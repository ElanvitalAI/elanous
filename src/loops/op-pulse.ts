// OP-PULSE — the structural hourly pulse that replaces OP's pinned standing goal («씨앗 두 문서» · CEO 11-25 20:0x).
//
// S: OP carried a pinned standing goal (FEATURE-SHIP-ACCELERATION + JUDGE-LOAD-REDUCTION). Every OP turn was «in
//    progress» against it: retros/bulletins lost to it, continuation hit the same gap → BLOCKED cards to the CEO,
//    loop-escape labels quoted it.
// C: we want the effect (targets watched, levers pulled, leaders given a beat) without a goal that never closes.
// Q: how does OP get pulled exactly when a target is missed, in the rhythm the current phase needs?
// A: a trigger-registry graph (graphs/triggers/op-pulse.yaml) with three steps, all here and pure (I/O injected):
//    ① phase  — detectPhase(): release schedule + clock + burst state → build · pre-cut · release-window ·
//               post-release · demo-freeze · night · burst (thresholds from the rhythm yaml, defaults in code)
//    ② rhythm — the phase row of graphs/triggers/op-pulse.rhythm.yaml (cadence · targets · levers · beat template),
//               derived from the seed docs' «국면별 리듬» sections; OP may propose edits as a PR, never live
//    ③ measure → gaps — no LLM: per space landed/h · green/h · idle-with-work hands · ready cells · blocked cells,
//               federation judge-wait median and budget headroom → pulseGaps() against the phase targets.
//    Fire = ONE internal OP turn (origin `pulse`, through the pulse inbox file the OP TUI consumes — not a self-mail,
//    not a wake, so the wake cap never coalesces it) only when there is a gap or the phase changed. All green = a
//    one-line heartbeat in the pulse file, no turn.
//
// 세 얼굴:
//   관측 = seat-state/OP/pulse/PULSE-<date>.md (one table per pulse) · {stateRoot}/loops/op-pulse.jsonl (one line per
//          pulse: phase · gaps · outcome · goal) · debug 'loops.op-pulse'
//   판단 근거 = pulseGaps() rows (metric · space · value · target) against the phase row; phase evidence line
//   수복과 인계 = gap → one OP turn whose contract is «one beat mail per affected leader within 20 min»; `eln pulse
//          verify` checks the msg store and writes the goal line; a missed goal → registry retry → exception card
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type PulsePhase = 'build' | 'pre-cut' | 'release-window' | 'post-release' | 'demo-freeze' | 'night' | 'burst';
export const PULSE_PHASES: readonly PulsePhase[] = ['build', 'pre-cut', 'release-window', 'post-release', 'demo-freeze', 'night', 'burst'];

export type PulseLever = 'reprioritize' | 'lend-hands' | 'judge-relief' | 'vm-ask' | 'burst-propose' | 'defect-only' | 'status-only';
export const PULSE_LEVERS: readonly PulseLever[] = ['reprioritize', 'lend-hands', 'judge-relief', 'vm-ask', 'burst-propose', 'defect-only', 'status-only'];

export interface PulseTargets {
  /** Federation landed PRs per hour (FEATURE-SHIP-ACCELERATION §1a). null = not a target in this phase. */
  landedPerH: number | null;
  greenPerH: number | null;
  /** Judge queue median wait, minutes (JUDGE-LOAD-REDUCTION §지표). */
  judgeWaitMedianMin: number | null;
  /** A space's idle hands that could pull work — more than this is a gap. */
  idleWithWorkMax: number | null;
  /** Ready cells per hand in a space — fewer than this × hands is a gap (the board runs dry). */
  readyPerHand: number | null;
}

export interface RhythmRow {
  phase: PulsePhase;
  cadenceMin: number;
  targets: PulseTargets;
  levers: PulseLever[];
  newWork: boolean;
  beat: string;
  /** Seed-doc section this row comes from (doc#anchor). */
  source: string;
}

export interface PhaseDetection {
  preCutHours: number;
  releaseAfterPublishMin: number;
  postReleaseHours: number;
  /** Local hours [from, to) of the low-traffic night window (to < from wraps midnight). */
  night: { from: number; to: number } | null;
  freezes: Array<{ from: string; to: string; label: string }>;
}

