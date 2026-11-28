// STEWARD-SPACE pure core — fixture ledgers → expected rows. Expected values are literals (rule 11: independent of the
// product's own constants/renderers).
import { describe, expect, test } from 'bun:test';
import { resolveScope } from './config.js';
import {
  emptyScopeState, exceptionCard, minutesToNextCut, planHandoff, planJudge, planMatch, planReceipts, planReclaim, planWatch, rollupLine, digestCounts,
  scopeOf, scopesOf, type Snapshot,
} from './model.js';
import { parsePanes, parseUtil } from './sources.js';

const NOW = Date.parse('2026-11-25T06:00:00.000Z');
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();
const agoMs = (min: number): number => NOW - min * 60_000;
const H = (c: string): string => c.repeat(40);

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    nowMs: NOW, hq: 'OP', coordinators: ['JUD', 'TC'],
    parent: { 'TC-H-CX-1': 'TC', 'TC-H-CX-2': 'TC', 'JUD-B': 'JUD', 'JUD-C': 'JUD', TC: 'OP', JUD: 'OP', 'MVP-B': 'OP' },
    seats: [
      { seat: 'TC-H-CX-1', activity: 'idle', idleForMs: 30 * 60_000 },
      { seat: 'TC-H-CX-2', activity: 'working', idleForMs: null },
      { seat: 'JUD-B', activity: 'idle', idleForMs: 40 * 60_000 },
      { seat: 'JUD-C', activity: 'idle', idleForMs: 15 * 60_000 },
      { seat: 'MVP-B', activity: 'idle', idleForMs: 50 * 60_000 },
      { seat: 'TC', activity: 'idle', idleForMs: 90 * 60_000 },
    ],
    version: '0.3.36',
    cells: [
      { id: 'CELL-A', title: 'a', status: 'yellow', owner: 'TC-H-CX-2', priority: 'P0', updatedAt: ago(180) },
      { id: 'CELL-B', title: 'b', status: 'yellow', owner: 'TC', priority: 'P0', updatedAt: ago(180) },
      { id: 'CELL-C', title: 'c', status: 'yellow', owner: 'TC-H-CX-1', priority: 'P0', updatedAt: ago(240) },
      { id: 'CELL-D', title: 'd', status: 'yellow', owner: 'JUD-C', priority: 'P0', updatedAt: ago(200) },
      { id: 'CELL-E', title: 'e', status: 'yellow', priority: 'P1', updatedAt: ago(30) },
      { id: 'CELL-F', title: 'f', status: 'green', owner: 'TC', priority: 'P0', updatedAt: ago(300) },
      { id: 'CELL-G', title: 'g', status: 'yellow', owner: 'TC', priority: 'P2', updatedAt: ago(300) },
      { id: 'CELL-H', title: 'h', status: 'yellow', owner: 'TC', priority: 'P1', updatedAt: ago(60) },
    ],
    prs: [
      { number: 101, head: H('a'), branch: 'tc-h-cx-1/foo', title: 't', draft: false, updatedAt: ago(20) },
      { number: 102, head: H('b'), branch: 'tc/bar', title: 't', draft: false, updatedAt: ago(20) },
      { number: 103, head: H('c'), branch: 'jud-b/x', title: 't', draft: false, updatedAt: ago(20) },
      { number: 104, head: H('d'), branch: 'tc/draft', title: 't', draft: true, updatedAt: ago(20) },
      { number: 105, head: H('e'), branch: 'tc/baz', title: 't', draft: false, updatedAt: ago(20) },
    ],
    merged: [
      { number: 90, branch: 'tc-h-cx-1/landed', mergedAtMs: agoMs(20) },
      { number: 91, branch: 'tc/landed2', mergedAtMs: agoMs(50) },
      { number: 92, branch: 'tc/old', mergedAtMs: agoMs(90) },
      { number: 93, branch: 'jud-b/landed', mergedAtMs: agoMs(10) },
    ],
    receipts: [
      { pr: 102, head12: 'bbbbbbbbbbbb', host: 'minim5', status: 'GATES_PASS_REVIEW_REQUIRED', atMs: agoMs(45) },
      { pr: 105, head12: 'ffffffffffff', host: 'node-b', status: 'LIGHT_PASS_NOT_FULL_GATE', atMs: agoMs(300) },
    ],
    verdicts: [],
    hosts: [
      { host: 'mshq', load1: 1, ncpu: 18, stopped: false },
      { host: 'minim5', load1: 6.5, ncpu: 18, stopped: false },
      { host: 'node-b', load1: 25, ncpu: 32, stopped: false },
      { host: 'node-c', load1: 4.4, ncpu: 14, stopped: false },
      { host: 'aws1', load1: null, ncpu: 16, stopped: true },
    ],
    utilAgeMs: 5 * 60_000,
    openHands: [{ receiver: 'TC', waitedMs: 12 * 60_000 }, { receiver: 'TC', waitedMs: 3 * 60_000 }],
    sourceErrors: [],
    ...over,
  };
}

