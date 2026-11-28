// REPLAY ⊕ SIM — STEWARD-HQ (#40624 · 대표 11-28 07:5x/08:0x «시뮬레이션 월드에서 충분히 검증»). The live R0 snapshots of
// 11-28 (fixtures/hq-live-1128-*.json: the run files trimmed ⊕ the 0.3.39 board rewound to the snapshot time) and a seeded
// world. Two engines per finding: steward:hq = planHqPairs (the R1 hook) and replayHqShadow (the stored-run path the
// report uses) · hand-steward = the pure pairs()/isReady and the body (observe → plan). Expected values are literals.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBody, coordinatorTest, isReady, pairs, type Cell, type Hand, type HandStewardDeps } from '../../loop-agent/bodies/hand-steward.js';
import { activeBoardVersion } from '../../ops-dashboard/current-version.js';
import { loadHqPolicy, planHqPairs, replayHqShadow } from './hq-shadow.js';
import type { CellView, Snapshot } from './model.js';
import { checklistStatusArgs } from './sources.js';

interface Fixture { runId: string; startedAt: string; snapshot: Snapshot; board0339: Array<CellView & { doneWhen?: boolean; predecessors?: string[] }>; snapshotBoardCounts: Record<string, string | number> }
const fixture = (name: string): Fixture => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', `hq-live-1128-${name}z.json`), 'utf8')) as Fixture;
const inPlay = (f: Fixture): Snapshot => ({ ...f.snapshot, version: '0.3.39', cells: f.board0339 });
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hq-board-replay-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const engine1 = (s: Snapshot) => { const t = planHqPairs(s, loadHqPolicy(), { at: new Date(s.nowMs).toISOString(), runId: 'r', source: 'tick' }); return { version: t.version, backlog: t.backlog, free: t.free, noCell: t.noCell, pairs: t.pairs.map((p) => `${p.hand}->${p.cell}`) }; };
function engine2(s: Snapshot, startedAt: string) {
  mkdirSync(join(root, 'steward', 'space', 'runs'), { recursive: true });
  writeFileSync(join(root, 'steward', 'space', 'runs', 'r.json'), JSON.stringify({ runId: 'r', startedAt, snapshot: s }));
  const [t] = replayHqShadow(root, new Date(Date.parse(startedAt) - 60_000), new Date(Date.parse(startedAt) + 60_000), loadHqPolicy());
  rmSync(join(root, 'steward'), { recursive: true, force: true });
  return { version: t!.version, backlog: t!.backlog, free: t!.free, noCell: t!.noCell, pairs: t!.pairs.map((p) => `${p.hand}->${p.cell}`) };
}

describe('REPLAY 22:10Z — steward:hq «idle 6 · free 6 · in-scope 0 · no backlog 6»', () => {
  const f = fixture('2210');
  test('before = the published 0.3.38 board the night read (262 cells · yellow 4 · all P2) — both engines: 0 pairs', () => {
    expect(f.snapshotBoardCounts).toEqual({ version: '0.3.38', cells: 262, green: 230, done: 28, yellow: 4 });
    const want = { version: '0.3.38', backlog: {}, free: 6, noCell: 6, pairs: [] };
    expect([engine1(f.snapshot), engine2(f.snapshot, f.startedAt)]).toEqual([want, want]);
  });
  // STEWARD-HQ-LIVE-ALIGN (#40627): reserve «[예비]» / «[WIP 잔류]» cells keep the stall clock and umbrella/decision cells
  // are never backlog — 13 · 38 under #40624 alone → 7 · 29; the pair is the same.
  test('after = the board in play (0.3.39) — both engines: backlog TC 7 · OP 29 (roster only) · one pair', () => {
    const want = { version: '0.3.39', backlog: { TC: 7, OP: 29 }, free: 5, noCell: 4, pairs: ['TC-H-REMOTE-1->THEME-UNTANGLE'] };
    expect([engine1(inPlay(f)), engine2(inPlay(f), f.startedAt)]).toEqual([want, want]);
  });
  test('the board read names the release in play: release.graph.version 0.3.39 over the installed package 0.3.38', () => {
    expect(checklistStatusArgs(activeBoardVersion(() => '0.3.39', () => '0.3.38'))).toEqual(['release', 'checklist', 'status', '--version', '0.3.39', '--json']);
    expect(checklistStatusArgs(activeBoardVersion(() => null, () => '0.3.38'))).toEqual(['release', 'checklist', 'status', '--version', '0.3.38', '--json']);
  });
});

