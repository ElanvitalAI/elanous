import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPack } from './kgs/pack.js';
import { KgsSqliteStore } from './kgs/sqlite-store.js';
import type { KnowledgeCard } from './kgs/types.js';
import { dispatchKnowledgeQuery } from './tools/knowledge-query.js';
import type { ObsidianVault } from '../auto-research/obsidian-bridge.js';
import { listInstalledPacks, queryInstalledPack, resolveInstalledKnowledgePack, selectInstalledKnowledgePack } from './query.js';

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
    expect(queryInstalledPack('pack:fab-knowledge@1.0.0', '설계해줘', store)).toEqual([]);
    expect(() => queryInstalledPack('pack:missing-pack@1.0.0', '온도', store)).toThrow('pack not installed');
  } finally { store.close(); }
});

test('Korean design questions match installed pack metadata after stacked particles and dispatch through the pack', async () => {
  const store = new KgsSqliteStore(':memory:');
  try {
    store.writePack(createPack({ id: { slug: 'concert-ticketing', version: '1.0.0' }, title: '콘서트 예매', intent: '티켓팅',
      audience: 'team', kind: 'research-bundle', author: 'test', tags: ['티켓팅'], cards: [card] }));
    const expected = { id: 'pack:concert-ticketing@1.0.0', title: '콘서트 예매' };
    for (const question of ['티켓팅을 설계해줘.', '티켓팅은 어떻게 설계해?', '티켓팅에서는 좌석 예매를 어떻게 해?', '티켓팅에도 적용할 설계를 해줘']) {
      expect(selectInstalledKnowledgePack(question, store)).toEqual(expected);
    }
    const question = '티켓팅에도 적용할 설계를 해줘';
    const result = await dispatchKnowledgeQuery({ question }, {
      selectPack: query => selectInstalledKnowledgePack(query, store),
      searchPack: (packId, query) => [{ ...card, id: 'card:ticketing', title: '티켓팅 좌석 배정',
        body: `적용 질문: ${query}`, ref: `${packId}#card:ticketing` }],
    });
    expect(result.selectedPack).toEqual(expected);
    expect(result.pack_hits?.[0]?.ref).toBe('pack:concert-ticketing@1.0.0#card:ticketing');
  } finally { store.close(); }
});

test('ambiguity asks about the top two equally ranked packs even when a third tied pack has different intent tags', async () => {
  const store = new KgsSqliteStore(':memory:');
  try {
    const makePack = (slug: string, title: string, tags: string[]) => createPack({
      id: { slug, version: '1.0.0' }, title, intent: '콘서트 티켓팅 예약 설계',
      audience: 'team', kind: 'research-bundle', author: 'test', tags, cards: [],
    });
    store.writePack(makePack('a-first', 'Concert Ticketing A', ['콘서트', '티켓팅']));
    store.writePack(makePack('b-second', 'Concert Ticketing B', ['콘서트', '티켓팅']));
    store.writePack(makePack('c-third', 'Concert Ticketing C', ['콘서트', '결제']));

    const decision = resolveInstalledKnowledgePack('콘서트 티켓팅', store);
    expect(decision).toMatchObject({ kind: 'ambiguous', intentTags: ['콘서트', '티켓팅'] });
    if (decision.kind !== 'ambiguous') throw new Error('expected an ambiguous top-two decision');
    expect(decision.candidates.map(candidate => candidate.id)).toEqual([
      'pack:a-first@1.0.0', 'pack:b-second@1.0.0',
    ]);
    const result = await dispatchKnowledgeQuery({ question: '콘서트 티켓팅' }, {
      resolvePack: question => resolveInstalledKnowledgePack(question, store),
      vault: { root: '/__knowledge-query-ambiguity__', isSimulated: true, label: 'simulation' },
    });
    expect(result.selectionQuestion).toBe('어느 지식 팩을 사용할까요? Concert Ticketing A / Concert Ticketing B 중에서 선택해 주세요.');
    expect(result.selectionQuestion).not.toContain('c-third');
    expect(result.notices).toBeUndefined();
  } finally { store.close(); }
});

