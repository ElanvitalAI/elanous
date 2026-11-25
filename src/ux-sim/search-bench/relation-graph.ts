// SEARCH-BENCH relation scorer — the third leg of the triple index (BM25 ⊕ vector ⊕ relations). The real ontology /
// Relate scorer (DOCS-DISTILL-3-RRF) is not in the tree yet, so this stub builds a relation graph from the corpus
// itself: doc→doc markdown links (umbrella «🔗» header links flagged), cell ids declared in a doc's header, cell ids
// mentioned in code comments, src/ paths a doc mentions. Any scorer with the same interface drops in.
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

export interface RelationScorer {
  readonly id: string;
  readonly version: number;
  /** Score paths related to the query and to the seed paths (top hits from the other legs). */
  score(query: string, seeds: readonly string[]): Map<string, number>;
}

const CELL = /\b[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+\b/g;
const SRC_PATH = /\bsrc\/[\w./-]+\.(?:ts|tsx|js|mjs)\b/g;
const LINK = /\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g;

export interface RelationGraph {
  readonly cellHeader: Map<string, Set<string>>;
  readonly cellName: Map<string, Set<string>>;
  readonly cellBody: Map<string, Set<string>>;
  readonly cellCode: Map<string, Set<string>>;
  readonly links: Map<string, Set<string>>;
  readonly umbrella: Map<string, Set<string>>;
  readonly docToCode: Map<string, Set<string>>;
  readonly edges: number;
  readonly buildMs: number;
}

const add = (m: Map<string, Set<string>>, k: string, v: string) => { const s = m.get(k) ?? new Set<string>(); s.add(v); m.set(k, s); };

/** files = corpus-relative paths. Markdown files give doc edges; source files give cell→code edges. */
export function buildRelationGraph(root: string, files: readonly string[]): RelationGraph {
  const started = performance.now();
  const g: Omit<RelationGraph, 'edges' | 'buildMs'> = { cellHeader: new Map(), cellName: new Map(), cellBody: new Map(), cellCode: new Map(), links: new Map(), umbrella: new Map(), docToCode: new Map() };
  const known = new Set(files);
  let edges = 0;
  for (const p of files) {
    const isDoc = p.endsWith('.md');
    const isCode = /\.(ts|tsx|js|mjs|py|rs|go|swift)$/.test(p) && !/\.test\.(ts|tsx|js)$/.test(p);
    if (!isDoc && !isCode) continue;
    let text: string;
    try { text = readFileSync(join(root, p), 'utf8'); } catch { continue; }
    if (text.length > 512 * 1024) text = text.slice(0, 512 * 1024);
    if (isCode) {
      for (const cell of new Set(text.match(CELL) ?? [])) { add(g.cellCode, cell, p); edges += 1; }
      continue;
    }
    const base = p.split('/').pop()!.replace(/\.md$/, '');
    if (/^[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(base)) { add(g.cellName, base, p); edges += 1; }
    const lines = text.split('\n');
    const header = lines.slice(0, 12).join('\n');
    for (const cell of new Set(header.match(CELL) ?? [])) { add(g.cellHeader, cell, p); edges += 1; }
    for (const cell of new Set(text.match(CELL) ?? [])) add(g.cellBody, cell, p);
    for (const m of text.matchAll(SRC_PATH)) if (known.has(m[0])) { add(g.docToCode, p, m[0]); edges += 1; }
    for (const line of lines) {
      for (const m of line.matchAll(LINK)) {
        const target = normalize(join(dirname(p), m[1]!));
        if (!known.has(target)) continue;
        add(g.links, p, target); add(g.links, target, p); edges += 1;
        if (line.startsWith('> 🔗')) add(g.umbrella, p, target);
      }
    }
  }
  return { ...g, edges, buildMs: performance.now() - started };
}

/** The stub scorer. Weights are params so the sweep can vary them. */
export function graphRelationScorer(g: RelationGraph, w: { header?: number; name?: number; body?: number; code?: number; neighbor?: number } = {}): RelationScorer {
  const W = { header: 2, name: 1, body: 0.2, code: 1, neighbor: 0.3, ...w };
  return {
    id: 'stub-corpus-graph', version: 1,
    score(query, seeds) {
      const out = new Map<string, number>();
      const bump = (p: string, s: number) => out.set(p, (out.get(p) ?? 0) + s);
      for (const cell of new Set(query.match(CELL) ?? [])) {
        for (const p of g.cellHeader.get(cell) ?? []) bump(p, W.header);
        for (const p of g.cellName.get(cell) ?? []) bump(p, W.name);
        for (const p of g.cellBody.get(cell) ?? []) bump(p, W.body);
        for (const p of g.cellCode.get(cell) ?? []) bump(p, W.code);
      }
      for (const seed of seeds.slice(0, 3)) {
        for (const p of g.links.get(seed) ?? []) bump(p, W.neighbor);
        for (const p of g.docToCode.get(seed) ?? []) bump(p, W.neighbor);
      }
      return out;
    },
  };
}
