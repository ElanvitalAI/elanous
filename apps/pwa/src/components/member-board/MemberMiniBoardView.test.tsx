import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemberMiniBoardScreen, MemberMiniBoardView } from './MemberMiniBoardView';
import { createMemberMiniBoardApi, type MemberMiniBoardApi } from '@/lib/member-mini-board-api';
import type { BriefingCard, MemberBoardCard } from './member-board-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card = (state: MemberBoardCard['state'], resultUrl?: string): MemberBoardCard => ({
  id: state, memberId: 'member-a', title: `카드 ${state}`, state, progress: '진행 상태', resultUrl, runId: 'run-12345678',
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushEffects() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('member mini board surface', () => {
  test('clears the previous member board until the next owner and data are both verified', async () => {
    const ownerB = deferred<{ memberId: string; appSlug: string }>();
    const boardB = deferred<unknown>();
    const briefingsB = deferred<unknown>();
    let ownerCalls = 0;
    let boardCalls = 0;
    let briefingCalls = 0;
    const api: MemberMiniBoardApi = {
      getVerifiedOwner: () => ++ownerCalls === 1
        ? Promise.resolve({ memberId: 'member-a', appSlug: 'app-a' }) : ownerB.promise,
      getBoard: () => ++boardCalls === 1
        ? Promise.resolve({ cards: [card('proposed')] }) : boardB.promise,
      getBriefings: () => ++briefingCalls === 1
        ? Promise.resolve({ briefings: [{ memberId: 'member-a', day: 'today', topics: [{ title: 'A private briefing' }] }] }) : briefingsB.promise,
      subscribe: () => () => {},
    };
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<MemberMiniBoardScreen api={api} />); await flushEffects(); });
    const rendered = () => JSON.stringify(tree.toJSON());
    expect(rendered()).toContain('카드 proposed');
    expect(rendered()).toContain('A private briefing');

    await act(async () => {
      tree.root.findAllByType('button')[0]!.props.onClick();
      await flushEffects();
    });
    expect(rendered()).toContain('회원 세션과 본인 앱 소유권을 확인하고 있습니다');
    expect(rendered()).not.toContain('카드 proposed');
    expect(rendered()).not.toContain('A private briefing');

    await act(async () => { ownerB.resolve({ memberId: 'member-b', appSlug: 'app-b' }); await flushEffects(); });
    expect(rendered()).not.toContain('카드 proposed');
    expect(rendered()).not.toContain('A private briefing');

    await act(async () => {
      boardB.resolve({ cards: [{ ...card('deployed', 'https://member-b.example.test'), memberId: 'member-b' }] });
      briefingsB.resolve({ briefings: [{ memberId: 'member-b', day: 'today', topics: [{ title: 'B private briefing' }] }] });
      await flushEffects();
    });
    expect(rendered()).toContain('카드 deployed');
    expect(rendered()).toContain('B private briefing');
    expect(rendered()).not.toContain('카드 proposed');
    await act(async () => tree.unmount());
  });

  test('simulates Nexus GET /v1/board through the member screen and hides other members', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      const path = new URL(url).pathname;
      if (path === '/v1/members') return Response.json({ member: { id: 'member-a' }, appSlot: { appSlug: 'lecture-scrap' } });
      if (path === '/v1/members/owner') return Response.json({ memberId: 'member-a', appSlug: 'lecture-scrap' });
      if (path === '/v1/board') return Response.json({ cards: [
        { id: 'task-a', memberId: 'member-a', title: '내 배포 카드', state: 'deployed', resultUrl: 'https://demo.example.test/member-a', updatedAt: '2026-11-09T08:00:00.000Z' },
        { id: 'task-b', memberId: 'member-b', title: '다른 회원 카드', state: 'proposed' },
      ] });
      if (path === '/v1/briefings') return Response.json({ briefings: [
        { id: 'brief-a', memberId: 'member-a', day: '2026-11-09', topics: [{ title: '내 브리핑' }] },
        { id: 'brief-b', memberId: 'member-b', day: '2026-11-09', topics: [{ title: '다른 회원 브리핑' }] },
      ] });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const api = createMemberMiniBoardApi('https://nexus.example.test/', fetchImpl, () => ({
      addEventListener() {}, close() {},
    }) as unknown as EventSource);
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<MemberMiniBoardScreen api={api} />); await flushEffects(); });

    const rendered = JSON.stringify(tree.toJSON());
    expect(rendered).toContain('내 배포 카드');
    expect(rendered).toContain('https://demo.example.test/member-a');
    expect(rendered).toContain('내 브리핑');
    expect(rendered).not.toContain('다른 회원 카드');
    expect(rendered).not.toContain('다른 회원 브리핑');
    const boardRequest = requests.find((request) => new URL(request.url).pathname === '/v1/board');
    expect(boardRequest).toBeDefined();
    expect(boardRequest?.init?.credentials).toBe('include');
    expect(new Headers(boardRequest?.init?.headers).has('authorization')).toBe(false);
    expect(requests.every((request) => request.init?.credentials === 'include')).toBe(true);
    await act(async () => tree.unmount());
  });

  test('renders five board columns, member briefing content and deployed result URL', () => {
    const briefing: BriefingCard = { id: 'brief-1', memberId: 'member-a', day: '2026-11-09', topics: [{ title: '강의 노트', summary: '핵심 내용' }], todos: ['앱 제안'] };
    const html = renderToStaticMarkup(<MemberMiniBoardView
      briefings={[briefing]}
      cards={[card('proposed'), card('approved'), card('developing'), card('testing'), { ...card('deployed'), publicUrl: 'https://demo.example.test' }]}
      refreshedAt="오후 4:00" loading={false} error={null} onRefresh={() => {}} />);
    for (const label of ['내 미니 보드', '제안', '승인', '개발 중', '시험', '배포됨', '오늘의 브리핑', '강의 노트', 'run 1234']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('https://demo.example.test');
    expect(html).toContain('href="/app/member/invite/"');
    expect(html).not.toContain('운영자 전용');
  });
});
