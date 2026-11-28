// SIM — STEWARD-READY-LANES (11-28 hourly audit: steward:hq agreement 72% → 11%, steward-live 0 after #40627). The live
// shape: the shadow paired idle hands to JUDGE-GATE-MISCLASS-FIX / COORD-RIGHTS-INVENTORY (green-triage lane a «merged ⊕
// receipt → judge now» — JUD signs, no hand has a move) and CAPSULE-A1-POLICY (lane b «merged, no receipt») to 3 hands in
// 40 min. A seeded world (0.3.39 roster under OP · one lane-a cell under OP · one lane-a cell under a hand · one lane-b cell
// · TC hands idle 2–6 min) through ONE lane reader (sources.ts liveCellLanes ⊕ cell-wait.ts) and every consumer of «ready
// for a hand»: the HQ shadow · live R1 · `eln work next` · hand-steward. Two engines per scene: A = the pure planners,
// B = the real node runner (r0 → r1 → x) with world effects. Expectations are literals or counted from the fixture
// (rule 11), never from the product's constants.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairs as handStewardPairs, type Cell as HsCell, type Hand as HsHand } from '../../loop-agent/bodies/hand-steward.js';
import { buildFederationLadder } from '../../msg/hand-raise-ladder.js';
import { parseMergeLog } from '../../release-loop/green-triage.js';
import { resolveScope, type StewardSpaceConfig } from './config.js';
import { cellWaitOf, type CellLanes } from './cell-wait.js';
import { hqShadowPath, hqShadowReport, loadHqPolicy, planHqPairs, renderHqShadowReport, shadowMemory, type HqShadowTick } from './hq-shadow.js';
import { DEFAULT_LIVE_R1, emptyScopeState, planMatch } from './model.js';
import { buildSnapshot, liveCellLanes, type SnapshotSources } from './sources.js';
import { ledgerPath, runStewardSpaceNode, type StewardEffects, type TickDeps } from './tick.js';
import { poolCandidates, workNext, type BoardCell, type WorkNextDeps } from './work-next.js';
import { liveWorkNextDeps } from './work-next-cli.js';
import { livePullPolicy } from '../../kit/work-pull/index.js';

const NOW = Date.parse('2026-11-28T01:00:00.000Z');
const ONE_MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const SEEDS = [1, 7, 42, 1127, 2026];
// The merge log and receipt dirs green-triage reads (origin/main squash subjects · PREGATE-GREEN lane dir names).
const TRIAGE = {
  merged: parseMergeLog([`${'a'.repeat(40)}\tfix(judge): gate misclass (#40000)`, `${'b'.repeat(40)}\tfeat(capsule): A1 policy (#38564)`].join('\n')),
  greenLanes: ['40000-df730c26eafa-minim5'],
};

interface Item { id: string; title: string; status: string; owner?: string; priority?: string; updatedAt: string; evidence?: string; dispatchKind?: string }

