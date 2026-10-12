// `elanous harness stop <runId>` — 런 하나를 한 줄로 멈춘다: 오케스트레이터 프로세스 ⊕ 그 런의 Pod Job.
//
// 🩸 2026-09-27: 멈추려면 사람이 PID 둘(harness ask 부모 · self orchestrate 자식)과 Job 이름을 손으로 찾아야 했고,
//   그 사이 떠 있던 조각이 main 에 병합됐다(#21048). 부모를 죽이면 자식이 PPID 1 고아로 2h36m 더 돌았다(🅞 보고).
// B 조각(#21171)이 오케스트레이터에 `self-dev-runs/<runId>/pid.json` ⊕ SIGTERM 정리(새 잡 멈춤 · 자기 Job 삭제 · cancelled)를 넣었다.
// 이 파일은 그 기록과 런 원장·프로세스 표를 읽고, 시작 시각이 확인된 후보에만 신호를 보내며, 라벨 일치 Pod Job 을 지운다.
//
// ⛔ 불변식: 기록된 시작 시각과 실제 프로세스 시작 시각이 다르면 신호를 보내지 않는다(PID 재사용 방지).
// ⛔ 불변식: 라벨이 붙은 Job 만 지운다 — `elanous.run=<runId>` · 그 라벨이 0 이면 `elanous.child-run=<runId>` 폴백(자식 런 id 로 쳤을 때).
//   지우는 것은 라벨 일치 Job 뿐이다: 이름 추측 없음 · Pod 직접 삭제 없음 · namespace 기본값(elanous-test) 불변.
//   (HARNESS-STOP-POD-LABEL 2026-10-11) 문맥마다 삭제 결과를 넷으로 가르고 관측 `harness.stop` `job-delete`(context·outcome·matchedBy) 로 남긴다.
// ⛔ 불변식: 짧은 runId 의 후보가 둘 이상이면 프로세스 신호·Job 삭제 전에 중단한다.

import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { debug } from '../debug/log.js';
import { selfDevRunsDir } from '../self-dev/run-store.js';
import { launchBindingRunIds, launchRegistryDir, readLaunchBinding } from './launch-registry.js';
import { loadRunLedger, resolveFederatedRunLedgerDirectories, runLedgerDir } from '../self-implement/run-ledger.js';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FULL_RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AmbiguousHarnessStopRunIdError extends Error {
  constructor(given: string, candidates: readonly string[]) {
    super(`harness stop ${given}: 더 긴 id 를 주십시오\n${candidates.map((id) => `  ${id}`).join('\n')}`);
    this.name = 'AmbiguousHarnessStopRunIdError';
  }
}