describe('REPLAY 22:25Z — the board in play, shadow pairs', () => {
  const f = fixture('2225');
  test('both engines: the 3 pairs the live report showed (TC-H-CC-2 · HAND-TUI-D · TC-H-CX-1)', () => {
    const want = { version: '0.3.39', backlog: { TC: 10, OP: 28 }, free: 7, noCell: 4, // 15 · 37 under #40624 alone (reserve · WIP · umbrella out)
      pairs: ['TC-H-CC-2->THEME-UNTANGLE', 'HAND-TUI-D->LAND10-JUDGE-CAPACITY', 'TC-H-CX-1->STEWARD-GRAPH-SCOPED'] };
    expect([engine1(inPlay(f)), engine2(inPlay(f), f.startedAt)]).toEqual([want, want]);
  });
});

// hand-steward on the same nights: hands = the snapshot's hand seats (judge side by ladder · cell = a yellow cell it owns),
// cells = the board in play minus unowned cells without a done-when (the live needs-spec filter).
function handWorld(f: Fixture, withCoordinatorHeld: boolean): { hands: Hand[]; cells: Cell[] } {
  const s = f.snapshot;
  const coords = new Set([s.hq, ...s.coordinators]);
  const is = coordinatorTest({ hq: s.hq, depthOf: (x) => (s.coordinators.includes(x) ? 2 : 3) });
  const owns = (seat: string) => f.board0339.find((c) => c.status === 'yellow' && (c.owner ?? '').split('/')[0] === seat)?.id;
  const hands: Hand[] = s.seats.filter((x) => !coords.has(x.seat) && (x.activity === 'idle' || x.activity === 'working')).map((x) => ({
    seat: x.seat, state: x.activity as 'idle' | 'working', ...(x.idleForMs !== null ? { since: s.nowMs - x.idleForMs } : {}),
    ...(s.parent[x.seat] === 'JUD' || /^(JUD|REVIEW)/.test(x.seat) ? { judge: true } : {}), ...(owns(x.seat) ? { cell: owns(x.seat)! } : {}) }));
  const cells: Cell[] = f.board0339.filter((c) => !(c.status === 'yellow' && !c.owner && !c.doneWhen)).map((c) => ({
    id: c.id, title: c.title, status: c.status, ...(c.owner ? { owner: c.owner } : {}), ...(c.priority ? { priority: c.priority } : {}),
    ...(c.predecessors ? { predecessors: c.predecessors } : {}), ...(c.dispatchKind ? { dispatchKind: c.dispatchKind } : {}), paths: [],
    ...(withCoordinatorHeld && c.owner && is(c.owner) ? { coordinatorHeld: true } : {}) }));
  return { hands, cells };
}
async function bodyEngine(f: Fixture, w: { hands: Hand[]; cells: Cell[] }) {
  const deps: HandStewardDeps = { readHands: () => w.hands, readCells: () => ({ version: '0.3.39', cells: w.cells }), readHints: () => ({}),
    hint: () => {}, unhint: () => false, modelFor: () => ({ line: 'm', tier: 'easy' }), post: () => 1, wake: () => 'woke' };
  const body = createBody({ stateRoot: '/nonexistent', card: undefined } as never, deps);
  const obs = await body.observe({ now: new Date(f.snapshot.nowMs) } as never);
  return { kpi: obs.kpi, plan: body.plan(obs, { now: new Date(f.snapshot.nowMs) } as never).map((a) => a.target) };
}

