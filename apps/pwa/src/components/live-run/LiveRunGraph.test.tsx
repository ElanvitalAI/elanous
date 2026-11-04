import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { ReactFlow } from '@xyflow/react';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import LiveRunPage from '@/app/live-run/page';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createNexusClient, type HarnessRunTraversal, type HarnessTraversalStepWire, type RunGraphDetail } from '@/nexus/client';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import { followZoom, LiveRunGraph, replayOverviewMinZoom } from './LiveRunGraph';

// /live 390px — 노드·간선·상태 말이 잘리지 않고 읽히는지 잰다(칸 DEMO-TA-GRAPH 판정선).
// ReactFlow 는 이 레포 `bun test` 에서 창만 있으면 돈다(GraphWizardCanvas.test.tsx 와 같은 셋업).

const STEPS: HarnessTraversalStepWire[] = [
  { node: 'intake', round: null, outcome: 'pass', at: '2026-10-17T09:00:00Z', durationMs: 1200, visit: 1, maxVisits: 1, detail: null },
  { node: 'compose', round: null, outcome: 'pass', at: '2026-10-17T09:00:05Z', durationMs: 800, visit: 1, maxVisits: 2, detail: null },
  { node: 'ship', round: null, outcome: 'pass', at: '2026-10-17T09:00:09Z', durationMs: 400, visit: 1, maxVisits: 1, detail: null },
];
const TRAVERSAL: HarnessRunTraversal = {
  runId: 'run-390', graphId: 'demo-loop', title: '390px 시연 런', status: 'completed', stage: null,
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
const nodeMock = (width: number) => () => ({
  closest: () => null, querySelector: () => null, querySelectorAll: () => [], contains: () => false, getRootNode: () => null,
  focus: noop, blur: noop, scrollTo: noop, addEventListener: noop, removeEventListener: noop, setAttribute: noop,
  getBoundingClientRect: () => ({ width, height: 700, top: 0, left: 0, right: width, bottom: 700, x: 0, y: 0 }),
  clientWidth: width, clientHeight: 700, offsetWidth: width, offsetHeight: 700, style: {}, ownerDocument: globalThis.document,
});

async function mount(width: number, requests: string[] = [], traversal = TRAVERSAL, graph = GRAPH, throughPage = false, stageMode = false, runId = 'run-390') {
  const fetchImpl = (async (url: string) => {
    requests.push(String(url));
    if (String(url).includes('/v1/harness/run-traversal')) return new Response(JSON.stringify(traversal), { status: 200 });
    if (String(url).includes('/v1/graphs/')) return new Response(JSON.stringify(graph), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const client = createNexusClient({ baseUrl: 'http://daemon', fetchImpl });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      <QueryClientProvider client={queryClient}>
        <NexusProvider client={client}>
          {throughPage ? (
            <AppRouterContext.Provider value={{ replace: () => {} } as never}>
              <SearchParamsContext.Provider value={new URLSearchParams({ run: runId })}>
                <LiveRunPage />
              </SearchParamsContext.Provider>
            </AppRouterContext.Provider>
          ) : <LiveRunGraph runId={runId} stageMode={stageMode} />}
        </NexusProvider>
      </QueryClientProvider>,
      { createNodeMock: nodeMock(width) },
    );
    await Bun.sleep(30);
  });
  // 그래프 원장 쿼리는 첫 렌더(런 원장 도착) 뒤에 출발한다 — 한 번 더 쉬어 채운 뒤 판정한다.
  await act(async () => { await Bun.sleep(30); });
  return root;
}

const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');

describe('LiveRunGraph — 390px', () => {
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
    const hadRoot = root !== null;
    if (root) { const done = root; root = null; act(() => { done.unmount(); }); }
    if (hadRoot) await Bun.sleep(850);
    for (const key of keys) {
      const previous = originals.get(key);
      if (previous && !('value' in previous && previous.value === undefined)) Object.defineProperty(g, key, previous);
      else delete g[key];
    }
  });

  test('followZoom — 좁은 화면 바닥 0.72, 넓은 화면 900px 기준 비율', () => {
    expect(followZoom(358)).toBe(0.72);
    expect(followZoom(620)).toBe(0.72);
    expect(followZoom(700)).toBe(0.78);
    expect(followZoom(1440)).toBe(1);
  });

  test('재생 완료 뒤 좁은 화면은 읽을 수 있는 따라가기 배율을 유지한다', () => {
    expect(replayOverviewMinZoom(true)).toBeNull();
    expect(replayOverviewMinZoom(false)).toBe(0.5);
  });

  test('390px — 노드·간선·상태 말이 잘리지 않는 좁은 화면 배치', async () => {
    root = await mount(390);
    const flow = root.root.findByType(ReactFlow);
    // 선언된 노드 4개가 전부 그래프에 올라간다(원장 사건 없는 audit 도 «기록 없음» 카드로).
    const flowNodes = flow.props.nodes as Array<{ id: string; data: { state: string; unrecorded: boolean } }>;
    expect(flowNodes.map((node) => node.id).sort()).toEqual(['audit', 'compose', 'intake', 'ship']);
    expect(flowNodes.find((node) => node.id === 'audit')?.data.unrecorded).toBe(true);
    // 간선 — 그래프가 선언한 3개가 전부 살아 있고(밟은 길 간선이 덧붙을 수 있다) 배선 계산(route.path)을 가진다.
    const flowEdges = flow.props.edges as Array<{ source: string; target: string; data: { route: { path: string } } }>;
    const edgeKeys = flowEdges.map((edge) => `${edge.source}->${edge.target}`);
    for (const declared of ['intake->compose', 'compose->audit', 'audit->ship']) expect(edgeKeys).toContain(declared);
    for (const edge of flowEdges) expect(edge.data.route.path).toBeTruthy();
    // 카드 DOM — 끝난 런은 처음부터 자동 재생된다: 재생이 compose 에 도달해 상태가 박힐 때까지 기다린다(재생 딜레이는 장면 규칙이 정한다).
    for (let waited = 0; waited < 12 && root.root.findByProps({ 'data-testid': 'live-node-compose' }).props['data-state'] !== 'passed'; waited += 1) {
      await act(async () => { await Bun.sleep(150); });
    }
    // 상태 말이 고정 폭 카드 안에 남는다(overflow-hidden + shrink-0, 종류 말이 대신 줄어든다).
    expect(root.root.findByProps({ 'data-testid': 'live-node-compose' }).props['data-state']).toBe('passed');
    const meta = root.root.findByProps({ 'data-testid': 'live-node-meta-compose' });
    expect(meta.props.className).toContain('overflow-hidden');
    const words = root.root.findAllByProps({ 'data-state-word': true });
    expect(words.map((word) => text(word))).toEqual(expect.arrayContaining(['기록 없음', '통과']));
    for (const word of words) expect(word.props.className).toContain('shrink-0');
    // 390px 판정 — 캔버스는 좁은 화면 배치로 커지고, 타임라인은 300px 로 낮아진다.
    const section = root.root.findByProps({ 'aria-label': '실행 그래프' });
    expect(section.props['data-viewport']).toBe('narrow');
    expect(section.props.className).toContain('h-[65dvh]');
    expect(section.props.className).toContain('min-h-[380px]');
    const aside = root.root.findByProps({ 'aria-label': '실행 타임라인' });
    expect(aside.props.className).toContain('max-h-[300px]');
    expect(aside.props.className).not.toContain('max-h-[420px]');
  });

  test('390px 조회 경로 — 완료된 런의 노드 이름·상태와 밟은 간선의 캡처 대기 표식', async () => {
    const requests: string[] = [];
    const longName = 'compose-the-actual-task-agent-result';
    const traversal = { ...TRAVERSAL, steps: STEPS.map((step) => step.node === 'compose' ? { ...step, node: longName } : step) };
    const graph = { ...GRAPH, nodes: GRAPH.nodes.map((node) => node.node_id === 'compose' ? { ...node, node_id: longName } : node),
      edges: GRAPH.edges.map((edge) => ({ ...edge, from: edge.from === 'compose' ? longName : edge.from, to: edge.to === 'compose' ? longName : edge.to })) };
    root = await mount(390, requests, traversal, graph, true);
    expect(root.root.findAllByType(LiveRunPage)).toHaveLength(1);
    expect(root.root.findAllByType(LiveRunGraph)).toHaveLength(1);
    expect(requests).toContain('http://daemon/v1/harness/run-traversal?runId=run-390');
    expect(requests).toContain('http://daemon/v1/graphs/demo-loop');
    await act(async () => { root!.root.findByProps({ 'data-testid': 'timeline-step-2' }).props.onClick(); });
    const flow = root.root.findByType(ReactFlow);
    const edges = flow.props.edges as Array<{ source: string; target: string; data: { taken: boolean; active: boolean } }>;
    expect(edges.some((edge) => edge.source === 'intake' && edge.target === longName && edge.data.taken && !edge.data.active)).toBe(true);
    const node = root.root.findByProps({ 'data-testid': `live-node-${longName}` });
    expect(node.props['data-state']).toBe('passed');
    const label = node.findAll((child) => child.type === 'div' && text(child) === longName && child.props.className?.includes('font-mono'))[0];
    expect(label.props.className).toContain('overflow-x-auto');
    expect(label.props.className).not.toContain('truncate');
    expect(label.props.title).toBe(longName);
    const section = root.root.findByProps({ 'aria-label': '실행 그래프' });
    expect(section.props['data-viewport']).toBe('narrow');
    expect(section.props.className).toContain('h-[65dvh]');
    const taken = edges.find((edge) => edge.source === 'intake' && edge.target === longName)!;
    const renderedEdge = flow.props.edgeTypes.live({ id: `intake-${longName}`, data: taken.data });
    expect(renderedEdge.props.children[0].props['data-testid']).toBe(`edge-token-intake-${longName}`);
  });

  test('traversal graphEvents를 같은 순서로 적용해 runtime 노드와 적응 간선을 재생한다', async () => {
    const withRuntimeGraph = {
      ...TRAVERSAL,
      graphEvents: [
        { seq: 4, ts: '2026-10-29T00:00:00.000Z', type: 'node-added' as const, node: 'source-audit', kind: 'judge', decider: 'runtime-overlay', reason: 'need source' },
        { seq: 5, ts: '2026-10-29T00:00:01.000Z', type: 'edge-rerouted' as const, from: 'audit', outcome: '$default', was: 'ship', to: 'source-audit', decider: 'runtime-overlay', reason: 'need source' },
        { seq: 6, ts: '2026-10-29T00:00:02.000Z', type: 'edge-rerouted' as const, from: 'source-audit', outcome: '$default', was: '$absent', to: 'ship', decider: 'runtime-overlay', reason: 'need source' },
        { seq: 7, ts: '2026-10-29T00:00:03.000Z', type: 'priority-changed' as const, node: 'audit', from: 2, to: 1, decider: 'research-runtime', reason: 'section priority' },
      ],
    };
    root = await mount(1024, [], withRuntimeGraph);
    const flow = root.root.findByType(ReactFlow);
    expect(flow.props.nodes.some((node: { id: string }) => node.id === 'source-audit')).toBe(true);
    const addedNode = root.root.findByProps({ 'data-testid': 'live-node-source-audit' });
    expect(addedNode.props['data-adaptive-event']).toBe('경로 수리');
    expect(root.root.findByProps({ 'data-testid': 'adaptive-event-source-audit' }).children).toEqual(['경로 수리']);
    expect(root.root.findByProps({ 'data-testid': 'adaptive-event-audit' }).children).toEqual(['우선순위 2→1']);
    expect(addedNode.props.className).toContain('animate-pulse');
    expect(flow.props.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'audit', target: 'source-audit' }),
      expect.objectContaining({ source: 'source-audit', target: 'ship' }),
    ]));
  });

  test('DEMO1104 fixed traversal response renders B/C scenario injections through /live-run', async () => {
    const traversal = JSON.parse(readFileSync(new URL('../../../../../test/fixtures/run-ledgers/demo1104-arg-9770d6f8.traversal.json', import.meta.url), 'utf8')) as HarnessRunTraversal;
    const runId = '9770d6f8-39e6-412a-9e83-9447b7a2cd36';
    const requests: string[] = [];
    const declaredGraph: RunGraphDetail = {
      ...GRAPH,
      nodes: [...GRAPH.nodes,
        { node_id: 'subscription-repair', kind: 'judge', recipe: 'subscription-repair', max_visits: 1 },
        { node_id: 'headline-refresh', kind: 'researcher', recipe: 'headline-refresh', max_visits: 1 },
      ],
    };
    root = await mount(1024, requests, traversal, declaredGraph, true, false, runId);
    expect(requests).toContain('http://daemon/v1/harness/run-traversal?runId=' + runId);
    const flow = root.root.findByType(ReactFlow);
    const nodes = flow.props.nodes as Array<{ id: string; data: { provenance?: { type: string; scene?: string; reason: string; mock?: boolean } } }>;
    expect(nodes.filter((node) => ['subscription-repair', 'headline-refresh'].includes(node.id))).toMatchObject([
      { id: 'subscription-repair', data: { provenance: { type: 'scenario-injection', scene: 'B', reason: 'paid-wall recovery mock', mock: true } } },
      { id: 'headline-refresh', data: { provenance: { type: 'scenario-injection', scene: 'C', reason: 'new headline reordering mock', mock: true } } },
    ]);
    expect(text(root.root.findByProps({ 'data-testid': 'scenario-injection-subscription-repair' })).trim()).toBe('시나리오 주입 · B · mock');
    expect(text(root.root.findByProps({ 'data-testid': 'scenario-injection-headline-refresh' })).trim()).toBe('시나리오 주입 · C · mock');
    expect(root.root.findByProps({ 'data-testid': 'scenario-injection-subscription-repair' }).props.title).toContain('paid-wall recovery mock');
  });

  test('non-mock scenario injection does not claim a mock label', async () => {
    const traversal = JSON.parse(readFileSync(new URL('../../../../../test/fixtures/run-ledgers/demo1104-arg-9770d6f8.traversal.json', import.meta.url), 'utf8')) as HarnessRunTraversal;
    const graphEvents = traversal.graphEvents?.map((event) => event.type === 'node-added' && event.node === 'subscription-repair'
      ? { ...event, reason: 'plugin grounded repair, not mock' }
      : event);
    root = await mount(1024, [], { ...traversal, graphEvents }, GRAPH);
    expect(text(root.root.findByProps({ 'data-testid': 'scenario-injection-subscription-repair' })).trim()).toBe('시나리오 주입 · B');
  });

  test('선언 그래프 밖에서 실제로 밟은 노드에만 새로 추가 표식을 붙인다', async () => {
    const addedNode = 'runtime-source-check';
    const traversal: HarnessRunTraversal = {
      ...TRAVERSAL,
      steps: [...STEPS, { node: addedNode, round: null, outcome: null, at: '2026-10-17T09:00:12Z', durationMs: null, visit: 1, maxVisits: 1, detail: null }],
    };
    root = await mount(1024, [], traversal);
    const flow = root.root.findByType(ReactFlow);
    const nodes = flow.props.nodes as Array<{ id: string; data: { adaptiveLabel?: string } }>;
    expect(nodes.find((node) => node.id === addedNode)?.data.adaptiveLabel).toBe('새로 추가');
    expect(nodes.find((node) => node.id === 'ship')?.data.adaptiveLabel).toBeUndefined();
    expect(root.root.findByProps({ 'data-testid': 'adaptive-event-runtime-source-check' }).children).toEqual(['새로 추가']);
  });

  test('무대 방문 패널은 관측된 복수 자원과 시각을 보이고 비어 있는 항목은 미계측으로 표시한다', async () => {
    const traversal: HarnessRunTraversal = {
      ...TRAVERSAL,
      steps: [
        { ...STEPS[0]!, resources: undefined },
        { ...STEPS[1]!, resources: { host: 'gcp2', pod: 'worker-7', models: ['gpt-6-sol', 'claude-sonnet-5'], plugins: ['browser', 'search'] } },
      ],
    };
    root = await mount(1024, [], traversal, GRAPH, false, true);
    const flow = root.root.findByType(ReactFlow);
    await act(async () => { flow.props.onNodeClick({}, { id: 'intake', type: 'live' }); });
    const panel = root.root.findByProps({ 'data-testid': 'node-detail' });
    const unmeasured = root.root.findByProps({ 'data-testid': 'visit-resources-intake-1' });
    expect(text(panel)).toContain('시각 18:00:00');
    expect(text(panel)).toContain('소요 1초');
    expect(text(unmeasured)).toContain('호스트 미계측');
    expect(text(unmeasured)).toContain('플러그인 미계측');

    await act(async () => { flow.props.onNodeClick({}, { id: 'compose', type: 'live' }); });
    const observed = root.root.findByProps({ 'data-testid': 'node-detail' });
    expect(text(observed)).toContain('모델 gpt-6-sol, claude-sonnet-5');
    expect(text(observed)).toContain('플러그인 browser, search');
  });

  test('넓은 화면(≥700px) 배치는 그대로 — 좁은 화면 수리가 넓은 골을 침범하지 않는다', async () => {
    (g.window as { innerWidth: number }).innerWidth = 1024;
    root = await mount(1024);
    const section = root.root.findByProps({ 'aria-label': '실행 그래프' });
    expect(section.props['data-viewport']).toBe('wide');
    expect(section.props.className).toContain('h-[60dvh]');
    expect(section.props.className).toContain('min-h-[340px]');
    const aside = root.root.findByProps({ 'aria-label': '실행 타임라인' });
    expect(aside.props.className).toContain('max-h-[420px]');
  });
});