function world(seed: number) {
  const r = rng(seed);
  const nRoster = 3 + Math.floor(r() * 4); // 3–6 OP-held roster P0 cells (supply · no PR)
  const b = Math.floor(r() * 3); // idle offset 0–2 min — the hands' order stays H2 > H1 > H0 > …
  const board: Item[] = [
    { id: 'JUD-A', title: 'judge gate misclass', status: 'yellow', owner: 'OP', priority: 'P0', updatedAt: iso(NOW - 300 * ONE_MINUTE), dispatchKind: 'code',
      evidence: 'PR #40000 merged · PREGATE-GREEN/40000-df730c26eafa-minim5 GREEN' },
    { id: 'EVID-B', title: 'capsule A1 policy', status: 'yellow', owner: 'OP', priority: 'P0', updatedAt: iso(NOW - 200 * ONE_MINUTE), dispatchKind: 'code',
      evidence: 'PR #38564 merged — E4 evidence still to run' },
    { id: 'JUD-H', title: 'coord rights inventory', status: 'yellow', owner: 'TC-W0', priority: 'P1', updatedAt: iso(NOW - 15 * ONE_MINUTE), dispatchKind: 'code',
      evidence: 'PR #40000 merged · PREGATE-GREEN/40000-df730c26eafa-minim5' },
    ...Array.from({ length: nRoster }, (_, i) => ({ id: `ROS-${i}`, title: `roster ${i}`, status: 'yellow', owner: 'OP/claude', priority: 'P0',
      updatedAt: iso(NOW - (20 + 10 * i) * ONE_MINUTE), dispatchKind: 'code', evidence: `[0.3.39 roster] cell ${i}` })),
  ];
  const w = {
    seed, nRoster, b, board, now: NOW, withLanes: true,
    /** seat → idle minutes (null = working). */
    idle: { 'TC-H0': 2 + b, 'TC-H1': 3 + b, 'TC-H2': 4 + b, 'TC-W0': 5 + b } as Record<string, number | null>,
    /** Roster cells oldest first (counted from the fixture). */
    rosterOldestFirst: Array.from({ length: nRoster }, (_, i) => `ROS-${nRoster - 1 - i}`),
  };
  const ladder = buildFederationLadder({ hq: 'OP', spaces: [
    { coordinator: 'TC', seats: ['TC-H0', 'TC-H1', 'TC-H2', 'TC-W0'] }, { coordinator: 'JUD', seats: ['JUD-B'] }, { coordinator: 'MK', seats: [] }] });
  const lanes = (): CellLanes => liveCellLanes('0.3.39', w.board, { triage: TRIAGE });
  const sources = (): SnapshotSources => ({
    panes: () => ({ panes: [
      ...['OP', 'TC', 'JUD', 'MK'].map((seat) => ({ seat, activityState: 'working', lastEventAtMs: w.now })),
      { seat: 'JUD-B', activityState: 'idle', lastEventAtMs: w.now - 30 * ONE_MINUTE },
      ...Object.entries(w.idle).map(([seat, m]) => (m === null ? { seat, activityState: 'working', lastEventAtMs: w.now } : { seat, activityState: 'idle', lastEventAtMs: w.now - m * ONE_MINUTE })),
    ] }),
    checklist: () => ({ version: '0.3.39', items: w.board.map((i) => ({ ...i })) }),
    prs: () => [], merged: () => [], receipts: () => [], verdicts: () => [], util: () => ({ hosts: [], ageMs: null }),
    ladder: () => ladder, openHands: () => [],
    ...(w.withLanes ? { lanes: (v: string, items: readonly unknown[]) => liveCellLanes(v, items, { triage: TRIAGE }) } : {}),
  });
  /** `eln work next` deps on the same world (swap writes the owner back). */
  const workDeps = (): WorkNextDeps => ({
    now: () => w.now, version: '0.3.39', cells: () => w.board as readonly BoardCell[],
    scopeOf: (s) => ladder.parentOf(s).toUpperCase(),
    lastActiveMs: (s) => { const m = w.idle[s]; return m === undefined ? undefined : m === null ? w.now : w.now - m * ONE_MINUTE; },
    waitOf: (c) => cellWaitOf(c.id, { prs: [], receipts: [], verdicts: [], ...(w.withLanes ? { lanes: lanes() } : {}) }),
    ...(w.withLanes ? { lanes } : {}),
    isCoordinator: (s) => ladder.depthOf(s) === 2,
    swap: (id, input) => {
      const c = w.board.find((x) => x.id === id);
      if (!c) return { outcome: 'missing' };
      if ((c.owner ?? null) !== input.expectedOwner) return { outcome: 'lost' };
      c.owner = input.to; c.updatedAt = iso(w.now);
      return { outcome: 'swapped' };
    },
  });
  /** hand-steward's view: the hand pool (a seat holding a cell says so) ⊕ the board with the shared lane. */
  const handSteward = (): { hands: HsHand[]; cells: HsCell[] } => {
    const l = w.withLanes ? lanes().cells : {};
    return {
      hands: Object.entries(w.idle).flatMap(([seat, m]) => (m === null ? [] : [{ seat, state: 'idle' as const, since: w.now - m * ONE_MINUTE,
        ...(w.board.some((c) => c.owner === seat && c.status === 'yellow') ? { cell: w.board.find((c) => c.owner === seat)!.id } : {}) }])),
      cells: w.board.map((c) => ({ id: c.id, title: c.title, status: c.status, ...(c.owner ? { owner: c.owner } : {}), ...(c.priority ? { priority: c.priority } : {}),
        ...(c.owner && ladder.depthOf(c.owner.split('/')[0]!) <= 2 ? { coordinatorHeld: true } : {}), ...(l[c.id] ? { lane: l[c.id] } : {}), paths: [] })),
    };
  };
  return Object.assign(w, { sources, workDeps, handSteward, lanes, ladder });
}
type World = ReturnType<typeof world>;

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ready-lanes-sim-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const SHADOW: StewardSpaceConfig = { scopes: { TC: { mode: 'shadow' }, JUD: { mode: 'shadow' }, MK: { mode: 'shadow' }, OP: { mode: 'shadow' } } };
const LIVE: StewardSpaceConfig = { scopes: { TC: { mode: 'live' }, JUD: { mode: 'live' }, MK: { mode: 'shadow' }, OP: { mode: 'live' } } };

