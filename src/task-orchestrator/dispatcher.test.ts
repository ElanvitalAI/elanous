import { describe, expect, test } from 'bun:test';
import { TaskDispatcher, DEFAULT_CONCURRENCY_CAPS } from './dispatcher.js';
import { TaskGraph } from './graph.js';
import { SurfaceRegistry, type SurfaceAdapter } from './surface-registry.js';
import { createTask, type Task } from './types.js';
import { TaskStore } from './store.js';
import type { OpsEventInput } from '../domains/ops-log.js';

function selfImplementTask(id: string): Task {
  return createTask(
    { title: `self-implement-${id}`, surface: { kind: 'self-implement', feature: id } },
    { id: `task:${id}` },
  );
}

function pendingAdapter(): SurfaceAdapter {
  return async (task) => ({
    executionId: `execution:${task.id}`,
    promise: new Promise(() => {}),
  });
}

function readySelfImplementGraph(count: number): TaskGraph {
  const graph = new TaskGraph();
  for (let index = 0; index < count; index++) graph.addTask(selfImplementTask(String(index)));
  graph.promoteReady();
  return graph;
}

function dispatcherFor(
  count: number,
  recordOpsEvent: (input: OpsEventInput) => unknown,
  concurrencyCaps?: { 'self-implement': number },
): TaskDispatcher {
  const graph = readySelfImplementGraph(count);
  const registry = new SurfaceRegistry();
  registry.register('self-implement', pendingAdapter());
  return new TaskDispatcher({ graph, registry, recordOpsEvent, concurrencyCaps });
}

describe('TaskDispatcher persistence and rejection', () => {
  test('adapter rejection records a failed execution and final task in the API store', async () => {
    const store = new TaskStore({ path: ':memory:' });
    try {
      const graph = new TaskGraph();
      const registry = new SurfaceRegistry();
      const item = createTask({ title: 'reject', surface: { kind: 'subagent', definitionName: 'missing', prompt: 'go' }, status: 'ready' });
      store.saveTask(item);
      graph.addTask(item);
      registry.register('subagent', async () => { throw new Error('definition not found'); });
      const dispatcher = new TaskDispatcher({ graph, registry, store, recordOpsEvent: () => {} });
      const result = dispatcher.tickTask(item.id);
      expect(result.dispatched).toHaveLength(1);
      expect(store.getTask(item.id)?.status).toBe('running');
      await result.dispatched[0]!.promise;
      expect(store.getTask(item.id)).toMatchObject({ status: 'failed', lastExecutionId: result.dispatched[0]!.executionId });
      expect(store.listExecutions(item.id)).toMatchObject([{
        id: result.dispatched[0]!.executionId, surface: item.surface, status: 'failed',
        error: { code: 'ADAPTER_ERROR', message: 'definition not found' },
      }]);
    } finally {
      store.close();
    }
  });
});

describe('TaskDispatcher self-implement concurrency observation', () => {
  test('defaults to three admissions and records one cap wait event for surplus work', () => {
    const events: OpsEventInput[] = [];
    const cap = DEFAULT_CONCURRENCY_CAPS['self-implement'];
    const result = dispatcherFor(cap + 1, (event) => events.push(event)).tick();

    expect(cap).toBe(3);
    expect(result.dispatched).toHaveLength(cap);
    expect(result.deferred).toEqual([{ taskId: `task:${cap}`, reason: 'cap' }]);
    const blocked = events.filter((event) => event.event === 'blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.refs).toMatchObject({
      surface: 'self-implement',
      cap,
      deferred: 1,
      deferredTaskIds: [`task:${cap}`],
    });
  });

  test('admits every task at or below the default cap without a cap wait event', () => {
    const events: OpsEventInput[] = [];
    const cap = DEFAULT_CONCURRENCY_CAPS['self-implement'];
    const result = dispatcherFor(cap, (event) => events.push(event)).tick();

    expect(result.dispatched).toHaveLength(cap);
    expect(result.deferred).toHaveLength(0);
    expect(events.filter((event) => event.event === 'blocked')).toHaveLength(0);
  });

  test('preserves zero as pause and Infinity as unrestricted override without storage IO', () => {
    const zeroEvents: OpsEventInput[] = [];
    const zero = dispatcherFor(2, (event) => zeroEvents.push(event), { 'self-implement': 0 }).tick();
    expect(zero.dispatched).toHaveLength(0);
    expect(zero.deferred).toEqual([
      { taskId: 'task:0', reason: 'cap' },
      { taskId: 'task:1', reason: 'cap' },
    ]);
    expect(zeroEvents.filter((event) => event.event === 'blocked')).toHaveLength(1);
    expect(zeroEvents.find((event) => event.event === 'blocked')?.refs).toMatchObject({
      cap: 0,
      deferred: 2,
    });

    const infinityEvents: OpsEventInput[] = [];
    const infinity = dispatcherFor(5, (event) => infinityEvents.push(event), { 'self-implement': Infinity }).tick();
    expect(infinity.dispatched).toHaveLength(5);
    expect(infinity.deferred).toHaveLength(0);
    expect(infinityEvents.filter((event) => event.event === 'blocked')).toHaveLength(0);
  });

  test('continues dispatch when the injected observation sink throws', () => {
    const cap = DEFAULT_CONCURRENCY_CAPS['self-implement'];
    const result = dispatcherFor(cap + 1, () => { throw new Error('sink unavailable'); }).tick();

    expect(result.dispatched).toHaveLength(cap);
    expect(result.deferred).toEqual([{ taskId: `task:${cap}`, reason: 'cap' }]);
  });
});