const live = (scope: string, caps?: { assign?: number; pregate?: number; judge?: number }) =>
  resolveScope(scope, 'OP', { scopes: { [scope]: { mode: 'live', ...(caps ? { caps } : {}) } } });

describe('rail 30 · waiting cells ⊕ coordinator board', () => {
  // TC-H-CX-1 owns CELL-C whose PR #201 (title names the cell) has a green receipt on its head and no verdict yet.
  const waitingSnap = (verdicts: Snapshot['verdicts'] = []): Snapshot => snap({
    cells: [
      { id: 'CELL-C', title: 'c', status: 'yellow', owner: 'TC-H-CX-1', priority: 'P1', updatedAt: ago(20) },
      { id: 'CELL-H', title: 'h', status: 'yellow', owner: 'TC', priority: 'P1', updatedAt: ago(60) },
    ],
    prs: [{ number: 201, head: H('9'), branch: 'tc-h-cx-1/c', title: 'fix(x): thing (CELL-C)', draft: false, updatedAt: ago(20) }],
    receipts: [{ pr: 201, head12: '999999999999', host: 'minim5', status: 'LIGHT_PASS_NOT_FULL_GATE', atMs: agoMs(15) }],
    verdicts,
  });
  test('a hand whose every cell waits on JUD gets the leader-held board cell assigned (ADMIN-RESOLVE-NOT-NAG), not woken on its cell', () => {
    const plan = planMatch(waitingSnap(), { scope: live('TC'), state: emptyScopeState() });
    expect(plan.rows.map((r) => [r.action, r.target, r.seat, r.reason])).toEqual([['assign', 'CELL-H', 'TC-H-CX-1', 'pull-for-idle:idle-all-waiting:30m']]);
  });
  test('a FAIL verdict makes the cell active again → woken on its own cell', () => {
    const plan = planMatch(waitingSnap([{ pr: 201, head12: '999999999999', kind: 'jud', verdict: 'FAIL', atMs: agoMs(5) }]), { scope: live('TC'), state: emptyScopeState() });
    expect(plan.rows.map((r) => [r.action, r.target, r.seat, r.reason])).toEqual([['wake', 'CELL-C', 'TC-H-CX-1', 'idle-owner:30m']]);
  });
});

describe('reclaim limit boundary', () => {
  test('explicit cap controls eligible rows; unknown, zero and invalid values fail closed', () => {
    const s = snap({
      cells: Array.from({ length: 40 }, (_, i) => ({ id: `CELL-${i}`, title: 'c', status: 'yellow' as const, owner: 'TC-H-CX-1', priority: 'P1', updatedAt: ago(90) })),
      seats: [{ seat: 'TC-H-CX-1', activity: 'idle', idleForMs: 90 * 60_000 }],
      prs: [], receipts: [],
    });
    const scope = live('TC');
    expect(planReclaim(s, { scope }).length).toBe(8);
    expect(planReclaim(s, { scope, reclaimLimit: 8 }).length).toBe(8);
    expect(planReclaim(s, { scope, reclaimLimit: 32 }).length).toBe(32);
    expect(planMatch(s, { scope, state: emptyScopeState(), reclaimLimit: 32 }).rows.filter((r) => r.action === 'reclaim')).toHaveLength(32);
    expect(planMatch(s, { scope, state: emptyScopeState(), reclaimLimit: null }).rows.filter((r) => r.action === 'reclaim')).toHaveLength(0);
    for (const reclaimLimit of [0, null, -1, NaN, Infinity, 1.5]) {
      expect(planReclaim(s, { scope, reclaimLimit })).toEqual([]);
    }
  });
});

describe('scope membership', () => {
  test('hands belong to their coordinator, unknown seats to HQ, HQ last in the scope order', () => {
    const s = snap();
    expect(scopeOf(s, 'TC-H-CX-1')).toBe('TC');
    expect(scopeOf(s, 'JUD-C')).toBe('JUD');
    expect(scopeOf(s, 'TC')).toBe('TC');
    expect(scopeOf(s, 'NOBODY-9')).toBe('OP');
    expect(scopeOf(s, undefined)).toBe('OP');
    expect(scopesOf(s)).toEqual(['JUD', 'TC', 'OP']);
  });
  test('instance id and default profile per coordinator', () => {
    expect(resolveScope('JUD', 'OP', undefined)).toEqual({ scope: 'JUD', instanceId: 'steward:JUD', mode: 'off', profile: 'judge', caps: { assign: 4, pregate: 3, judge: 2 } });
    expect(resolveScope('OP', 'OP', undefined, true).profile).toBe('hq');
    expect(resolveScope('OP', 'OP', undefined, true).mode).toBe('shadow');
    expect(resolveScope('UX', 'OP', { scopes: { UX: { mode: 'live', caps: { assign: 8 } } }, caps: { pregate: 6 } }).caps).toEqual({ assign: 8, pregate: 6, judge: 2 });
  });
});

