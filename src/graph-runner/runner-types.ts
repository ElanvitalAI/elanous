import type { GraphEdgeAdditionApi, GraphSubgraphAppendProposal, GraphSubscriptionDispatch } from './graph-subscriptions.js';
import type { GraphEvent, GraphEventBus } from './graph-events.js';
import type { GraphNodeSpec } from '../self-implement/graph-yaml.js';
import type { GraphV2ExtensionLedger } from '../graph-v2/lower.js';
import type { GraphVariantPlan } from '../self-implement/graph-variant.js';
import type { ResearchEdgeDecisionRegistry } from '../research/edge-decision.js';
import type { WorkflowDeps } from '../workflow-runtime/types.js';
import type { GrowthDecisionDeps, GrowthProposer, GrowthRecipeEffect, GraphGrowth, GrowthCommand } from './graph-grow.js';
import type { DecisionEntry } from '../decisions/decision-ledger.js';
import type { InProcessHandlerRegistry } from './in-process-registry.js';
import type { GraphCapabilityProviders } from './capabilities.js';
import type { ReleaseStageState } from '../release-loop/stage-mail.js';
import type { AcceptedRegression, GateExecutorOverride, GatePodPoolOverride, GateShardRerouteOverride } from '../../scripts/release-loop/resume-types.js';
import type { AdaptiveGateHealAppendNodeRequest, AdaptiveGateHealRerunGateRequest } from '../../scripts/release-loop/adaptive-gate-heal-adapter.js';
import type { ReleaseOpEvent } from '../release-loop/op-channel.js';
import type { MsgStore } from '../msg/msg-store.js';

export type GraphGrowthScope = 'harness' | 'task-agent';
type BashRun = WorkflowDeps['runBash'];

/** Parent graph budgets inherited by child unit runs. Internal runGraph handoff only. */
export interface GraphLoopBudgetScope { readonly graphId: string; readonly runId: string; readonly llmCalls: number }

