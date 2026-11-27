// SIGNAL-DIET-OP-DIGEST — unit tests ⊕ the 11-27 07:43 replay sim (seeds ≥ 3).
// Expectations are literals (rule 11): the shape counts below come from the 07:43 measurement — 83 mails / 45 min,
// LAND-GRAPH 26 · ORCHESTRATOR 14 · JUDGE-BUTLER 2 · GUARDIAN 2 (= 44 machine, 53 %) · 39 human / seat mail.
import { expect, test } from 'bun:test';
import { MsgStore } from './msg-store.js';
import { isMachineSender, opDigestFolds, opDigestUrgent, renderOpDigest } from './op-machine-digest.js';
import { resetInboxSnapshotMemory, seatInboxSnapshotText } from './inbox-snapshot-turn.js';

const T0 = Date.parse('2026-11-27T07:00:00.000Z');
function storeAt(): { store: MsgStore; set(ms: number): void } {
  let now = T0;
  const store = new MsgStore(':memory:', { now: () => new Date(now) });
  return { store, set: (ms) => { now = ms; } };
}

test('machine senders fold; humans, seats, sub-coordinators and replies stay direct', () => {
  expect(isMachineSender('LAND-GRAPH')).toBe(true);
  expect(isMachineSender('ORCHESTRATOR')).toBe(true);
  expect(isMachineSender('JUDGE-BUTLER')).toBe(true);
  expect(isMachineSender('GUARDIAN')).toBe(true);
  expect(isMachineSender('SPACE-STEWARD')).toBe(true);
  expect(isMachineSender('TC')).toBe(false);
  expect(isMachineSender('RAIL-WATCH')).toBe(false);
  expect(opDigestFolds({ from: 'LAND-GRAPH', to: 'OP', body: 'x' })).toBe(true);
  expect(opDigestFolds({ from: 'LAND-GRAPH', to: 'TC', body: 'x' })).toBe(false);
  expect(opDigestFolds({ from: 'HUMAN', to: 'OP', body: 'x' })).toBe(false);
  expect(opDigestFolds({ from: 'UX', to: 'OP', body: 'x' })).toBe(false);
  expect(opDigestFolds({ from: 'ORCHESTRATOR', to: 'OP', body: 'x', replyTo: 9 })).toBe(false);
});

test('🚨 passes through: marker, P0, crown, main-broken / release-blocked / security / cost', () => {
  expect(opDigestUrgent({ from: 'LAND-GRAPH', to: 'OP', body: '🚨 main broken after #40001' })).toBe(true);
  expect(opDigestUrgent({ from: 'GUARDIAN', to: 'OP', body: 'x', priority: 1 })).toBe(true);
  expect(opDigestUrgent({ from: 'GUARDIAN', to: 'OP', body: 'x', crownDirective: 'c-1' })).toBe(true);
  expect(opDigestUrgent({ from: 'GUARDIAN', to: 'OP', body: 'x', kind: 'cost-incident' })).toBe(true);
  expect(opDigestUrgent({ from: 'ORCHESTRATOR', to: 'OP', body: 'x', refs: ['release-blocked:0.3.38'] })).toBe(true);
  expect(opDigestUrgent({ from: 'ORCHESTRATOR', to: 'OP', body: 'x', refs: ['security'] })).toBe(true);
  expect(opDigestUrgent({ from: 'ORCHESTRATOR', to: 'OP', body: 'idle 16m', kind: 'steward-exception', intent: 'alert' })).toBe(false);
});

