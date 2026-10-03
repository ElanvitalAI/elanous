import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { DaemonClient } from '@/lib/daemon-client';
import ExecPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;
let tree: ReactTestRenderer | undefined;

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.fetch = originalFetch;
});

async function mount() {
  const config = { baseUrl: 'https://nexus.example', token: 'owner-token', provider: '' };
  const client = new DaemonClient(config);
  await act(async () => {
    tree = create(
      <DaemonContext.Provider value={{ client, config, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}>
        <ExecPage />
      </DaemonContext.Provider>,
    );
  });
  return tree!.root;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const older = {
  id: 'older', text: '지난 요청\n둘째 줄', createdAt: '2026-09-30T12:00:00Z', status: 'done',
  seats: [{ seat: 'CMO', title: '원고', status: 'done' }], resultCount: 1,
};
const newer = {
  id: 'newer', text: '오늘 요청\n둘째 줄', createdAt: '2026-10-01T12:00:00Z', status: 'failed',
  seats: [{ seat: 'COO', title: '검토', status: 'failed' }, { seat: 'CMO', title: '작성', status: 'done' }], resultCount: 1,
};

test('request query opens its matching detail from the today link', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = { location: { search: '?request=newer' } } as Window & typeof globalThis;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    if (url.endsWith('/newer')) return json({ ...newer, summary: '오늘 상세', results: [], approvals: [] });
    return json({ items: [older, newer] });
  }) as typeof fetch;
  try {
    const root = await mount();
    expect(root.findByProps({ id: 'exec-detail' }).children).toEqual(['맡긴 일 상세']);
    expect(root.findAllByType('p').some(p => p.children.join('') === '오늘 상세')).toBe(true);
    expect(calls).toContain('https://nexus.example/v1/exec-requests/newer');
  } finally {
    globalThis.window = originalWindow;
  }
});

test('one-line POST accepts only 202, immediately shows planning card and rejects a duplicate send', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let resolvePost: ((value: Response) => void) | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === 'POST') return new Promise<Response>(resolve => { resolvePost = resolve; });
    return json({ items: [] });
  }) as typeof fetch;
  const root = await mount();
  expect(root.findByProps({ id: 'exec-compose' }).children).toEqual(['COO 에게 맡기기']);
  expect(root.findByProps({ id: 'exec-list' }).children).toEqual(['맡긴 일']);
  expect(root.findByProps({ type: 'submit' }).props.disabled).toBe(true);
  await act(async () => { root.findByProps({ name: 'text' }).props.onChange({ target: { value: '  보고서 작성  ' } }); });
  await act(async () => { void root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  expect(root.findByProps({ type: 'submit' }).props.disabled).toBe(true);
  expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1);
  const post = calls.find(call => call.init?.method === 'POST')!;
  expect(post.url).toBe('https://nexus.example/v1/exec-requests');
  expect(post.init?.headers).toMatchObject({ authorization: 'Bearer owner-token', 'content-type': 'application/json' });
  expect(JSON.parse(post.init?.body as string)).toEqual({ text: '보고서 작성' });
  await act(async () => { resolvePost!(json({ id: 'accepted', status: 'planning' }, 202)); });
  const card = root.findByProps({ 'aria-expanded': false });
  expect(card.findAllByType('span')[1]!.children.join('')).toBe('보고서 작성');
  expect(card.findAllByType('span')[2]!.children.join('')).toBe('계획 중');
});

test('lists newest first, maps request/seat statuses and details show failed reason and result file', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    if (url.endsWith('/newer')) return json({ ...newer, summary: '일부 멈춤', seats: [
      { seat: 'COO', title: '발행 승인 확인', status: 'failed', graphId: 'a', runId: 'b', reason: '근거 부족' },
      { seat: 'CMO', title: '원고 작성', status: 'done', graphId: 'c', runId: 'd' },
    ], results: [{ seat: 'CMO', kind: 'pdf', title: '결과.pdf', url: '/v1/exec-requests/newer/files/result.pdf' }], approvals: [] });
    return json({ items: [older, newer] });
  }) as typeof fetch;
  const root = await mount();
  const cards = root.findAllByProps({ 'aria-expanded': false });
  expect(cards).toHaveLength(2);
  expect(cards[0]!.findAllByType('span')[1]!.children.join('')).toBe('오늘 요청');
  expect(cards[0]!.findAllByType('span')[2]!.children.join('')).toBe('멈춤');
  expect(cards[0]!.findAllByType('span')[3]!.children.join('')).toBe('COO 못 함 · CMO 완료');
  expect(cards[1]!.findAllByType('span')[2]!.children.join('')).toBe('완료');
  await act(async () => { cards[0]!.props.onClick(); });
  expect(calls).toContain('https://nexus.example/v1/exec-requests/newer');
  expect(root.findAllByType('span').some(span => span.children.join('') === 'COO · 발행 승인 확인')).toBe(true);
  expect(root.findAllByType('p').some(p => p.children.join('') === '못 한 이유 · 근거 부족')).toBe(true);
  const resultButton = root.findAllByType('button').find(button => button.children.join('') === '결과.pdf');
  expect(resultButton).toBeDefined();
  expect(root.findAllByType('a')).toHaveLength(0);
});

