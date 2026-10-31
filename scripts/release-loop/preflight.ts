// `elanous release preflight` — 컷 −30분 운영 점검 + 컷 −60분 main export 사전 점검.
//
// 🩸 계기(10-06 실측): 0.2.17 릴리스 런이 첫 노드(checklist-gate)에서 멎었다 — «발행 뒤» 칸(POSTPUB-VERIFY)이 그 판에
//    남아 있었고 게이트가 그것을 미완으로 셌다. 컷 전 체크리스트 점검은 착지 마감 컷 −30분, F9 export 는 main HEAD 에서 컷 −60분 수동 실행.
// ⛔ 읽기 전용 — 칸을 옮기지도, 동결을 바꾸지도, push 하지도 않는다. 옮길 것은 «명령»으로 제안만 한다.
// ⛔ 게이트 규칙을 다시 쓰지 않는다 — checklist-gate 노드 · release run 진입 검사 · 예약 시작 준비 검사(releaseReadiness, #24557)가
//    함께 쓰는 단 하나의 판정 cutChecklistGate 를 그대로 부르고, 예약 시작 경로는 releaseReadiness 를 CLI 와 같은 인자로 부른다.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { cutChecklistGate, listChecklist, type ChecklistItem } from '../../src/release-loop/checklist.js';
import { getSchedule, formatKst, type ReleaseSchedule } from '../../src/release-loop/release-schedule.js';
import { readLandingFreeze, landingFreezeMessage, type LandingFreeze } from '../../src/release-loop/landing-freeze.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { debug } from '../../src/debug/log.js';
import { releaseReadiness } from './release-readiness.js';
import { latestPublishedPreviousVersion, runUnattendedRelease, type UnattendedReleaseDeps } from './unattended-release.js';
import { loadExportConfig, run as runPublicExport, selectExportFiles } from '../public-export.js';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';

export type PreflightLevel = 'ok' | 'warn' | 'block';
export type PreflightCheck = 'checklist' | 'postpub' | 'run-input' | 'freeze' | 'schedule' | 'export' | 'notes' | 'cut-tree' | 'gate-slot' | 'release-notes';
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
  schedule: { cutAt: string; landBy: string | null; publishAt: string | null; publishAtSource: 'option' | 'schedule' | 'cadence' | null; exportCheckAt: string } | null;
  exportCheck: { mainSha: string; files: number; leaks: number; codeLiterals: number } | null;
  /** Read-only T−120 evidence. It describes checks only; it never means a release stage ran. */
  countdownReadiness: {
    status: 'green' | 'red' | 'unmeasured';
    notes: { status: 'green' | 'red' | 'unmeasured'; addedLines: number | null };
    export: { status: 'green' | 'red' | 'unmeasured'; leaks: number | null };
    checklist: { status: 'green' | 'red' | 'unmeasured' };
  };
  /** The immediately previous release (by version order) whose gate is compared. */
  previousVersion: string | null;
  gateMeasure: GateMeasure | null;
  /** When the previous release has no record: the newest measured older release, labelled with its version. */
  fallbackGateMeasure: GateMeasure | null;
}

// ── RELEASE-COUNTDOWN-SEQUENCE — T−120 → T0 발사 시퀀스 ─────────────────────────────────────────
// 누리호 발사 체계의 사상: H0 전 자동 시퀀스 · 단계별 녹색/빨강 한 화면 · 범위 이탈(빨강)이면 자동 중지 ·
// 최후 수동 취소 구간 · 실패는 «부적합 보고»로 원장에 남겨 다음 판에 반영한다.
// 단계 → 검사 묶음은 기존 findings 의 check 분류를 «그대로» 재사용한다(게이트 규칙을 다시 쓰지 않는다).
export type CountdownStage = 'T-120' | 'T-60' | 'T-30' | 'T0';

/** What `scripts/release-loop/cutoff.ts` pins at T−60 (`<instance>/release/<version>/manifest.json`). */
export interface CountdownManifest {
  cutoff?: { sha?: string };
  fragments?: { byPr: number; byNextMd: number; unlinked: number; unknown: number };
  escalate?: Array<{ kind?: string }>;
}

/** The «node-b» gate slot: the dispatcher is paused and the pod target lowered so the gate can take a Pod. */
export interface CountdownGateSlot { dispatcherPaused?: boolean; podTargetFrom?: number; podTargetTo?: number }

