#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { debug, redactSecretText } from '../../src/debug/log.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';
import { landingFreezeMessage, readLandingFreeze } from '../../src/release-loop/landing-freeze.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../src/instance/resolve.js';
import { getElanousConfigDirOverride } from '../../src/elanous-config-dir.js';
import { diffFailures, junitFailures, parseFailures, parseTimedOutFailures } from './gate-diff';
import { loadEnvKnownFailures, splitKnownEnv } from './env-known-failures';
import { loadGateBatchSafe } from './gate-batch-safe';
import { baselineFromCutLogs } from './baseline-from-logs';
import { mergePartialFailures, readPartialPlanResult, testFileOfId, verifyDocsOnlyCarry } from './gate-partial';
import { planGateRadiusShadow, shadowActual, writeGateRadiusShadow, type GateRadiusShadowPlan } from './gate-radius-shadow';
import { planHardRehearsalRadius, partialGateImagesMatch, preflightGateImageDigest } from './gate-radius-live';
import { actualGatePodImageDigest, gateBaselineReceipt, gateEnvFingerprint, gateGraphPins, gateSourcePins,
  POD_SWEEP_INTEGRATION_ONLY } from './gate-baseline-receipt';
export { POD_SWEEP_INTEGRATION_ONLY } from './gate-baseline-receipt';
import { logPlanWalltime, planDurations, readFileMemory } from './shard-plan';
import { defaultGateHostMirrorReaders, resolveGateHostMirror, type GateHostMirror, type GateHostMirrorReaders } from './gate-host-mirror';
import { isGateSpawnLaneFile, planGateSpawnSeparatedShards } from './spawn-lane';
import { GATE_POD_ENV_BASELINE, gateTestBaseline } from '../lib/gate-test-env.js';
export { GATE_POD_ENV_BASELINE } from '../lib/gate-test-env.js';
import { readJunitFileSeconds } from './gate-method';
import { deriveCdpTestPatterns } from '../test-deterministic';
import { emitNodeResult, readGraphContext } from './node-verdict.js';
import { isGateExecutor, type GateExecutor } from './gate-executor.js';
import { runPodCommand, parsePodCpu, podCpuMillis, resolvePodCpu, type RunPodCommandOptions, type PodCommandResult, type PodCpu } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { POD_BUN_CACHE_HOST_PATH, parseInstallSeconds, podBunCacheVolume } from '../../src/task-orchestrator/surfaces/pod-bun-cache.js';
import { PodPoolScheduler, parsePodPool, checkPodPool, defaultRemoteRun, type PodPoolMember } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import { POD_INSTALL_SLOTS_DEFAULT, POD_INSTALL_SLOTS_HOST_PATH, installSlotScript } from '../../src/task-orchestrator/surfaces/pod-install-slots.js';
import { gateDepsInstallScript, parseGateDeps } from '../../src/task-orchestrator/surfaces/pod-gate-deps.js';
import { warmReferenceFromJobArtifacts, writeWarmJobManifest } from './gate-warm-artifacts.js';
import { assessWarmWorkerShadow, parseWarmWorkerReply, type WarmWorkerCommand, type WarmWorkerFileResult, type WarmWorkerKey } from '../../src/task-orchestrator/surfaces/pod-warm-worker-protocol.js';
import type { WarmPodTransportResult } from '../../src/task-orchestrator/surfaces/pod-warm-worker-pod.js';
import { requestWarmPodReplay, finalizeWarmPodReplay, quarantineWarmPodReplay, type WarmReplayResult } from '../../src/task-orchestrator/surfaces/pod-warm-worker-provider.js';
import { resolveWarmPoolProfile } from '../../src/self-implement/pod-warm-pool-profile.js';
import { decideWarmReuse, type WarmReuseSwitchConfig, type WarmReuseEvidence } from '../../src/task-orchestrator/surfaces/pod-warm-switch.js';
import { getUserConfig } from '../../src/user-config.js';
import { gateShardsPath, recordGateShardsVerdict, writeGateShards, type GateShard } from '../../src/release-loop/gate-shards.js';
import { defaultKubectl } from '../../src/task-orchestrator/surfaces/self-implement-pod.js';
import { executeTuiNodeCheck, type ExecutedTuiCheck } from './tui-node-checks.js';
import { runWithReleaseGateTraffic } from './gate-traffic-mode.js';
import { emitPodLifecycle, gatePodLifecycleEvent, gatePodOutcome } from '../../src/task-orchestrator/surfaces/pod-lifecycle-stages.js';
import { gateHostReservationRoot, reserveReleaseGateHosts } from '../../src/release-loop/gate-host-reservation.js';
import { normRoot } from '../../src/instance/resolve.js';

export interface WarmShadowObservation {
  files: string[];
  attemptId: string;
  reason: string;
  status: 'observed' | 'fallback' | 'unmeasured';
  quarantined: 'yes' | 'no' | 'failed' | 'unavailable';
  finalized?: boolean;
  /** Exact producer identity; absent on an old verdict means the sample cannot enable reuse. */
  cutSha?: string;
  baselineSha?: string;
  workerKey?: WarmWorkerKey;
}

/** A provider may fill only lease identity; it cannot rewrite the Job attempt being compared. */
export function warmCommandMatchesRequest(command: WarmWorkerCommand, request: Omit<WarmWorkerCommand, 'leaseId' | 'generation' | 'workerId' | 'key'>): boolean {
  return command.protocol === request.protocol && command.runId === request.runId
    && command.attemptId === request.attemptId && command.cutSha === request.cutSha
    && command.baselineSha === request.baselineSha && command.deadlineAt === request.deadlineAt
    && command.envProfile === request.envProfile && command.files.length === request.files.length
    && command.files.every((file, index) => file === request.files[index]);
}

interface CommandResult { rc: number; output: string; passedIds?: string[]; stalledEnv?: Array<{ file: string; reason: 'no-output' }>; timedOut?: boolean;
  /** Identity and complete selected inventory of this Pod sweep; only the producer may issue it. */
  podSweep?: { id: string; shards: number; files: string[] };
  /** Complete, source-bound one-file Job result for shadow comparison; absent means unmeasured. */
  warmReference?: WarmWorkerFileResult | null;
  warmAttemptId?: string;
  warmShadow?: WarmShadowObservation;
  /** GATE-POD-STALL-FAILFAST ① — shard Pods whose tests the mid-run watch aborted in this sweep. */
  abortedShards?: number;
  /** Each contributing Pod leaf already passed failuresOf; repeated printed ids cannot add new failures. */
  validatedShards?: boolean }
function redactedGateLogTail(input: string): string {
  // Redact before trimming: a truncated token might no longer match the redaction rule.
  const bytes = Buffer.from(redactSecretText(input), 'utf8');
  let start = Math.max(0, bytes.length - 16_384);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}
export interface GateRunner {
  command(cmd: string, args: string[], cwd: string, limitMs?: number): Promise<CommandResult>;
  localCommand(cmd: string, args: string[], cwd: string, limitMs?: number): Promise<CommandResult>;
  /** Run one isolated test on the same Pod image and pinned commit as the sweep. */
  recheckPod?(file: string, commit: string, pod: NonNullable<GateOptions['pod']>, timeoutMs: number, relaxed?: boolean): Promise<CommandResult>;
  /** One checkout/install for a small independent file group; each file retains its own rc and log. */
  recheckPodBatch?(files: readonly string[], commit: string, pod: NonNullable<GateOptions['pod']>, timeoutMs: number): Promise<Map<string, CommandResult>>;
  /** `only` (GATE-PARTIAL) restricts the sweep to these test files; absent = every test file. */
  sweep(tree: string, logDir?: string, pod?: GateOptions['pod'], only?: readonly string[]): Promise<CommandResult>;
  add(tree: string, commit: string): Promise<void>;
  remove(tree: string): Promise<void>;
  snapshot(tree: string, commit: string): Promise<void>;
  removeSnapshot(tree: string): Promise<void>;
  /** Absolute remote bare mirror path, set before preparing the remote trees. */
  remoteMirror?: string;
}
export interface GateOptions {
  commit: string;
  /** The graph run that launched this gate; direct hard rehearsal instead pins source bytes explicitly. */
  graphRunId?: string;
  /** Only a direct hard rehearsal may pin graph bytes from its measured Git commit. */
  rehearsalBaseline?: boolean;
  forceFreeze?: boolean;
  version: string;
  baselineVersion?: string;
  baselineCommit?: string;
  remote?: string;
  remoteMirror?: string;
  /** GATE-HOST-EXECUTOR — `host` ignores every pod option and sweeps on `remote` (required). Absent = today's choice (pod when a pool is set). */
  executor?: GateExecutor;
  instanceRoot?: string;
  ledgerRoot?: string;
  repo?: string;
  /** Rehearsal's opt-in screen measurement; normal release gates keep their existing defaults. */
  rehearsalTui?: boolean;
  /** Files per final recheck window; every window is measured (default 32). */
  recheckFileLimit?: number;
  /** freshShards — GATE-SHARD-RESUME off: every shard starts a Pod even when this logDir already holds its result. */
  pod?: { pool: string; shards?: number; shardTimeoutSeconds?: number; durationSource?: string; bunCache?: string; freshShards?: boolean;
    /** Opt-in gate shadow: provider fills the fenced lease identity. The Job remains authoritative. */
    warmReplay?: (input: Omit<WarmWorkerCommand, 'leaseId' | 'generation' | 'workerId' | 'key'>) => Promise<{ command: WarmWorkerCommand | null; transport: WarmPodTransportResult }>;
    warmQuarantine?: (command: WarmWorkerCommand, reason: string) => Promise<void>;
    warmFinalize?: (command: WarmWorkerCommand) => Promise<void>;
    /** Set only on the cut recheck; baseline Jobs never consume the cut worker. */
    warmCutSha?: string;
    warmBaselineSha?: string;
    warmReuseConfig?: WarmReuseSwitchConfig;
    /** At most three cut isolation files may request a shadow replay per verdict. */
    warmEligible?: boolean;
    /** An explicitly excluded file cannot race for the shared replay budget. */
    warmReplayOwner?: boolean;
    /** Internal budget shared by every recheck in one gate verdict, including timeout retries. */
    warmShadowScope?: { requested: boolean; attempts?: number };
    /** Internal shadow wait cap; a stuck provider cannot hold the Job verdict (tests may lower it). */
    warmShadowTimeoutMs?: number;
    /** Maximum concurrent file-isolation fallback Jobs across the entire sweep; omitted = 4. */
    isolationConcurrency?: number;
    /** GATE-SKIP-KNOWN-RETRY — failure ids the previous release already had (and env-known ones): a shard that fails only
     *  with these is not re-run in isolation; the verdict still classifies them against the baseline as before. */
    knownFailures?: readonly string[];
    /** GATE-SPEED A3① — shard Pod CPU request/limit (`release.loop.gatePodCpu`); omitted = request 1 / limit 4. */
    cpu?: PodCpu;
    /** GATE-HOSTMIRROR-EXPLICIT — host Git mirror for every gate Pod (wins over env/config); omitted = resolved once per
     *  runner by {@link resolveGateHostMirror} (env → config → operating config when isolated → none). */
    hostMirror?: string;
    /** GATE-HOSTMIRROR-EXPLICIT — injected readers (tests · embedders). Absent = the real ones; an injected pool without
     *  them reads env only — never a real config from a test. */
    hostMirrorReaders?: GateHostMirrorReaders;
    /** GATE-INSTALL-CACHE — concurrent `bun install`s per node (`release.loop.gatePodInstallSlots`); omitted = 4 · 0 = off. */
    installSlots?: number;
    /** GATE-MEM-ADMIT — seconds a shard waits for pool admission (memory headroom) before it launches anyway with
     *  `admission-timeout` (`release.loop.gatePodAdmissionWaitSeconds`); omitted = {@link GATE_ADMISSION_WAIT_SECONDS_DEFAULT} · 0 = off. */
    admissionWaitSeconds?: number;
    /** GATE-MEM-ADMIT — an injected admission (tests · embedders); config never sets it. Absent = the gate's own pool's. */
    admission?: GateAdmission;
    /** GATE-POD-STALL-FAILFAST — seconds after the source checkout a shard may go without any test output (outside an
     *  install-slot wait) before it is stopped as unmeasured (`gatePodStallSeconds`); omitted = {@link GATE_POD_STALL_SECONDS_DEFAULT} · 0 = off. */
    stallSeconds?: number;
    /** GATE-POD-STALL-FAILFAST — injected live Pod log reader / Job stop (tests · embedders); config never sets them.
     *  Absent = kubectl on the gate's own pool; an injected pool without `liveLog` runs without the stall watch. */
    liveLog?: (job: { name: string; context?: string }) => string | null;
    /** false = the stop did not take; the watch asks again every poll until it does (void = taken). */
    stopJob?: (job: { name: string; context?: string }) => boolean | void;
    /** Failure-only Pod status and log reader; injected tests never call the live cluster. */
    failureEvidence?: (job: { name: string; context?: string }) => { podName?: string; termination?: { reason?: string; message?: string; exitCode?: number; finishedAt?: string }; logTail?: string; error?: string };
    failureKubectl?: typeof defaultKubectl;
    /** How often the stall watch reads the live log (ms); omitted = {@link GATE_POD_STALL_POLL_MS}. */
    stallPollMs?: number;
    /** GATE-POD-STALL-FAILFAST ① — seconds a shard may go without its part logs growing once test output began, before
     *  only its test process group is ended in the Pod (`gatePodMidRunStallSeconds`); omitted =
     *  {@link GATE_POD_MIDRUN_STALL_SECONDS_DEFAULT} · 0 = off. Needs the stall watch (live log). */
    midRunStallSeconds?: number;
    /** GATE-POD-STALL-FAILFAST ① — injected in-Pod test abort (tests · embedders); false = not taken. Absent = `kubectl exec`
     *  of {@link gateShardAbortScript} on the gate's own pool; an injected pool without it runs without the mid-run watch. */
    abortTests?: (job: { name: string; context?: string }, reason: string) => boolean | void;
    /** GATE-LIVE-OBS — the shard state file (`gateShardsPath(version)`) this sweep keeps current; absent = not written. */
    shardsFile?: { path: string; version: string };
    /** GATE-MULTI-HOST — is this pool member reachable (kubectl ns ⊕ ssh)? Injected by tests; absent = the real probe on
     *  the gate's own pool · an injected pool without it never marks a member down (unchanged). */
    probeMember?: (member: PodPoolMember) => boolean;
    /** GATE-MULTI-HOST — seconds a placed shard's Job status may stay unreadable before the shard counts as lost with its
     *  member; omitted = {@link GATE_MEMBER_UNREADABLE_SECONDS_DEFAULT}. Only a pool of two or more members uses it. */
    memberUnreadableSeconds?: number;
    /** GATE-WARM-BOOT-SCAN — observation only: the sweep's test selection (list · filter · duration plan · shard plan) time. */
    onSelectionTimed?: (timed: { ms: number; files: number }) => void };
}

/** Gate-profile opt-in wires the producer only for the process entry, never a test runner seam. */
export function withWarmGateHooks(opts: GateOptions, config: unknown, injectedRunner = false): GateOptions {
  if (injectedRunner || !opts.pod || resolveWarmPoolProfile(config) !== 'gate') return opts;
  const warmReuseConfig = config && typeof config === 'object' && 'pod' in config
    && config.pod && typeof config.pod === 'object' && 'warmReuse' in config.pod
    ? config.pod.warmReuse as WarmReuseSwitchConfig : undefined;
  return { ...opts, pod: { ...opts.pod, warmReplay: requestWarmPodReplay,
    warmFinalize: finalizeWarmPodReplay, warmQuarantine: quarantineWarmPodReplay, warmReuseConfig } };
}
export interface GateResult {
  outcome: 'ok' | 'regression' | 'error';
  commit: string;
  introduced: string[];
  preexisting: number;
  /** null = not counted (GATE-SPEED A4: the swept baseline ran only the cut's failing files). */
  fixed: number | null;
  knownEnv: number;
  knownEnvCleared: string[];
  stalledEnv: Array<{ file: string; reason: 'no-output' | 'isolated-timeout'; local: 'passed' | 'failed' | 'timeout' }>;
  rcNonzeroNoFailures: Array<{ file: string; rc: number; pass: number; baseline: 'same' | 'clean' | 'missing' }>;
  /** Files left unmeasured after isolated recheck; these cannot seed a reusable baseline. */
  unmeasuredRecheckFiles?: string[];
  /** Shadow only: Job verdict is unchanged even on a worker mismatch or failed quarantine. */
  warmShadow?: WarmShadowObservation[];
  /** GATE-POD-STALL-FAILFAST ① — cut sweep shard Pods ended by the mid-run abort (their files went the timeout way). */
  abortedShards?: number;
  baselineSource?: 'ledger' | 'instance' | 'cut-logs' | 'swept';
  /** GATE-BASELINE-CACHE — isolated baseline files answered from the ledger (hits) or run now (misses). */
  baselineCache?: { hits: number; misses: number };
  /** GATE-SPEED A4 — a swept baseline ran only the cut's failing files that exist at the previous release. */
  baselineDeferred?: { cutFiles: number; swept: number };
  durationMs: number;
  /** GATE-WARM-BOOT-SCAN — observation only: the cut sweep's test selection time (pod sweep · absent otherwise). */
  selectionMs?: number;
  error?: string;
  stalledShards?: Array<{ shard: number; files: string[]; reason: 'incomplete' | 'no-output' | 'job-failed' | 'exit-code' | 'unattributed' | 'timeout'; lastFile?: string; summaryFailures?: number; namedFailures?: number; detail?: string;
    /** Pool member that ran the final unmeasured attempt; enables a bounded cross-host tail remeasure. */
    lastHost?: string;
    /** Failure of the optional cross-host tail attempt; original stall fields remain authoritative. */
    tailRemeasure?: { reason: string; host?: string; detail?: string };
    /** GATE-POD-STALL-FAILFAST — the shard (and its one fresh retry) printed no test output within the stall window: unmeasured. */
    stall?: { seconds: number; sinceCheckoutMs: number } }>;
  partialSummary?: { pass: number; fail: number; errors: number; ran: number; files: number };
  /** Number of complete shards retained when an incomplete sweep is resumed. */
  preservedShardCount?: number;
  /** Completed shard measurements retained when another shard stalled, so same-commit resume can reuse them safely. */
  partialFailures?: SweepFailures;
  /** GATE-PARTIAL — this verdict re-ran only these files and carried the prior gate's results for the rest. */
  partial?: { priorCommit: string; files: number };
  /** GATE-INTRO-RECHECK — new failures that were only the «timed out» shape and passed one isolated re-run with a
   *  {@link GATE_TIMEOUT_RECHECK_MS} per-test limit: a warning (flaky under load), not an introduced regression. */
  loadFlaky?: string[];
  /** File-level unhandled errors that reproduced or could not be measured in isolation. They keep the gate red. */
  unmeasuredErrors?: Array<{ file: string; reason: 'reproduced' | 'timeout' | 'unreadable'; ids: string[] }>;
  /** Shard-only unhandled errors whose file-level replay completed cleanly. */
  interferenceErrors?: string[];
  rehearsalTui?: ExecutedTuiCheck;
}

const sha = /^[0-9a-f]{7,40}$/i;
const versionPattern = /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/;
const failureFile = (root: string, version: string) => join(root, 'release', version, 'gate-failures.json');
/** Judged identities live beside the machine release ledger; gate-failures.json keeps its raw baseline schema. */
const verdictFile = (root: string, version: string) => join(root, 'release', version, 'gate-verdict.json');
const WARM_VERDICT_HISTORY_LIMIT = 5;
const WARM_REPLAY_BUDGET = 3;
interface WarmVerdictSample { version: string; commit: string; baselineCommit: string; warmShadow: WarmShadowObservation[] }
const recordValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** The verdict is atomically replaced; carry a bounded prior-verdict window in that same SSOT. */
function readWarmVerdictHistory(path: string): WarmVerdictSample[] | undefined {
  if (!existsSync(path)) return [];
  try {
    const current = recordValue(JSON.parse(readFileSync(path, 'utf8')));
    if (!current || !Array.isArray(current.warmHistory)) return undefined;
    const history = [...current.warmHistory, { version: current.version, commit: current.commit,
      baselineCommit: current.baselineCommit, warmShadow: current.warmShadow }].slice(-WARM_VERDICT_HISTORY_LIMIT);
    if (history.some((entry) => { const row = recordValue(entry);
      return !row || typeof row.version !== 'string' || typeof row.commit !== 'string'
        || typeof row.baselineCommit !== 'string' || !Array.isArray(row.warmShadow); })) return undefined;
    return history as WarmVerdictSample[];
  } catch { return undefined; }
}
/** Every counted match has a measured, finalized worker with this exact cut, baseline and lock. */
export function warmEvidenceFromVerdicts(history: readonly WarmVerdictSample[] | undefined,
  version: string, head: string, baseline: string, lock: string): WarmReuseEvidence | undefined {
  if (!history?.length || !lock) return undefined;
  const rows = history.flatMap((verdict) => {
    if (verdict.version !== version || verdict.commit !== head || verdict.baselineCommit !== baseline
      || !Array.isArray(verdict.warmShadow)) return [null];
    return verdict.warmShadow.length ? verdict.warmShadow : [null];
  });
  const attempts = new Set<string>();
  const key = rows.at(-1)?.workerKey;
  if (rows.some((entry) => {
    if (entry === null || !recordValue(entry) || !Array.isArray(entry.files) || !recordValue(entry.workerKey)) return true;
    if (typeof entry.attemptId !== 'string' || !entry.attemptId || attempts.has(entry.attemptId)
      || entry.files.length !== 1 || typeof entry.files[0] !== 'string'
      || !/^(?:[\w.-]+\/)*[\w.-]+\.test\.[cm]?[jt]sx?$/.test(entry.files[0])
      || entry.files[0].split('/').some((part) => part === '.' || part === '..')) return true;
    attempts.add(entry.attemptId);
    return entry.cutSha !== head || entry.baselineSha !== baseline || entry.workerKey?.lockHash !== lock
      || typeof entry.workerKey.context !== 'string' || !entry.workerKey.context
      || typeof entry.workerKey.imageDigest !== 'string' || !entry.workerKey.imageDigest
      || typeof entry.workerKey.architecture !== 'string' || !entry.workerKey.architecture
      || entry.workerKey.context !== key?.context || entry.workerKey.imageDigest !== key?.imageDigest
      || entry.workerKey.architecture !== key?.architecture
      || (entry.reason === 'match' && (entry.status !== 'observed' || entry.finalized !== true || entry.quarantined !== 'no'));
  })) return undefined;
  const recentMismatchCount = rows.filter((entry) => entry!.reason !== 'match').length;
  let consecutiveMatchSamples = 0;
  for (const row of [...rows].reverse()) {
    if (row!.status !== 'observed' || row!.reason !== 'match' || row!.finalized !== true) break;
    consecutiveMatchSamples++;
  }
  const latest = rows.at(-1)!;
  return { consecutiveMatchSamples, recentMismatchCount,
    leaseValid: latest!.finalized === true,
    canaryPassed: latest!.status === 'observed' && latest!.reason === 'match' && latest!.finalized === true,
    // A release cut is the pinned main commit; baselineSha is checked separately above.
    expected: { head, main: head, lock }, worker: { head: latest!.cutSha, main: latest!.cutSha, lock: latest!.workerKey!.lockHash } };
}
/** Live reuse is serial and opt-in. Any uncertain lease, reply, or cleanup returns to the fresh Job. */
async function tryWarmGateAdoption(file: string, cutSha: string, baselineSha: string, expectedKey: WarmWorkerKey,
  pod: NonNullable<GateOptions['pod']>): Promise<CommandResult | undefined> {
  if (!pod.warmReplay || !pod.warmFinalize || !pod.warmQuarantine || !pod.warmShadowScope
    || (pod.warmShadowScope.attempts ?? 0) >= WARM_REPLAY_BUDGET) return undefined;
  pod.warmShadowScope.attempts = (pod.warmShadowScope.attempts ?? 0) + 1;
  pod.warmShadowScope.requested = true;
  const waitMs = pod.warmShadowTimeoutMs ?? 150_000;
  const deadline = Date.now() + waitMs;
  const request = { protocol: 1 as const, runId: randomUUID(), attemptId: randomUUID(), cutSha,
    baselineSha, deadlineAt: deadline - 1_000, files: [file], envProfile: 'gate-v1' };
  let command: WarmWorkerCommand | null = null;
  let timedOut = false;
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('warm adoption timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('warm adoption timeout')), remainingMs);
    })]); } finally { if (timer) clearTimeout(timer); }
  };
  try {
    const pending = Promise.resolve().then(() => pod.warmReplay!(request));
    void pending.then((late) => {
      if (timedOut && late.command) void pod.warmQuarantine!(late.command, 'late-adoption-after-timeout')
        .catch((error) => debug.log('release-loop.gate', 'warm-adoption-late-quarantine-failed', { file, error: String(error) }));
    }, () => undefined);
    let replay: WarmReplayResult;
    try { replay = await bounded(() => pending); }
    catch (error) { timedOut = true; throw error; }
    command = replay.command;
    if (!command || replay.transport.status !== 'observed' || replay.transport.reason !== 'complete'
      || !warmCommandMatchesRequest(command, request) || command.key.context !== expectedKey.context
      || command.key.imageDigest !== expectedKey.imageDigest || command.key.lockHash !== expectedKey.lockHash
      || command.key.architecture !== expectedKey.architecture) throw new Error('warm adoption lease or identity');
    const reply = parseWarmWorkerReply(replay.transport.reply);
    const part = reply?.files[0];
    if (!reply || !part || reply.files.length !== 1 || part.file !== file || part.rc !== 0 || part.junitComplete !== true
      || part.failureIds.length !== 0 || part.errorIds.length !== 0
      || reply.runId !== command.runId || reply.attemptId !== command.attemptId || reply.cutSha !== cutSha
      || reply.baselineSha !== baselineSha || reply.leaseId !== command.leaseId || reply.generation !== command.generation
      || reply.workerId !== command.workerId || reply.envProfile !== command.envProfile
      || reply.key.context !== command.key.context || reply.key.imageDigest !== command.key.imageDigest
      || reply.key.lockHash !== command.key.lockHash || reply.key.architecture !== command.key.architecture
      || reply.finishedAt < reply.startedAt || reply.finishedAt > command.deadlineAt) throw new Error('warm adoption result');
    await bounded(() => pod.warmFinalize!(command!));
    debug.log('release-loop.gate', 'warm-adopted-recheck', { file, cutSha, attemptId: command.attemptId });
    return { rc: 0, output: `${file}:\n(pass) warm isolated recheck\n1 pass\n0 fail\nRan 1 test across 1 file.\n` };
  } catch (error) {
    if (command) {
      let quarantineTimer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([pod.warmQuarantine!(command, 'adoption-fallback'),
        new Promise<never>((_, reject) => { quarantineTimer = setTimeout(() => reject(new Error('warm quarantine timeout')), 10_000); })]); }
      catch (fenceError) { debug.log('release-loop.gate', 'warm-adoption-quarantine-failed', { file, error: String(fenceError) }); }
      finally { if (quarantineTimer) clearTimeout(quarantineTimer); }
    }
    debug.log('release-loop.gate', 'warm-adoption-fresh-job', { file, reason: String(error) });
    return undefined;
  }
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const defaultRemoteMirror = '~/mirror/elanous-agent.git';

function check(result: CommandResult, label: string): void {
  if (result.rc !== 0) throw new Error(`${label} failed (rc=${result.rc}): ${result.output.slice(-500)}`);
}

type SweepFailures = { failures: string[]; errors: string[] };

