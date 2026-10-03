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
const render = (state: Parameters<typeof LiveTraceView>[0]['state'], now = at, receivedAt = at) =>
  renderToStaticMarkup(<LiveTraceView state={state} now={now} receivedAt={receivedAt} />);

describe('LiveTraceView', () => {
  test('shows the initial idle message and inert recording placeholder', () => {
    const html = render(EMPTY_RUNS);
    expect(html).toContain('지금 도는 런이 없습니다');
    expect(html).toContain('녹화 보기');
    expect(html).toContain('disabled');
    expect(html).toContain('text-lg');
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
    expect(render(waiting, at + 2_000)).toContain('bg-muted');
    expect(render(waiting, at + 2_000)).toContain('대기');
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
      client: { logsStreamUrl: () => '/stream' },
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
    const client = { logsStreamUrl: () => '/old' };
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
