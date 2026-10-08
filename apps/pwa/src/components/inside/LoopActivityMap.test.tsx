import { afterEach, expect, test } from 'bun:test';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { act, create } from 'react-test-renderer';
import { Position, ReactFlow } from '@xyflow/react';
import type { ActivityEdge } from './loop-activity-map';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LoopRow } from '@/components/loops/loop-status';
import { LoopActivityMap, NodeDetail } from './LoopActivityMap';
import { PacketEdge } from './PacketEdge';
import { leaksInternal } from './public-text';

const now = Date.parse('2026-10-05T10:00:00Z');
const rows: LoopRow[] = [
  { id: 'schedule:late', name: '늦은 루프', layer: 'ops', owner: 'OP', mode: 'cron', lastRun: null, verdict: '늦음' },
  { id: 'loop:off', name: '꺼진 루프', layer: 'ops', owner: '미지정', mode: 'off', lastRun: null, verdict: '꺼짐' },
];

const originalWindow = globalThis.window;
const originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
afterEach(() => {
  globalThis.window = originalWindow;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct;
});

const cardEdges: ActivityEdge[] = [
  { at: '2026-10-05T09:59:00Z', kind: 'card', from: 'loop:FLOW-1', to: 'TC', ref: 'A' },
  { at: '2026-10-05T09:58:00Z', kind: 'card', from: 'surface:pwa', to: 'card:A', ref: 'A' },
  { at: '2026-10-05T09:59:00Z', kind: 'card', from: 'card:A', to: 'loop:FLOW-1', ref: 'A' },
  { at: '2026-10-05T09:58:30Z', kind: 'card', from: 'surface:tui', to: 'card:B', ref: 'B' },
  { at: '2026-10-05T09:59:10Z', kind: 'request', from: 'OP', to: 'TC', ref: 'A' },
];

function mountMap(search: string, mapRows: readonly LoopRow[] = rows) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let href = `https://example.test/inside?scene=3${search}`;
  globalThis.window = {
    location: { get href() { return href; }, get search() { return new URL(href).search; } },
    history: { state: null, replaceState: (_state: unknown, _unused: string, url: string) => { href = url; },
      pushState: (_state: unknown, _unused: string, url: string) => { href = url; } },
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window & typeof globalThis;
  let root: ReturnType<typeof create>;
  const renderMap = (edges: readonly ActivityEdge[] = cardEdges) => <SearchParamsContext.Provider value={new URLSearchParams(new URL(href).search)}>
    <LoopActivityMap rows={mapRows} edges={edges} seenAt={{}} now={now} state="ready" />
  </SearchParamsContext.Provider>;
  act(() => { root = create(renderMap()); });
  return { root: root!, address: () => href, navigate: (method: 'pushState' | 'replaceState', url: string) => act(() => {
    window.history[method](null, '', url);
    root!.update(renderMap());
  }), updateEdges: (edges: readonly ActivityEdge[]) => act(() => root!.update(renderMap(edges))) };
}

test('map exposes four seats, unknown owner, red verdict and clickable node list at phone width', () => {
  const html = renderToStaticMarkup(<SearchParamsContext.Provider value={new URLSearchParams()}><LoopActivityMap rows={rows} edges={[]} seenAt={{}} now={now} state="ready" /></SearchParamsContext.Provider>);
  for (const label of ['COO', 'CMO', 'CTO', 'CXO', '미지정', '늦은 루프', '꺼진 루프']) expect(html).toContain(label);
  expect(html).toContain('data-loop-verdict="늦음"');
  expect(html).toContain('text-red-300');
  expect(html).toContain('늦은 루프');
  expect(html).toContain('꺼진 루프');
  expect(html).toContain('type="button"');
  expect(html).toContain('grid gap-4 sm:grid-cols-2');
  expect(html).toContain('최근 사건이 없습니다');
  expect(leaksInternal(html)).toEqual([]);
});

