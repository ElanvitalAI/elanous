import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isValidElement, type ReactNode } from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { ReactFlow } from '@xyflow/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createNexusClient, type HarnessRunTraversal, type RunGraphDetail } from '@/nexus/client';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import { RunGraphShowcase } from './RunGraphShowcase';

// Snapshot copied from `eln logs --instance prod --grep 49669d4d-75d9-44bd-9679-2e080c78fb0e
// --category graph.run --limit 30 --json`: four node-entry events, three matching node exits.
// Graph shape is copied from graphs/steward/steward.yaml; node IDs/outcomes match the captured records.
const TRAVERSAL: HarnessRunTraversal = {
  runId: '49669d4d-75d9-44bd-9679-2e080c78fb0e', graphId: 'steward', title: '스튜어드', status: 'running', stage: 'triage',
  startedAt: '2026-10-29T09:15:09.192Z', endedAt: null, prNumber: null, substrate: null,
  steps: [
    { node: 'resync', round: null, outcome: 'ok', at: '2026-10-29T09:15:09.192Z', durationMs: 1462, visit: 1, maxVisits: 1, detail: 'exit=0' },
    { node: 'rejudge', round: null, outcome: 'ok', at: '2026-10-29T09:15:10.657Z', durationMs: 650855, visit: 1, maxVisits: 1, detail: 'exit=0' },
    { node: 'sync', round: null, outcome: 'ok', at: '2026-10-29T09:26:01.514Z', durationMs: 41115, visit: 1, maxVisits: 1, detail: 'exit=0' },
    { node: 'triage', round: null, outcome: null, at: '2026-10-29T09:26:42.631Z', durationMs: null, visit: 1, maxVisits: 1, detail: null },
  ],
  ledgerEvents: 22,
};

const GRAPH: RunGraphDetail = {
  id: 'steward', source: 'core', editable: false, entry_node: 'resync', terminal_nodes: ['done', 'failed'],
  nodes: [
    { node_id: 'resync', kind: 'agent', recipe: 'cmd:steward-resync', max_visits: 1 },
    { node_id: 'rejudge', kind: 'agent', recipe: 'cmd:steward-rejudge', max_visits: 1 },
    { node_id: 'sync', kind: 'agent', recipe: 'cmd:steward-sync', max_visits: 1 },
    { node_id: 'triage', kind: 'agent', recipe: 'cmd:steward-triage', max_visits: 1 },
    { node_id: 'schedule', kind: 'agent', recipe: 'cmd:steward-schedule', max_visits: 1 },
    { node_id: 'report', kind: 'agent', recipe: 'cmd:steward-report', max_visits: 1 },
    { node_id: 'done', kind: 'gate', recipe: '', max_visits: 1 },
    { node_id: 'failed', kind: 'gate', recipe: '', max_visits: 1 },
  ],
  edges: [
    { from: 'resync', to: 'rejudge' },
    { from: 'rejudge', to: 'sync' },
    { from: 'sync', to: 'triage' },
    { from: 'sync', to: 'failed' },
    { from: 'triage', to: 'schedule' },
    { from: 'triage', to: 'failed' },
    { from: 'schedule', to: 'report' },
    { from: 'schedule', to: 'failed' },
    { from: 'report', to: 'done' },
    { from: 'report', to: 'failed' },
  ],
};
const RUNS = {
  entries: [{ runId: TRAVERSAL.runId, status: 'running', lastActivityTimestamp: '2026-10-29T09:26:42.631Z', objective: '스튜어드' }],
  finished: [], total: 1,
};

test('첫 장면 고정 입력은 실제 steward 런 원장의 사건열을 사용한다', () => {
  expect(TRAVERSAL.runId).toBe('49669d4d-75d9-44bd-9679-2e080c78fb0e');
  expect(TRAVERSAL.graphId).toBe('steward');
  expect(TRAVERSAL.steps.map(({ node, outcome }) => [node, outcome])).toEqual([
    ['resync', 'ok'], ['rejudge', 'ok'], ['sync', 'ok'], ['triage', null],
  ]);
  expect(TRAVERSAL.steps.map(({ at }) => at)).toEqual([
    '2026-10-29T09:15:09.192Z', '2026-10-29T09:15:10.657Z', '2026-10-29T09:26:01.514Z', '2026-10-29T09:26:42.631Z',
  ]);
});

const noop = () => {};
const nodeMock = (width: number) => () => ({
  closest: () => null, querySelector: () => null, querySelectorAll: () => [], contains: () => false, getRootNode: () => null,
  focus: noop, blur: noop, scrollTo: noop, addEventListener: noop, removeEventListener: noop, setAttribute: noop,
  getBoundingClientRect: () => ({ width, height: 700, top: 0, left: 0, right: width, bottom: 700, x: 0, y: 0 }),
  clientWidth: width, clientHeight: 700, offsetWidth: width, offsetHeight: 700, style: {}, ownerDocument: globalThis.document,
});

