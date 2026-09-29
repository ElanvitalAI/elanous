// Native tool: omni_search
//
// Skill-essence extraction of ~/.claude/skills/omni-crawl/. Different
// from WebSearch (cascade — first available wins): omni_search runs
// EVERY available web-search provider in PARALLEL and merges their
// hits, so the LLM gets a wider net for research-intent queries.
//
// Probe: at least 2 providers available. With only 1, plain WebSearch
// is sufficient — no point paying the parallel-fan-out cost.
//
// Merge strategies:
//   interleave  — round-robin pick across providers (default)
//   by-engine   — group hits under per-provider headings

import type { LLMToolSpec } from '../../llm.js';
import { getAvailableWebSearchProviders } from '../../web-search/index.js';
import type { WebSearchHit } from '../../web-search/provider.js';

export interface OmniSearchArgs {
  query: string;
  engines?: string[];                // provider ids; default: all available
  limit?: number;                    // per provider; default 5
  merge?: 'interleave' | 'by-engine';
  allow_domains?: string[];
  block_domains?: string[];
  recency_days?: number;
}

export interface OmniSearchResult {
  output: string;
  metadata: {
    perEngine: Record<string, { hits: number; durationMs: number; error?: string }>;
    totalHits: number;
    merge: 'interleave' | 'by-engine';
  };
}

export type OmniSearchEngineEvent =
  | { engine: string; phase: 'start' }
  | { engine: string; phase: 'complete'; hits: number; durationMs: number; error?: string };

