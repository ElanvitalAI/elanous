import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import type { ComponentProps } from 'react';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { EMPTY_RUNS, fromLogFrame, reduceRuns } from '@/lib/inside-events';
import { LiveTraceScene, LiveTraceView } from './LiveTraceScene';

const event = fromLogFrame({
  category: 'graph.run', event: 'node', ts: '2026-10-03T00:00:00.000Z',
  data: { graphId: 'demo-graph', runId: 'abcdef123456', nodeId: 'alpha', phase: 'start' },
})!;
const at = Date.parse(event.ts);
const settlement = (nodeId: string, phase: 'ok' | 'fail', receivedAt: number, ts = new Date(receivedAt).toISOString()) =>
  ({ nodeId, phase, receivedAt, ts });
const render = (state: Parameters<typeof LiveTraceView>[0]['state'], now = at, receivedAt = at,
  lastSettlement?: Parameters<typeof LiveTraceView>[0]['lastSettlement']) =>
  renderToStaticMarkup(<LiveTraceView state={state} now={now} receivedAt={receivedAt} lastSettlement={lastSettlement} />);

describe('LiveTraceView', () => {
  test('shows the initial idle message and inert recording placeholder', () => {
    const html = render(EMPTY_RUNS);
    expect(html).toContain('지금 도는 런이 없습니다');
    expect(html).toContain('마지막 활동: 확인 중');
    expect(html).not.toContain('마지막 활동: 기록 없음');
    expect(html).toContain('녹화 보기');
    expect(html).toContain('disabled');
    expect(html).toContain('text-lg');
  });

  test('idle shows the measured last activity time or distinguishes no record from an unreadable history', () => {
    const recorded = renderToStaticMarkup(<LiveTraceView state={EMPTY_RUNS} now={at} receivedAt={0} lastActivityTs={event.ts} />);
    expect(recorded).toContain('마지막 활동:');
    expect(recorded).toContain(`<time dateTime="${event.ts}">`);
    expect(recorded).toContain('KST</time>');
    expect(render(EMPTY_RUNS)).toContain('마지막 활동: 확인 중');
    expect(renderToStaticMarkup(<LiveTraceView state={EMPTY_RUNS} now={at} receivedAt={0} activityStatus="ready" />)).toContain('마지막 활동: 기록 없음');
    expect(renderToStaticMarkup(<LiveTraceView state={EMPTY_RUNS} now={at} receivedAt={0} activityStatus="unavailable" />)).toContain('마지막 활동: 못 읽음');
    expect(renderToStaticMarkup(<LiveTraceView state={EMPTY_RUNS} now={at} receivedAt={0} activityStatus="loading" />)).toContain('마지막 활동: 확인 중');
    expect(renderToStaticMarkup(<LiveTraceView state={EMPTY_RUNS} now={at} receivedAt={0} lastActivityTs="invalid" />)).not.toContain('<time');
    expect(render(reduceRuns(EMPTY_RUNS, event))).not.toContain('마지막 활동:');
  });

  test('shows the wizard step on the inside trace alongside an idle graph', () => {
    const html = renderToStaticMarkup(<LiveTraceView state={EMPTY_RUNS} now={at} receivedAt={at}
      wizardSteps={[
        { wizardId: 'w1', ts: event.ts, step: 'request', text: '요청' },
        { wizardId: 'w1', ts: event.ts, step: 'research', text: '3건 조사' },
      ]} />);
    expect(html).toContain('플러그인 마법사 흐름');
    expect(html).toContain('마법사 request · 요청');
    expect(html).toContain('마법사 research · 3건 조사');
    expect(html.indexOf('마법사 request')).toBeLessThan(html.indexOf('마법사 research'));
  });

  test('shows header, elapsed time, arrival order and running pulse then green ok', () => {
    const first = reduceRuns(EMPTY_RUNS, event);
    const running = render(first, at + 3_000);
    expect(running).toContain('demo-graph');
    expect(running).toContain('런 abcdef');
    expect(running).not.toContain('abcdef123456');
    expect(running).toContain('경과 3초');
    expect(running).toContain('animate-pulse');
    expect(running).toContain('진행 중');
    const second = reduceRuns(first, { ...event, nodeId: 'beta', ts: new Date(at + 1_000).toISOString() });
    const complete = reduceRuns(second, { ...event, phase: 'ok', ts: new Date(at + 2_000).toISOString() });
    const html = render(complete, at + 3_000);
    expect(html).toContain('border-green-500');
    expect(html).toContain('alpha · ok');
    expect(html.indexOf('alpha · ok')).toBeLessThan(html.indexOf('beta · 진행 중'));
    expect(html).toContain('flex-wrap');
    expect(render(complete, at + 20_000, at + 2_000)).not.toContain('완료 ·');
  });

  test('renders a failed node red, retries ↻1, and replaces the current run', () => {
    const first = reduceRuns(EMPTY_RUNS, event);
    const again = reduceRuns(first, event);
    expect(render(again)).toContain('↻1');
    const failed = reduceRuns(again, { ...event, phase: 'fail' });
    expect(render(failed)).toContain('border-red-500');
    expect(render(failed)).toContain('alpha · fail');
    const next = reduceRuns(failed, { ...event, runId: 'second987', nodeId: 'next' });
    expect(render(next)).toContain('런 second');
    expect(render(next)).not.toContain('alpha');
  });

  test('renders waiting grey and transitions to idle only after 60 seconds without events', () => {
    const active = reduceRuns(EMPTY_RUNS, event);
    expect(render(active, at + 60_000)).toContain('alpha');
    const idle = render(active, at + 60_001);
    expect(idle).toContain('지금 도는 런이 없습니다');
    expect(idle).toContain('녹화 보기');
    expect(idle).not.toContain('alpha');
    const finished = fromLogFrame({
      category: 'graph.run', event: 'node', ts: new Date(at + 1_000).toISOString(),
      data: { graphId: event.graphId, runId: event.runId, nodeId: event.nodeId, phase: 'ok' },
    })!;
    const waiting = reduceRuns(active, finished);
    expect(render(waiting, at + 2_000, at + 1_000, settlement('alpha', 'ok', at + 1_000))).toContain('다음 단계 준비 중');
    expect(render(waiting, at + 2_000, at + 1_000)).not.toContain('>대기<');
  });

  test('settled a ok · b ok · done ok shows completion after 15 seconds without a new start', () => {
    let state = reduceRuns(EMPTY_RUNS, event);
    for (const [nodeId, phase, seconds] of [
      ['alpha', 'ok', 1], ['beta', 'start', 2], ['beta', 'ok', 3], ['done', 'start', 4], ['done', 'ok', 5],
    ] as const) state = reduceRuns(state, { ...event, nodeId, phase, ts: new Date(at + seconds * 1000).toISOString() });
    const ended = settlement('done', 'ok', at + 5_000);
    expect(render(state, at + 19_999, at + 5_000, ended)).toContain('다음 단계 준비 중');
    const html = render(state, at + 20_000, at + 5_000, ended);
    expect(html).toContain('완료 · 5초');
    expect(html).not.toContain('다음 단계 준비 중');
    expect(html).not.toContain('>대기<');
    expect(html).toContain('done · ok');
    expect(render(state, at + 59_999, at + 5_000, ended)).toContain('완료 ·');
    const restarted = reduceRuns(state, { ...event, nodeId: 'next', ts: new Date(at + 20_001).toISOString() });
    expect(render(restarted, at + 20_002, at + 20_001)).not.toContain('완료 ·');
  });

  test('omitting the actual last settlement never invents a completion or duration', () => {
    const finished = reduceRuns(reduceRuns(EMPTY_RUNS, event), { ...event, phase: 'ok', ts: new Date(at + 1_000).toISOString() });
    const html = render(finished, at + 20_000, at + 1_000);
    expect(html).not.toContain('완료 ·');
    expect(html).not.toContain('다음 단계 준비 중');
  });

  test('a failed final node reports its name once the quiet window expires', () => {
    const active = reduceRuns(EMPTY_RUNS, event);
    const succeeded = reduceRuns(active, { ...event, phase: 'ok', ts: new Date(at + 500).toISOString() });
    const failed = reduceRuns(succeeded, { ...event, nodeId: 'broken', phase: 'fail', ts: new Date(at + 1_000).toISOString() });
    const html = render(failed, at + 16_000, at + 1_000, settlement('broken', 'fail', at + 1_000));
    expect(html).toContain('실패 · broken');
    expect(html).not.toContain('다음 단계 준비 중');
    expect(html).not.toContain('완료 ·');
    expect(html).not.toContain('>대기<');
  });
});

