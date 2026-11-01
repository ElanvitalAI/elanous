import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createNexusClient, type HarnessRunTraversal, type HarnessTraversalStepWire, type RunGraphDetail } from '@/nexus/client';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import { LiveRunGraph } from './LiveRunGraph';

// GRAPH-VIEW-WIRING-UX ⑥ — 상단 지표 띠. 무대 = 기존 LiveRunGraph 시험과 같은 mount+react-test-renderer
// (생산 호출 경로: NexusProvider → useNexusClient → getHarnessRunTraversal / getRunGraph → LiveRunGraph).

const STEPS: HarnessTraversalStepWire[] = [
  { node: 'intake', round: null, outcome: 'pass', at: '2026-10-17T09:00:00Z', durationMs: 1200, visit: 1, maxVisits: 1, detail: null },
  { node: 'compose', round: null, outcome: 'pass', at: '2026-10-17T09:00:05Z', durationMs: 800, visit: 1, maxVisits: 2, detail: null },
  { node: 'ship', round: null, outcome: 'pass', at: '2026-10-17T09:00:09Z', durationMs: 400, visit: 1, maxVisits: 1, detail: null },
];
const TRAVERSAL: HarnessRunTraversal = {
  runId: 'run-metrics', graphId: 'demo-loop', title: '지표 띠 런', status: 'completed', stage: null,
  startedAt: '2026-10-17T09:00:00Z', endedAt: '2026-10-17T09:01:00Z', prNumber: null, substrate: null,
  steps: STEPS, ledgerEvents: 6,
};
const GRAPH: RunGraphDetail = {
  id: 'demo-loop', source: 'core', editable: false, entry_node: 'intake', terminal_nodes: ['ship'],
  nodes: [
    { node_id: 'intake', kind: 'observe', recipe: 'cmd:intake', max_visits: 1 },
    { node_id: 'compose', kind: 'subgraph', recipe: 'cmd:compose', max_visits: 2 },
    { node_id: 'audit', kind: 'agent', recipe: 'cmd:audit', max_visits: 1 },
    { node_id: 'ship', kind: 'git', recipe: 'cmd:ship', max_visits: 1 },
  ],
  edges: [
    { from: 'intake', to: 'compose' },
    { from: 'compose', to: 'audit' },
    { from: 'audit', to: 'ship' },
  ],
};

const noop = () => {};
const nodeMock = () => ({
  closest: () => null, querySelector: () => null, querySelectorAll: () => [], contains: () => false, getRootNode: () => null,
  focus: noop, blur: noop, scrollTo: noop, addEventListener: noop, removeEventListener: noop, setAttribute: noop,
  getBoundingClientRect: () => ({ width: 1024, height: 700, top: 0, left: 0, right: 1024, bottom: 700, x: 0, y: 0 }),
  clientWidth: 1024, clientHeight: 700, offsetWidth: 1024, offsetHeight: 700, style: {}, ownerDocument: globalThis.document,
});

async function mount(traversal: HarnessRunTraversal, graph: RunGraphDetail | null = GRAPH) {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes('/v1/harness/run-traversal')) return new Response(JSON.stringify(traversal), { status: 200 });
    if (String(url).includes('/v1/graphs/')) {
      if (!graph) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(graph), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const client = createNexusClient({ baseUrl: 'http://daemon', fetchImpl });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      <QueryClientProvider client={queryClient}>
        <NexusProvider client={client}>
          <LiveRunGraph runId="run-metrics" />
        </NexusProvider>
      </QueryClientProvider>,
      { createNodeMock: nodeMock },
    );
    await Bun.sleep(30);
  });
  await act(async () => { await Bun.sleep(30); });
  return root;
}

const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');

describe('LiveRunGraph — 상단 지표 띠', () => {
  const g = globalThis as Record<string, unknown>;
  const keys = ['IS_REACT_ACT_ENVIRONMENT', 'window', 'ResizeObserver', 'requestAnimationFrame', 'SVGElement'] as const;
  let originals: Map<string, PropertyDescriptor | undefined>;
  let root: ReturnType<typeof create> | null = null;
  beforeEach(() => {
    originals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(g, key)]));
    g.IS_REACT_ACT_ENVIRONMENT = true;
    if (typeof g.requestAnimationFrame !== 'function') g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
    if (typeof g.ResizeObserver !== 'function') g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    if (typeof g.SVGElement !== 'function') g.SVGElement = class SVGElementStub {};
    g.window = { innerWidth: 1024, setTimeout, clearTimeout, requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: (id: number) => clearTimeout(id), addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) };
  });
  afterEach(async () => {
    const hadRoot = root !== null;
    if (root) { const done = root; root = null; act(() => { done.unmount(); }); }
    if (hadRoot) await Bun.sleep(850);
    for (const key of keys) {
      const previous = originals.get(key);
      if (previous && !('value' in previous && previous.value === undefined)) Object.defineProperty(g, key, previous);
      else delete g[key];
    }
  });

  test('값 있음 — 그래프의 노드 수·간선 수와 원장 경과를 실측으로 렌더하고 비용 원천이 없으면 미계측', async () => {
    root = await mount(TRAVERSAL, GRAPH);
    const strip = root.root.findByProps({ 'data-testid': 'live-run-metrics' });
    expect(text(strip.findByProps({ 'data-testid': 'metric-nodes' }))).toContain('4');
    // 선언 간선 3개 ⊕ 원장이 밟은 intake→compose 가 선언 map 에 없어 더해진 1개 = 화면에 그려진 간선.
    expect(text(strip.findByProps({ 'data-testid': 'metric-edges' }))).toContain('4');
    expect(text(strip.findByProps({ 'data-testid': 'metric-elapsed' }))).toContain('1분 0초');
    expect(text(strip.findByProps({ 'data-testid': 'metric-cost' }))).toContain('미계측');
    expect(text(strip.findByProps({ 'data-testid': 'metric-cost' }))).not.toContain('0');
  });

  test('값 없음 — 시각·단계 시간이 없으면 경과도 미계측이고 비용은 0으로 꾸미지 않는다', async () => {
    const empty: HarnessRunTraversal = {
      ...TRAVERSAL,
      startedAt: null,
      endedAt: null,
      steps: [],
      ledgerEvents: 0,
    };
    root = await mount(empty, { ...GRAPH, nodes: [], edges: [] });
    const strip = root.root.findByProps({ 'data-testid': 'live-run-metrics' });
    expect(text(strip.findByProps({ 'data-testid': 'metric-nodes' }))).toContain('0');
    expect(text(strip.findByProps({ 'data-testid': 'metric-edges' }))).toContain('0');
    expect(text(strip.findByProps({ 'data-testid': 'metric-elapsed' }))).toContain('미계측');
    expect(text(strip.findByProps({ 'data-testid': 'metric-cost' }))).toContain('미계측');
    expect(text(strip)).not.toMatch(/비용\s*0/);
  });
});
