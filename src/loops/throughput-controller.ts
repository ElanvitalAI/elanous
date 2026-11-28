// THROUGHPUT-CONTROLLER — the hourly «착지 10 · 초록 10» control step inside the OP pulse (CEO 11-26 23:4x · LLM 0).
//
// S: the target is 10 lands/h and 10 greens/h (FEATURE-SHIP-ACCELERATION §1). On 11-26 main took 115 merges in 23 h
//    (peaks 12/h at 07 · 19 · 20 KST) but 0.3.38 had 1 green of 116 cells. The land graph sat dead until 19:44 (a
//    launchd python3.9 crash refused ~45 PRs as «baseline-failing-focused»). After that it landed one PR per tick
//    (slots 1 · a tick every 4–10 min) while ~15 els PRs on the same files (attach-app.ts · server.ts · elements/index.ts)
//    bounced on merge conflicts (#40285 refused 5×). 228 pregate receipts covered 129 PRs (1.8 runs per PR). 18 hands sat
//    idle behind an unanswered ✋ and a blanket ban.
// C: each of these is one stage of the same pipeline, and each has its own lever. The hourly check named «a bottleneck»
//    by reading. It did not say which stage binds now, and it pulled no lever on its own.
// Q: from state alone, which ONE constraint binds the hour, and which lever moves it — by machine now, or by OP?
// A: decideThroughput() measures (lands/h · greens/h · ready supply · pregate waits · churn refusals by file · idle and
//    frozen hands). It walks the stages back to front (green → land → pregate → supply → hands — FEATURE-SHIP-ACCELERATION
//    §11c-2: the furthest-back constrained stage binds). The chain it walks is the one whose target misses by more. It
//    returns ONE verdict + ONE lever from LEVERS. Machine-doable levers (JUD green batch card · merge-main request to the
//    hot-lane PRs · pregate re-route card · tsc-blind re-run card) are executed by executeThroughput() through injected
//    actuators. Everything else becomes «OP NEXT ACTION» with the exact command. A tsc-blind receipt always gets its card
//    (safety), even when it is not the binding constraint.
//
// 세 얼굴:
//   관측 = `eln pulse throughput` · the «처리량 제어» block at the top of `eln pulse next` and of every pulse table ·
//          seat-state/OP/pulse/THROUGHPUT-NOW.md (the board line) · {stateRoot}/loops/throughput-controller.jsonl
//   판단 근거 = each constraint's signal line (counts · ids · ages from the snapshot) · the walk order · LEVERS row
//   수복과 인계 = machine levers run at once (deduped per PR head · 6 h). OP levers lead the OP turn with the command
//          and done-when. An unmeasured probe is «?». It is never read as zero and never counted as on target.
import { filterInWindow, median, MINUTE_MS } from '../kit/kpi/index.js';

export type ConstraintKind =
  | 'green-judge' | 'green-linkage'
  | 'land-dead' | 'hot-file-churn' | 'land-slots'
  | 'pregate-blind' | 'pregate-wait'
  | 'hands-frozen' | 'ready-drought'
  | 'on-target';

export type LeverActor = 'machine' | 'op';

export interface TpRefusal { readonly pr: number; readonly cls: string; readonly at: string; readonly files: readonly string[] }
export interface TpOpenPr { readonly pr: number; readonly head: string; readonly author: string; readonly files: readonly string[]; readonly draft: boolean; readonly updatedAt?: string }
export interface TpReceipt { readonly pr: number; readonly head: string; readonly host: string; readonly at: string; readonly tscExit: number | null; readonly author?: string }