/** Only named, completed JUnit cases can prove a listed failure passed in this cut. */
function junitPassedIds(xml: string): string[] {
  const passed = new Set<string>();
  const suites: string[] = [];
  let file: string | undefined;
  let open: { id: string; passed: boolean } | undefined;
  const decode = (value: string) => value.replace(/&(?:quot|apos|lt|gt|amp|#\d+|#x[\da-fA-F]+);/g, (entity) => {
    const named: Record<string, string> = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
    if (entity in named) return named[entity]!;
    const code = entity.startsWith('&#x') ? Number.parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
  for (const match of xml.matchAll(/<(\/?)\s*(testsuite|testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attrs, selfClosing] = match;
    const attr = (name: string) => { const found = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs!); return found ? decode(found[1]!) : undefined; };
    if (tag === 'testsuite') {
      if (closing) { suites.pop(); if (!suites.length) file = undefined; }
      else if (!selfClosing) { suites.push(attr('name') ?? ''); if (suites.length === 1) file = attr('file') ?? attr('name'); }
    } else if (tag === 'testcase') {
      if (closing) { if (open?.passed) passed.add(open.id); open = undefined; }
      else {
        const name = [...suites.slice(1), attr('name') ?? ''].join(' > ');
        const path = attr('file') ?? file;
        const id = path && name ? `${path} > ${name}` : undefined;
        if (selfClosing) { if (id) passed.add(id); }
        else open = id ? { id, passed: true } : undefined;
      }
    } else if (!closing && open) open.passed = false;
  }
  return [...passed].sort();
}
// A test may spawn a nested `bun test` whose own summary lines land earlier in the same output
// (09-29 0.2.4 gate: «0 fail · Ran 2 tests across 1 file» at line 6765 of a 60064-test sweep) —
// the sweep's own summary is always the «last» one, so read the last match, never the first.
const lastMatch = (output: string, pattern: RegExp): RegExpExecArray | null => {
  let last: RegExpExecArray | null = null;
  for (const m of output.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) last = m as RegExpExecArray;
  return last;
};
const summaryCount = (output: string, label: string) => Number(lastMatch(output, new RegExp(`(?:^|\\n)\\s*(\\d+) ${label}s?\\s*(?=\\n|$)`))?.[1] ?? NaN);
/** bun reads a bare positional as a substring filter (`test` matches every *.test.ts); `./` makes it a path. */
const asPath = (path: string) => path.startsWith('./') || path.startsWith('/') ? path : `./${path}`;
/** A Pod path (`~/repo/src/…` · `../..~/repo/src/…`) as a repository-relative one. */
const podRelative = (path: string) => path.replace(/^(?:\.\.\/)*\/?home\/ubuntu\/repo\//, '');
/** `file > [error]` ids of bun's «Unhandled error between tests» blocks, or undefined when one cannot be attributed. */
function unhandledErrorIds(output: string): string[] | undefined {
  const errors: string[] = [];
  let file: string | undefined;
  for (const raw of output.split(/\r?\n/)) {
    const header = /^(?:\.\/)?((?:[\w.-]+\/)+[\w.-]+\.test\.tsx?):/.exec(raw.trim());
    if (header) file = header[1];
    if (/^# Unhandled error between tests/.test(raw.trim())) {
      if (!file) return undefined;
      errors.push(`${file} > [error]`);
    }
  }
  return errors;
}
/**
 * GATE-SKIP-KNOWN-RETRY / GATE-ISOLATE-FAILED-FILES — the failing ids of one Pod shard, but only when every failure the
 * summary counts is named (junit first, else the console `(fail)` lines) and every unhandled error is attributed.
 * Anything less returns undefined, and the shard keeps the old retry path.
 */
export function shardFailureIds(clean: string, junit: string | undefined, fails: number, errors: number): { failures: string[]; errors: string[] } | undefined {
  if (!Number.isFinite(fails)) return undefined;
  const stripped = stripPodRepoRoot(clean);
  let failures: string[];
  try { failures = junit !== undefined ? [...new Set(junitFailures(junit).map(podRelative))].sort() : parseFailures(stripped); }
  catch { return undefined; }
  if (failures.length !== fails) return undefined;
  const errorIds = unhandledErrorIds(stripped);
  if (!errorIds || errorIds.length !== (Number.isNaN(errors) ? 0 : errors)) return undefined;
  return { failures, errors: [...new Set(errorIds)].sort() };
}
/** The console form `failuresOf` reads back, for failures named from junit (same shape as `pod-shard-junit-attribution`). */
const failureOutput = (failures: readonly string[], errors: readonly string[]) => [
  ...failures.map((id) => { const cut = id.indexOf(' > '); return `${id.slice(0, cut)}:\n(fail) ${id.slice(cut + 3)}`; }),
  ...errors.map((id) => `${testFileOfId(id)}:\n# Unhandled error between tests`),
].join('\n');
/** Repository-relative test files with at least one passed or failed junit testcase (an empty suite is no result). */
function junitFiles(xml: string): Set<string> {
  const files = new Set<string>();
  for (const id of [...junitPassedIds(xml), ...junitFailures(xml)]) {
    try { files.add(testFileOfId(podRelative(id))); } catch { /* an unreadable id proves nothing about its file */ }
  }
  return files;
}
/**
 * GATE-ISOLATE-FAILED-FILES — the files of a failed shard worth re-running: those with a failing test or an unhandled
 * error, and those with no junit result at all (crashed or never reached). undefined = cannot tell (fallback: whole shard).
 */
export function retryFiles(paths: readonly string[], clean: string | undefined, junit: string | undefined, fails: number, errors: number): string[] | undefined {
  if (junit === undefined || clean === undefined) return undefined;
  const ids = shardFailureIds(clean, junit, fails, errors);
  if (!ids) return undefined;
  const failing = new Set([...ids.failures, ...ids.errors].map((id) => { try { return testFileOfId(id); } catch { return id; } }));
  if ([...failing].some((file) => !paths.includes(file))) return undefined;
  const reported = junitFiles(junit);
  return paths.filter((file) => failing.has(file) || !reported.has(file));
}
export const POD_ISOLATION_MEMORY_LIMIT = '32Gi';
/** GT1b — a file whose measured peak is at least this runs alone at the isolation limit from the start: one such file
 *  sank a whole 203-file root shard at 16Gi (0.2.6 shard 12 · `unwired-exports` 9.9 GB) and cost two halving rounds. */
export const POD_HEAVY_FILE_MB = 4096;
/** Per-file peak memory, read from the cut tree (absent → no heavy files; the halving path still catches OOM). */
export const POD_MEMORY_SOURCE = 'docs/measurements/td1-whole-gate-mechanical-2026-10-01.tsv';
/** Integration tests that the Pod sweep does not run — each is judged by a real run elsewhere at the cut.
 *  0.2.7 run 5 (10-01): `scripts/install.test.ts` (real `bun pm pack` → `bun add` installs, 301 s alone on node-b)
 *  sat in a shard of its own past the 1200 s deadline with no output and stopped the whole gate. Judged on the
 *  mbp at the cut instead (TD1 moves it to the integration line). Keep this list short and explained. */
/** GT1 — files per retry chunk when a root shard fails (0.2.7: bundles of 54+ files OOMed at 16Gi, smaller passed). */
export const POD_SHARD_FILE_CAP = 27;

/** GATE-TIMEOUT-HEAL (0.2.20) — the per-shard Job deadline is the shard's planned wall-clock × 1.5, never under the
 *  configured floor (`release.loop.gatePodShardTimeoutSeconds` · default 1200 s) and never over the cap (or the floor,
 *  if that is higher). 0.2.19: the largest shard was planned at 18.9 min, ran 20–27 min (install 220–340 s under load)
 *  and 11 of 24 shards were cut at the flat 1200 s with nothing left to read. */
export const POD_SHARD_TIMEOUT_FLOOR_SECONDS = 1200;
export const POD_SHARD_TIMEOUT_CAP_SECONDS = 3600;
export function shardDeadlineSeconds(plannedSeconds: number, configured?: number): number {
  const floor = configured ?? POD_SHARD_TIMEOUT_FLOOR_SECONDS;
  const scaled = Number.isFinite(plannedSeconds) && plannedSeconds > 0 ? Math.ceil(plannedSeconds * 1.5) : 0;
  return Math.min(Math.max(floor, POD_SHARD_TIMEOUT_CAP_SECONDS), Math.max(floor, scaled));
}
/** Seconds the Pod keeps after the in-shell soft deadline: kill grace, artifact emission, and slack for what the Job
 *  deadline counts before the shell starts and the shell cannot see (scheduling · init containers). */
export const POD_SHARD_EMIT_RESERVE_SECONDS = 120;
export const softDeadlineSeconds = (deadline: number) => deadline > 2 * POD_SHARD_EMIT_RESERVE_SECONDS
  ? deadline - POD_SHARD_EMIT_RESERVE_SECONDS : Math.max(1, Math.floor(deadline * 0.8));
/** GATE-TIMEOUT-HEAL ② — a shard runs as consecutive parts of about this many planned seconds (at most
 *  {@link POD_SHARD_FILE_CAP} files), each with its own log and junit, so a shard cut by its deadline still leaves the
 *  results of every part that finished (F1/F2 read them) instead of nothing. */
export const POD_SHARD_PART_SECONDS = 120;
export function shardParts(paths: readonly string[], seconds: (file: string) => number, target = POD_SHARD_PART_SECONDS): string[][] {
  const parts: string[][] = [];
  let current: string[] = [];
  let sum = 0;
  for (const file of paths) {
    current.push(file);
    sum += seconds(file);
    if (sum >= target || current.length >= POD_SHARD_FILE_CAP) { parts.push(current); current = []; sum = 0; }
  }
  if (current.length) parts.push(current);
  return parts;
}
/**
 * GATE-ENV-BASELINE (W5 · 10-15) — the gate shard Pod's deterministic test env, exported before anything runs.
 * 0.2.29 gate failures were the Pod's «environment», not the code: no LLM provider · `man` stubbed · CLI spawn timeouts.
 * - `TZ=UTC` — the value `bun test` already uses when TZ is unset; pinned so a later image (or a shell profile) cannot move it.
 * - `LANG`/`LC_ALL=C.UTF-8` — the image sets no locale (POSIX); C.UTF-8 ships with glibc, so no image rebuild.
 * - `ELANOUS_TEST_FAKE_LLM=1` — the shared switch for the fake LLM provider. Its reader (UX device #27790) is not on main
 *   yet; until it lands the switch changes nothing. The reader yields to an explicit provider/endpoint, so a spawned CLI
 *   test that injects its own stub keeps it.
 * Retries, splits and file isolation all re-enter `runShard`, which builds every Pod shell here — they carry it too.
 * Provider keys are not set here on purpose: `test:deterministic` strips every credential-shaped key
 * (`scripts/lib/deterministic-env.ts` `isCredentialKey`), so a test never reaches a real provider from the Pod.
 * Binaries the image lacks (`man` pages — `git <sub> --help`) are not fixed here; see MANUAL-gate-regression-response-recipe §2a.
 */
export function gateEnvBaselineLine(env: Readonly<Record<string, string>> = gateTestBaseline(process.env)): string {
  return `export ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(' ')}`;
}
/**
 * The shard's Pod shell. Install once (behind the node's install slots), then run each part under the soft deadline,
 * leaving `install.log`/`install.rc`, `part-<i>.log`/`.rc`/`.junit.xml`, and `shard.timeout` (the part index) when the
 * deadline cut the shard. Real child/PTY parts have an additional 120 s test limit; a cap hit also writes
 * `shard.timeout` so the artifact reader does not mistake an unfinished child for a test verdict.
 * A part without `.rc` did not finish. The shell itself always exits 0 (as before).
 */
export function gateShardShell(o: { parts: readonly (readonly string[])[]; cdpPatterns: readonly string[]; softSeconds: number; cachePrefix: string; installSlots: number; depsDir?: string; beatSeconds?: number; parallelParts?: number; testTimeoutMs?: number; partLimitSeconds?: number; sourceBinding?: { cutSha: string; attemptId: string } }): string {
  // The planner keeps spawn files in their own shards; reject a mixed part rather than silently lose its limit.
  for (const part of o.parts) {
    if (part.some(isGateSpawnLaneFile) && !part.every(isGateSpawnLaneFile)) throw new Error('gate spawn lane part mixed with regular tests');
  }
  const spawnParts = o.parts.flatMap((part, index) => part.length && part.every(isGateSpawnLaneFile) ? [index] : []);
  const commands = o.parts.map((part, index) => {
    const ignores = o.cdpPatterns.filter((pattern) => part.includes(pattern)).flatMap((pattern) => ['--path-ignore-patterns', pattern]);
    // One-file runs keep named pass lines so their JUnit identities can be
    // cross-checked. The package script's --dots removes those names.
    const runner = part.length === 1 ? ['bun', 'run', 'scripts/test-deterministic.ts'] : ['bun', 'run', 'test:deterministic'];
    // Bash scopes this assignment to run_part; the mixed-part shell test
    // checks that a following multi-file part gets no source tag. The common
    // run_part body changes the shell hash once for this feature; keeping the
    // multi-file invocation unchanged avoids another cache-key change.
    const warmFile = part.length === 1 ? `WARM_REFERENCE_FILE=${quote(part[0]!)} ` : '';
    return `${warmFile}run_part ${index} ${[...runner, ...(o.testTimeoutMs !== undefined ? ['--timeout', String(o.testTimeoutMs)] : spawnParts.includes(index) ? ['--timeout=120000'] : []), ...ignores, ...part.map(asPath)].map(quote).join(' ')}`;
  });
  // Only file-isolation batches use this path. A bounded group shares one clone/install, but every test process gets
  // its own HOME, state and tmp directory; part logs/JUnit remain separate and the existing artifact reader judges them.
  const width = Math.max(1, Math.floor(o.parallelParts ?? 1));
  const isolateParts = o.parallelParts !== undefined;
  const run = width === 1 ? commands.join(' && ') : Array.from({ length: Math.ceil(commands.length / width) }, (_, group) => [
    ...commands.slice(group * width, (group + 1) * width).map((line) => `(${line}) & pids+=("$!")`),
    'for pid in "${pids[@]}"; do wait "$pid" || true; done; pids=()',
  ].join('; ')).join('; ');
  return [
    'mkdir -p "$HOME/outbox"; O="$HOME/outbox"',
    'stage_at() { printf "%s\\t%s\\n" "$1" "$2" >> "$O/stages.tsv"; }',
    'stage() { stage_at "$(date +%s)" "$1"; }',
    // This shell's first moment, captured before anything else runs so clone-end/shell-start keep their meaning.
    'shell_t=$(date +%s)',
    // Boot stages only: the container's age at shell entry. gate_end below keeps reading pod_age at its own spot.
    `boot_age=$(awk -v t="$(cut -d' ' -f22 /proc/1/stat 2>/dev/null)" -v hz="$(getconf CLK_TCK 2>/dev/null)" '{ if (t > 0 && hz > 0) print int($1 - t / hz); else print 0 }' /proc/uptime 2>/dev/null)`,
    'case "$boot_age" in ""|*[!0-9]*) boot_age=0;; esac',
    // GATE-WARM-BOOT-STAGES: boot on the Pod's own clock — prep start = the child container's PID 1 (none when the age is
    // unknown, never a guess), clone end = this shell's first line (the source checkout runs right before it).
    'if [ "$boot_age" -gt 0 ]; then stage_at "$(( shell_t - boot_age ))" prep-start; fi',
    'stage_at "$shell_t" clone-end',
    'stage_at "$shell_t" shell-start',
    ...(o.beatSeconds ? gateBeatScript(o.beatSeconds, o.installSlots > 0) : []),
    ...(o.cachePrefix ? [o.cachePrefix] : []),
    gateEnvBaselineLine(),
    // Seconds since this container's PID 1 started (the clone ran before this shell) — 0 when /proc cannot tell.
    `pod_age=$(awk -v t="$(cut -d' ' -f22 /proc/1/stat 2>/dev/null)" -v hz="$(getconf CLK_TCK 2>/dev/null)" '{ if (t > 0 && hz > 0) print int($1 - t / hz); else print 0 }' /proc/uptime 2>/dev/null)`,
    'case "$pod_age" in ""|*[!0-9]*) pod_age=0;; esac',
    `gate_end=$(( $(date +%s) + ${Math.max(1, Math.floor(o.softSeconds))} - pod_age ))`,
    ...(o.installSlots > 0 ? [installSlotScript({ slots: o.installSlots })] : []),
    'run_part() {',
    '  local i=$1; shift',
    ...(spawnParts.length ? ['  local spawn_part=0', `  case "$i" in ${spawnParts.join('|')}) spawn_part=1;; esac`] : []),
    '  stage "part-$i-start"',
    ...(isolateParts ? [
      '  local isolated; isolated=$(mktemp -d /tmp/gate-isolate.XXXXXX) || return 1',
      '  mkdir -p "$isolated/home" "$isolated/tmp" "$isolated/state" "$isolated/config" "$isolated/cache" "$isolated/data" "$isolated/xdg-state"',
      '  local source_repo="$PWD"',
      '  local -a run_env=(env HOME="$isolated/home" TMPDIR="$isolated/tmp" ELANOUS_STATE_DIR="$isolated/state" XDG_CONFIG_HOME="$isolated/config" XDG_CACHE_HOME="$isolated/cache" XDG_DATA_HOME="$isolated/data" XDG_STATE_HOME="$isolated/xdg-state")',
      '  stage "part-$i-setup-start"',
      '  local source_sha; source_sha=$(git rev-parse HEAD) || return 1',
      '  if ! "${run_env[@]}" git clone --shared --quiet --no-checkout "$source_repo" "$isolated/repo" > "$O/part-$i.setup.log" 2>&1 || ! "${run_env[@]}" git -C "$isolated/repo" checkout --detach --quiet "$source_sha" >> "$O/part-$i.setup.log" 2>&1; then cat "$O/part-$i.setup.log" > "$O/part-$i.log"; rm -rf "$isolated"; return 1; fi',
      '  ln -s "$source_repo/node_modules" "$isolated/repo/node_modules"',
      '  if [ -d "$source_repo/apps/pwa/node_modules" ]; then ln -s "$source_repo/apps/pwa/node_modules" "$isolated/repo/apps/pwa/node_modules"; fi',
      '  cd "$isolated/repo" || return 1',
      '  stage "part-$i-setup-end"',
    ] : ['  local -a run_env=()']),
    '  local left=$(( gate_end - $(date +%s) ))',
    '  if [ "$left" -le 0 ]; then echo "$i" > "$O/shard.timeout"; return 1; fi',
    ...(spawnParts.length ? ['  if [ "$spawn_part" -eq 1 ] && [ "$left" -gt 120 ]; then left=120; fi'] : []),
    ...(o.partLimitSeconds ? [`  if [ "$left" -gt ${o.partLimitSeconds} ]; then left=${o.partLimitSeconds}; fi`] : []),
    '  stage "part-$i-test-start"',
    ...(spawnParts.length ? ['  local test_start; test_start=$(date +%s)'] : []),
    `  { if [ -n "\${WARM_REFERENCE_FILE:-}" ]; then printf "[warm-worker] file=%s\\n" "$WARM_REFERENCE_FILE"; ${o.sourceBinding ? `printf "[warm-worker] cut=%s attempt=%s\\n" ${quote(o.sourceBinding.cutSha)} ${quote(o.sourceBinding.attemptId)}; ` : ''}fi; "\${run_env[@]}" timeout -k 10 "$left" "$@" --reporter=junit --reporter-outfile="$O/part-$i.junit.xml"; } > "$O/part-$i.log" 2>&1`,
    '  local prc=$?',
    '  if [ -n "${WARM_REFERENCE_FILE:-}" ] && [ -f "$O/part-$i.junit.xml" ]; then',
    '    local junit_sha; junit_sha=$(sha256sum "$O/part-$i.junit.xml" 2>/dev/null | awk \'{print $1}\')',
    '    if [ -z "$junit_sha" ]; then junit_sha=$(shasum -a 256 "$O/part-$i.junit.xml" 2>/dev/null | awk \'{print $1}\'); fi',
    '    if [[ "$junit_sha" =~ ^[a-f0-9]{64}$ ]]; then printf "[warm-worker] junit-sha256=%s\\n" "$junit_sha" >> "$O/part-$i.log"; fi',
    '  fi',
    ...(o.partLimitSeconds ? ['  if [ "$prc" -eq 124 ] || [ "$prc" -eq 137 ]; then echo "$i" > "$O/part-$i.timeout"; fi'] : []),
    ...(spawnParts.length ? ['  local test_end; test_end=$(date +%s)'] : []),
    '  stage "part-$i-test-end"',
    ...(isolateParts ? ['  stage "part-$i-cleanup-start"', '  cd "$source_repo"', '  rm -rf "$isolated"', '  stage "part-$i-cleanup-end"'] : []),
    '  stage "part-$i-end"',
    ...(spawnParts.length ? ['  if [ "$spawn_part" -eq 1 ] && { [ "$prc" -eq 124 ] || { [ "$test_end" -ge "$(( test_start + left ))" ] && { [ "$prc" -eq 137 ] || [ "$prc" -eq 143 ]; }; }; }; then echo "$i" > "$O/shard.timeout"; return 1; fi'] : []),
    '  if [ "$(date +%s)" -ge "$gate_end" ] && { [ "$prc" -eq 124 ] || [ "$prc" -eq 137 ] || [ "$prc" -eq 143 ]; }; then echo "$i" > "$O/shard.timeout"; return 1; fi',
    '  echo "$prc" > "$O/part-$i.rc"',
    '}',
    'if cd .. && cd repo; then',
    '  stage deps-start',
    // GATE-IMAGE-DEPS: link the image's baked node_modules when the lockfiles match; only a miss installs (behind a slot).
    ...gateDepsInstallScript({ log: '"$O/install.log"', installSlots: o.installSlots, ...(o.depsDir ? { depsDir: o.depsDir } : {}) }).split('\n').map((line) => `  ${line}`),
    '  echo "$irc" > "$O/install.rc"',
    '  stage deps-end',
    `  if [ "$irc" -eq 0 ]; then stage test-start; ${width > 1 ? 'pids=(); ' : ''}${run || 'true'}; stage test-end; fi`,
    'else echo 5 > "$O/install.rc"; fi',
    'stage shell-end',
    'true',
  ].join('\n');
}
/**
 * GATE-POD-STALL-FAILFAST (0.2.24) — the shard shell's live heartbeat on the Pod's stdout (everything else goes to the
 * outbox, which the host sees only after the Job ends). 10-10 0.2.24 gate: the node's containerd was unresponsive, all 28
 * shards ran to their 1697 s deadline with `finishedFiles: 0`, then retries and splits did the same for 2h+ and the node
 * never finished. The beat lets the host see «no test output yet» while the Job runs:
 * `ELANOUS_GATE_BEAT <seq> <slot|install|test> <0|1>` — the last field is 1 once any part log has a byte.
 * GATE-POD-STALL-FAILFAST ① (mid-run): once there is test output the beat adds the part logs' total bytes —
 * `ELANOUS_GATE_BEAT <seq> test 1 <bytes>` — so the host can see output stop after it started. The old 4-field line is
 * still read (no bytes = no mid-run watch).
 * It is observation only: the host hashes the shell without it into `runKey`.
 */
export function gateBeatScript(beatSeconds: number, installSlots: boolean): string[] {
  return [
    'gate_beat() {',
    '  local n=0 st t f',
    '  while :; do',
    '    n=$((n + 1)); t=0; b=0',
    '    for f in "$O"/part-*.log; do if [ -s "$f" ]; then t=1; b=$(( b + $(wc -c < "$f" 2>/dev/null || echo 0) )); fi; done',
    '    if [ -f "$O/install.rc" ]; then st=test',
    // A deps miss with no slot line yet = waiting for an install slot (bounded by the slot script; not a stall).
    ...(installSlots ? ["    elif [ -f \"$O/install.log\" ] && grep -q '^\\[gate\\] deps .* miss' \"$O/install.log\" 2>/dev/null && ! grep -q '^\\[gate\\] install-slot' \"$O/install.log\" 2>/dev/null; then st=slot"] : []),
    '    else st=install; fi',
    '    if [ "$t" = 1 ]; then echo "ELANOUS_GATE_BEAT $n $st $t $b"; else echo "ELANOUS_GATE_BEAT $n $st $t"; fi',
    `    sleep ${Math.max(1, Math.floor(beatSeconds))} >/dev/null 2>&1 </dev/null`,
    '  done',
    '}',
    'gate_beat & gate_beat_pid=$!',
    // Stopped before the shell returns, so no beat line lands between the Job's artifact lines.
    'trap \'kill "$gate_beat_pid" 2>/dev/null; wait "$gate_beat_pid" 2>/dev/null\' EXIT',
  ];
}
export const GATE_POD_STALL_SECONDS_DEFAULT = 300;
export const GATE_POD_STALL_POLL_MS = 15_000;
/** At least ten beats per stall window, never slower than one per 30 s. */
export const gateStallBeatSeconds = (stallSeconds: number) => Math.min(30, Math.max(1, Math.floor(stallSeconds / 10)));
export interface ShardLiveLog { checkout: boolean; beat?: { seq: number; stage: 'slot' | 'install' | 'test'; testOutput: boolean;
  /** Part logs' total bytes (mid-run progress) — absent on the old beat line. */
  bytes?: number } }
/** What the Pod's live stdout says so far: the source checkout line and the latest beat. */
export function readShardLiveLog(text: string): ShardLiveLog {
  let checkout = false;
  let beat: ShardLiveLog['beat'];
  for (const line of text.split(/\r?\n/)) {
    if (/^ELANOUS_POD_SOURCE (?:commit|default|pr) /.test(line)) checkout = true;
    const match = /^ELANOUS_GATE_BEAT (\d+) (slot|install|test) ([01])(?: (\d+))?\s*$/.exec(line);
    if (match) beat = { seq: Number(match[1]), stage: match[2] as 'slot' | 'install' | 'test', testOutput: match[3] === '1',
      ...(match[4] !== undefined ? { bytes: Number(match[4]) } : {}) };
  }
  return { checkout, ...(beat ? { beat } : {}) };
}

/** Kubernetes clock boundaries for scheduling and init. Child start → shell-start includes source checkout and setup. */
export function readGatePodLifecycle(text: string): Record<string, string> {
  try {
    const pod = (JSON.parse(text) as { items?: Array<{ metadata?: { creationTimestamp?: string }; status?: {
      conditions?: Array<{ type?: string; lastTransitionTime?: string }>;
      initContainerStatuses?: Array<{ name?: string; state?: { terminated?: { startedAt?: string; finishedAt?: string } } }>;
      containerStatuses?: Array<{ name?: string; state?: { terminated?: { startedAt?: string; finishedAt?: string } } }>;
    } }> }).items?.[0];
    if (!pod) return {};
    const out: Record<string, string> = {};
    const put = (key: string, value?: string) => { if (value && Number.isFinite(Date.parse(value))) out[key] = value; };
    put('podCreated', pod.metadata?.creationTimestamp);
    put('podScheduled', pod.status?.conditions?.find((item) => item.type === 'PodScheduled')?.lastTransitionTime);
    for (const item of pod.status?.initContainerStatuses ?? []) {
      if (!item.name || !/^[a-z0-9-]+$/.test(item.name)) continue;
      put(`init-${item.name}-start`, item.state?.terminated?.startedAt);
      put(`init-${item.name}-end`, item.state?.terminated?.finishedAt);
    }
    const child = pod.status?.containerStatuses?.find((item) => item.name === 'child');
    put('childStart', child?.state?.terminated?.startedAt);
    put('childEnd', child?.state?.terminated?.finishedAt);
    return out;
  } catch { return {}; }
}
/** Seconds with at least one isolated test process running; setup gaps between parallel groups remain overhead. */
export function gateBatchTestWallSeconds(stages: Record<string, number> | undefined, partCount: number): number | undefined {
  if (!stages || partCount < 1) return undefined;
  const spans: Array<[number, number]> = [];
  for (let index = 0; index < partCount; index++) {
    const start = stages[`part-${index}-test-start`];
    const end = stages[`part-${index}-test-end`];
    if (!Number.isFinite(start) || !Number.isFinite(end) || end! < start!) return undefined;
    spans.push([start!, end!]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let [from, to] = spans[0]!;
  for (const [start, end] of spans.slice(1)) {
    if (start <= to) to = Math.max(to, end);
    else { covered += to - from; from = start; to = end; }
  }
  return covered + to - from;
}
/**
 * GATE-POD-STALL-FAILFAST — watches one running shard Job. Armed once the source checkout line is seen; disarmed for good
 * the moment any test output exists (that shard then behaves exactly as before). Stalled = `stallSeconds` since the
 * checkout with no test output, not counting time the beat reported an install-slot wait. A silent shell (no beat at all)
 * counts like any other stage. Only successful reads decide; a read failure never stalls a shard. `graceMs` covers the
 * beat's report lag: output that appeared just inside the window is reported by the next beat before the stop decides.
 *
 * GATE-POD-STALL-FAILFAST ① (mid-run): with `midRunStallSeconds` > 0 and an `abortTests`, the watch does not end at the
 * first test output when the beat carries the part logs' bytes. It keeps the time the bytes last changed; no change for
 * `midRunStallSeconds` (⊕ grace) = a mid-run hang: `onAbort`, then `abortTests` ends only the test process group in the
 * Pod (never the Job — Job backoffLimit 0). One abort per watch; a beat without bytes (old shell) ends the watch as before.
 */
export function watchShardStall(o: { stallSeconds: number; pollMs: number; read: () => string | null; onStall: (sinceCheckoutMs: number) => void; now?: () => number; graceMs?: number;
  /** Stops the Job; false = not taken, asked again every poll until it is or the watch ends (a stalled Job must not run to its deadline). */
  stopJob?: () => boolean | void;
  /** Mid-run hang window in seconds (0 / absent = off). */
  midRunStallSeconds?: number;
  onAbort?: (info: { sinceLastOutputMs: number }) => void;
  /** Ends the Pod's test process group; false = not taken, asked again on the next polls (at most {@link GATE_SHARD_ABORT_TRIES}). */
  abortTests?: () => boolean | void }): { stop(): void; stalled(): { sinceCheckoutMs: number } | undefined; aborted(): ShardAbort | undefined; state(): ShardStallWatchState } {
  const now = o.now ?? Date.now;
  const midRunMs = o.midRunStallSeconds && o.midRunStallSeconds > 0 && o.abortTests ? o.midRunStallSeconds * 1000 : 0;
  /** Mid-run phase: the last bytes the beat reported and when they last changed. */
  let midRun: { bytes: number; changedAt: number } | undefined;
  let abort: ShardAbort | undefined;
  let abortTries = 0;
  let checkoutAt: number | undefined;
  /** Observation only (GATE-WARM-BOOT-SCAN): when the first test output was seen, relative to the checkout. */
  let firstTestAt: { checkout: number; at: number } | undefined;
  let windowStart: number | undefined;
  let lastSeq: number | undefined;
  let hit: { sinceCheckoutMs: number } | undefined;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const askStop = () => {
    timer = undefined;
    if (ended) return;
    let taken: boolean | void = false;
    try { taken = o.stopJob ? o.stopJob() : true; } catch { taken = false; }
    if (taken === false && !ended) timer = setTimeout(askStop, o.pollMs);
  };
  const askAbort = () => {
    timer = undefined;
    if (ended) return;
    abortTries++;
    let taken: boolean | void = false;
    try { taken = o.abortTests!(); } catch { taken = false; }
    if (taken !== false && abort) abort.taken = true;
    if (taken === false && !ended && abortTries < GATE_SHARD_ABORT_TRIES) timer = setTimeout(askAbort, o.pollMs);
  };
  const tick = () => {
    timer = undefined;
    if (done) return;
    let text: string | null = null;
    try { text = o.read(); } catch { text = null; }
    if (done) return;
    if (text !== null) {
      const t = now();
      const live = readShardLiveLog(text);
      if (midRun) {
        // A beat without bytes (cannot judge progress) ends the mid-run watch; a failed or empty read decides nothing.
        if (live.beat?.testOutput && live.beat.bytes === undefined) { done = true; return; }
        if (live.beat?.bytes !== undefined && live.beat.bytes !== midRun.bytes) midRun = { bytes: live.beat.bytes, changedAt: t };
        else if (t - midRun.changedAt >= midRunMs + (o.graceMs ?? 0)) {
          done = true;
          abort = { reason: `mid-run-stall ${o.midRunStallSeconds}s`, at: new Date().toISOString(), by: 'auto', sinceLastOutputMs: t - midRun.changedAt, taken: false };
          try { o.onAbort?.({ sinceLastOutputMs: abort.sinceLastOutputMs }); } catch { /* observation only */ }
          askAbort();
          return;
        }
        timer = setTimeout(tick, o.pollMs);
        return;
      }
      if (live.beat?.testOutput) {
        const seenCheckout = checkoutAt ?? (live.checkout ? t : undefined);
        if (seenCheckout !== undefined) firstTestAt = { checkout: seenCheckout, at: t };
        if (midRunMs && live.beat.bytes !== undefined) {
          midRun = { bytes: live.beat.bytes, changedAt: t };
          timer = setTimeout(tick, o.pollMs);
          return;
        }
        done = true;
        return;
      }
      if (live.checkout && checkoutAt === undefined) { checkoutAt = t; windowStart = t; }
      if (live.beat && live.beat.seq !== lastSeq) {
        lastSeq = live.beat.seq;
        if (live.beat.stage === 'slot' && windowStart !== undefined) windowStart = t;
      }
      if (checkoutAt !== undefined && windowStart !== undefined && t - windowStart >= o.stallSeconds * 1000 + (o.graceMs ?? 0)) {
        done = true;
        hit = { sinceCheckoutMs: t - checkoutAt };
        o.onStall(hit.sinceCheckoutMs);
        askStop();
        return;
      }
    }
    timer = setTimeout(tick, o.pollMs);
  };
  timer = setTimeout(tick, o.pollMs);
  return { stop: () => { done = true; ended = true; if (timer) clearTimeout(timer); }, stalled: () => hit, aborted: () => abort,
    state: () => ({ armed: checkoutAt !== undefined || firstTestAt !== undefined,
      disarmedBy: hit ? 'stall-fired' : abort ? 'mid-run-stall' : firstTestAt ? 'test-output' : null,
      firstTestAtSec: firstTestAt ? Math.round((firstTestAt.at - firstTestAt.checkout) / 100) / 10 : null,
      ...(abort ? { abort: { reason: abort.reason, at: abort.at, by: abort.by } } : {}) }) };
}
/** GATE-POD-STALL-FAILFAST ① — a mid-run abort: why (`mid-run-stall <N>s`), when, who (`auto`; a manual knob is slice 2). */
export type ShardAbort = { reason: string; at: string; by: 'auto'; sinceLastOutputMs: number;
  /** The in-Pod abort was taken (false = every try failed — the Job then runs to its deadline as before). */
  taken: boolean };
/** How many polls ask the in-Pod abort before giving up (the Job then runs to its deadline as before). */
export const GATE_SHARD_ABORT_TRIES = 3;
/** GATE-POD-STALL-FAILFAST ① — default mid-run hang window: well under a shard deadline (≈1500 s+), far over one test's limit. */
export const GATE_POD_MIDRUN_STALL_SECONDS_DEFAULT = 600;
/** Seconds between the in-Pod TERM and KILL of the test process group. */
export const GATE_SHARD_ABORT_GRACE_SECONDS = 10;
/** What one shard's stall watch saw — armed (checkout seen) · why it ended · first test output seconds after the checkout. */
export type ShardStallWatchState = { armed: boolean; disarmedBy: 'test-output' | 'stall-fired' | 'mid-run-stall' | null; firstTestAtSec: number | null;
  abort?: Omit<ShardAbort, 'sinceLastOutputMs' | 'taken'> };
/**
 * GATE-POD-STALL-FAILFAST ① — run inside the shard Pod (`kubectl exec … bash -c`): ends only the running test process
 * groups — the group led by a process whose argv carries `--reporter-outfile=…/outbox/part-<i>.junit.xml` (GNU `timeout`
 * leads its own group) — TERM now, KILL after the grace. It never signals PID 1's group or its own. Before the signal it
 * leaves `part-<i>.abort` (the reason) and `shard.timeout`, so the outbox reads like a deadline cut of that part
 * ({@link readShardArtifacts}: unfinished, timed out) while the shell finishes the remaining parts and its outbox.
 * Exit 0 = at least one group signalled.
 */
export function gateShardAbortScript(reason: string, graceSeconds = GATE_SHARD_ABORT_GRACE_SECONDS,
  /** Only this outbox's parts (tests: never another run's groups on the same machine); absent = any `…/outbox/` in the Pod. */
  outbox?: string): string {
  return [
    `reason=${quote(reason.replace(/[^\w .:-]/g, '_'))}`,
    `only=${quote(outbox ?? '')}`,
    "pg_of() { sed 's/^.*) //' \"/proc/$1/stat\" 2>/dev/null | cut -d' ' -f3; }",
    'root_pg=$(pg_of 1); my_pg=$(pg_of $$); found=0',
    'for d in /proc/[0-9]*; do',
    '  pid=${d#/proc/}',
    "  out=$(tr '\\0' '\\n' < \"$d/cmdline\" 2>/dev/null | grep -m1 -E '^--reporter-outfile=.*/outbox/part-[0-9]+\\.junit\\.xml$') || continue",
    '  if [ -n "$only" ]; then case "$out" in "--reporter-outfile=$only/part-"*) ;; *) continue;; esac; fi',
    '  pg=$(pg_of "$pid")',
    '  case "$pg" in ""|*[!0-9]*) continue;; esac',
    '  if [ "$pg" != "$pid" ] || [ "$pg" -le 1 ] || [ "$pg" = "$root_pg" ] || [ "$pg" = "$my_pg" ]; then continue; fi',
    '  out=${out#--reporter-outfile=}; dir=${out%/part-*}; part=${out##*/part-}; part=${part%.junit.xml}',
    '  printf "%s\\n" "$reason" > "$dir/part-$part.abort"',
    '  [ -f "$dir/shard.timeout" ] || echo "$part" > "$dir/shard.timeout"',
    '  if kill -TERM -- "-$pg" 2>/dev/null; then found=$((found + 1)); echo "ELANOUS_GATE_ABORT part=$part pgid=$pg"; fi',
    `  ( sleep ${Math.max(1, Math.floor(graceSeconds))}; kill -KILL -- "-$pg" 2>/dev/null ) >/dev/null 2>&1 </dev/null &`,
    'done',
    'echo "ELANOUS_GATE_ABORT signalled=$found"',
    '[ "$found" -gt 0 ]',
  ].join('\n');
}
/** The shard json's `stallWatch` record (observation only — never read by any judgment). */
export type ShardStallWatchRecord = Omit<ShardStallWatchState, 'disarmedBy'> & { disarmedBy: ShardStallWatchState['disarmedBy'] | 'off' | 'no-live-log'; stallSeconds: number };
export function shardStallWatchRecord(stallSeconds: number, hasLiveLog: boolean, state: ShardStallWatchState | undefined): ShardStallWatchRecord {
  if (!(stallSeconds > 0)) return { armed: false, disarmedBy: 'off', firstTestAtSec: null, stallSeconds };
  if (!hasLiveLog) return { armed: false, disarmedBy: 'no-live-log', firstTestAtSec: null, stallSeconds };
  return { ...(state ?? { armed: false, disarmedBy: null, firstTestAtSec: null }), stallSeconds };
}
/** GATE-WARM-BOOT-SCAN — logs the selection time and hands it to the caller; an observer failure never stops the sweep. */
export function reportSelectionTimed(ms: number, files: number, observer?: (timed: { ms: number; files: number }) => void): void {
  debug.log('release-loop.gate', 'selection-timed', { ms, files });
  try { observer?.({ ms, files }); } catch { /* observation only */ }
}
/** Removes bun's own summary lines so one summary over several runs can follow (same rule as the sweep's merge). */
const stripSummary = (output: string) => output.replace(/(?:^|\n)\s*\d+ (?:pass|fail|errors?)\s*(?=\n|$)/g, '\n').replace(/Ran \d+ tests? across \d+ files?\.?/g, '');
export interface ShardArtifacts {
  /** GATE-POD-STALL-FAILFAST (OP) — every unfinished part ended with a complete clean summary (0 fail · 0 error) but an exit
   *  other than 0/1: an exit-code anomaly (a test left process.exitCode set), with those parts' files. */
  exitCodeOnly?: string[];
  /** The verdict text: install log ⊕ every finished part (its summary removed) ⊕ one summary over the finished parts. */
  output?: string;
  junit?: string;
  /** 0|1 when every part finished · the failing part's exit when one crashed · undefined when the deadline cut the shard. */
  rc?: number;
  timedOut: boolean;
  /** Files of the parts that finished with a readable summary. */
  finished: string[];
  /** Raw logs of the parts that did not finish (diagnostics · last started file). */
  unfinishedLog?: string;
}
/** Reads a shard Pod's outbox: the part layout ({@link gateShardShell}) or the older single-run one (shard.log · shard.rc · junit.xml). */
export function readShardArtifacts(dir: string, parts: readonly (readonly string[])[]): ShardArtifacts {
  const read = (name: string) => { const path = join(dir, name); return existsSync(path) ? readFileSync(path, 'utf8') : undefined; };
  const rcOf = (text: string | undefined) => { const value = text?.trim() ?? ''; return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined; };
  const installRc = rcOf(read('install.rc'));
  const install = read('install.log');
  if (installRc === undefined && install === undefined) {
    const junit = read('junit.xml');
    const rc = rcOf(read('shard.rc'));
    return { output: read('shard.log'), ...(junit !== undefined ? { junit } : {}), ...(rc !== undefined ? { rc } : {}), timedOut: false, finished: [] };
  }
  const timedOut = read('shard.timeout') !== undefined;
  if (installRc !== 0) return { output: install, ...(installRc !== undefined ? { rc: installRc } : {}), timedOut, finished: [] };
  const good: Array<{ log: string; junit?: string; rc: 0 | 1; files: readonly string[] }> = [];
  const bad: string[] = [];
  const exitAnomaly: string[] = [];
  let otherBad = false;
  let badRc: number | undefined;
  parts.forEach((files, index) => {
    const log = read(`part-${index}.log`);
    const rc = rcOf(read(`part-${index}.rc`));
    const clean = log?.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    // GATE-POD-STALL-FAILFAST ① — a part the mid-run abort ended reads like a deadline cut: unfinished, its exit (143/137) no verdict.
    const abort = read(`part-${index}.abort`);
    if (abort !== undefined) {
      bad.push(`# part ${index} (abort: ${abort.trim()})\n${log ?? ''}`);
      otherBad = true;
      return;
    }
    if (clean !== undefined && (rc === 0 || rc === 1) && lastMatch(clean, /Ran (\d+) tests? across (\d+) files?/)) {
      const junit = read(`part-${index}.junit.xml`);
      good.push({ log: clean, rc, files, ...(junit !== undefined ? { junit } : {}) });
      return;
    }
    if (log !== undefined) bad.push(`# part ${index} (${rc === undefined ? 'unfinished' : `rc=${rc}`})\n${log}`);
    if (clean !== undefined && rc !== undefined && rc !== 0 && rc !== 1 && Number(lastMatch(clean, /Ran (\d+) tests? across ([1-9]\d*) files?/)?.[1] ?? 0) > 0
      && summaryCount(clean, 'fail') === 0 && !(summaryCount(clean, 'error') > 0) && !/^# Unhandled error between tests/m.test(clean)) exitAnomaly.push(...files);
    else otherBad = true;
    // A finished part without a readable summary is not a verdict: its exit, or 2 when it claimed 0|1.
    if (rc !== undefined && badRc === undefined) badRc = rc === 0 || rc === 1 ? 2 : rc;
  });
  const total = good.reduce((sum, part) => {
    const n = (label: string) => { const value = summaryCount(part.log, label); return Number.isNaN(value) ? 0 : value; };
    const ran = lastMatch(part.log, /Ran (\d+) tests? across (\d+) files?/)!;
    return { pass: sum.pass + n('pass'), fail: sum.fail + n('fail'), errors: sum.errors + n('error'), ran: sum.ran + Number(ran[1]), files: sum.files + Number(ran[2]) };
  }, { pass: 0, fail: 0, errors: 0, ran: 0, files: 0 });
  const output = [install ?? '', ...good.map((part) => stripSummary(part.log)),
    ...(good.length ? [`${total.pass} pass\n${total.fail} fail\n${total.errors} errors\nRan ${total.ran} tests across ${total.files} files.\n`] : [])].join('\n');
  const junits = good.flatMap((part) => part.junit !== undefined ? [part.junit] : []);
  const complete = good.length === parts.length;
  const rc = complete ? (good.some((part) => part.rc === 1) ? 1 : 0) : timedOut && badRc === undefined ? undefined : (badRc ?? 2);
  return {
    output,
    ...(junits.length ? { junit: junits.join('\n') } : {}),
    ...(rc !== undefined ? { rc } : {}),
    timedOut: !complete && timedOut && badRc === undefined,
    finished: good.flatMap((part) => [...part.files]),
    ...(bad.length ? { unfinishedLog: bad.join('\n') } : {}),
    ...(exitAnomaly.length && !otherBad ? { exitCodeOnly: exitAnomaly } : {}),
  };
}

/** The line appended to pod-N.log when part output that never finished went to pod-N.unfinished.log (a reader of pod-N.log alone saw «no test output»). */
export const gateUnfinishedHint = (relativePath: string, bytes: number) => `[gate] unfinished: ${relativePath} · ${bytes}B (진행 중 part 출력은 그 파일)`;

// review-model-ab: Pod 에서 출력 없이 멈춤 2/2(10-04 0.2.11 · 로컬 단독 4/0 · 1.7s) — GATE-STALL 수리 전까지 Pod 밖.
// The shared exclusion list lives in gate-baseline-receipt so radius verification uses the producer's rule.
/** Nightly-only whole-repository cases; gate runs the fixture cases in these same files. */
export const GATE_NIGHTLY_AUDITS: readonly string[] = [
  // Replaces F12's real-repo bucket B apps/pwa scope check and its whole-repo export partition check.
  'test/f12-sweep.test.ts',
  // Replaces unwired-exports' real src/oauth caller check and its src/ad-pipeline CLI scan.
  'scripts/unwired-exports.test.ts',
  // Replaces pwa-build-typecheck's full root tsc and PWA tsc sweeps (PWA build also runs in the release loop).
  'test/pwa-build-typecheck.test.ts',
];
const tail40 = (output: string) => output.trimEnd().split(/\r?\n/).slice(-40).join('\n');
const lastStartedTestFile = (output: string, paths: string[]): string | undefined => {
  let last: string | undefined;
  for (const line of output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/)) {
    const header = /^(?:\.\/)?((?:[\w.-]+\/)*[\w.-]+\.test\.tsx?):/.exec(line.trim());
    if (header && paths.includes(header[1]!)) last = header[1];
  }
  return last;
};

/**
 * GATE-SHARD-RESUME (0.2.19) — the result a previous attempt left in this log directory for exactly this shard: same name,
 * same commit, the same files in the same order and a test exit (rc 0|1) with its log. 0.2.18: the second gate stopped
 * after 33 minutes on a tool error (unsafe test path) and the third ran all 80 minutes again although the cut commit and
 * every finished shard were unchanged. The caller re-reads the log with the current tool code; anything else is a miss.
 */
/** GATE-SHARD-RESUME — how a previous attempt went past this shard without a verdict of its own: it re-ran in a fresh Job
 *  after no output (`-retry`), or it failed here and was split (`-c0` cap chunks · `-0` halves · `-file-0` isolation). The
 *  split shape follows from depth and size alone, so the same plan reaches the same child names (TC 09:30 review ②).
 *  `runKey` hashes where and how the Pod ran the shard (pool · command · ignores · memory · deadline · Bun cache): a fix on the Pod side
 *  makes every old result a miss instead of re-reading an old failure as introduced (TC 09:48 review). */
export function previousShardDescent(logDir: string, name: string, commit: string, files: readonly string[], runKey: string, parentAttempt?: string, splitChild?: string): { way: 'retry' | 'split'; attemptId: string } | undefined {
  const meta = (file: string): { commit?: unknown; files?: unknown; rc?: unknown; runKey?: unknown; attemptId?: unknown; parentAttempt?: unknown } | undefined => {
    try { return JSON.parse(readFileSync(join(logDir, `${file}.json`), 'utf8')); } catch { return undefined; }
  };
  const own = meta(name);
  if (own?.commit !== commit || own.runKey !== runKey || !Array.isArray(own.files) || own.files.length !== files.length || own.files.some((file, index) => file !== files[index])) return undefined;
  if (typeof own.attemptId !== 'string' || (parentAttempt !== undefined && own.parentAttempt !== parentAttempt)) return undefined;
  const attemptId = own.attemptId;
  // Children are checked whatever the parent's rc was: a parent can exit 0|1 and still have gone down (no output · an
  // unreadable summary). A child counts only for this commit and only with files taken from this shard.
  const parent = new Set(files);
  const child = (file: string, whole: boolean) => {
    const row = meta(file);
    // A child counts only when the parent's latest attempt wrote it — a child left by an older attempt is not this way down.
    return row?.commit === commit && row.parentAttempt === attemptId && Array.isArray(row.files) && row.files.length > 0 && row.files.every((path) => typeof path === 'string' && parent.has(path))
      && (!whole || row.files.length === files.length);
  };
  if (child(`${name}-retry`, true)) return { way: 'retry', attemptId };
  // Only the first child of the split the caller takes now (`-file-0` · `-c0` · `-0` · review r3): a record of another
  // split shape is not followed.
  return splitChild !== undefined && child(`${name}${splitChild}`, false) ? { way: 'split', attemptId } : undefined;
}

export function previousShardResult(logDir: string, name: string, commit: string, files: readonly string[], runKey: string, parentAttempt?: string): { output: string; junit?: string; rc: 0 | 1; durationMs?: number } | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(logDir, `${name}.json`), 'utf8')) as { commit?: unknown; files?: unknown; rc?: unknown; durationMs?: unknown; runKey?: unknown; parentAttempt?: unknown; jobExitCode?: unknown; jobFailed?: unknown };
    // Only a Job that itself exited 0 — a crashed Job can still leave rc 0 and a clean-looking log (review r6).
    if (meta.jobExitCode !== 0 || meta.jobFailed !== false) return undefined;
    if (meta.commit !== commit || meta.runKey !== runKey || (parentAttempt !== undefined && meta.parentAttempt !== parentAttempt) || (meta.rc !== 0 && meta.rc !== 1) || !Array.isArray(meta.files)
      || meta.files.length !== files.length || meta.files.some((file, index) => file !== files[index])) return undefined;
    const logPath = join(logDir, `${name}.log`);
    if (!existsSync(logPath)) return undefined;
    const junitPath = join(logDir, `${name}.junit.xml`);
    return { output: readFileSync(logPath, 'utf8'), rc: meta.rc, ...(existsSync(junitPath) ? { junit: readFileSync(junitPath, 'utf8') } : {}),
      ...(typeof meta.durationMs === 'number' ? { durationMs: meta.durationMs } : {}) };
  } catch { return undefined; }
}

/** 0.2.18 gate: a test that changed process.cwd made bun print later test files relative to that cwd
 *  (`../..~/repo/src/…`), and the safe-path check stopped the whole gate. The Pod clone root is
 *  `~/repo`; strip it back to a repository-relative path before any id is read. */
export function stripPodRepoRoot(output: string): string {
  return output.replace(/^(\s*(?:\(fail\)\s+)?)(?:\.\.\/)*(?:\/)?home\/ubuntu\/repo\//gm, '$1');
}

function failuresOf(run: CommandResult, label: string): SweepFailures {
  const output = stripPodRepoRoot(run.output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
  const ran = lastMatch(output, /Ran (\d+) tests? across ([1-9]\d*) files?/);
  const reportedErrors = summaryCount(output, 'error');
  const errorCount = Number.isNaN(reportedErrors) ? 0 : reportedErrors;
  const incomplete = (reason: string) => new Error(`${label} incomplete (rc=${run.rc}; Ran=${ran ? ran[0] : 'missing'}; errors=${Number.isNaN(reportedErrors) ? 'missing' : errorCount}; ${reason})\n${tail40(output)}`);
  const count = summaryCount(output, 'fail');
  const failures = parseFailures(output);
  // Bun repeats failed test names under "N tests failed:". A validated Pod sweep joins
  // separately checked shards, so a summary in one shard can precede real failures
  // from later shards. Remove each repeated block, not everything after the last one.
  // Unhandled-error summaries have a separate file-attribution path below and do not
  // use Bun's repeated `(fail)` block format.
  const failureSummary = [...output.matchAll(/^\d+ tests? failed:\s*$/gm)].at(-1);
  const executionOutput = run.validatedShards
    ? output.replace(/^\d+ tests? failed:\r?\n(?:\(fail\)[^\r\n]*(?:\r?\n|$))*(?:[ \t]*\r?\n)*/gm, '')
    : failureSummary ? output.slice(0, failureSummary.index) : output;
  const occurrences = [...executionOutput.matchAll(/^[ \t]*\(fail\)[ \t]+.+?(?:[ \t]+\[[\d.]+(?:ms|s)\])?[ \t]*\r?$/gm)].length;
  // A test that leaves process.exitCode set leaks a non-zero exit into a run whose own summary is complete and clean
  // (0.2.7 gate: agent-cli at v0.2.6 · 12 pass · 0 fail · rc 2). The summary is the verdict; read that exit as clean.
  const leakedExit = !!ran && run.rc !== 0 && run.rc !== 1 && count === 0 && errorCount === 0 && occurrences === 0
    && !/^# Unhandled error between tests/m.test(output);
  const rc = leakedExit ? 0 : run.rc;
  if (!ran || (Number(ran[1]) === 0 && errorCount === 0) || (rc !== 0 && rc !== 1)) throw incomplete('summary/exit');
  // Bun reports file-level unhandled errors separately from test failures.
  const errors: string[] = [];
  let file: string | undefined;
  for (const raw of output.split(/\r?\n/)) {
    const header = /^(?:\.\/)?((?:[\w.-]+\/)+[\w.-]+\.test\.tsx?):/.exec(raw.trim());
    if (header) file = header[1];
    if (/^# Unhandled error between tests/.test(raw.trim())) {
      if (!file) throw incomplete('unattributed unhandled error');
      errors.push(`${file} > [error]`);
    }
  }
  if (errors.length !== errorCount) throw incomplete(`error attribution identified=${errors.length}`);
  if (!Number.isFinite(count) || (count !== occurrences && !(run.validatedShards && occurrences > count && failures.length === count)) || (count > 0 && failures.length === 0)
    || (rc === 1 && count === 0 && errorCount === 0) || (rc === 0 && count + errorCount > 0)) {
    throw incomplete(`failure attribution incomplete: summary=${count}, identified=${failures.length}`);
  }
  return { failures, errors: [...new Set(errors)].sort() };
}

/**
 * «N pass · 0 fail · rc=1» from an isolated run is read as `rc-nonzero-no-failures` only when the summary is a complete,
 * clean, single-file summary for the requested file (`Ran N≥1 tests across 1 file` · 0 fail · 0 error · no `(fail)` ·
 * no unhandled error · pass = N · no other test-file header). Every other run is read exactly as before (`failuresOf`,
 * which throws on the incomplete shapes, plus a failure-count/identified-name check).
 */
export function readIsolatedRun(run: CommandResult, label: string, file: string):
  | { kind: 'read'; failures: string[]; errors: string[] }
  | { kind: 'rc-nonzero-no-failures'; rc: number; pass: number } {
  const output = stripPodRepoRoot(run.output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
  const ran = lastMatch(output, /Ran (\d+) tests? across (\d+) files?/);
  // rc 1 only: other non-zero exits with a clean summary keep the established leaked-exit reading (clean) in failuresOf.
  const cleanNonzero = run.rc === 1 && !!ran && Number(ran[1]) >= 1 && Number(ran[2]) === 1
    && summaryCount(output, 'fail') === 0
    && (Number.isNaN(summaryCount(output, 'error')) || summaryCount(output, 'error') === 0)
    && parseFailures(output).length === 0 && !/\(fail\)/.test(output)
    && !/Unhandled error between tests/.test(output);
  if (!cleanNonzero) {
    const read = failuresOf(run, label);
    // Two (fail) lines folding into one id would undercount the file's failures: unreadable, not fewer.
    const failCount = summaryCount(output, 'fail');
    if (Number.isFinite(failCount) && read.failures.length !== failCount)
      throw new Error(`${label} incomplete (rc=${run.rc}; failure attribution summary=${failCount}, identified=${read.failures.length})`);
    return { kind: 'read', ...read };
  }
  // Bun's file headers, when present, must identify the requested file before the result is recorded or cached.
  // Any test-file path counts: root-level (`other.test.ts:`), nested, or absolute (outside the stripped Pod root).
  for (const raw of output.split(/\r?\n/)) {
    // Any characters but `:` (unicode, spaces, @, +, …) — a header is `<path ending in .test/.spec.ts>:`.
    const header = /^(?:\.\/)?([^\s:][^:]*?\.(?:test|spec)\.[cm]?[jt]sx?):/.exec(raw.trim());
    if (header && header[1] !== file)
      throw new Error(`${label} incomplete (rc=${run.rc}; isolated run attributed to another file: ${header[1]})`);
  }
  const pass = summaryCount(output, 'pass');
  if (pass !== Number(ran![1]))
    throw new Error(`${label} incomplete (rc=${run.rc}; pass=${Number.isNaN(pass) ? 'missing' : pass}; Ran=${ran![1]})`);
  // Validate the requested file as well as the summary; only this one file can own the synthetic id.
  fileOf(`${file} > [rc-nonzero]`);
  return { kind: 'rc-nonzero-no-failures', rc: run.rc, pass };
}

class StalledPodShards extends Error {
  constructor(readonly stalledShards: NonNullable<GateResult['stalledShards']>, readonly partialSummary: NonNullable<GateResult['partialSummary']>,
    readonly partialFailures: SweepFailures, readonly preservedShardCount: number, readonly abortedShards = 0) {
    const unmeasured = stalledShards.filter((item) => item.stall);
    const exitCode = stalledShards.filter((item) => item.reason === 'exit-code');
    super(`pod sweep incomplete: stalled shards ${stalledShards.map(({ shard }) => shard).join(', ')}`
      + (unmeasured.length ? ` (unmeasured: no test output within ${unmeasured[0]!.stall!.seconds}s of checkout — shards ${[...new Set(unmeasured.map(({ shard }) => shard))].join(', ')})` : '')
      + (exitCode.length ? ` (exit-code anomaly: 0 fail but exit ≠ 0/1 — ${[...new Set(exitCode.flatMap(({ files }) => files))].join(', ')})` : '')
      + (abortedShards ? ` (중단 조각 ${abortedShards}: mid-run-stall)` : ''));
  }
}

/** Read completed shard failures without letting one malformed shard hide the stalled-shard verdict. */
export function partialFailuresOf(runs: readonly (CommandResult & { files: number })[]): SweepFailures {
  return runs.reduce<SweepFailures>((sum, run) => {
    try {
      const parsed = failuresOf({ rc: run.rc, output: run.output, validatedShards: true }, `pod partial shard ${run.files}`);
      sum.failures.push(...parsed.failures);
      sum.errors.push(...parsed.errors);
    } catch (error) {
      debug.log('release-loop.gate', 'pod-partial-failures-unreadable', {
        files: run.files,
        reason: error instanceof Error ? error.message : String(error),
      }, { level: 'warn' });
    }
    return sum;
  }, { failures: [], errors: [] });
}

class WarmRecheckIncomplete extends Error {
  constructor(message: string, readonly file: string, readonly shadow: WarmShadowObservation) { super(message); }
}

class SettledRecheckFailures extends Error {
  constructor(readonly failures: unknown[]) {
    super(failures[0] instanceof Error ? failures[0].message : String(failures[0]));
  }
}

/** Isolated re-runs (host stall re-run · cut and baseline re-checks) are time-limited; sweeps and installs keep their full time. */
export const GATE_ISOLATED_TIMEOUT_MS = 300_000;
/** Default final recheck window size; overflow continues in later windows. */
export const GATE_HOST_RECHECK_FILE_LIMIT = 32;
/** Two isolated test processes in each of four Pods = eight at most, with one checkout/install per eight files. */
export const GATE_RECHECK_POD_BATCH_FILES = 8;
/** GATE-INTRO-RECHECK (0.2.19) — the per-test limit of the one re-run given to a «timed out after 5000ms» new failure.
 *  0.2.18: both first-gate introductions were 5 s limits missed at 6.04/6.06 s, and they alone cost an 84-minute re-gate. */
export const GATE_TIMEOUT_RECHECK_MS = 60_000;
/** TEST-CENSUS intake: one row per load-flaky test, in the machine ledger (read by the test census, never by the gate). */
export const loadFlakyCensusPath = (ledger: string) => join(ledger, 'release', 'test-census', 'load-flaky.jsonl');

/**
 * Runs a limited local command in its own process group. On timeout: SIGTERM the group (test-deterministic forwards it to its own
 * `bun test` group — Chrome included), SIGKILL after a grace, and return after a hard deadline even if a foreign-group process still holds the pipe.
 */
export function limitedLocalCommand(cmd: string, args: string[], cwd: string, limitMs: number, graceMs = 10_000): Promise<CommandResult> {
  return new Promise((resolveRun) => {
    const chunks: string[] = [];
    let timedOut = false;
    let done = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const child = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let kept = 0;
    // Same ceiling as the unlimited spawnSync path (maxBuffer 128MB): drop the oldest output beyond it, keep the tail.
    const keep = (d: string) => { chunks.push(d); kept += d.length; while (kept > 128 * 1024 * 1024 && chunks.length > 1) kept -= chunks.shift()!.length; };
    child.stdout?.setEncoding('utf8').on('data', keep);
    child.stderr?.setEncoding('utf8').on('data', keep);
    const signalGroup = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { /* group already gone */ } };
    const finish = (code: number | null, error?: Error) => {
      if (done) return;
      done = true;
      for (const timer of timers) clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const tail = error ? `\n${error}` : timedOut ? `\nkilled after ${limitMs}ms (process group)` : '';
      resolveRun({ rc: code ?? 2, output: `${chunks.join('')}${tail}`, ...(timedOut ? { timedOut } : {}) });
    };
    timers.push(setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      timers.push(setTimeout(() => signalGroup('SIGKILL'), graceMs));
      timers.push(setTimeout(() => finish(null), graceMs + 5_000));
    }, limitMs));
    child.on('error', (error) => finish(null, error));
    child.on('close', (code) => finish(code));
  });
}

/**
 * GATE-MEM-ADMIT (0.2.20) — the gate's shard Jobs ask the same pool admission harness goal Pods ask
 * (`PodPoolScheduler.acquireAdmission` · memory headroom by observed usage · `limitedBy`). 0.2.19: 8 shards sat Pending
 * for CPU (requests 31.2/32) because harness Pods held the node and the gate counted only its own Jobs (#24698).
 * The gate never deadlocks on it: after {@link GATE_ADMISSION_WAIT_SECONDS_DEFAULT} it launches anyway and records
 * `admission-timeout`; an admission error launches at once (`admission-error`). Harness launches wait without a bound,
 * so the gate keeps priority.
 */
export interface GateAdmission {
  acquire(signal: AbortSignal): Promise<() => void>;
  /** The pool-wide reading admission waits on (recommended · limitedBy · memorySlots); null before any reading. */
  waitReason(): string | null;
}
export const GATE_ADMISSION_WAIT_SECONDS_DEFAULT = 300;
export type GateAdmissionOutcome = 'granted' | 'admission-timeout' | 'admission-error' | 'off';
export interface GateAdmissionResult { outcome: GateAdmissionOutcome; waitedMs: number; reason?: string; release: () => void }
export const gateAdmissionWaitText = (reading: string | null) => `메모리 여유 대기(admission) · ${reading ?? '측정 전'}`.slice(0, 160);
/**
 * GATE-MULTI-HOST (0.2.25 · 대표) — the gate pool is a host roster (`release.loop.gatePodPool` =
 * `pool-node-b@node-b:N,pool-node-c@node-c:M,…`); shards spread over it by free share (selfCapped). A member that fails a
 * shard's launch or goes silent mid-Job is probed; if it is unreachable it leaves the roster for the rest of this gate and
 * the shard runs again on the others — one dead host no longer stops the gate. One-member pools keep the old behaviour.
 */
export const GATE_MEMBER_UNREADABLE_SECONDS_DEFAULT = 600;
export function defaultGateMemberProbe(member: PodPoolMember): boolean {
  if (!checkPodPool([member], defaultKubectl).ok) return false;
  return !member.sshHost || defaultRemoteRun(member.sshHost, 'true').status === 0;
}

export function poolGateAdmission(pool: PodPoolScheduler): GateAdmission {
  return { acquire: (signal) => pool.acquireAdmission(signal, undefined, { gate: true }), waitReason: () => pool.waitReason() };
}
export async function admitGateShard(admission: GateAdmission | undefined, o: { waitMs: number; onWait: (reason: string) => void; reasonPollMs?: number; firstReasonMs?: number }): Promise<GateAdmissionResult> {
  const noop = () => {};
  if (!admission || !(o.waitMs > 0)) return { outcome: 'off', waitedMs: 0, release: noop };
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  let lastReason: string | undefined;
  const tell = () => { lastReason = gateAdmissionWaitText(admission.waitReason()); o.onWait(lastReason); };
  const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, o.waitMs);
  // A grant inside the first moment never touches the shard row (no flapping in shards.json).
  let ticker: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => { tell(); ticker = setInterval(tell, o.reasonPollMs ?? 15_000); }, o.firstReasonMs ?? 1_000);
  try {
    const granted = await admission.acquire(controller.signal);
    // Released at placement and again after the Job (the launch may fail before placement): only the first counts.
    let released = false;
    const release = () => { if (!released) { released = true; granted(); } };
    return { outcome: 'granted', waitedMs: Date.now() - started, ...(lastReason ? { reason: lastReason } : {}), release };
  } catch (error) {
    if (timedOut) return { outcome: 'admission-timeout', waitedMs: Date.now() - started, reason: lastReason ?? gateAdmissionWaitText(admission.waitReason()), release: noop };
    return { outcome: 'admission-error', waitedMs: Date.now() - started, reason: (error instanceof Error ? error.message : String(error)).slice(0, 160), release: noop };
  } finally {
    clearTimeout(deadline);
    clearTimeout(first);
    if (ticker) clearInterval(ticker);
  }
}