describe('R1 match', () => {
  test('idle owner is woken on its own cell (not reassigned), then no free hand → defer (capacity) and wanting for HQ', () => {
    const plan = planMatch(snap(), { scope: live('TC'), state: emptyScopeState() });
    expect(plan.rows.map((r) => [r.action, r.target, r.seat ?? null, r.reason])).toEqual([
      ['wake', 'CELL-C', 'TC-H-CX-1', 'idle-owner:30m'],
      ['defer', 'CELL-B', null, 'no-hand-in-scope'],
    ]);
    expect(plan.idleLeft).toEqual([]);
    expect(plan.wanting).toEqual(['CELL-B']);
  });
  test('two scopes never cross-assign: JUD assigns only JUD hands to JUD cells', () => {
    const jud = planMatch(snap(), { scope: live('JUD'), state: emptyScopeState() });
    // JUD-B owns nothing and the board has an unowned cell → nudged to pull; JUD-C is woken on its own cell.
    // (rail 30: pull nudges are emitted after the push pass, so the own-cell wake comes first.)
    expect(jud.rows.map((r) => [r.action, r.target, r.seat])).toEqual([['wake', 'CELL-D', 'JUD-C'], ['wake', 'JUD-B', 'JUD-B']]);
    expect(jud.idleLeft).toEqual([]);
    const tc = planMatch(snap(), { scope: live('TC'), state: emptyScopeState() });
    expect(tc.rows.some((r) => r.seat === 'JUD-B' || r.seat === 'JUD-C' || r.target === 'CELL-D')).toBe(false);
  });
  test('cross-scope only via HQ: HQ never lends a JUD hand to a maker P0 (maker ≠ judge); a P1 unowned cell waits for a pull', () => {
    const tc = planMatch(snap(), { scope: live('TC'), state: emptyScopeState() });
    // HQ's own hand is busy → the only lendable hand is JUD-B, a judge → the TC P0 waits (no RX card proposing JUD-B).
    const busyHq = snap({ seats: snap().seats.map((s) => (s.seat === 'MVP-B' ? { ...s, activity: 'working', idleForMs: null } : s)) });
    const hq = planMatch(busyHq, { scope: live('OP'), state: emptyScopeState(), wanting: tc.wanting, lendable: [{ seat: 'JUD-B', from: 'JUD' }] });
    expect(hq.rows.map((r) => [r.action, r.target, r.seat ?? null, r.reason])).toEqual([
      ['defer', 'CELL-B', null, 'no-idle-hand-anywhere'],
    ]);
    // rail 30: an idle HQ hand takes the P0 push itself (a push beats a pull nudge) — no nudge, nothing lent.
    const idleHq = planMatch(snap(), { scope: live('OP'), state: emptyScopeState(), wanting: tc.wanting, lendable: [{ seat: 'JUD-B', from: 'JUD' }] });
    expect(idleHq.rows.map((r) => [r.action, r.target, r.seat, r.lentFrom ?? null])).toEqual([
      ['assign', 'CELL-B', 'MVP-B', null],
    ]);
  });
  test('per-tick cap defers the rest; a recently assigned seat is in cooldown', () => {
    const state = emptyScopeState();
    state.seatCooldown['TC-H-CX-1'] = ago(5);
    const plan = planMatch(snap(), { scope: live('TC', { assign: 0 }), state });
    expect(plan.rows.map((r) => [r.action, r.target, r.reason])).toEqual([['defer', 'CELL-C', 'tick-cap'], ['defer', 'CELL-B', 'tick-cap']]);
    const cooled = planMatch(snap(), { scope: live('TC'), state });
    expect(cooled.rows.map((r) => [r.action, r.target])).toEqual([['defer', 'CELL-C'], ['defer', 'CELL-B']]);
  });
  test('HQ with no idle hand anywhere: every wanting cell is a defer row, none an exception', () => {
    const busy = snap({ seats: [{ seat: 'MVP-B', activity: 'working', idleForMs: null }] });
    const hq = planMatch(busy, { scope: live('OP'), state: emptyScopeState(), wanting: ['CELL-B'] });
    expect(hq.rows.map((r) => [r.action, r.target, r.reason])).toEqual([['defer', 'CELL-B', 'no-idle-hand-anywhere']]);
    expect(exceptionCard('OP', 'OP', hq.rows, emptyScopeState(), NOW)).toBeNull();
  });
});

