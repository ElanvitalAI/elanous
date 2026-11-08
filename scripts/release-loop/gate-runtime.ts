#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { debug, redactSecretText } from '../../src/debug/log.js';
import type { GateAdmission, GateCommandResult as CommandResult, GateOptions, GateProgressScheduler, GateResult, GateRunner, GateSweepProgress, GatePriorityImageState, GatePriorityShadowObservation, GateRiskLaneRecord, SweepFailures, WarmShadowObservation } from './gate-types.js';
export type { GateAdmission, GateOptions, GateProgressScheduler, GateResult, GateRunner, GateSweepProgress, GatePriorityImageState, GatePriorityShadowObservation, GateRiskLaneRecord, WarmShadowObservation } from './gate-types.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';
import { landingFreezeMessage, readLandingFreeze } from '../../src/release-loop/landing-freeze.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../src/instance/resolve.js';
import { getElanousConfigDirOverride } from '../../src/elanous-config-dir.js';
import { lastMatch, summaryCount } from './gate-test-summary.js';
import { collapseGateFailureAttempts, diffFailures, GateFailureAttributionMismatch, junitFailures, parseFailureAttempts, parseFailures, parseTimedOutFailures } from './gate-diff';
import { loadEnvKnownFailures, splitKnownEnv } from './env-known-failures';
import { loadGateBatchSafe } from './gate-batch-safe';
import { observeGatePrewarmCutShadow, type GatePrewarmInput } from './gate-prewarm-plan.js';
import { gateHistory } from './gate-history.js';
import { baselineUnmeasurableTimeoutIds } from './gate-baseline.js';
import { runPairedIsolatedBatch } from './gate-baseline-isolated.js';
import { baselineCommit, GATE_COMMIT_SHA as sha } from './gate-baseline-manifest.js';
export { baselineCommit } from './gate-baseline-manifest.js';
import { baselineFromCutLogs } from './baseline-from-logs';
import { changedFilesBetween, mergePartialFailures, readPartialPlanResult, testFileOfId, verifyDocsOnlyCarry } from './gate-partial';
import { planGateRadiusShadow, shadowActual, writeGateRadiusShadow, type GateRadiusShadowPlan } from './gate-radius-shadow';
import { planHardRehearsalRadius, partialGateImagesMatch, preflightGateBaseImageDigest, preflightGateExecutionIdentity, preflightGateImageDigest } from './gate-radius-live';
import { gitClosureTree, testsReachingChanged, testsReachingChangedForGateReuse } from './gate-closure.js';
import { actualGatePodImageDigest, gateBaselineReceipt, gateEnvFingerprint, gateGraphPins, gateShardRecipeIdentityAtCommit, gateSourcePins, parseGatePodRuntimeIdentity,
  POD_SWEEP_INTEGRATION_ONLY, gateAssignableTestsAtCommit } from './gate-baseline-receipt';
import { gateImagePinPath, normalizeGateImageDigest, pinnedGateImageSync as buildPinnedGateImageSync, readGateImagePin,
  readGateImagePinForRun, replaceGateImagePin, resolveGateImagePin, writeGateImagePin } from './gate-image-pin.js';
import { gateReceiptRegistryPath, planGateTrainReceiptCarry } from './gate-train-receipts.js';
import { gateReceiptHashesByShard } from './gate-receipt-hash.js';
import { formalReceiptSetPresenceReason } from './gate-shard-receipts.js';
import { gateEnvFingerprint as gateReceiptEnvFingerprint, gateLockfileHash } from '../../src/self-implement/gate-receipt-registry.js';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';
export { POD_SWEEP_INTEGRATION_ONLY } from './gate-baseline-receipt';
import { logPlanWalltime, planDurations, readFileMemory } from './shard-plan';
import { defaultGateHostMirrorReaders, resolveGateHostMirror, type GateHostMirror, type GateHostMirrorReaders } from './gate-host-mirror';
import { gateExternalVolumeMeasurements, parseGateExternalVolumeReadyEvents, parseGateExternalVolumeRejectedEvents, parseGateExternalVolumeRefs,
  GATE_VOLUME_REF_MOUNT_PATH, type GateExternalVolumeExpectations, type GateExternalVolumeRef } from '../../src/task-orchestrator/surfaces/pod-gate-volume-ref.js';
import { isGateSpawnLaneFile, planGateSpawnSeparatedShards } from './spawn-lane';
import { GATE_POD_ENV_BASELINE, gateTestBaseline } from '../lib/gate-test-env.js';
import { gateLockfileHashAtCommit, sameGateTestedFileHashes } from './gate-reuse-identity.js';
import { cachedCutSnapshot, createCutSnapshot } from './gate-cut-snapshot.js';
export { GATE_POD_ENV_BASELINE } from '../lib/gate-test-env.js';
import { readJunitFileSeconds } from './gate-method';
import { firstParentCommitsBetween, planGateBisect } from './gate-bisect.js';
import { deriveCdpTestPatterns } from '../test-deterministic';
import { emitNodeResult, readGraphContext } from './node-verdict.js';
import { isGateExecutor, type GateExecutor } from './gate-executor.js';
import { runPodCommand, parsePodCpu, podCpuMillis, resolvePodCpu, podCommandImageFor, podCommandJobFailureInfo, type RunPodCommandOptions, type PodCommandResult, type PodCpu } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { POD_BUN_CACHE_HOST_PATH, parseInstallSeconds, podBunCacheVolume } from '../../src/task-orchestrator/surfaces/pod-bun-cache.js';
import { NODE_REGISTRY, PodPoolScheduler, parsePodPool, checkPodPool, defaultRemoteRun, snapshotWarmPoolMembers, syncPoolImages, type PodPoolMember } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import { POD_INSTALL_SLOTS_DEFAULT, POD_INSTALL_SLOTS_HOST_PATH } from '../../src/task-orchestrator/surfaces/pod-install-slots.js';
import { parseGateDeps } from '../../src/task-orchestrator/surfaces/pod-gate-deps.js';
import { materializeWarmShardArtifacts, warmReferenceFromJobArtifacts, writeWarmJobManifest } from './gate-warm-artifacts.js';
import { assessWarmWorkerShadow, parseWarmWorkerReply, type WarmWorkerCommand, type WarmWorkerFileResult, type WarmWorkerKey } from '../../src/task-orchestrator/surfaces/pod-warm-worker-protocol.js';
import type { WarmPodTransportResult } from '../../src/task-orchestrator/surfaces/pod-warm-worker-pod.js';
import { configureWarmPodProvider, loadWarmPodProvider, requestWarmPodReplay, finalizeWarmPodReplay, quarantineWarmPodReplay, type WarmReplayInput, type WarmReplayResult } from '../../src/task-orchestrator/surfaces/pod-warm-worker-provider.js';
import { DEFAULT_CONTROL_PORT } from '../../src/control-plane/server.js';
import { createRunScopedWarmControlForward, startWarmControlPortForward } from './warm-control-forward.js';
import { resolveWarmPoolProfile } from '../../src/self-implement/pod-warm-pool-profile.js';
import { decideWarmReuse, type WarmReuseSwitchConfig, type WarmReuseEvidence } from '../../src/task-orchestrator/surfaces/pod-warm-switch.js';
import { invalidateWarmReuseEvidence, recordWarmReuseComparison, type ActualWarmLeaseEvidence } from '../../src/task-orchestrator/surfaces/warm-reuse-evidence.js';
import { getUserConfig, userConfigPath } from '../../src/user-config.js';
import { beginGateShardAttempt, finalizeTerminalGateShards, gateShardsPath, recordGateShardsVerdict, writeGateShards, type GateJobTerminal, type GateShard } from '../../src/release-loop/gate-shards.js';
import { appendGateShardLedgerBatch, appendGateShardLedgerForGate, gateShardLedgerBatchComplete, gateShardLedgerPath, readGateShardLedger, reusableGateShardLedgerBatch, type GateShardLedgerRow } from '../../src/release-loop/gate-shard-ledger.js';
import { recordGateTimeoutOwnerCells } from '../../src/release-loop/gate-timeout-owner-cell.js';
import { carryGateShardResult, markGateShardUnmeasured, nextGateShardAttempt, readGateShardManifest, readGateShardManifestHistory, readGateShardResult, reusableGateShardFailures, saveGateShardResult } from './gate-shard-receipts.js';
import { gateProgressTransitionKey, gateShardRuntimeIdentityKey, planGateReceiptRadius, planGateShardDispatch, summarizeGateProgress, type GateProgressGroup, type GateShardReceipt } from './gate-shard-dispatch.js';
import { defaultKubectl } from '../../src/task-orchestrator/surfaces/self-implement-pod.js';
import { executeTuiNodeCheck, type ExecutedTuiCheck } from './tui-node-checks.js';
import { runWithReleaseGateTraffic, runWithReleasePwaTraffic } from './gate-traffic-mode.js';
import { emitPodLifecycle, gatePodLifecycleEvent, gatePodOutcome } from '../../src/task-orchestrator/surfaces/pod-lifecycle-stages.js';
import { gateHostReservationRoot, readGateHostResourcesForHost, reserveReleaseGateHosts, type GateHostResourceReading } from '../../src/release-loop/gate-host-reservation.js';
import { startReleaseStageStallWatch } from '../../src/release-loop/stage-mail.js';
import { normRoot } from '../../src/instance/resolve.js';
import { readShardArtifacts } from './gate-shard-artifacts.js';
export { readShardArtifacts, type ShardArtifacts } from './gate-shard-artifacts.js';
import { decideAndRecordGateAutoheal, gateAutohealCause, type GateAutohealDecision } from './gate-autoheal.js';
import { gateEnvBaselineLine, gateShardShell, gateBeatScript, gateShardAbortScript, shellQuoteArgument as quote, asPath } from './gate-shard-shell.js';
import { GATE_NIGHTLY_AUDITS } from './gate-nightly-audits.js';
export { GATE_NIGHTLY_AUDITS } from './gate-nightly-audits.js';
export { gateEnvBaselineLine, gateShardShell, gateBeatScript, gateShardAbortScript, GATE_SHARD_ABORT_GRACE_SECONDS } from './gate-shard-shell.js';

/** Gate roster pools must prove the same immutable image; a down pool may be excluded, a different image may not. */
export function mismatchedGateRosterImagePools(
  poolImages: ReadonlyMap<string, readonly string[]>, pinnedDigest: string,
): string[] {
  // The second-pool protocol is specifically the node-b + mshq roster. Other rosters retain
  // the established behavior of excluding pools that cannot serve this run's pinned digest.
  if (poolImages.size !== 2 || !poolImages.has('pool-node-b') || !poolImages.has('pool-mshq')) return [];
  const expected = normalizeGateImageDigest(pinnedDigest);
  if (!expected) return [...poolImages.keys()];
  return [...poolImages].flatMap(([pool, images]) => {
    const measured = images.filter((image) => image.trim().length > 0);
    return measured.some((image) => normalizeGateImageDigest(image) !== expected) ? [pool] : [];
  });
}

export const GATE_BISECT_ALTERNATE_POOLS = [
  { host: 'node-c', pool: 'pool-node-c@node-c:1' },
  { host: 'mshq', pool: 'pool-mshq@mshq:1' },
  { host: 'gcp2', pool: 'pool-gcp2@gcp2:1' },
  { host: 'aws3', pool: 'pool-aws3@aws3:1' },
] as const;

export function selectGateBisectAlternatePool(gateHosts: ReadonlySet<string>) {
  const excluded = new Set([...gateHosts].map((host) => host.toLowerCase().split('.')[0]!));
  return GATE_BISECT_ALTERNATE_POOLS.find((candidate) => !excluded.has(candidate.host));
}

/** A provider may fill only lease identity; it cannot rewrite the Job attempt being compared. */
export function warmCommandMatchesRequest(command: WarmWorkerCommand, request: Omit<WarmWorkerCommand, 'leaseId' | 'generation' | 'workerId' | 'key'>): boolean {
  return command.protocol === request.protocol && command.runId === request.runId
    && command.attemptId === request.attemptId && command.cutSha === request.cutSha
    && command.baselineSha === request.baselineSha && command.deadlineAt === request.deadlineAt
    && command.envProfile === request.envProfile && command.files.length === request.files.length
    && command.files.every((file, index) => file === request.files[index]);
}


function redactedGateLogTail(input: string): string {
  // Redact before trimming: a truncated token might no longer match the redaction rule.
  const bytes = Buffer.from(redactSecretText(input), 'utf8');
  let start = Math.max(0, bytes.length - 16_384);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}
/**
 * GATE-FLOW-SIM — the gate's outside world as one seam: a scenario hands in the repo's fake clock
 * (`src/ux-sim/fake-clock.ts`) plus fake Pod/kubectl/ssh tools, and the production entry hands in nothing.
 * Every field falls back to the real tool, so an absent seam is today's behaviour byte for byte.
 */
export interface GateTools {
  /** Graph run identity passed to pool admission for shadow observations. */
  graphRunId?: string | null;
  /** Wall clock the gate measures with; absent = `Date.now`. */
  now?: () => number;
  /** The Pod Job runner (the fake Pod stage of a scenario); absent = the positional `podCommand`, else `runPodCommand`. */
  podCommand?: (options: RunPodCommandOptions) => Promise<PodCommandResult>;
  /** Kubernetes client (pool readiness · Pod lifecycle · Job log tail · failure evidence); absent = `defaultKubectl`. */
  kubectl?: typeof defaultKubectl;
  /** Mock-only imageID observation seam; production reads the completed Job's child imageID from Kubernetes. */
  podImageDigest?: (input: { job: PodCommandResult; host: string }) => string | null;
  /** Mock-only graph/recipe facts for an isolated gate tree; production pins the requested commit. */
  graphRecipePins?: (repo: string, commit: string) => ({ graphSha: string; recipeSha: string; graphEntry: string; recipeCommand: string; recipeTimeoutMs: number }) | null;
  /** SSH transport behind {@link GateRunner.command} on a remote host; absent = a real `ssh` child. */
  ssh?: (host: string, script: string, limitMs?: number) => { rc: number; output: string; timedOut?: boolean };
  /** SSH reachability probe of a multi-host roster; absent = `defaultRemoteRun`. */
  remoteRun?: typeof defaultRemoteRun;
  /** Pool admission a shard waits on (leases ⊕ a cluster reading); absent = the gate's own pool admission. */
  admission?: GateAdmission;
  /** The live progress heartbeat scheduler; tests inject a deterministic tick, production uses an unref'd interval. */
  progressScheduler?: GateProgressScheduler;
  /** Simulation seam for the detached regression-attribution sidecar launch. */
  startBisectSidecar?: (inputPath: string, gateOutcome: GateResult['outcome']) => void | Promise<void>;
  /** Simulation-only failure seam for the post-settlement HQ batch receiver. */
  appendShardLedgerBatch?: typeof appendGateShardLedgerBatch;
}

function emitGatePhaseProgress(phase: string, data: Record<string, unknown> = {}): void {
  const row = { phase, at: new Date().toISOString(), ...data };
  debug.log('release-loop.gate', `phase-${phase}`, row, { level: /failed|rejected/.test(phase) ? 'error' : 'info' });
  const path = process.env.ELANOUS_GATE_PROGRESS_FILE;
  if (!path) return;
  try { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 }); }
  catch (error) { debug.log('release-loop.gate', 'phase-event-write-failed', { phase, error: String(error) }, { level: 'warn' }); }
}

const scheduleGateProgress: GateProgressScheduler = (tick, intervalMs) => {
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};


/** One watchdog tick. Batch Kubernetes reads per host and trust only the current attempt's result marker. */
export function reconcileStaleGateShardBoard(input: {
  version: string;
  board: GateShard[];
  logDir?: string;
  kubectl: typeof defaultKubectl;
  now?: Date;
}): { board: GateShard[]; finalized: Array<{ shard: string; job?: string; state: GateShard['state']; source: 'result-json' | 'kubernetes-job-terminal'; endedAt: string }> } {
  const terminalJobs = new Map<string, GateJobTerminal>();
  const results = new Map<string, { completed?: boolean; jobName?: string; attemptId?: string; jobFailed?: boolean; rc?: number | null; reason?: 'timeout' | 'stall' }>();
  const active = input.board.filter((shard) => shard.state === 'running' || shard.state === 'retry');
  if (!active.length) return { board: input.board, finalized: [] };
  for (const shard of active) {
    if (input.logDir && shard.resultFile) {
      try {
        const raw = JSON.parse(readFileSync(join(input.logDir, basename(shard.resultFile)), 'utf8')) as Record<string, unknown>;
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.completed === true && typeof shard.job === 'string'
          && raw.jobName === shard.job && typeof shard.attemptId === 'string' && raw.attemptId === shard.attemptId) {
          results.set(shard.id, { completed: true, jobName: shard.job, attemptId: shard.attemptId,
            jobFailed: raw.jobFailed === true, rc: typeof raw.rc === 'number' ? raw.rc : null,
            ...(raw.reason === 'timeout' || raw.reason === 'stall' ? { reason: raw.reason } : {}) });
        }
      } catch { /* this attempt has not produced its result file yet */ }
    }
  }
  const byHost = new Map<string, GateShard[]>();
  for (const shard of active) if (shard.job && shard.host) byHost.set(shard.host, [...(byHost.get(shard.host) ?? []), shard]);
  for (const [host, shards] of byHost) {
    const retryIndividually = new Set(shards.map((shard) => shard.job!));
    try {
      const status = input.kubectl(['--context', host, '-n', 'elanous-test', 'get', 'jobs', ...shards.map((shard) => shard.job!), '-o', 'json']);
      const parsed = JSON.parse(status.stdout) as { items?: Array<{ metadata?: { name?: string }; status?: { conditions?: Array<{ type?: string; status?: string }> } }>; metadata?: { name?: string }; status?: { conditions?: Array<{ type?: string; status?: string }> } };
      const jobs = parsed.items ?? (parsed.metadata?.name ? [parsed as { metadata?: { name?: string }; status?: { conditions?: Array<{ type?: string; status?: string }> } }] : []);
      for (const shard of shards) {
        if (jobs.some((job) => job.metadata?.name === shard.job)) retryIndividually.delete(shard.job!);
        const conditions = jobs.find((job) => job.metadata?.name === shard.job)?.status?.conditions ?? [];
        if (conditions.some((condition) => condition.status === 'True' && condition.type === 'Complete')) terminalJobs.set(shard.job!, 'complete');
        else if (conditions.some((condition) => condition.status === 'True' && condition.type === 'Failed')) terminalJobs.set(shard.job!, 'failed');
      }
    } catch { /* a transient status read does not affect the gate verdict */ }
    // One missing/deleted Job can make a multi-name kubectl request non-zero; retry each name so siblings still reconcile.
    for (const shard of shards) {
      if (!retryIndividually.has(shard.job!)) continue;
      try {
        const status = input.kubectl(['--context', host, '-n', 'elanous-test', 'get', 'job', shard.job!, '-o', 'json']);
        const parsed = JSON.parse(status.stdout) as { metadata?: { name?: string }; status?: { conditions?: Array<{ type?: string; status?: string }> } };
        const conditions = parsed.status?.conditions ?? [];
        if (parsed.metadata?.name === shard.job && conditions.some((condition) => condition.status === 'True' && condition.type === 'Complete')) terminalJobs.set(shard.job!, 'complete');
        else if (parsed.metadata?.name === shard.job && conditions.some((condition) => condition.status === 'True' && condition.type === 'Failed')) terminalJobs.set(shard.job!, 'failed');
      } catch { /* this Job is still active, gone, or unreadable */ }
    }
  }
  const reconciled = finalizeTerminalGateShards({ v: 1, version: input.version, updatedAt: (input.now ?? new Date()).toISOString(), shards: input.board },
    terminalJobs, results, input.now ?? new Date());
  const finalized = reconciled.shards.flatMap((shard) => {
    if ((shard.state === 'running' || shard.state === 'retry') || !shard.endedAt) return [];
    const previous = input.board.find((row) => row.id === shard.id);
    if (!previous || (previous.state !== 'running' && previous.state !== 'retry')) return [];
    const result = results.get(shard.id);
    const source = result?.completed === true
      ? 'result-json' as const : 'kubernetes-job-terminal' as const;
    return [{ shard: shard.id, ...(shard.job ? { job: shard.job } : {}), state: shard.state, source, endedAt: shard.endedAt }];
  });
  return { board: reconciled.shards, finalized };
}


/** Gate-profile opt-in wires the producer only for the process entry, never a test runner seam. */
export interface WarmGateControlDependencies {
  startPortForward?: typeof startWarmControlPortForward;
  loadProvider?: typeof loadWarmPodProvider;
  configureProvider?: typeof configureWarmPodProvider;
  requestReplay?: typeof requestWarmPodReplay;
}

function safeWarmControlFailureReason(error: unknown): string {
  if (error instanceof SyntaxError) return 'provider-config-invalid-json';
  if (error instanceof Error) {
    if (error.message === 'warm provider config unavailable') return 'provider-config-unavailable';
    if (error.message === 'warm provider config must be private') return 'provider-config-not-private';
    if (error.message === 'invalid warm provider config') return 'provider-config-invalid';
    if (error.message === 'warm provider target is incomplete'
      || error.message === 'warm control forward requires one cluster and namespace per gate run') {
      return 'provider-config-target-invalid';
    }
  }
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
  if (code === 'ENOENT') return 'provider-config-unavailable';
  if (code === 'EACCES' || code === 'EPERM') return 'provider-config-permission-denied';
  return 'warm-control-setup-failed';
}

export function withWarmGateHooks(opts: GateOptions, config: unknown, injectedRunner = false,
  onWarmCleanup?: (cleanup: () => Promise<void>) => void,
  controlDependencies: WarmGateControlDependencies = {}): GateOptions {
  if (injectedRunner || !opts.pod || resolveWarmPoolProfile(config) !== 'gate') return opts;
  const podConfig = config && typeof config === 'object'
    ? (config as { pod?: { warmReuse?: { gateRecheck?: unknown; gateShardExecution?: unknown } } }).pod : undefined;
  const warmReuseConfig = podConfig?.warmReuse as WarmReuseSwitchConfig | undefined;
  const warmShardExecutionEnabled = podConfig?.warmReuse?.gateShardExecution !== false;
  const lifecycle = createRunScopedWarmControlForward(async () => {
    return startWarmGateControl(config, controlDependencies);
  });
  const replay: NonNullable<GateOptions['pod']>['warmReplay'] = async (input, selection) => {
    try { await lifecycle.ensure(); }
    catch (error) {
      const reason = safeWarmControlFailureReason(error);
      debug.log('pod.warm.control-forward', 'unavailable', { reason, fallback: 'fresh-job',
        ...(reason === 'provider-config-unavailable' ? { expectedFile: 'warm-pod-provider.json',
          setup: 'generate this host-local file with scripts/warm-pool-provider-config.ts' } : {}) }, { level: 'error' });
      return { command: null, transport: { status: 'fallback', reason: 'control-unavailable', reply: null } };
    }
    return (controlDependencies.requestReplay ?? requestWarmPodReplay)(input, undefined,
      { kind: 'gate', ...(selection?.lockHash ? { lockHash: selection.lockHash } : {}),
        ...(selection?.imageDigest ? { imageDigest: selection.imageDigest } : {}),
        ...(selection?.runtimeIdentity ? { runtimeIdentity: selection.runtimeIdentity } : {}),
        ...(selection?.runtimeContract ? { runtimeContract: selection.runtimeContract } : {}) });
  };
  const cleanup = async () => {
    try { await lifecycle.stop(); }
    finally { configureWarmPodProvider(null); }
  };
  onWarmCleanup?.(cleanup);
  return { ...opts, pod: { ...opts.pod, warmReplay: replay,
    warmFinalize: finalizeWarmPodReplay, warmQuarantine: quarantineWarmPodReplay, warmProducerEnabled: true, warmShardExecutionEnabled, warmReuseConfig } };
}

export function resolveWarmProviderConfig(config: unknown): { path: string; source: 'env' | 'config' | 'default' } | undefined {
  const envPath = process.env.ELANOUS_WARM_POD_PROVIDER_CONFIG?.trim();
  if (envPath) return { path: envPath, source: 'env' };

  const pod = config && typeof config === 'object' && !Array.isArray(config) && 'pod' in config
    && config.pod && typeof config.pod === 'object' && !Array.isArray(config.pod)
    ? config.pod as Record<string, unknown> : undefined;
  const configuredPath = typeof pod?.warmProviderConfig === 'string' ? pod.warmProviderConfig.trim() : '';
  if (configuredPath) return { path: configuredPath, source: 'config' };

  const defaultPath = join(dirname(userConfigPath()), 'warm-pod-provider.json');
  // A missing private config is an actionable deployment error, not an ambiguous "no provider" result.
  return { path: defaultPath, source: 'default' };
}

/** Carry the pin-derived identity for this gate invocation. Missing identity disables reuse. */
function setPinnedGateBaseImageDigest(value: string | null): string | null {
  const digest = normalizeGateImageDigest(value);
  process.env.ELANOUS_GATE_BASE_IMAGE_DIGEST = digest ?? '';
  return digest;
}

export function warmProviderTarget(path: string): { context: string; namespace: string } {
  if (!isAbsolute(path) || (statSync(path).mode & 0o077) !== 0) throw new Error('warm provider config must be private');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid warm provider config');
  const data = parsed as { candidates?: Array<{ spec?: { kubectlContext?: string; namespace?: string } }>;
    poolTemplates?: Array<{ spec?: { kubectlContext?: string; namespace?: string } }> };
  const rows = [...(data.candidates ?? []), ...(data.poolTemplates ?? [])];
  const targets = new Map<string, { context: string; namespace: string }>();
  for (const row of rows) {
    const context = row.spec?.kubectlContext;
    const namespace = row.spec?.namespace;
    if (typeof context !== 'string' || !context || typeof namespace !== 'string' || !namespace)
      throw new Error('warm provider target is incomplete');
    targets.set(`${context}/${namespace}`, { context, namespace });
  }
  if (targets.size !== 1) throw new Error('warm control forward requires one cluster and namespace per gate run');
  return [...targets.values()][0]!;
}

async function startWarmGateControl(config: unknown, dependencies: WarmGateControlDependencies) {
  const resolvedConfig = resolveWarmProviderConfig(config);
  if (!resolvedConfig) throw new Error('warm provider config unavailable');
  debug.log('pod.warm.control-forward', 'config-discovered', { source: resolvedConfig.source });
  const configPath = resolvedConfig.path;
  const target = warmProviderTarget(configPath);
  const forward = await (dependencies.startPortForward ?? startWarmControlPortForward)({ context: target.context,
    namespace: target.namespace, service: 'elanous-control', remotePort: DEFAULT_CONTROL_PORT });
  try {
    const provider = (dependencies.loadProvider ?? loadWarmPodProvider)(configPath, { runtimeOverrides: { controlUrl: forward.url } });
    (dependencies.configureProvider ?? configureWarmPodProvider)(provider);
    return forward;
  } catch (error) {
    await forward.stop();
    throw error;
  }
}


const versionPattern = /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/;
const failureFile = (root: string, version: string) => join(root, 'release', version, 'gate-failures.json');
/** Judged identities live beside the machine release ledger; gate-failures.json keeps its raw baseline schema. */
const verdictFile = (root: string, version: string) => join(root, 'release', version, 'gate-verdict.json');
export function sameHeadPreexistingFailureIds(root: string, version: string, head40: string, baseline40: string): string[] | undefined {
  try {
    const value = recordValue(JSON.parse(readFileSync(verdictFile(root, version), 'utf8')));
    if (!value || value.commit !== head40 || value.baselineCommit !== baseline40 || !['ok', 'regression'].includes(String(value.outcome))
      || !Array.isArray(value.preexisting) || !value.preexisting.every((id) => typeof id === 'string')) return undefined;
    return value.preexisting as string[];
  } catch { return undefined; }
}
/** Persist every judged gate attempt; an incomplete retry cannot erase the last complete sweep receipt. */
export function writeGateVerdictRecord(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const attemptsPath = join(dirname(path), 'gate-verdict-attempts.jsonl');
  appendFileSync(attemptsPath, JSON.stringify(value) + '\n', { encoding: 'utf8', mode: 0o600 });
  chmodSync(attemptsPath, 0o600);
  const complete = (record: Record<string, unknown> | null): boolean => {
    const receipt = recordValue(record?.baselineReceipt);
    return !!record && ['ok', 'regression'].includes(String(record.outcome))
      && receipt?.schema === 2 && receipt.valid === true && receipt.commit === record.commit;
  };
  const incomingComplete = complete(value);
  debug.log('release-loop.gate', 'verdict-attempt-recorded', {
    commit: typeof value.commit === 'string' ? value.commit : null,
    outcome: typeof value.outcome === 'string' ? value.outcome : null, complete: incomingComplete,
  });
  let previous: Record<string, unknown> | null = null;
  try { previous = recordValue(JSON.parse(readFileSync(path, 'utf8'))); } catch { /* first write or unreadable prior record */ }
  if (complete(previous) && !incomingComplete) {
    debug.log('release-loop.gate', 'incomplete-verdict-preserved', {
      completedCommit: previous!.commit, attemptCommit: typeof value.commit === 'string' ? value.commit : null,
      attemptsPath,
    });
    return;
  }
  const temp = join(dirname(path), `.gate-verdict-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } finally { if (existsSync(temp)) rmSync(temp); }
}
const WARM_VERDICT_HISTORY_LIMIT = 5;
const WARM_REPLAY_BUDGET = 3;
interface WarmVerdictSample { version: string; commit: string; baselineCommit: string; warmShadow: WarmShadowObservation[] }
const recordValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function validWarmShadowObservation(value: unknown): value is WarmShadowObservation {
  const row = recordValue(value);
  if (!row || !Array.isArray(row.files) || row.files.length !== 1 || typeof row.files[0] !== 'string'
    || !/^(?:[\w.-]+\/)*[\w.-]+\.test\.[cm]?[jt]sx?$/.test(row.files[0])
    || row.files[0].split('/').some((part) => part === '.' || part === '..')
    || typeof row.attemptId !== 'string' || !row.attemptId || typeof row.reason !== 'string'
    || !['observed', 'fallback', 'unmeasured'].includes(String(row.status))
    || !['yes', 'no', 'failed', 'unavailable'].includes(String(row.quarantined))) return false;
  if (row.finalized !== undefined && typeof row.finalized !== 'boolean') return false;
  if (row.cutSha !== undefined && typeof row.cutSha !== 'string') return false;
  if (row.baselineSha !== undefined && typeof row.baselineSha !== 'string') return false;
  if (row.workerKey !== undefined) {
    const key = recordValue(row.workerKey);
    if (!key || typeof key.context !== 'string' || !key.context || typeof key.imageDigest !== 'string' || !key.imageDigest
      || typeof key.lockHash !== 'string' || !key.lockHash || typeof key.architecture !== 'string' || !key.architecture) return false;
  }
  return true;
}
function validWarmVerdictSample(value: unknown): value is WarmVerdictSample {
  const row = recordValue(value);
  return !!row && typeof row.version === 'string' && typeof row.commit === 'string'
    && typeof row.baselineCommit === 'string' && Array.isArray(row.warmShadow)
    && row.warmShadow.every(validWarmShadowObservation);
}
/** The verdict is atomically replaced; carry a bounded prior-verdict window in that same SSOT. */
function readWarmVerdictHistory(path: string): WarmVerdictSample[] | undefined {
  if (!existsSync(path)) return [];
  try {
    const current = recordValue(JSON.parse(readFileSync(path, 'utf8')));
    if (!current || !Array.isArray(current.warmHistory)) return undefined;
    if (current.warmHistory.some((entry) => !validWarmVerdictSample(entry))) return undefined;
    const hasCurrentSample = ['version', 'commit', 'baselineCommit', 'warmShadow'].some((key) => key in current);
    const history = [...current.warmHistory];
    if (current.warmHistoryOnly !== true || hasCurrentSample) {
      const currentSample = { version: current.version, commit: current.commit,
        baselineCommit: current.baselineCommit, warmShadow: current.warmShadow };
      if (!validWarmVerdictSample(currentSample)) return undefined;
      if (current.warmHistoryOnly !== true) history.push(currentSample);
    }
    return history.slice(-WARM_VERDICT_HISTORY_LIMIT) as WarmVerdictSample[];
  } catch { return undefined; }
}

/** Append one actual pre-cut replay observation to the gate verdict's bounded history, preserving its gate result. */
function recordWarmPrecutCanarySample(path: string, sample: WarmVerdictSample): void {
  if (!sample.version || !/^[0-9a-f]{7,40}$/i.test(sample.commit) || !/^[0-9a-f]{7,40}$/i.test(sample.baselineCommit)
    || !Array.isArray(sample.warmShadow) || sample.warmShadow.length !== 1 || !sample.warmShadow.every(validWarmShadowObservation))
    throw new Error('invalid pre-cut canary sample');
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    let decoded: unknown;
    try { decoded = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { throw new Error(`gate verdict JSON is malformed: ${String(error)}`); }
    const parsed = recordValue(decoded);
    if (!parsed) throw new Error('gate verdict is not an object');
    current = parsed;
    if (current.warmHistory !== undefined && !Array.isArray(current.warmHistory)) throw new Error('gate verdict warmHistory is invalid');
  }
  const storedHistory = Array.isArray(current.warmHistory) ? [...current.warmHistory] : [];
  if (storedHistory.some((entry) => !validWarmVerdictSample(entry))) throw new Error('gate verdict warmHistory contains an invalid row');
  const history = storedHistory;
  const hasCurrentSample = ['version', 'commit', 'baselineCommit', 'warmShadow'].some((key) => key in current);
  if (current.warmHistoryOnly === true && hasCurrentSample) {
    const previous = { version: current.version, commit: current.commit, baselineCommit: current.baselineCommit, warmShadow: current.warmShadow };
    if (!validWarmVerdictSample(previous)) throw new Error('gate verdict current warm sample is invalid');
  } else if (current.warmHistoryOnly !== true) {
    const previous = { version: current.version, commit: current.commit, baselineCommit: current.baselineCommit, warmShadow: current.warmShadow };
    if (!validWarmVerdictSample(previous)) throw new Error('gate verdict current warm sample is invalid');
    history.push(previous);
  }
  history.push(sample);
  const body = JSON.stringify({ ...current, warmHistory: history.slice(-WARM_VERDICT_HISTORY_LIMIT), warmHistoryOnly: true }, null, 2) + '\n';
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.gate-verdict-${process.pid}-${randomUUID()}.tmp`);
  try { writeFileSync(temp, body, { mode: 0o600, flag: 'wx' }); chmodSync(temp, 0o600); renameSync(temp, path); }
  finally { if (existsSync(temp)) rmSync(temp); }
}