test('a group with nine nodes wraps after eight without overlapping the next seat or moving fixed nodes', () => {
  const crowded: LoopRow[] = Array.from({ length: 8 }, (_, index) => ({
    id: `loop:op-${index}`, name: `OP loop ${index}`, layer: 'ops', owner: 'OP', mode: 'cron', lastRun: null, verdict: '꺼짐',
  }));
  const { root, updateEdges } = mountMap('', crowded);
  try {
    const nodes = root.root.findByType(ReactFlow).props.nodes as Array<{ data: { label: string }; position: { x: number; y: number } }>;
    const at = (label: string) => nodes.find(node => node.data.label === label)!.position;
    expect(at('COO')).toEqual({ x: 0, y: 0 });
    expect(at('COO loop 6')).toEqual({ x: 0, y: 7 * 138 });
    expect(at('COO loop 7')).toEqual({ x: 220, y: 0 });
    expect(at('CMO')).toEqual({ x: 440, y: 0 });
    expect(at('조율')).toEqual({ x: 0, y: -170 });
    expect(at('TASK-AGENT')).toEqual({ x: 220, y: -170 });
    const prEdges: ActivityEdge[] = Array.from({ length: 9 }, (_, index) => ({
      at: '2026-10-05T09:59:00Z', kind: 'run', from: 'TC', to: `pr:${100 + index}`, ref: `run-${index}`,
    }));
    updateEdges(prEdges);
    const prNodes = root.root.findByType(ReactFlow).props.nodes as typeof nodes;
    const prAt = (label: string) => prNodes.find(node => node.data.label === label)!.position;
    expect(prAt('PR #100').y).toBe(prAt('PR #108').y);
    expect(prAt('PR #108').x).toBeGreaterThan(prAt('PR #100').x);
  } finally { act(() => root.unmount()); }
});

test('sub-seats remain visible as seat nodes when supplied by ops seats', () => {
  const html = renderToStaticMarkup(<SearchParamsContext.Provider value={new URLSearchParams()}><LoopActivityMap rows={rows} edges={[]} seenAt={{}} now={now} state="ready" seatIds={['OP', 'MK', 'TC', 'UX', 'TC-1']} /></SearchParamsContext.Provider>);
  expect(html).toContain('CTO-1');
  expect(html).toContain('h-[90px] w-[90px]');
});

test('list choice and ?card=A brighten three card edges, dim two unrelated edges, and read the path in time order', () => {
  const { root, address } = mountMap('');
  try {
    const select = root.root.findByProps({ 'aria-label': '데모 카드 선택' });
    const cardA = select.findAllByType('button').find(button => button.props.children === 'A')!;
    expect(cardA.props['aria-pressed']).toBe(false);
    act(() => cardA.props.onClick());
    expect(cardA.props['aria-pressed']).toBe(true);
    expect(new URL(address()).searchParams.get('card')).toBe('A');
    const graphEdges = root.root.findByType(ReactFlow).props.edges;
    expect(graphEdges.filter((edge: { style: { opacity: number } }) => edge.style.opacity === 1)).toHaveLength(3);
    expect(graphEdges.filter((edge: { style: { opacity: number } }) => edge.style.opacity === 0.16)).toHaveLength(2);
    const flow = root.root.findByProps({ 'aria-label': '선택 카드 흐름' });
    expect(flow.findAllByType('li').map(li => li.props.children.filter((part: unknown) => typeof part === 'string').join('')))
      .toEqual(['. 입구 · pwa → 카드 · ', '. 카드 → 칸 · FLOW-1 · ', '. 칸 · FLOW-1 → CTO · ']);
    const recent = root.root.findByProps({ 'aria-label': '최근 간선 사건' }).findAllByType('button');
    expect(recent.filter(button => button.props.className.includes('border-sky-300'))).toHaveLength(3);
    expect(recent.filter(button => button.props.className.includes('opacity-40'))).toHaveLength(2);
    act(() => select.findAllByType('button').find(button => button.props.children === '전체 보기')!.props.onClick());
    expect(new URL(address()).searchParams.has('card')).toBe(false);
    expect(root.root.findByType(ReactFlow).props.edges.every((edge: { style: { opacity: number } }) => edge.style.opacity === 0.55)).toBe(true);
    act(() => cardA.props.onClick());
    expect(root.root.findByType(ReactFlow).props.edges.filter((edge: { style: { opacity: number } }) => edge.style.opacity === 1)).toHaveLength(3);
    expect(root.root.findByType(ReactFlow).props.edges.filter((edge: { style: { opacity: number } }) => edge.style.opacity === 0.16)).toHaveLength(2);
  } finally { act(() => root.unmount()); }

  const linked = mountMap('&card=A');
  try {
    expect(linked.root.root.findByType(ReactFlow).props.edges.filter((edge: { style: { opacity: number } }) => edge.style.opacity === 1)).toHaveLength(3);
    expect(linked.root.root.findByType(ReactFlow).props.edges.filter((edge: { style: { opacity: number } }) => edge.style.opacity === 0.16)).toHaveLength(2);
    expect(linked.root.root.findByProps({ 'aria-label': '데모 카드 선택' }).findAllByType('button').find(button => button.props.children === 'A')!.props['aria-pressed']).toBe(true);
  } finally { act(() => linked.root.unmount()); }
});

