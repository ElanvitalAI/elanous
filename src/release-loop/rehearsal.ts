import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { stateDirSourceForChild } from '../agent/identity-env.js';
import { sendOutbound } from '../domains/outbound-alert.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { isValidGateHost } from '../self-implement/gate-remote.js';
import { parsePodPool } from '../task-orchestrator/surfaces/pod-pool.js';
import { latestPublishedPreviousVersion, releaseLoopConfig, releaseRehearsalConfig } from '../../scripts/release-loop/unattended-release.js';
import { LEAK_MARKERS, loadExportConfig, selectExportFiles } from '../../scripts/public-export.js';
import { LIGHT_RC_DEFAULT_SHARDS, LIGHT_RC_UNKNOWN_HOST, runLightRc, type LightRcDeps, type LightRcResult } from './light-rc.js';
import { planRehearsalShards, type RehearsalShardPlan, type RehearsalShardPlanDeps } from './rehearsal-shard-plan.js';
import { listSchedules, type ReleaseSchedule } from './release-schedule.js';
import { SPAWN_SYNC_MAX_BUFFER } from '../util/spawn-sync-output.js';
import { HARD_REHEARSAL_POD_SHARDS, hardRehearsalGateArgs, hardRehearsalGateVersion } from '../../scripts/release-loop/gate-radius-live.js';
import { gateSourcePins } from '../../scripts/release-loop/gate-baseline-receipt.js';
import { preflightGateExecutionIdentity, type GatePodExecutionIdentity } from '../../scripts/release-loop/gate-radius-live.js';
import { gateShardLedgerBatchComplete, gateShardLedgerPath, readGateShardLedger } from './gate-shard-ledger.js';
import { gateShardsPath, readGateShards } from './gate-shards.js';
import { createCommandCloudVmAdapter, type CloudVmAdapter } from './cloud-vm-adapter.js';

export type StepId = 'hard-mid' | 'rc-7h' | 'hard-5h' | 'rc-150m';
export type RehearsalOutcome = 'ok' | 'regression' | 'unmeasured' | 'error' | 'no-checkout' | 'checkout-dirty' | 'superseded' | 'interrupted';
export interface HardGateResult {
  outcome: 'ok' | 'regression' | 'unmeasured' | 'error';
  commit: string;
  executor: 'pod' | 'host' | null;
  introduced: string[];
  preexisting: number;
  error?: string;
  receiptRecord?: { available: boolean; reason?: string };
}
export type RehearsalPlan =
  | { status: 'no-schedule' }
  | { status: 'not-yet'; version: string; cutAt: string; nextStepAt: string }
  | { status: 'due'; version: string; cutAt: string; run: StepId | null; supersede: StepId[] }
  | { status: 'nothing-due'; version: string; cutAt: string };

const fixedSteps = [{ id: 'rc-7h', minutes: 420 }, { id: 'hard-5h', minutes: 300 }, { id: 'rc-150m', minutes: 150 }] as const;
const minute = 60_000;
function rehearsalSteps(intervalHours = 12): Array<{ id: StepId; minutes: number }> {
  if (!Number.isSafeInteger(intervalHours) || intervalHours < 8 || intervalHours > 72)
    throw new Error('release.loop.rehearsalHardIntervalHours must be an integer from 8 to 72');
  return [{ id: 'hard-mid', minutes: intervalHours * 60 }, ...fixedSteps];
}

/** Only the earliest future cut is eligible. A missed step is superseded rather than run beside a later one. */
export function planRehearsal(schedules: readonly ReleaseSchedule[], now: Date, stamps: Readonly<Partial<Record<StepId, boolean>>>, intervalHours = 12): RehearsalPlan {
  const current = now.getTime();
  if (!Number.isFinite(current)) throw new Error('now must be a valid date');
  const schedule = schedules.filter(row => Number.isFinite(Date.parse(row.cutAt)) && Date.parse(row.cutAt) > current)
    .sort((a, b) => Date.parse(a.cutAt) - Date.parse(b.cutAt) || a.version.localeCompare(b.version))[0];
  if (!schedule) return { status: 'no-schedule' };
  const { version, cutAt } = schedule;
  const cut = Date.parse(cutAt);
  const steps = rehearsalSteps(intervalHours);
  const open = steps.filter(step => !stamps[step.id]);
  if (!open.length) return { status: 'nothing-due', version, cutAt };
  if (current >= cut - 45 * minute) return { status: 'due', version, cutAt, run: null, supersede: open.map(step => step.id) };
  const latestDue = [...steps].reverse().find(step => current >= cut - step.minutes * minute);
  if (latestDue) {
    const run = stamps[latestDue.id] ? null : latestDue.id;
    const supersede = steps.filter(step => step.minutes > latestDue.minutes && !stamps[step.id]).map(step => step.id);
    if (!run && supersede.length === 0) {
      const next = open.find(step => current < cut - step.minutes * minute);
      if (next) return { status: 'not-yet', version, cutAt, nextStepAt: new Date(cut - next.minutes * minute).toISOString() };
    }
    return { status: 'due', version, cutAt, run, supersede };
  }
  return { status: 'not-yet', version, cutAt, nextStepAt: new Date(cut - open[0]!.minutes * minute).toISOString() };
}

export interface RehearsalRecovery {
  failedShard: string;
  remeasuredFiles: number | null;
  durationMs: number | null;
  poolOverwriteApplied: boolean | null;
  outcome: 'ok' | 'failed';
  error?: string;
}

export interface RehearsalStamp {
  version: string;
  step: StepId;
  cutAt: string;
  outcome: RehearsalOutcome | 'running';
  startedAt: string;
  endedAt?: string;
  sha?: string;
  summary?: string;
  regressionFiles?: string[];
  result?: LightRcResult;
  hardGate?: HardGateResult;
  recovery?: RehearsalRecovery;
  hardGateRunId?: string;
  hardGateLog?: string;
  /** Light rehearsal gate rows are queryable at HQ under this per-step execution identity. */
  lightRcRunId?: string;
  /** B6: an unmeasured hard gate always retains a cause, run id and durable local evidence path. */
  measurementGap?: { cause: string; runId: string; evidence: string };
  shardPlan?: RehearsalShardPlan;
  leakCheck?: { outcome: 'ok' | 'fail'; sha: string; exitCode: number | null; detail?: string };
  selection?: { shards?: number; remote?: string; fullFallback?: { reason: string; plannedShards?: number } };
  notifiedAt?: string;
  ownerPid?: number;
}

export interface RehearsalOptions {
  apply?: boolean;
  checkout?: string;
  ledgerRoot?: string;
  podPool?: string;
  recoveryRun?: string;
  shards?: number;
  remote?: string;
}