export interface OmniSearchDispatchOpts {
  /** Observational only: callback failures must not interrupt a provider search. */
  onEngine?: (event: OmniSearchEngineEvent) => void;
  onSource?: (source: WebSearchHit & { engine: string }) => void;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export function buildOmniSearchTool(): LLMToolSpec {
  return {
    name: 'OmniSearch',
    description:
      'Multi-provider web search — fans out to every configured search provider in parallel and ' +
      'merges hits. Wider coverage than WebSearch (cascade). Use for research-intent queries ' +
      'where you want triangulation across Grok / Firecrawl / etc. Probe-gated: requires at ' +
      'least 2 available providers (otherwise WebSearch already covers it).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        engines: { type: 'array', items: { type: 'string' }, description: 'Provider ids to call. Default: all available.' },
        limit: { type: 'integer', description: `Per-provider hit limit. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.` },
        merge: { type: 'string', enum: ['interleave', 'by-engine'], description: 'How to combine multi-provider hits.' },
        allow_domains: { type: 'array', items: { type: 'string' } },
        block_domains: { type: 'array', items: { type: 'string' } },
        recency_days: { type: 'integer' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };
}

export async function dispatchOmniSearch(
  rawArgs: Record<string, unknown>,
  opts: OmniSearchDispatchOpts = {},
): Promise<OmniSearchResult> {
  const args = validate(rawArgs);
  const merge = args.merge ?? 'interleave';
  const limit = Math.max(1, Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

  let providers = getAvailableWebSearchProviders();
  if (args.engines && args.engines.length > 0) {
    const wanted = new Set(args.engines.map(e => e.toLowerCase()));
    providers = providers.filter(p => wanted.has(p.id.toLowerCase()));
  }
  if (providers.length === 0) {
    return {
      output: 'omni_search: no available providers (set XAI_API_KEY / FIRECRAWL_API_KEY or pass --engines)',
      metadata: { perEngine: {}, totalHits: 0, merge },
    };
  }

  // Parallel fan-out. Per-provider failures don't fail the whole call.
  const perEngine: Record<string, { hits: WebSearchHit[]; durationMs: number; error?: string }> = {};
  const emit = (event: OmniSearchEngineEvent): void => {
    if (!opts.onEngine) return;
    try {
      void Promise.resolve(opts.onEngine(event)).catch(() => {});
    } catch { /* Observers cannot change search results. */ }
  };
  await Promise.all(providers.map(async (p) => {
    const start = Date.now();
    emit({ engine: p.id, phase: 'start' });
    try {
      const result = await p.search({
        query: args.query,
        limit,
        allowDomains: args.allow_domains,
        blockDomains: args.block_domains,
        recencyDays: args.recency_days,
      });
      perEngine[p.id] = { hits: result.hits, durationMs: Date.now() - start };
      for (const hit of result.hits) {
        try {
          if (opts.onSource) void Promise.resolve(opts.onSource({ ...hit, engine: p.id })).catch(() => {});
        } catch { /* Observers cannot change search results. */ }
      }
    } catch (err) {
      perEngine[p.id] = {
        hits: [],
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const info = perEngine[p.id]!;
    emit({ engine: p.id, phase: 'complete', hits: info.hits.length, durationMs: info.durationMs,
      ...(info.error !== undefined ? { error: info.error } : {}) });
  }));

  // Merge.
  const merged = merge === 'interleave' ? interleaveHits(perEngine) : groupByEngine(perEngine);
  const totalHits = Object.values(perEngine).reduce((acc, v) => acc + v.hits.length, 0);

  // Render.
  const lines: string[] = [];
  lines.push(`omni_search "${args.query}" — ${totalHits} hits across ${providers.length} provider${providers.length === 1 ? '' : 's'}`);
  for (const [pid, info] of Object.entries(perEngine)) {
    const note = info.error ? ` ERROR: ${info.error}` : '';
    lines.push(`  ${pid}: ${info.hits.length} hits in ${info.durationMs}ms${note}`);
  }
  lines.push('');
  if (merge === 'by-engine') {
    for (const [pid, info] of Object.entries(perEngine)) {
      if (info.hits.length === 0) continue;
      lines.push(`## ${pid}`);
      for (const h of info.hits) lines.push(formatHit(h));
      lines.push('');
    }
  } else {
    for (const h of merged) lines.push(formatHit(h));
  }

  return {
    output: lines.join('\n'),
    metadata: {
      perEngine: Object.fromEntries(Object.entries(perEngine).map(([k, v]) => [k, {
        hits: v.hits.length, durationMs: v.durationMs, error: v.error,
      }])),
      totalHits,
      merge,
    },
  };
}

/** Probe-compatible: at least 2 search providers available. */
export function omniSearchAvailable(): boolean {
  return getAvailableWebSearchProviders().length >= 2;
}

function interleaveHits(perEngine: Record<string, { hits: WebSearchHit[] }>): WebSearchHit[] {
  const lists = Object.values(perEngine).map(v => v.hits.slice());
  const merged: WebSearchHit[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const list of lists) {
      const next = list.shift();
      if (next) { merged.push(next); progressed = true; }
    }
  }
  return merged;
}

function groupByEngine(perEngine: Record<string, { hits: WebSearchHit[] }>): WebSearchHit[] {
  return Object.values(perEngine).flatMap(v => v.hits);
}

function formatHit(h: WebSearchHit): string {
  const head = `- [${h.title}](${h.url})`;
  if (!h.snippet) return head;
  const snippet = h.snippet.length > 200 ? h.snippet.slice(0, 200) + '…' : h.snippet;
  return `${head}\n  ${snippet}`;
}

function validate(raw: Record<string, unknown>): OmniSearchArgs {
  const query = raw.query;
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error(`'query' is required`);
  }
  const engines = raw.engines;
  if (engines !== undefined) {
    if (!Array.isArray(engines) || !engines.every(e => typeof e === 'string')) {
      throw new Error(`'engines' must be an array of strings`);
    }
  }
  const limit = raw.limit;
  if (limit !== undefined && (typeof limit !== 'number' || limit <= 0)) {
    throw new Error(`'limit' must be a positive number`);
  }
  const merge = raw.merge;
  if (merge !== undefined && !['interleave', 'by-engine'].includes(merge as string)) {
    throw new Error(`'merge' must be 'interleave' or 'by-engine'`);
  }
  return {
    query,
    engines: engines as string[] | undefined,
    limit: limit as number | undefined,
    merge: merge as OmniSearchArgs['merge'],
    allow_domains: raw.allow_domains as string[] | undefined,
    block_domains: raw.block_domains as string[] | undefined,
    recency_days: raw.recency_days as number | undefined,
  };
}
