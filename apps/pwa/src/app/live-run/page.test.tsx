import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient } from '@tanstack/react-query';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { createNexusClient } from '@/nexus/client';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import LiveRunPage from './page';
import { GraphInstanceLiveScreen } from '@/components/live-run/GraphInstanceLiveScreen';
import { withFakeFetchDevice } from '../../test-devices/fake-fetch';

const AUTO_FOLLOW_VALUE = '__auto_follow_latest__';
const client = createNexusClient({
  baseUrl: 'http://daemon',
  fetchImpl: (async () => new Response(JSON.stringify({ entries: [], finished: [] }), { status: 200 })) as unknown as typeof fetch,
});
const resourceView = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../../../plugins/graph-instance-view/fixtures/resource.view.json'), 'utf8')) as unknown;
const routeViews = Object.fromEntries(['graph', 'harness', 'release'].map(source => [source,
  JSON.parse(readFileSync(resolve(import.meta.dir, `../../../../../plugins/graph-instance-view/fixtures/${source}.view.json`), 'utf8')) as unknown,
])) as Record<'graph' | 'harness' | 'release', unknown>;
const router = { replace: () => {} };
let root: ReactTestRenderer | undefined;
let queryClient: QueryClient | undefined;
let restoreBrowser: (() => void) | undefined;

function installConnectBrowser(hash: string, initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const replacements: string[] = [];
  const local = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
  const location = {
    hash, origin: 'https://new-nexus.example', pathname: '/app/live-run', search: '',
    protocol: 'https:', host: 'new-nexus.example',
    replace: (url: string) => { replacements.push(url); },
  } as unknown as Location;
  const browserWindow = {
    location,
    history: { replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
      if (url) { location.hash = ''; }
    } },
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window;
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browserWindow });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  restoreBrowser = () => {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else delete (globalThis as { window?: unknown }).window;
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  };
  return { values, replacements };
}

async function renderPage(strict = false, query = '', nexusClient = client) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = (
    <AppRouterContext.Provider value={router as never}>
      <SearchParamsContext.Provider value={new URLSearchParams(query)}>
        <NexusProvider client={nexusClient} queryClient={queryClient}>
          <LiveRunPage />
        </NexusProvider>
      </SearchParamsContext.Provider>
    </AppRouterContext.Provider>
  );
  await act(async () => {
    root = create(strict ? <StrictMode>{page}</StrictMode> : page);
    await Bun.sleep(20);
  });
}

test('resource route is operator gated and drops unrelated URL identifiers', async () => {
  await withFakeFetchDevice([
    { url: '/v1/me', method: 'GET', response: () => Response.json({ operator: true }) },
  ], async () => {
    installConnectBrowser('', { 'elanous.nexus.baseUrl': 'https://new-nexus.example' });
    const calls: string[] = [];
    const resourceClient = createNexusClient({ baseUrl: 'https://nexus.test', fetchImpl: (async input => {
      calls.push(String(input));
      return Response.json(resourceView);
    }) as typeof fetch });
    await renderPage(false, 'view=instance&source=resource&run=other-run&graph=other-graph', resourceClient);
    await Bun.sleep(20);
    await act(async () => {});
    expect(root!.root.findByType(GraphInstanceLiveScreen).props.instanceKey).toEqual({ source: 'resource' });
    expect(calls).toEqual(['https://nexus.test/v1/graph-instance-view?source=resource']);
    expect(JSON.stringify(root!.toJSON())).toContain('자원 현황');
    expect(JSON.stringify(root!.toJSON())).toContain('mbp');
  });
});

test('resource route denies a nonoperator before reading the view', async () => {
  await withFakeFetchDevice([
    { url: '/v1/me', method: 'GET', response: () => Response.json({ operator: false }) },
  ], async () => {
    installConnectBrowser('', { 'elanous.nexus.baseUrl': 'https://new-nexus.example' });
    await renderPage(false, 'view=instance&source=resource');
    expect(root!.root.findAllByType(GraphInstanceLiveScreen)).toHaveLength(0);
    expect(root!.root.findByType('p').children.join('')).toBe('운영자만 볼 수 있습니다');
  });
});

// #36563 provides the Nexus route; this test keeps its response as a fixture while checking the PWA request and screen.
for (const { source, query, key, path, title } of [
  { source: 'graph', query: 'view=instance&source=graph&run=graph-demo-1&graph=research-flow',
    key: { source: 'graph', runId: 'graph-demo-1', graphId: 'research-flow' },
    path: '/v1/graph-instance-view?source=graph&runId=graph-demo-1&graphId=research-flow', title: 'Research flow' },
  { source: 'graph', query: 'view=instance&source=graph&run=graph-demo-1',
    key: { source: 'graph', runId: 'graph-demo-1' },
    path: '/v1/graph-instance-view?source=graph&runId=graph-demo-1', title: 'Research flow' },
  { source: 'harness', query: 'view=instance&source=harness&run=harness-demo-1',
    key: { source: 'harness', runId: 'harness-demo-1' },
    path: '/v1/graph-instance-view?source=harness&runId=harness-demo-1', title: 'Implement card' },
  { source: 'harness', query: 'view=instance&source=harness&run=harness-demo-1&graph=ignored',
    key: { source: 'harness', runId: 'harness-demo-1' },
    path: '/v1/graph-instance-view?source=harness&runId=harness-demo-1', title: 'Implement card' },
  { source: 'release', query: 'view=instance&source=release&run=release-demo-1&graph=release-loop',
    key: { source: 'release', runId: 'release-demo-1', graphId: 'release-loop' },
    path: '/v1/graph-instance-view?source=release&runId=release-demo-1&graphId=release-loop', title: 'Release loop' },
  { source: 'release', query: 'view=instance&source=release&run=release-demo-1',
    key: { source: 'release', runId: 'release-demo-1' },
    path: '/v1/graph-instance-view?source=release&runId=release-demo-1', title: 'Release loop' },
] as const) {
  test(`instance link selects the ${source} plugin route and renders its projection`, async () => {
    await withFakeFetchDevice([
      { url: '/v1/me', method: 'GET', response: () => Response.json({ operator: false }) },
    ], async () => {
      installConnectBrowser('', { 'elanous.nexus.baseUrl': 'https://new-nexus.example' });
      const calls: string[] = [];
      const routeClient = createNexusClient({ baseUrl: 'https://nexus.test', token: 'test-token', fetchImpl: (async input => {
        calls.push(String(input));
        return Response.json(routeViews[source]);
      }) as typeof fetch });
      await renderPage(false, query, routeClient);
      await Bun.sleep(20);
      await act(async () => {});
      expect(root!.root.findByType(GraphInstanceLiveScreen).props.instanceKey).toEqual(key);
      expect(calls).toEqual([`https://nexus.test${path}`]);
      expect(JSON.stringify(root!.toJSON())).toContain(title);
    });
  });
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  queryClient?.clear();
  queryClient = undefined;
  restoreBrowser?.();
  restoreBrowser = undefined;
});

