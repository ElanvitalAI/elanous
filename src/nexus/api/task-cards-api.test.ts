import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore, cardEventsPath, taskCardsDir } from '../../task-cards/card-store.js';
import { handleTaskCardsGet } from './task-cards-api.js';

const roots: string[] = [];
function fixture(): { root: string; store: CardStore } {
  const root = mkdtempSync(join(tmpdir(), 'task-cards-api-'));
  roots.push(root);
  return { root, store: new CardStore(root) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function body(response: Response): Promise<unknown> {
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  return response.json();
}

test('GET /v1/task-cards lists the empty store and both open and closed cards', async () => {
  const { root, store } = fixture();
  const empty = handleTaskCardsGet('/v1/task-cards', root);
  expect(empty.status).toBe(200);
  expect(await body(empty)).toEqual({ cards: [] });

  const first = store.createCard({ goalId: 'goal-1', title: 'First' });
  const second = store.createCard({ goalId: 'goal-2', title: 'Second' });
  store.appendSection(first.id, { key: 'landing', owner: 'landing-loop', content: 'Passed' });
  store.closeCard(second.id);
  const expected = store.listCards();
  const before = new Map([first.id, second.id].map((id) => [id, readFileSync(cardEventsPath(id, root), 'utf8')]));
  store.close();

  const result = handleTaskCardsGet('/v1/task-cards', root);
  expect(result.status).toBe(200);
  expect(await body(result)).toEqual({ cards: expected });
  expect(expected.find((card) => card.id === first.id)?.sections).toMatchObject([
    { key: 'landing', owner: 'landing-loop', content: 'Passed' },
  ]);
  expect(expected.find((card) => card.id === second.id)?.status).toBe('closed');
  expect(readdirSync(taskCardsDir(root)).filter((file) => file.endsWith('.jsonl'))).toHaveLength(2);
  for (const [id, contents] of before) expect(readFileSync(cardEventsPath(id, root), 'utf8')).toBe(contents);
});

test('GET /v1/task-cards/:id returns full stored card, and misses or unsafe ids return 404 without creating events', async () => {
  const { root, store } = fixture();
  const created = store.createCard({ goalId: 'goal-detail', title: 'Detail' });
  const card = store.appendSection(created.id, { key: 'run', owner: 'executor', content: 'Done' });
  const before = readFileSync(cardEventsPath(card.id, root), 'utf8');
  store.close();

  const response = handleTaskCardsGet(`/v1/task-cards/${card.id}`, root);
  expect(response.status).toBe(200);
  expect(await body(response)).toEqual({ card });
  for (const path of ['/v1/task-cards/missing', '/v1/task-cards/%2E%2E', '/v1/task-cards/%2Fetc%2Fpasswd',
    '/v1/task-cards/%GG', '/v1/task-cards/extra/path', '/v1/tasks', '/v1/tasks/unknown']) {
    const missing = handleTaskCardsGet(path, root);
    expect(missing.status).toBe(404);
    expect(await body(missing)).toEqual({ error: 'not_found' });
  }
  expect(readFileSync(cardEventsPath(card.id, root), 'utf8')).toBe(before);
  expect(readdirSync(taskCardsDir(root)).filter((file) => file.endsWith('.jsonl'))).toEqual([`${card.id}.jsonl`]);
});
