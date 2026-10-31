// ── Web-search registry ──
//
// Holds the list of registered providers + a `searchWeb()` entry
// point that picks the first available provider (by registration
// order) and routes the query. Callers that want a specific
// provider pass `providerId` to force the choice.

import { buildGrokSubscriptionWebSearchProvider, buildGrokWebSearchProvider } from './grok.js';
import { buildExaWebSearchProvider } from './exa.js';
import { buildFirecrawlWebSearchProvider } from './firecrawl.js';
import { buildTavilyWebSearchProvider } from './tavily.js';
import { buildFreeWebSearchProvider } from './free.js';
import { isPaidWebSearchEnabled, isTavilySearchEnabled } from '../user-config.js';
import { debug } from '../debug/log.js';
import { wantsGrokSearch, wantsXSearch } from './x-intent.js';
import {
  type WebSearchProvider,
  type WebSearchQuery,
  type WebSearchResult,
  WebSearchUnavailableError,
} from './provider.js';

export type { WebSearchProvider, WebSearchQuery, WebSearchResult, WebSearchHit } from './provider.js';
export { WebSearchUnavailableError } from './provider.js';

/** Registered providers, in preference order. Consumers append via
 *  addWebSearchProvider; the built-in Grok adapter is registered at
 *  module load (before first call). Tests reset via
 *  _resetWebSearchProvidersForTests. */
const providers: WebSearchProvider[] = [];
let includeEnvironmentResearchExa = true;

function registerBuiltins(): void {
  // General web cascade is Exa → Firecrawl; Grok is reserved for explicit X/Twitter intent.
  // Other providers remain registered for explicit provider selection only.
  // Provider registration snapshots config at module load; changing these gates requires a process restart.
  providers.push(buildExaWebSearchProvider());
  if (isPaidWebSearchEnabled('firecrawl')) providers.push(buildFirecrawlWebSearchProvider());
  if (isTavilySearchEnabled()) providers.push(buildTavilyWebSearchProvider());
  providers.push(buildGrokSubscriptionWebSearchProvider());
  if (isPaidWebSearchEnabled('grokApi')) providers.push(buildGrokWebSearchProvider({ id: 'grok-api' }));
  providers.push(buildFreeWebSearchProvider());
}
registerBuiltins();

/** Add a provider. Appended to the end of the preference list, so
 *  it runs only if earlier providers are unavailable or throw. Use
 *  addWebSearchProviderFirst() to prepend. */
export function addWebSearchProvider(provider: WebSearchProvider): void {
  providers.push(provider);
}

/** Prepend — next searchWeb() call will try this provider first. */
export function addWebSearchProviderFirst(provider: WebSearchProvider): void {
  providers.unshift(provider);
}

/** List provider ids in preference order. Exposed for the tool's
 *  prompt summary + `/tools` slash display. */
export function listWebSearchProviders(): Array<{ id: string; displayName: string; available: boolean }> {
  return providers.map(p => ({ id: p.id, displayName: p.displayName, available: p.available() }));
}

/** Run a search. Picks the first available provider (or the one
 *  matching `providerId` when supplied) and calls its search(). If
 *  the chosen provider errors, cascades through remaining available
 *  providers. Throws WebSearchUnavailableError when the cascade
 *  exhausts. */
export async function searchWeb(
  q: WebSearchQuery,
  opts: { providerId?: string; signal?: AbortSignal } = {},
): Promise<WebSearchResult> {
  const xIntent = !opts.providerId && wantsXSearch(q.query);
  const grokIntent = !opts.providerId && wantsGrokSearch(q.query);
  const candidates = opts.providerId
    ? providers.filter(p => p.id === opts.providerId || (opts.providerId === 'grok' && p.id === 'grok-api'))
    : providers.filter(p => p.available() && (grokIntent
      ? p.id === 'grok' || p.id === 'grok-api' || p.id === 'exa' || p.id === 'firecrawl'
      : p.id === 'exa' || p.id === 'firecrawl'));
  if (grokIntent) {
    const grokIndex = candidates.findIndex(p => p.id === 'grok' || p.id === 'grok-api');
    if (grokIndex > 0) candidates.unshift(...candidates.splice(grokIndex, 1));
  }
  if (candidates.length === 0) {
    const ordinaryProviderAvailable = providers.some(provider => provider.available() && (provider.id === 'exa' || provider.id === 'firecrawl'));
    const grokAvailable = providers.some(provider => provider.available() && (provider.id === 'grok' || provider.id === 'grok-api'));
    if (!opts.providerId && !grokIntent && grokAvailable && !ordinaryProviderAvailable) {
      throw new WebSearchUnavailableError(['grok'], ['policy:Grok is reserved for explicit X/Twitter searches. Configure Exa or Firecrawl for general web search.']);
    }
    throw new WebSearchUnavailableError(
      providers.map(p => p.id),
      providers.map(p => p.available() ? 'available (but id filter skipped)' : 'unavailable (check keys/binaries)'),
    );
  }

  const tried: string[] = [];
  const reasons: string[] = [];
  for (const provider of candidates) {
    if (!provider.available()) continue;
    tried.push(provider.id);
    try {
      const result = await provider.search(q, opts.signal);
      if (!xIntent) return result;
      if (provider.id === 'grok' || provider.id === 'grok-api') {
        const isXUrl = (raw: string): boolean => {
          try {
            const url = new URL(raw);
            return url.protocol === 'https:' && ['x.com', 'www.x.com'].includes(url.hostname.toLowerCase());
          } catch { return false; }
        };
        const hasXSource = result.hits.some(hit => hit.xSearchSource === true && isXUrl(hit.url));
        if (hasXSource) {
          debug.log('web-search.route', 'x-intent', { provider: provider.id, xIntent, fallback: false });
          return { ...result, xSearch: 'grok' };
        }
        debug.log('web-search.route', 'x-intent', { provider: provider.id, xIntent, fallback: true });
        const safeResult = { ...result };
        delete safeResult.note;
        return { ...safeResult, hits: result.hits.filter(hit => !isXUrl(hit.url)), xSearch: 'unavailable' };
      }
      debug.log('web-search.route', 'x-intent', { provider: provider.id, xIntent, fallback: true });
      return { ...result, xSearch: 'unavailable' };
    } catch (err: any) {
      reasons.push(err?.message ?? String(err));
    }
  }
  throw new WebSearchUnavailableError(tried, reasons);
}

/** Test-only reset — clears every registered provider and normally re-runs
 *  built-in registration. Pass false to isolate tests from credential-backed
 *  providers. Kept separate from the public API. */
export function _resetWebSearchProvidersForTests(includeBuiltins = true): void {
  providers.length = 0;
  // `false` means tests want a credential-independent provider set, including research discovery.
  includeEnvironmentResearchExa = includeBuiltins;
  if (includeBuiltins) registerBuiltins();
}

/** Snapshot of currently-available providers, in preference order.
 *  Exposed for parallel fan-out callers (omni_search P10) that don't
 *  want the cascade semantics of `searchWeb()`. */
export function getAvailableWebSearchProviders(): WebSearchProvider[] {
  return providers.filter(p => p.available());
}

/** Research-only provider snapshot. Exa stays out of the general registry/cascade so
 * adding a research credential cannot change ordinary WebSearch or OmniSearch defaults. */
export function getAvailableResearchWebSearchProviders(): WebSearchProvider[] {
  const available = getAvailableWebSearchProviders();
  if (available.some(provider => provider.id === 'exa')) return available;
  if (!includeEnvironmentResearchExa) return available;
  const exa = buildExaWebSearchProvider();
  return exa.available() ? [...available, exa] : available;
}