export interface CountdownStep {
  stage: CountdownStage;
  /** Minutes before the cut. */
  offsetMinutes: number;
  /** Cut − offset (ISO); null when the release has no stored schedule. */
  at: string | null;
  label: string;
  level: PreflightLevel;
  findings: PreflightFinding[];
  /** Not judged — an earlier step went red and the sequence stopped. */
  skipped: boolean;
}

export interface NonconformanceEntry {
  version: string;
  stage: CountdownStage;
  /** 원인 */
  cause: string;
  /** 수리 */
  repair: string;
  /** 다음 판 반영 */
  nextRelease: string;
  at: string;
}

export interface CountdownResult {
  version: string;
  next: string;
  cutAt: string | null;
  verdict: PreflightLevel;
  steps: CountdownStep[];
  /** The stage that went red and stopped the sequence. */
  haltedAt: CountdownStage | null;
  /** 담당 자리 우편 — sent when the sequence stops. */
  mail: { from: string; to: string; subject: string; body: string } | null;
  /** 최후 수동 취소 구간 — the last seconds before T0 in which a human can still abort. */
  manualCancel: { windowStartAt: string; windowEndAt: string; totalResponsibleSeconds: number; ldSeconds: number } | null;
  nonconformance: NonconformanceEntry[];
  /** The target «부적합 보고» ledger (JSON Lines); dry-run does not append. */
  nonconformanceLedger: string;
  sideEffectsEnabled: boolean;
  preflight: PreflightResult;
}
export type ReleaseCountdownStep = {
  id: 'notes-and-readiness' | 'pinned-main-preflight' | 'gate-window' | 'cut';
  offsetMinutes: number;
  at: string;
  action: string;
  observation: 'not-observed-by-countdown';
};