export interface RehearsalDeps {
  hardIntervalHours?: number;
  now?: () => Date;
  schedules?: (root: string) => ReleaseSchedule[];
  lightRc?: (version: string, checkout: string, selection: { shards?: number; remote?: string; rehearsalCloudHost?: boolean }, runId?: string) => Promise<LightRcResult>;
  /** Injectable outer host/dispatch boundaries while the rehearsal and light-rc code paths stay real. */
  lightRcDeps?: Omit<LightRcDeps, 'cwd'>;
  hardGate?: (version: string, checkout: string, sha: string, ledgerRoot: string, runId: string, remote?: string, podPool?: string) => Promise<HardGateResult>;
  hardGateGraphPins?: (checkout: string, commit: string) => { graphSha: string; recipeSha: string } | null;
  hardGateIdentity?: (pool: string, env: NodeJS.ProcessEnv, commit?: string) => GatePodExecutionIdentity | null;
  hardGateSpawn?: typeof spawnHardRehearsalGate;
  /** Injectable control-plane boundary; production uses release.rehearsal.cloudVmCommand. */
  cloudVmAdapter?: CloudVmAdapter;
  shardPlan?: typeof planRehearsalShards;
  shardPlanDeps?: RehearsalShardPlanDeps;
  notify?: (text: string) => void | boolean | Promise<void | boolean>;
  git?: (args: string[], cwd: string) => { rc: number | null; stdout: string; stderr?: string };
  leakCheck?: (checkout: string) => { status: number | null; detail?: string };
  resumeGate?: (runId: string, checkout: string) => Promise<{ files: number; durationMs: number; poolOverwriteApplied: boolean; ok: boolean }>;
}

export type RehearsalTickResult = RehearsalPlan & { applied?: boolean; stamps?: RehearsalStamp[]; notificationFailures?: number };

function stampPath(root: string, version: string, step: StepId): string {
  if (!/^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(version)) throw new Error(`invalid release version: ${version}`);
  return join(root, 'release', version, 'rehearsal', `${step}.json`);
}

function rehearsalGraphRunId(): string | undefined {
  const contextPath = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!contextPath) return undefined;
  try {
    const context = JSON.parse(contextPath.trimStart().startsWith('{') ? contextPath : readFileSync(contextPath, 'utf8')) as { graphId?: unknown; runId?: unknown };
    return typeof context.graphId === 'string' && typeof context.runId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(context.runId) ? context.runId : undefined;
  } catch { return undefined; }
}

const defaultGit: NonNullable<RehearsalDeps['git']> = (args, cwd) => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { rc: run.error ? null : run.status, stdout: run.stdout ?? '', stderr: run.error ? String(run.error) : run.stderr ?? '' };
};

