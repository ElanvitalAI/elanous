import { afterEach, describe, expect, test } from 'bun:test';
import { EMPTY_RUNS, fromLogFrame, fromWizardLogFrame, reduceRuns, subscribeInsideEvents, subscribePtyDecisions, subscribeWizardSteps } from './inside-events';
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

test('wizard.step frames reach the inside flow in order, ignoring malformed events', () => {
  useFake();
  const received: string[] = [];
  const unsubscribe = subscribeWizardSteps({ logsStreamUrl: params => {
    expect(params).toEqual({ exactCategory: 'wizard.step' });
    return '/v1/logs/stream?exactCategory=wizard.step';
  } }, event => received.push(event.step));
  const source = FakeEventSource.instances[0];
  for (const step of ['request', 'research', 'draft', 'validate', 'install', 'done']) {
    source.emit('log', { data: JSON.stringify({ category: 'wizard.step', event: 'wizard.step', data: { ts: '2026-10-03T00:00:00Z', wizardId: 'wizard-1', step, text: step } }) });
  }
  expect(received).toEqual(['request', 'research', 'draft', 'validate', 'install', 'done']);
  expect(fromWizardLogFrame({ category: 'wizard.step', event: 'wizard.step', data: { wizardId: 'w', step: 'unknown', text: 'bad', ts: '2026-10-03T00:00:00Z' } })).toBeNull();
  unsubscribe();
  source.emit('log', { data: JSON.stringify({ category: 'wizard.step', event: 'wizard.step', data: { ts: '2026-10-03T00:00:00Z', wizardId: 'w', step: 'done', text: 'done' } }) });
  expect(received).toHaveLength(6);
});

test('pty.decision subscribes by exact category, forwards valid data once, rejects malformed frames and unsubscribes', () => {
  useFake();
  const received: unknown[] = [];
  const decision = { ts: '2026-10-03T08:35:00Z', missionId: 'mission-1', seq: 1, sessionId: 'session-1', terminalId: 'terminal-1', agent: 'codex', step: 'read', text: '읽기' };
  const unsubscribe = subscribePtyDecisions({ logsStreamUrl: params => {
    expect(params).toEqual({ exactCategory: 'pty.decision' });
    return '/v1/logs/stream?exactCategory=pty.decision';
  } }, event => received.push(event));
  const source = FakeEventSource.instances[0];
  expect(source.url).toBe('/v1/logs/stream?exactCategory=pty.decision');
  source.emit('log', { data: '{broken' });
  source.emit('log', { data: JSON.stringify({ category: 'wizard.step', event: 'read', data: decision }) });
  source.emit('log', { data: JSON.stringify({ category: 'pty.decision', event: 'judge', data: decision }) });
  source.emit('log', { data: JSON.stringify({ category: 'pty.decision', event: 'read', data: { ...decision, seq: '1' } }) });
  source.emit('log', { data: JSON.stringify({ category: 'pty.decision', event: 'read', data: null }) });
  expect(received).toHaveLength(0);
  source.emit('log', { data: JSON.stringify({ category: 'pty.decision', event: 'read', data: decision }) });
  expect(received).toEqual([decision]);
  unsubscribe();
  expect(source.closed).toBe(true);
  source.emit('log', { data: JSON.stringify({ category: 'pty.decision', event: 'read', data: decision }) });
  expect(received).toHaveLength(1);
});

test('pty.decision has a no-op unsubscribe and opens no connection when the URL is absent', () => {
  useFake();
  const unsubscribe = subscribePtyDecisions({ logsStreamUrl: params => {
    expect(params).toEqual({ exactCategory: 'pty.decision' });
    return null;
  } }, () => { throw Error('unexpected'); });
  expect(FakeEventSource.instances).toHaveLength(0);
  unsubscribe();
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