test('reclicking completed or failed cards keeps detail; switching cards fetches the new detail', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    if (url.endsWith('/older')) return json({ ...older, summary: '완료된 결과', results: [], approvals: [] });
    if (url.endsWith('/newer')) return json({ ...newer, summary: '못 한 이유 확인', results: [], approvals: [] });
    return json({ items: [older, newer] });
  }) as typeof fetch;
  const root = await mount();
  for (const [id, summary] of [['newer', '못 한 이유 확인'], ['older', '완료된 결과']] as const) {
    const card = root.findAllByProps({ 'aria-expanded': false }).find(button => button.findAllByType('span')[1]?.children.join('') === (id === 'newer' ? '오늘 요청' : '지난 요청'))!;
    await act(async () => { card.props.onClick(); });
    expect(calls.filter(url => url.endsWith(`/${id}`))).toHaveLength(1);
    expect(root.findAllByType('p').some(p => p.children.join('') === summary)).toBe(true);
    await act(async () => { card.props.onClick(); });
    expect(root.findAllByType('p').some(p => p.children.join('') === summary)).toBe(true);
    expect(root.findAllByType('p').some(p => p.children.join('') === '상세 불러오는 중…')).toBe(false);
    expect(calls.filter(url => url.endsWith(`/${id}`))).toHaveLength(1);
  }
});

test('returning to a completed request starts a new detail read and discards the first delayed response', async () => {
  let resolveFirst: ((value: Response) => void) | undefined;
  let readsOfOlder = 0;
  globalThis.fetch = ((url: string) => {
    if (url.endsWith('/older')) {
      readsOfOlder += 1;
      if (readsOfOlder === 1) return new Promise<Response>(resolve => { resolveFirst = resolve; });
      return Promise.resolve(json({ ...older, summary: '최신 상세', results: [], approvals: [] }));
    }
    if (url.endsWith('/newer')) return Promise.resolve(json({ ...newer, summary: '다른 상세', results: [], approvals: [] }));
    return Promise.resolve(json({ items: [older, newer] }));
  }) as typeof fetch;
  const root = await mount();
  const card = (label: string) => root.findAllByProps({ 'aria-expanded': false }).find(button => button.findAllByType('span')[1]?.children.join('') === label)!;
  await act(async () => { card('지난 요청').props.onClick(); });
  expect(readsOfOlder).toBe(1);
  await act(async () => { card('오늘 요청').props.onClick(); });
  await act(async () => { card('지난 요청').props.onClick(); });
  expect(readsOfOlder).toBe(2);
  expect(root.findAllByType('p').some(p => p.children.join('') === '최신 상세')).toBe(true);
  await act(async () => { resolveFirst!(json({ ...older, summary: '오래된 상세', results: [], approvals: [] })); });
  expect(root.findAllByType('p').some(p => p.children.join('') === '최신 상세')).toBe(true);
  expect(root.findAllByType('p').some(p => p.children.join('') === '오래된 상세')).toBe(false);
});

