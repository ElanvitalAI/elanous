// SEARCH-BENCH Track I — the docs search index at three stages, built in a temp DB over the corpus (never the seat's
// knowledge.db):
//   stage 0 = before #40031: file selection by KNOWN_PREFIXES only (docs/conductor JUDGE-…/FEATURE-… not indexed),
//             FTS over chunk text only, RRF(vector, BM25) — re-implemented from the #40031 diff with product primitives.
//   stage 1 = #40031 (current product): `ingestDocsDir` + `hybridQueryKnowledge` as shipped (living dirs indexed,
//             dir/filename + H1 title in FTS, name/title ranking ×3).
//   stage 2 = triple index: stage 1 ⊕ a relation scorer (relation-graph.ts) fused by RRF — the slot the real
//             Relate/ontology scorer (DOCS-DISTILL-3-RRF) drops into.
// Vectors: a deterministic hashed n-gram embedding (offline, no model) so CI is reproducible; `embed: 'live'` swaps in
// the product defaultEmbed for a live run.
import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chunkReport, defaultEmbed, hybridQueryKnowledge, ingestDocsDir, openKnowledgeDb, queryKnowledge, type EmbedFn } from '../../domains/knowledge.js';
import { ftsQuery } from '../../domains/surface-events.js';
import { scanDocs } from '../../autopilot/discovery/doc-inventory.js';
import { KNOWN_PREFIXES } from '../../autopilot/discovery/doc-lint.js';

const HASH_DIM = 256;

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Deterministic feature-hashing embedding: word unigrams + character trigrams (Hangul-friendly), L2-normalized. */
export function hashEmbed(text: string): Float32Array {
  const v = new Float32Array(HASH_DIM);
  const words = text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 1).slice(0, 4000);
  const add = (feature: string, weight: number) => {
    const h = fnv1a(feature);
    v[h % HASH_DIM]! += (h & 0x80000000 ? -1 : 1) * weight;
  };
  for (const w of words) {
    add(`w:${w}`, 1);
    if (w.length >= 3) for (let i = 0; i + 3 <= w.length; i += 1) add(`t:${w.slice(i, i + 3)}`, 0.5);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i += 1) v[i] = v[i]! / norm;
  return v;
}
export const hashEmbedFn: EmbedFn = async (text) => ({ vector: hashEmbed(text), model: `bench-hash-${HASH_DIM}` });

export interface DocsHit { readonly path: string; readonly score: number }
export interface DocsIndex {
  readonly stage: 0 | 1;
  readonly files: number;
  readonly chunks: number;
  readonly buildMs: number;
  query(q: string, k: number): Promise<DocsHit[]>;
  /** Chunk-level matches in the shape the product DocsSearch tool takes as its index (path · snippet · matchedBy). */
  matches?(q: string, k: number): Promise<Array<{ path: string; snippet: string; matchedBy: string }>>;
}

const rel = (root: string, p: string): string => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);

function dedupe(root: string, rows: ReadonlyArray<{ source_ref: string | null; score: number }>, k: number): DocsHit[] {
  const out: DocsHit[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.source_ref) continue;
    const p = rel(root, r.source_ref);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({ path: p, score: r.score });
    if (out.length >= k) break;
  }
  return out;
}

/** Stage 1 — the shipped product path. */
export async function buildStage1(root: string, dbPath: string, embed: EmbedFn = hashEmbedFn): Promise<DocsIndex> {
  const started = performance.now();
  const db = openKnowledgeDb(dbPath);
  const r = await ingestDocsDir(db, { dir: join(root, 'docs'), embed, domain: 'elanous' });
  const buildMs = performance.now() - started;
  return {
    stage: 1, files: r.files, chunks: r.chunks, buildMs,
    async query(q, k) {
      const matches = await hybridQueryKnowledge(db, q, { k: 20, domain: 'elanous', kind: 'docs', embed });
      return dedupe(root, matches.map((m) => ({ source_ref: m.source_ref, score: m.rrf })), k);
    },
    async matches(q, k) {
      const matches = await hybridQueryKnowledge(db, q, { k, domain: 'elanous', embed });
      return matches.filter((m) => m.source_ref).map((m) => ({ path: m.source_ref!, snippet: m.text.replace(/\n+/g, ' / ').slice(0, 200), matchedBy: m.matchedBy }));
    },
  };
}

