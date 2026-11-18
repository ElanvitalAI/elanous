// SEARCH-PROVIDER-TOPIC-BENCH-ROUTING ① — availability probe ⊕ topic routing seam.
//
// The search provider order is not hardcoded at the call site. A route table maps a topic bucket to an ordered
// provider list; selection = the first provider in that list the runtime can actually use right now. Availability is
// decided from structured config/credential PRESENCE only (adapter registered, config gate, typed-store readiness) —
// never from a credential value. The probe never reads, returns or logs a key.
//
// Topic comes from structured signals only. The research plan route has no topic/intent field yet, so every research
// turn routes through the `default` bucket; a topic classifier is a later cell (no new keyword/regex classifier here).
// Bench (provider × topic) numbers are RES's cell ③ — this table is the seam that bench will rewrite.
import {
  runSearchWithDeadline, SEARCH_DEADLINE_CODE, SEARCH_REQUEST_TIMEOUT_MS,
} from '../graph-runner/capability-providers/search-web-deadline.js';
import { debug } from '../debug/log.js';
import type { WebSearchProvider } from './provider.js';

export type SearchTopic = 'default' | 'web-news' | 'dev-docs' | 'semantic';
export type SearchRouteProviderId = 'firecrawl' | 'firecrawl-dev' | 'tavily' | 'exa' | 'brave' | 'ddg-free';
/** `shadow` (default) computes and records the routed choice but keeps the legacy provider order; `on` uses the route. */
export type SearchRoutingMode = 'shadow' | 'on';

// 출처: SEARCH-PROVIDER-TOPIC-BENCH-ROUTING (0.3.28 · 대표 11-16) — omni-crawl role routing: Firecrawl default ·
// Tavily web/news · Firecrawl Dev Index developer docs · Exa semantic · Brave backup · ddg last-resort fallback.
// Order is policy until RES's provider × topic bench (cell ③) replaces it with measured numbers.
export const SEARCH_PROVIDER_ROUTES: Readonly<Record<SearchTopic, readonly SearchRouteProviderId[]>> = Object.freeze({
  default: Object.freeze(['firecrawl', 'tavily', 'exa', 'brave', 'ddg-free'] as const),
  'web-news': Object.freeze(['tavily', 'firecrawl', 'brave', 'ddg-free'] as const),
  'dev-docs': Object.freeze(['firecrawl-dev', 'firecrawl', 'exa', 'brave', 'ddg-free'] as const),
  semantic: Object.freeze(['exa', 'firecrawl', 'tavily', 'brave', 'ddg-free'] as const),
});

/** Fixed codes only — never provider error text, never a credential. */
export type SearchProviderUnavailableReason =
  | 'no-adapter' // no web-search adapter for this provider is registered in this runtime
  | 'disabled' // the structured config gate turns it off
  | 'credential-missing' // adapter present, credential presence check says no
  | 'credential-check-failed' // the credential store read threw
  | 'credential-check-timeout' // the credential store read did not settle within the caller budget
  | 'credential-check-cancelled' // the caller cancelled the turn while the read was pending
  | 'not-ready'; // caller-supplied snapshot did not include it as ready

export interface SearchProviderAvailability {
  provider: string;
  available: boolean;
  reason?: SearchProviderUnavailableReason;
}

export interface SearchProviderSelection {
  topic: SearchTopic;
  /** First available provider on the topic's route; null = every routed provider is unavailable. */
  chosen: string | null;
  /** Available providers after `chosen`, in route order (the fallback cascade in `on` mode). */
  fallbacks: string[];
  skipped: Array<{ provider: string; reason: SearchProviderUnavailableReason }>;
}

/** Loud failure code when a topic's whole route is unavailable — never a silent empty result. */
export const SEARCH_ROUTE_EXHAUSTED = 'SEARCH_ROUTE_EXHAUSTED';
export const SEARCH_ROUTING_CATEGORY = 'search';
export const SEARCH_PROVIDER_SELECTED_EVENT = 'provider-selected';

export function searchRouteFor(topic: SearchTopic): readonly SearchRouteProviderId[] {
  return SEARCH_PROVIDER_ROUTES[topic] ?? SEARCH_PROVIDER_ROUTES.default;
}