test('a machine mail to OP is parked, not an inbox row; the digest flushes after 30 min', () => {
  const { store, set } = storeAt();
  const parked = store.post({ from: 'land-graph', to: 'OP', kind: 'info', body: '[land-graph 착지 후통보] #40001 MERGED' });
  expect(parked.id).toBe(0);
  expect(parked.digested).toBe(1);
  expect(store.list('OP')).toHaveLength(0);
  set(T0 + 29 * 60_000);
  store.post({ from: 'ORCHESTRATOR', to: 'OP', kind: 'steward-exception', intent: 'alert', body: 'assign-failed:unknown-cell X-1' });
  expect(store.list('OP')).toHaveLength(0);
  set(T0 + 30 * 60_000);
  const human = store.post({ from: 'TC', to: 'OP', kind: 'report', body: 'PR #40002 ready' });
  const inbox = store.list('OP');
  expect(inbox.map((m) => m.from)).toEqual(['TC', 'SIGNAL-DIGEST']);
  expect(inbox[0]!.id).toBe(human.id);
  const digest = inbox[1]!;
  expect(digest.kind).toBe('digest');
  expect(digest.body).toContain('[machine digest · 2 mails');
  expect(digest.body).toContain('LAND-GRAPH 1 · ORCHESTRATOR 1');
  expect(digest.body).toContain('1. ORCHESTRATOR/steward-exception — assign-failed:unknown-cell X-1');
  expect(store.pendingOpDigest()).toHaveLength(0);
});

test('provenance keys stay idempotent across parking and flushing', () => {
  const { store, set } = storeAt();
  const a = store.appendWithProvenance({ from: 'JUDGE-BUTLER', to: 'OP', kind: 'request', intent: 'decision', body: 'sign JQ-1?' }, 'butler:jq-1');
  const b = store.appendWithProvenance({ from: 'JUDGE-BUTLER', to: 'OP', kind: 'request', intent: 'decision', body: 'sign JQ-1?' }, 'butler:jq-1');
  expect(a.digested).toBe(1);
  expect(b.digested).toBe(1);
  expect(store.pendingOpDigest()).toHaveLength(1);
  set(T0 + 31 * 60_000);
  const flushed = store.flushOpDigestIfDue();
  expect(flushed?.from).toBe('SIGNAL-DIGEST');
  const again = store.appendWithProvenance({ from: 'JUDGE-BUTLER', to: 'OP', kind: 'request', body: 'sign JQ-1?' }, 'butler:jq-1');
  expect(again.id).toBe(flushed!.id);
  expect(store.pendingOpDigest()).toHaveLength(0);
});

test('🚨 machine mail reaches OP at once', () => {
  const { store } = storeAt();
  store.post({ from: 'LAND-GRAPH', to: 'OP', kind: 'info', body: '🚨 main broken: tsc red on 6ac7d7b2cc3' });
  expect(store.list('OP').map((m) => m.body)).toEqual(['🚨 main broken: tsc red on 6ac7d7b2cc3']);
});

test('renderOpDigest quotes at most three decision items, newest first', () => {
  const items = [1, 2, 3, 4, 5].map((id) => ({ id, sender: 'ORCHESTRATOR', kind: 'steward-exception', intent: 'alert', body: `card ${id}`, refs: [], createdAt: new Date(T0 + id * 60_000).toISOString() }));
  const body = renderOpDigest([...items, { id: 6, sender: 'LAND-GRAPH', kind: 'info', intent: 'info', body: 'merged', refs: [], createdAt: new Date(T0).toISOString() }]);
  expect(body).toContain('needs decision 5] ORCHESTRATOR 5 · LAND-GRAPH 1');
  expect(body).toContain('1. ORCHESTRATOR/steward-exception — card 5');
  expect(body).toContain('3. ORCHESTRATOR/steward-exception — card 3');
  expect(body).not.toContain('card 2');
  expect(body).toContain('… 2 more decision items');
});

// ── 07:43 replay sim ──────────────────────────────────────────────────────────────────────────────────────────────
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

