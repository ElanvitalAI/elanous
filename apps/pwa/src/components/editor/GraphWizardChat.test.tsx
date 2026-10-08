import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { createNexusClient } from '@/nexus/client';
import { isQuiet } from '@/lib/quiet-surface';
import { fromYaml, toYaml, type CanvasGraph } from './graph-canvas-model';
import { GraphWizardChat, GraphWizardEntry, type CanvasSnapshot } from './GraphWizardChat';
import { askWizard, mergeWizardGraph, userMovedNodes, wizardPhase, wizardRequest, WIZARD_UNSUPPORTED, type WizardClient, type WizardDiff } from './graph-wizard';

const CREATE_YAML = `graph_id: news-digest
entry_node: fetch
terminal_nodes: [send]
nodes:
  - node_id: fetch
    kind: agent
    recipe: cmd:fetch
  - node_id: send
    kind: agent
    recipe: cmd:send
edges:
  - from: fetch
    to: send
`;

const EDIT_YAML = `graph_id: news-digest
entry_node: fetch
terminal_nodes: [send]
nodes:
  - node_id: fetch
    kind: agent
    recipe: cmd:fetch
  - node_id: summarize
    kind: agent
    recipe: cmd:summarize
  - node_id: send
    kind: agent
    recipe: cmd:send
edges:
  - from: fetch
    to: summarize
  - from: summarize
    to: send
`;

type Call = { url: string; body: Record<string, unknown> };
type Reply = { status: number; body: unknown } | 'hang';

function mockFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    const reply = replies.shift() ?? { status: 500, body: {} };
    if (reply === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const nexus = createNexusClient({ baseUrl: 'http://daemon', fetchImpl });
  const client: WizardClient = { graphWizard: (body, opts) => nexus.graphWizard!(body, opts) };
  return { calls, client };
}

/** A stand-in canvas: keeps the graph the chat pushed, like GraphEditor → GraphCanvasEditor does. */
function harness(replies: Reply[], initialPrompt?: string) {
  const { calls, client } = mockFetch(replies);
  const state: { graph: CanvasGraph | null; added: WizardDiff | null; restores: number } = { graph: null, added: null, restores: 0 };
  const current = (): CanvasSnapshot | null => state.graph ? { graph: state.graph, yaml: toYaml(state.graph) } : null;
  let root!: ReturnType<typeof create>;
  act(() => {
    root = create(<GraphWizardChat client={client} current={current}
      onApply={(graph, added) => { state.graph = graph; state.added = added; }}
      onRestore={(graph) => { state.graph = graph; state.restores += 1; }}
      {...(initialPrompt ? { initialPrompt } : {})} />);
  });
  return { calls, state, root };
}

const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
const buttons = (root: ReactTestInstance, label: string) => root.findAllByType('button').filter((button) => text(button) === label);

async function say(root: ReactTestInstance, prompt: string) {
  await act(async () => { root.findByProps({ 'aria-label': '만들고 싶은 일' }).props.onChange({ target: { value: prompt } }); });
  await act(async () => { root.findByType('form').props.onSubmit({ preventDefault() {} }); await Bun.sleep(5); });
}

