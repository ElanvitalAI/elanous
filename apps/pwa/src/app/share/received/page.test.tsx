import { expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { createElement } from 'react';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import ShareReceivedPage from './page';

test('Scene 1 share receipt shows article title, source, and persisted ID after one POST', async () => {
  const prior = {
    caches: globalThis.caches, navigator: globalThis.navigator, window: globalThis.window,
    fetch: globalThis.fetch,
    act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  const entries = new Map<string, Response>();
  const shareId = 'scene1-share';
  entries.set(`/__share/${shareId}/manifest.json`, Response.json({
    id: shareId, ts: Date.now(), title: '축제·콘서트 티켓 대란, 접속 폭주로 예매 실패',
    text: '동시 접속·중복 예매·공정 대기열 검토', url: 'https://example.test/ticket-rush', files: [],
  }));
  const cache = {
    match: async (path: string) => entries.get(path)?.clone(),
    put: async (path: string, response: Response) => { entries.set(path, response); },
    delete: async (path: string) => entries.delete(path),
    keys: async () => [...entries.keys()].map((path) => new Request(new URL(path, 'https://pwa.test'))),
  };
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  const navigations: string[] = [];
  let holdPost = false;
  let releasePost: (() => void) | undefined;
  Object.assign(globalThis, {
    caches: { keys: async () => ['elanous-pwa-share-target-test'], open: async () => cache },
    navigator: { locks: { request: async (_name: string, task: () => Promise<unknown>) => task() } },
    window: {
      location: { search: `?shared=${shareId}`, href: `https://pwa.test/app/share/received/?shared=${shareId}`, replace: (url: string) => navigations.push(url) },
      history: { state: null, replaceState: (_state: unknown, _title: string, url: URL) => navigations.push(String(url)) },
    },
    fetch: async (input: URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/members') return Response.json({ member: { id: 'member-scene1' } });
      requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (init?.method !== 'POST') return Response.json({ scraps: [{ id: 'persisted-scrap-1', kind: 'web', status: 'absorbed',
        raw: { text: '축제·콘서트 티켓 대란, 접속 폭주로 예매 실패', url: 'https://example.test/ticket-rush' } }] });
      if (holdPost) await new Promise<void>((resolve) => { releasePost = resolve; });
      return Response.json({ id: 'persisted-scrap-1', status: 'absorbed' }, { status: 201 });
    },
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const daemon = { config: { baseUrl: 'https://nexus.test', token: '', provider: '' },
    client: {}, sessionId: 'session-1', setConfig: () => {}, setSessionId: () => {} };
  let tree: ReturnType<typeof create> | null = null;
  try {
    await act(async () => {
      tree = create(createElement(DaemonContext.Provider, { value: daemon as never }, createElement(ShareReceivedPage)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const article = tree!.root.findByProps({ 'aria-label': '저장한 기사' });
    expect(article.props['data-scrap-id']).toBe('persisted-scrap-1');
    expect(article.findByType('p').children.join('')).toBe('축제·콘서트 티켓 대란, 접속 폭주로 예매 실패');
    expect(article.findByType('a').children.join('')).toBe('출처: example.test');
    expect(tree!.root.findAllByType('a').some((node) => node.props.href === '/scraps?selected=persisted-scrap-1')).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ path: '/v1/scraps', method: 'POST', body: { kind: 'web', raw: { url: 'https://example.test/ticket-rush' } } });
    expect(navigations).toEqual(['https://pwa.test/app/share/received/?saved=persisted-scrap-1']);
    await act(async () => tree!.unmount());
    tree = null;
    const location = (globalThis.window as Window).location as Location & { search: string; href: string };
    location.search = '?saved=persisted-scrap-1';
    location.href = navigations[0]!;
    await act(async () => {
      tree = create(createElement(DaemonContext.Provider, { value: daemon as never }, createElement(ShareReceivedPage)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(tree!.root.findByProps({ 'aria-label': '저장한 기사' }).props['data-scrap-id']).toBe('persisted-scrap-1');
    expect(requests.map((request) => request.method)).toEqual(['POST', 'GET']);
    await act(async () => tree!.update(createElement(DaemonContext.Provider,
      { value: { ...daemon, sessionId: null } as never }, createElement(ShareReceivedPage))));
    expect(tree!.root.findAllByProps({ 'aria-label': '저장한 기사' })).toHaveLength(0);
    await act(async () => tree!.unmount());
    tree = null;

    // Old progress records contain only a marker. A retry uses the same
    // idempotency key, then stores the recovered receipt.
    entries.set(`/__share/${shareId}/manifest.json`, Response.json({
      id: shareId, ts: Date.now(), title: '축제·콘서트 티켓 대란, 접속 폭주로 예매 실패',
      text: '동시 접속·중복 예매·공정 대기열 검토', url: 'https://example.test/ticket-rush', files: [],
    }));
    entries.set(`/__share/${shareId}/progress/url`, new Response('1'));
    location.search = `?shared=${shareId}`;
    location.href = `https://pwa.test/app/share/received/?shared=${shareId}`;
    holdPost = true;
    await act(async () => {
      tree = create(createElement(DaemonContext.Provider, { value: daemon as never }, createElement(ShareReceivedPage)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(requests.map((request) => request.method)).toEqual(['POST', 'GET', 'POST']);
    await act(async () => tree!.update(createElement(DaemonContext.Provider,
      { value: { ...daemon, sessionId: null } as never }, createElement(ShareReceivedPage))));
    await act(async () => tree!.update(createElement(DaemonContext.Provider,
      { value: daemon as never }, createElement(ShareReceivedPage))));
    await act(async () => { releasePost?.(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(tree!.root.findByProps({ 'aria-label': '저장한 기사' }).props['data-scrap-id']).toBe('persisted-scrap-1');
    expect(requests.map((request) => request.method)).toEqual(['POST', 'GET', 'POST']);
    expect(await entries.get(`/__share/${shareId}/progress/url`)?.json()).toMatchObject({ id: 'persisted-scrap-1' });
  } finally {
    if (tree) await act(async () => tree!.unmount());
    Object.assign(globalThis, { caches: prior.caches, navigator: prior.navigator, window: prior.window, fetch: prior.fetch });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = prior.act;
  }
});
