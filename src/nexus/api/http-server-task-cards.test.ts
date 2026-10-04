import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../task-cards/card-store.js';
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