export interface Rhythm { detection: PhaseDetection; rows: Map<PulsePhase, RhythmRow> }

/** Code defaults (used when the yaml omits a field). Source: FEATURE-SHIP-ACCELERATION §1a · JUDGE-LOAD-REDUCTION §지표. */
export const DEFAULT_DETECTION: PhaseDetection = { preCutHours: 4, releaseAfterPublishMin: 30, postReleaseHours: 2, night: { from: 1, to: 6 }, freezes: [] };
// JUD-RELAX (CEO 11-26): no judge-wait target — JUD keeps the veto only, so a merged+receipt cell is not a JUD wait.
export const DEFAULT_TARGETS: PulseTargets = { landedPerH: 20, greenPerH: 10, judgeWaitMedianMin: null, idleWithWorkMax: 3, readyPerHand: 2 };

const num = (v: unknown, at: string): number | null => {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${at} must be a non-negative number or null`);
  return v;
};

/** Parse the rhythm yaml text. Refuses unknown phases/levers and rows without cadence/beat/source (a bad edit fails loud). */
export function parseRhythm(text: string): Rhythm {
  const raw = parseYaml(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new Error('rhythm: not a yaml mapping');
  const d = (raw.detection ?? {}) as Record<string, unknown>;
  const nightRaw = d.night as { from?: unknown; to?: unknown } | null | undefined;
  const detection: PhaseDetection = {
    preCutHours: d.pre_cut_hours === undefined ? DEFAULT_DETECTION.preCutHours : num(d.pre_cut_hours, 'detection.pre_cut_hours') ?? 0,
    releaseAfterPublishMin: d.release_after_publish_min === undefined ? DEFAULT_DETECTION.releaseAfterPublishMin : num(d.release_after_publish_min, 'detection.release_after_publish_min') ?? 0,
    postReleaseHours: d.post_release_hours === undefined ? DEFAULT_DETECTION.postReleaseHours : num(d.post_release_hours, 'detection.post_release_hours') ?? 0,
    night: nightRaw === null ? null : nightRaw === undefined ? DEFAULT_DETECTION.night
      : { from: num(nightRaw.from, 'detection.night.from') ?? 0, to: num(nightRaw.to, 'detection.night.to') ?? 0 },
    freezes: (Array.isArray(d.freezes) ? d.freezes : []).map((f, i) => {
      const r = f as Record<string, unknown>;
      if (typeof r.from !== 'string' || Number.isNaN(Date.parse(r.from)) || typeof r.to !== 'string' || Number.isNaN(Date.parse(r.to)))
        throw new Error(`detection.freezes[${i}] needs ISO from/to`);
      return { from: r.from, to: r.to, label: typeof r.label === 'string' ? r.label : 'freeze' };
    }),
  };
  if (!Array.isArray(raw.phases)) throw new Error('rhythm: phases must be a list');
  const rows = new Map<PulsePhase, RhythmRow>();
  raw.phases.forEach((p, i) => {
    const r = p as Record<string, unknown>;
    const at = `phases[${i}]`;
    if (!PULSE_PHASES.includes(r.phase as PulsePhase)) throw new Error(`${at}.phase ${String(r.phase)} is not a known phase`);
    const cadence = num(r.cadence_min, `${at}.cadence_min`);
    if (!cadence) throw new Error(`${at}.cadence_min must be > 0`);
    const t = (r.targets ?? {}) as Record<string, unknown>;
    const target = (k: string, def: number | null) => t[k] === undefined ? def : num(t[k], `${at}.targets.${k}`);
    const levers = Array.isArray(r.levers) ? r.levers : [];
    for (const l of levers) if (!PULSE_LEVERS.includes(l as PulseLever)) throw new Error(`${at}.levers: ${String(l)} is not a known lever`);
    if (typeof r.beat !== 'string' || !r.beat.trim()) throw new Error(`${at}.beat must be a non-empty template`);
    if (typeof r.source !== 'string' || !r.source.includes('#')) throw new Error(`${at}.source must cite a seed-doc section (doc#anchor)`);
    rows.set(r.phase as PulsePhase, {
      phase: r.phase as PulsePhase, cadenceMin: cadence,
      targets: { landedPerH: target('landed_per_h', DEFAULT_TARGETS.landedPerH), greenPerH: target('green_per_h', DEFAULT_TARGETS.greenPerH),
        judgeWaitMedianMin: target('judge_wait_median_min', DEFAULT_TARGETS.judgeWaitMedianMin), idleWithWorkMax: target('idle_with_work_max', DEFAULT_TARGETS.idleWithWorkMax),
        readyPerHand: target('ready_per_hand', DEFAULT_TARGETS.readyPerHand) },
      levers: levers as PulseLever[], newWork: r.new_work !== false, beat: r.beat.trim(), source: r.source,
    });
  });
  if (!rows.has('build')) throw new Error('rhythm: the build phase row is required (the fallback phase)');
  return { detection, rows };
}

