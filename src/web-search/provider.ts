// ── Web-search provider interface ──
//
// Single contract that the native `web_search` tool routes through.
// Each provider (Grok live-search, Firecrawl, MCP, user-custom)
// implements this shape; the registry picks one based on user
// config + availability.
//
// Why an abstraction layer rather than a direct Grok call:
//   • The audit (내부 문서 `native-tool-source-audit`) notes all 3
//     reference projects expose web_search as a provider-backed
//     tool rather than hard-wired to one vendor.
//   • omni-crawl skill already calls Grok/Firecrawl directly; we
//     don't want to duplicate that. The native tool is for the
//     LLM's model-facing surface — skills keep their direct paths.
//   • Future providers (user custom command, MCP-backed search)
//     need a stable shape to plug into.

export interface WebSearchQuery {
  /** The natural-language query. Plain text; providers decide how
   *  to escape / tokenize. */
  query: string;
  /** Hint: how many results the caller wants. Providers MAY return
   *  fewer (rate limits, low-recall queries). Default 5. */
  limit?: number;
  /** Optional domain allowlist / blocklist hint — not all providers
   *  honour it, but Grok's search_parameters + Firecrawl both do. */
  allowDomains?: string[];
  blockDomains?: string[];
  /** Optional: recency filter in days. E.g. 30 for "past month".
   *  Providers that don't support it silently ignore. */
  recencyDays?: number;
}

export interface WebSearchHit {
  /** Canonical URL. */
  url: string;
  /** Page title (falls back to URL when unavailable). */
  title: string;
  /** Short snippet / summary — NOT the full body. Callers who want
   *  full content should fetch the URL via WebFetch. */
  snippet: string;
  /** Provider-supplied relevance score (0..1). Undefined when the
   *  provider doesn't score. */
  score?: number;
  /** Unix ms timestamp of the page if the provider knows it. */
  publishedAt?: number;
  /** Whether this URL came from an actual Grok x_search_call. */
  xSearchSource?: boolean;
  /** Pass-through metadata (provider-specific). Callers shouldn't
   *  depend on specific keys. */
  metadata?: Record<string, unknown>;
}

export interface WebSearchResult {
  hits: WebSearchHit[];
  /** Which provider served this result. Included so the tool
   *  renderer can show "via grok" etc. */
  providerName: string;
  /** X-intent outcome; 'grok' requires an x_search_call with an x.com hit. Absent for ordinary or explicitly routed searches. */
  xSearch?: 'grok' | 'unavailable';
  /** Wall-clock ms the call took. Zero on cached results. */
  durationMs: number;
  /** Provider-level note the model might find useful (e.g., "rate
   *  limited — retried with smaller limit"). Optional. */
  note?: string;
}

/** Thrown when no provider is available (no keys configured) or
 *  when every registered provider errored. Callers should display
 *  a clear hint instead of treating it as a generic tool error. */
export class WebSearchUnavailableError extends Error {
  constructor(public providers: string[], public reasons: string[]) {
    super(
      providers.length === 0
        ? 'No web-search providers are registered. Register one via addWebSearchProvider() or enable the built-in Grok adapter by setting a Grok API key.'
        : `All registered web-search providers failed: ${providers.map((p, i) => `${p}: ${reasons[i] ?? 'unknown'}`).join('; ')}`,
    );
    this.name = 'WebSearchUnavailableError';
  }
}

export interface WebSearchProvider {
  /** Stable identifier — user config references this when picking a
   *  default. Kebab-case convention ('grok', 'firecrawl', 'custom-cmd'). */
  id: string;
  /** Human-readable label for the log pane. */
  displayName: string;
  /** Is the provider usable right now? (keys present, binary on PATH,
   *  network reachable are all fair grounds to return false). */
  available(): boolean;
  /** Actually run the search. Throws on provider-level errors so the
   *  registry can fall through to the next provider. Implementations
   *  MUST respect AbortSignal when supplied. */
  search(q: WebSearchQuery, signal?: AbortSignal): Promise<WebSearchResult>;
}
