// REVIEW-NO-SILENT-GLM-FALLBACK (0.3.29) — a review is valid evidence only when the engine that
// answered is the engine that was asked. #38331 asked claude-acp and got an OpenRouter GLM verdict;
// the result still read `reviewed: true`. This module names both engines and marks the mismatch.
//
// One check for every route (claude-acp · terra-third/api `--model` · api default · role lane ·
// acp fallback): the caller passes what was requested and what the responder itself reported.
//
// #38365 Terra mustFix 1·2 — the responded family is read ONLY from the responder's own report, as a
// structured token (not a keyword guess), and is never filled in from the route. Unknown stays unknown.

/** Family token. Known synonyms fold to one name; any other leading token (deepseek, qwen, …) is its own family. */
export type ReviewEngineFamily = string;

/** The responder did not report a model, or its report names no family (e.g. claude ACP `default`). */
export const RESPONDED_ENGINE_UNMEASURED = 'unmeasured' as const;

export type ReviewInvalidReason = 'responded-model-mismatch' | 'responded-model-unknown';

// Synonyms only — a token missing here is NOT dropped; it is compared as its own family.
const FAMILY_ALIASES: Readonly<Record<string, string>> = {
  claude: 'claude', opus: 'claude', sonnet: 'claude', haiku: 'claude', anthropic: 'claude',
  gpt: 'gpt', codex: 'gpt', o: 'gpt', openai: 'gpt', terra: 'gpt', sol: 'gpt',
  glm: 'glm', zai: 'glm', z: 'glm',
  grok: 'grok', xai: 'grok',
  gemini: 'gemini', google: 'gemini',
};

// Tokens that state no family at all (selector words, not model names).
const NON_FAMILY_TOKENS: ReadonlySet<string> = new Set(['default', 'auto', 'best', 'latest', 'unknown', 'unmeasured', 'none']);

/**
 * Family named by a model id, backend id or `acp:<backend>[/<model>]` / `api:<model>` value.
 * Structured parse: drop the route prefix, take the last `/` segment (the model; vendor/provider path
 * segments precede it), take the part after a `<runtime>:` prefix, then its leading letter run.
 * Returns `undefined` when the text states no family.
 */
export function reviewEngineFamily(value: string | undefined | null): ReviewEngineFamily | undefined {
  let text = (value ?? '').trim().toLowerCase().replace(/^(acp|api):/, '');
  if (!text) return undefined;
  // `acp:claude/opus` → backend `claude` names the family; a model path keeps its last segment.
  const segments = text.split('/').filter(Boolean);
  text = segments.at(-1) ?? '';
  if (text.includes(':')) text = text.slice(text.lastIndexOf(':') + 1);
  const token = /^[a-z]+/.exec(text)?.[0];
  // #38365 Terra r3 — `anthropic/default`: only the provider path is known, never the family. Unknown stays unknown.
  if (!token || NON_FAMILY_TOKENS.has(token)) return undefined;
  return FAMILY_ALIASES[token] ?? token;
}

export interface ReviewEngineValidityInput {
  /** What the caller asked for (`acp:claude`, `gpt-6.1-terra`, `acp:claude-acp`); absent = no explicit request. */
  requested?: string | undefined;
  /** The model the responder itself reported (API provider resolution · ACP session model). Never the route. */
  respondedModel?: string | undefined;
  /** Landing-gate comparison of requested vs actual route (`mismatch` covers engine/route differences). */
  landingGateState?: 'consistent' | 'mismatch' | 'denied' | undefined;
}

export interface ReviewEngineValidity {
  invalid: boolean;
  invalidReason?: ReviewInvalidReason;
  requestedEngine?: ReviewEngineFamily;
  /** Family the responder reported, or `unmeasured`. Never inferred from the route. */
  respondedEngine: ReviewEngineFamily;
}

/**
 * ⛔ Requested engine ≠ responded engine ⇒ `invalid: true`:
 *   1. the landing gate saw a different route (claude-acp asked, api GLM answered) → `responded-model-mismatch`;
 *   2. the responder's own model names a different family → `responded-model-mismatch`;
 *   3. a request exists but the responder's family is unmeasured → `responded-model-unknown` (fail-closed:
 *      unknown is never counted as a match).
 * No explicit request ⇒ nothing to contradict; the responded engine is still reported as observed/unmeasured.
 */
export function assessReviewEngineValidity(input: ReviewEngineValidityInput): ReviewEngineValidity {
  const requestedEngine = input.requested ? reviewEngineFamily(input.requested) : undefined;
  const reported = reviewEngineFamily(input.respondedModel);
  const respondedEngine = reported ?? RESPONDED_ENGINE_UNMEASURED;
  const engines = { ...(requestedEngine ? { requestedEngine } : {}), respondedEngine };
  if (input.landingGateState === 'mismatch') return { invalid: true, invalidReason: 'responded-model-mismatch', ...engines };
  if (!input.requested) return { invalid: false, ...engines };
  if (reported === undefined) return { invalid: true, invalidReason: 'responded-model-unknown', ...engines };
  if (requestedEngine !== undefined && requestedEngine !== reported) {
    return { invalid: true, invalidReason: 'responded-model-mismatch', ...engines };
  }
  return { invalid: false, ...engines };
}
