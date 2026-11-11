import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemberProposalCard } from './MemberProposalCard';
import { MemberMiniBoardView } from '../member-board/MemberMiniBoardView';
import { createMemberMiniBoardApi } from '@/lib/member-mini-board-api';
import { handleBoardRoute, type BoardCardEvent, type BoardEventStore } from '../../../../../src/nexus/api/board-api';
import { createBoardApprovalDispatch } from '../../../../../plugins/absorb/handlers/board-approval';
import { runAbsorbGraphSimulation } from '../../../../../src/ux-sim/absorb-v2-runGraph-sim';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('KAIST test world: chat OK → approved → harness run/test → owner mini board', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pwa-kaist-approval-'));
  mkdirSync(join(root, 'kaist-app'));
  const events: BoardCardEvent[] = [
    { type: 'board.card', cardId: 'kaist-card', memberId: 'member-a', title: 'KAIST 강의 노트', state: 'suggested', at: '2026-11-09T00:00:00.000Z' },
    { type: 'board.card', cardId: 'next-card', memberId: 'member-a', title: '다음 앱 제안', state: 'suggested', at: '2026-11-08T00:00:00.000Z' },
    { type: 'board.card', cardId: 'other', memberId: 'member-b', title: '다른 회원 제안', state: 'suggested', at: '2026-11-09T00:00:00.000Z' },
  ];
  const store: BoardEventStore = {
    query: async ({ memberId }) => events.filter(event => event.memberId === memberId),
    append: async event => { events.push(event as BoardCardEvent); },
  };
  let starts = 0;
  let graphRun: Promise<unknown> | undefined;
  const dispatchApproved = createBoardApprovalDispatch({
    appsRoot: root,
    createRunId: () => `accept-kaist-test-${starts + 1}`,
    runGraph: async (file, options) => {
      expect(file).toContain('absorb-build.yaml');
      expect(options.input).toMatchObject({ suggestionId: starts === 0 ? 'kaist-card' : 'next-card', context: { memberId: 'member-a', appRef: 'kaist-app' } });
      starts += 1;
      if (starts === 1) {
        graphRun = runAbsorbGraphSimulation({ confirmation: 'y', approvalRunId: options.runId, onAcceptedBuild: async state => {
          expect(state.status).toBe('done');
          expect(state.path).toEqual(expect.arrayContaining(['build', 'simulate', 'publish']));
          const graphAttachment = { kind: 'diagram' as const, title: 'KAIST 흐름도', url: 'https://example.test/kaist.svg', mime: 'image/svg+xml', sha256: 'b'.repeat(64), producedBy: 'absorb-build' };
          await store.append({ ...events[0]!, state: 'building', runId: state.runId, at: '2026-11-09T00:02:00.000Z' });
          await store.append({ ...events[0]!, state: 'testing', runId: state.runId, summary: '그래프 시험 진행', at: '2026-11-09T00:03:00.000Z' });
          await store.append({ ...events[0]!, state: 'released', runId: state.runId, summary: '가짜 그래프 발행 완료', attachments: [graphAttachment],
            result: { publicUrl: 'https://lecture-scrap-demo.app.sim.invalid/' }, at: '2026-11-09T00:04:00.000Z' });
        } });
        await graphRun;
      }
      return { status: 'done' } as never;
    },
  });
  const requests: Array<{ path: string; method: string; credentials?: RequestCredentials }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, method: init?.method ?? 'GET', credentials: init?.credentials });
    if (init?.credentials !== 'include') return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (url.pathname === '/v1/members') return Response.json({ member: { id: 'member-a' }, appSlot: { appSlug: 'kaist-app' } });
    if (url.pathname === '/v1/members/owner') return Response.json({ memberId: 'member-a' });
    const request = new Request(url, { ...init, headers: {
      ...Object.fromEntries(new Headers(init?.headers).entries()), cookie: 'member-session=valid', origin: url.origin, 'sec-fetch-site': 'same-origin',
    } });
    return await handleBoardRoute(request, url.pathname, {
      store,
      resolveOwner: async () => ({ memberId: 'member-a', appSlug: 'kaist-app' }),
      dispatchApproved,
    }) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  const api = createMemberMiniBoardApi('https://nexus.example.test', fetchImpl, () => ({ addEventListener() {}, close() {} }));
  let tree!: ReturnType<typeof create>;
  try {
    await act(async () => { tree = create(<MemberProposalCard api={api} />); await Bun.sleep(0); });
    expect(JSON.stringify(tree.toJSON())).toContain('KAIST 강의 노트');
    expect(JSON.stringify(tree.toJSON())).not.toContain('다른 회원 제안');
    expect(starts).toBe(0);

    await act(async () => { tree.root.findByType('button').props.onClick(); await Bun.sleep(0); });
    expect(requests.filter(request => request.method === 'POST')).toEqual([{
      path: '/v1/board/kaist-card/approve', method: 'POST', credentials: 'include',
    }]);
    expect(starts).toBe(1);
    expect(JSON.stringify(tree.toJSON())).toContain('accept-kaist-test-1');
    expect(JSON.stringify(tree.toJSON())).toContain('/board');
    expect(JSON.stringify(tree.toJSON())).toContain('다음 앱 제안');
    expect(graphRun).toBeDefined();
    await graphRun;
    await act(async () => { tree.root.findByType('button').props.onClick(); await Bun.sleep(0); });
    expect(starts).toBe(2);
    expect(JSON.stringify(tree.toJSON())).toContain('accept-kaist-test-1');
    expect(JSON.stringify(tree.toJSON())).toContain('accept-kaist-test-2');

    expect(events.filter(event => event.cardId === 'kaist-card').map(event => event.state))
      .toEqual(['suggested', 'approved', 'building', 'testing', 'released']);
    const board = await api.getBoard() as { cards: Array<{ id: string; memberId: string; title: string; state: 'deployed'; summary: string; runId: string; publicUrl?: string }> };
    const kaistCard = board.cards.find(card => card.id === 'kaist-card');
    expect(kaistCard).toMatchObject({ id: 'kaist-card', state: 'deployed', runId: 'accept-kaist-test-1' });
    expect(kaistCard?.publicUrl).toBe('https://lecture-scrap-demo.app.sim.invalid/');
    const html = renderToStaticMarkup(<MemberMiniBoardView briefings={[]} cards={board.cards}
      refreshedAt={null} loading={false} error={null} onRefresh={() => undefined} />);
    expect(html).toContain('KAIST 강의 노트');
    expect(html).toContain('가짜 그래프 발행 완료');
    expect(html).toContain('KAIST 흐름도');
    console.log('PWA_KAIST_TEST_RECEIPT', JSON.stringify({
      fixtureId: 'pwa-kaist-approval-world-1', acceptanceId: 'accept-kaist-test-1', runId: 'accept-kaist-test-1',
      boardState: kaistCard?.state, publicUrl: kaistCard?.publicUrl, scope: 'test-world',
    }));
  } finally {
    if (tree) await act(async () => tree.unmount());
    rmSync(root, { recursive: true, force: true });
  }
});
