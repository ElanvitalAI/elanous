import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient } from '@tanstack/react-query';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { createNexusClient, type HarnessRunTraversal, type HarnessRunsSinceResponse, type RunGraphDetail } from '@/nexus/client';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import LiveRunPage from '@/app/live-run/page';

const AUTO_FOLLOW_VALUE = '__auto_follow_latest__';
const noop = () => {};
const GRAPH: RunGraphDetail = {
  id: 'auto-follow-graph', source: 'core', editable: false, entry_node: 'start', terminal_nodes: ['start'],
  nodes: [{ node_id: 'start', kind: 'agent', recipe: 'test', max_visits: 1 }], edges: [],
};
const nodeMock = () => ({
  closest: () => null, querySelector: () => null, querySelectorAll: () => [], contains: () => false, getRootNode: () => null,
  focus: noop, blur: noop, scrollTo: noop, addEventListener: noop, removeEventListener: noop, setAttribute: noop,
  getBoundingClientRect: () => ({ width: 390, height: 700, top: 0, left: 0, right: 390, bottom: 700, x: 0, y: 0 }),
  clientWidth: 390, clientHeight: 700, offsetWidth: 390, offsetHeight: 700, style: {}, ownerDocument: globalThis.document,
});

let search = new URLSearchParams();
const routeCalls: string[] = [];
let runResponse: HarnessRunsSinceResponse = {
  entries: [
    { runId: 'run-old', status: 'running', lastActivityTimestamp: '2026-11-04T00:00:00Z', objective: 'older session' },
    { runId: 'run-latest', status: 'running', lastActivityTimestamp: '2026-11-04T00:01:00Z', objective: 'latest session' },
  ], finished: [],
};
const requests: string[] = [];
const router = {
  replace(path: string) {
    routeCalls.push(path);
    search = new URL(path, 'http://localhost').searchParams;
  },
};
const fetchImpl = (async (url: string) => {
  const path = String(url);
  requests.push(path);
  const parsed = new URL(path);
  if (parsed.pathname === '/v1/harness/runs') return new Response(JSON.stringify(runResponse), { status: 200 });
  if (parsed.pathname === '/v1/harness/run-traversal') {
    const runId = parsed.searchParams.get('runId') ?? 'missing';
    const traversal: HarnessRunTraversal = {
      runId, graphId: GRAPH.id, title: runId, status: 'completed', stage: null,
      startedAt: '2026-11-04T00:00:00Z', endedAt: '2026-11-04T00:01:00Z', prNumber: null, substrate: null,
      steps: [], ledgerEvents: 0,
    };
    return new Response(JSON.stringify(traversal), { status: 200 });
  }
  if (parsed.pathname === `/v1/graphs/${GRAPH.id}`) return new Response(JSON.stringify(GRAPH), { status: 200 });
  return new Response('{}', { status: 200 });
}) as unknown as typeof fetch;
const client = createNexusClient({ baseUrl: 'http://daemon', fetchImpl });

let root: ReactTestRenderer | undefined;
let queryClient: QueryClient | undefined;
let originals: Map<string, PropertyDescriptor | undefined>;
const globalKeys = ['IS_REACT_ACT_ENVIRONMENT', 'window', 'ResizeObserver', 'requestAnimationFrame', 'SVGElement'] as const;

function treeElement() {
  return (
    <AppRouterContext.Provider value={router as never}>
      <SearchParamsContext.Provider value={search}>
        <NexusProvider client={client} queryClient={queryClient!}>
          <LiveRunPage />
        </NexusProvider>
      </SearchParamsContext.Provider>
    </AppRouterContext.Provider>
  );
}

function traversalRunIds() {
  return requests
    .filter((request) => request.includes('/v1/harness/run-traversal'))
    .map((request) => new URL(request).searchParams.get('runId'));
}

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    await Bun.sleep(850);
  }
  root = undefined;
  queryClient?.clear();
  queryClient = undefined;
  for (const key of globalKeys) {
    const previous = originals?.get(key);
    if (previous) Object.defineProperty(globalThis, key, previous);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test('auto-follow advances with the run list; manual choice pins and can return to auto-follow', async () => {
  originals = new Map(globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const globals = globalThis as Record<string, unknown>;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof globals.requestAnimationFrame !== 'function') globals.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  if (typeof globals.ResizeObserver !== 'function') globals.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (typeof globals.SVGElement !== 'function') globals.SVGElement = class SVGElementStub {};
  globals.window = {
    innerWidth: 390, setTimeout, clearTimeout,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: (id: number) => clearTimeout(id),
    addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  };
  search = new URLSearchParams();
  routeCalls.length = 0;
  requests.length = 0;
  runResponse = {
    entries: [
      { runId: 'run-old', status: 'running', lastActivityTimestamp: '2026-11-04T00:00:00Z', objective: 'older session' },
      { runId: 'run-latest', status: 'running', lastActivityTimestamp: '2026-11-04T00:01:00Z', objective: 'latest session' },
    ], finished: [],
  };
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  await act(async () => {
    root = create(treeElement(), { createNodeMock: nodeMock });
    await Bun.sleep(40);
  });
  await act(async () => { await Bun.sleep(30); });

  expect(traversalRunIds()).toContain('run-latest');
  expect(root!.root.findByType('select').props.value).toBe(AUTO_FOLLOW_VALUE);

  // Select the already visible auto-picked run; it must become an explicit, pinned choice.
  await act(async () => {
    root!.root.findByType('select').props.onChange({ target: { value: 'run-latest' } });
    root!.update(treeElement());
    await Bun.sleep(40);
  });
  expect(routeCalls.at(-1)).toBe('/live-run/?run=run-latest');
  expect(root!.root.findByType('select').props.value).toBe('run-latest');

  const query = queryClient!.getQueryCache().getAll().find((item) => item.queryKey[0] === 'harness-runs-since');
  expect(query?.isActive()).toBe(false);
  runResponse = {
    entries: [
      { runId: 'run-latest', status: 'running', lastActivityTimestamp: '2026-11-04T00:01:00Z', objective: 'latest session' },
      { runId: 'run-newer', status: 'running', lastActivityTimestamp: '2026-11-04T00:02:00Z', objective: 'newer session' },
    ], finished: [],
  };
  await act(async () => { queryClient!.setQueryData(query!.queryKey, runResponse); });
  expect(root!.root.findByType('select').props.value).toBe('run-latest');

  await act(async () => {
    root!.root.findByProps({ 'aria-label': '최신 런 자동 따라가기' }).props.onClick();
    root!.update(treeElement());
    await Bun.sleep(40);
  });
  await act(async () => {
    await queryClient!.refetchQueries({ queryKey: ['harness-runs-since'], type: 'active' });
    await Bun.sleep(40);
  });
  expect(routeCalls.at(-1)).toBe('/live-run/');
  expect(root!.root.findByType('select').props.value).toBe(AUTO_FOLLOW_VALUE);
  expect(traversalRunIds()).toContain('run-newer');
  expect(queryClient!.getQueryCache().getAll().some((item) => item.queryKey[0] === 'harness-runs-since' && item.isActive())).toBe(true);
});
