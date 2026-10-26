import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createNexusClient, type HarnessRunTraversal, type HarnessTraversalStepWire, type RunGraphDetail } from '@/nexus/client';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import * as livePanelModule from '@/components/live/LivePanel';
import * as nextNavigation from 'next/navigation';

// /live 배선 — 기본은 LivePanel(보존 계약), `?run=<runId>` 는 LiveRunGraph(390px 시연 경로).
// LivePanel 내부 동작은 보존 대상이라 스텁으로 빼고, 이 파일은 page.tsx 의 가지 선택만 잰다.
// R-TST23: mock.module 은 프로세스 전역이라 afterAll 에서 원본 스냅샷으로 되돌린다.

let search = '';
const StubPanel = () => <div data-testid="live-panel-stub" />;
const realNavigation = { ...nextNavigation };
const realLivePanel = { ...livePanelModule };

await mock.module('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(search) }));
await mock.module('@/components/live/LivePanel', () => ({ LivePanel: StubPanel }));
const { LivePanel } = await import('@/components/live/LivePanel');
const { LiveRunGraph } = await import('@/components/live-run/LiveRunGraph');
const { default: LivePage } = await import('./page');

const STEPS: HarnessTraversalStepWire[] = [
  { node: 'intake', round: null, outcome: 'pass', at: '2026-10-17T09:00:00Z', durationMs: 1200, visit: 1, maxVisits: 1, detail: null },
  { node: 'ship', round: null, outcome: 'pass', at: '2026-10-17T09:00:09Z', durationMs: 400, visit: 1, maxVisits: 1, detail: null },
];
const TRAVERSAL: HarnessRunTraversal = {
  runId: 'run-390', graphId: 'demo-loop', title: '390px 시연 런', status: 'completed', stage: null,
  startedAt: '2026-10-17T09:00:00Z', endedAt: '2026-10-17T09:01:00Z', prNumber: null, substrate: null,
  steps: STEPS, ledgerEvents: 2,
};
const GRAPH: RunGraphDetail = {
  id: 'demo-loop', source: 'core', editable: false, entry_node: 'intake', terminal_nodes: ['ship'],
  nodes: [
    { node_id: 'intake', kind: 'observe', recipe: 'cmd:intake', max_visits: 1 },
    { node_id: 'ship', kind: 'git', recipe: 'cmd:ship', max_visits: 1 },
  ],
  edges: [{ from: 'intake', to: 'ship' }],
};

const noop = () => {};
const nodeMock = (width: number) => () => ({
  closest: () => null, querySelector: () => null, querySelectorAll: () => [], contains: () => false, getRootNode: () => null,
  focus: noop, blur: noop, scrollTo: noop, addEventListener: noop, removeEventListener: noop, setAttribute: noop,
  getBoundingClientRect: () => ({ width, height: 700, top: 0, left: 0, right: width, bottom: 700, x: 0, y: 0 }),
  clientWidth: width, clientHeight: 700, offsetWidth: width, offsetHeight: 700, style: {}, ownerDocument: globalThis.document,
});

async function mountPage() {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes('/v1/harness/run-traversal')) return new Response(JSON.stringify(TRAVERSAL), { status: 200 });
    if (String(url).includes('/v1/graphs/')) return new Response(JSON.stringify(GRAPH), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const client = createNexusClient({ baseUrl: 'http://daemon', fetchImpl });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      <QueryClientProvider client={queryClient}>
        <NexusProvider client={client}>
          <LivePage />
        </NexusProvider>
      </QueryClientProvider>,
      { createNodeMock: nodeMock(390) },
    );
    await Bun.sleep(30);
  });
  // 그래프 원장 쿼리는 첫 렌더(런 원장 도착) 뒤에 출발한다 — 한 번 더 쉬어 채운 뒤 판정한다.
  await act(async () => { await Bun.sleep(30); });
  return root;
}

describe('/live 배선', () => {
  const g = globalThis as Record<string, unknown>;
  const keys = ['IS_REACT_ACT_ENVIRONMENT', 'window', 'ResizeObserver', 'requestAnimationFrame', 'SVGElement'] as const;
  let originals: Map<string, PropertyDescriptor | undefined>;
  let root: ReturnType<typeof create> | null = null;
  beforeEach(() => {
    originals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(g, key)]));
    g.IS_REACT_ACT_ENVIRONMENT = true;
    if (typeof g.requestAnimationFrame !== 'function') g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
    if (typeof g.ResizeObserver !== 'function') g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    // d3-zoom 의 extent 계산이 SVGElement 글로벌을 본다 — 창 없는 런타임에선 스텁으로 지나가게 한다.
    if (typeof g.SVGElement !== 'function') g.SVGElement = class SVGElementStub {};
    g.window = { innerWidth: 390, setTimeout, clearTimeout, requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: (id: number) => clearTimeout(id), addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) };
  });
  afterEach(async () => {
    if (root) { const done = root; root = null; act(() => { done.unmount(); }); }
    await Bun.sleep(850);
    for (const key of keys) {
      const previous = originals.get(key);
      if (previous && !('value' in previous && previous.value === undefined)) Object.defineProperty(g, key, previous);
      else delete g[key];
    }
  });

  test('기본(/live)은 LivePanel 을 그대로 렌더한다 — 보존 계약', async () => {
    search = '';
    root = await mountPage();
    expect(root.root.findAllByType(LivePanel)).toHaveLength(1);
    expect(root.root.findAllByType(LiveRunGraph)).toHaveLength(0);
  });

  test('?run=<runId> 는 LiveRunGraph 를 390px 좁은 화면 배치로 렌더한다', async () => {
    search = '?run=run-390';
    root = await mountPage();
    expect(root.root.findAllByType(LivePanel)).toHaveLength(0);
    expect(root.root.findAllByType(LiveRunGraph)).toHaveLength(1);
    expect(root.root.findByProps({ 'data-testid': 'live-node-intake' })).toBeTruthy();
    expect(root.root.findByProps({ 'aria-label': '실행 그래프' }).props['data-viewport']).toBe('narrow');
  });
});

afterAll(async () => {
  await mock.module('next/navigation', () => realNavigation);
  await mock.module('@/components/live/LivePanel', () => realLivePanel);
});
