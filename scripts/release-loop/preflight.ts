// `elanous release preflight` — 컷 30분 전 사전 점검(RELEASE-PREFLIGHT · 10-06).
//
// 🩸 계기(10-06 실측): 0.2.17 릴리스 런이 첫 노드(checklist-gate)에서 멎었다 — «발행 뒤» 칸(POSTPUB-VERIFY)이 그 판에
//    남아 있었고 게이트가 그것을 미완으로 셌다. 컷이 올 때까지 아무도 몰랐다. 새 규칙 = 착지 마감 = 컷 − 30분, 그 30분에 이 점검.
// ⛔ 읽기 전용 — 칸을 옮기지도, 동결을 바꾸지도, push 하지도 않는다. 옮길 것은 «명령»으로 제안만 한다.
// ⛔ 게이트 규칙을 다시 쓰지 않는다 — checklist-gate 노드 · release run 진입 검사 · 예약 시작 준비 검사(releaseReadiness, #24557)가
//    함께 쓰는 단 하나의 판정 cutChecklistGate 를 그대로 부르고, 예약 시작 경로는 releaseReadiness 를 CLI 와 같은 인자로 부른다.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cutChecklistGate, listChecklist, type ChecklistItem } from '../../src/release-loop/checklist.js';
import { getSchedule, formatKst, type ReleaseSchedule } from '../../src/release-loop/release-schedule.js';
import { readLandingFreeze, landingFreezeMessage, type LandingFreeze } from '../../src/release-loop/landing-freeze.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { debug } from '../../src/debug/log.js';
import { releaseReadiness } from './release-readiness.js';
import { latestPublishedPreviousVersion, runUnattendedRelease, type UnattendedReleaseDeps } from './unattended-release.js';

export type PreflightLevel = 'ok' | 'warn' | 'block';
export type PreflightCheck = 'checklist' | 'postpub' | 'run-input' | 'freeze' | 'schedule';
export interface PreflightFinding { level: PreflightLevel; check: PreflightCheck; id?: string; message: string; suggestion?: string }
export interface GateMeasure { version: string; runId: string; gateSeconds: number; toPublishSeconds?: number }
const compareStable = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!; };
export interface PreflightResult {
  version: string;
  next: string;
  verdict: PreflightLevel;
  blockers: number;
  warnings: number;
  findings: PreflightFinding[];
  schedule: { cutAt: string; landBy: string | null; publishAt: string | null; publishAtSource: 'option' | 'cadence' | null } | null;
  /** The immediately previous release (by version order) whose gate is compared. */
  previousVersion: string | null;
  gateMeasure: GateMeasure | null;
  /** When the previous release has no record: the newest measured older release, labelled with its version. */
  fallbackGateMeasure: GateMeasure | null;
}

export interface PreflightDeps {
  now?: Date;
  /** Planned publish time (ISO). Without it, the October cadence (07:00 · 18:00 KST) after the cut is assumed. */
  publishAt?: string;
  runInput?: (version: string) => Promise<{ input: unknown }>;
  freeze?: () => LandingFreeze | null;
  schedule?: (version: string) => ReleaseSchedule | null;
  graphRunsRoot?: string;
  releaseRunDeps?: UnattendedReleaseDeps;
  /** The immediately previous release; default = the run input's previousVersion (release ledger). */
  previousVersion?: string;
}

