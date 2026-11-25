// DocsSearch — read-only LLM tool over the design docs (and optional reference repos).
// Same core as `elanous docs search`: the docs index first (when knowledge.db exists), then the #40041
// filename ⊕ content fallback over the same roots when the index is empty or semantic-only.
// Sources come only from the single resolver (src/knowledge/search-roots.ts: env ELANOUS_SOURCES and shortcuts >
// config knowledge.sources (legacy docsRoots/refRoots) > cwd auto-detect) — no directory is written in code.
import { existsSync, readFileSync } from 'node:fs';
import type { LLMToolSpec } from '../../llm/tool-spec.js';
import { fallbackDocsSearch, fallbackTokens, isLowConfidence } from '../../knowledge/docs-search-fallback.js';
import { resolveKnowledgeDocsRoots } from '../../knowledge/docs-roots.js';
import { citeSourcePath, loadSearchSources, resolveSearchSources, SEARCH_ROOTS_UNCONFIGURED_NOTE, SEARCH_SCOPES, type ResolvedSearchSource, type SearchScope, type SearchSourcesOpts } from '../../knowledge/search-roots.js';
import { debug } from '../../debug/log.js';
import { expandQueryWords } from './search-terms.js';

export type DocsSearchScope = SearchScope;

export interface DocsSearchHit {
  path: string;
  /** `repo:<id>/<relpath>` · `ref:<id>/<relpath>` · `custom:<id>/<relpath>` (absolute path when outside every source). */
  cite: string;
  snippet: string;
  via: 'index' | 'fallback';
}

export interface DocsIndexMatch { path: string; snippet: string; matchedBy: string }

export interface DocsSearchDeps {
  /** Resolver options (test seam: env / configRaw / exists). */
  sourcesOpts?: SearchSourcesOpts;
  /** Repo docs roots when none are configured (auto-detect from cwd). */
  autoRepoRoots?: () => string[];
  /** Docs index query; null disables the index (fallback only). */
  indexSearch?: ((query: string, k: number) => Promise<DocsIndexMatch[]>) | null;
}

export interface DocsSearchResult extends Record<string, unknown> {
  output: string;
  ok: true;
  scope: DocsSearchScope;
  roots: string[];
  sources: ResolvedSearchSource[];
  hits: DocsSearchHit[];
}