export interface GraphRunState {
  graphId: string;
  runId: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  pidStartedAt?: string;
  activeNode?: { nodeId: string; pid: number; pidStartedAt: string };
  stoppedAt?: string;
  status: 'running' | 'paused' | 'cancelled' | 'done' | 'failed' | 'budget-exceeded' | 'awaiting-approval';
  forkedFromRunId?: string;
  forkedFromCommit?: string;
  forkedToCommit?: string;
  pausedAt?: string;
  cancelledAt?: string;
  /** Original named terminal when status is its canonical done/failed mapping. */
  reason?: string;
  path: string[];
  /** Dry-run path with each fan-out branch's planned writes expanded before its join. */
  plannedPath?: string[];
  /** startedAt/endedAt (ISO) and seconds are written when the node runs; ledgers before GRAPH-NODE-TIMES (0.2.19) have none. */
  nodes: Array<{ nodeId: string; executionId?: string; ok: boolean; exit: number | null; executed: boolean; output?: unknown; error?: string; reason?: string;
    /** Safe destination selected before output redaction; preserves resume routing without storing the outcome value. */
    resumeNextNode?: string;
    /** Legacy destination field written by the previous secret-binding revision. */
    commandNextNode?: string;
    completionReceipt?: { inputSha256: string; commit: string; artifactSha256: string };
    invalidatedByEvent?: string;
    failure?: { errorCode: string; message: string; stage: string }; decidedBy?: string; decidedAt?: string;
    startedAt?: string; endedAt?: string; seconds?: number;
    waiver?: { reason: string; at: string; approvedBy?: string; introducedIds?: string[]; ownerWaived?: boolean; /** RELEASE-WAIVE-UNMEASURED — why the waived gate had no verdict. */ unmeasured?: string; original: { exit: number | null; output?: unknown; error?: string } } }>;
  /** The node now running and when it started; cleared when its record is written. */
  currentNode?: { nodeId: string; executionId?: string; startedAt: string };
  input?: unknown;
  kstDayFallback?: { reason: 'missing-calendar-day' | 'invalid-calendar-day'; selected: string };
  pending?: { nodeId: string; message: string; since: string; inputSha256?: string; approvalNonce?: string; notifiedAt?: string; decision?: 'approved' | 'rejected'; outcome?: string; decidedBy?: string; decidedAt?: string };
  approvalSourceHash?: string;
  /** Hash of the graph and recipes used for this run; required to safely restart a failed path. */
  sourceHash?: string;
  graphSnapshot?: { graphSha: string; recipesSha: string };
  /** Direct child units resolved when this run began; resume must use the same definitions. */
  unitPins?: Record<string, { unit: string; version: number; path: string; hash: string; shapeHash?: string }>;
  /** v2 extension data retained in the run ledger; graphHash binds it to the lowered IR. */
  graphExtensionLedger?: { graphHash: string; ext: GraphV2ExtensionLedger };
  graphPath?: string;
  variant?: { overlayId: string; goal: string; plan: GraphVariantPlan };
  parentRunId?: string;
  /** The entry chosen by a parent call; absent for existing single-entry runs. */
  entryNodeId?: string;
  /** Monotonic graph event sequence; carried across resume for subscriber dedupe. */
  graphEventSequence?: number;
  /** Auditable dispositions for event-driven scheduler actions. */
  subscriptionActions?: Array<{ eventId: string; subscriberId: string; nodeId: string;
    action: GraphSubscriptionDispatch['action']; outcome: 'queued' | 'handled' | 'rejected'; reason?: string; at: string }>;
  /** Durable undispatched actions and wake continuation, restored after interruption/resume. */
  pendingSubscriptionActions?: Array<{ subscriberId: string; nodeId: string; action: GraphSubscriptionDispatch['action']; event: GraphEvent;
    returnTo?: string; failureTo?: string; errorTo?: string; recoveryTo?: string; appendNodeIds?: string[] }>;
  wakeContinuation?: { nodeId: string; returnTo?: string; failureTo?: string; errorTo?: string; recoveryTo?: string; appendNodeIds?: string[] };
  /** Validated append-only subgraphs installed by a subscriber and restored on resume. */
  subscriptionGraphAppends?: Array<{ proposal: GraphSubgraphAppendProposal; eventId: string; subscriberId: string }>;
  /** Subscriber-proposed event vocabulary and direct edges, durable across run resume. */
  adaptiveGraphVocabulary?: string[];
  adaptiveGraphEdges?: Array<{ from: string; to: string; triggerEvent: string; rationale: string; eventId: string; subscriberId: string }>;
  /** Durable MRTR handoff emitted by a high-risk ARG open proposal. */
  argInputRequests?: Array<{ eventId: string; resultType: 'input_required';
    requestState: Readonly<Record<string, string | number>>;
    inputRequests: readonly { readonly kind: 'approval'; readonly prompt: string }[] }>;
  /** Release ARG append receipts keyed by the originating bus event identity. */
  adaptiveGateNodeAppends?: Array<{ eventId: string; request: AdaptiveGateHealAppendNodeRequest; graphRevision: number }>;
  /** Same-run host-to-Pod reruns are idempotent per gate failure event. */
  adaptiveGateReruns?: Array<{ eventId: string; request: AdaptiveGateHealRerunGateRequest }>;
  /** Monotonic revision for run-local graph appends; starts at 1 for the loaded graph. */
  graphRevision?: number;
  /** Failed event envelopes remain byte-for-byte retryable so successful subscribers dedupe. */
  pendingGraphEvents?: GraphEvent[];
  unitCalls?: Array<{ node: string; unit: string; version: number; hash: string; shapeHash?: string; childRunId: string; exit: string; steps: number; entry?: string; visit?: number; enteredAtMs?: number; exitedAtMs?: number; durationMs?: number }>;
  /** Persisted fan-out child identities and terminal results; successful branches are immutable on resume. */
  fanOuts?: Record<string, { from: string; join: string; branches: Record<string, {
    runId: string; status: 'running' | 'done' | 'failed'; startedAt: string; endedAt?: string;
    artifactSha256?: string; output?: unknown; error?: string; path?: string[];
    waiver?: { verdict: 'waived'; decidedBy: 'OP'; reason: string; documentSha256: string; signatureSha256: string; pairedLogSha256: string; originalStatus: 'failed' };
    completionReceipt?: { inputSha256: string; commit: string; artifactSha256: string };
  }> }>;
  /** Highest visit number handed to each unit in this run; not rewound by a restart, so
   *  a resumed run never reuses a (runId, unit, visit) span. */
  unitVisitSeq?: Record<string, number>;
  growth?: GraphGrowth[];
  growthRejections?: Array<{ from: string; outcome: string; reason: string }>;
  growthAttempts?: number;
  /** `rejected` can represent a cap refusal before proposer invocation; `proposal` means the proposer was actually called.
   * Legacy parked states without this field resume append-only, so their first recorded event may be applied/rejected. */
  growthEvents?: Array<{ phase: 'proposal' | 'parked' | 'applied' | 'rejected' | 'undo-available'; from: string; outcome: string; at: string; nodeId?: string; kind?: string; reason?: string; undo?: GraphGrowth['undo'] }>;
  growthPark?: { from: string; outcome: string; reason: string; decisionId: string; decisionRef: string; growth: GraphGrowth; command?: GrowthCommand; approval?: string };
  /** An in-flight declared repair/detour survives a process restart before its rejoin. */
  healPending?: { edgeRef: string; from: string; via: string; to: string; exhaustedTo: string };
  /** The declared edge selected for each completed source visit. */
  healTransitions?: Array<{ edgeRef: string; kind: string; from: string; visit: number; to: string }>;
  resume?: { from: string; visitId?: string; at: string; previousStatus: GraphRunState['status']; graph?: 'snapshot' | 'current'; budgetReset?: { reason: string; at: string; priorExecuted: number; resumedPrefixExecuted: number; priorUnitCalls: number; resumedPrefixUnitCalls: number } };
  /** GRAPH-RECIPE-PIN-FU — resume refusals from graph/recipes edition drift,
   *  recorded in the run ledger before any node effect executes. */
  sourcePinRefusals?: Array<{ at: string; reason: string; graphSha: string; recipesSha: string; pinnedGraphSha: string; pinnedRecipesSha: string }>;
  /** GATE-HOST-EXECUTOR — every explicit input change a resume made (what was set and what it replaced), oldest first. */
  inputOverrides?: Array<GateExecutorOverride | GatePodPoolOverride | GateShardRerouteOverride>;
  executed: number;
  dryRun: boolean;
  statePath: string;
}

