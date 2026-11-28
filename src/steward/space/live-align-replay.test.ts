// REPLAY — the 11-28 live R0 snapshots (fixtures/hq-live-1128-*.json · ~/.elanous/steward/space/runs/<id>.json trimmed:
// seats · ladder · open ✋ · pulls · wakes · PRs that name a board cell · their receipts; the 0.3.39 board read after,
// owners/status rewound to the snapshot time from the checklist history; evidence kept only as its roster tag).
// Two engines: A = the pure planners (planHqPairs shadow · planMatch per scope) · B = the live node runner (r1 → x, every
// scope as configured that night, world effects: seat assign writes the owner back, boardNow reads the same board).
// «before» = what ran that night · «after» = #40624 (board in play) ⊕ #40627 (live numbers). Expected values are literals.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveScope, type StewardSpaceConfig } from './config.js';
import { loadHqPolicy, planHqPairs } from './hq-shadow.js';
import { DEFAULT_LIVE_R1, emptyScopeState, LEGACY_R1, planMatch, scopesOf, type CellView, type LiveR1Policy, type Snapshot } from './model.js';
import { runStewardSpaceNode, type StewardEffects, type TickDeps } from './tick.js';

interface Fixture { runId: string; startedAt: string; snapshot: Snapshot; board0339: CellView[]; snapshotBoardCounts: Record<string, string | number> }
const fixture = (name: string): Fixture => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', `hq-live-1128-${name}z.json`), 'utf8')) as Fixture;
// `loops.stewardSpace` as it stood in ~/.elanous/config.json that night.
const CONFIG: StewardSpaceConfig = { scopes: { TC: { mode: 'live' }, JUD: { mode: 'live', caps: { judge: 4 } }, UX: { mode: 'live' }, MK: { mode: 'shadow' }, OP: { mode: 'live' } } };
const inPlay = (f: Fixture): Snapshot => ({ ...f.snapshot, version: '0.3.39', cells: f.board0339 });

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'live-align-replay-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Engine B — the snapshot as an R0 run file, then the real r1 and x nodes. Returns the live assigns in order. */
function runner(snap: Snapshot, startedAt: string, r1: LiveR1Policy): string[] {
  mkdirSync(join(root, 'steward', 'space', 'runs'), { recursive: true });
  const scopes = scopesOf(snap).map((s) => resolveScope(s, snap.hq, CONFIG)).filter((s) => s.mode !== 'off');
  writeFileSync(join(root, 'steward', 'space', 'runs', 'replay.json'), JSON.stringify({ runId: 'replay', startedAt, input: { runId: 'replay' }, scopes, snapshot: snap, rows: [], ticks: {} }));
  const board = snap.cells.map((c) => ({ ...c }));
  const assigns: string[] = [];
  const effects: StewardEffects = {
    mail: () => {}, dispatchPregate: () => ({ ok: true }), releaseCell: () => ({ ok: true }),
    assignCell: ({ version, cellId, seat }) => { const c = board.find((x) => x.id === cellId); if (c) (c as { owner?: string }).owner = seat; assigns.push(`${cellId}->${seat}@${version}`); return { ok: true, via: 'replay' }; },
    boardNow: () => board.map((c) => ({ id: c.id, status: c.status, ...(c.owner ? { owner: c.owner } : {}) })),
  };
  const d: TickDeps = { root, now: () => new Date(snap.nowMs), config: CONFIG, sources: () => { throw new Error('replay: no r0'); }, effects, liveR1: () => ({ policy: r1, source: 'yaml' }) };
  for (const node of ['r1', 'x'] as const) expect(runStewardSpaceNode(node, { runId: 'replay' }, d).outcome).toBe('ok');
  return assigns;
}
/** Engine A — planMatch for one scope (no other scope ran). */
const pure = (snap: Snapshot, scope: string, r1: LiveR1Policy): string[] =>
  planMatch(snap, { scope: resolveScope(scope, snap.hq, CONFIG), state: emptyScopeState(), r1 }).rows.filter((r) => r.action === 'assign').map((r) => `${r.target}->${r.seat}${r.lentFrom ? ` (lent ${r.lentFrom})` : ''}`);
const shadowPairs = (snap: Snapshot) => {
  const t = planHqPairs(snap, loadHqPolicy(), { at: new Date(snap.nowMs).toISOString(), runId: 'replay', source: 'replay' });
  return { backlog: t.backlog, free: t.free, pairs: t.pairs.map((p) => `${p.hand}->${p.cell}`) };
};

