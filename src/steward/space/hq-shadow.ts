// STEWARD-HQ (0.3.39 P1 · FEDERATION-STEWARDS §5a) — 교통 행정관 `steward:hq` in SHADOW.
//
// S: the space steward is ONE graph (graphs/steward/space.yaml · R0–R6·X) with an instance per coordinator scope
//    (`steward:<scope>` · STEWARD-GRAPH-SCOPED). Its HQ instance lends only hands a sub-scope reported as «idle left» to
//    cells a sub-scope reported as «wanting» — 11-28 00:2x it deferred 16 rows «no-idle-hand-anywhere» in one hour while
//    `eln fed kpi` counted 12 idle-with-work hands, and OP's tab assigned 14 cells by hand (resource-opt rows).
// C: §5a says «shadow 1 h → compare with what OP actually did → capped live». There was no shadow record and no compare.
// A: 세 얼굴 —
//   관측 = every HQ R1 tick appends ONE line to `<state>/steward/space/<HQ>/hq-shadow.jsonl`: free hands · in-scope
//          hands · «would have paired idle hand X (home A) → backlog cell Y (scope B)» rows (caps from
//          graphs/policies/steward-hq.yaml). The same pure function replays the stored R0 snapshots (runs/*.json, last 48
//          ticks) so an hour that ran before this code can be judged too.
//   판단 근거 = rules only (no LLM): free = idle ≥ idle_min ∧ no workable own yellow cell (WIP 1) ∧ not waiting on an
//          open ✋ · backlog = yellow P0/P1 not waiting: unowned (HQ) · coordinator-held (that scope) · stalled hand cell
//          (its scope) · best cell first (P0 · oldest) · a pair inside the home scope is marked in-scope · maker ≠ judge.
//          STEWARD-READY-LANES (11-28 01:00–01:47Z: agreement 72% → 11%): «workable» is the shared cell-wait rule, so a
//          green-triage lane-a cell («merged ⊕ receipt → judge now») is JUD's, never a hand's · a cell the shadow paired
//          stays with that hand for stall_min (what a live assign's owner change would do — CAPSULE-A1-POLICY drew 3 hands
//          in 40 min) · OP acts on lane-a cells and on coordinator / no-pane seats are kept apart from the comparison.
//   수복과 인계 = shadow writes only its ledger (no mail · no owner change · no pregate). `eln steward hq shadow-report`
//          joins the rows with fed-state `cell:assign` (decidedBy = HQ · tab vs steward-live) and `work:claimed` facts →
//          would-pair · OP assigned · agreement vs the §5a target · idle now · per-scope rollup · fed exceptions.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { Fact } from '../../fed-state/ledger.js';
import { cellWaitOf } from './cell-wait.js';
import { DEFAULT_LIVE_R1, freeHands, isAssignableCell, isRosterCell, judgeCell, judgeSide, scopeOf, type CellView, type LiveR1Policy, type Row, type Snapshot } from './model.js';
import { comparePull, legacyPullPolicy, liveWriter, recentDeclaredPr, pullClass } from '../../kit/work-pull/index.js';
import { prNamesCell } from './cell-wait.js';

export interface HqPolicy {
  readonly mode: 'shadow' | 'off';
  readonly caps: { readonly assign: number; readonly pregate: number; readonly judge: number };
  readonly idleMin: number;
  /** Pre-policy fallback: a live snapshot's `pull` (graphs/policies/work-pull.yaml order.priorities · shared with `eln work
   *  next` and OP's table) wins; this list serves stored snapshots without it (replays). */
  readonly priorities?: readonly string[];
  readonly stallMin: number;
  readonly matchLeadMin: number;
  readonly agreementTarget: number;
  /** STEWARD-HQ-LIVE-ALIGN — the live R1 numbers (every scope) · absent block = {@link DEFAULT_LIVE_R1}. */
  readonly live?: LiveR1Policy;
}

export const hqPolicyPath = (root = resolve(import.meta.dir, '../../..')): string => join(root, 'graphs', 'policies', 'steward-hq.yaml');

const nonNeg = (v: unknown, key: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`steward-hq policy: ${key} must be a number ≥ 0`);
  return v;
};