test('client-side query navigation changes the selected card without remounting the map', () => {
  const { root, navigate } = mountMap('&card=A');
  try {
    expect(root.root.findByType(ReactFlow).props.edges.filter((edge: { style: { opacity: number } }) => edge.style.opacity === 1)).toHaveLength(3);
    navigate('pushState', 'https://example.test/inside?scene=3&card=B');
    expect(root.root.findByProps({ 'aria-label': '데모 카드 선택' }).findAllByType('button').find(button => button.props.children === 'B')!.props['aria-pressed']).toBe(true);
    expect(root.root.findByType(ReactFlow).props.edges.filter((edge: { style: { opacity: number } }) => edge.style.opacity === 1)).toHaveLength(1);
    expect(root.root.findByType(ReactFlow).props.edges.filter((edge: { style: { opacity: number } }) => edge.style.opacity === 0.16)).toHaveLength(4);
    navigate('replaceState', 'https://example.test/inside?scene=3&card=missing');
    expect(JSON.stringify(root.toJSON())).toContain('이 카드는 아직 흐른 사건이 없음');
    expect(root.root.findByType(ReactFlow).props.edges.every((edge: { style: { opacity: number } }) => edge.style.opacity === 0.16)).toBe(true);
    navigate('pushState', 'https://example.test/inside?scene=3');
    expect(root.root.findAllByProps({ 'aria-label': '선택 카드 흐름' })).toHaveLength(0);
    expect(root.root.findByType(ReactFlow).props.edges.every((edge: { style: { opacity: number } }) => edge.style.opacity === 0.55)).toBe(true);
  } finally { act(() => root.unmount()); }
});

test('completed card reads entrance, card, cell, seat, then reply surface even when API sends newest first', () => {
  const full: ActivityEdge[] = [
    { at: '2026-10-05T09:59:30Z', kind: 'card', from: 'TC', to: 'surface:telegram', ref: 'A' },
    cardEdges[0]!, cardEdges[2]!, cardEdges[1]!,
  ];
  const { root, updateEdges } = mountMap('&card=A');
  try {
    updateEdges(full);
    const flow = root.root.findByProps({ 'aria-label': '선택 카드 흐름' });
    expect(flow.findAllByType('li').map(li => li.props.children.filter((part: unknown) => typeof part === 'string').join('')))
      .toEqual(['. 입구 · pwa → 카드 · ', '. 카드 → 칸 · FLOW-1 · ', '. 칸 · FLOW-1 → CTO · ', '. CTO → 회신 · telegram · ']);
  } finally { act(() => root.unmount()); }
});

test('unknown card in URL says there are no flowed events and does not highlight unrelated edges', () => {
  const { root } = mountMap('&card=missing');
  try {
    expect(JSON.stringify(root.toJSON())).toContain('이 카드는 아직 흐른 사건이 없음');
    expect(root.root.findByType(ReactFlow).props.edges.every((edge: { style: { opacity: number } }) => edge.style.opacity === 0.16)).toBe(true);
  } finally { act(() => root.unmount()); }
});

