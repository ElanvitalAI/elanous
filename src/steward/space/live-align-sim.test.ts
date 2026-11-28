// SIM — STEWARD-HQ-LIVE-ALIGN (대표 11-28 07:5x «시뮬레이션 월드에서 충분한 시나리오 검증을 하고 시작하세요»). A seeded
// federation world (0.3.39 roster under OP · reserve / WIP-leftover / umbrella cells · free TC hands idle 2–6 min · a
// hand idle 1 min · holders idle 3–5 min on their own P0 cell · a judge hand · a declared hand with no pane · a published
// 0.3.38 board: yellow P2 only, the 22:10Z shape) driven through the real node runner (r0 → r1 → x · live) with world effects: `seat assign` writes the
// owner back into the world, `boardNow` is the world board (OP's tab can act on it between snapshot and assign).
// Expectations are literals or counted from the fixture (rule 11), never from the product's constants.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFederationLadder } from '../../msg/hand-raise-ladder.js';
import { activeBoardVersion } from '../../ops-dashboard/current-version.js';
import { hqShadowPath, loadLiveR1Policy } from './hq-shadow.js';
import { resolveScope } from './config.js';
import { DEFAULT_LIVE_R1, emptyScopeState, LEGACY_R1, planMatch } from './model.js';
import { buildSnapshot, type SnapshotSources } from './sources.js';
import { ledgerPath, runStewardSpaceNode, type StewardEffects, type TickDeps } from './tick.js';

const NOW = Date.parse('2026-11-27T22:40:00.000Z');
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();
const agoMs = (min: number): number => NOW - min * 60_000;
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const SEEDS = [1, 7, 42, 1127, 2026];

interface Item { id: string; title: string; status: string; owner?: string; priority?: string; updatedAt: string; evidence?: string; dispatchKind?: string }