function effectsFor(w: World) {
  const assigns: string[] = []; const wakes: string[] = [];
  const effects: StewardEffects = {
    mail: () => {}, dispatchPregate: () => ({ ok: true }), releaseCell: () => ({ ok: true }),
    // An owner wake goes through the same door (`seat assign` on its own cell): the owner stays — the sim leaves its clock too.
    assignCell: ({ cellId, seat, why }) => {
      if (why.startsWith('wake:')) { wakes.push(`${cellId}->${seat}`); return { ok: true, via: 'sim' }; }
      const c = w.board.find((x) => x.id === cellId)!; c.owner = seat; c.updatedAt = iso(w.now); assigns.push(`${cellId}->${seat}`); return { ok: true, via: 'sim' };
    },
    boardNow: () => w.board.map((c) => ({ id: c.id, status: c.status, ...(c.owner ? { owner: c.owner } : {}) })),
  };
  return { effects, assigns, wakes };
}
type LedgerRow = { runId?: string; node: string; action: string; target: string; seat?: string; reason: string };
/** Engine B — the real node runner. Returns this run's r1 rows and the shadow ledger's newest line. */
function runner(w: World, runId: string, config: StewardSpaceConfig, effects: StewardEffects): { rows: LedgerRow[]; shadow: HqShadowTick } {
  const d: TickDeps = { root, now: () => new Date(w.now), config, sources: () => w.sources(), effects, liveR1: () => ({ policy: DEFAULT_LIVE_R1, source: 'yaml' }) };
  for (const node of ['r0', 'r1', 'x'] as const) expect(runStewardSpaceNode(node, { runId }, d).outcome).toBe('ok');
  const rows = ['OP', 'TC'].flatMap((s) => (existsSync(ledgerPath(root, s)) ? readFileSync(ledgerPath(root, s), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as LedgerRow) : []))
    .filter((r) => r.runId === runId && r.node === 'r1');
  const shadow = readFileSync(hqShadowPath(root, 'OP'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as HqShadowTick).at(-1)!;
  return { rows, shadow };
}
/** Engine A — the pure shadow plan, remembering the earlier engine-A ticks of the scene. */
function shadowA(w: World, prior: HqShadowTick[], memory = true): HqShadowTick {
  const policy = loadHqPolicy();
  const snap = buildSnapshot(w.sources(), w.now);
  return planHqPairs(snap, policy, { at: iso(w.now), runId: `a-${w.now}`, source: 'replay' }, memory ? shadowMemory(prior, w.now, policy.stallMin) : {});
}
/** Engine A — live R1: TC first (its rows make seats busy), then HQ with TC's idleLeft (tick.ts order). */
function liveA(w: World): string[] {
  const snap = buildSnapshot(w.sources(), w.now);
  const tc = planMatch(snap, { scope: resolveScope('TC', 'OP', LIVE), state: emptyScopeState(), r1: DEFAULT_LIVE_R1 });
  const busy = new Set(tc.rows.filter((r) => (r.action === 'assign' || r.action === 'wake') && r.seat).map((r) => r.seat!));
  const hq = planMatch(snap, { scope: resolveScope('OP', 'OP', LIVE), state: emptyScopeState(), r1: DEFAULT_LIVE_R1, busySeats: busy, lendable: tc.idleLeft.map((seat) => ({ seat, from: 'TC' })) });
  return [...tc.rows, ...hq.rows].filter((r) => r.action === 'assign').map((r) => `${r.target}->${r.seat}`);
}
const pairsOf = (t: HqShadowTick): string[] => t.pairs.map((p) => `${p.hand}->${p.cell}`);
const claim = (w: World, seat: string): string => { const r = workNext(seat, w.workDeps()); return r.code === 0 ? r.cell.id : `code ${r.code}`; };

describe('SIM STEWARD-READY-LANES — seeds 1 · 7 · 42 · 1127 · 2026', () => {
  test('the lane reader on the fixture: lane a = JUD-A · JUD-H · lane b = EVID-B · roster cells are supply (not stored) · hold = the pack\'s stall_min', () => {
    expect(world(1).lanes()).toEqual({ cells: { 'JUD-A': 'judge', 'JUD-H': 'judge', 'EVID-B': 'evidence' }, holdMin: 120 });
  });

  for (const seed of SEEDS) {
    test(`seed ${seed} · S1 a lane-a cell is never given to a hand — shadow (A = B) · live R1 (A = B) · work next · hand-steward`, () => {
      const w = world(seed);
      const ros = w.rosterOldestFirst;
      // Shadow: the hand that holds only a lane-a cell is free (it waits on JUD) · cap 4 · EVID-B (P0 · oldest workable) first.
      const expected = ['TC-W0->EVID-B', `TC-H2->${ros[0]}`, `TC-H1->${ros[1]}`, `TC-H0->${ros[2]}`];
      const a = shadowA(w, []);
      expect(pairsOf(a)).toEqual(expected);
      expect(a.judgeLane).toEqual(['JUD-A', 'JUD-H']);
      const b = runner(w, `s1-${seed}`, SHADOW, effectsFor(w).effects).shadow;
      expect(pairsOf(b)).toEqual(expected);
      // Live R1 on the same world (TC lends its idle hands to HQ's roster): the same four, never JUD-*.
      const pure = liveA(w);
      const live = effectsFor(w);
      runner(w, `s1-live-${seed}`, LIVE, live.effects);
      expect(pure).toEqual(['EVID-B->TC-W0', `${ros[0]}->TC-H2`, `${ros[1]}->TC-H1`, `${ros[2]}->TC-H0`]);
      expect(live.assigns).toEqual(pure);
    });

    test(`seed ${seed} · S1b work next and hand-steward read the same lane: no JUD-* claim or hint`, () => {
      const w = world(seed);
      const ros = w.rosterOldestFirst;
      const hs = w.handSteward();
      // hand-steward ranks ready cells by priority then id; TC-W0 is held (hand pool names its cell).
      expect(handStewardPairs(hs.hands, hs.cells, {}).map((p) => `${p.hand.seat}->${p.cell.id}`)).toEqual(['TC-H2->EVID-B', 'TC-H1->ROS-0', 'TC-H0->ROS-1']);
      // Without the lane (the pre-fix reading) the same pool hinted the lane-a cell.
      w.withLanes = false;
      const before = w.handSteward();
      expect(handStewardPairs(before.hands, before.cells, {}).map((p) => `${p.hand.seat}->${p.cell.id}`)).toEqual(['TC-H2->EVID-B', 'TC-H1->JUD-A', 'TC-H0->ROS-0']);
      w.withLanes = true;
      // `eln work next` claims coordinator-held (ladder depth 2) cells — the same board under TC: four claims in a row,
      // P0 oldest first, JUD-A skipped; TC-W0's own lane-a cell does not hold WIP 1.
      for (const c of w.board) if (c.owner?.startsWith('OP')) c.owner = 'TC';
      expect(['TC-H2', 'TC-H1', 'TC-H0', 'TC-W0'].map((s) => claim(w, s))).toEqual(['EVID-B', ros[0], ros[1], ros[2]]);
      expect(w.board.find((c) => c.id === 'JUD-A')!.owner).toBe('TC');
    });

    test(`seed ${seed} · S2 a lane-b cell is paired once — three shadow ticks, a different idle hand each (the 01:00/01:10/01:40Z shape)`, () => {
      const w = world(seed);
      const ros = w.rosterOldestFirst;
      const at = [0, 10, 40];
      const hands = ['TC-H0', 'TC-H1', 'TC-H2'];
      const ticksA: HqShadowTick[] = []; const ticksB: HqShadowTick[] = []; const before: HqShadowTick[] = [];
      const { effects } = effectsFor(w);
      for (let k = 0; k < 3; k++) {
        w.now = NOW + at[k]! * ONE_MINUTE;
        w.idle = { 'TC-H0': null, 'TC-H1': null, 'TC-H2': null, 'TC-W0': null, [hands[k]!]: 3 };
        ticksA.push(shadowA(w, ticksA));
        ticksB.push(runner(w, `s2-${seed}-${k}`, SHADOW, effects).shadow);
        w.withLanes = false; before.push(shadowA(w, [], false)); w.withLanes = true;
      }
      expect(ticksA.map(pairsOf)).toEqual([['TC-H0->EVID-B'], [`TC-H1->${ros[0]}`], [`TC-H2->${ros[1]}`]]);
      expect(ticksB.map(pairsOf)).toEqual(ticksA.map(pairsOf));
      expect(ticksA.map((t) => t.remembered ?? 0)).toEqual([0, 1, 2]);
      // Before: no lane, no memory — the lane-a cell to every hand (what the 11-28 shadow ledger shows).
      expect(before.map(pairsOf)).toEqual([['TC-H0->JUD-A'], ['TC-H1->JUD-A'], ['TC-H2->JUD-A']]);
    });

    test(`seed ${seed} · S2b live: the lane-b cell stays with its hand for the 2 h hold (lease 45 min is not enough) · work next agrees`, () => {
      const w = world(seed);
      const ros = w.rosterOldestFirst;
      w.idle = { 'TC-H0': 3, 'TC-H1': null, 'TC-H2': null, 'TC-W0': null };
      const live = effectsFor(w);
      runner(w, `s2b-0-${seed}`, LIVE, live.effects);
      expect(live.assigns).toEqual(['EVID-B->TC-H0']);
      // +60 min: TC-H0 idle since the assign, TC-H1 idle 3 → no reclaim · TC-H0 woken on its cell · TC-H1 gets a roster cell.
      w.now = NOW + 60 * ONE_MINUTE; w.idle = { 'TC-H0': 60, 'TC-H1': 3, 'TC-H2': null, 'TC-W0': null };
      const t1 = effectsFor(w);
      const rows1 = runner(w, `s2b-1-${seed}`, LIVE, t1.effects).rows;
      expect(rows1.filter((r) => r.action === 'reclaim')).toEqual([]);
      expect(rows1.filter((r) => r.action === 'wake').map((r) => [r.target, r.seat, r.reason])).toEqual([['EVID-B', 'TC-H0', 'idle-owner:60m']]);
      expect([t1.assigns, t1.wakes]).toEqual([[`${ros[0]}->TC-H1`], ['EVID-B->TC-H0']]);
      // `eln work next` for another TC hand at +60 min: EVID-B is not a candidate (held) · at +130 min it is (hold over).
      const ids = (): string[] => poolCandidates(w.board as readonly BoardCell[], { seat: 'TC-H2', scope: 'TC', nowMs: w.now, scopeOf: (s) => w.ladder.parentOf(s).toUpperCase(),
        isCoordinator: (s) => w.ladder.depthOf(s) === 2, isJudge: () => false, lastActiveMs: (s) => w.workDeps().lastActiveMs(s), priorityOrder: [], skills: [], lanes: w.lanes(),
        waitOf: (c) => w.workDeps().waitOf!(c) }).map((c) => c.cell.id);
      expect(ids().includes('EVID-B')).toBe(false);
      // +130 min: the hold ran out 10 min ago → reclaimed, the next hand may take it.
      w.now = NOW + 130 * ONE_MINUTE; w.idle = { 'TC-H0': 130, 'TC-H1': null, 'TC-H2': 3, 'TC-W0': null };
      expect(ids().includes('EVID-B')).toBe(true);
      const rows2 = runner(w, `s2b-2-${seed}`, LIVE, effectsFor(w).effects).rows;
      expect(rows2.filter((r) => r.action === 'reclaim').map((r) => [r.target, r.seat, r.reason])).toEqual([['EVID-B', 'TC-H0', 'lease-expired:10m']]);
    });

    test(`seed ${seed} · S2c without the lane the same world reclaims at +60 min (45-min lease) — the hand-to-hand churn`, () => {
      const w = world(seed);
      w.withLanes = false;
      w.idle = { 'TC-H0': 3, 'TC-H1': null, 'TC-H2': null, 'TC-W0': null };
      const live = effectsFor(w);
      runner(w, `s2c-0-${seed}`, LIVE, live.effects);
      expect(live.assigns).toEqual(['JUD-A->TC-H0']); // and without the lane the first push was the lane-a cell
      // Point the hand at EVID-B (as the 11-28 board had it) to show the lease clock on a lane-b cell.
      w.board.find((c) => c.id === 'JUD-A')!.owner = 'OP';
      w.board.find((c) => c.id === 'EVID-B')!.owner = 'TC-H0';
      w.board.find((c) => c.id === 'EVID-B')!.updatedAt = iso(NOW);
      w.now = NOW + 60 * ONE_MINUTE; w.idle = { 'TC-H0': 60, 'TC-H1': null, 'TC-H2': null, 'TC-W0': null };
      const rows = runner(w, `s2c-1-${seed}`, LIVE, effectsFor(w).effects).rows;
      expect(rows.filter((r) => r.action === 'reclaim').map((r) => [r.target, r.reason])).toEqual([['EVID-B', 'lease-expired:15m']]);
    });

    test(`seed ${seed} · S3 implementable roster cells are paired, oldest first, by both engines and live R1`, () => {
      const w = world(seed);
      const ros = w.rosterOldestFirst;
      w.idle = { 'TC-H0': 2 + w.b, 'TC-H1': 3 + w.b, 'TC-H2': 4 + w.b, 'TC-W0': null };
      w.board.find((c) => c.id === 'EVID-B')!.status = 'green'; // only supply cells left on the backlog
      const expected = [`TC-H2->${ros[0]}`, `TC-H1->${ros[1]}`, `TC-H0->${ros[2]}`];
      expect(pairsOf(shadowA(w, []))).toEqual(expected);
      expect(pairsOf(runner(w, `s3-${seed}`, SHADOW, effectsFor(w).effects).shadow)).toEqual(expected);
      const pure = liveA(w);
      const live = effectsFor(w);
      runner(w, `s3-live-${seed}`, LIVE, live.effects);
      expect(pure).toEqual([`${ros[0]}->TC-H2`, `${ros[1]}->TC-H1`, `${ros[2]}->TC-H0`]);
      expect(live.assigns).toEqual(pure);
    });

    test(`seed ${seed} · S4 a cell a hand self-claimed (work next) between ticks is not proposed again`, () => {
      const w = world(seed);
      const ros = w.rosterOldestFirst;
      w.idle = { 'TC-H0': 2 + w.b, 'TC-H1': 3 + w.b, 'TC-H2': null, 'TC-W0': null };
      w.board.find((c) => c.id === 'EVID-B')!.owner = 'TC'; // a TC roster cell — `eln work next` claims coordinator-held cells
      const ticksA: HqShadowTick[] = [];
      const { effects } = effectsFor(w);
      ticksA.push(shadowA(w, ticksA));
      const b0 = runner(w, `s4-0-${seed}`, SHADOW, effects).shadow;
      expect(pairsOf(ticksA[0]!)).toEqual(['TC-H1->EVID-B', `TC-H0->${ros[0]}`]);
      expect(pairsOf(b0)).toEqual(pairsOf(ticksA[0]!));
      // +5 min: TC-H2 pulls on its own and claims the top P0 cell (EVID-B), then works.
      w.now = NOW + 5 * ONE_MINUTE; w.idle['TC-H2'] = 1;
      expect(claim(w, 'TC-H2')).toBe('EVID-B');
      w.now = NOW + 10 * ONE_MINUTE; w.idle = { 'TC-H0': 12 + w.b, 'TC-H1': 13 + w.b, 'TC-H2': null, 'TC-W0': null };
      ticksA.push(shadowA(w, ticksA));
      const b1 = runner(w, `s4-1-${seed}`, SHADOW, effects).shadow;
      // EVID-B (owner TC-H2 now) is nobody else's · ros[0] stays TC-H0's (memory) · TC-H1 takes the next roster cell.
      expect(pairsOf(ticksA[1]!)).toEqual([`TC-H1->${ros[1]}`, `TC-H0->${ros[0]}`]);
      expect(pairsOf(b1)).toEqual(pairsOf(ticksA[1]!));
    });
  }

  test('R report: OP acts to a coordinator seat and onto a lane-a cell are kept apart — agreement 50% (all acts 33%)', () => {
    const w = world(42);
    const ros = w.rosterOldestFirst;
    const ticks: HqShadowTick[] = [];
    for (const [k, m] of [0, 10, 40].entries()) {
      w.now = NOW + m * ONE_MINUTE;
      w.idle = { 'TC-H0': null, 'TC-H1': null, 'TC-H2': null, 'TC-W0': null, [`TC-H${k}`]: 3 };
      ticks.push(shadowA(w, ticks));
    }
    const r = hqShadowReport({ hq: 'OP', since: new Date(NOW - 60 * ONE_MINUTE), until: new Date(NOW + 60 * ONE_MINUTE), ticks, policy: loadHqPolicy(), facts: [
      { ts: iso(NOW + 2 * ONE_MINUTE), type: 'cell', state: 'assign', decidedBy: 'OP', cell: 'EVID-B', to: 'TC-H0', kind: '[steward RO-1] P0 stalled' },
      { ts: iso(NOW + 3 * ONE_MINUTE), type: 'cell', state: 'assign', decidedBy: 'OP', cell: 'ROS-0', to: 'MK', kind: '[steward RO-2] P0 stalled' },
      { ts: iso(NOW + 12 * ONE_MINUTE), type: 'cell', state: 'assign', decidedBy: 'OP', cell: 'JUD-A', to: 'TC-H1', kind: '[steward RO-3] P0 stalled' },
    ] });
    expect(r.pairs.map((p) => `${p.hand}->${p.cell}:${p.match}`)).toEqual(['TC-H0->EVID-B:cell', `TC-H1->${ros[0]}:none`, `TC-H2->${ros[1]}:none`]);
    expect(r.opAssigned).toEqual({ tab: 3, stewardLive: 0, claims: 0, toCoordinator: 1, toJudgeLane: 1 });
    expect([r.agreement, r.agreementRaw]).toEqual([0.5, 0.33]); // (1 + 1) / (3 + 1) · (1 + 1) / (3 + 3)
    expect(renderHqShadowReport(r).split('\n')[2]).toBe("agreement 50% (target 90%) → stay shadow · not compared (never steward:hq's move): to coordinator seats 1 · onto lane-a cells 1 (JUD signs) · all acts 33%");
  });
});

// Exercise both real entrypoints with a GitHub-shaped draft, not a stubbed protection predicate.
test('recent draft PR protects its declared cell in work next and steward plans', () => {
  const previousPath = process.env.PATH;
  const pr = { number: 40675, headRefOid: 'a'.repeat(40), headRefName: 'draft/ros',
    title: 'Draft implementation', body: '칸: ROS-1', isDraft: true, updatedAt: iso(NOW - ONE_MINUTE) };
  const { policy, error } = livePullPolicy();
  expect(error).toBeUndefined();
  const w = world(1);
  w.board = w.board.filter((c) => c.id === 'ROS-0' || c.id === 'ROS-1');
  const makeSources = (prs: unknown[]): SnapshotSources => ({ ...w.sources(), prs: () => prs, pull: () => ({ policy }) });
  const plans = (prs: unknown[]) => {
    const snap = buildSnapshot(makeSources(prs), NOW);
    const live = planMatch(snap, { scope: resolveScope('OP', 'OP', LIVE), state: emptyScopeState(), r1: DEFAULT_LIVE_R1,
      lendable: [{ seat: 'TC-H0', from: 'TC' }, { seat: 'TC-H1', from: 'TC' }] });
    const shadow = planHqPairs(snap, loadHqPolicy(), { at: iso(NOW), runId: 'draft-pr', source: 'replay' }, {});
    return { live: live.rows.filter((row) => row.action === 'assign').map((row) => row.target), shadow: shadow.pairs.map((pair) => pair.cell) };
  };
  try {
    // gh is the only PR boundary; liveWorkNextDeps still parses the actual gh JSON and applies its actual policy.
    const gh = join(root, 'gh');
    const fakeGh = (prs: unknown[]) => writeFileSync(gh, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify([{ data: { repository: { pullRequests: { nodes: prs } } } }])}\nJSON\n`, { mode: 0o755 });
    process.env.PATH = `${root}:${previousPath ?? ''}`;
    fakeGh([]);
    const baseline = liveWorkNextDeps('TC-H0', { version: '0.3.39', now: NOW });
    const baseResult = workNext('TC-H0', { ...w.workDeps(), isCoordinator: (s) => s === 'OP' || w.ladder.depthOf(s) === 2, policy: baseline.policy, prProtected: baseline.prProtected });
    expect(baseResult).toMatchObject({ code: 0, cell: { id: 'ROS-1' } });
    // Restore the fixture owner changed by the preceding claim.
    w.board.find((c) => c.id === 'ROS-1')!.owner = 'OP/claude';
    const noPr = plans([]);
    expect(noPr.live).toContain('ROS-1');
    expect(noPr.shadow).toContain('ROS-1');

    fakeGh([pr]);
    const liveDeps = liveWorkNextDeps('TC-H0', { version: '0.3.39', now: NOW });
    const protectedResult = workNext('TC-H0', { ...w.workDeps(), isCoordinator: (s) => s === 'OP' || w.ladder.depthOf(s) === 2, policy: liveDeps.policy, prProtected: liveDeps.prProtected });
    expect(protectedResult).toMatchObject({ code: 0, cell: { id: 'ROS-0' } });
    expect(w.board.find((c) => c.id === 'ROS-1')!.owner).toBe('OP/claude');
    // Restore before taking the independent planner snapshot.
    w.board.find((c) => c.id === 'ROS-0')!.owner = 'OP/claude';
    const withPr = plans([pr]);
    expect(withPr.live).not.toContain('ROS-1');
    expect(withPr.shadow).not.toContain('ROS-1');
    expect(withPr.live).toContain('ROS-0');
    expect(withPr.shadow).toContain('ROS-0');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
