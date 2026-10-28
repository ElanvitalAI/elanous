import { test, expect } from 'bun:test';
import { openKnowledgeDb, ingestText, type EmbedFn } from '../domains/knowledge.js';
import { ingestReferenceCard, queryReferences } from './ref-vector.js';
import type { ReferenceCard } from './ref-index.js';

const embed: EmbedFn = async (text) => ({ vector: new Float32Array([text.includes('배포') ? 1 : 0, 1]), model: 'test-reference' });

const card: ReferenceCard = {
  id: 'source-A', kind: 'local-repo', orchestrationId: 'local-repo:source-A', name: 'alpha', oneLine: '배포 안내', oneLineFile: 'README.md',
  directories: [], titles: [{ file: 'docs/deploy.md', title: '배포 절차' }], commands: ['bun test'],
  receivedAt: '2026-10-28T00:00:00.000Z', truncated: false,
};

test('reference card text is searchable with its source ID and real relative file path', async () => {
  const db = openKnowledgeDb(':memory:');
  try {
    expect(await ingestReferenceCard(db, card, { embed })).toEqual({ ingested: 3, truncated: false });
    const matches = await queryReferences(db, '배포', { embed });
    expect(matches.some((m) => m.source_ref === 'source-A#README.md')).toBe(true);
    expect(matches.some((m) => m.source_ref === 'source-A#docs/deploy.md')).toBe(true);
    expect(await ingestReferenceCard(db, card, { embed })).toEqual({ ingested: 0, truncated: false });
  } finally { db.close(); }
});

test('chunk cap reports truncation and ungrounded text is not indexed', async () => {
  const db = openKnowledgeDb(':memory:');
  try {
    expect(await ingestReferenceCard(db, { ...card, oneLineFile: undefined }, { embed, maxChunks: 1 }))
      .toEqual({ ingested: 1, truncated: true });
    const rows = db.prepare('SELECT source_ref FROM docs').all() as Array<{ source_ref: string }>;
    expect(rows).toEqual([{ source_ref: 'source-A#docs/deploy.md' }]);
    await ingestText(db, { id: 'reference:orphan', ts: card.receivedAt!, kind: 'reference', domain: 'elanous', text: '배포', source_ref: null }, embed);
    expect((await queryReferences(db, '배포', { embed })).every((m) => m.source_ref !== null)).toBe(true);
  } finally { db.close(); }
});
