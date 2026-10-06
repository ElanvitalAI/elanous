import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore, cardEventsPath } from '../../task-cards/card-store.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { startNexusHttpServer } from './http-server.js';

const originalStateDir = process.env.ELANOUS_STATE_DIR;
const roots: string[] = [];
afterEach(() => {
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('NEXUS routes authenticated GET task-cards list and detail without capturing /v1/tasks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-task-cards-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  const store = new CardStore(root);
  const card = store.createCard({ goalId: 'http-goal', title: 'HTTP card' });
  store.appendSection(card.id, { key: 'outcome', owner: 'steward', content: 'Delivered' });
  const expected = store.getCard(card.id);
  store.close();

  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const server = startNexusHttpServer({
    state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
    metaApi: { bearerToken: 'test-token', noAuth: false },
    startPort: 43000 + Math.floor(Math.random() * 2000),
  });
  const headers = { authorization: 'Bearer test-token', 'sec-fetch-site': 'cross-site' };
  try {
    const list = await fetch(`${server.url}/v1/task-cards`, { headers });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ cards: [expected] });

    const detail = await fetch(`${server.url}/v1/task-cards/${card.id}`, { headers });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual({ card: expected });

    for (const path of ['/v1/task-cards/missing', '/v1/task-cards/%2Fetc%2Fpasswd', '/v1/task-cards/extra/path']) {
      const response = await fetch(`${server.url}${path}`, { headers });
      expect(response.status).toBe(404);
    }
    for (const path of ['/v1/task-cards', `/v1/task-cards/${card.id}`]) {
      const unauthenticated = await fetch(`${server.url}${path}`, {
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(unauthenticated.status).toBe(401);
      expect(await unauthenticated.json()).toEqual({ error: 'unauthorized' });
      const write = await fetch(`${server.url}${path}`, { method: 'POST', headers, body: '{}' });
      expect(write.status).toBe(405);
    }
    for (const path of ['/v1/tasks', '/v1/tasks/missing']) {
      const tasks = await fetch(`${server.url}${path}`, { headers: { 'sec-fetch-site': 'cross-site' } });
      expect(tasks.status).toBe(401);
      expect(await tasks.json()).toEqual({ error: 'unauthorized' });
    }
  } finally {
    server.stop();
  }
});

test('owner closes a card with a persisted reason; a non-owner cannot close it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-card-close-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  const store = new CardStore(root);
  const card = store.createCard({ goalId: 'close-goal', title: 'Close me' });
  store.close();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const server = startNexusHttpServer({
    state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
    metaApi: { bearerToken: 'owner-token', noAuth: false },
    startPort: 43000 + Math.floor(Math.random() * 2000),
  });
  const url = `${server.url}/v1/task-cards/${card.id}/close`;
  try {
    const unauthorized = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer wrong', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ reason: 'not mine' }) });
    expect(unauthorized.status).toBe(401);
    const nonOwner = await fetch(url, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', origin: server.url }, body: JSON.stringify({ reason: 'not mine' }) });
    expect(nonOwner.status).toBe(403);
    expect(JSON.parse(readFileSync(cardEventsPath(card.id, root), 'utf8').trim().split('\n').at(-1)!)).not.toHaveProperty('type', 'closed');
    const ownerHeaders = { authorization: 'Bearer owner-token', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' };
    for (const badReason of ['', '  ', 'two\nlines']) {
      const bad = await fetch(url, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ reason: badReason }) });
      expect(bad.status).toBe(400);
    }
    const closed = await fetch(url, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ reason: '  완료  ' }) });
    expect(closed.status).toBe(200);
    expect((await closed.json() as { card: { status: string; closedReason: string } }).card).toMatchObject({ status: 'closed', closedReason: '완료' });
    const events = readFileSync(cardEventsPath(card.id, root), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string; reason?: string });
    expect(events.at(-1)).toMatchObject({ type: 'closed', reason: '완료' });
    const again = await fetch(url, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ reason: '다른 사유' }) });
    expect(again.status).toBe(200);
    expect(readFileSync(cardEventsPath(card.id, root), 'utf8').trim().split('\n')).toHaveLength(events.length);
    const detail = await fetch(`${server.url}/v1/task-cards/${card.id}`, { headers: { authorization: 'Bearer owner-token', 'sec-fetch-site': 'cross-site' } });
    expect((await detail.json() as { card: { status: string; closedReason: string } }).card).toMatchObject({ status: 'closed', closedReason: '완료' });
  } finally {
    server.stop();
  }
});
