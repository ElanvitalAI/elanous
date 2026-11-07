/** Release-loop macrophage: evidence-driven cleanup planning. Live mode emits decisions; mutations stay simulation-only. */

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
  | 'stale-receipt';

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
}

export interface MacrophageHealInput {
  phase: 'idle' | 'active';
  mode?: 'live' | 'simulation';
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
  }
}

const mutatingActions = new Set<MacrophageAction>(['triage-draft', 'remove-resource', 'release-hold', 'archive-receipt', 'remove-queue-row']);

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
    const applied = mode === 'simulation' && mutatingActions.has(decision.action);
    const result = mode === 'simulation'
      ? applied ? `simulated ${decision.action}` : `simulated recommendation ${decision.action}`
      : `planned ${decision.action}; no cleanup applied`;
    return { id: scrap.id, kind: scrap.kind, evidence: decision.evidence, result, action: decision.action, applied };
  });
  const removed = new Set(events.filter((event) => event.applied).map((event) => event.id));
  return { status: mode === 'simulation' ? 'simulated' : 'planned', events,
    remaining: input.inventory.filter((scrap) => !removed.has(scrap.id)).map((scrap) => scrap.id) };
}