function world(seed: number, opts: { minFree?: number; minRoster?: number } = {}) {
  const r = rng(seed);
  const nFree = Math.max(opts.minFree ?? 0, 2 + Math.floor(r() * 4)); // 2–5 free TC hands, idle 2–6 min (all < the old 10)
  const nHold = 1 + Math.floor(r() * 3); // 1–3 holders on their own P0 cell
  const nRoster = Math.max(opts.minRoster ?? 0, 3 + Math.floor(r() * 5)); // 3–7 OP-held roster P0 cells (all < 120 min old)
  const nReserve = 1 + Math.floor(r() * 2);
  const free = Array.from({ length: nFree }, (_, i) => ({ seat: `TC-F${i}`, idleMin: 2 + i }));
  const holders = Array.from({ length: nHold }, (_, i) => ({ seat: `TC-O${i}`, idleMin: 3 + i }));
  const v39: Item[] = [
    ...Array.from({ length: nRoster }, (_, i) => ({ id: `ROS-${i}`, title: `roster ${i}`, status: 'yellow', owner: 'OP/claude', priority: 'P0', updatedAt: ago(20 + 10 * i) })),
    ...Array.from({ length: nReserve }, (_, i) => ({ id: `RSV-${i}`, title: 'reserve', status: 'yellow', owner: 'OP', priority: 'P0', updatedAt: ago(30), evidence: '[예비 0.3.39] CEO 11-28 05:4x 로스터 60 밖 예비 20\nmore' })),
    { id: 'WIP-0', title: 'wip', status: 'yellow', owner: 'OP', priority: 'P0', updatedAt: ago(40), evidence: '[WIP 잔류 0.3.39] 새 pull 금지' },
    { id: 'UMB-0', title: 'umbrella', status: 'yellow', owner: 'OP', priority: 'P0', updatedAt: ago(500), dispatchKind: 'umbrella' },
    ...holders.map((h, i) => ({ id: `OWN-${i}`, title: 'own', status: 'yellow', owner: h.seat, priority: 'P0', updatedAt: ago(15), dispatchKind: 'code' })),
  ];
  const v38: Item[] = Array.from({ length: 4 }, (_, i) => ({ id: `OLD-${i}`, title: 'old', status: 'yellow', owner: 'OP', priority: 'P2', updatedAt: ago(900) }));
  const boards: Record<string, Item[]> = { '0.3.38': v38, '0.3.39': v39 };
  const w = {
    seed, free, holders, nRoster, nReserve, boards, graph: '0.3.39' as string,
    /** OP's tab acts between snapshot and assign: the oldest roster cell → the longest-idle free hand. */
    opTab: false, opTabDone: false,
    // Expected from the fixture: roster cells oldest first · free maker hands longest idle first.
    rosterOldestFirst: Array.from({ length: nRoster }, (_, i) => `ROS-${nRoster - 1 - i}`),
    freeLongestFirst: [...free].reverse().map((f) => f.seat),
  };
  // One object: the scene flips `w.graph` / `w.opTab` on the world the sources read (not on a copy).
  const sources = (): SnapshotSources => ({
    panes: () => ({ panes: [
      { seat: 'OP', activityState: 'working', lastEventAtMs: agoMs(0) },
      { seat: 'TC', activityState: 'working', lastEventAtMs: agoMs(0) },
      { seat: 'JUD', activityState: 'working', lastEventAtMs: agoMs(0) },
      { seat: 'JUD-B', activityState: 'idle', lastEventAtMs: agoMs(30) },
      { seat: 'TC-S0', activityState: 'idle', lastEventAtMs: agoMs(1) },
      ...free.map((f) => ({ seat: f.seat, activityState: 'idle', lastEventAtMs: agoMs(f.idleMin) })),
      ...holders.map((h) => ({ seat: h.seat, activityState: 'idle', lastEventAtMs: agoMs(h.idleMin) })),
    ] }),
    // The live read is `release checklist status --version <activeBoardVersion()>` — the same resolver, its graph injected.
    checklist: () => { const v = activeBoardVersion(() => w.graph, () => '0.3.38'); return { version: v, items: boards[v]!.map((i) => ({ ...i })) }; },
    prs: () => [], merged: () => [], receipts: () => [], verdicts: () => [], util: () => ({ hosts: [], ageMs: null }),
    ladder: () => buildFederationLadder({ hq: 'OP', spaces: [
      { coordinator: 'TC', seats: ['TC-S0', ...free.map((f) => f.seat), ...holders.map((h) => h.seat)] }, { coordinator: 'JUD', seats: ['JUD-B'] }] }),
    openHands: () => [],
    declaredSeats: () => ['HAND-ELN-TA', 'TC-F0', 'TC'],
  });
  return Object.assign(w, { sources });
}
type World = ReturnType<typeof world>;

