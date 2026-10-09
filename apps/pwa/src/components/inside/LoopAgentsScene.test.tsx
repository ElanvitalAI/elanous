import { afterEach, expect, test } from 'bun:test';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps } from 'react';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { LoopAgentsScene, LoopAgentsViewContent, loopEdgesPath, mapNodeDetails } from './LoopAgentsScene';
import { LoopActivityMap } from './LoopActivityMap';
import { NexusApiError } from '@/nexus/client';
import { loopAgentsView } from './loop-agents-view';

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
const originalInterval = globalThis.setInterval;
const originalClear = globalThis.clearInterval;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  globalThis.setInterval = originalInterval;
  globalThis.clearInterval = originalClear;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct;
});

test('renders four cards, two columns at narrow widths, four at 1440 and a running strip with update time', () => {
  const html = renderToStaticMarkup(<LoopAgentsViewContent view={loopAgentsView(null, null)} runsUnreadable refreshedAt="2026-10-08T10:00:00.000Z" />);
  expect(html).toContain('grid-cols-2');
  expect(html).toContain('min-[1440px]:grid-cols-4');
  expect(html).toContain('min-[1440px]:text-[22px]');
  for (const seat of ['COO', 'CMO', 'CTO', 'CXO']) expect(html).toContain(`${seat} 자리`);
  expect(html).toContain('대표 결정 대기');
  expect(html).toContain('지금 도는 런');
  expect(html).toContain('마지막 갱신');
  expect(html).toContain('2026-10-08T10:00:00.000Z');
  expect(html).not.toContain('지금 도는 런이 없습니다');
});

test('unconfirmed runs remain unreadable on first load and connection switch; confirmed empty runs alone show no active runs', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} } as unknown as Document;
  globalThis.window = { setInterval: () => 1, clearInterval: () => {} } as unknown as Window & typeof globalThis;
  const pending: Array<(response: Response) => void> = [];
  globalThis.fetch = ((_input: RequestInfo | URL) => new Promise<Response>((resolve) => { pending.push(resolve); })) as typeof fetch;
  const context = (baseUrl: string) => ({
    client: { fetchResponse: (path: string, init: RequestInit) => globalThis.fetch(path, init) },
    config: { baseUrl, token: '', provider: '' },
  }) as unknown as ComponentProps<typeof DaemonContext.Provider>['value'];
  const firstPaint = renderToStaticMarkup(<DaemonContext.Provider value={context('')}><LoopAgentsScene /></DaemonContext.Provider>);
  expect(firstPaint).toContain('<h2 class="font-semibold">지금 도는 런</h2><p class="text-muted-foreground">못 읽음</p>');
  expect(firstPaint).not.toContain('지금 도는 런이 없습니다');
  let root: ReturnType<typeof create>;
  act(() => { root = create(<DaemonContext.Provider value={context('')}><LoopAgentsScene /></DaemonContext.Provider>); });
  const text = () => JSON.stringify(root!.toJSON());
  try {
    expect(text()).toContain('못 읽음');
    expect(text()).not.toContain('지금 도는 런이 없습니다');
    await act(async () => {
      pending[0](new Response(JSON.stringify({ date: '2026-10-08', seats: [] })));
      pending[1](new Response(JSON.stringify({ entries: [] })));
    });
    expect(text()).toContain('지금 도는 런이 없습니다');
    expect(pending).toHaveLength(2);
    act(() => { root!.update(<DaemonContext.Provider value={context('https://next.example')}><LoopAgentsScene /></DaemonContext.Provider>); });
    expect(text()).toContain('못 읽음');
    expect(text()).not.toContain('지금 도는 런이 없습니다');
  } finally {
    act(() => { root!.unmount(); });
  }
});

