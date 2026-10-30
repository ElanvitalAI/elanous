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
    { from: 'resync', to: 'rejudge', outcomes: ['ok', 'fail'] },
    { from: 'rejudge', to: 'sync', outcomes: ['ok', 'fail'] },
    { from: 'sync', to: 'triage', outcomes: ['ok'] },
    { from: 'sync', to: 'failed', outcomes: ['fail'] },
    { from: 'triage', to: 'schedule', outcomes: ['ok'] },
    { from: 'triage', to: 'failed', outcomes: ['fail'] },
    { from: 'schedule', to: 'report', outcomes: ['ok'] },
    { from: 'schedule', to: 'failed', outcomes: ['fail'] },
    { from: 'report', to: 'done', outcomes: ['ok'] },
    { from: 'report', to: 'failed', outcomes: ['fail'] },
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

async function mount(width: number) {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes('/v1/harness/runs')) return new Response(JSON.stringify(RUNS), { status: 200 });
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
          <RunGraphShowcase />
        </NexusProvider>
      </QueryClientProvider>,
      { createNodeMock: nodeMock(width) },
    );
  });
  await waitUntil(() => root.root.findAllByProps({ 'data-testid': `showcase-run-${TRAVERSAL.runId}` }).length > 0);
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
    root.root.findByProps({ 'data-testid': `showcase-run-${TRAVERSAL.runId}` }).props.onClick();
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
    expect(text(root.root.findByProps({ 'data-testid': `showcase-run-${TRAVERSAL.runId}` }))).toContain('● 도는 중');
    await pickRun(root);
    expectCurrentSceneOnly(root);
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
