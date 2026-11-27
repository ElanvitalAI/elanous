/**
 * SIM — WIP1-ASSIGN-GUARD (0.3.38 P0 · OP 11-27 12:10). Live: OP's direct assignments put a new P1 on hands already holding
 * an active P0 → 17 hand ✋ «both are mine, set order / reassign» (12 back to OP). This world drives the real seatAssign
 * with a stateful board (owner ⊕ status ⊕ priority ⊕ updatedAt), a hand pool derived from it, and a returnToBoard that
 * clears the owner like the veto path. Expected values are literals (rule 11); seeds 1–5 sweep random assign storms.
 */
import { describe, expect, test } from 'bun:test';
import type { ChecklistItem } from '../release-loop/checklist.js';
import type { HandPoolEntry } from './hand-pool.js';
import { seatAssign, type SeatAssignDeps } from './seat-assign.js';
import { freeHands, loadSeatAssignPolicy, parseSeatAssignPolicy, priorityRank, wip1Decide, wipTakeoverRule, type Wip1Policy } from './seat-assign-wip1.js';
import { leaderCard } from '../prompt-library/leader-card.js';
import { HAND_STANDARD_ANSWERS } from '../msg/hand-raise-ladder.js';

const T0 = Date.parse('2026-11-27T03:10:00.000Z');
const POLICY: Wip1Policy = { activeWindowMs: 180 * 60_000, priorityOrder: ['P0', 'P1', 'P2'], unrankedAs: 'P2', activeRecentMs: 30 * 60_000, activePanes: ['WORKING', 'WAITING_APPROVAL', 'WAITING_REPLY'] };