export function parseHqPolicy(text: string): HqPolicy {
  const raw = parse(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new Error('steward-hq policy: not a mapping');
  const mode = raw.mode;
  if (mode !== 'shadow' && mode !== 'off') throw new Error(`steward-hq policy: mode must be shadow|off (got ${String(mode)})`);
  const caps = (raw.caps ?? {}) as Record<string, unknown>;
  const pr = raw.priorities;
  if (pr !== undefined && (!Array.isArray(pr) || !pr.length || pr.some((p) => typeof p !== 'string'))) throw new Error('steward-hq policy: priorities must be a list of strings');
  const target = nonNeg(raw.agreement_target, 'agreement_target');
  if (target > 1) throw new Error('steward-hq policy: agreement_target must be ≤ 1');
  const live = parseLiveR1(raw.live);
  return {
    mode,
    caps: { assign: nonNeg(caps.assign, 'caps.assign'), pregate: nonNeg(caps.pregate, 'caps.pregate'), judge: nonNeg(caps.judge, 'caps.judge') },
    idleMin: nonNeg(raw.idle_min, 'idle_min'), ...(pr !== undefined ? { priorities: pr as string[] } : {}), stallMin: nonNeg(raw.stall_min, 'stall_min'),
    matchLeadMin: nonNeg(raw.match_lead_min, 'match_lead_min'), agreementTarget: target, live,
  };
}

/** The `live:` block — a missing key = its default; a wrong type throws (the policy file is wrong, say so). */
export function parseLiveR1(raw: unknown): LiveR1Policy {
  if (raw === undefined || raw === null) return DEFAULT_LIVE_R1;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('steward-hq policy: live must be a mapping');
  const r = raw as Record<string, unknown>;
  const bool = (key: string, fallback: boolean): boolean => {
    if (r[key] === undefined) return fallback;
    if (typeof r[key] !== 'boolean') throw new Error(`steward-hq policy: live.${key} must be true|false`);
    return r[key] as boolean;
  };
  const markers = r.not_roster_markers;
  if (markers !== undefined && (!Array.isArray(markers) || markers.some((m) => typeof m !== 'string' || !m.trim()))) throw new Error('steward-hq policy: live.not_roster_markers must be a list of strings');
  return {
    idleMin: r.idle_min === undefined ? DEFAULT_LIVE_R1.idleMin : nonNeg(r.idle_min, 'live.idle_min'),
    rosterStallExempt: bool('roster_stall_exempt', DEFAULT_LIVE_R1.rosterStallExempt),
    directLend: bool('direct_lend', DEFAULT_LIVE_R1.directLend),
    notRosterMarkers: markers === undefined ? DEFAULT_LIVE_R1.notRosterMarkers : (markers as string[]),
  };
}

/** The live tick's read: the shipped policy's `live` block, else the defaults (fail-open — R1 never stops on a bad file). */
export function loadLiveR1Policy(path = hqPolicyPath()): { policy: LiveR1Policy; source: 'yaml' | 'default'; error?: string } {
  try { return { policy: loadHqPolicy(path).live ?? DEFAULT_LIVE_R1, source: 'yaml' }; } catch (error) { return { policy: DEFAULT_LIVE_R1, source: 'default', error: String(error).slice(0, 200) }; }
}

export function loadHqPolicy(path = hqPolicyPath()): HqPolicy {
  if (!existsSync(path)) throw new Error(`steward-hq policy missing: ${path}`);
  return parseHqPolicy(readFileSync(path, 'utf8'));
}

// ── plan (pure) ────────────────────────────────────────────────────────────────────────────────

export interface HqPair { readonly hand: string; readonly from: string; readonly cell: string; readonly to: string; readonly priority?: string; readonly side: 'maker' | 'judge'; readonly idleMin: number }
export interface HqShadowTick {
  readonly at: string; readonly runId: string; readonly hq: string; readonly source: 'tick' | 'replay';
  /** Idle hands (idle ≥ idle_min) · of them free (no workable own cell · not waiting on ✋). */
  readonly idle: number; readonly free: number;
  /** Pairs inside the hand's home scope (the sub-steward's lane) · free hands with no same-side backlog · over the cap. */
  readonly inScope: number; readonly noCell: number; readonly overCap: number;
  readonly pairs: readonly HqPair[];
  /** Backlog per scope · cell → scope for the report's «same scope» match. */
  readonly backlog: Readonly<Record<string, number>>;
  readonly cellScope: Readonly<Record<string, string>>;
  /** HQ ⊕ coordinator seats — never hands (§5a lends hands only); the report keeps OP's assignments to them apart. */
  readonly coords?: readonly string[];
  /** The board version the snapshot read (11-28: 0.3.38 while 0.3.39 was in play → backlog 0 — now visible in the report). */
  readonly version?: string;
  /** Declared hands with no live pane (HAND-ELN-* 11-28) — never paired; an OP assignment to one is reported apart. */
  readonly noPane?: readonly string[];
  /** STEWARD-READY-LANES — yellow lane-a cells (JUD signs) this tick saw: never paired · an OP act on one is kept apart. */
  readonly judgeLane?: readonly string[];
  /** Backlog cells left out because an earlier shadow pair gave them to another hand (inside stall_min). */
  readonly remembered?: number;
}

/** The shadow's own memory: cell → the hand it was first paired to, for pairs younger than `windowMin` (earliest wins). */
export type ShadowMemory = Readonly<Record<string, { readonly hand: string; readonly atMs: number }>>;
export function shadowMemory(ticks: readonly Pick<HqShadowTick, 'at' | 'pairs'>[], nowMs: number, windowMin: number): ShadowMemory {
  const out: Record<string, { hand: string; atMs: number }> = {};
  for (const t of [...ticks].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const at = Date.parse(t.at);
    if (!Number.isFinite(at) || at > nowMs || nowMs - at >= windowMin * MIN) continue;
    for (const p of t.pairs) if (!out[p.cell]) out[p.cell] = { hand: p.hand, atMs: at };
  }
  return out;
}

const UNOWNED = (owner: string | undefined): boolean => !owner || owner === '-' || owner.toLowerCase() === 'none';
const ownerSeat = (owner: string | undefined): string => (owner ?? '').split('/')[0]!.trim().toUpperCase();
const MIN = 60_000;

export function planHqPairs(snap: Snapshot, policy: HqPolicy, meta: { at: string; runId: string; source: 'tick' | 'replay' }, memory: ShadowMemory = {}): HqShadowTick {
  const isHand = (seat: string): boolean => seat !== snap.hq && !snap.coordinators.includes(seat);
  // WORK-PULL-REACHES-ROSTER — ONE order with `eln work next` and OP's table: the snapshot's pull policy (work-pull.yaml ·
  // roster class → roster rank → priority), else the pre-policy file's priorities.
  const pull = snap.pull;
  const priorities = pull?.policy.priorities ?? policy.priorities ?? legacyPullPolicy().priorities;
  const rank = (p: string | undefined): number => { const i = priorities.indexOf(p ?? ''); return i < 0 ? 99 : i; };
  const order = (a: CellView, b: CellView): number => (pull ? comparePull(a, b, pull.policy, pull.rosterRank) : rank(a.priority) - rank(b.priority))
    || Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id);
  const working = new Set(snap.seats.filter((s) => s.activity === 'working').map((s) => s.seat));
  const workable = (c: CellView): boolean => c.status === 'yellow' && !cellWaitOf(c.id, snap);
  const r1 = policy.live ?? DEFAULT_LIVE_R1;
  // The same live-writer rule as model.ts / `eln work next` (kit/work-pull liveWriter · activity clock ⊕ PRs).
  const writing = (c: CellView): boolean => {
    const seat = c.writer?.seat?.trim().toUpperCase();
    if (!seat || !pull) return false;
    const view = snap.seats.find((s) => s.seat === seat);
    const activityMs = view?.lastActiveMs ?? (view?.activity === 'working' ? snap.nowMs : view?.activity === 'idle' && view.idleForMs !== null ? snap.nowMs - view.idleForMs : undefined);
    const prs = snap.prs.filter((pr) => prNamesCell(pr, c.id)).map((pr) => Date.parse(pr.updatedAt)).filter((t) => Number.isFinite(t));
    return liveWriter(c, { nowMs: snap.nowMs, ...(activityMs !== undefined ? { activityMs } : {}), ...(prs.length ? { prUpdatedMs: Math.max(...prs) } : {}) }, pull.policy) !== undefined;
  };
  const rosterOf = (c: CellView): boolean => (pull ? pullClass(c.evidenceHead, pull.policy) === 'roster' : isRosterCell(c, r1.notRosterMarkers));

  const cellScope: Record<string, string> = {};
  const backlogCells: CellView[] = [];
  const judgeLane = snap.cells.filter((c) => c.status === 'yellow' && cellWaitOf(c.id, snap) === 'awaiting-judge').map((c) => c.id).sort();
  for (const c of snap.cells) {
    if (!workable(c) || !isAssignableCell(c) || !priorities.includes(c.priority ?? '')) continue;
    // A cell a hand is live-writing is that hand's · «[WIP 잔류 …]» is never paired.
    if (pull && (pullClass(c.evidenceHead, pull.policy) === 'never' || writing(c) || recentDeclaredPr(c.id, snap.prs, snap.nowMs, pull.policy))) continue;
    let scope: string | null = null;
    if (UNOWNED(c.owner)) scope = snap.hq;
    else {
      const owner = ownerSeat(c.owner);
      // Same rule as live R1 (movableCells): a coordinator's roster cell at once · its reserve / WIP-leftover cell on the clock.
      if (!isHand(owner)) { if ((r1.rosterStallExempt && rosterOf(c)) || snap.nowMs - Date.parse(c.updatedAt) >= policy.stallMin * MIN) scope = scopeOf(snap, owner); }
      else if (!working.has(owner) && snap.nowMs - Date.parse(c.updatedAt) >= policy.stallMin * MIN) scope = scopeOf(snap, owner);
    }
    if (scope === null) continue;
    cellScope[c.id] = scope;
    backlogCells.push(c);
  }
  backlogCells.sort(order);
  const backlog: Record<string, number> = {};
  for (const id of Object.keys(cellScope)) backlog[cellScope[id]!] = (backlog[cellScope[id]!] ?? 0) + 1;

  const idleHands = snap.seats
    .filter((s) => isHand(s.seat) && s.activity === 'idle' && s.idleForMs !== null && s.idleForMs >= policy.idleMin * MIN)
    .sort((a, b) => (b.idleForMs ?? 0) - (a.idleForMs ?? 0) || a.seat.localeCompare(b.seat));
  const freeSet = new Set(freeHands(snap, policy.idleMin).map((s) => s.seat));
  const free = idleHands.filter((s) => freeSet.has(s.seat));

  const taken = new Set<string>();
  const left = { assign: policy.caps.assign, judge: policy.caps.judge };
  const pairs: HqPair[] = [];
  let inScope = 0; let noCell = 0; let overCap = 0;
  // A cell paired earlier (inside stall_min) belongs to that hand — as a live assign's owner change would make it.
  const given = (c: CellView, seat: string): boolean => { const m = memory[c.id]; return !!m && m.hand !== seat && snap.nowMs - m.atMs < policy.stallMin * MIN; };
  const remembered = backlogCells.filter((c) => { const m = memory[c.id]; return !!m && snap.nowMs - m.atMs < policy.stallMin * MIN; }).length;
  for (const hand of free) {
    const judge = judgeSide(snap, hand.seat);
    const home = scopeOf(snap, hand.seat);
    const fits = (c: CellView): boolean => !taken.has(c.id) && !given(c, hand.seat) && judgeCell(snap, c) === judge && ownerSeat(c.owner) !== hand.seat;
    // Best backlog cell anywhere (P0 first · oldest). A home-scope cell is the sub-steward's lane — counted `inScope`, still
    // recorded: 11-28 the TC steward (live) wrote no r1 assign in an hour while OP's tab moved TC hands onto HQ cells.
    const cell = backlogCells.find(fits);
    if (!cell) { noCell++; continue; }
    const cap = judge ? 'judge' : 'assign';
    if (left[cap] <= 0) { overCap++; continue; }
    left[cap]--;
    taken.add(cell.id);
    if (cellScope[cell.id] === home) inScope++;
    pairs.push({ hand: hand.seat, from: home, cell: cell.id, to: cellScope[cell.id]!, ...(cell.priority ? { priority: cell.priority } : {}),
      side: judge ? 'judge' : 'maker', idleMin: Math.floor((hand.idleForMs ?? 0) / MIN) });
  }
  return { ...meta, hq: snap.hq, idle: idleHands.length, free: free.length, inScope, noCell, overCap, pairs, backlog, cellScope, coords: [snap.hq, ...snap.coordinators], ...(snap.version ? { version: snap.version } : {}),
    noPane: snap.seats.filter((s) => s.activity === 'no-pane' && isHand(s.seat)).map((s) => s.seat).sort(),
    ...(judgeLane.length ? { judgeLane } : {}), ...(remembered ? { remembered } : {}) };
}

