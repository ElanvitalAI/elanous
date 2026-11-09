/** Release-loop macrophage: evidence-driven cleanup planning. Live mode emits decisions; mutations stay simulation-only. */
import { pickAutohealActionForState, type AutohealLadder } from '../self-implement/stop-autoheal.js';

export interface MacrophageFailurePromotion {
  mode: 'live' | 'shadow';
  action: 'attempt-repair' | 'retain';
  crossVerdict: 'agree' | 'disagree' | 'out-of-scope';
  reason: string;
  rollbackReason: string;
  overlayId?: string;
}

/** Promote one signature only when the macrophage policy and shared graph prescription independently agree. */
export function resolveMacrophageFailurePromotion(
  signature: MacrophageEvidence['failureSignature'],
  options: { loadLadder?: () => AutohealLadder; requestedMode?: unknown; policyAction?: MacrophageAction } = {},
): MacrophageFailurePromotion {
  if (signature !== 'type-error') return { mode: 'shadow', action: 'retain', crossVerdict: 'out-of-scope',
    reason: 'signature-out-of-scope', rollbackReason: 'signature-out-of-scope' };
  const policyAction = options.policyAction;
  if (policyAction !== 'attempt-repair') return { mode: 'shadow', action: 'retain',
    crossVerdict: 'disagree', reason: 'independent-cross-verdict-disagreed', rollbackReason: 'policy-action-mismatch-or-unavailable' };
  const graphPick = pickAutohealActionForState('gate-failed', { stop_class: 'gate-failed', failure_signature: signature }, options.loadLadder);
  if (graphPick.source !== 'graph' || graphPick.action !== policyAction) return { mode: 'shadow', action: policyAction,
    crossVerdict: 'disagree', reason: 'independent-cross-verdict-disagreed',
    rollbackReason: graphPick.fallbackReason ?? 'overlay-unavailable-or-action-mismatch',
    ...(graphPick.overlayId ? { overlayId: graphPick.overlayId } : {}) };
  if (options.requestedMode !== 'live') return { mode: 'shadow', action: policyAction, crossVerdict: 'agree',
    reason: 'live-mode-not-explicit', rollbackReason: options.requestedMode === 'simulation' ? 'simulation-only' : 'unknown-mode-setting',
    overlayId: graphPick.overlayId };
  return { mode: 'live', action: policyAction, crossVerdict: 'agree', reason: 'type-error-policy-and-overlay-agree',
    rollbackReason: 'none', overlayId: graphPick.overlayId };
}

export type MacrophageScrapKind =
  | 'parked-pr'
  | 'stale-draft'
  | 'repeated-failing-test'
  | 'flaky-timeout-test'
  | 'stale-generated-artifact'
  | 'orphan-worktree'
  | 'orphan-pod'
  | 'orphan-job'
  | 'merged-land-queue-row'
  | 'expired-hold'
  | 'stale-receipt'
  | 'release-node-failure'
  | 'merge-train-observation';

export type MacrophageAction =
  | 'attempt-repair'
  | 'notify-owner'
  | 'triage-draft'
  | 'open-cell'
  | 'quarantine-test'
  | 'regenerate'
  | 'remove-resource'
  | 'release-hold'
  | 'archive-receipt'
  | 'remove-queue-row'
  | 'retain';

export interface MacrophageEvidence {
  /** A repair recipe is present and bound to this PR. */
  repairRecipe?: string;
  /** Existing draft policy has already classified the draft. Unknown means no close recommendation. */
  draftAction?: 'close' | 'keep' | 'human';
  consecutiveFailures?: number;
  flaky?: boolean;
  timeoutBurned?: boolean;
  sourceFingerprint?: string;
  generatedFingerprint?: string;
  ownerRunStatus?: 'running' | 'done' | 'failed' | 'unknown';
  ownershipVerified?: boolean;
  holdUntil?: string;
  receiptStale?: boolean;
  receiptVerified?: boolean;
  detail?: string;
  mergedMainline?: boolean;
  queueRow?: string;
  worktreePath?: string;
  nodeId?: string;
  failureSignature?: 'configuration-missing' | 'type-error' | 'ledger-unconfigured' | 'unknown';
  failureDetail?: string;
  trainEventType?: 'merge-train.batch' | 'merge-train.verdict' | 'merge-train.incident';
}

export interface MacrophageScrap {
  id: string;
  kind: MacrophageScrapKind;
  owner?: string;
  evidence: MacrophageEvidence;
}

export interface MacrophageEvent {
  id: string;
  kind: MacrophageScrapKind;
  evidence: string;
  result: string;
  action: MacrophageAction;
  applied: boolean;
  sourceNodeId?: string;
  failureSignature?: MacrophageEvidence['failureSignature'];
  promotionMode?: 'live' | 'shadow';
  promotionReason?: string;
  rollbackReason?: string;
  promotionOverlayId?: string;
}

