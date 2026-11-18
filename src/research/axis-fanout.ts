// Research-only native fanout. The caller supplies Bloom's question ladder;
// each axis gets its own direct tool call and evidence stays attributed to it.
import type { BloomResearchQuestion, ResearchEvidenceEnvelope } from '../auto-research/question-ladder-contract.js';
import { probeResearchWebSearchProvidersAsync } from '../web-search/index.js';
import {
  emitSearchProviderSelected, searchRouteExhaustedMessage, searchRouteFor, selectSearchProvider,
  type SearchProviderAvailability, type SearchRoutingMode, type SearchTopic,
} from '../web-search/routing.js';
import { searchProviderRoutingMode } from '../user-config.js';
import type { WebSearchHit, WebSearchProvider } from '../web-search/provider.js';
import { debug } from '../debug/log.js';
import { dispatchWebFetch } from '../skills/tools/webfetch.js';
import { CRAWL_PROVIDERS } from '../research-bridge/crawl.js';

const RESEARCH_EXA_TIMEOUT_MS = 4_500;
// Leave scheduler/logging headroom under the user-visible 15s aggregate cap.
export const RESEARCH_SEARCH_BUDGET_MS = 14_500;
const ENGINE_BREAKER_FAILURE_LIMIT = 2;

export interface AxisToolCallPlan {
  questionId: string;
  tool: 'OmniSearch';
  query: string;
}

export interface AxisEvidenceGroup {
  questionId: string;
  evidence: ResearchEvidenceEnvelope[];
  error?: string;
  /** Set only by native search/tool budget guards, never inferred from provider text. */
  budgetExhausted?: boolean;
}

export interface AxisFanoutResult {
  plan: AxisToolCallPlan[];
  axes: AxisEvidenceGroup[];
}

export type AxisSearchHit = WebSearchHit & { engine?: string };
export interface AxisSearchResult {
  hits: AxisSearchHit[];
  errors: string[];
  /** Native aggregate search deadline signal; provider messages cannot set this field. */
  budgetExhausted?: boolean;
}
interface TimedAxisSearchResult extends AxisSearchResult {
  observedAt: string;
  fetchedPage?: { url: string; output: string };
  fetchedPageObservedAt?: string;
  fetchedPagePublishedAt?: string;
}
export interface AxisSearchContext {
  questionPrompt?: string;
  requestedWindow?: string;
}
export type AxisSearch = (query: string, signal?: AbortSignal, context?: AxisSearchContext) => Promise<AxisSearchHit[] | AxisSearchResult>;

export interface AxisFanoutDeps {
  search?: AxisSearch;
  fetchPage?: (url: string, question: BloomResearchQuestion, signal?: AbortSignal) => Promise<{ url: string; output: string }>;
  signal?: AbortSignal;
  admitToolCall?: (toolName: 'OmniSearch' | 'WebFetch') => boolean;
  /** Observation clock seam for deterministic source-reference dates. */
  now?: () => number;
  /** Early-answer seam: one search call settled, with the evidence it adds (same envelopes as the final result). Fail-soft. */
  onAxisEvidence?: (questionId: string, evidence: ResearchEvidenceEnvelope[]) => void;
  /** SEARCH-PROVIDER-TOPIC-BENCH-ROUTING — test/caller override of `webSearch.routing.mode` for the default searcher. */
  searchRoutingMode?: SearchRoutingMode;
}

/** Routing seam for one research searcher. Absent fields resolve from config (`mode`) and the default bucket (`topic`). */
export interface ResearchSearchRouting {
  mode?: SearchRoutingMode;
  /** Structured topic bucket. The research plan carries no topic field yet → `default`. */
  topic?: SearchTopic;
  /** Probe result (fixed reasons). Absent = derived from the supplied ready snapshot. */
  availability?: readonly SearchProviderAvailability[];
}

interface ProviderHealth {
  failures: number;
  open: boolean;
}