describe('R1 wake (idle owner)', () => {
  // TC live 11-25 16:4x: «defer 26 · idle 10», 0 assigned — idle hands that own a yellow cell were never matched.
  const owners = (over: Partial<Snapshot> = {}): Snapshot => snap({
    coordinators: ['TC'],
    parent: { 'TC-W-1': 'TC', 'TC-W-2': 'TC', 'TC-W-3': 'TC', 'TC-W-4': 'TC', TC: 'OP' },
    seats: [
      { seat: 'TC-W-1', activity: 'idle', idleForMs: 25 * 60_000 },
      { seat: 'TC-W-2', activity: 'idle', idleForMs: 35 * 60_000 },
      { seat: 'TC-W-3', activity: 'idle', idleForMs: 40 * 60_000 },
      { seat: 'TC-W-4', activity: 'idle', idleForMs: 12 * 60_000 },
    ],
    cells: [
      { id: 'OWN-1', title: 'o1', status: 'yellow', owner: 'TC-W-1', priority: 'P1', updatedAt: ago(30) },
      { id: 'OWN-2', title: 'o2', status: 'yellow', owner: 'TC-W-2', priority: 'P0', updatedAt: ago(300) },
      { id: 'OWN-3', title: 'o3', status: 'yellow', owner: 'TC-W-3', priority: 'P0', updatedAt: ago(300) },
      { id: 'FREE-1', title: 'f1', status: 'yellow', priority: 'P1', updatedAt: ago(10) },
    ],
    openHands: [{ receiver: 'TC', waitedMs: 8 * 60_000, sender: 'TC-W-2', blockedSeat: 'TC-W-2' }],
    // TC-W-4 (owns nothing) called `eln work next` 5 min ago, after it went idle 12 min ago → pulled, not nudged.
    pulls: { 'TC-W-4': agoMs(5) },
    ...over,
  });

  test('3 idle owners, 1 with an open ✋, 1 woken 10 min ago → exactly 1 wake; no owner is a free hand or reassigned', () => {
    const state = emptyScopeState();
    state.woken = { 'TC-W-3': { at: ago(10), cell: 'OWN-3', count: 1 } };
    const plan = planMatch(owners(), { scope: live('TC'), state });
    expect(plan.rows.filter((r) => r.action === 'wake').map((r) => [r.target, r.seat, r.reason])).toEqual([['OWN-1', 'TC-W-1', 'idle-owner:25m']]);
    expect(plan.rows.map((r) => [r.action, r.target, r.seat ?? null, r.reason])).toEqual([
      ['defer', 'OWN-3', 'TC-W-3', 'wake-cooldown'],
      ['defer', 'OWN-2', 'TC-W-2', 'wake-skip:open-hand'],
      ['wake', 'OWN-1', 'TC-W-1', 'idle-owner:25m'],
    ]);
    expect(plan.wake.counts).toEqual({ 'TC-W-1': 1 });
    // TC-W-4 owns nothing: the only free hand left over (HQ may lend it to its unowned FREE-1).
    expect(plan.idleLeft).toEqual(['TC-W-4']);
  });

  test('shared wake ledger: a hand woken by another source 5 min ago is not woken by the steward (and its cell is held)', () => {
    const plan = planMatch(owners({ openHands: [], wakes: { 'TC-W-1': { by: 'idle-nudge', atMs: agoMs(5) } } }), { scope: live('TC'), state: emptyScopeState() });
    expect(plan.rows.filter((r) => r.seat === 'TC-W-1').map((r) => [r.action, r.target, r.reason])).toEqual([['defer', 'OWN-1', 'already-woken:idle-nudge@05:55Z']]);
    expect(plan.rows.filter((r) => r.action === 'wake').map((r) => r.seat)).toEqual(['TC-W-3', 'TC-W-2']);
  });

  test('cap: at most `assign` wakes per tick; the rest defer with wake-tick-cap and their cells are held', () => {
    const plan = planMatch(owners({ openHands: [] }), { scope: live('TC', { assign: 2 }), state: emptyScopeState() });
    expect(plan.rows.map((r) => [r.action, r.target, r.reason])).toEqual([
      ['wake', 'OWN-3', 'idle-owner:40m'],
      ['wake', 'OWN-2', 'idle-owner:35m'],
      ['defer', 'OWN-1', 'wake-tick-cap'],
    ]);
  });

  test('answered wake resets the count; 3 unanswered wakes → one exception line, no 4th wake, cell free for another hand', () => {
    // Woken 30 min ago, idle 40 min → no activity since the wake.
    const stale = emptyScopeState();
    stale.woken = { 'TC-W-3': { at: ago(30), cell: 'OWN-3', count: 3 } };
    const plan = planMatch(owners({ openHands: [] }), { scope: live('TC'), state: stale });
    expect(plan.rows.filter((r) => r.seat === 'TC-W-3' || r.target === 'TC-W-3').map((r) => [r.action, r.target, r.reason]))
      .toEqual([['ambiguous', 'TC-W-3', 'wake-not-answered:3x']]);
    const card = exceptionCard('TC', 'OP', plan.rows, emptyScopeState(), NOW);
    expect(card?.body.split('\n')[1]).toBe('- ambiguous TC-W-3 · TC-W-3 — wake-not-answered:3x');
    // The silent owner's stalled cell goes to the free hand (TC-W-4); TC-W-1 and TC-W-2 are woken on their own cells.
    expect(plan.rows.filter((r) => r.action === 'assign').map((r) => [r.target, r.seat, r.reason])).toEqual([['OWN-3', 'TC-W-4', 'stalled-from:TC-W-3']]);
    expect(plan.rows.filter((r) => r.action === 'wake').map((r) => r.seat)).toEqual(['TC-W-2', 'TC-W-1']);
    // Same record, but the pane re-entered idle 5 min ago (it ran a turn after the wake) → answered, a fresh first wake.
    const answered = planMatch(owners({ openHands: [], seats: [{ seat: 'TC-W-3', activity: 'idle', idleForMs: 25 * 60_000 }] }), { scope: live('TC'), state: stale });
    expect(answered.wake.answered).toEqual(['TC-W-3']);
    // TC-W-2 has no pane here: its OWN-2 lease runs from the cell's last change (300 min ago) → reclaimed to the board.
    expect(answered.rows.map((r) => [r.action, r.target, r.seat ?? null])).toEqual([['reclaim', 'OWN-2', 'TC-W-2'], ['wake', 'OWN-3', 'TC-W-3']]);
    expect(answered.wake.counts).toEqual({ 'TC-W-3': 1 });
  });

  test('rollup shows the tick\'s wakes only when there are some', () => {
    const c = { landedPerHour: 0, idle: 4, blocked: 0, openHands: 0, oldestHandMin: 0 };
    expect(rollupLine('TC', { ...c, woken: 3 })).toBe('TC · landed/h 0 · idle 4 · wake 3 · blocked 0 · ✋ 0');
    expect(rollupLine('TC', { ...c, woken: 0 })).toBe('TC · landed/h 0 · idle 4 · blocked 0 · ✋ 0');
  });
});