export function createGateRunner(repo: string, remote?: string, commandOverride?: GateRunner['command'], podCommand: (options: RunPodCommandOptions) => Promise<PodCommandResult> = runPodCommand, poolOverride?: PodPoolScheduler, podLogTail?: (job: PodCommandResult) => string): GateRunner {
  let remoteMirror: string | undefined;
  // GATE-HOSTMIRROR-EXPLICIT: resolved once per runner and handed to every podCommand (shard · retry · recheck).
  let gateMirror: GateHostMirror | undefined;
  const gateHostMirror = (pod: NonNullable<GateOptions['pod']>): { hostMirror?: string } => {
    if (!gateMirror) {
      gateMirror = resolveGateHostMirror(pod.hostMirror, pod.hostMirrorReaders ?? (poolOverride ? { env: process.env } : defaultGateHostMirrorReaders()));
      debug.log('release-loop.gate', 'host-mirror-resolved', { source: gateMirror.source, path: gateMirror.path });
    }
    return gateMirror.hostMirror ? { hostMirror: gateMirror.hostMirror } : {};
  };
  const localCommand: GateRunner['localCommand'] = async (cmd, args, cwd, limitMs) => {
    if (limitMs) return limitedLocalCommand(cmd, args, cwd, limitMs);
    const run = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    return { rc: run.status ?? 2, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}${run.error ? `\n${run.error}` : ''}` };
  };
  const command: GateRunner['command'] = commandOverride ?? (remote
    ? async (cmd, args, cwd, limitMs) => {
      // A limited remote run is killed on the remote host; the local ssh deadline is a backstop.
      // GNU timeout signals its own process group: -s KILL would kill timeout too (ssh 255), so TERM first then KILL after 10s (124 / 137).
      // No coreutils timeout on the remote → run unlimited there and rely on the local ssh deadline.
      const limitPrefix = limitMs ? `$(command -v timeout >/dev/null 2>&1 && echo 'timeout -k 10 ${Math.ceil(limitMs / 1000)}') ` : '';
      // Start in /tmp, not the caller checkout. macOS resolves that symlink to /private/tmp before the child sees it;
      // the remote command still `cd`s to the quoted path, so either spelling is the same directory.
      const run = spawnSync('ssh', [remote, `PATH=$HOME/.bun/bin:/opt/homebrew/bin:$PATH; export PATH; cd ${quote(cwd)} && ${limitPrefix}${[cmd, ...args].map(quote).join(' ')}`],
        { cwd: '/tmp', encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...(limitMs ? { timeout: limitMs + 60_000, killSignal: 'SIGKILL' as const } : {}) });
      const timedOut = !!limitMs && (run.status === 124 || run.status === 137 || (run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT');
      return { rc: run.status ?? 2, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}${run.error ? `\n${run.error}` : ''}`, ...(timedOut ? { timedOut } : {}) };
    }
    : localCommand);
  const podSweep = async (tree: string, logDir: string | undefined, pod: NonNullable<GateOptions['pod']>, only?: readonly string[]): Promise<CommandResult> => {
    const sweepId = randomUUID();
    const shardCount = pod.shards ?? 24;
    const isolationConcurrency = pod.isolationConcurrency ?? 4;
    // GATE-TIMEOUT-HEAL ①: the configured value is the floor; each shard's own deadline is shardDeadlineSeconds(planned).
    const deadlineSeconds = pod.shardTimeoutSeconds ?? POD_SHARD_TIMEOUT_FLOOR_SECONDS;
    if (!pod.pool || !Number.isSafeInteger(shardCount) || shardCount < 1
      || !Number.isSafeInteger(deadlineSeconds) || deadlineSeconds < 1
      || !Number.isSafeInteger(isolationConcurrency) || isolationConcurrency < 1) throw new Error('invalid pod sweep options');
    const head = await command('git', ['rev-parse', 'HEAD'], tree);
    check(head, 'cut tree HEAD');
    const commit = head.output.trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('invalid cut tree HEAD');
    const selectionStart = Date.now();
    const listed = await command('git', ['ls-files', '*.test.*'], tree);
    check(listed, 'git ls-files tests');
    const allFiles = listed.output.split(/\r?\n/).filter((file) => /\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file)).sort();
    const onlySet = only ? new Set(only) : undefined;
    // GATE-PARTIAL: every planned file must exist at this commit — a deleted/renamed failing file would otherwise «pass»
    // by not running. Fail closed (gate error), never a smaller sweep than planned.
    const missing = only?.filter((file) => !allFiles.includes(file)) ?? [];
    if (missing.length) throw new Error(`partial plan file missing at this commit: ${missing.slice(0, 5).join(', ')}`);
    const files = onlySet ? allFiles.filter((file) => onlySet.has(file)) : allFiles;
    if (files.some((file) => file.startsWith('-') || file.startsWith('/') || file.startsWith('./')
      || file.split('/').some((part) => !part || part === '.' || part === '..') || /[\r\n]/.test(file))) throw new Error('unsafe pod test path');
    if (new Set(files).size !== files.length) throw new Error('duplicate pod test path');
    if (!files.length) throw new Error('sweep incomplete: no tests ran');
    const cdp = await command('rg', ['-l', '--glob', '*.test.ts', '-e', 'requireCdpBase', '-e', '9333', 'test', 'scripts'], tree);
    if (cdp.rc !== 0 && cdp.rc !== 1) throw new Error(`CDP pattern discovery failed (rc=${cdp.rc}): ${tail40(cdp.output)}`);
    const cdpPatterns = cdp.output.split(/\r?\n/).filter((path) => path.endsWith('.test.ts'));
    // CDP 시험은 `test:deterministic` 이 스스로 뺀다 — 조각에 그것만 남으면 bun «시험 없음» exit 1 을 «불완전»으로 읽었다(09-30 G1d 실측 둘).
    // bun 의 탐색은 숨은 디렉터리(`.x/`)를 안 연다 — 사람의 `bun test` 가 한 번도 안 돌리는 빈 픽스처가 조각에 혼자 남아 «Ran 0 tests» 를 «불완전»으로 읽었다(09-30 G1e 5번 조각).
    const assignable = files.filter((file) => !cdpPatterns.includes(file) && !POD_SWEEP_INTEGRATION_ONLY.includes(file)
      && !file.split('/').some((part) => part.startsWith('.')));
    const integrationOnly = files.filter((file) => POD_SWEEP_INTEGRATION_ONLY.includes(file));
    if (integrationOnly.length) debug.log('release-loop.gate', 'pod-sweep-integration-only', { files: integrationOnly });
    if (!assignable.length) throw new Error('sweep incomplete: no tests ran');
    const { durations, wall: planWall } = planDurations(pod.durationSource);
    const memory = readFileMemory(join(tree, POD_MEMORY_SOURCE));
    // The TD1 measurements predate the fixture-only gate; do not isolate those five files at their old 2–13 GB peaks.
    const fixtureOnly = new Set([...GATE_NIGHTLY_AUDITS, 'test/guardian/dispatch-surface-contract.test.ts', 'test/user-config-mcp.test.ts']);
    const heavy = new Set(assignable.filter((file) => !fixtureOnly.has(file) && (memory.get(file) ?? 0) >= POD_HEAVY_FILE_MB));
    const { shards: lightShards, spawnFiles: spawnLane, spawnShardCount } = planGateSpawnSeparatedShards(assignable.filter((file) => !heavy.has(file)), durations, shardCount);
    const shards = [
      ...lightShards,
      ...[...heavy].map((file) => ({ files: [file], plannedSeconds: durations.get(file) ?? 0 })),
    ];
    if (spawnLane.length) debug.log('release-loop.gate', 'pod-spawn-lane', { files: spawnLane, shards: spawnShardCount });
    logPlanWalltime(planWall, shards);
    if (heavy.size) debug.log('release-loop.gate', 'pod-heavy-alone', { files: [...heavy], thresholdMb: POD_HEAVY_FILE_MB, memoryLimit: POD_ISOLATION_MEMORY_LIMIT });
    const known = assignable.filter((file) => durations.has(file)).length;
    debug.log('release-loop.gate', 'pod-shard-plan', {
      shards: shards.length, known, unknown: assignable.length - known,
      maxPlannedSeconds: Math.max(...shards.map((shard) => shard.plannedSeconds)),
      source: durations.size ? pod.durationSource : 'none',
    });
    reportSelectionTimed(Date.now() - selectionStart, assignable.length, pod.onSelectionTimed);
    // GATE-SPEED A3①: shard Pod CPU (`release.loop.gatePodCpu` · default request 1 / limit 4) — shards × request must fit the pool.
    const cpu = resolvePodCpu(pod.cpu);
    // Only evidence-backed opt-in files reach this batch; every other file retains its own Pod below.
    const batchWidth = Math.max(1, Math.min(4, Math.floor(podCpuMillis(cpu.limit)! / 1000)));
    debug.log('release-loop.gate', 'shard-resources', { shards: shards.length, cpuRequest: cpu.request, cpuLimit: cpu.limit, cpuSource: pod.cpu ? 'config' : 'default' });
    debug.log('release-loop.gate', 'isolation-batch-width', { batchWidth, cpuLimit: cpu.limit });
    const ready = poolOverride ? undefined : checkPodPool(parsePodPool(pod.pool), defaultKubectl);
    if (ready && !ready.ok) throw new Error('pod command: 풀의 노드가 하나도 준비되지 않았다');
    const poolScheduler = poolOverride ?? new PodPoolScheduler(ready!.ready);
    const configCache = typeof pod.bunCache === 'string' ? pod.bunCache.trim() : '';
    const envCache = process.env[POD_BUN_CACHE_HOST_PATH]?.trim();
    const bunCache = configCache || envCache || undefined;
    debug.log('release-loop.gate', 'pod-bun-cache', { source: configCache ? 'config' : envCache ? 'env' : 'none' });
    const cachePrefix = bunCache ? podBunCacheVolume(bunCache).shellPrefix : '';
    // GATE-INSTALL-CACHE: node-wide install slots (see pod-install-slots.ts for the measured cause and the safety argument).
    const installSlots = pod.installSlots ?? POD_INSTALL_SLOTS_DEFAULT;
    if (!Number.isSafeInteger(installSlots) || installSlots < 0) throw new Error('invalid pod sweep options');
    debug.log('release-loop.gate', 'pod-install-slots', { slots: installSlots, source: pod.installSlots !== undefined ? 'config' : 'default' });
    // GATE-MEM-ADMIT: every shard Job (retries and splits too) asks pool admission before it is placed.
    const admissionWaitSeconds = pod.admissionWaitSeconds ?? GATE_ADMISSION_WAIT_SECONDS_DEFAULT;
    if (!Number.isSafeInteger(admissionWaitSeconds) || admissionWaitSeconds < 0) throw new Error('invalid pod sweep options');
    // An injected pool (tests) runs without admission unless `pod.admission` is passed; the gate's own pool asks it.
    const gateAdmission = pod.admission ?? (poolOverride ? undefined : poolGateAdmission(poolScheduler));
    debug.log('release-loop.gate', 'pod-admission', { waitSeconds: admissionWaitSeconds, source: pod.admissionWaitSeconds !== undefined ? 'config' : 'default', enabled: !!gateAdmission && admissionWaitSeconds > 0 });
    // GATE-POD-STALL-FAILFAST: a shard with no test output within the stall window is stopped and recorded unmeasured.
    const stallSeconds = pod.stallSeconds ?? GATE_POD_STALL_SECONDS_DEFAULT;
    const stallPollMs = pod.stallPollMs ?? GATE_POD_STALL_POLL_MS;
    if (!Number.isFinite(stallSeconds) || stallSeconds < 0 || !Number.isFinite(stallPollMs) || stallPollMs <= 0) throw new Error('invalid pod sweep options');
    // An injected pool (tests) runs without the watch unless `pod.liveLog` is passed — never a real kubectl from a test.
    const liveLog = pod.liveLog ?? (poolOverride ? undefined : (job: { name: string; context?: string }) => {
      if (!job.context) return null;
      const logs = defaultKubectl(['--context', job.context, '-n', 'elanous-test', 'logs', `job/${job.name}`, '-c', 'child', '--tail=400']);
      return logs.status === 0 ? logs.stdout : null;
    });
    const stopJob = pod.stopJob ?? ((job: { name: string; context?: string }) => {
      // Not `delete job`: runPodCommand would poll a missing Job forever. A 1 s deadline makes the Job fail now and
      // runPodCommand returns through its normal path (logs · exit code · Secret cleanup).
      if (!job.context) return false;
      const patched = defaultKubectl(['--context', job.context, '-n', 'elanous-test', 'patch', 'job', job.name, '--type=merge', '-p', JSON.stringify({ spec: { activeDeadlineSeconds: 1 } })]);
      if (patched.status !== 0) debug.log('release-loop.gate', 'pod-shard-stall-stop-failed', { job: job.name, error: patched.stderr.trim().slice(0, 300) }, { level: 'warn' });
      return patched.status === 0;
    });
    const stallWatch = stallSeconds > 0 && !!liveLog;
    debug.log('release-loop.gate', 'pod-stall-watch', { stallSeconds, source: pod.stallSeconds !== undefined ? 'config' : 'default', enabled: stallWatch });
    // GATE-POD-STALL-FAILFAST ①: a hang after test output began ends only the Pod's test process group (never the Job).
    const midRunStallSeconds = pod.midRunStallSeconds ?? GATE_POD_MIDRUN_STALL_SECONDS_DEFAULT;
    if (!Number.isFinite(midRunStallSeconds) || midRunStallSeconds < 0) throw new Error('invalid pod sweep options');
    const abortTests = pod.abortTests ?? (poolOverride ? undefined : (job: { name: string; context?: string }, reason: string) => {
      if (!job.context) return false;
      const ran = defaultKubectl(['--context', job.context, '-n', 'elanous-test', 'exec', `job/${job.name}`, '-c', 'child', '--', 'bash', '-c', gateShardAbortScript(reason)]);
      if (ran.status !== 0) debug.log('release-loop.gate', 'shard-abort-failed', { job: job.name, rc: ran.status, out: `${ran.stdout}${ran.stderr}`.trim().slice(0, 300) }, { level: 'warn' });
      return ran.status === 0;
    });
    const midRunWatch = stallWatch && midRunStallSeconds > 0 && !!abortTests;
    debug.log('release-loop.gate', 'pod-midrun-stall-watch', { midRunStallSeconds, source: pod.midRunStallSeconds !== undefined ? 'config' : 'default', enabled: midRunWatch });
    /** Shard Pods the mid-run watch aborted in this sweep (the verdict summary's «중단 조각 n»). */
    let abortedShards = 0;
    // GATE-MULTI-HOST: members found unreachable during this gate — skipped for placement while any other member is left.
    const downMembers = new Set<string>();
    let tailPlacedHost: string | undefined;
    const multiHost = poolScheduler.members.length > 1;
    const probeMember = pod.probeMember ?? (poolOverride ? undefined : defaultGateMemberProbe);
    const memberUnreadableSeconds = pod.memberUnreadableSeconds ?? GATE_MEMBER_UNREADABLE_SECONDS_DEFAULT;
    if (!Number.isFinite(memberUnreadableSeconds) || memberUnreadableSeconds < 0) throw new Error('invalid pod sweep options');
    debug.log('release-loop.gate', 'pod-roster', { members: poolScheduler.members.map((m) => ({ context: m.context, host: m.sshHost ?? null, capacity: m.capacity })),
      dropped: ready?.dropped ?? [], multiHost, probe: !!probeMember });
    /** True when the shard's member is (now) known unreachable — a newly found one is logged and leaves the roster. */
    const memberLost = (context: string, shard: number, error: string): boolean => {
      if (downMembers.has(context)) return true;
      const member = poolScheduler.members.find((m) => m.context === context);
      if (!multiHost || !probeMember || !member) return false;
      let reachable: boolean;
      try { reachable = probeMember(member); } catch { reachable = false; }
      if (reachable) return false;
      downMembers.add(context);
      debug.log('release-loop.gate', 'pod-member-down', { member: context, host: member.sshHost ?? null, shard, error: error.slice(0, 300),
        remaining: poolScheduler.members.filter((m) => !downMembers.has(m.context)).map((m) => m.context) }, { level: 'warn' });
      return true;
    };
    const jobLogTail = (job: PodCommandResult): string => {
      if (podLogTail) return podLogTail(job);
      for (const member of poolScheduler.members.filter((m) => !downMembers.has(m.context))) {
        const logs = defaultKubectl(['--context', member.context, '-n', 'elanous-test', 'logs', `job/${job.job}`, '-c', 'child', '--tail=200']);
        if (logs.status === 0 && logs.stdout) return logs.stdout;
      }
      return '';
    };
    const failureEvidence = pod.failureEvidence ?? ((job: { name: string; context?: string }) => {
      if (!job.context) return { error: '수거 실패 · Job 배치 context 없음' };
      const prefix = ['--context', job.context, '--request-timeout=5s', '-n', 'elanous-test'];
      const errors: string[] = [];
      let termination: { reason?: string; message?: string; exitCode?: number; finishedAt?: string } | undefined;
      let podName: string | undefined;
      let latestEndedAt = -Infinity;
      const status = (pod.failureKubectl ?? defaultKubectl)([...prefix, 'get', 'pods', '-l', `job-name=${job.name}`, '-o', 'json']);
      if (status.status !== 0) errors.push(`Pod 상태: ${status.stderr.trim() || `kubectl rc=${status.status}`}`);
      else try {
        const pods = JSON.parse(status.stdout) as { items?: Array<{ metadata?: { name?: string; creationTimestamp?: string }; status?: { containerStatuses?: Array<{ name?: string; state?: { terminated?: typeof termination } }> } }> };
        for (const item of pods.items ?? []) {
          const child = item.status?.containerStatuses?.find((container) => container.name === 'child');
          const ended = child?.state?.terminated;
          if (!ended || !item.metadata?.name) continue;
          const endedAt = Date.parse(ended.finishedAt ?? item.metadata.creationTimestamp ?? '');
          const rank = Number.isFinite(endedAt) ? endedAt : -Infinity;
          if (!termination || rank > latestEndedAt) { podName = item.metadata.name; termination = ended; latestEndedAt = rank; }
        }
        if (!termination) errors.push('Pod 상태: child 종료 사유 없음');
      } catch (error) { errors.push(`Pod 상태 JSON: ${String(error)}`); }
      const logs = podName ? (pod.failureKubectl ?? defaultKubectl)([...prefix, 'logs', `pod/${podName}`, '-c', 'child', '--tail=100']) : undefined;
      if (!logs) errors.push('로그: 종료된 Pod 이름 없음');
      else if (logs.status !== 0) errors.push(`로그: ${logs.stderr.trim() || `kubectl rc=${logs.status}`}`);
      return { ...(podName ? { podName } : {}), ...(termination ? { termination } : {}), ...(logs?.status === 0 ? { logTail: logs.stdout } : {}),
        ...(errors.length ? { error: `수거 실패 · ${errors.join(' · ')}` } : {}) };
    });
    type ShardRun = { output: string; rc: number; pass: number; fail: number; errors: number; ran: number; files: number; passedIds: string[] };
    type ShardReason = NonNullable<GateResult['stalledShards']>[number]['reason'];
    // 깊이 끝 OOM 조각은 «조각 전체»를 파일 하나씩 격리한다 — 상한 40 이면 나머지가 못 잰 채 남았다(09-30 ① 7번 조각 110 파일).
    const isolationRemaining = shards.map((item) => item.files.length);
    // One sweep-wide permit pool: independent root shards must not each launch their own unbounded file fan-out.
    let activeIsolation = 0;
    const isolationWaiters: Array<() => void> = [];
    const isolatedFile = async <T>(run: () => Promise<T>): Promise<T> => {
      if (activeIsolation < isolationConcurrency) activeIsolation++;
      else await new Promise<void>((resolve) => isolationWaiters.push(resolve));
      try { return await run(); }
      finally {
        const next = isolationWaiters.shift();
        if (next) next(); // transfer this permit directly; queued callers cannot exceed the cap
        else activeIsolation--;
      }
    };
    debug.log('release-loop.gate', 'pod-isolation-concurrency', { limit: isolationConcurrency, source: pod.isolationConcurrency === undefined ? 'default' : 'config' });
    const knownFailures = new Set(pod.knownFailures ?? []);
    const batchSafe = loadGateBatchSafe(repo);
    debug.log('release-loop.gate', 'batch-safe-opt-in', { files: batchSafe.size });
    const estimated = (paths: string[]) => paths.reduce((sum, file) => {
      const value = durations.get(file);
      return sum + (value !== undefined && Number.isFinite(value) && value >= 0 ? value : unknownSeconds);
    }, 0);
    const knownTimes = assignable.map((file) => durations.get(file)).filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    const unknownSeconds = knownTimes.length ? (knownTimes[Math.floor((knownTimes.length - 1) / 2)]! + knownTimes[Math.floor(knownTimes.length / 2)]!) / 2 : 1;
    // GATE-LIVE-OBS — one row per root shard in the release ledger's shards.json (UX contract · src/release-loop/gate-shards.ts).
    // Retries and splits of a shard update its row. A write failure is logged and never stops the gate.
    const board: GateShard[] = shards.map((item, index) => ({ id: `pod-${index}`, state: 'pending', plannedMin: Math.round(item.plannedSeconds / 6) / 10 }));
    const flushBoard = () => {
      if (!pod.shardsFile) return;
      try { writeGateShards(pod.shardsFile.path, { v: 1, version: pod.shardsFile.version, updatedAt: new Date().toISOString(), shards: board }); }
      catch (error) { debug.log('release-loop.gate', 'shards-write-failed', { path: pod.shardsFile.path, error: String(error) }); }
    };
    const markShard = (shard: number, patch: Partial<GateShard>, clear: Array<keyof GateShard> = []) => {
      const row = board[shard];
      if (!row) return;
      const next: GateShard = { ...row, ...patch };
      for (const key of clear) delete next[key];
      if (JSON.stringify(next) === JSON.stringify(row)) return;
      board[shard] = next;
      flushBoard();
    };
    flushBoard();
    /** The gate's scheduler, seen through one shard: a slot wait and the Pod start become row states. */
    // GATE-MEM-ADMIT: `placed` releases the shard's admission once a member is chosen — from then on the Job is
    // Pending/Running in the cluster and the next admission reading counts it, so holding the lease would count it twice.
    const trackedPool = (shard: number, retry: boolean, placed: (member: NonNullable<Awaited<ReturnType<PodPoolScheduler['tryAcquire']>>>) => void = () => {}, skipMembers: ReadonlySet<string> = new Set()): PodPoolScheduler => ({
      members: poolScheduler.members,
      tryAcquire: async (...[skip, onEmpty, mode]: Parameters<PodPoolScheduler['tryAcquire']>) => {
        // GATE-MULTI-HOST: a lost member is skipped while another member is left (all lost = the old behaviour).
        const anyLeft = poolScheduler.members.some((m) => !downMembers.has(m.context));
        const excluded = new Set([...(skip ?? []), ...skipMembers, ...(downMembers.size && anyLeft ? downMembers : [])]);
        const member = await poolScheduler.tryAcquire(excluded.size ? excluded : undefined, onEmpty, mode);
        if (member) placed(member);
        if (member) markShard(shard, { state: retry ? 'retry' : 'running', startedAt: board[shard]?.startedAt ?? new Date().toISOString(), host: member.context }, ['waitReason']);
        else markShard(shard, { waitReason: 'Pod 자리 대기' });
        return member;
      },
      release: (member: Parameters<PodPoolScheduler['release']>[0]) => poolScheduler.release(member),
    }) as unknown as PodPoolScheduler;
    const runShard = async (paths: string[], shard: number, depth = 0, branch = '', retriedNoOutput = false, fresh = pod.freshShards === true, parentAttempt?: string, hostRetries = 0, batchIsolation = false, skipMembers: ReadonlySet<string> = new Set(), singleShotTail = false): Promise<{ runs: ShardRun[]; stalled: NonNullable<GateResult['stalledShards']> }> => {
      // 파일별 소요는 junit 으로 남긴다 — 콘솔 요약(판정 원천)은 그대로이고, 느린 시험 목록(K10 D4)·계층 분리(D2)의 자가 된다.
      // GATE-TIMEOUT-HEAL: parts (each with its own junit) under a soft deadline inside this shard's own Job deadline.
      const shardDeadline = shardDeadlineSeconds(batchIsolation ? Math.max(...paths.map((file) => estimated([file]))) * Math.ceil(paths.length / batchWidth) : estimated(paths), deadlineSeconds);
      const parts = batchIsolation ? paths.map((file) => [file]) : shardParts(paths, (file) => estimated([file]));
      const memoryLimit = batchIsolation || paths.length === 1 && (depth >= 1 || heavy.has(paths[0]!)) ? POD_ISOLATION_MEMORY_LIMIT : undefined;
      const shellOptions = { parts, cdpPatterns, softSeconds: softDeadlineSeconds(shardDeadline), cachePrefix, installSlots, ...(batchIsolation ? { parallelParts: batchWidth } : {}) };
      const keyShell = gateShardShell(shellOptions);
      // The stall beat only reports; runKey keeps hashing the shell without it, so earlier results stay reusable.
      const runKey = createHash('sha256').update(JSON.stringify({ pool: pod.pool, podShell: keyShell, memoryLimit: memoryLimit ?? null, deadlineSeconds: shardDeadline, bunCache: bunCache ?? null })).digest('hex');
      let start = Date.now();
      let admitted: GateAdmissionResult | undefined;
      let output: string | undefined;
      const phaseTimes: Record<string, string> = {};
      const stamp = (phase: string) => { phaseTimes[phase] = new Date().toISOString(); };
      let podStages: Record<string, number> | undefined;
      let podLifecycle: Record<string, string> | undefined;
      let imageDigest: string | null = null;
      let podJobName: string | undefined;
      let batchArtifactsComplete = true;
      let junit: string | undefined;
      let rc: number | undefined;
      let jobExitCode: number | undefined;
      let batchArtifactDir: string | undefined;
      let lastFile: string | undefined;
      let jobFailed = false;
      let jobError = '';
      let failureCapture: ReturnType<NonNullable<NonNullable<GateOptions['pod']>['failureEvidence']>> | undefined;
      let jobNameForCapture: string | undefined;
      let jobContextForCapture: string | undefined;
      const captureFailure = () => {
        try { failureCapture = failureEvidence({ name: jobNameForCapture ?? 'unplaced', context: jobContextForCapture }); }
        catch (error) { failureCapture = { error: `수거 실패 · ${String(error)}` }; }
      };
      /** GATE-MULTI-HOST — the member this shard's Job was placed on (recorded in the shard json / log / board). */
      let placedOn: string | undefined;
      let timedOut = false;
      let finished: string[] = [];
      let unfinishedLog: string | undefined;
      let exitCodeOnly: string[] | undefined;
      let stall: { seconds: number; sinceCheckoutMs: number } | undefined;
      let stallWatchState: ShardStallWatchState | undefined;
      let abort: ShardAbort | undefined;
      // The way down a previous attempt took wins over its own log: that log was not a verdict, or it would have no children.
      // The split this shard would take if it failed here — the same rule as the split code below (isolation at depth 2 ·
      // cap chunks for a big root shard · halves otherwise · none for one file).
      // Isolation follows only while this shard's isolation budget still covers every file (review r7) — the budget is the
      // shard's file count and isolations take disjoint files, so this holds unless the plan changed; if not, run the Pod.
      const splitChild = depth === 2 && paths.length > 1 ? (isolationRemaining[shard]! >= paths.length
        ? batchIsolation || !paths.every((file) => batchSafe.has(file)) ? '-file-0' : '-batch' : undefined)
        : depth < 2 && paths.length > 1 ? (depth === 0 && paths.length > POD_SHARD_FILE_CAP ? '-c0' : '-0') : undefined;
      const found = !fresh && logDir ? previousShardDescent(logDir, `pod-${shard}${branch}`, commit, paths, runKey, parentAttempt, splitChild) : undefined;
      const descent = found?.way;
      const reused = !fresh && !descent && logDir ? previousShardResult(logDir, `pod-${shard}${branch}`, commit, paths, runKey, parentAttempt) : undefined;
      // This shard's attempt id: the recorded one when its way down is followed, a new one when a Pod runs. Children carry it.
      const attemptId = found?.attemptId ?? randomUUID();
      // The Pod itself stamps its cut and attempt before the test starts. A
      // collector-created manifest cannot reassign another Job's bytes.
      const podShell = gateShardShell({ ...shellOptions,
        ...(stallWatch ? { beatSeconds: gateStallBeatSeconds(stallSeconds) } : {}),
        sourceBinding: { cutSha: commit, attemptId } });
      if (descent === 'retry') {
        // «descend» is only the way down; «resumed» comes from each leaf whose log reads cleanly (review r4).
        debug.log('release-loop.gate', 'pod-shard-descend', { shard, branch, files: paths.length, via: 'retry' });
        return runShard(paths, shard, depth, `${branch}-retry`, true, undefined, attemptId, hostRetries, batchIsolation, skipMembers);
      }
      if (descent === 'split') {
        output = undefined;
        debug.log('release-loop.gate', 'pod-shard-descend', { shard, branch, files: paths.length, via: 'split' });
      } else if (reused) {
        output = reused.output;
        junit = reused.junit;
        rc = reused.rc;
        jobExitCode = 0;
        lastFile = lastStartedTestFile(output, paths);
      } else try {
        stamp('admissionStart');
        admitted = await admitGateShard(gateAdmission, { waitMs: admissionWaitSeconds * 1000, onWait: (reason) => markShard(shard, { waitReason: reason }) });
        stamp('admissionEnd');
        if (admitted.outcome !== 'off') debug.log('release-loop.gate', 'shard-admission', { shard, branch, outcome: admitted.outcome, waitedMs: admitted.waitedMs, ...(admitted.reason ? { reason: admitted.reason } : {}) },
          admitted.outcome === 'granted' ? undefined : { level: 'warn' });
        // The admission wait is not the shard's run time: deadline/timeout judgment and the measured duration start here.
        start = Date.now();
        const jobName = `gate-${randomUUID()}`;
        jobNameForCapture = jobName;
        // The member's context is known once the Job is placed; the live log is read (and the Job stopped) there.
        let jobContext: string | undefined;
        const liveJob = () => ({ name: jobName, ...(jobContext ? { context: jobContext } : {}) });
        // Grace = two beats ⊕ one poll: test output that appeared inside the window is seen before the stop.
        const watch = stallWatch ? watchShardStall({ stallSeconds, pollMs: stallPollMs, graceMs: 2 * gateStallBeatSeconds(stallSeconds) * 1000 + stallPollMs, read: () => liveLog!(liveJob()),
          onStall: (sinceCheckoutMs) => debug.log('release-loop.gate', 'pod-shard-stall', { shard, branch, stallSeconds, sinceCheckoutMs }, { level: 'warn' }),
          stopJob: () => {
            try { return stopJob(liveJob()); }
            catch (error) { debug.log('release-loop.gate', 'pod-shard-stall-stop-failed', { job: jobName, error: String(error) }, { level: 'warn' }); return false; }
          },
          ...(midRunWatch ? {
            midRunStallSeconds,
            onAbort: ({ sinceLastOutputMs }: { sinceLastOutputMs: number }) => debug.log('release-loop.gate', 'shard-abort',
              { shard, branch, reason: `mid-run-stall ${midRunStallSeconds}s`, by: 'auto', sinceLastOutputMs }, { level: 'warn' }),
            abortTests: () => {
              try { return abortTests!(liveJob(), `mid-run-stall ${midRunStallSeconds}s`); }
              catch (error) { debug.log('release-loop.gate', 'shard-abort-failed', { job: jobName, error: String(error) }, { level: 'warn' }); return false; }
            },
          } : {}) }) : undefined;
        const placed = admitted.release;
        const job = await podCommand({
          provenanceGate: true,
          provenance: { actorKind: process.env.ELANOUS_SEAT ? 'seat' : 'loop', actor: process.env.ELANOUS_SEAT || 'release-loop',
            character: 'gate-shard-runner', launchHost: hostname(), entrance: process.env.ELANOUS_RELEASE_ENTRANCE?.trim() || 'release-run',
            kind: 'gate-shard', run: process.env.ELANOUS_RUN_ID || sweepId, phase: 'release-gate', requestedAt: new Date().toISOString(),
            graphNode: 'gate', version: pod.shardsFile?.version, commit, shard: `${shard + 1}-of-${shards.length}`,
            reason: `release gate shard ${shard + 1}/${shards.length}`, pool: pod.pool, cpuReq: cpu.request,
            memReq: memoryLimit ?? POD_ISOLATION_MEMORY_LIMIT, warmReused: false },
          pool: pod.pool, poolScheduler: trackedPool(shard, depth > 0 || branch !== '', (member) => {
            stamp('poolPlaced'); jobContext = member.context; jobContextForCapture = member.context; placedOn = member.context; placed();
            if (branch === '-tail') tailPlacedHost = member.context;
          }, skipMembers), clone: true, source: { kind: 'commit', sha: commit }, deadlineSeconds: shardDeadline,
          ...gateHostMirror(pod),
          ...(multiHost ? { statusUnreadableMs: memberUnreadableSeconds * 1000 } : {}),
          ...(bunCache ? { bunCache } : {}),
          ...(installSlots > 0 ? { installSlots: POD_INSTALL_SLOTS_HOST_PATH } : {}),
          ...(pod.cpu ? { cpu: pod.cpu } : {}),
          // 실패 뒤 다시 도는 파일 하나짜리 Job 은 메모리 한도를 올린다 — 16Gi 에선 무거운 한 파일이 혼자서도 OOM 이었다(09-30 `unwired-exports`).
          ...(memoryLimit ? { memoryLimit } : {}),
          name: jobName,
          command: ['bash', '-lc', podShell],
        }).finally(() => watch?.stop());
        stamp('jobReturned');
        podJobName = job.job;
        // poolOverride is the injected scheduler used by isolated tests; it has no authenticated kubectl
        // context. Those sweeps intentionally cannot mint a valid baseline receipt (missing observed digest).
        // Production pool sweeps always use this Kubernetes lookup; lookup failure is receipt-invalid only.
        if (!poolOverride && placedOn) {
          try {
            const got = defaultKubectl(['--context', placedOn, '-n', 'elanous-test', 'get', 'pods', '-l', `job-name=${job.job}`, '-o', 'json']);
            if (got.status === 0) {
              podLifecycle = readGatePodLifecycle(got.stdout);
              imageDigest = actualGatePodImageDigest(got.stdout);
            }
          } catch { /* timings never change the verdict */ }
        }
        jobExitCode = job.exitCode;
        if (job.exitCode !== 0) captureFailure();
        batchArtifactDir = job.artifactsDir;
        const read = readShardArtifacts(job.artifactsDir, parts);
        batchArtifactsComplete = !batchIsolation || parts.every((_, index) =>
          ['rc', 'log', 'junit.xml'].every((suffix) => existsSync(join(job.artifactsDir, `part-${index}.${suffix}`))));
        const stagesPath = join(job.artifactsDir, 'stages.tsv');
        if (existsSync(stagesPath)) {
          try {
            podStages = Object.fromEntries(readFileSync(stagesPath, 'utf8').split(/\r?\n/).flatMap((line) => {
              const match = /^(\d+)\t([a-z0-9-]+)$/.exec(line);
              return match ? [[match[2]!, Number(match[1])]] : [];
            }));
          } catch (error) {
            debug.log('release-loop.gate', 'pod-stages-unreadable', { shard, branch, error: String(error) }, { level: 'warn' });
          }
        }
        stamp('artifactsRead');
        ({ output, junit, rc, timedOut, finished, unfinishedLog, exitCodeOnly } = read);
        // A stall counts only when the Job also left no verdict (a failed stop can let a late shard finish after all).
        const stalledAt = watch?.stalled();
        stallWatchState = watch?.state();
        abort = watch?.aborted();
        if (abort?.taken) abortedShards++;
        if (stalledAt && !finished.length && rc === undefined) stall = { seconds: stallSeconds, sinceCheckoutMs: stalledAt.sinceCheckoutMs };
        // A Job the cluster cut at its own deadline leaves no outbox at all: past the deadline with nothing is a timeout too.
        if (!timedOut && output === undefined && job.exitCode !== 0 && Date.now() - start >= shardDeadline * 1000) timedOut = true;
        lastFile = output === undefined && unfinishedLog === undefined ? undefined : lastStartedTestFile(`${output ?? ''}\n${unfinishedLog ?? ''}`, paths);
        if (!lastFile && (job.exitCode !== 0 || rc === undefined || (rc !== 0 && rc !== 1))) {
          try { lastFile = lastStartedTestFile(jobLogTail(job).split(/\r?\n/).slice(-200).join('\n'), paths); }
          catch { /* Log retrieval is diagnostic; do not hide the stalled shard. */ }
        }
      } catch (error) {
        jobFailed = true;
        jobError = error instanceof Error ? error.message : String(error);
        if (!failureCapture) captureFailure();
      }
      // A launch that failed before placement still gives its admission back (release is idempotent).
      admitted?.release();
      const durationMs = Date.now() - start;
      const fileSeconds = junit === undefined ? undefined : Object.fromEntries(readJunitFileSeconds(junit));
      const testSeconds = fileSeconds === undefined ? undefined : Object.values(fileSeconds).reduce((sum, seconds) => sum + seconds, 0);
      const testWallSeconds = batchIsolation
        ? gateBatchTestWallSeconds(podStages, parts.length)
        : podStages?.['test-start'] !== undefined && podStages?.['test-end'] !== undefined
          ? Math.max(0, podStages['test-end'] - podStages['test-start']) : undefined;
      const podOverheadSeconds = testWallSeconds !== undefined || (!batchIsolation && testSeconds !== undefined)
        ? Math.max(0, durationMs / 1000 - (testWallSeconds ?? testSeconds!)) : undefined;
      // A reused shard keeps its files as they are — rewriting would replace the measured durationMs the next release plans by.
      if (logDir && !reused && !descent) {
        mkdirSync(logDir, { recursive: true });
        const warmPrefix = join(logDir, `pod-${shard}${branch}`);
        rmSync(`${warmPrefix}.warm-manifest.json`, { force: true });
        rmSync(`${warmPrefix}.rc`, { force: true });
        // GATE-SHARD-RESUME: the json is what makes a log reusable, so it goes first and comes back last — a stop between
        // the new log and the new json leaves no json, never the old Job's exit paired with the new log (review r8).
        rmSync(join(logDir, `pod-${shard}${branch}.json`), { force: true });
        const destination = join(logDir, `pod-${shard}${branch}.log`);
        const unfinishedLogBytes = unfinishedLog !== undefined ? Buffer.byteLength(unfinishedLog, 'utf8') : undefined;
        // GATE-UNFINISHED-HINT: pod-N.log holds finished parts only — point a reader at the running parts' output (file only; the verdict reads `output`).
        if (output !== undefined) writeFileSync(destination, unfinishedLogBytes !== undefined
          ? `${output}${output.endsWith('\n') || output === '' ? '' : '\n'}${gateUnfinishedHint(`pod-${shard}${branch}.unfinished.log`, unfinishedLogBytes)}\n` : output, { mode: 0o600 });
        else rmSync(destination, { force: true });
        const junitDestination = join(logDir, `pod-${shard}${branch}.junit.xml`);
        if (junit !== undefined) writeFileSync(junitDestination, junit, { mode: 0o600 });
        else rmSync(junitDestination, { force: true });
        const unfinishedDestination = join(logDir, `pod-${shard}${branch}.unfinished.log`);
        if (unfinishedLog !== undefined) writeFileSync(unfinishedDestination, unfinishedLog, { mode: 0o600 });
        else rmSync(unfinishedDestination, { force: true });
        writeFileSync(join(logDir, `pod-${shard}${branch}.json`), JSON.stringify({ durationMs, rc: rc ?? null,
          ...(stall ? { reason: 'stall', finishedFiles: 0, stallSeconds: stall.seconds, sinceCheckoutMs: stall.sinceCheckoutMs } : timedOut ? { reason: 'timeout', finishedFiles: finished.length } : {}), files: paths, plannedSeconds: estimated(paths), deadlineSeconds: shardDeadline, shardCount: shards.length, sweepId, commit, runKey, attemptId, ...(parentAttempt ? { parentAttempt } : {}), jobExitCode: jobExitCode ?? null, jobFailed, ...(placedOn ? { host: placedOn } : {}),
          ...(Object.keys(phaseTimes).length ? { phaseTimes } : {}), ...(podStages ? { podStages } : {}),
          ...(podLifecycle && Object.keys(podLifecycle).length ? { podLifecycle } : {}),
          ...(failureCapture ? { failureCapture: {
            ...(failureCapture.podName ? { podName: failureCapture.podName } : {}),
            ...(failureCapture.termination ? { termination: {
              ...failureCapture.termination,
              ...(failureCapture.termination.reason ? { reason: redactSecretText(failureCapture.termination.reason) } : {}),
              ...(failureCapture.termination.message ? { message: redactSecretText(failureCapture.termination.message) } : {}),
            } } : {}),
            ...(failureCapture.logTail !== undefined ? { logTail: redactedGateLogTail(failureCapture.logTail) } : {}),
            ...(failureCapture.error ? { error: redactSecretText(failureCapture.error) } : {}),
          } } : {}),
          ...(imageDigest ? { imageDigest } : {}),
          ...(fileSeconds !== undefined ? { fileSeconds, testSeconds } : {}), ...(testWallSeconds !== undefined ? { testWallSeconds } : {}),
          ...(podOverheadSeconds !== undefined ? { podOverheadSeconds } : {}),
          ...(unfinishedLogBytes !== undefined ? { unfinishedLogBytes } : {}),
          ...(admitted && admitted.outcome !== 'off' ? { admission: admitted.outcome, admissionWaitMs: admitted.waitedMs } : {}),
          ...(abort ? { abort: { reason: `abort: ${abort.reason}`, at: abort.at, by: abort.by, sinceLastOutputMs: abort.sinceLastOutputMs, taken: abort.taken } } : {}),
          stallWatch: shardStallWatchRecord(stallSeconds, !!liveLog, stallWatchState) }) + '\n', { mode: 0o600 });
        if (paths.length === 1 && (rc === 0 || rc === 1) && !jobFailed && jobExitCode === 0
          && output !== undefined && junit !== undefined) {
          writeFileSync(`${warmPrefix}.rc`, `${rc}\n`, { mode: 0o600 });
          writeWarmJobManifest(warmPrefix, paths[0]!, commit, attemptId);
        }
      }
      const installSeconds = parseInstallSeconds(output ?? '');
      // GATE-TIMEOUT-HEAL ③: a cut shard is «reason: timeout» (with the files that still finished), not a bare rc=null.
      if (!reused && !descent) debug.log('release-loop.gate', 'pod-shard', { shard, files: paths, durationMs, rc: rc ?? null, attempt: depth + 1, installSeconds, gateDeps: parseGateDeps(output ?? ''), deadlineSeconds: shardDeadline, parts: parts.length, ...(placedOn ? { host: placedOn } : {}),
        ...(testSeconds !== undefined ? { testSeconds } : {}),
        ...(stall ? { reason: 'stall', finishedFiles: 0, stallSeconds: stall.seconds } : timedOut ? { reason: 'timeout', finishedFiles: finished.length } : {}) });
      // POD-LIFECYCLE-STAGES: the same values the shard json carries, as one `pod.lifecycle stages` line (observation only) —
      // only for a Job that came back (a launch that failed before the Job returned has no Pod to describe).
      if (!reused && !descent && podJobName !== undefined) emitPodLifecycle(gatePodLifecycleEvent({ runId: process.env.ELANOUS_RUN_ID ?? null, podJob: podJobName, host: placedOn ?? null,
        shard: `pod-${shard}${branch}`, attemptId, phaseTimes, podStages, podLifecycle, outcome: gatePodOutcome({ jobFailed, stalled: !!stall, timedOut, rc }) }));
      if (!reused && !descent) markShard(shard, { ...(installSeconds !== null ? { installSec: installSeconds } : {}), ...(rc !== undefined ? { rc } : {}), ...(timedOut ? { state: 'timeout' as const } : {}) });
      let clean = output?.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      const ran = clean && lastMatch(clean, /Ran (\d+) tests? across (\d+) files?/);
      const passes = clean === undefined ? NaN : summaryCount(clean, 'pass');
      const fails = clean === undefined ? NaN : summaryCount(clean, 'fail');
      const errors = clean === undefined ? NaN : summaryCount(clean, 'error');
      let reason: ShardReason | undefined;
      let namedFailures: number | undefined;
      let unattributedDetail: string | undefined;
      if (descent === 'split') reason = 'incomplete';
      // GATE-POD-STALL-FAILFAST: stopped with no test output — the existing «no output» reason (one fresh retry).
      else if (stall) reason = 'no-output';
      else if (timedOut) reason = 'timeout';
      else if (batchIsolation && !batchArtifactsComplete) reason = 'incomplete';
      // GATE-POD-STALL-FAILFAST (OP): a complete summary with 0 fail · 0 error but an exit other than 0/1 is an exit-code
      // anomaly (0.2.23: a test left process.exitCode set → «0 fail · rc 3» read as a stalled shard). Same split/isolation
      // path as job-failed — only the label differs, so the verdict names the file instead of saying «stalled».
      else if (!jobFailed && exitCodeOnly?.length && rc !== undefined && rc !== 0 && rc !== 1) reason = 'exit-code';
      else if (jobFailed || (jobExitCode !== undefined && jobExitCode !== 0) || (rc !== undefined && rc !== 0 && rc !== 1)) reason = 'job-failed';
      else if (!clean || rc === undefined) reason = 'no-output';
      else if (!ran || !Number.isFinite(passes) || !Number.isFinite(fails)
        || Number(ran[2]) === 0 || Number(ran[2]) > paths.length
        || (Number(ran[1]) === 0 && !(errors > 0))) reason = 'incomplete';
      else {
        try {
          const attributed = failuresOf({ rc, output: clean }, `pod-${shard} shard`);
          if (attributed.failures.length !== fails) reason = 'unattributed';
        } catch (error) {
          reason = 'unattributed';
          // 어떤 수가 어긋났는지(요약·이름·오류 귀속) 첫 줄을 싣는다 — 수만으론 원인 파일을 못 찾았다(09-30 ① 1번 조각).
          unattributedDetail = (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]!.slice(0, 300);
        }
        if (reason === 'unattributed') namedFailures = [...clean.matchAll(/\(fail\)\s+.+?(?:\s+\[[\d.]+(?:ms|s)\])?\s*$/gm)].length;
        // 콘솔 요약은 실패를 세는데 `(fail)` 이름 줄이 하나도 없으면 같은 조각의 junit 에서 이름을 가져온다
        // (10-01 0.2.6 게이트: `--dots` 로 도는 한 파일 조각이 이름 없이 끝나 게이트 전체가 error 로 멈췄다).
        if (reason === 'unattributed' && namedFailures === 0 && junit) {
          const named = junitFailures(junit);
          if (named.length === fails) {
            const patched = `${clean}\n${named.map((id) => { const cut = id.indexOf(' > '); return `${id.slice(0, cut)}:\n(fail) ${id.slice(cut + 3)}`; }).join('\n')}\n`;
            try {
              if (failuresOf({ rc, output: patched }, `pod-${shard} shard`).failures.length === fails) {
                clean = patched;
                reason = undefined;
                debug.log('release-loop.gate', 'pod-shard-junit-attribution', { shard, files: paths, failures: named });
              }
            } catch { /* 그래도 못 맞추면 원래대로 멈춘다 */ }
          }
        }
      }
      // A reused result that the current tool cannot read cleanly is not a verdict: run that shard for real.
      if (reused && reason) {
        debug.log('release-loop.gate', 'pod-shard-resume-miss', { shard, branch, reason });
        return runShard(paths, shard, depth, branch, retriedNoOutput, true, parentAttempt, hostRetries, batchIsolation, skipMembers, singleShotTail);
      }
      // GATE-MULTI-HOST: the Job failed because its member is gone (launch failed · status unreadable) — not the shard's
      // fault, so no split: the same files run again on the members left. Bounded by the roster size.
      if (!singleShotTail && jobFailed && placedOn && hostRetries < poolScheduler.members.length && memberLost(placedOn, shard, jobError)
        && poolScheduler.members.some((m) => !downMembers.has(m.context))) {
        debug.log('release-loop.gate', 'pod-shard-host-retry', { shard, branch, files: paths.length, lostMember: placedOn, attempt: hostRetries + 1 }, { level: 'warn' });
        return runShard(paths, shard, depth, `${branch}-h${hostRetries}`, retriedNoOutput, undefined, attemptId, hostRetries + 1, batchIsolation, skipMembers, singleShotTail);
      }
      // GATE-TIMEOUT-HEAL ④: a Pod that died before any test ran (no outbox · jobExitCode≠0 — 0.2.19: isolated retries
      // ending with exit 5, the source checkout) gets the same one fresh retry as «no output» instead of stalling the sweep.
      // 137 (killed · OOM) keeps the isolation path: re-running an OOM file only re-measures the same kill.
      const diedBeforeTests = reason === 'job-failed' && output === undefined && !jobFailed && jobExitCode !== undefined && jobExitCode !== 0
        && jobExitCode !== 137 && (paths.length === 1 || jobExitCode === 5);
      if ((reason === 'no-output' || diedBeforeTests) && !retriedNoOutput) {
        const retry = await runShard(paths, shard, depth, `${branch}-retry`, true, undefined, attemptId, hostRetries, batchIsolation, skipMembers);
        debug.log('release-loop.gate', 'pod-shard-retry', { shard, files: paths, reason, outcome: retry.stalled[0]?.reason ?? 'ok' });
        return retry;
      }
      // GATE-POD-STALL-FAILFAST: a stall after the fresh retry is unmeasured — no split, no isolation: smaller Pods on the
      // same stalled node only re-measure the stall (10-10: retries and splits repeated it for 2h+).
      if (stall && reason === 'no-output') return { runs: [], stalled: [{ shard, files: paths, reason, stall, ...(placedOn ? { lastHost: placedOn } : {}) }] };
      // GATE-STALLED-TAIL-REMEASURE: the alternate-host probe is a single observation. Do not split, isolate, or
      // retry its failed result; the sweep retains the original stall and records this attempt separately.
      if (singleShotTail && reason) return { runs: [], stalled: [{ shard, files: paths, reason,
        ...(lastFile ? { lastFile } : {}), ...(placedOn ? { lastHost: placedOn } : {}),
        ...(reason === 'unattributed' ? { summaryFailures: fails, namedFailures, ...(unattributedDetail ? { detail: unattributedDetail } : {}) } : {}) }] };
      // A shared Job may finish some file parts before another part loses its JUnit/log/rc. Keep every complete part's
      // original verdict, including a failure, and rerun only parts without the full artifact trio.
      if (batchIsolation && !batchArtifactsComplete && batchArtifactDir && reason) {
        const measured: ShardRun[] = [];
        const missing: string[] = [];
        parts.forEach((part, index) => {
          const file = part[0]!;
          try {
            const prefix = join(batchArtifactDir!, `part-${index}`);
            const partLog = readFileSync(`${prefix}.log`, 'utf8');
            const partJunit = readFileSync(`${prefix}.junit.xml`, 'utf8');
            const partRc = Number(readFileSync(`${prefix}.rc`, 'utf8').trim());
            const ranPart = lastMatch(partLog, /Ran (\d+) tests? across (\d+) files?/);
            const passPart = summaryCount(partLog, 'pass'), failPart = summaryCount(partLog, 'fail');
            const errorsPart = summaryCount(partLog, 'error');
            if ((partRc !== 0 && partRc !== 1) || !ranPart || Number(ranPart[2]) !== 1
              || !Number.isFinite(passPart) || !Number.isFinite(failPart)) throw new Error('incomplete part');
            const attributed = failuresOf({ rc: partRc, output: partLog }, `pod-${shard} part-${index}`);
            if (attributed.failures.length !== failPart) throw new Error('unattributed part');
            measured.push({ output: partLog, rc: partRc, pass: passPart, fail: failPart,
              errors: Number.isFinite(errorsPart) ? errorsPart : 0, ran: Number(ranPart[1]), files: 1,
              passedIds: junitPassedIds(partJunit).map(podRelative) });
          } catch { missing.push(file); }
        });
        if (measured.length && missing.length) {
          debug.log('release-loop.gate', 'isolation-batch-partial', { shard, branch, measured: measured.length, missing });
          const children = await Promise.all(missing.map((file) => isolatedFile(() => runShard([file], shard, depth + 1,
            `${branch}-file-${paths.indexOf(file)}`, false, undefined, attemptId))));
          return { runs: [...measured, ...children.flatMap((child) => child.runs)],
            stalled: children.flatMap((child) => child.stalled) };
        }
      }
      if (reason) {
        // GATE-SKIP-KNOWN-RETRY — a shard whose summary is complete but whose failures could not be read back (unattributed)
        // and whose every named failure is one the previous release already had is not re-run: re-running only re-measures
        // known failures (0.2.18 cut: 109 retry Pods · 1,840 shard-minutes, 4x the first pass). Those failures go to the
        // verdict as they are, so it still classifies them against the baseline (preexisting) — never silently dropped.
        if (reason === 'unattributed' && knownFailures.size && clean && ran) {
          const ids = shardFailureIds(clean, junit, fails, errors);
          const all = ids ? [...ids.failures, ...ids.errors] : [];
          if (ids && all.length && all.every((id) => knownFailures.has(id))) {
            debug.log('release-loop.gate', 'retry-skipped-known', { shard, failures: all.length });
            return { runs: [{ output: `${failureOutput(ids.failures, ids.errors)}\n`, rc: 1, pass: Number.isFinite(passes) ? passes : 0,
              fail: ids.failures.length, errors: ids.errors.length, ran: Number(ran[1]), files: Number(ran[2]),
              passedIds: junit ? junitPassedIds(junit) : [] }], stalled: [] };
          }
        }
        // GATE-ISOLATE-FAILED-FILES — with this shard's junit, only the files with a failing test or an unhandled error and
        // the files with no junit result (crashed · never reached) are re-run; the rest passed here and keep that result.
        // The narrowed set runs under its own branch (`-n`) at the same depth, so the usual split/isolation rules still apply
        // to it, and a resumed gate finds this shard's own log (not a `-c0`/`-0` child) and narrows the same way again.
        const narrowed = !descent ? retryFiles(paths, clean, junit, fails, errors) : undefined;
        if (narrowed && narrowed.length && narrowed.length < paths.length) {
          debug.log('release-loop.gate', 'retry-narrowed', { shard, before: paths.length, after: narrowed.length });
          const kept = new Set(paths.filter((file) => !narrowed.includes(file)));
          const passedIds = junitPassedIds(junit!).map(podRelative).filter((id) => { try { return kept.has(testFileOfId(id)); } catch { return false; } });
          const directBatch = narrowed.length > 1 && narrowed.length <= POD_SHARD_FILE_CAP && narrowed.every((file) => batchSafe.has(file));
          const child = await runShard(narrowed, shard, directBatch ? 2 : depth, `${branch}-n`, false, undefined, attemptId, 0, directBatch);
          return { runs: [{ output: '', rc: 0, pass: passedIds.length, fail: 0, errors: 0, ran: passedIds.length, files: kept.size, passedIds },
            ...child.runs], stalled: child.stalled };
        }
        // 깊이 2 에서 «이름 없는 실패»·«불완전»도 파일 단위로 가른다 — 아니면 149파일 조각의 실패 하나가 끝까지 주인 없이 남는다(09-30 G1e 7번 조각: 요약 28 · 이름 27).
        // 로그 없이 죽은 조각(`no-output` · OOM)도 같다 — 09-30 G1f ② 4-0-0 은 150파일이 격리 0 으로 남았다.
        if (depth === 2 && paths.length > 1) {
          const count = Math.min(paths.length, isolationRemaining[shard]!);
          isolationRemaining[shard]! -= count;
          const batchPaths = paths.slice(0, count);
          // The common path already ran every file as an isolated part in this same Job. Only an incomplete batch
          // needs a fresh per-file Pod, preserving the earlier fail-closed behavior when the shared Job died.
          const canBatch = batchPaths.length > 1 && batchPaths.every((file) => batchSafe.has(file));
          const batch = batchIsolation || !canBatch ? undefined : await runShard(batchPaths, shard, depth + 1, `${branch}-batch`, false, undefined, attemptId, 0, true);
          const retryPaths = !batch ? batchPaths : batchPaths.filter((file) => batch.stalled.some((item) => item.files.includes(file)));
          const children = !batch || batch.stalled.length ? await Promise.all(retryPaths.map((file) => isolatedFile(async () => {
            const child = await runShard([file], shard, depth + 1, `${branch}-file-${batchPaths.indexOf(file)}`, false, undefined, attemptId);
            debug.log('release-loop.gate', 'pod-shard-isolate', { shard, file, outcome: child.stalled[0]?.reason ?? 'ok' });
            return child;
          }))) : [batch];
          debug.log('release-loop.gate', 'pod-shard-isolate-batch', { shard, files: batchPaths.length, fallback: !batch || batch.stalled.length > 0 });
          return { runs: [...(batch?.stalled.length ? batch.runs : []), ...children.flatMap((child) => child.runs)], stalled: [
            ...children.flatMap((child) => child.stalled),
            ...(batch?.stalled.filter((item) => item.files.some((file) => !retryPaths.includes(file))) ?? []),
            ...(paths.length > count ? [{ shard, files: paths.slice(count), reason,
              ...(lastFile ? { lastFile } : {}),
            }] : []),
          ] };
        }
        if (depth >= 2 || paths.length === 1) return { runs: [], stalled: [{ shard, files: paths, reason,
          ...(lastFile ? { lastFile } : {}),
          ...(reason === 'unattributed' ? { summaryFailures: fails, namedFailures, ...(unattributedDetail ? { detail: unattributedDetail } : {}) } : {}),
        }] };
        // GT1 — a big shard that failed at the root goes straight to cap-sized chunks instead of halving twice: memory
        // piles up when one bun process runs many files (0.2.7: only bundles of 54+ OOMed), and each halving round costs
        // a Pod start, an install and a rerun. A failing chunk then isolates its files (depth 2), as before.
        if (depth === 0 && paths.length > POD_SHARD_FILE_CAP) {
          const chunks = Array.from({ length: Math.ceil(paths.length / POD_SHARD_FILE_CAP) }, (_, i) => paths.slice(i * POD_SHARD_FILE_CAP, (i + 1) * POD_SHARD_FILE_CAP));
          debug.log('release-loop.gate', 'pod-shard-cap-split', { shard, files: paths.length, chunks: chunks.length, cap: POD_SHARD_FILE_CAP, reason });
          // Preserve the proven cap-chunk Job even with an empty opt-in list. Batch isolation is only for chunks whose
          // every file is explicitly safe; a regular cap chunk keeps the preexisting one-process Pod verdict.
          const children = await Promise.all(chunks.map((chunk, i) => runShard(chunk, shard, 2, `${branch}-c${i}`, false, undefined, attemptId, 0,
            chunk.length > 1 && chunk.every((file) => batchSafe.has(file)))));
          return { runs: children.flatMap((child) => child.runs), stalled: children.flatMap((child) => child.stalled) };
        }
        debug.log('release-loop.gate', 'pod-shard-split', { shard, depth, files: paths, reason });
        const middle = Math.ceil(paths.length / 2);
        const children = await Promise.all([
          runShard(paths.slice(0, middle), shard, depth + 1, `${branch}-0`, false, undefined, attemptId, 0,
            depth + 1 === 2 && middle > 1 && paths.slice(0, middle).every((file) => batchSafe.has(file))),
          runShard(paths.slice(middle), shard, depth + 1, `${branch}-1`, false, undefined, attemptId, 0,
            depth + 1 === 2 && paths.length - middle > 1 && paths.slice(middle).every((file) => batchSafe.has(file))),
        ]);
        return { runs: children.flatMap((child) => child.runs), stalled: children.flatMap((child) => child.stalled) };
      }
      if (reused) debug.log('release-loop.gate', 'pod-shard-resumed', { shard, branch, files: paths.length, rc, durationMs: reused.durationMs ?? null });
      return { runs: [{ output: clean!, rc: rc!, pass: passes, fail: fails,
        errors: Number.isNaN(errors) ? 0 : errors,
        ran: Number(ran![1]), files: Number(ran![2]), passedIds: junit ? junitPassedIds(junit) : [] }], stalled: [] };
    };
    // 모든 조각이 끝난 뒤 판정한다 — 한 조각의 예외로 먼저 돌아가면 다른 Pod 가 도는 채로 정리가 시작된다(#22002 리뷰 R3).
    const settled = await Promise.allSettled(shards.map(async (item, shard) => {
      try {
        const done = await runShard(item.files, shard);
        const state = !done.stalled.length ? 'done' as const : done.stalled.some((stall) => stall.reason === 'timeout') ? 'timeout' as const : 'failed' as const;
        markShard(shard, { state, endedAt: new Date().toISOString() }, ['waitReason']);
        return done;
      } catch (error) {
        markShard(shard, { state: 'failed', endedAt: new Date().toISOString() }, ['waitReason']);
        throw error;
      }
    }));
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    const results = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    let stalledShards = results.flatMap((result) => result.stalled);
    const measured = results.flatMap((result) => result.runs);
    // GATE-STALLED-TAIL-REMEASURE: after the sweep, give only a one-file no-output leaf one fresh attempt on a different
    // pool member. Keep the original unmeasured evidence if no alternate is available or the remeasure is incomplete.
    const remainingStalls: typeof stalledShards = [];
    for (const stalled of stalledShards) {
      const alternatives = stalled.lastHost
        ? poolScheduler.members.filter((member) => member.context !== stalled.lastHost && !downMembers.has(member.context))
        : [];
      if (!stalled.stall || stalled.reason !== 'no-output' || stalled.files.length !== 1 || !stalled.lastHost || !alternatives.length) {
        remainingStalls.push(stalled);
        continue;
      }
      debug.log('release-loop.gate', 'pod-stalled-tail-remeasure-start', { shard: stalled.shard, file: stalled.files[0], fromHost: stalled.lastHost,
        availableHosts: alternatives.map((member) => member.context) });
      try {
        tailPlacedHost = undefined;
        const tail = await runShard(stalled.files, stalled.shard, 0, '-tail', true, true, undefined, 0, false, new Set([stalled.lastHost]), true);
        if (tail.stalled.length) {
          const unresolved = tail.stalled[0]!;
          remainingStalls.push({ ...stalled, tailRemeasure: { reason: unresolved.reason,
            ...(unresolved.lastHost ?? tailPlacedHost ? { host: unresolved.lastHost ?? tailPlacedHost } : {}),
            ...(unresolved.detail ? { detail: unresolved.detail } : {}) } });
          debug.log('release-loop.gate', 'pod-stalled-tail-remeasure-incomplete', { shard: stalled.shard, file: stalled.files[0],
            fromHost: stalled.lastHost, toHost: unresolved.lastHost ?? null, reason: unresolved.reason }, { level: 'warn' });
        } else {
          measured.push(...tail.runs);
          debug.log('release-loop.gate', 'pod-stalled-tail-remeasure-complete', { shard: stalled.shard, file: stalled.files[0],
            fromHost: stalled.lastHost, toHost: tailPlacedHost ?? null });
        }
      } catch (error) {
        remainingStalls.push({ ...stalled, tailRemeasure: { reason: 'error', ...(tailPlacedHost ? { host: tailPlacedHost } : {}), detail: String(error).slice(0, 500) } });
        debug.log('release-loop.gate', 'pod-stalled-tail-remeasure-error', { shard: stalled.shard, file: stalled.files[0],
          fromHost: stalled.lastHost, error: String(error).slice(0, 500) }, { level: 'warn' });
      }
    }
    stalledShards = remainingStalls;
    const total = measured.reduce((sum, run) => ({ pass: sum.pass + run.pass, fail: sum.fail + run.fail,
      errors: sum.errors + run.errors, ran: sum.ran + run.ran, files: sum.files + run.files }),
    { pass: 0, fail: 0, errors: 0, ran: 0, files: 0 });
    const unmeasured = stalledShards.filter((item) => item.stall);
    if (unmeasured.length) debug.log('release-loop.gate', 'pod-sweep-unmeasured', { shards: [...new Set(unmeasured.map((item) => item.shard))], files: unmeasured.reduce((sum, item) => sum + item.files.length, 0),
      stallSeconds, measuredFiles: total.files }, { level: 'warn' });
    // An unmeasured (stalled) shard is never handed to the host re-run as an environment stall: the gate fails now.
    if (abortedShards) debug.log('release-loop.gate', 'pod-sweep-aborted', { shards: abortedShards, midRunStallSeconds }, { level: 'warn' });
    if (stalledShards.some((item) => item.reason !== 'no-output' || item.files.length !== 1 || item.stall)) {
      const measuredFailures = partialFailuresOf(measured);
      throw new StalledPodShards(stalledShards, total, measuredFailures,
        results.filter((item) => item.stalled.length === 0).length, abortedShards);
    }
    if (total.ran === 0 && total.errors === 0 && !stalledShards.length) throw new Error('sweep incomplete: no tests ran');
    const outputs = measured.map((run) => run.output.replace(/(?:^|\n)\s*\d+ (?:pass|fail|errors?)\s*(?=\n|$)/g, '\n').replace(/Ran \d+ tests? across \d+ files?\.?/g, ''));
    return { rc: total.fail + total.errors ? 1 : 0, output: outputs.join('\n') + `\n${total.pass} pass\n${total.fail} fail\n${total.errors} errors\nRan ${total.ran} tests across ${total.files} files.\n`, validatedShards: true,
      podSweep: { id: sweepId, shards: shards.length, files: assignable },
      passedIds: [...new Set(measured.flatMap((run) => run.passedIds))].sort(),
      stalledEnv: stalledShards.flatMap((item) => item.files.map((file) => ({ file, reason: 'no-output' as const }))),
      ...(abortedShards ? { abortedShards } : {}) };
  };
  const runPodRecheckBatch = async (files: readonly string[], commit: string, pod: NonNullable<GateOptions['pod']>, timeoutMs: number, relaxed = false): Promise<Map<string, CommandResult>> => {
    const warmShadowScope = pod.warmShadowScope ?? { requested: false };
    const shadowTimeoutMs = pod.warmShadowTimeoutMs ?? 150_000;
    if (!Number.isSafeInteger(shadowTimeoutMs) || shadowTimeoutMs < 1 || shadowTimeoutMs > 150_000)
      throw new Error('invalid warm shadow timeout');
    let shadowDeadline = 0;
    const boundedShadow = async <T>(phase: string, operation: () => Promise<T>): Promise<T> => {
      const remainingMs = shadowDeadline - Date.now();
      if (remainingMs <= 0) throw new Error(`warm ${phase} timeout after ${shadowTimeoutMs}ms`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`warm ${phase} timeout after ${shadowTimeoutMs}ms`)), remainingMs);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    if (!files.length || files.length > GATE_RECHECK_POD_BATCH_FILES || new Set(files).size !== files.length
      || files.some((file) => !/^(?:[\w.-]+\/)*[\w.-]+\.test\.[cm]?[jt]sx?$/.test(file)
        || file.split('/').some((part) => part === '.' || part === '..')))
      throw new Error('unsafe pod recheck files');
    if (!sha.test(commit)) throw new Error('invalid pod recheck commit');
    const installSlots = pod.installSlots ?? POD_INSTALL_SLOTS_DEFAULT;
    if (!Number.isSafeInteger(installSlots) || installSlots < 0) throw new Error('invalid pod recheck install slots');
    const bunCache = pod.bunCache?.trim() || process.env[POD_BUN_CACHE_HOST_PATH]?.trim();
    const attemptId = randomUUID();
    const partLimitSeconds = Math.ceil(timeoutMs / 1000);
    const deadlineSeconds = partLimitSeconds * Math.ceil(files.length / 2) + POD_SHARD_EMIT_RESERVE_SECONDS + 60;
    const shell = gateShardShell({ parts: files.map((file) => [file]), cdpPatterns: [], softSeconds: softDeadlineSeconds(deadlineSeconds),
      cachePrefix: bunCache ? podBunCacheVolume(bunCache).shellPrefix : '', installSlots, parallelParts: files.length > 1 ? 2 : 1,
      partLimitSeconds, sourceBinding: { cutSha: commit, attemptId }, ...(relaxed ? { testTimeoutMs: GATE_TIMEOUT_RECHECK_MS } : {}) });
    const job = await podCommand({ pool: pod.pool, ...(poolOverride ? { poolScheduler: poolOverride } : {}), clone: true,
      provenanceGate: true,
      provenance: { actorKind: process.env.ELANOUS_SEAT ? 'seat' : 'loop', actor: process.env.ELANOUS_SEAT || 'release-loop',
        character: 'gate-shard-runner', launchHost: hostname(), entrance: 'release-recheck', kind: 'gate-recheck',
        run: process.env.ELANOUS_RUN_ID || attemptId, phase: 'release-gate', requestedAt: new Date().toISOString(),
        graphNode: 'gate-triage', commit, reason: `release gate recheck ${files.length} files`, pool: pod.pool,
        memReq: POD_ISOLATION_MEMORY_LIMIT, warmReused: false },
      source: { kind: 'commit', sha: commit }, deadlineSeconds, ...(bunCache ? { bunCache } : {}), ...gateHostMirror(pod),
      ...(installSlots > 0 ? { installSlots: POD_INSTALL_SLOTS_HOST_PATH } : {}), ...(pod.cpu ? { cpu: pod.cpu } : {}),
      memoryLimit: POD_ISOLATION_MEMORY_LIMIT, name: `gate-recheck-${randomUUID()}`, command: ['bash', '-lc', shell] });
    const artifact = (name: string) => {
      const path = join(job.artifactsDir, name);
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    };
    const installed = artifact('install.rc')?.trim() === '0';
    const warmEligible = files.length === 1 && pod.warmEligible === true && !!pod.warmReplay && !!pod.warmQuarantine && !!pod.warmFinalize
      && pod.warmCutSha === commit;
    const incomplete = (message: string, file: string): Error => warmEligible
      ? new WarmRecheckIncomplete(message, file, { files: [file], attemptId, status: 'unmeasured', reason: 'reference-unmeasured', quarantined: 'no' })
      : new Error(message);
    if (!installed || job.exitCode !== 0)
      throw incomplete(`pod isolated recheck setup incomplete: ${commit.slice(0, 9)} job=${job.job} exit=${job.exitCode} install=${installed}`, files[0]!);
    const timedOut = artifact('shard.timeout') !== undefined;
    const results = new Map<string, CommandResult>();
    for (const [index, file] of files.entries()) {
      const rcText = artifact(`part-${index}.rc`)?.trim();
      const output = artifact(`part-${index}.log`);
      const rc = rcText && /^\d+$/.test(rcText) ? Number(rcText) : undefined;
      const partTimedOut = artifact(`part-${index}.timeout`) !== undefined;
      if (rc === undefined || output === undefined || partTimedOut) {
        if (!timedOut && !partTimedOut) throw incomplete(`pod isolated recheck incomplete: ${file} @${commit.slice(0, 9)} job=${job.job} rc=${rc ?? 'missing'}`, file);
        results.set(file, { rc: 124, output: output ?? '', timedOut: true });
      } else {
        // The comparator only accepts a complete JUnit/log pair tied to this exact Job attempt.
        // A missing or damaged artifact leaves the existing Job verdict authoritative.
        let warmReference: WarmWorkerFileResult | null = null;
        if (warmEligible) {
          try {
            const prefix = join(job.artifactsDir, `recheck-${index}`);
            const part = (suffix: string) => join(job.artifactsDir, `part-${index}.${suffix}`);
            for (const suffix of ['log', 'rc', 'junit.xml']) if (existsSync(part(suffix))) copyFileSync(part(suffix), `${prefix}.${suffix}`);
            writeFileSync(`${prefix}.json`, JSON.stringify({ commit, attemptId, files: [file], rc,
              jobFailed: false, jobExitCode: job.exitCode }) + '\n', { mode: 0o600 });
            if (writeWarmJobManifest(prefix, file, commit, attemptId))
              warmReference = warmReferenceFromJobArtifacts(prefix, file, { cutSha: commit, attemptId });
          } catch (error) {
            debug.log('release-loop.gate', 'warm-reference-unmeasured', { file, attemptId, error: String(error) });
          }
        }
        results.set(file, { rc, output, warmReference, warmAttemptId: attemptId });
      }
      debug.log('release-loop.gate', 'pod-isolated-recheck', { file, commit, job: job.job, rc: rc ?? 124, relaxed });
    }
    if (warmEligible && pod.warmReplay && pod.warmQuarantine && pod.warmFinalize) {
      shadowDeadline = Date.now() + shadowTimeoutMs;
      const first = results.get(files[0]!)!;
      const reference = first.warmReference;
      if (!reference) {
        first.warmShadow = { files: [...files], attemptId, status: 'unmeasured', reason: 'reference-unmeasured', quarantined: 'no' };
        debug.log('release-loop.gate', 'warm-shadow-recheck', first.warmShadow);
      } else if (pod.warmReplayOwner !== false && (warmShadowScope.attempts ?? (warmShadowScope.requested ? 1 : 0)) < WARM_REPLAY_BUDGET) {
        warmShadowScope.attempts = (warmShadowScope.attempts ?? (warmShadowScope.requested ? 1 : 0)) + 1;
        warmShadowScope.requested = true;
        let observation: WarmShadowObservation;
        try {
          const request = { protocol: 1 as const, runId: randomUUID(), attemptId, cutSha: commit,
            ...(pod.warmBaselineSha ? { baselineSha: pod.warmBaselineSha } : {}),
            deadlineAt: Math.min(Date.now() + timeoutMs * files.length + 60_000, shadowDeadline - 1_000),
            files, envProfile: 'gate-v1' };
          // The producer honors deadlineAt. An injected/slow producer may still settle after our wait cap:
          // fence any late lease before it can be mistaken for a reusable worker.
          let replayTimedOut = false;
          const pendingReplay = Promise.resolve().then(() => pod.warmReplay!(request));
          void pendingReplay.then((late) => {
            if (replayTimedOut && late.command) void Promise.resolve().then(() => pod.warmQuarantine!(late.command!, 'late-replay-after-timeout'))
              .catch((error) => debug.log('release-loop.gate', 'warm-shadow-late-quarantine-failed', { attemptId, error: String(error) }));
          }, (error) => {
            if (replayTimedOut) debug.log('release-loop.gate', 'warm-shadow-late-replay-failed', { attemptId, error: String(error) });
          });
          let replay: WarmReplayResult;
          try { replay = await boundedShadow('replay', () => pendingReplay); }
          catch (error) { replayTimedOut = true; throw error; }
          if (!replay.command) {
            observation = { files: [...files], attemptId, status: 'fallback', reason: replay.transport.reason, quarantined: 'no' };
          } else if (replay.transport.status !== 'observed') {
            let quarantined: WarmShadowObservation['quarantined'] = 'yes';
            try { await boundedShadow('quarantine', () => pod.warmQuarantine!(replay.command!, `transport-${replay.transport.reason}`)); }
            catch (error) {
              quarantined = 'failed';
              debug.log('release-loop.gate', 'warm-shadow-quarantine-failed', { attemptId,
                reason: replay.transport.reason, error: String(error) });
            }
            observation = { files: [...files], attemptId, status: 'fallback', reason: replay.transport.reason, quarantined };
          } else {
            const bound = warmCommandMatchesRequest(replay.command, request);
            const decision = bound ? assessWarmWorkerShadow(replay.command, [reference], replay.transport.reply)
              : { reason: 'identity' as const, quarantineWorker: true };
            let reason: string = decision.reason;
            let status: WarmShadowObservation['status'] = 'observed';
            let quarantined: WarmShadowObservation['quarantined'] = 'no';
            let finalized = false;
            if (decision.reason === 'match') {
              try { await boundedShadow('finalize', () => pod.warmFinalize!(replay.command!)); finalized = true; }
              catch (error) {
                reason = 'finalize-failed';
                status = 'fallback';
                debug.log('release-loop.gate', 'warm-shadow-finalize-failed', { attemptId, error: String(error) });
              }
            }
            if (!finalized) {
              try { await boundedShadow('quarantine', () => pod.warmQuarantine!(replay.command!, reason)); quarantined = 'yes'; }
              catch (error) {
                quarantined = 'failed';
                debug.log('release-loop.gate', 'warm-shadow-quarantine-failed', { attemptId, reason, error: String(error) });
              }
            }
            observation = { files: [...files], attemptId, status, reason, quarantined, finalized,
              cutSha: replay.command.cutSha, baselineSha: replay.command.baselineSha, workerKey: replay.command.key };
          }
        } catch (error) {
          observation = { files: [...files], attemptId, status: 'unmeasured', reason: String(error), quarantined: 'unavailable' };
        }
        first.warmShadow = observation;
        debug.log('release-loop.gate', 'warm-shadow-recheck', observation);
      } else {
        first.warmShadow = { files: [...files], attemptId, status: 'fallback', reason: 'replay-budget-exhausted', quarantined: 'no' };
        debug.log('release-loop.gate', 'warm-shadow-recheck', first.warmShadow);
      }
    }
    return results;
  };
  return {
    command,
    localCommand: commandOverride && !remote ? commandOverride : localCommand,
    async recheckPod(file, commit, pod, timeoutMs, relaxed = false) {
      return (await runPodRecheckBatch([file], commit, pod, timeoutMs, relaxed)).get(file)!;
    },
    recheckPodBatch: (files, commit, pod, timeoutMs) => runPodRecheckBatch(files, commit, pod, timeoutMs),
    get remoteMirror() { return remoteMirror; },
    set remoteMirror(path) { remoteMirror = path; },
    async sweep(tree, logDir, pod, only) {
      if (pod) return podSweep(tree, logDir, pod, only);
      const listed = await command('git', ['ls-files', '*.test.*'], tree);
      check(listed, 'git ls-files tests');
      const allFiles = listed.output.split(/\r?\n/).filter((file) => /\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file));
      const onlySet = only ? new Set(only) : undefined;
      const missing = only?.filter((file) => !allFiles.includes(file)) ?? [];
      if (missing.length) throw new Error(`partial plan file missing at this commit: ${missing.slice(0, 5).join(', ')}`);
      const files = onlySet ? allFiles.filter((file) => onlySet.has(file)) : allFiles;
      const groups = onlySet ? [{ name: 'partial', paths: files }] : [
        { name: 'src-cli', paths: ['src/cli'] },
        { name: 'src-rest', paths: [...new Set(files.filter((f) => f.startsWith('src/') && !f.startsWith('src/cli/')).map((f) => f.split('/').length === 2 ? f : f.split('/').slice(0, 2).join('/')))] },
        { name: 'test', paths: ['test'] },
        { name: 'other', paths: [...new Set(files.filter((f) => !f.startsWith('src/') && !f.startsWith('test/')).map((f) => f.split('/')[0]!))] },
      ];
      let cdpPatterns: string[];
      if (remote) {
        const cdp = await command('rg', ['-l', '--glob', '*.test.ts', '-e', 'requireCdpBase', '-e', '9333', 'test', 'scripts'], tree);
        if (cdp.rc !== 0 && cdp.rc !== 1) throw new Error(`CDP pattern discovery failed (rc=${cdp.rc}): ${tail40(cdp.output)}`);
        cdpPatterns = cdp.output.split(/\r?\n/).filter((path) => path.endsWith('.test.ts'));
      } else cdpPatterns = deriveCdpTestPatterns({ cwd: tree });
      const outputs: string[] = [];
      let total = { pass: 0, fail: 0, errors: 0, ran: 0, files: 0 };
      for (const group of groups) {
        if (!group.paths.length || !files.some((f) => group.paths.some((p) => f === p || f.startsWith(`${p}/`)))) continue;
        const start = Date.now();
        const groupIgnores = [...new Set(cdpPatterns)]
          .filter((pattern) => files.includes(pattern) && group.paths.some((p) => pattern === p || pattern.startsWith(`${p}/`)))
          .flatMap((pattern) => ['--path-ignore-patterns', pattern]);
        const run = await command('bun', ['run', 'test:deterministic', ...groupIgnores, ...group.paths.map(asPath)], tree);
        if (logDir) {
          mkdirSync(logDir, { recursive: true });
          writeFileSync(join(logDir, `${group.name}.log`), run.output, { mode: 0o600 });
          writeFileSync(join(logDir, `${group.name}.json`), JSON.stringify({ durationMs: Date.now() - start, rc: run.rc }) + '\n', { mode: 0o600 });
        }
        debug.log('release-loop.gate', 'shard', { shard: group.name, durationMs: Date.now() - start, rc: run.rc, logDir });
        try { failuresOf(run, `${group.name} shard`); }
        catch (error) { throw new Error(`${group.name} shard: ${error instanceof Error ? error.message : String(error)}`); }
        const clean = run.output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        const ran = lastMatch(clean, /Ran (\d+) tests? across (\d+) files?/)!;
        const passes = summaryCount(clean, 'pass');
        if (!Number.isFinite(passes) && Number(ran[1]) > 0) throw new Error(`${group.name} shard incomplete (rc=${run.rc}; pass summary missing)\n${tail40(clean)}`);
        total = { pass: total.pass + (Number.isNaN(passes) ? 0 : passes), fail: total.fail + summaryCount(clean, 'fail'),
          errors: total.errors + (Number.isNaN(summaryCount(clean, 'error')) ? 0 : summaryCount(clean, 'error')),
          ran: total.ran + Number(ran[1]), files: total.files + Number(ran[2]) };
        outputs.push(clean.replace(/(?:^|\n)\s*\d+ (?:pass|fail|errors?)\s*(?=\n|$)/g, '\n').replace(/Ran \d+ tests? across \d+ files?\.?/g, ''));
      }
      if (!outputs.length || (total.ran === 0 && total.errors === 0)) throw new Error('sweep incomplete: no tests ran');
      return { rc: total.fail + total.errors ? 1 : 0, output: outputs.join('\n') + `\n${total.pass} pass\n${total.fail} fail\n${total.errors} errors\nRan ${total.ran} tests across ${total.files} files.\n` };
    },
    async add(tree, commit) {
      if (remote) {
        if (!remoteMirror) throw new Error('remote mirror not prepared');
        check(await command('git', ['clone', '--no-checkout', remoteMirror, tree], dirname(tree)), 'remote tree clone');
        check(await command('git', ['-C', tree, 'fetch', 'origin', `refs/elanous/gate/${commit}`], dirname(tree)), 'remote tree fetch');
        check(await command('git', ['-C', tree, 'checkout', '--detach', commit], dirname(tree)), 'remote tree checkout');
      } else check(await command('git', ['worktree', 'add', '--detach', tree, commit], repo), 'git worktree add');
    },
    async remove(tree) {
      if (remote) check(await command('rm', ['-rf', '--', tree], dirname(tree)), 'remote tree cleanup');
      else check(await command('git', ['worktree', 'remove', '--force', tree], repo), 'git worktree remove');
    },
    async snapshot(tree, commit) {
      if (remote) {
        if (!remoteMirror) throw new Error('remote mirror not prepared');
        check(await command('git', ['clone', '--no-checkout', remoteMirror, tree], dirname(tree)), 'baseline snapshot clone');
        check(await command('git', ['-C', tree, 'fetch', 'origin', `refs/elanous/gate/${commit}`], dirname(tree)), 'baseline snapshot fetch');
        check(await command('git', ['-C', tree, 'checkout', '--detach', commit], dirname(tree)), 'baseline snapshot checkout');
      } else {
        check(await command('git', ['clone', '--quiet', '--shared', '--no-checkout', repo, tree], repo), 'baseline snapshot clone');
        check(await command('git', ['checkout', '--quiet', '--detach', commit], tree), 'baseline snapshot checkout');
      }
    },
    async removeSnapshot(tree) {
      if (remote) check(await command('rm', ['-rf', '--', tree], dirname(tree)), 'baseline snapshot cleanup');
      else rmSync(tree, { recursive: true, force: true });
    },
  };
}