function gitResult(git: NonNullable<RehearsalDeps['git']>, args: string[], checkout: string): string {
  const result = git(args, checkout);
  if (result.rc !== 0) throw new Error(`git ${args.join(' ')} rc=${result.rc}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export function rehearsalLeakFailureDetail(stdout: string, stderr: string, spawnError?: string): string {
  try {
    const report = JSON.parse(stdout.trim()) as {
      leaks?: number; hits?: Array<{ marker?: string; file?: string; line?: number; text?: string }>;
    };
    const first = report.hits?.[0];
    if (Number.isSafeInteger(report.leaks) && report.leaks! >= 0) {
      if (!first) return `${report.leaks} hit(s)`;
      return sanitizeRehearsalLeakDetail(`${report.leaks} hit(s) · ${first.marker ?? ''} ${first.file ?? ''}:${first.line ?? ''}`);
    }
  } catch { /* fall through to the process diagnostic */ }
  return 'leak-check produced no structured diagnostic';
}

/** Validate before evidence persistence: JSON and injected checkers are both untrusted diagnostic inputs. */
export function sanitizeRehearsalLeakDetail(detail: string, checkout?: string): string {
  if (detail === 'leak-check produced no structured diagnostic') return detail;
  const parsed = /^(?<count>\d+) hit\(s\) · (?<marker>(?:unknown-marker: )?[a-z][a-z0-9-]{0,63}) (?<file>.+):(?<line>[1-9]\d*)$/.exec(detail);
  if (!parsed?.groups) return 'leak-check produced no structured diagnostic';
  const { count, file, line } = parsed.groups;
  const rawMarker = parsed.groups.marker!.replace(/^unknown-marker: /, '');
  const markerKnown = LEAK_MARKERS.some(item => item.marker === rawMarker) && !parsed.groups.marker!.startsWith('unknown-marker: ');
  const marker = markerKnown ? rawMarker : `unknown-marker: ${rawMarker}`;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(rawMarker)) return 'leak-check produced no structured diagnostic';
  const countValue = Number(count), lineValue = Number(line);
  if (!Number.isSafeInteger(countValue) || countValue < 1 || !Number.isSafeInteger(lineValue) || lineValue < 1)
    return 'leak-check produced no structured diagnostic';
  const parts = file!.split('/');
  if (file!.startsWith('/')
    || /[\p{Cc}]/u.test(file!) || parts.some(part => !part || part === '.' || part === '..'))
    return 'leak-check produced no structured diagnostic';
  if (checkout) {
    try {
      const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: checkout, encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER });
      if (tracked.status !== 0 || tracked.error) return 'leak-check produced no structured diagnostic';
      const publicFiles = selectExportFiles((tracked.stdout ?? '').split('\0').filter(Boolean), loadExportConfig(checkout));
      if (!publicFiles.includes(file!)) return 'leak-check produced no structured diagnostic';
      const checkoutRoot = realpathSync(checkout);
      const realFile = realpathSync(resolve(checkoutRoot, file!));
      if (!realFile.startsWith(`${checkoutRoot}/`))
        return 'leak-check produced no structured diagnostic';
      const sourceLine = readFileSync(realFile, 'utf8').split(/\r?\n/)[lineValue - 1];
      const markerPattern = markerKnown ? LEAK_MARKERS.find(item => item.marker === rawMarker)?.pattern : undefined;
      if (!sourceLine || (markerKnown && !markerPattern?.test(sourceLine))) return 'leak-check produced no structured diagnostic';
    } catch { return 'leak-check produced no structured diagnostic'; }
  }
  return `${countValue} hit(s) · ${marker} ${file}:${lineValue}`;
}

/** Public export checks the pinned rehearsal checkout before any remote RC work. Its output is private and ephemeral. */
export function runRehearsalLeakCheck(checkout: string): { status: number | null; detail?: string } {
  const out = mkdtempSync(join(tmpdir(), 'elanous-rehearsal-export-'));
  try {
    const result = spawnSync('bun', ['scripts/public-export.ts', '--out', join(out, 'export'), '--json', '--all'], {
      cwd: checkout, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status === 0) return { status: 0 };
    return { status: result.status, detail: rehearsalLeakFailureDetail(result.stdout ?? '', result.stderr ?? '', result.error?.message) };
  } finally { rmSync(out, { recursive: true, force: true }); }
}

/** Run the exact hard-gate subprocess with an isolated clock budget for timeout replay. */
export function spawnHardRehearsalGate(opts: {
  binary: string; args: string[]; checkout: string; ledgerRoot: string; logPath: string; progressFile?: string; timeoutMs: number; sha: string;
}): HardGateResult {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const log = openSync(opts.logPath, 'wx', 0o600);
  let run: ReturnType<typeof spawnSync>;
  try {
    run = spawnSync(opts.binary, opts.args, {
      cwd: opts.checkout, encoding: 'utf8', stdio: ['ignore', log, log], timeout: opts.timeoutMs,
      env: { ...process.env, ELANOUS_STATE_DIR: opts.ledgerRoot, ELANOUS_STATE_DIR_SOURCE: stateDirSourceForChild(opts.ledgerRoot),
        ...(opts.progressFile ? { ELANOUS_GATE_PROGRESS_FILE: opts.progressFile } : {}) },
    });
  } finally { closeSync(log); }
  return parseHardRehearsalGateResult(run, opts.logPath, opts.sha);
}

function parseHardRehearsalGateResult(run: ReturnType<typeof spawnSync>, logPath: string, sha: string): HardGateResult {
  // stdout and stderr stream to the claim's durable evidence while the child is still running.
  const output = readFileSync(logPath, 'utf8');
  const line = output.split(/\r?\n/).reverse().find(value => value.trim().startsWith('{'));
  if (!line) throw new Error(`hard rehearsal gate produced no JSON (rc=${run.status ?? 'spawn'}${run.error ? `: ${run.error.message}` : ''}; log ${logPath})`);
  const result = JSON.parse(line) as HardGateResult;
  if (!['ok', 'regression', 'unmeasured', 'error'].includes(result.outcome) || !Array.isArray(result.introduced)
      || result.introduced.some(item => typeof item !== 'string')) {
    throw new Error('hard rehearsal gate result lacks a valid verdict');
  }
  if (result.outcome !== 'error' && (result.commit !== sha || result.executor !== 'pod')) {
    throw new Error('hard rehearsal gate result lacks pinned commit, Pod executor or verdict evidence');
  }
  if (result.outcome === 'ok' && result.introduced.length) throw new Error('hard rehearsal gate ok verdict contains introduced failures');
  if (run.status === 0 && result.outcome === 'ok') return result;
  if (run.status === 1 && result.outcome === 'regression') return result;
  if (run.status === 2 && result.outcome === 'error') return result;
  throw new Error(`hard rehearsal gate rc=${run.status ?? 'spawn'} disagrees with outcome=${result.outcome}`);
}

/** The hard rehearsal runs the release gate remotely and confirms its structured receipt was persisted. */
function hardGateReceiptRecordMismatch(input: {
  version: string;
  head40: string;
  gateCommit?: unknown;
  receipt?: { valid?: unknown; reason?: unknown; version?: unknown; commit?: unknown; head40?: unknown;
    graphSha?: unknown; recipeSha?: unknown; envFingerprint?: unknown; imageDigest?: unknown; executionIdentity?: unknown };
  graphPins: { graphSha: string; recipeSha: string } | null;
  expectedIdentity?: GatePodExecutionIdentity | null;
}): string | null {
  const { receipt, graphPins, version, head40 } = input;
  if (!receipt) return 'release gate baseline receipt absent';
  if (!graphPins) return 'receipt graph/recipe source pins unavailable';
  if (input.gateCommit !== head40 || receipt.commit !== head40 || receipt.head40 !== head40)
    return 'receipt baseline head differs from rehearsal head';
  if (receipt.valid !== true) return `release gate receipt invalid: ${String(receipt.reason ?? 'unknown')}`;
  if (receipt.version !== version) return 'receipt release version absent or mismatched';
  if (receipt.graphSha !== graphPins.graphSha || receipt.recipeSha !== graphPins.recipeSha)
    return 'receipt graph/recipe source pins differ from recorded commit';
  if (typeof receipt.imageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(receipt.imageDigest))
    return 'receipt image digest absent or invalid';
  const runtime = receipt.executionIdentity as { bunVersion?: unknown; platform?: unknown; architecture?: unknown; envFingerprint?: unknown } | undefined;
  if (!runtime || typeof runtime.bunVersion !== 'string' || typeof runtime.platform !== 'string'
    || typeof runtime.architecture !== 'string' || typeof runtime.envFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/i.test(runtime.envFingerprint)
    || receipt.envFingerprint !== runtime.envFingerprint) return 'receipt runtime or environment fingerprint absent';
  if (input.expectedIdentity === null) return 'selected gate execution identity unavailable';
  if (input.expectedIdentity) {
    const expected = input.expectedIdentity;
    for (const field of ['imageDigest', 'bunVersion', 'platform', 'architecture', 'envFingerprint'] as const) {
      const actual = field === 'imageDigest' ? receipt.imageDigest : field === 'envFingerprint' ? receipt.envFingerprint : runtime[field];
      if (actual !== expected[field]) return `receipt environment-${field}-mismatch`;
    }
  }
  return null;
}

/** Reuse is allowed only when this release ledger has a complete cut batch for the exact rehearsal gate SHA. */
function hardGateShardLedgerRecordMismatch(ledgerRoot: string, gateVersion: string, commit: string, progressFile: string): string | null {
  let progress: Array<Record<string, unknown>>;
  try {
    progress = readFileSync(progressFile, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid progress row');
      return row as Record<string, unknown>;
    });
  } catch { return 'HQ gate completion evidence unavailable'; }
  const initialPlan = progress.find(row => row.phase === 'shard-planning' && row.shardIndex === 1
    && Number.isSafeInteger(row.shardTotal) && Number(row.shardTotal) >= HARD_REHEARSAL_POD_SHARDS);
  const plannedShardCount = initialPlan?.shardTotal;
  if (!Number.isSafeInteger(plannedShardCount)) return 'HQ gate completion shard plan unavailable';
  const planRows = progress.filter(row => row.phase === 'shard-planning' && row.shardTotal === plannedShardCount
    && Number.isSafeInteger(row.shardIndex) && Number(row.shardIndex) >= 1 && Number(row.shardIndex) <= Number(plannedShardCount)
    && typeof row.shard === 'string' && row.shard.trim());
  const shardByIndex = new Map(planRows.map(row => [Number(row.shardIndex), String(row.shard)]));
  if (shardByIndex.size !== Number(plannedShardCount) || new Set(shardByIndex.values()).size !== shardByIndex.size
    || Array.from({ length: Number(plannedShardCount) }, (_, index) => index + 1).some(index => !shardByIndex.has(index))) {
    return 'HQ gate completion shard plan unavailable';
  }
  const expectedShardIds = Array.from({ length: Number(plannedShardCount) }, (_, index) => shardByIndex.get(index + 1)!);
  const completion = [...progress].reverse().find(row => row.phase === 'collection' && row.state === 'complete');
  const completedShardCount = completion?.shardCount;
  if (!Number.isSafeInteger(completedShardCount) || completedShardCount !== plannedShardCount) return 'HQ gate completion shard plan unavailable';
  const shardPlan = readGateShards(gateShardsPath(gateVersion, ledgerRoot));
  const plannedShardIds = shardPlan?.shards.map(row => row.id) ?? [];
  if (!shardPlan || expectedShardIds.some(id => !plannedShardIds.includes(id))
    || new Set(shardPlan.shards.map(row => row.id)).size !== shardPlan.shards.length) return 'HQ gate shard plan incomplete';
  const ledger = readGateShardLedger(gateShardLedgerPath(gateVersion, ledgerRoot));
  if (!ledger) return 'HQ shard ledger has no completed batch';
  if (ledger.trailingPartial || ledger.malformed) return 'HQ shard ledger is malformed or unterminated';
  const matching = ledger.rows.filter(row => row.version === gateVersion && row.commit === commit && row.phase === 'cut');
  const groups = new Map<string, typeof matching>();
  for (const row of matching) if (row.batchId) groups.set(row.batchId, [...(groups.get(row.batchId) ?? []), row]);
  if (!groups.size) return 'HQ shard ledger has no completed batch';
  for (const [batchId, rows] of groups) {
    const first = rows[0]!;
    const shardIds = plannedShardIds;
    if (gateShardLedgerBatchComplete(rows, { batchId, version: gateVersion, commit, phase: 'cut', observedAt: first.observedAt, shardIds })) return null;
  }
  return 'HQ shard ledger batch is incomplete';
}

function validateRehearsalPodPoolOverride(remote: string | undefined, podPool: string): void {
  if (remote !== 'aws1') throw new Error('hard rehearsal --pod-pool override is reserved for --remote aws1');
  const members = parsePodPool(podPool);
  if (members.length !== 1 || members[0]?.sshHost !== 'aws1') {
    throw new Error('hard rehearsal --pod-pool must isolate exactly one aws1 Pod member');
  }
}

async function runHardGate(version: string, checkout: string, sha: string, ledgerRoot: string, runId: string,
  remote?: string, graphProbe: NonNullable<RehearsalDeps['hardGateGraphPins']> = gateSourcePins,
  identityProbe: NonNullable<RehearsalDeps['hardGateIdentity']> = preflightGateExecutionIdentity,
  gateSpawn: NonNullable<RehearsalDeps['hardGateSpawn']> = spawnHardRehearsalGate,
  podPoolOverride?: string): Promise<HardGateResult> {
  const configuredPool = releaseLoopConfig().gatePodPool;
  if (!configuredPool) throw new Error('hard rehearsal requires release.loop.gatePodPool');
  const targetHost = remote ?? 'node-b';
  const selectedPool = podPoolOverride ?? configuredPool;
  if (podPoolOverride !== undefined) validateRehearsalPodPoolOverride(targetHost, podPoolOverride);
  const members = parsePodPool(selectedPool);
  const gateMember = members.find(member => member.sshHost === targetHost);
  if (!gateMember) {
    if (podPoolOverride !== undefined) throw new Error(`hard rehearsal --pod-pool requires a Pod member for --remote ${targetHost}`);
    throw new Error(`hard rehearsal requires a configured Pod member for --remote ${targetHost}`);
  }
  const pool = selectedPool.split(',').map(part => part.trim())
    .find(part => part.split(/[#:]/, 1)[0] === `${gateMember.context}@${gateMember.sshHost}`);
  if (!pool) throw new Error(`hard rehearsal cannot isolate the ${targetHost} Pod member`);
  const previous = latestPublishedPreviousVersion(version, ledgerRoot);
  const logPath = join(ledgerRoot, 'release', version, 'rehearsal', `${runId}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  let graphPins: { graphSha: string; recipeSha: string } | null = null;
  let expectedIdentity: GatePodExecutionIdentity | null = null;
  let identityProbeError: string | undefined;
  try { expectedIdentity = identityProbe(pool, process.env, sha); if (!expectedIdentity) identityProbeError = 'selected gate execution identity unavailable'; }
  catch (error) { identityProbeError = oneLine(error instanceof Error ? error.message : String(error)); }
  if (podPoolOverride !== undefined && !expectedIdentity) {
    const reason = identityProbeError ?? 'selected aws1 Pod execution identity unavailable';
    return { outcome: 'unmeasured', commit: sha, executor: 'pod', introduced: [], preexisting: 0,
      error: reason, receiptRecord: { available: false, reason } };
  }
  let graphProbeError: string | undefined;
  try { graphPins = graphProbe(checkout, sha); }
  catch (error) { graphProbeError = oneLine(error instanceof Error ? error.message : String(error)); }
  const gateVersion = hardRehearsalGateVersion(version, runId);
  const result = gateSpawn({
    binary: 'bun', args: hardRehearsalGateArgs(version, runId, sha, previous, pool),
    checkout, ledgerRoot, logPath, progressFile: join(ledgerRoot, 'release', version, 'rehearsal', `${runId}.gate-progress.jsonl`),
    timeoutMs: 4 * 60 * 60_000, sha,
  });
  let reason: string | undefined;
  try {
    const verdict = JSON.parse(readFileSync(join(ledgerRoot, 'release', gateVersion, 'gate-verdict.json'), 'utf8')) as {
      commit?: unknown; baselineReceipt?: Parameters<typeof hardGateReceiptRecordMismatch>[0]['receipt'];
    };
    reason = [graphProbeError ? `receipt source pins could not be read: ${graphProbeError}` : undefined,
      identityProbeError ? `receipt identity preflight failed: ${identityProbeError}` : undefined,
      hardGateReceiptRecordMismatch({ version: gateVersion, head40: sha, gateCommit: verdict.commit,
        receipt: verdict.baselineReceipt, graphPins, expectedIdentity }) ?? undefined,
      hardGateShardLedgerRecordMismatch(ledgerRoot, gateVersion, sha, join(ledgerRoot, 'release', version, 'rehearsal', `${runId}.gate-progress.jsonl`)) ?? undefined].filter(Boolean).join(' · ') || undefined;
  } catch (error) {
    reason = [graphProbeError ? `receipt source pins could not be read: ${graphProbeError}` : undefined,
      identityProbeError ? `receipt identity preflight failed: ${identityProbeError}` : undefined,
      `gate receipt readback failed: ${oneLine(error instanceof Error ? error.message : String(error))}`].filter(Boolean).join(' · ');
  }
  return { ...result, receiptRecord: reason ? { available: false, reason } : { available: true } };
}

function oneLine(text: string): string { return text.replace(/\s+/g, ' ').trim(); }

function outcomeLine(stamp: RehearsalStamp): string {
  const head = `${stamp.outcome === 'regression' || stamp.outcome === 'error' || stamp.outcome === 'interrupted' ? '⛔' : '🧪'} 리허설 ${stamp.version} ${stamp.step} · ${stamp.outcome}`;
  if (stamp.outcome === 'no-checkout') return `${head} · ELANOUS_REHEARSAL_GIT_CWD=<깨끗한 체크아웃> 설정 필요`;
  if (stamp.outcome === 'checkout-dirty') return `${head} · 체크아웃 변경을 보존했다`;
  if (!stamp.result) return `${head}${stamp.summary ? ` · ${stamp.summary}` : ''}`;
  const result = stamp.result;
  const duration = Math.max(0, Math.round((Date.parse(stamp.endedAt!) - Date.parse(stamp.startedAt)) / minute));
  const planningGap = stamp.shardPlan?.unmeasured
    || (stamp.selection?.shards !== undefined && result.shards !== stamp.selection.shards)
    || (stamp.selection?.remote !== undefined && result.remote !== stamp.selection.remote);
  const detail = stamp.summary && (stamp.selection?.fullFallback || stamp.outcome === 'unmeasured' || stamp.outcome === 'error' && planningGap) ? ` · ${stamp.summary}` : '';
  return `${head} · 새 회귀 ${result.introduced ?? 'UNKNOWN'} · 기존 ${result.preexisting ?? 'UNKNOWN'} · 미분류 ${result.unclassified ?? 'UNKNOWN'} · ${result.remote ?? 'local'} · ${duration}분${stamp.outcome === 'error' ? ` · gate rc ${result.gateExitCode}${!result.ok ? ' · RC 실패' : ''}` : ''}${stamp.regressionFiles?.length ? ` · 파일 ${stamp.regressionFiles.slice(0, 3).join(', ')}` : ''}${detail}`;
}

function persistStamp(path: string, stamp: RehearsalStamp): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(stamp)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** A stamp that cannot be parsed (e.g. written by an older build that crashed mid-write) is reported, never re-run. */
function readStampFile(path: string): RehearsalStamp | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as RehearsalStamp; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    debug.log('release.rehearsal', 'stamp-unreadable', { path, error: oneLine(String(error)) });
    return null;
  }
}