describe('LiveTraceScene connection lifecycle', () => {
  const originalEventSource = globalThis.EventSource;
  afterEach(() => { globalThis.EventSource = originalEventSource; delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

  test('counts 60 seconds of silence from receipt, even when the streamed log is two minutes old', () => {
    let clock = at + 120_000;
    const now = spyOn(Date, 'now').mockImplementation(() => clock);
    const originalInterval = globalThis.setInterval;
    let tick: (() => void) | undefined;
    globalThis.setInterval = ((fn: () => void) => {
      tick = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    class FakeEventSource {
      static source: FakeEventSource;
      listeners = new Map<string, (message: { data: string }) => void>();
      constructor(_url: string) { FakeEventSource.source = this; }
      addEventListener(name: string, fn: (message: { data: string }) => void) { this.listeners.set(name, fn); }
      close() {}
      log(frame: unknown) { this.listeners.get('log')?.({ data: JSON.stringify(frame) }); }
    }
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const value = {
      client: { logsStreamUrl: () => '/stream', listLogs: async () => ({ ok: true, logs: [] }) },
      config: { baseUrl: '/stream', token: '', provider: '' },
    } as unknown as ComponentProps<typeof DaemonContext.Provider>['value'];
    let root: ReturnType<typeof create> | undefined;
    try {
      act(() => { root = create(<DaemonContext.Provider value={value}><LiveTraceScene /></DaemonContext.Provider>); });
      expect(tick).toBeDefined();
      act(() => { FakeEventSource.source.log({
        category: 'graph.run', event: 'node', ts: event.ts,
        data: { graphId: event.graphId, runId: event.runId, nodeId: event.nodeId, phase: event.phase },
      }); });
      expect(JSON.stringify(root!.toJSON())).toContain('alpha');
      clock += 60_000;
      act(() => { tick!(); });
      expect(JSON.stringify(root!.toJSON())).toContain('alpha');
      clock += 1;
      act(() => { tick!(); });
      expect(JSON.stringify(root!.toJSON())).toContain('지금 도는 런이 없습니다');
      expect(JSON.stringify(root!.toJSON())).not.toContain('alpha');
    } finally {
      if (root) act(() => { root!.unmount(); });
      globalThis.setInterval = originalInterval;
      now.mockRestore();
    }
  });

  test('shows the latest persisted node time without waiting for a new live frame', async () => {
    class FakeEventSource {
      addEventListener() {}
      close() {}
    }
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const client = { logsStreamUrl: () => '/stream', listLogs: async () => ({ ok: true, logs: [{ ts: event.ts }] }) };
    const value = { client, config: { baseUrl: '/stream', token: '', provider: '' } } as unknown as ComponentProps<typeof DaemonContext.Provider>['value'];
    let root: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { root = create(<DaemonContext.Provider value={value}><LiveTraceScene /></DaemonContext.Provider>); });
      const html = JSON.stringify(root!.toJSON());
      expect(html).toContain('지금 도는 런이 없습니다');
      expect(html).toContain(event.ts);
      expect(html).not.toContain('기록 없음');
    } finally { if (root) act(() => root!.unmount()); }
  });

  test('hydrates the last node time on an idle screen, then keeps a newer streamed time when the history request arrives late', async () => {
    let clock = at + 120_000;
    const now = spyOn(Date, 'now').mockImplementation(() => clock);
    const originalInterval = globalThis.setInterval;
    let tick: (() => void) | undefined;
    globalThis.setInterval = ((fn: () => void) => { tick = fn; return 1 as unknown as ReturnType<typeof setInterval>; }) as typeof setInterval;
    let resolveHistory!: (value: { ok: boolean; logs: Array<{ ts: string }> }) => void;
    const requests: Record<string, string>[] = [];
    const history = new Promise<{ ok: boolean; logs: Array<{ ts: string }> }>(resolve => { resolveHistory = resolve; });
    class FakeEventSource {
      static source: FakeEventSource;
      listeners = new Map<string, (message: { data: string }) => void>();
      constructor(_url: string) { FakeEventSource.source = this; }
      addEventListener(name: string, fn: (message: { data: string }) => void) { this.listeners.set(name, fn); }
      close() {}
      log(ts: string) { this.listeners.get('log')?.({ data: JSON.stringify({
        category: 'graph.run', event: 'node', ts,
        data: { graphId: event.graphId, runId: event.runId, nodeId: event.nodeId, phase: event.phase },
      }) }); }
    }
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const client = { logsStreamUrl: () => '/stream', listLogs: (params: Record<string, string>) => { requests.push(params); return history; } };
    const value = { client, config: { baseUrl: '/stream', token: '', provider: '' } } as unknown as ComponentProps<typeof DaemonContext.Provider>['value'];
    let root: ReturnType<typeof create> | undefined;
    try {
      act(() => { root = create(<DaemonContext.Provider value={value}><LiveTraceScene /></DaemonContext.Provider>); });
      expect(requests).toEqual([{ category: 'graph.run', event: 'node', limit: '1' }]);
      expect(JSON.stringify(root!.toJSON())).toContain('확인 중');
      const streamed = new Date(clock).toISOString();
      act(() => FakeEventSource.source.log(streamed));
      await act(async () => { resolveHistory({ ok: true, logs: [{ ts: event.ts }] }); await history; });
      clock += 60_001;
      act(() => tick!());
      const html = JSON.stringify(root!.toJSON());
      expect(html).toContain('지금 도는 런이 없습니다');
      expect(html).toContain('마지막 활동: ');
      expect(html).toContain(streamed);
      expect(html).not.toContain(`"dateTime":"${event.ts}"`);
    } finally {
      if (root) act(() => root!.unmount());
      globalThis.setInterval = originalInterval;
      now.mockRestore();
    }
  });

  test('alpha start → beta start → beta ok → alpha fail ends as failure, not registration-order success', () => {
    let clock = at;
    const now = spyOn(Date, 'now').mockImplementation(() => clock);
    const originalInterval = globalThis.setInterval;
    let tick: (() => void) | undefined;
    globalThis.setInterval = ((fn: () => void) => { tick = fn; return 1 as unknown as ReturnType<typeof setInterval>; }) as typeof setInterval;
    class FakeEventSource {
      static source: FakeEventSource;
      listeners = new Map<string, (message: { data: string }) => void>();
      constructor(_url: string) { FakeEventSource.source = this; }
      addEventListener(name: string, fn: (message: { data: string }) => void) { this.listeners.set(name, fn); }
      close() {}
      log(nodeId: string, phase: 'start' | 'ok' | 'fail') { this.listeners.get('log')?.({ data: JSON.stringify({
        category: 'graph.run', event: 'node', ts: new Date(clock).toISOString(),
        data: { graphId: event.graphId, runId: event.runId, nodeId, phase },
      }) }); }
    }
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const value = { client: { logsStreamUrl: () => '/stream', listLogs: async () => ({ ok: true, logs: [] }) }, config: { baseUrl: '/stream', token: '', provider: '' } } as unknown as ComponentProps<typeof DaemonContext.Provider>['value'];
    let root: ReturnType<typeof create> | undefined;
    try {
      act(() => { root = create(<DaemonContext.Provider value={value}><LiveTraceScene /></DaemonContext.Provider>); });
      act(() => FakeEventSource.source.log('alpha', 'start'));
      clock += 1_000;
      act(() => FakeEventSource.source.log('beta', 'start'));
      clock += 1_000;
      act(() => FakeEventSource.source.log('beta', 'ok'));
      clock += 1_000;
      act(() => FakeEventSource.source.log('alpha', 'fail'));
      clock += 15_000;
      act(() => tick!());
      const html = JSON.stringify(root!.toJSON());
      expect(html).toContain('실패 · alpha');
      expect(html).not.toContain('완료 ·');
      expect(html).not.toContain('다음 단계 준비 중');
    } finally {
      if (root) act(() => root!.unmount());
      globalThis.setInterval = originalInterval;
      now.mockRestore();
    }
  });

  test('a duplicate settled frame does not restart the 15-second completion window', () => {
    let clock = at;
    const now = spyOn(Date, 'now').mockImplementation(() => clock);
    const originalInterval = globalThis.setInterval;
    let tick: (() => void) | undefined;
    globalThis.setInterval = ((fn: () => void) => {
      tick = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    class FakeEventSource {
      static source: FakeEventSource;
      listeners = new Map<string, (message: { data: string }) => void>();
      constructor(_url: string) { FakeEventSource.source = this; }
      addEventListener(name: string, fn: (message: { data: string }) => void) { this.listeners.set(name, fn); }
      close() {}
      log(phase: 'start' | 'ok') { this.listeners.get('log')?.({ data: JSON.stringify({
        category: 'graph.run', event: 'node', ts: new Date(clock).toISOString(),
        data: { graphId: event.graphId, runId: event.runId, nodeId: event.nodeId, phase },
      }) }); }
    }
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const value = { client: { logsStreamUrl: () => '/stream', listLogs: async () => ({ ok: true, logs: [] }) }, config: { baseUrl: '/stream', token: '', provider: '' } } as unknown as ComponentProps<typeof DaemonContext.Provider>['value'];
    let root: ReturnType<typeof create> | undefined;
    try {
      act(() => { root = create(<DaemonContext.Provider value={value}><LiveTraceScene /></DaemonContext.Provider>); });
      act(() => FakeEventSource.source.log('start'));
      clock += 1_000;
      act(() => FakeEventSource.source.log('ok'));
      clock += 14_000;
      act(() => FakeEventSource.source.log('ok'));
      clock += 1_000;
      act(() => tick!());
      expect(JSON.stringify(root!.toJSON())).toContain('완료 ·');
    } finally {
      if (root) act(() => root!.unmount());
      globalThis.setInterval = originalInterval;
      now.mockRestore();
    }
  });

  test('switches daemon without showing stale nodes or accepting a late old-source frame', () => {
    const sources: Array<{ url: string; isClosed: () => boolean; log: (json: unknown) => void }> = [];
    class FakeEventSource {
      listeners = new Map<string, (event: { data: string }) => void>();
      closed = false;
      constructor(public url: string) {
        sources.push({ url, isClosed: () => this.closed, log: (json) => this.listeners.get('log')?.({ data: JSON.stringify(json) }) });
      }
      addEventListener(name: string, fn: (event: { data: string }) => void) { this.listeners.set(name, fn); }
      close() { this.closed = true; }
    }
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const client = { logsStreamUrl: () => '/old', listLogs: async () => ({ ok: true, logs: [] }) };
    const value = (baseUrl: string) => ({ client, config: { baseUrl, token: '', provider: '' } }) as unknown as ComponentProps<typeof DaemonContext.Provider>['value'];
    const oldFrame = { category: 'graph.run', event: 'node', ts: event.ts, data: { graphId: event.graphId, runId: event.runId, nodeId: event.nodeId, phase: event.phase } };
    let root: ReturnType<typeof create>;
    act(() => { root = create(<DaemonContext.Provider value={value('/old')}><LiveTraceScene /></DaemonContext.Provider>); });
    try {
      expect(sources).toHaveLength(1);
      act(() => { sources[0].log(oldFrame); });
      expect(JSON.stringify(root!.toJSON())).toContain('demo-graph');
      client.logsStreamUrl = () => '/new';
      act(() => { root!.update(<DaemonContext.Provider value={value('/new')}><LiveTraceScene /></DaemonContext.Provider>); });
      expect(sources[0].isClosed()).toBe(true);
      expect(sources[1].url).toBe('/new');
      expect(JSON.stringify(root!.toJSON())).toContain('지금 도는 런이 없습니다');
      act(() => { sources[0].log(oldFrame); });
      expect(JSON.stringify(root!.toJSON())).not.toContain('demo-graph');
      expect(JSON.stringify(root!.toJSON())).not.toContain(`"dateTime":"${event.ts}"`);
      const nextFrame = { ...oldFrame, data: { ...oldFrame.data, graphId: 'new-graph', runId: 'new-run', nodeId: 'new-node' } };
      act(() => { sources[1].log(nextFrame); });
      expect(JSON.stringify(root!.toJSON())).toContain('new-graph');
      expect(JSON.stringify(root!.toJSON())).not.toContain('demo-graph');
    } finally {
      act(() => { root!.unmount(); });
      expect(sources[1].isClosed()).toBe(true);
    }
  });
});