export function buildDocsSearchTool(): LLMToolSpec {
  return {
    name: 'DocsSearch',
    description: 'Search the project design docs (and configured reference repos) by topic — the index that breaks ties after Glob/Grep. '
      + 'Reach for Glob / Grep first (native search finds code and most docs); use DocsSearch when they return too many similar candidates '
      + 'or nothing, or when the topic is a design idea with no obvious filename. Examples: `DocsSearch(query: "판정국 부하 줄이기")` · '
      + '`DocsSearch(query: "landing train", scope: "both")`. Returns ranked file paths with a one-line snippet each; then Read the best path. '
      + 'Query words also match their ko↔en glossary terms. Uses the docs index, falling back to filename + content search over the same roots when the index has nothing. '
      + 'scope: repo (our repo docs, default) · ref (reference sources) · both · custom (explicit `paths` and/or configured `source_ids`). '
      + 'Hits are cited as repo:<id>/<path> or ref:<id>/<path>. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or words, e.g. "graph runner budget" or "착지 열차".' },
        scope: { type: 'string', enum: [...SEARCH_SCOPES], description: 'Which sources to search. Default repo.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'scope custom: directories or files to search (must exist; read-only).' },
        source_ids: { type: 'array', items: { type: 'string' }, description: 'scope custom: configured source ids to search.' },
        limit: { type: 'integer', description: 'Maximum hits, 1–20 (default 8).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };
}

function snippetOf(path: string, query: string): string {
  try {
    const tokens = fallbackTokens(query);
    const lines = readFileSync(path, 'utf8').split('\n');
    const line = lines.find((l) => tokens.some((t) => l.toLowerCase().includes(t))) ?? lines.find((l) => l.trim()) ?? '';
    return line.trim().slice(0, 200);
  } catch { return ''; }
}

async function defaultIndexSearch(query: string, k: number): Promise<DocsIndexMatch[]> {
  const knowledge = await import('../../domains/knowledge.js');
  if (!existsSync(knowledge.knowledgeDbPath())) return [];
  const db = knowledge.openKnowledgeDb();
  try {
    const matches = await knowledge.hybridQueryKnowledge(db, query, { k, domain: 'elanous' });
    return matches.filter((m) => m.source_ref).map((m) => ({
      path: m.source_ref!, snippet: m.text.replace(/\n+/g, ' / ').slice(0, 200), matchedBy: m.matchedBy,
    }));
  } finally { db.close(); }
}

export async function dispatchDocsSearch(args: Record<string, unknown>, deps: DocsSearchDeps = {}): Promise<DocsSearchResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new Error('query is required');
  const scope = (args.scope ?? 'repo') as DocsSearchScope;
  if (!(SEARCH_SCOPES as readonly string[]).includes(scope)) throw new Error(`scope must be one of ${SEARCH_SCOPES.join(', ')}`);
  const limit = args.limit === undefined ? 8 : args.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be an integer between 1 and 20');
  const strings = (v: unknown): string[] | undefined => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

  const notes: string[] = [];
  const loaded = loadSearchSources(deps.sourcesOpts);
  const sources = resolveSearchSources({ ...deps.sourcesOpts, scope, paths: strings(args.paths), sourceIds: strings(args.source_ids) });
  if (loaded.origin === 'none' && scope !== 'custom') notes.push(SEARCH_ROOTS_UNCONFIGURED_NOTE);
  // repo 출처는 docs 디렉터리로 정규화해 찾는다(인용은 출처 뿌리 기준). 설정이 없으면 cwd 자동 감지.
  const searchRoots: string[] = [];
  for (const s of sources) {
    if (s.type === 'repo') searchRoots.push(...resolveKnowledgeDocsRoots({ docsRoots: [s.path] }).roots.map((r) => r.path));
    else searchRoots.push(s.path);
  }
  if (!sources.some((x) => x.type === 'repo') && (scope === 'repo' || scope === 'both')) {
    searchRoots.push(...(deps.autoRepoRoots ?? (() => resolveKnowledgeDocsRoots().roots.map((r) => r.path)))());
  }
  if (sources.length === 0 && scope === 'ref') notes.push('no ref sources configured (knowledge.sources type "ref" or ELANOUS_REF_ROOTS)');

  // ko↔en glossary expansion (search-terms.ts) — «판정국 부하» also searches «judge load».
  const expanded = expandQueryWords(query);
  if (expanded.added.length > 0) notes.push(`[expanded: + ${expanded.added.join(', ')}]`);
  const hits: DocsSearchHit[] = [];
  let indexMatches: DocsIndexMatch[] = [];
  const indexSearch = deps.indexSearch === undefined ? defaultIndexSearch : deps.indexSearch;
  if ((scope === 'repo' || scope === 'both') && indexSearch) {
    try { indexMatches = await indexSearch(expanded.query, limit); } catch (error) {
      debug.log('tools.docs-search', 'index-failed', { error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    }
    for (const m of indexMatches) hits.push({ path: m.path, cite: citeSourcePath(m.path, sources), snippet: m.snippet, via: 'index' });
  }
  if (scope !== 'repo' || isLowConfidence(indexMatches)) {
    const seen = new Set(hits.map((h) => h.path));
    for (const f of fallbackDocsSearch(expanded.query, searchRoots, limit)) {
      if (seen.has(f.path)) continue;
      hits.push({ path: f.path, cite: citeSourcePath(f.path, sources), snippet: snippetOf(f.path, expanded.query), via: 'fallback' });
    }
  }
  const ranked = hits.slice(0, limit);
  if (ranked.length === 0) debug.log('docs', 'search-miss', { query, roots: searchRoots, hits: 0, surface: 'tool' }, { level: 'warn' });
  const lines = ranked.map((h, i) => `${i + 1}. ${h.via === 'fallback' ? '(fallback) ' : ''}${h.cite}${h.snippet ? ` — ${h.snippet}` : ''}`);
  const output = [
    ...notes,
    ranked.length === 0 ? `No docs matched «${query}» in ${searchRoots.length} root(s).` : `${ranked.length} doc(s) for «${query}» (scope ${scope}):`,
    ...lines,
  ].join('\n');
  return { output, ok: true, scope, roots: searchRoots, sources, hits: ranked };
}