export interface SearchProviderProbeDeps {
  /** Adapters registered in this runtime (the web-search registry snapshot). */
  registered: readonly WebSearchProvider[];
  /** Structured config gate; false = `disabled`. Absent = no gate known for that id. */
  isEnabled?: (providerId: string) => boolean | undefined;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Presence-only readiness of one adapter. Throws are classified, not swallowed into a bare false. */
export async function probeSearchProviderReadiness(
  provider: WebSearchProvider,
  signal?: AbortSignal,
  timeoutMs = SEARCH_REQUEST_TIMEOUT_MS,
): Promise<SearchProviderAvailability> {
  try {
    const ready = await runSearchWithDeadline(async scope => {
      scope.throwIfAborted();
      return provider.availableAsync ? provider.availableAsync(scope) : provider.available();
    }, signal, timeoutMs);
    return ready ? { provider: provider.id, available: true } : { provider: provider.id, available: false, reason: 'credential-missing' };
  } catch (error) {
    // runSearchWithDeadline rejects deadline AND cancel with one structured code (SearchDeadlineError · search-web-deadline.ts);
    // the caller's own signal separates a cancelled turn from a store that did not answer in time. Never message text.
    const deadline = typeof error === 'object' && error !== null && (error as { code?: unknown }).code === SEARCH_DEADLINE_CODE;
    const reason = signal?.aborted ? 'credential-check-cancelled'
      : deadline ? 'credential-check-timeout' : 'credential-check-failed';
    return { provider: provider.id, available: false, reason };
  }
}

/** Which of `providerIds` are usable right now. No network call: adapters' readiness checks read config/typed stores only. */
export async function probeSearchProviderAvailability(
  providerIds: readonly string[],
  deps: SearchProviderProbeDeps,
): Promise<SearchProviderAvailability[]> {
  return Promise.all(providerIds.map(async (id): Promise<SearchProviderAvailability> => {
    const adapter = deps.registered.find(provider => provider.id === id);
    if (!adapter) {
      return { provider: id, available: false, reason: deps.isEnabled?.(id) === false ? 'disabled' : 'no-adapter' };
    }
    return probeSearchProviderReadiness(adapter, deps.signal, deps.timeoutMs);
  }));
}

/** First available provider on the topic route; every unavailable routed provider is reported with its reason. */
export function selectSearchProvider(topic: SearchTopic, availability: readonly SearchProviderAvailability[]): SearchProviderSelection {
  const ordered: string[] = [];
  const skipped: SearchProviderSelection['skipped'] = [];
  for (const id of searchRouteFor(topic)) {
    const entry = availability.find(candidate => candidate.provider === id);
    if (entry?.available) ordered.push(id);
    else skipped.push({ provider: id, reason: entry?.reason ?? 'not-ready' });
  }
  return { topic, chosen: ordered[0] ?? null, fallbacks: ordered.slice(1), skipped };
}

/** Message carried as a failed-evidence error when `on` mode has no routed provider. Fixed codes only. */
export function searchRouteExhaustedMessage(selection: SearchProviderSelection): string {
  return `${SEARCH_ROUTE_EXHAUSTED}: no available search provider for topic ${selection.topic} (${
    selection.skipped.map(entry => `${entry.provider}=${entry.reason}`).join(', ')})`;
}

/** `search.provider-selected` — allowlisted fields only; no query text, no credential, no provider error text. */
export function emitSearchProviderSelected(
  selection: SearchProviderSelection,
  context: { mode: SearchRoutingMode; legacy: string | null },
): void {
  debug.log(SEARCH_ROUTING_CATEGORY, SEARCH_PROVIDER_SELECTED_EVENT, {
    topic: selection.topic,
    mode: context.mode,
    chosen: selection.chosen,
    legacy: context.legacy,
    divergent: selection.chosen !== context.legacy,
    fallbacks: [...selection.fallbacks],
    skipped: selection.skipped.map(entry => ({ provider: entry.provider, reason: entry.reason })),
  }, selection.chosen ? undefined : { level: 'warn' });
}
