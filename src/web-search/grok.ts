// ── Grok web-search provider ──
//
// Adapter around Grok's server-side search (Agent Tools API) exposed as
// the native `web_search` provider. Grok runs web_search + x_search
// server-side and returns a synthesised answer + cited URLs, which we
// repackage as WebSearchHit[] so callers get a uniform shape regardless
// of provider.
//
// NOTE (2026-07-05): migrated off the deprecated live-search feature
// (chat/completions + search_parameters → HTTP 410) to the Agent Tools
// API via the shared `grokAgentSearch` helper (src/grok/agent-search.ts).
// Model = GROK_SEARCH_MODEL (grok-4-1-fast-reasoning, 가성비) — separate
// from the grok-4.3 chat provider.
//
// Why not just have skills call Grok directly (omni-crawl does)?
//   • The native `web_search` tool gives the MODEL-FACING surface a
//     single pluggable provider path — users can swap in Firecrawl or a
//     custom MCP provider without touching skill bodies.

import { getGrokApiKey } from '../config.js';
import { grokAgentSearch, GROK_SEARCH_MODEL } from '../grok/agent-search.js';
import { wantsXSearch } from './x-intent.js';
import type { WebSearchHit, WebSearchProvider, WebSearchResult } from './provider.js';

const DEFAULT_LIMIT = 5;
const GROK_TIMEOUT_MS = 45_000;

export function buildGrokWebSearchProvider(): WebSearchProvider {
  return {
    id: 'grok',
    displayName: 'Grok (xAI agent-tools search)',
    available: () => !!getGrokApiKey(),
    search: async (q, signal) => {
      const startedAt = Date.now();
      const limit = Math.max(1, Math.min(20, q.limit ?? DEFAULT_LIMIT));

      // Domain / recency filters aren't first-class in the Agent Tools
      // web_search schema, so fold them into the query as natural-language
      // hints (Grok honours them well). Keeps the provider contract intact
      // without passing unverified tool params.
      let query = q.query;
      if (q.allowDomains?.length) query += `\n(Prefer sources from: ${q.allowDomains.join(', ')})`;
      if (q.blockDomains?.length) query += `\n(Avoid sources from: ${q.blockDomains.join(', ')})`;
      if (q.recencyDays) query += `\n(Only results from the past ${q.recencyDays} days.)`;

      const r = await grokAgentSearch(query, {
        model: GROK_SEARCH_MODEL,
        tools: ['web_search', 'x_search'],
        systemPrompt: 'You are a concise web-search assistant. Answer in one or two sentences and let the cited sources carry the detail.',
        timeoutMs: GROK_TIMEOUT_MS,
        signal,
      });

      if (!r.ok) throw new Error(r.error ?? 'grok search failed');

      const xSourceUrls = new Set(r.xSearchSources ?? []);
      const citations = wantsXSearch(q.query)
        ? [...r.citations.filter(c => xSourceUrls.has(c.url)), ...r.citations.filter(c => !xSourceUrls.has(c.url))]
        : r.citations;
      const hits: WebSearchHit[] = citations.slice(0, limit).map(c => ({
        url: c.url,
        title: c.title ?? c.url,
        snippet: '',
        ...(xSourceUrls.has(c.url) ? { xSearchSource: true } : {}),
      }));

      const note = r.text.length > 0 ? r.text.slice(0, 1500) : undefined;
      return {
        hits,
        providerName: 'grok',
        durationMs: Date.now() - startedAt,
        ...(note ? { note } : {}),
      } satisfies WebSearchResult;
    },
  };
}
