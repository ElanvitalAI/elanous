import { expect, test } from 'bun:test';
import { startMemberBoardFeed } from './mini-board-feed.js';
import { createNexusBoardAdapter } from './nexus-board-adapter.js';
import { projectTuiMiniBoard, renderTuiMiniBoard } from './mini-board-projection.js';

test('Scene 6 NEXT board follows owned development, testing and deployed cards with diagram and PDF', async () => {
  const owner = 'member-kcb';
  const token = 'fake-member-token';
  const sha256 = 'a'.repeat(64);
  const states = ['developing', 'testing', 'deployed'] as const;
  let step = 0;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const requests: string[] = [];
  const adapter = createNexusBoardAdapter({
    baseUrl: 'https://nexus.example.test', accessToken: () => token,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      if (url.pathname === '/v1/events') {
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }),
          { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.pathname !== '/v1/board') return new Response(null, { status: 404 });
      return Response.json({ cards: [
        { id: 'foreign', memberId: 'member-other', title: 'private', state: 'deployed' },
        { id: 'kcb-ticket', memberId: owner, title: '티켓팅 MVP', state: states[step],
          updatedAt: `2026-11-11T00:00:0${step}.000Z`,
          ...(step === 2 ? { attachments: [
            { kind: 'diagram', title: '아키텍처', url: 'https://demo.example.test/diagram.svg', sha256 },
            { kind: 'pdf', title: '설계 보고서', url: 'https://demo.example.test/report.pdf', sha256 },
          ] } : {}),
        },
      ] });
    },
  });
  const screens: string[] = [];
  const stop = startMemberBoardFeed({ adapter, memberId: owner, onEntries: (entries) => {
    screens.push(renderTuiMiniBoard(projectTuiMiniBoard(entries, 0), 100).join('\n'));
  } });
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !predicate()) await Bun.sleep(10);
    expect(predicate()).toBe(true);
  };
  const publish = () => stream?.enqueue(new TextEncoder().encode(
    `event: board.card\ndata: {"card":{"id":"kcb-ticket","memberId":"${owner}","title":"티켓팅 MVP","state":"${states[step]}"}}\n\n`));
  try {
    await until(() => screens.some(screen => screen.includes('개발 중(1)')) && !!stream);
    step = 1;
    publish();
    await until(() => screens.some(screen => screen.includes('시험(1)')));
    step = 2;
    publish();
    await until(() => screens.some(screen => screen.includes('배포됨(1)') && screen.includes('설계 보고서')));
    const deployed = screens.at(-1)!.replace(/\s+/g, '');
    expect(deployed).toContain('https://demo.example.test/diagram.svg');
    expect(deployed).toContain('https://demo.example.test/report.pdf');
    expect(deployed).not.toContain('private');
    expect(requests).toContain('/v1/board');
  } finally {
    stop();
  }
});
