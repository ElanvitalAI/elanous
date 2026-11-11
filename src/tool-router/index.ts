import type { PluginAIToolContribution, PluginAIToolRoute } from '../plugins/core/manifest.js';

export function toolRouteIdentity(pluginId: string, name: string): string {
  return `${pluginId}:${name}`;
}

export interface ToolRouteSource {
  pluginId: string;
  tools: readonly PluginAIToolContribution[];
}

export interface ToolRouteIndexOptions {
  allowedGraphIds?: ReadonlySet<string>;
  allowedGraphIdsByPlugin?: ReadonlyMap<string, ReadonlySet<string>>;
  allowedGraphIdsByRoute?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ToolRouteOntologyEntry {
  pluginId: string;
  terms: readonly string[];
}

export interface IndexedToolRoute {
  pluginId: string;
  name: string;
  description: string;
  handler?: string;
  route: PluginAIToolRoute;
  documentTerms: ReadonlyMap<string, number>;
  documentLength: number;
}

export interface ToolRouteIndex {
  entries: readonly IndexedToolRoute[];
  ontology: readonly ToolRouteOntologyEntry[];
  averageDocumentLength: number;
  documentFrequency: ReadonlyMap<string, number>;
}

export interface ToolRouteMatch {
  pluginId: string;
  name: string;
  handler?: string;
  route: PluginAIToolRoute;
  bm25: number;
  ontology: number;
  ontologyTerms: string[];
  score: number;
}

export interface ToolRouteDecision {
  query: string;
  matches: ToolRouteMatch[];
  miss: boolean;
}

export interface ToolRouteScope {
  enabledPluginIds: ReadonlySet<string>;
  /** Active plugins may be a subset of installed and enabled plugins. */
  activePluginIds?: ReadonlySet<string>;
  /** Graph handlers are hidden unless their manifest-declared graph ID is allowed. */
  allowedGraphIds?: ReadonlySet<string>;
  allowedGraphIdsByPlugin?: ReadonlyMap<string, ReadonlySet<string>>;
  limit?: number;
}

export interface SafeToolRouteDecision extends ToolRouteDecision {
  mode: 'index' | 'native-all';
  fallbackReason?: 'router-error';
  /** When present, fallback native discovery must be restricted to this enabled set. */
  enabledPluginIds?: string[];
}

export type ToolRoutingStrategy = 'index' | 'native-all';

/** Change this one default to roll routing back; individual runs may still override it. */
export const DEFAULT_TOOL_ROUTING_STRATEGY: ToolRoutingStrategy = 'index';

/** Index routing is the default; native-all remains an explicit A/B escape hatch. */
export function defaultToolRoutingStrategy(requested?: ToolRoutingStrategy): ToolRoutingStrategy {
  return requested ?? DEFAULT_TOOL_ROUTING_STRATEGY;
}

export interface ToolRouteAuthorization {
  allowed: boolean;
  confirmationRequired: boolean;
}

export type ToolRouteDispatch<T> =
  | { status: 'confirmation-required'; confirmationRequired: true }
  | { status: 'graph-not-allowlisted'; confirmationRequired: boolean }
  | { status: 'dispatched'; confirmationRequired: boolean; result: T };

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const RRF_K = 60;
const DEFAULT_ROUTE_LIMIT = 3;
const NO_ALLOWED_GRAPH_IDS: ReadonlySet<string> = new Set();

/** First-party domain terms from RFC-native-tools-as-default-plugins-lazy-routing §4c. */
export const FIRST_PARTY_TOOL_ONTOLOGY: readonly ToolRouteOntologyEntry[] = [
  { pluginId: 'elanous-release', terms: ['발행', '릴리즈', '릴리스', '컷', '판', 'release', 'publish'] },
  { pluginId: 'elanous-observe', terms: ['로그', '관측', '운영 상태', 'log', 'observe', 'ops status'] },
];

/** Index only declared plugin tools; no handler is loaded or executed at route time. */
export function buildToolRouteIndex(
  sources: readonly ToolRouteSource[],
  ontologyOrOptions: readonly ToolRouteOntologyEntry[] | ToolRouteIndexOptions = FIRST_PARTY_TOOL_ONTOLOGY,
): ToolRouteIndex {
  const ontology = Array.isArray(ontologyOrOptions)
    ? ontologyOrOptions as readonly ToolRouteOntologyEntry[] : FIRST_PARTY_TOOL_ONTOLOGY;
  const options = Array.isArray(ontologyOrOptions) ? {} : ontologyOrOptions as ToolRouteIndexOptions;
  const entries: IndexedToolRoute[] = [];
  for (const source of sources) for (const tool of source.tools) {
    if (!tool.route) continue;
    if (isGraphRouteHandler(tool.handler)) {
      const routeAllowlist = options.allowedGraphIdsByRoute
        ? options.allowedGraphIdsByRoute.get(toolRouteIdentity(source.pluginId, tool.name)) ?? NO_ALLOWED_GRAPH_IDS
        : options.allowedGraphIdsByPlugin?.get(source.pluginId) ?? options.allowedGraphIds ?? NO_ALLOWED_GRAPH_IDS;
      if (!graphRouteHandlerAllowed(tool.handler!, routeAllowlist)) continue;
    }
    const terms = tokenize([
      tool.name, tool.description,
      ...tool.route.triggers, ...tool.route.examples,
    ].join(' '));
    const documentTerms = new Map<string, number>();
    for (const term of terms) documentTerms.set(term, (documentTerms.get(term) ?? 0) + 1);
    entries.push({
      pluginId: source.pluginId,
      name: tool.name,
      description: tool.description,
      ...(tool.handler ? { handler: tool.handler } : {}),
      route: tool.route,
      documentTerms,
      documentLength: terms.length,
    });
  }
  const documentFrequency = new Map<string, number>();
  for (const entry of entries) for (const term of entry.documentTerms.keys()) {
    documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  // Source: plugin route manifests supply plugin membership; eligibility still requires each tool's trigger evidence.
  const knownOntologyIds = new Set(ontology.map(({ pluginId }) => pluginId));
  const inferredOntology = ontology === FIRST_PARTY_TOOL_ONTOLOGY
    ? [...new Set(sources.filter(({ tools }) => tools.some((tool) => tool.route)).map(({ pluginId }) => pluginId))]
      .filter((pluginId) => !knownOntologyIds.has(pluginId))
      .map((pluginId) => ({ pluginId, terms: [] }))
    : [];
  return {
    entries,
    ontology: [...ontology, ...inferredOntology].map((entry) => ({
      pluginId: entry.pluginId,
      terms: [...new Set(entry.terms.map((term) => tokenize(term).join(' ')).filter(Boolean))],
    })),
    averageDocumentLength: entries.length === 0 ? 0 : entries.reduce((sum, entry) => sum + entry.documentLength, 0) / entries.length,
    documentFrequency,
  };
}

/** Deterministic BM25 + domain-ontology ranking. Scores stay separate for observation. */
export function routeToolIntent(
  index: ToolRouteIndex,
  query: string,
  opts: ToolRouteScope,
): ToolRouteDecision {
  const queryTokens = tokenize(query);
  const queryTerms = [...new Set(queryTokens)];
  if (queryTerms.length === 0) return { query, matches: [], miss: true };
  const queryPhrase = ` ${queryTokens.join(' ')} `;
  const allowedPluginIds = scopedPluginIds(opts);
  const eligible = index.entries
    .filter((entry) => allowedPluginIds.has(entry.pluginId)
      && (!isGraphRouteHandler(entry.handler)
        || graphRouteHandlerAllowed(entry.handler!, opts.allowedGraphIdsByPlugin?.get(entry.pluginId)
          ?? opts.allowedGraphIds ?? NO_ALLOWED_GRAPH_IDS)))
    .map((entry) => {
      const ontologyEntry = index.ontology.find((candidate) => candidate.pluginId === entry.pluginId);
      const ontologyTerms = (ontologyEntry?.terms ?? []).filter((term) => queryPhrase.includes(` ${term} `));
      return { entry, ontologyTerms, bm25: bm25Score(index, entry, queryTerms), ontology: ontologyTerms.length };
    })
    .filter(({ entry, ontologyTerms }) => ontologyTerms.length > 0
      || hasTriggerEvidence({ pluginId: entry.pluginId, name: entry.name, route: entry.route, bm25: 0, ontology: 0, ontologyTerms: [], score: 0 }, queryTokens));
  const bm25Ranks = rankBy(eligible, (item) => item.bm25);
  const ontologyRanks = rankBy(eligible, (item) => item.ontology);
  const candidates: ToolRouteMatch[] = eligible.map(({ entry, ontologyTerms, bm25, ontology }) => {
    const rankKey = toolRouteIdentity(entry.pluginId, entry.name);
    const bm25Rank = bm25Ranks.get(rankKey) ?? 0;
    const ontologyRank = ontologyRanks.get(rankKey) ?? 0;
    const score = (bm25Rank ? 1 / (RRF_K + bm25Rank) : 0)
      + (ontologyRank ? 1 / (RRF_K + ontologyRank) : 0);
    return { pluginId: entry.pluginId, name: entry.name, ...(entry.handler ? { handler: entry.handler } : {}),
      route: entry.route, bm25, ontology, ontologyTerms, score };
  }).filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || right.bm25 - left.bm25
      || `${left.pluginId}:${left.name}`.localeCompare(`${right.pluginId}:${right.name}`))
    .slice(0, Math.max(0, opts.limit ?? DEFAULT_ROUTE_LIMIT));
  return { query, matches: candidates, miss: candidates.length === 0 };
}

/** Router failures degrade to the existing native tool surface without blocking the turn. */
export function routeToolIntentWithFallback(
  query: string,
  loadIndex: () => ToolRouteIndex,
  opts: ToolRouteScope & { strategy?: ToolRoutingStrategy },
): SafeToolRouteDecision {
  if (defaultToolRoutingStrategy(opts.strategy) === 'native-all') {
    return {
      query, matches: [], miss: true, mode: 'native-all',
      enabledPluginIds: [...scopedPluginIds(opts)].sort(),
    };
  }
  try {
    return {
      ...routeToolIntent(loadIndex(), query, opts),
      mode: 'index',
    };
  } catch {
    return {
      query,
      matches: [],
      miss: true,
      mode: 'native-all',
      fallbackReason: 'router-error',
      enabledPluginIds: [...scopedPluginIds(opts)].sort(),
    };
  }
}

function scopedPluginIds(opts: ToolRouteScope): Set<string> {
  return new Set([...opts.enabledPluginIds].filter((pluginId) => opts.activePluginIds?.has(pluginId) ?? true));
}

/** The shared pre-dispatch gate used by callers and route simulations. */
export function authorizeToolRoute(match: ToolRouteMatch, confirmed: boolean): ToolRouteAuthorization {
  const confirmationRequired = match.route.requiresConfirm;
  return { confirmationRequired, allowed: !confirmationRequired || confirmed };
}

/** The single route-to-handler dispatch gate; confirmation is checked before execute is called. */
export function isGraphRouteHandler(handler: string | undefined): boolean {
  return handler?.startsWith('graph:') === true || handler?.startsWith('./graph:') === true;
}

export function graphRouteHandlerAllowed(handler: string, allowedGraphIds: ReadonlySet<string>): boolean {
  if (!isGraphRouteHandler(handler)) return false;
  const graphId = handler.replace(/^(?:\.\/)?graph:/, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(graphId) && allowedGraphIds.has(graphId);
}

export function dispatchToolRoute<T>(
  match: ToolRouteMatch,
  confirmed: boolean,
  execute: (match: ToolRouteMatch) => T,
  opts: { allowedGraphIds?: ReadonlySet<string> } = {},
): ToolRouteDispatch<T> {
  const handler = match.handler;
  if (handler && isGraphRouteHandler(handler)) {
    if (!graphRouteHandlerAllowed(handler, opts.allowedGraphIds ?? new Set())) {
      return { status: 'graph-not-allowlisted', confirmationRequired: match.route.requiresConfirm };
    }
  }
  const authorization = authorizeToolRoute(match, confirmed);
  if (!authorization.allowed) return { status: 'confirmation-required', confirmationRequired: true };
  return { status: 'dispatched', confirmationRequired: authorization.confirmationRequired, result: execute(match) };
}


function rankBy<T extends { entry: IndexedToolRoute }>(items: readonly T[], score: (item: T) => number): Map<string, number> {
  const ranked = [...items].filter((item) => score(item) > 0)
    .sort((left, right) => score(right) - score(left)
      || `${left.entry.pluginId}:${left.entry.name}`.localeCompare(`${right.entry.pluginId}:${right.entry.name}`));
  const ranks = new Map<string, number>();
  let priorScore: number | undefined;
  let priorRank = 0;
  ranked.forEach((item, index) => {
    const currentScore = score(item);
    if (priorScore !== currentScore) priorRank = index + 1;
    ranks.set(toolRouteIdentity(item.entry.pluginId, item.entry.name), priorRank);
    priorScore = currentScore;
  });
  return ranks;
}

function hasTriggerEvidence(candidate: ToolRouteMatch, queryTokens: readonly string[]): boolean {
  const query = queryTokens.join(' ');
  return candidate.route.triggers.some((trigger) => {
    const phrase = tokenize(trigger).join(' ');
    return phrase.length > 0 && (` ${query} `).includes(` ${phrase} `);
  });
}

function bm25Score(index: ToolRouteIndex, entry: IndexedToolRoute, terms: readonly string[]): number {
  if (index.averageDocumentLength === 0) return 0;
  return terms.reduce((total, term) => {
    const frequency = entry.documentTerms.get(term) ?? 0;
    if (frequency === 0) return total;
    const documentFrequency = index.documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (index.entries.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
    const lengthNorm = frequency + BM25_K1 * (1 - BM25_B + BM25_B * entry.documentLength / index.averageDocumentLength);
    return total + idf * frequency * (BM25_K1 + 1) / lengthNorm;
  }, 0);
}

function tokenize(value: string): string[] {
  return (value.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? []).map(normalizeTerm);
}

function normalizeTerm(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}
