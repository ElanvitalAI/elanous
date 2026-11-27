/**
 * SIM — ASSIGN-CAP-POLICY (CEO 11-27 10:4x «고정값 금지 · 조율자는 막히면 안 된다»). Live 10:41: the 행정관 assigned on
 * OP's identity, steward ⊕ OP shared one 10/10-min budget → `steward-refused code=rate-folded` while 25 hands sat idle
 * and 39 cells stalled. This world replays it through the real resource steward and the real seatAssign: OP already
 * spent 10 assignments in the window, 25 idle hands, 39 open target cells. Expected values are literals (rule 11).
 */
import { describe, expect, test } from 'bun:test';
import type { ChecklistItem } from '../release-loop/checklist.js';
import type { MatchingTable } from '../resource-opt/matching-table.js';
import { createSteward } from '../resource-opt/steward.js';
import type { HandPoolEntry } from './hand-pool.js';
import { assignRateActor, assignRateCap, seatAssign, type AssignRatePolicy, type SeatAssignDeps } from './seat-assign.js';
import { readAssignRatePolicy } from './seat-assign-live.js';

const T0 = Date.parse('2026-11-27T01:41:00.000Z');

function world(opts: { hands: number; cells: number; policy?: AssignRatePolicy }) {
  let now = T0;
  const hands = Array.from({ length: opts.hands }, (_, i) => `TC-H-SIM-${i + 1}`);
  const cells = new Map<string, { version: string; item: ChecklistItem }>();
  for (let i = 0; i < opts.cells; i++) {
    const id = `CAP-${i + 1}`;
    cells.set(id, { version: '0.3.39', item: { id, title: `cell ${i + 1}`, status: 'yellow', priority: 'P1', updatedAt: '2026-11-27T00:00:00.000Z', updatedBy: 'OP' } as ChecklistItem });
  }
  const mails: { from: string; to: string; cell: string; at: number; by: string; refs: string[] }[] = [];
  const hints: string[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const pool: HandPoolEntry[] = hands.map(seat => ({ seat, home: 'TC', state: 'idle', lent: false, closeCandidate: false }));
  const deps: SeatAssignDeps = {
    now: () => new Date(now),
    coordinators: () => ({ hq: 'OP', spaces: ['TC', 'UX'] }),
    federationSeats: () => new Set(['OP', 'TC', 'UX', ...hands]),
    findCell: id => cells.get(id),
    writers: () => [],
    assign: () => ({ from: null, outcome: 'assigned' }),
    post: mail => {
      mails.push({ from: mail.from, to: mail.to, cell: mail.refs[0]!.slice(5), at: now, by: mail.refs.find(r => r.startsWith('steward:')) ?? mail.from, refs: mail.refs });
      return { id: mails.length };
    },
    wake: async () => ({ result: 'injected' }),
    pool: () => ({ hosts: ['node-b'], scope: 'x', source: 'code-default' }),
    handPool: () => pool,
    log: (event, data) => { logs.push({ event, data }); },
    assignLedger: since => mails.filter(m => m.at >= since).map(m => ({ from: m.from, to: m.to, cell: m.cell, by: m.by })),
    targetVersion: () => '0.3.39',
    hint: (cell, seat) => { hints.push(`${cell}→${seat}`); },
    ...(opts.policy ? { ratePolicy: () => opts.policy! } : {}),
  };
  return { hands, cells, mails, hints, logs, deps, tick: (ms: number) => { now += ms; } };
}

describe('SIM assign cap — 25 idle hands × 39 cells (live 10:41)', () => {
  test('the steward assigns all 39 cells in one pass although OP already spent 10 in the window', async () => {
    const w = world({ hands: 25, cells: 39 });
    for (let i = 0; i < 10; i++) w.mails.push({ from: 'OP', to: 'UX', cell: `OLD-${i}`, at: T0 - 60_000, by: 'OP', refs: [`cell:OLD-${i}`] });
    let builds = 0;
    const rows = [...w.cells.keys()].map((cell, i) => ({ id: `A${i + 1}`, kind: 'assign' as const, seat: w.hands[i % 25]!, idleMin: 12, cell, title: 'x', priority: 'P1', why: 'unowned' as const }));
    const steward = createSteward({
      build: async () => { builds += 1; return { at: T0, version: '0.3.39', hqSeat: 'OP', rows, summary: {} as MatchingTable['summary'], unmeasured: [] }; },
      assign: async row => {
        w.tick(3_000);
        const res = await seatAssign({ seat: row.seat, cellId: row.cell, actor: 'OP', caller: 'resource-steward' }, w.deps);
        return res.ok ? { ok: true } : { ok: false, code: res.code, reason: res.reason };
      },
    });
    const out = await steward.run('seat-idle TC-H-SIM-1');
    expect(builds).toBe(1);
    expect(out.assigned.length).toBe(39);
    expect(w.mails.length).toBe(49);
    expect(w.logs.filter(l => l.event === 'seat.assign.folded').length).toBe(0);
    expect(w.hints).toEqual([]);
    // the steward's mails carry its own rate key, never OP's
    expect(w.mails.slice(10).every(m => m.by === 'steward:OP' && m.refs.includes('steward:OP'))).toBe(true);
  });

  test('the same cell flapping between hands folds on its 3rd assignment — one log line', async () => {
    const w = world({ hands: 5, cells: 3 });
    expect((await seatAssign({ seat: 'TC-H-SIM-1', cellId: 'CAP-1', actor: 'OP' }, w.deps)).ok).toBe(true);
    w.tick(60_000);
    expect((await seatAssign({ seat: 'TC-H-SIM-2', cellId: 'CAP-1', actor: 'OP' }, w.deps)).ok).toBe(true);
    w.tick(60_000);
    const third = await seatAssign({ seat: 'TC-H-SIM-3', cellId: 'CAP-1', actor: 'OP' }, w.deps);
    expect(third).toMatchObject({ ok: false, code: 'rate-folded' });
    const folded = w.logs.filter(l => l.event === 'seat.assign.folded');
    expect(folded.length).toBe(1);
    expect(folded[0]!.data).toMatchObject({ why: 'flap', cellId: 'CAP-1', cellAssigns: 2 });
    expect(w.hints).toEqual(['CAP-1→TC-H-SIM-3']);
    // a different cell to a fresh idle hand still passes right after
    expect((await seatAssign({ seat: 'TC-H-SIM-4', cellId: 'CAP-2', actor: 'OP' }, w.deps)).ok).toBe(true);
    // 11 minutes later the window has rolled: the cell may be assigned again
    w.tick(11 * 60_000);
    expect((await seatAssign({ seat: 'TC-H-SIM-3', cellId: 'CAP-1', actor: 'OP' }, w.deps)).ok).toBe(true);
  });

  test('a configured cap (seat.assign.rateMax 2) folds repeats to a busy hand but never distinct cells to fresh idle hands', async () => {
    const w = world({ hands: 5, cells: 8, policy: { rateMax: 2 } });
    for (let i = 1; i <= 5; i++) expect((await seatAssign({ seat: `TC-H-SIM-${i}`, cellId: `CAP-${i}`, actor: 'OP' }, w.deps)).ok).toBe(true);
    const sixth = await seatAssign({ seat: 'TC-H-SIM-1', cellId: 'CAP-6', actor: 'OP' }, w.deps);
    expect(sixth).toMatchObject({ ok: false, code: 'rate-folded' });
    expect(w.logs.filter(l => l.event === 'seat.assign.folded').map(l => l.data.why)).toEqual(['cap']);
    expect((await seatAssign({ seat: 'TC-H-SIM-1', cellId: 'CAP-6', actor: 'OP', force: true }, w.deps)).ok).toBe(true);
  });
});

describe('assign cap policy — pure', () => {
  test('cap scales with idle hands for coordinators; config overrides; others keep a small cap', () => {
    expect(assignRateCap({ coordinator: true, idleHands: 0 })).toBe(30);
    expect(assignRateCap({ coordinator: true, idleHands: 25 })).toBe(50);
    expect(assignRateCap({ coordinator: true, idleHands: 25, policy: { rateMax: 7 } })).toBe(7);
    expect(assignRateCap({ coordinator: true, idleHands: 4, policy: { rateMax: -1 } })).toBe(30);
    expect(assignRateCap({ coordinator: false, idleHands: 25 })).toBe(3);
    expect(assignRateCap({ coordinator: false, idleHands: 25, policy: { handRateMax: 5 } })).toBe(5);
  });
  test('steward actors count under steward:<scope>', () => {
    expect(assignRateActor('op', { steward: true })).toBe('steward:OP');
    expect(assignRateActor('OP', { caller: 'resource-steward' })).toBe('steward:OP');
    expect(assignRateActor('OP', { caller: 'cli:123' })).toBe('OP');
  });
  test('config reader takes numbers only', () => {
    expect(readAssignRatePolicy({ seat: { assign: { rateMax: 80, rateWindowMs: 300000, handRateMax: 'x' } } })).toEqual({ rateMax: 80, rateWindowMs: 300000 });
    expect(readAssignRatePolicy({ release: {} })).toBe(null);
    expect(readAssignRatePolicy(null)).toBe(null);
  });
});
