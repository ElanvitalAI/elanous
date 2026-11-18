/** What an owner-approval request came back with. Only `declined` is the owner saying no; every other reason means nobody decided. */
export type ApprovalHoldReason = 'timeout' | 'turn-cancelled' | 'host-cancelled' | 'unavailable';
export type ApprovalOutcome =
  | { readonly approved: true }
  | { readonly approved: false; readonly reason: 'declined' | ApprovalHoldReason };

export const APPROVAL_APPROVED: ApprovalOutcome = { approved: true };
export const APPROVAL_DECLINED: ApprovalOutcome = { approved: false, reason: 'declined' };

/** A plain boolean comes from an approver that cannot tell «no» from «nobody answered»: false stays a refusal (the old behavior). */
export function normalizeApproval(value: boolean | ApprovalOutcome): ApprovalOutcome {
  return typeof value === 'boolean' ? (value ? APPROVAL_APPROVED : APPROVAL_DECLINED) : value;
}

/** True when nobody decided (timeout, cancelled turn, no channel): the node must wait, not record a rejection. */
export function isApprovalHold(outcome: ApprovalOutcome): outcome is { approved: false; reason: ApprovalHoldReason } {
  return !outcome.approved && outcome.reason !== 'declined';
}

export interface ApprovalHold {
  readonly nodeId: string;
  readonly reason: ApprovalHoldReason;
  readonly message: string;
  /** Record the owner's decision on the held node (the trusted CLI step). */
  readonly decide: string;
  /** Then continue the same run; present only when the saved graph path is known (a made-up path would not run). */
  readonly resume?: string;
}

/** The note returned with a run that stays awaiting-approval after an undecided approval. */
export function approvalHold(
  state: { graphId: string; runId: string; graphPath?: string },
  nodeId: string,
  reason: ApprovalHoldReason,
): ApprovalHold {
  const why = reason === 'timeout' ? 'no one answered in time'
    : reason === 'unavailable' ? 'no approval channel was available' : 'the approval was cancelled before anyone decided';
  return {
    nodeId, reason,
    message: `Approval at ${nodeId} is on hold (${why}); it was NOT rejected. The run is still waiting: record the owner's decision, then resume the same run.`,
    decide: `eln graph approve ${shellQuote(state.graphId)} ${shellQuote(state.runId)}   (add --reject to refuse)`,
    ...(state.graphPath ? { resume: `eln graph run ${shellQuote(state.graphPath)} --resume ${shellQuote(state.runId)}` } : {}),
  };
}

/** POSIX single-quote a word so a path with spaces or metacharacters stays one argument. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}