function effectsFor(w: World & { opTab: boolean; opTabDone: boolean }) {
  const assigns: string[] = []; const mails: string[] = [];
  const effects: StewardEffects = {
    mail: (m) => { mails.push(`${m.to}:${m.body.split('\n')[0]}`); },
    assignCell: ({ version, cellId, seat }) => {
      const cell = w.boards[version]!.find((c) => c.id === cellId)!;
      cell.owner = seat; cell.updatedAt = new Date(NOW).toISOString();
      assigns.push(`${cellId}->${seat}@${version}`);
      return { ok: true, via: 'sim' };
    },
    dispatchPregate: () => ({ ok: true }),
    releaseCell: () => ({ ok: true }),
    boardNow: (version) => {
      if (w.opTab && !w.opTabDone) {
        w.opTabDone = true;
        const cell = w.boards[version]!.find((c) => c.id === w.rosterOldestFirst[0])!;
        cell.owner = w.freeLongestFirst[0]; // OP's tab: the same pair the steward planned, a moment earlier
      }
      return w.boards[version]!.map((c) => ({ id: c.id, status: c.status, ...(c.owner ? { owner: c.owner } : {}) }));
    },
  };
  return { effects, assigns, mails };
}

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'live-align-sim-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const CONFIG = { scopes: { TC: { mode: 'live' as const }, JUD: { mode: 'live' as const }, OP: { mode: 'live' as const } } };
function tick(w: World, runId: string, effects: StewardEffects, over: Partial<TickDeps> = {}) {
  const d: TickDeps = { root, now: () => new Date(NOW), config: CONFIG, sources: () => w.sources(), effects, ...over };
  for (const node of ['r0', 'r1', 'x'] as const) expect(runStewardSpaceNode(node, { runId }, d).outcome).toBe('ok');
  // A tick with nothing to do for OP writes no ledger line (no file yet) — that is «no rows», not an error.
  if (!existsSync(ledgerPath(root, 'OP'))) return [];
  return readFileSync(ledgerPath(root, 'OP'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as { runId?: string; node: string; action: string; target: string; seat?: string; reason: string; lentFrom?: string; done?: boolean });
}
/** Engine A — the pure planners on the same world: TC first (its rows make seats busy), then HQ with TC's idleLeft. */
function engineA(w: World): string[] {
  const snap = buildSnapshot(w.sources(), NOW);
  const tc = planMatch(snap, { scope: resolveScope('TC', 'OP', CONFIG), state: emptyScopeState(), r1: DEFAULT_LIVE_R1 });
  const busy = new Set(tc.rows.filter((r) => (r.action === 'assign' || r.action === 'wake') && r.seat).map((r) => r.seat!));
  const hq = planMatch(snap, { scope: resolveScope('OP', 'OP', CONFIG), state: emptyScopeState(), r1: DEFAULT_LIVE_R1, busySeats: busy,
    lendable: tc.idleLeft.map((seat) => ({ seat, from: 'TC' })) });
  return [...tc.rows, ...hq.rows].filter((r) => r.action === 'assign').map((r) => `${r.target}->${r.seat}@${snap.version}`);
}
const r1Of = (rows: ReturnType<typeof tick>) => rows.filter((r) => r.node === 'r1');
const ownersOf = (w: World) => {
  const by = new Map<string, string[]>();
  for (const c of w.boards['0.3.39']!) if (c.status === 'yellow' && c.owner) { const s = c.owner.split('/')[0]!; by.set(s, [...(by.get(s) ?? []), c.id]); }
  return by;
};

describe('SIM STEWARD-HQ-LIVE-ALIGN — seeds 1 · 7 · 42 · 1127 · 2026', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed} · S1 idle-2-min hands are lent · S2 roster cells move without the clock, reserve/WIP/umbrella stay · S5 cap 4 · S6 no-pane never`, () => {
      const w = world(seed);
      const pureAssigns = engineA(w);
      const { effects, assigns } = effectsFor(w);
      const rows = r1Of(tick(w, `s1-${seed}`, effects));
      const k = Math.min(4, w.nRoster, w.free.length);
      // Two engines agree: the pure planners (A) and the live node runner (B).
      expect(pureAssigns).toEqual(assigns);
      expect(assigns).toEqual(Array.from({ length: k }, (_, i) => `${w.rosterOldestFirst[i]}->${w.freeLongestFirst[i]}@0.3.39`));
      expect(rows.filter((r) => r.action === 'assign').every((r) => r.lentFrom === 'TC' && r.done === true)).toBe(true);
      // S2: never a reserve / WIP-leftover / umbrella / hand-held cell.
      expect(assigns.some((a) => /^(RSV|WIP|UMB|OWN)-/.test(a))).toBe(false);
      // S5: at most 4 per tick; roster cells beyond that wait as tick-cap (only when hands were left over).
      expect(assigns.length).toBeLessThanOrEqual(4);
      if (w.free.length > 4 && w.nRoster > 4) expect(rows.filter((r) => r.reason === 'tick-cap').length).toBe(w.nRoster - 4);
      // S1/S4/S6: never the 1-min hand, a holder, the judge hand or the no-pane hand.
      expect(assigns.some((a) => /->(TC-S0|TC-O\d|JUD-B|HAND-ELN-TA)@/.test(a))).toBe(false);
      const shadow = readFileSync(hqShadowPath(root, 'OP'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(shadow.at(-1).noPane).toEqual(['HAND-ELN-TA']);
    });

    test(`seed ${seed} · S2b without the live block (legacy numbers) the same world assigns 0 — the 22:25Z shape`, () => {
      const w = world(seed);
      const { effects, assigns } = effectsFor(w);
      const rows = r1Of(tick(w, `legacy-${seed}`, effects, { liveR1: () => ({ policy: LEGACY_R1, source: 'default' }) }));
      expect(assigns).toEqual([]);
      expect(rows.filter((r) => r.action === 'assign')).toEqual([]);
    });

    test(`seed ${seed} · S3 OP's tab assigns first in the same tick → no collision (one owner per cell · ≤ 1 cell per hand)`, () => {
      const w = world(seed);
      w.opTab = true;
      const { effects, assigns } = effectsFor(w);
      const rows = r1Of(tick(w, `optab-${seed}`, effects));
      const k = Math.min(4, w.nRoster, w.free.length);
      expect(assigns).toEqual(Array.from({ length: k - 1 }, (_, i) => `${w.rosterOldestFirst[i + 1]}->${w.freeLongestFirst[i + 1]}@0.3.39`));
      expect(rows.filter((r) => r.reason.startsWith('op-tab-first:')).map((r) => [r.target, r.seat, r.reason])).toEqual([
        [w.rosterOldestFirst[0], w.freeLongestFirst[0], `op-tab-first:owner-now:${w.freeLongestFirst[0]}`]]);
      for (const [seat, cells] of ownersOf(w)) if (seat !== 'OP' && seat !== 'TC') expect([seat, cells.length]).toEqual([seat, 1]);
    });

    test(`seed ${seed} · S4 a second tick never re-assigns a hand that took a cell, nor a holder`, () => {
      const w = world(seed, { minFree: 5, minRoster: 7 });
      const first = effectsFor(w);
      tick(w, `t1-${seed}`, first.effects);
      const second = effectsFor(w);
      tick(w, `t2-${seed}`, second.effects);
      const took = new Set(first.assigns.map((a) => a.split('->')[1]!.split('@')[0]!));
      expect(first.assigns.length).toBe(4);
      expect(second.assigns.map((a) => a.split('->')[1]!.split('@')[0]!).filter((s) => took.has(s) || /^TC-O/.test(s))).toEqual([]);
      // The fifth free hand (TC-F0 · idle 2 min) is the only one left → exactly one more pair, on the next-oldest roster cell.
      expect(second.assigns).toEqual([`${w.rosterOldestFirst[4]}->TC-F0@0.3.39`]);
      for (const [seat, cells] of ownersOf(w)) if (seat !== 'OP' && seat !== 'TC') expect([seat, cells.length]).toEqual([seat, 1]);
    });

    test(`seed ${seed} · S7 release switch: graph 0.3.38 → no backlog · flipped to 0.3.39 → the new board's backlog`, () => {
      const w = world(seed);
      w.graph = '0.3.38';
      const before = effectsFor(w);
      tick(w, `pre-${seed}`, before.effects);
      expect(before.assigns).toEqual([]);
      w.graph = '0.3.39';
      const after = effectsFor(w);
      tick(w, `post-${seed}`, after.effects);
      expect(after.assigns.length).toBe(Math.min(4, w.nRoster, w.free.length));
      expect(after.assigns.every((a) => a.endsWith('@0.3.39') && a.startsWith('ROS-'))).toBe(true);
    });

    test(`seed ${seed} · S8 a broken policy file → the defaults (same pairs as S1)`, () => {
      const broken = join(root, 'steward-hq.yaml');
      writeFileSync(broken, 'mode: shadow\nlive: [this is not a mapping\n');
      const read = loadLiveR1Policy(broken);
      expect([read.source, read.policy.idleMin, read.policy.rosterStallExempt, read.policy.directLend]).toEqual(['default', 2, true, true]);
      const w = world(seed);
      const { effects, assigns } = effectsFor(w);
      tick(w, `broken-${seed}`, effects, { liveR1: () => loadLiveR1Policy(broken) });
      const k = Math.min(4, w.nRoster, w.free.length);
      expect(assigns).toEqual(Array.from({ length: k }, (_, i) => `${w.rosterOldestFirst[i]}->${w.freeLongestFirst[i]}@0.3.39`));
    });
  }
});
