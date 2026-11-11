import { expect, test } from 'bun:test';
import { createNexusBoardAdapter } from '../tui-client/nexus-board-adapter.js';
import { createFakeNexusBoardServer } from './fake-nexus-board-server.js';

test('TUI board adapter folds fake Nexus board responses and refreshes only for the verified member SSE event', async () => {
  const server = createFakeNexusBoardServer();
  const adapter = createNexusBoardAdapter({
    baseUrl: 'https://nexus.example.test/',
    accessToken: () => 'fake-member-token',
    fetchImpl: server.fetch,
  });

  const events = await adapter.read('member-a');
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    taskId: 'card-a', section: 'release', runId: '12345678',
    data: { title: '무대 앱', summary: '공개됨', status: 'done', resultUrl: 'https://demo.example.test' },
  });

  let refreshes = 0;
  const connectionOrder: string[] = [];
  await adapter.watch('member-a', new AbortController().signal, () => { refreshes++; connectionOrder.push('event'); }, () => { connectionOrder.push('ready'); });
  expect(refreshes).toBe(1);
  expect(connectionOrder[0]).toBe('ready');
  expect(server.requests().map((request) => request.path)).toEqual(['/v1/board', '/v1/events']);
  expect(server.requests().every((request) => request.authorization === 'Bearer fake-member-token')).toBe(true);
});

test('TUI board adapter fails closed without a member session and on a rejected board response', async () => {
  const anonymous = createNexusBoardAdapter({
    baseUrl: 'https://nexus.example.test', accessToken: () => undefined,
    fetchImpl: async () => Response.json({ cards: [] }),
  });
  await expect(anonymous.read('member-a')).rejects.toThrow('eln login');

  const rejected = createNexusBoardAdapter({
    baseUrl: 'https://nexus.example.test', accessToken: () => 'revoked',
    fetchImpl: async () => new Response(null, { status: 401 }),
  });
  await expect(rejected.read('member-a')).rejects.toThrow('HTTP 401');

  const malformedResponse = createNexusBoardAdapter({
    baseUrl: 'https://nexus.example.test', accessToken: () => 'fake-member-token',
    fetchImpl: async () => Response.json({ items: [] }),
  });
  await expect(malformedResponse.read('member-a')).rejects.toThrow('cards 배열이 필요합니다');

  const emptyBoard = createNexusBoardAdapter({
    baseUrl: 'https://nexus.example.test', accessToken: () => 'fake-member-token',
    fetchImpl: async () => Response.json({ cards: [] }),
  });
  await expect(emptyBoard.read('member-a')).resolves.toEqual([]);

  const malformedState = createNexusBoardAdapter({
    baseUrl: 'https://nexus.example.test', accessToken: () => 'fake-member-token',
    fetchImpl: async () => Response.json({ cards: [
      { id: 'bad-prototype', memberId: 'member-a', title: '잘못된 프로토타입 상태', state: 'toString' },
    ] }),
  });
  await expect(malformedState.read('member-a')).resolves.toEqual([]);

  expect(() => createNexusBoardAdapter({ baseUrl: 'http://nexus.example.test', accessToken: () => 'secret' }))
    .toThrow('requires HTTPS');
});
