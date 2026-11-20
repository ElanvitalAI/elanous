/**
 * TA-RETRY-VISIBLE-NO-AUTO (POOL-QUEUE 59) — which child failures the orchestrator's one automatic repair must NOT retry.
 *
 * Live 11-18 (self-implement.pod logs): in runs run-7f94dd65 · run-c0ef17c1 · run-437ac18f a Job failed with
 * «no-usable-provider: openrouter(…)=provider-not-allowed, grok(…)=provider-not-allowed» and the «자동 수복 1회» repair
 * (orchestrate.ts task-failed) launched a new Job 6–8 s later with no approval; it failed the same way every time.
 * A failure decided by configuration (no provider the child may use) is deterministic: the narrower retry runs on the
 * same config and cannot pass. Those are skipped and reported; everything else keeps the one repair as before.
 */

import { isNoReviewProviderText } from './no-review-provider.js';

export type DeterministicFailureClass = 'no-usable-provider' | 'provider-not-allowed' | 'no-review-provider';

/**
 * Skip reasons that come from configuration, so a retry meets them again. Source: src/llm.ts FallbackCandidateSkipReason
 * (`unknown-step` · `folded-into-earlier-step`) plus the provider allow check (`provider-not-allowed`).
 * `already-attempted` / `not-available` mean the providers failed or were down THIS turn (429 · 5xx · exhaustion) —
 * transient, so the one repair stays (JUD #38634 ⓑ).
 */
const CONFIG_DECIDED_REASONS: ReadonlySet<string> = new Set(['provider-not-allowed', 'unknown-step', 'folded-into-earlier-step']);

export type RepairRetryVerdict =
  | { readonly retry: true }
  | { readonly retry: false; readonly failureClass: DeterministicFailureClass };

/** The per-provider reasons of a `no-usable-provider: a(m)=r, b(m)=r` text (src/llm.ts podNoUsableProviderReason). */
export function noUsableProviderReasons(text: string): string[] | null {
  const at = text.search(/\bno-usable-provider:/);
  if (at < 0) return null;
  const list = text.slice(at + 'no-usable-provider:'.length);
  return [...list.matchAll(/=([a-z][a-z-]*)/g)].map((m) => m[1]!);
}

export function repairRetryVerdict(errorCode: string | undefined, errorMessage: string | undefined): RepairRetryVerdict {
  const text = `${errorCode ?? ''}: ${errorMessage ?? ''}`;
  // TA-POD-REVIEW-PROVIDER-ALLOW: a review chain exhausted before any call (`role-chain-exhausted: <role>: …` or the
  // `no-review-provider:` marker) is decided by configuration and credentials; the repair Job meets the same chain.
  if (isNoReviewProviderText(text)) return { retry: false, failureClass: 'no-review-provider' };
  const reasons = noUsableProviderReasons(text);
  if (reasons !== null) {
    // Deterministic only when EVERY provider was ruled out by configuration; one transient reason keeps the repair.
    return reasons.length > 0 && reasons.every((reason) => CONFIG_DECIDED_REASONS.has(reason))
      ? { retry: false, failureClass: 'no-usable-provider' }
      : { retry: true };
  }
  if (/=provider-not-allowed\b/.test(text)) return { retry: false, failureClass: 'provider-not-allowed' };
  return { retry: true };
}