export interface MacrophageHealInput {
  phase: 'idle' | 'active';
  mode?: 'live' | 'simulation';
  /** Promotion requires a caller-supplied explicit mode; omission remains shadow. */
  promotionMode?: unknown;
  /** Injectable only for cross-verdict simulations; production uses the shared STOP-AUTOHEAL ladder. */
  promotionLadder?: () => AutohealLadder;
  now: Date;
  /** Explicit setting: the number of consecutive release failures that creates a repair cell. */
  consecutiveFailureLimit: number;
  inventory: readonly MacrophageScrap[];
}

export interface MacrophageHealResult {
  status: 'deferred' | 'planned' | 'simulated';
  events: MacrophageEvent[];
  remaining: string[];
}

const terminalRun = (status: MacrophageEvidence['ownerRunStatus']): boolean => status === 'done' || status === 'failed';

function decide(scrap: MacrophageScrap, input: MacrophageHealInput): { action: MacrophageAction; evidence: string } {
  const evidence = scrap.evidence;
  switch (scrap.kind) {
    case 'parked-pr':
      return evidence.repairRecipe
        ? { action: 'attempt-repair', evidence: `repair recipe=${evidence.repairRecipe}` }
        : scrap.owner
          ? { action: 'notify-owner', evidence: `owner=${scrap.owner}; repair recipe absent` }
          : { action: 'retain', evidence: 'PR owner and repair recipe are unverified' };
    case 'stale-draft':
      return evidence.ownerRunStatus === 'running'
        ? { action: 'retain', evidence: `draft owner run=running; owner=${scrap.owner ?? 'unknown'}` }
        : evidence.draftAction === 'close'
        ? { action: 'triage-draft', evidence: 'existing draft policy approved close' }
        : scrap.owner
          ? { action: 'notify-owner', evidence: `draft policy=${evidence.draftAction ?? 'unknown'}; owner=${scrap.owner}` }
          : { action: 'retain', evidence: `draft policy=${evidence.draftAction ?? 'unknown'}; owner unverified` };
    case 'repeated-failing-test':
      return Number.isInteger(evidence.consecutiveFailures) && evidence.consecutiveFailures! >= input.consecutiveFailureLimit && scrap.owner
        ? { action: 'open-cell', evidence: `consecutive failures=${evidence.consecutiveFailures}; owner=${scrap.owner}` }
        : { action: 'retain', evidence: `consecutive failures=${evidence.consecutiveFailures ?? 'unknown'}; threshold=${input.consecutiveFailureLimit}` };
    case 'flaky-timeout-test':
      return evidence.flaky || evidence.timeoutBurned
        ? { action: 'quarantine-test', evidence: `flaky=${evidence.flaky === undefined ? 'unknown' : evidence.flaky}; timeoutBurned=${evidence.timeoutBurned === undefined ? 'unknown' : evidence.timeoutBurned}` }
        : { action: 'retain', evidence: `flaky=${evidence.flaky === undefined ? 'unknown' : evidence.flaky}; timeoutBurned=${evidence.timeoutBurned === undefined ? 'unknown' : evidence.timeoutBurned}` };
    case 'stale-generated-artifact':
      return evidence.sourceFingerprint && evidence.generatedFingerprint && evidence.sourceFingerprint !== evidence.generatedFingerprint
        ? { action: 'regenerate', evidence: `source=${evidence.sourceFingerprint}; generated=${evidence.generatedFingerprint}` }
        : { action: 'retain', evidence: 'source/generated fingerprints do not prove staleness' };
    case 'orphan-worktree':
    case 'orphan-pod':
    case 'orphan-job':
      return evidence.ownerRunStatus === 'running'
        ? { action: 'retain', evidence: `kind=${scrap.kind}; owner run=running; owner=${scrap.owner ?? 'unknown'}` }
        : scrap.kind === 'orphan-worktree' && evidence.mergedMainline === true && evidence.ownershipVerified && evidence.worktreePath
        ? { action: 'remove-resource', evidence: `kind=orphan-worktree; branch merged to main; clean and inactive worktree verified` }
        : terminalRun(evidence.ownerRunStatus) && evidence.ownershipVerified
          ? { action: 'remove-resource', evidence: `kind=${scrap.kind}; owner run=${evidence.ownerRunStatus}; ownership verified` }
          : { action: 'retain', evidence: `kind=${scrap.kind}; owner run=${evidence.ownerRunStatus ?? 'unknown'}; ownership=${evidence.ownershipVerified ? 'verified' : 'unverified'}` };
    case 'merged-land-queue-row':
      return evidence.mergedMainline === true && typeof evidence.queueRow === 'string'
        ? { action: 'remove-queue-row', evidence: `PR merged; exact queued row verified (${scrap.id})` }
        : { action: 'retain', evidence: 'merge state or exact queue row is unverified' };
    case 'expired-hold': {
      const expiresAt = Date.parse(evidence.holdUntil ?? '');
      return evidence.ownerRunStatus === 'running'
        ? { action: 'retain', evidence: `hold owner run=running; expiry=${evidence.holdUntil ?? 'unknown'}; owner=${scrap.owner ?? 'unknown'}` }
        : Number.isFinite(expiresAt) && expiresAt <= input.now.getTime() && scrap.owner
        ? { action: 'release-hold', evidence: `hold expired at=${new Date(expiresAt).toISOString()}; owner=${scrap.owner}` }
        : { action: scrap.owner ? 'notify-owner' : 'retain', evidence: `hold expiry=${evidence.holdUntil ?? 'unknown'}; owner=${scrap.owner ?? 'unknown'}` };
    }
    case 'stale-receipt':
      return evidence.receiptStale === true && evidence.receiptVerified === true && terminalRun(evidence.ownerRunStatus)
        ? { action: 'archive-receipt', evidence: `stale and verified; owner run=${evidence.ownerRunStatus}` }
        : { action: 'retain', evidence: `stale=${evidence.receiptStale ?? 'unknown'}; verified=${evidence.receiptVerified ?? 'unknown'}; owner run=${evidence.ownerRunStatus ?? 'unknown'}` };
    case 'release-node-failure': {
      const detail = (evidence.failureDetail ?? 'diagnostic unavailable').slice(0, 400);
      const signature = evidence.failureSignature ?? 'unknown';
      const node = evidence.nodeId ?? 'unknown-node';
      if (signature === 'type-error') return { action: 'attempt-repair', evidence: `failure signature=${signature}; node=${node}; detail=${detail}` };
      if (signature === 'configuration-missing' || signature === 'ledger-unconfigured')
        return { action: 'open-cell', evidence: `failure signature=${signature}; node=${node}; detail=${detail}` };
      return { action: scrap.owner ? 'notify-owner' : 'retain', evidence: `failure signature=unknown; node=${node}; owner=${scrap.owner ?? 'unverified'}; detail=${detail}` };
    }
    case 'merge-train-observation':
      return { action: 'retain', evidence: `observed ${evidence.trainEventType ?? 'unknown train event'}; no train repair policy is attached; payload=${evidence.detail ?? 'unavailable'}` };
  }
}

