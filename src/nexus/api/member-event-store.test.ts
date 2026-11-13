import { expect, test } from 'bun:test';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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

test('two processes reserve one idempotency key before applying the last hourly slot', async () => withStoreRoot(async root => {
  const lastSlotCapacity = 1;
  const modulePath = new URL('./member-event-store.ts', import.meta.url).href;
  const childSource = `import { createJsonlMemberEventStore } from ${JSON.stringify(modulePath)};
    const store = createJsonlMemberEventStore(process.argv[1]);
    const result = await store.reserveUniqueEvent({ type: 'scrap.summary.requested', memberId: 'member-shared',
      requestId: 'sum_same', scrapId: 'scrap-1', at: '2026-11-13T00:00:00.000Z' },
      { type: 'scrap.summary.requested', key: 'requestId', since: '2026-11-12T23:00:00.000Z', max: ${lastSlotCapacity} });
    process.stdout.write(result.status);`;
  const runChild = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childSource, root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { errors += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(`reservation child failed: ${code} ${errors}`)));
  });
  expect((await Promise.all([runChild(), runChild()])).sort()).toEqual(['appended', 'existing']);
  const store = createJsonlMemberEventStore(root);
  expect(await store.query({ memberId: 'member-shared', type: 'scrap.summary.requested' })).toHaveLength(1);
  expect((await store.reserveUniqueEvent!({ type: 'scrap.summary.requested', memberId: 'member-shared',
    requestId: 'sum_other', scrapId: 'scrap-1', at: '2026-11-13T00:00:00.000Z' },
  { type: 'scrap.summary.requested', key: 'requestId', since: '2026-11-12T23:00:00.000Z', max: lastSlotCapacity })).status).toBe('limited');
}));