function readBaseline(root: string, version: string): { commit: string; failures: string[]; errors?: string[] } | undefined {
  const path = failureFile(root, version);
  if (!existsSync(path)) return undefined;
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!data || typeof data !== 'object' || !('failures' in data) || !Array.isArray(data.failures)
    || !data.failures.every((id: unknown) => typeof id === 'string')
    || ('errors' in data && (!Array.isArray(data.errors) || !data.errors.every((id: unknown) => typeof id === 'string')))
    || !('commit' in data) || typeof data.commit !== 'string' || !sha.test(data.commit)) {
    throw new Error(`invalid baseline failure ledger: ${path}`);
  }
  const record = data as { commit: string; failures: string[]; errors?: string[] };
  for (const id of [...record.failures, ...(record.errors ?? [])]) fileOf(id);
  return record;
}

export function baselineCommit(root: string, version: string): string {
  const path = join(root, 'release', version, 'release.json');
  const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const commit = manifest && typeof manifest === 'object' && 'sourceCommit' in manifest ? manifest.sourceCommit : undefined;
  if (typeof commit !== 'string' || !sha.test(commit)) throw new Error(`missing sourceCommit in ${path}`);
  return commit;
}

const fileOf = testFileOfId;

/**
 * GATE-BASELINE-CACHE (0.2.18) — the isolated `bun run test:deterministic <file>` result of one test file at one commit,
 * kept in the machine ledger so a later gate does not run it again (0.2.17: the failing files were re-run on the previous
 * release commit although that release had already measured them). Cache format harvested from draft #24500.
 * `host` is where the result was measured (`local`, the ssh host, or `pod:<pool>`) — another environment is a miss.
 * Timeouts are never stored: an environment stall is measured again, not remembered.
 */