const mutatingActions = new Set<MacrophageAction>([
  'triage-draft', 'quarantine-test', 'regenerate', 'remove-resource', 'release-hold', 'archive-receipt', 'remove-queue-row',
]);

/** Emit one evidence-backed decision per scrap by default; only simulation applies changes to its in-memory world. */
export function runMacrophageHeal(input: MacrophageHealInput): MacrophageHealResult {
  const mode = input.mode ?? 'live';
  if (!Number.isInteger(input.consecutiveFailureLimit) || input.consecutiveFailureLimit < 1) {
    throw new RangeError('consecutiveFailureLimit must be a positive integer');
  }
  if (!Number.isFinite(input.now.getTime())) throw new RangeError('now must be a valid date');
  const ids = new Set<string>();
  for (const scrap of input.inventory) {
    if (!scrap.id.trim() || ids.has(scrap.id)) throw new Error(`inventory scrap IDs must be non-empty and unique: ${scrap.id}`);
    ids.add(scrap.id);
  }
  if (input.phase === 'active') return { status: 'deferred', events: [], remaining: input.inventory.map((scrap) => scrap.id) };
  const events = input.inventory.map((scrap) => {
    const decision = decide(scrap, input);
    const promotion = scrap.kind === 'release-node-failure'
      ? resolveMacrophageFailurePromotion(scrap.evidence.failureSignature, {
        loadLadder: input.promotionLadder,
        requestedMode: mode === 'simulation' ? 'simulation' : input.promotionMode,
        policyAction: decision.action,
      })
      : undefined;
    const applied = mode === 'simulation' && mutatingActions.has(decision.action);
    const result = mode === 'simulation'
      ? applied ? `simulated ${decision.action}` : `simulated recommendation ${decision.action}`
      : `planned ${decision.action}; no cleanup applied`;
    return { id: scrap.id, kind: scrap.kind, evidence: decision.evidence, result, action: decision.action, applied,
      ...(promotion ? { promotionMode: promotion.mode, promotionReason: promotion.reason, rollbackReason: promotion.rollbackReason,
        ...(promotion.overlayId ? { promotionOverlayId: promotion.overlayId } : {}) } : {}),
      ...(scrap.kind === 'release-node-failure' ? { sourceNodeId: scrap.evidence.nodeId, failureSignature: scrap.evidence.failureSignature ?? 'unknown' } : {}) };
  });
  const removed = new Set(events.filter((event) => event.applied).map((event) => event.id));
  return { status: mode === 'simulation' ? 'simulated' : 'planned', events,
    remaining: input.inventory.filter((scrap) => !removed.has(scrap.id)).map((scrap) => scrap.id) };
}