for (const seed of [1, 7, 42, 1127]) {
  test(`07:43 replay (seed ${seed}): 83 mails / 45 min → 39 direct + 2 🚨 + ≤ 2 digests, nothing lost`, () => {
    const r = rng(seed);
    const { store, set } = storeAt();
    const shape: Array<{ from: string; kind: string; intent?: 'alert' | 'decision' | 'info'; body: string }> = [
      ...Array.from({ length: 26 }, (_, i) => ({ from: 'land-graph', kind: 'info', body: `[land-graph · stall] #${40100 + i} ready 30+ min` })),
      ...Array.from({ length: 12 }, (_, i) => ({ from: 'ORCHESTRATOR', kind: 'steward-exception', intent: 'alert' as const, body: `idle ${10 + i}m — 보드에 일감이 있습니다` })),
      ...Array.from({ length: 2 }, (_, i) => ({ from: 'ORCHESTRATOR', kind: 'hold-hygiene', body: `hold #${i} stale` })),
      ...Array.from({ length: 2 }, (_, i) => ({ from: 'JUDGE-BUTLER', kind: 'request', intent: 'decision' as const, body: `sign JQ-${i}?` })),
      ...Array.from({ length: 2 }, (_, i) => ({ from: 'GUARDIAN', kind: 'incident', body: `host reservation ${i}` })),
      ...Array.from({ length: 39 }, (_, i) => ({ from: ['TC', 'UX', 'MK', 'OPC', 'HUMAN'][i % 5]!, kind: 'report', body: `seat report ${i}` })),
    ];
    // two 🚨 machine mails on top of the measured shape
    shape.push({ from: 'LAND-GRAPH', kind: 'info', body: '🚨 main broken: rail smoke red' });
    shape.push({ from: 'GUARDIAN', kind: 'cost-incident', body: 'VM aws1 idle 6h' });
    const order = shape.map((m) => ({ m, at: T0 + Math.floor(r() * 45 * 60_000) })).sort((a, b) => a.at - b.at);
    for (const { m, at } of order) { set(at); store.post({ from: m.from, to: 'OP', kind: m.kind, ...(m.intent ? { intent: m.intent } : {}), body: m.body }); }
    set(T0 + 90 * 60_000);
    store.flushOpDigestIfDue();
    const inbox = store.list('OP', 0, 500);
    const digests = inbox.filter((m) => m.from === 'SIGNAL-DIGEST');
    expect(inbox.filter((m) => ['TC', 'UX', 'MK', 'OPC', 'HUMAN'].includes(m.from))).toHaveLength(39);
    expect(inbox.filter((m) => m.body.startsWith('🚨') || m.kind === 'cost-incident')).toHaveLength(2);
    expect(digests.length).toBeGreaterThanOrEqual(1);
    expect(digests.length).toBeLessThanOrEqual(2);
    expect(inbox.length).toBeLessThanOrEqual(43); // was 85 rows (83 + 2 🚨)
    expect(store.pendingOpDigest()).toHaveLength(0);
    const counted = digests.reduce((n, d) => n + Number(/\[machine digest · (\d+) mails/u.exec(d.body)?.[1] ?? 0), 0);
    expect(counted).toBe(44);
    for (const d of digests) expect(d.body.split('\n').filter((l) => /^ {2}\d\. /u.test(l)).length).toBeLessThanOrEqual(3);
  });
}

// OP-DIGEST-FLUSH-TICK (sim #40379 LA-D2) — nobody writes to OP after machine mail is parked: the turn snapshot (and the
// TUI minute tick, same call) flushes the digest once due; before the window it stays parked; a second call is a no-op.
test('a quiet OP inbox still gets the digest: the turn snapshot flushes when due, once', () => {
  resetInboxSnapshotMemory();
  let now = T0;
  const store = new MsgStore(':memory:', { now: () => new Date(now) });
  store.post({ from: 'JUDGE-BUTLER', to: 'OP', kind: 'request', intent: 'decision', body: 'sign JQ-7?' });
  expect(store.list('OP')).toHaveLength(0);
  now = T0 + 20 * 60_000;
  seatInboxSnapshotText('OP', { openStore: () => store, now: () => new Date(now) });
  expect(store.list('OP')).toHaveLength(0);
  now = T0 + 45 * 60_000;
  const text = seatInboxSnapshotText('OP', { openStore: () => store, now: () => new Date(now) });
  expect(store.list('OP').map((m) => m.from)).toEqual(['SIGNAL-DIGEST']);
  expect(store.list('OP')[0]!.body).toContain('sign JQ-7?');
  expect(text ?? '').toContain('SIGNAL-DIGEST');
  expect(store.flushOpDigestIfDue()).toBeNull();
  // another seat's snapshot never flushes OP's digest
  store.post({ from: 'JUDGE-BUTLER', to: 'OP', kind: 'request', intent: 'decision', body: 'sign JQ-8?' });
  now = T0 + 80 * 60_000;
  seatInboxSnapshotText('TC', { openStore: () => store, now: () => new Date(now) });
  expect(store.list('OP')).toHaveLength(1);
});