function ownerIsDead(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

function aged(startedAt: string, now: number): boolean {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) && now - started > 15 * minute;
}

/**
 * Exclusive lock without ever removing another process's lock. Generation `<base>`, `<base>.1`, … is created with
 * wx and carries `{ pid, token }`. A generation whose holder is gone (or an empty/unreadable one older than a
 * minute — a crash inside the create) is skipped, never unlinked, so two contenders recovering the same dead lock
 * still race on one wx create. A live, fresh-unreadable holder stops the scan (fail closed; a later tick retries).
 * There is no generation cap: a dead generation only exists after a crash, so the scan is always finite.
 * Returns a release function that removes only the acquired generation.
 */
function acquireGenerationLock(base: string): { release: () => void } | null {
  const contents = JSON.stringify({ pid: process.pid, token: randomUUID() });
  for (let generation = 0; ; generation++) {
    const path = generation ? `${base}.${generation}` : base;
    try { writeFileSync(path, contents, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder: { pid?: number } | null = null;
      try { holder = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number }; } catch { holder = null; }
      if (holder) { if (ownerIsDead(holder.pid)) continue; return null; }
      try { if (Date.now() - statSync(path).mtimeMs > minute) continue; }
      catch (inner) { if ((inner as NodeJS.ErrnoException).code === 'ENOENT') { generation--; continue; } }
      return null;
    }
    return {
      // Only this process ever writes or removes this generation, so removing it is race-free.
      release: () => { try { if (readFileSync(path, 'utf8') === contents) unlinkSync(path); } catch (inner) { if ((inner as NodeJS.ErrnoException).code !== 'ENOENT') throw inner; } },
    };
  }
}