export interface PreflightDeps {
  now?: Date;
  countdown?: boolean;
  /** Planned publish time (ISO). Without it, the October cadence (07:00 · 18:00 KST) after the cut is assumed. */
  publishAt?: string;
  runInput?: (version: string) => Promise<{ input: unknown }>;
  freeze?: () => LandingFreeze | null;
  schedule?: (version: string) => ReleaseSchedule | null;
  graphRunsRoot?: string;
  releaseRunDeps?: UnattendedReleaseDeps;
  /** The immediately previous release; default = the run input's previousVersion (release ledger). */
  previousVersion?: string;
  /** Injectable for deterministic preflight tests. Production pins origin/main and scans a disposable checkout. */
  exportCheck?: () => Promise<{ mainSha: string; files: number; leaks: number; codeLiterals: number }>;
  /** Countdown T−120/T−60/T0: the cut manifest `cutoff.ts` pinned (default `<instance>/release/<v>/manifest.json`). */
  manifest?: (version: string) => CountdownManifest | null;
  /** Countdown T−60: the «node-b» gate-slot record (default `<instance>/release/<v>/gate-slot.json`). */
  gateSlot?: (version: string) => CountdownGateSlot | null;
  /** Countdown seat mail — default posts `eln msg post --from OP --to <담당 자리>`. */
  postMail?: (mail: { from: string; to: string; subject: string; body: string }) => void;
  /** Countdown «부적합 보고» ledger (JSON Lines) — default `<instance>/release/nonconformance.jsonl`. */
  nonconformanceLog?: string;
  /** Injectable read-only comparison of release/next.md against the previous published tag. */
  releaseNotesCheck?: (previousVersion: string | undefined, mainSha: string | undefined) => Promise<number>;
  /** Explicitly enable owner mail and nonconformance ledger append; defaults to dry-run. */
  allowSideEffects?: boolean;
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 << 20 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 실패 rc=${result.status}: ${(result.stderr ?? '').trim().slice(0, 300)}`);
  return (result.stdout ?? '').trim();
}

/** Read-only main snapshot: all checkout and cleanup writes are contained in a disposable temp directory. */
export async function scanOriginMainExport(): Promise<{ mainSha: string; files: number; leaks: number; codeLiterals: number }> {
  const repoRoot = runGit(process.cwd(), ['rev-parse', '--show-toplevel']);
  const mainSha = runGit(repoRoot, ['rev-parse', '--verify', 'origin/main^{commit}']);
  const temp = mkdtempSync(join(tmpdir(), 'release-preflight-main-'));
  const snapshot = join(temp, 'checkout');
  try {
    runGit(temp, ['clone', '--shared', '--no-checkout', '--quiet', repoRoot, snapshot]);
    runGit(snapshot, ['read-tree', mainSha]);
    const tracked = runGit(snapshot, ['ls-files', '-z']).split('\0').filter(Boolean);
    const trackedSet = new Set(tracked);
    // `git check-ignore --no-index` applies every nested ignore file, including ones below selected paths.
    const needed = new Set(tracked.filter((file) => file === '.gitignore' || file.endsWith('/.gitignore')));
    needed.add('release/public-export.yaml');
    // Read only the paths the pinned manifest can inspect; the full tracked-path index stays at mainSha.
    const manifestPath = join(snapshot, 'release/public-export.yaml');
    const manifest = spawnSync('git', ['-C', snapshot, 'show', `${mainSha}:release/public-export.yaml`], { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 << 20 });
    if (manifest.status !== 0) throw new Error(`origin/main public export manifest 읽기 실패: ${(manifest.stderr ?? '').trim()}`);
    mkdirSync(join(snapshot, 'release'), { recursive: true });
    writeFileSync(manifestPath, manifest.stdout ?? '');
    const config = loadExportConfig(snapshot);
    const selected = selectExportFiles(tracked, config);
    for (const file of selected) needed.add(file);
    for (const source of Object.values(config.replace)) needed.add(source);
    if (config.skills) {
      needed.add('catalog/resources.yaml');
      needed.add('src/video-pipeline/capabilities.ts');
      for (const file of tracked) if (/^skills\/[^/]+\/SKILL\.md$/u.test(file)) needed.add(file);
      for (const file of tracked) {
        const skill = /^skills\/([^/]+)\//u.exec(file)?.[1];
        if (skill) mkdirSync(join(snapshot, 'skills', skill), { recursive: true });
      }
    }
    const checkout = spawnSync('git', ['-C', snapshot, 'checkout-index', '--stdin', '-z', '-f'], {
      input: `${[...needed].filter((file) => trackedSet.has(file)).join('\0')}\0`, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 << 20,
    });
    if (checkout.status !== 0) throw new Error(`origin/main export 입력 파일 준비 실패 rc=${checkout.status}: ${(checkout.stderr ?? '').trim().slice(0, 300)}`);
    let output = '';
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => { output += `${args.map(String).join(' ')}\n`; };
    console.error = () => {};
    let code: number;
    try { code = runPublicExport(['--leak-check', '--json'], snapshot); }
    finally { console.log = originalLog; console.error = originalError; }
    const report = JSON.parse(output.trim()) as {
      files?: number; leaks?: number; hits?: Array<{ marker: string; file?: string; line?: number }>; codeLiterals?: { hits?: number };
      privateRedactions?: { loaded?: boolean };
    };
    if (report.privateRedactions?.loaded !== true) {
      const failure = report.hits?.find((hit) => hit.marker.startsWith('private-redaction-'));
      if (failure) throw new Error(`공개 export 개인 치환 실패: ${failure.marker} ${failure.file ?? ''}:${failure.line ?? 0}`);
      throw new Error('개인 치환표를 읽지 못해 export 누수 검사를 완결할 수 없다');
    }
    if (typeof report.files !== 'number' || typeof report.leaks !== 'number') throw new Error('public-export 검사 결과가 완전하지 않다');
    if (code !== (report.leaks > 0 ? 1 : 0)) throw new Error(`public-export 종료 코드와 누수 결과 불일치: rc=${code} leaks=${report.leaks}`);
    const codeLiterals = report.codeLiterals?.hits ?? 0;
    return { mainSha, files: report.files, leaks: Math.max(0, report.leaks - codeLiterals), codeLiterals };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Count added release-note lines from the last published tag to the exact pinned main commit. */
export async function scanReleaseNotesAddedLines(previousVersion: string | undefined, mainSha: string | undefined): Promise<number> {
  if (!previousVersion || !STABLE.test(previousVersion)) throw new Error('직전 발행 판 버전이 없어 release/next.md 변경을 비교할 수 없다');
  const repoRoot = runGit(process.cwd(), ['rev-parse', '--show-toplevel']);
  const pinnedMainSha = mainSha && /^[0-9a-f]{40}$/u.test(mainSha)
    ? mainSha : runGit(repoRoot, ['rev-parse', '--verify', 'origin/main^{commit}']);
  const previousTag = runGit(repoRoot, ['rev-parse', '--verify', `v${previousVersion}^{commit}`]);
  const numstat = runGit(repoRoot, ['diff', '--numstat', `${previousTag}...${pinnedMainSha}`, '--', 'release/next.md']);
  if (!numstat) return 0;
  const added = Number(numstat.split('\t', 1)[0]);
  if (!Number.isSafeInteger(added) || added < 0) throw new Error(`release/next.md diff 결과를 읽을 수 없다: ${numstat}`);
  return added;
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

/** A read-only timeline; timestamps never imply that a human or automation completed a step. */
export function releaseCountdown(cutAt: string): ReleaseCountdownStep[] {
  const cut = Date.parse(cutAt);
  if (!Number.isFinite(cut)) throw new Error(`invalid release cut time: ${cutAt}`);
  const phases = [
    { id: 'notes-and-readiness', offsetMinutes: -120, action: 'release/next.md 새 줄 ≥1 · 공개 export 누수 0 · 체크리스트 게이트 모의' },
    { id: 'pinned-main-preflight', offsetMinutes: -60, action: '컷 트리를 고정하고 origin/main export 및 release preflight 실행' },
    { id: 'gate-window', offsetMinutes: -30, action: 'gate 모드 · node-b 자리 확보 · 디스패처 정지 · podTarget 감축 확인' },
    { id: 'cut', offsetMinutes: 0, action: 'release 컷 실행' },
  ] as const;
  return phases.map((phase) => ({
    ...phase,
    at: new Date(cut + phase.offsetMinutes * 60_000).toISOString(),
    observation: 'not-observed-by-countdown',
  }));
}

export function formatReleaseCountdown(cutAt: string, now = new Date(), readiness?: PreflightResult['countdownReadiness']): string[] {
  return [
    `발행 카운트다운 · 컷 ${formatKst(cutAt)} · 이 명령은 단계 완료를 관측하거나 실행하지 않는다`,
    ...releaseCountdown(cutAt).map((step) => {
      const label = step.offsetMinutes === 0 ? 'T0' : `T${step.offsetMinutes}`;
      const timing = now.getTime() < Date.parse(step.at) ? '예정' : '시각 도달 · 완료 미관측';
      const t120 = readiness && step.id === 'notes-and-readiness'
        ? ` · read-only 판정 ${readiness.status} (notes +${readiness.notes.addedLines ?? '?'} · export 누수 ${readiness.export.leaks ?? '?'} · checklist ${readiness.checklist.status})`
        : '';
      return `· ${label} ${formatKst(step.at)} · ${timing} · ${step.action}${t120}`;
    }),
  ];
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
  let exportCheck: PreflightResult['exportCheck'] = null;
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

  // 3a. Public export leakage is measured against one pinned origin/main commit, never this possibly dirty branch.
  try {
    exportCheck = await (deps.exportCheck ?? scanOriginMainExport)();
    findings.push(exportCheck.leaks
      ? { level: 'block', check: 'export', message: `origin/main ${exportCheck.mainSha.slice(0, 12)} 공개 export 누수 ${exportCheck.leaks}건 · ${exportCheck.files} 파일 검사` }
      : { level: 'ok', check: 'export', message: `origin/main ${exportCheck.mainSha.slice(0, 12)} 공개 export 누수 0건 · ${exportCheck.files} 파일 검사` });
    if (exportCheck.codeLiterals) findings.push({ level: 'warn', check: 'export', message: `코드 리터럴 표지 ${exportCheck.codeLiterals}건은 문서/주석 누수에서 분리해 기록` });
  } catch (error) {
    findings.push({ level: 'block', check: 'export', message: `origin/main 공개 export 검사를 완료하지 못했다 — ${error instanceof Error ? error.message : String(error)}` });
  }

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

  let notesAddedLines: number | null = null;
  if (deps.countdown) {
    try {
      notesAddedLines = await (deps.releaseNotesCheck ?? scanReleaseNotesAddedLines)(runPrevious, exportCheck?.mainSha);
      findings.push(notesAddedLines > 0
        ? { level: 'ok', check: 'release-notes', message: `직전 발행 ${runPrevious} 이후 고정 main의 release/next.md 추가 ${notesAddedLines}줄` }
        : { level: 'block', check: 'release-notes', message: `직전 발행 ${runPrevious ?? '-'} 이후 고정 main의 release/next.md 추가 줄이 없다` });
    } catch (error) {
      findings.push({ level: 'warn', check: 'release-notes', message: `release/next.md 변경을 측정하지 못했다 — ${error instanceof Error ? error.message : String(error)}` });
    }
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
    // --publish-at > the stored schedule publish time (`release schedule set --publish-at`) > the October cadence.
    const publishAtSource = deps.publishAt ? 'option' : schedule.publishAt ? 'schedule' : 'cadence';
    const publishAt = deps.publishAt ? new Date(deps.publishAt).toISOString() : schedule.publishAt ?? cadencePublishAt(schedule.cutAt);
    const exportCheckAt = new Date(cut - 60 * 60_000).toISOString();
    scheduleOut = { cutAt: schedule.cutAt, landBy: schedule.landBy, publishAt, publishAtSource, exportCheckAt };
    findings.push(Date.parse(now.toISOString()) < Date.parse(exportCheckAt)
      ? { level: 'warn', check: 'schedule', message: `main export 검사 시각 ${formatKst(exportCheckAt)}(컷 − 60분)보다 이르다 · OP가 그 시각에 수동 실행` }
      : { level: 'ok', check: 'schedule', message: `main export 검사 시각 ${formatKst(exportCheckAt)}(컷 − 60분) · 자동 예약 없음` });
    if (!schedule.landBy) findings.push({ level: 'warn', check: 'schedule', message: `착지 마감 없음 — 컷 ${formatKst(schedule.cutAt)} · 규칙은 컷 − 30분` });
    else if (cut - Date.parse(schedule.landBy) < 30 * 60_000) findings.push({ level: 'warn', check: 'schedule', message: `착지 마감 ${formatKst(schedule.landBy)} 이 컷 − 30분보다 늦다(컷 ${formatKst(schedule.cutAt)})` });
    else findings.push({ level: 'ok', check: 'schedule', message: `일정 — 착지 마감 ${formatKst(schedule.landBy)} · 컷 ${formatKst(schedule.cutAt)}` });
    gateMeasure = previousVersion ? releaseGateMeasure({ version: previousVersion }, deps.graphRunsRoot) : null;
    if (!gateMeasure) fallbackGateMeasure = releaseGateMeasure({ below: version }, deps.graphRunsRoot);
    const windowSeconds = Math.round((Date.parse(publishAt) - cut) / 1000);
    const publishLabel = `발행 ${formatKst(publishAt)}${publishAtSource === 'cadence' ? '(기본: 판 주기 07·18시 · --publish-at 로 바꾼다)' : publishAtSource === 'schedule' ? '(판 일정)' : ''}`;
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

  const checklistHasResult = findings.some((f) => f.check === 'checklist' && f.level === 'ok');
  const countdownReadiness: PreflightResult['countdownReadiness'] = !deps.countdown ? {
    status: 'unmeasured', notes: { status: 'unmeasured', addedLines: null },
    export: { status: 'unmeasured', leaks: null }, checklist: { status: 'unmeasured' },
  } : (() => {
    const notesFinding = findings.find((f) => f.check === 'release-notes');
    const exportFinding = findings.find((f) => f.check === 'export');
    const checklistBlocked = findings.some((f) => f.check === 'checklist' && f.level === 'block');
    const notesStatus = notesFinding?.level === 'ok' ? 'green' : notesFinding?.level === 'block' ? 'red' : 'unmeasured';
    const exportStatus = exportFinding?.level === 'ok' ? 'green' : exportFinding?.level === 'block' ? 'red' : 'unmeasured';
    const checklistStatus = checklistBlocked ? 'red' : checklistHasResult ? 'green' : 'unmeasured';
    const statuses = [notesStatus, exportStatus, checklistStatus];
    return {
      status: statuses.includes('red') ? 'red' : statuses.every((status) => status === 'green') ? 'green' : 'unmeasured',
      notes: { status: notesStatus, addedLines: notesAddedLines },
      export: { status: exportStatus, leaks: exportCheck?.leaks ?? null },
      checklist: { status: checklistStatus },
    };
  })();
  const blockers = findings.filter((f) => f.level === 'block').length;
  const warnings = findings.filter((f) => f.level === 'warn').length;
  debug.log('release.preflight', 'checked', { version, blockers, warnings });
  return { version, next, verdict: blockers ? 'block' : warnings ? 'warn' : 'ok', blockers, warnings, findings, schedule: scheduleOut, exportCheck, countdownReadiness, previousVersion, gateMeasure, fallbackGateMeasure };
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

const COUNTDOWN_ORDER: CountdownStage[] = ['T-120', 'T-60', 'T-30', 'T0'];
const COUNTDOWN_OFFSET_MINUTES: Record<CountdownStage, number> = { 'T-120': 120, 'T-60': 60, 'T-30': 30, T0: 0 };
/** Which existing finding group each stage judges — the check vocabulary of `releasePreflight`, not a new rule set. */
const COUNTDOWN_CHECKS: Record<CountdownStage, PreflightCheck[]> = {
  'T-120': ['checklist', 'postpub', 'notes', 'release-notes', 'export'],
  'T-60': ['run-input', 'freeze', 'cut-tree', 'gate-slot'],
  'T-30': ['schedule'],
  T0: [],
};
const COUNTDOWN_LABELS: Record<CountdownStage, string> = {
  'T-120': '노트(next.md 새 줄) · 공개 export 누수 · 체크리스트 게이트 모의',
  'T-60': 'preflight(컷 트리 고정) ⊕ node-b 게이트 자리(디스패처 정지 · podTarget 감축)',
  'T-30': 'gate window 준비(컷→발행 창 ≥ 직전 실측 게이트)',
  T0: '컷 트리 확인(실제 컷 실행은 별도)',
};
/** 담당 자리 — who is mailed when that stage goes red. */
const COUNTDOWN_OWNER: Record<CountdownStage, string> = { 'T-120': 'TC', 'T-60': 'OP', 'T-30': 'OP', T0: 'OP' };
/** 최후 수동 취소 구간(누리호 사상): 총책임자 8초 · LD 5초. */
const MANUAL_CANCEL_SECONDS = { totalResponsibleSeconds: 8, ldSeconds: 5 };

const worstLevel = (findings: PreflightFinding[]): PreflightLevel =>
  findings.some((finding) => finding.level === 'block') ? 'block' : findings.some((finding) => finding.level === 'warn') ? 'warn' : 'ok';

function readReleaseJson<T>(version: string, file: string): T | null {
  try { return JSON.parse(readFileSync(join(effectiveInstanceRoot(), 'release', version, file), 'utf8')) as T; } catch { return null; }
}

/** T−120 — `next.md` got at least one new line for this release (0.2.39 found notes-empty only after the cut). */
function countdownNotes(manifest: CountdownManifest | null): PreflightFinding {
  if (!manifest) return { level: 'warn', check: 'notes', message: 'next.md 새 줄 판정 없음 — 컷 manifest 없음(T−60 의 cutoff.ts 가 만든다)' };
  const lines = (manifest.fragments?.byNextMd ?? 0) + (manifest.fragments?.unlinked ?? 0);
  if ((manifest.escalate ?? []).some((item) => item.kind === 'notes-empty') || lines < 1) {
    return {
      level: 'block', check: 'notes', message: 'next.md 새 줄 0 — notes-empty(이 판 공개 노트가 비어 있다 · 컷 뒤에 드러나면 발행이 늦어진다)',
      suggestion: 'release/next.md 에 이 판 feat/fix 줄을 더하고 cutoff.ts 로 manifest 를 다시 만든다',
    };
  }
  return { level: 'ok', check: 'notes', message: `next.md 새 줄 ${lines}줄` };
}

/** T−60 — the cut tree is pinned: the manifest names one cutoff sha (cutoff.ts output, its format unchanged). */
function countdownCutTree(manifest: CountdownManifest | null): PreflightFinding {
  const sha = manifest?.cutoff?.sha;
  return sha
    ? { level: 'ok', check: 'cut-tree', message: `컷 트리 고정 ${sha.slice(0, 12)}` }
    : { level: 'warn', check: 'cut-tree', message: '컷 트리 고정 없음 — T−60 에 `bun scripts/release-loop/cutoff.ts --version <v>` 로 manifest 를 만든다' };
}

/** T−60 — the «node-b» gate slot: dispatcher stopped and the pod target lowered so the gate can take a Pod. */
function countdownGateSlot(slot: CountdownGateSlot | null): PreflightFinding[] {
  if (!slot) return [{ level: 'warn', check: 'gate-slot', message: 'node-b 게이트 자리 기록 없음 — release/<v>/gate-slot.json(디스패처 정지 · podTarget 감축)' }];
  const findings: PreflightFinding[] = [];
  if (slot.dispatcherPaused !== true) {
    findings.push({
      level: 'block', check: 'gate-slot', message: 'node-b 게이트 자리 — 디스패처가 멈추지 않았다(게이트가 Pod 를 잡지 못한다)',
      suggestion: '디스패처를 정지하고 release/<v>/gate-slot.json 에 dispatcherPaused: true 를 남긴다',
    });
  }
  if (slot.podTargetFrom !== undefined && slot.podTargetTo !== undefined && slot.podTargetTo >= slot.podTargetFrom) {
    findings.push({
      level: 'block', check: 'gate-slot', message: `node-b 게이트 자리 — podTarget 감축 없음(${slot.podTargetFrom}→${slot.podTargetTo})`,
      suggestion: 'podTarget 을 게이트 몫만큼 줄이고 gate-slot.json 에 from/to 를 기록한다',
    });
  }
  if (!findings.length) {
    const target = slot.podTargetFrom !== undefined ? ` · podTarget ${slot.podTargetFrom}→${slot.podTargetTo ?? slot.podTargetFrom}` : '';
    findings.push({ level: 'ok', check: 'gate-slot', message: `node-b 게이트 자리 확보 — 디스패처 정지${target}` });
  }
  return findings;
}

/** T0 — model readiness only: this command never executes the cut. */
function countdownCut(manifest: CountdownManifest | null): PreflightFinding {
  const sha = manifest?.cutoff?.sha;
  return sha
    ? { level: 'ok', check: 'cut-tree', message: `T0 컷 준비 — 고정 트리 ${sha.slice(0, 12)}(실제 컷 실행은 별도 명령)` }
    : { level: 'block', check: 'cut-tree', message: 'T0 컷 불가 — 컷 트리 고정(manifest cutoff.sha)이 없다', suggestion: 'T−60 에 cutoff.ts 로 컷 트리를 고정한다' };
}

function postSeatMail(mail: { from: string; to: string; subject: string; body: string }): void {
  const result = spawnSync('eln', ['msg', 'post', '--from', mail.from, '--to', mail.to, '--kind', 'report', '--body', `${mail.subject}\n${mail.body}`], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER,
  });
  if (result.status !== 0 || result.error) process.stderr.write(`release countdown 좌석 우편 실패: ${(result.stderr || String(result.error ?? result.status)).trim()}\n`);
}

/**
 * `release preflight --countdown` — the launch sequence from T−120 to T0 over the same `releasePreflight` findings.
 * A red stage stops every later stage, mails the owning seat and appends one «부적합 보고» per failure to the ledger.
 * Read-only apart from that ledger append and the seat mail — the cut and the checklist are never changed.
 */
export async function runReleaseCountdown(version: string, deps: PreflightDeps = {}): Promise<CountdownResult> {
  const preflight = await releasePreflight(version, { ...deps, countdown: true });
  const now = deps.now ?? new Date();
  const manifest = (deps.manifest ?? ((v: string) => readReleaseJson<CountdownManifest>(v, 'manifest.json')))(version);
  const slot = (deps.gateSlot ?? ((v: string) => readReleaseJson<CountdownGateSlot>(v, 'gate-slot.json')))(version);
  const cutAt = preflight.schedule?.cutAt ?? null;

  const grouped = new Map<PreflightCheck, PreflightFinding[]>();
  for (const finding of preflight.findings) grouped.set(finding.check, [...(grouped.get(finding.check) ?? []), finding]);
  const own: Record<CountdownStage, PreflightFinding[]> = {
    'T-120': [countdownNotes(manifest)],
    'T-60': [countdownCutTree(manifest), ...countdownGateSlot(slot)],
    'T-30': [],
    T0: [countdownCut(manifest)],
  };

  const steps: CountdownStep[] = [];
  let haltedAt: CountdownStage | null = null;
  for (const stage of COUNTDOWN_ORDER) {
    const offsetMinutes = COUNTDOWN_OFFSET_MINUTES[stage];
    const at = cutAt ? new Date(Date.parse(cutAt) - offsetMinutes * 60_000).toISOString() : null;
    if (haltedAt) {
      steps.push({ stage, offsetMinutes, at, label: COUNTDOWN_LABELS[stage], level: 'ok', findings: [], skipped: true });
      continue;
    }
    const findings = [...COUNTDOWN_CHECKS[stage].flatMap((check) => grouped.get(check) ?? []), ...own[stage]];
    const level = worstLevel(findings);
    steps.push({ stage, offsetMinutes, at, label: COUNTDOWN_LABELS[stage], level, findings, skipped: false });
    if (level === 'block') haltedAt = stage;
  }

  const nonconformance: NonconformanceEntry[] = steps.flatMap((step) => step.findings
    .filter((finding) => finding.level === 'block')
    .map((finding) => ({
      version, stage: step.stage, cause: finding.message,
      repair: finding.suggestion ?? `${step.stage} 담당 자리가 원인을 확인해 고친다`,
      nextRelease: preflight.next, at: now.toISOString(),
    })));
  const nonconformanceLedger = deps.nonconformanceLog ?? join(effectiveInstanceRoot(), 'release', 'nonconformance.jsonl');
  if (deps.allowSideEffects && nonconformance.length) {
    mkdirSync(dirname(nonconformanceLedger), { recursive: true });
    appendFileSync(nonconformanceLedger, `${nonconformance.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  }