/** Stage 0 — pre-#40031 selection and FTS text, same chunker/FTS/vector primitives, RRF without the title ranking. */
export async function buildStage0(root: string, dbPath: string, embed: EmbedFn = hashEmbedFn): Promise<DocsIndex> {
  const started = performance.now();
  const db: Database = openKnowledgeDb(dbPath);
  const docsDir = join(root, 'docs');
  const files = scanDocs(docsDir, { readText: false }).filter((e) => KNOWN_PREFIXES.has(e.prefix)).map((e) => resolve(root, e.path)).sort();
  const insert = db.prepare(`INSERT OR IGNORE INTO docs(id, ts, kind, sector_tags, text, source_ref, embed_model, embedding, domain) VALUES (?,?,?,?,?,?,?,?,?)`);
  const fts = db.prepare(`INSERT INTO docs_fts (id, search_text) VALUES (?, ?)`);
  let chunks = 0;
  for (const file of files) {
    const parts = chunkReport(readFileSync(file, 'utf8'));
    for (let i = 0; i < parts.length; i += 1) {
      const id = `docs:${file}#${i}`;
      const { vector, model } = await embed(parts[i]!);
      insert.run(id, '2026-01-01T00:00:00.000Z', 'docs', null, parts[i]!, file, model, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), 'elanous');
      fts.run(id, parts[i]!);
      chunks += 1;
    }
  }
  const buildMs = performance.now() - started;
  return {
    stage: 0, files: files.length, chunks, buildMs,
    async query(q, k) {
      const pool = 80;
      let vector: Array<{ id: string }> = [];
      try { vector = await queryKnowledge(db, q, { k: 20, domain: 'elanous', kind: 'docs', embed }); } catch { /* keyword only */ }
      let keyword: Array<{ id: string }> = [];
      try {
        keyword = db.prepare(`SELECT d.id FROM docs_fts f JOIN docs d ON d.id = f.id WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts) LIMIT ?`)
          .all(ftsQuery(q), pool) as Array<{ id: string }>;
      } catch { /* parse failure */ }
      const score = new Map<string, number>();
      vector.forEach((m, i) => score.set(m.id, (score.get(m.id) ?? 0) + 1 / (60 + i + 1)));
      keyword.forEach((m, i) => score.set(m.id, (score.get(m.id) ?? 0) + 1 / (60 + i + 1)));
      const top = [...score.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 20);
      const src = db.prepare(`SELECT source_ref FROM docs WHERE id = ?`);
      return dedupe(root, top.map(([id, s]) => ({ source_ref: (src.get(id) as { source_ref: string } | null)?.source_ref ?? null, score: s })), k);
    },
  };
}

/** Text files a code index takes (source + docs + config). Binary/huge files are skipped. */
export const CODE_INDEX_EXT = /\.(ts|tsx|js|mjs|cjs|jsx|py|rs|go|swift|java|kt|c|h|cc|cpp|hpp|rb|lua|sh|zsh|toml|yaml|yml|json|md|mdx|txt)$/i;

export interface CorpusIndex {
  readonly files: number;
  readonly bytes: number;
  readonly buildMs: number;
  readonly dbBytes: number;
  query(q: string, k: number): Promise<DocsHit[]>;
}

/** Track I over source (new variant · works on any corpus, incl. ref): one row per text file = path tokens + the first
 *  64 KB, FTS5 BM25 (porter) ⊕ optional hashed vectors, RRF. Measures build time and DB size. */
export async function buildCorpusIndex(root: string, dbPath: string, files: readonly string[], opts: { vectors: boolean }): Promise<CorpusIndex> {
  const { Database } = await import('bun:sqlite');
  const { statSync } = await import('node:fs');
  const started = performance.now();
  const db = new Database(dbPath);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS f USING fts5(path UNINDEXED, head, body, tokenize = 'porter')`);
  db.run(`CREATE TABLE IF NOT EXISTS v(path TEXT PRIMARY KEY, emb BLOB)`);
  const ins = db.prepare(`INSERT INTO f(path, head, body) VALUES (?,?,?)`);
  const insV = db.prepare(`INSERT OR REPLACE INTO v(path, emb) VALUES (?,?)`);
  let n = 0, bytes = 0;
  db.run('BEGIN');
  for (const p of files) {
    if (!CODE_INDEX_EXT.test(p)) continue;
    let text: string;
    try { const st = statSync(join(root, p)); if (st.size > 1024 * 1024) continue; text = readFileSync(join(root, p), 'utf8').slice(0, 64 * 1024); } catch { continue; }
    const head = p.replace(/[/_.-]+/g, ' ');
    ins.run(p, head, text);
    if (opts.vectors) { const e = hashEmbed(`${head}\n${text.slice(0, 8000)}`); insV.run(p, new Uint8Array(e.buffer, e.byteOffset, e.byteLength)); }
    n += 1; bytes += text.length;
  }
  db.run('COMMIT');
  const buildMs = performance.now() - started;
  const dbBytes = statSync(dbPath).size;
  const vecs = opts.vectors ? (db.prepare(`SELECT path, emb FROM v`).all() as Array<{ path: string; emb: Uint8Array }>).map((r) => ({ path: r.path, v: new Float32Array(new Uint8Array(r.emb).buffer) })) : [];
  return {
    files: n, bytes, buildMs, dbBytes,
    async query(q, k) {
      const score = new Map<string, number>();
      let kw: Array<{ path: string }> = [];
      try { kw = db.prepare(`SELECT path FROM f WHERE f MATCH ? ORDER BY bm25(f, 0, 5.0, 1.0) LIMIT 60`).all(ftsQuery(q)) as Array<{ path: string }>; } catch { /* parse */ }
      kw.forEach((r, i) => score.set(r.path, (score.get(r.path) ?? 0) + 1 / (60 + i + 1)));
      if (vecs.length) {
        const qv = hashEmbed(q);
        const sims = vecs.map((r) => { let d = 0; for (let i = 0; i < qv.length; i += 1) d += qv[i]! * r.v[i]!; return { path: r.path, d }; })
          .sort((a, b) => b.d - a.d || (a.path < b.path ? -1 : 1)).slice(0, 60);
        sims.forEach((r, i) => score.set(r.path, (score.get(r.path) ?? 0) + 1 / (60 + i + 1)));
      }
      return [...score.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, k).map(([path, s]) => ({ path, score: s }));
    },
  };
}

export { defaultEmbed };