/** List names, not ledger bodies: a run may have written its pid.json before its ledger. */
export function stopRunIdCandidates(given: string, ledgerDirs: readonly string[], runsDir: string): string[] {
  const found = new Set<string>();
  for (const dir of ledgerDirs) {
    let names: string[];
    try { names = readdirSync(dir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (FULL_RUN_ID.test(id) && id.startsWith(given)) found.add(id);
    }
  }
  try {
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(given) && FULL_RUN_ID.test(entry.name)
        && existsSync(join(runsDir, entry.name, 'pid.json'))) found.add(entry.name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return [...found].sort();
}
/** `pid.json` 의 `startedAt` 은 `Date.now() − uptime` 근삿값이다 — 이만큼의 차이는 같은 프로세스로 본다. */
export const START_TOLERANCE_MS = 5_000;

export interface PidRecord { pid: number; startedAt: number; argv0?: string }
export interface StopProcessCandidate { pid: number; startedAt: number; via: 'pid.json' | 'argv-runId' | 'argv-goal' }
export type StopProcessScan = { status: 'ok'; candidates: StopProcessCandidate[] } | { status: 'failed'; reason: string };

/** The start event, not later bookkeeping, owns the goal document path. */
export function stopGoalPathFromLedger(runId: string, dir = runLedgerDir()): string | null {
  try {
    const start = loadRunLedger(runId, dir)?.find((entry) => entry.event === 'start');
    const goal = start?.data.goalFile;
    const root = start?.data.targetRoot;
    if (typeof goal !== 'string' || !goal.trim()) return null;
    return isAbsolute(goal) ? resolve(goal) : typeof root === 'string' && isAbsolute(root) ? resolve(root, goal) : goal;
  } catch { return null; }
}

/** Parse ps rows without treating a partial or failed measurement as an empty table. Relative goal arguments require the candidate's own cwd, never the stop caller's cwd. */
export function discoverStopProcesses(runId: string, goalPath: string | null, table: string, processCwd: (pid: number) => string | null = () => null): StopProcessScan {
  const candidates: StopProcessCandidate[] = [];
  for (const line of table.split(/\r?\n/)) {
    if (!line.trim() || /^\s*PID\s/.test(line)) continue;
    const match = /^\s*(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(line);
    if (!match) return { status: 'failed', reason: 'unparseable process table row' };
    const pid = Number(match[1]);
    const startedAt = Date.parse(`${match[2]!} GMT`);
    if (!Number.isSafeInteger(pid) || !Number.isFinite(startedAt)) return { status: 'failed', reason: 'invalid process table row' };
    if (pid <= 1) continue;
    const args = match[3]!.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
    const entry = args.findIndex((arg) => /(?:^|\/)elanous(?:\.mjs)?$/.test(arg));
    const executable = args[0] ?? '';
    const runtime = /(?:^|\/)(?:bun|node)$/.test(executable);
    if (entry < 0 || (entry !== 0 && (!runtime || entry !== 1))) continue;
    const command = args.slice(entry + 1);
    const launcher = command[0] === 'harness' && ['ask', 'say'].includes(command[1] ?? '')
      || command[0] === 'dev' && command.some((arg) => arg === '--ask' || arg === '--say' || arg.startsWith('--ask=') || arg.startsWith('--say='))
      || command[0] === 'self' && command[1] === 'orchestrate';
    if (!launcher) continue;
    const namedRunIds = command.flatMap((arg, i) => arg === '--run-id' || arg === '--runId'
      ? [command[i + 1] ?? '']
      : arg.startsWith('--run-id=') || arg.startsWith('--runId=') ? [arg.slice(arg.indexOf('=') + 1)] : []);
    const runMatch = namedRunIds.includes(runId) || command.includes(runId);
    // An explicitly different run takes precedence over a shared goal document.
    if (namedRunIds.some((id) => id !== runId)) continue;
    // A goal path is a positional or option value, not text embedded in a prompt.
    const goalArgs = command.flatMap((arg, i) => {
      if (arg === '--ask' || arg === '--say' || arg === '--goal-file' || arg === '--goal') return [command[i + 1] ?? ''];
      if (arg.startsWith('--ask=') || arg.startsWith('--say=') || arg.startsWith('--goal-file=') || arg.startsWith('--goal=')) return [arg.slice(arg.indexOf('=') + 1)];
      if (i > 0 && (command[i - 1] === '--ask' || command[i - 1] === '--say' || command[i - 1] === '--goal-file' || command[i - 1] === '--goal')) return [];
      if (command[0] === 'harness' && i === 2 && (command[1] === 'ask' || command[1] === 'say')) return [arg];
      if (command[0] === 'self' && command[1] === 'orchestrate' && i === 2) return [arg];
      return [];
    });
    const goalMatch = goalPath !== null && goalArgs.some((arg) => {
      if (isAbsolute(arg)) return isAbsolute(goalPath) && resolve(arg) === resolve(goalPath);
      if (!isAbsolute(goalPath)) return false;
      let cwd: string | null;
      try { cwd = processCwd(pid); } catch { return false; }
      return cwd !== null && isAbsolute(cwd) && resolve(cwd, arg) === resolve(goalPath);
    });
    if (runMatch || goalMatch) candidates.push({ pid, startedAt, via: runMatch ? 'argv-runId' : 'argv-goal' });
  }
  return { status: 'ok', candidates };
}

function stopProcessCwd(pid: number): string | null {
  try {
    if (process.platform === 'linux') return readlinkSync(`/proc/${pid}/cwd`);
    const r = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5_000 });
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout.split(/\r?\n/).find((line) => line.startsWith('n/'))?.slice(1) ?? null;
  } catch { return null; }
}

function scanStopProcessTable(runId: string, goalPath: string | null): StopProcessScan {
  let r: ReturnType<typeof spawnSync>;
  try { r = spawnSync('ps', ['-eo', 'pid=,lstart=,args='], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, TZ: 'UTC' },
  }); }
  catch (error) { return { status: 'failed', reason: String(error) }; }
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return { status: 'failed', reason: String(r.error ?? r.stderr ?? `ps status ${r.status}`) };
  return discoverStopProcesses(runId, goalPath, r.stdout, stopProcessCwd);
}

