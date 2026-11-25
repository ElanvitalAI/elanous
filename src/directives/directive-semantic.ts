// Hybrid utterance search — meaning (embedding cosine) + words (FTS5 bm25) fused by RRF.
// Same machinery as `eln docs search` (src/domains/knowledge.ts: EmbedFn · defaultEmbed · cosine · RRF_K ·
// surface-events ftsQuery). Vectors live in directives.db (`directive_vec`) next to the rows; only rows
// without a vector are embedded. When the embedder is down the search falls back to words and says so.
import type { DirectiveFilters, DirectiveIndex, DirectiveRow } from './directive-index.js';

export type EmbedFn = (text: string) => Promise<{ vector: Float32Array; model: string }>;
/** Below this cosine a meaning-only candidate is noise, not a match. */
export const MEANING_FLOOR = 0.6;

export interface EmbedPendingResult { embedded: number; pending: number; model: string | null; error: string | null }

/** Embeds rows that have no vector yet, oldest first, at most `max` per call. Stops at the first embedder failure. */
export async function embedPending(index: DirectiveIndex, embed: EmbedFn, max = 500): Promise<EmbedPendingResult> {
  const missing = index.db.prepare(`SELECT d.source_file, d.line_no, d.text FROM directives d
    LEFT JOIN directive_vec v ON v.source_file = d.source_file AND v.line_no = d.line_no
    WHERE v.source_file IS NULL ORDER BY d.ts DESC LIMIT ?`).all(Math.max(0, max)) as Array<{ source_file: string; line_no: number; text: string }>;
  const insert = index.db.prepare('INSERT OR REPLACE INTO directive_vec(source_file,line_no,model,vector) VALUES (?,?,?,?)');
  let embedded = 0;
  let model: string | null = null;
  for (const row of missing) {
    try {
      const out = await embed(row.text.slice(0, 2000));
      insert.run(row.source_file, row.line_no, out.model, Buffer.from(out.vector.buffer, out.vector.byteOffset, out.vector.byteLength));
      model = out.model;
      embedded++;
    } catch (error) {
      return { embedded, pending: pendingCount(index), model, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { embedded, pending: pendingCount(index), model, error: null };
}

export function pendingCount(index: DirectiveIndex): number {
  return (index.db.prepare(`SELECT count(*) AS n FROM directives d LEFT JOIN directive_vec v
    ON v.source_file = d.source_file AND v.line_no = d.line_no WHERE v.source_file IS NULL`).get() as { n: number }).n;
}

export interface DirectiveHit extends DirectiveRow {
  rrf: number;
  /** Cosine to the query, null when the meaning leg did not see this row. */
  similarity: number | null;
  matchedBy: 'meaning' | 'words' | 'both';
  /** Every topic word appears in the utterance. */
  allWords: boolean;
}
export interface HybridResult { hits: DirectiveHit[]; mode: 'hybrid' | 'keyword'; note: string | null }

function vectorOf(buf: Uint8Array): Float32Array {
  return buf.byteOffset % 4 === 0 ? new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) : new Float32Array(buf.slice().buffer);
}
const keyOf = (row: { source_file: string; line_no: number }) => `${row.source_file}\0${row.line_no}`;
/** Topic words for FTS — letters/digits runs of two or more characters. */
export function topicWords(query: string): string[] {
  return [...new Set((query.match(/[\p{L}\p{N}_]+/gu) ?? []).filter(word => word.length > 1))];
}

/** Meaning + words, fused by RRF. `pool` bounds each leg; `floor` drops meaning-only candidates below it. */
export async function hybridSearchDirectives(index: DirectiveIndex, query: string, filters: DirectiveFilters = {},
  opts: { embed?: EmbedFn | null; pool?: number; floor?: number } = {}): Promise<HybridResult> {
  const { cosine, RRF_K } = await import('../domains/knowledge.js');
  const { ftsQuery } = await import('../domains/surface-events.js');
  const pool = Math.max(1, Math.min(5000, opts.pool ?? 200));
  const floor = opts.floor ?? MEANING_FLOOR;
  const filter = index.filterClause(filters);
  const and = filter.where.length ? ` AND ${filter.where.join(' AND ')}` : '';
  const words = topicWords(query);

  let note: string | null = null;
  let meaning: Array<{ row: DirectiveRow; similarity: number }> = [];
  let mode: HybridResult['mode'] = 'hybrid';
  if (!opts.embed) { mode = 'keyword'; note = '의미 검색 꺼짐 — 키워드로만 찾음'; }
  else {
    try {
      const { vector, model } = await opts.embed(query);
      const rows = index.db.prepare(`SELECT d.*, v.vector AS vector FROM directive_vec v
        JOIN directives d ON d.source_file = v.source_file AND d.line_no = v.line_no WHERE v.model = ?${and}`)
        .all(model, ...filter.params) as Array<DirectiveRow & { vector: Uint8Array }>;
      if (!rows.length && !index.db.prepare('SELECT 1 FROM directive_vec WHERE model = ? LIMIT 1').get(model)) {
        mode = 'keyword'; note = `의미 색인 0건(${model}) — 키워드로만 찾음 · \`directives sync\` 가 채운다`;
      }
      meaning = rows.map(({ vector: buf, ...row }) => ({ row, similarity: cosine(vector, vectorOf(buf)) }))
        .filter(entry => entry.similarity >= floor)
        .sort((a, b) => b.similarity - a.similarity).slice(0, pool);
    } catch (error) {
      mode = 'keyword';
      note = `임베더 응답 없음(${error instanceof Error ? error.message.slice(0, 80) : 'error'}) — 키워드로만 찾음`;
    }
  }

  const byWords = (match: string) => index.db.prepare(`SELECT d.* FROM directive_fts
    JOIN directives d ON d.rowid = directive_fts.rowid WHERE directive_fts MATCH ?${and}
    ORDER BY bm25(directive_fts) LIMIT ?`).all(match, ...filter.params, pool) as DirectiveRow[];
  let keyword: DirectiveRow[] = [];
  const allWords = new Set<string>();
  if (words.length) {
    try {
      keyword = byWords(ftsQuery(words.join(' ')));
      for (const row of byWords(words.map(word => `"${word}"*`).join(' AND '))) allWords.add(keyOf(row));
    } catch { /* MATCH parse failure — meaning only */ }
  }

  const fused = new Map<string, DirectiveHit>();
  const bump = (row: DirectiveRow, rank: number, by: 'meaning' | 'words', similarity: number | null) => {
    const key = keyOf(row);
    const hit = fused.get(key) ?? { ...row, rrf: 0, similarity: null, matchedBy: by, allWords: allWords.has(key) };
    hit.rrf += 1 / (RRF_K + rank + 1);
    if (similarity !== null) hit.similarity = similarity;
    if (hit.matchedBy !== by) hit.matchedBy = 'both';
    fused.set(key, hit);
  };
  meaning.forEach((entry, rank) => bump(entry.row, rank, 'meaning', entry.similarity));
  keyword.forEach((row, rank) => bump(row, rank, 'words', null));
  return { hits: [...fused.values()].sort((a, b) => b.rrf - a.rrf), mode, note };
}

/** Stored vectors for the given rows (theme grouping). */
export function vectorsFor(index: DirectiveIndex, rows: readonly DirectiveRow[]): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  const get = index.db.prepare('SELECT vector FROM directive_vec WHERE source_file=? AND line_no=?');
  for (const row of rows) {
    const found = get.get(row.source_file, row.line_no) as { vector: Uint8Array } | null;
    if (found) out.set(keyOf(row), vectorOf(found.vector));
  }
  return out;
}
export { keyOf as directiveKey };
