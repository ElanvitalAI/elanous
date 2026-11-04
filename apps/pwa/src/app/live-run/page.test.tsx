import { afterEach, expect, test } from 'bun:test';
import { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient } from '@tanstack/react-query';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { createNexusClient } from '@/nexus/client';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import LiveRunPage from './page';

const AUTO_FOLLOW_VALUE = '__auto_follow_latest__';
const client = createNexusClient({
  baseUrl: 'http://daemon',
  fetchImpl: (async () => new Response(JSON.stringify({ entries: [], finished: [] }), { status: 200 })) as unknown as typeof fetch,
});
const router = { replace: () => {} };
let root: ReactTestRenderer | undefined;
let queryClient: QueryClient | undefined;
let restoreBrowser: (() => void) | undefined;

function installConnectBrowser(hash: string, initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const requests: Array<{ url: string; init: RequestInit }> = [];
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
  const oldFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browserWindow });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({
      scope: 'setup', bearer: 'elsb_fresh-device-bearer', expiresAt: Date.now() + 86_400_000,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  restoreBrowser = () => {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else delete (globalThis as { window?: unknown }).window;
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
    globalThis.fetch = oldFetch;
  };
  return { values, requests, replacements };
}

async function renderPage(strict = false) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = (
    <AppRouterContext.Provider value={router as never}>
      <SearchParamsContext.Provider value={new URLSearchParams()}>
        <NexusProvider client={client} queryClient={queryClient}>
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
  const browser = installConnectBrowser('#t=els_fresh-link-token', {
    'elanous.nexus.baseUrl': 'https://old-nexus.example',
    'elanous.daemon.token': 'elsb_' + 'A'.repeat(43),
    'elanous.daemon.setupScopeExpiresAt': String(Date.now() - 1),
  });
  await renderPage();
  expect(browser.requests).toHaveLength(1);
  expect(browser.requests[0]!.url).toBe('https://new-nexus.example/v1/setup/claim');
  expect(JSON.parse(browser.requests[0]!.init.body as string)).toEqual({ t: 'els_fresh-link-token' });
  expect(browser.values.get('elanous.nexus.baseUrl')).toBe('https://new-nexus.example');
  expect(browser.values.get('elanous.daemon.token')).toBe('elsb_fresh-device-bearer');
  expect(browser.replacements).toEqual(['/app/live-run']);
});

test('StrictMode effect replay claims once and saves the bearer', async () => {
  const browser = installConnectBrowser('#t=els_strict-mode-token');
  await renderPage(true);
  expect(browser.requests).toHaveLength(1);
  expect(browser.values.get('elanous.daemon.token')).toBe('elsb_fresh-device-bearer');
  expect(browser.replacements).toEqual(['/app/live-run']);
});