test('run incident keeps opaque graph IDs and provides a Trace lens link', () => {
  const edge = { at: '2026-10-05T09:59:00Z', kind: 'run' as const, from: 'OP', to: 'loop:run-123abc', ref: 'run-123abc' };
  const html = renderToStaticMarkup(<SearchParamsContext.Provider value={new URLSearchParams()}><LoopActivityMap rows={rows} edges={[edge]} seenAt={{}} now={now} state="ready" /></SearchParamsContext.Provider>);
  expect(html).toContain('최근 간선 사건');
  expect(html).toContain('type="button"');
  expect(html).not.toContain('data-id="loop:run-123abc"');
});

// LOOP-INTERACT 조각 C — 꾸러미 이동 · 넘김 표시 · 2단 줌 · ?demo= 여정 띠.
const interact: ActivityEdge[] = [
  { at: '2026-10-05T09:58:00Z', kind: 'hand', from: 'loop:orchestrator', to: 'agent:task-agent', ref: 'card-1', mode: 'live' },
  { at: '2026-10-05T09:58:10Z', kind: 'hand', from: 'loop:orchestrator', to: 'agent:task-agent', ref: 'card-2', mode: 'shadow' },
  { at: '2026-10-05T09:58:20Z', kind: 'hand', from: 'loop:orchestrator', to: 'agent:task-agent', ref: 'card-3', mode: 'live', broken: true },
  { at: '2026-10-05T09:58:30Z', kind: 'launch', from: 'agent:task-agent', to: 'TC', ref: 'card-1' },
  { at: '2026-10-05T09:58:40Z', kind: 'request', from: 'OP', to: 'TC', ref: 'q1' },
  { at: '2026-10-05T09:58:50Z', kind: 'report', from: 'TC', to: 'OP', ref: 'q1' },
];

function mountInteract({ search = '', reduce = false, seen = now, edges = interact, details }: { search?: string; reduce?: boolean; seen?: number; edges?: ActivityEdge[]; details?: Record<string, { now?: string; running?: number; waiting?: number }> } = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const href = `https://example.test/inside?scene=3${search}`;
  globalThis.window = {
    location: { href, search: new URL(href).search },
    history: { state: null, replaceState: () => {}, pushState: () => {} },
    addEventListener: () => {}, removeEventListener: () => {},
    matchMedia: (query: string) => ({ matches: reduce && query.includes('reduce'), addEventListener: () => {}, removeEventListener: () => {} }),
  } as unknown as Window & typeof globalThis;
  const seenAt = Object.fromEntries(edges.map(edge => [JSON.stringify([edge.at, edge.kind, edge.from, edge.to, edge.ref]), seen]));
  let root: ReturnType<typeof create>;
  act(() => { root = create(<SearchParamsContext.Provider value={new URLSearchParams(new URL(href).search)}>
    <LoopActivityMap rows={rows} edges={edges} seenAt={seenAt} now={now} state="ready" details={details} />
  </SearchParamsContext.Provider>); });
  return root!;
}

type FlowEdge = { type: string; label: string; source: string; target: string; style: Record<string, unknown>; data: { packet: unknown; hand: string | null } };
const svgOf = (edge: FlowEdge) => renderToStaticMarkup(<svg><PacketEdge id="e" source={edge.source} target={edge.target} sourceX={0} sourceY={0} targetX={100} targetY={40}
  sourcePosition={Position.Right} targetPosition={Position.Left} label={edge.label} style={edge.style} data={edge.data as never} /></svg>);