// ── ledger ─────────────────────────────────────────────────────────────────────────────────────

const spaceDir = (root: string): string => join(root, 'steward', 'space');
export const hqShadowPath = (root: string, hq: string): string => join(spaceDir(root), hq.replace(/[^\w.-]/g, '_'), 'hq-shadow.jsonl');

/** One HQ R1 tick → one appended line (O_APPEND: concurrent ticks interleave whole lines). Off = nothing. */
export function recordHqShadow(root: string, snap: Snapshot, meta: { at: string; runId: string }, policy: HqPolicy): HqShadowTick | null {
  if (policy.mode === 'off') return null;
  const now = new Date(snap.nowMs);
  const memory = shadowMemory(readHqShadow(root, snap.hq, new Date(snap.nowMs - policy.stallMin * MIN), now), snap.nowMs, policy.stallMin);
  const tick = planHqPairs(snap, policy, { ...meta, source: 'tick' }, memory);
  const path = hqShadowPath(root, snap.hq);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(tick)}\n`);
  return tick;
}

export function readHqShadow(root: string, hq: string, since: Date, until: Date): HqShadowTick[] {
  const path = hqShadowPath(root, hq);
  if (!existsSync(path)) return [];
  const out: HqShadowTick[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line) as HqShadowTick; const ms = Date.parse(t.at);
      if (ms >= since.getTime() && ms < until.getTime()) out.push(t);
    } catch { /* torn line: skip */ }
  }
  return out;
}

/** The same plan over the R0 snapshots the space graph kept (runs/*.json · the last 48 ticks) — for hours before the hook. */
export function replayHqShadow(root: string, since: Date, until: Date, policy: HqPolicy): HqShadowTick[] {
  const dir = join(spaceDir(root), 'runs');
  if (!existsSync(dir)) return [];
  const runs: { runId: string; startedAt: string; snapshot: Snapshot }[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      const run = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { runId?: string; startedAt?: string; snapshot?: Snapshot };
      const ms = Date.parse(run.startedAt ?? '');
      if (!run.snapshot || !(ms >= since.getTime() && ms < until.getTime())) continue;
      runs.push({ runId: run.runId ?? name.slice(0, -5), startedAt: run.startedAt!, snapshot: run.snapshot });
    } catch { /* unreadable run file: skip */ }
  }
  // In time order, each tick remembering the earlier replayed pairs (the same memory the live hook reads from its ledger).
  const ticks: HqShadowTick[] = [];
  for (const run of runs.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.runId.localeCompare(b.runId))) {
    try {
      ticks.push(planHqPairs(run.snapshot, policy, { at: run.startedAt, runId: run.runId, source: 'replay' }, shadowMemory(ticks, run.snapshot.nowMs, policy.stallMin)));
    } catch { /* a snapshot the planner cannot read: skip */ }
  }
  return ticks;
}

// ── report (pure) ──────────────────────────────────────────────────────────────────────────────

export interface HqAct { readonly at: string; readonly hand: string; readonly cell: string; readonly by: 'op-tab' | 'steward-live' | 'claim'; readonly why?: string; readonly toCoordinator?: boolean; readonly toNoPane?: boolean; readonly toJudgeLane?: boolean }
export interface HqShadowReport {
  readonly hq: string; readonly since: string; readonly until: string; readonly source: 'tick' | 'replay' | 'none'; readonly ticks: number;
  /** Board version of the last tick (absent = a tick written before 11-28). */
  readonly board?: string;
  readonly wouldPair: number; readonly pairs: ReadonlyArray<HqPair & { at: string; match: 'cell' | 'scope' | 'none' }>;
  readonly opAssigned: { readonly tab: number; readonly stewardLive: number; readonly claims: number; readonly toCoordinator: number; readonly toNoPane?: number; readonly toJudgeLane?: number };
  readonly acts: ReadonlyArray<HqAct & { predicted: boolean }>;
  readonly matched: { readonly cell: number; readonly scope: number };
  /** Dice over both sides: (shadow pairs matched + OP acts predicted) / (shadow pairs + OP acts compared) · null when both
   *  are 0. ONE number, the §5a gate's (STEWARD-READY-LANES 11-28): OP's acts steward:hq may never make are not compared
   *  — to coordinator seats (§5a lends hands only · OP routes its direct reports), to no-pane hands (no session) and onto
   *  lane-a cells (JUD signs · not hand work). They are counted in `opAssigned`; `agreementRaw` keeps the all-acts Dice. */
  readonly agreement: number | null; readonly agreementRaw: number | null; readonly target: number;
  readonly idleNow: { readonly idle: number; readonly free: number; readonly inScope: number; readonly noCell: number; readonly overCap: number } | null;
  readonly rollups: readonly string[];
  readonly exceptions: { readonly count: number; readonly top: readonly string[] };
}

export function hqActsOf(facts: readonly Fact[], hq: string): HqAct[] {
  const acts: HqAct[] = [];
  for (const f of facts) {
    if (f.type === 'cell' && f.state === 'assign' && f.decidedBy === hq && f.to && f.cell) {
      acts.push({ at: f.ts, hand: f.to.toUpperCase(), cell: f.cell, by: (f.kind ?? '').startsWith('[행정관') ? 'steward-live' : 'op-tab', ...(f.kind ? { why: f.kind.slice(0, 80) } : {}) });
    } else if (((f.type === 'work' && f.state === 'claimed') || (f.type === 'cell' && f.state === 'claim')) && f.seat && f.cell) {
      acts.push({ at: f.ts, hand: f.seat.toUpperCase(), cell: f.cell, by: 'claim' });
    }
  }
  return acts;
}

export function hqShadowReport(input: {
  hq: string; since: Date; until: Date; ticks: readonly HqShadowTick[]; facts: readonly Fact[]; policy: HqPolicy;
  ledgerRows?: readonly Pick<Row, 'action' | 'reason' | 'target'>[]; rollups?: readonly string[];
}): HqShadowReport {
  const { ticks, policy } = input;
  const lead = policy.matchLeadMin * MIN;
  const firstPair = new Map<string, HqPair & { at: string; scopes: Readonly<Record<string, string>> }>();
  for (const t of ticks) for (const p of t.pairs) {
    const key = `${p.hand}|${p.cell}`;
    if (!firstPair.has(key)) firstPair.set(key, { ...p, at: t.at, scopes: t.cellScope });
  }
  const acts = hqActsOf(input.facts, input.hq).filter((a) => { const ms = Date.parse(a.at); return ms >= input.since.getTime() && ms < input.until.getTime(); });
  const pairs = [...firstPair.values()].map(({ scopes, ...p }) => {
    const after = acts.filter((a) => a.hand === p.hand && Date.parse(a.at) >= Date.parse(p.at) - lead);
    const match: 'cell' | 'scope' | 'none' = after.some((a) => a.cell === p.cell) ? 'cell' : after.some((a) => scopes[a.cell] === p.to) ? 'scope' : 'none';
    return { ...p, match };
  });
  const coords = new Set(ticks.flatMap((t) => t.coords ?? [input.hq]));
  const noPane = new Set(ticks.flatMap((t) => t.noPane ?? []));
  const judgeLane = new Set(ticks.flatMap((t) => t.judgeLane ?? []));
  // A hand with no pane cannot take the cell (11-28 21:59Z: 3 of OP's 8 went to HAND-ELN-TA · HAND-ELN-ELS · HAND-VM-GOLDEN):
  // kept apart like coordinator seats — the shadow is right not to pair them, so they do not count against it. Same for a
  // lane-a cell (11-28 01:11Z OP's tab: MSG-ACK-MULTI-ID → TC-H-CX-3 «P1 stalled» — merged ⊕ receipt, JUD signs it).
  const decided = acts.filter((a) => a.by !== 'claim').map((a) => (coords.has(a.hand) ? { ...a, toCoordinator: true } : noPane.has(a.hand) ? { ...a, toNoPane: true }
    : judgeLane.has(a.cell) ? { ...a, toJudgeLane: true } : a));
  const scored = decided.map((a) => ({ ...a, predicted: [...firstPair.values()].some((p) => p.hand === a.hand && Date.parse(p.at) <= Date.parse(a.at) + lead && (p.cell === a.cell || p.scopes[a.cell] === p.to)) }));
  const matchedCell = pairs.filter((p) => p.match === 'cell').length;
  const matchedScope = pairs.filter((p) => p.match === 'scope').length;
  const denom = pairs.length + scored.length;
  const handActs = scored.filter((a) => !a.toCoordinator && !a.toNoPane && !a.toJudgeLane);
  const denomHands = pairs.length + handActs.length;
  const last = ticks[ticks.length - 1];
  const exc = (input.ledgerRows ?? []).filter((r) => r.action === 'reject' || r.action === 'ambiguous' || r.action === 'escalate');
  const reasons = new Map<string, number>();
  for (const r of exc) { const k = `${r.action}:${r.reason.split(':')[0]}`; reasons.set(k, (reasons.get(k) ?? 0) + 1); }
  return {
    hq: input.hq, since: input.since.toISOString(), until: input.until.toISOString(), source: last?.source ?? 'none', ticks: ticks.length,
    ...(last?.version ? { board: last.version } : {}),
    wouldPair: pairs.length, pairs,
    opAssigned: { tab: decided.filter((a) => a.by === 'op-tab').length, stewardLive: decided.filter((a) => a.by === 'steward-live').length, claims: acts.filter((a) => a.by === 'claim').length, toCoordinator: decided.filter((a) => a.toCoordinator).length,
      ...(decided.some((a) => a.toNoPane) ? { toNoPane: decided.filter((a) => a.toNoPane).length } : {}),
      ...(decided.some((a) => a.toJudgeLane) ? { toJudgeLane: decided.filter((a) => a.toJudgeLane).length } : {}) },
    acts: scored, matched: { cell: matchedCell, scope: matchedScope },
    agreement: denomHands ? Math.round(((matchedCell + matchedScope + handActs.filter((a) => a.predicted).length) / denomHands) * 100) / 100 : null,
    agreementRaw: denom ? Math.round(((matchedCell + matchedScope + scored.filter((a) => a.predicted).length) / denom) * 100) / 100 : null,
    target: policy.agreementTarget,
    idleNow: last ? { idle: last.idle, free: last.free, inScope: last.inScope, noCell: last.noCell, overCap: last.overCap } : null,
    rollups: input.rollups ?? [],
    exceptions: { count: exc.length, top: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} ${n}`) },
  };
}

