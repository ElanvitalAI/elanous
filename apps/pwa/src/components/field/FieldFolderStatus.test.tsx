import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { DaemonClient } from '@/lib/daemon-client';
import FieldFolderStatus from './FieldFolderStatus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const config = { baseUrl: 'https://nexus.example', token: 'owner-token', provider: '' };
let tree: ReactTestRenderer | undefined;
let requests: Array<{ url: string; init?: RequestInit }> = [];

function render(event: string, refreshKey = 0, client = new DaemonClient(config)) {
  return <DaemonContext.Provider value={{ client, config, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}>
    <FieldFolderStatus event={event} refreshKey={refreshKey} />
  </DaemonContext.Provider>;
}

function mockFetch(handle: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    return handle(url);
  }) as typeof fetch;
}

async function mount(event: string, client?: DaemonClient) {
  await act(async () => { tree = create(render(event, 0, client)); });
  return tree!.root;
}

async function change(event: string, refreshKey = 0, client?: DaemonClient) {
  await act(async () => { tree!.update(render(event, refreshKey, client)); });
}

function cardText() {
  return tree!.root.findByProps({ 'aria-label': '행사 폴더 상태' }).findAllByType('p').map((p) => p.children.join('')).join(' | ');
}

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  requests = [];
});

test('a valid event reads its uploaded count on mount, and switching events reads the new folder only', async () => {
  mockFetch((url) => {
    if (url.includes('/v1/field/uploads?event=')) return Response.json({ event: 'unused', count: url.endsWith('event=first') ? 3 : 7, files: [] });
    throw new Error(`unexpected request: ${url}`);
  });
  const client = new DaemonClient(config);
  await mount('first', client);
  expect(cardText()).toContain('폴더에 3개 · 영상 없음');
  await change('second', 0, client);
  expect(cardText()).toContain('폴더에 7개 · 영상 없음');
  expect(cardText()).not.toContain('3개');
  expect(requests.map((request) => request.url)).toEqual([
    'https://nexus.example/v1/field/uploads?event=first',
    'https://nexus.example/v1/field/uploads?event=second',
  ]);
  expect(requests[0]!.init?.headers).toEqual({ authorization: 'Bearer owner-token' });
});

test('invalid names make no request and do not display a previous event', async () => {
  mockFetch(() => Response.json({ event: 'first', count: 2 }));
  const client = new DaemonClient(config);
  await mount('first', client);
  await change('Bad/Name', 0, client);
  expect(tree!.root.findAllByProps({ 'aria-label': '행사 폴더 상태' })).toHaveLength(0);
  expect(requests).toHaveLength(1);
});

test('refreshing the same event updates the count without showing the stale response', async () => {
  let resolveOld!: (response: Response) => void;
  let count = 0;
  mockFetch((url) => {
    expect(url).toEndWith('/v1/field/uploads?event=first');
    count += 1;
    return count === 1 ? new Promise<Response>((resolve) => { resolveOld = resolve; }) : Response.json({ event: 'first', count: 5 });
  });
  const client = new DaemonClient(config);
  await mount('first', client);
  await change('first', 1, client);
  expect(cardText()).toContain('폴더에 5개');
  await act(async () => { resolveOld(Response.json({ event: 'first', count: 1 })); await Promise.resolve(); });
  expect(cardText()).toContain('폴더에 5개');
  expect(requests).toHaveLength(2);
});

test('a late response for an old event cannot replace the new event status', async () => {
  let resolveOld!: (response: Response) => void;
  mockFetch((url) => url.endsWith('event=first')
    ? new Promise<Response>((resolve) => { resolveOld = resolve; })
    : Response.json({ event: 'second', count: 8 }));
  const client = new DaemonClient(config);
  await mount('first', client);
  await change('second', 0, client);
  await act(async () => { resolveOld(Response.json({ event: 'first', count: 2 })); await Promise.resolve(); });
  expect(tree!.root.findByProps({ 'aria-label': '행사 폴더 상태' }).findByType('h2').children).toEqual(['second']);
  expect(cardText()).toContain('폴더에 8개');
  expect(cardText()).not.toContain('2개');
});

test('a listed rendering reel transitions to failure and exposes its reason', async () => {
  mockFetch((url) => {
    if (url.endsWith('/v1/field/uploads?event=first')) return Response.json({ event: 'first', count: 4, reel: { status: 'rendering', updatedAt: '' } });
    if (url.endsWith('/v1/field/reel?event=first')) return Response.json({ event: 'first', state: 'failed', items: 4, error: 'encoding failed' });
    throw new Error(`unexpected request: ${url}`);
  });
  await mount('first');
  expect(cardText()).toContain('폴더에 4개 · 영상 만들지 못함');
  expect(cardText()).toContain('encoding failed');
  expect(requests.map((request) => request.url)).toEqual([
    'https://nexus.example/v1/field/uploads?event=first',
    'https://nexus.example/v1/field/reel?event=first',
  ]);
});

test('an already failed reel on mount displays the daemon failure reason', async () => {
  mockFetch((url) => {
    if (url.endsWith('/v1/field/uploads?event=first')) return Response.json({ event: 'first', count: 2, reel: { status: 'failed' } });
    if (url.endsWith('/v1/field/reel?event=first')) return Response.json({ event: 'first', state: 'failed', items: 2, error: 'bad media' });
    throw new Error(`unexpected request: ${url}`);
  });
  await mount('first');
  expect(cardText()).toContain('폴더에 2개 · 영상 만들지 못함');
  expect(cardText()).toContain('bad media');
});

test('a completed reel uses the authenticated blob and revokes its URL when the event changes', async () => {
  const revoked: string[] = [];
  URL.createObjectURL = (() => 'blob:field') as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => { revoked.push(url); }) as typeof URL.revokeObjectURL;
  mockFetch((url) => {
    if (url.endsWith('/v1/field/uploads?event=first')) return Response.json({ event: 'first', count: 2, reel: { status: 'done', url: '/v1/field/reel/file?event=first' } });
    if (url.endsWith('/v1/field/reel/file?event=first')) return new Response(new Blob(['video'], { type: 'video/mp4' }));
    if (url.endsWith('/v1/field/uploads?event=second')) return Response.json({ event: 'second', count: 0 });
    throw new Error(`unexpected request: ${url}`);
  });
  const client = new DaemonClient(config);
  await mount('first', client);
  expect(cardText()).toContain('영상 완료');
  expect(tree!.root.findByType('video').props.src).toBe('blob:field');
  expect(requests[1]!.init?.headers).toEqual({ authorization: 'Bearer owner-token' });
  await change('second', 0, client);
  expect(revoked).toEqual(['blob:field']);
  expect(tree!.root.findAllByType('video')).toHaveLength(0);
});

test('listing errors are visible rather than masquerading as an empty folder', async () => {
  mockFetch(() => Response.json({ reason: 'unavailable' }, { status: 503 }));
  await mount('first');
  expect(cardText()).toContain('unavailable');
  expect(cardText()).not.toContain('폴더에 0개');
});
