import { expect, test } from 'bun:test';
import { createNexusBoardAdapter } from '../tui-client/nexus-board-adapter.js';
import { formatTuiMiniBoardCard, projectTuiMiniBoard, renderTuiMiniBoard } from '../tui-client/mini-board-projection.js';
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
    taskId: 'card-a', section: 'release', runId: 'run-12345678',
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

test('Scene 6 NEXT board retains verified diagram and PDF links from the owned card', async () => {
  const sha256 = 'a'.repeat(64);
  const adapter = createNexusBoardAdapter({
    baseUrl: 'https://nexus.example.test', accessToken: () => 'fake-member-token',
    fetchImpl: async () => Response.json({ cards: [
      { id: 'foreign', memberId: 'member-b', title: '비공개', state: 'deployed', attachments: [{ kind: 'pdf', title: 'secret', url: 'https://private.example.test/', sha256 }] },
      { id: 'scene-6', memberId: 'member-a', title: '티켓팅 MVP', state: 'deployed', updatedAt: '2026-11-11T00:00:00.000Z', attachments: [
        { kind: 'diagram', title: '아키텍처', url: 'https://demo.example.test/diagram.svg', sha256 },
        { kind: 'pdf', title: '설계 보고서', url: 'https://demo.example.test/report.pdf', sha256 },
        { kind: 'html', title: 'unsafe', url: 'http://demo.example.test/page', sha256 },
      ] },
    ] }),
  });
  const entries = await adapter.read('member-a');
  expect(entries).toHaveLength(1);
  expect(entries[0]?.data.attachments).toEqual([
    { kind: 'diagram', title: '아키텍처', url: 'https://demo.example.test/diagram.svg', sha256 },
    { kind: 'pdf', title: '설계 보고서', url: 'https://demo.example.test/report.pdf', sha256 },
  ]);
});

test('Scene 6 board strips OSC, ANSI and C1 controls from member-authored terminal text', async () => {
  const adapter = createNexusBoardAdapter({
    baseUrl: 'https://nexus.example.test', accessToken: () => 'fake-member-token',
    fetchImpl: async () => Response.json({ cards: [{
      id: 'scene-6', memberId: 'member-a', state: 'deployed', runId: 'run-safe-board',
      title: '제안\u001b]8;;https://evil.example\u0007앱\u001b]8;;\u001b\\',
      summary: '진행\u001b[2J\u009b31m\u000a완료',
      attachments: [{ kind: 'pdf', title: '설계\u001b]0;hijack\u0007 PDF\u001b[31m\u009d2;noise\u009c',
        url: 'https://demo.example.test/design.pdf', sha256: 'a'.repeat(64) }],
    }] }),
  });
  const entries = await adapter.read('member-a');
  const board = projectTuiMiniBoard(entries);
  const card = board.columns.find(column => column.id === 'done')?.cards[0];
  expect(card).toBeDefined();
  const lines = [formatTuiMiniBoardCard(card!), ...renderTuiMiniBoard(board, 60), ...renderTuiMiniBoard(board, 120)];
  const output = lines.join('\n');
  expect(output).toContain('제안앱');
  expect(output).toContain('진행완료');
  expect(output).toContain('설계 PDF');
  expect(output).toContain('https://demo.example.test/design.pdf');
  expect(lines.every(line => !/[\u0000-\u001f\u007f-\u009f]/u.test(line))).toBe(true);
  expect(output).not.toContain('hijack');
  expect(output).not.toContain('https://evil.example');
  expect(output).not.toContain('[2J');
  expect(output).not.toContain('31m');
});