export interface ThroughputSnapshot {
  readonly now: string;
  readonly version: string | null;
  readonly targets: { readonly landsPerH: number; readonly greensPerH: number };
  /** Squash merges on origin/main in the last hour (all paths: land graph · direct · train). null = unmeasured. */
  readonly landsLastHour: number | null;
  /** The land graph's own lands in the last hour (ledger `landed`). */
  readonly graphLandsLastHour: number | null;
  readonly greensLastHour: number | null;
  /** green-triage bucket (a): merged PR ⊕ same-head receipt, still yellow — JUD can sign now. */
  readonly judgeReady: readonly { readonly cell: string; readonly prs: readonly number[] }[] | null;
  /** PRs that landed in the last hour and no cell of the version cites. */
  readonly landsWithoutCell: number | null;
  readonly land: { readonly readyToLand: number | null; readonly slots: number | null; readonly mode: string | null; readonly lastTickAgeMin: number | null; readonly avgTickMin: number | null } | null;
  /** Churn refusals (merge conflict · stale-base revert · same-files overlap) in the last 2 h, with the PR's files. */
  readonly churn: readonly TpRefusal[] | null;
  readonly openPrs: readonly TpOpenPr[] | null;
  /** PR-ZOMBIE-AGING: non-draft open PRs left out of supply (head older than pr-aging.yaml supply.fresh_head_max_days) · absent = unmeasured. */
  readonly staleExcluded?: readonly number[] | null;
  /** PRs the land graph is waiting on for a pregate receipt of their current head (no-receipt · stale-head), with age. */
  readonly awaitingPregate: readonly { readonly pr: number; readonly sinceMin: number }[] | null;
  /** Pregate receipts written in the last 2 h. */
  readonly receipts: readonly TpReceipt[] | null;
  /** Pregate hosts in routing order (local first: node-b → minim5 → mbp — OPS-RULES §착지 가속 · local-hosts-before-paid-vm). */
  readonly pregateHosts: readonly string[];
  readonly hands: { readonly free: readonly string[]; readonly holdingIdle: readonly string[]; readonly working: number } | null;
  /** Hands with an open ✋ older than FROZEN_MIN (blanket bans and unanswered hand-raises freeze them). */
  readonly frozen: readonly { readonly seat: string; readonly to: string; readonly ageMin: number; readonly msgId: number }[] | null;
  /** Yellow cells nobody owns with a done-when (what `eln work next` can hand out). */
  readonly readyCells: number | null;
  /** Verified live maximum number of recipient cards per run; unknown fails closed. */
  readonly throughputCards?: number | null;
  readonly unmeasured?: readonly string[];
}

export interface Constraint { readonly kind: ConstraintKind; readonly signal: string }

export interface LeverAction {
  /** Dedupe key (kind + PR + head). */
  readonly key: string;
  readonly do: 'jud-green-batch' | 'merge-main-request' | 'pregate-route' | 'tsc-rerun';
  readonly to: readonly string[];
  readonly body: string;
}

export interface Lever {
  readonly id: string;
  readonly actor: LeverActor;
  readonly owner: string;
  readonly what: string;
  readonly commands: readonly string[];
  readonly doneWhen: string;
  /** Machine actions (cards) the controller sends itself. Empty for OP levers. */
  readonly actions: readonly LeverAction[];
}

export interface ThroughputVerdict {
  readonly at: string;
  readonly measured: { readonly lands: number | null; readonly greens: number | null; readonly targets: ThroughputSnapshot['targets']; readonly ceilingLandsPerH: number | null; readonly pipeline: number | null; readonly staleExcluded?: number };
  /** Which target the walk followed (the one missing by more, relative). */
  readonly chain: 'green' | 'land';
  readonly active: readonly Constraint[];
  readonly binding: Constraint;
  readonly lever: Lever;
  /** Safety cards that go out regardless of the binding constraint (tsc-blind receipts). */
  readonly safety: readonly LeverAction[];
  readonly throughputCards?: number | null;
  readonly hotFiles: readonly { readonly file: string; readonly prs: readonly number[] }[];
  readonly unmeasured: readonly string[];
}

