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
import { buildFixedTestWebSearchProvider, testFixedSearchActive } from './test-fixed-search.js';
import { isPaidWebSearchEnabled, isTavilySearchEnabled } from '../user-config.js';
import { debug } from '../debug/log.js';
import { wantsGrokSearch, wantsXSearch } from './x-intent.js';
import {
  type WebSearchProvider,
  type WebSearchQuery,
  type WebSearchResult,
  WebSearchUnavailableError, webSearchProviderReady,
} from './provider.js';
import {
  type SearchProviderAvailability,
  SEARCH_PROVIDER_ROUTES, probeSearchProviderAvailability, probeSearchProviderReadiness,
} from './routing.js';

export type { WebSearchProvider, WebSearchQuery, WebSearchResult, WebSearchHit } from './provider.js';
export { WebSearchUnavailableError } from './provider.js';

/** Registered providers, in preference order. Consumers append via
 *  addWebSearchProvider; the built-in Grok adapter is registered at
 *  module load (before first call). Tests reset via
 *  _resetWebSearchProvidersForTests. */
const providers: WebSearchProvider[] = [];
let includeEnvironmentResearchExa = true;

function registerBuiltins(): void {
  // Test boundary: an isolated fake-LLM universe may pin one fixed provider instead of the credential-backed list.
  if (testFixedSearchActive()) { providers.push(buildFixedTestWebSearchProvider()); return; }
  // Firecrawl is the configured general default; DDG is the last keyless fallback. Grok stays explicit.
  // Other providers remain registered for explicit provider selection only.
  // Provider registration snapshots config at module load; changing these gates requires a process restart.
  if (isPaidWebSearchEnabled('firecrawl')) providers.push(buildFirecrawlWebSearchProvider());
  providers.push(buildExaWebSearchProvider());
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
  const explicitGrok = opts.providerId === 'grok' || opts.providerId === 'grok-api' || (!opts.providerId && wantsGrokSearch(q.query));
  // 출처: #37946 — ordinary (non-Grok) web search keeps one 15s caller-facing deadline.
  const ordinaryDeadlineMs = 15_000;
  const deadlineAt = explicitGrok ? undefined : Date.now() + ordinaryDeadlineMs;
  const searchSignal = explicitGrok ? opts.signal : opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(ordinaryDeadlineMs)]) : AbortSignal.timeout(ordinaryDeadlineMs);
  const grokIntent = !opts.providerId && wantsGrokSearch(q.query);
  const candidates = opts.providerId
    ? providers.filter(p => p.id === opts.providerId || (opts.providerId === 'grok' && p.id === 'grok-api'))
    : providers.filter(p => (grokIntent
      ? p.id === 'grok' || p.id === 'grok-api' || p.id === 'exa' || p.id === 'firecrawl'
      : ['firecrawl', 'exa', 'tavily', 'ddg-free'].includes(p.id)));
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

  const readiness = await Promise.all(candidates.map(provider => webSearchProviderReady(provider, searchSignal)));
  const readyCandidates = candidates.filter((_provider, index) => readiness[index]);
  searchSignal?.throwIfAborted();
  const tried: string[] = [];
  const reasons: string[] = [];
  for (const [index, provider] of readyCandidates.entries()) {
    tried.push(provider.id);
    try {
      const result = await provider.search(q, attemptSignal(searchSignal, deadlineAt, readyCandidates.length - index));
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

/** Split what is left of the shared deadline evenly over the providers still queued, so a stalled
 *  earlier provider (e.g. Firecrawl) cannot starve the later fallbacks (DDG last). The final provider
 *  gets all remaining time; explicit Grok searches carry no shared deadline and are not sliced. */
function attemptSignal(searchSignal: AbortSignal | undefined, deadlineAt: number | undefined, providersLeft: number): AbortSignal | undefined {
  if (!searchSignal || deadlineAt === undefined || providersLeft <= 1) return searchSignal;
  const share = Math.floor((deadlineAt - Date.now()) / providersLeft);
  return share > 0 ? AbortSignal.any([searchSignal, AbortSignal.timeout(share)]) : searchSignal;
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


/** Registered provider ids that only an async typed-store check can confirm (sync `available()` says no). */
export function webSearchProvidersPendingAsyncReadiness(): string[] {
  return providers.filter(p => p.availableAsync && !p.available()).map(p => p.id);
}

/** Research preflight resolves typed stores before deciding which services can run. */
export async function getAvailableResearchWebSearchProvidersAsync(signal?: AbortSignal, timeoutMs = 15_000): Promise<WebSearchProvider[]> {
  return (await probeResearchWebSearchProvidersAsync(signal, timeoutMs)).providers;
}

/** Structured config gates for routed providers that the registry only registers when enabled. */
function routedProviderEnabled(providerId: string): boolean | undefined {
  if (providerId === 'tavily') return isTavilySearchEnabled();
  if (providerId === 'firecrawl') return isPaidWebSearchEnabled('firecrawl');
  return undefined;
}

/** SEARCH-PROVIDER-TOPIC-BENCH-ROUTING ① — one readiness pass yields both the ready snapshot (unchanged contract of
 * getAvailableResearchWebSearchProvidersAsync) and a per-provider availability with a fixed reason for every routed id. */
export async function probeResearchWebSearchProvidersAsync(signal?: AbortSignal, timeoutMs = 15_000): Promise<{
  providers: WebSearchProvider[];
  availability: SearchProviderAvailability[];
}> {
  const snapshot = [...providers];
  if (includeEnvironmentResearchExa && !snapshot.some(provider => provider.id === 'exa')) snapshot.push(buildExaWebSearchProvider());
  const probed = await Promise.all(snapshot.map(provider => probeSearchProviderReadiness(provider, signal, timeoutMs)));
  signal?.throwIfAborted();
  const ready = probed.map(entry => entry.available);
  debug.log('web-search', 'service-preflight', { services: snapshot.map((provider, index) => ({
    id: provider.id, credentialReady: ready[index], quota: 'unmeasured',
  })) });
  const routedIds = [...new Set(Object.values(SEARCH_PROVIDER_ROUTES).flat())];
  const availability = await probeSearchProviderAvailability(routedIds, {
    registered: [], isEnabled: routedProviderEnabled,
  });
  return {
    providers: snapshot.filter((_provider, index) => ready[index]),
    availability: [
      ...probed,
      ...availability.filter(entry => !probed.some(known => known.provider === entry.provider)),
    ],
  };
}
