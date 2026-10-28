import type { Database } from 'bun:sqlite';
import { chunkReport, hybridQueryKnowledge, ingestText, type EmbedFn, type HybridMatch } from '../domains/knowledge.js';
import type { ReferenceCard } from './ref-index.js';

export interface ReferenceIngestOptions {
  embed: EmbedFn;
  maxChunks?: number;
}

export interface ReferenceQueryOptions {
  embed: EmbedFn;
  k?: number;
}

/** Keep the source ID and a real relative file path together in each returned citation. */
function sourceRef(id: string, file: string): string | null {
  if (!id || !file || file.startsWith('/') || /^[a-zA-Z]:/.test(file) || file.split(/[\\/]/).some((part) => part === '..' || part === '.')) return null;
  return `${id}#${file}`;
}

/** Index only card text whose original file is known; an invented README path must never become a citation. */
export async function ingestReferenceCard(
  db: Database,
  card: ReferenceCard,
  opts: ReferenceIngestOptions,
): Promise<{ ingested: number; truncated: boolean }> {
  const maxChunks = opts.maxChunks ?? 200;
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 0) throw new Error('reference maxChunks must be a nonnegative integer');
  const entries: Array<{ file: string; text: string }> = [];
  if (card.oneLine && card.oneLineFile) entries.push({ file: card.oneLineFile, text: card.oneLine });
  for (const title of card.titles) entries.push({ file: title.file, text: title.title });
  for (const command of card.commands) entries.push({ file: 'package.json', text: command });
  const chunks = entries.flatMap(({ file, text }) => {
    const ref = sourceRef(card.id, file);
    return ref ? chunkReport(text).map((chunk) => ({ ref, text: chunk })) : [];
  });
  let ingested = 0;
  const ts = card.receivedAt ?? new Date(0).toISOString();
  for (const [index, chunk] of chunks.slice(0, maxChunks).entries()) {
    if (await ingestText(db, {
      id: `reference:${card.id}:${index}`,
      ts,
      kind: 'reference',
      domain: 'elanous',
      text: chunk.text,
      source_ref: chunk.ref,
    }, opts.embed)) ingested++;
  }
  return { ingested, truncated: card.truncated || chunks.length > maxChunks };
}

/** Reuse the knowledge hybrid ranker, but never return a result without a source link. */
export async function queryReferences(
  db: Database,
  query: string,
  opts: ReferenceQueryOptions,
): Promise<HybridMatch[]> {
  const k = Math.min(Math.max(opts.k ?? 5, 1), 20);
  const matches = await hybridQueryKnowledge(db, query, { kind: 'reference', domain: 'elanous', k: 20, embed: opts.embed });
  return matches.filter((match) => !!match.source_ref).slice(0, k);
}