// ── thresholds (each names its source) ──────────────────────────────────────────────────────────────────────────
// 출처: CEO 11-26 23:4x «시간당 랜딩 10, 초록 10».
export const TARGET_LANDS_PER_H = 10;
export const TARGET_GREENS_PER_H = 10;
/** green-triage (a) rows worth one JUD batch card (a batch below this is OP's signature window, not a constraint). */
export const JUDGE_READY_MIN = 3;
/** Churn: any PR refused this often in 2 h, or a file shared by this many refused PRs, is a hot lane (11-26: #40285 ×5). */
export const CHURN_PR_REPEAT = 2;
export const CHURN_FILE_PRS = 2;
export const CHURN_TOTAL_MIN = 3;
/** Land graph silent this long with PRs ready = dead (the 20-min land-graph cadence × 2 — 11-26 python crash). */
export const LAND_DEAD_TICK_MIN = 40;
/** pregate: this many PRs waiting with a median wait over this = capacity (OPS-RULES §32 «pregate 대기 10분↑» + one rerun). */
export const PREGATE_WAIT_N = 3;
export const PREGATE_WAIT_MIN = 15;
/** A ✋ open this long freezes its hand (hand-raise ladder hold 15 min × 2). */
export const FROZEN_MIN = 30;
export const FROZEN_HANDS_MIN = 2;
/** Ready supply per idle hand (BOARD-STEWARD READY_PER_HAND · rhythm ready_per_hand 2). */
export const READY_PER_IDLE_HAND = 2;
/** Machine cards per verdict (a card storm floods the hands' mail — op-next-action MAX_ASSIGN_PER_PLAN). */
export const MAX_CARDS = 8;
/** tsc exits that are tsc's own verdict (0 clean · 1/2 diagnostics). Anything else (134 abort · 137 kill · null) = blind. */
export const TSC_OWN_EXITS = [0, 1, 2];
export const CHURN_CLASSES = ['stale-base-revert', 'merge-conflict', 'main-moved-overlap'];

/** The lever table — the doc's §1 table in code (constraint → lever → owner → mechanism). */
export const LEVERS: Readonly<Record<ConstraintKind, { readonly id: string; readonly actor: LeverActor; readonly owner: string; readonly mechanism: string }>> = {
  'green-judge': { id: 'L-GREEN-BATCH', actor: 'machine', owner: 'JUD', mechanism: 'one card to JUD listing the green-triage (a) cells — same-head receipt ⊕ focused 0 ⊕ merged = sign green now' },
  'green-linkage': { id: 'L-CELL-LINK', actor: 'op', owner: 'OP → authors', mechanism: 'landed PRs that cite no cell: add the PR to its cell (evidence add) · PR body «칸 닫음: <ID>»' },
  'land-dead': { id: 'L-LAND-TICK', actor: 'machine', owner: 'next-action (d) · RES', mechanism: 'one land-graph tick + outcome alarm (planner rule (d)); one refusal class on every PR = a tool fault, not the PRs' },
  'hot-file-churn': { id: 'L-HOT-LANE', actor: 'machine', owner: 'authors · land graph', mechanism: 'merge-main request to every open PR in the hot lane now · land order = churn victims first (land-graph landOrder)' },
  'land-slots': { id: 'L-SLOTS', actor: 'op', owner: 'OP', mechanism: 'consider increasing land.graph.slots (the overlap guard still serializes same-file PRs)' },
  'pregate-blind': { id: 'L-TSC-BLIND', actor: 'machine', owner: 'author · RES', mechanism: 'card: re-run pregate on another host — a tsc exit outside 0/1/2 or an empty tsc output is a failure, never «clean»' },
  'pregate-wait': { id: 'L-PREGATE-ROUTE', actor: 'machine', owner: 'authors · RES', mechanism: 'card each waiting author the least-used local host: pregate.py <PR> --light --host <h>' },
  'hands-frozen': { id: 'L-UNFREEZE', actor: 'op', owner: 'OP · coordinator', mechanism: 'answer the ✋ / turn a blanket ban into named cells + expiry' },
  'ready-drought': { id: 'L-SUPPLY', actor: 'op', owner: 'OP · leaders', mechanism: 'harvest drafts with a PASS receipt to ready · split the top P0 into ≤45-min cells (planner (b)/(c) assigns)' },
  'on-target': { id: 'L-NONE', actor: 'machine', owner: '-', mechanism: 'both targets met — heartbeat line only' },
};

const ids = (xs: readonly number[], n = 6) => `${xs.slice(0, n).map(x => `#${x}`).join(' ')}${xs.length > n ? ` (+${xs.length - n})` : ''}`;

