// MVP M1.5 A.2 — WebSearch tool (daemon side).
//
// Thin adapter over the existing `src/web-search/searchWeb()`
// provider registry — no new API surface, just a daemon-side
// LLMToolSpec + dispatch wrapper. The dashboard's skill-level
// `WebSearch` (`src/skills/tools/web-search.ts`) keeps its full
// argument set; this daemon-side variant exposes the minimal arg
// shape so headless callers (PWA · iPhone Shortcut · Telegram ·
// remote TUI) get a predictable contract.

import type { LLMToolSpec } from '../../llm.js';
import { searchWeb, WebSearchUnavailableError } from '../../web-search/index.js';

import { ToolSafetyError, type DaemonToolDispatchCtx } from './types.js';
import { debug } from '../../debug/log.js';

export interface DaemonWebSearchArgs {
  query: string;
  limit?: number;
  recency_days?: number;
}

export interface DaemonWebSearchResult {
  query: string;
  providerName: string;
  hits: Array<{
    url: string;
    title: string;
    snippet?: string;
  }>;
  numHits: number;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export function buildWebSearchTool(): LLMToolSpec {
  return {
    name: 'WebSearch',
    description:
      'Search the public web via the daemon\'s configured provider (Grok / ' +
      'Firecrawl / etc.). When no key is available, falls back to keyless DuckDuckGo. ' +
      'Returns a ranked list of URLs + titles + snippets. ' +
      'Pair with a follow-up Read or external WebFetch when the model needs ' +
      'the full article body.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Plain-text search query.' },
        limit: { type: 'number', description: `Max hits to return (default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT}).` },
        recency_days: { type: 'number', description: 'Restrict results indexed within the last N days.' },
      },
      required: ['query'],
    },
  };
}

export async function dispatchWebSearch(
  args: DaemonWebSearchArgs,
  ctx: DaemonToolDispatchCtx,
): Promise<DaemonWebSearchResult> {
  const query = String(args.query ?? '').trim();
  if (query.length === 0) {
    throw new ToolSafetyError('path-traversal', 'query is required');
  }
  const limit = typeof args.limit === 'number'
    ? Math.max(1, Math.min(args.limit, MAX_LIMIT))
    : DEFAULT_LIMIT;
  // 제1원칙 관측 — 웹 우회 조회(로컬 소스 대비). kind='web' 로 read/grep 과 구분.
  try {
    debug.log('agent.source', 'web', {
      query, limit,
      ...(ctx.sessionId ? { session: ctx.sessionId } : {}),
    });
  } catch { /* fail-open */ }
  const recencyDays = typeof args.recency_days === 'number' && args.recency_days > 0
    ? args.recency_days
    : undefined;

  try {
    const result = await searchWeb(
      {
        query,
        limit,
        ...(recencyDays !== undefined ? { recencyDays } : {}),
      },
      { signal: ctx.signal },
    );
    return {
      query,
      providerName: result.providerName,
      hits: result.hits.map((h) => ({
        url: h.url,
        title: h.title,
        snippet: h.snippet,
      })),
      numHits: result.hits.length,
    };
  } catch (err) {
    if (err instanceof WebSearchUnavailableError) {
      throw new ToolSafetyError('unavailable', err.message);
    }
    throw err;
  }
}
