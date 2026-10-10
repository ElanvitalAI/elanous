import { afterEach, expect, test } from 'bun:test';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { act, create } from 'react-test-renderer';
import type { ComponentProps } from 'react';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { LoopAgentsScene } from '@/components/inside/LoopAgentsScene';
import { _setEventSourceFactoryForTest } from '@/lib/shared-event-source';
import { LoopInteractPanel, LoopsView } from './LoopsView';
import { LoopStatusPanel } from './LoopStatusPanel';
import { ResourceMap, ResourcePanel } from './ResourceMap';

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct;
  _setEventSourceFactoryForTest(null);
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Set<(event: unknown) => void>>();
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(name: string, fn: (event: unknown) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  removeEventListener(name: string, fn: (event: unknown) => void) { this.listeners.get(name)?.delete(fn); }
  emit(name: string, event: unknown = {}) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
  close() { this.closed = true; }
}

function mount(search: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.instances = [];
  _setEventSourceFactoryForTest((url) => new FakeEventSource(url) as unknown as EventSource);
  globalThis.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} } as unknown as Document;
  globalThis.window = {
    location: { href: `https://example.test/loops?${search}`, search: `?${search}` },
    history: { state: null, replaceState: () => {} },
    setInterval: () => 1, clearInterval: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
  } as unknown as Window & typeof globalThis;
  globalThis.fetch = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
  const edgeReads: string[] = [];
  const fetchJson = async (path: string) => {
    if (path === '/v1/loops/resources') return { resource: { now: '2026-10-05T00:00:00Z', unassigned: 0,
      seats: [{ seat: 'MK', running: 1, cap: 6, baseShare: 3, borrowed: 1, lent: 0, launchCap: 4, idle: true,
        nextCell: { id: 'MK-1', title: '다음 잡' } }] } };
    if (path.startsWith('/v1/loops/edges')) { edgeReads.push(path); return { edges: [] }; }
    if (path.includes('includeOwners')) return { owners: [] };
    if (path.includes('schedules')) return { schedules: [] };
    return { loops: { loops: [] } };
  };
  const value = {
    client: { fetchJson, fetchResponse: (path: string, init: RequestInit) => globalThis.fetch(path, init),
      logsStreamUrl: (params: Record<string, string>) => `/v1/logs/stream?${new URLSearchParams(params)}` },
    config: { baseUrl: '', token: '', provider: '' },
  } as unknown as ComponentProps<typeof DaemonContext.Provider>['value'];
  let root: ReturnType<typeof create>;
  const tree = <DaemonContext.Provider value={value}><SearchParamsContext.Provider value={new URLSearchParams(search)}><LoopsView /></SearchParamsContext.Provider></DaemonContext.Provider>;
  return { edgeReads, mount: async () => { await act(async () => { root = create(tree); }); return root!; } };
}

test('resource view calls its read-only resource endpoint and shows one LOOP-INTERACT resource graph', async () => {
  const resource = mount('view=resources');
  const root = await resource.mount();
  try {
    expect(root.root.findAllByType(LoopStatusPanel)).toHaveLength(0);
    expect(root.root.findAllByType(ResourcePanel)).toHaveLength(1);
    expect(root.root.findAllByType(ResourceMap)).toHaveLength(1);
    expect(root.root.findByProps({ 'aria-label': '자원 LOOP-INTERACT' })).toBeDefined();
    expect(resource.edgeReads).toEqual([]);
  } finally { act(() => root.unmount()); }
});

test('default /loops keeps the status table; ?view=interact opens the interaction map without the table', async () => {
  const plain = mount('');
  const statusRoot = await plain.mount();
  try {
    expect(statusRoot.root.findAllByType(LoopStatusPanel)).toHaveLength(1);
    expect(statusRoot.root.findAllByType(LoopInteractPanel)).toHaveLength(0);
    expect(plain.edgeReads).toEqual([]);
  } finally { act(() => { statusRoot.unmount(); }); }

  const interact = mount('view=interact&journey=card-7');
  const root = await interact.mount();
  try {
    expect(root.root.findAllByType(LoopStatusPanel)).toHaveLength(0);
    expect(root.root.findByType(LoopAgentsScene).props.initialMode).toBe('map');
    expect(root.root.findByProps({ 'aria-label': '루프 활동 지도' })).toBeDefined();
    // ?journey= 가 그대로 지도에 닿는다 — 여정 질의로 읽고 여정 띠를 그린다.
    expect(interact.edgeReads[0]).toBe('/v1/loops/edges?ref=card-7&mode=live&limit=500');
    expect(root.root.findByProps({ 'aria-label': '데모 여정' })).toBeDefined();
    // 실시간: 기존 로그 SSE 하나를 «다시 읽기 신호»로 — 프레임이 오면 디바운스 뒤 간선을 다시 읽는다.
    const streams = FakeEventSource.instances.filter((source) => source.url.startsWith('/v1/logs/stream?category='));
    expect(streams).toHaveLength(1);
    const before = interact.edgeReads.length;
    await act(async () => { streams[0]!.emit('log', { data: '{}' }); streams[0]!.emit('log', { data: '{}' }); });
    expect(interact.edgeReads.length).toBe(before);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
    expect(interact.edgeReads.length).toBe(before + 1);
  } finally { act(() => { root.unmount(); }); }
  expect(FakeEventSource.instances.filter((source) => source.url.startsWith('/v1/logs/stream?category=')).every((source) => source.closed)).toBe(true);
});