/** A notification lock only fences delivery, never the RC claim. A living sender is never evicted for elapsed time alone. */
async function deliverStamp(path: string, notify: NonNullable<RehearsalDeps['notify']>, now: NonNullable<RehearsalDeps['now']>): Promise<boolean> {
  const lock = acquireGenerationLock(`${path}.notify.lock`);
  if (!lock) return false;
  try {
    const stamp = JSON.parse(readFileSync(path, 'utf8')) as RehearsalStamp;
    if (!stamp.endedAt || stamp.notifiedAt) return true;
    try {
      if (await notify(outcomeLine(stamp)) === false) {
        debug.log('release.rehearsal', 'notify-failed', { version: stamp.version, step: stamp.step, outcome: stamp.outcome });
        return false;
      }
      stamp.notifiedAt = now().toISOString();
      persistStamp(path, stamp);
      return true;
    } catch (error) {
      debug.log('release.rehearsal', 'notify-failed', { version: stamp.version, step: stamp.step, outcome: stamp.outcome, error: oneLine(String(error)) });
      return false;
    }
  } finally {
    lock.release();
  }
}

/**
 * The running→interrupted transition is exclusive: only the tick holding the interrupt lock may re-read and rewrite
 * the stamp, so a loser never writes from its stale read and cannot clobber the winner's `notifiedAt`.
 */
function interruptStamp(path: string, saved: RehearsalStamp, now: Date): RehearsalStamp | null {
  const lock = acquireGenerationLock(`${path}.interrupt.lock`);
  if (!lock) {
    debug.log('release.rehearsal', 'step-claimed-elsewhere', { version: saved.version, step: saved.step, outcome: 'interrupted' });
    return null;
  }
  try {
    const latest = JSON.parse(readFileSync(path, 'utf8')) as RehearsalStamp;
    if (latest.outcome !== 'running' || latest.endedAt || latest.startedAt !== saved.startedAt || latest.ownerPid !== saved.ownerPid || !ownerIsDead(latest.ownerPid)) return null;
    if (latest.step === 'hard-mid' || latest.step === 'hard-5h') {
      // The claim stores this identity atomically. Older running stamps may lack it, so recovery mints one.
      const runId = latest.hardGateRunId || `hard-${randomUUID()}`;
      const evidence = join(dirname(path), `${runId}.log`);
      const cause = `hard rehearsal process ended before a gate verdict (pid ${latest.ownerPid})`;
      appendFileSync(evidence, `${cause}\n`, { mode: 0o600 });
      latest.hardGateRunId = runId;
      latest.hardGateLog = evidence;
      latest.measurementGap = { cause, runId, evidence };
      latest.summary = `${cause} · runId ${runId} · evidence ${evidence}`;
    } else latest.summary = '실행 프로세스 종료 · RC 재실행 안 함';
    latest.outcome = 'interrupted';
    latest.endedAt = now.toISOString();
    persistStamp(path, latest);
    return latest;
  } finally {
    lock.release();
  }
}