test('authenticated result file is fetched through daemon client; unrelated remote result stays a link', async () => {
  const client = new DaemonClient({ baseUrl: 'https://nexus.example', token: 'owner-token', provider: '' });
  const fetches: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    fetches.push({ url, init });
    if (url.endsWith('/one')) return json({ id: 'one', text: '파일', createdAt: '2026-10-01', status: 'done', summary: '', seats: [], approvals: [], results: [
      { seat: 'CMO', kind: 'pdf', title: '파일.pdf', url: '/v1/exec-requests/one/files/file.pdf' },
      { seat: 'COO', kind: 'link', title: '공개 페이지', url: 'https://external.example/report' },
    ] });
    if (url.endsWith('.pdf')) return new Response('file', { status: 200 });
    return json({ items: [{ id: 'one', text: '파일', createdAt: '2026-10-01', status: 'done', seats: [], resultCount: 2 }] });
  }) as typeof fetch;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalWindow = globalThis.window;
  const originalTimeout = globalThis.setTimeout;
  const tab = { opener: {} as unknown, closed: false, location: { replace(url: string) { expect(url).toBe('blob:result'); } }, close() {} };
  URL.createObjectURL = () => 'blob:result';
  URL.revokeObjectURL = () => {};
  globalThis.setTimeout = (() => 1) as unknown as typeof setTimeout;
  globalThis.window = { open: () => tab } as unknown as Window & typeof globalThis;
  try {
    await act(async () => {
      tree = create(<DaemonContext.Provider value={{ client, config: { baseUrl: 'https://nexus.example', token: 'owner-token', provider: '' }, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}><ExecPage /></DaemonContext.Provider>);
    });
    const root = tree!.root;
    await act(async () => { root.findByProps({ 'aria-expanded': false }).props.onClick(); });
    expect(root.findByType('a').props.href).toBe('https://external.example/report');
    await act(async () => { await root.findAllByType('button').find(button => button.children.join('') === '파일.pdf')!.props.onClick(); });
    expect(fetches.find(call => call.url.endsWith('/files/file.pdf'))).toMatchObject({
      url: 'https://nexus.example/v1/exec-requests/one/files/file.pdf',
      init: { headers: { authorization: 'Bearer owner-token' } },
    });
    expect(tab.opener).toBe(null);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    globalThis.setTimeout = originalTimeout;
    globalThis.window = originalWindow;
  }
});

test('active requests poll list and selected detail every five seconds, then stop after completion', async () => {
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    const id = ++nextTimer;
    timers.set(id, { callback, delay });
    return id;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id: number) => { timers.delete(id); }) as unknown as typeof clearInterval;
  let status = 'planning';
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    if (url.endsWith('/active')) return json({ id: 'active', text: '일', createdAt: '2026-10-01', status, summary: '', seats: [], results: [], approvals: [] });
    return json({ items: [{ id: 'active', text: '일', createdAt: '2026-10-01', status, seats: [], resultCount: 0 }] });
  }) as typeof fetch;
  try {
    const root = await mount();
    await act(async () => { root.findByProps({ 'aria-expanded': false }).props.onClick(); });
    expect([...timers.values()].map(timer => timer.delay)).toEqual([5_000, 5_000]);
    await act(async () => { for (const timer of [...timers.values()]) timer.callback(); });
    expect(calls.filter(url => url.endsWith('/active'))).toHaveLength(2);
    status = 'running';
    await act(async () => { for (const timer of [...timers.values()]) timer.callback(); });
    expect(calls.filter(url => url.endsWith('/active'))).toHaveLength(3);
    expect(timers.size).toBe(2);
    status = 'done';
    await act(async () => { for (const timer of [...timers.values()]) timer.callback(); });
    expect(root.findByProps({ 'aria-expanded': true }).findAllByType('span')[2]!.children.join('')).toBe('완료');
    expect(timers.size).toBe(0);
  } finally {
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClear;
  }
});

