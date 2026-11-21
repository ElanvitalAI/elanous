import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Native tool: omni_search
//
// Skill-essence extraction of ~/.claude/skills/omni-crawl/. Different
// from WebSearch (cascade — first available wins): omni_search runs
// every selected provider in parallel and merges hits. Research dispatch
// uses Exa/Firecrawl web fallback alongside concurrent Grok when it is ready.
//
// Probe: at least 2 providers available. With only 1, plain WebSearch
// is sufficient — no point paying the parallel-fan-out cost.
//
// Merge strategies:
//   interleave  — round-robin pick across providers (default)
//   by-engine   — group hits under per-provider headings


import {
  getAvailableResearchWebSearchProviders,
  getAvailableResearchWebSearchProvidersAsync,
  getAvailableWebSearchProviders,
  listWebSearchProviders,
  webSearchProvidersPendingAsyncReadiness,
} from '../../web-search/index.js';
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
  signal?: AbortSignal;
  /** Observational only: callback failures must not interrupt a provider search. */
  onEngine?: (event: OmniSearchEngineEvent) => void;
  onSource?: (source: WebSearchHit & { engine: string }) => void;
  /** Test seam for verifying that sequential research providers share one deadline. */
  now?: () => number;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export function buildOmniSearchTool(): LLMToolSpec {
  return {
    name: 'OmniSearch',
    description:
      'Multi-provider web search — fans out to configured search providers in parallel and ' +
      'merges hits. Wider coverage than WebSearch (cascade). Research searches use bounded ' +
      'Exa / Firecrawl routes alongside Grok when configured. Probe-gated: requires at ' +
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

const RESEARCH_SEARCH_BUDGET_MS = 14_500;
const RESEARCH_WEB_FALLBACK_IDS = ['exa', 'firecrawl'];
const RESEARCH_GROK_ID = 'grok';
const RESEARCH_EXA_TIMEOUT_MS = 4_500;
const researchHits = new WeakMap<OmniSearchResult, Record<string, WebSearchHit[]>>();

export async function dispatchOmniSearch(
  rawArgs: Record<string, unknown>,
  opts: OmniSearchDispatchOpts = {},
): Promise<OmniSearchResult> {
  const args = validate(rawArgs);
  const allowed = researchOrder(await resolveResearchProvidersForDispatch(opts.signal));
  const requested = args.engines === undefined ? undefined : new Set(args.engines.map(id => id.toLowerCase()));
  const providers = requested === undefined
    ? allowed
    : allowed.filter(provider => requested.has(provider.id.toLowerCase()));
  return dispatchWithProviders(args, opts, providers);
}

export async function dispatchResearchOmniSearch(
  rawArgs: Record<string, unknown>,
  opts: OmniSearchDispatchOpts = {},
): Promise<OmniSearchResult> {
  const args = validate(rawArgs);
  const now = opts.now ?? Date.now;
  const deadlineAt = now() + RESEARCH_SEARCH_BUDGET_MS;
  // Typed-store credentials (e.g. Firecrawl key only in the secret store) need async readiness, inside the research budget.
  const ready = await resolveResearchProvidersForDispatch(opts.signal, Math.max(1, Math.min(RESEARCH_SEARCH_BUDGET_MS, deadlineAt - now())));
  const requested = args.engines === undefined ? undefined : new Set(args.engines.map(id => id.toLowerCase()));
  const pick = (list: ResearchProviders): ResearchProviders => requested === undefined
    ? list
    : list.filter(provider => requested.has(provider.id.toLowerCase()));
  const webFallback = pick(researchOrder(ready));
  // g3 demo: Grok (X/Reddit opinion) runs concurrently with the Exa/Firecrawl web fallback; its failure never drops web hits.
  const grok = pick(ready.filter(provider => provider.id === RESEARCH_GROK_ID));
  const [grokResult, webResult] = await Promise.all([
    grok.length === 0
      ? Promise.resolve(emptyOmniSearchResult(args))
      : dispatchWithProviders(args, opts, grok, { deadlineAt, now }).catch(() => emptyOmniSearchResult(args)),
    dispatchResearchWebFallback(args, opts, webFallback, deadlineAt),
  ]);
  return combineResearchResults(args, grokResult, webResult);
}

function emptyOmniSearchResult(args: OmniSearchArgs): OmniSearchResult {
  const result: OmniSearchResult = {
    output: '',
    metadata: { perEngine: {}, totalHits: 0, merge: args.merge ?? 'interleave' },
  };
  researchHits.set(result, {});
  return result;
}

async function dispatchResearchWebFallback(
  args: OmniSearchArgs,
  opts: OmniSearchDispatchOpts,
  providers: ReturnType<typeof getAvailableWebSearchProviders>,
  deadlineAt: number,
): Promise<OmniSearchResult> {
  const accumulated = emptyOmniSearchResult(args);
  for (const provider of providers) {
    const result = await dispatchWithProviders(args, opts, [provider], {
      deadlineAt,
      now: opts.now ?? Date.now,
    });
    Object.assign(accumulated.metadata.perEngine, result.metadata.perEngine);
    accumulated.metadata.totalHits += result.metadata.totalHits;
    accumulated.output += accumulated.output && result.output ? `\n\n${result.output}` : result.output;
    Object.assign(researchHits.get(accumulated)!, researchHits.get(result));
    const details = result.metadata.perEngine[provider.id];
    // A successful but empty response is no usable research evidence, so continue to the next provider.
    if (details && !details.error && details.hits > 0) break;
  }
  return accumulated;
}

function combineResearchResults(
  args: OmniSearchArgs,
  grokResult: OmniSearchResult,
  webResult: OmniSearchResult,
): OmniSearchResult {
  const perEngine = { ...grokResult.metadata.perEngine, ...webResult.metadata.perEngine };
  const hitsByEngine = { ...researchHits.get(grokResult), ...researchHits.get(webResult) };
  const merge = args.merge ?? 'interleave';
  const limit = Math.max(1, Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const merged = (merge === 'interleave'
    ? interleaveHits(Object.fromEntries(Object.entries(hitsByEngine).map(([id, hits]) => [id, { hits }])))
    : groupByEngine(Object.fromEntries(Object.entries(hitsByEngine).map(([id, hits]) => [id, { hits }]))))
    .slice(0, limit);
  const selectedByEngine = new Map<string, WebSearchHit[]>();
  for (const [id, hits] of Object.entries(hitsByEngine)) selectedByEngine.set(id, []);
  // Keep merge order for the global limit while retaining each source heading.
  for (const hit of merged) {
    const id = Object.keys(hitsByEngine).find(engine => hitsByEngine[engine]!.includes(hit));
    if (id) selectedByEngine.get(id)!.push(hit);
  }
  const output: string[] = [`omni_search "${args.query}" — ${merged.length} hits across ${Object.keys(perEngine).length} provider${Object.keys(perEngine).length === 1 ? '' : 's'}`];
  for (const [id, info] of Object.entries(perEngine)) {
    output.push(`  ${id}: ${selectedByEngine.get(id)?.length ?? 0} hits in ${info.durationMs}ms${info.error ? ` ERROR: ${info.error}` : ''}`);
  }
  output.push('');
  if (merge === 'by-engine') {
    for (const [id, hits] of selectedByEngine) {
      if (hits.length === 0) continue;
      output.push(`## ${id}`);
      for (const hit of hits) output.push(formatHit(hit));
      output.push('');
    }
  } else {
    for (const hit of merged) output.push(formatHit(hit));
  }
  const result: OmniSearchResult = {
    output: output.join('\n'),
    metadata: {
      perEngine: Object.fromEntries(Object.entries(perEngine).map(([id, info]) => [id, {
        ...info, hits: selectedByEngine.get(id)?.length ?? 0,
      }])),
      totalHits: merged.length,
      merge,
    },
  };
  researchHits.set(result, hitsByEngine);
  return result;
}

async function dispatchWithProviders(
  args: OmniSearchArgs,
  opts: OmniSearchDispatchOpts,
  selectedProviders?: ReturnType<typeof getAvailableWebSearchProviders>,
  researchLimits?: { deadlineAt: number; now: () => number },
): Promise<OmniSearchResult> {
  const merge = args.merge ?? 'interleave';
  const limit = Math.max(1, Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

  let providers = selectedProviders ?? getAvailableWebSearchProviders();
  if (!selectedProviders && args.engines && args.engines.length > 0) {
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
      const query = {
        query: args.query,
        limit,
        allowDomains: args.allow_domains,
        blockDomains: args.block_domains,
        recencyDays: args.recency_days,
      };
      let result;
      if (researchLimits) {
        const remainingMs = researchLimits.deadlineAt - researchLimits.now();
        const timeoutMs = p.id === 'exa'
          ? Math.min(RESEARCH_EXA_TIMEOUT_MS, remainingMs)
          : remainingMs;
        if (timeoutMs <= 0) throw new DOMException('Research search budget exhausted', 'TimeoutError');
        const controller = new AbortController();
        const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // Caller cancellation (before, during readiness, or during the call) still reaches the provider through
        // `signal`, and is reported per engine at once even if the provider ignores an already-aborted signal.
        const parent = opts.signal;
        const cancelled = new Promise<never>((_, reject) => {
          if (!parent) return;
          if (parent.aborted) reject(parent.reason);
          else parent.addEventListener('abort', () => reject(parent.reason), { once: true });
        });
        cancelled.catch(() => {});
        try {
          result = await Promise.race([
            p.search(query, signal),
            cancelled,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new DOMException(`Research search timed out after ${timeoutMs}ms`, 'TimeoutError'));
              }, timeoutMs);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } else {
        result = await p.search(query, opts.signal);
      }
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

  const result: OmniSearchResult = {
    output: lines.join('\n'),
    metadata: {
      perEngine: Object.fromEntries(Object.entries(perEngine).map(([k, v]) => [k, {
        hits: v.hits.length, durationMs: v.durationMs, error: v.error,
      }])),
      totalHits,
      merge,
    },
  };
  researchHits.set(result, Object.fromEntries(Object.entries(perEngine).map(([id, info]) => [id, info.hits])));
  return result;
}

/** Probe-compatible: at least 2 Exa/Firecrawl providers available for omni_search. */
export function omniSearchAvailable(): boolean {
  return getAvailableResearchProviders().length >= 2;
}

/** Research-only probe: require one bounded Exa/Firecrawl web route. */
export function researchOmniSearchAvailable(): boolean {
  return getAvailableResearchProviders().some(provider => RESEARCH_WEB_FALLBACK_IDS.includes(provider.id));
}

export function getAvailableResearchSearchEngineIds(): string[] {
  return getAvailableResearchProviders().map(provider => provider.id);
}

type ResearchProviders = ReturnType<typeof getAvailableWebSearchProviders>;

/** Last successful async readiness (typed stores included). A rejection is never cached. */
let lastAsyncReadyResearch: ResearchProviders | undefined;
let researchReadinessInFlight: Promise<unknown> | undefined;

function researchOrder(available: ResearchProviders): ResearchProviders {
  return RESEARCH_WEB_FALLBACK_IDS.flatMap(id => available.filter(provider => provider.id === id));
}

async function resolveResearchProviders(signal?: AbortSignal, timeoutMs?: number): Promise<ResearchProviders> {
  return researchOrder(await resolveReadyResearchProviders(signal, timeoutMs));
}

async function resolveReadyResearchProviders(signal?: AbortSignal, timeoutMs?: number): Promise<ResearchProviders> {
  const ready = await getAvailableResearchWebSearchProvidersAsync(signal, timeoutMs);
  lastAsyncReadyResearch = ready;
  return ready;
}

/** Returns the full ready snapshot (Grok included); callers apply researchOrder for the Exa/Firecrawl route.
 *  Dispatch keeps its envelope contract: if the caller cancels while readiness is resolving, fall back to the
 *  synchronous snapshot so the cancellation reaches the provider calls and is reported per engine, not thrown. */
async function resolveResearchProvidersForDispatch(signal?: AbortSignal, timeoutMs?: number): Promise<ResearchProviders> {
  try { return await resolveReadyResearchProviders(signal, timeoutMs); }
  catch (error) {
    if (!signal?.aborted) throw error;
    return getAvailableResearchWebSearchProviders();
  }
}

/** Start (once at a time) the async typed-store readiness check so later synchronous probes can see it. */
export function primeResearchOmniSearchReadiness(): Promise<unknown> {
  researchReadinessInFlight ??= resolveResearchProviders()
    .catch(() => undefined)
    .finally(() => { researchReadinessInFlight = undefined; });
  return researchReadinessInFlight;
}

/** Synchronous probe: env/config availability plus the last async readiness result. Until that result
 *  exists, kick it off in the background; dispatch itself always re-resolves readiness asynchronously. */
function getAvailableResearchProviders(): ResearchProviders {
  const available = getAvailableResearchWebSearchProviders();
  const pending = webSearchProvidersPendingAsyncReadiness().filter(id => RESEARCH_WEB_FALLBACK_IDS.includes(id));
  if (lastAsyncReadyResearch === undefined && pending.length > 0) void primeResearchOmniSearchReadiness();
  const registered = new Set(listWebSearchProviders().map(provider => provider.id));
  const extra = (lastAsyncReadyResearch ?? []).filter(provider =>
    registered.has(provider.id) && !available.some(known => known.id === provider.id));
  return researchOrder([...available, ...extra]);
}

/** Async engine ids for callers that can await (CLI): resolves typed-store readiness directly. */
export async function getAvailableResearchSearchEngineIdsAsync(signal?: AbortSignal): Promise<string[]> {
  return (await resolveResearchProviders(signal)).map(provider => provider.id);
}

/** Test-only: forget cached async readiness. */
export function _resetResearchOmniSearchReadinessForTests(): void {
  lastAsyncReadyResearch = undefined;
  researchReadinessInFlight = undefined;
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
  // An empty engines array is «no preference», the same as omitting the argument.
  // Keeping it as an empty set would filter out every provider (a9dc research turns
  // answered «0 hits across 0 providers» — OP #117982 / RES #117975).
  const normalizedEngines = Array.isArray(engines) && engines.length === 0 ? undefined : engines as string[] | undefined;
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
    engines: normalizedEngines,
    limit: limit as number | undefined,
    merge: merge as OmniSearchArgs['merge'],
    allow_domains: raw.allow_domains as string[] | undefined,
    block_domains: raw.block_domains as string[] | undefined,
    recency_days: raw.recency_days as number | undefined,
  };
}
