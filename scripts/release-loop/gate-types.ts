import type { GateExecutor } from './gate-executor.js';
import type { GatePrewarmInput } from './gate-prewarm-plan.js';
import type { GateHostMirrorReaders } from './gate-host-mirror.js';
import type { GateProgressGroup } from './gate-shard-dispatch.js';
import type { GateExternalVolumeRef } from '../../src/task-orchestrator/surfaces/pod-gate-volume-ref.js';
import type { WarmPodTransportResult } from '../../src/task-orchestrator/surfaces/pod-warm-worker-pod.js';
import type { WarmWorkerCommand, WarmWorkerFileResult } from '../../src/task-orchestrator/surfaces/pod-warm-worker-protocol.js';
import type { PodCpu } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import type { PodPoolMember } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import type { WarmReuseSwitchConfig } from '../../src/task-orchestrator/surfaces/pod-warm-switch.js';

import type { ActualWarmLeaseEvidence } from '../../src/task-orchestrator/surfaces/warm-reuse-evidence.js';
import type { WarmWorkerKey } from '../../src/task-orchestrator/surfaces/pod-warm-worker-protocol.js';
import type { GateAutohealDecision } from './gate-autoheal.js';
import type { ExecutedTuiCheck } from './tui-node-checks.js';

export type SweepFailures = { failures: string[]; errors: string[] };
export type RetryPassCause = 'isolation' | 'timeout' | 'load';
export type RetryPassEvidence = { id: string; cause: RetryPassCause };

/** Structural shape for failure-only Kubernetes reads; keep the type boundary independent of the Pod implementation. */
export type GateKubectl = (args: readonly string[], input?: string, timeoutMs?: number) => { status: number | null; stdout: string; stderr: string };

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
  /** Transient lease evidence; stripped before verdict persistence. */
  leaseEvidence?: ActualWarmLeaseEvidence;
}