/** Files shared by ≥ CHURN_FILE_PRS refused PRs, most PRs first. */
export function hotFiles(churn: readonly TpRefusal[]): { file: string; prs: number[] }[] {
  const by = new Map<string, Set<number>>();
  for (const r of churn) for (const f of r.files) { const s = by.get(f) ?? new Set<number>(); s.add(r.pr); by.set(f, s); }
  return [...by].filter(([, s]) => s.size >= CHURN_FILE_PRS).map(([file, s]) => ({ file, prs: [...s].sort((a, b) => a - b) }))
    .sort((a, b) => b.prs.length - a.prs.length || a.file.localeCompare(b.file));
}

/** The least-used pregate host (fewest receipts in the last 30 min), ties broken by routing order. */
export function freestHost(hosts: readonly string[], receipts: readonly TpReceipt[], nowMs: number): string | null {
  if (!hosts.length) return null;
  const recent = filterInWindow(receipts, r => r.at, nowMs, 30 * MINUTE_MS);
  return [...hosts].map((h, i) => ({ h, i, n: recent.filter(r => r.host === h).length })).sort((a, b) => a.n - b.n || a.i - b.i)[0]!.h;
}

/** Measure → active constraints → ONE binding constraint (back-to-front walk) → ONE lever. Pure. */
export function decideThroughput(s: ThroughputSnapshot): ThroughputVerdict {
  const nowMs = Date.parse(s.now);
  const unmeasured = [...(s.unmeasured ?? [])];
  const T = s.targets;
  const active: Constraint[] = [];
  const add = (kind: ConstraintKind, signal: string) => active.push({ kind, signal });

  // green chain
  const judgeReady = s.judgeReady ?? [];
  if (s.judgeReady === null) unmeasured.push('judge-ready');
  if (s.greensLastHour !== null && s.greensLastHour < T.greensPerH && judgeReady.length >= JUDGE_READY_MIN)
    add('green-judge', `greens ${s.greensLastHour}/${T.greensPerH} · ${judgeReady.length} cells merged ⊕ same-head receipt, unsigned (${judgeReady.slice(0, 4).map(j => j.cell).join(' · ')}${judgeReady.length > 4 ? ' …' : ''})`);
  if (s.greensLastHour !== null && s.greensLastHour < T.greensPerH && s.landsLastHour !== null && s.landsWithoutCell !== null
      && s.landsLastHour >= T.landsPerH / 2 && s.landsWithoutCell * 2 >= s.landsLastHour)
    add('green-linkage', `${s.landsWithoutCell} of ${s.landsLastHour} lands in the last hour cite no ${s.version ?? ''} cell — they can never turn a cell green`);

  // land chain (back to front)
  const land = s.land;
  if (land && land.readyToLand !== null && land.readyToLand > 0 && s.graphLandsLastHour === 0
      && (land.lastTickAgeMin === null || land.lastTickAgeMin >= LAND_DEAD_TICK_MIN || (s.churn ?? []).length === 0))
    add('land-dead', `${land.readyToLand} PRs ready · land graph landed 0 in 60 min · last tick ${land.lastTickAgeMin ?? '?'} min ago · mode ${land.mode ?? '?'}`);
  const churn = (s.churn ?? []).filter(r => CHURN_CLASSES.includes(r.cls));
  if (s.churn === null) unmeasured.push('churn');
  const hot = hotFiles(churn);
  const perPr = new Map<number, number>(); for (const r of churn) perPr.set(r.pr, (perPr.get(r.pr) ?? 0) + 1);
  const repeat = [...perPr].filter(([, n]) => n >= CHURN_PR_REPEAT).map(([pr]) => pr);
  if (churn.length >= CHURN_TOTAL_MIN && (hot.length > 0 || repeat.length > 0))
    add('hot-file-churn', `${churn.length} churn refusals in 2 h · ${hot.length ? `hot ${hot.slice(0, 3).map(h => `${h.file.split('/').pop()}×${h.prs.length}`).join(' · ')}` : 'no shared file'}${repeat.length ? ` · refused ≥${CHURN_PR_REPEAT}×: ${ids(repeat)}` : ''}`);
  const rawCeiling = land && land.slots !== null && Number.isFinite(land.slots) && land.slots > 0 && land.avgTickMin !== null && Number.isFinite(land.avgTickMin) && land.avgTickMin > 0
    ? land.slots * 60 / land.avgTickMin : null;
  const ceiling = rawCeiling === null ? null : Math.round(rawCeiling * 10) / 10;
  if (land && land.slots !== null && land.readyToLand !== null && s.landsLastHour !== null && s.landsLastHour < T.landsPerH
      && rawCeiling !== null && rawCeiling < T.landsPerH && land.readyToLand > land.slots)
    add('land-slots', `slots ${land.slots} · ${land.readyToLand} ready waiting · a tick every ${land.avgTickMin} min → ceiling ${rawCeiling}/h < ${T.landsPerH}`);
  const blind = (s.receipts ?? []).filter(r => r.tscExit === null || !TSC_OWN_EXITS.includes(r.tscExit));
  if (s.receipts === null) unmeasured.push('receipts');
  if (blind.length) add('pregate-blind', `${blind.length} receipts with a tsc exit outside 0/1/2 (OOM/kill = no verdict): ${blind.slice(0, 4).map(r => `#${r.pr}@${r.host} exit ${r.tscExit ?? 'none'}`).join(' · ')}`);
  const waiting = s.awaitingPregate ?? [];
  if (s.awaitingPregate === null) unmeasured.push('awaiting-pregate');
  const waitMed = median(waiting.map(w => w.sinceMin));
  if (waiting.length >= PREGATE_WAIT_N && waitMed !== null && waitMed >= PREGATE_WAIT_MIN)
    add('pregate-wait', `${waiting.length} PRs wait for a same-head receipt · median ${Math.round(waitMed)} min (${ids(waiting.map(w => w.pr))})`);
  const frozen = s.frozen ?? [];
  if (s.frozen === null) unmeasured.push('frozen');
  if (frozen.length >= FROZEN_HANDS_MIN)
    add('hands-frozen', `${frozen.length} hands behind an open ✋ ≥${FROZEN_MIN} min: ${frozen.slice(0, 4).map(f => `${f.seat}→${f.to} ${f.ageMin}m`).join(' · ')}`);
  const pipeline = land?.readyToLand !== null && land?.readyToLand !== undefined && s.awaitingPregate !== null ? land.readyToLand + waiting.length : null;
  const free = s.hands?.free.length ?? null;
  if (pipeline !== null && pipeline < T.landsPerH && s.landsLastHour !== null && s.landsLastHour < T.landsPerH
      && (free === null || free > 0 || (s.readyCells !== null && s.readyCells < READY_PER_IDLE_HAND * Math.max(1, free))))
    add('ready-drought', `pipeline ${pipeline} PRs (ready ${land?.readyToLand} · awaiting pregate ${waiting.length}) < ${T.landsPerH}/h · free hands ${free ?? '?'} · ready cells ${s.readyCells ?? '?'} (want ≥ ${READY_PER_IDLE_HAND}× free hands)`);

  // Which target misses by more (relative)? Unmeasured counts as no gap — «?» is never a reason to act.
  const gap = (v: number | null, t: number) => v === null || t <= 0 ? 0 : Math.max(0, (t - v) / t);
  const landGap = gap(s.landsLastHour, T.landsPerH); const greenGap = gap(s.greensLastHour, T.greensPerH);
  const chain: 'green' | 'land' = greenGap > landGap ? 'green' : 'land';
  const LAND_ORDER: ConstraintKind[] = ['land-dead', 'hot-file-churn', 'land-slots', 'pregate-blind', 'pregate-wait', 'hands-frozen', 'ready-drought'];
  const order: ConstraintKind[] = chain === 'green' ? ['green-judge', 'green-linkage', ...LAND_ORDER] : [...LAND_ORDER, 'green-judge', 'green-linkage'];
  const binding = landGap === 0 && greenGap === 0 && !active.some(a => a.kind === 'land-dead')
    ? { kind: 'on-target' as const, signal: `lands ${s.landsLastHour ?? '?'}/${T.landsPerH} · greens ${s.greensLastHour ?? '?'}/${T.greensPerH}` }
    : order.map(k => active.find(a => a.kind === k)).find((a): a is Constraint => !!a)
      ?? { kind: 'on-target' as const, signal: `below target (lands ${s.landsLastHour ?? '?'} · greens ${s.greensLastHour ?? '?'}) but no constraint signal fired — measure by hand (FEATURE-SHIP-ACCELERATION §1d)` };

  const safety: LeverAction[] = blind.map(r => {
    const other = s.pregateHosts.find(h => h !== r.host) ?? r.host;
    return { key: `tsc-rerun:${r.pr}:${r.head.slice(0, 12)}`, do: 'tsc-rerun', to: [...new Set([r.author ?? 'OP', 'RES'])],
      body: `[처리량 · tsc-blind] #${r.pr} @${r.head.slice(0, 12)} receipt on ${r.host}: tsc exit ${r.tscExit ?? 'none'} — no type verdict (OOM/kill). Re-run: pregate.py ${r.pr} --light --host ${other} (tsc heap 14GB). An empty tsc output or an exit outside 0/1/2 is a failure, never «clean».` };
  });
  const lever = leverFor(binding, s, { hot, waiting, judgeReady, nowMs, ceiling });
  return { at: s.now, measured: { lands: s.landsLastHour, greens: s.greensLastHour, targets: T, ceilingLandsPerH: ceiling, pipeline, ...(s.staleExcluded ? { staleExcluded: s.staleExcluded.length } : {}) }, chain, active, binding, lever, safety, throughputCards: s.throughputCards, hotFiles: hot, unmeasured: [...new Set(unmeasured)] };
}

function leverFor(b: Constraint, s: ThroughputSnapshot, x: { hot: { file: string; prs: number[] }[]; waiting: readonly { pr: number; sinceMin: number }[]; judgeReady: readonly { cell: string; prs: readonly number[] }[]; nowMs: number; ceiling: number | null }): Lever {
  const row = LEVERS[b.kind]; const v = s.version ?? '<version>';
  const base = { id: row.id, actor: row.actor, owner: row.owner };
  switch (b.kind) {
    case 'green-judge': {
      const list = x.judgeReady.slice(0, 10);
      return { ...base, what: `JUD signs ${list.length} green-triage (a) cells now`, commands: [`eln release checklist green-triage --version ${v}`, ...list.slice(0, 3).map(j => `eln release checklist evidence ${j.cell} --version ${v}   # then sign green (JUD)`)],
        doneWhen: `greens next hour ≥ ${Math.min(s.targets.greensPerH, list.length)}`,
        actions: [{ key: `jud-green-batch:${list.map(j => j.cell).join(',')}`, do: 'jud-green-batch', to: ['JUD'],
          body: `[처리량 · 초록 묶음] ${v}: ${list.length} cells are merged with a same-head receipt (green-triage a) — sign them green now (same-head receipt ⊕ focused exit 0 ⊕ sim/test-universe evidence = green; veto only with a file:line): ${list.map(j => `${j.cell}(${j.prs.map(p => `#${p}`).join(',')})`).join(' · ')}` }] };
    }
    case 'green-linkage':
      return { ...base, what: 'link the landed PRs to their cells (evidence add) and require «칸 닫음: <ID>» in PR bodies', commands: [`eln release checklist landed-but-yellow --version ${v}`, `eln release checklist evidence add <ID> 'PR #<N>' --version ${v}`],
        doneWhen: `lands without a cell ≤ half of the next hour's lands`, actions: [] };
    case 'land-dead':
      return { ...base, what: 'land graph is not landing — one tick + alarm (planner rule (d)); if every PR is refused with one class, fix the tool, not the PRs', commands: ['eln land graph tick --json', 'eln land graph status'],
        doneWhen: 'the tick lands ≥ 1 PR, or its refusal classes name who fixes what', actions: [] };
    case 'hot-file-churn': {
      const lane = new Set(x.hot.map(h => h.file));
      const targets = (s.openPrs ?? []).filter(p => !p.draft && p.files.some(f => lane.has(f)));
      return { ...base, what: `hot lane(s) ${x.hot.slice(0, 3).map(h => h.file).join(' · ') || '(repeat refusals)'}: every open PR in the lane merges origin/main now, then light pregate; one writer lane per hot file`,
        commands: ['git fetch origin && git merge origin/main   # in the PR worktree, then:', 'pregate.py <PR> --light --host minim5', '(new PRs on a hot file: wait for the lane — one open writer per hot file)'],
        doneWhen: 'no PR refused twice for churn in the next hour', actions: targets.map(p => ({ key: `merge-main:${p.pr}:${p.head.slice(0, 12)}`, do: 'merge-main-request' as const, to: [p.author || 'OP'],
          body: `[처리량 · 핫 파일 레인] #${p.pr} @${p.head.slice(0, 12)} shares ${p.files.filter(f => lane.has(f)).slice(0, 3).join(', ')} with PRs that keep bouncing (merge conflict / stale base). Merge origin/main into it NOW, then pregate.py ${p.pr} --light — the land graph lands churn victims first. Do not open another PR on these files until this one lands.` })) };
    }
    case 'land-slots': {
      const nextSlots = Math.floor(s.land!.slots!) + 1;
      return { ...base, what: `consider raising land.graph.slots ${s.land!.slots} → ${nextSlots} (estimated ceiling ${x.ceiling ?? '?'}/h; target ${s.targets.landsPerH}/h); same-file PRs still land one per tick`, commands: [`eln config set land.graph.slots ${nextSlots}`],
        doneWhen: `lands/h ≥ ${s.targets.landsPerH}`, actions: [] };
    }
    case 'pregate-blind':
      return { ...base, what: 're-run the tsc-blind receipts on another host (safety cards sent)', commands: ['pregate.py <PR> --light --host <other host>'], doneWhen: 'every receipt of the hour has a tsc exit in 0/1/2', actions: [] };
    case 'pregate-wait': {
      const host = freestHost(s.pregateHosts, s.receipts ?? [], x.nowMs) ?? 'minim5';
      const heads = new Map((s.openPrs ?? []).map(p => [p.pr, p] as const));
      return { ...base, what: `route waiting pregates to ${host} (least used in 30 min)`, commands: [`pregate.py <PR> --light --host ${host}`],
        doneWhen: `median wait for a same-head receipt < ${PREGATE_WAIT_MIN} min`,
        actions: x.waiting.flatMap(w => { const p = heads.get(w.pr); return p ? [{ key: `pregate-route:${p.pr}:${p.head.slice(0, 12)}`, do: 'pregate-route' as const, to: [p.author || 'OP'],
          body: `[처리량 · pregate] #${p.pr} @${p.head.slice(0, 12)} has waited ${Math.round(w.sinceMin)} min for a same-head receipt — run: pregate.py ${p.pr} --light --host ${host} (least-used local host now).` }] : []; }) };
    }
    case 'hands-frozen':
      return { ...base, what: 'unfreeze the hands: answer each ✋ (resolve/reject) — a ban must name cells and an expiry', commands: (s.frozen ?? []).slice(0, 3).map(f => `eln msg hand ${f.msgId} resolve '<decision · which cells · until when>'`),
        doneWhen: 'frozen hands < 2 at the next checkpoint', actions: [] };
    case 'ready-drought':
      return { ...base, what: `supply: ≥ ${s.targets.landsPerH} PRs in the pipeline — harvest PASS drafts to ready, split the top P0 into ≤45-min cells`, commands: ['gh pr list --draft --limit 200 --json number,headRefOid   # drafts with a same-head PASS receipt → gh pr ready', `eln release checklist green-triage --version ${v}   # (c) supply rows`],
        doneWhen: `pipeline ≥ ${s.targets.landsPerH} and ready cells ≥ ${READY_PER_IDLE_HAND}× free hands`, actions: [] };
    case 'on-target':
      return { ...base, what: 'no lever — keep the rhythm', commands: [], doneWhen: '-', actions: [] };
  }
}

// ── execute ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ThroughputActuators {
  /** Post one card (msg store) and return its id. */
  card(to: string, body: string): Promise<string> | string;
  /** Keys sent in the last 6 h (dedupe — one card per PR head per kind). */
  sentKeys(): ReadonlySet<string>;
  /** Keys sent before the six-hour window. */
  staleKeys?(): ReadonlySet<string>;
  record(row: Record<string, unknown>): void;
}