  const mail = haltedAt ? countdownMail(version, haltedAt, steps, nonconformance.length) : null;
  if (deps.allowSideEffects && mail) (deps.postMail ?? postSeatMail)(mail);

  const cancelSeconds = MANUAL_CANCEL_SECONDS.totalResponsibleSeconds + MANUAL_CANCEL_SECONDS.ldSeconds;
  const manualCancel = cutAt ? {
    windowStartAt: new Date(Date.parse(cutAt) - cancelSeconds * 1000).toISOString(),
    windowEndAt: cutAt, ...MANUAL_CANCEL_SECONDS,
  } : null;
  const verdict = haltedAt ? 'block' : steps.some((step) => step.level === 'warn') ? 'warn' : 'ok';
  debug.log('release.preflight', 'countdown', { version, haltedAt, verdict, nonconformance: nonconformance.length });
  return {
    version, next: preflight.next, cutAt, verdict, steps, haltedAt, mail, manualCancel, nonconformance, nonconformanceLedger,
    sideEffectsEnabled: deps.allowSideEffects === true, preflight,
  };
}

function countdownMail(version: string, stage: CountdownStage, steps: CountdownStep[], failures: number): CountdownResult['mail'] {
  const step = steps.find((entry) => entry.stage === stage)!;
  const reasons = step.findings.filter((finding) => finding.level === 'block');
  const repairs = reasons.filter((finding) => finding.suggestion).map((finding) => `· ${finding.message} → ${finding.suggestion}`);
  return {
    from: 'OP', to: COUNTDOWN_OWNER[stage], subject: `RELEASE-COUNTDOWN ${version} ${stage}`,
    body: [
      `RELEASE-COUNTDOWN ${version} ${stage} 빨강 — 발사 시퀀스를 자동 중지했다.`,
      ...reasons.map((finding) => `· ${finding.message}`),
      ...(repairs.length ? ['수리:', ...repairs] : []),
      `«부적합 보고» ${failures}건을 원장에 넣었다(원인·수리·다음 판 ${nextPatch(version)} 반영).`,
    ].join('\n'),
  };
}