const POSTPUB_ID = /^POSTPUB-/i;
// Only a title that «starts» with the marker: a pre-publish cell often mentions «발행 뒤» in its body (a slot, a plan).
const POSTPUB_TITLE = /^[«"'(]?\s*(발행\s*(뒤|후)|post-?publish)/i;
const STABLE = /^\d+\.\d+\.\d+$/;

export function isPostPublishCell(item: Pick<ChecklistItem, 'id' | 'title'> & { kind?: string }): boolean {
  return POSTPUB_ID.test(item.id) || POSTPUB_TITLE.test(item.title) || (item as { kind?: string }).kind === 'postpub';
}

export function nextPatch(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch! + 1}`;
}

const kstHour = (ms: number) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms)));

/** October cadence: the first 07:00 or 18:00 KST strictly after the cut (a cut at 07:00 publishes at 18:00). */
export function cadencePublishAt(cutAt: string): string {
  const cut = Date.parse(cutAt);
  const startOfHour = Math.floor(cut / 3_600_000) * 3_600_000 + 3_600_000;
  for (let t = startOfHour; t < cut + 48 * 3_600_000; t += 3_600_000) {
    const h = kstHour(t);
    if (h === 7 || h === 18) return new Date(t).toISOString();
  }
  return new Date(cut).toISOString();
}

/**
 * A release's measured gate: the newest finished release-loop run of «that» version (`{ version }`) or, with
 * `{ below }`, the most recently measured run of any version under it. Node timings are not stored in the run state, so the gate time is the start of the gate node's context file to
 * the start of the next node's (contexts/<n>.json is written when node n starts). Null when nothing was measured.
 */
export function releaseGateMeasure(which: { version: string } | { below: string }, root = join(effectiveInstanceRoot(), 'graph-runs', 'release-loop')): GateMeasure | null {
  if (!existsSync(root)) return null;
  const runs: Array<{ runId: string; version: string; startedAt: string; path: string[]; file: string }> = [];
  for (const file of readdirSync(root)) {
    if (!file.endsWith('.json') || file.includes('.decision')) continue;
    try {
      const state = JSON.parse(readFileSync(join(root, file), 'utf8')) as { runId?: string; status?: string; startedAt?: string; path?: string[]; input?: { version?: string } };
      const v = state.input?.version;
      if (state.status !== 'done' || typeof v !== 'string' || !STABLE.test(v) || !Array.isArray(state.path) || typeof state.startedAt !== 'string') continue;
      if ('version' in which ? v !== which.version : compareStable(v, which.below) >= 0) continue;
      runs.push({ runId: state.runId ?? file.slice(0, -5), version: v, startedAt: state.startedAt, path: state.path, file });
    } catch { /* an unreadable run is skipped — the measure is best-effort */ }
  }
  // `{ version }`: the newest run of that release. `{ below }` (only a labelled reference when the previous release has
  // no record): the most recently measured run, not the highest version.
  runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  for (const run of runs) {
    const contexts = join(root, `${run.file}.contexts`);
    const index = run.path.indexOf('gate');
    if (index < 0 || !existsSync(contexts)) continue;
    const at = (i: number): number | null => {
      const path = join(contexts, `${i + 1}.json`);
      try {
        const ctx = JSON.parse(readFileSync(path, 'utf8')) as { nodeId?: string };
        return ctx.nodeId === run.path[i] ? statSync(path).mtimeMs : null;
      } catch { return null; }
    };
    const gateStart = at(index), gateEnd = at(index + 1);
    if (gateStart === null || gateEnd === null || gateEnd < gateStart) continue;
    const publishIndex = run.path.indexOf('publish');
    const publishStart = publishIndex >= 0 ? at(publishIndex) : null;
    return {
      version: run.version, runId: run.runId, gateSeconds: Math.round((gateEnd - gateStart) / 1000),
      ...(publishStart !== null ? { toPublishSeconds: Math.round((publishStart - Date.parse(run.startedAt)) / 1000) } : {}),
    };
  }
  return null;
}

const minutes = (seconds: number) => `${Math.round(seconds / 60)}분`;
const short = (title: string) => (title.length > 60 ? `${title.slice(0, 60)}…` : title);

export async function releasePreflight(version: string, deps: PreflightDeps = {}): Promise<PreflightResult> {
  if (!STABLE.test(version)) throw new Error(`release preflight takes a stable version x.y.z: ${version}`);
  const now = deps.now ?? new Date();
  const next = nextPatch(version);
  const findings: PreflightFinding[] = [];
  const moveHint = (id: string) => `elanous release checklist move ${id} --from ${version} --to ${next} --reason "발행 뒤 칸 — 다음 판에서 확인"`;

  // 1·2. Checklist gate simulation «at the cut» (the node and the run entry both judge after land-by) ⊕ post-publish cells.
  const schedule = (deps.schedule ?? ((v: string) => getSchedule(v, deps.releaseRunDeps?.ledgerRoot)))(version);
  // Always the stored cut (before or after it): the preflight simulates «the cut», not the moment it is run.
  const judgeAt = schedule ? new Date(Date.parse(schedule.cutAt)) : now;
  const data = listChecklist(version);
  const { autoMoved, ...gate } = cutChecklistGate(version, schedule?.landBy, judgeAt);
  const p0 = data.items.filter((item) => item.status === 'yellow' && item.priority === 'P0').map((item) => item.id);
  const byId = new Map(data.items.map((item) => [item.id, item]));
  const blockReason = new Map<string, string>();
  for (const id of gate.red) blockReason.set(id, '빨강');
  for (const id of gate.undecided) blockReason.set(id, '노랑 · 처분 없음(판정 없음)');
  for (const id of gate.blocked) blockReason.set(id, p0.includes(id) ? 'P0 노랑' : '노랑 · 처분 block');
  // The scheduled start (`release run --if-ready` · `auto-start`) first asks releaseReadiness — the same call the CLI
  // makes, judged at the cut. It shares cutChecklistGate (#24557); an injected deps.checklist may still differ, so any
  // cell it refuses that the cut judgement did not is reported too (report, don't re-rule).
  try {
    const readiness = releaseReadiness(version, { ledgerRoot: deps.releaseRunDeps?.ledgerRoot, checklist: deps.releaseRunDeps?.checklist, now: () => judgeAt });
    if (readiness.reason === 'checklist-blocked') {
      for (const id of [...readiness.details.red, ...readiness.details.undecided, ...readiness.details.blocked]) {
        if (!blockReason.has(id)) blockReason.set(id, '예약 시작(release run --if-ready · auto-start)의 준비 검사(releaseReadiness)가 런을 거부한다');
      }
    } else if (readiness.reason === 'already-published' || readiness.reason === 'already-running') {
      // Both refuse the scheduled start — a running release (live run.lock) or a published one.
      findings.push({ level: 'block', check: 'run-input', message: `준비 검사(releaseReadiness)가 예약 시작을 거부한다: ${readiness.reason} (${readiness.details})` });
    }
  } catch (error) {
    findings.push({ level: 'block', check: 'run-input', message: `준비 검사(releaseReadiness) 오류 — ${error instanceof Error ? error.message : String(error)}` });
  }
  for (const [id, reason] of blockReason) {
    const item = byId.get(id);
    const postpub = item ? isPostPublishCell(item) : false;
    findings.push({
      level: 'block', check: postpub ? 'postpub' : 'checklist', id,
      message: `${id} — ${reason}${postpub ? ' · 발행 뒤 칸이 이 판에 남아 있다' : ''}${item ? ` · «${short(item.title)}»` : ''}`,
      ...(postpub ? { suggestion: moveHint(id) } : {}),
    });
  }
  for (const item of data.items) {
    if (blockReason.has(item.id) || !isPostPublishCell(item)) continue;
    findings.push({ level: 'warn', check: 'postpub', id: item.id, message: `${item.id} — 발행 뒤 칸이 이 판에 남아 있다(지금은 막지 않음 · 상태 ${item.status} · 처분 ${item.disposition ?? '-'})`, suggestion: moveHint(item.id) });
  }
  for (const id of autoMoved) {
    if (!blockReason.has(id)) findings.push({ level: 'warn', check: 'checklist', id, message: `${id} — 처분 없는 노랑 · 컷(착지 마감 뒤)에서 노드가 ${next} 로 자동 이월한다` });
  }
  for (const p of gate.parity ?? []) findings.push({ level: 'warn', check: 'checklist', id: p.id, message: `${p.id} — 화면 짝 경고: ${p.why}` });
  if (!blockReason.size) findings.push({ level: 'ok', check: 'checklist', message: `체크리스트 게이트 모의 통과 — ${data.items.length}칸 · 이월 ${gate.moved.length} · 알려진 문제 ${gate.knownIssues.length}` });

  // 3. The same input check `release run --dry-run` makes.
  let runPrevious: string | undefined;
  try {
    const result = await (deps.runInput ?? ((v: string) => runUnattendedRelease({ version: v, dryRun: true }, deps.releaseRunDeps ?? {})))(version);
    const input = result.input as { previousVersion?: string; gatePodPool?: string };
    runPrevious = input.previousVersion;
    findings.push({ level: 'ok', check: 'run-input', message: `release run --dry-run 입력 OK — 직전 판 ${input.previousVersion ?? '-'} · 게이트 풀 ${input.gatePodPool ?? '-'}` });
  } catch (error) {
    findings.push({ level: 'block', check: 'run-input', message: `release run --dry-run 입력 오류 — ${error instanceof Error ? error.message : String(error)}` });
  }

  // 4. Landing freeze (emergency switch since RELEASE-BRANCH): when on, `release run` refuses.
  try {
    const frozen = (deps.freeze ?? (() => readLandingFreeze(deps.releaseRunDeps?.freezeRoot)))();
    if (frozen) findings.push({ level: 'block', check: 'freeze', message: `${landingFreezeMessage(frozen)} — release run 이 거부한다`, suggestion: 'elanous freeze off (또는 의도한 강행이면 release run --force-freeze)' });
    else findings.push({ level: 'ok', check: 'freeze', message: '착지 동결 꺼짐' });
  } catch (error) {
    findings.push({ level: 'block', check: 'freeze', message: `동결 상태를 못 읽었다 — ${error instanceof Error ? error.message : String(error)}` });
  }

  // 5. Schedule sanity: land-by = cut − 30 min · cut→publish window vs the previous measured gate.
  let scheduleOut: PreflightResult['schedule'] = null;
  let gateMeasure: GateMeasure | null = null;
  let fallbackGateMeasure: GateMeasure | null = null;
  let previousVersion: string | null = deps.previousVersion ?? runPrevious ?? null;
  if (!previousVersion) { try { previousVersion = latestPublishedPreviousVersion(version, deps.releaseRunDeps?.ledgerRoot); } catch { previousVersion = null; } }
  if (!schedule) {
    findings.push({ level: 'warn', check: 'schedule', message: `판 일정 없음 — elanous release schedule set --version ${version} --cut-at <iso> --land-by <iso>` });
  } else {
    const cut = Date.parse(schedule.cutAt);
    const publishAt = deps.publishAt ? new Date(deps.publishAt).toISOString() : cadencePublishAt(schedule.cutAt);
    scheduleOut = { cutAt: schedule.cutAt, landBy: schedule.landBy, publishAt, publishAtSource: deps.publishAt ? 'option' : 'cadence' };
    if (!schedule.landBy) findings.push({ level: 'warn', check: 'schedule', message: `착지 마감 없음 — 컷 ${formatKst(schedule.cutAt)} · 규칙은 컷 − 30분` });
    else if (cut - Date.parse(schedule.landBy) < 30 * 60_000) findings.push({ level: 'warn', check: 'schedule', message: `착지 마감 ${formatKst(schedule.landBy)} 이 컷 − 30분보다 늦다(컷 ${formatKst(schedule.cutAt)})` });
    else findings.push({ level: 'ok', check: 'schedule', message: `일정 — 착지 마감 ${formatKst(schedule.landBy)} · 컷 ${formatKst(schedule.cutAt)}` });
    gateMeasure = previousVersion ? releaseGateMeasure({ version: previousVersion }, deps.graphRunsRoot) : null;
    if (!gateMeasure) fallbackGateMeasure = releaseGateMeasure({ below: version }, deps.graphRunsRoot);
    const windowSeconds = Math.round((Date.parse(publishAt) - cut) / 1000);
    const publishLabel = `발행 ${formatKst(publishAt)}${deps.publishAt ? '' : '(기본: 판 주기 07·18시 · --publish-at 로 바꾼다)'}`;
    if (!gateMeasure) {
      const fallback = fallbackGateMeasure ? ` · 참고: 가장 최근 실측은 ${fallbackGateMeasure.version} 게이트 ${minutes(fallbackGateMeasure.gateSeconds)}(직전 판 아님)` : ' · 게이트 실측 없음';
      findings.push({ level: 'warn', check: 'schedule', message: `직전 판${previousVersion ? `(${previousVersion})` : ''} 실측 없음 — 컷→${publishLabel} 창 ${minutes(windowSeconds)}${fallback}` });
    }
    else {
      const measured = `직전 실측 ${gateMeasure.version} 게이트 ${minutes(gateMeasure.gateSeconds)}${gateMeasure.toPublishSeconds !== undefined ? ` · 런 시작→발행 노드 ${minutes(gateMeasure.toPublishSeconds)}` : ''}`;
      const need = Math.max(gateMeasure.gateSeconds, gateMeasure.toPublishSeconds ?? 0);
      findings.push(windowSeconds < need
        ? { level: 'warn', check: 'schedule', message: `컷→${publishLabel} 창 ${minutes(windowSeconds)} < ${measured} — 발행이 늦어진다` }
        : { level: 'ok', check: 'schedule', message: `컷→${publishLabel} 창 ${minutes(windowSeconds)} ≥ ${measured}` });
    }
  }

  const blockers = findings.filter((f) => f.level === 'block').length;
  const warnings = findings.filter((f) => f.level === 'warn').length;
  debug.log('release.preflight', 'checked', { version, blockers, warnings });
  return { version, next, verdict: blockers ? 'block' : warnings ? 'warn' : 'ok', blockers, warnings, findings, schedule: scheduleOut, previousVersion, gateMeasure, fallbackGateMeasure };
}

const ICON: Record<PreflightLevel, string> = { ok: '✅', warn: '⚠️', block: '⛔' };

export function formatPreflight(result: PreflightResult): string[] {
  const order: PreflightLevel[] = ['block', 'warn', 'ok'];
  const lines = [...result.findings].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level))
    .flatMap((f) => [`${ICON[f.level]} ${f.message}`, ...(f.suggestion ? [`    → ${f.suggestion}`] : [])]);
  const verdict = result.verdict === 'block' ? `⛔ 판정: 막힘 — ⛔${result.blockers} ⚠️${result.warnings} · 컷 전에 고친다`
    : result.verdict === 'warn' ? `⚠️ 판정: 통과(경고 ${result.warnings})` : '✅ 판정: 통과';
  return [`release preflight ${result.version} (다음 판 ${result.next})`, ...lines, verdict];
}
