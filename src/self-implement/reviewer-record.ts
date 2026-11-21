/**
 * TA-POD-REVIEW-PROVIDER-ALLOW (reviewer record) — which provider/model actually reviewed a round.
 *
 * Until now the pair lived only in the review decision event; the task card and the PR never said who reviewed.
 * One value, `reviewer=<provider>/<model>`, is written to the card history and the PR round comment.
 * Only provider and model NAMES travel: each part is cut to an allowlisted charset and a length cap, and a part that looks
 * like a credential drops the whole line (no line is better than a leaked one).
 */

/** Longest accepted provider or model name; longer is not a name. */
export const REVIEWER_PART_MAX_CHARS = 80;

const NAME_CHARS = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const CREDENTIAL_LIKE = /(?:^|[^a-z])(?:sk|pk|ghp|gho|xox[a-z]|AKIA|eyJ)[-_A-Za-z0-9]{6,}|bearer|token=|secret|password|api[-_]?key/i;

export interface ReviewerRan { readonly provider: string; readonly model: string }

/** `reviewer=<provider>/<model>`, or `undefined` when either part is not a plain name. */
export function reviewerTag(reviewer: ReviewerRan | undefined): string | undefined {
  if (!reviewer) return undefined;
  const parts = [reviewer.provider, reviewer.model];
  for (const part of parts) {
    if (typeof part !== 'string' || part.length === 0 || part.length > REVIEWER_PART_MAX_CHARS) return undefined;
    if (!NAME_CHARS.test(part) || CREDENTIAL_LIKE.test(part)) return undefined;
  }
  return `reviewer=${reviewer.provider}/${reviewer.model}`;
}

/** Default card writer: one `reviewer` history line on the card, if this machine has it. */
export function recordReviewerOnCard(cardId: string, event: { detail: string; runId?: string }): void {
  const { taskAgentStatePath, updateTaskCard } = require('../task-agent/task-card-state.js') as typeof import('../task-agent/task-card-state.js');
  updateTaskCard(taskAgentStatePath(), cardId, (card) => card
    ? { ...card, history: [...card.history, { at: new Date().toISOString(), event: 'reviewer', ...event }] }
    : undefined);
}