test('a completed request polls only while a matching approval is pending, including before the first list resolves', async () => {
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    const id = ++nextTimer;
    timers.set(id, { callback, delay });
    return id;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id: number) => { timers.delete(id); }) as unknown as typeof clearInterval;
  let resolveList: ((value: Response) => void) | undefined;
  let withResult = false;
  let detailCalls = 0;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (url.endsWith('/finished')) {
      detailCalls += 1;
      return Promise.resolve(json({ id: 'finished', text: '일', createdAt: '2026-10-01', status: 'done', summary: '', seats: [],
        results: withResult ? [{ seat: 'COO', kind: 'report', title: '늦게 온 보고서', url: 'https://example.com/report' }] : [],
        approvals: [{ graphId: 'graph', runId: 'run', message: '게시 확인' }] }));
    }
    if (init?.method === 'POST') return Promise.resolve(json({ graphId: 'graph', runId: 'run', decision: 'approved' }));
    if (url.endsWith('/v1/graph-approvals')) return resolveList
      ? Promise.resolve(json({ items: [] }))
      : new Promise<Response>(resolve => { resolveList = resolve; });
    return Promise.resolve(json({ items: [{ id: 'finished', text: '일', createdAt: '2026-10-01', status: 'done', seats: [], resultCount: 0 }] }));
  }) as typeof fetch;
  try {
    const root = await mount();
    await act(async () => { root.findByProps({ 'aria-expanded': false }).props.onClick(); });
    expect([...timers.values()].map(timer => timer.delay)).toEqual([5_000]);
    withResult = true;
    await act(async () => { for (const timer of [...timers.values()]) timer.callback(); });
    expect(detailCalls).toBe(2);
    expect(root.findByType('a').props.href).toBe('https://example.com/report');
    await act(async () => { resolveList!(json({ items: [{ graphId: 'graph', runId: 'run' }] })); });
    expect(timers.size).toBe(1);
    await act(async () => { for (const timer of [...timers.values()]) timer.callback(); });
    expect(detailCalls).toBe(3);
    await act(async () => { root.findAllByType('button').find(button => button.children.join('') === '승인')!.props.onClick(); });
    expect(timers.size).toBe(0);
    await act(async () => { for (const timer of [...timers.values()]) timer.callback(); });
    expect(detailCalls).toBe(4);
  } finally {
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClear;
  }
});

test('a completed request with historical approvals stops polling once the pending list is empty', async () => {
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    expect(delay).toBe(5_000);
    const id = ++nextTimer;
    timers.set(id, callback);
    return id;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id: number) => { timers.delete(id); }) as unknown as typeof clearInterval;
  let detailCalls = 0;
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith('/finished')) {
      detailCalls += 1;
      return json({ id: 'finished', text: '일', createdAt: '2026-10-01', status: 'done', summary: '', seats: [], results: [],
        approvals: [{ graphId: 'graph', runId: 'run', message: '이미 결정한 게시' }] });
    }
    if (url.endsWith('/v1/graph-approvals')) return json({ items: [] });
    return json({ items: [{ id: 'finished', text: '일', createdAt: '2026-10-01', status: 'done', seats: [], resultCount: 0 }] });
  }) as typeof fetch;
  try {
    const root = await mount();
    await act(async () => { root.findByProps({ 'aria-expanded': false }).props.onClick(); });
    expect(detailCalls).toBe(1);
    expect(timers.size).toBe(0);
    await act(async () => { for (const callback of [...timers.values()]) callback(); });
    expect(detailCalls).toBe(1);
  } finally {
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClear;
  }
});

test('switching clients during a delayed list request loads the new list without polling and ignores the late old response', async () => {
  const oldConfig = { baseUrl: 'https://old.example', token: 'old-token', provider: '' };
  const newConfig = { baseUrl: 'https://new.example', token: 'new-token', provider: '' };
  const oldClient = new DaemonClient(oldConfig);
  const newClient = new DaemonClient(newConfig);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let resolveOld: ((value: Response) => void) | undefined;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === 'https://old.example/v1/exec-requests') {
      return new Promise<Response>(resolve => { resolveOld = resolve; });
    }
    return Promise.resolve(json({ items: [newer] }));
  }) as typeof fetch;
  const provider = (client: DaemonClient, config: typeof oldConfig) => (
    <DaemonContext.Provider value={{ client, config, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}>
      <ExecPage />
    </DaemonContext.Provider>
  );
  await act(async () => { tree = create(provider(oldClient, oldConfig)); });
  expect(calls).toEqual([{ url: 'https://old.example/v1/exec-requests', init: expect.objectContaining({ headers: { authorization: 'Bearer old-token' } }) }]);
  expect(tree!.root.findAllByType('p').some(p => p.children.join('') === '불러오는 중…')).toBe(true);

  await act(async () => { tree!.update(provider(newClient, newConfig)); });
  expect(calls).toEqual([
    { url: 'https://old.example/v1/exec-requests', init: expect.objectContaining({ headers: { authorization: 'Bearer old-token' } }) },
    { url: 'https://new.example/v1/exec-requests', init: expect.objectContaining({ headers: { authorization: 'Bearer new-token' } }) },
  ]);
  expect(tree!.root.findAllByProps({ 'aria-expanded': false })[0]?.findAllByType('span')[1]?.children.join('')).toBe('오늘 요청');
  expect(tree!.root.findAllByType('p').some(p => p.children.join('') === '불러오는 중…')).toBe(false);

  await act(async () => { resolveOld!(json({ items: [older] })); });
  expect(tree!.root.findAllByProps({ 'aria-expanded': false })).toHaveLength(1);
  expect(tree!.root.findAllByProps({ 'aria-expanded': false })[0]?.findAllByType('span')[1]?.children.join('')).toBe('오늘 요청');
});