test('no run query routes to latest-run auto-follow mode', async () => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root = create(
      <AppRouterContext.Provider value={router as never}>
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <NexusProvider client={client} queryClient={queryClient}>
            <LiveRunPage />
          </NexusProvider>
        </SearchParamsContext.Provider>
      </AppRouterContext.Provider>,
    );
    await Bun.sleep(10);
  });
  expect(root!.root.findByType('select').props.value).toBe(AUTO_FOLLOW_VALUE);
  expect(root!.root.findByProps({ role: 'status' })).toBeTruthy();
});

test('auto-follow route keeps the no-daemon guidance when Nexus is unavailable', async () => {
  await act(async () => {
    root = create(
      <AppRouterContext.Provider value={router as never}>
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <LiveRunPage />
        </SearchParamsContext.Provider>
      </AppRouterContext.Provider>,
    );
  });
  expect(root!.root.findByType('h1').children.join('')).toBe('런 장면');
  expect(root!.root.findByType('p').children.join('')).toContain('데몬에 연결되면 최근 하니스 런을 자동으로 따라갑니다.');
});


test('an incoming link replaces a saved expired token and claims against the link host', async () => {
  await withFakeFetchDevice([
    { url: '/v1/setup/claim', method: 'POST', response: () => new Response(JSON.stringify({
      scope: 'setup', bearer: 'elsb_fresh-device-bearer', expiresAt: Date.now() + 86_400_000,
    }), { status: 200, headers: { 'content-type': 'application/json' } }) },
    { url: '/v1/me', method: 'GET', response: () => Response.json({ operator: false }) },
  ], async (device) => {
    const browser = installConnectBrowser('#t=els_fresh-link-token', {
      'elanous.nexus.baseUrl': 'https://old-nexus.example',
      'elanous.daemon.token': 'elsb_' + 'A'.repeat(43),
      'elanous.daemon.setupScopeExpiresAt': String(Date.now() - 1),
    });
    await renderPage();
    const calls = device.calls();
    const [request] = calls.filter((call) => call.method === 'POST' && new URL(call.url).pathname === '/v1/setup/claim');
    const operatorChecks = calls.filter((call) => call.method === 'GET' && new URL(call.url).pathname === '/v1/me');
    expect(calls.map((call) => call.routeId)).not.toContain(null);
    expect(operatorChecks.some((call) => call.status === 200)).toBe(true);
    expect(operatorChecks.every((call) => call.status === 200)).toBe(true);
    expect(calls.filter((call) => call.method === 'POST' && new URL(call.url).pathname === '/v1/setup/claim')).toHaveLength(1);
    expect(request!.url).toBe('https://new-nexus.example/v1/setup/claim');
    expect(JSON.parse(request!.body!)).toEqual({ t: 'els_fresh-link-token' });
    expect(browser.values.get('elanous.nexus.baseUrl')).toBe('https://new-nexus.example');
    expect(browser.values.get('elanous.daemon.token')).toBe('elsb_fresh-device-bearer');
    expect(browser.replacements).toEqual(['/app/live-run']);
  });
});

test('StrictMode effect replay claims once and saves the bearer', async () => {
  await withFakeFetchDevice([
    { url: '/v1/setup/claim', method: 'POST', response: () => new Response(JSON.stringify({
      scope: 'setup', bearer: 'elsb_fresh-device-bearer', expiresAt: Date.now() + 86_400_000,
    }), { status: 200, headers: { 'content-type': 'application/json' } }) },
    { url: '/v1/me', method: 'GET', response: () => Response.json({ operator: false }) },
  ], async (device) => {
    const browser = installConnectBrowser('#t=els_strict-mode-token');
    await renderPage(true);
    const calls = device.calls();
    const operatorChecks = calls.filter((call) => call.method === 'GET' && new URL(call.url).pathname === '/v1/me');
    expect(calls.map((call) => call.routeId)).not.toContain(null);
    expect(operatorChecks.some((call) => call.status === 200)).toBe(true);
    expect(operatorChecks.every((call) => call.status === 200)).toBe(true);
    expect(calls.filter((call) => call.method === 'POST' && new URL(call.url).pathname === '/v1/setup/claim')).toHaveLength(1);
    expect(browser.values.get('elanous.daemon.token')).toBe('elsb_fresh-device-bearer');
    expect(browser.replacements).toEqual(['/app/live-run']);
  });
});
