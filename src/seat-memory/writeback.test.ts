import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSeatMemories } from './seat-memory.js';
import { createSeatMemoryWriteback } from './writeback.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function context() {
  const dir = mkdtempSync(join(tmpdir(), 'seat-writeback-')); dirs.push(dir);
  return { seat: 'TC', dir, audience: 'hq-seat' as const, jevDeps: { peekEndpoint: () => '', resolveAccess: () => ({ ok: false as const }), log: () => {} } };
}
const done = () => { let resolve!: (v: string) => void; const promise = new Promise<string>(r => { resolve = r; }); return { promise, resolve }; };
const admission = { authenticatedHuman: true, audience: 'hq-seat' } as const;
const candidate = { sourceIndex: 0, name: 'guidance', description: 'verified guidance', type: 'feedback', body: 'Keep the agreed testing rule.', kind: '교정', scope: 'seat' };

test('N human turns launch asynchronously and source is pinned to snapshot, not the active request', async () => {
  const ctx = context(); const finished = done(); let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const wb = createSeatMemoryWriteback({ every: 2, context: { ...ctx, getSourceEventId: () => 'wrong-current-turn' },
    review: async turns => { expect(turns.map(t => t.sourceEventId)).toEqual(['event-1', 'event-2']); await gate; return [candidate]; }, onResult: finished.resolve });
  wb.observe({ sourceEventId: 'event-1', text: 'First human statement' }, admission);
  wb.observe({ sourceEventId: 'event-2', text: 'Second human statement' }, admission);
  expect(listSeatMemories(ctx.dir)).toHaveLength(0);
  release(); expect(await finished.promise).toBe('saved');
  expect(listSeatMemories(ctx.dir)[0]?.triage?.source).toBe('event-1');
});

test('nothing to save and invalid model source do not write', async () => {
  const ctx = context(); const finished = done();
  const wb = createSeatMemoryWriteback({ every: 1, context: ctx, review: async () => [{ ...candidate, sourceIndex: 5 }], onResult: finished.resolve });
  wb.observe({ sourceEventId: 'event', text: 'hello' }, admission);
  expect(await finished.promise).toBe('nothing-to-save'); expect(listSeatMemories(ctx.dir)).toHaveLength(0);
});

test('member and failed audience resolution never invoke reviewer', async () => {
  for (const getAudience of [async () => 'member' as const, async () => { throw new Error('offline'); }]) {
    const finished = done(); let calls = 0;
    const wb = createSeatMemoryWriteback({ every: 1, context: { ...context(), getAudience }, review: async () => { calls++; return []; }, onResult: finished.resolve });
    wb.observe({ sourceEventId: 'event', text: 'private member content' }, admission);
    expect(['nothing-to-save', 'failed']).toContain(await finished.promise); expect(calls).toBe(0);
  }
});

test('empty review is nothing to save', async () => {
  const finished = done(); const wb = createSeatMemoryWriteback({ every: 1, context: context(), review: async () => [], onResult: finished.resolve });
  wb.observe({ sourceEventId: 'event', text: 'hello' }, admission); expect(await finished.promise).toBe('nothing-to-save');
});

test('flush reviews a partial batch once with its original source', async () => {
  const ctx = context(); let calls = 0;
  const wb = createSeatMemoryWriteback({ every: 3, context: ctx, review: async turns => {
    calls++; expect(turns.map(t => t.sourceEventId)).toEqual(['event-flush']); return [candidate];
  } });
  wb.observe({ sourceEventId: 'event-flush', text: 'Please keep the testing rule.' }, admission);
  expect(calls).toBe(0);
  await wb.flush(); await wb.flush();
  expect(calls).toBe(1);
  expect(listSeatMemories(ctx.dir)[0]?.triage?.source).toBe('event-flush');
});

test('flush waits for the in-flight batch then reviews pending turns', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const reviewed: string[][] = [];
  const wb = createSeatMemoryWriteback({ every: 2, context: context(), review: async turns => {
    reviewed.push(turns.map(t => t.sourceEventId)); if (reviewed.length === 1) await gate; return [];
  } });
  wb.observe({ sourceEventId: '1', text: 'first' }, admission); wb.observe({ sourceEventId: '2', text: 'second' }, admission);
  await Promise.resolve();
  wb.observe({ sourceEventId: '3', text: 'third' }, admission);
  const flushing = wb.flush(); release(); await flushing;
  expect(reviewed).toEqual([['1', '2'], ['3']]);
});

test('busy reviewer preserves queued turns and flush drains all batches', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const batches: string[][] = [];
  const wb = createSeatMemoryWriteback({ every: 2, context: context(), review: async turns => {
    batches.push(turns.map(t => t.sourceEventId));
    if (batches.length === 1) await gate;
    return [];
  } });
  for (let i = 1; i <= 7; i++) wb.observe({ sourceEventId: String(i), text: `human ${i}` }, admission);
  const flushing = wb.flush(); release(); await flushing;
  expect(batches).toEqual([['1', '2'], ['3', '4'], ['5', '6'], ['7']]);
});

test('flush never sends member turns to the reviewer', async () => {
  let calls = 0; const wb = createSeatMemoryWriteback({ every: 4, context: { ...context(), audience: 'member' }, review: async () => { calls++; return []; } });
  wb.observe({ sourceEventId: '1', text: 'private' }, admission); await wb.flush(); expect(calls).toBe(0);
});


test('untrusted and member events are rejected at ingress even if the later session is HQ', async () => {
  let calls = 0;
  const wb = createSeatMemoryWriteback({ every: 1, context: context(), review: async () => { calls++; return []; } });
  wb.observe({ sourceEventId: 'member', text: 'private' }, { authenticatedHuman: true, audience: 'member' } as never);
  wb.observe({ sourceEventId: 'agent', text: 'not a human' }, { authenticatedHuman: false, audience: 'hq-seat' } as never);
  wb.observe({ sourceEventId: 'unknown', text: 'unknown origin' }, undefined as never);
  await wb.flush(); expect(calls).toBe(0);
});

test('audience changing during review discards results without writing', async () => {
  const ctx = context(); let audience: 'hq-seat' | 'member' = 'hq-seat';
  const wb = createSeatMemoryWriteback({ every: 1, context: { ...ctx, getAudience: async () => audience }, review: async () => {
    audience = 'member'; return [candidate];
  } });
  wb.observe({ sourceEventId: 'event', text: 'trusted HQ turn' }, admission);
  await wb.flush(); expect(listSeatMemories(ctx.dir)).toHaveLength(0);
});