/** Build one bounded searcher per research prepass. Grok stays on explicit X routes.
 * Provider order: `shadow` (default) keeps the legacy order (Firecrawl → BYOK → keyless ddg) and only records the
 * routed choice; `on` uses SEARCH_PROVIDER_ROUTES for the first call AND the fallback cascade.
 * Per-engine serialization lets a timeout open that engine's
 * breaker before queued Bloom axes start. */
export function createResearchAxisSearcher(
  availableProviders?: readonly WebSearchProvider[],
  now: () => number = Date.now,
  inheritedDeadline?: number,
  routing: ResearchSearchRouting = {},
): AxisSearch {
  const deadline = inheritedDeadline ?? now() + RESEARCH_SEARCH_BUDGET_MS;
  if (!availableProviders) {
    let initialized: Promise<AxisSearch> | undefined;
    return async (query, signal) => {
      // #38331 follow-up (GROUNDING-FIRST-ANSWER-30S): check the caller's abort BEFORE starting the shared probe. Checked
      // after it, a call that arrived already aborted (a head start reaching the searcher after its turn settled) threw
      // here and left the probe — which rejects with that same abort reason — awaited by no one: an unhandled rejection.
      signal?.throwIfAborted();
      if (!initialized) {
        initialized = probeResearchWebSearchProvidersAsync(signal,
          Math.max(1, Math.min(15_000, deadline - now())))
          .then(probe => createResearchAxisSearcher(probe.providers, now, deadline, { ...routing, availability: probe.availability }));
        // Handler at creation: every caller still awaits `initialized` and receives its rejection; this only stops the
        // runtime from reporting it when the last waiter has gone.
        initialized.catch(() => undefined);
      }
      return (await initialized)(query, signal);
    };
  }
  const metadata = new Map(CRAWL_PROVIDERS.map(provider => [provider.id, provider]));
  const descriptor = (id: string) => metadata.get(id === 'ddg-free' ? 'ddg' : id);
  const priority = (id: string) => id === 'firecrawl' ? 0 : id === 'ddg-free' ? 2 : 1;
  const allowed = availableProviders.filter(provider => provider.id !== 'grok' && provider.id !== 'grok-api'
    && descriptor(provider.id)?.provides.includes('search.web@1'))
    .sort((a, b) => priority(a.id) - priority(b.id));
  const mode = routing.mode ?? searchProviderRoutingMode();
  const topic = routing.topic ?? 'default';
  // A routed provider is usable only when the ready snapshot holds it (same credential gate for first call and fallback).
  const ready = (id: string) => allowed.find(provider => provider.id === id);
  const availability: SearchProviderAvailability[] = searchRouteFor(topic).map(id => {
    const probed = routing.availability?.find(entry => entry.provider === id);
    if (ready(id)) return { provider: id, available: true };
    return { provider: id, available: false, reason: probed && !probed.available ? probed.reason ?? 'not-ready' : 'not-ready' };
  });
  const selection = selectSearchProvider(topic, availability);
  emitSearchProviderSelected(selection, { mode, legacy: allowed[0]?.id ?? null });
  const routed = [selection.chosen, ...selection.fallbacks].flatMap(id => {
    const provider = id ? ready(id) : undefined;
    return provider ? [provider] : [];
  });
  const webFallback = mode === 'on' ? routed : allowed;
  const keylessFallback = webFallback.find(provider => descriptor(provider.id)?.tier === 'free')?.id ?? null;
  const health = new Map(webFallback.map(provider => [provider.id, { failures: 0, open: false }]));
  let searchBudgetExhausted = false;
  const tails = new Map<string, Promise<void>>();

  debug.log('research.search', 'provider-preflight', {
    allowed: webFallback.map(provider => provider.id),
    available: allowed.map(provider => provider.id),
    routingMode: mode,
    keylessFallback,
    excluded: availableProviders.filter(provider => !webFallback.some(allowedProvider => allowedProvider.id === provider.id))
      .map(provider => provider.id),
    budgetMs: RESEARCH_SEARCH_BUDGET_MS,
  });

  const enqueue = <T>(providerId: string, run: () => Promise<T>): Promise<T> => {
    const previous = tails.get(providerId) ?? Promise.resolve();
    const current = previous.then(run, run);
    tails.set(providerId, current.then(() => undefined, () => undefined));
    return current;
  };

  return async (query, signal) => {
    const hits: AxisSearchHit[] = [];
    const errors: string[] = [];
    let budgetExhausted = searchBudgetExhausted;
    if (mode === 'on' && webFallback.length === 0) {
      // Loud, coded failure: the whole topic route is unavailable (reasons were emitted with provider-selected).
      return { hits, errors: [searchRouteExhaustedMessage(selection)] };
    }
    const execute = async (provider: WebSearchProvider): Promise<boolean> => enqueue(provider.id, async () => {
      const state = health.get(provider.id)!;
      // A queued call can find the breaker opened by an earlier call on the same engine: same skip, same event.
      if (state.open) {
        debug.log('research.search', 'provider-skipped', { provider: provider.id, reason: 'breaker-open' });
        return false;
      }
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        state.open = true;
        searchBudgetExhausted = true;
        budgetExhausted = true;
        errors.push(`${provider.id}: research search budget exhausted`);
        return false;
      }
      const timeoutMs = provider.id === 'exa'
        ? Math.min(RESEARCH_EXA_TIMEOUT_MS, remainingMs)
        : remainingMs;
      const startedAt = now();
      try {
        const controller = new AbortController();
        const abortFromCaller = (): void => controller.abort(signal?.reason);
        if (signal?.aborted) abortFromCaller();
        else signal?.addEventListener('abort', abortFromCaller, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let result;
        try {
          result = await Promise.race([
            provider.search({ query, limit: 5 }, controller.signal),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new DOMException(`${provider.id} research search timed out after ${timeoutMs}ms`, 'TimeoutError'));
              }, timeoutMs);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener('abort', abortFromCaller);
        }
        if (result.hits.length === 0) {
          state.failures += 1;
          if (state.failures >= ENGINE_BREAKER_FAILURE_LIMIT) state.open = true;
        } else {
          state.failures = 0;
          hits.push(...result.hits.map(hit => ({ ...hit, engine: provider.id })));
        }
        debug.log('research.search', 'provider-complete', {
          provider: provider.id, queryLength: query.length, hits: result.hits.length,
          durationMs: now() - startedAt, breakerOpen: state.open,
        });
        return result.hits.length > 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const timeout = error instanceof Error && /timeout|timed out|abort/i.test(`${error.name} ${error.message}`);
        const quota = /quota|credit|rate.?limit|\b429\b|exhaust/i.test(message);
        const blocked = error instanceof Error && 'reason' in error && error.reason === 'blocked';
        state.failures += 1;
        if (timeout || quota || blocked || state.failures >= ENGINE_BREAKER_FAILURE_LIMIT) state.open = true;
        errors.push(`${provider.id}: ${message}`);
        debug.log('research.search', 'provider-failed', {
          provider: provider.id, queryLength: query.length, durationMs: now() - startedAt,
          timeout, quota, blocked, failures: state.failures, breakerOpen: state.open,
        }, { level: 'warn' });
        return false;
      }
    });
    const runWebFallback = async (): Promise<void> => {
      for (const provider of webFallback) {
        if (health.get(provider.id)?.open) {
          debug.log('research.search', 'provider-skipped', { provider: provider.id, reason: 'breaker-open' });
          continue;
        }
        if (await execute(provider)) return;
      }
    };
    await runWebFallback();
    if (hits.length === 0 && errors.length === 0) errors.push('no healthy research search provider');
    return { hits, errors, ...(budgetExhausted || searchBudgetExhausted ? { budgetExhausted: true } : {}) };
  };
}