describe('R2 receipt', () => {
  // 출처: 내부 문서 `LOOP-AGENTS` §2 규칙 8 — fixture caps (load ≤ 0.7/core · 1 slot per host)
  const base = { hosts: ['mshq', 'minim5', 'node-b', 'node-c'], hostSlots: 1, maxLoadPerCore: 0.7, dispatchedAnywhere: new Set<string>(), inflightByHost: new Map<string, number>() };
  test('receipt-less non-draft PRs of the scope go to the least-loaded open host; mshq never; over-load host closed', () => {
    const rows = planReceipts(snap(), { ...base, scope: live('TC'), state: emptyScopeState() });
    expect(rows.map((r) => [r.action, r.target, r.host ?? null, r.seat ?? null, r.head12])).toEqual([
      ['dispatch', '#101', 'node-c', 'TC-H-CX-1', 'aaaaaaaaaaaa'],
      ['dispatch', '#105', 'minim5', 'TC', 'eeeeeeeeeeee'],
    ]);
  });
  test('cap, host slots full, stale UTIL and a global marker all hold back', () => {
    expect(planReceipts(snap(), { ...base, scope: live('TC', { pregate: 1 }), state: emptyScopeState() }).map((r) => [r.action, r.target, r.reason]))
      .toEqual([['dispatch', '#101', 'no-same-head-receipt'], ['defer', '#105', 'tick-cap']]);
    expect(planReceipts(snap(), { ...base, inflightByHost: new Map([['node-c', 1], ['minim5', 1]]), scope: live('TC'), state: emptyScopeState() }).map((r) => r.reason))
      .toEqual(['no-host-slot', 'no-host-slot']);
    expect(planReceipts(snap({ utilAgeMs: 40 * 60_000 }), { ...base, scope: live('TC'), state: emptyScopeState() }).map((r) => r.reason))
      .toEqual(['no-host-slot', 'no-host-slot']);
    expect(planReceipts(snap(), { ...base, dispatchedAnywhere: new Set(['101-aaaaaaaaaaaa']), scope: live('TC'), state: emptyScopeState() }).map((r) => r.target))
      .toEqual(['#105']);
  });
});