test('polls every 10 seconds, pauses while hidden, preserves the other feed on failure and resumes on visibility', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let hidden = false;
  let visible: (() => void) | undefined;
  globalThis.document = { get hidden() { return hidden; }, addEventListener: (_: string, fn: () => void) => { visible = fn; }, removeEventListener: () => { visible = undefined; } } as unknown as Document;
  let tick: (() => void) | undefined;
  let intervalMs: number | undefined;
  let cleared = false;
  globalThis.window = { setInterval: (fn: () => void, ms: number) => { tick = fn; intervalMs = ms; return 1; }, clearInterval: () => { cleared = true; } } as unknown as Window & typeof globalThis;
  const requests: string[] = [];
  let seatFails = false;
  let runFails = false;
  globalThis.fetch = (async (input: string) => {
    requests.push(input);
    if (input.includes('/v1/ops/seats')) return new Response(seatFails ? '{}': JSON.stringify({ date: '2026-10-08', seats: [
      { seat: 'OP', now: { text: '실행 중', at: '' }, landed: [], blocked: [], pendingDecisions: 2, checklist: null },
    ] }), { status: seatFails ? 503 : 200 });
    return new Response(runFails ? '{}' : JSON.stringify({ entries: [{ runId: 'run-a1b2c3d4-1234-abcd-9876-0123456789ab', status: 'running', lastPhase: '구현' }] }), { status: runFails ? 503 : 200 });
  }) as typeof fetch;
  const value = { client: { fetchResponse: (path: string, init: RequestInit) => globalThis.fetch(path, init) },
    config: { baseUrl: '', token: '', provider: '' } } as unknown as ComponentProps<typeof DaemonContext.Provider>['value'];
  let root: ReturnType<typeof create>;
  await act(async () => { root = create(<DaemonContext.Provider value={value}><LoopAgentsScene /></DaemonContext.Provider>); });
  try {
    expect(intervalMs).toBe(10_000);
    expect(requests).toEqual(['/v1/ops/seats?date=' + new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()), '/v1/harness/runs']);
    expect(JSON.stringify(root!.toJSON())).toContain('실행 중');
    expect(JSON.stringify(root!.toJSON())).toContain('a1b2c3');
    hidden = true;
    await act(async () => { tick!(); });
    expect(requests).toHaveLength(2);
    hidden = false;
    seatFails = true;
    await act(async () => { visible!(); });
    expect(JSON.stringify(root!.toJSON())).toContain('COO');
    expect(JSON.stringify(root!.toJSON())).toContain('못 읽음');
    expect(JSON.stringify(root!.toJSON())).toContain('a1b2c3');
    seatFails = false;
    runFails = true;
    await act(async () => { tick!(); });
    expect(JSON.stringify(root!.toJSON())).toContain('실행 중');
    expect(JSON.stringify(root!.toJSON())).not.toContain('a1b2c3');
  } finally {
    act(() => { root!.unmount(); });
    expect(cleared).toBe(true);
    expect(visible).toBeUndefined();
  }
});

for (const status of [401, 403, 500] as const) {
  test(`map edges status ${status} displays ${status === 500 ? 'the existing error' : 'token access denied'}`, async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} } as unknown as Document;
    globalThis.window = { setInterval: () => 1, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {} } as unknown as Window & typeof globalThis;
    globalThis.fetch = (async () => new Response(JSON.stringify({ entries: [] }))) as unknown as typeof fetch;
    const edgePath = '/v1/loops/edges';
    const requests: string[] = [];
    const value = {
      client: {
        fetchResponse: async () => new Response(JSON.stringify({ date: '2026-10-08', seats: [] })),
        fetchJson: async (path: string) => {
          requests.push(path);
          if (path.startsWith(edgePath)) throw new NexusApiError(status, path, null);
          if (path.startsWith('/v1/schedules')) return { schedules: [], owners: [] };
          return { loops: { loops: [] } };
        },
        logsStreamUrl: () => null,
      },
      config: { baseUrl: '', token: '', provider: '' },
    } as unknown as ComponentProps<typeof DaemonContext.Provider>['value'];
    let root: ReturnType<typeof create>;
    await act(async () => { root = create(<SearchParamsContext.Provider value={new URLSearchParams()}><DaemonContext.Provider value={value}><LoopAgentsScene initialMode="map" /></DaemonContext.Provider></SearchParamsContext.Provider>); });
    try {
      expect(requests.some(path => path.startsWith(edgePath))).toBe(true);
      const map = root!.root.findByType(LoopActivityMap);
      expect(map.props.state).toBe(status === 500 ? 'error' : 'unauthorized');
      const alerts = map.findAllByProps({ role: 'alert' });
      expect(alerts).toHaveLength(1);
      const text = JSON.stringify(root!.toJSON());
      if (status === 500) {
        expect(text).toContain('지도 원천을 읽지 못했습니다');
        expect(text).toContain('데몬 연결을 확인하세요');
        expect(text).not.toContain('지도 원천에 접근 권한이 없습니다');
      } else {
        expect(alerts[0]!.props.children).toBe('지도 원천에 접근 권한이 없습니다 — 토큰으로 다시 붙으세요');
        expect(text).not.toContain('지도를 읽는 중');
        expect(text).not.toContain('데몬 연결을 확인하세요');
      }
    } finally { act(() => { root!.unmount(); }); }
  });
}

