// ── web_search native tool ──
//
// Model-facing tool that routes through the provider registry in
// src/web-search/. When the user has no search provider configured
// the tool throws a clear unavailability error instead of silently
// no-opping — the model should surface that to the user rather than
// hallucinate around it.

import type { LLMToolSpec } from '../../llm.js';
import { searchWeb, WebSearchUnavailableError } from '../../web-search/index.js';

export interface WebSearchArgs {
  query: string;
  limit?: number;
  allow_domains?: string[];
  block_domains?: string[];
  recency_days?: number;
  provider?: string;
}

export interface WebSearchToolResult {
  output: string;
  /** Number of hits actually returned. */
  numHits: number;
  /** Provider that served the result, for the log pane renderer. */
  providerName: string;
  /** Pass-through of any provider-level note. */
  note?: string;
}

export function buildWebSearchTool(): LLMToolSpec {
  return {
    name: 'WebSearch',
    description:
      'Search the public web — returns a ranked list of URLs + titles + snippets. ' +
      'Routes through the configured provider (Grok live-search by default; users can ' +
      'register Firecrawl / MCP / custom). Pair with WebFetch when you need the full ' +
      'body of a specific result.',
    parameters: {
      type: 'object',
      properties: {
        query:         { type: 'string',  description: 'Plain-text search query.' },
        limit:         { type: 'number',  description: 'Max hits to return. Default 5, cap 20.' },
        allow_domains: { type: 'array', items: { type: 'string' }, description: 'Restrict results to these domains. Providers that do not support this ignore the hint.' },
        block_domains: { type: 'array', items: { type: 'string' }, description: 'Exclude these domains from results.' },
        recency_days:  { type: 'number',  description: 'Restrict to pages indexed within the last N days. 0/undefined = any age.' },
        provider:      { type: 'string',  description: 'Force a specific provider by id (e.g., "grok"). When omitted, the registry picks the first available.' },
      },
      required: ['query'],
    },
  };
}

export async function dispatchWebSearch(args: Record<string, unknown>, ctx: { signal?: AbortSignal } = {}): Promise<WebSearchToolResult> {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('query is required');
  const limit = typeof args.limit === 'number' ? args.limit : undefined;
  const allowDomains = Array.isArray(args.allow_domains)
    ? (args.allow_domains as unknown[]).filter(x => typeof x === 'string') as string[]
    : undefined;
  const blockDomains = Array.isArray(args.block_domains)
    ? (args.block_domains as unknown[]).filter(x => typeof x === 'string') as string[]
    : undefined;
  const recencyDays = typeof args.recency_days === 'number' && args.recency_days > 0
    ? args.recency_days
    : undefined;
  const providerId = typeof args.provider === 'string' && args.provider.length > 0
    ? args.provider
    : undefined;

  let result;
  try {
    result = await searchWeb({
      query,
      ...(limit !== undefined ? { limit } : {}),
      ...(allowDomains ? { allowDomains } : {}),
      ...(blockDomains ? { blockDomains } : {}),
      ...(recencyDays !== undefined ? { recencyDays } : {}),
    }, {
      ...(providerId ? { providerId } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } catch (err: any) {
    if (err instanceof WebSearchUnavailableError) {
      throw new Error(err.message);
    }
    throw err;
  }

  const header = result.hits.length === 0
    ? `No results for "${query}" (via ${result.providerName}, ${result.durationMs}ms)`
    : `${result.hits.length} result${result.hits.length === 1 ? '' : 's'} for "${query}" (via ${result.providerName}, ${result.durationMs}ms)`;

  const hitLines = result.hits.map((h, i) => {
    const scoreTag = h.score !== undefined ? ` [${h.score.toFixed(2)}]` : '';
    const datedTag = h.publishedAt
      ? ` (${new Date(h.publishedAt).toISOString().slice(0, 10)})`
      : '';
    const snippet = h.snippet ? `\n    ${h.snippet}` : '';
    return `${i + 1}. ${h.title}${scoreTag}${datedTag}\n   ${h.url}${snippet}`;
  });

  const notePrefix = result.note ? `\n\n${result.note}\n` : '';
  const xStatus = result.xSearch === 'unavailable'
    ? 'X search unavailable: these results do not establish reactions on X; do not cite them as X posts.'
    : '';
  const output = [header, xStatus, notePrefix.trim(), ...hitLines].filter(Boolean).join('\n\n');

  return {
    output,
    numHits: result.hits.length,
    providerName: result.providerName,
    ...(result.note ? { note: result.note } : {}),
  };
}
