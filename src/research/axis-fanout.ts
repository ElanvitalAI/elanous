// Research-only native fanout. The caller supplies Bloom's question ladder;
// each axis gets its own direct tool call and evidence stays attributed to it.
import type { BloomResearchQuestion, ResearchEvidenceEnvelope } from '../auto-research/question-ladder-contract.js';
import { getAvailableResearchWebSearchProviders } from '../web-search/index.js';
import type { WebSearchHit, WebSearchProvider } from '../web-search/provider.js';
import { debug } from '../debug/log.js';
import { dispatchWebFetch } from '../skills/tools/webfetch.js';

const RESEARCH_PAID_WEB_FALLBACK_IDS = ['exa', 'firecrawl'] as const;
const RESEARCH_KEYLESS_WEB_FALLBACK_IDS = ['ddg-free'] as const;
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
}

interface ProviderHealth {
  failures: number;
  open: boolean;
}

/** Build one bounded searcher per research prepass. Paid Exa/Firecrawl routes
 * take precedence; DDG is used only when neither paid route is available. Grok
 * is reserved for explicit X intent.
 * Per-engine serialization lets a timeout open that engine's
 * breaker before queued Bloom axes start. */
export function createResearchAxisSearcher(
  availableProviders: readonly WebSearchProvider[] = getAvailableResearchWebSearchProviders(),
  now: () => number = Date.now,
): AxisSearch {
  const paidProviders = RESEARCH_PAID_WEB_FALLBACK_IDS.flatMap(id => availableProviders.filter(provider => provider.id === id));
  const webFallback = paidProviders.length > 0
    ? paidProviders
    : RESEARCH_KEYLESS_WEB_FALLBACK_IDS.flatMap(id => availableProviders.filter(provider => provider.id === id));
  const allowed = [...webFallback];
  const keylessFallback = paidProviders.length === 0 && allowed.some(provider =>
    (RESEARCH_KEYLESS_WEB_FALLBACK_IDS as readonly string[]).includes(provider.id));
  const health = new Map(allowed.map(provider => [provider.id, { failures: 0, open: false }]));
  const deadline = now() + RESEARCH_SEARCH_BUDGET_MS;
  let searchBudgetExhausted = false;
  const tails = new Map<string, Promise<void>>();

  debug.log('research.search', 'provider-preflight', {
    allowed: allowed.map(provider => provider.id),
    available: allowed.map(provider => provider.id),
    keylessFallback: keylessFallback ? 'ddg-free' : null,
    excluded: availableProviders.filter(provider => !allowed.some(allowedProvider => allowedProvider.id === provider.id))
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
    const execute = async (provider: WebSearchProvider): Promise<boolean> => enqueue(provider.id, async () => {
      const state = health.get(provider.id)!;
      if (state.open) return false;
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
        state.failures += 1;
        if (timeout || quota || state.failures >= ENGINE_BREAKER_FAILURE_LIMIT) state.open = true;
        errors.push(`${provider.id}: ${message}`);
        debug.log('research.search', 'provider-failed', {
          provider: provider.id, queryLength: query.length, durationMs: now() - startedAt,
          timeout, quota, failures: state.failures, breakerOpen: state.open,
        }, { level: 'warn' });
        return false;
      }
    });
    const runWebFallback = async (): Promise<void> => {
      for (const provider of webFallback) {
        if (!health.get(provider.id)?.open && await execute(provider)) return;
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
  const search = deps.search ?? createResearchAxisSearcher();
  const fetchPage = deps.fetchPage ?? (!deps.search
    ? async (url: string, question: BloomResearchQuestion, signal?: AbortSignal) =>
      dispatchWebFetch({ url, prompt: question.prompt }, { signal })
    : undefined);
  const fetchedQuestions = new Set<string>();
  const settled = await Promise.allSettled(plan.map(async call => {
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
  }));
  const axes: AxisEvidenceGroup[] = questions.map(question => ({ questionId: question.id, evidence: [] }));
  const groups = new Map(axes.map(axis => [axis.questionId, axis]));
  const byQuestion = new Map(questions.map(question => [question.id, question]));
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
      const response = outcome.value;
      if (response.budgetExhausted) group.budgetExhausted = true;
      if (response.hits.length === 0 && response.errors.length === 0) {
        group.evidence.push({ ...failedEvidence(question, call.query, 'no hits returned', observedAt), outcome: 'partial' });
      }
      const fetchedPage = 'fetchedPage' in response ? response.fetchedPage : undefined;
      if (fetchedPage) {
        const content = fetchedPage.output;
        const excerpt = Array.from(content).slice(0, 8_000).join('');
        const fetchedPageObservedAt = 'fetchedPageObservedAt' in outcome.value
          ? outcome.value.fetchedPageObservedAt : undefined;
        const fetchedPagePublishedAt = 'fetchedPagePublishedAt' in outcome.value
          ? outcome.value.fetchedPagePublishedAt : undefined;
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
    } else {
      const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      group.error = group.error ? `${group.error}; ${message}` : message;
      group.evidence.push(failedEvidence(question, call.query, message, observedAt));
    }
  });
  return { plan, axes };
}
