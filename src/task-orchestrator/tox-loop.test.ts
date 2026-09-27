import { describe, expect, test } from 'bun:test';
import { TaskGraph } from './graph.js';
import { TaskEventBus } from './events.js';
import { createTask, type Task, type TaskPriority, type TaskStatus } from './types.js';
import { startToxLoop } from './tox-loop.js';
import { wireTox } from './boot.js';
import { TaskDispatcher } from './dispatcher.js';
import { SurfaceRegistry } from './surface-registry.js';
import { dispatchTaskCreate } from './runtimes/create.js';
import { setUserConfigOverlay } from '../user-config.js';

function add(graph: TaskGraph, title: string, priority: TaskPriority, createdAt: number, status: TaskStatus = 'ready'): Task {
  const task = createTask({ title, priority, status, goalSlug: 'test',
    surface: { kind: 'skill', skillName: 'test' },
    ...(priority === 'urgent' ? { acceptance: { criteria: ['verified'] } } : {}),
  }, { id: `task:${createdAt.toString(16).padStart(4, '0')}`, now: createdAt });
  graph.addTask(task);
  return task;
}

const allow = async () => ({ canAfford: true, tripped: [] });
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 10)); };

describe('TOX ready loop', () => {
  test('priority then creation time, two active maximum, release wakes next; non-ready stays untouched', async () => {
    const graph = new TaskGraph();
    const [low, urgent, medium1, high, medium2] = [
      add(graph, 'low', 'low', 1), add(graph, 'urgent', 'urgent', 2),
      add(graph, 'medium first', 'medium', 3), add(graph, 'high', 'high', 4),
      add(graph, 'medium second', 'medium', 5),
    ];
    const backlog = add(graph, 'external pending approval', 'urgent', 6, 'backlog');
    add(graph, 'blocked', 'high', 7, 'blocked');
    add(graph, 'scheduled', 'high', 8, 'scheduled');
    const launched: string[] = [];
    const events: Array<{ event: string; taskId?: string; running: number; ready: number }> = [];
    const resolvers = new Map<string, () => void>();
    let peak = 0;
    const loop = startToxLoop({ graph, dispatcher: { tickTask: () => ({ dispatched: [], deferred: [] }) },
      maxConcurrent: 2, intervalMs: 60_000, budgetCheck: allow,
      log: (event, data) => { events.push({ event, ...data }); },
      launch: (task) => new Promise<void>((resolve) => {
        graph.updateTask(task.id, { status: 'running' });
        launched.push(task.id);
        resolvers.set(task.id, () => {
          graph.updateTask(task.id, { status: 'done' });
          resolvers.delete(task.id);
          resolve();
        });
        peak = Math.max(peak, resolvers.size);
      }),
    });
    try {
      await loop.tick();
      expect(launched).toEqual([urgent.id, high.id]);
      await loop.tick();
      expect(launched).toHaveLength(2);
      expect(events).toContainEqual(expect.objectContaining({ event: 'waiting-capacity', taskId: medium1.id, running: 2 }));
      resolvers.get(urgent.id)!();
      await flush();
      expect(launched[2]).toBe(medium1.id);
      resolvers.get(high.id)!();
      await flush();
      expect(launched[3]).toBe(medium2.id);
      resolvers.get(medium1.id)!();
      await flush();
      expect(launched[4]).toBe(low.id);
      expect(peak).toBe(2);
      console.info(`TOX launch order=${launched.join(',')} peak=${peak}`);
      expect(launched).not.toContain(backlog.id);
      expect(graph.getTask(backlog.id)?.status).toBe('backlog');
    } finally {
      loop.stop();
      for (const resolve of [...resolvers.values()]) resolve();
    }
  });

  test('budget hold leaves ready without dispatch and emits budget-hold; capacity waits', async () => {
    const graph = new TaskGraph();
    const held = add(graph, 'held', 'urgent', 1);
    const backlog = add(graph, 'external', 'low', 2, 'backlog');
    const events: Array<{ event: string; taskId?: string; reason?: string }> = [];
    let calls = 0;
    const loop = startToxLoop({ graph, dispatcher: { tickTask: () => ({ dispatched: [], deferred: [] }) },
      intervalMs: 60_000, budgetCheck: async () => ({ canAfford: false, tripped: ['weekly'] }),
      launch: () => { calls++; }, log: (event, data) => { events.push({ event, ...data }); },
    });
    try {
      await loop.tick();
      expect(calls).toBe(0);
      expect(graph.getTask(held.id)?.status).toBe('ready');
      expect(events).toContainEqual(expect.objectContaining({ event: 'budget-hold', taskId: held.id, reason: 'budget-hold' }));
      expect(events.some((e) => e.taskId === backlog.id)).toBe(false);
    } finally { loop.stop(); }
  });

  test('missing budget reading holds even a ready task without a goal slug', async () => {
    const graph = new TaskGraph();
    const task = add(graph, 'ungated', 'medium', 1);
    graph.updateTask(task.id, { goalSlug: undefined });
    const events: string[] = [];
    let launches = 0;
    const loop = startToxLoop({ graph, dispatcher: { tickTask: () => ({ dispatched: [], deferred: [] }) },
      intervalMs: 60_000, budgetCheck: async (slug) => ({ canAfford: slug !== '', tripped: slug ? [] : ['no-goal'] }),
      launch: () => { launches++; }, log: (event) => { events.push(event); },
    });
    try {
      await loop.tick();
      expect(launches).toBe(0);
      expect(events).toContain('budget-hold');
    } finally { loop.stop(); }
  });

  test('default P15 gate holds real adapter at codex 60% and grok 50% without budgetCheck', async () => {
    const graph = new TaskGraph();
    const registry = new SurfaceRegistry();
    const task = add(graph, 'P15 threshold', 'urgent', 1);
    let starts = 0;
    registry.register('skill', async () => {
      starts++;
      return { executionId: 'exec:p15', promise: new Promise<import('./types.js').TaskExecution>(() => {}) };
    });
    const events: Array<{ event: string; taskId?: string }> = [];
    const loop = startToxLoop({ graph, dispatcher: new TaskDispatcher({ graph, registry }), intervalMs: 60_000,
      readBudget: {
        config: { tools: { selfImplement: { childLlm: { mode: 'auto', chain: [
          { provider: 'openai-codex' }, { provider: 'grok' },
        ] } } }, llm: {} } as never,
        inspectCodex: () => ({ candidates: [{ name: 'default', usedPercent: 60 }] }) as never,
        grokSnapshot: () => ({ windows: [{ kind: 'weekly', used: 50 }] }) as never,
      },
      log: (event, data) => { events.push({ event, taskId: data.taskId }); },
    });
    try {
      const result = await loop.tick();
      expect(result.dispatched).toHaveLength(0);
      expect(starts).toBe(0);
      expect(graph.getTask(task.id)?.status).toBe('ready');
      expect(events).toContainEqual({ event: 'budget-hold', taskId: task.id });
    } finally { loop.stop(); }
  });

  test('rejected budget-check errors are fail-closed and observable', async () => {
    const graph = new TaskGraph();
    const task = add(graph, 'read failure', 'medium', 1);
    const events: Array<{ event: string; reason?: string; taskId?: string }> = [];
    let launches = 0;
    const loop = startToxLoop({ graph, dispatcher: { tickTask: () => ({ dispatched: [], deferred: [] }) },
      budgetCheck: async () => { throw new Error('usage unavailable'); }, intervalMs: 60_000,
      launch: () => { launches++; }, log: (event, data) => { events.push({ event, ...data }); },
    });
    try {
      await loop.tick();
      expect(launches).toBe(0);
      expect(events).toContainEqual(expect.objectContaining({ event: 'budget-hold', taskId: task.id,
        reason: 'admission-error:usage unavailable' }));
    } finally { loop.stop(); }
  });

  test('default gate does not start original adapter when only fallback provider has budget', async () => {
    const graph = new TaskGraph();
    add(graph, 'fallback', 'medium', 1);
    let starts = 0;
    const registry = new SurfaceRegistry();
    registry.register('skill', async () => {
      starts++;
      return { executionId: 'exec:fallback', promise: new Promise<import('./types.js').TaskExecution>(() => {}) };
    });
    const loop = startToxLoop({ graph, dispatcher: new TaskDispatcher({ graph, registry }), intervalMs: 60_000,
      readBudget: {
        config: { tools: { selfImplement: { childLlm: { mode: 'auto', chain: [
          { provider: 'openai-codex' }, { provider: 'grok' },
        ] } } }, llm: {} } as never,
        inspectCodex: () => ({ candidates: [{ name: 'default', usedPercent: 60 }] }) as never,
        grokSnapshot: () => ({ windows: [{ kind: 'weekly', used: 10 }] }) as never,
      },
    });
    try {
      expect((await loop.tick()).dispatched).toHaveLength(0);
      expect(starts).toBe(0);
    } finally { loop.stop(); }
  });

  test('real dispatcher starts only the budget-approved task (not a second ready task)', async () => {
    const graph = new TaskGraph();
    const registry = new SurfaceRegistry();
    const started: string[] = [];
    registry.register('skill', async (task) => {
      started.push(task.id);
      return { executionId: `exec:${task.id}`, promise: new Promise<import('./types.js').TaskExecution>(() => {}) };
    });
    const denied = add(graph, 'denied', 'urgent', 1);
    const allowed = add(graph, 'allowed', 'medium', 2);
    const dispatcher = new TaskDispatcher({ graph, registry });
    const loop = startToxLoop({ graph, dispatcher, intervalMs: 60_000,
      budgetCheck: async (slug, estimate) => ({ canAfford: estimate === 1, tripped: estimate === 1 ? [] : ['weekly'] }),
    });
    graph.updateTask(denied.id, { estimateUsd: 2 });
    graph.updateTask(allowed.id, { estimateUsd: 1 });
    try {
      await loop.tick();
      await flush();
      expect(started).toEqual([allowed.id]);
      expect(graph.getTask(denied.id)?.status).toBe('ready');
    } finally { loop.stop(); }
  });

  test('boot feedback reports admitted dispatch only after the async budget decision', async () => {
    const boot = wireTox({ startFeedbackLoop: false, startRetryPolicy: false,
      budgetCheck: allow, tox: { loop: { intervalMs: 60_000 } },
    });
    let starts = 0;
    boot.registry.override('skill', async (task) => {
      starts++;
      return { executionId: `exec:${task.id}`, promise: new Promise<import('./types.js').TaskExecution>(() => {}) };
    });
    try {
      const parent = add(boot.graph, 'completed parent', 'medium', 1, 'done');
      const next = add(boot.graph, 'ready next', 'high', 2);
      const outcome = await boot.loop.onTaskCompleted(parent.id);
      expect(outcome.kind).toBe('continue');
      if (outcome.kind === 'continue') expect(outcome.dispatched).toBe(1);
      expect(starts).toBe(1);
      expect(boot.graph.getTask(next.id)?.status).toBe('running');
    } finally { boot.dispose(); }
  });

  test('boot feedback completion promotes dependents through the budgeted loop', async () => {
    const bus = new TaskEventBus();
    let budgetCalls = 0;
    const boot = wireTox({ bus, startRetryPolicy: false,
      budgetCheck: async () => (++budgetCalls === 1
        ? { canAfford: true, tripped: [] }
        : { canAfford: false, tripped: ['weekly'] }),
      tox: { loop: { intervalMs: 60_000 } },
    });
    let calls = 0;
    boot.registry.override('skill', async (task) => {
      calls++;
      return { executionId: `exec:${task.id}`, promise: new Promise<import('./types.js').TaskExecution>(() => {}) };
    });
    try {
      const parent = add(boot.graph, 'parent', 'medium', 1, 'running');
      const child = createTask({ title: 'child', priority: 'medium', status: 'blocked',
        goalSlug: 'test', dependsOn: [parent.id], surface: { kind: 'skill', skillName: 'test' },
      }, { id: 'task:0002', now: 2 });
      boot.graph.addTask(child);
      boot.graph.updateTask(parent.id, { status: 'done' });
      bus.emit({ kind: 'task-completed', taskId: parent.id, executionId: 'exec:01' });
      await flush();
      expect(boot.graph.getTask(child.id)?.status).toBe('ready');
      expect(calls).toBe(0);
    } finally { boot.dispose(); }
  });

  test('a failed task frees capacity for the next ready task without waiting for the interval', async () => {
    const graph = new TaskGraph();
    const first = add(graph, 'running', 'high', 1);
    const second = add(graph, 'waiting', 'low', 2);
    const launched: string[] = [];
    let finishFirst: (() => void) | undefined;
    const loop = startToxLoop({ graph, dispatcher: { tickTask: () => ({ dispatched: [], deferred: [] }) },
      maxConcurrent: 1, intervalMs: 60_000, budgetCheck: allow,
      launch: (task) => {
        graph.updateTask(task.id, { status: 'running' });
        launched.push(task.id);
        return new Promise<void>((resolve) => {
          if (task.id === first.id) finishFirst = () => {
            graph.updateTask(first.id, { status: 'failed' }); resolve();
          };
        });
      },
    });
    try {
      await loop.tick();
      expect(launched).toEqual([first.id]);
      finishFirst!();
      await flush();
      expect(launched).toEqual([first.id, second.id]);
    } finally { loop.stop(); }
  });

  test('real TaskCreate intake promotes ready work without an explicit tick', async () => {
    const boot = wireTox({ startFeedbackLoop: false, startRetryPolicy: false,
      budgetCheck: allow, tox: { loop: { intervalMs: 60_000 } } });
    let calls = 0;
    boot.registry.override('skill', async (task) => {
      calls++;
      return { executionId: `exec:${task.id}`, promise: new Promise<import('./types.js').TaskExecution>(() => {}) };
    });
    try {
      const created = await dispatchTaskCreate({ title: 'from intake', goalSlug: 'test',
        surface: { kind: 'skill', skillName: 'test' } });
      expect(created.taskId).toBeDefined();
      await flush();
      expect(calls).toBe(1);
    } finally { boot.dispose(); }
  });

  test('persisted tox.loop.enabled=false config disables automatic boot loop', async () => {
    setUserConfigOverlay((config) => ({ ...config, raw: { ...config.raw, tox: { loop: { enabled: false, maxConcurrent: 2 } } } }));
    const boot = wireTox({ startFeedbackLoop: false, startRetryPolicy: false, budgetCheck: allow });
    try {
      expect(boot.toxLoop).toBeNull();
    } finally {
      boot.dispose();
      setUserConfigOverlay(null);
    }
  });

  test('boot wakes on task-created without manual tick, disabled boot stays idle, disposal unsubscribes', async () => {
    for (const enabled of [true, false]) {
      const bus = new TaskEventBus();
      const boot = wireTox({ bus, startFeedbackLoop: false, startRetryPolicy: false,
        budgetCheck: allow, tox: { loop: { enabled, intervalMs: 60_000 } } });
      let calls = 0;
      boot.registry.override('skill', async (task) => {
        calls++;
        return { executionId: `exec:${task.id}`, promise: new Promise<import('./types.js').TaskExecution>(() => {}) };
      });
      try {
        const task = add(boot.graph, 'new', 'medium', 1);
        bus.emit({ kind: 'task-created', taskId: task.id, surface: 'skill' });
        await flush();
        expect(calls).toBe(enabled ? 1 : 0);
      } finally { boot.dispose(); }
      expect(bus.listenerCount()).toBe(0);
    }
  });
});