export interface GateResult {
  outcome: 'ok' | 'regression' | 'error';
  summary?: string;
  commit: string;
  /** Present only when the ARG image-repair node completed its cut-image preparation step. */
  imagePin?: 'cut-commit';
  imagePinRunId?: string;
  imagePinDigest?: string;
  /** Formal receipt fallback decision observed by the real graph-scoped gate. */
  formalReceiptDecision?: string;
  /** Human-readable decision for a rehearsal receipt considered by this cut. */
  rehearsalReceiptDecision?: { action: 'reuse-zero' | 'partial-rerun' | 'full-sweep' | 'not-selected'; reason: string };
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
  /** Successfully finalized warm Pods used by this cut's isolated gate rechecks. */
  reusedWarmPods?: number;
  /** GATE-POD-STALL-FAILFAST ① — cut sweep shard Pods ended by the mid-run abort (their files went the timeout way). */
  abortedShards?: number;
  baselineSource?: 'ledger' | 'instance' | 'cut-logs' | 'swept';
  /** GATE-BASELINE-CACHE — isolated baseline files answered from the ledger (hits) or run now (misses). */
  baselineCache?: { hits: number; misses: number };
  /** A residual summary/name mismatch triggers an explicit baseline rerun before the gate stays fail-closed. */
  attributionRecheck?: { summary: number; observed: number; identified: number; collapsed: number;
    targetFiles: string[]; baselineResult: 'completed' | 'failed' | 'timeout' };
  /** GATE-SPEED A4 — a swept baseline ran only the cut's failing files that exist at the previous release. */
  baselineDeferred?: { cutFiles: number; swept: number };
  durationMs: number;
  /** GATE-WARM-BOOT-SCAN — observation only: the cut sweep's test selection time (pod sweep · absent otherwise). */
  selectionMs?: number;
  error?: string;
  stalledShards?: Array<{ shard: number; files: string[]; reason: 'incomplete' | 'no-output' | 'job-failed' | 'exit-code' | 'unattributed' | 'timeout' | 'admission-timeout' | 'admission-error' | 'image-pin-mismatch'; lastFile?: string; summaryFailures?: number; namedFailures?: number; detail?: string;
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
  trainReceiptReuse?: { source?: 'train-receipts' | 'formal-receipts' | 'file-cas' | 'existing-partial' | 'full-sweep'; carried: number | null; total: number | null;
    remeasure?: number | null; receipts: number; receiptKeys?: string[]; selectedFiles?: number | null;
    reasons: string[]; reasonCounts?: Record<string, number>; planReasons?: string[] };
  /** A failure that passed an evidence-checked isolated re-run: warning (flaky under load), not an introduced regression. */
  loadFlaky?: string[];
  /** Evidence-backed cause for a retry pass; absent for older shard receipts. */
  retryPass?: RetryPassEvidence[];
  /** File-level unhandled errors that reproduced or could not be measured in isolation. They keep the gate red. */
  unmeasuredErrors?: Array<{ file: string; reason: 'reproduced' | 'timeout' | 'unreadable'; ids: string[] }>;
  /** Shard-only unhandled errors whose file-level replay completed cleanly. */
  interferenceErrors?: string[];
  rehearsalTui?: ExecutedTuiCheck;
  /** Recovery recommendation is persisted with the failed graph node so the resume coordinator can act on it. */
  autoheal?: GateAutohealDecision;
  autoheals?: GateAutohealDecision[];
}

export interface GateCommandResult { rc: number; output: string; passedIds?: string[]; stalledEnv?: Array<{ file: string; reason: 'no-output' }>; timedOut?: boolean;
  /** Same-Pod per-file retry passed with complete log/JUnit evidence; these original ids are excluded from introduced. */
  loadFlaky?: string[];
  retryPass?: RetryPassEvidence[];
  /** Files already given their one same-Pod retry; prevent the later timeout-only path from retrying them again. */
  loadFlakyAttemptedFiles?: string[];
  /** Identity and complete selected inventory of this Pod sweep; only the producer may issue it. */
  podSweep?: { id: string; invocationId?: string; shards: number; files: string[]; imageDigests?: Array<string | null>;
    disposition?: { reused: number; rerun: number; unmeasured: number } };
  /** Complete, source-bound one-file Job result for shadow comparison; absent means unmeasured. */
  warmReference?: WarmWorkerFileResult | null;
  warmAttemptId?: string;
  warmShadow?: WarmShadowObservation;
  /** GATE-POD-STALL-FAILFAST ① — shard Pods whose tests the mid-run watch aborted in this sweep. */
  abortedShards?: number;
  /** Each contributing Pod leaf already passed failuresOf; repeated printed ids cannot add new failures. */
  validatedShards?: boolean
  /** GATE-RISK-LANE — the watch-list shard this sweep ran first, with its plan and measurement (observation only). */
  riskLane?: GateRiskLaneRecord }
export type GateProgressScheduler = (tick: () => void, intervalMs: number) => () => void;
export interface GateSweepProgress {
  executor: 'host' | 'pod';
  groups: readonly GateProgressGroup[];
}
export interface GateRunner {
  /** Bind a CLI-derived release run identity before the first plan or shard row is written. */
  setRunId?(runId: string | null): void;
  command(cmd: string, args: string[], cwd: string, limitMs?: number): Promise<GateCommandResult>;
  localCommand(cmd: string, args: string[], cwd: string, limitMs?: number): Promise<GateCommandResult>;
  /** Run one isolated test on the same Pod image and pinned commit as the sweep. */
  recheckPod?(file: string, commit: string, pod: NonNullable<GateOptions['pod']>, timeoutMs: number, relaxed?: boolean): Promise<GateCommandResult>;
  /** One checkout/install for a small independent file group; each file retains its own rc and log. */
  recheckPodBatch?(files: readonly string[], commit: string, pod: NonNullable<GateOptions['pod']>, timeoutMs: number): Promise<Map<string, GateCommandResult>>;
  /** `only` (GATE-PARTIAL) restricts the sweep to these test files; absent = every test file. */
  sweep(tree: string, logDir?: string, pod?: GateOptions['pod'], only?: readonly string[], onProgress?: (progress: GateSweepProgress) => void): Promise<GateCommandResult>;
  add(tree: string, commit: string): Promise<void>;
  remove(tree: string): Promise<void>;
  snapshot(tree: string, commit: string): Promise<void>;
  removeSnapshot(tree: string): Promise<void>;
  /** Absolute remote bare mirror path, set before preparing the remote trees. */
  remoteMirror?: string;
  /** GATE-FLOW-SIM — the clock this runner measures with (the injected fake clock in a scenario); absent = `Date.now`. */
  now?(): number;
  progressScheduler?: GateProgressScheduler;
  heartbeatScheduler?: GateProgressScheduler;
  startBisectSidecar?(inputPath: string, gateOutcome: GateResult['outcome']): void | Promise<void>;
}
export interface GateOptions {
  commit: string;
  /** Present only when launched as a graph command; used to scope release-stage stall mail. */
  graphId?: string;
  dryRun?: boolean;
  /** Explicit pre-cut warm↔fresh comparison, persisted before the ordinary gate reads warmHistory. */
  warmPrecutCanary?: { file: string };
  /** RELEASE-POLICY-PACK — the gate Pod image is tied to this resolved cut commit. */
  imagePin?: 'cut-commit';
  /** Internal ARG repair mode: build/record the cut image pin without starting a gate sweep. */
  imagePinPrepareOnly?: boolean;
  /** The graph run that launched this gate; direct hard rehearsal instead pins source bytes explicitly. */
  graphRunId?: string;
  /** Direct hard-rehearsal identity; scopes evidence without changing graph-run semantics. */
  runId?: string;
  /** Only a direct hard rehearsal may pin graph bytes from its measured Git commit. */
  rehearsalBaseline?: boolean;
  forceFreeze?: boolean;
  /** Force all release tests to run, bypassing every reusable partial plan. */
  full?: boolean;
  version: string;
  baselineVersion?: string;
  baselineCommit?: string;
  remote?: string;
  remoteMirror?: string;
  /** GATE-HOST-EXECUTOR — `host` ignores every pod option and sweeps on `remote` (required). Absent = today's choice (pod when a pool is set). */
  executor?: GateExecutor;
  instanceRoot?: string;
  ledgerRoot?: string;
  /** Shared HQ root for authoritative shard rows when other light-rc artifacts stay in a disposable instance. */
  shardLedgerRoot?: string;
  /** Keep a light-rc rehearsal entirely inside its disposable instance until its receipt is atomically published. */
  scratchOnly?: boolean;
  repo?: string;
  /** Rehearsal's opt-in screen measurement; normal release gates keep their existing defaults. */
  rehearsalTui?: boolean;
  /** Files per final recheck window; every window is measured (default 32). */
  recheckFileLimit?: number;
  /** freshShards — GATE-SHARD-RESUME off: every shard starts a Pod even when this logDir already holds its result. */
  pod?: { pool: string; shards?: number; shardTimeoutSeconds?: number; durationSource?: string; bunCache?: string; externalVolumeRefs?: readonly GateExternalVolumeRef[]; freshShards?: boolean;
    imagePin?: 'cut-commit';
    /** One immutable container image identity for this gate graph run and all its resumes. */
    pinnedImageDigest?: string;
    /** Tag identity for the source-free runtime image; source checkout still uses GateOptions.commit. */
    imageTagCommit?: string;
    /** Current image execution identity; an unmeasured base digest keeps warm reuse closed. */
    executionIdentity?: import('./gate-radius-live.js').GatePodExecutionIdentity | null;
    /** Base dependency layer digest from the pinned image; null closes warm reuse. */
    gateBaseImageDigest?: string | null;
    pinnedRunId?: string;
    /** Remeasure one named shard, or all incomplete shards with auto. Complete siblings keep their receipts. */
    rerouteShard?: string | 'auto';
    /** Pool context for the rerouted shard; the planner otherwise distributes missing shards over pool contexts. */
    shardHost?: string;
    /** Shard capability requirements are independent of host names; placement resolves them at run time. */
    shardCapabilities?: Readonly<Record<string, { os?: 'darwin' | 'linux' }>>;
    /** Opt-in gate shadow: provider fills the fenced lease identity. The Job remains authoritative. */
    warmReplay?: (input: Omit<WarmWorkerCommand, 'leaseId' | 'generation' | 'workerId' | 'key'>,
      selection?: { kind: 'gate' | 'implementation'; lockHash?: string; imageDigest?: string;
        runtimeIdentity?: { baseImageDigest: string; lockHash: string; os: string; architecture: string; bunVersion: string };
        runtimeContract?: { baseImageDigest?: string; bunVersion: string; os: 'linux'; architecture: string; requiredTools: readonly string[] } }) => Promise<{ command: WarmWorkerCommand | null; transport: WarmPodTransportResult }>;
    warmQuarantine?: (command: WarmWorkerCommand, reason: string) => Promise<void>;
    /** Explicit gate-profile producer handoff; shadow-only callers keep their Job path. */
    warmProducerEnabled?: boolean;
    /** Explicit opt-in: complete validated warm-worker artifacts may become this shard's verdict. */
    warmShardExecutionEnabled?: boolean;
    warmFinalize?: (command: WarmWorkerCommand) => Promise<void>;
    /** Invocation-scoped receipt; called only after a warm producer is finalized for this gate result. */
    onWarmPodFinalized?: () => void;
    /** Set only on the cut recheck; baseline Jobs never consume the cut worker. */
    warmCutSha?: string;
    /** A measured planner snapshot may accompany the cut; absent fields remain visibly unmeasured. */
    warmPrewarmInput?: GatePrewarmInput;
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
    /** GATE-MEM-ADMIT — seconds an active shard waits for pool admission. Root shards beyond the pool cap queue
     *  outside this timer; an exhausted wait stays unmeasured (`release.loop.gatePodAdmissionWaitSeconds`); 0 = off. */
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
    failureKubectl?: GateKubectl;
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
    shardsFile?: { path: string; version: string; ledgerPath?: string; envFingerprint?: string;
      receiptRoot?: string; base40?: string; sameHeadPreexistingFailureIds?: string[]; expectedImageDigest?: string | null; graphPins?: ({ graphSha: string; recipeSha: string } & { graphEntry?: string; recipeCommand?: string; recipeTimeoutMs?: number }) | null; executionIdentity?: import('./gate-radius-live.js').GatePodExecutionIdentity | null; radiusPriorCommit?: string };
    /** GATE-RISK-LANE — the ledgers `gateHistory` reads its watch list from; absent = no risk lane (the sweep plans as before). */
    riskWatch?: { instanceRoots: readonly string[]; ledgerRoots: readonly string[] };
    /** GATE-MULTI-HOST — is this pool member reachable (kubectl ns ⊕ ssh)? Injected by tests; absent = the real probe on
     *  the gate's own pool · an injected pool without it never marks a member down (unchanged). */
    probeMember?: (member: PodPoolMember) => boolean;
    /** GATE-MULTI-HOST — seconds a placed shard's Job status may stay unreadable before the shard counts as lost with its
     *  member; omitted = {@link GATE_MEMBER_UNREADABLE_SECONDS_DEFAULT}. Only a pool of two or more members uses it. */
    memberUnreadableSeconds?: number;
    /** GATE-WARM-BOOT-SCAN — observation only: the sweep's test selection (list · filter · duration plan · shard plan) time. */
    onSelectionTimed?: (timed: { ms: number; files: number }) => void };
}
/**
 * GATE-MEM-ADMIT (0.2.20) — the gate's shard Jobs ask the same pool admission harness goal Pods ask
 * (`PodPoolScheduler.acquireAdmission` · memory headroom by observed usage · `limitedBy`). 0.2.19: 8 shards sat Pending
 * for CPU (requests 31.2/32) because harness Pods held the node and the gate counted only its own Jobs (#24698).
 * A timed out or failed admission means the lease cannot protect capacity, so the shard remains unmeasured.
 * A later release resume can retry it when capacity is available.
 */
export interface GateAdmission {
  acquire(signal: AbortSignal): Promise<() => void>;
  /** The pool-wide reading admission waits on (recommended · limitedBy · memorySlots); null before any reading. */
  waitReason(): string | null;
  /** Optional deterministic-test observation override; production uses poolGateAdmission's unknown-only provider. */
  priorityShadowObservation?(gateWaiting: boolean): GatePriorityShadowObservation;
}
export type GatePriorityImageState = 'verified' | 'mismatch' | 'unknown';
export interface GatePriorityShadowObservation {
  gateRunId: string | null;
  host: string | null;
  competingRunId: string | null;
  competingHost: string | null;
  gateImageState: GatePriorityImageState;
  competingImageState: GatePriorityImageState;
  gateWaiting: boolean;
  lowerPriorityWaiting: boolean | null;
}
/** GATE-RISK-LANE — the watched files this sweep ran first, and how that shard was planned and measured. */
export interface GateRiskLaneRecord { files: string[]; plannedSeconds: number; durationMs: number; rc: 0 | 1 | null }
