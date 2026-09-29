// ── Web-search registry ──
//
// Holds the list of registered providers + a `searchWeb()` entry
// point that picks the first available provider (by registration
// order) and routes the query. Callers that want a specific
// provider pass `providerId` to force the choice.

import { buildGrokWebSearchProvider } from './grok.js';
import { buildFirecrawlWebSearchProvider } from './firecrawl.js';
import { buildTavilyWebSearchProvider } from './tavily.js';
import { isTavilySearchEnabled } from '../user-config.js';
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

function registerBuiltins(): void {
  // 순서 = 선호도. ⛔⭐ **tavily 는 config 게이트 뒤에 있다**(대표 2026-08-06 · 기본 OFF) —
  //   상시 유료 검색이 고정비였다. 종전 근거(basic 1cr·~1s 로 grok 대비 30배 저렴·20배 빠름)는
  //   여전히 참이지만 ***「싸다」와 「늘 켜 둔다」는 다른 축***이고, 지시는 후자를 껐다.
  //   ⇒ 켜면 종전과 «똑같이» 1순위로 복귀한다: `elanous config set webSearch.tavily.enabled true`.
  //   ⚠️ 등록 시점이라 config 변경은 **다음 기동부터** 먹는다(이미 뜬 프로세스엔 안 먹는다).
  if (isTavilySearchEnabled()) providers.push(buildTavilyWebSearchProvider());
  providers.push(buildGrokWebSearchProvider());
  providers.push(buildFirecrawlWebSearchProvider());
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
  const candidates = opts.providerId
    ? providers.filter(p => p.id === opts.providerId)
    : providers.filter(p => p.available());
  if (candidates.length === 0) {
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
      return await provider.search(q, opts.signal);
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
  if (includeBuiltins) registerBuiltins();
}

/** Snapshot of currently-available providers, in preference order.
 *  Exposed for parallel fan-out callers (omni_search P10) that don't
 *  want the cascade semantics of `searchWeb()`. */
export function getAvailableWebSearchProviders(): WebSearchProvider[] {
  return providers.filter(p => p.available());
}
