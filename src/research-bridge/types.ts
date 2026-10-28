// PLAN §4.4 · Phase 1.4 — `/research` ↔ omni-crawl bridge types.
//
// The bridge captures the result of a single skill invocation
// (default: omni-crawl) so the next user turn carries it as
// "external context" the LLM should treat like cited research.

export interface ExternalResearchResult {
  /** User-supplied topic / query string. */
  topic: string;
  /** Skill that produced the result. Default: 'omni-crawl'. */
  skill: string;
  /** ISO timestamp when invocation started. */
  startedAt: string;
  /** ISO timestamp when invocation finished. */
  finishedAt: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** True when the skill returned non-empty output without error. */
  ok: boolean;
  /** Full markdown output from the skill (capped to ~16 KiB on
   *  archive — see store.ts MAX_OUTPUT_BYTES). */
  output: string;
  /** Truthy when the skill threw or exited non-zero; empty on success. */
  error?: string;
}

/** Optional knobs for `invokeResearch`. */
export interface InvokeResearchOpts {
  /** Skill name override; default 'omni-crawl'. */
  skill?: string;
  /** Stream progress chunks back to the caller (e.g. dashboard chat
   *  pane) so the user sees activity for long-running invocations. */
  onProgress?: (delta: string) => void;
  /** Cancel a bounded automatic follow-up when its caller's time budget expires. */
  signal?: AbortSignal;
}
