// Research-only native fanout. The caller supplies Bloom's question ladder;
// each axis gets its own direct tool call and evidence stays attributed to it.
import type { BloomResearchQuestion, ResearchEvidenceEnvelope } from '../auto-research/question-ladder-contract.js';
import type { WebSearchHit } from '../web-search/provider.js';

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
export type AxisSearch = (query: string) => Promise<AxisSearchHit[] | AxisSearchResult>;

export interface AxisFanoutDeps {
  search?: AxisSearch;
}

/** Keep every query attached to the Bloom question that produced it. */
export function planAxisToolCalls(questions: readonly BloomResearchQuestion[]): AxisToolCallPlan[] {
  return questions.flatMap(question => question.searchTerms
    .map(query => query.trim())
    .filter(Boolean)
    .map(query => ({ questionId: question.id, tool: 'OmniSearch' as const, query })));
}

async function directOmniSearch(query: string): Promise<AxisSearchResult> {
  const { dispatchOmniSearch } = await import('../skills/tools/omni-search.js');
  const hits: AxisSearchHit[] = [];
  const result = await dispatchOmniSearch({ query }, { onSource: hit => { hits.push(hit); } });
  if (Object.keys(result.metadata.perEngine).length === 0) {
    throw new Error('no available web-search providers');
  }
  const errors = Object.entries(result.metadata.perEngine)
    .flatMap(([engine, info]) => info.error ? [`${engine}: ${info.error}`] : []);
  return { hits, errors };
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
  const search = deps.search ?? directOmniSearch;
  const settled = await Promise.allSettled(plan.map(call => search(call.query)));
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