export interface ThroughputDid { readonly key: string; readonly status: 'did' | 'would' | 'skip' | 'failed'; readonly evidence: string }

/** Send the lever's machine actions and the safety cards (live only); shadow/manual → «would» lines. */
export async function executeThroughput(v: ThroughputVerdict, act: ThroughputActuators | null, stage: string): Promise<ThroughputDid[]> {
  const out: ThroughputDid[] = [];
  const all = [...v.safety, ...(v.lever.actor === 'machine' ? v.lever.actions : [])];
  const cap = Number.isSafeInteger(v.throughputCards) && v.throughputCards! >= 0 ? v.throughputCards! : 0;
  let remaining = cap;
  const sent = act?.sentKeys() ?? new Set<string>();
  const stale = act?.staleKeys?.() ?? new Set<string>();
  for (const a of all) {
    if (sent.has(a.key)) { out.push({ key: a.key, status: 'skip', evidence: 'sent in the last 6 h' }); continue; }
    if (stage === 'live' && act && stale.has(a.key)) {
      act.record({ key: a.key, outcome: 'no-effect-skip' });
      out.push({ key: a.key, status: 'skip', evidence: 'no effect after 6 h' });
      continue;
    }
    if (a.to.length > remaining) { out.push({ key: a.key, status: 'skip', evidence: v.throughputCards == null ? 'steward throughputCards unmeasured' : 'steward throughputCards exhausted' }); continue; }
    remaining -= a.to.length;
    if (stage !== 'live' || !act) { out.push({ key: a.key, status: 'would', evidence: `${a.do} → ${a.to.join(',')}` }); continue; }
    try {
      const mails: string[] = [];
      for (const to of a.to) mails.push(String(await act.card(to, a.body)));
      act.record({ at: v.at, key: a.key, do: a.do, to: a.to, mail: mails });
      out.push({ key: a.key, status: 'did', evidence: `${a.do} → ${a.to.join(',')} (mail ${mails.join(",")})` });
    } catch (e) { out.push({ key: a.key, status: 'failed', evidence: (e instanceof Error ? e.message : String(e)).slice(0, 160) }); }
  }
  return out;
}