/** Run a bounded set of real fresh-Job ↔ warm-worker comparisons before the release gate. */
export async function runWarmPrecutCanary(input: { opts: GateOptions; runner: GateRunner; file: string;
  config: unknown; historyPath: string; timeoutMs?: number }): Promise<{ samples: WarmShadowObservation[]; decision: ReturnType<typeof decideWarmReuse> }> {
  const { opts, runner } = input;
  if (!opts.pod || !runner.recheckPod || !opts.baselineCommit || !opts.pod.warmReplay || !opts.pod.warmFinalize || !opts.pod.warmQuarantine)
    throw new Error('pre-cut canary requires a Pod pool, baseline commit, and warm worker hooks');
  if (!/^(?:[\w.-]+\/)*[\w.-]+\.test\.[cm]?[jt]sx?$/.test(input.file)
    || input.file.split('/').some((part) => part === '.' || part === '..')) throw new Error('pre-cut canary requires one repository test file');
  if (readWarmVerdictHistory(input.historyPath) === undefined)
    throw new Error('gate verdict contains malformed warm history or current sample; refusing canary without writing');
  const samples = 2;
  if (samples > WARM_REPLAY_BUDGET) throw new Error(`pre-cut canary sample count exceeds replay budget (${WARM_REPLAY_BUDGET})`);
  const lock = await runner.localCommand('git', ['show', `${opts.commit}:bun.lock`], opts.repo ?? process.cwd());
  if (lock.rc !== 0 || !lock.output) throw new Error('pre-cut canary cut lock is unmeasured');
  if (!/^[0-9a-f]{40}$/i.test(opts.baselineCommit)) throw new Error('pre-cut canary baseline commit is invalid');
  const baseline = await runner.localCommand('git', ['cat-file', '-e', `${opts.baselineCommit}^{commit}`], opts.repo ?? process.cwd());
  if (baseline.rc !== 0) throw new Error(`pre-cut canary baseline commit is absent: ${opts.baselineCommit.slice(0, 12)}`);
  const trackedFile = await runner.localCommand('git', ['cat-file', '-e', `${opts.commit}:${input.file}`], opts.repo ?? process.cwd());
  if (trackedFile.rc !== 0) throw new Error(`pre-cut canary test file is absent from cut ${opts.commit.slice(0, 12)}`);
  const lockHash = createHash('sha256').update(lock.output).digest('hex');
  const pod = { ...opts.pod, warmProducerEnabled: false, warmCutSha: opts.commit, warmBaselineSha: opts.baselineCommit,
    warmEligible: true, warmReplayOwner: true, warmShadowScope: { requested: false, attempts: 0 } };
  const observations: WarmShadowObservation[] = [];
  const attemptIds = new Set<string>();
  for (let index = 0; index < samples; index++) {
    let observation: WarmShadowObservation;
    let failure: Error | undefined;
    try {
      const result = await runner.recheckPod(input.file, opts.commit, pod, input.timeoutMs ?? GATE_ISOLATED_TIMEOUT_MS);
      observation = result.warmShadow ?? { files: [input.file], attemptId: `precut-unmeasured-${index + 1}-${randomUUID()}`,
        status: 'unmeasured', reason: result.rc === 0 ? 'warm-shadow-missing' : `fresh-job-rc-${result.rc}`, quarantined: 'no' };
      if (result.rc !== 0) { observation = { ...observation, status: 'unmeasured', reason: `fresh-job-rc-${result.rc}` };
        failure = new Error(`pre-cut fresh Job failed on attempt ${index + 1}: rc=${result.rc}`); }
      else if (observation.status !== 'observed' || !observation.workerKey
        || observation.files.length !== 1 || observation.files[0] !== input.file
        || observation.cutSha !== opts.commit || observation.baselineSha !== opts.baselineCommit
        || observation.workerKey.lockHash !== lockHash || !['match', 'result'].includes(observation.reason)
        || attemptIds.has(observation.attemptId)
        || (observation.reason === 'match' && (observation.finalized !== true || observation.quarantined !== 'no'))) {
        failure = new Error(`pre-cut warm comparison was not measured on attempt ${index + 1}: ${observation.reason}`);
        observation = { ...observation, status: 'unmeasured', reason: observation.reason || 'warm-shadow-unmeasured' };
      }
    } catch (error) {
      observation = { files: [input.file], attemptId: `precut-error-${index + 1}-${randomUUID()}`,
        status: 'unmeasured', reason: String(error), quarantined: 'unavailable' };
      failure = error instanceof Error ? error : new Error(String(error));
    }
    const journalObservation = observation;
    const { leaseEvidence: _leaseEvidence, ...persistedObservation } = observation;
    observation = persistedObservation;
    attemptIds.add(observation.attemptId);
    observations.push(observation);
    try {
      recordWarmPrecutCanarySample(input.historyPath, { version: opts.version, commit: opts.commit,
        baselineCommit: opts.baselineCommit, warmShadow: [observation] });
    } catch (error) {
      invalidateWarmReuseEvidence();
      throw error;
    }
    await journalWarmGateShadow(journalObservation, opts.commit, runner, opts.repo ?? process.cwd());
    if (failure) throw failure;
  }
  const history = readWarmVerdictHistory(input.historyPath);
  const evidence = warmEvidenceFromVerdicts(history, opts.version, opts.commit, opts.baselineCommit, lockHash);
  const warmReuseConfig = (input.config && typeof input.config === 'object' && 'pod' in input.config
    && recordValue((input.config as Record<string, unknown>).pod)?.warmReuse) as WarmReuseSwitchConfig | undefined;
  return { samples: observations, decision: decideWarmReuse('gate-recheck', warmReuseConfig,
    evidence ? { 'gate-recheck': evidence } : undefined) };
}
/** Every counted match has a measured, finalized worker with this exact cut, baseline and lock. */
async function journalWarmGateShadow(shadow: WarmShadowObservation, commit: string, runner: GateRunner, repo: string): Promise<void> {
  let head = '';
  let main = '';
  try {
    const headResult = await runner.localCommand('git', ['rev-parse', `${commit}^{commit}`], repo);
    const mainResult = await runner.localCommand('git', ['ls-remote', 'origin', 'refs/heads/main'], repo);
    head = headResult.rc === 0 ? headResult.output.trim() : '';
    const match = mainResult.rc === 0 ? /^(?:[0-9a-f]{40})\s+refs\/heads\/main\s*$/im.exec(mainResult.output) : null;
    main = match?.[0].trim().split(/\s+/)[0] ?? '';
  } catch (error) {
    invalidateWarmReuseEvidence();
    debug.log('pod.warm', 'evidence-journal-write-failed', { consumer: 'gate-recheck', reason: 'head-main-lookup-failed' }, { level: 'warn' });
    return;
  }
  if (!/^[0-9a-f]{40}$/i.test(head) || !/^[0-9a-f]{40}$/i.test(main)) {
    invalidateWarmReuseEvidence();
    debug.log('pod.warm', 'evidence-journal-write-failed', { consumer: 'gate-recheck', reason: 'head-main-unmeasured' }, { level: 'warn' });
    return;
  }
  const accepted = head === main && shadow.status === 'observed' && shadow.reason === 'match'
    && shadow.finalized === true && shadow.quarantined === 'no' && !!shadow.leaseEvidence;
  try {
    recordWarmReuseComparison({ consumer: 'gate-recheck', head, main,
      ...(shadow.leaseEvidence ? { lease: { workerId: shadow.leaseEvidence.workerId,
        leaseId: shadow.leaseEvidence.leaseId, generation: shadow.leaseEvidence.generation,
        expectedLockHash: shadow.leaseEvidence.expectedLockHash, workerLockHash: shadow.leaseEvidence.workerLockHash,
        leaseValid: shadow.leaseEvidence.leaseValid, canaryPassed: shadow.leaseEvidence.canaryPassed,
        agree: shadow.leaseEvidence.agree } } : {}),
      comparison: { reason: shadow.reason }, finalized: accepted,
      reason: head === main ? (shadow.reason || shadow.status) : 'head-main-mismatch' });
  } catch (error) {
    debug.log('pod.warm', 'evidence-journal-write-failed', { consumer: 'gate-recheck', reason: String(error) }, { level: 'warn' });
  }
}

export function warmEvidenceFromVerdicts(history: readonly WarmVerdictSample[] | undefined,
  version: string, head: string, baseline: string, lock: string): WarmReuseEvidence | undefined {
  if (!history?.length || !lock) return undefined;
  const matchingHistory = history.filter((verdict) => verdict.version === version && verdict.commit === head
    && verdict.baselineCommit === baseline);
  const rows = matchingHistory.flatMap((verdict) => verdict.warmShadow.length ? verdict.warmShadow : [null]);
  if (!rows.length) return undefined;
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
    const pending = Promise.resolve().then(() => pod.warmReplay!(request, { kind: 'gate',
      lockHash: expectedKey.lockHash, imageDigest: expectedKey.imageDigest,
      runtimeIdentity: { baseImageDigest: pod.executionIdentity?.baseImageDigest ?? '', lockHash: expectedKey.lockHash,
        os: pod.executionIdentity?.platform ?? '', architecture: pod.executionIdentity?.architecture ?? '',
        bunVersion: pod.executionIdentity?.bunVersion ?? '' } }));
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
const defaultRemoteMirror = '~/mirror/elanous-agent.git';

function check(result: CommandResult, label: string): void {
  if (result.rc !== 0) throw new Error(`${label} failed (rc=${result.rc}): ${result.output.slice(-500)}`);
}

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
/** `test:deterministic` runs several Bun commands. Its final clean command is not the verdict for earlier commands. */
function deterministicSubrunCounts(output: string): { fail: number; error: number } | undefined {
  if (!/error: script "test:deterministic" exited with code 1/.test(output)) return undefined;
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const runs: Array<{ fail: number; error: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^Ran \d+ tests? across [1-9]\d* files?\./.test(lines[i]!)) continue;
    let pass: number | undefined;
    let fail: number | undefined;
    let error = 0;
    for (let j = i - 1; j >= Math.max(0, i - 8); j -= 1) {
      const line = lines[j]!;
      const count = /^(\d+) (pass|fail|skip|errors?|expect\(\) calls)$/.exec(line);
      if (!line) continue;
      if (!count) break;
      if (count[2] === 'pass') { pass = Number(count[1]); break; }
      if (count[2] === 'fail') fail = Number(count[1]);
      if (count[2] === 'error' || count[2] === 'errors') error = Number(count[1]);
    }
    if (pass === undefined || fail === undefined) return undefined;
    runs.push({ fail, error });
  }
  if (runs.length < 2) return undefined;
  return runs.reduce((sum, run) => ({ fail: sum.fail + run.fail, error: sum.error + run.error }), { fail: 0, error: 0 });
}
/** bun reads a bare positional as a substring filter (`test` matches every *.test.ts); `./` makes it a path. */
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

/** GATE-RISK-LANE — the shard plan plus the risk shard it may have placed first. */
export interface GateRiskLanePlan {
  /** Execution order: the risk shard first (absent when nothing is watched), then the current plan unchanged. */
  shards: Array<{ files: string[]; plannedSeconds: number }>;
  /** Assignable files this plan treated as risk — exactly `shards[0].files`; empty means «the current plan». */
  riskFiles: string[];
  riskPlannedSeconds: number;
  spawnFiles: string[];
  spawnShardCount: number;
}

/**
 * GATE-RISK-LANE — the watch list the gate-history table already keeps (`gateHistory().watchList`: introduced or flaky
 * in at least two of the last three releases). Reading it never blocks a gate: an unreadable ledger set is «no list».
 */
export function readGateRiskWatchList(o: { instanceRoots: readonly string[]; ledgerRoots: readonly string[] }): string[] {
  try { return gateHistory({ instanceRoots: o.instanceRoots, ledgerRoots: o.ledgerRoots }).watchList; }
  catch (error) {
    debug.log('release-loop.gate', 'risk-lane-watch-unavailable', { reason: String(error) });
    return [];
  }
}

/**
 * GATE-RISK-LANE (0.2.36) — the next full sweep runs the files the watch list names in its first shard, so a repeat
 * regression breaks before the general shards spend their deadline. Only the order changes:
 * - a watched heavy file already runs alone at the isolation limit, and a watched spawn file keeps its own lane (a part
 *   mixing real child/PTY files with regular ones is refused by {@link gateShardShell}) — neither joins the risk shard;
 * - every assignable file is assigned exactly once: the risk files leave the lane they would have been balanced into;
 * - with no watch list, or one that names no file of this sweep, the plan is today's plan byte for byte;
 * - when the watch list hits, the sweep runs exactly one more shard than configured (the risk shard in front), which is
 *   the same trade the configuration already makes for spawning a Pool Job.
 */
export function planGateRiskLaneShards(o: { assignable: readonly string[]; durations: Map<string, number>; shardCount: number;
  heavy: ReadonlySet<string>; watchList: readonly string[] }): GateRiskLanePlan {
  const light = o.assignable.filter((file) => !o.heavy.has(file));
  const watched = new Set(o.watchList);
  const riskFiles = [...new Set(light)].filter((file) => watched.has(file) && !isGateSpawnLaneFile(file)).sort();
  const heavyShards = [...o.heavy].map((file) => ({ files: [file], plannedSeconds: o.durations.get(file) ?? 0 }));
  const planWith = (files: readonly string[]) => planGateSpawnSeparatedShards(files, o.durations, o.shardCount);
  if (!riskFiles.length) {
    const current = planWith(light);
    return { shards: [...current.shards, ...heavyShards], riskFiles: [], riskPlannedSeconds: 0,
      spawnFiles: current.spawnFiles, spawnShardCount: current.spawnShardCount };
  }
  const risk = new Set(riskFiles);
  const rest = planWith(light.filter((file) => !risk.has(file)));
  // An unmeasured file takes the same median weight planShards gives it, so the shard's plan stays comparable.
  const known = o.assignable.map((file) => o.durations.get(file))
    .filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const median = known.length ? (known[Math.floor((known.length - 1) / 2)]! + known[Math.floor(known.length / 2)]!) / 2 : 1;
  const plannedSeconds = riskFiles.reduce((sum, file) => {
    const value = o.durations.get(file);
    return sum + (value !== undefined && Number.isFinite(value) && value >= 0 ? value : median);
  }, 0);
  return {
    shards: [{ files: [...riskFiles], plannedSeconds }, ...rest.shards, ...heavyShards],
    riskFiles: [...riskFiles], riskPlannedSeconds: plannedSeconds,
    spawnFiles: rest.spawnFiles, spawnShardCount: rest.spawnShardCount,
  };
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

/** Install-slot logs are produced by the same Pod shell as stages.tsv. Keep this as a measured wait, not inferred from
 * the broader dependency-install span. The log reports whole seconds, so callers retain that resolution. */
export function parseGateInstallSlotWaitMs(text: string): number | undefined {
  const waits = [...text.matchAll(/^\[gate\] install-slot (?:\d+ waited |none \(waited )(\d+(?:\.\d+)?)s\)?$/gm)]
    .map((match) => Number(match[1]) * 1000).filter(Number.isFinite);
  return waits.length ? waits.reduce((sum, value) => sum + value, 0) : undefined;
}

function elapsedMs(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) return undefined;
  const from = Date.parse(start), to = Date.parse(end);
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from : undefined;
}

