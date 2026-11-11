import { expect, test } from 'bun:test';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchGraphContract } from '../../graph-runner/capabilities.js';
import { appendJournalRecord, createJsonlMemberEventStore, createNexusCapabilityRegistry } from './member-event-store.js';
import { withPrivateFileLock } from './private-file-lock.js';

function withStoreRoot(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'nexus-member-event-store-'));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test('JSONL store isolates two members and persists their events across a store restart', async () => withStoreRoot(async root => {
  const firstStore = createJsonlMemberEventStore(root);
  const observed: unknown[] = [];
  const unsubscribe = firstStore.subscribe(event => observed.push(event));
  const alice = { type: 'board.card', memberId: 'member-alice', cardId: 'alice-card', state: 'suggested' };
  const bob = { type: 'board.card', memberId: 'member-bob', cardId: 'bob-card', state: 'suggested' };
  const aliceBrief = { type: 'briefing.ready', memberId: 'member-alice', briefingId: 'brief-alice' };
  const aliceTimed = { type: 'board.card', memberId: 'member-alice', cardId: 'timed-card', state: 'testing', at: '2026-11-09T10:00:00.000Z' };
  await firstStore.append(alice);
  await firstStore.append(bob);
  await firstStore.append(aliceBrief);
  await firstStore.append(aliceTimed);
  expect(observed).toEqual([alice, bob, aliceBrief, aliceTimed]);
  expect(await firstStore.query({ memberId: 'member-alice', type: 'board.card' })).toEqual([alice, aliceTimed]);
  expect(await firstStore.query({ memberId: 'member-alice', type: 'briefing.ready' })).toEqual([aliceBrief]);
  expect(await firstStore.query({ memberId: 'member-bob', type: 'board.card' })).toEqual([bob]);
  expect((await createJsonlMemberEventStore(root).scan({ type: 'board.card' })).map(event => event.cardId).sort()).toEqual(['alice-card', 'bob-card', 'timed-card']);
  expect(await firstStore.query({ memberId: 'member-alice', type: 'board.card', since: '2026-11-09T09:00:00.000Z' })).toEqual([aliceTimed]);
  expect(firstStore.query({ memberId: 'member-alice', type: 'board.card', since: 'not-a-time' })).rejects.toThrow('since must be an ISO timestamp');
  unsubscribe();

  const restarted = createJsonlMemberEventStore(root);
  expect(await restarted.query({ memberId: 'member-alice', type: 'board.card' })).toEqual([alice, aliceTimed]);
  expect(await restarted.query({ memberId: 'member-alice', type: 'briefing.ready' })).toEqual([aliceBrief]);
  expect(await restarted.query({ memberId: 'member-bob', type: 'board.card' })).toEqual([bob]);
  expect(await restarted.query({ memberId: 'member-alice', type: 'board.card', since: '2026-11-09T09:00:00.000Z' })).toEqual([aliceTimed]);
}));

test('concurrent store instances preserve complete JSONL records under the member lock', async () => withStoreRoot(async root => {
  const modulePath = new URL('./member-event-store.js', import.meta.url).pathname;
  const childSource = `import { createJsonlMemberEventStore } from ${JSON.stringify(modulePath)}; const store = createJsonlMemberEventStore(process.argv[1]); for (let i = 0; i < 10; i++) await store.append({ type: 'board.card', memberId: 'member-shared', cardId: process.argv[2] + '-' + i, state: 'suggested' });`;
  const runChild = (label: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childSource, root, label], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`event-store child failed: ${code}`)));
  });
  await Promise.all([runChild('a'), runChild('b')]);
  const events = await createJsonlMemberEventStore(root).query({ memberId: 'member-shared', type: 'board.card' });
  expect(events).toHaveLength(20);
  expect(new Set(events.map(event => event.cardId)).size).toBe(20);
}));

test('partial JSONL write failure rolls back the incomplete record', async () => withStoreRoot(async root => {
  const path = `${root}/journal.jsonl`;
  writeFileSync(path, 'existing\n', { mode: 0o600 });
  const fd = openSync(path, 'a');
  let calls = 0;
  try {
    expect(() => appendJournalRecord(fd, Buffer.from('{"partial":true}\n'), (file, buffer, offset, length) => {
      calls++;
      if (calls > 1) throw new Error('simulated disk write failure');
      const chunkLength = Math.min(3, length);
      return writeSync(file, buffer, offset, chunkLength);
    })).toThrow('simulated disk write failure');
  } finally { closeSync(fd); }
  expect(readFileSync(path, 'utf8')).toBe('existing\n');
}));

test('event-store lock requirement fails closed when flock cannot load', async () => withStoreRoot(async root => {
  let updated = false;
  expect(() => withPrivateFileLock(`${root}/unavailable.lock`, () => { updated = true; }, 'test.lock', true, () => null))
    .toThrow('private file lock is unavailable');
  expect(updated).toBe(false);
}));

test('store.events@1 provider exposes member-scoped append and query through the shared registry', async () => withStoreRoot(async root => {
  const store = createJsonlMemberEventStore(root);
  const observed: unknown[] = [];
  store.subscribe(event => observed.push(event));
  const registry = createNexusCapabilityRegistry(store);
  const context = (input: unknown) => ({ graphId: 'store-events-sim', runId: 'run-sim', nodeId: 'store', input, outputs: {} });
  const event = { type: 'board.card', memberId: 'member-a', cardId: 'card-a', state: 'approved' };
  expect(await dispatchGraphContract('store.events@1', context({ operation: 'append', memberId: 'member-a', event }), registry))
    .toMatchObject({ ok: true, outcome: 'ok', result: { appended: true } });
  expect(observed).toEqual([event]);
  expect(await dispatchGraphContract('store.events@1', context({ operation: 'query', memberId: 'member-a', type: 'board.card' }), registry))
    .toMatchObject({ ok: true, result: { events: [event] } });
  expect(await dispatchGraphContract('store.events@1', context({ operation: 'query', memberId: 'member-b', type: 'board.card' }), registry))
    .toMatchObject({ ok: true, result: { events: [] } });
  expect(await dispatchGraphContract('store.events@1', context({ operation: 'append', memberId: 'member-b', event }), registry))
    .toMatchObject({ ok: false, outcome: 'failed', error: 'contract-exhausted', evidence: {
      contractId: 'store.events@1', attempts: [{ provider: 'nexus-jsonl-event-store', reason: 'member-mismatch' }],
    } });
}));