/** The board line (THROUGHPUT-NOW.md first line) — one line, both numbers, the binding constraint, the lever. */
export function boardLine(v: ThroughputVerdict): string {
  const n = (x: number | null) => x === null ? '?' : String(x);
  return `${v.at.slice(11, 16)}Z 착지 ${n(v.measured.lands)}/${v.measured.targets.landsPerH} · 초록 ${n(v.measured.greens)}/${v.measured.targets.greensPerH} · 묶는 병목 ${v.binding.kind} → ${v.lever.id} (${v.lever.actor === 'machine' ? '기계' : 'OP'})`;
}

/** The «처리량 제어» block (pulse table · `eln pulse next` · `eln pulse throughput`). */
export function renderThroughputBlock(v: ThroughputVerdict, did: readonly ThroughputDid[] = []): string {
  const lines = ['## 처리량 제어 (throughput controller)', boardLine(v),
    `측정: 착지 ${v.measured.lands ?? '?'}/h · 초록 ${v.measured.greens ?? '?'}/h · 착지 천장 ${v.measured.ceilingLandsPerH ?? '?'}/h · 파이프라인 ${v.measured.pipeline ?? '?'} PR${v.measured.staleExcluded ? ` (신선 PR 만 · 좀비 ${v.measured.staleExcluded} 제외)` : ''} · 따라간 사슬 ${v.chain}`,
    `묶는 병목: ${v.binding.kind} — ${v.binding.signal}`];
  const others = v.active.filter(a => a.kind !== v.binding.kind);
  if (others.length) lines.push(`함께 켜진 신호: ${others.map(a => a.kind).join(' · ')}`);
  if (v.binding.kind !== 'on-target') {
    lines.push(`${v.lever.actor === 'op' ? 'OP NEXT ACTION' : '기계 지렛대'} ${v.lever.id} (${v.lever.owner}): ${v.lever.what}`, ...v.lever.commands.map(c => `  $ ${c}`), `  done when: ${v.lever.doneWhen}`);
  }
  for (const d of did) lines.push(`${d.status} ${d.key} (${d.evidence})`);
  if (v.hotFiles.length) lines.push(`핫 파일: ${v.hotFiles.slice(0, 5).map(h => `${h.file} ${h.prs.map(p => `#${p}`).join(',')}`).join(' · ')}`);
  if (v.unmeasured.length) lines.push(`unmeasured: ${v.unmeasured.join(', ')}`);
  return lines.join('\n');
}