/** Per-shard preparation timings, joined by the exact runKey already written to pod-N.json. Missing stages stay absent. */
export function gatePreparationTimings(input: {
  phaseTimes: Readonly<Record<string, string>>;
  podStages?: Readonly<Record<string, number>>;
  podLifecycle?: Readonly<Record<string, string>>;
  admissionWaitMs?: number;
  installSeconds?: number | null;
  installSlotWaitMs?: number;
  volumeRefPreparationMs?: number;
}): { stagesMs: Record<string, number>; preTestMs?: number; measuredPreTestStages: string[]; missingPreTestStages: string[] } {
  const phase = input.phaseTimes;
  const pod = input.podStages ?? {};
  const k8s = input.podLifecycle ?? {};
  const measured: Record<string, number | undefined> = {
    admissionWait: input.admissionWaitMs,
    create: elapsedMs(phase.poolPlaced, k8s.podCreated),
    schedule: elapsedMs(k8s.podCreated, k8s.podScheduled),
    // Kubernetes does not expose pull-start/pull-end as Pod timestamps; this measured span includes image pull + init/container startup.
    imageAndBoot: elapsedMs(k8s.podScheduled, k8s.childStart),
    clone: typeof pod['prep-start'] === 'number' && typeof pod['clone-end'] === 'number' && pod['clone-end'] >= pod['prep-start']
      ? (pod['clone-end'] - pod['prep-start']) * 1000 : undefined,
    installSlotWait: input.installSlotWaitMs,
    install: input.installSeconds != null && Number.isFinite(input.installSeconds) ? input.installSeconds * 1000 : undefined,
    dependencyTotal: typeof pod['deps-start'] === 'number' && typeof pod['deps-end'] === 'number' && pod['deps-end'] >= pod['deps-start']
      ? (pod['deps-end'] - pod['deps-start']) * 1000 : undefined,
    volumeRefVerification: input.volumeRefPreparationMs,
  };
  const stagesMs = Object.fromEntries(Object.entries(measured).filter((entry): entry is [string, number] => entry[1] !== undefined));
  // Volume preflight runs inside source/dependency preparation. Report it as an overlapping diagnostic,
  // but do not add the same wall time to preTestMs a second time.
  const preTestStages = ['admissionWait', 'create', 'schedule', 'imageAndBoot', 'clone', 'dependencyTotal', 'installSlotWait', 'install'];
  const totalStages = preTestStages.slice(0, 6);
  const measuredPreTestStages = preTestStages.filter((stage) => stagesMs[stage] !== undefined);
  const missingPreTestStages = preTestStages.filter((stage) => stagesMs[stage] === undefined);
  const preTestMs = totalStages.every((stage) => stagesMs[stage] !== undefined)
    ? totalStages.reduce((sum, stage) => sum + stagesMs[stage]!, 0) : undefined;
  return { stagesMs, ...(preTestMs !== undefined ? { preTestMs } : {}), measuredPreTestStages, missingPreTestStages };
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
/** What one shard's stall watch saw — armed (checkout seen) · why it ended · first test output seconds after the checkout. */
export type ShardStallWatchState = { armed: boolean; disarmedBy: 'test-output' | 'stall-fired' | 'mid-run-stall' | null; firstTestAtSec: number | null;
  abort?: Omit<ShardAbort, 'sinceLastOutputMs' | 'taken'> };
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
/** The line appended to pod-N.log when part output that never finished went to pod-N.unfinished.log (a reader of pod-N.log alone saw «no test output»). */
export const gateUnfinishedHint = (relativePath: string, bytes: number) => `[gate] unfinished: ${relativePath} · ${bytes}B (진행 중 part 출력은 그 파일)`;

// review-model-ab: Pod 에서 출력 없이 멈춤 2/2(10-04 0.2.11 · 로컬 단독 4/0 · 1.7s) — GATE-STALL 수리 전까지 Pod 밖.
// The shared exclusion list lives in gate-baseline-receipt so radius verification uses the producer's rule.
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
export function previousShardDescent(logDir: string, name: string, commit: string, files: readonly string[], runKey: string, parentAttempt?: string, splitChild?: string): { way: 'retry' | 'split' | 'file-fanout'; attemptId: string } | undefined {
  const meta = (file: string): { commit?: unknown; files?: unknown; rc?: unknown; reason?: unknown; runKey?: unknown; attemptId?: unknown; parentAttempt?: unknown } | undefined => {
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
  // A stalled multi-file parent may have descended directly to one Pod per file. Keep that shape on resume.
  if (own.reason === 'stall' && files.length > 1 && child(`${name}-file-0`, false)) return { way: 'file-fanout', attemptId };
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
  // Validated Pod shards were checked separately before their logs were joined; only the host sweep needs subrun totals.
  const subruns = !run.validatedShards && run.rc === 1 ? deterministicSubrunCounts(output) : undefined;
  const errorCount = subruns?.error ?? (Number.isNaN(reportedErrors) ? 0 : reportedErrors);
  const incomplete = (reason: string) => new Error(`${label} incomplete (rc=${run.rc}; Ran=${ran ? ran[0] : 'missing'}; errors=${subruns || !Number.isNaN(reportedErrors) ? errorCount : 'missing'}; ${reason})\n${tail40(output)}`);
  const count = subruns?.fail ?? summaryCount(output, 'fail');
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
  const collapsed = collapseGateFailureAttempts(parseFailureAttempts(executionOutput));
  const failures = collapsed.failures;
  if (collapsed.collapsed > 0) debug.log('release-loop.gate', 'failure-attribution-deduplicated', {
    label, summary: count, observed: occurrences, identified: collapsed.failures.length, collapsed: collapsed.collapsed,
  });
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
  const retryDuplicatesExplainCount = occurrences > count && collapsed.observed === occurrences && failures.length === count;
  if (Number.isFinite(count) && (failures.length !== count || (occurrences !== count && !retryDuplicatesExplainCount))) {
    throw new GateFailureAttributionMismatch(label, count, occurrences, failures.length, collapsed.collapsed, failures);
  }
  if (!Number.isFinite(count) || (count > 0 && failures.length === 0)
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
    const failCount = deterministicSubrunCounts(output)?.fail ?? summaryCount(output, 'fail');
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
      + (stalledShards.some((item) => item.reason === 'image-pin-mismatch') ? ` (image pin mismatch: ${stalledShards.filter((item) => item.reason === 'image-pin-mismatch').map((item) => item.detail ?? `shard ${item.shard}`).join('; ')})` : '')
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
export const GATE_ATTRIBUTION_RECHECK_FILE_LIMIT = 64;
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


export interface GatePriorityShadowDecision extends GatePriorityShadowObservation {
  event: 'gate-priority-shadow-decision';
  decision: 'gate-first' | 'no-contention' | 'insufficient-evidence';
  selectionRationale: string;
}

/** A shadow-only policy decision; it has no pool or Pod handle and cannot change runtime state. */
export function gatePriorityShadowDecision(input: GatePriorityShadowObservation): GatePriorityShadowDecision {
  const base = { event: 'gate-priority-shadow-decision' as const, ...input };
  if (!input.gateWaiting || input.lowerPriorityWaiting === false) {
    return { ...base, decision: 'no-contention', selectionRationale: !input.gateWaiting ? 'gate-not-waiting' : 'no-lower-priority-waiter-observed' };
  }
  if (input.lowerPriorityWaiting !== true) {
    return { ...base, decision: 'insufficient-evidence', selectionRationale: 'lower-priority-wait-state-unknown' };
  }
  if (!input.gateRunId || !input.competingRunId || !input.host || input.host !== input.competingHost) {
    return { ...base, decision: 'insufficient-evidence', selectionRationale: 'same-host-run-identities-unavailable' };
  }
  if (input.gateImageState !== 'verified' || input.competingImageState !== 'verified') {
    return { ...base, decision: 'insufficient-evidence', selectionRationale: 'image-state-not-verified' };
  }
  return { ...base, decision: 'gate-first', selectionRationale: 'same-host-contention-and-verified-gate-image; gate-policy-priority' };
}

export const GATE_ADMISSION_WAIT_SECONDS_DEFAULT = 1800;
/** Queue pressure scales the default wait but never creates an unbounded admission timer. */
export function gateAdmissionWaitSeconds(shards: number, slots: number): number {
  return Math.max(GATE_ADMISSION_WAIT_SECONDS_DEFAULT, Math.min(3600,
    Math.ceil(shards / Math.max(1, slots)) * 300));
}
export function createGateRootLimiter(slots: number): <T>(run: () => Promise<T>) => Promise<T> {
  if (!Number.isSafeInteger(slots) || slots < 1) throw new Error('invalid gate root slots');
  let active = 0;
  const waiters: Array<() => void> = [];
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= slots) await new Promise<void>((resolve) => waiters.push(resolve));
    else active++;
    try { return await run(); }
    finally {
      const next = waiters.shift();
      if (next) next(); // transfer the occupied slot before another caller can enter
      else active--;
    }
  };
}
/** A direct gate has no preflight image pin. Its measured receipt still carries its own image digest. */
function gateRuntimeSourceFingerprint(repo: string, commit: string, identity: { bunVersion: string; platform: string; architecture: string; envFingerprint: string; baseImageDigest?: string } | null | undefined): string | null {
  if (!identity || typeof identity.baseImageDigest !== "string" || !/^[a-f0-9]{40}$/i.test(commit) || !/^sha256:[a-f0-9]{64}$/i.test(identity.baseImageDigest)) return null;
  const files = ['bun.lock', 'apps/pwa/bun.lock', 'package.json', 'apps/pwa/package.json', 'docker/harness/Dockerfile'];
  const snapshot = cachedCutSnapshot(repo, commit);
  const inputs: Array<[string, string]> = [];
  for (const file of files) {
    const content = snapshot?.read(file);
    if (snapshot && content === undefined) return null;
    if (snapshot) inputs.push([file, content!]);
    else {
      const result = spawnSync('git', ['show', commit + ':' + file], { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      if (result.status !== 0 || result.error) return null;
      inputs.push([file, result.stdout]);
    }
  }
  const lockfileHash = createHash('sha256').update(inputs.filter(([file]) => file.endsWith('.lock')).map(([, value]) => value).join('\0')).digest('hex');
  const dependencyLayerHash = createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  return createHash('sha256').update(JSON.stringify({ envFingerprint: identity.envFingerprint, bunVersion: identity.bunVersion,
    platform: identity.platform, architecture: identity.architecture, baseImageDigest: identity.baseImageDigest, lockfileHash, dependencyLayerHash })).digest('hex');
}

export function gateReceiptReuseKey(receipt: GateShardReceipt | null, version: string, head40: string, fingerprint: string,
  expectedImageDigest: string | null | undefined, currentIdentity: import('./gate-radius-live.js').GatePodExecutionIdentity | null,
  graphPins: ({ graphSha: string; recipeSha: string } & { graphEntry?: string; recipeCommand?: string; recipeTimeoutMs?: number }) | null,
  testedProof?: { lockfileHash: string | null; testedFileHashes: Record<string, string> | null;
    sameHeadPreexistingFailureIds?: readonly string[] }): { envKey?: string; reason: string } {
  if (!receipt) return { reason: 'receipt-missing' };
  if (receipt.status !== 'complete') return { reason: 'receipt-unmeasured' };
  if (!Array.isArray(receipt.failureIds) || !Array.isArray(receipt.errorIds)) return { reason: 'receipt-failure-evidence-unmeasured' };
  if (!reusableGateShardFailures(receipt, head40, testedProof?.sameHeadPreexistingFailureIds)) return { reason: 'receipt-has-failures' };
  if (!currentIdentity) return { reason: 'current-environment-unmeasured' };
  if (!graphPins?.graphEntry || !graphPins.recipeCommand) return { reason: 'current-shard-recipe-unmeasured' };
  if (!receipt.version || !receipt.head40 || !receipt.graphSha || !receipt.recipeSha || !receipt.graphEntry || !receipt.recipeCommand || !Number.isSafeInteger(receipt.recipeTimeoutMs) || !receipt.imageDigest || !receipt.runtimeIdentity || !receipt.envFingerprint)
    return { reason: 'receipt-reuse-record-incomplete' };
  if (receipt.graphEntry !== graphPins.graphEntry) return { reason: 'graph-entry-mismatch' };
  if (receipt.recipeCommand !== graphPins.recipeCommand) return { reason: 'recipe-command-mismatch' };
  if (receipt.recipeTimeoutMs !== graphPins.recipeTimeoutMs) return { reason: 'recipe-timeout-mismatch' };
  const environmentFields = ['bunVersion', 'platform', 'architecture', 'baseImageDigest'] as const;
  const stored: Record<string, string> = { ...receipt.runtimeIdentity };
  const current: Record<string, string> = { ...currentIdentity };
  for (const field of environmentFields) {
    if (!stored[field] || !current[field]) return { reason: `environment-${field}-unmeasured` };
    if (stored[field] !== current[field]) return { reason: `environment-${field}-mismatch` };
  }
  const receiptRuntimeKey = gateShardRuntimeIdentityKey(receipt.runtimeIdentity, receipt.lockfileHash);
  const currentRuntimeKey = gateShardRuntimeIdentityKey(currentIdentity, testedProof?.lockfileHash ?? receipt.lockfileHash);
  if (receipt.envFingerprint !== receipt.runtimeIdentity.envFingerprint || !receiptRuntimeKey || receipt.envKey !== receiptRuntimeKey)
    return { reason: 'receipt-env-record-inconsistent' };
  if (!currentRuntimeKey || currentRuntimeKey !== receiptRuntimeKey) return { reason: 'runtime-identity-mismatch' };
  if (testedProof && (!testedProof.lockfileHash || !/^[a-f0-9]{64}$/i.test(testedProof.lockfileHash)
    || receipt.lockfileHash !== testedProof.lockfileHash)) return { reason: 'runtime-lockfile-mismatch-or-unmeasured' };
  if (testedProof && (!testedProof.testedFileHashes
    || !sameGateTestedFileHashes(receipt.testedFileHashes, testedProof.testedFileHashes)))
    return { reason: 'tested-file-content-mismatch-or-unmeasured' };
  const currentImageDigest = expectedImageDigest ?? currentIdentity.imageDigest;
  if (!currentImageDigest) return { reason: 'environment-imageDigest-current-pin-unmeasured' };
  if (!/^sha256:[a-f0-9]{64}$/i.test(currentImageDigest)) return { reason: 'environment-imageDigest-current-pin-unmeasured' };
  if (currentImageDigest !== currentIdentity.imageDigest) return { reason: 'environment-imageDigest-current-pin-mismatch' };
  return { envKey: receipt.envKey, reason: `runtime-match; image-compatible; baseline=${receipt.version}@${receipt.head40.slice(0, 12)}; current=${version}@${head40.slice(0, 12)}` };
}

/** A prior shard is reusable across commits only when no changed input reaches one of its tests. */
function gateReceiptChangedFileImpact(repo: string, from: string, to: string, tests: readonly string[]): { files: string[]; fullRerun?: string } {
  let changed: string[];
  try { changed = changedFilesBetween(repo, from, to); }
  catch (error) { return { files: [...tests], fullRerun: `changed-file-diff-unreadable:${String(error).slice(0, 120)}` }; }
  if (!changed.length) return { files: [] };
  const runtimeWide = (file: string) => {
    const base = file.split('/').at(-1) ?? file;
    return base === 'package.json' || base === 'bun.lock' || base === 'bun.lockb' || base === 'bunfig.toml'
      || /^tsconfig[^/]*\.json$/.test(base) || /^.+\.config\.[cm]?[jt]sx?$/.test(base)
      || file.startsWith('docker/') || file.startsWith('.github/')
      || /^(?:test|tests|scripts\/test)\/.+\/(?:setup|preload)[^/]*\.[^.]+$/.test(file)
      || /^(?:test|tests|scripts\/test)\/(?:setup|preload)[^/]*\.[^.]+$/.test(file);
  };
  if (changed.some(runtimeWide)) return { files: [...tests], fullRerun: 'changed-runtime-environment-input' };
  const testPath = /^(?:[\w.-]+\/)*[\w.-]+\.test\.ts$/;
  const changedTests = changed.filter((file) => testPath.test(file));
  const source = changed.filter((file) => !testPath.test(file) && file.endsWith('.ts'));
  const nonTs = changed.filter((file) => !file.endsWith('.ts'));
  // Non-runtime assets are dependencies only when tracked TypeScript names their exact path.
  let snapshot;
  try { snapshot = createCutSnapshot(repo, to); }
  catch (error) { return { files: [...tests], fullRerun: `changed-non-ts-reference-search-failed:${String(error).slice(0, 120)}` }; }
  for (const file of nonTs) {
    source.push(...snapshot.files.filter((path) => path.endsWith('.ts') && (snapshot.read(path) ?? '').includes(file)));
  }
  // Scripts can be consumed as runtime inputs assembled outside imports; rerun every shard until proven.
  if (source.some((file) => file.startsWith('scripts/'))) return { files: [...tests], fullRerun: 'changed-script-input' };
  const impacted = new Set(changedTests);
  if (source.length) {
    try {
      const tree = gitClosureTree(repo, to);
      if (source.some((file) => !tree.files.includes(file))) return { files: [...tests], fullRerun: 'changed-source-missing-at-current-head' };
      const closure = testsReachingChanged(tree, source, tests);
      if (!closure.ok) return { files: [...tests], fullRerun: `changed-source-closure-unreadable:${closure.reason.slice(0, 120)}` };
      for (const file of closure.tests) impacted.add(file);
    } catch (error) { return { files: [...tests], fullRerun: `changed-source-closure-error:${String(error).slice(0, 120)}` }; }
  }
  return { files: [...impacted].sort() };
}

export type GateAdmissionOutcome = 'granted' | 'admission-timeout' | 'admission-error' | 'off';
export interface GateAdmissionResult { outcome: GateAdmissionOutcome; waitedMs: number; reason?: string; release: () => void }
export const gateAdmissionWaitText = (reading: string | null) => `메모리 여유 대기(admission) · ${reading ?? '측정 전'}`.slice(0, 160);
/**
 * GATE-MULTI-HOST (0.2.25 · 대표) — the gate pool is a host roster (`release.loop.gatePodPool` =
 * `pool-node-a@node-a:N,pool-node-b@node-b:M,…`); shards spread over it by free share (selfCapped). A member that fails a
 * shard's launch or goes silent mid-Job is probed; if it is unreachable it leaves the roster for the rest of this gate and
 * the shard runs again on the others — one dead host no longer stops the gate. One-member pools keep the old behaviour.
 */
export const GATE_MEMBER_UNREADABLE_SECONDS_DEFAULT = 600;
export function defaultGateMemberProbe(member: PodPoolMember, tools: GateTools = {}): boolean {
  if (!checkPodPool([member], tools.kubectl ?? defaultKubectl).ok) return false;
  return !member.sshHost || (tools.remoteRun ?? defaultRemoteRun)(member.sshHost, 'true').status === 0;
}

export function poolGateAdmission(pool: PodPoolScheduler, gateRunId: string | null = null,
  priorityShadowObservation?: (gateWaiting: boolean) => GatePriorityShadowObservation): GateAdmission {
  const singleHost = pool.members.length === 1 ? (pool.members[0]!.sshHost ?? hostname()) : null;
  // The optional provider is a deterministic test seam only. Production never fabricates a competitor or image fact.
  return {
    acquire: (signal) => pool.acquireAdmission(signal, undefined, { gate: true }),
    waitReason: () => pool.waitReason(),
    // At admission time a multi-host pool has not selected a host yet. Existing measurements do not expose
    // competing run ids or image states, so keep those unknown rather than deriving them from Job names.
    priorityShadowObservation: priorityShadowObservation ?? ((gateWaiting) => ({ gateRunId, host: singleHost, competingRunId: null, competingHost: null,
      gateImageState: 'unknown', competingImageState: 'unknown', gateWaiting, lowerPriorityWaiting: null })),
  };
}
export async function admitGateShard(admission: GateAdmission | undefined, o: { waitMs: number; onWait: (reason: string) => void; reasonPollMs?: number; firstReasonMs?: number;
  onPriorityShadow?: (decision: GatePriorityShadowDecision) => void }): Promise<GateAdmissionResult> {
  const noop = () => {};
  if (!admission || !(o.waitMs > 0)) return { outcome: 'off', waitedMs: 0, release: noop };
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  let lastReason: string | undefined;
  let priorityShadowLogged = false;
  const tell = () => {
    lastReason = gateAdmissionWaitText(admission.waitReason());
    if (!priorityShadowLogged && admission.priorityShadowObservation) {
      priorityShadowLogged = true;
      const decision = gatePriorityShadowDecision(admission.priorityShadowObservation(true));
      if (o.onPriorityShadow) o.onPriorityShadow(decision);
      else debug.log('release-loop.gate', 'gate-priority-shadow-decision', decision);
    }
    o.onWait(lastReason);
  };
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

/**
 * The real `ssh` transport behind {@link GateRunner.command} on a remote host. A scenario replaces it through
 * {@link GateTools.ssh} so the gate flow can run without any remote call.
 */
export function defaultSshCommand(host: string, script: string, limitMs?: number): { rc: number; output: string; timedOut?: boolean } {
  // Start in /tmp, not the caller checkout. macOS resolves that symlink to /private/tmp before the child sees it;
  // the remote command still `cd`s to the quoted path, so either spelling is the same directory.
  const run = spawnSync('ssh', [host, script],
    { cwd: '/tmp', encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...(limitMs ? { timeout: limitMs + 60_000, killSignal: 'SIGKILL' as const } : {}) });
  const timedOut = !!limitMs && (run.status === 124 || run.status === 137 || (run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT');
  return { rc: run.status ?? 2, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}${run.error ? `\n${run.error}` : ''}`, ...(timedOut ? { timedOut } : {}) };
}

export function gateVolumeRefOutput(artifactOutput: string, fullLogsFetched: boolean, fullJobLogs: string, tailFallback = ''): string {
  if (fullLogsFetched && fullJobLogs) return fullJobLogs;
  if (artifactOutput) return artifactOutput;
  return fullLogsFetched ? fullJobLogs : tailFallback;
}

export function createGateRunner(repo: string, remote?: string, commandOverride?: GateRunner['command'], podCommand: (options: RunPodCommandOptions) => Promise<PodCommandResult> = runPodCommand, poolOverride?: PodPoolScheduler, podLogTail?: (job: PodCommandResult) => string, tools: GateTools = {}): GateRunner {
  const observedPrewarmCuts = new Set<string>();
  const gateCutLockfileHashes = new Map<string, string>();
  const gateVolumeSweepIdByCommit = new Map<string, string>();
  const volumeRefMeasurementRows: Array<{ sweepId: string; cutSha: string; phase: 'sweep' | 'recheck'; shard: string;
    attemptId: string; host: string | null; job: string | null; attemptedJobName?: string; launchState?: string } & ReturnType<typeof gateExternalVolumeMeasurements>> = [];
  const logExternalVolumeCutSummary = (commit: string, sweepId: string, phase: 'sweep' | 'recheck', completion: string,
    expected: readonly GateExternalVolumeRef[]): void => {
    const rows = volumeRefMeasurementRows.filter((row) => row.cutSha === commit && row.sweepId === sweepId);
    debug.log('release-loop.gate', 'external-volume-ref-cut-summary', {
      sweepId, cutSha: commit, phase, completion, expectedKinds: expected.map(({ kind }) => kind),
      attemptedPodCount: rows.filter((row) => row.job !== null).length,
      unresolvedLaunchCount: rows.filter((row) => row.job === null).length,
      volumeRefPodCount: rows.filter((row) => row.volumeRefPod).length, perShard: rows,
    });
  };
  let remoteMirror: string | undefined;
  // GATE-FLOW-SIM: the one place the real outside world is named — an injected seam replaces it, absent = today's tools.
  const clock = tools.now ?? Date.now;
  const kubectl = tools.kubectl ?? defaultKubectl;
  const ssh = tools.ssh ?? defaultSshCommand;
  const remoteRun = tools.remoteRun ?? defaultRemoteRun;
  const runPod = tools.podCommand ?? podCommand;
  const pinnedGateImageSync = (pod: NonNullable<GateOptions['pod']>, commit: string): RunPodCommandOptions['syncImages'] | undefined => {
    const hasDigest = Boolean(pod.pinnedImageDigest?.trim());
    const hasRunId = Boolean(pod.pinnedRunId?.trim());
    if (hasDigest !== hasRunId) throw new Error('gate pinned image: both pinnedImageDigest and pinnedRunId are required');
    if (!hasDigest) return undefined;
    return async (members, image, localCommit) => {
      if (localCommit !== commit) throw new Error('gate pinned image: requested source commit changed');
      const probe = preflightGateImageDigest;
      const poolSpecFor = (member: PodPoolMember) => `${member.context}${member.sshHost ? `@${member.sshHost}` : ''}:${member.capacity}#${member.registry ?? NODE_REGISTRY}`;
      const result = buildPinnedGateImageSync({ runId: pod.pinnedRunId!, commit, digest: pod.pinnedImageDigest!, image,
        members: members.map((member) => ({ context: member.context, registry: member.registry ?? NODE_REGISTRY })),
        probeTagDigest: (member) => {
          const candidate = members.find((row) => row.context === member.context && (row.registry ?? NODE_REGISTRY) === member.registry);
          return candidate ? probe(poolSpecFor(candidate), commit) : null;
        } });
      for (const drift of result.tagDrifts) debug.log('release-loop.gate', 'image-tag-drift', {
        ...drift, action: 'skip-push-use-pinned-digest',
      }, { level: 'warn' });
      return result.images;
    };
  };
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
      return ssh(remote, `PATH=$HOME/.bun/bin:/opt/homebrew/bin:$PATH; export PATH; cd ${quote(cwd)} && ${limitPrefix}${[cmd, ...args].map(quote).join(' ')}`, limitMs);
    }
    : localCommand);
  const rulesGateBaseFor = async (commit: string, files: readonly string[]): Promise<string | undefined> => {
    if (!files.includes('test/rules-contract.test.ts')) return undefined;
    // The gate mirror only receives pinned commit refs, so its Pod checkout has no origin/main.
    // Resolve the same merge-base in the source repository and pass the exact commit to the Pod.
    const resolved = await localCommand('git', ['merge-base', commit, 'origin/main'], repo);
    if (resolved.rc !== 0) throw new Error(`rules gate base unavailable for ${commit.slice(0, 12)}: ${tail40(resolved.output)}`);
    const base = resolved.output.trim();
    if (!/^[0-9a-f]{40}$/.test(base)) throw new Error(`rules gate base invalid for ${commit.slice(0, 12)}: ${base}`);
    return base;
  };
  const podSweep = async (tree: string, logDir: string | undefined, pod: NonNullable<GateOptions['pod']>, only?: readonly string[], onProgress?: (progress: GateSweepProgress) => void): Promise<CommandResult> => {
    const sweepId = randomUUID();
    let shardCount = pod.shards ?? 24;
    const isolationConcurrency = pod.isolationConcurrency ?? 4;
    // GATE-TIMEOUT-HEAL ①: the configured value is the floor; each shard's own deadline is shardDeadlineSeconds(planned).
    const deadlineSeconds = pod.shardTimeoutSeconds ?? POD_SHARD_TIMEOUT_FLOOR_SECONDS;
    if (!pod.pool || !Number.isSafeInteger(shardCount) || shardCount < 1
      || !Number.isSafeInteger(deadlineSeconds) || deadlineSeconds < 1
      || !Number.isSafeInteger(isolationConcurrency) || isolationConcurrency < 1) throw new Error('invalid pod sweep options');
    // Validate remote ledger wiring before inventory, planning, or any Pod work.
    // Parsing the configured roster is local and does not probe hosts.
    const remoteLedgerRequired = !!pod.shardsFile && (poolOverride?.members ?? parsePodPool(pod.pool)).some((member) => !!member.sshHost);
    if (remoteLedgerRequired && (!pod.shardsFile?.ledgerPath || !pod.shardsFile.envFingerprint)) {
      emitGatePhaseProgress('preflight-failed', { reason: 'HQ shard ledger is not configured' });
      throw new Error('remote gate refused: HQ shard ledger is not configured');
    }
    const hasPinnedDigest = Boolean(pod.pinnedImageDigest?.trim());
    const hasPinnedRunId = Boolean(pod.pinnedRunId?.trim());
    if (hasPinnedDigest !== hasPinnedRunId) throw new Error('gate pinned image: both pinnedImageDigest and pinnedRunId are required');
    const head = await command('git', ['rev-parse', 'HEAD'], tree);
    check(head, 'cut tree HEAD');
    const commit = head.output.trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('invalid cut tree HEAD');
    gateVolumeSweepIdByCommit.set(commit, sweepId);
    const cutLockSha256 = gateLockfileHash(tree);
    gateCutLockfileHashes.set(commit, cutLockSha256);
    const externalVolumeExpectations: GateExternalVolumeExpectations | undefined = pod.externalVolumeRefs?.length
      ? (() => {
        // Keep malformed/missing pins in the per-shard preflight path so the named attempt is ledgered.
        return { imageDigest: pod.pinnedImageDigest ?? '', lockSha256: cutLockSha256, sourceCommit: commit };
      })()
      : undefined;
    emitGatePhaseProgress('shard-planning', { total: shardCount, commit });
    const selectionStart = clock();
    const listed = await command('git', ['ls-files', '*.test.*'], tree);
    check(listed, 'git ls-files tests');
    const allFiles = listed.output.split(/\r?\n/).filter((file) => /\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file)).sort();
    const onlySet = only ? new Set(only) : undefined;
    // GATE-PARTIAL: every planned file must exist at this commit — a deleted/renamed failing file would otherwise «pass»
    // by not running. Fail closed (gate error), never a smaller sweep than planned.
    const missing = only?.filter((file) => !allFiles.includes(file)) ?? [];
    if (missing.length) throw new Error(`partial plan file missing at this commit: ${missing.slice(0, 5).join(', ')}`);
    let files = onlySet ? allFiles.filter((file) => onlySet.has(file)) : allFiles;
    // An empty, closure-proven radius means every prior formal shard is carried; load the receipt inventory for dispatch.
    const rulesBaseSha = await rulesGateBaseFor(commit, files);
    if (files.some((file) => file.startsWith('-') || file.startsWith('/') || file.startsWith('./')
      || file.split('/').some((part) => !part || part === '.' || part === '..') || /[\r\n]/.test(file))) throw new Error('unsafe pod test path');
    if (new Set(files).size !== files.length) throw new Error('duplicate pod test path');
    if (!files.length) throw new Error('sweep incomplete: no tests ran');
    const cdp = await command('rg', ['-l', '--glob', '*.test.ts', '-e', 'requireCdpBase', '-e', '9333', 'test', 'scripts'], tree);
    if (cdp.rc !== 0 && cdp.rc !== 1) throw new Error(`CDP pattern discovery failed (rc=${cdp.rc}): ${tail40(cdp.output)}`);
    const cdpPatterns = cdp.output.split(/\r?\n/).filter((path) => path.endsWith('.test.ts'));
    // CDP 시험은 `test:deterministic` 이 스스로 뺀다 — 조각에 그것만 남으면 bun «시험 없음» exit 1 을 «불완전»으로 읽었다(09-30 G1d 실측 둘).
    // bun 의 탐색은 숨은 디렉터리(`.x/`)를 안 연다 — 사람의 `bun test` 가 한 번도 안 돌리는 빈 픽스처가 조각에 혼자 남아 «Ran 0 tests» 를 «불완전»으로 읽었다(09-30 G1e 5번 조각).
    const allAssignable = allFiles.filter((file) => !cdpPatterns.includes(file) && !POD_SWEEP_INTEGRATION_ONLY.includes(file)
      && !file.split('/').some((part) => part.startsWith('.')));
    let assignable = files.filter((file) => !cdpPatterns.includes(file) && !POD_SWEEP_INTEGRATION_ONLY.includes(file)
      && !file.split('/').some((part) => part.startsWith('.')));
    const integrationOnly = files.filter((file) => POD_SWEEP_INTEGRATION_ONLY.includes(file));
    if (integrationOnly.length) debug.log('release-loop.gate', 'pod-sweep-integration-only', { files: integrationOnly });
    if (!assignable.length) throw new Error('sweep incomplete: no tests ran');
    const { durations, wall: planWall } = planDurations(pod.durationSource);
    const memory = readFileMemory(join(tree, POD_MEMORY_SOURCE));
    // The TD1 measurements predate the fixture-only gate; do not isolate those five files at their old 2–13 GB peaks.
    const fixtureOnly = new Set([...GATE_NIGHTLY_AUDITS, 'test/guardian/dispatch-surface-contract.test.ts', 'test/user-config-mcp.test.ts']);
    const heavy = new Set(assignable.filter((file) => !fixtureOnly.has(file) && (memory.get(file) ?? 0) >= POD_HEAVY_FILE_MB));
    // GATE-RISK-LANE — the failure history this sweep already keeps (`gateHistory().watchList`) puts its watched files in
    // the first shard; heavy files stay solo and spawn files keep their own lane, so the rest of the plan is unchanged.
    const watchList = pod.riskWatch ? readGateRiskWatchList(pod.riskWatch) : [];
    const riskPlan = planGateRiskLaneShards({ assignable, durations, shardCount, heavy, watchList });
    let shards = riskPlan.shards;
    const receiptRoot = pod.shardsFile?.receiptRoot;
    const priorReceiptRows = !pod.freshShards && receiptRoot && existsSync(receiptRoot) ? (() => {
      const ids = readdirSync(receiptRoot).flatMap((name) => {
        const match = /^pod-(\d+)\.receipt(?:\.[a-f0-9]{40})?\.json$/i.exec(name);
        return match ? [`pod-${Number(match[1])}`] : [];
      });
      const histories = [...new Set(ids)].flatMap((id) => readGateShardManifestHistory(receiptRoot, id));
      const byHead = new Map<string, GateShardReceipt[]>();
      for (const receipt of histories) {
        const rows = byHead.get(receipt.head40) ?? [];
        rows.push(receipt);
        byHead.set(receipt.head40, rows);
      }
      const completeSets = [...byHead.values()].map((rows) => rows.sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4))))
        .filter((rows) => rows.length > 0 && rows.every((row, index) => row.id === `pod-${index}` && row.status === 'complete'))
        .sort((a, b) => Math.min(...b.map((row) => Date.parse(row.measuredAt))) - Math.min(...a.map((row) => Date.parse(row.measuredAt))));
      return completeSets[0] ?? [];
    })() : [];
    const receiptHeads = [...new Set(priorReceiptRows.map((receipt) => receipt.head40))];
    const changedReceiptFiles = new Set<string>();
    let changedReceiptFullRerun: string | null = null;
    for (const priorHead of receiptHeads) if (priorHead !== commit) {
      const impact = gateReceiptChangedFileImpact(repo, priorHead, commit, allAssignable);
      if (impact.fullRerun) changedReceiptFullRerun = impact.fullRerun;
      for (const file of impact.files) changedReceiptFiles.add(file);
    }
    const radiusSelection = only ?? (changedReceiptFullRerun ? allAssignable : [...changedReceiptFiles]);
    const radiusPriorCommit = only ? pod.shardsFile?.radiusPriorCommit ?? '' : receiptHeads.length === 1 ? receiptHeads[0]! : commit;
    const radiusReceiptPlan = priorReceiptRows.length ? planGateReceiptRadius({ receipts: priorReceiptRows, tests: allAssignable,
      selectedFiles: radiusSelection, priorCommit: radiusPriorCommit }) : null;
    const radiusUnchangedShardIds = radiusReceiptPlan?.unchangedShardIds ?? [];
    const radiusInvalidatedShardIds = radiusReceiptPlan?.invalidatedShardIds ?? [];
    if (radiusReceiptPlan) { assignable = allAssignable; shards = radiusReceiptPlan.shards.map((shard) => ({ ...shard, plannedSeconds: shard.files.reduce((total, file) => total + (durations.get(file) ?? 0), 0) })); shardCount = shards.length; }
    else if (priorReceiptRows.length) {
      // Keep the measured partition stable across commits when the complete test inventory is unchanged. Replanning from
      // current durations can move tests between shard IDs and makes a valid per-shard impact proof unusable.
      const ordered = [...priorReceiptRows].sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));
      const measuredFiles = ordered.flatMap((receipt) => receipt.files);
      const inventory = new Set(allAssignable);
      const stableLayout = ordered.every((receipt, index) => receipt.id === `pod-${index}` && receipt.status === 'complete'
        && receipt.files.length > 0 && receipt.files.every((file) => inventory.has(file)))
        && measuredFiles.length === allAssignable.length && new Set(measuredFiles).size === measuredFiles.length
        && measuredFiles.every((file) => inventory.has(file));
      if (stableLayout) {
        assignable = allAssignable;
        shards = ordered.map((receipt) => ({ id: receipt.id, files: [...receipt.files],
          plannedSeconds: receipt.files.reduce((total, file) => total + (durations.get(file) ?? 0), 0) }));
        shardCount = shards.length;
      }
    }
    const base40 = pod.shardsFile?.base40;
    const envFingerprint = pod.shardsFile?.envFingerprint;
    const expectedImageDigest = pod.shardsFile?.expectedImageDigest;
  const injectedGraphRecipePins = tools.graphRecipePins?.(repo, commit) ?? null;
  const sourceGraphPins = pod.shardsFile?.graphPins ?? injectedGraphRecipePins ?? gateSourcePins(repo, commit);
  const shardRecipeIdentity = pod.shardsFile?.graphPins?.graphEntry && pod.shardsFile.graphPins.recipeCommand
    ? { graphEntry: pod.shardsFile.graphPins.graphEntry, recipeCommand: pod.shardsFile.graphPins.recipeCommand, recipeTimeoutMs: pod.shardsFile.graphPins.recipeTimeoutMs }
    : injectedGraphRecipePins ?? gateShardRecipeIdentityAtCommit(repo, commit);
  const currentGraphPins = sourceGraphPins && shardRecipeIdentity ? { ...sourceGraphPins, ...shardRecipeIdentity } : null;
  const currentExecutionIdentity = pod.shardsFile?.executionIdentity ?? preflightGateExecutionIdentity(pod.pool, process.env, commit);
  pod = { ...pod, executionIdentity: currentExecutionIdentity };
  const currentRuntimeSourceFingerprint = currentExecutionIdentity
    ? gateRuntimeSourceFingerprint(repo, commit, currentExecutionIdentity) : null;
    const currentLockfileHash = gateLockfileHashAtCommit(repo, commit);
    const currentTestedFileHashesByShard = gateReceiptHashesByShard(repo, commit, shards, cachedCutSnapshot(repo, commit)).hashesByShard;
    if (riskPlan.spawnFiles.length) debug.log('release-loop.gate', 'pod-spawn-lane', { files: riskPlan.spawnFiles, shards: riskPlan.spawnShardCount });
    if (riskPlan.riskFiles.length) debug.log('release-loop.gate', 'pod-risk-lane-plan', { files: riskPlan.riskFiles, shard: 0,
      plannedSeconds: riskPlan.riskPlannedSeconds, shards: shards.length, watch: watchList.length });
    logPlanWalltime(planWall, shards);
    if (heavy.size) debug.log('release-loop.gate', 'pod-heavy-alone', { files: [...heavy], thresholdMb: POD_HEAVY_FILE_MB, memoryLimit: POD_ISOLATION_MEMORY_LIMIT });
    const known = assignable.filter((file) => durations.has(file)).length;
    debug.log('release-loop.gate', 'pod-shard-plan', {
      shards: shards.length, known, unknown: assignable.length - known,
      maxPlannedSeconds: Math.max(...shards.map((shard) => shard.plannedSeconds)),
      source: durations.size ? pod.durationSource : 'none',
    });
    reportSelectionTimed(clock() - selectionStart, assignable.length, pod.onSelectionTimed);
    // GATE-SPEED A3①: shard Pod CPU (`release.loop.gatePodCpu` · default request 1 / limit 4) — shards × request must fit the pool.
    const cpu = resolvePodCpu(pod.cpu);
    // Only evidence-backed opt-in files reach this batch; every other file retains its own Pod below.
    const batchWidth = Math.max(1, Math.min(4, Math.floor(podCpuMillis(cpu.limit)! / 1000)));
    debug.log('release-loop.gate', 'shard-resources', { shards: shards.length, cpuRequest: cpu.request, cpuLimit: cpu.limit, cpuSource: pod.cpu ? 'config' : 'default' });
    debug.log('release-loop.gate', 'isolation-batch-width', { batchWidth, cpuLimit: cpu.limit });
    const ready = poolOverride ? undefined : checkPodPool(parsePodPool(pod.pool), kubectl);
    if (ready && !ready.ok) throw new Error('pod command: 풀의 노드가 하나도 준비되지 않았다');
    const poolScheduler = poolOverride ?? new PodPoolScheduler(ready!.ready);
    // Remote gate evidence is part of the cut contract: a remote-only cut sweep cannot pass
    // if its HQ ledger is unavailable or was not configured. Only the cut sweep carries shardsFile;
    // baseline and attribution-recheck sweeps are not cut evidence and never write the HQ shard ledger.
    emitGatePhaseProgress('shards-running', { planned: shards.length });
    type GateShardExecution = NonNullable<ReturnType<typeof parseGatePodRuntimeIdentity>>;
    type GateShardDetail = Partial<GateShardLedgerRow> & { runtimeIdentity?: GateShardExecution };
    const detailsById = new Map<string, GateShardDetail>();
    const executionsByShard = new Map<string, Array<{ branch: string; attemptId: string; imageDigest: string | null;
      runtimeIdentity: GateShardExecution | null; host: string | null }>>();
    const receiptChecks = shards.map((item, shard) => {
      // Volume content identity is currently proven inside each Pod rather than part of a durable receipt key.
      // Until that exact marker digest is carried by the receipt, never reuse a prior shard without rerunning preflight.
      if (pod.externalVolumeRefs?.length) return { reason: 'external-volume-ref-identity-not-bound-to-receipt', priorHead: null };
      if (pod.freshShards) return { reason: 'fresh-shards', priorHead: null };
      if (!receiptRoot || !base40 || !envFingerprint) return { reason: 'receipt-context-missing', priorHead: null };
      const prior = priorReceiptRows.find((receipt) => receipt.id === `pod-${shard}`) ?? readGateShardManifest(receiptRoot, `pod-${shard}`);
      const sameHead = prior?.head40 === commit;
      const shardImpact = prior && !sameHead
        ? gateReceiptChangedFileImpact(repo, prior.head40, commit, allAssignable) : null;
      const changedFileImpact = shardImpact?.fullRerun ?? (shardImpact?.files.some((file) => item.files.includes(file))
        ? 'changed-file-reaches-shard-test' : null);
      if (changedFileImpact) {
        if (!radiusInvalidatedShardIds.includes(`pod-${shard}`)) radiusInvalidatedShardIds.push(`pod-${shard}`);
        return { reason: changedFileImpact, priorHead: prior?.head40 ?? null };
      }
      if (prior && !sameHead && !radiusUnchangedShardIds.includes(`pod-${shard}`)) radiusUnchangedShardIds.push(`pod-${shard}`);
      const priorRuntime = sameHead ? null : prior?.runtimeSourceFingerprint
        ?? (prior && gateRuntimeSourceFingerprint(repo, prior.head40, prior.runtimeIdentity));
      const currentRuntime = sameHead ? null : currentRuntimeSourceFingerprint;
      const testedProof = { lockfileHash: currentLockfileHash, testedFileHashes: currentTestedFileHashesByShard[`pod-${shard}`] ?? null,
        sameHeadPreexistingFailureIds: pod.shardsFile?.sameHeadPreexistingFailureIds };
      const key = prior?.base40 !== base40 ? { reason: 'base40-mismatch' }
        : !sameHead && (!priorRuntime || !currentRuntime) ? { reason: 'runtime-fingerprint-unmeasured' }
          : !sameHead && priorRuntime !== currentRuntime ? { reason: 'runtime-fingerprint-mismatch' }
            : gateReceiptReuseKey(prior, pod.shardsFile!.version, commit, envFingerprint, expectedImageDigest, currentExecutionIdentity, currentGraphPins, testedProof);
      if (!key.envKey) {
        return { reason: key.reason, priorHead: prior?.head40 ?? null };
      }
      const result = readGateShardResult(receiptRoot, { shard: { id: `pod-${shard}`, files: item.files },
        head40: prior!.head40, base40, envKey: key.envKey, receipt: prior! });
      const decision = result ? 'reuse' as const : 'rerun' as const;
      const reason = result ? key.reason : 'receipt-payload-or-shard-radius-mismatch';

      return result ? { reason, result, priorHead: prior!.head40 } : { reason, priorHead: prior?.head40 ?? null };
    });
    for (const [shard, check] of receiptChecks.entries()) debug.log('gate.receipt', 'receipt-check', {
      shardId: `pod-${shard}`, decision: check.result ? 'reuse-candidate' : 'remeasure',
      reason: check.reason ?? 'receipt-identity-valid', priorHead: check.priorHead, targetHead: commit,
      priorRuntimeSourceFingerprint: check.result?.receipt.runtimeSourceFingerprint ?? null,
      currentRuntimeSourceFingerprint,
    });
    const receipts = [...receiptChecks.flatMap((check) => check.result ? [check.result.receipt] : []),
      ...priorReceiptRows.filter((receipt) => receipt.failureIds.length > 0 || receipt.errorIds.length > 0)];
    const requiredOs = pod.shardCapabilities ?? {};
    const envKnownIds = loadEnvKnownFailures(tree);
    const envKnownFiles = new Set([...envKnownIds].map(fileOf));
    const macPassShardIds = shards.flatMap((shard, index) => {
      const prior = [...priorReceiptRows].reverse().find((receipt) => receipt.id === `pod-${index}`);
      if (!prior) return [];
      const knownFailure = [...prior.failureIds, ...prior.errorIds].some((id) => envKnownIds.has(id));
      const knownUnmeasuredFile = prior.status === 'unmeasured' && shard.files.some((file) => envKnownFiles.has(file));
      return knownFailure || knownUnmeasuredFile ? [`pod-${index}`] : [];
    });
    for (const id of Object.keys(requiredOs)) if (!/^pod-\d+$/.test(id) || Number(id.slice(4)) >= shards.length)
      throw new Error(`unknown shard capability target: ${id}`);
    const needsPlatform = Object.values(requiredOs).some((value) => value.os)
      || (pod.rerouteShard === 'auto' && macPassShardIds.length > 0);
    const hosts = poolScheduler.members.map((member) => {
      let platform: 'darwin' | 'linux' | 'other' = 'other';
      if (needsPlatform) {
        const system = member.sshHost ? remoteRun(member.sshHost, 'uname -s') :
          { status: 0, stdout: process.platform, stderr: '' };
        if (system.status === 0) platform = /^(?:darwin)$/i.test(system.stdout.trim()) ? 'darwin'
          : /^(?:linux)$/i.test(system.stdout.trim()) ? 'linux' : 'other';
      }
      return { id: member.context, platform, available: true, reserved: false };
    });
    const hostPlan = planGateShardDispatch({ head40: commit, base40: base40 ?? commit,
      shards: shards.map((item, shard) => ({ id: `pod-${shard}`, files: item.files,
        ...(requiredOs[`pod-${shard}`]?.os ? { requiredOs: requiredOs[`pod-${shard}`]!.os } : {}) })), receipts,
      hosts,
      graphEntry: currentGraphPins?.graphEntry, recipeCommand: currentGraphPins?.recipeCommand, recipeTimeoutMs: currentGraphPins?.recipeTimeoutMs, environmentIdentity: currentExecutionIdentity ?? undefined,
      lockfileHash: currentLockfileHash ?? undefined,
      testedFileHashesByShard: Object.fromEntries(Object.entries(currentTestedFileHashesByShard).flatMap(([id, hashes]) => hashes ? [[id, hashes]] : [])),
      sameHeadPreexistingFailureIds: pod.shardsFile?.sameHeadPreexistingFailureIds,
      radiusUnchangedShardIds, invalidatedShardIds: radiusInvalidatedShardIds,
      macPassShardIds,
      ...(pod.rerouteShard ? { rerouteShard: pod.rerouteShard } : {}), ...(pod.shardHost ? { shardHost: pod.shardHost } : {}) });
    const receiptDisposition = {
      reused: hostPlan.filter((action) => action.kind === 'reuse').length,
      rerun: hostPlan.filter((action) => action.kind === 'run').length,
      unmeasured: hostPlan.filter((action) => action.kind === 'unmeasured').length,
    };
    for (const action of hostPlan) {
      const decision = action.kind === 'reuse' ? 'reuse' as const : 'rerun' as const;
      const reason = action.reason;
      const prior = receiptChecks[Number(action.shardId.slice(4))]?.result?.receipt
        ?? readGateShardManifest(receiptRoot ?? '', action.shardId);
      detailsById.set(action.shardId, { reuseDecision: decision, reuseReason: reason });
      const receiptCheck = receiptChecks[Number(action.shardId.slice(4))];
      debug.log('gate.receipt', 'reuse-decision', { shardId: action.shardId, decision, reason,
        receiptCheckReason: receiptCheck?.reason ?? null, receiptCheckHead: receiptCheck?.priorHead ?? null,
        targetHead: commit, host: action.kind === 'run' ? action.host : prior?.host ?? null,
        replacingHead: action.kind === 'run' ? action.replacing?.head40 ?? null : null });
      if (pod.shardsFile?.ledgerPath && envFingerprint) {
        try {
          const error = appendGateShardLedgerForGate(pod.shardsFile.ledgerPath, {
          v: 1, invocationId: sweepId, version: pod.shardsFile!.version, phase: 'cut', shardId: action.shardId, files: [...action.files],
          host: action.kind === 'run' ? action.host : prior?.host ?? null, executor: 'pod',
          imageDigest: prior?.imageDigest ?? null, measuredImageDigest: prior?.imageDigest ?? null,
          currentImageDigest: expectedImageDigest ?? currentExecutionIdentity?.imageDigest ?? null,
          commit, envFingerprint, startedAt: null, endedAt: null,
          observedAt: new Date().toISOString(), state: action.kind === 'reuse' ? 'done' : 'pending',
          rc: null, pass: null, fail: null, errors: null, ran: null, failureIds: prior?.failureIds ?? null,
          errorIds: prior?.errorIds ?? null, attribution: action.kind === 'reuse' ? 'complete' : 'unmeasured',
          logPath: null, junitPath: null, stopReason: null, attemptId: null, reuseDecision: decision, reuseReason: reason,
          }, remoteLedgerRequired);
          if (error) throw new Error(error);
        } catch (error) {
          debug.log('gate.receipt', 'reuse-ledger-write-failed', { shardId: action.shardId, error: String(error), failClosed: remoteLedgerRequired },
            { level: remoteLedgerRequired ? 'error' : 'warn' });
          if (remoteLedgerRequired) throw new Error(`remote gate refused: HQ shard ledger write failed (${action.shardId}): ${String(error)}`);
        }
      }
    }
    // Leave ordinary shards to the live free-slot scheduler. A static plan can pick a busy member
    // while another is idle; pin only a capability or a deliberate cross-host replacement.
    const hostPins = new Map(hostPlan.flatMap((item) => item.kind === 'run'
      && (requiredOs[item.shardId]?.os || (pod.rerouteShard === 'auto' && macPassShardIds.includes(item.shardId))
        || (item.replacing && item.host !== item.replacing.host)
        || (pod.shardHost && item.host === pod.shardHost)) ? [[item.shardId, item.host] as const] : []));
    const unavailable = hostPlan.find((item) => item.kind === 'unmeasured');
    if (unavailable) throw new Error(`gate shard ${unavailable.shardId} unmeasured: ${unavailable.reason}`);
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
    const rootSlots = Math.max(1, poolScheduler.members.reduce((total, member) => total + member.capacity, 0));
    const admissionWaitSeconds = pod.admissionWaitSeconds ?? gateAdmissionWaitSeconds(shards.length, rootSlots);
    if (!Number.isSafeInteger(admissionWaitSeconds) || admissionWaitSeconds < 0) throw new Error('invalid pod sweep options');
    // An injected pool (tests) runs without admission unless `pod.admission` is passed; the gate's own pool asks it.
    const gateAdmission = pod.admission ?? tools.admission ?? (poolOverride ? undefined : poolGateAdmission(poolScheduler, tools.graphRunId ?? null));
    debug.log('release-loop.gate', 'pod-admission', { waitSeconds: admissionWaitSeconds, source: pod.admissionWaitSeconds !== undefined ? 'config' : 'default', enabled: !!gateAdmission && admissionWaitSeconds > 0,
      rootSlots, shards: shards.length });
    // GATE-POD-STALL-FAILFAST: a shard with no test output within the stall window is stopped and recorded unmeasured.
    const stallSeconds = pod.stallSeconds ?? GATE_POD_STALL_SECONDS_DEFAULT;
    const stallPollMs = pod.stallPollMs ?? GATE_POD_STALL_POLL_MS;
    if (!Number.isFinite(stallSeconds) || stallSeconds < 0 || !Number.isFinite(stallPollMs) || stallPollMs <= 0) throw new Error('invalid pod sweep options');
    // An injected pool (tests) runs without the watch unless `pod.liveLog` is passed — never a real kubectl from a test.
    const liveLog = pod.liveLog ?? (poolOverride ? undefined : (job: { name: string; context?: string }) => {
      if (!job.context) return null;
      const logs = kubectl(['--context', job.context, '-n', 'elanous-test', 'logs', `job/${job.name}`, '-c', 'child', '--tail=400']);
      return logs.status === 0 ? logs.stdout : null;
    });
    const stopJob = pod.stopJob ?? ((job: { name: string; context?: string }) => {
      // Not `delete job`: runPodCommand would poll a missing Job forever. A 1 s deadline makes the Job fail now and
      // runPodCommand returns through its normal path (logs · exit code · Secret cleanup).
      if (!job.context) return false;
      const patched = kubectl(['--context', job.context, '-n', 'elanous-test', 'patch', 'job', job.name, '--type=merge', '-p', JSON.stringify({ spec: { activeDeadlineSeconds: 1 } })]);
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
      const ran = kubectl(['--context', job.context, '-n', 'elanous-test', 'exec', `job/${job.name}`, '-c', 'child', '--', 'bash', '-c', gateShardAbortScript(reason)]);
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
    const probeMember = pod.probeMember ?? (poolOverride ? undefined : (member: PodPoolMember) => defaultGateMemberProbe(member, { kubectl, remoteRun }));
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
        const logs = kubectl(['--context', member.context, '-n', 'elanous-test', 'logs', `job/${job.job}`, '-c', 'child', '--tail=200']);
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
      const status = (pod.failureKubectl ?? kubectl)([...prefix, 'get', 'pods', '-l', `job-name=${job.name}`, '-o', 'json']);
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
      const logs = podName ? (pod.failureKubectl ?? kubectl)([...prefix, 'logs', `pod/${podName}`, '-c', 'child', '--tail=100']) : undefined;
      if (!logs) errors.push('로그: 종료된 Pod 이름 없음');
      else if (logs.status !== 0) errors.push(`로그: ${logs.stderr.trim() || `kubectl rc=${logs.status}`}`);
      return { ...(podName ? { podName } : {}), ...(termination ? { termination } : {}), ...(logs?.status === 0 ? { logTail: logs.stdout } : {}),
        ...(errors.length ? { error: `수거 실패 · ${errors.join(' · ')}` } : {}) };
    });
    type ShardRun = { output: string; rc: number; pass: number; fail: number; errors: number; ran: number; files: number; passedIds: string[]; loadFlaky?: string[]; loadFlakyAttemptedFiles?: string[] };
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
    const hqResumeRows = pod.shardsFile?.ledgerPath && pod.shardsFile.envFingerprint && expectedImageDigest
      && !pod.freshShards && !pod.externalVolumeRefs?.length && !pod.knownFailures?.length
      && hostPlan.every((action) => action.kind === 'run')
      ? reusableGateShardLedgerBatch({ path: pod.shardsFile.ledgerPath, version: pod.shardsFile.version, commit,
        envFingerprint: pod.shardsFile.envFingerprint, imageDigest: expectedImageDigest,
        shards: shards.map((item, index) => ({ shardId: `pod-${index}`, files: item.files })) })
      : undefined;
    const knownTimes = assignable.map((file) => durations.get(file)).filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    const unknownSeconds = knownTimes.length ? (knownTimes[Math.floor((knownTimes.length - 1) / 2)]! + knownTimes[Math.floor(knownTimes.length / 2)]!) / 2 : 1;
    // GATE-LIVE-OBS — root rows stay stable; each recursive split/retry and tail gets its own row.
    // Otherwise a finished root Job can hide a still-running child (or tail) behind 80/80 done.
    const board: GateShard[] = shards.map((item, index) => ({ id: `pod-${index}`, state: 'pending', plannedMin: Math.round(item.plannedSeconds / 6) / 10 }));
    let collectionStarted = false;
    const reportProgress = () => onProgress?.({ executor: 'pod', groups: board.map((row) => {
      const detail = detailsById.get(row.id);
      const measuredFailureCount = typeof detail?.fail === 'number' && typeof detail.errors === 'number'
        ? detail.fail + detail.errors : row.state === 'done' && row.rc === 0 ? 0 : null;
      return { id: row.id, state: row.state === 'retry' ? 'running' : row.state,
        rawState: row.state, ...(row.attemptId ? { attemptId: row.attemptId } : {}),
        failureCount: measuredFailureCount,
        ...(row.host ? { host: row.host } : {}),
        ...(row.startedAt ? { startedAtMs: Date.parse(row.startedAt) } : {}),
        ...(row.endedAt ? { endedAtMs: Date.parse(row.endedAt) } : {}),
      };
    }) });
    reportProgress();
    const filesById = new Map(shards.map((item, index) => [`pod-${index}`, [...item.files]]));
    const observeShard = (row: GateShard) => {
      if (!pod.shardsFile?.ledgerPath || !pod.shardsFile.envFingerprint) {
        if (remoteLedgerRequired) throw new Error('remote gate refused: HQ shard ledger identity is unavailable');
        return;
      }
      const detail = detailsById.get(row.id) ?? {};
      const logName = row.resultFile?.replace(/\.json$/, '') ?? null;
      const logPath = logName && logDir ? join(logDir, `${logName}.log`) : null;
      const junitPath = logName && logDir ? join(logDir, `${logName}.junit.xml`) : null;
      try {
        const error = appendGateShardLedgerForGate(pod.shardsFile.ledgerPath, {
          v: 1, invocationId: sweepId, version: pod.shardsFile.version, phase: 'cut', shardId: row.id,
          files: filesById.get(row.id) ?? [], host: row.host ?? null, executor: 'pod',
          imageDigest: detail.imageDigest ?? null, measuredImageDigest: detail.imageDigest ?? null,
          currentImageDigest: expectedImageDigest ?? currentExecutionIdentity?.imageDigest ?? null,
          commit, envFingerprint: pod.shardsFile.envFingerprint,
          startedAt: row.startedAt ?? null, endedAt: row.endedAt ?? null, observedAt: new Date().toISOString(),
          state: row.state, rc: row.rc ?? null, pass: detail.pass ?? null, fail: detail.fail ?? null,
          errors: detail.errors ?? null, ran: detail.ran ?? null,
          failureIds: detail.failureIds ?? null, errorIds: detail.errorIds ?? null,
          attribution: detail.attribution ?? 'unmeasured', reuseDecision: detail.reuseDecision, reuseReason: detail.reuseReason, logPath, junitPath,
          stopReason: detail.stopReason ?? row.waitReason ?? null, attemptId: row.attemptId ?? null, retryGroupId: detail.retryGroupId,
        }, remoteLedgerRequired);
        if (error) throw new Error(error);
      } catch (error) {
        debug.log('release-loop.gate', 'shard-ledger-write-failed', { shard: row.id, error: String(error), failClosed: remoteLedgerRequired }, { level: remoteLedgerRequired ? 'error' : 'warn' });
        if (remoteLedgerRequired) throw new Error(`remote gate refused: HQ shard ledger write failed (${row.id}): ${String(error)}`);
      }
    };
    const flushBoard = () => {
      if (!pod.shardsFile) return;
      try { writeGateShards(pod.shardsFile.path, { v: 1, version: pod.shardsFile.version, updatedAt: new Date().toISOString(), shards: board }); }
      catch (error) { debug.log('release-loop.gate', 'shards-write-failed', { path: pod.shardsFile.path, error: String(error) }); }
    };
    const rowIndex = (shard: number, branch = '') => branch ? board.findIndex((row) => row.id === `pod-${shard}${branch}`) : shard;
    const markShard = (shard: number, patch: Partial<GateShard>, clear: Array<keyof GateShard> = [], branch = '') => {
      const index = rowIndex(shard, branch);
      const row = board[index];
      if (!row) return;
      const next: GateShard = { ...row, ...patch };
      for (const key of clear) delete next[key];
      if (JSON.stringify(next) === JSON.stringify(row)) return;
      board[index] = next;
      reportProgress();
      if (!collectionStarted && (next.state === 'done' || next.state === 'failed' || next.state === 'timeout')) {
        collectionStarted = true;
        emitGatePhaseProgress('collection', { state: 'collecting', shardCount: shards.length,
          completedShardCount: board.filter((shard) => shard.state === 'done' || shard.state === 'failed' || shard.state === 'timeout').length,
          failureCount: null });
      }
      observeShard(next);
      flushBoard();
    };
    const resetShardAttempt = (shard: number, branch = '', plannedMin?: number) => {
      if (branch && rowIndex(shard, branch) < 0) board.push({ id: `pod-${shard}${branch}`, state: 'pending', ...(plannedMin !== undefined ? { plannedMin } : {}) });
      const index = rowIndex(shard, branch);
      const row = board[index];
      if (!row) return;
      board[index] = beginGateShardAttempt(row);
      delete board[index]!.rc;
      delete board[index]!.installSec;
      // The root is a logical aggregate while its descendants run, not the terminal state of its first Job.
      if (branch) {
        board[shard] = beginGateShardAttempt(board[shard]!);
        delete board[shard]!.rc;
        delete board[shard]!.installSec;
        observeShard(board[shard]!);
      }
      detailsById.delete(row.id);
      observeShard(board[index]!);
      flushBoard();
    };
    const recordShardResult = (id: string, done: { runs: ShardRun[]; stalled: NonNullable<GateResult['stalledShards']> }) => {
      const index = board.findIndex((row) => row.id === id);
      if (index < 0) return;
      const counts = done.runs.reduce((sum, run) => ({ pass: sum.pass + run.pass, fail: sum.fail + run.fail,
        errors: sum.errors + run.errors, ran: sum.ran + run.ran }), { pass: 0, fail: 0, errors: 0, ran: 0 });
      const failureIds: string[] = [];
      const errorIds: string[] = [];
      let attributed = done.stalled.length === 0 && done.runs.length > 0;
      for (const run of done.runs) {
        try {
          const parsed = failuresOf({ rc: run.rc, output: run.output, validatedShards: true }, `ledger ${id}`);
          failureIds.push(...parsed.failures); errorIds.push(...parsed.errors);
        } catch { attributed = false; }
      }
      const detail: GateShardDetail = { ...(detailsById.get(id) ?? {}), ...counts, failureIds: attributed ? [...new Set(failureIds)].sort() : null,
        errorIds: attributed ? [...new Set(errorIds)].sort() : null, attribution: attributed ? 'complete' : 'unmeasured',
        stopReason: done.stalled.map((item) => item.reason).join(', ') || null };
      detailsById.set(id, detail);
      reportProgress();
      observeShard(board[index]!);
    };
    for (const row of board) observeShard(row);
    flushBoard();
    // A result collector can lose its callback after the Kubernetes Job has already completed. Reconcile
    // the public shard board independently so a finished Job cannot remain «running» indefinitely.
    const shardsFile = pod.shardsFile;
    let reconcileTimer: ReturnType<typeof setInterval> | undefined;
    const reconcileTick = () => {
      if (!shardsFile) return;
      try {
        const reconciled = reconcileStaleGateShardBoard({ version: shardsFile.version, board, ...(logDir ? { logDir } : {}), kubectl });
        for (const item of reconciled.finalized) {
          const index = board.findIndex((shard) => shard.id === item.shard);
          if (index < 0) continue;
          board[index] = reconciled.board.find((shard) => shard.id === item.shard)!;
          observeShard(board[index]!);
          debug.log('release.gate', 'shard-stale-finalized', item);
        }
        flushBoard();
      } catch (error) {
        debug.log('release.gate', 'shard-watchdog-tick-failed', { error: String(error) }, { level: 'warn' });
      }
    };
    /** The gate's scheduler, seen through one shard: a slot wait and the Pod start become row states. */
    // GATE-MEM-ADMIT: `placed` releases the shard's admission once a member is chosen — from then on the Job is
    // Pending/Running in the cluster and the next admission reading counts it, so holding the lease would count it twice.
    const trackedPool = (shard: number, branch: string, jobName: string, resultFile: string, attemptId: string, placed: (member: NonNullable<Awaited<ReturnType<PodPoolScheduler['tryAcquire']>>>) => void = () => {}, skipMembers: ReadonlySet<string> = new Set(), allowPin = false): PodPoolScheduler => ({
      members: poolScheduler.members,
      tryAcquire: async (...[skip, onEmpty, mode]: Parameters<PodPoolScheduler['tryAcquire']>) => {
        // GATE-MULTI-HOST: a lost member is skipped while another member is left (all lost = the old behaviour).
        const anyLeft = poolScheduler.members.some((m) => !downMembers.has(m.context));
        // Only the first placement follows the plan; retries and unavailable hosts can move.
        const planned = allowPin && !skip?.size ? hostPins.get(`pod-${shard}`) : undefined;
        const pin = planned && !downMembers.has(planned) ? planned : undefined;
        const excluded = new Set([...(skip ?? []), ...skipMembers, ...(downMembers.size && anyLeft ? downMembers : []),
          ...(pin ? poolScheduler.members.filter((m) => m.context !== pin).map((m) => m.context) : [])]);
        const member = await poolScheduler.tryAcquire(excluded.size ? excluded : undefined, onEmpty, mode);
        if (member) placed(member);
        if (member) markShard(shard, { state: 'running', startedAt: board[rowIndex(shard, branch)]?.startedAt ?? new Date().toISOString(), host: member.context, job: jobName, resultFile, attemptId }, ['waitReason'], branch);
        else markShard(shard, { waitReason: 'Pod 자리 대기' }, [], branch);
        return member;
      },
      release: (member: Parameters<PodPoolScheduler['release']>[0]) => poolScheduler.release(member),
    }) as unknown as PodPoolScheduler;
    const runShardImpl = async (paths: string[], shard: number, depth = 0, branch = '', retriedNoOutput = false, fresh = pod.freshShards === true, parentAttempt?: string, hostRetries = 0, batchIsolation = false, skipMembers: ReadonlySet<string> = new Set(), singleShotTail = false): Promise<{ runs: ShardRun[]; stalled: NonNullable<GateResult['stalledShards']> }> => {
      // 파일별 소요는 junit 으로 남긴다 — 콘솔 요약(판정 원천)은 그대로이고, 느린 시험 목록(K10 D4)·계층 분리(D2)의 자가 된다.
      // GATE-TIMEOUT-HEAL: parts (each with its own junit) under a soft deadline inside this shard's own Job deadline.
      const shardDeadline = shardDeadlineSeconds(batchIsolation ? Math.max(...paths.map((file) => estimated([file]))) * Math.ceil(paths.length / batchWidth) : estimated(paths), deadlineSeconds);
      const parts = batchIsolation ? paths.map((file) => [file]) : shardParts(paths, (file) => estimated([file]));
      const memoryLimit = batchIsolation || paths.length === 1 && (depth >= 1 || heavy.has(paths[0]!)) ? POD_ISOLATION_MEMORY_LIMIT : undefined;
      const shellOptions = { parts, cdpPatterns, softSeconds: softDeadlineSeconds(shardDeadline), cachePrefix, installSlots,
        ...(pod.externalVolumeRefs?.some(({ kind }) => kind === 'node_modules') ? { depsDir: GATE_VOLUME_REF_MOUNT_PATH.node_modules } : {}),
        ...(rulesBaseSha ? { rulesBaseSha } : {}), ...(batchIsolation ? { parallelParts: batchWidth } : {}) };
      const keyShell = gateShardShell(shellOptions);
      // The stall beat only reports; runKey keeps hashing the shell without it, so earlier results stay reusable.
      const runKey = createHash('sha256').update(JSON.stringify({ pool: pod.pool, podShell: keyShell, memoryLimit: memoryLimit ?? null,
        deadlineSeconds: shardDeadline, bunCache: bunCache ?? null, externalVolumeRefs: pod.externalVolumeRefs ?? [] })).digest('hex');
      let start = clock();
      let admitted: GateAdmissionResult | undefined;
      let output: string | undefined;
      const phaseTimes: Record<string, string> = {};
      const stamp = (phase: string) => { phaseTimes[phase] = new Date().toISOString(); };
      let podStages: Record<string, number> | undefined;
      let podLifecycle: Record<string, string> | undefined;
      let imageDigest: string | null = null;
      let runtimeIdentity: ReturnType<typeof parseGatePodRuntimeIdentity> | undefined;
      let podJobName: string | undefined;
      let batchArtifactsComplete = true;
      let junit: string | undefined;
      let rc: number | undefined;
      let shardLoadFlaky: string[] = [];
      let shardLoadFlakyAttemptedFiles: string[] = [];
      let jobExitCode: number | undefined;
      let batchArtifactDir: string | undefined;
      let lastFile: string | undefined;
      let jobFailed = false;
      let warmQuarantineFailed = false;
      let warmShardRun = false;
      let jobError = '';
      let imagePinMismatch = false;
      let failureCapture: ReturnType<NonNullable<NonNullable<GateOptions['pod']>['failureEvidence']>> | undefined;
      let jobNameForCapture: string | undefined;
      let jobContextForCapture: string | undefined;
      const captureFailure = () => {
        try { failureCapture = failureEvidence({ name: jobNameForCapture ?? 'unplaced', context: jobContextForCapture }); }
        catch (error) { failureCapture = { error: `수거 실패 · ${String(error)}` }; }
      };
      /** GATE-MULTI-HOST — the member this shard's Job was placed on (recorded in the shard json / log / board). */
      let placedOn: string | undefined;
      let externalVolumeSnapshotMs = 0;
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
      const hqResume = !fresh && !branch && depth === 0 && parentAttempt === undefined && !descent
        ? hqResumeRows?.get(`pod-${shard}`) : undefined;
      if (hqResume) {
        const failureIds = hqResume.failureIds ?? [];
        const errorIds = hqResume.errorIds ?? [];
        const output = `${failureOutput(failureIds, errorIds)}\n${hqResume.pass} pass\n${hqResume.fail} fail\n${hqResume.errors} errors\nRan ${hqResume.ran} tests across ${paths.length} files.\n`;
        detailsById.set(`pod-${shard}`, { imageDigest: hqResume.imageDigest ?? undefined, pass: hqResume.pass!, fail: hqResume.fail!,
          errors: hqResume.errors!, ran: hqResume.ran!, failureIds, errorIds, attribution: 'complete', reuseDecision: 'reuse', reuseReason: 'completed HQ ledger batch' });
        debug.log('release-loop.gate', 'pod-shard-resumed-from-hq-ledger', { shard, files: paths.length, batchId: hqResume.batchId,
          rc: hqResume.rc, ran: hqResume.ran });
        return { runs: [{ output, rc: hqResume.rc === 1 || failureIds.length + errorIds.length > 0 ? 1 : 0,
          pass: hqResume.pass!, fail: hqResume.fail!, errors: hqResume.errors!, ran: hqResume.ran!, files: paths.length, passedIds: [] }], stalled: [] };
      }
      // External refs require a real Pod attempt for this sweep's verification and volume measurements;
      // a prior shard receipt cannot stand in for mounting and checking the current node snapshots.
      const reused = !pod.externalVolumeRefs?.length && !fresh && !descent && logDir
        ? previousShardResult(logDir, `pod-${shard}${branch}`, commit, paths, runKey, parentAttempt) : undefined;
      // This shard's attempt id: the recorded one when its way down is followed, a new one when a Pod runs. Children carry it.
      const attemptId = found?.attemptId ?? randomUUID();
      let volumeAttemptRow: (ReturnType<typeof gateExternalVolumeMeasurements> & { sweepId: string; cutSha: string; phase: 'sweep'; shard: string;
        attemptId: string; host: string | null; job: string | null; attemptedJobName?: string; launchState?: string }) | undefined;
      // The Pod itself stamps its cut and attempt before the test starts. A
      // collector-created manifest cannot reassign another Job's bytes.
      const podShell = gateShardShell({ ...shellOptions,
        ...(stallWatch ? { beatSeconds: gateStallBeatSeconds(stallSeconds) } : {}),
        sourceBinding: { cutSha: commit, attemptId } });
      if (descent === 'retry') {
        // «descend» is only the way down; «resumed» comes from each leaf whose log reads cleanly (review r4).
        debug.log('release-loop.gate', 'pod-shard-descend', { shard, branch, files: paths.length, via: 'retry' });
        resetShardAttempt(shard, branch);
        return runShard(paths, shard, depth, `${branch}-retry`, true, undefined, attemptId, hostRetries, batchIsolation, skipMembers);
      }
      if (descent === 'split' || descent === 'file-fanout') {
        resetShardAttempt(shard, branch);
        output = undefined;
        debug.log('release-loop.gate', 'pod-shard-descend', { shard, branch, files: paths.length, via: descent });
      } else if (reused) {
        output = reused.output;
        junit = reused.junit;
        rc = reused.rc;
        jobExitCode = 0;
        lastFile = lastStartedTestFile(output, paths);
      } else try {
        const warmParts = paths.map((file) => [file]);
        const warmIdentity = pod.executionIdentity;
        const warmShardEligible = pod.warmShardExecutionEnabled === true && pod.warmProducerEnabled === true
          && !!pod.warmReplay && !!pod.warmFinalize && !!pod.warmQuarantine
          && !!pod.pinnedImageDigest && !!warmIdentity && warmIdentity.platform === 'linux'
          && !pod.externalVolumeRefs?.length && !rulesBaseSha
          && paths.length > 0 && paths.every((file) => !isGateSpawnLaneFile(file) && !heavy.has(file));
        if (warmShardEligible) {
          let leased: WarmWorkerCommand | undefined;
          let warmLeaseClosed = false;
          let warmDirectory: string | undefined;
          const warmStarted = clock();
          const quarantine = async (reason: string) => {
            if (!leased || warmLeaseClosed) return;
            await pod.warmQuarantine!(leased, reason);
            warmLeaseClosed = true;
          };
          try {
            const warmRequest = { protocol: 1 as const, runId: sweepId, attemptId, cutSha: commit,
              deadlineAt: Date.now() + shardDeadline * 1000, files: paths, envProfile: 'gate-v1' };
            const runtimeIdentityInput = { baseImageDigest: warmIdentity.baseImageDigest ?? '', lockHash: cutLockSha256,
              os: warmIdentity.platform, architecture: warmIdentity.architecture, bunVersion: warmIdentity.bunVersion };
            const replay = await pod.warmReplay!(warmRequest, { kind: 'gate', lockHash: cutLockSha256,
              imageDigest: pod.pinnedImageDigest, runtimeIdentity: runtimeIdentityInput,
              runtimeContract: { baseImageDigest: warmIdentity.baseImageDigest, bunVersion: warmIdentity.bunVersion,
                os: 'linux', architecture: warmIdentity.architecture, requiredTools: ['bun', 'git'] } });
            leased = replay.command ?? undefined;
            if (leased && replay.transport.status === 'observed' && replay.transport.reason === 'complete'
              && warmCommandMatchesRequest(leased, warmRequest)
              && leased.podName && leased.podUid && leased.podContext
              && leased.key.imageDigest === pod.pinnedImageDigest && leased.key.lockHash === cutLockSha256
              && leased.key.architecture === warmIdentity.architecture) {
              warmDirectory = mkdtempSync(join(tmpdir(), 'gate-warm-shard-'));
              const materialized = materializeWarmShardArtifacts(warmDirectory, leased, replay.transport, warmParts);
              const read = materialized ? readShardArtifacts(warmDirectory, warmParts) : undefined;
              // readShardArtifacts validates each one-file warm part's own Bun/JUnit summary.
              // Combined output keeps one summary per file, not a synthetic shard-wide total.
              const complete = !!read && !read.timedOut && read.rc !== undefined && (read.rc === 0 || read.rc === 1)
                && read.finished.length === paths.length && !!read.output && !!read.junit;
              if (complete) {
                const attribution = failuresOf({ rc: read!.rc!, output: read!.output! }, `warm pod-${shard} shard`);
                await pod.warmFinalize!(leased);
                warmLeaseClosed = true;
                output = read!.output;
                junit = read!.junit;
                rc = read!.rc;
                jobExitCode = 0;
                finished = read!.finished;
                batchArtifactsComplete = true;
                imageDigest = leased.key.imageDigest;
                placedOn = leased.podContext;
                runtimeIdentity = { bunVersion: warmIdentity.bunVersion, platform: warmIdentity.platform,
                  architecture: warmIdentity.architecture, envFingerprint: warmIdentity.envFingerprint,
                  ...(warmIdentity.baseImageDigest ? { baseImageDigest: warmIdentity.baseImageDigest } : {}) };
                lastFile = paths.at(-1);
                warmShardRun = true;
                debug.log('release-loop.gate', 'warm-shard-reused', { sweepId, shard, branch, attemptId,
                  files: paths.length, workerId: leased.workerId, podUid: leased.podUid, host: placedOn,
                  imageDigest, leaseGeneration: leased.generation, requestMs: clock() - warmStarted,
                  failureIds: attribution.failures, errorIds: attribution.errors,
                  newPodLaunches: 0, verdictSource: 'validated-warm-artifacts' });
              } else await quarantine('warm-artifact-incomplete');
            } else if (leased) await quarantine('warm-identity-or-transport-invalid');
          } catch (error) {
            debug.log('release-loop.gate', 'warm-shard-fallback', { sweepId, shard, branch, reason: String(error).slice(0, 300) }, { level: 'warn' });
            if (leased && !warmLeaseClosed) {
              try { await quarantine('warm-shard-adoption-failed'); }
              catch (quarantineError) {
                // Never retry, split, or launch a cold replacement while a possibly dirty warm worker remains selectable.
                warmQuarantineFailed = true;
                throw new Error('warm worker quarantine failed; refusing further shard execution: ' + String(quarantineError));
              }
            }
          } finally {
            if (warmDirectory) rmSync(warmDirectory, { recursive: true, force: true });
          }
        }
        if (!warmShardRun) {
        stamp('admissionStart');
        admitted = await admitGateShard(gateAdmission, { waitMs: admissionWaitSeconds * 1000, onWait: (reason) => markShard(shard, { waitReason: reason }, [], branch) });
        stamp('admissionEnd');
        if (admitted.outcome !== 'off') debug.log('release-loop.gate', 'shard-admission', { shard, branch, outcome: admitted.outcome, waitedMs: admitted.waitedMs, ...(admitted.reason ? { reason: admitted.reason } : {}) },
          admitted.outcome === 'granted' ? undefined : { level: 'warn' });
        if (admitted.outcome === 'admission-error' || admitted.outcome === 'admission-timeout') {
          admitted.release();
          return { runs: [], stalled: [{ shard, files: paths, reason: admitted.outcome, ...(admitted.reason ? { detail: admitted.reason } : {}) }] };
        }
        // The admission wait is not the shard's run time: deadline/timeout judgment and the measured duration start here.
        start = clock();
        const jobName = `gate-${randomUUID()}`;
        volumeAttemptRow = pod.externalVolumeRefs?.length ? {
          sweepId, cutSha: commit, phase: 'sweep' as const, shard: `pod-${shard}${branch}`, attemptId,
          host: null as string | null, job: null as string | null, attemptedJobName: jobName, launchState: 'not-started',
          ...gateExternalVolumeMeasurements(pod.externalVolumeRefs, [], []),
        } : undefined;
        if (volumeAttemptRow) volumeRefMeasurementRows.push(volumeAttemptRow);
        const resultFile = `pod-${shard}${branch}.json`;
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
        const job = await runPod({
          provenanceGate: true,
          provenance: { actorKind: process.env.ELANOUS_SEAT ? 'seat' : 'loop', actor: process.env.ELANOUS_SEAT || 'release-loop',
            character: 'gate-shard-runner', launchHost: hostname(), entrance: process.env.ELANOUS_RELEASE_ENTRANCE?.trim() || 'release-run',
            kind: 'gate-shard', run: process.env.ELANOUS_RUN_ID || sweepId, phase: 'release-gate', requestedAt: new Date().toISOString(),
            graphNode: 'gate', version: pod.shardsFile?.version, commit, shard: `${shard + 1}-of-${shards.length}`,
            reason: `release gate shard ${shard + 1}/${shards.length}`, pool: pod.pool, cpuReq: cpu.request,
            memReq: memoryLimit ?? POD_ISOLATION_MEMORY_LIMIT, warmReused: false },
          pool: pod.pool, poolScheduler: trackedPool(shard, branch, jobName, resultFile, attemptId, (member) => {
            stamp('poolPlaced'); jobContext = member.context; jobContextForCapture = member.context; placedOn = member.context;
            if (volumeAttemptRow) volumeAttemptRow.host = member.context;
            placed();
            if (branch === '-tail') tailPlacedHost = member.context;
          }, skipMembers, depth === 0 && branch === '' && hostRetries === 0 && !retriedNoOutput && !batchIsolation && skipMembers.size === 0), clone: true,
          source: { kind: 'commit', sha: commit, ...(rulesBaseSha ? { baseSha: rulesBaseSha } : {}) },
          ...(pod.imagePin === 'cut-commit' || pod.pinnedImageDigest || pod.pinnedRunId ? { imageCommit: commit } : {}),
          ...(pod.pinnedImageDigest || pod.pinnedRunId ? { syncImages: pinnedGateImageSync(pod, commit)! } : {}), deadlineSeconds: shardDeadline,
          ...(pod.gateBaseImageDigest !== undefined ? { gateBaseImageDigest: pod.gateBaseImageDigest } : {}),
          ...gateHostMirror(pod),
          ...(multiHost ? { statusUnreadableMs: memberUnreadableSeconds * 1000 } : {}),
          ...(bunCache ? { bunCache } : {}),
          ...(pod.externalVolumeRefs?.length ? { externalVolumeRefs: pod.externalVolumeRefs } as Partial<RunPodCommandOptions> : {}),
          ...(externalVolumeExpectations ? { externalVolumeExpectations } as Partial<RunPodCommandOptions> : {}),
          ...(installSlots > 0 ? { installSlots: POD_INSTALL_SLOTS_HOST_PATH } : {}),
          ...(pod.cpu ? { cpu: pod.cpu } : {}),
          // 실패 뒤 다시 도는 파일 하나짜리 Job 은 메모리 한도를 올린다 — 16Gi 에선 무거운 한 파일이 혼자서도 OOM 이었다(09-30 `unwired-exports`).
          ...(memoryLimit ? { memoryLimit } : {}),
          name: jobName,
          command: ['bash', '-lc', podShell],
        }).finally(() => watch?.stop());
        externalVolumeSnapshotMs = job.externalVolumeSnapshotMs ?? 0;
        stamp('jobReturned');
        podJobName = job.job;
        batchArtifactDir = job.artifactsDir;
        if (volumeAttemptRow) Object.assign(volumeAttemptRow, { host: placedOn ?? null, job: job.job, launchState: 'job-created' });
        // poolOverride is the injected scheduler used by isolated tests; it has no authenticated kubectl
        // context. Those sweeps intentionally cannot mint a valid baseline receipt (missing observed digest).
        // Production pool sweeps always use this Kubernetes lookup; lookup failure is receipt-invalid only.
        if (tools.podImageDigest) {
          imageDigest = tools.podImageDigest({ job, host: placedOn ?? 'unobserved' });
        } else if (!poolOverride && placedOn) {
          try {
            const got = kubectl(['--context', placedOn, '-n', 'elanous-test', 'get', 'pods', '-l', `job-name=${job.job}`, '-o', 'json']);
            if (got.status === 0) {
              podLifecycle = readGatePodLifecycle(got.stdout);
              imageDigest = actualGatePodImageDigest(got.stdout);
            }
          } catch { /* timings never change the verdict */ }
        }
        if (pod.pinnedImageDigest && imageDigest !== pod.pinnedImageDigest) {
          imagePinMismatch = true;
          debug.log('release-loop.gate', 'image-pin-mismatch', { runId: pod.pinnedRunId ?? null,
            shard, branch, host: placedOn ?? null, pinnedDigest: pod.pinnedImageDigest, actualDigest: imageDigest,
            decision: 'reject-job' }, { level: 'error' });
          throw new Error(`gate image pin mismatch: expected ${pod.pinnedImageDigest}, got ${imageDigest ?? 'unmeasured'}`);
        }
        jobExitCode = job.exitCode;
        if (job.exitCode !== 0) captureFailure();
        batchArtifactDir = job.artifactsDir;
        const read = readShardArtifacts(job.artifactsDir, parts);
        runtimeIdentity = read.runtimeIdentity;
        if (logDir) {
          mkdirSync(logDir, { recursive: true });
          let retryArtifactIndex = 0;
          const retryEvidence = parts.flatMap((files, partIndex) => {
            const path = join(job.artifactsDir, `part-${partIndex}.retry-files`);
            if (!existsSync(path)) return [];
            const retryFiles = readFileSync(path, 'utf8').split(/\r?\n/).filter((file) => file && files.includes(file));
            return retryFiles.map((file, retryIndex) => {
              const prefix = `part-${partIndex}.retry-${retryIndex}`;
              const persisted: Record<string, unknown> = { file, started: existsSync(join(job.artifactsDir, `${prefix}.started`)), rc: existsSync(join(job.artifactsDir, `${prefix}.rc`))
                ? readFileSync(join(job.artifactsDir, `${prefix}.rc`), 'utf8').trim() : null };
              for (const suffix of ['log', 'junit.xml'] as const) {
                const source = join(job.artifactsDir, `${prefix}.${suffix}`);
                if (!existsSync(source)) continue;
                const targetName = `pod-${shard}${branch}.retry-${retryArtifactIndex}.${suffix}`;
                copyFileSync(source, join(logDir, targetName)); chmodSync(join(logDir, targetName), 0o600);
                persisted[suffix === 'log' ? 'log' : 'junit'] = targetName;
              }
              retryArtifactIndex++;
              return persisted;
            });
          });
          if (retryEvidence.length) writeFileSync(join(logDir, `pod-${shard}${branch}.retries.json`), JSON.stringify(retryEvidence, null, 2) + '\n', { mode: 0o600 });
          else rmSync(join(logDir, `pod-${shard}${branch}.retries.json`), { force: true });
        }
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
        shardLoadFlaky = read.loadFlaky ?? [];
        shardLoadFlakyAttemptedFiles = read.loadFlakyAttemptedFiles ?? [];
        ({ output, junit, rc, timedOut, finished, unfinishedLog, exitCodeOnly } = read);
        // A stall counts only when the Job also left no verdict (a failed stop can let a late shard finish after all).
        const stalledAt = watch?.stalled();
        stallWatchState = watch?.state();
        abort = watch?.aborted();
        if (abort?.taken) abortedShards++;
        if (stalledAt && !finished.length && rc === undefined) stall = { seconds: stallSeconds, sinceCheckoutMs: stalledAt.sinceCheckoutMs };
        // A Job the cluster cut at its own deadline leaves no outbox at all: past the deadline with nothing is a timeout too.
        if (!timedOut && output === undefined && job.exitCode !== 0 && clock() - start >= shardDeadline * 1000) timedOut = true;
        lastFile = output === undefined && unfinishedLog === undefined ? undefined : lastStartedTestFile(`${output ?? ''}\n${unfinishedLog ?? ''}`, paths);
        if (!lastFile && (job.exitCode !== 0 || rc === undefined || (rc !== 0 && rc !== 1))) {
          try { lastFile = lastStartedTestFile(jobLogTail(job).split(/\r?\n/).slice(-200).join('\n'), paths); }
          catch { /* Log retrieval is diagnostic; do not hide the stalled shard. */ }
        }
        }
      } catch (error) {
        jobFailed = true;
        jobError = error instanceof Error ? error.message : String(error);
        const launched = podCommandJobFailureInfo(error);
        if (launched) {
          batchArtifactDir = launched.artifactsDir;
          placedOn = launched.context ?? placedOn;
          externalVolumeSnapshotMs = launched.externalVolumeSnapshotMs ?? 0;
          if (launched.launchState !== 'preflight-failed') podJobName = launched.job;
          if (volumeAttemptRow) Object.assign(volumeAttemptRow, { host: launched.context ?? placedOn ?? null,
            attemptedJobName: launched.job, launchState: launched.launchState,
            ...(launched.launchState !== 'preflight-failed' ? { job: launched.job } : {}),
            volumeRefSnapshotPreparationMs: externalVolumeSnapshotMs, volumeRefPreparationMs: externalVolumeSnapshotMs });
        }
        if (!failureCapture) captureFailure();
      }
      // A launch that failed before placement still gives its admission back (release is idempotent).
      admitted?.release();
      if (warmQuarantineFailed) return { runs: [], stalled: [{ shard, files: paths, reason: 'job-failed',
        detail: jobError.slice(0, 300), ...(placedOn ? { lastHost: placedOn } : {}) }] };
      const durationMs = clock() - start;
      const fileSeconds = junit === undefined ? undefined : Object.fromEntries(readJunitFileSeconds(junit));
      const testSeconds = fileSeconds === undefined ? undefined : Object.values(fileSeconds).reduce((sum, seconds) => sum + seconds, 0);
      const testWallSeconds = batchIsolation
        ? gateBatchTestWallSeconds(podStages, parts.length)
        : podStages?.['test-start'] !== undefined && podStages?.['test-end'] !== undefined
          ? Math.max(0, podStages['test-end'] - podStages['test-start']) : undefined;
      const podOverheadSeconds = testWallSeconds !== undefined || (!batchIsolation && testSeconds !== undefined)
        ? Math.max(0, durationMs / 1000 - (testWallSeconds ?? testSeconds!)) : undefined;
      const installSeconds = parseInstallSeconds(output ?? '');
      const installSlotWaitMs = parseGateInstallSlotWaitMs(output ?? '');
      const volumeRefLogPath = batchArtifactDir ? join(batchArtifactDir, 'external-volume-ref.log') : '';
      let volumeRefOutput = volumeRefLogPath && existsSync(volumeRefLogPath) ? readFileSync(volumeRefLogPath, 'utf8') : output ?? '';
      if (!volumeRefOutput) volumeRefOutput = output ?? '';
      if (pod.externalVolumeRefs?.length && podJobName && placedOn) {
        try {
          const logs = kubectl(['--context', placedOn, '-n', 'elanous-test', 'logs', `job/${podJobName}`, '-c', 'child', '--tail=-1']);
          if (logs.status === 0 && logs.stdout) volumeRefOutput = logs.stdout;
        } catch { /* absent Job logs remain an incomplete measurement */ }
      }
      const volumeRefReady = parseGateExternalVolumeReadyEvents(volumeRefOutput);
      const volumeRefRejected = parseGateExternalVolumeRejectedEvents(volumeRefOutput);
      const volumeRefMetrics = gateExternalVolumeMeasurements(pod.externalVolumeRefs ?? [], volumeRefReady, volumeRefRejected, externalVolumeSnapshotMs);
      if (pod.externalVolumeRefs?.length && podJobName) {
        const existingAttempt = volumeRefMeasurementRows.find((row) => row.sweepId === sweepId && row.cutSha === commit
          && row.attemptId === attemptId && row.shard === `pod-${shard}${branch}`);
        if (existingAttempt) Object.assign(existingAttempt, { host: placedOn ?? existingAttempt.host, job: podJobName, ...volumeRefMetrics });
      }
      const preparationTimings = gatePreparationTimings({ phaseTimes, podStages, podLifecycle,
        ...(admitted ? { admissionWaitMs: admitted.waitedMs } : {}), installSeconds,
        ...(installSlotWaitMs !== undefined ? { installSlotWaitMs } : {}),
        ...(pod.externalVolumeRefs?.length ? { volumeRefPreparationMs: volumeRefMetrics.volumeRefPreparationMs } : {}) });
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
        const testedFileHashes = branch ? undefined : currentTestedFileHashesByShard[`pod-${shard}`] ?? null;
        const lockfileHash = branch ? undefined : gateLockfileHashAtCommit(repo, commit);
        writeFileSync(join(logDir, `pod-${shard}${branch}.json`), JSON.stringify({ completed: true, jobName: jobNameForCapture, durationMs, rc: rc ?? null,
          ...(shardLoadFlakyAttemptedFiles.length ? { samePodRetryFiles: shardLoadFlakyAttemptedFiles } : {}),
          ...(shardLoadFlaky.length ? { loadFlaky: shardLoadFlaky } : {}),
          ...(stall ? { reason: 'stall', finishedFiles: 0, stallSeconds: stall.seconds, sinceCheckoutMs: stall.sinceCheckoutMs } : timedOut ? { reason: 'timeout', finishedFiles: finished.length } : {}), files: paths, plannedSeconds: estimated(paths), deadlineSeconds: shardDeadline, shardCount: shards.length, sweepId, commit, runKey, attemptId, ...(parentAttempt ? { parentAttempt } : {}), jobExitCode: jobExitCode ?? null, jobFailed, ...(placedOn ? { host: placedOn } : {}),
          ...(Object.keys(phaseTimes).length ? { phaseTimes } : {}), ...(podStages ? { podStages } : {}),
          preparationTimingsMs: preparationTimings,
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
          ...(imageDigest ? { imageDigest } : {}), ...(runtimeIdentity ? { runtimeIdentity } : {}),
          ...(testedFileHashes ? { testedFileHashes } : {}), ...(lockfileHash ? { lockfileHash } : {}),
          ...(fileSeconds !== undefined ? { fileSeconds, testSeconds } : {}), ...(testWallSeconds !== undefined ? { testWallSeconds } : {}),
          ...(podOverheadSeconds !== undefined ? { podOverheadSeconds } : {}),
          ...(pod.externalVolumeRefs?.length ? { volumeRefs: volumeRefMetrics, volumeRefReady } : {}),
          ...(unfinishedLogBytes !== undefined ? { unfinishedLogBytes } : {}),
          ...(admitted && admitted.outcome !== 'off' ? { admission: admitted.outcome, admissionWaitMs: admitted.waitedMs,
            ...(admitted.reason ? { admissionReason: admitted.reason } : {}) } : {}),
          ...(abort ? { abort: { reason: `abort: ${abort.reason}`, at: abort.at, by: abort.by, sinceLastOutputMs: abort.sinceLastOutputMs, taken: abort.taken } } : {}),
          stallWatch: shardStallWatchRecord(stallSeconds, !!liveLog, stallWatchState) }) + '\n', { mode: 0o600 });
        if (paths.length === 1 && (rc === 0 || rc === 1) && !jobFailed && jobExitCode === 0
          && output !== undefined && junit !== undefined) {
          writeFileSync(`${warmPrefix}.rc`, `${rc}\n`, { mode: 0o600 });
          writeWarmJobManifest(warmPrefix, paths[0]!, commit, attemptId);
        }
      }
      detailsById.set(`pod-${shard}${branch}`, { ...(detailsById.get(`pod-${shard}${branch}`) ?? {}),
        ...(imageDigest ? { imageDigest } : {}), ...(runtimeIdentity ? { runtimeIdentity } : {}) });
      if (!reused) {
        const rootId = `pod-${shard}`;
        executionsByShard.set(rootId, [...(executionsByShard.get(rootId) ?? []), {
          branch, attemptId, imageDigest, runtimeIdentity: runtimeIdentity ?? null, host: placedOn ?? board[rowIndex(shard, branch)]?.host ?? (poolScheduler.members.length === 1 ? poolScheduler.members[0]?.context : undefined) ?? null,
        }]);
      }
      // GATE-TIMEOUT-HEAL ③: a cut shard is «reason: timeout» (with the files that still finished), not a bare rc=null.
      if (!reused && !descent) debug.log('release-loop.gate', 'pod-shard', { shard, files: paths, durationMs, rc: rc ?? null, attempt: depth + 1, installSeconds, runKey, preparationTimingsMs: preparationTimings, gateDeps: parseGateDeps(output ?? ''), deadlineSeconds: shardDeadline, parts: parts.length, ...(placedOn ? { host: placedOn } : {}),
        ...(pod.externalVolumeRefs?.length ? { ...volumeRefMetrics, volumeRefReady } : {}),
        ...(testSeconds !== undefined ? { testSeconds } : {}),
        ...(stall ? { reason: 'stall', finishedFiles: 0, stallSeconds: stall.seconds } : timedOut ? { reason: 'timeout', finishedFiles: finished.length } : {}) });
      // POD-LIFECYCLE-STAGES: the same values the shard json carries, as one `pod.lifecycle stages` line (observation only) —
      // only for a Job that came back (a launch that failed before the Job returned has no Pod to describe).
      if (!reused && !descent && podJobName !== undefined) emitPodLifecycle({ ...gatePodLifecycleEvent({ runId: process.env.ELANOUS_RUN_ID ?? null, podJob: podJobName, host: placedOn ?? null,
        shard: `pod-${shard}${branch}`, attemptId, phaseTimes, podStages, podLifecycle, outcome: gatePodOutcome({ jobFailed, stalled: !!stall, timedOut, rc }) }),
        runKey, preparationTimingsMs: preparationTimings });
      if (!reused && !descent) markShard(shard, { ...(installSeconds !== null ? { installSec: installSeconds } : {}), ...(rc !== undefined ? { rc } : {}), ...(timedOut ? { state: 'timeout' as const } : {}) }, [], branch);
      let clean = output?.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      const ran = clean && lastMatch(clean, /Ran (\d+) tests? across (\d+) files?/);
      const passes = clean === undefined ? NaN : summaryCount(clean, 'pass');
      const fails = clean === undefined ? NaN : summaryCount(clean, 'fail');
      const errors = clean === undefined ? NaN : summaryCount(clean, 'error');
      let reason: ShardReason | undefined;
      let namedFailures: number | undefined;
      let unattributedDetail: string | undefined;
      if (descent === 'split') reason = 'incomplete';
      else if (imagePinMismatch) reason = 'image-pin-mismatch';
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
      // A watched stall in a multi-file Job has already spent its first deadline. Measure each file on its own
      // under the sweep-wide isolation permit pool instead of paying for another whole-bundle Job and split tree.
      // The same descent is replayed after a cut resume when the parent and first child records are attributed.
      if (reason === 'no-output' && paths.length > 1 && !singleShotTail && (stall || descent === 'file-fanout')) {
        const count = Math.min(paths.length, isolationRemaining[shard]!);
        isolationRemaining[shard]! -= count;
        debug.log('release-loop.gate', 'pod-stall-file-fanout', { shard, branch, files: paths.length, launched: count,
          resumed: descent === 'file-fanout', limit: isolationConcurrency });
        const children = await Promise.all(paths.slice(0, count).map((file, index) => isolatedFile(() =>
          runShard([file], shard, depth + 1, `${branch}-file-${index}`, false, undefined, attemptId))));
        return { runs: children.flatMap((child) => child.runs), stalled: [
          ...children.flatMap((child) => child.stalled),
          ...(paths.length > count ? [{ shard, files: paths.slice(count), reason: 'no-output' as const,
            ...(placedOn ? { lastHost: placedOn } : {}) }] : []),
        ] };
      }
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
        if (reason === 'image-pin-mismatch') return { runs: [], stalled: [{ shard, files: paths, reason,
          detail: jobError.slice(0, 300), ...(placedOn ? { lastHost: placedOn } : {}) }] };
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
          const rootId = `pod-${shard}`;
          const rootDetail = detailsById.get(rootId) ?? {};
          detailsById.set(rootId, { ...rootDetail,
            unmeasuredFiles: [...new Set([...(rootDetail.unmeasuredFiles ?? []), ...narrowed])], retryGroupId: rootDetail.retryGroupId ?? attemptId });
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
        ran: Number(ran![1]), files: Number(ran![2]), passedIds: junit ? junitPassedIds(junit) : [],
        ...(shardLoadFlaky.length ? { loadFlaky: shardLoadFlaky } : {}),
        ...(shardLoadFlakyAttemptedFiles.length ? { loadFlakyAttemptedFiles: shardLoadFlakyAttemptedFiles } : {}) }], stalled: [] };
    };
    const runShard = async (...args: Parameters<typeof runShardImpl>): ReturnType<typeof runShardImpl> => {
      const [paths, shard, depth = 0, branch = '', , , parentAttempt, hostRetries = 0] = args;
      filesById.set(`pod-${shard}${branch}`, [...paths]);
      if (parentAttempt) {
        const id = `pod-${shard}${branch}`;
        detailsById.set(id, { ...(detailsById.get(id) ?? {}), retryGroupId: parentAttempt });
      }
      if (branch || depth > 0 || parentAttempt !== undefined || hostRetries > 0) {
        resetShardAttempt(shard, branch, Math.round(estimated(paths) / 6) / 10);
      }
      try {
        const done = await runShardImpl(...args);
        if (branch) markShard(shard, { state: !done.stalled.length ? 'done' : done.stalled.some((stall) => stall.reason === 'timeout') ? 'timeout' : 'failed', endedAt: new Date().toISOString() }, ['waitReason'], branch);
        if (branch) recordShardResult(`pod-${shard}${branch}`, done);
        return done;
      } catch (error) {
        if (branch) markShard(shard, { state: 'failed', endedAt: new Date().toISOString() }, ['waitReason'], branch);
        throw error;
      }
    };
    // 모든 조각이 끝난 뒤 판정한다 — 한 조각의 예외로 먼저 돌아가면 다른 Pod 가 도는 채로 정리가 시작된다(#22002 리뷰 R3).
    // GATE-RISK-LANE — the risk shard's own wall time (planned vs measured in its log line); it never changes a verdict.
    const shardDurations: number[] = [];
    // Keep root shards outside the timed Pod admission until a gate slot is available.
    // Otherwise a wide sweep starts every admission clock together and later waves expire before placement.
    const withRootSlot = createGateRootLimiter(rootSlots);
    debug.log('release-loop.gate', 'pod-root-concurrency', { limit: rootSlots, shards: shards.length });
    let settled: Array<PromiseSettledResult<Awaited<ReturnType<typeof runShard>>>>;
    if (shardsFile) {
      reconcileTimer = setInterval(reconcileTick, 30_000);
      reconcileTimer.unref();
    }
    try {
      settled = await Promise.allSettled(shards.map(async (item, shard) => {
        const shardStartedAt = clock();
        try {
          const shardId = `pod-${shard}`;
          const expected = hostPlan[shard]?.kind === 'reuse' ? receiptChecks[shard]?.result : null;
          if (expected) {
            if (receiptRoot && expected.receipt.head40 !== commit && radiusUnchangedShardIds.includes(shardId)) {
              try {
                const carried = carryGateShardResult(receiptRoot, expected, commit);
                debug.log('gate.receipt', 'shard-receipt-carried', { shard: shardId, from: expected.receipt.head40, to: carried.head40 });
              } catch (error) {
                debug.log('release-loop.gate', 'shard-receipt-carry-failed', { shard: shardId, error: String(error) }, { level: 'error' });
                throw new Error(`shard receipt carry failed; refusing unrecorded reuse: ${shardId}: ${String(error)}`);
              }
            }
            const done = { runs: expected.runs, stalled: [] };
            shardDurations[shard] = 0;
            detailsById.set(shardId, { ...(detailsById.get(shardId) ?? {}), imageDigest: expected.receipt.imageDigest });
            markShard(shard, { state: 'done', rc: done.runs.some((run) => run.fail || run.errors) ? 1 : 0,
              startedAt: expected.receipt.measuredAt, endedAt: new Date().toISOString(), host: expected.receipt.host }, ['waitReason']);
            recordShardResult(shardId, done);
            debug.log('release-loop.gate', 'shard-receipt-reused', { shard: shardId, host: expected.receipt.host, files: item.files.length });
            return done;
          }
          debug.log('release-loop.gate', 'shard-receipt-not-reused', { shard: shardId,
            reason: pod.rerouteShard === shardId ? 'reroute-requested'
              : receiptChecks[shard]?.result && pod.rerouteShard === 'auto' ? 'auto-reroute'
                : receiptChecks[shard]?.result ? 'dispatch-remeasure-required'
                  : receiptChecks[shard]?.reason ?? 'receipt-unavailable',
            plan: hostPlan[shard]?.kind ?? 'none' });
          const receiptAttempt = receiptRoot ? nextGateShardAttempt(receiptRoot, shardId) : 1;
          if (receiptRoot && base40 && envFingerprint) {
            try {
              markGateShardUnmeasured(receiptRoot, { id: shardId, files: [...item.files], version: pod.shardsFile!.version, graphSha: currentGraphPins?.graphSha ?? '', recipeSha: currentGraphPins?.recipeSha ?? '', head40: commit, base40,
                graphRunId: tools.graphRunId ?? undefined,
                host: 'pending', envKey: `${envFingerprint}:${expectedImageDigest ?? 'unmeasured'}`, status: 'unmeasured',
                failureIds: [], errorIds: [], evidencePath: 'pending', evidenceSha256: '0'.repeat(64),
                measuredAt: new Date().toISOString(), attempt: receiptAttempt });
            } catch (error) {
              debug.log('release-loop.gate', 'shard-receipt-invalidate-failed', { shard: shardId, error: String(error) }, { level: 'warn' });
              throw error;
            }
          }
          // A missing or deliberately replaced receipt must execute a new Job. The older log-only resume
          // has no base/environment/image binding and cannot authorize this cross-host measurement.
          // The sixth runShardImpl argument is `fresh`: a missing receipt must launch a new Job.
          const freshForReceipt = (!!receiptRoot && !hqResumeRows?.has(shardId)) || pod.freshShards === true;
          const done = await withRootSlot(() => {
            markShard(shard, { state: 'running', startedAt: new Date().toISOString() }, ['waitReason']);
            return runShard(item.files, shard, 0, '', false, freshForReceipt);
          });
          shardDurations[shard] = clock() - shardStartedAt;
          const state = !done.stalled.length ? 'done' as const : done.stalled.some((stall) => stall.reason === 'timeout') ? 'timeout' as const : 'failed' as const;
          markShard(shard, { state, rc: done.stalled.length || done.runs.some((run) => run.fail || run.errors) ? 1 : 0, endedAt: new Date().toISOString() }, ['waitReason']);
          recordShardResult(`pod-${shard}`, done);
          if (receiptRoot && base40 && envFingerprint && !done.stalled.length) {
            const executionRows = executionsByShard.get(shardId) ?? [];
            const executionEvidenceComplete = executionRows.length > 0
              && executionRows.every((execution) => !!execution.imageDigest && !!execution.runtimeIdentity && !!execution.host);
            const imageDigests = [...new Set(executionRows.map((execution) => execution.imageDigest).filter((value): value is string => !!value))];
            const runtimes = [...new Map(executionRows.flatMap((execution) => execution.runtimeIdentity
              ? [[JSON.stringify(execution.runtimeIdentity), execution.runtimeIdentity] as const] : [])).values()];
            const imageDigest = imageDigests.length === 1 ? imageDigests[0] : undefined;
            const runtimeIdentity = runtimes.length === 1 ? runtimes[0] : undefined;
            const detail = detailsById.get(shardId);
            if (imageDigest && runtimeIdentity) { const { imageDigest: _oldImageDigest, ...detailWithoutImage } = detail ?? {}; detailsById.set(shardId, { ...detailWithoutImage, imageDigest, runtimeIdentity }); }
            const attribution = detail?.attribution;
            const executionHosts = [...new Set(executionRows.map((execution) => execution.host).filter((host): host is string => !!host))];
            const executedHost = executionHosts[0];
            const testedFileHashes = currentTestedFileHashesByShard[shardId];
            if (executionEvidenceComplete && imageDigest && runtimeIdentity && executedHost && currentGraphPins && attribution === 'complete'
              && currentLockfileHash && testedFileHashes) {
              const runtimeSourceFingerprint = gateRuntimeSourceFingerprint(repo, commit, runtimeIdentity);
              if (!runtimeSourceFingerprint) {
                debug.log('release-loop.gate', 'shard-receipt-not-saved', { shard: shardId, reason: 'runtime-source-fingerprint-unmeasured' });
              } else try {
                saveGateShardResult(receiptRoot, { receipt: { id: shardId, files: [...item.files], head40: commit, base40,
                  version: pod.shardsFile!.version, graphRunId: tools.graphRunId ?? undefined, graphSha: currentGraphPins!.graphSha, recipeSha: currentGraphPins!.recipeSha,
                  graphEntry: currentGraphPins?.graphEntry, recipeCommand: currentGraphPins?.recipeCommand, recipeTimeoutMs: currentGraphPins?.recipeTimeoutMs,
                  host: executedHost, envKey: gateShardRuntimeIdentityKey(runtimeIdentity, currentLockfileHash)!, envFingerprint, imageDigest, runtimeIdentity,
                  runtimeSourceFingerprint, lockfileHash: currentLockfileHash, testedFileHashes,
                  executions: executionRows.map((execution) => ({ branch: execution.branch, attemptId: execution.attemptId,
                    host: execution.host!, imageDigest: execution.imageDigest!, runtimeIdentity: execution.runtimeIdentity! })), status: 'complete',
                  failureIds: detail?.failureIds ?? [], errorIds: detail?.errorIds ?? [],
                  evidencePath: 'pending', evidenceSha256: '0'.repeat(64), measuredAt: new Date().toISOString(),
                  attempt: receiptAttempt }, runs: done.runs });
              } catch (error) {
                debug.log('release-loop.gate', 'shard-receipt-write-failed', { shard: shardId, error: String(error) }, { level: 'error' });
                throw error;
              }
            } else debug.log('release-loop.gate', 'shard-receipt-not-saved', { shard: shardId,
              missingImageDigest: !imageDigest, missingRuntimeIdentity: !runtimeIdentity, executionEvidenceComplete,
              executedHost: executedHost ?? null, attribution: attribution ?? 'unmeasured' });
          }
          return done;
        } catch (error) {
          markShard(shard, { state: 'failed', endedAt: new Date().toISOString() }, ['waitReason']);
          throw error;
        }
      }));
    } finally { if (reconcileTimer) clearInterval(reconcileTimer); }
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    const shardFailureCounts = shards.map((_, index) => detailsById.get(`pod-${index}`)?.fail !== undefined
      && detailsById.get(`pod-${index}`)?.errors !== undefined
      ? Number(detailsById.get(`pod-${index}`)!.fail) + Number(detailsById.get(`pod-${index}`)!.errors) : null);
    emitGatePhaseProgress('collection', { state: 'complete', shardCount: shards.length,
      failureCount: shardFailureCounts.every((count) => count !== null)
        ? shardFailureCounts.reduce<number>((sum, count) => sum + (count ?? 0), 0) : null });
    if (remoteLedgerRequired) {
      const observedAt = new Date().toISOString();
      const batchRows: GateShardLedgerRow[] = shards.map((item, index) => {
        const row = board.find((candidate) => candidate.id === `pod-${index}`);
        const detail = detailsById.get(`pod-${index}`) ?? {};
        if (!row || row.state !== 'done' || (detail.attribution !== 'complete' && !(detail.attribution === 'unmeasured' && detail.unmeasuredFiles?.length))
          || detail.ran === undefined)
          throw new Error(`remote gate refused: HQ shard result batch is incomplete (pod-${index})`);
        return { v: 1, invocationId: sweepId, version: pod.shardsFile!.version, phase: 'cut', shardId: row.id, files: [...item.files],
          host: row.host ?? null, executor: 'pod', imageDigest: detail.imageDigest ?? null,
          measuredImageDigest: detail.imageDigest ?? null,
          currentImageDigest: expectedImageDigest ?? currentExecutionIdentity?.imageDigest ?? null,
          commit, envFingerprint: pod.shardsFile!.envFingerprint!,
          startedAt: row.startedAt ?? null, endedAt: row.endedAt ?? null, observedAt, state: 'done', rc: row.rc ?? null,
          pass: detail.pass ?? null, fail: detail.fail ?? null, errors: detail.errors ?? null, ran: detail.ran,
          failureIds: detail.failureIds ?? null, errorIds: detail.errorIds ?? null, attribution: detail.attribution ?? 'unmeasured', logPath: null, junitPath: null,
          stopReason: null, attemptId: row.attemptId ?? null, reuseDecision: detail.reuseDecision, reuseReason: detail.reuseReason,
          ...(detail.unmeasuredFiles?.length ? { unmeasuredFiles: [...detail.unmeasuredFiles] } : {}), retryGroupId: detail.retryGroupId };
      });
      try {
        const appendBatch = tools.appendShardLedgerBatch ?? appendGateShardLedgerBatch;
        const batchId = randomUUID();
        emitGatePhaseProgress('hq-ledger-recording', { shardCount: batchRows.length });
        const error = appendBatch(pod.shardsFile!.ledgerPath!, batchRows, true, batchId);
        if (error) throw new Error(error);
        const persisted = readGateShardLedger(pod.shardsFile!.ledgerPath!);
        if (!persisted || persisted.trailingPartial || persisted.malformed > 0 || !gateShardLedgerBatchComplete(persisted.rows, { batchId, version: pod.shardsFile!.version, commit,
          phase: 'cut', observedAt, shardIds: batchRows.map((row) => row.shardId) })) {
          throw new Error('incomplete completed shard batch in HQ ledger');
        }
        emitGatePhaseProgress('hq-ledger-recorded', { shardCount: batchRows.length });
      } catch (error) {
        emitGatePhaseProgress('hq-ledger-rejected', { shardCount: batchRows.length, reason: String(error) });
        debug.log('release-loop.gate', 'shard-ledger-batch-write-failed', { shards: batchRows.length, error: String(error), failClosed: true }, { level: 'error' });
        throw new Error(`remote gate refused: HQ shard result batch write failed: ${String(error)}`);
      }
      debug.log('release-loop.gate', 'shard-ledger-batch-written', { shards: batchRows.length });
    }
    const results = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    // GATE-RISK-LANE — planned vs measured for the shard that ran first, with its own result. Its Pods are ordinary
    // shard Pods: their runs join `measured` below, so the sweep's summary and every later judgment are unchanged.
    let riskLane: GateRiskLaneRecord | undefined;
    if (riskPlan.riskFiles.length) {
      const riskRuns = results[0]?.runs ?? [];
      riskLane = { files: [...riskPlan.riskFiles], plannedSeconds: riskPlan.riskPlannedSeconds,
        durationMs: shardDurations[0] ?? 0, rc: riskRuns.length ? (riskRuns.some((run) => run.fail + run.errors > 0) ? 1 : 0) : null };
      debug.log('release-loop.gate', 'pod-risk-lane', { files: riskLane.files, shard: 0, plannedSeconds: riskLane.plannedSeconds,
        durationMs: riskLane.durationMs, rc: riskLane.rc, ...(results[0]?.stalled[0] ? { reason: results[0].stalled[0]!.reason } : {}) });
    }
    let stalledShards = results.flatMap((result) => result.stalled);
    const measured = results.flatMap((result) => result.runs);
    // GATE-STALLED-TAIL-REMEASURE: after the sweep, give only a one-file no-output leaf one fresh attempt on a different
    // pool member. Keep the original unmeasured evidence if no alternate is available or the remeasure is incomplete.
    const remainingStalls: typeof stalledShards = [];
    const tailTouched = new Set<number>();
    const tailRc = new Map<number, number>();
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
      tailTouched.add(stalled.shard);
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
          tailRc.set(stalled.shard, tail.runs.some((run) => run.fail || run.errors) ? 1 : 0);
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
    for (const shard of tailTouched) {
      const unresolved = stalledShards.some((item) => item.shard === shard);
      markShard(shard, { state: unresolved ? 'failed' : 'done', rc: unresolved ? 1 : tailRc.get(shard) ?? 0, endedAt: new Date().toISOString() }, ['waitReason']);
    }
    const total = measured.reduce((sum, run) => ({ pass: sum.pass + run.pass, fail: sum.fail + run.fail,
      errors: sum.errors + run.errors, ran: sum.ran + run.ran, files: sum.files + run.files }),
    { pass: 0, fail: 0, errors: 0, ran: 0, files: 0 });
    const unmeasured = stalledShards.filter((item) => item.stall);
    if (unmeasured.length) debug.log('release-loop.gate', 'pod-sweep-unmeasured', { shards: [...new Set(unmeasured.map((item) => item.shard))], files: unmeasured.reduce((sum, item) => sum + item.files.length, 0),
      stallSeconds, measuredFiles: total.files }, { level: 'warn' });
    // An unmeasured (stalled) shard is never handed to the host re-run as an environment stall: the gate fails now.
    if (abortedShards) debug.log('release-loop.gate', 'pod-sweep-aborted', { shards: abortedShards, midRunStallSeconds }, { level: 'warn' });
    if (pod.externalVolumeRefs?.length) logExternalVolumeCutSummary(commit, sweepId, 'sweep', 'sweep-complete', pod.externalVolumeRefs);
    if (stalledShards.some((item) => item.reason !== 'no-output' || item.files.length !== 1 || item.stall)) {
      const measuredFailures = partialFailuresOf(measured);
      throw new StalledPodShards(stalledShards, total, measuredFailures,
        results.filter((item) => item.stalled.length === 0).length, abortedShards);
    }
    if (total.ran === 0 && total.errors === 0 && !stalledShards.length) throw new Error('sweep incomplete: no tests ran');
    const outputs = measured.map((run) => run.output.replace(/(?:^|\n)\s*\d+ (?:pass|fail|errors?)\s*(?=\n|$)/g, '\n').replace(/Ran \d+ tests? across \d+ files?\.?/g, ''));
    return { rc: total.fail + total.errors ? 1 : 0, output: outputs.join('\n') + `\n${total.pass} pass\n${total.fail} fail\n${total.errors} errors\nRan ${total.ran} tests across ${total.files} files.\n`, validatedShards: true,
      podSweep: { id: sweepId, invocationId: sweepId, shards: shards.length, files: assignable, disposition: receiptDisposition },
      passedIds: [...new Set(measured.flatMap((run) => run.passedIds))].sort(),
      ...(measured.some((run) => run.loadFlaky?.length)
        ? { loadFlaky: [...new Set(measured.flatMap((run) => run.loadFlaky ?? []))].sort() } : {}),
      ...(measured.some((run) => run.loadFlakyAttemptedFiles?.length)
        ? { loadFlakyAttemptedFiles: [...new Set(measured.flatMap((run) => run.loadFlakyAttemptedFiles ?? []))].sort() } : {}),
      stalledEnv: stalledShards.flatMap((item) => item.files.map((file) => ({ file, reason: 'no-output' as const }))),
      ...(abortedShards ? { abortedShards } : {}),
      ...(riskLane ? { riskLane } : {}) };
  };
  const runPodRecheckBatch = async (files: readonly string[], commit: string, pod: NonNullable<GateOptions['pod']>, timeoutMs: number, relaxed = false): Promise<Map<string, CommandResult>> => {
    let measurementSweepId = gateVolumeSweepIdByCommit.get(commit);
    if (!measurementSweepId) { measurementSweepId = randomUUID(); gateVolumeSweepIdByCommit.set(commit, measurementSweepId); }
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
    if (pod.warmCutSha === commit && !observedPrewarmCuts.has(commit)) {
      observedPrewarmCuts.add(commit);
      try {
        const pool = poolOverride ?? new PodPoolScheduler(parsePodPool(pod.pool), { kubectl });
        const snapshot = observeGatePrewarmCutShadow(
          pod.warmPrewarmInput?.cutSha === commit ? pod.warmPrewarmInput : { cutSha: commit },
          () => poolOverride && !tools.kubectl ? null : snapshotWarmPoolMembers(pool.members, kubectl), () => pool.snapshot());
        debug.log('pod.pool', snapshot.status === 'observed' ? 'gate-prewarm-shadow' : 'gate-prewarm-shadow-unmeasured',
          { cutSha: commit, ...snapshot });
      } catch (error) {
        debug.log('pod.pool', 'gate-prewarm-shadow-unmeasured', { cutSha: commit, reason: String(error) });
      }
    }
    const rulesBaseSha = await rulesGateBaseFor(commit, files);
    const installSlots = pod.installSlots ?? POD_INSTALL_SLOTS_DEFAULT;
    if (!Number.isSafeInteger(installSlots) || installSlots < 0) throw new Error('invalid pod recheck install slots');
    const bunCache = pod.bunCache?.trim() || process.env[POD_BUN_CACHE_HOST_PATH]?.trim();
    const attemptId = randomUUID();
    const partLimitSeconds = Math.ceil(timeoutMs / 1000);
    const deadlineSeconds = partLimitSeconds * Math.ceil(files.length / 2) + POD_SHARD_EMIT_RESERVE_SECONDS + 60;
    const shell = gateShardShell({ parts: files.map((file) => [file]), cdpPatterns: [], softSeconds: softDeadlineSeconds(deadlineSeconds),
      cachePrefix: bunCache ? podBunCacheVolume(bunCache).shellPrefix : '', installSlots, parallelParts: files.length > 1 ? 2 : 1,
      ...(pod.externalVolumeRefs?.some(({ kind }) => kind === 'node_modules') ? { depsDir: GATE_VOLUME_REF_MOUNT_PATH.node_modules } : {}),
      partLimitSeconds, sourceBinding: { cutSha: commit, attemptId }, ...(rulesBaseSha ? { rulesBaseSha } : {}), ...(relaxed ? { testTimeoutMs: GATE_TIMEOUT_RECHECK_MS } : {}) });
    const warmEligible = !pod.externalVolumeRefs?.length && files.length === 1 && pod.warmEligible === true && !!pod.warmReplay && !!pod.warmQuarantine && !!pod.warmFinalize
      && pod.warmCutSha === commit;
    let expectedLockHash: string | undefined;
    if (warmEligible) {
      try {
        const lock = await command('git', ['show', `${commit}:bun.lock`], repo);
        if (lock.rc === 0 && lock.output) expectedLockHash = createHash('sha256').update(lock.output).digest('hex');
      } catch { /* Without the source-bound lock hash the production provider must fall back. */ }
    }
    const warmSelection = { kind: 'gate' as const, ...(expectedLockHash ? { lockHash: expectedLockHash } : {}),
      ...(pod.pinnedImageDigest ? { imageDigest: pod.pinnedImageDigest } : {}),
      ...(pod.executionIdentity?.architecture ? { runtimeContract: { baseImageDigest: pod.executionIdentity.baseImageDigest,
        bunVersion: pod.executionIdentity.bunVersion, os: 'linux' as const,
        architecture: pod.executionIdentity.architecture, requiredTools: [] } } : {}),
      runtimeIdentity: { baseImageDigest: pod.executionIdentity?.baseImageDigest ?? '', lockHash: expectedLockHash ?? '',
        os: pod.executionIdentity?.platform ?? '', architecture: pod.executionIdentity?.architecture ?? '',
        bunVersion: pod.executionIdentity?.bunVersion ?? '' } };
    const warmRequest = warmEligible && pod.warmProducerEnabled && pod.warmReplayOwner !== false ? { protocol: 1 as const, runId: randomUUID(), attemptId, cutSha: commit,
      ...(pod.warmBaselineSha ? { baselineSha: pod.warmBaselineSha } : {}), deadlineAt: Date.now() + timeoutMs + 60_000,
      files, envProfile: 'gate-v1' } : undefined;
    const replay = warmRequest ? await pod.warmReplay!(warmRequest, warmSelection) : undefined;
    const leased = replay?.command;
    let closed = false;
    const quarantine = async (reason: string) => {
      if (!leased || closed) return;
      await pod.warmQuarantine!(leased, reason);
      closed = true;
    };
    let producer: RunPodCommandOptions['warmProducer'];
    if (leased && replay?.transport.status === 'observed' && replay.transport.reason === 'complete') {
      if (warmCommandMatchesRequest(leased, warmRequest!) && leased.podName && leased.podUid
        && leased.podContext && leased.image?.endsWith(`@${leased.key.imageDigest}`)
        && (!pod.pinnedImageDigest || (normalizeGateImageDigest(pod.pinnedImageDigest) !== null
          && normalizeGateImageDigest(leased.key.imageDigest) === normalizeGateImageDigest(pod.pinnedImageDigest)))) {
        producer = { pod: leased.podName, podUid: leased.podUid, context: leased.podContext, image: leased.image,
          commit, files: ['package.json', 'bun.lock'] };
      } else await quarantine('gate-producer-identity');
    }
    let job: PodCommandResult;
    const recheckJobName = `gate-recheck-${randomUUID()}`;
    const recheckMeasurementRow = pod.externalVolumeRefs?.length ? {
      sweepId: measurementSweepId, cutSha: commit, phase: 'recheck' as const, shard: `recheck-${files.join(',')}`,
      attemptId, host: producer?.context ?? null, job: null, attemptedJobName: recheckJobName, launchState: 'not-started',
      ...gateExternalVolumeMeasurements(pod.externalVolumeRefs, [], []),
    } : undefined;
    if (recheckMeasurementRow) volumeRefMeasurementRows.push(recheckMeasurementRow);
    try {
      job = await runPod({ pool: pod.pool, ...(poolOverride ? { poolScheduler: poolOverride } : {}), clone: true,
      provenanceGate: true,
      provenance: { actorKind: process.env.ELANOUS_SEAT ? 'seat' : 'loop', actor: process.env.ELANOUS_SEAT || 'release-loop',
        character: 'gate-shard-runner', launchHost: hostname(), entrance: 'release-recheck', kind: 'gate-recheck',
        run: process.env.ELANOUS_RUN_ID || attemptId, phase: 'release-gate', requestedAt: new Date().toISOString(),
        graphNode: 'gate-triage', commit, reason: `release gate recheck ${files.length} files`, pool: pod.pool,
        memReq: POD_ISOLATION_MEMORY_LIMIT, warmReused: !!producer },
      source: { kind: 'commit', sha: commit, ...(rulesBaseSha ? { baseSha: rulesBaseSha } : {}) }, deadlineSeconds, ...(producer ? { warmProducer: producer, image: producer.image } : {}),
      ...(producer || pod.pinnedImageDigest || pod.pinnedRunId ? { imageCommit: commit } : {}),
      ...(pod.pinnedImageDigest || pod.pinnedRunId ? { syncImages: pinnedGateImageSync(pod, commit)! } : {}),
      ...(pod.gateBaseImageDigest !== undefined ? { gateBaseImageDigest: pod.gateBaseImageDigest } : {}),
      ...(bunCache ? { bunCache } : {}),
      ...(pod.externalVolumeRefs?.length ? { externalVolumeRefs: pod.externalVolumeRefs } as Partial<RunPodCommandOptions> : {}),
      ...(pod.externalVolumeRefs?.length ? { externalVolumeExpectations: (() => {
        const lockSha256 = gateCutLockfileHashes.get(commit);
        if (!pod.pinnedImageDigest || !lockSha256 || !/^[0-9a-f]{64}$/u.test(lockSha256)) {
          throw new Error('gate recheck external volume identity unavailable');
        }
        return { imageDigest: pod.pinnedImageDigest, lockSha256, sourceCommit: commit };
      })() } as Partial<RunPodCommandOptions> : {}),
      ...gateHostMirror(pod),
      ...(installSlots > 0 ? { installSlots: POD_INSTALL_SLOTS_HOST_PATH } : {}), ...(pod.cpu ? { cpu: pod.cpu } : {}),
      memoryLimit: POD_ISOLATION_MEMORY_LIMIT, name: recheckJobName, command: ['bash', '-lc', shell] });
      if (recheckMeasurementRow) Object.assign(recheckMeasurementRow, { job: job.job, attemptedJobName: job.job, launchState: 'job-created',
        host: job.context ?? producer?.context ?? recheckMeasurementRow.host,
        volumeRefSnapshotPreparationMs: job.externalVolumeSnapshotMs ?? 0,
        volumeRefPreparationMs: job.externalVolumeSnapshotMs ?? 0 });
    } catch (error) {
      const launched = podCommandJobFailureInfo(error);
      if (launched && recheckMeasurementRow) {
        Object.assign(recheckMeasurementRow, { attemptedJobName: launched.job, launchState: launched.launchState,
          ...(launched.launchState !== 'preflight-failed' ? { job: launched.job } : {}),
          host: launched.context ?? recheckMeasurementRow.host,
          volumeRefSnapshotPreparationMs: launched.externalVolumeSnapshotMs ?? 0,
          volumeRefPreparationMs: launched.externalVolumeSnapshotMs ?? 0 });
        if (launched.launchState === 'preflight-failed') recheckMeasurementRow.job = null;
        let volumeOutput = '';
        try {
          const path = join(launched.artifactsDir, 'external-volume-ref.log');
          if (existsSync(path)) volumeOutput = readFileSync(path, 'utf8');
          if (launched.context && launched.launchState !== 'preflight-failed') {
            const logs = kubectl(['--context', launched.context, '-n', 'elanous-test', 'logs', `job/${launched.job}`, '-c', 'child', '--tail=-1']);
            if (logs.status === 0 && logs.stdout) volumeOutput = logs.stdout;
          }
        } catch { /* keep attempt count and timing even when log collection fails */ }
        Object.assign(recheckMeasurementRow, gateExternalVolumeMeasurements(pod.externalVolumeRefs ?? [],
          parseGateExternalVolumeReadyEvents(volumeOutput), parseGateExternalVolumeRejectedEvents(volumeOutput), launched.externalVolumeSnapshotMs ?? 0));
      }
      if (pod.externalVolumeRefs?.length) logExternalVolumeCutSummary(commit, measurementSweepId, 'recheck', 'recheck-job-failed', pod.externalVolumeRefs);
      await quarantine('gate-job-failed');
      throw error;
    }
    try {
    if (pod.externalVolumeRefs?.length) {
      let artifactOutput = '';
      let fullJobLogs = '';
      let fullJobLogsFetched = false;
      let tailFallback = '';
      try {
        const volumeRefLogPath = join(job.artifactsDir, 'external-volume-ref.log');
        if (existsSync(volumeRefLogPath)) artifactOutput = readFileSync(volumeRefLogPath, 'utf8');
        for (const context of [...new Set([...(job.context ? [job.context] : []), ...parsePodPool(pod.pool).map((member) => member.context)])]) {
          const logs = kubectl(['--context', context, '-n', 'elanous-test', 'logs', `job/${job.job}`, '-c', 'child', '--tail=-1']);
          if (logs.status === 0) { fullJobLogs = logs.stdout; fullJobLogsFetched = true; break; }
        }
        if (!fullJobLogsFetched && !artifactOutput && podLogTail) {
          try { tailFallback = podLogTail(job); } catch { /* artifact remains the fallback */ }
        }
      } catch { /* missing logs remain an incomplete external-ref measurement */ }
      const volumeOutput = gateVolumeRefOutput(artifactOutput, fullJobLogsFetched, fullJobLogs, tailFallback);
      const volumeRefReady = parseGateExternalVolumeReadyEvents(volumeOutput);
      const volumeRefRejected = parseGateExternalVolumeRejectedEvents(volumeOutput);
      const volumeRefMetrics = gateExternalVolumeMeasurements(pod.externalVolumeRefs, volumeRefReady, volumeRefRejected, job.externalVolumeSnapshotMs ?? 0);
      if (recheckMeasurementRow) Object.assign(recheckMeasurementRow, { job: job.job, host: job.context ?? producer?.context ?? recheckMeasurementRow.host, ...volumeRefMetrics });
    }
    if (pod.pinnedImageDigest) {
      let actualDigest: string | null = null;
      if (tools.podImageDigest) {
        actualDigest = tools.podImageDigest({ job, host: job.context ?? producer?.context ?? 'unobserved' });
      } else if (!poolOverride) {
        // Rechecks launch through the pool scheduler too; find the Job in its configured
        // contexts so a recheck cannot silently escape the run-level image pin.
        const contexts = [...new Set([...(job.context ? [job.context] : []), ...parsePodPool(pod.pool).map((member) => member.context)])];
        const observed: string[] = [];
        for (const context of contexts) {
          try {
            const got = kubectl(['--context', context, '-n', 'elanous-test', 'get', 'pods', '-l', `job-name=${job.job}`, '-o', 'json']);
            if (got.status !== 0) continue;
            const digest = actualGatePodImageDigest(got.stdout);
            if (digest) observed.push(digest);
          } catch { /* inability to observe is rejected below */ }
        }
        if (new Set(observed).size === 1) actualDigest = observed[0]!;
      }
      if (actualDigest !== pod.pinnedImageDigest) {
        debug.log('release-loop.gate', 'image-pin-mismatch', { runId: pod.pinnedRunId ?? null,
          job: job.job, phase: 'recheck', host: job.context ?? producer?.context ?? null,
          pinnedDigest: pod.pinnedImageDigest, actualDigest, decision: 'reject-job' }, { level: 'error' });
        await quarantine('gate-image-pin-mismatch');
        throw new Error(`gate image pin mismatch: expected ${pod.pinnedImageDigest}, got ${actualDigest ?? 'unmeasured'} (recheck)`);
      }
    }
      const artifact = (name: string) => {
        const path = join(job.artifactsDir, name);
        return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
      };
    const installed = artifact('install.rc')?.trim() === '0';
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
    if (warmEligible && !pod.warmProducerEnabled && pod.warmReplay && pod.warmQuarantine && pod.warmFinalize) {
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
          const pendingReplay = Promise.resolve().then(() => pod.warmReplay!(request, warmSelection));
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
              cutSha: replay.command.cutSha, baselineSha: replay.command.baselineSha, workerKey: replay.command.key,
              leaseEvidence: { workerId: replay.command.workerId, leaseId: replay.command.leaseId, generation: replay.command.generation,
                expectedLockHash: replay.command.key.lockHash, workerLockHash: replay.transport.reply?.key?.lockHash ?? '',
                leaseValid: finalized, canaryPassed: decision.reason === 'match' && finalized, agree: decision.reason === 'match' } };
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
    if (producer && leased) {
      const reference = results.get(files[0]!)?.warmReference;
      const decision = job.exitCode === 0 && reference && !timedOut
        ? assessWarmWorkerShadow(leased, [reference], replay!.transport.reply) : null;
      if (decision?.reason !== 'match') await quarantine(decision?.reason ?? 'reference-unmeasured');
      else {
        await pod.warmFinalize!(leased);
        closed = true;
        pod.onWarmPodFinalized?.();
      }
    }
    if (pod.externalVolumeRefs?.length) logExternalVolumeCutSummary(commit, measurementSweepId, 'recheck', 'recheck-batch-complete', pod.externalVolumeRefs);
    return results;
    } catch (error) {
      if (pod.externalVolumeRefs?.length) logExternalVolumeCutSummary(commit, measurementSweepId, 'recheck', 'recheck-processing-failed', pod.externalVolumeRefs);
      await quarantine('gate-job-incomplete');
      throw error;
    }
  };
  return {
    command,
    localCommand: commandOverride && !remote ? commandOverride : localCommand,
    now: clock,
    async recheckPod(file, commit, pod, timeoutMs, relaxed = false) {
      return (await runPodRecheckBatch([file], commit, pod, timeoutMs, relaxed)).get(file)!;
    },
    recheckPodBatch: (files, commit, pod, timeoutMs) => runPodRecheckBatch(files, commit, pod, timeoutMs),
    get remoteMirror() { return remoteMirror; },
    set remoteMirror(path) { remoteMirror = path; },
    progressScheduler: tools.progressScheduler ?? scheduleGateProgress,
    ...(tools.startBisectSidecar ? { startBisectSidecar: tools.startBisectSidecar } : {}),
    async sweep(tree, logDir, pod, only, onProgress) {
      if (pod) return podSweep(tree, logDir, pod, only, onProgress);
      const listed = await command('git', ['ls-files', '*.test.*'], tree);
      check(listed, 'git ls-files tests');
      const allFiles = listed.output.split(/\r?\n/).filter((file) => /\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file));
      const onlySet = only ? new Set(only) : undefined;
      const missing = only?.filter((file) => !allFiles.includes(file)) ?? [];
      if (missing.length) throw new Error(`partial plan file missing at this commit: ${missing.slice(0, 5).join(', ')}`);
      let files = onlySet ? allFiles.filter((file) => onlySet.has(file)) : allFiles;
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
      const selectedGroups = groups.filter((group) => group.paths.length && files.some((f) => group.paths.some((p) => f === p || f.startsWith(`${p}/`))));
      const progressGroups: GateProgressGroup[] = selectedGroups.map((group) => ({ id: group.name, state: 'pending', ...(remote ? { host: remote } : {}) }));
      onProgress?.({ executor: 'host', groups: progressGroups });
      for (const group of selectedGroups) {
        const progress = progressGroups.find((item) => item.id === group.name)!;
        progress.state = 'running'; progress.startedAtMs = clock();
        onProgress?.({ executor: 'host', groups: progressGroups });
        const start = Date.now();
        const groupIgnores = [...new Set(cdpPatterns)]
          .filter((pattern) => files.includes(pattern) && group.paths.some((p) => pattern === p || pattern.startsWith(`${p}/`)))
          .flatMap((pattern) => ['--path-ignore-patterns', pattern]);
        let run: CommandResult;
        try { run = await command('bun', ['run', 'test:deterministic', ...groupIgnores, ...group.paths.map(asPath)], tree); }
        catch (error) {
          progress.state = 'failed'; progress.endedAtMs = clock();
          onProgress?.({ executor: 'host', groups: progressGroups });
          throw error;
        }
        progress.state = run.timedOut ? 'timeout' : run.rc === 0 ? 'done' : 'failed'; progress.endedAtMs = clock();
        onProgress?.({ executor: 'host', groups: progressGroups });
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

class InvalidPodSweepOptionsError extends Error {
  constructor() {
    super('invalid pod sweep options');
    this.name = 'InvalidPodSweepOptionsError';
  }
}

function assertValidPodSweepOptions(opts: GateOptions): void {
  if (opts.pod && (!opts.pod.pool || !Number.isSafeInteger(opts.pod.shards ?? 24) || (opts.pod.shards ?? 24) < 1
    || !Number.isSafeInteger(opts.pod.shardTimeoutSeconds ?? 1200) || (opts.pod.shardTimeoutSeconds ?? 1200) < 1)) {
    throw new InvalidPodSweepOptionsError();
  }
}

export async function judgeGate(opts: GateOptions, runner?: GateRunner,
  imageProbe: typeof preflightGateImageDigest = preflightGateImageDigest,
  identityProbe: typeof preflightGateExecutionIdentity = preflightGateExecutionIdentity,
  syncImages: typeof syncPoolImages = syncPoolImages): Promise<GateResult> {
  const needsDefaultCutSnapshot = runner === undefined;
  const runnerFactory = (opts as GateOptions & { gateRunnerFactoryForTest?: typeof createGateRunner }).gateRunnerFactoryForTest ?? createGateRunner;
  runner ??= runnerFactory(opts.repo ?? process.cwd(), opts.remote, undefined, undefined, undefined, undefined, { graphRunId: opts.graphRunId ?? null });
  if (opts.pod?.warmReplay) opts = { ...opts, pod: { ...opts.pod,
    warmShadowScope: { requested: false, attempts: 0 } } };
  if (opts.pod?.shardsFile?.ledgerPath) {
    const priorLedger = readGateShardLedger(opts.pod.shardsFile.ledgerPath);
    if (priorLedger?.trailingPartial || (priorLedger?.malformed ?? 0) > 0)
      throw new Error('remote gate refused: HQ shard ledger contains an unterminated or malformed JSONL row');
  }
  const explicitConfig = getElanousConfigDirOverride();
  const root = opts.scratchOnly ? (opts.instanceRoot ?? effectiveInstanceRoot())
    : explicitConfig ? effectiveInstanceRoot() : (opts.instanceRoot ?? effectiveInstanceRoot());
  // The freeze is read from the same root the gate runs in (a config-dir override must not move it elsewhere).
  const frozen = readLandingFreeze(root);
  if (frozen) {
    debug.log('release.run', opts.forceFreeze ? 'freeze-forced' : 'frozen', { version: opts.version, reason: frozen.reason, until: frozen.until, node: 'gate' });
    if (!opts.forceFreeze) throw new Error(landingFreezeMessage(frozen));
  }
  // GATE-FLOW-SIM — the injected clock (absent = `Date.now`), read only after the freeze check: a frozen gate must not
  // touch its runner at all (a refusal is decided before any side effect).
  const clock = runner.now ?? Date.now;
  const start = clock();
  const ledger = opts.scratchOnly ? (opts.ledgerRoot ?? root) : explicitConfig ? root : (opts.ledgerRoot ?? releaseLedgerRoot());
  const roots = opts.scratchOnly ? [root] : [...new Set([ledger, root])];
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
  const timeoutBaselineUnmeasurableIds = new Set<string>();
  const timeoutBaselineMeasuredIds = new Set<string>();
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
  const baselineVersion = opts.baselineVersion;
  try {
    if (!sha.test(opts.commit) || !versionPattern.test(opts.version)
      || (opts.baselineVersion && !versionPattern.test(opts.baselineVersion))
      || (opts.baselineCommit && !sha.test(opts.baselineCommit))) throw new Error('invalid commit or version');
    if (!baselineVersion) throw new Error('previous release version required (--baseline-version)');
    // The cut snapshot is the only Git object read surface used by planning consumers in this process.
    if (opts.rehearsalBaseline && (opts.graphRunId || !opts.pod || !/-rc\.\d+$/.test(opts.version)))
      throw new Error('rehearsal baseline requires a direct Pod gate with an isolated rc version');
    // Observation only. Failure to plan cannot change the gate selector or verdict.
    try { radiusShadow = planGateRadiusShadow({ repo, ledgerRoot: ledger, version: opts.version,
      baselineVersion, forCommit: opts.commit, instanceRoot: root,
      expectedBaselineCommit: opts.baselineCommit }); }
    catch (error) { debug.log('release-loop.gate', 'radius-shadow-unavailable', { reason: String(error) }); }
    if (!Number.isSafeInteger(opts.recheckFileLimit ?? GATE_HOST_RECHECK_FILE_LIMIT) || (opts.recheckFileLimit ?? GATE_HOST_RECHECK_FILE_LIMIT) < 1)
      throw new Error('invalid gate recheck file limit');
    assertValidPodSweepOptions(opts);
    if (opts.pod && (opts.graphRunId || opts.rehearsalBaseline)) {
      const components = opts.pod.pool.split(',').map((part) => part.trim()).filter(Boolean);
      const members = parsePodPool(opts.pod.pool);
      const memberSpecs = members.map((member) => {
        const spec = components.find((part) => part.split(/[@:#]/, 1)[0] === member.context);
        if (!spec) throw new Error(`gate image pin cannot map pool member ${member.context}`);
        return { context: member.context, spec };
      });
      const poolImages = new Map<string, readonly string[]>();
      const currentImages: Record<string, string | null> = {};
      for (const member of memberSpecs) {
        const digest = imageProbe(member.spec, opts.commit);
        currentImages[member.context] = digest;
        poolImages.set(member.context, digest ? [digest] : []);
      }
      // A scheduled hard rehearsal is a direct Pod gate with its own unique rc version, not a graph run.
      // The version is stable across a retry of that rehearsal and scopes its immutable image pin.
      const pinRunId = opts.graphRunId ?? opts.version;
      const pinPath = gateImagePinPath(root, opts.version, pinRunId);
      const gateImageTag = `${podCommandImageFor([], true).split(':')[0]}:${opts.commit.slice(0, 12)}`;
      let savedPin: ReturnType<typeof readGateImagePin>;
      let supersededPin: ReturnType<typeof readGateImagePinForRun> = null;
      let stalePinNeedsSuperseding = false;
      try { savedPin = existsSync(pinPath) ? readGateImagePin(pinPath, pinRunId, gateImageTag, opts.commit) : null; }
      catch (error) {
        let prior: ReturnType<typeof readGateImagePinForRun> = null;
        try { prior = readGateImagePinForRun(pinPath, pinRunId, gateImageTag); } catch { /* Keep invalid or corrupt pins fail-closed. */ }
        if (!prior || prior.commit === opts.commit.toLowerCase()) {
          debug.log('release-loop.gate', 'image-pin', { runId: pinRunId, currentImages, decision: 'fail-closed',
            reason: 'saved-image-pin-invalid', error: String(error).slice(0, 300) }, { level: 'error' });
          throw new Error('gate resume refused: saved image digest pin is invalid');
        }
        supersededPin = prior;
        stalePinNeedsSuperseding = true;
        savedPin = null;
        debug.log('release-loop.gate', 'image-pin', { runId: pinRunId, currentImages, decision: 'stale-tip-detected',
          priorCommit: supersededPin.commit, nextCommit: opts.commit.toLowerCase() });
      }
      const savedDigest = savedPin?.digest ?? null;
      let previouslyExecuted = false;
      if (opts.graphRunId) {
        // A gate's immutable pin is written before any Pod work. The graph state is only a legacy-run detector:
        // if it already records an executed gate but this pin does not exist, resume cannot safely invent one.
        const runPath = join(root, 'graph-runs', 'release-loop', `${opts.graphRunId}.json`);
        if (existsSync(runPath)) {
          try {
            const prior = JSON.parse(readFileSync(runPath, 'utf8')) as { nodes?: Array<{ nodeId?: unknown; executed?: unknown }> };
            previouslyExecuted = prior.nodes?.some((node) => node.nodeId === 'gate' && node.executed === true) ?? false;
          } catch { previouslyExecuted = true; }
        }
      }
      if (!savedDigest && previouslyExecuted && !supersededPin && !opts.imagePinPrepareOnly) {
        debug.log('release-loop.gate', 'image-pin', { runId: pinRunId, savedDigest: null, currentImages,
          decision: 'fail-closed', reason: 'resume-pin-missing' }, { level: 'error' });
        throw new Error('gate resume refused: saved image digest pin is missing');
      }
      const hasPoolImage = [...poolImages.values()].some((images) => images.some((image) => normalizeGateImageDigest(image) !== null));
      if (!savedDigest && !hasPoolImage) {
        let syncResults: Awaited<ReturnType<typeof syncPoolImages>>;
        const imageSourceRoot = mkdtempSync(join(tmpdir(), 'release-gate-image-source-'));
        const imageSourceTree = join(imageSourceRoot, 'cut');
        const stopImageSyncWatch = startReleaseStageStallWatch({ runId: pinRunId, nodeId: 'gate' }, {
          graphId: opts.graphId ?? '', dryRun: opts.dryRun === true,
        });
        try {
          check(await runner.localCommand('git', ['clone', '--quiet', '--shared', '--no-checkout', repo, imageSourceTree], repo), 'gate image source clone');
          check(await runner.localCommand('git', ['checkout', '--quiet', '--detach', opts.commit], imageSourceTree), 'gate image source checkout');
          syncResults = await syncImages(members, podCommandImageFor([], true), opts.commit, {
            buildScript: join(imageSourceTree, 'docker', 'harness', 'build.sh'),
          });
        } catch (error) {
          debug.log('release-loop.gate', 'image-pin', { runId: pinRunId, decision: 'fail-closed',
            reason: 'initial-image-sync-failed', error: String(error).slice(0, 300) }, { level: 'error' });
          throw new Error(`gate image pin refused: initial image sync failed (${String(error).slice(0, 300)})`);
        } finally {
          stopImageSyncWatch();
          rmSync(imageSourceRoot, { recursive: true, force: true });
        }
        const failedSyncs = memberSpecs.filter((member) => !syncResults.get(member.context)?.ok);
        if (failedSyncs.length) {
          debug.log('release-loop.gate', 'image-pin', { runId: pinRunId, decision: 'fail-closed', reason: 'initial-image-sync-failed',
            failed: failedSyncs.map((member) => ({ context: member.context, result: syncResults.get(member.context) ?? null })) }, { level: 'error' });
          throw new Error('gate image pin refused: initial image sync failed');
        }
        for (const member of memberSpecs) {
          const digest = imageProbe(member.spec, opts.commit);
          currentImages[member.context] = digest;
          poolImages.set(member.context, digest ? [digest] : []);
        }
        debug.log('release-loop.gate', 'image-pin', { runId: pinRunId, decision: 'initial-image-sync',
          outcomes: [...syncResults].map(([context, result]) => ({ context, ok: result.ok, action: result.action })), currentImages });
      }
      const resolution = resolveGateImagePin({ ...(savedDigest ? { savedDigest } : {}),
        ...(!savedDigest ? { initialDigest: [...poolImages.values()].flat().find(Boolean) ?? null } : {}), poolImages });
      if (!resolution.ok) {
        debug.log('release-loop.gate', 'image-pin', { runId: pinRunId, savedDigest, currentImages,
          decision: 'fail-closed', reason: resolution.reason }, { level: 'error' });
        throw new Error(`gate image pin refused: ${resolution.reason}`);
      }
      const mismatchedPools = mismatchedGateRosterImagePools(poolImages, resolution.digest);
      if (mismatchedPools.length) {
        debug.log('release-loop.gate', 'image-pin', { runId: pinRunId, savedDigest, currentImages,
          decision: 'fail-closed', reason: 'pool-image-digest-mismatch', mismatchedPools }, { level: 'error' });
        throw new Error(`gate image pin refused: pool image digest mismatch (${mismatchedPools.join(', ')})`);
      }
      const selected = memberSpecs.filter((member) => resolution.eligiblePools.includes(member.context));
      if (!selected.length) throw new Error('gate image pin refused: no eligible pool');
      const selectedPool = selected.map((member) => member.spec).join(',');
      const labeledDependencyDigest = preflightGateBaseImageDigest(selectedPool, opts.commit, resolution.digest);
      // The exact pinned image must report the same dependency identity at runtime before it can authorize reuse.
      const probedIdentity = labeledDependencyDigest
        ? preflightGateExecutionIdentity(selectedPool, process.env, opts.commit, resolution.digest) : null;
      const baseImageDigest = setPinnedGateBaseImageDigest(probedIdentity?.baseImageDigest === labeledDependencyDigest
        ? labeledDependencyDigest : null);
      if (!baseImageDigest) debug.log('release-loop.gate', 'base-image-identity-unavailable', {
        runId: pinRunId, imageDigest: resolution.digest, decision: 'warm-reuse-disabled', reason: 'pinned-image-label-missing-or-mismatched',
      }, { level: 'warn' });
      if (!savedDigest) {
        try {
          if (stalePinNeedsSuperseding) {
            replaceGateImagePin(pinPath, pinRunId, resolution.digest, gateImageTag, opts.commit, gateImageTag, supersededPin!.commit);
          } else writeGateImagePin(pinPath, pinRunId, resolution.digest, gateImageTag, opts.commit);
        }
        catch (error) {
          debug.log('release-loop.gate', 'image-pin', { runId: pinRunId, pinnedDigest: resolution.digest,
            currentImages, decision: 'fail-closed', reason: 'pin-write-failed', error: String(error).slice(0, 300) }, { level: 'error' });
          throw error;
        }
      }
      opts = { ...opts, pod: { ...opts.pod, pool: selected.map((member) => member.spec).join(','),
        pinnedImageDigest: resolution.digest, pinnedRunId: pinRunId, gateBaseImageDigest: baseImageDigest } };
      debug.log('release-loop.gate', 'image-pin', { runId: pinRunId, pinnedDigest: resolution.digest,
        currentImages, eligiblePools: resolution.eligiblePools, excludedPools: members.map((member) => member.context)
          .filter((context) => !resolution.eligiblePools.includes(context)), decision: savedDigest ? 'resume-pinned' : 'pin-created' });
    } else if (opts.pod) {
      debug.log('release-loop.gate', 'image-pin-unscoped', { runId: null, decision: 'not-applicable',
        reason: 'direct-pod-gate-without-graph-run-id' });
    }
    if (opts.imagePinPrepareOnly) {
      const pin = opts.pod?.pinnedImageDigest;
      if (!opts.pod || !opts.graphRunId || !pin || opts.pod.pinnedRunId !== opts.graphRunId)
        throw new Error('image repair did not produce a run-scoped cut pin');
      return { outcome: 'ok', commit: opts.commit, introduced: [], preexisting: 0, fixed: null, knownEnv: 0,
        knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: Math.max(0, clock() - start),
        imagePin: 'cut-commit', imagePinRunId: opts.graphRunId,
        imagePinDigest: pin };
    }
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
      const baseSha = opts.baselineCommit ?? baselineReleaseCommit(baselineVersion);
      cachedBaseline(baselineVersion, baseSha);
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
    const explicitPartial = opts.full ? null : partialRead.plan;
    const rehearsalStampPresent = ['hard-5h', 'hard-mid'].some((step) =>
      existsSync(join(root, 'release', opts.version, 'rehearsal', `${step}.json`)));
    const currentIdentity = !opts.full && !explicitPartial && opts.graphRunId && opts.pod
      ? identityProbe(opts.pod.pool, process.env, opts.commit) : null;
    const currentImage = currentIdentity?.imageDigest ?? (!opts.full && !explicitPartial
      && opts.graphRunId && opts.pod ? imageProbe(opts.pod.pool, opts.commit) : null);
    const receiptImage = currentImage ?? (opts.graphRunId && opts.pod && process.env.ELANOUS_GRAPH_CONTEXT
      ? imageProbe(opts.pod.pool, opts.commit) : null);
    const receiptBase = opts.baselineCommit ?? (roots.some((location) =>
      existsSync(join(location, 'release', baselineVersion, 'release.json')))
      ? baselineReleaseCommit(baselineVersion) : undefined);
    const radius = !opts.full && !explicitPartial && opts.graphRunId && opts.pod && rehearsalStampPresent
      ? planHardRehearsalRadius({ root, repo, version: opts.version, forCommit: opts.commit,
        graphPins: gateGraphPins(root, opts.graphRunId), envFingerprint: gateEnvFingerprint(process.env), imageDigest: currentImage,
        executionIdentity: currentIdentity })
      : null;
    if (radius) debug.log('release-loop.gate', 'radius-live-plan', { version: opts.version, reason: radius.reason,
      files: radius.plan?.files.length ?? null, rehearsalRunId: radius.rehearsalRunId ?? null });
    let partial = opts.full ? null : explicitPartial ?? radius?.plan ?? null;
    if (radius) {
      const rehearsalPlanSelected = radius.plan !== null && partial === radius.plan;
      result.rehearsalReceiptDecision = rehearsalPlanSelected
        ? { action: radius.plan!.kind === 'carry' ? 'reuse-zero' : 'partial-rerun', reason: radius.reason }
        : { action: opts.full ? 'full-sweep' : 'not-selected', reason: opts.full ? 'explicit full-sweep option' : explicitPartial ? 'explicit partial plan takes precedence' : radius.reason };
    }
    // Build once after input/remote validation and before any shard assignment or receipt planning.
    if (needsDefaultCutSnapshot) createCutSnapshot(repo, opts.commit, join(ledger, 'cut-snapshots'));
    let trainReceiptPlan: ReturnType<typeof planGateTrainReceiptCarry> = null;
    if (!opts.full && !partial && opts.graphRunId && opts.pod) {
      const receiptPath = gateReceiptRegistryPath(repo);
      const bun = spawnSync('bun', ['--version'], { cwd: repo, encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER });
      if (receiptPath && bun.status === 0 && !bun.error) {
        try {
          trainReceiptPlan = planGateTrainReceiptCarry({ repo, commit: opts.commit, receiptPath,
            bunVersion: bun.stdout.trim(), lockfileHash: gateLockfileHash(repo), envFingerprint: gateReceiptEnvFingerprint(process.env) });
          if (trainReceiptPlan?.carriedFiles.length) partial = { version: opts.version, priorCommit: trainReceiptPlan.priorCommit,
            forCommit: opts.commit, files: trainReceiptPlan.files, priorFailures: [], priorErrors: [] };
        } catch (error) {
          debug.log('release-loop.gate', 'train-receipt-plan-failed', { version: opts.version, reason: String(error).slice(0, 240) });
        }
      }
      // The same graph run's previous formal gate is the fallback when train receipts cannot carry.
      // Diff paths are resolved through imports and literal file consumers; unverifiable closure fails closed.
      let formalReceiptFallback: { priorCommit: string; files: string[]; priorFailures: string[]; priorErrors: string[] } | null = null;
      const formalReceiptRoot = join(ledger, 'release', opts.version, 'gate-logs', 'cut', 'receipts');
      const formalNames = existsSync(formalReceiptRoot) ? readdirSync(formalReceiptRoot).filter((name) => /^pod-\d+\.receipt\.json$/.test(name)) : [];
      const formalRows = formalNames.sort((a, b) => Number(a.slice(4).split('.')[0]) - Number(b.slice(4).split('.')[0]))
        .map((name) => readGateShardManifest(formalReceiptRoot, name.replace('.receipt.json', '')));
      const priorHead = formalRows[0]?.head40;
      let formalInventoryReason = 'formal-receipt-test-inventory-unreadable';
      let formalInventoryComplete = false;
      let formalPayloadComplete = false;
      if (priorHead && formalRows.length) {
        try {
          const priorTests = gateAssignableTestsAtCommit(repo, priorHead);
          const receiptFiles = formalRows.flatMap((row) => row?.files ?? []);
          formalInventoryComplete = !!priorTests
            && formalRows.every((row, index) => row?.id === 'pod-' + index && row.status === 'complete')
            && new Set(receiptFiles).size === receiptFiles.length
            && JSON.stringify([...receiptFiles].sort()) === JSON.stringify([...(priorTests ?? [])].sort());
          formalInventoryReason = priorTests ? 'formal-receipt-shard-inventory-incomplete' : formalInventoryReason;
          formalPayloadComplete = formalInventoryComplete && formalRows.every((row) => !!row
            && !!readGateShardResult(formalReceiptRoot, { shard: row, head40: row.head40, base40: row.base40, envKey: row.envKey }));
        } catch { formalInventoryComplete = false; formalPayloadComplete = false; }
      }
      const formalIdentity = currentIdentity && currentImage ? { ...currentIdentity, imageDigest: currentImage } : null;
      let formalReason = formalReceiptSetPresenceReason(formalRows.length)
        ?? (formalRows.some((row) => !row || row.status !== 'complete') ? 'formal-receipt-set-incomplete'
        : formalRows.some((row) => row!.version !== opts.version) ? 'formal-receipt-version-mismatch'
        : !formalInventoryComplete ? formalInventoryReason
        : !formalPayloadComplete ? 'formal-receipt-payload-incomplete'
        : formalRows.some((row) => row!.graphRunId !== opts.graphRunId) ? 'formal-receipt-run-id-missing-or-mismatch'
        : !receiptBase ? 'formal-receipt-base40-unmeasured'
        : formalRows.some((row) => row!.base40 !== receiptBase) ? 'formal-receipt-base40-mismatch'
        : !gateGraphPins(root, opts.graphRunId) ? 'formal-receipt-graph-pins-unmeasured'
        : formalRows.some((row) => !/^[a-f0-9]{64}$/i.test(row!.graphSha) || !/^[a-f0-9]{64}$/i.test(row!.recipeSha)
          || row!.graphSha !== formalRows[0]!.graphSha || row!.recipeSha !== formalRows[0]!.recipeSha) ? 'formal-receipt-graph-pins-missing-or-mixed'
        : !gateShardRecipeIdentityAtCommit(repo, opts.commit) ? 'formal-receipt-recipe-identity-unmeasured'
        : formalRows.some((row) => !row!.graphEntry || !row!.recipeCommand || !Number.isSafeInteger(row!.recipeTimeoutMs)
          || row!.graphEntry !== formalRows[0]!.graphEntry || row!.recipeCommand !== formalRows[0]!.recipeCommand
          || row!.recipeTimeoutMs !== formalRows[0]!.recipeTimeoutMs) ? 'formal-receipt-recipe-identity-missing-or-mixed'
        : !formalIdentity ? 'current-image-or-runtime-unmeasured'
        : formalRows.some((row) => row!.head40 !== priorHead) ? 'formal-receipt-heads-mixed'
        : formalRows.some((row) => row!.runtimeIdentity?.baseImageDigest !== formalIdentity.baseImageDigest) ? 'formal-receipt-environment-baseImageDigest-mismatch'
        : formalRows.some((row) => row!.envFingerprint !== formalIdentity.envFingerprint
          || JSON.stringify(row!.runtimeIdentity) !== JSON.stringify({ bunVersion: formalIdentity.bunVersion, platform: formalIdentity.platform,
            architecture: formalIdentity.architecture, envFingerprint: formalIdentity.envFingerprint, baseImageDigest: formalIdentity.baseImageDigest })) ? 'formal-receipt-environment-mismatch'
        : formalRows.some((row) => row!.imageDigest !== formalRows[0]!.imageDigest) ? 'formal-receipt-image-set-mixed'
        : formalRows.some((row) => !gateRuntimeSourceFingerprint(repo, row!.head40, row!.runtimeIdentity)
          || gateRuntimeSourceFingerprint(repo, row!.head40, row!.runtimeIdentity) !== gateRuntimeSourceFingerprint(repo, opts.commit, formalIdentity))
          ? 'formal-receipt-runtime-fingerprint-mismatch'
        : 'formal-receipt-radius-unmeasured');
      result.formalReceiptDecision = formalReason;
      if (formalReason === 'formal-receipt-radius-unmeasured' && priorHead && priorHead !== opts.commit) {
        try {
          const tests = gateAssignableTestsAtCommit(repo, opts.commit);
          const changed = changedFilesBetween(repo, priorHead, opts.commit);
          if (!tests) formalReason = 'formal-receipt-test-inventory-unreadable';
          else {
            const closure = testsReachingChangedForGateReuse(gitClosureTree(repo, opts.commit), changed, tests);
            if (!closure.ok) formalReason = 'formal-receipt-radius-opaque:' + closure.reason;
            else if (!closure.tests.length) formalReason = 'formal-receipt-no-consumers';
            else {
              formalReceiptFallback = { priorCommit: priorHead, files: closure.tests,
                priorFailures: formalRows.flatMap((row) => row?.failureIds ?? []), priorErrors: formalRows.flatMap((row) => row?.errorIds ?? []) };
              formalReason = 'formal-receipt-radius-proven';
            }
          }
        } catch (error) { formalReason = 'formal-receipt-radius-error:' + String(error).slice(0, 160); }
      }
      const formalFallbackSelected = !partial && formalReceiptFallback !== null;
      if (formalFallbackSelected && formalReceiptFallback) {
        partial = { version: opts.version, priorCommit: formalReceiptFallback.priorCommit, forCommit: opts.commit,
          files: formalReceiptFallback.files, priorFailures: formalReceiptFallback.priorFailures, priorErrors: formalReceiptFallback.priorErrors };
      }
      debug.log('release-loop.gate', 'formal-receipt-fallback', { runId: opts.graphRunId, version: opts.version,
        priorCommit: priorHead ?? null, commit: opts.commit, reason: formalReason,
        changedFiles: priorHead && priorHead !== opts.commit ? (() => { try { return changedFilesBetween(repo, priorHead, opts.commit).length; } catch { return null; } })() : 0,
        selectedTests: formalReceiptFallback?.files.length ?? 0,
        carriedTests: formalReceiptFallback ? Math.max(0, formalRows.reduce((sum, row) => sum + (row?.files.length ?? 0), 0) - formalReceiptFallback.files.length) : 0,
        action: formalFallbackSelected ? 'radius-regate' : partial ? 'existing-plan-preserved' : 'full-sweep' });
      if (trainReceiptPlan) {
        result.trainReceiptReuse = { carried: trainReceiptPlan.carriedFiles.length, total: trainReceiptPlan.totalFiles,
          receipts: trainReceiptPlan.receipts.length, reasons: [...trainReceiptPlan.reasons, ...(formalReceiptFallback ? [formalReason] : [])] };
        debug.log('release-loop.gate', 'train-receipt-plan', { version: opts.version, commit: opts.commit,
          carried: trainReceiptPlan.carriedFiles.length, total: trainReceiptPlan.totalFiles,
          ratio: trainReceiptPlan.carriedFiles.length / trainReceiptPlan.totalFiles,
          receipts: trainReceiptPlan.receipts, selectedFiles: trainReceiptPlan.files.length,
          reasons: [...trainReceiptPlan.reasons, ...(formalReceiptFallback ? [formalReason] : [])], action: formalFallbackSelected ? 'formal-receipt-radius-regate' : partial ? 'existing-plan-preserved' : trainReceiptPlan.carriedFiles.length ? 'run-remaining-tests' : 'full-sweep' });
      } else if (!opts.full && !explicitPartial && !radius?.plan) {
        debug.log('release-loop.gate', 'train-receipt-plan', { version: opts.version, commit: opts.commit,
          carried: formalReceiptFallback ? Math.max(0, formalRows.reduce((sum, row) => sum + (row?.files.length ?? 0), 0) - formalReceiptFallback.files.length) : 0,
          total: formalReceiptFallback ? formalRows.reduce((sum, row) => sum + (row?.files.length ?? 0), 0) : null,
          ratio: formalReceiptFallback ? (formalRows.reduce((sum, row) => sum + (row?.files.length ?? 0), 0) - formalReceiptFallback.files.length) / Math.max(1, formalRows.reduce((sum, row) => sum + (row?.files.length ?? 0), 0)) : 0,
          receipts: formalReceiptFallback ? formalRows.length : [], selectedFiles: formalReceiptFallback?.files.length ?? null,
          reasons: formalReceiptFallback ? [formalReason] : ['no safe receipt coverage'], action: formalFallbackSelected ? 'formal-receipt-radius-regate' : partial ? 'existing-plan-preserved' : 'full-sweep' });
      }
    }
    const explicitPodPlan = !!explicitPartial && explicitPartial.kind !== 'recheck' && !!opts.pod;
    const explicitPodDigest = explicitPodPlan ? explicitPartial!.shardImageDigests?.[0] : undefined;
    const probedPodDigest = explicitPodDigest ? imageProbe(opts.pod!.pool, opts.commit) : null;
    if (explicitPodPlan && (!explicitPodDigest || probedPodDigest !== explicitPodDigest)) {
      debug.log('release-loop.gate', 'partial-image-preflight-fallback', { version: opts.version,
        reason: !explicitPodDigest || !probedPodDigest ? 'executed-pod-image-digest-missing' : 'executed-pod-image-digest-mismatch' }, { level: 'warn' });
      partial = null;
    }
    debug.log('release-loop.gate', partial ? 'partial-regate' : 'partial-fallback', {
      version: opts.version, priorCommit: partial?.priorCommit ?? null, commit: opts.commit,
      planKind: partial?.kind ?? 'full', remeasureFileCount: partial?.files.length ?? 0,
      preservedShardCount: partial?.kind === 'recheck' && 'preservedShardCount' in partial
        && typeof partial.preservedShardCount === 'number' ? partial.preservedShardCount : 0,
      fallbackReason: partial ? undefined : partialRead.fallbackReason,
    });
    const sameHeadRehearsalCarry = partial?.kind === 'carry' && radius?.plan === partial;
    if (partial?.kind === 'carry' && !sameHeadRehearsalCarry) {
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
        const knownSha = opts.baselineCommit ?? baselineReleaseCommit(baselineVersion);
        const saved = cachedBaseline(baselineVersion, knownSha)?.saved;
        const recorded = saved ? undefined : baselineFromCutLogs(join(ledger, 'release', baselineVersion, 'gate-logs', 'cut'), knownSha);
        const trustedKnown = saved ?? (recorded?.complete ? recorded : undefined);
        if (trustedKnown) knownFailures = [...trustedKnown.failures, ...(trustedKnown.errors ?? []), ...loadEnvKnownFailures(repo)];
      } catch (error) { debug.log('release-loop.gate', 'known-failures-unavailable', { error: String(error) }); }
    }
    const durationSource = join(ledger, 'release', baselineVersion, 'gate-logs', 'cut');
    const runCut = async (selected: typeof partial) => {
      if (selected?.kind === 'carry') return undefined;
      const progressFile = opts.graphRunId && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.graphRunId)
        ? join(ledger, 'graph-runs', 'release-loop', `${opts.graphRunId}.json.contexts`, 'gate-progress.jsonl') : undefined;
      const phaseSignatures = new Map<string, string>();
      let latest: GateSweepProgress | undefined;
      const emitProgress = () => {
        if (!latest) return;
        const nowMs = runner.now?.() ?? Date.now();
        for (const group of latest.groups) {
          const signature = gateProgressTransitionKey(group);
          if (phaseSignatures.get(group.id) === signature) continue;
          phaseSignatures.set(group.id, signature);
          const phase = group.rawState === 'retry' ? 'shard-retry'
            : group.state === 'pending' ? 'shard-planning' : `shard-${group.state}`;
          const phaseEvent = { phase, shard: group.id, shardIndex: latest.groups.indexOf(group) + 1,
            shardTotal: latest.groups.length, host: group.host ?? null,
            state: group.rawState ?? group.state, attemptId: group.attemptId ?? null,
            durationMs: group.startedAtMs === undefined ? null : Math.max(0, nowMs - group.startedAtMs),
            failureCount: group.failureCount ?? null, introduced: null, preexisting: null, unmeasured: null,
            runId: opts.graphRunId ?? null, at: new Date(nowMs).toISOString() };
          emitGatePhaseProgress(phase, phaseEvent);
        }
        const event = { version: opts.version, runId: opts.graphRunId ?? null, at: new Date(nowMs).toISOString(),
          ...summarizeGateProgress({ executor: latest.executor, groups: latest.groups, nowMs }) };
        debug.log('release-loop.gate', 'progress', event);
        if (progressFile) {
          try { mkdirSync(dirname(progressFile), { recursive: true }); appendFileSync(progressFile, `${JSON.stringify(event)}\n`, { mode: 0o600 }); }
          catch (error) { debug.log('release-loop.gate', 'progress-log-write-failed', { path: progressFile, error: String(error) }, { level: 'warn' }); }
        }
      };
      const cancel = (runner.progressScheduler ?? scheduleGateProgress)(emitProgress, 60_000);
      try {
        const sweepResult = await runner.sweep(cutTree,
      join(root, 'release', opts.version, 'gate-logs', selected ? 'cut-partial' : 'cut'),
      opts.pod ? { ...opts.pod, ...(opts.imagePin ? { imagePin: opts.imagePin } : {}), durationSource, ...(knownFailures.length ? { knownFailures } : {}), onSelectionTimed: ({ ms }) => { result.selectionMs = ms; },
        // GATE-RISK-LANE — the watch list is read from this gate's own ledgers (the instance root ⊕ the machine ledger);
        // the cut sweep puts those files first, the baseline sweep keeps its plan.
        riskWatch: { instanceRoots: roots, ledgerRoots: roots },
        // GATE-LIVE-OBS: the release ledger's shards.json (UX #24782) — never the run tree's universe; an explicit
        // --ledger-root or an explicit test instance keeps it in that ledger.
        shardsFile: { path: gateShardsPath(opts.version, ledger), version: opts.version,
          ledgerPath: gateShardLedgerPath(opts.version, opts.shardLedgerRoot ?? ledger), envFingerprint: gateEnvFingerprint(process.env),
          receiptRoot: join(ledger, 'release', opts.version, 'gate-logs', 'cut', 'receipts'),
          base40: receiptBase, ...(receiptBase ? { sameHeadPreexistingFailureIds: sameHeadPreexistingFailureIds(ledger, opts.version, opts.commit, receiptBase) } : {}),
          expectedImageDigest: receiptImage, graphPins: opts.pod.shardsFile?.graphPins ?? gateSourcePins(repo, opts.commit),
          executionIdentity: currentIdentity ?? opts.pod.shardsFile?.executionIdentity ?? null, ...(selected?.priorCommit ? { radiusPriorCommit: selected.priorCommit } : {}) } } : undefined,
      selected?.files, (progress) => { latest = progress; emitProgress(); });
        emitProgress();
        return sweepResult;
      } finally { cancel?.(); }
    };
    let cutRun = await runCut(partial);
    const radiusSelectionMatched = partial?.files && cutRun?.podSweep?.files
      && JSON.stringify([...partial.files].sort()) === JSON.stringify([...cutRun.podSweep.files].sort());
    if (radius?.plan && radius.plan.kind !== 'carry' && (!radiusSelectionMatched
      || !partialGateImagesMatch(root, opts.version, currentImage!, opts.commit, cutRun?.podSweep))) {
      debug.log('release-loop.gate', 'radius-live-image-drift', { version: opts.version,
        rehearsalRunId: radius.rehearsalRunId, action: 'full-sweep' }, { level: 'warn' });
      partial = null;
      cutRun = await runCut(null);
    }
    if (explicitPodDigest && partial === explicitPartial && (!radiusSelectionMatched
      || !partialGateImagesMatch(root, opts.version, explicitPodDigest, opts.commit, cutRun?.podSweep))) {
      debug.log('release-loop.gate', 'partial-image-drift', { version: opts.version, action: 'full-sweep' }, { level: 'warn' });
      partial = null;
      cutRun = await runCut(null);
    }
    if (radius?.plan && partial === radius.plan) debug.log('release-loop.gate', 'baseline-consumed', {
      version: opts.version, baselineCommit: radius.plan.priorCommit, commit: opts.commit,
      selectedFiles: radius.plan.files.length, rehearsalRunId: radius.rehearsalRunId,
    });
    cutSweepRc = cutRun?.rc ?? null;
    if (cutRun?.podSweep) debug.log('release-loop.gate', 'shard-ledger-summary', {
      version: opts.version, commit: opts.commit, invocationId: cutRun.podSweep.invocationId,
      disposition: cutRun.podSweep.disposition, shardCount: cutRun.podSweep.shards, fileCount: cutRun.podSweep.files.length,
    });
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
    let measuredCut: SweepFailures;
    try {
      measuredCut = cutRun ? await localStalled(cutRun, cutTree, opts.commit, 'cut') : { failures: [], errors: [] };
    } catch (error) {
      if (!(error instanceof GateFailureAttributionMismatch) || error.label !== 'cut sweep') throw error;
      const targetFiles = [...new Set(error.failures.map(fileOf))].sort();
      const attribution = { summary: error.summary, observed: error.observed, identified: error.identified,
        collapsed: error.collapsed, targetFiles,
        baselineResult: 'failed' as 'completed' | 'failed' | 'timeout' };
      result.attributionRecheck = attribution;
      debug.log('release-loop.gate', 'failure-attribution-baseline-recheck', { ...attribution, phase: 'started' });
      try {
        if (!targetFiles.length || targetFiles.length > GATE_ATTRIBUTION_RECHECK_FILE_LIMIT)
          throw new Error(`baseline recheck target count ${targetFiles.length} outside safe bound 1..${GATE_ATTRIBUTION_RECHECK_FILE_LIMIT}`);
        if (!work) throw new Error('gate workspace missing before baseline attribution recheck');
        const recheckTree = join(work, 'baseline-attribution-recheck');
        trees.push(recheckTree);
        const baseShaForRecheck = opts.baselineCommit ?? baselineReleaseCommit(baselineVersion);
        await runner.add(recheckTree, baseShaForRecheck);
        for (const dir of [recheckTree, join(recheckTree, 'apps/pwa')])
          check(await runner.command('bun', ['install'], dir), `bun install ${dir}`);
        const rechecked = await runner.sweep(recheckTree,
          join(root, 'release', opts.version, 'gate-logs', 'baseline-attribution-recheck'),
          opts.pod ? { ...opts.pod, ...(opts.imagePin ? { imagePin: opts.imagePin } : {}), durationSource } : undefined,
          targetFiles);
        if (rechecked.timedOut || rechecked.abortedShards || rechecked.stalledEnv?.length) {
          attribution.baselineResult = 'timeout';
          throw new Error('baseline sweep timed out or stalled');
        }
        failuresOf(rechecked, 'baseline attribution recheck');
        attribution.baselineResult = 'completed';
      } catch (recheckError) {
        debug.log('release-loop.gate', 'failure-attribution-baseline-recheck', { ...attribution, phase: 'failed', error: String(recheckError) });
        throw new Error(`baseline recheck ${attribution.baselineResult}; cut attribution unresolved (summary=${attribution.summary}, identified=${attribution.identified})`);
      }
      debug.log('release-loop.gate', 'failure-attribution-baseline-recheck', { ...attribution, phase: 'completed',
        disposition: 'cut names remain unresolved; baseline success cannot identify unnamed cut failures; fail closed' });
      throw new Error(`baseline recheck completed; cut attribution still unresolved (summary=${attribution.summary}, identified=${attribution.identified})`);
    }
    // A between-tests error proves only that the shared process failed. Re-run each affected file by itself using the
    // same isolated path as ordinary new-failure rechecks, even when the error was present in the baseline ledger.
    // Replace that file's shard observations with its isolated observations before the existing regression comparison.
    const prefetchedCut = new Map<string, CommandResult>();
    const prefetchedBaseline = new Map<string, CommandResult>();
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
    const samePodFlaky = [...new Set(cutRun?.loadFlaky ?? [])].sort();
    if (samePodFlaky.length) {
      const flaky = new Set(samePodFlaky);
      cut.failures = cut.failures.filter((id) => !flaky.has(id));
      cut.errors = cut.errors.filter((id) => !flaky.has(id));
      result.loadFlaky = [...new Set([...(result.loadFlaky ?? []), ...samePodFlaky])].sort();
      debug.log('release-loop.gate', 'same-pod-load-flaky', { ids: samePodFlaky, files: [...new Set(samePodFlaky.map(fileOf))].sort() });
      try {
        const path = loadFlakyCensusPath(ledger);
        mkdirSync(dirname(path), { recursive: true });
        const at = new Date().toISOString();
        appendFileSync(path, samePodFlaky.map((id) => JSON.stringify({ at, version: opts.version, commit: opts.commit, id,
          host: opts.pod ? `pod:${opts.pod.pool}` : opts.remote ?? 'local', retry: 'same-pod-standalone' }) + '\n').join(''), { mode: 0o600 });
      } catch (error) { debug.log('release-loop.gate', 'load-flaky-census-write-failed', { ids: samePodFlaky, error: String(error) }); }
    }
    if (partial && !sameHeadRehearsalCarry) result.partial = { priorCommit: partial.priorCommit, files: partial.files.length };
    cutFailures = cut;
    const baseSha = opts.baselineCommit ?? baselineReleaseCommit(baselineVersion);
    baselineCommitForVerdict = baseSha;
    const cached = cachedBaseline(baselineVersion, baseSha);
    const recorded = cached ? undefined : baselineFromCutLogs(join(ledger, 'release', baselineVersion, 'gate-logs', 'cut'), baseSha);
    const trusted = cached?.saved ?? (recorded?.complete ? recorded : undefined);
    result.baselineSource = cached ? cached.source : recorded?.complete ? 'cut-logs' : 'swept';
    debug.log('release-loop.gate', 'baseline', { version: baselineVersion, source: result.baselineSource, commit: baseSha });
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
    let deferredBaselineFiles = new Set<string>();
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
      debug.log('release-loop.gate', 'baseline-deferred', { version: baselineVersion, commit: baseSha, cutFiles: cutFiles.length, swept: present.length });
      if (present.length) {
        if (opts.pod && runner.recheckPod && runner.recheckPodBatch) {
          deferredBaselineFiles = new Set(present);
          // GATE-BASELINE-SWEEP-TO-ISOLATED: each failed cut file is isolated on both commits as a paired batch below.
          // This keeps the same failure identities while avoiding a separate baseline sweep and its own Pod preparation.
          debug.log('release-loop.gate', 'baseline-isolated-pair-plan', { version: baselineVersion, commit: baseSha,
            files: present, executor: 'pod-batch' });
          baseline = { failures: [], errors: [] };
        } else {
          emitGatePhaseProgress('remeasure', { fileCount: present.length, remeasureKind: 'baseline' });
          const baseRun = await runner.sweep(baseTree!, join(root, 'release', opts.version, 'gate-logs', 'baseline'),
            opts.pod ? { ...opts.pod, ...(opts.imagePin ? { imagePin: opts.imagePin } : {}), durationSource } : undefined,
            present);
          baseline = await localStalled(baseRun, baseTree!, baseSha, 'baseline');
        }
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
    const recheckStartedAt = clock();
    const recordedWarmAttemptIds = new Set((result.warmShadow ?? []).map((entry) => entry.attemptId));
    const recordWarmShadow = async (shadow?: WarmShadowObservation) => {
      if (!shadow || recordedWarmAttemptIds.has(shadow.attemptId)) return;
      recordedWarmAttemptIds.add(shadow.attemptId);
      await journalWarmGateShadow(shadow, opts.commit, runner, opts.repo ?? process.cwd());
      {
        const { leaseEvidence: _leaseEvidence, ...persistedShadow } = shadow;
        (result.warmShadow ??= []).push(persistedShadow);
      }
    };
    const recheckFile = async (file: string, index: number) => {
      debug.log('release-loop.gate', 'isolated-recheck-progress',
        { index: index + 1, total: recheckFiles.length, file, elapsedSec: Math.round((Date.now() - recheckStartedAt) / 1000) });
      // 0.2.15: the cut re-check of a new-failure file (InsidePage.test.tsx · headless Chrome) hung for good — limit it like the host re-run.
      const pairedBaselinePromise = deferredBaselineFiles.has(file) && !baseCache.has(`${file}\0${cacheHost}`)
        && !prefetchedBaseline.has(file)
        ? (opts.pod && runner.recheckPod
          ? runner.recheckPod(file, baseSha, opts.pod, GATE_ISOLATED_TIMEOUT_MS)
          : (async () => runner.command('bun', ['run', 'test:deterministic', asPath(file)], await getBaseTree(), GATE_ISOLATED_TIMEOUT_MS))())
        : Promise.resolve(undefined);
      const cutCheckPromise = cutHostFailed.has(file) ? Promise.resolve(undefined) : prefetchedCut.get(file) ?? (opts.pod && runner.recheckPod
        ? runner.recheckPod(file, opts.commit, { ...opts.pod, warmCutSha: opts.commit, warmBaselineSha: baseSha,
          warmEligible: warmEligibleFiles.has(file) }, GATE_ISOLATED_TIMEOUT_MS)
        : runner.command('bun', ['run', 'test:deterministic', asPath(file)], cutTree, GATE_ISOLATED_TIMEOUT_MS));
      const [cutCheck, pairedBaseline] = await Promise.all([cutCheckPromise, pairedBaselinePromise]);
      if (pairedBaseline) prefetchedBaseline.set(file, pairedBaseline);
      await recordWarmShadow(cutCheck?.warmShadow);
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
      const samePodRetried = new Set(cutRun?.loadFlakyAttemptedFiles ?? []);
      const shaped = candidates.filter((id) => timedOut.has(id) && isolatedCut.failures.includes(id) && !samePodRetried.has(fileOf(id)));
      if (shaped.length) {
        const relaxed = opts.pod && runner.recheckPod
          ? await runner.recheckPod(file, opts.commit, { ...opts.pod, warmCutSha: opts.commit, warmBaselineSha: baseSha,
            warmEligible: warmEligibleFiles.has(file) }, GATE_ISOLATED_TIMEOUT_MS, true)
          : await runner.command('bun', ['run', 'test:deterministic', asPath(file), '--timeout', String(GATE_TIMEOUT_RECHECK_MS)], cutTree, GATE_ISOLATED_TIMEOUT_MS);
        await recordWarmShadow(relaxed.warmShadow);
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
        const stillTimedOut = recheck === 'timeout' ? shaped : shaped.filter((id) => {
          try { return parseTimedOutFailures(stripPodRepoRoot(relaxed.output)).includes(id); } catch { return false; }
        });
        if (stillTimedOut.length) {
          const baselineTree = opts.pod && runner.recheckPod ? undefined : await getBaseTree();
          const baselineRetry = opts.pod && runner.recheckPod
            ? await runner.recheckPod(file, baseSha, opts.pod, GATE_ISOLATED_TIMEOUT_MS, true)
            : await runner.command('bun', ['run', 'test:deterministic', asPath(file), '--timeout', String(GATE_TIMEOUT_RECHECK_MS)], baselineTree!, GATE_ISOLATED_TIMEOUT_MS);
          await recordWarmShadow(baselineRetry.warmShadow);
          const baselineUnmeasurable = baselineUnmeasurableTimeoutIds({ output: stripPodRepoRoot(baselineRetry.output) }, stillTimedOut);
          for (const id of stillTimedOut) {
            if (baselineUnmeasurable.includes(id)) timeoutBaselineUnmeasurableIds.add(id);
            else timeoutBaselineMeasuredIds.add(id);
          }
          if (baselineUnmeasurable.length) {
            candidates = candidates.filter((id) => !baselineUnmeasurable.includes(id));
            debug.log('release-loop.gate', 'timeout-baseline-unmeasurable', { file, ids: baselineUnmeasurable,
              baseline: baselineRetry.timedOut ? 'timeout' : 'timeout-or-skipped', remote: opts.remote ?? 'local' });
          }
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
        const previous = prefetchedBaseline.get(file) ?? (opts.pod && runner.recheckPod
          ? await runner.recheckPod(file, baseSha, opts.pod, GATE_ISOLATED_TIMEOUT_MS)
          : await runner.command('bun', ['run', 'test:deterministic', asPath(file)], baselineTree!, GATE_ISOLATED_TIMEOUT_MS));
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
        await recordWarmShadow(run.warmShadow);
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
          const settledGroups = await Promise.allSettled(groups.slice(next, next + cap).map(async (files) => {
            const baselineFiles = files.filter((file) => deferredBaselineFiles.has(file)
              && !baseCache.has(`${file}\0${cacheHost}`) && !prefetchedBaseline.has(file));
            const paired = await runPairedIsolatedBatch({ cutFiles: files, baselineFiles, cutCommit: opts.commit, baselineCommit: baseSha,
              runBatch: (batchFiles, commit) => runner.recheckPodBatch!(batchFiles, commit,
                commit === opts.commit ? { ...opts.pod!, warmCutSha: opts.commit, warmBaselineSha: baseSha,
                  warmEligible: batchFiles.length === 1 && warmEligibleFiles.has(batchFiles[0]!) } : opts.pod!, GATE_ISOLATED_TIMEOUT_MS) });
            for (const [file, run] of paired.cut) prefetchedCut.set(file, run);
            for (const [file, run] of paired.baseline) {
              prefetchedBaseline.set(file, run);
              // Keep every completed baseline group if this window later fails; the next gate can reuse it.
              if (!run.timedOut) {
                const reading = readIsolatedRun(run, `baseline isolated ${file}`, file);
                const prior: SweepFailures = reading.kind === 'read' ? reading : { failures: [], errors: [`${file} > [rc-nonzero]`] };
                remember({ commit: baseSha, file, host: cacheHost, failures: prior.failures, errors: prior.errors, missing: false });
              }
            }
            if (paired.failures.length) throw new SettledRecheckFailures(paired.failures);
          }));
          const failures = settledGroups.filter((item): item is PromiseRejectedResult => item.status === 'rejected').map((item) => item.reason);
          if (failures.length) throw new SettledRecheckFailures(failures);
        }
      }
      for (let next = 0; next < window.length; next += cap)
        await settleStarted(window.slice(next, next + cap).map((file, slot) => recheckFile(file, start + next + slot)));
      for (const file of window) prefetchedCut.delete(file);
    }
    result.introduced.sort();
    preexistingIds.sort();
    result.loadFlaky?.sort();
    // GATE-RISK-LANE — did the shard that ran first carry this gate's new failures? Observation only: the outcome above
    // is the existing aggregation, and the counts (introduced · preexisting) are the same ones the verdict writes.
    if (cutRun?.riskLane) debug.log('release-loop.gate', 'risk-lane-introduced', { files: cutRun.riskLane.files,
      plannedSeconds: cutRun.riskLane.plannedSeconds, durationMs: cutRun.riskLane.durationMs, rc: cutRun.riskLane.rc,
      introduced: result.introduced.filter((id) => cutRun!.riskLane!.files.includes(fileOf(id))).length });
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
    if (error instanceof Error && error.message.startsWith('remote gate refused: HQ shard result batch')) throw error;
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
    result.durationMs = clock() - start;
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
      ...(result.warmShadow?.length ? { warmShadow: result.warmShadow } : {}),
      ...(result.attributionRecheck ? { attributionRecheck: result.attributionRecheck } : {}) };
    // Receipt is advisory for a later radius gate. Missing identity makes reuse invalid, never this gate's verdict.
    const baselineReceipt = gateBaselineReceipt({ root, version: opts.version, commit: opts.commit,
      graphPins: gateGraphPins(root, opts.graphRunId) ?? (opts.rehearsalBaseline ? gateSourcePins(repo, opts.commit) : null),
      envFingerprint: gateEnvFingerprint(process.env),
      ...(result.attributionRecheck ? { attributionRecheck: result.attributionRecheck } : {}),
      // 대표 11-06: a regression must not void the receipt — passed shards stay reusable; failed files are re-measured from gate-failures.json.
      fullSweep: result.outcome !== 'error' && cutSweepUsable && !result.partial && !!cutFailures
        && !result.rcNonzeroNoFailures.length && !result.stalledShards?.length && !result.stalledEnv.length
        && !result.unmeasuredRecheckFiles?.length && !result.unmeasuredErrors?.length });
    try {
      for (const location of roots) {
        const path = verdictFile(location, opts.version);
        if (existsSync(path)) readFileSync(path, 'utf8');
      }
      for (const location of roots) {
        const path = verdictFile(location, opts.version);
        const warmHistory = readWarmVerdictHistory(path) ?? [];
        writeGateVerdictRecord(path, { version: opts.version, commit: opts.commit,
          outcome: result.outcome, baselineCommit, ...ids, ...observed, baselineReceipt,
          ...(opts.pod?.warmReplay ? { baselineCommit, warmHistory } : {}) });
      }
    } catch (error) {
      result.outcome = 'error';
      result.error = `verdict persistence: ${String(error)}`;
      const path = verdictFile(ledger, opts.version);
      try {
        const warmHistory = readWarmVerdictHistory(path) ?? [];
        writeGateVerdictRecord(path, { version: opts.version, commit: opts.commit,
          outcome: result.outcome, baselineCommit, ...ids, ...observed, baselineReceipt,
          ...(opts.pod?.warmReplay ? { baselineCommit, warmHistory } : {}) });
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
    if (result.outcome === 'regression' && result.introduced.length && opts.pod && runner.recheckPodBatch &&
        /^[0-9a-f]{40}$/i.test(baselineCommit) && /^[0-9a-f]{40}$/i.test(opts.commit)) {
      emitGatePhaseProgress('remeasure', { fileCount: result.introduced.length, remeasureKind: 'regression-isolation' });
      try {
      const gateHosts = new Set(parsePodPool(opts.pod.pool).map((member) => {
        const contextHost = /(?:^|-)pool-([a-zA-Z0-9][a-zA-Z0-9._-]*)$/u.exec(member.context)?.[1];
        return (member.sshHost ?? contextHost ?? hostname()).toLowerCase().split('.')[0];
      }));
      const alternate = selectGateBisectAlternatePool(gateHosts);
      if (!alternate) {
        debug.log('release-loop.gate', 'bisect-unmeasured', { version: opts.version, commit: opts.commit, reason: 'no-parent-host-outside-release-gate-pool' });
      } else {
        // git-spawn-allow: read-only first-parent ancestry proves the baseline lies on the cut's first-parent path.
        const history = await runner.command('git', ['rev-list', '--first-parent', '--parents', opts.commit], repo, 15_000);
        const firstParentRows = history.rc === 0 ? history.output.trim().split(/\r?\n/).filter(Boolean).map((row) => row.split(/\s+/)[0]!) : [];
        const range = firstParentCommitsBetween(firstParentRows, baselineCommit, opts.commit);
        const planned = history.rc !== 0 ? { ok: false as const, reason: `first-parent history unreadable: ${history.output || history.rc}` }
          : !range.ok ? { ok: false as const, reason: range.reason }
            : planGateBisect({ version: opts.version, baseCommit: baselineCommit, cutCommit: opts.commit,
              firstParentCommits: range.commits, introducedIds: result.introduced,
              basePass: true, cutFail: true, host: alternate.host });
        if (!planned.ok) {
          debug.log('release-loop.gate', 'bisect-unmeasured', { version: opts.version, commit: opts.commit, reason: planned.reason });
        } else {
          const sidecarRunId = (opts.graphRunId ?? `direct-${randomUUID()}`).replace(/[^a-zA-Z0-9_.-]/g, '_');
          const path = join(ledger, 'release', opts.version, `gate-bisect-${opts.commit}-${sidecarRunId}.json`);
          const record = { plan: planned.plan, status: 'queued', createdAt: new Date(clock()).toISOString(), repo, ledger, path,
            runId: sidecarRunId, alternatePool: alternate.pool,
            pod: { pool: opts.pod.pool, imagePin: opts.pod.imagePin, pinnedImageDigest: opts.pod.pinnedImageDigest, pinnedRunId: opts.pod.pinnedRunId,
              hostMirror: opts.pod.hostMirror, installSlots: opts.pod.installSlots, shardTimeoutSeconds: opts.pod.shardTimeoutSeconds } };
          try {
            mkdirSync(dirname(path), { recursive: true });
            const temp = join(dirname(path), `.gate-bisect-${process.pid}-${randomUUID()}.tmp`);
            try { writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, path); }
            finally { if (existsSync(temp)) rmSync(temp); }
          } catch (error) {
            debug.log('release-loop.gate', 'bisect-unmeasured', { version: opts.version, commit: opts.commit, reason: `plan persistence: ${String(error)}` });
          }
          debug.log('release-loop.gate', 'bisect-plan', { version: opts.version, commit: opts.commit, baseCommit: baselineCommit,
            files: planned.plan.files, commits: planned.plan.commits.length, host: alternate.host, path });
          try {
            if (runner.startBisectSidecar) {
              await runner.startBisectSidecar(path, result.outcome);
            } else {
              const sidecar = spawn(process.execPath, [join(repo, 'scripts/release-loop/gate-bisect-sidecar.ts'), '--input', path],
                { cwd: repo, detached: true, stdio: 'ignore', env: process.env });
              sidecar.on('error', (error) => debug.log('release-loop.gate', 'bisect-sidecar-spawn-failed', { version: opts.version, commit: opts.commit, reason: String(error) }));
              sidecar.unref();
            }
          } catch (error) {
            debug.log('release-loop.gate', 'bisect-sidecar-spawn-failed', { version: opts.version, commit: opts.commit, reason: String(error) });
          }
        }
      }
      } catch (error) {
        debug.log('release-loop.gate', 'bisect-sidecar-unavailable', { version: opts.version, commit: opts.commit, reason: String(error) });
      }
    }
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
        missedIntroduced: record.actual.missedIntroduced.length,
        lazyRequireCurrent: radiusShadow.lazyRequireShadow?.currentFiles.length ?? null,
        lazyRequireProposed: radiusShadow.lazyRequireShadow?.proposedFiles.length ?? null,
        lazyRequireMissedFailures: record.actual.lazyRequireMissedFailures?.length ?? null,
        lazyRequireComparison: record.actual.lazyRequireComparison ?? 'not-planned' });
    } catch (error) { debug.log('release-loop.gate', 'radius-shadow-unavailable', { reason: String(error) }); }
  }
  // GATE-LIVE-OBS-RC-WORDING ⓒ — the shards board says «판정 전» until this lands; then «새 실패 N» only (UX · gate-shards.ts).
  // Same ledger as the board's own writes (sweep's shardsFile). A write failure is logged and never changes the verdict.
  if (result.outcome !== 'error' && opts.pod) {
    const path = gateShardsPath(opts.version, ledger);
    try {
      const written = recordGateShardsVerdict(path, { introduced: result.introduced.length, preexisting: result.preexisting });
      debug.log('release-loop.gate', 'shards-verdict', { version: opts.version, path, written, introduced: result.introduced.length, preexisting: result.preexisting });
    } catch (error) { debug.log('release-loop.gate', 'shards-verdict-write-failed', { path, error: String(error) }); }
  }
  const unmeasuredCount = result.stalledEnv.length + (result.unmeasuredErrors?.length ?? 0)
    + (result.unmeasuredRecheckFiles?.length ?? 0) + (result.stalledShards?.length ?? 0);
  if (timeoutBaselineUnmeasurableIds.size || timeoutBaselineMeasuredIds.size) {
    recordGateTimeoutOwnerCells({ ledgerRoot: ledger, version: opts.version, commit: opts.commit,
      unmeasurableIds: [...timeoutBaselineUnmeasurableIds], measuredIds: [...timeoutBaselineMeasuredIds] });
  }
  const classifiedFailureCount = unmeasuredCount === 0 ? result.introduced.length + result.preexisting : null;
  emitGatePhaseProgress('classification', { introduced: result.introduced.length, preexisting: result.preexisting,
    unmeasured: unmeasuredCount, failureCount: classifiedFailureCount });
  emitGatePhaseProgress('verdict', { outcome: result.outcome, introduced: result.introduced.length,
    preexisting: result.preexisting, unmeasured: unmeasuredCount, failureCount: classifiedFailureCount });
  return result;
}

export function graphGateResult(result: GateResult, graph: boolean) {
  return { ...result, ...(graph && result.outcome === 'regression' ? { outcome: 'fail' as const } : {}),
    stalledShards: result.stalledShards ?? [], unmeasuredRecheckFiles: result.unmeasuredRecheckFiles ?? [],
    unmeasuredErrors: result.unmeasuredErrors ?? [], abortedShards: result.abortedShards ?? 0,
    verdict: result.outcome === 'ok' ? 'pass' as const : 'fail' as const,
    summary: (result.partial ? `부분 재검 ${result.partial.files}파일(앞 게이트 ${result.partial.priorCommit.slice(0, 9)} 결과 이음) · ` : '')
      + (result.rehearsalReceiptDecision ? `예행 영수증 ${result.rehearsalReceiptDecision.action} · ${result.rehearsalReceiptDecision.reason} · ` : '')
      + (result.outcome === 'ok' ? `새 회귀 ${result.introduced.length} · 기존 ${result.preexisting} · 고침 ${result.fixed ?? '못 셈(기준선 미루기)'}` : `게이트 ${result.outcome}: ${result.error ?? result.introduced.length + ' new regressions'}`) + ` · 환경 알려진 실패 ${result.knownEnv}`
      + (result.reusedWarmPods !== undefined ? ` · 재활용 웜 Pod ${result.reusedWarmPods}` : '')
      + (result.rcNonzeroNoFailures.length ? ` · ⚠ 종료코드만 비영 ${result.rcNonzeroNoFailures.length}` : '')
      + (result.loadFlaky?.length ? ` · ⚠ 부하 흔들림 ${result.loadFlaky.length}(독립 재실행 통과 · 막지 않음)` : '')
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

export type GatePoolResourceProbe = (host: string, env: NodeJS.ProcessEnv, members: readonly PodPoolMember[]) => GateHostResourceReading;

export type GatePoolStartBlock = { host: string; reason: string; resources?: Pick<Extract<GateHostResourceReading, { status: 'measured' }>, 'reservations' | 'authoringLeases' | 'waitingJobs' | 'activeJobs'> };

/** The gate starts only after every host in its exclusive pool is measured empty. */
export function releaseGatePoolStartBlock(opts: GateOptions, env: NodeJS.ProcessEnv,
  probe: GatePoolResourceProbe = (host, probeEnv, members) => readGateHostResourcesForHost(host, probeEnv, { members })): GatePoolStartBlock | null {
  if (!opts.pod) return null;
  let members: PodPoolMember[];
  try { members = parsePodPool(opts.pod.pool); }
  catch (error) { return { host: 'unknown', reason: `gate-pool-invalid: ${error instanceof Error ? error.message : String(error)}` }; }
  for (const host of reservedGateHosts(opts)) {
    const reading = probe(host, env, members);
    if (reading.status === 'unmeasurable') return { host, reason: `gate-pool-unmeasurable:${reading.reason}` };
    if (!reading.empty) return { host, reason: 'gate-host-busy', resources: {
      reservations: reading.reservations, authoringLeases: reading.authoringLeases,
      waitingJobs: reading.waitingJobs, activeJobs: reading.activeJobs,
    } };
  }
  return null;
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
  const landedRepair = context && Object.entries(context.outputs)
    .filter(([nodeId, output]) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId) && output.outcome === 'ok'
      && typeof output.commit === 'string' && /^[0-9a-f]{40}$/i.test(output.commit))
    .at(-1)?.[1]?.commit;
  const graphCommit = typeof landedRepair === 'string' ? landedRepair : context?.outputs['version-release']?.commit;
  if (typeof graphCommit === 'string') fromGraph.commit = graphCommit;
  const imagePinRepair = context && Object.entries(context.outputs).some(([nodeId, output]) =>
    /^gate-image-repair-[a-f0-9]{12}$/.test(nodeId) && output.outcome === 'ok' && output.imagePin === 'cut-commit'
      && output.imagePinRunId === context.runId && output.commit === fromGraph.commit
      && typeof output.imagePinDigest === 'string' && normalizeGateImageDigest(output.imagePinDigest) !== null);
  if (imagePinRepair) fromGraph.gateImagePin = 'cut-commit';
  if (fromGraph.gateImagePin !== undefined && fromGraph.gateImagePin !== 'cut-commit') {
    throw new Error(`unsupported gate image pin: ${String(fromGraph.gateImagePin)}`);
  }
  // Policy-selected Pod gates must pin their container to the resolved cut commit. Host sweeps do
  // not consume a container image pin, and the legacy no-executor path retains its old behavior.
  if (fromGraph.gateExecutor === 'pod' && fromGraph.gateImagePin !== 'cut-commit') {
    throw new Error('gateImagePin cut-commit is required for a policy-selected release gate');
  }
  const baselineCommit = context?.outputs.cutoff?.baseline as { sha?: unknown } | undefined;
  if (typeof baselineCommit?.sha === 'string') fromGraph.previousCommit = baselineCommit.sha;
  if (fromGraph.gateExecutor !== undefined && !isGateExecutor(fromGraph.gateExecutor)) throw new Error(`gateExecutor must be pod or host: ${String(fromGraph.gateExecutor)}`);
  // GATE-HOST-EXECUTOR: a host gate never reads the pod settings (a bad pod value must not block the fallback executor).
  const hostExecutor = fromGraph.gateExecutor === 'host';
  const externalVolumeRefs = hostExecutor ? [] : parseGateExternalVolumeRefs(fromGraph.gatePodExternalVolumeRefs);
  const graphCapabilities = fromGraph.gateShardCapabilities;
  if (!hostExecutor && graphCapabilities !== undefined && (!graphCapabilities || typeof graphCapabilities !== 'object'
    || Array.isArray(graphCapabilities) || Object.entries(graphCapabilities).some(([id, value]) =>
      !/^pod-\d+$/.test(id) || !value || typeof value !== 'object' || Array.isArray(value)
      || !['darwin', 'linux'].includes((value as { os?: string }).os ?? ''))))
    throw new Error('gateShardCapabilities must map pod-N to {os: darwin|linux}');
  const opts: GateOptions = {
    ...(context?.graphId ? { graphId: context.graphId } : {}),
    // The pod image-pin guard runs before judge() receives context.runId; carry the run scope here.
    ...(context?.runId ? { graphRunId: context.runId } : {}),
    dryRun: env.ELANOUS_GRAPH_DRY_RUN === '1',
    ...(fromGraph.gateImagePin === 'cut-commit' ? { imagePin: 'cut-commit' as const } : {}),
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
      ...(externalVolumeRefs.length ? { externalVolumeRefs } : {}),
      ...(fromGraph.gatePodInstallSlots !== undefined ? { installSlots: Number(fromGraph.gatePodInstallSlots) } : {}),
      ...(fromGraph.gatePodAdmissionWaitSeconds !== undefined ? { admissionWaitSeconds: Number(fromGraph.gatePodAdmissionWaitSeconds) } : {}),
      ...(fromGraph.gatePodIsolationConcurrency !== undefined ? { isolationConcurrency: Number(fromGraph.gatePodIsolationConcurrency) } : {}),
      ...(fromGraph.gatePodStallSeconds !== undefined ? { stallSeconds: Number(fromGraph.gatePodStallSeconds) } : {}),
      ...(fromGraph.gatePodMidRunStallSeconds !== undefined ? { midRunStallSeconds: Number(fromGraph.gatePodMidRunStallSeconds) } : {}),
      ...(fromGraph.gatePodFreshShards === true ? { freshShards: true } : {}),
      ...(typeof fromGraph.gateRerouteShard === 'string' ? { rerouteShard: fromGraph.gateRerouteShard } : {}),
      ...(typeof fromGraph.gateShardHost === 'string' ? { shardHost: fromGraph.gateShardHost } : {}),
      ...(graphCapabilities ? { shardCapabilities: graphCapabilities as Record<string, { os: 'darwin' | 'linux' }> } : {}),
      ...((cpu) => cpu ? { cpu } : {})(parsePodCpu(fromGraph.gatePodCpu, 'release.loop.gatePodCpu')),
    } : undefined,
  };
  if (isGateExecutor(fromGraph.gateExecutor)) opts.executor = fromGraph.gateExecutor;
  let freshShards = false;
  let warmPrecutCanaryFile: string | undefined;
  let rerouteShard: string | undefined;
  let shardHost: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return 'help';
    if (arg === '--json') continue;
    if (arg === '--precut-canary-file') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('--precut-canary-file requires one test file');
      warmPrecutCanaryFile = value;
      continue;
    }
    if (arg === '--full') { opts.full = true; continue; }
    if (arg === '--rehearsal-baseline') {
      opts.rehearsalBaseline = true;
      // Hard rehearsals are direct Pod runs, but explicitly bind them to the measured cut image too.
      opts.imagePin = 'cut-commit';
      continue;
    }
    // Applied after the loop and only to a Pod gate — on its own it must not turn a local gate into a Pod one (review r5).
    if (arg === '--fresh-shards') { freshShards = true; continue; }
    if (arg === '--reroute-shard') {
      const value = args[++i];
      if (!value || !/^(?:auto|pod-\d+)$/.test(value)) throw new Error('--reroute-shard requires auto or pod-N');
      rerouteShard = value;
      continue;
    }
    if (arg === '--shard-host') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('--shard-host requires a pool context');
      shardHost = value;
      continue;
    }
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
  if (warmPrecutCanaryFile) opts.warmPrecutCanary = { file: warmPrecutCanaryFile };
  if ((rerouteShard || shardHost) && !opts.pod?.pool) throw new Error('shard reroute requires a Pod pool');
  if (shardHost && !rerouteShard) throw new Error('--shard-host requires --reroute-shard');
  if (opts.pod && rerouteShard) opts.pod = { ...opts.pod, rerouteShard, ...(shardHost ? { shardHost } : {}) };
  if (opts.pod?.rerouteShard && !/^(?:auto|pod-\d+)$/.test(opts.pod.rerouteShard)) throw new Error('gateRerouteShard must be auto or pod-N');
  if (opts.pod?.shardHost && !opts.pod.rerouteShard) throw new Error('gateShardHost requires gateRerouteShard');
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
  judge: (opts: GateOptions, runner?: GateRunner, imageProbe?: typeof preflightGateImageDigest) => Promise<GateResult> = judgeGate,
  imageProbe: typeof preflightGateImageDigest = preflightGateImageDigest,
  poolResourceProbe?: GatePoolResourceProbe): Promise<number> {
  const start = Date.now();
  let result: GateResult | undefined;
  let version = '';
  let requestedCommit = '';
  let graphRunId: string | null = null;
  let autohealStoreRoot = '';
  let placement: { executor: string | null; host: string | null } | undefined;
  let warmControlCleanup: (() => Promise<void>) | undefined;
  let invocationWarmReuseCount = 0;
  let reportsWarmReuseCount = false;
  try {
    const parsed = parseOptions(argv, env);
    if (parsed !== 'help') requestedCommit = parsed.commit;
    let config: unknown = null;
    if (parsed !== 'help' && !runner && parsed.pod) {
      try { config = getUserConfig(); }
      catch (error) { debug.log('release-loop.gate', 'warm-profile-unavailable', { error: String(error) }); }
    }
    let opts = parsed === 'help' ? parsed : withWarmGateHooks(parsed, config, !!runner,
      cleanup => { warmControlCleanup = cleanup; });
    if (opts !== 'help' && opts.pod) {
      reportsWarmReuseCount = true;
      opts = { ...opts, pod: { ...opts.pod, onWarmPodFinalized: () => { invocationWarmReuseCount++; } } };
    }
    if (opts !== 'help' && opts.pod) assertValidPodSweepOptions(opts);
    if (opts !== 'help' && opts.pod) {
      // Keep the production guard enabled on graph paths even when a simulator replaces only the outside
      // Pod/Kubernetes boundary. Direct injected unit calls retain their explicit test bypass.
      const path: 'graph' | 'rehearsal' | 'test-injected' = opts.rehearsalBaseline ? 'rehearsal'
        : opts.graphRunId ? 'graph' : runner || judge !== judgeGate ? 'test-injected' : 'graph';
      const reason = opts.imagePin !== 'cut-commit' ? 'pod-gate-missing-cut-image-pin'
        : !(opts.graphRunId || opts.rehearsalBaseline) ? 'pod-gate-missing-run-scope' : null;
      const decision = path === 'test-injected' ? 'test-bypass' : reason ? 'fail-closed' : 'allow';
      debug.log('release-loop.gate', 'entry-guard-evaluated', { path, decision });
      if (decision === 'fail-closed') {
        debug.log('release-loop.gate', 'image-pin-unscoped', { runId: opts.graphRunId ?? null, version: opts.version,
          commit: opts.commit, imagePin: opts.imagePin ?? null, decision, reason }, { level: 'error' });
        throw new Error(`gate pod refused to start without a scoped cut image pin (${reason})`);
      }
    }
    if (opts !== 'help' && opts.pod) {
      // Reject malformed shard settings before touching the live host pool.
      // Supplying a runner or judge is the node's existing simulation seam; never issue a real Kubernetes read from it.
      const probe = poolResourceProbe ?? (runner || judge !== judgeGate
        ? (() => ({ status: 'measured' as const, empty: true, reservations: 0, authoringLeases: 0, waitingJobs: 0, activeJobs: 0 }))
        : undefined);
      const occupied = releaseGatePoolStartBlock(opts, env, probe);
      if (occupied) {
        debug.log('release-loop.gate', 'gate-host-pool-preflight-blocked', { host: occupied.host, reason: occupied.reason,
          resources: occupied.resources ?? null, version: opts.version }, { level: 'error' });
        const counts = occupied.resources
          ? ` · reservations=${occupied.resources.reservations} · authoringLeases=${occupied.resources.authoringLeases} · waitingJobs=${occupied.resources.waitingJobs} · activeJobs=${occupied.resources.activeJobs}`
          : '';
        console.error(`🚨 release gate 즉시 차단 — gate 호스트 풀 ${occupied.host}: ${occupied.reason}${counts}`);
        throw new Error(`release gate host pool preflight blocked (${occupied.host}): ${occupied.reason}`);
      }
    }
    if (opts !== 'help' && opts.warmPrecutCanary) {
      const canaryRunner = runner ?? createGateRunner(opts.repo ?? process.cwd(), opts.remote, undefined, undefined, undefined, undefined, { graphRunId: opts.graphRunId ?? null });
      const warmPrecutTestSeam = (runner as (GateRunner & { warmPrecutCanaryTestSeam?: {
        config: unknown; hooks: Pick<NonNullable<GateOptions['pod']>, 'warmReplay' | 'warmFinalize' | 'warmQuarantine' | 'warmReuseConfig'>;
      } }) | undefined)?.warmPrecutCanaryTestSeam;
      const canaryOpts = warmPrecutTestSeam && opts.pod ? { ...opts, pod: { ...opts.pod, ...warmPrecutTestSeam.hooks } } : opts;
      const canary = await runWarmPrecutCanary({ opts: canaryOpts, runner: canaryRunner, file: opts.warmPrecutCanary.file,
        config: warmPrecutTestSeam?.config ?? config,
        historyPath: verdictFile(opts.ledgerRoot ?? releaseLedgerRoot(), opts.version) });
      const output = { version: opts.version, commit: opts.commit, samples: canary.samples, decision: canary.decision };
      console.log(JSON.stringify(output));
      return 0;
    }
    if (opts !== 'help') {
      placement = gateExecutorOf(opts);
      debug.log('release-loop.gate', 'executor', { version: opts.version, ...placement, requested: opts.executor ?? null,
        imagePin: opts.imagePin ?? null, imageCommit: opts.imagePin === 'cut-commit' ? opts.commit : null });
    }
    if (opts === 'help') {
      console.log('Usage: bun scripts/release-loop/gate-node.ts --commit <sha> --version <v> [--baseline-version <prev>] [--baseline-commit <sha>] [--remote <ssh-host>] [--remote-mirror <path>] [--pod-pool <pool>] [--precut-canary-file <test-file>] [--pod-shards <n>] [--pod-shard-timeout-seconds <n>] [--recheck-file-limit <n>] [--fresh-shards] [--reroute-shard <pod-N|auto>] [--shard-host <pool-context>] [--executor <pod|host>] [--rehearsal-baseline] [--full] [--json]\n--precut-canary-file runs exactly two one-file warm↔fresh comparisons and stores them in this version\'s gate-verdict warmHistory before the standard gate consumes it; decideWarmReuse applies minMatchSamples.\nWithout flags, input.commit, input.version and input.previousVersion come from the JSON file at ELANOUS_GRAPH_CONTEXT.\n--executor host (input.gateExecutor) ignores every pod option and sweeps on --remote (input.gateRemote, required).\n--rehearsal-baseline pins source graph bytes only for a direct Pod gate on an isolated rc version.\n--full disables receipt and partial reuse and runs the complete test inventory.');
      return 0;
    }
    version = opts.version;
    autohealStoreRoot = opts.ledgerRoot ?? releaseLedgerRoot();
    // The graph's existing gate-node execution path delegates verdict classification and persistence here.
    const context = usesGraphContext(argv, env) ? readGraphContext(env) : undefined;
    graphRunId = context?.runId ?? null;
    // Let the gate's existing SSH host validation report an invalid host before any reservation is published.
    const hosts = opts.remote && !/^(?:[\w.-]+@)?[\w.-]+$/.test(opts.remote) ? [] : reservedGateHosts(opts);
    const reservationRoot = context ? gateHostReservationRoot() : undefined;
    if (context && (!context.runId || !env.ELANOUS_STATE_DIR || normRoot(env.ELANOUS_STATE_DIR) !== reservationRoot))
      throw new Error('release gate host reservation requires graph runId and pinned state root');
    const releaseHosts = context && hosts.length
      ? reserveReleaseGateHosts(reservationRoot!, context.runId!, hosts) : () => undefined;
    try {
      result = await judge(context?.runId ? { ...opts, graphRunId: context.runId } : opts, runner, imageProbe);
      if (reportsWarmReuseCount) result.reusedWarmPods = invocationWarmReuseCount;
    }
    finally { releaseHosts(); }
  } catch (error) {
    result = { outcome: 'error', commit: requestedCommit, introduced: [], preexisting: 0, fixed: 0, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: Date.now() - start,
      ...(reportsWarmReuseCount ? { reusedWarmPods: invocationWarmReuseCount } : {}),
      error: error instanceof InvalidPodSweepOptionsError ? error.message : String(error) };
    placement ??= requestedGateExecutor(argv, env);
  } finally {
    try { await warmControlCleanup?.(); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      debug.log('pod.warm.control-forward', 'cleanup-failed', { version, reason }, { level: 'error' });
      if (typeof result !== 'undefined') result = { ...result, outcome: 'error', error: [result.error, reason].filter(Boolean).join('; ') };
    }
  }
  if (!result) throw new Error('release gate returned without a result');
  if (versionPattern.test(version) && result.stalledShards?.length) {
    result.autoheals = result.stalledShards.map((shard, index) => {
      const shardKey = `pod-${shard.shard}`;
      const signature = createHash('sha256').update(JSON.stringify({ shard: shard.shard,
        files: [...shard.files].sort(), reason: shard.reason })).digest('hex');
      const cause = gateAutohealCause({ outcome: result.outcome, introduced: result.introduced, durationMs: result.durationMs,
        error: result.error, stalledShards: [shard], interferenceErrors: result.interferenceErrors, loadFlaky: result.loadFlaky }) ?? 'environment';
      const decision = decideAndRecordGateAutoheal({ cause, signature, version, runId: graphRunId ?? 'direct', shardKey,
        shardKeys: [shardKey], shardElapsedMs: result.durationMs,
        overallElapsedMs: index === 0 ? result.durationMs : 0,
        storeRoot: autohealStoreRoot || releaseLedgerRoot() });
      debug.log('release-loop.gate-autoheal', 'decision', { runId: graphRunId, version, ...decision });
      return decision;
    });
    result.autoheal = result.autoheals.find((decision) => decision.action === 'hitl') ?? result.autoheals[0];
  } else if (versionPattern.test(version)) {
    // Some failures (for example an unreachable gate host or a measured regression) have no
    // stalled shard. Keep them in the same durable policy ledger instead of silently skipping autoheal.
    const cause = gateAutohealCause(result);
    if (cause) {
      const signature = createHash('sha256').update(JSON.stringify({ cause,
        error: result.error ?? null, introduced: [...(result.introduced ?? [])].sort() })).digest('hex');
      result.autoheal = decideAndRecordGateAutoheal({ cause, signature, version, runId: graphRunId ?? 'direct',
        shardKey: 'gate', shardKeys: ['gate'], shardElapsedMs: result.durationMs, overallElapsedMs: result.durationMs,
        storeRoot: autohealStoreRoot || releaseLedgerRoot() });
      debug.log('release-loop.gate-autoheal', 'decision', { runId: graphRunId, version, ...result.autoheal });
    }
  }
  if (result.error) console.error(result.error);
  debug.log('release-loop.gate', 'result', { version, outcome: result.outcome, ...(placement ?? {}) });
  const nodeResult = graphGateResult(result, !!env.ELANOUS_GRAPH_CONTEXT);
  emitNodeResult({ ...nodeResult, ...(placement ?? {}),
    ...(placement?.executor === 'host' ? { summary: `${nodeResult.summary} · 실행기 host${placement.host ? `(${placement.host})` : ''}` } : {}) });
  return result.outcome === 'ok' ? 0 : result.outcome === 'regression' ? 1 : 2;
}

if (import.meta.main) {
  // The graph spawns this file as its own process, which inherits no daemon sink — without this every
  // `release-loop.gate`/`release.gate`/`pod.pool` event stayed in the file trail and `elanous logs` read 0 rows.
  await registerStandaloneLogSink('release-loop');
  process.exitCode = await runWithReleaseGateTraffic(process.env,
    () => runWithReleasePwaTraffic(process.env, () => runGateNode(process.argv.slice(2), process.env)));
}