/** A started RC claim is permanent; a preflight with no runnable shards releases its claim for the next tick. */
export async function runRehearsalTick(opts: RehearsalOptions = {}, deps: RehearsalDeps = {}): Promise<RehearsalTickResult> {
  if (opts.shards !== undefined && (!Number.isSafeInteger(opts.shards) || opts.shards < 1)) {
    throw new Error(`release rehearsal tick: invalid --shards count: ${opts.shards}`);
  }
  if (opts.remote !== undefined && !isValidGateHost(opts.remote)) {
    throw new Error(`release rehearsal tick: invalid --remote host: ${opts.remote}`);
  }
  const root = opts.ledgerRoot ?? releaseLedgerRoot();
  const now = (deps.now ?? (() => new Date()))();
  const schedules = (deps.schedules ?? listSchedules)(root);
  const intervalHours = deps.hardIntervalHours ?? releaseLoopConfig().rehearsalHardIntervalHours ?? 12;
  const steps = rehearsalSteps(intervalHours);
  if (!Number.isFinite(now.getTime())) throw new Error('now must be a valid date');
  const candidate = planRehearsal(schedules, now, {}, intervalHours);
  const stamps = candidate.status !== 'no-schedule'
    ? Object.fromEntries(steps.map(step => [step.id, existsSync(stampPath(root, candidate.version, step.id))])) as Partial<Record<StepId, boolean>> : {};
  const plan = planRehearsal(schedules, now, stamps, intervalHours);
  debug.log('release.rehearsal', 'tick', { ...plan, apply: !!opts.apply });
  if (!opts.apply) return plan;
  const written: RehearsalStamp[] = [];
  const notify = deps.notify ?? ((text: string) => sendOutbound(text, 'op-report'));
  const clock = deps.now ?? (() => new Date());
  let notificationFailures = 0;
  const releaseDir = join(root, 'release');
  const versions = existsSync(releaseDir) ? readdirSync(releaseDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : [];
  for (const version of versions) {
    if (!/^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(version)) continue;
    for (const step of steps) {
      const path = stampPath(root, version, step.id);
      if (!existsSync(path)) continue;
      const saved = readStampFile(path);
      if (!saved) continue;
      if (saved.outcome === 'running' && !saved.endedAt && aged(saved.startedAt, now.getTime()) && ownerIsDead(saved.ownerPid)) {
        const interrupted = interruptStamp(path, saved, now);
        if (interrupted) {
          written.push(interrupted);
          debug.log('release.rehearsal', 'step-done', { version, step: step.id, outcome: 'interrupted', summary: interrupted.summary });
        }
      }
      const pending = readStampFile(path);
      if (pending?.endedAt && !pending.notifiedAt && !await deliverStamp(path, notify, clock)) notificationFailures++;
    }
  }
  if (plan.status !== 'due') return { ...plan, ...(written.length ? { stamps: written, applied: true } : {}), notificationFailures };
  const claim = (step: StepId, execute = true): { path: string; stamp: RehearsalStamp } | null => {
    const path = stampPath(root, plan.version, step);
    mkdirSync(dirname(path), { recursive: true });
    const stamp: RehearsalStamp = { version: plan.version, cutAt: plan.cutAt, step, outcome: 'running', startedAt: now.toISOString(), ownerPid: process.pid };
    if (step === 'hard-mid' || step === 'hard-5h') {
      stamp.hardGateRunId = `hard-${randomUUID()}`;
      stamp.hardGateLog = join(dirname(path), `${stamp.hardGateRunId}.log`);
    } else if (execute) {
      stamp.lightRcRunId = rehearsalGraphRunId() ?? `light-${randomUUID()}`;
    }
    // Crash-safe exclusive create: the complete JSON is written to a private temp file, then hard-linked into
    // place. link(2) fails with EEXIST like wx, but the stamp can never be observed empty or half-written.
    const temp = `${path}.${process.pid}.${randomUUID()}.claim.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(stamp)}\n`, { mode: 0o600 });
      linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      debug.log('release.rehearsal', 'step-claimed-elsewhere', { version: plan.version, step, outcome: 'running' });
      return null;
    } finally {
      try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return { path, stamp };
  };
  const finish = async (path: string, stamp: RehearsalStamp): Promise<void> => {
    stamp.endedAt = (deps.now ?? (() => new Date()))().toISOString();
    persistStamp(path, stamp);
    written.push(stamp);
    debug.log('release.rehearsal', stamp.outcome === 'superseded' ? 'step-superseded' : 'step-done', { version: stamp.version, step: stamp.step, outcome: stamp.outcome, sha: stamp.sha, summary: stamp.summary });
    if (!await deliverStamp(path, notify, clock)) notificationFailures++;
  };
  for (const step of plan.supersede) {
    const claimed = claim(step, false);
    if (claimed) { claimed.stamp.outcome = 'superseded'; await finish(claimed.path, claimed.stamp); }
  }
  if (plan.run) {
    const claimed = claim(plan.run);
    if (claimed) {
      const { path, stamp } = claimed;
      debug.log('release.rehearsal', 'step-start', { version: plan.version, step: plan.run, outcome: 'running' });
      try {
        const cloudHostStep = plan.run === 'hard-mid' || plan.run === 'rc-7h';
        let cloudVm: CloudVmAdapter | undefined;
        const ensureCloudVmReady = async (): Promise<void> => {
          if (!cloudHostStep || cloudVm) return;
          const configured = deps.cloudVmAdapter;
          const command = configured ? undefined : releaseRehearsalConfig().cloudVmCommand;
          if (!configured && !command) throw new Error('release.rehearsal.cloudVmCommand is not configured; refusing cloud rehearsal without local fallback');
          cloudVm = configured ?? createCommandCloudVmAdapter(command!);
          await cloudVm.start('aws1');
          const status = await cloudVm.status('aws1');
          if (status.state !== 'running') throw new Error(`aws1 status is ${status.state}${status.detail ? ` (${status.detail})` : ''}`);
          debug.log('release.rehearsal', 'cloud-vm-ready', { version: plan.version, step: plan.run, host: 'aws1', state: status.state });
        };
        const postponeCloudStep = async (error: unknown): Promise<RehearsalTickResult> => {
          const reason = oneLine(error instanceof Error ? error.message : String(error));
          stamp.outcome = 'unmeasured';
          stamp.summary = `aws1 start/readiness failed; rehearsal postponed without failover: ${reason}`;
          stamp.endedAt = clock().toISOString();
          unlinkSync(path);
          written.push(stamp);
          debug.log('release.rehearsal', 'cloud-vm-postponed', { version: plan.version, step: plan.run, host: 'aws1', reason });
          try { await notify(stamp.summary); } catch { notificationFailures++; }
          return { ...plan, applied: true, stamps: written, notificationFailures };
        };
        const checkout = opts.checkout?.trim() || process.env.ELANOUS_REHEARSAL_GIT_CWD?.trim();
        if (!checkout) stamp.outcome = 'no-checkout';
        else {
          const git = deps.git ?? defaultGit;
          const status = gitResult(git, ['status', '--porcelain'], checkout);
          if (status) stamp.outcome = 'checkout-dirty';
          else {
            gitResult(git, ['fetch', '-q', 'origin', 'main'], checkout);
            gitResult(git, ['checkout', '-q', '--detach', 'origin/main'], checkout);
            stamp.sha = gitResult(git, ['rev-parse', 'HEAD'], checkout);
            if (!stamp.sha) throw new Error('git rev-parse HEAD returned no sha');
            const leak = (deps.leakCheck ?? runRehearsalLeakCheck)(checkout);
            const statusIsValid = leak.status === null || (Number.isSafeInteger(leak.status) && leak.status >= 0 && leak.status <= 255);
            const leakStatus = statusIsValid ? leak.status : null;
            const leakDetail = leakStatus === 0 ? undefined : sanitizeRehearsalLeakDetail(leak.detail ?? '', checkout);
            stamp.leakCheck = { outcome: leakStatus === 0 ? 'ok' : 'fail', sha: stamp.sha, exitCode: leakStatus,
              ...(leakDetail ? { detail: leakDetail } : {}) };
            if (leakStatus !== 0) throw new Error(`public export leak-check failed (rc=${leakStatus ?? 'spawn'})${leakDetail ? ` · ${leakDetail}` : ''}`);
            if (plan.run === 'hard-5h' || plan.run === 'hard-mid') {
              const targetHost = plan.run === 'hard-mid' ? 'aws1' : opts.remote ?? 'node-b';
              stamp.selection = { shards: 12, remote: targetHost };
              const hardGateRunId = stamp.hardGateRunId;
              const hardGateLog = stamp.hardGateLog;
              if (!hardGateRunId || !hardGateLog) throw new Error('hard rehearsal claim has no evidence identity');
              if (plan.run === 'hard-mid') {
                try { await ensureCloudVmReady(); }
                catch (error) { return await postponeCloudStep(error); }
              }
              const hard = await (deps.hardGate ?? ((version, cwd, sha, ledger, id, host) =>
                runHardGate(version, cwd, sha, ledger, id, host, deps.hardGateGraphPins, deps.hardGateIdentity, deps.hardGateSpawn, opts.podPool)))
                (plan.version, checkout, stamp.sha, root, hardGateRunId, targetHost, opts.podPool);
              const gateReceiptFailure = hard.receiptRecord?.available === true ? undefined
                : hard.receiptRecord?.reason?.trim() || 'HQ gate receipt unavailable';
              const measuredHard = gateReceiptFailure && hard.outcome !== 'error'
                ? { ...hard, outcome: 'unmeasured' as const, error: gateReceiptFailure }
                : hard;
              stamp.hardGate = measuredHard;
              if (!existsSync(hardGateLog)) writeFileSync(hardGateLog, `${JSON.stringify(hard)}\n`, { flag: 'wx', mode: 0o600 });
              if (measuredHard.outcome !== 'error' && (measuredHard.commit !== stamp.sha || measuredHard.executor !== 'pod' || !Array.isArray(measuredHard.introduced)))
                throw new Error('hard rehearsal result did not measure pinned SHA on a Pod');
              if (measuredHard.outcome === 'ok' && measuredHard.introduced.length) throw new Error('hard rehearsal gate ok verdict contains introduced failures');
              stamp.outcome = measuredHard.outcome === 'regression' && measuredHard.introduced.length === 0 ? 'unmeasured' : measuredHard.outcome;
              const cause = stamp.outcome === 'unmeasured' ? (gateReceiptFailure ?? (measuredHard.outcome === 'unmeasured'
                ? measuredHard.error?.trim() || 'hard rehearsal execution identity unavailable' : 'regression verdict has no introduced IDs'))
                : measuredHard.outcome === 'error' ? measuredHard.error?.trim() || 'gate returned error without a cause' : undefined;
              if (cause) stamp.measurementGap = { cause, runId: hardGateRunId, evidence: hardGateLog };
              const introducedCount: number | null = stamp.outcome === 'unmeasured' || stamp.outcome === 'error' ? null : hard.introduced.length;
              const preexistingCount: number | null = introducedCount === null ? null : hard.preexisting;
              const totalFailures: number | null = introducedCount === null || preexistingCount === null ? null : introducedCount + preexistingCount;
              const receiptStatus = gateReceiptFailure ? ` · HQ 원장 영수증 실패: ${gateReceiptFailure}` : '';
              stamp.summary = oneLine(`hard gate ${measuredHard.outcome} · introduced ${introducedCount ?? 'UNKNOWN'} · preexisting ${preexistingCount ?? 'UNKNOWN'} · total failures ${totalFailures ?? 'UNKNOWN'} · 원격 Pod ${targetHost} · 12 shards · runId ${hardGateRunId} · evidence ${hardGateLog}${cause ? ` · ${cause}` : ''}${receiptStatus}`);
            } else {
            const shardPlan = opts.shards === undefined ? (deps.shardPlan ?? planRehearsalShards)(plan.version, root, checkout, { ...deps.shardPlanDeps, remoteGate: true }) : undefined;
            if (shardPlan) stamp.shardPlan = shardPlan;
            const fullFallbackReasons = [
              ...(plan.run === 'rc-7h' && shardPlan && shardPlan.shards !== LIGHT_RC_DEFAULT_SHARDS
                ? [`planned shard count ${shardPlan.shards} does not match the aws1 host-gate contract`] : []),
              ...(shardPlan?.planningGaps ?? []),
              ...(shardPlan?.rssRevisionPending ? ['selected-file memory revision is not verified'] : []),
              ...(shardPlan?.testFiles === null ? ['selected test inventory unavailable'] : []),
              ...(shardPlan?.testFiles === 0 ? ['selected test inventory empty'] : []),
              ...(shardPlan?.gatePlanShards === null ? ['persisted gate shard plan unavailable'] : []),
              ...(opts.shards !== undefined && opts.shards !== LIGHT_RC_DEFAULT_SHARDS ? [`requested shard count ${opts.shards} does not match the full host gate`] : []),
              ...(shardPlan && shardPlan.shards !== LIGHT_RC_DEFAULT_SHARDS ? [`planned shard count ${shardPlan.shards} does not match the full host gate`] : []),
            ];
            const fullFallback = (plan.run === 'rc-150m' || plan.run === 'rc-7h') && fullFallbackReasons.length > 0;
            const selection = {
              shards: plan.run === 'rc-7h' || fullFallback ? LIGHT_RC_DEFAULT_SHARDS : opts.shards ?? shardPlan?.shards,
              remote: plan.run === 'rc-7h' ? 'aws1' : opts.remote,
              ...(plan.run === 'rc-7h' ? { rehearsalCloudHost: true } : {}),
              ...(fullFallback ? { fullFallback: { reason: [...new Set(fullFallbackReasons)].join('; '),
                ...(shardPlan ? { plannedShards: shardPlan.shards } : {}) } } : {}),
            };
            stamp.selection = selection;
            // A missing prior board is a planning gap, not proof that this gate cannot run. The pinned
            // remote RC measures the current checkout with the conservative four-shard host recipe.
            if (plan.run !== 'rc-150m' && (shardPlan?.testFiles === null || shardPlan?.testFiles === 0)) {
              stamp.outcome = 'unmeasured';
              stamp.summary = oneLine(`${shardPlan.testFiles === 0 ? 'no runnable rehearsal shards' : 'rehearsal test inventory unavailable'} · ${shardPlan.unmeasured ?? (shardPlan.testFiles === 0 ? 'selected test files empty' : 'selected test inventory unavailable')}`);
              stamp.endedAt = clock().toISOString();
              // No RC was launched: this claim is not a completed stage. Leave the ledger free for the next tick.
              unlinkSync(path);
              written.push(stamp);
              debug.log('release.rehearsal', 'step-shortage-retry', { version: stamp.version, step: stamp.step, summary: stamp.summary });
              return { ...plan, applied: true, stamps: written, notificationFailures };
            }
            const regressionFiles: string[] = [];
            if (plan.run === 'rc-7h') {
              try { await ensureCloudVmReady(); }
              catch (error) { return await postponeCloudStep(error); }
            }
            const result = await (deps.lightRc ?? ((version, cwd, selected, runId) => runLightRc(version, { ledgerRoot: root, head: stamp.sha, ...selected,
              ...(runId ? { graphRunId: runId } : {}), rehearsalTui: true, log: (line) => {
                for (const entry of line.split(/\r?\n/)) {
                  const file = /^- introduced: (.+?)(?: > |$)/.exec(entry)?.[1];
                  if (file && regressionFiles.length < 3) regressionFiles.push(file);
                }
                console.error(line);
              } }, { ...deps.lightRcDeps, cwd })))(plan.version, checkout, selection, stamp.lightRcRunId);
            stamp.result = result;
            if (opts.recoveryRun && result.unmeasured !== null) {
              const failedShard = result.unmeasured;
              const started = Date.now();
              try {
                const recovered = await deps.resumeGate?.(opts.recoveryRun, checkout);
                if (!recovered) throw new Error('release resume --from gate is unavailable for this rehearsal');
                stamp.recovery = { failedShard, remeasuredFiles: recovered.files, durationMs: recovered.durationMs,
                  poolOverwriteApplied: recovered.poolOverwriteApplied, outcome: recovered.ok ? 'ok' : 'failed',
                  ...(!recovered.ok ? { error: 'resumed gate did not pass' } : {}) };
              } catch (error) {
                stamp.recovery = { failedShard, remeasuredFiles: null, durationMs: Math.max(0, Date.now() - started),
                  poolOverwriteApplied: null, outcome: 'failed',
                  error: oneLine(error instanceof Error ? error.message : String(error)) };
              }
            }
            if (regressionFiles.length) stamp.regressionFiles = regressionFiles;
            const shardMismatch = selection.shards !== undefined && result.shards !== selection.shards
              ? `selected shards ${selection.shards} but RC reported ${result.shards}` : null;
            const remoteMismatch = selection.remote && result.remote !== selection.remote
              ? `requested remote ${selection.remote} but RC reported ${result.remote ?? 'local'}` : null;
            if (shardPlan?.remoteCapacityPending && result.remote && result.remote !== LIGHT_RC_UNKNOWN_HOST
              && !remoteMismatch && result.unmeasured === null
              && result.introduced !== null && result.unclassified === 0 && result.ok
              && result.gateExitCode === 0 && !shardMismatch) {
              // Only the completed RC can validate capacity of the actual remote host. Keep independent
              // selection/RSS gaps; clear just the provisional remote-capacity gap.
              stamp.shardPlan = { ...shardPlan, remoteCapacityPending: false, rssRevisionPending: false,
                remoteCapacityVerifiedBy: result.remote,
                unmeasured: shardPlan.planningGaps?.length ? shardPlan.planningGaps.join('; ') : null };
            }
            const remoteCapacityVerified = plan.run === 'rc-150m' && stamp.shardPlan?.remoteCapacityPending === true
              && result.ok && result.gateExitCode === 0 && result.unmeasured === null && result.unclassified === 0
              && result.remote === selection.remote && !shardMismatch && !remoteMismatch;
            const shardPlanningGap = fullFallback ? null : stamp.shardPlan?.unmeasured
              ?.replace(remoteCapacityVerified ? /(?:^|; )remote gate host resources unmeasured before RC(?=; |$)/g : /$^/, '')
              .replace(/^; |; $/g, '') || null;
            const planningGap = shardPlanningGap || shardMismatch || remoteMismatch;
            const missingEvidence = result.introduced === null || result.unclassified === null
              || result.unmeasured !== null || result.unclassified > 0 || !!planningGap;
            stamp.outcome = result.introduced !== null && result.introduced > 0 ? missingEvidence ? 'unmeasured' : 'regression'
              : result.introduced === null || result.unclassified === null || result.unmeasured !== null || result.unclassified > 0 ? 'unmeasured'
              : result.unmeasured === null && (!result.ok || result.gateExitCode !== 0) ? 'error'
              : planningGap ? 'unmeasured' : 'ok';
            stamp.summary = oneLine(`light gate runId ${stamp.lightRcRunId} · introduced ${result.introduced ?? 'UNKNOWN'} · preexisting ${result.preexisting ?? 'UNKNOWN'} · unclassified ${result.unclassified ?? 'UNKNOWN'} · ${result.remote ?? 'local'} · gate rc ${result.gateExitCode}${!result.ok ? ' · RC 실패' : ''}${result.unmeasured !== null ? ` · unmeasured: ${result.unmeasured || 'RC reason empty'}` : ''}${fullFallback ? ` · full-shards fallback (${selection.shards}): ${selection.fullFallback?.reason}` : shardPlanningGap ? ` · unmeasured: ${shardPlanningGap}` : ''}${shardMismatch ? ` · unmeasured: ${shardMismatch}` : ''}${remoteMismatch ? ` · unmeasured: ${remoteMismatch}` : ''}`);
            }
          }
        }
        if (cloudVm && plan.run === 'rc-7h' && stamp.outcome === 'ok' && stamp.result?.hostReceiptPersisted === true) {
          try {
            await cloudVm.stop('aws1');
            const status = await cloudVm.status('aws1');
            debug.log('release.rehearsal', 'cloud-vm-stopped', { version: plan.version, step: plan.run, host: 'aws1', state: status.state });
            if (status.state !== 'stopped') throw new Error(`aws1 stop was not confirmed (state=${status.state})`);
          } catch (error) {
            const reason = oneLine(error instanceof Error ? error.message : String(error));
            stamp.summary = oneLine(`${stamp.summary ?? 'rc-7h completed'} · aws1 stop failed (measurement retained): ${reason}`);
            debug.log('release.rehearsal', 'cloud-vm-stop-warning', { version: plan.version, step: plan.run, host: 'aws1', reason });
            try { await notify(`aws1 stop failed after completed rehearsal measurement; receipt retained: ${reason}`); }
            catch { notificationFailures++; }
          }
        }
      } catch (error) {
        stamp.outcome = 'error';
        const cause = String(error instanceof Error ? error.message : error).split(/\r?\n/, 1)[0] ?? 'unknown error';
        if (stamp.hardGateRunId && stamp.hardGateLog) {
          // The runner opens stderr before launch, so a failed launch or missing JSON may leave an empty file.
          appendFileSync(stamp.hardGateLog, `${cause}\n`, { mode: 0o600 });
          stamp.measurementGap = { cause, runId: stamp.hardGateRunId, evidence: stamp.hardGateLog };
        }
        stamp.summary = oneLine(`${cause}${stamp.hardGateRunId ? ` · runId ${stamp.hardGateRunId} · evidence ${stamp.hardGateLog}` : ''}${stamp.shardPlan?.unmeasured ? ` · unmeasured: ${stamp.shardPlan.unmeasured}` : ''}`);
      }
      if (stamp.hardGateRunId && stamp.hardGateLog && !stamp.measurementGap
        && (stamp.outcome === 'no-checkout' || stamp.outcome === 'checkout-dirty')) {
        const cause = stamp.outcome === 'no-checkout' ? 'hard gate checkout unavailable' : 'hard gate checkout dirty';
        appendFileSync(stamp.hardGateLog, `${cause}\n`, { mode: 0o600 });
        stamp.measurementGap = { cause, runId: stamp.hardGateRunId, evidence: stamp.hardGateLog };
      }
      await finish(path, stamp);
    }
  }
  return { ...plan, applied: true, stamps: written, notificationFailures };
}