test('generation heartbeat keeps the lease and a takeover fences the previous result', async () => withStoreRoot(async root => {
  const first = createJsonlMemberEventStore(root);
  const second = createJsonlMemberEventStore(root);
  const claim = (claimId: string, at: string, _since: string) => first.claimPendingEvent!(
    { type: 'scrap.summary.claimed', memberId: 'member-a', requestId: 'sum-lease', claimId, at },
    { resultType: 'scrap.summary.result', key: 'requestId', now: () => new Date(at), leaseMs: 5 * 60_000 });
  expect(await claim('worker-a', '2026-11-13T00:00:00.000Z', '2026-11-12T23:55:00.000Z')).toBe('claimed');
  expect(await claim('worker-a', '2026-11-13T00:04:00.000Z', '2026-11-12T23:59:00.000Z')).toBe('renewed');
  expect(await claim('worker-b', '2026-11-13T00:06:00.000Z', '2026-11-13T00:01:00.000Z')).toBe('busy');
  expect(await claim('worker-b', '2026-11-13T00:10:00.000Z', '2026-11-13T00:05:00.000Z')).toBe('claimed');
  const result = { type: 'scrap.summary.result', memberId: 'member-a', requestId: 'sum-lease',
    scrapId: 'scrap-1', status: 'ready', summary: 'winner', at: '2026-11-13T00:10:00.000Z' };
  const ownership = (claimId: string) => ({ claimType: 'scrap.summary.claimed', key: 'requestId', claimId, now: () => new Date('2026-11-13T00:10:00.000Z'), leaseMs: 5 * 60_000 });
  expect((await first.appendClaimedResult!(result, ownership('worker-a'))).status).toBe('stale');
  expect((await second.appendClaimedResult!(result, ownership('worker-b'))).status).toBe('appended');
  expect((await first.appendClaimedResult!(result, ownership('worker-a'))).status).toBe('existing');
  expect(await first.query({ memberId: 'member-a', type: 'scrap.summary.result' })).toHaveLength(1);
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

for (const at of ['2026-11-13T00:05:00.000Z', '2026-11-13T00:05:00.001Z']) for (const capability of ['renew', 'append']) {
  test(`expired generation cannot ${capability} before takeover at ${at}`, async () => withStoreRoot(async root => {
    const store = createJsonlMemberEventStore(root);
    const initial = { type: 'scrap.summary.claimed', memberId: 'member-a', requestId: 'expired-no-takeover',
      claimId: 'old-worker', at: '2026-11-13T00:00:00.000Z' };
    const limit = { resultType: 'scrap.summary.result', key: 'requestId', now: () => new Date('2026-11-13T00:00:00.000Z'), leaseMs: 5 * 60_000 };
    expect(await store.claimPendingEvent!(initial, limit)).toBe('claimed');
    const timing = { now: () => new Date(at), leaseMs: 5 * 60_000 };
    // No intervening claimant: expiry alone must revoke both capabilities.
    const result = { type: 'scrap.summary.result', memberId: 'member-a', requestId: initial.requestId,
      status: 'ready', summary: 'expired worker', at };
    if (capability === 'renew') expect(await store.claimPendingEvent!({ ...initial, at }, { ...limit, ...timing })).toBe('busy');
    else expect((await store.appendClaimedResult!(result, {
      claimType: initial.type, key: 'requestId', claimId: initial.claimId, ...timing })).status).toBe('stale');
    expect(await store.query({ memberId: 'member-a', type: initial.type })).toEqual([initial]);
    expect(await store.query({ memberId: 'member-a', type: result.type })).toHaveLength(0);
    expect(await store.claimPendingEvent!({ ...initial, claimId: 'new-worker', at }, { ...limit, ...timing })).toBe('claimed');
    expect((await store.appendClaimedResult!(result, {
      claimType: initial.type, key: 'requestId', claimId: 'new-worker', ...timing })).status).toBe('appended');
  }));
}

for (const operation of ['renew', 'append'] as const) {
  test(`claim ${operation} rejects expiry while waiting on another process journal lock`, async () => withStoreRoot(async root => {
    const clockPath = join(root, 'clock.txt'), readyPath = join(root, 'holder-ready'), waitingPath = join(root, 'wait-started');
    writeFileSync(clockPath, '2026-11-13T00:04:59.999Z');
    const store = createJsonlMemberEventStore(root);
    const initial = { type: 'scrap.summary.claimed', memberId: 'member-a', requestId: 'lock-expiry', claimId: 'worker-a', at: '2026-11-13T00:00:00.000Z' };
    const limit = { resultType: 'scrap.summary.result', key: 'requestId', now: () => new Date('2026-11-13T00:00:00.000Z'), leaseMs: 5 * 60_000 };
    expect(await store.claimPendingEvent!(initial, limit)).toBe('claimed');
    const lockPath = join(root, `member-${createHash('sha256').update(initial.memberId).digest('hex')}.jsonl.lock`);
    const lockModule = new URL('./private-file-lock.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['-e', `import { withPrivateFileLock } from ${JSON.stringify(lockModule)};
      import { existsSync, writeFileSync } from 'node:fs';
      withPrivateFileLock(process.argv[1], () => {
        writeFileSync(process.argv[2], 'ready');
        for (let i = 0; i < 500 && !existsSync(process.argv[4]); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        if (!existsSync(process.argv[4])) throw new Error('parent did not start operation');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        writeFileSync(process.argv[3], '2026-11-13T00:05:00.001Z');
      }, 'test.expiry-lock', true);`, lockPath, readyPath, clockPath, waitingPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    try {
      for (let i = 0; i < 200 && !existsSync(readyPath); i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(existsSync(readyPath)).toBe(true);
      const at = readFileSync(clockPath, 'utf8'); expect(at).toBe('2026-11-13T00:04:59.999Z');
      const timing = { now: () => new Date(readFileSync(clockPath, 'utf8')), leaseMs: 5 * 60_000 };
      writeFileSync(waitingPath, 'starting operation'); const waitStarted = Date.now();
      const result = operation === 'renew'
        ? await store.claimPendingEvent!({ ...initial, at }, { ...limit, ...timing })
        : (await store.appendClaimedResult!({ type: 'scrap.summary.result', memberId: initial.memberId,
          requestId: initial.requestId, at, summary: 'expired' }, { claimType: initial.type, key: 'requestId', claimId: initial.claimId, ...timing })).status;
      // source: #23681 / JUD23677 — holder sleeps250ms after handshake; allow50ms scheduling slack to prove real lock wait.
      expect(Date.now() - waitStarted).toBeGreaterThanOrEqual(200);
      expect(await exited).toBe(0); expect(readFileSync(clockPath, 'utf8')).toBe('2026-11-13T00:05:00.001Z');
      expect(result).toBe(operation === 'renew' ? 'busy' : 'stale');
      expect(await store.query({ memberId: initial.memberId, type: initial.type })).toEqual([initial]);
      expect(await store.query({ memberId: initial.memberId, type: 'scrap.summary.result' })).toHaveLength(0);
    } finally { if (child.exitCode === null) child.kill(); await exited; }
  }));
}