export function loadRhythm(path: string): Rhythm { return parseRhythm(readFileSync(path, 'utf8')); }

/** The row for a phase; a phase missing from the yaml falls back to build (never throws at fire time). */
export function rhythmRow(rhythm: Rhythm, phase: PulsePhase): RhythmRow { return rhythm.rows.get(phase) ?? rhythm.rows.get('build')!; }

// ── ① phase ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PhaseInput {
  now: Date;
  schedules: ReadonlyArray<{ version: string; cutAt?: string | null; publishAt?: string | null }>;
  /** An active burst (eln pulse burst start) — the OP/CEO declared phase. */
  burstActive: boolean;
  /** Local hour of `now` (injected so tests do not depend on the host time zone). */
  localHour: number;
}

export interface PhaseResult { phase: PulsePhase; evidence: string }

/** Precedence: burst (declared) > demo-freeze > release-window > pre-cut > post-release > night > build. */
export function detectPhase(input: PhaseInput, detection: PhaseDetection): PhaseResult {
  const t = input.now.getTime();
  if (input.burstActive) return { phase: 'burst', evidence: 'burst declared (eln pulse burst status)' };
  const freeze = detection.freezes.find(f => t >= Date.parse(f.from) && t < Date.parse(f.to));
  if (freeze) return { phase: 'demo-freeze', evidence: `freeze «${freeze.label}» ${freeze.from} → ${freeze.to}` };
  const h = 3_600_000;
  for (const s of input.schedules) {
    const cut = s.cutAt ? Date.parse(s.cutAt) : NaN; const pub = s.publishAt ? Date.parse(s.publishAt) : NaN;
    if (Number.isFinite(cut) && Number.isFinite(pub) && t >= cut && t < pub + detection.releaseAfterPublishMin * 60_000)
      return { phase: 'release-window', evidence: `${s.version} cut ${s.cutAt} → publish ${s.publishAt} +${detection.releaseAfterPublishMin}m` };
  }
  for (const s of input.schedules) {
    const cut = s.cutAt ? Date.parse(s.cutAt) : NaN;
    if (Number.isFinite(cut) && t >= cut - detection.preCutHours * h && t < cut)
      return { phase: 'pre-cut', evidence: `${s.version} cut ${s.cutAt} in ${Math.ceil((cut - t) / 60_000)}m (T−${detection.preCutHours}h window)` };
  }
  for (const s of input.schedules) {
    const pub = s.publishAt ? Date.parse(s.publishAt) : NaN;
    const from = pub + detection.releaseAfterPublishMin * 60_000;
    if (Number.isFinite(pub) && t >= from && t < from + detection.postReleaseHours * h)
      return { phase: 'post-release', evidence: `${s.version} published ${s.publishAt} · migration window ${detection.postReleaseHours}h` };
  }
  const n = detection.night;
  if (n && (n.from <= n.to ? input.localHour >= n.from && input.localHour < n.to : input.localHour >= n.from || input.localHour < n.to))
    return { phase: 'night', evidence: `local hour ${input.localHour} in night ${n.from}–${n.to}` };
  return { phase: 'build', evidence: 'no release/freeze window — normal build' };
}

// ── ③ measure → gaps ────────────────────────────────────────────────────────────────────────────────────────────────

export interface SpaceMeasure {
  space: string;
  landedPerH: number | null;
  greenPerH: number | null;
  hands: number | null;
  idleWithWork: number | null;
  readyCells: number | null;
  blockedCells: number | null;
}