/** Keep every query attached to the Bloom question that produced it. */
export function planAxisToolCalls(questions: readonly BloomResearchQuestion[]): AxisToolCallPlan[] {
  return questions.flatMap(question => question.searchTerms
    .map(query => query.trim())
    .filter(Boolean)
    .map(query => ({ questionId: question.id, tool: 'OmniSearch' as const, query })));
}

function evidenceFromHit(question: BloomResearchQuestion, hit: AxisSearchHit, observedAt: string): ResearchEvidenceEnvelope {
  const publishedAt = publishedDateFromHit(hit);
  return {
    questionId: question.id,
    sourceKind: hit.engine ? `web-search:${hit.engine}` : 'web-search',
    source: hit.url,
    observedAt,
    ...(question.requestedWindow ? { requestedWindow: question.requestedWindow } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    content: [hit.title, hit.snippet].filter(Boolean).join(' — '),
    outcome: hit.snippet ? 'complete' : 'partial',
    truncated: true, // Search snippets are excerpts, not the complete source page.
  };
}

function publishedDateFromHit(hit: AxisSearchHit): string | undefined {
  const published = hit.publishedAt;
  const date = published !== undefined && Number.isFinite(published) && published > 0
    ? new Date(published) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function failedEvidence(question: BloomResearchQuestion, query: string, message: string, observedAt: string): ResearchEvidenceEnvelope {
  return {
    questionId: question.id,
    sourceKind: 'search-query',
    source: query,
    observedAt,
    ...(question.requestedWindow ? { requestedWindow: question.requestedWindow } : {}),
    content: message,
    outcome: 'failed',
    truncated: false,
  };
}

/** Turn one settled search call into attributed evidence on its axis group (shared by the early hook and the final result). */
function appendSearchEvidence(
  group: AxisEvidenceGroup,
  question: BloomResearchQuestion,
  call: AxisToolCallPlan,
  response: TimedAxisSearchResult,
): void {
  const observedAt = response.observedAt;
  if (response.budgetExhausted) group.budgetExhausted = true;
  if (response.hits.length === 0 && response.errors.length === 0) {
    group.evidence.push({ ...failedEvidence(question, call.query, 'no hits returned', observedAt), outcome: 'partial' });
  }
  const fetchedPage = 'fetchedPage' in response ? response.fetchedPage : undefined;
  if (fetchedPage) {
    const content = fetchedPage.output;
    const excerpt = Array.from(content).slice(0, 8_000).join('');
    const fetchedPageObservedAt = 'fetchedPageObservedAt' in response
      ? response.fetchedPageObservedAt : undefined;
    const fetchedPagePublishedAt = 'fetchedPagePublishedAt' in response
      ? response.fetchedPagePublishedAt : undefined;
    group.evidence.push({
      questionId: question.id,
      sourceKind: 'web-fetch',
      source: fetchedPage.url,
      observedAt: fetchedPageObservedAt ?? observedAt,
      ...(question.requestedWindow ? { requestedWindow: question.requestedWindow } : {}),
      ...(fetchedPagePublishedAt ? { publishedAt: fetchedPagePublishedAt } : {}),
      content: excerpt,
      outcome: excerpt ? 'complete' : 'partial',
      truncated: Array.from(content).length > 8_000,
    });
  }
  for (const hit of response.hits) {
    try {
      group.evidence.push(evidenceFromHit(question, hit, observedAt));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      group.error = group.error ? `${group.error}; ${message}` : message;
      group.evidence.push(failedEvidence(question, call.query, message, observedAt));
    }
  }
  for (const message of response.errors) {
    group.error = group.error ? `${group.error}; ${message}` : message;
    group.evidence.push(failedEvidence(question, call.query, message, observedAt));
  }
}

/** Invoke all axis queries concurrently, preserving ladder order and partial failures. */
export async function fanOutAxisEvidence(
  questions: readonly BloomResearchQuestion[],
  deps: AxisFanoutDeps = {},
): Promise<AxisFanoutResult> {
  const now = deps.now ?? Date.now;
  const referenceTime = (): string => new Date(now()).toISOString();
  const plan = planAxisToolCalls(questions);
  if (new Set(questions.map(question => question.id)).size !== questions.length) {
    throw new Error('research axis question IDs must be unique');
  }
  const search = deps.search ?? createResearchAxisSearcher(undefined, Date.now, undefined,
    deps.searchRoutingMode ? { mode: deps.searchRoutingMode } : {});
  const fetchPage = deps.fetchPage ?? (!deps.search
    ? async (url: string, question: BloomResearchQuestion, signal?: AbortSignal) =>
      dispatchWebFetch({ url, prompt: question.prompt }, { signal })
    : undefined);
  const fetchedQuestions = new Set<string>();
  const searchAxis = async (call: AxisToolCallPlan): Promise<TimedAxisSearchResult> => {
    if (deps.admitToolCall && !deps.admitToolCall('OmniSearch')) {
      return {
        hits: [], errors: ['research tool budget reached'], budgetExhausted: true, observedAt: referenceTime(),
      } satisfies TimedAxisSearchResult;
    }
    const question = questions.find(candidate => candidate.id === call.questionId)!;
    let raw: AxisSearchHit[] | AxisSearchResult;
    try {
      raw = await search(call.query, deps.signal, {
        questionPrompt: question.prompt,
        requestedWindow: question.requestedWindow,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { hits: [], errors: [message], observedAt: referenceTime() } satisfies TimedAxisSearchResult;
    }
    const observedAt = referenceTime();
    const response = Array.isArray(raw) ? { hits: raw, errors: [] } : raw;
    if (!fetchPage || response.hits.length === 0 || fetchedQuestions.has(question.id)) {
      return { ...response, observedAt } satisfies TimedAxisSearchResult;
    }
    fetchedQuestions.add(question.id);
    if (deps.admitToolCall && !deps.admitToolCall('WebFetch')) {
      return { ...response, budgetExhausted: true, observedAt } satisfies TimedAxisSearchResult;
    }
    try {
      const page = await fetchPage(response.hits[0]!.url, question, deps.signal);
      const fetchedPagePublishedAt = page.url === response.hits[0]!.url
        ? publishedDateFromHit(response.hits[0]!) : undefined;
      return {
        ...response, observedAt, fetchedPage: page, fetchedPageObservedAt: referenceTime(),
        ...(fetchedPagePublishedAt ? { fetchedPagePublishedAt } : {}),
      } satisfies TimedAxisSearchResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug.log('research.search', 'native-fetch-failed', {
        questionId: question.id, reason: message.slice(0, 200),
      }, { level: 'warn' });
      return { ...response, observedAt } satisfies TimedAxisSearchResult;
    }
  };
  const byQuestion = new Map(questions.map(question => [question.id, question]));
  const notifyAxisEvidence = (call: AxisToolCallPlan, response: TimedAxisSearchResult): void => {
    if (!deps.onAxisEvidence) return;
    const scratch: AxisEvidenceGroup = { questionId: call.questionId, evidence: [] };
    appendSearchEvidence(scratch, byQuestion.get(call.questionId)!, call, response);
    try { deps.onAxisEvidence(call.questionId, scratch.evidence); } catch { /* early-answer observer is fail-soft */ }
  };
  const settled = await Promise.allSettled(plan.map(call => searchAxis(call).then(response => {
    notifyAxisEvidence(call, response);
    return response;
  })));
  const axes: AxisEvidenceGroup[] = questions.map(question => ({ questionId: question.id, evidence: [] }));
  const groups = new Map(axes.map(axis => [axis.questionId, axis]));
  for (const question of questions) {
    if (!plan.some(call => call.questionId === question.id)) {
      const group = groups.get(question.id)!;
      group.error = 'no search terms';
      group.evidence.push(failedEvidence(question, question.prompt, group.error, referenceTime()));
    }
  }
  settled.forEach((outcome, index) => {
    const call = plan[index]!;
    const group = groups.get(call.questionId)!;
    const question = byQuestion.get(call.questionId)!;
    const observedAt = outcome.status === 'fulfilled' ? outcome.value.observedAt : referenceTime();
    if (outcome.status === 'fulfilled') {
      appendSearchEvidence(group, question, call, outcome.value);
    } else {
      const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      group.error = group.error ? `${group.error}; ${message}` : message;
      group.evidence.push(failedEvidence(question, call.query, message, observedAt));
    }
  });
  return { plan, axes };
}
