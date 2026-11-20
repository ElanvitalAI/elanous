/**
 * TA-POD-REVIEW-PROVIDER-ALLOW — a review whose provider chain is exhausted before any call is made.
 *
 * The reviewer was never run, so the failure is decided by configuration/credentials, not by this turn's traffic.
 * Three consumers share one vocabulary: the run ledger event, the unreviewed merge-hold reason (stop class → needs-owner)
 * and the orchestrator's one automatic repair (which must not retry it). Only provider NAMES and fixed reason codes
 * travel here; never a credential, token or model-call text.
 */

/** Ledger event name, error-message prefix and unreviewed merge-hold reason. */
export const NO_REVIEW_PROVIDER = 'no-review-provider';

/** Error text: `no-review-provider: <original exhaustion text>`. The prefix survives the 400-char failure-reason cut. */
export function noReviewProviderError(cause: string): Error {
  return new Error(`${NO_REVIEW_PROVIDER}: ${cause}`);
}

/** True for our own marker, or for a bare role-chain exhaustion text (`role-chain-exhausted: <role>: …`). */
export function isNoReviewProviderText(text: string | undefined): boolean {
  return typeof text === 'string' && /(?:^|[^a-z-])(?:no-review-provider|role-chain-exhausted):/.test(text);
}

/** Why a finished round has no real review: provider exhaustion gets its own reason, everything else stays `no-real-review`. */
export function unreviewedMergeReason(failureReason: string | undefined): 'no-review-provider' | 'no-real-review' {
  return isNoReviewProviderText(failureReason) ? NO_REVIEW_PROVIDER : 'no-real-review';
}

/** The one record line for the review model actually used: `reviewer=<provider>/<model>`, or `reviewer=none` when no review ran. Names only. */
export function reviewerRecordLine(reviewer: { provider: string; model: string } | undefined): string {
  const name = (value: string): string => value.replace(/[^A-Za-z0-9._:@+/-]/g, '').slice(0, 80);
  const provider = reviewer ? name(reviewer.provider) : '';
  const model = reviewer ? name(reviewer.model) : '';
  // A credential-shaped "name" is dropped whole (fail-safe: the line says none/unknown, never the value).
  const safe = (value: string): string => value.split('/').some((part) => /^(?:sk-|ghp_|gho_|github_pat_|xox|AIza|Bearer)/i.test(part) || /[A-Za-z0-9]{32,}/.test(part)) ? 'unknown' : value;
  return provider && model ? `reviewer=${safe(provider)}/${safe(model)}` : 'reviewer=none';
}
