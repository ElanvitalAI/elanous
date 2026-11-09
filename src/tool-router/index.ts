import type { PluginAIToolContribution, PluginAIToolRoute } from '../plugins/core/manifest.js';

export function toolRouteIdentity(pluginId: string, name: string): string {
  return `${pluginId}:${name}`;
}

export interface ToolRouteSource {
  pluginId: string;
  tools: readonly PluginAIToolContribution[];
}

export interface ToolRouteOntologyEntry {
  pluginId: string;
  terms: readonly string[];
}

export interface IndexedToolRoute {
  pluginId: string;
  name: string;
  description: string;
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

export interface SafeToolRouteDecision extends ToolRouteDecision {
  mode: 'index' | 'native-all';
  fallbackReason?: 'router-error';
  /** When present, fallback native discovery must be restricted to this enabled set. */
  enabledPluginIds?: string[];
}

export interface ToolRouteAuthorization {
  allowed: boolean;
  confirmationRequired: boolean;
}

export type ToolRouteDispatch<T> =
  | { status: 'confirmation-required'; confirmationRequired: true }
  | { status: 'dispatched'; confirmationRequired: boolean; result: T };

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const RRF_K = 60;
const DEFAULT_ROUTE_LIMIT = 3;

/** First-party domain terms from RFC-native-tools-as-default-plugins-lazy-routing §4c. */
export const FIRST_PARTY_TOOL_ONTOLOGY: readonly ToolRouteOntologyEntry[] = [
  { pluginId: 'elanous-release', terms: ['발행', '릴리즈', '릴리스', '컷', '판', 'release', 'publish'] },
  { pluginId: 'elanous-observe', terms: ['로그', '관측', '운영 상태', 'log', 'observe', 'status'] },
];

/** Index only declared plugin tools; no handler is loaded or executed at route time. */
export function buildToolRouteIndex(
  sources: readonly ToolRouteSource[],
  ontology: readonly ToolRouteOntologyEntry[] = FIRST_PARTY_TOOL_ONTOLOGY,
): ToolRouteIndex {
  const entries: IndexedToolRoute[] = [];
  for (const source of sources) for (const tool of source.tools) {
    if (!tool.route) continue;
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
      route: tool.route,
      documentTerms,
      documentLength: terms.length,
    });
  }
  const documentFrequency = new Map<string, number>();
  for (const entry of entries) for (const term of entry.documentTerms.keys()) {
    documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  return {
    entries,
    ontology: ontology.map((entry) => ({ pluginId: entry.pluginId, terms: [...new Set(entry.terms.flatMap(tokenize))] })),
    averageDocumentLength: entries.length === 0 ? 0 : entries.reduce((sum, entry) => sum + entry.documentLength, 0) / entries.length,
    documentFrequency,
  };
}

/** Deterministic BM25 + domain-ontology ranking. Scores stay separate for observation. */
export function routeToolIntent(
  index: ToolRouteIndex,
  query: string,
  opts: { enabledPluginIds: ReadonlySet<string>; limit?: number },
): ToolRouteDecision {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return { query, matches: [], miss: true };
  const eligible = index.entries
    .filter((entry) => opts.enabledPluginIds.has(entry.pluginId))
    .map((entry) => {
      const ontologyEntry = index.ontology.find((candidate) => candidate.pluginId === entry.pluginId);
      const ontologyTerms = (ontologyEntry?.terms ?? []).filter((term) => queryTerms.includes(term));
      return { entry, ontologyTerms, bm25: bm25Score(index, entry, queryTerms), ontology: ontologyTerms.length };
    })
    .filter(({ entry, ontologyTerms }) => ontologyTerms.length > 0
      || hasTriggerEvidence({ pluginId: entry.pluginId, name: entry.name, route: entry.route, bm25: 0, ontology: 0, ontologyTerms: [], score: 0 }, queryTerms));
  const bm25Ranks = rankBy(eligible, (item) => item.bm25);
  const ontologyRanks = rankBy(eligible, (item) => item.ontology);
  const candidates: ToolRouteMatch[] = eligible.map(({ entry, ontologyTerms, bm25, ontology }) => {
    const rankKey = toolRouteIdentity(entry.pluginId, entry.name);
    const bm25Rank = bm25Ranks.get(rankKey) ?? 0;
    const ontologyRank = ontologyRanks.get(rankKey) ?? 0;
    const score = (bm25Rank ? 1 / (RRF_K + bm25Rank) : 0)
      + (ontologyRank ? 1 / (RRF_K + ontologyRank) : 0);
    return { pluginId: entry.pluginId, name: entry.name, route: entry.route, bm25, ontology, ontologyTerms, score };
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
  opts: { enabledPluginIds: ReadonlySet<string>; limit?: number },
): SafeToolRouteDecision {
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
      enabledPluginIds: [...opts.enabledPluginIds].sort(),
    };
  }
}

/** The shared pre-dispatch gate used by callers and route simulations. */
export function authorizeToolRoute(match: ToolRouteMatch, confirmed: boolean): ToolRouteAuthorization {
  const confirmationRequired = match.route.requiresConfirm;
  return { confirmationRequired, allowed: !confirmationRequired || confirmed };
}

/** The single route-to-handler dispatch gate; confirmation is checked before execute is called. */
export function dispatchToolRoute<T>(
  match: ToolRouteMatch,
  confirmed: boolean,
  execute: (match: ToolRouteMatch) => T,
): ToolRouteDispatch<T> {
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

function hasTriggerEvidence(candidate: ToolRouteMatch, queryTerms: readonly string[]): boolean {
  const query = queryTerms.join(' ');
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