test('new hand, launch and report edges each send one shaped packet; reduced motion sends none', () => {
  const root = mountInteract();
  try {
    const edges: FlowEdge[] = root.root.findByType(ReactFlow).props.edges;
    expect(edges).toHaveLength(interact.length);
    expect(edges.every(edge => edge.type === 'packet')).toBe(true);
    const svgs = edges.map(svgOf);
    expect(svgs.map(svg => svg.split('<animateMotion').length - 1)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(svgs[0]).toContain('▲');
    expect(svgs[3]).toContain('★');
    expect(svgs[4]).toContain('keyPoints="0;1;0"');
    expect(svgs[3]).not.toContain('keyPoints');
  } finally { act(() => root.unmount()); }
  const calm = mountInteract({ reduce: true });
  try {
    const edges: FlowEdge[] = calm.root.findByType(ReactFlow).props.edges;
    expect(edges.every(edge => edge.data.packet === null)).toBe(true);
    expect(edges.map(svgOf).join('').split('<animateMotion').length - 1).toBe(0);
    expect(edges.filter(edge => edge.style.opacity === 1)).toHaveLength(interact.length);
  } finally { act(() => calm.unmount()); }
  const old = mountInteract({ seen: now - 10_000 });
  try {
    expect((old.root.findByType(ReactFlow).props.edges as FlowEdge[]).map(svgOf).join('').split('<animateMotion').length - 1).toBe(0);
  } finally { act(() => old.unmount()); }
});

test('hand edges read shadow as dashed and faint, live as solid, broken as a marked cut', () => {
  const root = mountInteract({ seen: 0 });
  try {
    const [live, shadow, broken] = root.root.findByType(ReactFlow).props.edges as FlowEdge[];
    expect(live).toMatchObject({ label: '넘김', data: { hand: 'live' } });
    expect(live!.style.strokeDasharray).toBeUndefined();
    expect(shadow).toMatchObject({ label: '넘김 · 그림자', data: { hand: 'shadow' }, style: { strokeDasharray: '6 5', opacity: 0.35 } });
    expect(broken).toMatchObject({ label: '넘김 · 끊김 ✕', data: { hand: 'broken' }, style: { strokeDasharray: '2 7' } });
    const recent = root.root.findByProps({ 'aria-label': '최근 간선 사건' }).findAllByType('button')
      .flatMap(b => (b.props.children as unknown[]).filter(part => typeof part === 'string')).join('|');
    expect(recent).toContain('넘김 · 끊김 ✕');
    expect(recent).toContain('넘김 · 그림자');
  } finally { act(() => root.unmount()); }
});

test('near zoom puts now, at most five recent actions and run/wait counts in nodes; far zoom strips them', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ at: `2026-10-05T09:5${i}:00Z`, kind: 'launch' as const, from: 'agent:task-agent', to: 'TC', ref: `c${i}` }));
  const root = mountInteract({ edges: many, seen: 0, details: { TC: { now: '서버 조각 B', waiting: 2 }, 'agent:task-agent': { running: 3 } } });
  try {
    const flow = root.root.findByType(ReactFlow);
    expect(flow.props.maxZoom).toBe(2.5);
    const nodes = flow.props.nodes as Array<{ data: { label: string; detail?: { now: string | null; recent: string[]; running: unknown; waiting: unknown } } }>;
    const agent = nodes.find(node => node.data.label === 'TASK-AGENT')!;
    expect(agent.data.detail!.recent).toHaveLength(5);
    expect(agent.data.detail!.running).toBe(3);
    expect(nodes.find(node => node.data.label === 'CTO')!.data.detail).toMatchObject({ now: '서버 조각 B', waiting: 2 });
    expect(nodes.filter(node => ['조율', 'TASK-AGENT', '런 묶음', '발행 루프', '수호자', 'COO', 'CMO', 'CTO', 'CXO'].includes(node.data.label))).toHaveLength(9);
    act(() => flow.props.onMove(null, { x: 0, y: 0, zoom: 0.5 }));
    expect((root.root.findByType(ReactFlow).props.nodes as Array<{ data: { detail?: unknown } }>).every(node => node.data.detail === undefined)).toBe(true);
    act(() => root.root.findByType(ReactFlow).props.onMove(null, { x: 0, y: 0, zoom: 1.2 }));
    expect((root.root.findByType(ReactFlow).props.nodes as Array<{ data: { detail?: unknown } }>).some(node => node.data.detail !== undefined)).toBe(true);
    const html = renderToStaticMarkup(<NodeDetail detail={agent.data.detail as never} />);
    expect(html.split('<li').length - 1).toBe(5);
    expect(leaksInternal(html)).toEqual([]);
  } finally { act(() => root.unmount()); }
});

