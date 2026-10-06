import { afterEach, expect, test } from 'bun:test';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { act, create } from 'react-test-renderer';
import { ReactFlow } from '@xyflow/react';
import type { ActivityEdge } from './loop-activity-map';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LoopRow } from '@/components/loops/loop-status';
import { LoopActivityMap } from './LoopActivityMap';
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

function mountMap(search: string) {
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
    <LoopActivityMap rows={rows} edges={edges} seenAt={{}} now={now} state="ready" />
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
