import { expect, test } from 'bun:test';
import type { TaskCardEntry } from '../../apps/pwa/src/lib/task-card-model.js';
import { startMemberBoardFeed } from '../tui-client/mini-board-feed.js';
import { createNexusBoardAdapter } from '../tui-client/nexus-board-adapter.js';
import { createFakeNexusBoardServer } from './fake-nexus-board-server.js';

test('Nexus board snapshots and owned board.card events update the existing TUI journal projection', async () => {
  const server = createFakeNexusBoardServer({ lineEnding: '\r\n', advanceOnOwnEvent: true, autoEventOnConnect: false });
  const adapter = createNexusBoardAdapter({
    baseUrl: 'https://nexus.example.test', accessToken: () => 'fake-member-token', fetchImpl: server.fetch,
  });
  const received: TaskCardEntry[][] = [];
  const stop = startMemberBoardFeed({
    adapter,
    memberId: 'member-a',
    onEntries: (entries) => { received.push(entries); },
  });
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !(received.some((entries) => entries[0]?.data.status === 'testing') && server.eventConnections() >= 1 && server.requests().filter((request) => request.path === '/v1/board').length >= 2)) {
    await Bun.sleep(10);
  }
  expect(received.some((entries) => entries[0]?.data.status === 'testing')).toBe(true);
  const readsBeforeEvent = server.requests().filter((request) => request.path === '/v1/board').length;
  server.publishOwnedCard();
  const eventDeadline = Date.now() + 2_000;
  while (Date.now() < eventDeadline && !received.some((entries) => entries[0]?.data.status === 'done')) await Bun.sleep(10);
  stop();

  expect(received.some((entries) => entries.length === 1 && entries[0]?.taskId === 'card-a' && entries[0]?.data.status === 'done')).toBe(true);
  expect(server.requests().filter((request) => request.path === '/v1/board').length).toBeGreaterThan(readsBeforeEvent);
  // Source: #36170 fake Nexus SSE contract includes a member-owned event frame.
  expect(server.eventConnections()).toBeGreaterThanOrEqual(1);
});

test('TUI board projection receives its initial snapshot while SSE headers are stalled', async () => {
  const server = createFakeNexusBoardServer();
  const baseAdapter = createNexusBoardAdapter({
    baseUrl: 'https://nexus.example.test', accessToken: () => 'fake-member-token', fetchImpl: server.fetch,
  });
  let watchAttempts = 0;
  const adapter = {
    read: (memberId: string) => baseAdapter.read(memberId),
    watch: (_memberId: string, signal: AbortSignal) => {
      watchAttempts++;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
  };
  const received: TaskCardEntry[][] = [];
  const stop = startMemberBoardFeed({ adapter, memberId: 'member-a', onEntries: (entries) => { received.push(entries); }, sseConnectTimeoutMs: 25 });
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && (received.length === 0 || watchAttempts < 2)) await Bun.sleep(10);
  stop();
  // Source: #36170 initial GET /v1/board snapshot is independent of SSE headers.
  expect(received.length).toBeGreaterThanOrEqual(1);
  expect(received[0]?.[0]).toMatchObject({ taskId: 'card-a', data: { status: 'done' } });
  // Source: #36170 bounded SSE startup retries after the configured connect timeout.
  expect(watchAttempts).toBeGreaterThanOrEqual(2);
});
