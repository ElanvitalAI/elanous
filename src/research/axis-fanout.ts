// Research-only native fanout. The caller supplies Bloom's question ladder;
// each axis gets its own direct tool call and evidence stays attributed to it.
import type { BloomResearchQuestion, ResearchEvidenceEnvelope } from '../auto-research/question-ladder-contract.js';
import { getAvailableWebSearchProviders } from '../web-search/index.js';
import type { WebSearchHit, WebSearchProvider } from '../web-search/provider.js';
import { debug } from '../debug/log.js';

const RESEARCH_SEARCH_ENGINES = ['grok', 'grok-api', 'firecrawl'] as const;
const RESEARCH_GROK_TIMEOUT_MS = 8_000;
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
}

export interface AxisFanoutResult {
  plan: AxisToolCallPlan[];
  axes: AxisEvidenceGroup[];
}

export type AxisSearchHit = WebSearchHit & { engine?: string };
export interface AxisSearchResult {
  hits: AxisSearchHit[];
  errors: string[];
}
export type AxisSearch = (query: string, signal?: AbortSignal) => Promise<AxisSearchHit[] | AxisSearchResult>;

export interface AxisFanoutDeps {
  search?: AxisSearch;
  signal?: AbortSignal;
}

interface ProviderHealth {
  failures: number;
  open: boolean;
}

/** Build one bounded searcher per research prepass. Free/DDG is deliberately
 * excluded: it is not a safe fallback for stock research and can consume a
 * full 15s timeout for every query. Per-engine serialization lets the first
 * timeout open that engine's breaker before queued Bloom axes start. */
export function createResearchAxisSearcher(
  availableProviders: readonly WebSearchProvider[] = getAvailableWebSearchProviders(),
  now: () => number = Date.now,
): AxisSearch {
  const grok = availableProviders.find(provider => provider.id === 'grok')
    ?? availableProviders.find(provider => provider.id === 'grok-api');
  const allowed = [
    ...(grok ? [grok] : []),
    ...availableProviders.filter(provider => provider.id === 'firecrawl'),
  ];
  const health = new Map(allowed.map(provider => [provider.id, { failures: 0, open: false }]));
  const deadline = now() + RESEARCH_SEARCH_BUDGET_MS;
  const tails = new Map<string, Promise<void>>();

  debug.log('research.search', 'provider-preflight', {
    allowed: RESEARCH_SEARCH_ENGINES,
    available: allowed.map(provider => provider.id),
    excluded: availableProviders.filter(provider => !(RESEARCH_SEARCH_ENGINES as readonly string[]).includes(provider.id))
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
    const selected = allowed.filter(provider => !health.get(provider.id)?.open);
    if (selected.length === 0) return { hits, errors: ['no healthy Grok/Firecrawl research provider'] };

    await Promise.all(selected.map(provider => enqueue(provider.id, async () => {
      const state = health.get(provider.id)!;
      if (state.open) return;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        state.open = true;
        errors.push(`${provider.id}: research search budget exhausted`);
        return;
      }
      const activeCount = Math.max(1, allowed.filter(candidate => !health.get(candidate.id)?.open).length);
      const isGrok = provider.id === 'grok' || provider.id === 'grok-api';
      const timeoutMs = isGrok
        ? Math.min(RESEARCH_GROK_TIMEOUT_MS, remainingMs)
        : Math.max(1, Math.floor(remainingMs / activeCount));
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
      }
    })));
    return { hits, errors };
  };
}

/** Keep every query attached to the Bloom question that produced it. */
export function planAxisToolCalls(questions: readonly BloomResearchQuestion[]): AxisToolCallPlan[] {
  return questions.flatMap(question => question.searchTerms
    .map(query => query.trim())
    .filter(Boolean)
    .map(query => ({ questionId: question.id, tool: 'OmniSearch' as const, query })));
}

function evidenceFromHit(question: BloomResearchQuestion, hit: AxisSearchHit): ResearchEvidenceEnvelope {
  const published = hit.publishedAt;
  const date = published !== undefined && Number.isFinite(published) && published > 0
    ? new Date(published) : undefined;
  const observedAt = date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  return {
    questionId: question.id,
    sourceKind: hit.engine ? `web-search:${hit.engine}` : 'web-search',
    source: hit.url,
    ...(question.requestedWindow ? { requestedWindow: question.requestedWindow } : {}),
    ...(observedAt ? { observedAt } : {}),
    content: [hit.title, hit.snippet].filter(Boolean).join(' — '),
    outcome: hit.snippet ? 'complete' : 'partial',
    truncated: true, // Search snippets are excerpts, not the complete source page.
  };
}

function failedEvidence(question: BloomResearchQuestion, query: string, message: string): ResearchEvidenceEnvelope {
  return {
    questionId: question.id,
    sourceKind: 'search-query',
    source: query,
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
  const plan = planAxisToolCalls(questions);
  if (new Set(questions.map(question => question.id)).size !== questions.length) {
    throw new Error('research axis question IDs must be unique');
  }
  const search = deps.search ?? createResearchAxisSearcher();
  const settled = await Promise.allSettled(plan.map(call => search(call.query, deps.signal)));
  const axes: AxisEvidenceGroup[] = questions.map(question => ({ questionId: question.id, evidence: [] }));
  const groups = new Map(axes.map(axis => [axis.questionId, axis]));
  const byQuestion = new Map(questions.map(question => [question.id, question]));
  for (const question of questions) {
    if (!plan.some(call => call.questionId === question.id)) {
      const group = groups.get(question.id)!;
      group.error = 'no search terms';
      group.evidence.push(failedEvidence(question, question.prompt, group.error));
    }
  }
  settled.forEach((outcome, index) => {
    const call = plan[index]!;
    const group = groups.get(call.questionId)!;
    const question = byQuestion.get(call.questionId)!;
    if (outcome.status === 'fulfilled') {
      const response = Array.isArray(outcome.value) ? { hits: outcome.value, errors: [] } : outcome.value;
      if (response.hits.length === 0 && response.errors.length === 0) {
        group.evidence.push({ ...failedEvidence(question, call.query, 'no hits returned'), outcome: 'partial' });
      }
      for (const hit of response.hits) {
        try {
          group.evidence.push(evidenceFromHit(question, hit));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          group.error = group.error ? `${group.error}; ${message}` : message;
          group.evidence.push(failedEvidence(question, call.query, message));
        }
      }
      for (const message of response.errors) {
        group.error = group.error ? `${group.error}; ${message}` : message;
        group.evidence.push(failedEvidence(question, call.query, message));
      }
    } else {
      const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      group.error = group.error ? `${group.error}; ${message}` : message;
      group.evidence.push(failedEvidence(question, call.query, message));
    }
  });
  return { plan, axes };
}