async function mount(width: number, traversal: HarnessRunTraversal = TRAVERSAL) {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes('/v1/harness/runs')) return new Response(JSON.stringify(RUNS), { status: 200 });
    if (String(url).includes('/v1/harness/run-traversal')) return new Response(JSON.stringify(traversal), { status: 200 });
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
          <RunGraphShowcase />
        </NexusProvider>
      </QueryClientProvider>,
      { createNodeMock: nodeMock(width) },
    );
  });
  await waitUntil(() => root.root.findAllByProps({ value: TRAVERSAL.runId }).length > 0);
  return root;
}

async function waitUntil(ready: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let isReady = false;
    await act(async () => {
      isReady = ready();
      if (!isReady) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (isReady) return;
  }
  throw new Error('React Query/graph render did not reach the requested state');
}

async function pickRun(root: ReturnType<typeof create>) {
  await act(async () => {
    root.root.findByProps({ 'data-testid': 'showcase-run-select-0' }).props.onChange({ target: { value: TRAVERSAL.runId } });
  });
  await waitUntil(() => root.root.findAllByType(ReactFlow).length > 0);
}

function expectCurrentSceneOnly(root: ReturnType<typeof create>) {
  expect(root.root.findAllByProps({ role: 'group', 'aria-label': '보기' })).toHaveLength(0);
  expect(root.root.findAllByProps({ 'data-testid': 'toggle-units' })).toHaveLength(0);
  expect(text(root.root)).not.toContain('리플레이');
  expect(text(root.root)).not.toContain('묶음 접기');
}

const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
function countTag(node: ReactNode, tag: string): number {
  if (Array.isArray(node)) return node.reduce((count, child) => count + countTag(child, tag), 0);
  if (!isValidElement(node)) return 0;
  const children = (node.props as { children?: ReactNode }).children;
  return (node.type === tag ? 1 : 0) + countTag(children, tag);
}

describe('RunGraphShowcase — 390px·태블릿·발표 폭', () => {
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
    if (root) {
      const done = root;
      root = null;
      act(() => { done.unmount(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 850)); });
    }
    for (const key of keys) {
      const previous = originals.get(key);
      if (previous && !('value' in previous && previous.value === undefined)) Object.defineProperty(g, key, previous);
      else delete g[key];
    }
  });

  test('발표 폭(1280px) — 원장 사건이 노드를 밝히고 다음 간선에 흐르는 표식이 움직인다', async () => {
    (g.window as { innerWidth: number }).innerWidth = 1280;
    root = await mount(1280);
    expect(text(root.root.findByProps({ 'data-testid': 'showcase-run-select-0' }))).toContain('도는 중');
    await pickRun(root);
    expectCurrentSceneOnly(root);
    expect([0, 1, 2].every((index) => root!.root.findAllByProps({ 'data-testid': `showcase-panel-${index}` }).length === 1)).toBe(true);
    expect(root.root.findAllByProps({ role: 'group', 'aria-label': '리서치 적응형 그래프 사건' })).toHaveLength(1);
    expect(root.root.findByProps({ 'data-testid': 'arg-added-count-0' }).children).toEqual(['0']);
    expect(root.root.findByProps({ 'data-testid': 'arg-depth-count-0' }).children).toEqual(['0']);
    expect(root.root.findByProps({ 'data-testid': 'arg-repair-count-0' }).children).toEqual(['0']);
    expect(text(root.root.findByProps({ 'data-testid': 'arg-hand-card-0' }))).toContain('이 런 원장에 기록된 손 노드 없음');
    const flow = root.root.findByType(ReactFlow);
    const nodes = flow.props.nodes as Array<{ id: string; data: { state: string; visits: number } }>;
    expect(nodes.find((node) => node.id === 'resync')?.data).toMatchObject({ state: 'passed', visits: 1 });
    expect(nodes.find((node) => node.id === 'sync')?.data).toMatchObject({ state: 'passed', visits: 1 });
    expect(nodes.find((node) => node.id === 'triage')?.data).toMatchObject({ state: 'running', visits: 1 });
    const triageView = root.root.findByProps({ 'data-testid': 'live-node-triage' });
    expect(triageView.props.className).toContain('workflow-node-status-running');
    expect(triageView.props.style.borderColor).toBe('#f59e0b');
    const flowEdges = flow.props.edges as Array<{ id: string; source: string; target: string; data: { taken: boolean; active: boolean } }>;
    expect(flowEdges.some((edge) => edge.source === 'resync' && edge.target === 'rejudge' && edge.data.taken)).toBe(true);
    const active = flowEdges.find((edge) => edge.source === 'sync' && edge.target === 'triage' && edge.data.active)!;
    expect(active.data.taken).toBe(true);
    const liveEdge = (flow.props.edgeTypes as { live: (props: unknown) => ReactNode }).live({ id: active.id, data: active.data, markerEnd: undefined, style: undefined });
    expect(countTag(liveEdge, 'animateMotion')).toBe(2);
    expect(root.root.findByProps({ 'aria-label': '실행 그래프' }).props['data-viewport']).toBe('wide');
  });

  test('기록된 적응 사건은 세 패널과 손 카드에만 실측값으로 표시한다', async () => {
    const traversal: HarnessRunTraversal = {
      ...TRAVERSAL,
      graphEvents: [
        { seq: 5, ts: '2026-10-29T09:26:43.000Z', type: 'node-added', node: 'source-check', kind: 'search', decider: 'runtime-overlay', reason: 'source evidence missing' },
        { seq: 6, ts: '2026-10-29T09:26:44.000Z', type: 'unit-expanded', node: 'research', unit: 'source-check', childRunId: 'child-research', resolution: 3, decider: 'runtime-overlay', reason: 'deepen source review' },
        { seq: 7, ts: '2026-10-29T09:26:45.000Z', type: 'edge-rerouted', from: 'triage', outcome: '$default', was: 'schedule', to: 'source-check', decider: 'runtime-overlay', reason: 'retry source with alternate route' },
        { seq: 8, ts: '2026-10-29T09:26:46.000Z', type: 'node-added', node: 'codex-hand', kind: 'hand', decider: 'runtime-overlay', reason: 'agent mission hand', who: 'codex', what: 'compare independent research angle', missionId: 'mission-research' },
        { seq: 9, ts: '2026-10-29T09:26:47.000Z', type: 'node-added', node: 'source-check-2', kind: 'search', decider: 'runtime-overlay', reason: 'compare second source' },
        { seq: 10, ts: '2026-10-29T09:26:48.000Z', type: 'node-added', node: 'source-check-3', kind: 'search', decider: 'runtime-overlay', reason: 'compare third source' },
      ],
    };
    root = await mount(1280, traversal);
    await pickRun(root);
    expect(root.root.findByProps({ 'data-testid': 'arg-added-count-0' }).children).toEqual(['4']);
    expect(root.root.findByProps({ 'data-testid': 'arg-depth-count-0' }).children).toEqual(['1']);
    expect(root.root.findByProps({ 'data-testid': 'arg-repair-count-0' }).children).toEqual(['1']);
    expect(root.root.findByProps({ 'data-testid': 'arg-added-panel-0' }).props.className).toContain('animate-pulse');
    expect(root.root.findByProps({ 'data-testid': 'arg-depth-panel-0' }).props.className).toContain('animate-pulse');
    expect(root.root.findByProps({ 'data-testid': 'arg-repair-panel-0' }).props.className).toContain('animate-pulse');
    expect(root.root.findAllByProps({ 'data-event-seq': 5 })).toHaveLength(1);
    expect(root.root.findAllByProps({ 'data-event-seq': 6 })).toHaveLength(1);
    expect(root.root.findAllByProps({ 'data-event-seq': 7 })).toHaveLength(1);
    expect(text(root.root.findByProps({ 'data-testid': 'arg-hand-card-0' })).includes('codex → compare independent research angle · mission-research')).toBe(true);
    const nodes = root.root.findByType(ReactFlow).props.nodes as Array<{ id: string }>;
    expect(nodes.some((node) => node.id === 'source-check')).toBe(true);
    expect(nodes.some((node) => node.id === 'codex-hand')).toBe(true);
  });

  test('태블릿 폭(820px) — 실제 진행 노드와 현재 간선을 넓은 배치로 유지한다', async () => {
    (g.window as { innerWidth: number }).innerWidth = 820;
    root = await mount(820);
    await pickRun(root);
    expectCurrentSceneOnly(root);
    const section = root.root.findByProps({ 'aria-label': '실행 그래프' });
    expect(section.props['data-viewport']).toBe('wide');
    expect(section.props.className).toContain('h-[60dvh]');
    const flow = root.root.findByType(ReactFlow);
    const triage = (flow.props.nodes as Array<{ id: string; data: { state: string } }>).find((node) => node.id === 'triage');
    expect(triage?.data.state).toBe('running');
    const active = (flow.props.edges as Array<{ source: string; target: string; data: { active: boolean } }>).find((edge) => edge.source === 'sync' && edge.target === 'triage');
    expect(active?.data.active).toBe(true);
    expect(root.root.findByProps({ 'aria-label': '실행 타임라인' }).props.className).toContain('max-h-[420px]');
  });

  test('390px — 원장 사건으로 밝혀진 노드 상태와 현재 간선을 좁은 배치에 보존한다', async () => {
    (g.window as { innerWidth: number }).innerWidth = 390;
    root = await mount(390);
    await pickRun(root);
    expectCurrentSceneOnly(root);
    const nodes = root.root.findByType(ReactFlow).props.nodes as Array<{ id: string; data: { state: string } }>;
    expect(nodes.find((node) => node.id === 'triage')?.data.state).toBe('running');
    expect(nodes.find((node) => node.id === 'schedule')?.data.state).toBe('pending');
    expect(root.root.findByProps({ 'data-testid': 'live-node-triage' }).props['data-state']).toBe('running');
    const section = root.root.findByProps({ 'aria-label': '실행 그래프' });
    expect(section.props['data-viewport']).toBe('narrow');
    expect(section.props.className).toContain('h-[65dvh]');
    expect(section.props.className).toContain('min-h-[380px]');
    expect(root.root.findByProps({ 'aria-label': '실행 타임라인' }).props.className).toContain('max-h-[300px]');
  });
});
