import { expect, test } from 'bun:test';
import { TaskGraph } from './graph.js';
import { TaskEventBus } from './events.js';
import { TaskStore } from './store.js';
import { createTask, type TaskStatus } from './types.js';
import { startToxLoop } from './tox-loop.js';
import { TaskDispatcher } from './dispatcher.js';
import { SurfaceRegistry } from './surface-registry.js';

const flush = async () => { await new Promise(resolve => setTimeout(resolve, 10)); };

const makeTask = (graph: TaskGraph, provider: 'linear' | 'asana', id: string) => {
  const task = createTask({ title: 'external work', status: 'ready',
    surface: { kind: 'skill', skillName: 'test' },
    generatedBy: { kind: 'external', provider, ref: 'issue-id' }, approval: { state: 'approved' },
  }, { id });
  graph.addTask(task);
  return task;
};

test('state-transition subscription projects only Linear-origin tasks and includes stored execution result', async () => {
  const graph = new TaskGraph();
  const bus = new TaskEventBus();
  const store = new TaskStore({ path: ':memory:' });
  const linear = makeTask(graph, 'linear', 'task:1001');
  const other = makeTask(graph, 'asana', 'task:1002');
  store.saveTask(linear);
  const projected: Array<{ status: TaskStatus; output?: string; executionId?: string }> = [];
  let keyReads = 0;
  const loop = startToxLoop({ graph, bus, store, dispatcher: { tickTask: () => ({ dispatched: [], deferred: [] }) },
    intervalMs: 60_000, budgetCheck: async () => ({ canAfford: false, tripped: ['hold'] }),
    linearProjection: {
      getApiKey: async () => { keyReads++; return 'key'; },
      project: async ({ task, apiKey, execution }) => {
        expect(apiKey).toBe('key');
        projected.push({ status: task.status, output: execution?.output, executionId: task.lastExecutionId });
        return true;
      },
    },
  });
  try {
    bus.emit({ kind: 'task-started', taskId: other.id, executionId: 'exec:other' });
    bus.emit({ kind: 'task-status-changed', taskId: other.id, from: 'ready', to: 'review' });
    expect(keyReads).toBe(0);

    const executionId = 'exec:1001';
    store.saveExecution({ id: executionId, taskId: linear.id, startedAt: 1, status: 'completed',
      surface: linear.surface, output: 'Finished work' });
    bus.emit({ kind: 'task-started', taskId: linear.id, executionId });
    graph.updateTask(linear.id, { status: 'running', lastExecutionId: executionId });
    bus.emit({ kind: 'task-status-changed', taskId: linear.id, from: 'running', to: 'review' });
    bus.emit({ kind: 'task-completed', taskId: linear.id, executionId });
    await flush();
    expect(projected).toEqual([
      { status: 'running', executionId, output: 'Finished work' },
      { status: 'review', executionId, output: 'Finished work' },
      { status: 'done', executionId, output: 'Finished work' },
    ]);
    expect(keyReads).toBe(3);
  } finally { loop.stop(); store.close(); }
});

test('sequential Linear transitions preserve outgoing projection order without delaying task execution', async () => {
  const graph = new TaskGraph();
  const bus = new TaskEventBus();
  const task = makeTask(graph, 'linear', 'task:4001');
  const statuses: TaskStatus[] = [];
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const loop = startToxLoop({ graph, bus, dispatcher: { tickTask: () => ({ dispatched: [], deferred: [] }) },
    intervalMs: 60_000, budgetCheck: async () => ({ canAfford: false, tripped: ['hold'] }),
    linearProjection: { getApiKey: async () => 'key', project: async ({ task: snapshot }) => {
      statuses.push(snapshot.status);
      if (snapshot.status === 'running') await hold;
      return true;
    } },
  });
  try {
    graph.updateTask(task.id, { status: 'running' });
    bus.emit({ kind: 'task-started', taskId: task.id, executionId: 'exec:4001' });
    graph.updateTask(task.id, { status: 'done' });
    bus.emit({ kind: 'task-completed', taskId: task.id, executionId: 'exec:4001' });
    await flush();
    expect(graph.getTask(task.id)?.status).toBe('done');
    expect(statuses).toEqual(['running']);
    release();
    await flush();
    expect(statuses).toEqual(['running', 'done']);
  } finally { release(); loop.stop(); }
});

test('dispatcher review transition reaches the projector with persisted output', async () => {
  const graph = new TaskGraph();
  const bus = new TaskEventBus();
  const store = new TaskStore({ path: ':memory:' });
  const registry = new SurfaceRegistry();
  const task = makeTask(graph, 'linear', 'task:3001');
  store.saveTask(task);
  registry.register('skill', async () => ({ executionId: 'exec:adapter', promise: Promise.resolve({
    id: 'exec:adapter', taskId: task.id, startedAt: 1, status: 'completed', surface: task.surface,
    output: 'needs review', reviewRequired: true,
  }) }));
  const projected: Array<{ status: TaskStatus; output?: string }> = [];
  const loop = startToxLoop({ graph, bus, store, dispatcher: new TaskDispatcher({ graph, bus, store, registry }),
    intervalMs: 60_000, budgetCheck: async () => ({ canAfford: true, tripped: [] }),
    linearProjection: { getApiKey: async () => 'key', project: async ({ task, execution }) => {
      projected.push({ status: task.status, output: execution?.output });
      return true;
    } },
  });
  try {
    const result = await loop.tick();
    await Promise.all(result.dispatched.map(item => item.promise));
    await flush();
    expect(graph.getTask(task.id)?.status).toBe('review');
    expect(projected).toEqual([{ status: 'running', output: undefined }, { status: 'review', output: 'needs review' }]);
  } finally { loop.stop(); store.close(); }
});

test('rejected Linear projection is observable but does not block TOX event delivery or execution', async () => {
  const graph = new TaskGraph();
  const bus = new TaskEventBus();
  const task = makeTask(graph, 'linear', 'task:2001');
  const errors: string[] = [];
  let delivered = 0;
  const loop = startToxLoop({ graph, bus, dispatcher: { tickTask: () => ({ dispatched: [], deferred: [] }) },
    intervalMs: 60_000, budgetCheck: async () => ({ canAfford: false, tripped: ['hold'] }),
    log: (event, data) => { if (event === 'skipped' && data.reason) errors.push(data.reason); },
    linearProjection: { getApiKey: async () => 'key', project: async () => { throw new Error('Linear unavailable'); } },
  });
  const after = bus.subscribe(() => { delivered++; });
  try {
    graph.updateTask(task.id, { status: 'running' });
    bus.emit({ kind: 'task-started', taskId: task.id, executionId: 'exec:2001' });
    graph.updateTask(task.id, { status: 'failed' });
    bus.emit({ kind: 'task-failed', taskId: task.id, executionId: 'exec:2001',
      errorCode: 'E', errorMessage: 'execution failure', willRetry: false, attempt: 0 });
    await flush();
    expect(graph.getTask(task.id)?.status).toBe('failed');
    expect(delivered).toBe(2);
    expect(errors).toEqual(['linear-projection:Error: Linear unavailable', 'linear-projection:Error: Linear unavailable']);
  } finally { after.dispose(); loop.stop(); }
});