describe('GRAPH-WIZARD chat', () => {
  beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
  afterEach(() => { delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

  test('create → edit grows the same canvas (current YAML + history sent), then undo puts the previous canvas back', async () => {
    const { calls, state, root } = harness([
      { status: 200, body: { ok: true, id: 'news-digest', yaml: CREATE_YAML, base: 'daily-digest', issues: [], attempts: 1, summary: '노드 2개 추가 — fetch → send' } },
      { status: 200, body: { ok: true, id: 'news-digest', yaml: EDIT_YAML, base: 'daily-digest', issues: [], attempts: 2, summary: '노드 1개 추가 — summarize' } },
    ]);
    await say(root.root, '매일 아침 AI 뉴스 요약해서 텔레그램으로');
    expect(calls[0]!.url).toBe('http://daemon/v1/graphs/wizard');
    expect(calls[0]!.body).toEqual({ prompt: '매일 아침 AI 뉴스 요약해서 텔레그램으로', kind: 'harness' });
    expect(state.graph!.nodes.map((node) => node.id)).toEqual(['fetch', 'send']);
    expect(state.added).toEqual({ nodes: ['fetch', 'send'], edges: ['fetch->send:'] });
    expect(text(root.root.findAllByProps({ 'data-testid': 'wizard-status' })[0]!)).toContain('초안 · 기반 템플릿 daily-digest · 검증 통과(시도 1)');
    expect(text(root.root)).toContain('노드 2개 추가 — fetch → send');

    // The user moved «fetch» on the canvas; the next turn must keep it there.
    state.graph = { ...state.graph!, nodes: state.graph!.nodes.map((node) => node.id === 'fetch' ? { ...node, x: 999, y: 777 } : node) };
    const afterCreate = state.graph;
    await say(root.root, '요약 단계를 넣어줘');
    expect(calls[1]!.body.currentYaml).toBe(toYaml(afterCreate));
    expect(calls[1]!.body.history).toEqual([
      { role: 'user', text: '매일 아침 AI 뉴스 요약해서 텔레그램으로' },
      { role: 'assistant', text: '노드 2개 추가 — fetch → send' },
    ]);
    expect(state.graph!.nodes.map((node) => node.id)).toEqual(['fetch', 'summarize', 'send']);
    expect(state.graph!.nodes.find((node) => node.id === 'fetch')).toMatchObject({ x: 999, y: 777 });
    expect(state.added).toEqual({ nodes: ['summarize'], edges: ['fetch->summarize:', 'summarize->send:'] });

    const undos = buttons(root.root, '되돌리기');
    expect(undos).toHaveLength(2);
    await act(async () => { undos[1]!.props.onClick(); });
    expect(state.graph).toBe(afterCreate);
    expect(buttons(root.root, '되돌리기')).toHaveLength(1);
    expect(text(root.root)).toContain('되돌림');
    // Undo of the first turn empties the canvas again.
    await act(async () => { buttons(root.root, '되돌리기')[0]!.props.onClick(); });
    expect(state.graph).toBeNull();
    act(() => root.unmount());
  });

  test('after undo, the undone turn leaves the history and the next turn edits the restored canvas', async () => {
    const { calls, state, root } = harness([
      { status: 200, body: { ok: true, yaml: CREATE_YAML, base: 'daily-digest', issues: [], attempts: 1, summary: 'T1' } },
      { status: 200, body: { ok: true, yaml: EDIT_YAML, base: 'daily-digest', issues: [], attempts: 1, summary: 'T2' } },
      { status: 200, body: { ok: true, yaml: EDIT_YAML, base: 'daily-digest', issues: [], attempts: 1, summary: 'T3' } },
    ]);
    await say(root.root, '첫 말');
    const afterFirst = state.graph;
    await say(root.root, '둘째 말');
    await act(async () => { buttons(root.root, '되돌리기')[1]!.props.onClick(); });
    expect(state.graph).toBe(afterFirst);
    await say(root.root, '셋째 말');
    expect(calls[2]!.body.currentYaml).toBe(toYaml(afterFirst!));
    expect(calls[2]!.body.history).toEqual([{ role: 'user', text: '첫 말' }, { role: 'assistant', text: 'T1' }]);
    act(() => root.unmount());
  });

  test('«다시 만들기» resends the same words against the canvas before that turn, without the undone turn in history', async () => {
    const { calls, root } = harness([
      { status: 200, body: { ok: true, yaml: CREATE_YAML, issues: [], attempts: 1, summary: 'T1' } },
      { status: 200, body: { ok: true, yaml: EDIT_YAML, issues: [], attempts: 1, summary: 'T2' } },
      { status: 200, body: { ok: true, yaml: EDIT_YAML, issues: [], attempts: 1, summary: 'T2b' } },
    ]);
    await say(root.root, '첫 말');
    await say(root.root, '둘째 말');
    await act(async () => { buttons(root.root, '다시 만들기')[1]!.props.onClick(); await Bun.sleep(5); });
    expect(calls[2]!.body.prompt).toBe('둘째 말');
    expect(calls[2]!.body.currentYaml).toBe(calls[1]!.body.currentYaml);
    expect(calls[2]!.body.history).toEqual([{ role: 'user', text: '첫 말' }, { role: 'assistant', text: 'T1' }]);
    act(() => root.unmount());
  });

  test('on a phone width the sheet folds to a one-line bar after a turn (the canvas is the point); the chat holds the screen quiet', async () => {
    const g = globalThis as Record<string, unknown>;
    const hadWindow = 'window' in g;
    if (!hadWindow) g.window = { matchMedia: () => ({ matches: true }) };
    try {
      const { root } = harness([{ status: 200, body: { ok: true, yaml: CREATE_YAML, issues: [], attempts: 1, summary: '노드 2개 추가' } }]);
      expect(isQuiet()).toBe(true);
      await say(root.root, '매일 아침 AI 뉴스 요약해서 텔레그램으로');
      expect(text(root.root.findByProps({ 'data-testid': 'wizard-collapsed-line' }))).toBe('노드 2개 추가');
      const toggle = root.root.findAllByType('button').find((button) => button.props['aria-expanded'] !== undefined)!;
      expect(toggle.props['aria-expanded']).toBe(false);
      act(() => root.unmount());
      expect(isQuiet()).toBe(false);
    } finally {
      if (!hadWindow) delete g.window;
    }
  });

  test('422: the draft still lands on the canvas, the issues are listed, «고쳐서 다시» prefills the fix', async () => {
    const { state, root } = harness([
      { status: 422, body: { ok: false, id: 'pr-merge', yaml: CREATE_YAML, base: 'pr-review', issues: ["끝 노드 'send' 에 들어오는 간선이 없다", { message: 'recipe 없음', nodeId: 'fetch' }], attempts: 3, summary: '노드 2개 — 검증 실패' } },
    ]);
    await say(root.root, 'PR 리뷰하고 문제 없으면 머지');
    expect(state.graph!.nodes).toHaveLength(2);
    const issues = root.root.findByProps({ 'data-testid': 'wizard-issues' });
    expect(text(issues)).toContain("끝 노드 'send' 에 들어오는 간선이 없다");
    expect(text(issues)).toContain('fetch: recipe 없음');
    expect(text(root.root.findByProps({ 'data-testid': 'wizard-status' }))).toContain('검증 실패 2건(시도 3)');
    await act(async () => { buttons(root.root, '고쳐서 다시')[0]!.props.onClick(); });
    expect(root.root.findByProps({ 'aria-label': '만들고 싶은 일' }).props.value).toBe('검증 오류를 고쳐줘');
    act(() => root.unmount());
  });

  test('an older daemon (404) says the server needs an update and leaves the canvas alone', async () => {
    const { state, root } = harness([{ status: 404, body: { error: 'not-found' } }]);
    await say(root.root, '조사해서 표로 정리하고 내가 승인하면 게시');
    expect(state.graph).toBeNull();
    expect(text(root.root)).toContain('이 Daemon 이 아직 그래프 마법사를 지원하지 않습니다');
    act(() => root.unmount());
  });

  test('an empty prompt never reaches the daemon', async () => {
    const { calls, root } = harness([]);
    await say(root.root, '   ');
    expect(calls).toHaveLength(0);
    expect(text(root.root)).toContain('무엇을 만들지 한 줄로 적어 주세요');
    act(() => root.unmount());
  });

  test('while generating it shows elapsed seconds and «취소» aborts the request', async () => {
    const { calls, state, root } = harness(['hang'], '매일 아침 AI 뉴스 요약해서 텔레그램으로');
    await act(async () => { await Bun.sleep(1_100); });
    expect(calls).toHaveLength(1);
    const pending = root.root.findByProps({ 'data-testid': 'wizard-pending' });
    expect(text(pending)).toMatch(/요청을 읽는 중…[1-9]초/);
    await act(async () => { buttons(root.root, '취소')[0]!.props.onClick(); await Bun.sleep(5); });
    expect(root.root.findAllByProps({ 'data-testid': 'wizard-pending' })).toHaveLength(0);
    expect(text(root.root)).toContain('취소했습니다');
    expect(state.graph).toBeNull();
    act(() => root.unmount());
  });

  test('the entry card starts with a chip or the typed line, and refuses an empty one', () => {
    const started: string[] = [];
    let root!: ReturnType<typeof create>;
    act(() => { root = create(<GraphWizardEntry onStart={(prompt) => started.push(prompt)} />); });
    act(() => { buttons(root.root, 'PR 리뷰하고 문제 없으면 머지')[0]!.props.onClick(); });
    act(() => { root.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    expect(started).toEqual(['PR 리뷰하고 문제 없으면 머지']);
    expect(text(root.root)).toContain('무엇을 만들지 한 줄로 적어 주세요');
    act(() => root.unmount());
  });
});

describe('GRAPH-WIZARD helpers', () => {
  test('history is capped at the last ten turns and currentYaml is omitted for an empty canvas', () => {
    const turns = Array.from({ length: 14 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, text: `t${index}` }));
    const body = wizardRequest('  더  ', null, turns);
    expect(body.prompt).toBe('더');
    expect(body.currentYaml).toBeUndefined();
    expect(body.history).toHaveLength(10);
    expect(body.history![0]!.text).toBe('t4');
  });

  test('400 «prompt required» reads as empty; any other 400 shows the server reason', async () => {
    const empty = mockFetch([{ status: 400, body: { error: 'bad_request', reason: 'prompt required' } }]);
    expect(await askWizard(empty.client, { prompt: 'x' })).toEqual({ kind: 'empty' });
    const other = mockFetch([{ status: 400, body: { error: 'bad_request', reason: 'currentYaml must be a string' } }]);
    expect(await askWizard(other.client, { prompt: 'x' })).toEqual({ kind: 'error', message: '요청을 받지 않았습니다 — currentYaml must be a string' });
  });

  test('405 is an older daemon too; an unparsable draft is reported, not thrown', async () => {
    const old = mockFetch([{ status: 405, body: null }]);
    expect(await askWizard(old.client, { prompt: 'x' })).toEqual({ kind: 'unsupported' });
    const bad = mockFetch([{ status: 422, body: { ok: false, yaml: '- just\n- a list', issues: ['bad'] } }]);
    const outcome = await askWizard(bad.client, { prompt: 'x' });
    expect(outcome.kind).toBe('draft');
    if (outcome.kind === 'draft') { expect(outcome.graph).toBeNull(); expect(outcome.parseError).toBeTruthy(); }
    expect(WIZARD_UNSUPPORTED).toContain('서버 업데이트 후');
  });

  test('auto layout until the user moves a node; phase text follows elapsed time', () => {
    const laid = fromYaml(CREATE_YAML);
    expect(userMovedNodes(null, null)).toBe(false);
    expect(userMovedNodes(laid, laid)).toBe(false);
    expect(userMovedNodes(laid, { ...laid, nodes: laid.nodes.map((node, i) => i === 0 ? { ...node, x: node.x + 1 } : node) })).toBe(true);
    expect(userMovedNodes(null, laid)).toBe(true);
    const fresh = mergeWizardGraph({ ...laid, nodes: laid.nodes.map((node) => ({ ...node, x: 999 })) }, fromYaml(EDIT_YAML), { keepPositions: false });
    expect(fresh.graph.nodes.find((node) => node.id === 'fetch')!.x).not.toBe(999);
    expect([wizardPhase(0), wizardPhase(5), wizardPhase(15), wizardPhase(40)]).toEqual(['요청을 읽는 중…', '노드 구성 중…', '간선 잇는 중…', '검증하고 고치는 중…']);
  });

  test('merge keeps positions of ids that survive and reports only what is new', () => {
    const before = fromYaml(CREATE_YAML);
    const moved = { ...before, nodes: before.nodes.map((node) => ({ ...node, x: node.x + 5 })) };
    const merged = mergeWizardGraph(moved, fromYaml(EDIT_YAML));
    expect(merged.graph.nodes.find((node) => node.id === 'send')!.x).toBe(moved.nodes.find((node) => node.id === 'send')!.x);
    expect(merged.added.nodes).toEqual(['summarize']);
  });
});