export interface GraphRunOptions {
  /** Event envelope clock for deterministic simulation; defaults to the wall clock. */
  eventNow?: () => Date;
  input?: unknown;
  /** Authenticated owner from the host route; graph input cannot establish this identity. */
  verifiedOwnerId?: string;
  /** Merge a small compatibility repair into the saved input while holding the run's resume lock. */
  resumeInputPatch?: Record<string, unknown>;
  /** Abort an active graph command and stop before dispatching the next node. */
  signal?: AbortSignal;
  /** Bytes already checked by the tick gate, used for a current-graph start or legacy resume. */
  graphSource?: string;
  dryRun?: boolean;
  variant?: { goal: string; plan: GraphVariantPlan };
  runId?: string;
  /** Optional structured event sink for actual node lifecycle events and declared subscriptions. */
  eventBus?: GraphEventBus;
  /** Root containing graph declarations with triggers.event: { from, on }. */
  graphEventTriggerRoot?: string;
  /** Internal dispatch runs disable routing to keep one event delivery from recursively fanning out. */
  routeGraphEvents?: boolean;
  resumeRunId?: string;
  resumeGraphId?: string;
  fromNodeId?: string;
  /** Exact execution ID of a saved node visit, including repeated visits. */
  fromVisitId?: string;
  /** Embedded runs (a classify verdict inside self-implement) keep the per-node `[graph]` stderr lines off the caller's terminal; debug.log still records every node. */
  quiet?: boolean;
  /** Release-only: accept the recorded failed node without executing it, and expose its regression to known-issues. */
  releaseWaiver?: { nodeId: string; reason: string; requestedRegressions: AcceptedRegression[]; acceptedRegressions: AcceptedRegression[]; approvedBy?: string; introducedIds?: string[]; ownerWaived?: boolean; unmeasured?: string };
  releasePwaFanOutWaiver?: { reason: string };
  /** Release-only: durable authorization ledger from which a waived graph transition must be consumed. */
  waiverLedgerRoot?: string;
  /** Release-only: add accepted issues independently of a waiver at a restart boundary. */
  releaseAcceptedRegressions?: { requested: AcceptedRegression[]; acceptedRegressions: AcceptedRegression[] };
  /** Release-only (GATE-HOST-EXECUTOR): run the restarted gate on this executor — recorded in `inputOverrides`, never a waiver. */
  releaseGateExecutor?: { executor: string; host?: string };
  /** Release-only (RESUME-GATE-POOL-OVERRIDE): replace the saved gate pool for this resumed gate. */
  releaseGatePodPool?: string;
  /** Release-only: remeasure a shard after the same-commit resume preflight. */
  releaseGateShardReroute?: { shard: string; host?: string; os?: 'darwin' | 'linux' };
  /** Release-only: explicit, reasoned restart after the graph's execution budget stopped the run. */
  releaseBudgetExceededResume?: { reason: string };
  useCurrentGraph?: boolean;
  /** Internal unit invocation context, propagated only by runGraph. */
  unitContext?: { parentRunId: string; ancestors: readonly string[]; remainingSteps: number; entryNodeId?: string };
  /** Internal provider-call budget scopes inherited by child unit runs. */
  loopBudgetScopes?: readonly GraphLoopBudgetScope[];
  /**
   * RELEASE-LEDGER-UNIVERSE — stamp every cmd: child with this run's ledger root (`ELANOUS_STATE_DIR`).
   * Without it a child launched from a non-leader tree (`bun scripts/...` with cwd = that tree) re-resolves
   * its own universe and lands in the tree-derived test universe while the run ledger is prod.
   */
  pinChildUniverse?: boolean;
  /** Release resume: command checkout and cut tip, checked before every Bash dispatch. */
  releaseCommandSource?: { root: string; cutTip: string; git?: (args: string[]) => string };
  /** Internal fan-out child: the parent release ledger's verified cut tip. */
  branchCutTip?: string;
  /** Internal fan-out child: the original release graph snapshot (its entry-only graph is synthetic). */
  branchGraphSnapshot?: { graphSha: string; recipesSha: string };
  /** Parent outputs visible to a fan-out child, before its branch-local outputs. */
  branchParentOutputs?: Readonly<Record<string, unknown>>;
  /** Internal fan-out proof: parent revalidated the signed T6 post-gate route. */
  branchWaiverParentRunId?: string;
  /** Optional per-run Bloom edge policy hook. */
  researchEdgeDecisionRegistry?: ResearchEdgeDecisionRegistry;
  deps?: {
    root?: string;
    /** Trusted caller's ARG feedback universe; release operations default to prod. */
    argFeedbackUniverse?: 'test' | 'prod';
    runBash?: BashRun;
    /** Resolve a graph YAML secret name from the Elanous secret store (injectable for simulations). */
    resolveGraphSecret?: (name: string) => Promise<string | undefined>;
    callLLM?: (prompt: string) => Promise<string>;
    log?: (event: string, data: Record<string, unknown>) => void;
    releaseStageMail?: (input: { runId: string; nodeId: string; state: ReleaseStageState }) => unknown;
    releaseOpEventWriter?: (store: MsgStore, event: ReleaseOpEvent) => unknown;
    releaseOpChannel?: boolean;
    releaseOpMode?: 'shadow' | 'operational' | (() => 'shadow' | 'operational');
    releaseOpDecisionObserver?: (event: { nodeId: string; decision: 'go' | 'no-go'; mode: 'shadow' | 'operational' }) => void;
    releaseGraphEventAdapters?: boolean;
    dispatchGraphSubscription?: (dispatch: GraphSubscriptionDispatch) => void | Promise<void>;
    proposeGraphEdge?: GraphEdgeAdditionApi;
    /** Observer failures are isolated; returned promises are serialized off the graph execution path. */
    nodeLifecycle?: (event: GraphNodeLifecycleEvent) => void | Promise<void>;
    /** Optional post-arrival binding check; used by callers that enforce additional dispatch constraints. */
    validateNodeBinding?: (nodeId: string, command: string | undefined) => void;
    /** Fault-injection hook for verifying lifecycle closure and persisted resume state. */
    beforePersist?: (state: GraphRunState) => void;
    /** Run a state write inside a caller-owned persistence fence. */
    withPersistFence?: (state: GraphRunState, persist: () => void) => void;
    beforeNode?: () => void;
    /** Observe heal-loop terminal failures without making notification delivery affect the saved verdict. */
    postOpAlert?: (body: string) => void;
    processStartMs?: (pid: number) => number | null;
    monotonicMs?: () => number;
    growthProposer?: GrowthProposer;
    growthLLM?: (prompt: string) => Promise<string>;
    growthScope?: GraphGrowthScope;
    classifyGrowthRecipe?: (node: GraphNodeSpec, resolved: { command?: string; approval?: string }) => GrowthRecipeEffect;
    growthDecision?: GrowthDecisionDeps & { list?: (filters: { status: 'all' }) => DecisionEntry[] };
    inProcessHandlers?: InProcessHandlerRegistry;
    /** Generic provider bindings for the closed `cap:<name>` capability vocabulary. */
    capabilityProviders?: GraphCapabilityProviders;
  };
}

/** Best-effort lifecycle signal consumed by release-loop observers. */
export type GraphNodeLifecyclePhase = 'arrival' | 'start' | 'end' | 'leave';
export interface GraphNodeLifecycleEvent {
  eventId: string;
  seq: number;
  kind: 'node.lifecycle';
  source: 'graph-runner';
  phase: GraphNodeLifecyclePhase;
  graphId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  visit: number;
  dryRun: boolean;
  at: string;
  outcome?: 'ok' | 'fail';
  nextNodeId?: string;
  reason?: string;
  data: {
    phase: GraphNodeLifecyclePhase;
    visit: number;
    dryRun: boolean;
    at: string;
    nextNodeId?: string;
    reason?: string;
  };
}

export type GraphRun = (path: string, options?: GraphRunOptions) => Promise<GraphRunState>;
