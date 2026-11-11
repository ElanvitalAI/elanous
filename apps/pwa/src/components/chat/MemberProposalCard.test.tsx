import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, create } from 'react-test-renderer';
import { MemberProposalCard } from './MemberProposalCard';
import { createMemberMiniBoardApi } from '@/lib/member-mini-board-api';
import { handleBoardRoute, type BoardCardEvent, type BoardEventStore } from '../../../../../src/nexus/api/board-api';
import { createBoardApprovalDispatch } from '../../../../../plugins/absorb/handlers/board-approval';
import { loadKaistClassicPtyReceipt } from '../../../../../src/ux-sim/kaist-classic-pwa-replay-world';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('KAIST PWA chat OK posts once per proposal and keeps both graph acceptance IDs', async () => {
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
  const acceptedRunId = loadKaistClassicPtyReceipt().receipt.graphRun!.runId;
  const dispatched: Array<{ file: string; runId: string | undefined; suggestionId: unknown; memberId: unknown }> = [];
  const dispatchApproved = createBoardApprovalDispatch({
    appsRoot: root,
    createRunId: () => dispatched.length === 0 ? acceptedRunId : 'accept-kaist-test-2',
    runGraph: async (file, options = {}) => {
      const input = options.input as { suggestionId?: unknown; context?: { memberId?: unknown } } | undefined;
      dispatched.push({ file, runId: options.runId, suggestionId: input?.suggestionId,
        memberId: input?.context?.memberId });
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
    expect(dispatched).toHaveLength(0);

    await act(async () => { tree.root.findByType('button').props.onClick(); await Bun.sleep(0); });
    expect(requests.filter(request => request.method === 'POST')).toEqual([{
      path: '/v1/board/kaist-card/approve', method: 'POST', credentials: 'include',
    }]);
    expect(JSON.stringify(tree.toJSON())).toContain(acceptedRunId);
    expect(JSON.stringify(tree.toJSON())).toContain('다음 앱 제안');

    await act(async () => { tree.root.findByType('button').props.onClick(); await Bun.sleep(0); });
    expect(requests.filter(request => request.method === 'POST').map(request => request.path))
      .toEqual(['/v1/board/kaist-card/approve', '/v1/board/next-card/approve']);
    expect(dispatched).toEqual([
      { file: expect.stringContaining('absorb-build.yaml'), runId: acceptedRunId, suggestionId: 'kaist-card', memberId: 'member-a' },
      { file: expect.stringContaining('absorb-build.yaml'), runId: 'accept-kaist-test-2', suggestionId: 'next-card', memberId: 'member-a' },
    ]);
    expect(JSON.stringify(tree.toJSON())).toContain(acceptedRunId);
    expect(JSON.stringify(tree.toJSON())).toContain('accept-kaist-test-2');
    expect(events.filter(event => event.cardId === 'kaist-card').map(event => event.state)).toEqual(['suggested', 'approved']);
  } finally {
    if (tree) await act(async () => tree.unmount());
    rmSync(root, { recursive: true, force: true });
  }
});