export interface BaselineFileResult { commit: string; file: string; host: string; failures: string[]; errors: string[]; missing: boolean }
export const baselineCachePath = (ledger: string, commit: string) => join(ledger, 'gate-baseline-cache', `${commit}.jsonl`);
function validFileResult(value: unknown, commit: string): value is BaselineFileResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<BaselineFileResult>;
  if (row.commit !== commit || typeof row.file !== 'string' || typeof row.host !== 'string' || !row.host.trim()
    || typeof row.missing !== 'boolean' || !Array.isArray(row.failures) || !Array.isArray(row.errors)
    || (row.missing && (row.failures.length || row.errors.length))) return false;
  try {
    fileOf(`${row.file} > case`);
    return [...row.failures, ...row.errors].every((id) => typeof id === 'string' && fileOf(id) === row.file);
  } catch { return false; }
}
/** A missing cache file is empty; any unreadable or invalid row discards the whole file — it is never read as a pass. */
export function readBaselineFileCache(ledger: string, commit: string): Map<string, BaselineFileResult> {
  const entries = new Map<string, BaselineFileResult>();
  if (!sha.test(commit)) return entries;
  const path = baselineCachePath(ledger, commit);
  if (!existsSync(path)) return entries;
  try {
    // The writer always ends with one newline and never writes an empty line — anything else is a damaged file.
    const text = readFileSync(path, 'utf8');
    if (!text.endsWith('\n')) throw new Error('missing final newline');
    for (const line of text.slice(0, -1).split('\n')) {
      if (!line.trim()) throw new Error('empty line');
      const row: unknown = JSON.parse(line);
      if (!validFileResult(row, commit)) throw new Error('invalid row');
      entries.set(`${row.file}\0${row.host}`, row);
    }
  } catch (error) {
    debug.log('release.gate', 'baseline-cache-corrupt', { path, error: String(error) });
    entries.clear();
  }
  return entries;
}
export function saveBaselineFileCache(ledger: string, commit: string, rows: BaselineFileResult[]): void {
  if (!rows.length || !sha.test(commit)) return;
  const entries = readBaselineFileCache(ledger, commit);
  for (const row of rows) entries.set(`${row.file}\0${row.host}`, row);
  const path = baselineCachePath(ledger, commit);
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.gate-baseline-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, [...entries.values()].map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    renameSync(temp, path);
  } finally { if (existsSync(temp)) rmSync(temp); }
}