export interface PulseMeasure {
  at: string;
  version: string | null;
  landedPerH: number | null;
  greenPerH: number | null;
  judgeQueue: number | null;
  judgeWaitMedianMin: number | null;
  budget: string[];
  spaces: SpaceMeasure[];
  /** Probes that could not measure (never read as zero). */
  unmeasured: string[];
  /** WORLD-REGISTRY one-liner (세계: live · zombie · unregistered · no-owner) — absent/null = unread. */
  world?: string | null;
}

export interface PulseGap { metric: 'landed/h' | 'green/h' | 'judge-wait' | 'idle-with-work' | 'ready-cells'; space: string; value: number; target: string }

/** Gaps against the phase targets. An unmeasured value is never a gap (and never green either — it shows as «?»). */
export function pulseGaps(m: PulseMeasure, targets: PulseTargets): PulseGap[] {
  const gaps: PulseGap[] = [];
  if (targets.landedPerH !== null && m.landedPerH !== null && m.landedPerH < targets.landedPerH)
    gaps.push({ metric: 'landed/h', space: 'FED', value: m.landedPerH, target: `≥ ${targets.landedPerH}` });
  if (targets.greenPerH !== null && m.greenPerH !== null && m.greenPerH < targets.greenPerH)
    gaps.push({ metric: 'green/h', space: 'FED', value: m.greenPerH, target: `≥ ${targets.greenPerH}` });
  if (targets.judgeWaitMedianMin !== null && m.judgeWaitMedianMin !== null && m.judgeWaitMedianMin > targets.judgeWaitMedianMin)
    gaps.push({ metric: 'judge-wait', space: 'JUD', value: m.judgeWaitMedianMin, target: `≤ ${targets.judgeWaitMedianMin}m` });
  for (const s of m.spaces) {
    if (targets.idleWithWorkMax !== null && s.idleWithWork !== null && s.idleWithWork > targets.idleWithWorkMax)
      gaps.push({ metric: 'idle-with-work', space: s.space, value: s.idleWithWork, target: `≤ ${targets.idleWithWorkMax}` });
    if (targets.readyPerHand !== null && s.readyCells !== null && s.hands !== null && s.hands > 0 && s.readyCells < targets.readyPerHand * s.hands)
      gaps.push({ metric: 'ready-cells', space: s.space, value: s.readyCells, target: `≥ ${targets.readyPerHand}×${s.hands} hands = ${targets.readyPerHand * s.hands}` });
  }
  return gaps;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const cell = (v: number | null): string => v === null ? '?' : String(Math.round(v * 10) / 10);

export function rhythmLine(row: RhythmRow): string {
  const t = row.targets;
  const targets = [t.landedPerH !== null ? `착지 ${t.landedPerH}/h` : null, t.greenPerH !== null ? `초록 ${t.greenPerH}/h` : null,
    t.judgeWaitMedianMin !== null ? `판정 대기 ≤${t.judgeWaitMedianMin}m` : null].filter(Boolean).join(' · ') || '수치 목표 없음';
  return `${row.cadenceMin}분 · ${targets} · 손잡이 ${row.levers.join(', ') || '없음'}${row.newWork ? '' : ' · 새 일 0'}`;
}

/** The pulse table (markdown) — one block per pulse in PULSE-<date>.md. */
export function renderPulseTable(m: PulseMeasure, phase: PhaseResult, row: RhythmRow, gaps: readonly PulseGap[]): string {
  const gapKey = new Set(gaps.map(g => `${g.space}:${g.metric}`));
  const mark = (space: string, metric: PulseGap['metric'], v: number | null) => `${cell(v)}${gapKey.has(`${space}:${metric}`) ? ' ❗' : ''}`;
  const lines = [
    `## ${m.at} · 국면 ${phase.phase} · ${gaps.length ? `격차 ${gaps.length}` : '전부 초록'}`,
    `국면 근거: ${phase.evidence}`,
    `리듬: ${rhythmLine(row)} (출처 ${row.source})`,
    `연방: 착지 ${mark('FED', 'landed/h', m.landedPerH)}/h · 초록 ${mark('FED', 'green/h', m.greenPerH)}/h · 판정 대기 ${cell(m.judgeQueue)}건 중앙값 ${mark('JUD', 'judge-wait', m.judgeWaitMedianMin)}m`,
    '',
    '| 스페이스 | 착지/h | 초록/h | 손 | 유휴(일 있음) | 준비 칸 | 막힌 칸 |',
    '|---|---|---|---|---|---|---|',
    ...m.spaces.map(s => `| ${s.space} | ${cell(s.landedPerH)} | ${cell(s.greenPerH)} | ${cell(s.hands)} | ${mark(s.space, 'idle-with-work', s.idleWithWork)} | ${mark(s.space, 'ready-cells', s.readyCells)} | ${cell(s.blockedCells)} |`),
    '',
    `예산 여유: ${m.budget.length ? m.budget.join(' · ') : '?'}`,
    ...(m.world !== undefined ? [m.world ?? '세계: ? (lease ledger unread)'] : []),
    ...(m.unmeasured.length ? [`못 잰 것: ${m.unmeasured.join(', ')}`] : []),
  ];
  return `${lines.join('\n')}\n`;
}

export const LEVER_MENU: Record<PulseLever, string> = {
  reprioritize: '우선순위 재정렬 — `eln work priority <칸…>` (풀 P0 순서)',
  'lend-hands': '손 빌려주기 — 유휴 손이 많은 스페이스 → 준비 칸이 쌓인 스페이스 (`eln seat pool` 보고 리더에게 비트)',
  'judge-relief': '판정 숨통 — 기능 판정 하나·델타만·DIRECT-T1·열차 묶음·판정 손 빌리기 (JUDGE-LOAD-REDUCTION §5·§6)',
  'vm-ask': 'VM 요청 — 계산이 병목일 때만 CEO 카드 1장 (`eln decisions raise` · 돈)',
  'burst-propose': '버스트 제안 — 격차가 크고 기한이 가깝다면 `eln pulse burst plan` 결과를 붙여 제안(자동 시작 금지 · OP 결정)',
  'defect-only': '결함 수리만 — 새 기능 칸 금지, 데모/발행 결함만 배정',
  'status-only': '상태만 — 새 일 0, 리더에게 현황 한 줄만',
};

/** The one OP turn's brief: phase + rhythm first, then the gap table, levers and the contract. */
export function renderPulseBrief(input: { window: string; phase: PhaseResult; row: RhythmRow; gaps: readonly PulseGap[]; table: string; phaseChanged: string | null; tablePath: string;
  /** OP-WORLD-LENS — the world card (world-lens.ts renderLensLines): OP reads these numbers instead of assembling them. */
  world?: readonly string[] | null }): string {
  const { row } = input;
  const leaders = [...new Set(input.gaps.map(g => g.space === 'FED' ? 'TC' : g.space))].sort();
  return [
    `[pulse ${input.window}] 국면: ${input.phase.phase} · 리듬: ${rhythmLine(row)}`,
    ...(input.phaseChanged ? [`국면 전환: ${input.phaseChanged} — 모든 리더에게 새 비트를 보낸다.`] : []),
    ...(input.world && input.world.length ? ['', ...input.world, '(숫자는 이 카드에서 인용한다 — 손으로 다시 모으지 않는다 · 의심되면 줄 끝 [src] 명령을 다시 돌린다)'] : []),
    '',
    `격차표 (전문 ${input.tablePath}):`,
    ...input.gaps.map(g => `- ${g.space} · ${g.metric} = ${g.value} (목표 ${g.target})`),
    ...(input.gaps.length ? [] : ['- 수치 격차 없음 (국면 전환 비트만)']),
    '',
    '손잡이 (이 국면에 허용된 것만):',
    ...row.levers.map(l => `- ${LEVER_MENU[l]}`),
    '',
    `비트 양식: ${row.beat}`,
    '',
    '계약: 출력 = 영향받은 리더마다 비트 우편 1통(무엇을 · 언제까지 · 수치) — `eln msg post --from OP --to <리더> --kind beat --body "[pulse ' + input.window + '] …"`.',
    `   대상 리더: ${input.phaseChanged ? '모든 스페이스 리더' : leaders.join(', ') || '없음'} · CEO 카드는 돈/VM 일 때만 최대 1장.`,
    `   20분 안에 \`eln pulse verify --window ${input.window}\` 로 비트 우편을 확인한다(목표 줄). 씨앗 문서는 참조만 — 상시 골로 고정하지 않는다.`,
    `   리듬 표를 바꾸고 싶으면 칸/PR 로 제안한다(graphs/triggers/op-pulse.rhythm.yaml · 라이브 수정 금지).`,
  ].join('\n');
}

// ── state · inbox · ledger ──────────────────────────────────────────────────────────────────────────────────────────

export interface PulseState { lastPulseAt: string | null; lastPhase: PulsePhase | null }

export function readPulseState(path: string): PulseState {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PulseState>;
    return { lastPulseAt: typeof raw.lastPulseAt === 'string' ? raw.lastPulseAt : null,
      lastPhase: PULSE_PHASES.includes(raw.lastPhase as PulsePhase) ? raw.lastPhase as PulsePhase : null };
  } catch { return { lastPulseAt: null, lastPhase: null }; }
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function writePulseState(path: string, state: PulseState): void { atomicWrite(path, `${JSON.stringify(state)}\n`); }

/** Is a pulse due now? Phase change → immediately; else when the phase cadence has elapsed since the last pulse. */
export function pulseDue(input: { now: Date; phase: PhaseResult; state: PulseState; row: RhythmRow }): { met: boolean; key: string; evidence: string } {
  const { state, phase, row } = input;
  if (state.lastPhase !== null && state.lastPhase !== phase.phase)
    return { met: true, key: `phase:${state.lastPhase}->${phase.phase}@${state.lastPulseAt ?? 'never'}`, evidence: `phase ${state.lastPhase} → ${phase.phase} (${phase.evidence})` };
  const since = state.lastPulseAt ? input.now.getTime() - Date.parse(state.lastPulseAt) : Infinity;
  const met = since >= row.cadenceMin * 60_000;
  return { met, key: `cadence:${phase.phase}@${state.lastPulseAt ?? 'never'}`,
    evidence: `${phase.phase} cadence ${row.cadenceMin}m · last pulse ${state.lastPulseAt ?? 'never'}${Number.isFinite(since) ? ` (${Math.floor(since / 60_000)}m ago)` : ''}` };
}

export interface PulseInboxRequest { id: string; window: string; body: string; at: string }

/** The pulse inbox: one pending request the OP TUI opens as an origin-`pulse` internal turn. A newer pulse replaces an unread one. */
export function writePulseInbox(path: string, req: PulseInboxRequest): void { atomicWrite(path, `${JSON.stringify(req)}\n`); }

export function readPulseInbox(path: string): PulseInboxRequest | null {
  if (!existsSync(path)) return null;
  try {
    const r = JSON.parse(readFileSync(path, 'utf8')) as Partial<PulseInboxRequest>;
    return typeof r.id === 'string' && typeof r.body === 'string' && typeof r.window === 'string' ? { id: r.id, window: r.window, body: r.body, at: String(r.at ?? '') } : null;
  } catch { return null; }
}

export function appendPulseLedger(path: string, row: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
}

/** Paths (seatState = ~/elanous-hq/seat-state · stateRoot = the universe state dir). */
export const pulsePaths = (seatState: string, stateRoot: string, date: string) => ({
  table: join(seatState, 'OP', 'pulse', `PULSE-${date}.md`),
  state: join(stateRoot, 'loops', 'op-pulse-state.json'),
  inbox: join(seatState, 'OP', 'pulse', 'inbox.json'),
  consumed: join(seatState, 'OP', 'pulse', 'inbox.consumed'),
  ledger: join(stateRoot, 'loops', 'op-pulse.jsonl'),
  nextLedger: join(stateRoot, 'loops', 'op-next-action.jsonl'),
  burst: join(seatState, 'OP', 'pulse', 'burst.json'),
  burstLedger: join(seatState, 'OP', 'pulse', 'burst-receipts.jsonl'),
});

/** Beat mails for a window: OP → leader posts whose body carries `[pulse <window>]`. */
export function beatsForWindow(mails: ReadonlyArray<{ id: number; from: string; to: string; body: string; createdAt?: string }>, window: string): Array<{ id: number; to: string }> {
  const tag = `[pulse ${window}]`;
  return mails.filter(m => m.from.toUpperCase() === 'OP' && m.to.toUpperCase() !== 'OP' && m.body.includes(tag)).map(m => ({ id: m.id, to: m.to.toUpperCase() }));
}