for (const status of [401, 403] as const) {
  test(`map clears previously displayed rows and edges after status ${status}`, async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} } as unknown as Document;
    let refresh: (() => void) | undefined;
    globalThis.setInterval = ((fn: () => void, ms: number) => { if (ms === 5_000) refresh = fn; return 1; }) as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;
    globalThis.window = { setInterval: () => 1, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {} } as unknown as Window & typeof globalThis;
    globalThis.fetch = (async () => new Response(JSON.stringify({ entries: [] }))) as unknown as typeof fetch;
    let denied = false;
    const value = {
      client: {
        fetchResponse: async () => new Response(JSON.stringify({ date: '2026-10-08', seats: [] })),
        fetchJson: async (path: string) => {
          if (path.startsWith('/v1/loops/edges')) {
            if (denied) throw new NexusApiError(status, path, null);
            return { edges: [{ at: new Date(Date.now() - 1_000).toISOString(), kind: 'request', from: 'OP', to: 'TC', ref: 'visible-edge' }] };
          }
          if (path.startsWith('/v1/schedules')) return { schedules: [], owners: [{ id: 'visible-loop', title: '기존 지도 데이터', owner: 'OP', enabled: true, lastRun: null, jobs: [] }] };
          return { loops: { loops: [] } };
        },
        logsStreamUrl: () => null,
      },
      config: { baseUrl: '', token: '', provider: '' },
    } as unknown as ComponentProps<typeof DaemonContext.Provider>['value'];
    let root: ReturnType<typeof create>;
    await act(async () => { root = create(<SearchParamsContext.Provider value={new URLSearchParams()}><DaemonContext.Provider value={value}><LoopAgentsScene initialMode="map" /></DaemonContext.Provider></SearchParamsContext.Provider>); });
    try {
      const map = () => root!.root.findByType(LoopActivityMap);
      expect(map().props.state).toBe('ready');
      expect(map().props.rows.map((row: { name: string }) => row.name)).toContain('기존 지도 데이터');
      expect(map().props.edges).toHaveLength(1);
      expect(refresh).toBeDefined();
      denied = true;
      await act(async () => { refresh!(); });
      expect(map().props.state).toBe('unauthorized');
      expect(map().props.rows).toEqual([]);
      expect(map().props.edges).toEqual([]);
      expect(map().props.seenAt).toEqual({});
      const text = JSON.stringify(root!.toJSON());
      expect(text).toContain('지도 원천에 접근 권한이 없습니다 — 토큰으로 다시 붙으세요');
      expect(text).not.toContain('기존 지도 데이터');
      expect(text).not.toContain('visible-edge');
      expect(text).not.toContain('지도를 읽는 중');
      expect(text).not.toContain('데몬 연결을 확인하세요');
    } finally { act(() => { root!.unmount(); }); }
  });
}

test('non-NexusApiError map failure keeps the existing error', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} } as unknown as Document;
  globalThis.window = { setInterval: () => 1, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {} } as unknown as Window & typeof globalThis;
  globalThis.fetch = (async () => new Response(JSON.stringify({ entries: [] }))) as unknown as typeof fetch;
  const value = {
    client: {
      fetchResponse: async () => new Response(JSON.stringify({ date: '2026-10-08', seats: [] })),
      fetchJson: async (path: string) => {
        if (path.startsWith('/v1/loops/edges')) throw new Error('network unavailable');
        if (path.startsWith('/v1/schedules')) return { schedules: [], owners: [] };
        return { loops: { loops: [] } };
      },
      logsStreamUrl: () => null,
    },
    config: { baseUrl: '', token: '', provider: '' },
  } as unknown as ComponentProps<typeof DaemonContext.Provider>['value'];
  let root: ReturnType<typeof create>;
  await act(async () => { root = create(<SearchParamsContext.Provider value={new URLSearchParams()}><DaemonContext.Provider value={value}><LoopAgentsScene initialMode="map" /></DaemonContext.Provider></SearchParamsContext.Provider>); });
  try {
    const map = root!.root.findByType(LoopActivityMap);
    expect(map.props.state).toBe('error');
    const text = JSON.stringify(root!.toJSON());
    expect(text).toContain('지도 원천을 읽지 못했습니다');
    expect(text).not.toContain('지도 원천에 접근 권한이 없습니다');
  } finally { act(() => { root!.unmount(); }); }
});

test('demo address asks one journey with ?ref=&mode=live instead of the 60-minute window; bad ids fall back', () => {
  const at = Date.parse('2026-10-05T10:00:00Z');
  expect(loopEdgesPath(at, 'card-1')).toBe('/v1/loops/edges?ref=card-1&mode=live&limit=500');
  expect(loopEdgesPath(at, null)).toBe('/v1/loops/edges?since=2026-10-05T09%3A00%3A00.000Z&limit=200');
  expect(loopEdgesPath(at, '../x')).toContain('since=');
  const details = mapNodeDetails(loopAgentsView(null, null), true);
  expect(details['agent:task-agent']).toEqual({ running: '못 읽음' });
  expect(details.TC).toEqual({ now: '못 읽음', waiting: '못 읽음' });
});