export async function judgeGate(opts: GateOptions, runner: GateRunner = createGateRunner(opts.repo ?? process.cwd(), opts.remote),
  imageProbe: typeof preflightGateImageDigest = preflightGateImageDigest): Promise<GateResult> {
  const start = Date.now();
  if (opts.pod?.warmReplay) opts = { ...opts, pod: { ...opts.pod,
    warmShadowScope: { requested: false, attempts: 0 } } };
  const explicitConfig = getElanousConfigDirOverride();
  const root = explicitConfig ? effectiveInstanceRoot() : (opts.instanceRoot ?? effectiveInstanceRoot());
  // The freeze is read from the same root the gate runs in (a config-dir override must not move it elsewhere).
  const frozen = readLandingFreeze(root);
  if (frozen) {
    debug.log('release.run', opts.forceFreeze ? 'freeze-forced' : 'frozen', { version: opts.version, reason: frozen.reason, until: frozen.until, node: 'gate' });
    if (!opts.forceFreeze) throw new Error(landingFreezeMessage(frozen));
  }
  const ledger = explicitConfig ? root : (opts.ledgerRoot ?? releaseLedgerRoot());
  const roots = [...new Set([ledger, root])];
  const cachedBaseline = (version: string, commit: string) => {
    for (const [index, location] of roots.entries()) {
      const saved = readBaseline(location, version);
      if (saved?.commit === commit) return { saved, source: index === 0 && location !== root ? 'ledger' as const : 'instance' as const };
    }
    return undefined;
  };
  const baselineReleaseCommit = (version: string) => {
    for (const location of roots) {
      const path = join(location, 'release', version, 'release.json');
      if (existsSync(path)) return baselineCommit(location, version);
    }
    return baselineCommit(root, version);
  };
  const repo = resolve(opts.repo ?? process.cwd());
  const result: GateResult = { outcome: 'error', commit: opts.commit, introduced: [], preexisting: 0, fixed: 0, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 0 };
  let baselineCommitForVerdict = opts.baselineCommit ?? '';
  const preexistingIds: string[] = [];
  let knownEnvIds: string[] = [];
  let work: string | undefined;
  let baseSnapshot = false;
  let cutFailures: SweepFailures | undefined;
  let cutSweepUsable = false;
  let cutSweepRc: number | null = null;
  let radiusShadow: GateRadiusShadowPlan | undefined;
  const trees: string[] = [];
  try {
    if (!sha.test(opts.commit) || !versionPattern.test(opts.version)
      || (opts.baselineVersion && !versionPattern.test(opts.baselineVersion))
      || (opts.baselineCommit && !sha.test(opts.baselineCommit))) throw new Error('invalid commit or version');
    if (!opts.baselineVersion) throw new Error('previous release version required (--baseline-version)');
    if (opts.rehearsalBaseline && (opts.graphRunId || !opts.pod || !/-rc\.\d+$/.test(opts.version)))
      throw new Error('rehearsal baseline requires a direct Pod gate with an isolated rc version');
    // Observation only. Failure to plan cannot change the gate selector or verdict.
    try { radiusShadow = planGateRadiusShadow({ repo, ledgerRoot: ledger, version: opts.version,
      baselineVersion: opts.baselineVersion, forCommit: opts.commit, instanceRoot: root,
      expectedBaselineCommit: opts.baselineCommit }); }
    catch (error) { debug.log('release-loop.gate', 'radius-shadow-unavailable', { reason: String(error) }); }
    if (!Number.isSafeInteger(opts.recheckFileLimit ?? GATE_HOST_RECHECK_FILE_LIMIT) || (opts.recheckFileLimit ?? GATE_HOST_RECHECK_FILE_LIMIT) < 1)
      throw new Error('invalid gate recheck file limit');
    if (opts.pod && (!opts.pod.pool || !Number.isSafeInteger(opts.pod.shards ?? 24) || (opts.pod.shards ?? 24) < 1
      || !Number.isSafeInteger(opts.pod.shardTimeoutSeconds ?? 1200) || (opts.pod.shardTimeoutSeconds ?? 1200) < 1)) throw new Error('invalid pod sweep options');
    if (opts.remote && !/^(?:[\w.-]+@)?[\w.-]+$/.test(opts.remote)) throw new Error('invalid ssh host');
    if (opts.remote) {
      runner.remoteMirror = undefined;
      const configured = opts.remoteMirror ?? defaultRemoteMirror;
      if (!/^(?:\/|~\/)[\w./-]+$/.test(configured) || configured.split('/').includes('..')) throw new Error('invalid remote mirror path');
      const home = configured.startsWith('~/') ? await runner.command('sh', ['-c', 'printf "%s\\n" "$HOME"'], '/tmp') : undefined;
      if (home) check(home, 'remote home');
      const homePath = home?.output.split(/\r?\n/).find((line) => line.startsWith('/'));
      if (home && (!homePath || !/^\/[^\r\n]*$/.test(homePath))) throw new Error('invalid remote home');
      const mirror = configured.startsWith('~/') ? join(homePath!, configured.slice(2)) : configured;
      const baseSha = opts.baselineCommit ?? baselineReleaseCommit(opts.baselineVersion);
      cachedBaseline(opts.baselineVersion, baseSha);
      const present = await runner.command('test', ['-d', mirror], '/tmp');
      if (present.rc === 1) {
        check(await runner.command('mkdir', ['-p', dirname(mirror)], '/tmp'), 'remote mirror parent');
        check(await runner.command('git', ['init', '--bare', mirror], '/tmp'), 'remote mirror init');
      } else check(present, 'remote mirror lookup');
      const bare = await runner.command('git', ['--git-dir', mirror, 'rev-parse', '--is-bare-repository'], '/tmp');
      check(bare, 'remote mirror inspection');
      if (!bare.output.split(/\r?\n/).includes('true')) throw new Error('remote mirror is not bare');
      for (const commit of new Set([opts.commit, baseSha])) {
        const ref = `refs/elanous/gate/${commit}`;
        const found = await runner.command('git', ['--git-dir', mirror, 'show-ref', '--verify', '--quiet', ref], '/tmp');
        if (found.rc === 1) check(await runner.localCommand('git', ['push', `${opts.remote}:${mirror}`, `${commit}:${ref}`], repo), `remote push ${commit}`);
        else check(found, `remote mirror ref ${commit}`);
      }
      runner.remoteMirror = mirror;
      const temporary = await runner.command('mktemp', ['-d', '/tmp/release-gate-XXXXXXXX'], '/tmp');
      check(temporary, 'remote mktemp');
      const paths = temporary.output.split(/\r?\n/).filter((line) => /^\/tmp\/release-gate-[\w-]+$/.test(line));
      if (paths.length !== 1) throw new Error('could not create temporary work directory');
      work = paths[0]!;
    } else work = mkdtempSync(join(tmpdir(), 'release-gate-'));
    const cutTree = join(work, 'cut');
    trees.push(cutTree);
    await runner.add(cutTree, opts.commit);
    for (const dir of [cutTree, join(cutTree, 'apps/pwa')]) check(await runner.command('bun', ['install'], dir), `bun install ${dir}`);
    // GATE-PARTIAL: a plan made by `release resume --from gate --partial` for exactly this commit re-runs only its files.
    // Its logs go to cut-partial/ — the full cut/ logs stay whole (the next release reads them as a baseline source).
    const partialRead = readPartialPlanResult(roots, opts.version, opts.commit);
    const explicitPartial = partialRead.plan;
    const rehearsalStampPresent = ['hard-5h', 'hard-mid'].some((step) =>
      existsSync(join(root, 'release', opts.version, 'rehearsal', `${step}.json`)));
    const currentImage = !explicitPartial && opts.graphRunId && opts.pod && rehearsalStampPresent
      ? imageProbe(opts.pod.pool) : null;
    const radius = !explicitPartial && opts.graphRunId && opts.pod && rehearsalStampPresent
      ? planHardRehearsalRadius({ root, repo, version: opts.version, forCommit: opts.commit,
        graphPins: gateGraphPins(root, opts.graphRunId), envFingerprint: gateEnvFingerprint(process.env), imageDigest: currentImage })
      : null;
    if (radius) debug.log('release-loop.gate', 'radius-live-plan', { version: opts.version, reason: radius.reason,
      files: radius.plan?.files.length ?? null, rehearsalRunId: radius.rehearsalRunId ?? null });
    let partial = explicitPartial ?? radius?.plan ?? null;
    debug.log('release-loop.gate', partial ? 'partial-regate' : 'partial-fallback', {
      version: opts.version, priorCommit: partial?.priorCommit ?? null, commit: opts.commit,
      planKind: partial?.kind ?? 'full', remeasureFileCount: partial?.files.length ?? 0,
      preservedShardCount: partial?.kind === 'recheck' && 'preservedShardCount' in partial
        && typeof partial.preservedShardCount === 'number' ? partial.preservedShardCount : 0,
      fallbackReason: partial ? undefined : partialRead.fallbackReason,
    });
    if (partial?.kind === 'carry') {
      const carryPriorCommit = partial.priorCommit;
      // The plan alone is not evidence: the old cut and its verdict must still be complete and clean at this SHA.
      if (!verifyDocsOnlyCarry(repo, carryPriorCommit, opts.commit))
        throw new Error(`carry plan diff is not docs-only: ${carryPriorCommit}..${opts.commit}`);
      const trusted = roots.some((location) => {
        const dir = join(location, 'release', opts.version);
        const failuresPath = join(dir, 'gate-failures.json');
        const verdictPath = join(dir, 'gate-verdict.json');
        if (!existsSync(failuresPath) || !existsSync(verdictPath)) return false;
        const failures = JSON.parse(readFileSync(failuresPath, 'utf8')) as { commit?: unknown; failures?: unknown; errors?: unknown };
        const verdict = JSON.parse(readFileSync(verdictPath, 'utf8')) as { commit?: unknown; outcome?: unknown };
        return failures.commit === carryPriorCommit && Array.isArray(failures.failures) && failures.failures.length === 0
          && (failures.errors === undefined || (Array.isArray(failures.errors) && failures.errors.length === 0))
          && verdict.commit === carryPriorCommit && verdict.outcome === 'ok';
      });
      if (!trusted) throw new Error(`carry plan has no complete clean gate at ${carryPriorCommit}`);
    }
    // GATE-SKIP-KNOWN-RETRY — the ids the verdict will not count as introduced (the recorded baseline ⊕ env-known), read
    // before the sweep so a shard failing only with them skips its isolation retries. No recorded baseline = no skip.
    let knownFailures: string[] = [];
    if (opts.pod) {
      try {
        const knownSha = opts.baselineCommit ?? baselineReleaseCommit(opts.baselineVersion);
        const saved = cachedBaseline(opts.baselineVersion, knownSha)?.saved;
        const recorded = saved ? undefined : baselineFromCutLogs(join(ledger, 'release', opts.baselineVersion, 'gate-logs', 'cut'), knownSha);
        const trustedKnown = saved ?? (recorded?.complete ? recorded : undefined);
        if (trustedKnown) knownFailures = [...trustedKnown.failures, ...(trustedKnown.errors ?? []), ...loadEnvKnownFailures(repo)];
      } catch (error) { debug.log('release-loop.gate', 'known-failures-unavailable', { error: String(error) }); }
    }
    const durationSource = join(ledger, 'release', opts.baselineVersion, 'gate-logs', 'cut');
    const runCut = (selected: typeof partial) => selected?.kind === 'carry' ? undefined : runner.sweep(cutTree,
      join(root, 'release', opts.version, 'gate-logs', selected ? 'cut-partial' : 'cut'),
      opts.pod ? { ...opts.pod, durationSource, ...(knownFailures.length ? { knownFailures } : {}), onSelectionTimed: ({ ms }) => { result.selectionMs = ms; },
        // GATE-LIVE-OBS: the release ledger's shards.json (UX #24782) — never the run tree's universe; an explicit
        // --ledger-root (tests) keeps it in that ledger.
        shardsFile: { path: opts.ledgerRoot ? gateShardsPath(opts.version, opts.ledgerRoot) : gateShardsPath(opts.version), version: opts.version } } : undefined,
      selected?.files);
    let cutRun = await runCut(partial);
    const radiusSelectionMatched = partial?.files && cutRun?.podSweep?.files
      && JSON.stringify([...partial.files].sort()) === JSON.stringify([...cutRun.podSweep.files].sort());
    if (radius?.plan && (!radiusSelectionMatched
      || !partialGateImagesMatch(root, opts.version, currentImage!, opts.commit, cutRun?.podSweep))) {
      debug.log('release-loop.gate', 'radius-live-image-drift', { version: opts.version,
        rehearsalRunId: radius.rehearsalRunId, action: 'full-sweep' }, { level: 'warn' });
      partial = null;
      cutRun = await runCut(null);
    }
    cutSweepRc = cutRun?.rc ?? null;
    cutSweepUsable = !!cutRun && (cutRun.rc === 0 || cutRun.rc === 1) && !cutRun.timedOut
      && !cutRun.abortedShards && !cutRun.stalledEnv?.length;
    if (cutRun?.abortedShards) result.abortedShards = cutRun.abortedShards;
    const localStalled = async (run: CommandResult, tree: string, commit: string, label: string) => {
      const stalled = run.stalledEnv ?? [];
      const noCompletedShard = stalled.length && run.rc === 0
        && /(?:^|\n)0 pass\n0 fail\n0 errors\nRan 0 tests across 0 files\./.test(run.output);
      const measured: SweepFailures = noCompletedShard ? { failures: [], errors: [] } : failuresOf(run, `${label} sweep`);
      if (!stalled.length) return measured;
      let hostTree = tree;
      const local: GateResult['stalledEnv'] = [];
      try {
        if (opts.remote) {
          hostTree = join(mkdtempSync(join(tmpdir(), 'release-gate-local-')), 'cut');
          check(await runner.localCommand('git', ['clone', '--quiet', '--shared', '--no-checkout', repo, hostTree], repo), 'host cut clone');
          check(await runner.localCommand('git', ['checkout', '--quiet', '--detach', commit], hostTree), 'host cut checkout');
          for (const dir of [hostTree, join(hostTree, 'apps/pwa')]) check(await runner.localCommand('bun', ['install'], dir), `host bun install ${dir}`);
        }
        for (const { file, reason } of stalled) {
          if (!/^(?:[\w.-]+\/)+[\w.-]+\.test\.tsx?$/.test(file) || file.split('/').includes('..')) throw new Error(`unsafe test path: ${file}`);
          // 0.2.15: InsidePage.test.tsx gave no Pod output and then hung on the host with headless Chrome — the run could only fail.
          const isolated = await runner.localCommand('bun', ['run', 'test:deterministic', asPath(file)], hostTree, GATE_ISOLATED_TIMEOUT_MS);
          // A file that stalls in its Pod shard and again on the host is an environment stall: record it, measure nothing from it.
          if (isolated.timedOut) {
            // Grandchildren (e.g. headless Chrome) can outlive the kill — the event lets the next release see a repeat.
            debug.log('release-loop.gate', 'isolated-timeout', { file, label, limitMs: GATE_ISOLATED_TIMEOUT_MS });
            local.push({ file, reason, local: 'timeout' });
            continue;
          }
          const parsed = failuresOf(isolated, `${label} host isolated ${file}`);
          if ([...parsed.failures, ...parsed.errors].some((id) => fileOf(id) !== file)) throw new Error(`host isolated run attributed to another file: ${file}`);
          measured.failures.push(...parsed.failures);
          measured.errors.push(...parsed.errors);
          local.push({ file, reason, local: parsed.failures.length || parsed.errors.length ? 'failed' : 'passed' });
        }
      } finally {
        if (opts.remote && hostTree !== tree) rmSync(dirname(hostTree), { recursive: true, force: true });
      }
      result.stalledEnv.push(...local);
      debug.log('release-loop.gate', 'pod-shard-stalled-env', { files: stalled.map(({ file, reason }) => ({ file, reason })), local });
      return measured;
    };
    const measuredCut = cutRun ? await localStalled(cutRun, cutTree, opts.commit, 'cut') : { failures: [], errors: [] };
    // A between-tests error proves only that the shared process failed. Re-run each affected file by itself using the
    // same isolated path as ordinary new-failure rechecks, even when the error was present in the baseline ledger.
    // Replace that file's shard observations with its isolated observations before the existing regression comparison.
    const prefetchedCut = new Map<string, CommandResult>();
    for (const file of [...new Set(measuredCut.errors.filter((id) => id.endsWith(' > [error]')).map(fileOf))].sort()) {
      let run: CommandResult | undefined;
      let reading: ReturnType<typeof readIsolatedRun> | undefined;
      let reason: 'reproduced' | 'timeout' | 'unreadable' | undefined;
      try {
        run = opts.pod && runner.recheckPod
          ? await runner.recheckPod(file, opts.commit, opts.pod, GATE_ISOLATED_TIMEOUT_MS)
          : await runner.command('bun', ['run', 'test:deterministic', asPath(file)], cutTree, GATE_ISOLATED_TIMEOUT_MS);
      } catch (error) {
        reason = 'unreadable';
        debug.log('release-loop.gate', 'unhandled-isolated-run-failed', { file, error: String(error) });
      }
      if (run?.timedOut) reason = 'timeout';
      else if (run) {
        try {
          reading = readIsolatedRun(run, `cut unhandled isolated ${file}`, file);
          if (reading.kind === 'read' && reading.errors.length) reason = 'reproduced';
        } catch { reason = 'unreadable'; }
      }
      const originalIds = measuredCut.errors.filter((id) => fileOf(id) === file);
      measuredCut.failures = measuredCut.failures.filter((id) => fileOf(id) !== file);
      measuredCut.errors = measuredCut.errors.filter((id) => fileOf(id) !== file);
      if (reading?.kind === 'read') measuredCut.failures.push(...reading.failures);
      else if (reading?.kind === 'rc-nonzero-no-failures') measuredCut.errors.push(`${file} > [rc-nonzero]`);
      if (reason) {
        (result.unmeasuredErrors ??= []).push({ file, reason, ids: originalIds });
        debug.log('release-loop.gate', 'unhandled-isolated-unmeasured', { file, reason, ids: originalIds });
      } else {
        prefetchedCut.set(file, run!);
        if (reading?.kind === 'read' && !reading.failures.length) {
          (result.interferenceErrors ??= []).push(...originalIds);
          debug.log('release-loop.gate', 'unhandled-isolated-interference', { file, ids: originalIds });
        }
      }
    }
    const cut = partial ? mergePartialFailures(partial, measuredCut) : measuredCut;
    if (partial) result.partial = { priorCommit: partial.priorCommit, files: partial.files.length };
    cutFailures = cut;
    const baseSha = opts.baselineCommit ?? baselineReleaseCommit(opts.baselineVersion);
    baselineCommitForVerdict = baseSha;
    const cached = cachedBaseline(opts.baselineVersion, baseSha);
    const recorded = cached ? undefined : baselineFromCutLogs(join(ledger, 'release', opts.baselineVersion, 'gate-logs', 'cut'), baseSha);
    const trusted = cached?.saved ?? (recorded?.complete ? recorded : undefined);
    result.baselineSource = cached ? cached.source : recorded?.complete ? 'cut-logs' : 'swept';
    debug.log('release-loop.gate', 'baseline', { version: opts.baselineVersion, source: result.baselineSource, commit: baseSha });
    let baseTree: string | undefined;
    const getBaseTree = async () => {
      if (!baseTree) {
        baseTree = join(work!, 'baseline');
        if (trusted) {
          baseSnapshot = true;
          await runner.snapshot(baseTree, baseSha);
        } else {
          trees.push(baseTree);
          await runner.add(baseTree, baseSha);
        }
        for (const dir of [baseTree, join(baseTree, 'apps/pwa')]) check(await runner.command('bun', ['install'], dir), `bun install ${dir}`);
      }
      return baseTree;
    };
    let baseline: SweepFailures | undefined = trusted ? { failures: trusted.failures, errors: trusted.errors ?? [] } : undefined;
    if (!baseline) {
      // GATE-SPEED A4 (RFC-release-gate-under-30min §A4) — with no recorded baseline only the files that failed at the cut
      // are swept at the previous release; a passing cut file needs no comparison. Files absent there stay new failures.
      const cutFiles = [...new Set([...cut.failures, ...cut.errors].map(fileOf))].sort();
      let present: string[] = [];
      if (cutFiles.length) {
        const tree = await getBaseTree();
        // -z: the default output quotes paths with special characters, which would read as absent.
        const listed = await runner.command('git', ['ls-files', '-z', '--', ...cutFiles], tree);
        check(listed, 'baseline ls-files');
        const known = new Set(listed.output.split('\0'));
        present = cutFiles.filter((file) => known.has(file));
      }
      result.baselineDeferred = { cutFiles: cutFiles.length, swept: present.length };
      debug.log('release-loop.gate', 'baseline-deferred', { version: opts.baselineVersion, commit: baseSha, cutFiles: cutFiles.length, swept: present.length });
      if (present.length) {
        // K9b — the baseline is swept on the same Pod pool as the cut, not on this host (0.2.6: an hour of local baseline
        // after a 23-minute Pod cut).
        const baseRun = await runner.sweep(baseTree!, join(root, 'release', opts.version, 'gate-logs', 'baseline'),
          opts.pod ? { ...opts.pod, durationSource } : undefined,
          present);
        baseline = await localStalled(baseRun, baseTree!, baseSha, 'baseline');
      } else baseline = { failures: [], errors: [] };
    }
    for (const id of [...baseline.failures, ...baseline.errors, ...cut.failures, ...cut.errors]) fileOf(id);
    const known = opts.pod ? loadEnvKnownFailures(repo) : new Set<string>();
    const cutIds = [...cut.failures, ...cut.errors];
    const cutHostFailed = new Set(cutRun?.stalledEnv?.map(({ file }) => file) ?? []);
    const baselineIds = [...baseline.failures, ...baseline.errors];
    const countedCut = splitKnownEnv(cutIds, known);
    const countedBaseline = splitKnownEnv(baselineIds, known);
    knownEnvIds = countedCut.knownEnv;
    result.knownEnv = knownEnvIds.length;
    result.knownEnvCleared = [...new Set(cutRun?.passedIds ?? [])].filter((id) => known.has(id) && !cutIds.includes(id) && !cutRun?.stalledEnv?.some(({ file }) => fileOf(id) === file)).sort();
    const diff = diffFailures(countedCut.counted, countedBaseline.counted);
    result.fixed = result.baselineDeferred ? null : diff.fixed.length;
    preexistingIds.push(...diff.common);
    result.preexisting = preexistingIds.length;
    // GATE-BASELINE-CACHE — only the files whose new failures reproduce in isolation reach the baseline, and each
    // (commit, file, host) is run at most once across gates: this gate's cut results also seed the next gate's baseline.
    const cacheHost = opts.pod && runner.recheckPod ? `pod:${opts.pod.pool}` : opts.remote ?? 'local';
    const newFailureFiles = new Set(diff.newFailures.map(fileOf));
    const baseCache = newFailureFiles.size ? readBaselineFileCache(ledger, baseSha) : new Map<string, BaselineFileResult>();
    const cacheStats = { hits: 0, misses: 0 };
    const remember = (row: BaselineFileResult) => {
      // Only a row the reader would accept is stored; an unstorable result skips the cache and leaves the verdict alone.
      const { commit, file } = row;
      if (!validFileResult(row, commit)) {
        debug.log('release.gate', 'baseline-cache-skip', { commit, file });
        return;
      }
      try { saveBaselineFileCache(ledger, row.commit, [row]); }
      catch (error) { debug.log('release.gate', 'baseline-cache-write-failed', { commit: row.commit, file: row.file, error: String(error) }); }
    };
    const recheckFiles = [...newFailureFiles].sort();
    const eligible = recheckFiles.filter((file) => !cutHostFailed.has(file) && !prefetchedCut.has(file));
    const warmEligibleFiles = new Set(opts.pod?.warmReplay && opts.pod.warmQuarantine && opts.pod.warmFinalize
      ? eligible.slice(0, WARM_REPLAY_BUDGET) : []);
    // The source-bound lock comes from the cut commit itself, never from the producer's claim.
    const history = readWarmVerdictHistory(verdictFile(ledger, opts.version));
    let warmLockHash = '';
    if (opts.pod?.warmReuseConfig?.gateRecheck && history?.length) {
      try {
        const lock = await runner.localCommand('git', ['show', `${opts.commit}:bun.lock`], repo);
        if (lock.rc === 0 && lock.output) warmLockHash = createHash('sha256').update(lock.output).digest('hex');
      } catch { /* Unmeasured evidence keeps reuse off. */ }
    }
    const warmEvidence = warmEvidenceFromVerdicts(history, opts.version, opts.commit, baseSha, warmLockHash);
    const warmDecision = decideWarmReuse('gate-recheck', opts.pod?.warmReuseConfig,
      warmEvidence ? { 'gate-recheck': warmEvidence } : undefined);
    const verifiedWorkerKey = history?.at(-1)?.warmShadow.at(-1)?.workerKey;
    if (warmDecision.live && verifiedWorkerKey && opts.pod && runner.recheckPod) {
      // Only the first two files may adopt; replay them serially before scheduling fresh fallbacks.
      for (const file of eligible.slice(0, 2)) {
        const adopted = await tryWarmGateAdoption(file, opts.commit, baseSha, verifiedWorkerKey, opts.pod);
        if (adopted) prefetchedCut.set(file, adopted);
      }
    }
    const recheckLimit = opts.recheckFileLimit ?? GATE_HOST_RECHECK_FILE_LIMIT;
    const recheckConcurrency = opts.pod?.isolationConcurrency ?? 4;
    if (opts.pod && (!Number.isSafeInteger(recheckConcurrency) || recheckConcurrency < 1)) throw new Error('invalid pod recheck concurrency');
    // Each window is bounded, but overflow is queued into the next one. A limit must never turn known failures into
    // unmeasured files. Pod checks use the same file-isolation fanout cap as the sweep; host fallback stays serial.
    debug.log('release-loop.gate', 'isolated-recheck-plan', { files: recheckFiles.length, window: recheckLimit,
      concurrency: opts.pod && runner.recheckPod ? recheckConcurrency : 1, executor: opts.pod && runner.recheckPod ? 'pod' : 'host',
      remote: opts.remote ?? null, podBatchFiles: opts.pod && runner.recheckPod && runner.recheckPodBatch ? GATE_RECHECK_POD_BATCH_FILES : 1 });
    const recheckStartedAt = Date.now();
    const recordWarmShadow = (shadow?: WarmShadowObservation) => {
      if (shadow && !result.warmShadow?.some((entry) => entry.attemptId === shadow.attemptId))
        (result.warmShadow ??= []).push(shadow);
    };
    const recheckFile = async (file: string, index: number) => {
      debug.log('release-loop.gate', 'isolated-recheck-progress',
        { index: index + 1, total: recheckFiles.length, file, elapsedSec: Math.round((Date.now() - recheckStartedAt) / 1000) });
      // 0.2.15: the cut re-check of a new-failure file (InsidePage.test.tsx · headless Chrome) hung for good — limit it like the host re-run.
      const cutCheck = cutHostFailed.has(file) ? undefined : prefetchedCut.get(file) ?? (opts.pod && runner.recheckPod
          ? await runner.recheckPod(file, opts.commit, { ...opts.pod, warmCutSha: opts.commit, warmBaselineSha: baseSha,
            warmEligible: warmEligibleFiles.has(file) }, GATE_ISOLATED_TIMEOUT_MS)
        : await runner.command('bun', ['run', 'test:deterministic', asPath(file)], cutTree, GATE_ISOLATED_TIMEOUT_MS));
      recordWarmShadow(cutCheck?.warmShadow);
      if (cutCheck?.timedOut) {
        debug.log('release-loop.gate', 'isolated-timeout', { file, label: 'cut isolated', limitMs: GATE_ISOLATED_TIMEOUT_MS });
        result.stalledEnv.push({ file, reason: 'isolated-timeout', local: 'timeout' });
        return;
      }
      const cutReading = cutCheck === undefined ? undefined : readIsolatedRun(cutCheck, `cut isolated ${file}`, file);
      const rcOnly = cutReading?.kind === 'rc-nonzero-no-failures' ? cutReading : undefined;
      const rcOnlyId = `${file} > [rc-nonzero]`;
      const isolatedCut: SweepFailures = cutReading === undefined
        ? { failures: cut.failures.filter((id) => fileOf(id) === file), errors: cut.errors.filter((id) => fileOf(id) === file) }
        : cutReading.kind === 'read' ? cutReading : { failures: [], errors: [rcOnlyId] };
      if (cutCheck !== undefined) remember({ commit: opts.commit, file, host: cacheHost, failures: isolatedCut.failures, errors: isolatedCut.errors, missing: false });
      const reproduced = new Set([...isolatedCut.failures, ...isolatedCut.errors]);
      let candidates = rcOnly ? [rcOnlyId] : diff.newFailures.filter((id) => fileOf(id) === file && reproduced.has(id));
      // GATE-INTRO-RECHECK — a new failure that is only bun's «timed out» shape gets one more isolated run with a generous
      // per-test limit, on the same runner (node-b when the gate is remote). Passing there = flaky under load (warning);
      // an assertion failure, a failure again, or a run that cannot be read stays introduced.
      const timedOut = cutCheck === undefined ? new Set<string>() : new Set(parseTimedOutFailures(stripPodRepoRoot(cutCheck.output)));
      const shaped = candidates.filter((id) => timedOut.has(id) && isolatedCut.failures.includes(id));
      if (shaped.length) {
        const relaxed = opts.pod && runner.recheckPod
          ? await runner.recheckPod(file, opts.commit, { ...opts.pod, warmCutSha: opts.commit, warmBaselineSha: baseSha,
            warmEligible: warmEligibleFiles.has(file) }, GATE_ISOLATED_TIMEOUT_MS, true)
          : await runner.command('bun', ['run', 'test:deterministic', asPath(file), '--timeout', String(GATE_TIMEOUT_RECHECK_MS)], cutTree, GATE_ISOLATED_TIMEOUT_MS);
        recordWarmShadow(relaxed.warmShadow);
        let flaky: string[] = [];
        let recheck: 'read' | 'timeout' | 'unreadable' = 'read';
        if (relaxed.timedOut) recheck = 'timeout';
        else {
          try {
            const again = failuresOf(relaxed, `cut timeout recheck ${file}`);
            const still = new Set([...again.failures, ...again.errors]);
            flaky = again.errors.length ? [] : shaped.filter((id) => !still.has(id));
          } catch { recheck = 'unreadable'; }
        }
        debug.log('release-loop.gate', 'timeout-recheck', { file, shaped: shaped.length, flaky: flaky.length, recheck, remote: opts.remote ?? 'local', limitMs: GATE_TIMEOUT_RECHECK_MS });
        if (flaky.length) {
          (result.loadFlaky ??= []).push(...flaky);
          candidates = candidates.filter((id) => !flaky.includes(id));
          try {
            const path = loadFlakyCensusPath(ledger);
            mkdirSync(dirname(path), { recursive: true });
            const at = new Date().toISOString();
            appendFileSync(path, flaky.map((id) => JSON.stringify({ at, version: opts.version, commit: opts.commit, id, host: cacheHost, limitMs: GATE_TIMEOUT_RECHECK_MS }) + '\n').join(''), { mode: 0o600 });
          } catch (error) { debug.log('release-loop.gate', 'load-flaky-census-write-failed', { file, error: String(error) }); }
        }
      }
      if (candidates.length === 0) return;
      let oldFailures: Set<string>;
      let baselineMissing = false;
      const hit = baseCache.get(`${file}\0${cacheHost}`);
      if (hit?.missing) baselineMissing = true;
      if (hit) {
        cacheStats.hits++;
        oldFailures = new Set([...hit.failures, ...hit.errors]);
      } else {
        cacheStats.misses++;
        const baselineTree = opts.pod && runner.recheckPod ? undefined : await getBaseTree();
        const previous = opts.pod && runner.recheckPod
          ? await runner.recheckPod(file, baseSha, opts.pod, GATE_ISOLATED_TIMEOUT_MS)
          : await runner.command('bun', ['run', 'test:deterministic', asPath(file)], baselineTree!, GATE_ISOLATED_TIMEOUT_MS);
        if (previous.timedOut) {
          debug.log('release-loop.gate', 'isolated-timeout', { file, label: 'baseline isolated', limitMs: GATE_ISOLATED_TIMEOUT_MS });
          result.stalledEnv.push({ file, reason: 'isolated-timeout', local: 'timeout' });
          return;
        }
        if (/No tests found|had no matches/i.test(previous.output) && previous.rc === 1) {
          const lookup = await runner.command('git', ['ls-tree', '--name-only', baseSha, '--', file], opts.remote ? baselineTree ?? cutTree : repo);
          if (lookup.rc !== 0 || lookup.output.trim()) throw new Error(`baseline isolated run incomplete: ${file}`);
          oldFailures = new Set();
          baselineMissing = true;
          remember({ commit: baseSha, file, host: cacheHost, failures: [], errors: [], missing: true });
        } else {
          const reading = readIsolatedRun(previous, `baseline isolated ${file}`, file);
          const prior: SweepFailures = reading.kind === 'read' ? reading : { failures: [], errors: [rcOnlyId] };
          if (reading.kind === 'rc-nonzero-no-failures') debug.log('release-loop.gate', 'isolated-rc-nonzero-no-failures',
            { file, label: 'baseline isolated', rc: reading.rc, pass: reading.pass, baseline: 'same' });
          oldFailures = new Set([...prior.failures, ...prior.errors]);
          remember({ commit: baseSha, file, host: cacheHost, failures: prior.failures, errors: prior.errors, missing: false });
        }
      }
      if (rcOnly) {
        const baseline = oldFailures.has(rcOnlyId) ? 'same' : baselineMissing ? 'missing' : 'clean';
        result.rcNonzeroNoFailures.push({ file, rc: rcOnly.rc, pass: rcOnly.pass, baseline });
        debug.log('release-loop.gate', 'isolated-rc-nonzero-no-failures', { file, label: 'cut isolated', rc: rcOnly.rc, pass: rcOnly.pass, baseline });
      }
      for (const id of candidates) {
        if (oldFailures.has(id)) preexistingIds.push(id);
        else result.introduced.push(id);
      }
    };
    const cap = opts.pod && runner.recheckPod ? recheckConcurrency : 1;
    const settleStarted = async <T>(jobs: Promise<T>[]): Promise<T[]> => {
      const settled = await Promise.allSettled(jobs);
      const rejected = settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
      if (rejected.length) throw new SettledRecheckFailures(rejected.map((item) => item.reason));
      return settled.map((item) => (item as PromiseFulfilledResult<T>).value);
    };
    // Always attempt both eligible references before a failed Job can end the verdict. A cap of one
    // still runs the second Job, and successes retain their shadow if a peer throws.
    if (warmEligibleFiles.size && opts.pod && runner.recheckPod) {
      const completed = new Map<string, CommandResult>();
      const failures: unknown[] = [];
      const warmFiles = [...warmEligibleFiles].filter((file) => !prefetchedCut.has(file));
      for (let start = 0; start < warmFiles.length; start += cap) {
        const settled = await Promise.allSettled(warmFiles.slice(start, start + cap).map(async (file) => {
          const pod = { ...opts.pod!, warmCutSha: opts.commit, warmBaselineSha: baseSha, warmEligible: true,
            warmReplayOwner: true };
          return runner.recheckPodBatch
            ? (await runner.recheckPodBatch([file], opts.commit, pod, GATE_ISOLATED_TIMEOUT_MS)).get(file)
            : await runner.recheckPod!(file, opts.commit, pod, GATE_ISOLATED_TIMEOUT_MS);
        }));
        for (const [index, item] of settled.entries()) {
          if (item.status === 'rejected') failures.push(item.reason);
          else if (item.value) completed.set(warmFiles[start + index]!, item.value);
          else failures.push(new Error(`pod isolated recheck missing result: ${warmFiles[start + index]}`));
        }
      }
      for (const [file, run] of completed) {
        recordWarmShadow(run.warmShadow);
        prefetchedCut.set(file, run);
      }
      if (failures.length) throw new SettledRecheckFailures(failures);
    }
    for (let start = 0; start < recheckFiles.length; start += recheckLimit) {
      const window = recheckFiles.slice(start, start + recheckLimit);
      debug.log('release-loop.gate', 'isolated-recheck-window', { start, files: window.length, total: recheckFiles.length });
      if (opts.pod && runner.recheckPod && runner.recheckPodBatch) {
        const pending = window.filter((file) => !cutHostFailed.has(file) && !prefetchedCut.has(file));
        const warmSingles = pending.filter((file) => warmEligibleFiles.has(file)).length;
        const groups = [
          ...pending.slice(0, warmSingles).map((file) => [file]),
          ...Array.from({ length: Math.ceil((pending.length - warmSingles) / GATE_RECHECK_POD_BATCH_FILES) }, (_, index) =>
            pending.slice(warmSingles + index * GATE_RECHECK_POD_BATCH_FILES, warmSingles + (index + 1) * GATE_RECHECK_POD_BATCH_FILES)),
        ];
        for (let next = 0; next < groups.length; next += cap) {
          const batches = await settleStarted(groups.slice(next, next + cap).map((files) =>
            runner.recheckPodBatch!(files, opts.commit, { ...opts.pod!, warmCutSha: opts.commit, warmBaselineSha: baseSha,
              warmEligible: files.length === 1 && warmEligibleFiles.has(files[0]!) }, GATE_ISOLATED_TIMEOUT_MS)));
          for (const batch of batches) for (const [file, run] of batch) prefetchedCut.set(file, run);
        }
      }
      for (let next = 0; next < window.length; next += cap)
        await settleStarted(window.slice(next, next + cap).map((file, slot) => recheckFile(file, start + next + slot)));
      for (const file of window) prefetchedCut.delete(file);
    }
    result.introduced.sort();
    preexistingIds.sort();
    result.loadFlaky?.sort();
    result.preexisting = preexistingIds.length;
    result.baselineCache = cacheStats;
    debug.log('release.gate', 'baseline-cache', { hits: cacheStats.hits, misses: cacheStats.misses, commit: baseSha });
    const timedOutFiles = [...new Set(result.stalledEnv.filter((item) => item.reason === 'isolated-timeout').map((item) => item.file))].sort();
    const unmeasuredFiles = [...new Set([...timedOutFiles, ...(result.unmeasuredErrors ?? []).map((item) => item.file)])].sort();
    if (unmeasuredFiles.length) result.unmeasuredRecheckFiles = unmeasuredFiles;
    if (timedOutFiles.length || result.unmeasuredErrors?.length) {
      result.outcome = 'error';
      result.error = [
        timedOutFiles.length ? `isolated recheck timed out: ${timedOutFiles.join(', ')}` : undefined,
        result.unmeasuredErrors?.length ? `unhandled errors unmeasured after isolated recheck: ${result.unmeasuredErrors.map((item) => `${item.file} (${item.reason})`).join(', ')}` : undefined,
      ].filter(Boolean).join('; ');
    } else result.outcome = result.introduced.length ? 'regression' : 'ok';
    if (opts.rehearsalTui) {
      result.rehearsalTui = await executeTuiNodeCheck(opts.commit, repo, runner.localCommand);
      if (result.rehearsalTui.outcome !== 'ok') {
        result.outcome = 'error';
        result.error = result.rehearsalTui.detail;
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    const warmFailures = (error instanceof SettledRecheckFailures ? error.failures : [error])
      .filter((failure): failure is WarmRecheckIncomplete => failure instanceof WarmRecheckIncomplete);
    if (warmFailures.length) {
      (result.warmShadow ??= []).push(...warmFailures.map((failure) => failure.shadow));
      result.unmeasuredRecheckFiles = [...new Set([...(result.unmeasuredRecheckFiles ?? []),
        ...warmFailures.map((failure) => failure.file)])].sort();
    }
    if (error instanceof StalledPodShards) {
      result.stalledShards = error.stalledShards;
      result.partialSummary = error.partialSummary;
      result.partialFailures = error.partialFailures;
      result.preservedShardCount = error.preservedShardCount;
      if (error.abortedShards) result.abortedShards = error.abortedShards;
    }
  } finally {
    if (baseSnapshot && work) {
      try { await runner.removeSnapshot(join(work, 'baseline')); }
      catch (error) { result.outcome = 'error'; result.error = `cleanup: ${String(error)}`; }
    }
    for (const tree of trees.reverse()) {
      try { await runner.remove(tree); }
      catch (error) { result.outcome = 'error'; result.error = `cleanup: ${String(error)}`; }
    }
    if (work) {
      try {
        if (opts.remote) check(await runner.command('rm', ['-rf', '--', work], '/tmp'), 'remote temporary directory cleanup');
        else rmSync(work, { recursive: true, force: true });
      } catch (error) { result.outcome = 'error'; result.error = `cleanup: ${String(error)}`; }
    }
    if (opts.remote) runner.remoteMirror = undefined;
    result.durationMs = Date.now() - start;
  }
  if (cutFailures && !result.stalledShards?.length && !result.stalledEnv.length && !result.unmeasuredRecheckFiles?.length) {
    try {
      for (const location of roots) {
        const path = failureFile(location, opts.version);
        mkdirSync(dirname(path), { recursive: true });
        const temp = join(dirname(path), `.gate-failures-${process.pid}-${randomUUID()}.tmp`);
        try {
          writeFileSync(temp, JSON.stringify({ commit: opts.commit, failures: cutFailures.failures, ...(cutFailures.errors.length ? { errors: cutFailures.errors } : {}) }, null, 2) + '\n', { mode: 0o600 });
          chmodSync(temp, 0o600);
          renameSync(temp, path);
        } finally { if (existsSync(temp)) rmSync(temp); }
      }
    } catch (error) {
      result.outcome = 'error';
      result.error = `baseline persistence: ${String(error)}`;
    }
  }
  {
    const baselineCommit = baselineCommitForVerdict;
    const ids = {
      introduced: [...result.introduced].sort(),
      knownEnv: [...knownEnvIds].sort(),
      preexisting: [...preexistingIds].sort(),
      loadFlaky: [...(result.loadFlaky ?? [])].sort(),
      ...(result.unmeasuredRecheckFiles?.length ? { unmeasuredRecheckFiles: [...result.unmeasuredRecheckFiles].sort() } : {}),
      ...(result.unmeasuredErrors?.length ? { unmeasuredErrors: result.unmeasuredErrors } : {}),
      ...(result.interferenceErrors?.length ? { interferenceErrors: [...result.interferenceErrors].sort() } : {}),
    };
    const observed = { ...(result.selectionMs !== undefined ? { selectionMs: result.selectionMs } : {}),
      ...(result.warmShadow?.length ? { warmShadow: result.warmShadow } : {}) };
    // Receipt is advisory for a later radius gate. Missing identity makes reuse invalid, never this gate's verdict.
    const baselineReceipt = gateBaselineReceipt({ root, version: opts.version, commit: opts.commit,
      graphPins: gateGraphPins(root, opts.graphRunId) ?? (opts.rehearsalBaseline ? gateSourcePins(repo, opts.commit) : null),
      envFingerprint: gateEnvFingerprint(process.env),
      fullSweep: result.outcome === 'ok' && cutSweepUsable && !result.partial && !!cutFailures
        && !result.rcNonzeroNoFailures.length && !result.stalledShards?.length && !result.stalledEnv.length
        && !result.unmeasuredRecheckFiles?.length && !result.unmeasuredErrors?.length });
    try {
      for (const location of roots) {
        const path = verdictFile(location, opts.version);
        if (existsSync(path)) readFileSync(path, 'utf8');
      }
      for (const location of roots) {
        const path = verdictFile(location, opts.version);
        mkdirSync(dirname(path), { recursive: true });
        const temp = join(dirname(path), `.gate-verdict-${process.pid}-${randomUUID()}.tmp`);
        try {
          const warmHistory = readWarmVerdictHistory(path) ?? [];
          writeFileSync(temp, JSON.stringify({ version: opts.version, commit: opts.commit,
            outcome: result.outcome, ...ids, ...observed, baselineReceipt,
            ...(opts.pod?.warmReplay ? { baselineCommit, warmHistory } : {}) }, null, 2) + '\n', { mode: 0o600 });
          chmodSync(temp, 0o600);
          renameSync(temp, path);
        } finally { if (existsSync(temp)) rmSync(temp); }
      }
    } catch (error) {
      result.outcome = 'error';
      result.error = `verdict persistence: ${String(error)}`;
      const path = verdictFile(ledger, opts.version);
      try {
        mkdirSync(dirname(path), { recursive: true });
        const temp = join(dirname(path), `.gate-verdict-${process.pid}-${randomUUID()}.tmp`);
        try {
          const warmHistory = readWarmVerdictHistory(path) ?? [];
          writeFileSync(temp, JSON.stringify({ version: opts.version, commit: opts.commit,
            outcome: result.outcome, ...ids, ...observed, baselineReceipt,
            ...(opts.pod?.warmReplay ? { baselineCommit, warmHistory } : {}) }, null, 2) + '\n', { mode: 0o600 });
          chmodSync(temp, 0o600);
          renameSync(temp, path);
        } finally { if (existsSync(temp)) rmSync(temp); }
      } catch (persistenceError) {
        result.error += `; error verdict persistence: ${String(persistenceError)}`;
      }
    }
    debug.log('release-loop.gate', 'judged', {
      version: opts.version, commit: opts.commit, outcome: result.outcome,
      introduced: result.introduced.length, preexisting: result.preexisting,
      knownEnv: result.knownEnv, loadFlaky: ids.loadFlaky.length,
      introducedIds: ids.introduced, knownEnvIds: ids.knownEnv, preexistingIds: ids.preexisting, loadFlakyIds: ids.loadFlaky,
      ...(result.outcome === 'error' ? { error: result.error } : {}),
    });
  }
  if (radiusShadow) {
    try {
      const record = { plan: radiusShadow, recordedAt: new Date().toISOString(),
        actual: shadowActual({ plan: radiusShadow, outcome: result.outcome,
          introduced: result.introduced, cutFailures: cutFailures?.failures ?? [], cutErrors: cutFailures?.errors ?? [], cutRc: cutSweepRc,
          fullSweep: cutSweepUsable && !result.partial && !!cutFailures && result.outcome !== 'error'
            && !result.rcNonzeroNoFailures.length && !result.stalledShards?.length
            && !result.stalledEnv.length && !result.unmeasuredRecheckFiles?.length
            && !result.unmeasuredErrors?.length }) };
      const path = writeGateRadiusShadow(ledger, record);
      debug.log('release-loop.gate', 'radius-shadow-recorded', { path, proposed: radiusShadow.proposed,
        missedIntroduced: record.actual.missedIntroduced.length });
    } catch (error) { debug.log('release-loop.gate', 'radius-shadow-unavailable', { reason: String(error) }); }
  }
  // GATE-LIVE-OBS-RC-WORDING ⓒ — the shards board says «판정 전» until this lands; then «새 실패 N» only (UX · gate-shards.ts).
  // Same ledger as the board's own writes (sweep's shardsFile). A write failure is logged and never changes the verdict.
  if (result.outcome !== 'error' && opts.pod) {
    const path = opts.ledgerRoot ? gateShardsPath(opts.version, opts.ledgerRoot) : gateShardsPath(opts.version);
    try {
      const written = recordGateShardsVerdict(path, { introduced: result.introduced.length, preexisting: result.preexisting });
      debug.log('release-loop.gate', 'shards-verdict', { version: opts.version, path, written, introduced: result.introduced.length, preexisting: result.preexisting });
    } catch (error) { debug.log('release-loop.gate', 'shards-verdict-write-failed', { path, error: String(error) }); }
  }
  return result;
}

export function graphGateResult(result: GateResult, graph: boolean) {
  return { ...result, ...(graph && result.outcome === 'regression' ? { outcome: 'fail' as const } : {}),
    verdict: result.outcome === 'ok' ? 'pass' as const : 'fail' as const,
    summary: (result.partial ? `부분 재검 ${result.partial.files}파일(앞 게이트 ${result.partial.priorCommit.slice(0, 9)} 결과 이음) · ` : '')
      + (result.outcome === 'ok' ? `새 회귀 ${result.introduced.length} · 기존 ${result.preexisting} · 고침 ${result.fixed ?? '못 셈(기준선 미루기)'}` : `게이트 ${result.outcome}: ${result.error ?? result.introduced.length + ' new regressions'}`) + ` · 환경 알려진 실패 ${result.knownEnv}`
      + (result.rcNonzeroNoFailures.length ? ` · ⚠ 종료코드만 비영 ${result.rcNonzeroNoFailures.length}` : '')
      + (result.loadFlaky?.length ? ` · ⚠ 부하 흔들림 ${result.loadFlaky.length}(시간 초과 꼴 · ${GATE_TIMEOUT_RECHECK_MS / 1000}s 재실행 통과 · 막지 않음)` : '')
      + (result.stalledEnv.length ? ` · 환경 멈춤 ${result.stalledEnv.length} (Pod 밖 통과 ${result.stalledEnv.filter((item) => item.local === 'passed').length})` : '')
      + (result.abortedShards ? ` · 중단 조각 ${result.abortedShards}(중간 매달림 · 시험만 끊고 재확인)` : '') };
}

/** GATE-HOST-EXECUTOR — which executor produced (or will produce) this verdict, for the node output and observation. */
export function gateExecutorOf(opts: Pick<GateOptions, 'pod' | 'remote'>): { executor: GateExecutor; host: string | null } {
  // A Pod sweep runs in shard Pods even when gateRemote is also set (that host only holds the mirror) — no SSH host judged it.
  return opts.pod ? { executor: 'pod', host: null } : { executor: 'host', host: opts.remote ?? 'local' };
}

/** A Pod without an SSH host runs on this machine; it does not reserve every remote gate host. */
export function reservedGateHosts(opts: Pick<GateOptions, 'pod' | 'remote'>): string[] {
  return opts.pod ? [...new Set(parsePodPool(opts.pod.pool).map(member => member.sshHost ?? hostname()))]
    : [opts.remote?.split('@').at(-1) ?? hostname()];
}

/** What was asked for, read best-effort when the options themselves were refused — so a failed gate still says which executor. */
export function requestedGateExecutor(args: string[], env: NodeJS.ProcessEnv): { executor: string | null; host: string | null } {
  let executor: unknown;
  let host: unknown;
  try {
    if (usesGraphContext(args, env)) {
      const input = readGraphContext(env).input as Record<string, unknown>;
      executor = input.gateExecutor ?? (typeof input.gatePodPool === 'string' ? 'pod' : undefined);
      host = input.gateRemote;
    }
  } catch { /* the refusal itself is reported as the error */ }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--executor') executor = args[i + 1];
    else if (args[i] === '--remote') host = args[i + 1];
  }
  // Same rule as gateExecutorOf: a pod gate names no SSH host.
  return { executor: typeof executor === 'string' ? executor : null, host: executor !== 'pod' && typeof host === 'string' ? host : null };
}

function usesGraphContext(args: string[], env: NodeJS.ProcessEnv): boolean {
  return !!env.ELANOUS_GRAPH_CONTEXT && args.length > 0 && args.every(arg => arg === '--json');
}

export function parseOptions(args: string[], env: NodeJS.ProcessEnv): GateOptions | 'help' {
  const context = usesGraphContext(args, env) ? readGraphContext(env) : undefined;
  const fromGraph: Record<string, unknown> = context?.input ?? {};
  const graphCommit = context?.outputs['version-release']?.commit;
  if (typeof graphCommit === 'string') fromGraph.commit = graphCommit;
  const baselineCommit = context?.outputs.cutoff?.baseline as { sha?: unknown } | undefined;
  if (typeof baselineCommit?.sha === 'string') fromGraph.previousCommit = baselineCommit.sha;
  if (fromGraph.gateExecutor !== undefined && !isGateExecutor(fromGraph.gateExecutor)) throw new Error(`gateExecutor must be pod or host: ${String(fromGraph.gateExecutor)}`);
  // GATE-HOST-EXECUTOR: a host gate never reads the pod settings (a bad pod value must not block the fallback executor).
  const hostExecutor = fromGraph.gateExecutor === 'host';
  const opts: GateOptions = {
    rehearsalTui: fromGraph.rehearsalTui === true,
    recheckFileLimit: fromGraph.gateRecheckFileLimit !== undefined ? Number(fromGraph.gateRecheckFileLimit) : undefined,
    commit: typeof fromGraph.commit === 'string' ? fromGraph.commit : '',
    version: typeof fromGraph.version === 'string' ? fromGraph.version : '',
    baselineVersion: typeof fromGraph.previousVersion === 'string' ? fromGraph.previousVersion : undefined,
    forceFreeze: fromGraph.forceFreeze === true,
    baselineCommit: typeof fromGraph.previousCommit === 'string' ? fromGraph.previousCommit : undefined,
    remote: typeof fromGraph.gateRemote === 'string' ? fromGraph.gateRemote : undefined,
    remoteMirror: typeof fromGraph.gateRemoteMirror === 'string' ? fromGraph.gateRemoteMirror : undefined,
    pod: !hostExecutor && typeof fromGraph.gatePodPool === 'string' ? {
      pool: fromGraph.gatePodPool,
      ...(fromGraph.gatePodShards !== undefined ? { shards: Number(fromGraph.gatePodShards) } : {}),
      ...(fromGraph.gatePodShardTimeoutSeconds !== undefined ? { shardTimeoutSeconds: Number(fromGraph.gatePodShardTimeoutSeconds) } : {}),
      ...(typeof fromGraph.gatePodBunCache === 'string' && fromGraph.gatePodBunCache.trim() ? { bunCache: fromGraph.gatePodBunCache } : {}),
      ...(fromGraph.gatePodInstallSlots !== undefined ? { installSlots: Number(fromGraph.gatePodInstallSlots) } : {}),
      ...(fromGraph.gatePodAdmissionWaitSeconds !== undefined ? { admissionWaitSeconds: Number(fromGraph.gatePodAdmissionWaitSeconds) } : {}),
      ...(fromGraph.gatePodIsolationConcurrency !== undefined ? { isolationConcurrency: Number(fromGraph.gatePodIsolationConcurrency) } : {}),
      ...(fromGraph.gatePodStallSeconds !== undefined ? { stallSeconds: Number(fromGraph.gatePodStallSeconds) } : {}),
      ...(fromGraph.gatePodMidRunStallSeconds !== undefined ? { midRunStallSeconds: Number(fromGraph.gatePodMidRunStallSeconds) } : {}),
      ...(fromGraph.gatePodFreshShards === true ? { freshShards: true } : {}),
      ...((cpu) => cpu ? { cpu } : {})(parsePodCpu(fromGraph.gatePodCpu, 'release.loop.gatePodCpu')),
    } : undefined,
  };
  if (isGateExecutor(fromGraph.gateExecutor)) opts.executor = fromGraph.gateExecutor;
  let freshShards = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return 'help';
    if (arg === '--json') continue;
    if (arg === '--rehearsal-baseline') { opts.rehearsalBaseline = true; continue; }
    // Applied after the loop and only to a Pod gate — on its own it must not turn a local gate into a Pod one (review r5).
    if (arg === '--fresh-shards') { freshShards = true; continue; }
    if (arg === '--rehearsal-tui') { opts.rehearsalTui = true; continue; }
    if (arg === '--recheck-file-limit') {
      const value = args[++i];
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) throw new Error('--recheck-file-limit requires a positive integer');
      opts.recheckFileLimit = Number(value);
      continue;
    }
    if (arg === '--executor') {
      const value = args[++i];
      if (!isGateExecutor(value)) throw new Error(`--executor must be pod or host: ${value ?? ''}`);
      opts.executor = value;
      continue;
    }
    const key = ({ '--commit': 'commit', '--version': 'version', '--baseline-version': 'baselineVersion', '--baseline-commit': 'baselineCommit', '--remote': 'remote', '--remote-mirror': 'remoteMirror', '--pod-pool': 'pod', '--pod-shards': 'pod', '--pod-shard-timeout-seconds': 'pod' } as Record<string, keyof GateOptions>)[arg!];
    if (!key) throw new Error(`unknown option: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`value required for ${arg}`);
    if (arg === '--pod-pool') opts.pod = { ...opts.pod, pool: value };
    else if (arg === '--pod-shards') opts.pod = { pool: opts.pod?.pool ?? '', ...opts.pod, shards: Number(value) };
    else if (arg === '--pod-shard-timeout-seconds') opts.pod = { pool: opts.pod?.pool ?? '', ...opts.pod, shardTimeoutSeconds: Number(value) };
    else if (key === 'commit') opts.commit = value;
    else if (key === 'version') opts.version = value;
    else if (key === 'baselineVersion') opts.baselineVersion = value;
    else if (key === 'baselineCommit') opts.baselineCommit = value;
    else if (key === 'remote') opts.remote = value;
    else if (key === 'remoteMirror') opts.remoteMirror = value;
  }
  if (freshShards && opts.pod) opts.pod = { ...opts.pod, freshShards: true };
  // GATE-HOST-EXECUTOR: the host executor is the existing non-pod sweep on gateRemote — a configured pool must not pull it
  // back into Pods, and without a host it would silently sweep on the runner's own machine.
  if (opts.executor === 'host') {
    if (!opts.remote) throw new Error('gateExecutor host requires gateRemote (the SSH host whose clean clone runs the sweep)');
    opts.pod = undefined;
  }
  // An explicit pod choice must not quietly become a host sweep for want of a pool (absent executor = today's behaviour).
  if (opts.executor === 'pod' && !opts.pod?.pool) throw new Error('gateExecutor pod requires gatePodPool');
  return opts;
}

/** The node's run: judge, emit the graph result line, and return the process exit code (ok 0 · regression 1 · else 2).
 *  `runner` is a seam for tests; the process entry passes none. */
export async function runGateNode(argv: string[], env: NodeJS.ProcessEnv, runner?: GateRunner,
  judge: (opts: GateOptions, runner?: GateRunner) => Promise<GateResult> = judgeGate): Promise<number> {
  const start = Date.now();
  let result: GateResult;
  let version = '';
  let placement: { executor: string | null; host: string | null } | undefined;
  try {
    const parsed = parseOptions(argv, env);
    let config: unknown = null;
    if (parsed !== 'help' && !runner && parsed.pod) {
      try { config = getUserConfig(); }
      catch (error) { debug.log('release-loop.gate', 'warm-profile-unavailable', { error: String(error) }); }
    }
    const opts = parsed === 'help' ? parsed : withWarmGateHooks(parsed, config, !!runner);
    if (opts !== 'help') {
      placement = gateExecutorOf(opts);
      debug.log('release-loop.gate', 'executor', { version: opts.version, ...placement, requested: opts.executor ?? null });
    }
    if (opts === 'help') {
      console.log('Usage: bun scripts/release-loop/gate-node.ts --commit <sha> --version <v> [--baseline-version <prev>] [--baseline-commit <sha>] [--remote <ssh-host>] [--remote-mirror <path>] [--pod-pool <pool>] [--pod-shards <n>] [--pod-shard-timeout-seconds <n>] [--recheck-file-limit <n>] [--fresh-shards] [--executor <pod|host>] [--rehearsal-baseline] [--json]\nWithout flags, input.commit, input.version and input.previousVersion come from the JSON file at ELANOUS_GRAPH_CONTEXT.\n--executor host (input.gateExecutor) ignores every pod option and sweeps on --remote (input.gateRemote, required).\n--rehearsal-baseline pins source graph bytes only for a direct Pod gate on an isolated rc version.');
      return 0;
    }
    version = opts.version;
    // The graph's existing gate-node execution path delegates verdict classification and persistence here.
    const context = usesGraphContext(argv, env) ? readGraphContext(env) : undefined;
    // Let the gate's existing SSH host validation report an invalid host before any reservation is published.
    const hosts = opts.remote && !/^(?:[\w.-]+@)?[\w.-]+$/.test(opts.remote) ? [] : reservedGateHosts(opts);
    const reservationRoot = context ? gateHostReservationRoot() : undefined;
    if (context && (!context.runId || !env.ELANOUS_STATE_DIR || normRoot(env.ELANOUS_STATE_DIR) !== reservationRoot))
      throw new Error('release gate host reservation requires graph runId and pinned state root');
    const releaseHosts = context && hosts.length
      ? reserveReleaseGateHosts(reservationRoot!, context.runId!, hosts) : () => undefined;
    try { result = await judge(context?.runId ? { ...opts, graphRunId: context.runId } : opts, runner); }
    finally { releaseHosts(); }
  } catch (error) {
    result = { outcome: 'error', commit: '', introduced: [], preexisting: 0, fixed: 0, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: Date.now() - start, error: String(error) };
    placement ??= requestedGateExecutor(argv, env);
  }
  if (result.error) console.error(result.error);
  debug.log('release-loop.gate', 'result', { version, outcome: result.outcome, ...(placement ?? {}) });
  emitNodeResult({ ...graphGateResult(result, !!env.ELANOUS_GRAPH_CONTEXT), ...(placement ?? {}) });
  return result.outcome === 'ok' ? 0 : result.outcome === 'regression' ? 1 : 2;
}

if (import.meta.main) {
  // The graph spawns this file as its own process, which inherits no daemon sink — without this every
  // `release-loop.gate`/`release.gate`/`pod.pool` event stayed in the file trail and `elanous logs` read 0 rows.
  await registerStandaloneLogSink('release-loop');
  process.exitCode = await runWithReleaseGateTraffic(process.env, () => runGateNode(process.argv.slice(2), process.env));
}