describe('REPLAY 22:10Z (run e5ef7258) — the night «idle 6 · free 6 · no backlog 6»', () => {
  const f = fixture('2210');
  test('the fixture is the night: the snapshot read the published 0.3.38 board (262 cells · yellow 4, all P2)', () => {
    expect(f.snapshotBoardCounts).toEqual({ version: '0.3.38', cells: 262, green: 230, done: 28, yellow: 4 });
    expect(f.snapshot.cells.map((c) => c.priority)).toEqual(['P2', 'P2', 'P2', 'P2']);
  });
  test('A · shadow: before backlog {} · 0 pairs → after (board in play) one pair', () => {
    expect(shadowPairs(f.snapshot)).toEqual({ backlog: {}, free: 6, pairs: [] });
    expect(shadowPairs(inPlay(f))).toEqual({ backlog: { TC: 7, OP: 29 }, free: 5, pairs: ['TC-H-REMOTE-1->THEME-UNTANGLE'] });
  });
  test('A · live HQ planner: legacy 0 → new 1', () => {
    expect(pure(inPlay(f), 'OP', LEGACY_R1)).toEqual([]);
    expect(pure(inPlay(f), 'OP', DEFAULT_LIVE_R1)).toEqual(['THEME-UNTANGLE->TC-H-REMOTE-1']);
  });
  test('B · node runner: before (0.3.38 · legacy) 0 → after 1, the same pair', () => {
    expect(runner(f.snapshot, f.startedAt, LEGACY_R1)).toEqual([]);
    rmSync(join(root, 'steward'), { recursive: true, force: true });
    expect(runner(inPlay(f), f.startedAt, DEFAULT_LIVE_R1)).toEqual(['THEME-UNTANGLE->TC-H-REMOTE-1@0.3.39']);
  });
});

describe('REPLAY 22:25Z (run 7ef5c2ba) — board fixed, live R1 «3 × no-idle-hand-anywhere»', () => {
  const f = fixture('2225');
  test('A · shadow pairs 3 · live HQ planner legacy 0 → new = the same 3 pairs (lent from TC)', () => {
    expect(shadowPairs(inPlay(f))).toEqual({ backlog: { TC: 10, OP: 28 }, free: 7,
      pairs: ['TC-H-CC-2->THEME-UNTANGLE', 'HAND-TUI-D->LAND10-JUDGE-CAPACITY', 'TC-H-CX-1->STEWARD-GRAPH-SCOPED'] });
    expect(pure(inPlay(f), 'OP', LEGACY_R1)).toEqual([]);
    expect(pure(inPlay(f), 'OP', DEFAULT_LIVE_R1)).toEqual([
      'THEME-UNTANGLE->TC-H-CC-2 (lent TC)', 'LAND10-JUDGE-CAPACITY->HAND-TUI-D (lent TC)', 'STEWARD-GRAPH-SCOPED->TC-H-CX-1 (lent TC)']);
  });
  test('A · TC planner (its own roster cells): legacy 0 → new 3', () => {
    expect(pure(inPlay(f), 'TC', LEGACY_R1)).toEqual([]);
    expect(pure(inPlay(f), 'TC', DEFAULT_LIVE_R1)).toEqual([
      'CAPSULE-A1-POLICY->TC-H-CC-2', 'HQ-PHYSICAL-RESTRUCTURE->HAND-TUI-D', 'JUDGE-GATE-MISCLASS-FIX->TC-H-CX-1']);
  });
  // That night's 22:25Z tick was `--scope OP` alone: TC's idleLeft came from its 22:20Z tick ([] — TC-H-CC-2 was idle 6 min)
  // → 3 × defer. A full run (the */10 cron) under the old numbers lends only TC-H-CC-2 (idle 11 ≥ 10) to the oldest cell.
  test('B · node runner: legacy 1 (the one hand idle ≥ 10) → new 3 — TC runs first and staffs its own cells, HQ lends nobody twice', () => {
    expect(runner(inPlay(f), f.startedAt, LEGACY_R1)).toEqual(['THEME-UNTANGLE->TC-H-CC-2@0.3.39']);
    rmSync(join(root, 'steward'), { recursive: true, force: true });
    expect(runner(inPlay(f), f.startedAt, DEFAULT_LIVE_R1)).toEqual([
      'CAPSULE-A1-POLICY->TC-H-CC-2@0.3.39', 'HQ-PHYSICAL-RESTRUCTURE->HAND-TUI-D@0.3.39', 'JUDGE-GATE-MISCLASS-FIX->TC-H-CX-1@0.3.39']);
  });
});

describe('REPLAY 22:30Z (run 4b7a0b10) — every idle maker already held a cell', () => {
  const f = fixture('2230');
  test('A and B: 0 before and 0 after — no hand that holds work is re-assigned (TC-H-CX-5 · MVP-B · TC-H-POOL-3 · TC-H-REMOTE-1)', () => {
    const held = ['TC-H-CX-5', 'MVP-B', 'TC-H-POOL-3', 'TC-H-REMOTE-1'].map((s) => f.board0339.filter((c) => c.status === 'yellow' && (c.owner ?? '').split('/')[0] === s).length);
    expect(held).toEqual([1, 1, 1, 1]);
    expect(shadowPairs(inPlay(f)).pairs).toEqual([]);
    expect([pure(inPlay(f), 'OP', DEFAULT_LIVE_R1), pure(inPlay(f), 'TC', DEFAULT_LIVE_R1)]).toEqual([[], []]);
    expect(runner(inPlay(f), f.startedAt, DEFAULT_LIVE_R1)).toEqual([]);
  });
});