export function renderHqShadowReport(r: HqShadowReport): string {
  const pct = (v: number | null): string => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);
  return [
    `steward:hq shadow ${r.since} → ${r.until} · source ${r.source} · ticks ${r.ticks}${r.board ? ` · board ${r.board}` : ''}`,
    `would-pair ${r.wouldPair} (matched: same cell ${r.matched.cell} · same scope ${r.matched.scope}) · OP assigned: tab ${r.opAssigned.tab} · steward-live ${r.opAssigned.stewardLive} · hand claims ${r.opAssigned.claims}`,
    `agreement ${pct(r.agreement)} (target ${pct(r.target)}) → ${r.agreement !== null && r.agreement >= r.target ? 'capped live may start' : 'stay shadow'} · not compared (never steward:hq's move): to coordinator seats ${r.opAssigned.toCoordinator}${r.opAssigned.toNoPane ? ` · to no-pane hands ${r.opAssigned.toNoPane} (no session — the cell waits)` : ''}${r.opAssigned.toJudgeLane ? ` · onto lane-a cells ${r.opAssigned.toJudgeLane} (JUD signs)` : ''} · all acts ${pct(r.agreementRaw)}`,
    r.idleNow ? `idle now ${r.idleNow.idle} · free ${r.idleNow.free} · in-scope ${r.idleNow.inScope} · no backlog ${r.idleNow.noCell} · over cap ${r.idleNow.overCap}` : 'idle now: no tick',
    ...r.pairs.slice(0, 12).map((p) => `- ${p.at.slice(11, 16)}Z would pair ${p.hand} (${p.from}) → ${p.cell} (${p.to}${p.priority ? ` · ${p.priority}` : ''}) · ${p.match}`),
    ...r.acts.slice(0, 12).map((a) => `- ${a.at.slice(11, 16)}Z OP ${a.by} ${a.hand}${a.toCoordinator ? ' (coordinator)' : a.toNoPane ? ' (no pane)' : ''} → ${a.cell}${a.toJudgeLane ? ' (lane a · JUD)' : ''} · ${a.predicted ? 'predicted' : 'not in shadow'}`),
    ...(r.rollups.length ? ['scopes:', ...r.rollups.map((l) => `- ${l}`)] : []),
    `fed exceptions ${r.exceptions.count}${r.exceptions.top.length ? ` (${r.exceptions.top.join(' · ')})` : ''}`,
  ].join('\n');
}
