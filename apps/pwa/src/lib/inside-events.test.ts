import { afterEach, describe, expect, test } from 'bun:test';
import { EMPTY_RUNS, fromLogFrame, reduceRuns, subscribeInsideEvents } from './inside-events';
import { _setEventSourceFactoryForTest } from './shared-event-source';

const frame = (data: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  category: 'graph.run', event: 'node', ts: '2026-10-03T00:00:00.000Z', data, ...overrides,
});
const node = { graphId: 'graph-a', runId: 'run-123456', nodeId: 'first', phase: 'start' } as const;

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

const useFake = () => _setEventSourceFactoryForTest((url) => new FakeEventSource(url) as unknown as EventSource);
afterEach(() => {
  _setEventSourceFactoryForTest(null);
  FakeEventSource.instances = [];
});

describe('inside log frame', () => {
  test('graph.run/node accepts the wire body, including optional seconds and JSON strings', () => {
    expect(fromLogFrame(JSON.stringify(frame({ ...node, seconds: 2.5 })))).toEqual({ kind: 'node', ...node, ts: '2026-10-03T00:00:00.000Z', seconds: 2.5 });
  });
  test('rejects other category/event, malformed JSON and invalid shapes', () => {
    expect(fromLogFrame(frame(node, { category: 'graph.edge' }))).toBeNull();
    expect(fromLogFrame(frame(node, { event: 'decision' }))).toBeNull();
    expect(fromLogFrame('{broken')).toBeNull();
    for (const bad of [null, [], {}, frame(null as never), frame({ ...node, phase: 'done' }), frame({ ...node, runId: '' }), frame({ ...node, seconds: '2' }), frame(node, { ts: 'bad' })]) {
      expect(fromLogFrame(bad)).toBeNull();
    }
  });
});

describe('run reduction', () => {
  test('start to ok, repeated start, arrival order, new run and immutable history', () => {
    const start = fromLogFrame(frame(node))!;
    const first = reduceRuns(EMPTY_RUNS, start);
    const ok = reduceRuns(first, { ...start, phase: 'ok', seconds: 3 });
    expect(ok.runs[start.runId].nodes.first).toEqual({ nodeId: 'first', phase: 'ok', retries: 0 });
    expect(ok.runs[start.runId]).toEqual({
      graphId: 'graph-a', runId: 'run-123456', startedAt: start.ts,
      order: ['first'], nodes: { first: { nodeId: 'first', phase: 'ok', retries: 0 } },
    });
    const retry = reduceRuns(ok, start);
    expect(retry.runs[start.runId].nodes.first).toMatchObject({ phase: 'start', retries: 1 });
    const two = reduceRuns(retry, { ...start, nodeId: 'second' });
    expect(two.runs[start.runId].order).toEqual(['first', 'second']);
    const other = reduceRuns(two, { ...start, runId: 'next-run', nodeId: 'else' });
    expect(other.currentRunId).toBe('next-run');
    expect(other.runs[start.runId]).toBe(two.runs[start.runId]);
    expect(first.runs[start.runId].nodes.first.phase).toBe('start');
    expect(EMPTY_RUNS.currentRunId).toBeNull();
  });
  test('a late event of an older run updates it without taking «now» back (A start → B start → A ok)', () => {
    const aStart = fromLogFrame(frame(node))!;
    const bStart = { ...aStart, runId: 'run-b', nodeId: 'b1' };
    const afterB = reduceRuns(reduceRuns(EMPTY_RUNS, aStart), bStart);
    expect(afterB.currentRunId).toBe('run-b');
    const lateA = reduceRuns(afterB, { ...aStart, phase: 'ok' });
    expect(lateA.currentRunId).toBe('run-b');
    expect(lateA.runs[aStart.runId].nodes.first.phase).toBe('ok');
    const bOk = reduceRuns(lateA, { ...bStart, phase: 'ok' });
    expect(bOk.currentRunId).toBe('run-b');
  });

  test('treats inherited run and node names as ordinary IDs', () => {
    const first = fromLogFrame(frame({ ...node, runId: '__proto__', nodeId: '__proto__' }))!;
    const state = reduceRuns(EMPTY_RUNS, first);
    expect(state.currentRunId).toBe('__proto__');
    expect(Object.hasOwn(state.runs, '__proto__')).toBe(true);
    expect(state.runs['__proto__'].order).toEqual(['__proto__']);
    expect(state.runs['__proto__'].nodes['__proto__']).toMatchObject({ phase: 'start', retries: 0 });
    const retried = reduceRuns(state, first);
    expect(retried.runs['__proto__'].nodes['__proto__'].retries).toBe(1);
    expect(Object.getPrototypeOf(retried.runs)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(retried.runs['__proto__'].nodes)).toBe(Object.prototype);
  });
});

describe('SSE subscription', () => {
  test('unavailable URL never opens an EventSource', () => {
    useFake();
    const unsubscribe = subscribeInsideEvents({ logsStreamUrl: () => null }, () => { throw Error('unexpected'); });
    expect(FakeEventSource.instances).toHaveLength(0);
    unsubscribe();
  });
  test('asks for graph.run, passes only node frames, and leaves reconnect to the EventSource (no close on error)', () => {
    useFake();
    const received: unknown[] = [];
    const unsubscribe = subscribeInsideEvents({ logsStreamUrl: (params) => {
      expect(params).toEqual({ category: 'graph.run' });
      return '/v1/logs/stream?category=graph.run';
    } }, (event) => received.push(event));
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe('/v1/logs/stream?category=graph.run');
    source.emit('log', { data: '{bad' });
    source.emit('log', { data: JSON.stringify(frame(node, { category: 'other' })) });
    source.emit('log', { data: JSON.stringify(frame(node, { category: 'graph.runner', event: 'node-start' })) });
    source.emit('log', { data: JSON.stringify(frame(node)) });
    expect(received).toHaveLength(1);
    source.onerror?.({});
    expect(source.closed).toBe(false);
    unsubscribe();
    source.emit('log', { data: JSON.stringify(frame(node)) });
    expect(received).toHaveLength(1);
  });
  test('two subscribers share one connection; the last unsubscribe closes it', () => {
    useFake();
    const a = subscribeInsideEvents({ logsStreamUrl: () => '/stream' }, () => {});
    const b = subscribeInsideEvents({ logsStreamUrl: () => '/stream' }, () => {});
    expect(FakeEventSource.instances).toHaveLength(1);
    a();
    expect(FakeEventSource.instances[0].closed).toBe(false);
    b();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });
});