describe('R3 judge · R4 hand-off', () => {
  test('GREEN receipt without verdict 30m+ → idle judge hands, oldest first, security-4 marked', () => {
    const s = snap({
      prs: [
        { number: 102, head: H('b'), branch: 'tc/bar', title: 't', draft: false, updatedAt: ago(20) },
        { number: 106, head: H('6'), branch: 'tc/fresh', title: 't', draft: false, updatedAt: ago(20) },
        { number: 107, head: H('7'), branch: 'tc/judged', title: 't', draft: false, updatedAt: ago(20) },
        { number: 108, head: H('8'), branch: 'tc/oauth', title: 't', draft: false, updatedAt: ago(20), files: ['src/oauth/token.ts'] },
      ],
      receipts: [
        { pr: 102, head12: 'bbbbbbbbbbbb', host: 'minim5', status: 'GATES_PASS_REVIEW_REQUIRED', atMs: agoMs(45) },
        { pr: 106, head12: '666666666666', host: 'minim5', status: 'LIGHT_PASS_NOT_FULL_GATE', atMs: agoMs(10) },
        { pr: 107, head12: '777777777777', host: 'minim5', status: 'LIGHT_PASS_NOT_FULL_GATE', atMs: agoMs(50) },
        { pr: 108, head12: '888888888888', host: 'node-b', status: 'LIGHT_PASS_NOT_FULL_GATE', atMs: agoMs(60) },
      ],
      verdicts: [{ pr: 107, head12: '777777777777', kind: 'judb', verdict: 'pass', atMs: agoMs(40) }],
    });
    expect(planJudge(s, { scope: live('JUD'), state: emptyScopeState() }).map((r) => [r.action, r.target, r.seat, r.reason])).toEqual([
      ['judge-assign', '#108', 'JUD-B', 'green-no-verdict:security-4'],
      ['judge-assign', '#102', 'JUD-C', 'green-no-verdict'],
    ]);
    // JUD-HAND-DISCOVERY: caps.judge counts hands (batches) — one hand takes both items in one batch.
    expect(planJudge(s, { scope: live('JUD', { judge: 1 }), state: emptyScopeState() }).map((r) => [r.action, r.target, r.seat]))
      .toEqual([['judge-assign', '#108', 'JUD-B'], ['judge-assign', '#102', 'JUD-B']]);
    const noJudge = snap({ ...s, seats: [{ seat: 'JUD-B', activity: 'working', idleForMs: null }] });
    expect(planJudge(noJudge, { scope: live('JUD'), state: emptyScopeState() }).map((r) => [r.action, r.target, r.reason]))
      .toEqual([['defer', '#108', 'no-free-judge-hand:cooling=0,fresh=0,busy=1'], ['defer', '#102', 'no-free-judge-hand:cooling=0,fresh=0,busy=1']]);
    const noJudgeSeat = snap({ ...s, seats: [{ seat: 'TC-H-CX-1', activity: 'idle', idleForMs: 60 * 60_000 }] });
    expect(planJudge(noJudgeSeat, { scope: live('JUD'), state: emptyScopeState() }).map((r) => r.reason))
      .toEqual(['no-judge-hand', 'no-judge-hand']);
    expect(planHandoff(s, { scope: live('JUD') }).map((r) => [r.action, r.target, r.reason])).toEqual([['ambiguous', '#107', 'pass-not-landed']]);
  });
  test('fresh PASS → hand-off to the poller; a hold blocks the hand-off', () => {
    const s = snap({
      verdicts: [
        { pr: 101, head12: 'aaaaaaaaaaaa', kind: 'jud', verdict: 'pass', atMs: agoMs(5) },
        { pr: 105, head12: 'eeeeeeeeeeee', kind: 'judb', verdict: 'pass', atMs: agoMs(5) },
        { pr: 105, head12: 'eeeeeeeeeeee', kind: 'hold', verdict: 'hold', atMs: agoMs(4) },
      ],
    });
    expect(planHandoff(s, { scope: live('JUD') }).map((r) => [r.action, r.target, r.reason])).toEqual([['handoff', '#101', 'pass-to-poller']]);
  });
});

