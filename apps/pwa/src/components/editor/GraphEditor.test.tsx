import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { ReactFlow } from '@xyflow/react';
import { WorkflowsPanel } from '@/components/workflows/WorkflowsPanel';
import { RunGraphView } from '@/components/workflows/RunGraphView';
import { GraphCanvasEditor } from './GraphCanvasEditor';
import { GraphWizardEntry } from './GraphWizardChat';
import type { GraphKindEntry } from '@/nexus/client';
import { GraphEditor, GraphEditorPalette, GraphShareControl } from './GraphEditor';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import { createNexusClient, NexusApiError } from '@/nexus/client';
import { QueryClient } from '@tanstack/react-query';
import { parse as parseYaml } from 'yaml';
import { graphEditorNodeGroups } from './graph-editor-mode';
import { grantCanvasGraphAccess, saveCanvasGraph, shareableCanvasGraphId } from './graph-canvas-save';
import type { CanvasSaveClient } from './graph-canvas-save';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNexusState } from '../../../../../src/nexus/state/state';
import { TabRegistry } from '../../../../../src/nexus/state/tab-registry';
import { NexusEventBus } from '../../../../../src/nexus/api/event-bus';
import { routeRequest } from '../../../../../src/nexus/api/http-server';
import { createDevProxyRuntimeRef } from '../../../../../src/nexus/api/admin-dev-proxy';
import { defaultGraphsDir } from '../../../../../src/self-implement/graph-templates';

