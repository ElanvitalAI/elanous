// Firecrawl web-search provider.
//
// Auto-registered alongside Grok in src/web-search/index.ts via
// `addWebSearchProvider`. Available iff the canonical Firecrawl config
// resolver returns an API key (user-config first, then legacy env fallback).
//
// Calls Firecrawl's /v1/search endpoint (REST). Returns up to
// `limit` hits (default 5). allowDomains / blockDomains pass
// through; recencyDays unsupported by Firecrawl search and silently
// dropped.

import { getFirecrawlConfig } from '../registry/discovery/config.js';
import { getSecretAsync, selectBackendFromConfig } from '../nexus/config/secrets/index.js';
import { readSearchJson, runSearchWithDeadline } from '../graph-runner/capability-providers/search-web-deadline.js';
import {
  type WebSearchHit,
  type WebSearchProvider,
  type WebSearchQuery,
  type WebSearchResult,
} from './provider.js';

const FIRECRAWL_API = 'https://api.firecrawl.dev/v1/search';

type FirecrawlConfigResolver = () => { apiKey: string };

export function buildFirecrawlWebSearchProvider(
  resolveConfig: FirecrawlConfigResolver = getFirecrawlConfig,
  deps: { keyLookup?: (slot: string) => Promise<string | undefined>; fetch?: typeof fetch } = {},
): WebSearchProvider {
  const lookup = deps.keyLookup ?? (async slot => { selectBackendFromConfig(); return getSecretAsync(slot); });
  const keyForRequest = async () => {
    let stored: string | undefined;
    try { stored = await lookup('cred:firecrawl.api_key'); }
    catch { throw new Error('Firecrawl credential unavailable'); }
    return stored === undefined ? resolveConfig().apiKey.trim() : stored.trim();
  };
  return {
    id: 'firecrawl',
    displayName: 'Firecrawl',
    available: () => !!resolveConfig().apiKey,
    availableAsync: signal => runSearchWithDeadline(async scope => {
      scope.throwIfAborted();
      const key = await keyForRequest(); scope.throwIfAborted(); return !!key;
    }, signal),
    async search(q: WebSearchQuery, signal?: AbortSignal): Promise<WebSearchResult> {
      return runSearchWithDeadline(async scope => {
      scope.throwIfAborted();
      const key = await keyForRequest();
      scope.throwIfAborted();
      if (!key) throw new Error('Firecrawl API key not configured');
      const limit = Math.max(1, Math.min(q.limit ?? 5, 20));
      const body: Record<string, unknown> = { query: q.query, limit };
      // Firecrawl supports "tbs" hints for recency but not direct
      // domain filtering on /v1/search; we pre-/post-filter.
      const resp = await (deps.fetch ?? fetch)(FIRECRAWL_API, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: scope, redirect: 'error',
      });
      if (!resp.ok) {
        throw new Error(`Firecrawl search HTTP ${resp.status}`);
      }
      const json = await readSearchJson(resp, scope, 1_000_000) as { data?: Array<Record<string, unknown>> };
      const items = Array.isArray(json.data) ? json.data : [];
      let hits: WebSearchHit[] = items.map(it => ({
        url: String(it.url ?? ''),
        title: String(it.title ?? it.url ?? '(untitled)'),
        snippet: String(it.description ?? it.snippet ?? ''),
        metadata: it,
      })).filter(h => h.url);

      if (q.allowDomains && q.allowDomains.length > 0) {
        const allow = q.allowDomains.map(d => d.toLowerCase());
        hits = hits.filter(h => allow.some(d => safeHostname(h.url).endsWith(d)));
      }
      if (q.blockDomains && q.blockDomains.length > 0) {
        const block = q.blockDomains.map(d => d.toLowerCase());
        hits = hits.filter(h => !block.some(d => safeHostname(h.url).endsWith(d)));
      }

      return { hits, providerName: 'firecrawl', durationMs: 0 };
      }, signal);
    },
  };
}

function safeHostname(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}