function world(hands: readonly string[], cells: readonly { id: string; priority: 'P0' | 'P1' | 'P2'; owner?: string; ageMin?: number }[],
  opts: { panes?: Map<string, string>; activity?: Map<string, { atMin: number; signal: string }>; activityThrows?: boolean } = {}) {
  let now = T0;
  const panes = opts.panes ?? new Map<string, string>();
  const board = new Map<string, ChecklistItem>();
  for (const c of cells) {
    board.set(c.id, { id: c.id, title: c.id, status: 'yellow', priority: c.priority, ...(c.owner ? { owner: c.owner } : {}),
      updatedAt: new Date(T0 - (c.ageMin ?? 5) * 60_000).toISOString(), updatedBy: 'OP' } as ChecklistItem);
  }
  const history: { cell: string; to: string | null }[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const returns: { cell: string; reason: string }[] = [];
  let mailId = 0;
  const pool = (): HandPoolEntry[] => hands.map(seat => {
    const held = [...board.values()].find(c => c.status === 'yellow' && c.owner === seat);
    const pane = panes.get(seat);
    return held ? { seat, home: 'TC', state: 'working', scope: 'TC', cell: held.id, lent: false, closeCandidate: false, ...(pane ? { pane } : {}) }
      : { seat, home: 'TC', state: 'idle', lent: false, closeCandidate: false, since: T0 - hands.indexOf(seat) * 1_000, ...(pane ? { pane } : {}) };
  });
  const deps: SeatAssignDeps = {
    now: () => new Date(now),
    coordinators: () => ({ hq: 'OP', spaces: ['TC'] }),
    federationSeats: () => new Set(['OP', 'TC', ...hands]),
    findCell: id => { const item = board.get(id); return item ? { version: '0.3.38', item } : undefined; },
    writers: () => [],
    assign: (_v, id, seat) => {
      const item = board.get(id)!;
      const from = item.owner ?? null;
      board.set(id, { ...item, owner: seat, updatedAt: new Date(now).toISOString() });
      history.push({ cell: id, to: seat });
      return { from, outcome: from === seat ? 'same' : 'assigned' };
    },
    post: () => ({ id: ++mailId }),
    wake: async () => ({ result: 'injected' }),
    pool: () => ({ hosts: ['node-b'], scope: 'x', source: 'code-default' }),
    handPool: () => pool(),
    log: (event, data) => { logs.push({ event, data }); },
    targetVersion: () => '0.3.38',
    heldCells: () => [...board.values()],
    wip1Policy: () => POLICY,
    cellActivity: (_seat, id, sinceMs) => {
      if (opts.activityThrows) throw new Error('gh down');
      const a = opts.activity?.get(id);
      return a && T0 - a.atMin * 60_000 >= sinceMs ? { atMs: T0 - a.atMin * 60_000, signal: a.signal } : null;
    },
    returnToBoard: (id, reason) => {
      const item = board.get(id)!;
      board.set(id, { ...item, owner: undefined } as ChecklistItem);
      history.push({ cell: id, to: null });
      returns.push({ cell: id, reason });
      return { ok: true, line: `veto ${id}: unassigned ${item.owner} (back to the board)` };
    },
  };
  const activeOf = (seat: string) => [...board.values()].filter(c => c.status === 'yellow' && c.owner === seat && now - Date.parse(c.updatedAt) <= POLICY.activeWindowMs);
  return { board, history, logs, returns, deps, activeOf, panes, tick: (ms: number) => { now += ms; }, now: () => now };
}

const totals = { displaced: 0, keptActive: 0 };

describe('SIM WIP-1 assign guard (live 12:10 — P1 stacked on an active P0)', () => {
  test('hand with an active P0 + assign P1 → refused «WIP-1: <hand> holds <cell>», the top idle hand suggested', async () => {
    const w = world(['TC-H-1', 'TC-H-2', 'TC-H-3'], [{ id: 'HOT-P0', priority: 'P0', owner: 'TC-H-1' }, { id: 'NEW-P1', priority: 'P1' }, { id: 'BUSY', priority: 'P2', owner: 'TC-H-2' }]);
    const r = await seatAssign({ seat: 'TC-H-1', cellId: 'NEW-P1', actor: 'OP' }, w.deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('wip-1');
    expect(r.suggest).toBe('TC-H-3');
    expect(r.reason).toBe('seat assign: WIP-1: TC-H-1 holds HOT-P0 (P0) — NEW-P1 (P1) not stacked; suggest TC-H-3 (idle · TC pool): eln seat assign TC-H-3 NEW-P1');
    expect(w.board.get('NEW-P1')!.owner).toBeUndefined();
    expect(w.logs.filter(l => l.event === 'seat.assign.refused' && l.data.code === 'wip-1').length).toBe(1);
  });

  test('the steward and --force/--p0 follow the same guard', async () => {
    const w = world(['TC-H-1', 'TC-H-2'], [{ id: 'HOT-P0', priority: 'P0', owner: 'TC-H-1' }, { id: 'NEW-P1', priority: 'P1' }]);
    for (const extra of [{ steward: true }, { force: true }, { p0: true }]) {
      const r = await seatAssign({ seat: 'TC-H-1', cellId: 'NEW-P1', actor: 'OP', caller: 'resource-steward', ...extra }, w.deps);
      expect(r.ok ? 'ok' : r.code).toBe('wip-1');
    }
  });

  test('equal priority never preempts (P0 onto P0 → refused)', async () => {
    const w = world(['TC-H-1'], [{ id: 'A-P0', priority: 'P0', owner: 'TC-H-1' }, { id: 'B-P0', priority: 'P0' }]);
    const r = await seatAssign({ seat: 'TC-H-1', cellId: 'B-P0', actor: 'OP' }, w.deps);
    expect(r.ok ? 'ok' : r.code).toBe('wip-1');
    if (!r.ok) expect(r.reason).toBe('seat assign: WIP-1: TC-H-1 holds A-P0 (P0) — B-P0 (P0) not stacked; no idle hand — B-P0 stays on the board for pull');
  });

  test('assign P0 over a P1 not worked for 60 min → allowed, the P1 goes back to the board (veto path), then no flap', async () => {
    const w = world(['TC-H-1', 'TC-H-2'], [{ id: 'OLD-P1', priority: 'P1', owner: 'TC-H-1', ageMin: 60 }, { id: 'NEW-P0', priority: 'P0' }], { panes: new Map([['TC-H-1', 'IDLE']]) });
    const r = await seatAssign({ seat: 'TC-H-1', cellId: 'NEW-P0', actor: 'OP' }, w.deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.returned).toEqual(['OLD-P1']);
    expect(w.board.get('OLD-P1')!.owner).toBeUndefined();
    expect(w.board.get('NEW-P0')!.owner).toBe('TC-H-1');
    expect(w.returns).toEqual([{ cell: 'OLD-P1', reason: 'WIP-1: OP assigned NEW-P0 (P0) to TC-H-1, above OLD-P1 (P1)' }]);
    expect(r.lines.includes('↩ veto OLD-P1: unassigned TC-H-1 (back to the board)')).toBe(true);
    // flap check: the returned P1 back onto the same hand is refused; it goes to the idle hand instead
    w.tick(60_000);
    const back = await seatAssign({ seat: 'TC-H-1', cellId: 'OLD-P1', actor: 'OP' }, w.deps);
    expect(back.ok ? 'ok' : back.code).toBe('wip-1');
    if (!back.ok) expect(back.suggest).toBe('TC-H-2');
    const other = await seatAssign({ seat: 'TC-H-2', cellId: 'OLD-P1', actor: 'OP' }, w.deps);
    expect(other.ok).toBe(true);
    expect(w.history).toEqual([{ cell: 'OLD-P1', to: null }, { cell: 'NEW-P0', to: 'TC-H-1' }, { cell: 'OLD-P1', to: 'TC-H-2' }]);
  });

  test('live 15:5x replay: TC-H-CC-1 implementing YAML-DEF-LOADER (P1 · pane WORKING) + a P0 → refused «actively on», the P1 kept', async () => {
    const w = world(['TC-H-CC-1', 'TC-H-CC-2'], [{ id: 'YAML-DEF-LOADER', priority: 'P1', owner: 'TC-H-CC-1', ageMin: 70 }, { id: 'HOT-P0', priority: 'P0' }],
      { panes: new Map([['TC-H-CC-1', 'WORKING']]) });
    const r = await seatAssign({ seat: 'TC-H-CC-1', cellId: 'HOT-P0', actor: 'OP' }, w.deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('wip-1');
    expect(r.suggest).toBe('TC-H-CC-2');
    expect(r.reason).toBe('seat assign: WIP-1: TC-H-CC-1 actively on YAML-DEF-LOADER (P1 · pane WORKING) — HOT-P0 (P0) does not displace it; suggest TC-H-CC-2 (idle · TC pool): eln seat assign TC-H-CC-2 HOT-P0');
    expect(w.board.get('YAML-DEF-LOADER')!.owner).toBe('TC-H-CC-1');
    expect(w.returns).toEqual([]);
    expect(w.logs.find(l => l.event === 'seat.assign.refused')!.data.why).toBe('actively-on');
  });

  test('each activity signal inside 30 min keeps the lower cell: ledger 12m · commit 10m · push 25m · check unavailable', async () => {
    const cases: [ReturnType<typeof world>, string][] = [
      [world(['TC-H-1'], [{ id: 'LOW', priority: 'P1', owner: 'TC-H-1', ageMin: 12 }, { id: 'HI', priority: 'P0' }]), 'ledger 12m ago'],
      [world(['TC-H-1'], [{ id: 'LOW', priority: 'P1', owner: 'TC-H-1', ageMin: 90 }, { id: 'HI', priority: 'P0' }], { activity: new Map([['LOW', { atMin: 10, signal: 'commit tc/low-fix' }]]) }), 'commit tc/low-fix 10m ago'],
      [world(['TC-H-1'], [{ id: 'LOW', priority: 'P1', owner: 'TC-H-1', ageMin: 90 }, { id: 'HI', priority: 'P0' }], { activity: new Map([['LOW', { atMin: 25, signal: 'push PR #41000' }]]) }), 'push PR #41000 25m ago'],
      [world(['TC-H-1'], [{ id: 'LOW', priority: 'P1', owner: 'TC-H-1', ageMin: 90 }, { id: 'HI', priority: 'P0' }], { activityThrows: true }), 'activity check unavailable'],
    ];
    for (const [w, signal] of cases) {
      const r = await seatAssign({ seat: 'TC-H-1', cellId: 'HI', actor: 'OP' }, w.deps);
      expect(r.ok ? 'ok' : r.reason).toBe(`seat assign: WIP-1: TC-H-1 actively on LOW (P1 · ${signal}) — HI (P0) does not displace it; no idle hand — HI stays on the board for pull`);
      expect(w.board.get('LOW')!.owner).toBe('TC-H-1');
    }
  });

  test('activity 31 min old and an IDLE pane → the P0 displaces the P1', async () => {
    const w = world(['TC-H-1'], [{ id: 'LOW', priority: 'P1', owner: 'TC-H-1', ageMin: 45 }, { id: 'HI', priority: 'P0' }],
      { panes: new Map([['TC-H-1', 'IDLE']]), activity: new Map([['LOW', { atMin: 31, signal: 'commit tc/low' }]]) });
    const r = await seatAssign({ seat: 'TC-H-1', cellId: 'HI', actor: 'OP' }, w.deps);
    expect(r.ok && r.returned).toEqual(['LOW']);
    expect(w.board.get('HI')!.owner).toBe('TC-H-1');
  });

  test('a stale owned cell (no activity in the window) does not block; it goes back to the board', async () => {
    const w = world(['TC-H-1'], [{ id: 'STALE-P0', priority: 'P0', owner: 'TC-H-1', ageMin: 600 }, { id: 'NEW-P1', priority: 'P1' }]);
    // the pool shows the hand working on STALE-P0 → active (the pane is the activity) → refused
    expect((await seatAssign({ seat: 'TC-H-1', cellId: 'NEW-P1', actor: 'OP' }, w.deps)).ok).toBe(false);
    const d = wip1Decide({ seat: 'TC-H-1', cell: { id: 'NEW-P1', priority: 'P1' }, held: [...w.board.values()], pool: [{ seat: 'TC-H-1', home: 'TC', state: 'idle', lent: false, closeCandidate: false }], nowMs: T0, policy: POLICY });
    expect(d.kind).toBe('clear');
    if (d.kind === 'clear') expect(d.stale.map(c => c.id)).toEqual(['STALE-P0']);
  });

  test('live 16:3x replay: a hand the pool view calls idle but holding an active P0 (TC-H-POOL-3) is never suggested nor POOL-picked', async () => {
    const cells = [{ id: 'A-P0', priority: 'P0' as const, owner: 'TC-H-POOL-2', ageMin: 5 }, { id: 'HOT-P0', priority: 'P0' as const, owner: 'TC-H-POOL-3', ageMin: 5 },
      { id: 'YAML-DEF-LOADER', priority: 'P1' as const }];
    const idle = (seat: string, since: number, pane?: string): HandPoolEntry => ({ seat, home: 'TC', state: 'idle', lent: false, closeCandidate: false, since, ...(pane ? { pane } : {}) });
    // the pool view lags the ledger: POOL-3 shows idle and is the longest idle; POOL-4's pane is WORKING
    const view = (withFree: boolean): HandPoolEntry[] => [
      { seat: 'TC-H-POOL-2', home: 'TC', state: 'working', scope: 'TC', cell: 'A-P0', lent: false, closeCandidate: false },
      idle('TC-H-POOL-3', T0 - 90 * 60_000), idle('TC-H-POOL-4', T0 - 80 * 60_000, 'WORKING'),
      ...(withFree ? [idle('TC-H-POOL-5', T0 - 10 * 60_000, 'IDLE')] : [])];
    const hands = ['TC-H-POOL-2', 'TC-H-POOL-3', 'TC-H-POOL-4', 'TC-H-POOL-5'];
    for (const withFree of [true, false]) {
      const w = world(hands, cells);
      const deps = { ...w.deps, handPool: () => view(withFree) };
      const named = await seatAssign({ seat: 'TC-H-POOL-2', cellId: 'YAML-DEF-LOADER', actor: 'OP' }, deps);
      expect(named.ok).toBe(false);
      if (named.ok) continue;
      expect(named.suggest).toBe(withFree ? 'TC-H-POOL-5' : undefined);
      expect(named.reason).toBe(withFree
        ? 'seat assign: WIP-1: TC-H-POOL-2 holds A-P0 (P0) — YAML-DEF-LOADER (P1) not stacked; suggest TC-H-POOL-5 (idle · TC pool): eln seat assign TC-H-POOL-5 YAML-DEF-LOADER'
        : 'seat assign: WIP-1: TC-H-POOL-2 holds A-P0 (P0) — YAML-DEF-LOADER (P1) not stacked; no idle hand — YAML-DEF-LOADER stays on the board for pull');
      expect(named.reason.includes('TC-H-POOL-3')).toBe(false);
      expect(named.reason.includes('TC-H-POOL-4')).toBe(false);
      const pooled = await seatAssign({ seat: 'POOL', cellId: 'YAML-DEF-LOADER', actor: 'TC' }, deps);
      if (withFree) {
        expect(pooled.ok && pooled.seat).toBe('TC-H-POOL-5');
      } else {
        expect(pooled.ok ? 'ok' : pooled.reason).toBe('seat assign: no idle hand — YAML-DEF-LOADER stays on the board for pull (3 hands, none with zero active cells)');
        expect(w.board.get('YAML-DEF-LOADER')!.owner).toBeUndefined();
      }
      expect(w.board.get('HOT-P0')!.owner).toBe('TC-H-POOL-3');
    }
  });

  test('freeHands: zero active cells only (pool idle · pane not busy · no yellow cell touched in the window)', () => {
    const held = [{ id: 'X', status: 'yellow' as const, owner: 'H3', priority: 'P0' as const, updatedAt: new Date(T0 - 5 * 60_000).toISOString() },
      { id: 'Y', status: 'yellow' as const, owner: 'H6', priority: 'P1' as const, updatedAt: new Date(T0 - 600 * 60_000).toISOString() }];
    const e = (seat: string, state: HandPoolEntry['state'], pane?: string): HandPoolEntry => ({ seat, home: 'TC', state, lent: false, closeCandidate: false, ...(pane ? { pane } : {}) });
    const pool = [e('H1', 'idle'), e('H2', 'working'), e('H3', 'idle'), e('H4', 'idle', 'WAITING_APPROVAL'), e('H5', 'no-pane'), e('H6', 'idle', 'IDLE')];
    expect(freeHands(pool, held, T0, POLICY).map(h => h.seat)).toEqual(['H1', 'H6']);
  });

  test('coordinators are not WIP-bound (not in the hand pool)', async () => {
    const w = world(['TC-H-1'], [{ id: 'A', priority: 'P0', owner: 'TC' }, { id: 'B', priority: 'P1' }]);
    expect((await seatAssign({ seat: 'TC', cellId: 'B', actor: 'OP' }, w.deps)).ok).toBe(true);
  });

  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: a random assign storm keeps every hand at ≤ 1 active cell and never flaps a cell back onto the hand that lost it`, async () => {
      let s = seed;
      const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
      const hands = ['TC-H-1', 'TC-H-2', 'TC-H-3', 'TC-H-4'];
      const prios = ['P0', 'P1', 'P2'] as const;
      const cells = Array.from({ length: 12 }, (_, i) => ({ id: `C${i + 1}`, priority: prios[Math.floor(rand() * 3)]! }));
      const w = world(hands, cells);
      const lostBy = new Map<string, string>();
      for (let step = 0; step < 40; step++) {
        w.tick(3 * 60_000);
        for (const h of hands) w.panes.set(h, rand() < 0.4 ? 'WORKING' : 'IDLE');
        const snapshot = new Map([...w.board.values()].map(c => [c.id, { updatedAt: Date.parse(c.updatedAt), pane: c.owner ? w.panes.get(c.owner) : undefined }]));
        const seat = hands[Math.floor(rand() * hands.length)]!;
        const cell = cells[Math.floor(rand() * cells.length)]!.id;
        const owner = w.board.get(cell)!.owner;
        if (owner && owner !== seat) continue; // a held cell is moved by veto, not by assign
        const before = w.returns.length;
        const r = await seatAssign({ seat, cellId: cell, actor: 'OP' }, w.deps);
        for (const ret of w.returns.slice(before)) {
          lostBy.set(ret.cell, seat);
          // an actively worked cell is never displaced: ledger touched < 30 min ago, or the owner's pane WORKING
          const was = snapshot.get(ret.cell)!;
          expect(w.now() - was.updatedAt).toBeGreaterThan(30 * 60_000);
          expect(was.pane).not.toBe('WORKING');
          totals.displaced += 1;
        }
        if (!r.ok && r.reason.includes(' actively on ')) totals.keptActive += 1;
        if (r.ok && lostBy.get(cell) === seat) throw new Error(`flap: ${cell} returned from ${seat} and assigned back`);
        for (const h of hands) expect(w.activeOf(h).length).toBeLessThanOrEqual(1);
      }
      // every return names the hand that took the higher (or newer) cell
      for (const ret of w.returns) expect(ret.reason.startsWith('WIP-1: ')).toBe(true);
    });
  }

  test('seeds 1–5 together: active cells were kept and idle-ish cells were displaced', () => {
    expect(totals.keptActive).toBeGreaterThan(0);
    expect(totals.displaced).toBeGreaterThan(0);
  });
});

describe('policy + takeover rule (graphs/policies/seat-assign.yaml)', () => {
  test('the shipped policy parses; values come from YAML', () => {
    const p = loadSeatAssignPolicy();
    expect(p.wip1.priorityOrder).toEqual(['P0', 'P1', 'P2']);
    expect(p.takeover.replyWaitMin).toBe(30);
    expect(p.wip1.activeRecentMs).toBe(1_800_000);
    expect(p.wip1.activePanes).toEqual(['WORKING', 'WAITING_APPROVAL', 'WAITING_REPLY']);
    expect(p.takeover.staleHours).toBe(24);
    expect(priorityRank(undefined, p.wip1)).toBe(2);
  });

  test('a broken policy is loud', () => {
    expect(() => parseSeatAssignPolicy('wip1: {active_window_min: 0}')).toThrow();
  });

  test('POOL-PULL-NEEDS-SPEC: pull.requireDoneWhen ships true; absent = true; false = false; a non-boolean is loud', () => {
    expect(loadSeatAssignPolicy().pull.requireDoneWhen).toBe(true);
    const base = 'wip1: {active_window_min: 180, priority_order: [P0, P1, P2], unranked_as: P2, active_recent_min: 30, active_panes: [WORKING]}\n'
      + 'takeover: {reply_wait_min: 30, stale_hours: 24, keep_branch: wip-keep/x}\n';
    expect(parseSeatAssignPolicy(base).pull.requireDoneWhen).toBe(true);
    expect(parseSeatAssignPolicy(`${base}pull: {requireDoneWhen: false}\n`).pull.requireDoneWhen).toBe(false);
    expect(() => parseSeatAssignPolicy(`${base}pull: {requireDoneWhen: 'yes'}\n`)).toThrow('pull.requireDoneWhen must be true or false');
  });

  test('coordinator text states the takeover rule, never «do not touch»', () => {
    const rule = wipTakeoverRule({ replyWaitMin: 30, staleHours: 24, keepBranch: 'wip-keep/<seat>-<date>' });
    expect(rule).toContain('no reply in 30 min');
    expect(rule).toContain('wip-keep/<seat>-<date>');
    expect(rule).toContain('untouched for 24 h');
    const tc = leaderCard({ kind: 'space', seat: 'TC', space: 'build' });
    expect(tc).toContain('no reply in 30 min');
    expect(tc).toContain('WIP 1 per hand');
    expect(HAND_STANDARD_ANSWERS.join('\n')).not.toContain('do not touch them');
    expect(HAND_STANDARD_ANSWERS[2]).toContain('take it over');
  });
});