describe('editor sharing boundary', () => {
  test('existing create/update save payloads, version result and error mapping are preserved', async () => {
    const createRunGraph = mock(async (_id: string, _yaml: string) => ({ version: 3 }));
    const putRunGraphYaml = mock(async (_id: string, _yaml: string) => ({ version: 4 }));
    const client = { createRunGraph, putRunGraphYaml } as unknown as CanvasSaveClient;
    const yaml = 'graph_id: mine\n';
    expect(await saveCanvasGraph(client, 'mine', yaml, 'create')).toEqual({ ok: true, id: 'mine', created: true, version: 3 });
    expect(createRunGraph).toHaveBeenCalledWith('mine', yaml, undefined);
    expect(await saveCanvasGraph(client, 'mine', yaml, 'update')).toEqual({ ok: true, id: 'mine', created: false, version: 4 });
    expect(putRunGraphYaml).toHaveBeenCalledWith('mine', yaml, undefined);
    createRunGraph.mockImplementationOnce(async () => { throw new NexusApiError(409, '/v1/graphs', { error: 'conflict' }); });
    expect(await saveCanvasGraph(client, 'mine', yaml, 'create')).toEqual({ ok: false, issues: [{ source: 'server', message: '«mine» 는 이미 있는 그래프 id 입니다 — 다른 id 를 쓰세요' }] });
  });
  test('GraphShareControl grants server access for a saved graph and reports an API failure', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const token = `eg_${randomBytes(32).toString('hex')}`;
    const hash = createHash('sha256').update(token).digest('hex');
    const otherToken = `eg_${randomBytes(32).toString('hex')}`;
    const rootDir = mkdtempSync(join(tmpdir(), 'w9c-editor-'));
    const prior = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = rootDir;
    mkdirSync(join(rootDir, 'graphs'), { recursive: true });
    const yaml = readFileSync(join(defaultGraphsDir(), 'research-loop.yaml'), 'utf8').replace(/^graph_id:.*$/m, 'graph_id: mine');
    writeFileSync(join(rootDir, 'graphs', 'mine.yaml'), yaml);
    const requests: string[] = [];
    let rejectGrant = false;
    const fetchImpl = mock(async (request: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method} ${request}`);
      if (rejectGrant && init?.method === 'PUT' && String(request).endsWith('/access')) return Response.json({ error: 'forbidden' }, { status: 403 });
      const bus = new NexusEventBus();
      const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
      state.bus = bus;
      return (await routeRequest(new Request(String(request), {
        method: init?.method, headers: { authorization: new Headers(init?.headers).get('authorization') ?? '', 'sec-fetch-site': 'cross-site', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
        ...(init?.body ? { body: init.body } : {}),
      }), { state, registry: new TabRegistry(state), eventBus: bus, metaApi: { bearerToken: 'owner-secret', noAuth: false } },
      { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef()))!;
    });
    const client = createNexusClient({ baseUrl: 'http://localhost', token: 'owner-secret', fetchImpl: Object.assign(fetchImpl, { preconnect: () => {} }) });
    const snapshot = { graphId: 'mine', yaml: 'graph_id: mine\n', saved: true };
    expect(shareableCanvasGraphId(snapshot)).toBe('mine');
    expect(shareableCanvasGraphId({ ...snapshot, saved: false })).toBeNull();
    let root: ReturnType<typeof create> | undefined;
    const props = { context: snapshot as Parameters<typeof GraphShareControl>[0]['context'], client };
    try {
      const peer = (method: string, path: string, body?: unknown, credential = token) => {
        const bus = new NexusEventBus();
        const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
        state.bus = bus;
        return routeRequest(new Request(`http://localhost${path}`, {
          method, headers: { authorization: `Bearer ${credential}`, 'sec-fetch-site': 'cross-site', ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }), { state, registry: new TabRegistry(state), eventBus: bus, metaApi: { bearerToken: 'owner-secret', noAuth: false } },
        { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
      };
      expect((await peer('GET', '/v1/graphs/mine/yaml'))?.status).toBe(401);
      expect((await peer('PUT', '/v1/graphs/mine/yaml', { yaml }))?.status).toBe(401);
      act(() => { root = create(<GraphShareControl {...props} />); });
      expect(root!.root.findAllByProps({ role: 'note' })).toHaveLength(0);
      act(() => {
        root!.root.findByProps({ 'aria-label': '공유용 그래프 토큰' }).props.onChange({ target: { value: token } });
        root!.root.findByProps({ 'aria-label': '공유 권한' }).props.onChange({ target: { value: 'edit' } });
      });
      expect(root!.root.findByProps({ role: 'note' }).children.join('')).toBe('상대가 바꾼 그래프를 실행하면 상대 명령이 이 기계에서 돈다 — 실행 전 승인 필요');
      await act(async () => { root!.root.findAllByType('button').at(-1)!.props.onClick(); });
      expect((await client.getRunGraphAccess('mine')).grants).toEqual([{ recipient: hash, permission: 'edit' }]);
      expect(requests.slice(0, 2)).toEqual(['PUT http://localhost/v1/graphs/mine/access', 'GET http://localhost/v1/graphs/mine/access']);
      expect((await peer('GET', '/v1/graphs/mine/yaml'))?.status).toBe(200);
      expect((await peer('PUT', '/v1/graphs/mine/yaml', { yaml }))?.status).toBe(200);
      expect((await peer('GET', '/v1/graphs/mine/yaml', undefined, otherToken))?.status).toBe(401);
      expect((await peer('GET', '/v1/graphs/mine/versions'))?.status).toBe(401);
      expect((await peer('GET', '/v1/graphs/mine/access'))?.status).toBe(401);
      expect(root!.root.findByProps({ role: 'status' }).children.join('')).toContain('편집 권한을 부여');
      rejectGrant = true;
      await act(async () => { root!.root.findAllByType('button').at(-1)!.props.onClick(); });
      expect(root!.root.findByProps({ role: 'status' }).children.join('')).toContain('권한 설정 실패');
      expect((await client.getRunGraphAccess('mine')).grants).toHaveLength(1);
      act(() => { root!.update(<GraphShareControl context={{ ...snapshot, saved: false } as typeof props.context} client={client} />); });
      expect(root!.root.findAllByType('button').at(-1)!.props.disabled).toBe(true);
    } finally {
      if (root) act(() => { root!.unmount(); });
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
      if (prior === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = prior;
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('a successful PUT without the matching server grant is not reported as shared', async () => {
    const client = {
      putRunGraphAccess: mock(async () => ({ recipient: 'expected', permission: 'edit' as const })),
      getRunGraphAccess: mock(async () => ({ grants: [] })),
    };
    await expect(grantCanvasGraphAccess(client, 'mine', 'eg_valid', 'edit')).rejects.toThrow('권한 적용을 확인할 수 없습니다');
    expect(client.putRunGraphAccess).toHaveBeenCalledWith('mine', 'eg_valid', 'edit');
    expect(client.getRunGraphAccess).toHaveBeenCalledWith('mine');
  });

  test('generated peer credential is kept in the UI until it can be given to the recipient; unsaved graphs cannot grant', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const client = { putRunGraphAccess: mock(async () => ({ recipient: '', permission: 'view' as const })), getRunGraphAccess: mock(async () => ({ grants: [] })) };
    let root: ReturnType<typeof create> | undefined;
    try {
      act(() => { root = create(<GraphShareControl context={null} client={client} />); });
      act(() => { root!.root.findAllByType('button')[0]!.props.onClick(); });
      const token = root!.root.findByProps({ 'aria-label': '공유용 그래프 토큰' }).props.value as string;
      expect(token).toMatch(/^eg_[a-f0-9]{48}$/);
      expect(root!.root.findAllByType('button').at(-1)!.props.disabled).toBe(true);
      expect(client.putRunGraphAccess).not.toHaveBeenCalled();
    } finally {
      if (root) act(() => { root!.unmount(); });
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });
});

const palette: GraphKindEntry[] = [
  { graph: 'workflow', kind: 'bash', plugin: null, description: 'Bash node', schema: {}, core: true },
  { graph: 'workflow', kind: 'custom', plugin: 'demo', description: 'Custom node', schema: {}, core: false },
  { graph: 'harness', kind: 'agent', plugin: null, description: 'Harness node', schema: {}, core: true },
];
const groups = graphEditorNodeGroups(palette);

describe('GraphEditorPalette', () => {
  beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
  afterEach(() => { delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

  test('collapses the phone palette below 640px and groups both wire kinds on the wide palette', () => {
    let root: ReturnType<typeof create> | undefined;
    try {
      act(() => { root = create(<GraphEditorPalette groups={groups} />); });
      const details = root!.root.findByType('details');
      const wide = root!.root.findAllByProps({ 'aria-label': '노드 팔레트' }).find((node) => node.type === 'div')!;
      expect(details.props.open).toBeUndefined();
      expect(details.props.className).toContain('min-[640px]:hidden');
      expect(details.findByType('summary').children).toEqual(['노드 더하기 (', '3', ')']);
      expect(wide.props.className).toContain('hidden');
      expect(wide.props.className).toContain('min-[640px]:block');
      for (const container of [details, wide]) {
        expect(container.findByType('strong').children).toEqual(['노드 팔레트']);
        const sections = container.findAllByType('section');
        expect(sections.map((section) => section.props['aria-label'])).toEqual(['작업 노드', '실행 단계 노드']);
        expect(sections.map((section) => section.findAllByType('span').filter((node) => node.props['data-graph']).map((node) => [node.props.title, node.props['data-graph']]))).toEqual([
          [['Bash node', 'workflow'], ['Custom node', 'workflow']], [['Harness node', 'harness']],
        ]);
        expect(container.findByType('small').children).toEqual(['demo']);
      }
    } finally {
      if (root) act(() => { root!.unmount(); });
    }
  });

  test('both grouped palette actions carry their wire identity without switching or clearing the canvas', () => {
    const added: string[] = [];
    let root: ReturnType<typeof create> | undefined;
    try {
      act(() => { root = create(<GraphEditorPalette groups={groups} onAdd={(entry) => added.push(`${entry.graph}:${entry.kind}`)} />); });
      const wide = root!.root.findAllByProps({ 'aria-label': '노드 팔레트' }).find((node) => node.type === 'div')!;
      const buttons = wide.findAllByType('button');
      expect(buttons.map((button) => button.props['data-graph'])).toEqual(['workflow', 'workflow', 'harness']);
      act(() => { buttons[0]!.props.onClick(); buttons[2]!.props.onClick(); });
      expect(added).toEqual(['workflow:bash', 'harness:agent']);
      expect(wide.findAllByType('section')).toHaveLength(2);
    } finally {
      if (root) act(() => { root!.unmount(); });
    }
  });

  test('shows the independent core fallback notice in both responsive palettes', () => {
    let root: ReturnType<typeof create> | undefined;
    try {
      const partial = graphEditorNodeGroups(palette.filter((entry) => entry.graph === 'workflow'));
      act(() => { root = create(<GraphEditorPalette groups={partial} />); });
      expect(root!.root.findAllByProps({ role: 'status' })).toHaveLength(2);
      expect(root!.root.findByType('summary').children).toEqual(['노드 더하기 (', String(partial[0]!.kinds.length + partial[1]!.kinds.length), ')']);
      expect(partial[0]!.fallback).toBe(false);
      expect(partial[1]!.kinds.every((entry) => entry.graph === 'harness')).toBe(true);
    } finally {
      if (root) act(() => { root!.unmount(); });
    }
  });

  test('existing workflow and saved harness graph routes remain reachable alongside the shared canvas', async () => {
    const client = createNexusClient({ baseUrl: 'http://localhost', fetchImpl: (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/graph/kinds') return Response.json({ kinds: palette.filter((entry) => new URL(String(input)).searchParams.get('graph') === entry.graph) });
      return Response.json({ graphs: [], workflows: [] });
    }) as typeof fetch });
    let root: ReturnType<typeof create> | undefined;
    const hadWindow = 'window' in globalThis;
    const priorWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { addEventListener() {}, removeEventListener() {}, history: { replaceState() {} } };
    try {
      await act(async () => { root = create(<NexusProvider client={client} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><GraphEditor /></NexusProvider>); });
      expect(root!.root.findAllByType(ReactFlow)).toHaveLength(1);
      const buttons = root!.root.findAllByType('button');
      await act(async () => { buttons.find((button) => button.children.includes('워크플로 목록'))!.props.onClick(); });
      expect(root!.root.findAllByType(WorkflowsPanel)).toHaveLength(1);
      expect(root!.root.findAllByType(GraphWizardEntry)).toHaveLength(1);
      await act(async () => { root!.root.findAllByType('button').find((button) => button.children.includes('실행 그래프 목록'))!.props.onClick(); });
      const list = root!.root.findByType(RunGraphView);
      expect(typeof list.props.onOpenInCanvas).toBe('function');
      expect(typeof list.props.onNewGraph).toBe('function');
      await act(async () => { list.props.onOpenInCanvas('saved', 'graph_id: saved\nentry_node: step\nterminal_nodes: [step]\nnodes:\n  - node_id: step\n    kind: agent\n    recipe: cmd:step\n'); });
      expect(root!.root.findByType(GraphCanvasEditor).props.initialGraph.graphId).toBe('saved');
      expect(root!.root.findByType(GraphCanvasEditor).props.initialSaved).toBe(true);
      expect(typeof root!.root.findByType(GraphCanvasEditor).props.renderActions).toBe('function');
      await act(async () => { root!.root.findAllByType('button').find((button) => button.children.includes('통합 캔버스'))!.props.onClick(); });
      expect(root!.root.findByType(ReactFlow).props.nodes).toHaveLength(0);
    } finally {
      if (root) await act(async () => { root!.unmount(); });
      if (hadWindow) (globalThis as { window?: unknown }).window = priorWindow;
      else delete (globalThis as { window?: unknown }).window;
    }
  });

  test('deleting a node and an edge changes only that kind’s validated and saved wire graph', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const client = createNexusClient({ baseUrl: 'http://localhost', fetchImpl: (async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
      if (path === '/v1/graph/kinds') return Response.json({ kinds: palette.filter((entry) => new URL(String(input)).searchParams.get('graph') === entry.graph) });
      if (path === '/v1/graphs/validate') return Response.json({ ok: true, errors: [], ignoredKeys: [] });
      return Response.json({ ok: true, id: 'steps', version: 1 });
    }) as typeof fetch });
    let root: ReturnType<typeof create> | undefined;
    const hadWindow = 'window' in globalThis;
    const priorWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { addEventListener() {}, removeEventListener() {} };
    try {
      await act(async () => { root = create(<NexusProvider client={client} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><GraphEditor /></NexusProvider>); });
      for (const graph of ['workflow', 'harness']) for (let i = 0; i < 2; i++) await act(async () => {
        const button = root!.root.findAllByProps({ 'aria-label': '노드 팔레트' }).find((node) => node.type === 'div')!
          .findAllByType('button').find((item) => item.props['data-graph'] === graph && item.children.includes(graph === 'workflow' ? 'bash' : 'agent'))!;
        button.props.onClick();
      });
      const flow = () => root!.root.findByType(ReactFlow);
      expect(flow().props.nodes.map((node: { id: string }) => node.id)).toEqual(['workflow-bash-1', 'workflow-bash-2', 'harness-agent-1', 'harness-agent-2']);
      await act(async () => { flow().props.onConnect({ source: 'workflow-bash-1', target: 'workflow-bash-2' }); flow().props.onConnect({ source: 'harness-agent-1', target: 'harness-agent-2' }); flow().props.onConnect({ source: 'workflow-bash-1', target: 'harness-agent-1' }); });
      expect(flow().props.edges).toHaveLength(2);
      await act(async () => { flow().props.onEdgesChange([{ type: 'remove', id: 'workflow-bash-1:workflow-bash-2' }]); flow().props.onNodesChange([{ type: 'remove', id: 'harness-agent-2' }]); });
      expect(flow().props.nodes.map((node: { id: string }) => node.id)).toEqual(['workflow-bash-1', 'workflow-bash-2', 'harness-agent-1']);
      expect(flow().props.edges).toHaveLength(0);
      const sections = root!.root.findAllByType('section').filter((node) => String(node.props['aria-label']).endsWith('검증과 저장'));
      await act(async () => { sections[0]!.findByType('input').props.onChange({ target: { value: 'tasks' } }); sections[1]!.findByType('input').props.onChange({ target: { value: 'steps' } }); });
      for (const section of sections) {
        await act(async () => { section.findAllByType('button')[0]!.props.onClick(); });
        await act(async () => { section.findAllByType('button')[1]!.props.onClick(); });
      }
      const validated = requests.filter((request) => request.path === '/v1/graphs/validate');
      expect(validated.map((request) => [request.body.graph, (parseYaml(String(request.body.yaml)) as { nodes: unknown[]; edges?: unknown[] }).nodes.length])).toEqual([
        ['workflow', 2], ['workflow', 2], ['harness', 1], ['harness', 1],
      ]);
      expect(validated.every((request) => !(parseYaml(String(request.body.yaml)) as { edges?: unknown[] }).edges?.length)).toBe(true);
      expect(requests.find((request) => request.path === '/v1/workflows/tasks')?.body.yaml).toBe(validated[1]!.body.yaml);
      expect(requests.find((request) => request.path === '/v1/graphs')?.body.yaml).toBe(validated[3]!.body.yaml);
    } finally {
      if (root) await act(async () => { root!.unmount(); });
      if (hadWindow) (globalThis as { window?: unknown }).window = priorWindow;
      else delete (globalThis as { window?: unknown }).window;
    }
  });

  test('subworkflow reference is required and the entered value is sent unchanged to validation and save', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const client = createNexusClient({ baseUrl: 'http://localhost', fetchImpl: (async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
      if (path === '/v1/graph/kinds') return Response.json({ kinds: new URL(String(input)).searchParams.get('graph') === 'workflow' ? [{ graph: 'workflow', kind: 'subworkflow', description: '', plugin: null, core: true }] : [] });
      if (path === '/v1/graphs/validate') return Response.json({ ok: true, errors: [], ignoredKeys: [] });
      return Response.json({ ok: true });
    }) as typeof fetch });
    let root: ReturnType<typeof create> | undefined;
    const hadWindow = 'window' in globalThis;
    const priorWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { addEventListener() {}, removeEventListener() {} };
    try {
      await act(async () => { root = create(<NexusProvider client={client} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><GraphEditor /></NexusProvider>); });
      const wide = root!.root.findAllByProps({ 'aria-label': '노드 팔레트' }).find((node) => node.type === 'div')!;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(wide.findAllByType('button').map((button) => button.props['aria-label'])).toContain('작업 노드 subworkflow 추가');
      await act(async () => { wide.findAllByType('button').find((button) => button.props['aria-label'] === '작업 노드 subworkflow 추가')!.props.onClick(); });
      expect(root!.root.findByType(ReactFlow).props.nodes.map((node: { data: { kind: string } }) => node.data.kind)).toEqual(['subworkflow']);
      const section = root!.root.findAllByType('section').find((node) => node.props['aria-label'] === '작업 노드 검증과 저장')!;
      await act(async () => { section.findByType('input').props.onChange({ target: { value: 'tasks' } }); });
      await act(async () => { section.findAllByType('button')[1]!.props.onClick(); });
      expect(requests.filter((request) => request.path === '/v1/graphs/validate')).toHaveLength(0);
      expect(section.findByProps({ role: 'status' }).children.join('')).toContain('참조 워크플로');
      await act(async () => { root!.root.findByProps({ 'aria-label': 'workflow-subworkflow-1 참조 워크플로' }).props.onChange({ target: { value: 'real-target' } }); });
      await act(async () => { section.findAllByType('button')[0]!.props.onClick(); });
      await act(async () => { section.findAllByType('button')[1]!.props.onClick(); });
      const validated = requests.filter((request) => request.path === '/v1/graphs/validate');
      expect(validated.map((request) => (parseYaml(String(request.body.yaml)) as { nodes: Array<{ workflow: string }> }).nodes[0]?.workflow)).toEqual(['real-target', 'real-target']);
      expect(requests.find((request) => request.path === '/v1/workflows/tasks')?.body.yaml).toBe(validated[1]!.body.yaml);
    } finally {
      if (root) await act(async () => { root!.unmount(); });
      if (hadWindow) (globalThis as { window?: unknown }).window = priorWindow;
      else delete (globalThis as { window?: unknown }).window;
    }
  });

  test('real editor keeps both kinds on one canvas and validates and saves each wire graph', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const client = createNexusClient({ baseUrl: 'http://localhost', fetchImpl: (async (input, init) => {
      const path = new URL(String(input)).pathname + new URL(String(input)).search;
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ path, body });
      if (path.startsWith('/v1/graph/kinds')) return Response.json({ kinds: palette.filter((entry) => path.endsWith(`graph=${entry.graph}`)) });
      if (path === '/v1/graphs/validate') return Response.json({ ok: true, errors: [], ignoredKeys: [] });
      return Response.json({ ok: true, id: 'steps', version: 1 });
    }) as typeof fetch });
    let root: ReturnType<typeof create> | undefined;
    const hadWindow = 'window' in globalThis;
    const priorWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { addEventListener() {}, removeEventListener() {} };
    try {
      await act(async () => { root = create(<NexusProvider client={client} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><GraphEditor /></NexusProvider>); });
      const wide = root!.root.findAllByProps({ 'aria-label': '노드 팔레트' }).find((node) => node.type === 'div')!;
      const sections = wide.findAllByType('section');
      expect(sections.map((section) => section.props['aria-label'])).toEqual(['작업 노드', '실행 단계 노드']);
      await act(async () => { sections[0]!.findAllByType('button')[0]!.props.onClick(); sections[1]!.findAllByType('button')[0]!.props.onClick(); });
      const flow = root!.root.findByType(ReactFlow);
      expect(flow.props.nodes.map((node: { data: { graph: string } }) => node.data.graph)).toEqual(['workflow', 'harness']);
      const names = root!.root.findAllByType('input');
      await act(async () => {
        names[0]!.props.onChange({ target: { value: 'tasks' } });
        names[1]!.props.onChange({ target: { value: 'steps' } });
      });
      for (const section of root!.root.findAllByType('section').filter((node) => String(node.props['aria-label']).endsWith('검증과 저장'))) {
        await act(async () => { section.findAllByType('button')[0]!.props.onClick(); });
        await act(async () => { section.findAllByType('button')[1]!.props.onClick(); });
      }
      const validated = requests.filter((request) => request.path === '/v1/graphs/validate');
      expect(validated.map((request) => request.body.graph)).toEqual(['workflow', 'workflow', 'harness', 'harness']);
      expect(validated.map((request) => (parseYaml(String(request.body.yaml)) as { nodes: unknown[] }).nodes.length)).toEqual([1, 1, 1, 1]);
      expect(requests.find((request) => request.path === '/v1/workflows/tasks')?.body).toMatchObject({ scope: 'project', yaml: validated[1]!.body.yaml });
      expect(requests.find((request) => request.path === '/v1/graphs')?.body).toMatchObject({ id: 'steps', yaml: validated[3]!.body.yaml });
      expect(root!.root.findByType(ReactFlow).props.nodes).toHaveLength(2);
      expect(requests.filter((request) => request.path.startsWith('/v1/graph/kinds')).map((request) => request.path).sort()).toEqual([
        '/v1/graph/kinds?graph=harness', '/v1/graph/kinds?graph=workflow',
      ]);
    } finally {
      if (root) await act(async () => { root!.unmount(); });
      if (hadWindow) (globalThis as { window?: unknown }).window = priorWindow;
      else delete (globalThis as { window?: unknown }).window;
    }
  });
});
