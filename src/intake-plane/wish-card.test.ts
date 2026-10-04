import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../task-cards/card-store.js';
import { createNexusState } from '../nexus/state/state.js';
import { TabRegistry } from '../nexus/state/tab-registry.js';
import { NexusEventBus } from '../nexus/api/event-bus.js';
import { startNexusHttpServer } from '../nexus/api/http-server.js';
import { createWishCard } from './wish-card.js';

const roots: string[] = [];
const originalStateDir = process.env.ELANOUS_STATE_DIR;
afterEach(() => {
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('new Telegram wish creates the canonical card and intake section; retry and other sources stay distinct', () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-card-'));
  roots.push(root);
  const store = new CardStore(root);
  try {
    const text = `${'가'.repeat(85)}\n뒤의 본문`;
    const first = createWishCard({ text, source: 'telegram', ref: '42:7' }, store);
    expect(first).toEqual({ cardId: expect.any(String), title: '가'.repeat(80), created: true });
    const card = store.getCard(first.cardId)!;
    expect(card.goalId).toBe('wish:telegram:42:7');
    expect(card.sections).toHaveLength(1);
    expect(card.sections[0]).toMatchObject({ key: 'intake:wish:0', owner: 'steward' });
    expect(JSON.parse(card.sections[0]!.content)).toEqual({
      source: 'telegram', ref: '42:7', title: '가'.repeat(80), text, at: expect.any(String),
    });
    const second = createWishCard({ text: '다른 글', source: 'telegram', ref: '42:7' }, store);
    expect(second).toEqual({ cardId: first.cardId, title: first.title, created: false });
    expect(store.getCard(first.cardId)?.sections).toEqual(card.sections);
    expect(store.listCards()).toHaveLength(1);
    expect(createWishCard({ text: 'PWA 소원', source: 'pwa', ref: '42:7' }, store).created).toBe(true);
    expect(store.listCards()).toHaveLength(2);
  } finally { store.close(); }
});

test('TUI wish creates one card and one intake section across repeated requests with the same ref', () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-tui-'));
  roots.push(root);
  const store = new CardStore(root);
  try {
    const input = { text: 'TUI 소원\n자세한 내용', source: 'tui' as const, ref: 'session:7' };
    const first = createWishCard(input, store);
    expect(first).toEqual({ cardId: expect.any(String), title: 'TUI 소원', created: true });
    const card = store.getCard(first.cardId)!;
    expect(card.goalId).toBe('wish:tui:session:7');
    expect(card.sections).toHaveLength(1);
    expect(card.sections[0]).toMatchObject({ key: 'intake:wish:0', owner: 'steward' });
    expect(JSON.parse(card.sections[0]!.content)).toEqual({
      source: 'tui', ref: 'session:7', title: 'TUI 소원', text: input.text, at: expect.any(String),
    });
    const second = createWishCard(input, store);
    expect(second).toEqual({ cardId: first.cardId, title: first.title, created: false });
    expect(store.listCards()).toHaveLength(1);
    expect(store.getCard(first.cardId)?.sections).toEqual(card.sections);
  } finally { store.close(); }
});

test('retry restores a missing intake section after an interrupted create without duplicating the card', () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-retry-'));
  roots.push(root);
  const store = new CardStore(root);
  const input = { text: '중단된 소원', source: 'telegram' as const, ref: '42:interrupt' };
  const append = spyOn(store, 'appendSection').mockImplementationOnce(() => { throw new Error('interrupted'); });
  try {
    expect(() => createWishCard(input, store)).toThrow('interrupted');
    expect(store.listCards()).toHaveLength(1);
    expect(store.listCards()[0]?.sections).toHaveLength(0);
    append.mockRestore();
    const restartedStore = new CardStore(root);
    try {
      const result = createWishCard(input, restartedStore);
      expect(result).toMatchObject({ title: input.text, created: false });
      expect(restartedStore.listCards()).toHaveLength(1);
      expect(restartedStore.getCard(result.cardId)?.sections).toMatchObject([{ key: 'intake:wish:0', owner: 'steward' }]);
      expect(createWishCard(input, restartedStore)).toEqual(result);
      expect(restartedStore.getCard(result.cardId)?.sections).toHaveLength(1);
    } finally { restartedStore.close(); }
  } finally { append.mockRestore(); store.close(); }
});

test('a retry with the same ref but a different text keeps the first title and records no contradicting body (review must-fix)', () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-mismatch-'));
  roots.push(root);
  const store = new CardStore(root);
  const append = spyOn(store, 'appendSection').mockImplementationOnce(() => { throw new Error('interrupted'); });
  try {
    expect(() => createWishCard({ text: '첫 소원', source: 'telegram', ref: '42:same' }, store)).toThrow('interrupted');
    append.mockRestore();
    const result = createWishCard({ text: '다른 소원', source: 'telegram', ref: '42:same' }, store);
    expect(result).toMatchObject({ title: '첫 소원', created: false });
    const section = JSON.parse(store.getCard(result.cardId)!.sections[0]!.content) as Record<string, unknown>;
    expect(section).toMatchObject({ title: '첫 소원', text: null, recovered: true, mismatch: true });
    expect(JSON.stringify(section)).not.toContain('다른 소원');
  } finally { append.mockRestore(); store.close(); }
});

test('POST /v1/task-cards/wish requires owner auth and yields 201/200/400 while GET stays readable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-http-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const server = startNexusHttpServer({
    state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
    metaApi: { bearerToken: 'wish-token', noAuth: false },
    startPort: 47000 + Math.floor(Math.random() * 2000),
  });
  const headers = { authorization: 'Bearer wish-token', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' };
  const url = `${server.url}/v1/task-cards/wish`;
  try {
    const denied = await fetch(url, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ text: 'no', ref: 'no' }) });
    expect(denied.status).toBe(401);
    const post = (text: string, ref: string) => fetch(url, { method: 'POST', headers, body: JSON.stringify({ text, ref }) });
    const first = await post('새 소원', 's:123');
    expect(first.status).toBe(201);
    const card = await first.json() as { cardId: string; title: string; created: boolean };
    expect(card).toEqual({ cardId: expect.any(String), title: '새 소원', created: true });
    const retry = await post('다른 본문', 's:123');
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ...card, created: false });
    const empty = await post('   ', 's:124');
    expect(empty.status).toBe(400);
    expect((await fetch(`${server.url}/v1/task-cards`, { headers })).status).toBe(200);
    const store = new CardStore(root);
    try {
      expect(store.listCards()).toHaveLength(1);
      expect(store.getCard(card.cardId)?.goalId).toBe('wish:pwa:s:123');
    } finally { store.close(); }
  } finally { server.stop(); }
});

test('empty wish rejects without creating cards', () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-card-'));
  roots.push(root);
  const store = new CardStore(root);
  try {
    expect(() => createWishCard({ text: ' \n  ', source: 'pwa', ref: 'r' }, store)).toThrow();
    expect(store.listCards()).toHaveLength(0);
  } finally { store.close(); }
});