/** The one screen of the launch sequence: every stage green/red, the manual-cancel window and one «판정:» line. */
export function formatCountdown(result: CountdownResult): string[] {
  const lines = [`release countdown ${result.version} (다음 판 ${result.next})${result.cutAt ? ` · 컷 ${formatKst(result.cutAt)}` : ''} · 검사 상태만 표시(단계 실행은 미관측)`];
  for (const step of result.steps) {
    const when = step.at ? ` · ${formatKst(step.at)}` : '';
    if (step.skipped) { lines.push(`⏸ ${step.stage} — 미진행(${result.haltedAt} 빨강 — 자동 중지)${when}`); continue; }
    lines.push(`${ICON[step.level]} ${step.stage} ${step.label}${when}`);
    for (const finding of step.findings) {
      lines.push(`    ${ICON[finding.level]} ${finding.message}`);
      if (finding.suggestion) lines.push(`      → ${finding.suggestion}`);
    }
  }
  if (result.manualCancel) {
    const seconds = Math.round((Date.parse(result.manualCancel.windowEndAt) - Date.parse(result.manualCancel.windowStartAt)) / 1000);
    lines.push(`⏱ 최후 수동 취소 구간 T0−${seconds}초 ~ T0 (${formatKst(result.manualCancel.windowEndAt)}) — 총책임자 ${result.manualCancel.totalResponsibleSeconds}초 · LD ${result.manualCancel.ldSeconds}초`);
  }
  if (result.mail) lines.push(`${result.sideEffectsEnabled ? '📮 담당 자리 우편' : '📮 담당 자리 우편 계획(미발송 · 기본 dry-run)'} → ${result.mail.to} · ${result.mail.subject}`);
  lines.push(result.verdict === 'block'
    ? `⛔ 판정: 평가 중지 — ${result.haltedAt} 빨강 · 부적합 보고 ${result.nonconformance.length}건 ${result.sideEffectsEnabled ? `원장 기록(${result.nonconformanceLedger})` : `원장 기록 계획(미기록 · 기본 dry-run: ${result.nonconformanceLedger})`}`
    : result.verdict === 'warn' ? '⚠️ 판정: 통과(경고) — 경고 단계는 기록만 한다' : '✅ 판정: 통과');
  return lines;
}