test('late POST from an old connection cannot enter the new list or release the new connection send', async () => {
  const oldConfig = { baseUrl: 'https://old.example', token: 'old-token', provider: '' };
  const newConfig = { baseUrl: 'https://new.example', token: 'new-token', provider: '' };
  const oldClient = new DaemonClient(oldConfig);
  const newClient = new DaemonClient(newConfig);
  const listCalls: string[] = [];
  const postResolvers = new Map<string, (value: Response) => void>();
  const timers = new Map<number, () => void>();
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  let nextTimer = 0;
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    expect(delay).toBe(5_000);
    const id = ++nextTimer;
    timers.set(id, callback);
    return id;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id: number) => { timers.delete(id); }) as unknown as typeof clearInterval;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return new Promise<Response>(resolve => { postResolvers.set(url, resolve); });
    listCalls.push(url);
    return Promise.resolve(json({ items: url.startsWith('https://new.example')
      ? [{ id: 'new-running', text: '새 연결의 일', createdAt: '2026-10-01', status: 'running', seats: [], resultCount: 0 }]
      : [] }));
  }) as typeof fetch;
  const provider = (client: DaemonClient, config: typeof oldConfig) => (
    <DaemonContext.Provider value={{ client, config, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}>
      <ExecPage />
    </DaemonContext.Provider>
  );
  try {
    await act(async () => { tree = create(provider(oldClient, oldConfig)); });
    const root = tree!.root;
    await act(async () => { root.findByProps({ name: 'text' }).props.onChange({ target: { value: '옛 연결의 일' } }); });
    await act(async () => { void root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    expect(postResolvers.has('https://old.example/v1/exec-requests')).toBe(true);

    await act(async () => { tree!.update(provider(newClient, newConfig)); });
    expect(root.findAllByProps({ 'aria-expanded': false })).toHaveLength(1);
    expect(root.findByProps({ name: 'text' }).props.value).toBe('');
    await act(async () => { root.findByProps({ name: 'text' }).props.onChange({ target: { value: '새 요청' } }); });
    await act(async () => { void root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    expect(root.findByProps({ type: 'submit' }).props.disabled).toBe(true);

    await act(async () => { postResolvers.get('https://old.example/v1/exec-requests')!(json({ id: 'old-accepted', status: 'planning' }, 202)); });
    expect(root.findByProps({ type: 'submit' }).props.disabled).toBe(true);
    expect(root.findByProps({ name: 'text' }).props.value).toBe('새 요청');
    expect(root.findAllByProps({ 'aria-expanded': false })).toHaveLength(1);
    expect(root.findAllByType('span').some(span => span.children.join('') === '옛 연결의 일')).toBe(false);
    await act(async () => { for (const callback of [...timers.values()]) callback(); });
    expect(listCalls.filter(url => url === 'https://new.example/v1/exec-requests').length).toBeGreaterThan(1);
    expect(root.findAllByProps({ 'aria-expanded': false })).toHaveLength(1);

    await act(async () => { postResolvers.get('https://new.example/v1/exec-requests')!(json({ id: 'new-accepted', status: 'planning' }, 202)); });
    expect(root.findAllByProps({ 'aria-expanded': false })).toHaveLength(2);
    expect(root.findAllByType('span').some(span => span.children.join('') === '새 요청')).toBe(true);
  } finally {
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClear;
  }
});

test('non-202 submission reports failure without a planning card', async () => {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => init?.method === 'POST'
    ? json({ error: 'bad_request' }, 200) : json({ items: [] })) as typeof fetch;
  const root = await mount();
  await act(async () => { root.findByProps({ name: 'text' }).props.onChange({ target: { value: '일' } }); });
  await act(async () => { await root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  expect(root.findByProps({ role: 'alert' }).children.join('')).toContain('보내지 못했습니다');
  expect(root.findAllByProps({ 'aria-expanded': false })).toHaveLength(0);
});