export interface HarnessStopDeps {
  readPidRecord: (runId: string) => PidRecord | null;
  runIdCandidates?: (given: string) => string[];
  readGoalPath: (runId: string) => string | null;
  scanProcesses: (runId: string, goalPath: string | null) => StopProcessScan;
  /** 살아 있는 프로세스의 시작 시각(ms) · 없으면 null. */
  processStartMs: (pid: number) => number | null;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  kubeContexts: () => string[];
  kubectl: (args: readonly string[]) => { status: number | null; stdout: string; stderr: string };
  namespace: string;
  graceMs: number;
}

export type HarnessStopJobMatchedBy = 'elanous.run' | 'elanous.child-run';

/**
 * 문맥 하나의 Pod Job 삭제 결과(HARNESS-STOP-POD-LABEL) — «0개 지움» 의 종류를 가른다.
 *   deleted N — 라벨 일치 Job N 개 삭제 · none — 두 라벨 다 Job 0(진짜 없음 · Pod 생성 전 등)
 *   unreachable — kubectl 실패(그 0 을 진짜 0 으로 믿을 수 없다) · pods-only — Job 0 인데 같은 라벨 Pod 잔존
 */
export type HarnessStopJobDelete =
  | { context: string; outcome: 'deleted'; matchedBy: HarnessStopJobMatchedBy; deleted: number }
  | { context: string; outcome: 'none'; matchedBy: null; deleted: 0 }
  | { context: string; outcome: 'unreachable'; matchedBy: null; deleted: 0; error: string }
  | { context: string; outcome: 'pods-only'; matchedBy: null; deleted: 0; podsRemaining: number };

export interface HarnessStopResult {
  runId: string;
  givenRunId?: string;
  process: 'stopped' | 'killed' | 'absent' | 'owner-mismatch' | 'unmeasured' | 'dry-run';
  pid?: number;
  candidates: StopProcessCandidate[];
  scanned: boolean;
  pidRecordFound: boolean;
  dryRun: boolean;
  jobsDeleted: number;
  /** 문맥별 Job 삭제 분류 — 출력 한 줄과 `--json` 의 근원. */
  jobDeletes: HarnessStopJobDelete[];
  contexts: string[];
}

export function readPidRecordFrom(runsDir: string, runId: string): PidRecord | null {
  try {
    const value = JSON.parse(readFileSync(join(runsDir, runId, 'pid.json'), 'utf8')) as Partial<PidRecord>;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 1 || !Number.isFinite(value.startedAt)) return null;
    return { pid: value.pid as number, startedAt: value.startedAt as number, ...(typeof value.argv0 === 'string' ? { argv0: value.argv0 } : {}) };
  } catch {
    return null;
  }
}

/** The launching universe's pid.json when the binding names it, else the binding's own pid — both still pass the start-time check. */
export function pidRecordFromLaunchBinding(runId: string, registryDir = launchRegistryDir()): PidRecord | null {
  const binding = readLaunchBinding(runId, registryDir);
  if (!binding) return null;
  const fromRunsDir = binding.runsDir ? readPidRecordFrom(binding.runsDir, runId) : null;
  if (fromRunsDir) return fromRunsDir;
  debug.log('harness.stop', 'pid-from-launch-binding', { runId, pid: binding.pid });
  return { pid: binding.pid, startedAt: binding.startedAt, ...(binding.argv0 ? { argv0: binding.argv0 } : {}) };
}

