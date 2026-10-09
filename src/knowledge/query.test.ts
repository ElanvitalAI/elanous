import { expect, test } from 'bun:test';
import { createPack } from './kgs/pack.js';
import { KgsSqliteStore } from './kgs/sqlite-store.js';
import type { KnowledgeCard } from './kgs/types.js';
import { listInstalledPacks, queryInstalledPack } from './query.js';

const at = '2026-10-01T00:00:00Z';
const card: KnowledgeCard = {
  schema_version: 2, kind: 'card', id: 'card:1234', title: '식각 온도', body: '식각 온도는 40도',
  createdAt: at, updatedAt: at, author: 'test', nature: 'fact', reliability: 'verified',
  source: { kind: 'manual' }, tags: [],
};

test('only installed pack ids are offered and each query searches that pack index, with citations and ranking', () => {
  const store = new KgsSqliteStore(':memory:');
  try {
    store.writePack(createPack({ id: { slug: 'fab-knowledge', version: '1.0.0' }, title: '공정', intent: '식각',
      audience: 'team', kind: 'generic', author: 'test', cards: [
        card, { ...card, id: 'card:2345', title: '온도', body: '온도는 50도' },
      ] }));
    store.writePack(createPack({ id: { slug: 'other-pack', version: '1.0.0' }, title: '영업', intent: '영업',
      audience: 'team', kind: 'research-bundle', author: 'test', cards: [{ ...card, id: 'card:3456', body: '온도는 99도' }] }));
    expect(listInstalledPacks(store)).toEqual([
      { id: 'pack:other-pack@1.0.0', title: '영업' },
      { id: 'pack:fab-knowledge@1.0.0', title: '공정' },
    ]);
    const hits = queryInstalledPack('pack:fab-knowledge@1.0.0', '식각 온도', store);
    expect(hits.map(hit => hit.id)).toEqual(['card:1234', 'card:2345']);
    expect(hits[0]).toMatchObject({ body: '식각 온도는 40도', ref: 'pack:fab-knowledge@1.0.0#card:1234' });
    expect(hits.some(hit => hit.body.includes('99도'))).toBe(false);
    expect(queryInstalledPack('pack:fab-knowledge@1.0.0', '없는 지식', store)).toEqual([]);
    expect(() => queryInstalledPack('pack:missing-pack@1.0.0', '온도', store)).toThrow('pack not installed');
  } finally { store.close(); }
});