describe('R5 watch · R6 digest · X card', () => {
  test('assignment not picked after 20m, receipt arrival, stuck pregate; REL cut readiness; RES VM pressure', () => {
    const state = emptyScopeState();
    state.assigned['CELL-C'] = { seat: 'TC-H-CX-1', at: ago(25) };
    state.dispatched['101'] = { head12: 'aaaaaaaaaaaa', host: 'node-c', at: ago(70) };
    state.dispatched['102'] = { head12: 'bbbbbbbbbbbb', host: 'minim5', at: ago(50) };
    const w = planWatch(snap(), { scope: live('TC'), state, cutTimes: ['04:00', '16:00'], cutWindowMinutes: 120, timeZoneOffsetMinutes: 540 });
    expect(w.rows.map((r) => [r.action, r.target, r.reason])).toEqual([
      ['ambiguous', 'CELL-C', 'assign-not-picked'],
      ['ambiguous', '#101', 'pregate-stuck'],
      ['watch', '#102', 'receipt:GATES_PASS_REVIEW_REQUIRED'],
    ]);
    expect(w.resolvedPrs.sort()).toEqual(['101', '102']);
    // 출처: 내부 문서 `LOOP-AGENTS` — 15:00 KST fixture → 16:00 cut in 60 minutes
    expect(minutesToNextCut(NOW, ['04:00', '16:00'], 540)).toEqual({ cut: '16:00', minutes: 60 });
    const rel = planWatch(snap(), { scope: { ...live('REL'), profile: 'release' }, state: emptyScopeState(), cutTimes: ['04:00', '16:00'], cutWindowMinutes: 120, timeZoneOffsetMinutes: 540 });
    expect(rel.rows.map((r) => [r.target, r.reason])).toEqual([['cut@16:00', 'cut-readiness:P0-open=4:in=60m']]);
    const many = Array.from({ length: 11 }, (_, i) => ({ number: 200 + i, head: H('9'), branch: 'tc/x', title: 't', draft: false, updatedAt: ago(1) }));
    const res = planWatch(snap({ prs: many }), { scope: { ...live('RES'), profile: 'resource' }, state: emptyScopeState(), cutTimes: [], cutWindowMinutes: 0 });
    expect(res.rows.map((r) => [r.target, r.reason])).toEqual([['vm-pressure', 'receiptless=11:stopped=aws1']]);
  });
  test('rollup line counts landed/h, idle, blocked and open ✋ for the scope only', () => {
    expect(rollupLine('TC', digestCounts(snap(), 'TC'))).toBe('TC · landed/h 2 · idle 1 · blocked 0 · ✋ 2 (oldest 12m)');
    expect(rollupLine('JUD', digestCounts(snap(), 'JUD'))).toBe('JUD · landed/h 1 · idle 2 · blocked 0 · ✋ 0');
  });
  test('card: sub-scope sends reject/ambiguous to its coordinator, keeps escalations for HQ; HQ cards everything; repeats suppressed', () => {
    const rows = [
      { node: 'r1', scope: 'TC', action: 'escalate' as const, target: 'CELL-B', reason: 'no-hand-in-scope', mode: 'live' as const },
      { node: 'r5', scope: 'TC', action: 'ambiguous' as const, target: '#101', head12: 'aaaaaaaaaaaa', reason: 'pregate-stuck', mode: 'live' as const },
      { node: 'r1', scope: 'OP', action: 'escalate' as const, target: 'CELL-Z', reason: 'no-idle-hand-anywhere', mode: 'live' as const },
    ];
    const tc = exceptionCard('TC', 'OP', rows, emptyScopeState(), NOW)!;
    expect(tc.to).toBe('TC');
    expect(tc.body).toBe(`[행정관 · TC] 예외 카드 1건\n- ambiguous #101@aaaaaaaaaaaa — pregate-stuck\n담당: TC · 기한: ${new Date(NOW + 30 * 60_000).toISOString()}\n다음 행동: 각 예외를 해결하거나 담당자와 기한을 정해 보드에 인계하세요. 결정은 다음 틱이 집행합니다.`);
    const hq = exceptionCard('OP', 'OP', rows, emptyScopeState(), NOW)!;
    expect(hq.title).toBe('[행정관 · OP] 예외 카드 1건');
    const seen = emptyScopeState();
    for (const key of tc.keys) seen.cards[key] = ago(10);
    expect(exceptionCard('TC', 'OP', rows, seen, NOW)).toBeNull();
  });
  test('card: one per scope, duplicates counted once, at most 10 lines then the count', () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({ node: 'r4', scope: 'JUD', action: 'ambiguous' as const, target: `#${500 + i}`, reason: 'pass-not-landed', mode: 'shadow' as const }));
    const card = exceptionCard('JUD', 'OP', [...rows, rows[0]!, rows[1]!], emptyScopeState(), NOW)!;
    const lines = card.body.split('\n');
    expect(lines[0]).toBe('[행정관 · JUD] 예외 카드 14건');
    expect(lines.filter((l) => l.startsWith('- ')).length).toBe(10);
    expect(lines[1]).toBe('- ambiguous #500 — pass-not-landed');
    expect(lines[11]).toBe('… 외 4건 (eln steward space status --scope JUD)');
    expect(card.keys.length).toBe(14);
  });
});

