import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { createNexusClient, type GraphKindEntry, type NexusClient } from '@/nexus/client';
import { GraphCanvasEditor, type GraphCanvasContext } from './GraphCanvasEditor';
import { GraphWizardChat } from './GraphWizardChat';
import { useWizardCanvas } from './use-wizard-canvas';
import type { WizardClient } from './graph-wizard';

/** GRAPH-WIZARD review must-fix ①: the chat ↔ canvas wiring is exercised through the REAL `GraphCanvasEditor`
 *  and the same `useWizardCanvas` hook `GraphEditor` uses — not a stand-in canvas. */

const T1 = `graph_id: ai-news
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
const T2 = T1.replace('terminal_nodes: [send]', 'terminal_nodes: [send]').replace(`  - node_id: send`, `  - node_id: approve
    kind: hitl
    recipe: cmd:approve
  - node_id: send`).replace(`  - from: fetch
    to: send`, `  - from: fetch
    to: approve
  - from: approve
    to: send`);

const palette: GraphKindEntry[] = ['agent', 'hitl'].map((kind) => ({ graph: 'harness', kind, plugin: null, description: '', schema: {}, core: true }));

const noop = () => {};
const createNodeMock = () => ({
  closest: () => null, querySelector: () => null, querySelectorAll: () => [], contains: () => false, getRootNode: () => null,
  focus: noop, blur: noop, scrollTo: noop, addEventListener: noop, removeEventListener: noop, setAttribute: noop,
  getBoundingClientRect: () => ({ width: 1000, height: 600, top: 0, left: 0, right: 1000, bottom: 600, x: 0, y: 0 }),
  clientWidth: 1000, clientHeight: 600, offsetWidth: 1000, offsetHeight: 600, style: {}, ownerDocument: globalThis.document,
});

function setup(replies: Array<{ status: number; body: unknown }>, wizardMode = false) {
  const calls: Array<Record<string, unknown>> = [];
  const saves: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/v1/graphs/wizard')) {
      calls.push(JSON.parse(String(init?.body ?? '{}')));
      const reply = replies.shift()!;
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }
    if (String(url).endsWith('/yaml') && init?.method === 'PUT') {
      saves.push(JSON.parse(String(init.body ?? '{}')));
      return new Response(JSON.stringify({ id: 'ai-news', source: 'mine', editable: true, saved: true, version: 2 }), { status: 200 });
    }
    if (String(url).endsWith('/v1/graphs') && init?.method === 'POST') {
      saves.push(JSON.parse(String(init.body ?? '{}')));
      return new Response(JSON.stringify({ id: 'ai-news', source: 'mine', editable: true, saved: true, version: 1 }), { status: 201 });
    }
    if (String(url).endsWith('/v1/graphs')) return new Response(JSON.stringify({ graphs: [] }), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const nexus = createNexusClient({ baseUrl: 'http://daemon', fetchImpl });
  const wizardClient: WizardClient = { graphWizard: (body, opts) => nexus.graphWizard!(body, opts) };
  const seen: { context: GraphCanvasContext | null } = { context: null };
  function Editor({ client }: { client: NexusClient }) {
    const wizard = useWizardCanvas(50);
    return <>
      <GraphCanvasEditor palette={palette} client={client} wizardMode={wizardMode}
        {...(wizard.replace ? { replace: wizard.replace } : {})}
        {...(wizard.highlight ? { highlight: wizard.highlight } : {})}
        nodeLabels={wizard.labels}
        {...(wizard.steps ? { wizardSteps: wizard.steps } : {})}
        onChange={(context) => { wizard.onChange(context); seen.context = context; }} />
      <GraphWizardChat client={wizardClient} current={wizard.current} laid={wizard.laid} onApply={wizard.apply} onRestore={wizard.restore} />
    </>;
  }
  let root!: ReturnType<typeof create>;
  act(() => { root = create(<Editor client={nexus} />, { createNodeMock }); });
  return { root, calls, seen, saves };
}

const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
const buttons = (root: ReactTestInstance, label: string) => root.findAllByType('button').filter((button) => text(button) === label);
async function say(root: ReactTestInstance, prompt: string) {
  const chat = root.findByProps({ 'data-testid': 'graph-wizard-chat' });
  await act(async () => { chat.findByProps({ 'aria-label': '만들고 싶은 일' }).props.onChange({ target: { value: prompt } }); });
  await act(async () => { chat.findByType('form').props.onSubmit({ preventDefault() {} }); await Bun.sleep(10); });
}

describe('GRAPH-WIZARD chat ↔ real canvas', () => {
  // No DOM in this repo's `bun test`: ReactFlow only needs a window that takes listeners. Restored after each test.
  const g = globalThis as Record<string, unknown>;
  let hadWindow = false;
  let hadResize = false;
  let hadRaf = false;
  beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    hadWindow = 'window' in g;
    hadRaf = 'requestAnimationFrame' in g;
    if (!hadRaf) g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
    hadResize = 'ResizeObserver' in g;
    if (!hadResize) g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    if (!hadWindow) g.window = { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: (id: number) => clearTimeout(id), addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) };
  });
  afterEach(() => {
    delete g.IS_REACT_ACT_ENVIRONMENT;
    if (!hadWindow) delete g.window;
    if (!hadResize) delete g.ResizeObserver;
    if (!hadRaf) delete g.requestAnimationFrame;
  });

  test('create → edit lands on the canvas (its YAML goes back as currentYaml) → undo restores it', async () => {
    const { root, calls, seen } = setup([
      { status: 200, body: { ok: true, yaml: T1, base: 'daily-digest', issues: [], attempts: 1, summary: '노드 2개 추가' } },
      { status: 200, body: { ok: true, yaml: T2, base: 'daily-digest', issues: [], attempts: 1, summary: '승인 노드 추가' } },
    ]);
    await say(root.root, '매일 아침 AI 뉴스 요약해서 텔레그램으로');
    expect(calls[0]!.currentYaml).toBeUndefined();
    expect(seen.context!.graph.nodes.map((node) => node.id)).toEqual(['fetch', 'send']);
    expect(seen.context!.graphId).toBe('ai-news');
    const afterT1 = seen.context!;

    await say(root.root, '보내기 전에 내가 승인하게 해줘');
    expect(calls[1]!.currentYaml).toBe(afterT1.yaml);
    expect(seen.context!.graph.nodes.map((node) => node.id)).toEqual(['fetch', 'approve', 'send']);
    // The canvas paints the new node as «just added».
    expect(JSON.stringify(root.toJSON())).toContain('graph-wizard-new');
    await act(async () => { await Bun.sleep(80); });
    expect(JSON.stringify(root.toJSON())).not.toContain('graph-wizard-new');

    await act(async () => { buttons(root.root, '되돌리기')[1]!.props.onClick(); await Bun.sleep(5); });
    expect(seen.context!.yaml).toBe(afterT1.yaml);
    expect(seen.context!.graph.nodes.map((node) => node.id)).toEqual(['fetch', 'send']);
    act(() => root.unmount());
  });

  test('wizard mode gives the canvas the width: no properties panel until something is selected; hand mode keeps it', async () => {
    const wizard = setup([], true);
    expect(wizard.root.root.findAll((node) => node.type === 'aside' && node.props['aria-label'] === '속성')).toHaveLength(0);
    act(() => wizard.root.unmount());
    const hand = setup([], false);
    expect(hand.root.root.findAll((node) => node.type === 'aside' && node.props['aria-label'] === '속성')).toHaveLength(1);
    act(() => hand.root.unmount());
  });

  test('v2 reply: Korean labels title the cards (id underneath) and the bubble says why the base was picked', async () => {
    const { root } = setup([
      { status: 200, body: { ok: true, yaml: T1, base: 'wizard-collect-summarize-send', baseReason: '수집→요약→발송 흐름과 가장 가깝다', issues: [], attempts: 1, summary: '노드 2개 추가', labels: { fetch: '뉴스 수집', send: '텔레그램 발송' } } },
    ]);
    await say(root.root, '매일 아침 AI 뉴스 요약해서 텔레그램으로');
    const tree = JSON.stringify(root.toJSON());
    expect(tree).toContain('뉴스 수집');
    expect(tree).toContain('텔레그램 발송');
    expect(text(root.root.findByProps({ 'data-testid': 'wizard-base' }))).toBe('기반: wizard-collect-summarize-send — 이유 수집→요약→발송 흐름과 가장 가깝다');
    act(() => root.unmount());
  });

  test('an older daemon without labels/baseReason: ids stay the titles and no base line is shown', async () => {
    const { root } = setup([{ status: 200, body: { ok: true, yaml: T1, base: 'daily-digest', issues: [], attempts: 1, summary: '노드 2개 추가' } }]);
    await say(root.root, '매일 아침 AI 뉴스 요약해서 텔레그램으로');
    expect(root.root.findAllByProps({ 'data-testid': 'wizard-base' })).toHaveLength(0);
    expect(JSON.stringify(root.toJSON())).not.toContain('뉴스 수집');
    act(() => root.unmount());
  });

  test('«저장» sends the wizard steps with the YAML (the server keeps them so «실행» runs real steps)', async () => {
    const steps = { fetch: { label: '뉴스 수집', step: 'web-search', arg: '오늘 AI 뉴스', retries: 2 }, send: { label: '텔레그램 발송', step: 'telegram-send' } };
    const { root, saves, seen } = setup([{ status: 200, body: { ok: true, yaml: T1, issues: [], attempts: 1, summary: '노드 2개 추가', steps } }]);
    await say(root.root, '매일 아침 AI 뉴스 요약해서 텔레그램으로');
    const save = root.root.findAllByType('button').find((button) => text(button) === '저장')!;
    await act(async () => { save.props.onClick(); await Bun.sleep(20); });
    expect(saves).toHaveLength(1);
    expect(saves[0]).toEqual({ id: 'ai-news', yaml: seen.context!.yaml, steps });
    act(() => root.unmount());
  });

  test('steps follow the turn: a reply without steps saves none; undo puts the earlier turn\'s steps back', async () => {
    const steps = { fetch: { label: '뉴스 수집', step: 'web-search', arg: '오늘 AI 뉴스' } };
    const { root, saves } = setup([
      { status: 200, body: { ok: true, yaml: T1, issues: [], attempts: 1, summary: 'T1', steps } },
      { status: 200, body: { ok: true, yaml: T2, issues: [], attempts: 1, summary: 'T2' } },
    ]);
    await say(root.root, '첫 말');
    await say(root.root, '둘째 말');
    const save = () => root.root.findAllByType('button').find((button) => text(button) === '저장')!;
    await act(async () => { save().props.onClick(); await Bun.sleep(20); });
    expect(saves.at(-1)!.steps).toBeUndefined();
    await act(async () => { buttons(root.root, '되돌리기')[1]!.props.onClick(); await Bun.sleep(20); });
    await act(async () => { save().props.onClick(); await Bun.sleep(20); });
    expect(saves).toHaveLength(2);
    expect(saves.at(-1)!.steps).toEqual(steps);
    act(() => root.unmount());
  });

  test('a 422 draft still lands on the canvas', async () => {
    const { root, seen } = setup([
      { status: 422, body: { ok: false, yaml: T1, base: null, issues: ['끝 노드 없음'], attempts: 3, summary: '초안 — 검증 실패' } },
    ]);
    await say(root.root, 'PR 리뷰하고 문제 없으면 머지');
    expect(seen.context!.graph.nodes).toHaveLength(2);
    expect(text(root.root.findByProps({ 'data-testid': 'wizard-issues' }))).toContain('끝 노드 없음');
    act(() => root.unmount());
  });
});
