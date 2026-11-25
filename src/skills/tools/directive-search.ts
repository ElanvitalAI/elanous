// DirectiveSearch — read-only seat tool over the local utterance index (`elanous directives ask`).
// Lets a seat answer «대표가 전에 뭐라고 했지» by speech: a natural-language question, optional KST period
// overrides, and the matched utterances with time, channel and a short context. Syncs the index first.
import type { LLMToolSpec } from '../../llm/tool-spec.js';
import { askDirectives, renderAsk, type AskResult } from '../../directives/ask.js';
import { DirectiveIndex, type IndexOptions } from '../../directives/directive-index.js';
import type { EmbedFn } from '../../directives/directive-semantic.js';

export interface DirectiveSearchDeps {
  index?: IndexOptions;
  /** Meaning embedder; undefined = the docs-search default, null = words only. */
  embed?: EmbedFn | null;
  now?: number;
}
export interface DirectiveSearchResult extends Record<string, unknown> {
  output: string;
  ok: true;
  intent: AskResult['intent'];
  mode: AskResult['mode'];
  said: AskResult['said'] | null;
  rows: AskResult['rows'];
  summary: string[];
}

export function buildDirectiveSearchTool(): LLMToolSpec {
  return {
    name: 'DirectiveSearch',
    description: 'Search what the owner said before, across every channel (Claude Code · codex · eln TUI · telegram · PWA · grok). '
      + 'Ask in plain Korean or English — time words (어제·지난주·이번 주·3시간 전·11월 23일·아침/밤) and channel words (텔레그램·코덱스·eln·클로드) '
      + 'are understood; the topic is matched by meaning and words. «…한 적 있어?» answers yes/no with the closest lines; '
      + '«지난 일주일 동안 … 내역» returns every match grouped by day with a short account. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question as spoken, e.g. "어제 로스터 얘기한 거" or "11월 23일에 데모 취소라고 한 적 있어?"' },
        since: { type: 'string', description: 'Optional ISO instant overriding the period start the question implies.' },
        until: { type: 'string', description: 'Optional ISO instant overriding the period end.' },
        limit: { type: 'integer', description: 'Maximum utterances for a plain search, 1–50 (default 10).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };
}

function isoOrThrow(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO date-time`);
  return new Date(Date.parse(value)).toISOString();
}

export async function dispatchDirectiveSearch(args: Record<string, unknown>, deps: DirectiveSearchDeps = {}): Promise<DirectiveSearchResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new Error('query is required');
  const limit = args.limit === undefined ? 10 : args.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be an integer between 1 and 50');
  const since = isoOrThrow(args.since, 'since');
  const until = isoOrThrow(args.until, 'until');
  const embed = deps.embed !== undefined ? deps.embed : (await import('../../domains/knowledge.js')).defaultEmbed;
  const index = new DirectiveIndex(deps.index ?? {});
  try {
    index.sync();
    const result = await askDirectives(index, query, { embed, now: deps.now, limit, since, until, embedMax: 100 });
    return {
      output: renderAsk(result), ok: true, intent: result.intent, mode: result.mode,
      said: result.said ?? null, rows: result.rows, summary: result.summary ?? [],
    };
  } finally { index.close(); }
}