/** macOS·Linux 공통 — UTC 시작 시각과 상태를 같은 ps 관측에서 읽는다. */
export function psProcessStartMs(pid: number): number | null {
  const r = spawnSync('ps', ['-o', 'lstart=,stat=', '-p', String(pid)], {
    encoding: 'utf8', timeout: 5_000, env: { ...process.env, TZ: 'UTC' },
  });
  if (r.status !== 0) return null;
  const match = /^\s*((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S+)\s*$/.exec(r.stdout);
  if (!match || match[2]!.startsWith('Z')) return null;
  const ms = Date.parse(`${match[1]!} GMT`);
  return Number.isFinite(ms) ? ms : null;
}

export function defaultHarnessStopDeps(overrides: Partial<HarnessStopDeps> = {}, opts: { launchRegistryDir?: string } = {}): HarnessStopDeps {
  const registry = opts.launchRegistryDir ?? launchRegistryDir();
  const env = { ...process.env };
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[key];
  const kubectl = (args: readonly string[]) => {
    const r = spawnSync('kubectl', [...args], { encoding: 'utf8', timeout: 15_000, env });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') };
  };
  return {
    // This universe first; then the host-wide launch binding, so a run launched from another worktree is still found.
    readPidRecord: (runId) => readPidRecordFrom(selfDevRunsDir(), runId) ?? pidRecordFromLaunchBinding(runId, registry),
    runIdCandidates: (given) => {
      const ledgerDirs = new Set([runLedgerDir(), ...resolveFederatedRunLedgerDirectories({})]);
      const found = new Set(stopRunIdCandidates(given, [...ledgerDirs], selfDevRunsDir()));
      for (const id of launchBindingRunIds(registry)) if (id.startsWith(given) && FULL_RUN_ID.test(id)) found.add(id);
      return [...found].sort();
    },
    readGoalPath: (runId) => {
      let fromLedger: string | null = null;
      try { fromLedger = stopGoalPathFromLedger(runId); } catch { fromLedger = null; }
      return fromLedger ?? readLaunchBinding(runId, registry)?.goalPath ?? null;
    },
    scanProcesses: scanStopProcessTable,
    processStartMs: psProcessStartMs,
    kill: (pid, signal) => { process.kill(pid, signal); },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    kubeContexts: () => {
      const r = kubectl(['config', 'get-contexts', '-o', 'name']);
      return r.status === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
    },
    kubectl,
    namespace: 'elanous-test',
    graceMs: 10_000,
    ...overrides,
  };
}

/** Pod Job 라벨 — `elanous.run` = 부모(오케스트레이터) 런 id · `elanous.child-run` = 자식 런 id(self-implement-pod podRunLabels). */
const POD_JOB_LABELS = ['elanous.run', 'elanous.child-run'] as const;

/** `kubectl get -o name` 출력에서 `<prefix>` 로 시작하는 줄 수를 센다. */
function countOutputLines(stdout: string, prefix: string): number {
  return stdout.split('\n').filter((line) => line.startsWith(prefix)).length;
}

/**
 * `kubectl delete job -o name` 출력에서 삭제된 Job 줄 수를 센다.
 * `-o name` 출력은 `job.batch/<name>` 한 줄씩이지만, 일부 kubectl 버전·설정에서는
 * `job.batch "<name>" deleted` 꼴도 나타난다(#26194). 두 꼴을 모두 센다.
 */
function countDeletedJobLines(stdout: string): number {
  return stdout.split('\n').filter((line) => /^job\.batch(?:\/|\s+")/.test(line.trim())).length;
}

/** 문맥 하나의 Pod Job 삭제 — 결과를 넷(deleted·none·unreachable·pods-only)으로 가르고 문맥마다 관측 `harness.stop` `job-delete` 를 남긴다. */
function deleteRunPodJobs(deps: HarnessStopDeps, runId: string, context: string): HarnessStopJobDelete {
  const unreachable = (stderr: string): HarnessStopJobDelete => {
    const error = stderr.slice(0, 200);
    debug.log('harness.stop', 'job-delete', { runId, context, outcome: 'unreachable', matchedBy: null, error }, { level: 'warn' });
    return { context, outcome: 'unreachable', matchedBy: null, deleted: 0, error };
  };
  // ① `elanous.run=<runId>` — 0 이면 `elanous.child-run=<runId>` 로 한 번 더 고른다(자식 런 id 로 쳤을 때). 지우는 것은 라벨 일치 Job 뿐이다.
  for (const label of POD_JOB_LABELS) {
    // `-o name` → «job.batch/<name>» 한 줄씩. 맨 출력은 «job.batch "<name>" deleted» 라 «job.batch/» 로만 세면
    //   지워도 늘 0 이었다(10-11 · 여섯 번 «0개 지움» 뒤 Pod Terminating). 두 꼴을 다 센다(#26194).
    const r = deps.kubectl(['--context', context, '-n', deps.namespace, 'delete', 'job', '-l', `${label}=${runId}`, '--wait=false', '-o', 'name']);
    if (r.status !== 0) return unreachable(r.stderr);
    const deleted = countDeletedJobLines(r.stdout);
    if (deleted > 0) {
      debug.log('harness.stop', 'job-delete', { runId, context, outcome: 'deleted', matchedBy: label, deleted });
      return { context, outcome: 'deleted', matchedBy: label, deleted };
    }
  }
  // ② 두 라벨 다 Job 0 — 같은 라벨 Pod(`get pods -l <라벨>=<runId>`)로 none 과 pods-only 를 가른다. Pod 는 직접 지우지 않는다.
  for (const label of POD_JOB_LABELS) {
    const p = deps.kubectl(['--context', context, '-n', deps.namespace, 'get', 'pods', '-l', `${label}=${runId}`, '-o', 'name']);
    if (p.status !== 0) return unreachable(p.stderr);
    const podsRemaining = countOutputLines(p.stdout, 'pod/');
    if (podsRemaining > 0) {
      debug.log('harness.stop', 'job-delete', { runId, context, outcome: 'pods-only', matchedBy: null, podsRemaining });
      return { context, outcome: 'pods-only', matchedBy: null, deleted: 0, podsRemaining };
    }
  }
  debug.log('harness.stop', 'job-delete', { runId, context, outcome: 'none', matchedBy: null });
  return { context, outcome: 'none', matchedBy: null, deleted: 0 };
}

export async function stopHarnessRun(runId: string, deps: HarnessStopDeps, contexts?: readonly string[], dryRun = false): Promise<HarnessStopResult> {
  if (!RUN_ID.test(runId)) throw new Error(`invalid run id: ${runId}`);
  const given = runId;
  if (!FULL_RUN_ID.test(given)) {
    const matches = [...new Set(deps.runIdCandidates?.(given) ?? [])].sort();
    if (matches.length === 1) runId = matches[0]!;
    debug.log('harness.stop', 'run-id-resolved', { given, resolved: runId, candidates: matches });
    if (matches.length > 1) throw new AmbiguousHarnessStopRunIdError(given, matches);
  }
  // ── ⓐ 프로세스 ────────────────────────────────────────────
  let processState: HarnessStopResult['process'] = 'absent';
  const record = deps.readPidRecord(runId);
  let scan: StopProcessScan;
  let goalPath: string | null = null;
  try { goalPath = deps.readGoalPath(runId); }
  catch { /* 원장 판독 실패 — runId 단독 대조 */ }
  try { scan = deps.scanProcesses(runId, goalPath); }
  catch (error) { scan = { status: 'failed', reason: String(error) }; }
  const candidates: StopProcessCandidate[] = [];
  const seen = new Set<number>();
  const add = (candidate: StopProcessCandidate) => {
    if (!seen.has(candidate.pid)) { seen.add(candidate.pid); candidates.push(candidate); }
  };
  let recordMismatch = false;
  if (record) {
    const recordedStart = deps.processStartMs(record.pid);
    if (recordedStart !== null && Math.abs(recordedStart - record.startedAt) <= START_TOLERANCE_MS) {
      add({ pid: record.pid, startedAt: recordedStart, via: 'pid.json' });
    } else if (recordedStart !== null) { processState = 'owner-mismatch'; recordMismatch = true; }
  }
  if (scan.status === 'ok') {
    for (const candidate of scan.candidates) {
      if (candidate.pid !== record?.pid || !recordMismatch) add(candidate);
    }
  }
  debug.log('harness.stop', 'process-candidates', { runId, found: candidates.map(({ via, pid }) => ({ via, pid })), scanned: scan.status === 'ok' });
  if (dryRun) processState = 'dry-run';
  else {
    const verified: StopProcessCandidate[] = [];
    for (const candidate of candidates) {
      if (candidate.via === 'pid.json') { verified.push(candidate); continue; }
      const actual = deps.processStartMs(candidate.pid);
      if (actual === null) continue;
      if (Math.abs(actual - candidate.startedAt) > START_TOLERANCE_MS) { processState = 'owner-mismatch'; continue; }
      verified.push(candidate);
    }
    for (const candidate of verified) {
      try { deps.kill(candidate.pid, 'SIGTERM'); } catch { /* 방금 끝났다 */ }
    }
    for (const candidate of verified) {
      processState = 'stopped';
      const step = 250;
      for (let waited = 0; waited < deps.graceMs; waited += step) {
        await deps.sleep(step);
        if (deps.processStartMs(candidate.pid) === null) break;
      }
      const still = deps.processStartMs(candidate.pid);
      const expectedStart = candidate.via === 'pid.json' ? record!.startedAt : candidate.startedAt;
      if (still !== null && Math.abs(still - expectedStart) <= START_TOLERANCE_MS) {
        try { deps.kill(candidate.pid, 'SIGKILL'); processState = 'killed'; } catch { /* 끝났다 */ }
      }
    }
    if (processState === 'absent' && (scan.status === 'failed' || candidates.length > 0)) processState = 'unmeasured';
  }
  // ── ⓑ Pod Job (라벨로만) ───────────────────────────────────
  const targets = dryRun ? [] : contexts && contexts.length > 0 ? [...contexts] : deps.kubeContexts();
  const jobDeletes = targets.map((context) => deleteRunPodJobs(deps, runId, context));
  const jobsDeleted = jobDeletes.reduce((sum, job) => sum + job.deleted, 0);
  const result: HarnessStopResult = { runId, ...(given !== runId ? { givenRunId: given } : {}), process: processState, ...(record ? { pid: record.pid } : {}), candidates, scanned: scan.status === 'ok', pidRecordFound: record !== null, dryRun, jobsDeleted, jobDeletes, contexts: targets };
  debug.log('harness.stop', 'stopped', { runId, process: processState, jobsDeleted, contexts: targets.length });
  return result;
}

export function formatHarnessStop(r: HarnessStopResult): string {
  const label: Record<HarnessStopResult['process'], string> = {
    stopped: '멈춤(SIGTERM)', killed: '멈춤(SIGKILL — 제한 시간 안에 안 끝났다)',
    absent: `못 찾음(pid.json ${r.pidRecordFound ? '확인' : '없음'} · 프로세스 표에서 runId·골 경로 0)`,
    unmeasured: '못 잼(프로세스 표 또는 후보 시작 시각 확인 실패 — 없음이 아님)',
    'dry-run': 'dry-run(신호·Pod Job 삭제 없음)',
    'owner-mismatch': '소유 불일치(건드리지 않음 — PID 가 다른 프로세스로 재사용됐다)',
  };
  return [
    ...(r.givenRunId ? [`↳ ${r.givenRunId} → ${r.runId}(전체)`] : []),
    `harness stop ${r.runId}`,
    `  프로세스: ${label[r.process]}${r.pid ? ` · pid ${r.pid}` : ''}`,
    ...(!r.scanned && r.process !== 'unmeasured' ? ['  프로세스 표: 못 잼(기록 밖 발사 프로세스는 확인하지 못함)'] : []),
    ...r.candidates.map(({ pid, startedAt, via }) => `  후보: pid ${pid} · 시작 ${new Date(startedAt).toISOString()} · ${via}`),
    r.dryRun
      ? `  Pod Job: dry-run(조회·삭제하지 않음 · 라벨 elanous.run=${r.runId})`
      : `  Pod Job: ${r.jobsDeleted}개 지움 (문맥 ${r.contexts.length}개 · 라벨 elanous.run=${r.runId} · child-run 폴백)`,
    ...r.jobDeletes.map(formatHarnessStopJobDelete),
  ].join('\n');
}

/** 문맥 하나의 Pod Job 결과 줄 — none·unreachable·pods-only 는 서로 다른 문면으로 갈라 읽힌다. */
function formatHarnessStopJobDelete(job: HarnessStopJobDelete): string {
  if (job.outcome === 'deleted') return `    ${job.context}: ${job.deleted}개 지움 (라벨 ${job.matchedBy})`;
  if (job.outcome === 'pods-only') return `    ${job.context}: Job 0 · 같은 라벨 Pod ${job.podsRemaining} 남음 (Pod 는 직접 지우지 않는다)`;
  if (job.outcome === 'unreachable') return `    ${job.context}: 못 닿음 (kubectl 실패: ${job.error})`;
  return `    ${job.context}: 없음 (라벨 맞는 Job 0)`;
}
