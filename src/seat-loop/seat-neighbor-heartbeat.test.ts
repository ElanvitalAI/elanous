import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMsgStore } from '../msg/msg-store.js';
import { checkLoopNeighbors, emitLoopHeartbeat, SEAT_NEIGHBORS } from '../loops/neighbor-runtime.js';
import { runSeatLoopOnce } from './seat-loop.js';

test('MK seat uses the cmo-seat contract identity so OP detects its missed signal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-cmo-signal-'));
  const now = new Date('2026-10-05T00:00:00Z');
  try {
    await runSeatLoopOnce('MK', { root, repo: root, now: () => now, config: { mode: 'shadow', seats: ['MK'] },
      versions: () => [], schedules: () => [] });
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try { expect(store.db.query('SELECT loop_id FROM loop_signals').all()).toEqual([{ loop_id: 'cmo-seat' }]); }
    finally { store.close(); }
    const peers = SEAT_NEIGHBORS.OP!.filter(peer => peer.id === 'cmo-seat');
    expect(checkLoopNeighbors(root, 'op-seat', peers, now)).toEqual([]);
    expect(checkLoopNeighbors(root, 'op-seat', peers, new Date(now.getTime() + 30 * 60_000)))
      .toMatchObject([{ neighbor: 'cmo-seat', action: 'defer', to: 'orchestrator' }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real seat turn renews its durable lease while running, stops renewal at exit, and expired lease triggers onAbsent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-neighbor-lease-'));
  const start = new Date('2026-10-05T00:00:00Z');
  let clock = start;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const signal = () => {
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try { return store.db.query('SELECT at, health, ends_at FROM loop_signals WHERE loop_id=?').get('tc-seat') as
      { at: string; health: string; ends_at: string | null }; }
    finally { store.close(); }
  };
  try {
    const turn = runSeatLoopOnce('TC', { root, repo: root, now: () => clock, config: { mode: 'shadow', seats: ['TC'] },
      versions: () => [], schedules: () => [], heartbeatIntervalMs: 10,
      pullRequests: async () => { entered(); await held; return []; } });
    await started;
    expect(signal()).toEqual({ at: start.toISOString(), health: 'healthy', ends_at: new Date(start.getTime() + 30 * 60_000).toISOString() });
    clock = new Date(start.getTime() + 31 * 60_000);
    const deadline = Date.now() + 1000;
    while (signal().at !== clock.toISOString() && Date.now() < deadline) await Bun.sleep(10);
    expect(signal()).toEqual({ at: clock.toISOString(), health: 'healthy', ends_at: new Date(clock.getTime() + 30 * 60_000).toISOString() });
    const neighbor = SEAT_NEIGHBORS.OP!.filter(peer => peer.id === 'tc-seat');
    expect(checkLoopNeighbors(root, 'op-seat', neighbor, clock)).toEqual([]);
    release();
    expect((await turn).status).toBe('skipped-empty');
    const completed = signal();
    expect(completed.ends_at).toBe(new Date(clock.getTime() + 30 * 60_000).toISOString());
    clock = new Date(clock.getTime() + 31 * 60_000);
    await Bun.sleep(40);
    expect(signal()).toEqual(completed);
    const incidents = checkLoopNeighbors(root, 'op-seat', neighbor, clock);
    expect(incidents).toMatchObject([{ neighbor: 'tc-seat', reason: 'end-expired', action: 'escalate', to: 'orchestrator' }]);
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(store.db.query('SELECT reason, action, recipient FROM loop_incidents WHERE observer=? AND neighbor=?').all('op-seat', 'tc-seat'))
        .toEqual([{ reason: 'end-expired', action: 'escalate', recipient: 'orchestrator' }]);
      expect(store.listByRecipient('orchestrator').filter(message => message.kind === 'neighbor-escalate')).toHaveLength(1);
    } finally { store.close(); }
  } finally { release(); rmSync(root, { recursive: true, force: true }); }
});

test('a long seat turn watches its neighbors periodically, not only when the turn ends', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-neighbor-midturn-'));
  const start = new Date('2026-10-05T00:00:00Z');
  let clock = start;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const stewardDelegations = () => {
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try { return store.listByRecipient('steward').filter(row => row.kind === 'neighbor-delegate').length; }
    finally { store.close(); }
  };
  try {
    emitLoopHeartbeat(root, 'op-seat', 'healthy', start);
    const turn = runSeatLoopOnce('TC', { root, repo: root, now: () => clock, config: { mode: 'shadow', seats: ['TC'] },
      versions: () => [], schedules: () => [], heartbeatIntervalMs: 10,
      pullRequests: async () => { entered(); await held; return []; } });
    await started;
    clock = new Date(start.getTime() + 31 * 60_000);
    const deadline = Date.now() + 1000;
    while (stewardDelegations() === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(stewardDelegations()).toBe(1); // OP went silent mid-turn: delegated before the turn ended
    release();
    await turn;
    expect(stewardDelegations()).toBe(1); // the end-of-turn check does not repeat the receipt
  } finally { release(); rmSync(root, { recursive: true, force: true }); }
});