describe('source parsers', () => {
  test('els panes: one seat in two panes is as busy as its busiest pane; seatless panes ignored; idle needs a timestamp', () => {
    const seats = parsePanes({ panes: [
      { seat: 'TC-H-CX-1', activityState: 'idle', lastEventAtMs: agoMs(30) },
      { seat: 'TC-H-CX-1', activityState: 'working', lastEventAtMs: agoMs(1) },
      { seat: 'JUD-B', activityState: 'idle', lastEventAtMs: agoMs(40) },
      { seat: 'JUD-C', activityState: 'idle' },
      { activityState: 'idle', lastEventAtMs: agoMs(99) },
    ] }, NOW);
    expect(seats).toEqual([
      { seat: 'TC-H-CX-1', activity: 'working', idleForMs: null },
      { seat: 'JUD-B', activity: 'idle', idleForMs: 2_400_000 },
      { seat: 'JUD-C', activity: 'idle', idleForMs: null },
    ]);
  });
  test('els panes: idle time counts from status.since (entered idle), not the last screen event', () => {
    const seats = parsePanes({ panes: [
      { seat: 'TC-H-CX-2', activityState: 'idle', lastEventAtMs: agoMs(1), status: { state: 'IDLE', since: agoMs(14) } },
      { seat: 'TC-H-CX-7', activityState: 'working', lastEventAtMs: agoMs(1), status: { state: 'WORKING', since: agoMs(2) } },
      { seat: 'TC-H-CX-9', activityState: 'idle', lastEventAtMs: agoMs(1), status: { state: 'WAITING', since: agoMs(30) } },
    ] }, NOW);
    expect(seats).toEqual([
      { seat: 'TC-H-CX-2', activity: 'idle', idleForMs: 840_000 },
      { seat: 'TC-H-CX-7', activity: 'working', idleForMs: null },
      { seat: 'TC-H-CX-9', activity: 'idle', idleForMs: null },
    ]);
  });
  test('UTIL tsv: stopped and unmeasured hosts stay null', () => {
    expect(parseUtil('host\tload1\tncpu\tx\nminim5\t6.53\t18\t-\naws1\tstopped\t16\t-\ngcp2\tunmeasured\tunknown\t-\n')).toEqual([
      { host: 'minim5', load1: 6.53, ncpu: 18, stopped: false },
      { host: 'aws1', load1: null, ncpu: 16, stopped: true },
      { host: 'gcp2', load1: null, ncpu: null, stopped: false },
    ]);
  });
});

describe('maker ≠ judge (RX-1..4 · 11-25 live: JUD-B / JUD-3 proposed for implementation cells)', () => {
  const rx = (roles: Record<string, string> = {}): Snapshot => snap({
    coordinators: ['JUD', 'TC', 'UX'],
    parent: { 'JUD-B': 'JUD', 'JUD-3': 'JUD', 'ARBITER-1': 'UX', 'TC-H-CX-1': 'TC', TC: 'OP', JUD: 'OP', UX: 'OP' },
    seats: [
      { seat: 'JUD-B', activity: 'idle', idleForMs: 60 * 60_000 },
      { seat: 'JUD-3', activity: 'idle', idleForMs: 55 * 60_000 },
      { seat: 'ARBITER-1', activity: 'idle', idleForMs: 50 * 60_000 },
      { seat: 'TC-H-CX-1', activity: 'working', idleForMs: null },
    ],
    cells: [
      { id: 'DEMO-INVEST-ORCH-PIN', title: 'pin the invest orchestration demo', status: 'yellow', priority: 'P0', updatedAt: ago(200) },
      { id: 'CHECKLIST-OWNER-HAND-SEATS', title: 'checklist owner = hand seats', status: 'yellow', priority: 'P0', updatedAt: ago(190) },
      { id: 'ELS-SERVER-COLOR-ENV', title: 'els server color env', status: 'yellow', priority: 'P1', updatedAt: ago(180) },
      { id: 'WAIT-CYCLE-DETECTOR', title: 'wait cycle detector', status: 'yellow', priority: 'P1', owner: 'TC', updatedAt: ago(170) },
    ],
    roles,
  });
  const lendable = [{ seat: 'JUD-B', from: 'JUD' }, { seat: 'JUD-3', from: 'JUD' }, { seat: 'ARBITER-1', from: 'UX' }];

  test('HQ R1 never pairs JUD-B / JUD-3 with the four implementation cells → no assign row, no RX card naming them', () => {
    const tc = planMatch(rx(), { scope: live('TC'), state: emptyScopeState() });
    const plan = planMatch(rx(), { scope: live('OP'), state: emptyScopeState(), wanting: tc.wanting, lendable });
    const assigns = plan.rows.filter((r) => r.action === 'assign').map((r) => [r.target, r.seat]);
    expect(assigns).toEqual([['DEMO-INVEST-ORCH-PIN', 'ARBITER-1']]);
    expect(plan.rows.some((r) => r.seat === 'JUD-B' || r.seat === 'JUD-3')).toBe(false);
    const card = exceptionCard('OP', 'OP', plan.rows, emptyScopeState(), NOW);
    expect(card?.body.includes('JUD-B') || card?.body.includes('JUD-3') || false).toBe(false);
  });

  test('role from federation.yaml: ARBITER-1 declared «judge» is a judge too → every implementation cell waits', () => {
    const tc = planMatch(rx({ 'ARBITER-1': 'judge' }), { scope: live('TC'), state: emptyScopeState() });
    const plan = planMatch(rx({ 'ARBITER-1': 'judge' }), { scope: live('OP'), state: emptyScopeState(), wanting: tc.wanting, lendable });
    expect(plan.rows.filter((r) => r.action === 'assign')).toEqual([]);
    expect(plan.rows.filter((r) => r.action === 'defer').map((r) => [r.target, r.reason])).toEqual([
      ['DEMO-INVEST-ORCH-PIN', 'no-idle-hand-anywhere'], ['CHECKLIST-OWNER-HAND-SEATS', 'no-idle-hand-anywhere'],
    ]);
  });
});