test('?demo=<id> draws one five-step journey band with ReleaseFlow marks and lights only that journey', () => {
  const journey: ActivityEdge[] = [
    { at: '2026-10-05T09:50:00Z', kind: 'move', from: 'agent:task-agent', to: 'release:RELEASE-LIVE2', ref: 'card-1', move: 'green-proposal' },
    { at: '2026-10-05T09:40:00Z', kind: 'run', from: 'loop:run-abc123', to: 'pr:24700', ref: 'run-abc123' },
    { at: '2026-10-05T09:12:00Z', kind: 'run', from: 'TC', to: 'loop:run-abc123', ref: 'run-abc123' },
    { at: '2026-10-05T09:11:00Z', kind: 'launch', from: 'agent:task-agent', to: 'TC', ref: 'card-1' },
    { at: '2026-10-05T09:10:00Z', kind: 'hand', from: 'loop:orchestrator', to: 'agent:task-agent', ref: 'card-1', mode: 'live' },
    { at: '2026-10-05T09:59:00Z', kind: 'request', from: 'OP', to: 'MK', ref: 'unrelated' },
  ];
  const root = mountInteract({ search: '&demo=card-1', edges: journey, seen: 0 });
  try {
    const band = root.root.findByProps({ 'aria-label': '데모 여정' });
    const steps = band.findAllByType('li');
    expect(steps.map(li => li.props['data-journey-state'])).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(JSON.stringify(band.findAllByType('span').map(s => s.props.children))).toContain('✓');
    const edges = root.root.findByType(ReactFlow).props.edges as FlowEdge[];
    expect(edges.filter(edge => edge.style.opacity === 1)).toHaveLength(5);
    expect(edges.filter(edge => edge.style.opacity === 0.16)).toHaveLength(1);
  } finally { act(() => root.unmount()); }
  const partial = mountInteract({ search: '&demo=card-1', edges: journey.slice(3), seen: 0 });
  try {
    expect(partial.root.findByProps({ 'aria-label': '데모 여정' }).findAllByType('li').map(li => li.props['data-journey-state']))
      .toEqual(['done', 'done', 'current', 'pending', 'pending']);
  } finally { act(() => partial.unmount()); }
  // JOURNEY-EMPTY-STATE — 사건 0 인 여정은 «지금» 없이 다섯 단계 모두 «남음» ⊕ «아직 사건 없음» 한 줄
  const empty = mountInteract({ search: '&demo=card-1', edges: [], seen: 0 });
  try {
    const band = empty.root.findByProps({ 'aria-label': '데모 여정' });
    expect(band.findAllByType('li').map(li => li.props['data-journey-state'])).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
    expect(JSON.stringify(band.findAllByProps({ role: 'status' }).map(p => p.props.children))).toContain('아직 사건 없음');
  } finally { act(() => empty.unmount()); }
  const started = mountInteract({ search: '&demo=card-1', edges: journey, seen: 0 });
  try { expect(started.root.findByProps({ 'aria-label': '데모 여정' }).findAllByProps({ role: 'status' })).toHaveLength(0); } finally { act(() => started.unmount()); }
  const viaJourney = mountInteract({ search: '&demo=1&journey=card-1', edges: journey, seen: 0 });
  try { expect(viaJourney.root.findAllByProps({ 'aria-label': '데모 여정' })).toHaveLength(1); } finally { act(() => viaJourney.unmount()); }
  // /inside 의 ?demo=1|0 은 데모 모드 스위치다 — 여정 id 로 읽으면 장면③이 지도로 넘어가 현황이 사라진다.
  for (const search of ['&demo=../bad', '&demo=0', '&demo=1']) {
    const none = mountInteract({ search, edges: journey, seen: 0 });
    try { expect(none.root.findAllByProps({ 'aria-label': '데모 여정' })).toHaveLength(0); } finally { act(() => none.unmount()); }
  }
});