test('a generic 설계해 expression alone falls back to the vault instead of selecting an unrelated pack', async () => {
  const store = new KgsSqliteStore(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'knowledge-query-korean-generic-design-'));
  try {
    store.writePack(createPack({ id: { slug: 'payment-design', version: '1.0.0' }, title: '결제 설계해',
      intent: '결제 설계해', audience: 'team', kind: 'generic', author: 'test', cards: [card] }));
    mkdirSync(join(root, 'Notes'), { recursive: true });
    writeFileSync(join(root, 'Notes', 'ticketing.md'), '---\ntitle: Ticketing\n---\nVault ticketing guidance.\n');
    const question = '티켓팅 시스템을 설계해';

    expect(selectInstalledKnowledgePack(question, store)).toBeNull();
    const result = await dispatchKnowledgeQuery({ question }, {
      resolvePack: text => resolveInstalledKnowledgePack(text, store),
      vault: { root, isSimulated: true, label: 'fixture' },
    });
    expect(result.selectedPack).toBeUndefined();
    expect(result.results.map(note => note.relPath)).toEqual(['Notes/ticketing.md']);
    expect(result.results[0]?.excerpt).toContain('Vault ticketing guidance.');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('generic 설계하 and 방법 overlap cannot select a different topic pack and dispatch falls back to the vault', async () => {
  const store = new KgsSqliteStore(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'knowledge-query-korean-generic-method-'));
  try {
    store.writePack(createPack({ id: { slug: 'payment-design-method', version: '1.0.0' }, title: '결제를 설계하는 방법',
      intent: '결제를 설계하는 방법', audience: 'team', kind: 'generic', author: 'test', cards: [card] }));
    mkdirSync(join(root, 'Notes'), { recursive: true });
    writeFileSync(join(root, 'Notes', 'ticketing.md'), '---\ntitle: Ticketing\n---\nVault ticketing guidance.\n');
    const vault: ObsidianVault = { root, isSimulated: true, label: 'fixture' };
    const question = '티켓팅을 설계하는 방법';

    expect(resolveInstalledKnowledgePack(question, store)).toEqual({ kind: 'none' });
    const result = await dispatchKnowledgeQuery({ question }, {
      resolvePack: text => resolveInstalledKnowledgePack(text, store),
      vault,
    });
    expect(result.selectedPack).toBeUndefined();
    expect(result.pack_hits).toBeUndefined();
    expect(result.results.map(note => note.relPath)).toEqual(['Notes/ticketing.md']);
    expect(result.results[0]?.excerpt).toContain('Vault ticketing guidance.');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('generic English question words do not select an unrelated pack and dispatch falls back to the vault', async () => {
  const store = new KgsSqliteStore(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'knowledge-query-vault-fallback-'));
  try {
    store.writePack(createPack({ id: { slug: 'database-design', version: '1.0.0' }, title: 'How to design a database system',
      intent: 'How to design a database system', audience: 'team', kind: 'generic', author: 'test', cards: [card] }));
    mkdirSync(join(root, 'Notes'), { recursive: true });
    writeFileSync(join(root, 'Notes', 'payment.md'), '---\ntitle: Payment recovery\n---\nVault payment answer.\n');
    const vault: ObsidianVault = { root, isSimulated: true, label: 'fixture' };
    const question = 'how do I design a payment system';

    expect(selectInstalledKnowledgePack(question, store)).toBeNull();
    const result = await dispatchKnowledgeQuery({ question }, {
      vault,
      selectPack: query => selectInstalledKnowledgePack(query, store),
      searchPack: (packId, query) => queryInstalledPack(packId, query, store),
    });

    expect(result.pack_hits).toBeUndefined();
    expect(result.results.map(note => note.relPath)).toEqual(['Notes/payment.md']);
    expect(result.results[0]?.excerpt).toContain('Vault payment answer.');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('generic please/service overlap cannot select an unrelated pack and dispatch falls back to the vault', async () => {
  const store = new KgsSqliteStore(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'knowledge-query-generic-words-'));
  try {
    store.writePack(createPack({ id: { slug: 'database-service', version: '1.0.0' }, title: 'Please design a database service',
      intent: 'Please design a database service', audience: 'team', kind: 'generic', author: 'test', cards: [card] }));
    mkdirSync(join(root, 'Notes'), { recursive: true });
    writeFileSync(join(root, 'Notes', 'payment.md'), '---\ntitle: Payment service\n---\nVault payment service answer.\n');
    const vault: ObsidianVault = { root, isSimulated: true, label: 'fixture' };
    const question = 'please design a payment service';

    expect(selectInstalledKnowledgePack(question, store)).toBeNull();
    const result = await dispatchKnowledgeQuery({ question }, {
      vault,
      selectPack: query => selectInstalledKnowledgePack(query, store),
      searchPack: (packId, query) => queryInstalledPack(packId, query, store),
    });

    expect(result.selectedPack).toBeUndefined();
    expect(result.pack_hits).toBeUndefined();
    expect(result.results.map(note => note.relPath)).toEqual(['Notes/payment.md']);
    expect(result.results[0]?.excerpt).toContain('Vault payment service answer.');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('generic Korean question word overlap cannot select an unrelated pack and dispatch falls back to the vault', async () => {
  const store = new KgsSqliteStore(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'knowledge-query-korean-question-word-'));
  try {
    store.writePack(createPack({ id: { slug: 'payment-design', version: '1.0.0' }, title: '결제를 어떻게 설계할까',
      intent: '결제를 어떻게 설계할까', audience: 'team', kind: 'generic', author: 'test', cards: [card] }));
    mkdirSync(join(root, 'Notes'), { recursive: true });
    writeFileSync(join(root, 'Notes', 'ticketing.md'), '---\ntitle: Ticketing design\n---\nVault ticketing answer.\n');
    const vault: ObsidianVault = { root, isSimulated: true, label: 'fixture' };
    const question = '티켓팅을 어떻게 설계해?';

    expect(selectInstalledKnowledgePack(question, store)).toBeNull();
    const result = await dispatchKnowledgeQuery({ question }, {
      vault,
      selectPack: query => selectInstalledKnowledgePack(query, store),
      searchPack: (packId, query) => queryInstalledPack(packId, query, store),
    });

    expect(result.selectedPack).toBeUndefined();
    expect(result.pack_hits).toBeUndefined();
    expect(result.results.map(note => note.relPath)).toEqual(['Notes/ticketing.md']);
    expect(result.results[0]?.excerpt).toContain('Vault ticketing answer.');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
