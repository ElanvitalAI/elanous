import { expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { createElement } from 'react';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import ScrapsPage from './page';

const daemon = { config: { baseUrl: 'https://nexus.example.test', token: '', provider: '' },
  client: {}, sessionId: 'member-session', setConfig: () => {}, setSessionId: () => {} };

test('Scene 1 member opens the saved article from the PWA consumer', async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const previousAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  const requests: Array<{ url: string; credentials?: RequestCredentials }> = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, { window: { location: { search: '?selected=article-1' } } });
  globalThis.fetch = (async (input: URL, init?: RequestInit) => {
    requests.push({ url: String(input), credentials: init?.credentials });
    return Response.json({ scraps: [{ id: 'article-1', kind: 'web', status: 'absorbed',
      raw: { url: 'https://news.example.test/tickets', text: '축제·콘서트 티켓 대란' } }] });
  }) as typeof fetch;
  let tree: ReturnType<typeof create> | null = null;
  try {
    await act(async () => { tree = create(createElement(DaemonContext.Provider, { value: daemon as never }, createElement(ScrapsPage))); });
    expect(requests).toEqual([{ url: 'https://nexus.example.test/v1/scraps', credentials: 'include' }]);
    const anchors = tree!.root.findAllByType('a');
    expect(anchors.some((node) => node.props.href === 'https://news.example.test/tickets' && node.props.target === '_blank')).toBe(true);
    expect(tree!.root.findByProps({ 'data-scrap-id': 'article-1' }).props['data-scrap-id']).toBe('article-1');
    expect(tree!.root.findByProps({ 'data-scrap-id': 'article-1' }).props['aria-current']).toBe('true');
    expect(JSON.stringify(tree!.toJSON())).toContain('선택한 스크랩');
    expect(JSON.stringify(tree!.toJSON())).toContain('축제·콘서트 티켓 대란');
    expect(anchors.find((node) => node.props.href === 'https://news.example.test/tickets')?.children.join('')).toBe('출처: news.example.test');
    expect(JSON.stringify(tree!.toJSON())).toContain('흡수됨');
    await act(async () => tree!.update(createElement(DaemonContext.Provider,
      { value: { ...daemon, sessionId: null } as never }, createElement(ScrapsPage))));
    expect(tree!.root.findAllByProps({ 'data-scrap-id': 'article-1' })).toHaveLength(0);
    expect(tree!.root.findByProps({ role: 'alert' }).children.join('')).toBe('회원 로그인이 필요합니다.');
  } finally {
    if (tree) await act(async () => tree!.unmount());
    globalThis.fetch = previousFetch;
    Object.assign(globalThis, { window: previousWindow });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

test('member authorization failure is visible and never shows a stale article', async () => {
  const previousFetch = globalThis.fetch;
  const previousAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
  let tree: ReturnType<typeof create> | null = null;
  try {
    await act(async () => { tree = create(createElement(DaemonContext.Provider, { value: daemon as never }, createElement(ScrapsPage))); });
    expect(tree!.root.findByProps({ role: 'alert' }).children.join('')).toBe('회원 로그인이 필요합니다.');
    expect(tree!.root.findAllByType('a').some((node) => node.props.href === 'https://news.example.test/tickets')).toBe(false);
  } finally {
    if (tree) await act(async () => tree!.unmount());
    globalThis.fetch = previousFetch;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
