// Track I — the index: docs search stage 0 (pre-#40031) → stage 1 (#40031, shipped) → stage 2 triple (⊕ relations),
// plus a source/code index (BM25 ± hashed vectors over every text file — the Track-I answer for code and for the ref
// corpus, which has no docs/ tree).
import type { SearchKit } from '../kit.js';
import { rrf } from '../plan.js';
import type { SearchStrategy } from '../types.js';

export async function tripleRanked(q: string, kit: SearchKit, weight: number): Promise<string[]> {
  const base = (await kit.docs(1, q, 10)).map((h) => h.path);
  const rel = kit.relation().score(q, base);
  const relRanked = [...rel.entries()].filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([p]) => p);
  kit.note('Relation', q);
  return rrf([{ paths: base, weight: 1 }, { paths: relRanked, weight }]);
}

/** Stage 1b triple: the product DocsSearch tool (index ⊕ fallback, resolver sources) as the base leg. */
export async function triple1bRanked(q: string, kit: SearchKit, weight: number): Promise<string[]> {
  const base = await kit.docsTool(q, 'both', 10);
  const rel = kit.relation().score(q, base);
  const relRanked = [...rel.entries()].filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([p]) => p);
  kit.note('Relation', q);
  return rrf([{ paths: base, weight: 1 }, { paths: relRanked, weight }]);
}

const docsStage = (stage: 0 | 1): SearchStrategy['run'] => async (q, kit) => (await kit.docs(stage, q, 10)).map((h) => h.path);

export const indexStrategies: SearchStrategy[] = [
  { id: 'I0-docs-s0', version: 1, track: 'I', label: 'docs search · stage 0 (pre-#40031 selection, no title rank)', source: '#40031 diff (src/domains/knowledge.ts)', run: docsStage(0) },
  { id: 'I1-docs-s1', version: 1, track: 'I', label: 'docs search · stage 1 (#40031 shipped: conductor + name/title)', source: 'src/domains/knowledge.ts hybridQueryKnowledge', run: docsStage(1) },
  { id: 'I1b-docs-tool', version: 1, track: 'I', label: 'stage 1b: product DocsSearch tool (#40041 fallback · #40044 resolver, scope both)', source: 'src/skills/tools/docs-search.ts · src/knowledge/search-roots.ts', run: (q, kit) => kit.docsTool(q, 'both', 10) },
  { id: 'I2b-triple-tool-w2', version: 1, track: 'I', label: 'stage 1b ⊕ relations (triple on the DocsSearch tool)', source: 'docs-search.ts ⊕ relation-graph.ts', run: (q, kit) => triple1bRanked(q, kit, 2) },
  ...[0.5, 1, 2, 4].map((w): SearchStrategy => ({ id: `I2-triple-w${w}`, version: 1, track: 'I', label: `stage 2 triple-rrf (relation weight ${w})`, params: { relationWeight: w },
    source: 'relation-graph.ts stub (DOCS-DISTILL-3-RRF slot)', run: (q, kit) => tripleRanked(q, kit, w) })),
  { id: 'I3-code-bm25', version: 1, track: 'I', label: 'source index · BM25 (path + 64 KB body)', run: async (q, kit) => (await kit.codeIndex(q, 10, false)).map((h) => h.path) },
  { id: 'I3-code-hybrid', version: 1, track: 'I', label: 'source index · BM25 + hashed vectors', run: async (q, kit) => (await kit.codeIndex(q, 10, true)).map((h) => h.path) },
  { id: 'I4-all-index', version: 1, track: 'I', label: 'triple docs (w2) ⊕ source index (RRF)', run: async (q, kit) => rrf([{ paths: await tripleRanked(q, kit, 2), weight: 1 }, { paths: (await kit.codeIndex(q, 10, true)).map((h) => h.path), weight: 1 }]) },
];