describe('REPLAY hand-steward — 22:18Z «idle_hands_with_ready_cells 0 충족» was a false green', () => {
  for (const [name, want] of [
    ['2210', { kpi: 1, plan: ['CLAUDE-OP-PROXY-BUS@TC-H-REMOTE-1'] }],
    ['2225', { kpi: 2, plan: ['CLAUDE-OP-PROXY-BUS@HAND-TUI-D', 'CURRENT-RELEASE-ONE-SOURCE@TC-H-CX-1'] }],
  ] as const) {
    test(`${name}Z · before (unowned-only) KPI 0 · after (coordinator-held = board) KPI ${want.kpi} — pure and body engines agree`, async () => {
      const f = fixture(name);
      const before = handWorld(f, false); const after = handWorld(f, true);
      const closed = new Set(after.cells.filter((c) => c.status === 'green' || c.status === 'done').map((c) => c.id));
      expect([before.cells.filter((c) => isReady(c, closed)).length, pairs(before.hands, before.cells, {}).length]).toEqual([0, 0]);
      expect(await bodyEngine(f, before)).toEqual({ kpi: 0, plan: [] });
      expect(pairs(after.hands, after.cells, {}).map((p) => `${p.cell.id}@${p.hand.seat}`)).toEqual([...want.plan]);
      expect(await bodyEngine(f, after)).toEqual({ kpi: want.kpi, plan: [...want.plan] });
    });
  }
});

describe('SIM hand-steward coordinator-held board (hand-held · umbrella · open-predecessor cells stay out) — seeds 1 · 7 · 42 · 1127 · 2026', () => {
  for (const seed of [1, 7, 42, 1127, 2026]) {
    test(`seed ${seed}`, async () => {
      const r = rng(seed);
      const nIdle = 1 + Math.floor(r() * 4); const nHeld = Math.floor(r() * 6);
      const hands: Hand[] = [
        ...Array.from({ length: nIdle }, (_, i) => ({ seat: `TC-H${i}`, state: 'idle' as const, since: 1_000 + i })),
        { seat: 'JUD-B', state: 'idle', since: 1, judge: true }, { seat: 'TC-W', state: 'working', cell: 'W-1' }, { seat: 'TC-O', state: 'idle', since: 2, cell: 'OWN-1' },
      ];
      const cells: Cell[] = [
        ...Array.from({ length: nHeld }, (_, i) => ({ id: `HELD-${i}`, title: 'h', status: 'yellow', owner: i % 2 ? 'TC' : 'OP/claude', priority: 'P0', paths: [], coordinatorHeld: true })),
        { id: 'OWN-1', title: 'o', status: 'yellow', owner: 'TC-O', priority: 'P0', paths: [] },
        { id: 'UMB-1', title: 'u', status: 'yellow', owner: 'OP', priority: 'P0', dispatchKind: 'umbrella', paths: [], coordinatorHeld: true },
        { id: 'PRE-1', title: 'p', status: 'yellow', owner: 'TC', priority: 'P0', predecessors: ['OWN-1'], paths: [], coordinatorHeld: true },
      ];
      const got = pairs(hands, cells, {});
      expect(got.map((p) => `${p.cell.id}@${p.hand.seat}`)).toEqual(Array.from({ length: Math.min(nIdle, nHeld) }, (_, i) => `HELD-${i}@TC-H${i}`));
      const deps: HandStewardDeps = { readHands: () => hands, readCells: () => ({ version: '0.3.39', cells }), readHints: () => ({}),
        hint: () => {}, unhint: () => false, modelFor: () => ({ line: 'm', tier: 'easy' }), post: () => 1, wake: () => 'woke' };
      const obs = await createBody({ stateRoot: '/nonexistent', card: undefined } as never, deps).observe({ now: new Date(2_000_000) } as never);
      expect(obs.kpi).toBe(Math.min(nIdle, nHeld));
    });
  }
});
