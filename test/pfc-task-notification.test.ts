// ── PFC-S1 P2: background task-notification queue + XML injection ──
//
// Covers:
//   1. TaskNotificationQueue enqueue / drain / size / dedup
//   2. renderTaskNotificationsXml format invariants
//   3. AgentRegistry.onTaskDone listener dispatch
//   4. Runner's terminal-state callback wiring
//   5. Auto-wired queue only enqueues BACKGROUND tasks
//   6. Output truncation above TASK_NOTIFICATION_OUTPUT_CAP

import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../src/debug/log';
import {
  TaskNotificationQueue,
  globalTaskNotificationQueue,
  renderTaskNotificationsXml,
  wireTaskNotifications,
  rewireGlobalTaskNotifications,
  TASK_NOTIFICATION_OUTPUT_CAP,
  type PendingTaskNotification,
} from '../src/agent/task-notification';
import {
  AgentRegistry,
  globalAgentRegistry,
} from '../src/agent/registry';
import type {
  AgentDefinition, AgentTask,
} from '../src/agent/types';
import type { LLMProvider, LLMStreamEvent } from '../src/llm';

function fakeProvider(turns: LLMStreamEvent[][]): LLMProvider {
  let call = 0;
  const p: LLMProvider = {
    name: 'fake',
    defaultModel: 'fake-model',
    available: () => true,
    async *streamChat() {
      const events = turns[call++] ?? [];
      for (const ev of events) yield ev;
    },
    async *chat(messages, opts) {
      for await (const ev of p.streamChat!(messages, opts)) {
        if (ev.type === 'text') yield ev.delta;
      }
    },
  };
  return p;
}

function simpleDef(name = 'bg-test'): AgentDefinition {
  return { name, systemPrompt: 'You are test.' };
}

function makePending(over: Partial<PendingTaskNotification> = {}): PendingTaskNotification {
  return {
    taskId: 'task-1',
    agentName: 'explore',
    state: 'done',
    output: 'ok',
    truncated: false,
    durationMs: 1200,
    finishedAt: Date.now(),
    ...over,
  };
}

// ── Queue mechanics ──

describe('TaskNotificationQueue', () => {
  test('enqueue + size', () => {
    const q = new TaskNotificationQueue();
    expect(q.size).toBe(0);
    q.enqueue(makePending({ taskId: 'a' }));
    q.enqueue(makePending({ taskId: 'b' }));
    expect(q.size).toBe(2);
  });

  test('drain empties + returns in order', () => {
    const q = new TaskNotificationQueue();
    q.enqueue(makePending({ taskId: 'a' }));
    q.enqueue(makePending({ taskId: 'b' }));
    const out = q.drain();
    expect(out.map(o => o.taskId)).toEqual(['a', 'b']);
    expect(q.size).toBe(0);
  });

  test('drain on empty returns []', () => {
    const q = new TaskNotificationQueue();
    expect(q.drain()).toEqual([]);
  });

  test('drain listeners see delivered notifications, never pending enqueues', () => {
    const q = new TaskNotificationQueue();
    const delivered: string[][] = [];
    const off = q.onDrain(items => { delivered.push(items.map(item => item.taskId)); });
    q.enqueue(makePending({ taskId: 'a' }));
    expect(delivered).toEqual([]);
    q.drain();
    expect(delivered).toEqual([['a']]);
    q.drain();
    expect(delivered).toEqual([['a']]);
    off();
    q.enqueue(makePending({ taskId: 'b' }));
    q.drain();
    expect(delivered).toEqual([['a']]);
  });

  test('dedup by taskId — second enqueue is noop', () => {
    const q = new TaskNotificationQueue();
    q.enqueue(makePending({ taskId: 'x', output: 'first' }));
    q.enqueue(makePending({ taskId: 'x', output: 'second' }));
    const out = q.drain();
    expect(out.length).toBe(1);
    expect(out[0]!.output).toBe('first');
  });

  test('dedup survives drain — re-enqueue of same taskId still blocked', () => {
    const q = new TaskNotificationQueue();
    q.enqueue(makePending({ taskId: 'x' }));
    q.drain();
    q.enqueue(makePending({ taskId: 'x' }));
    expect(q.size).toBe(0);
  });

  test('clear() resets queue + seen', () => {
    const q = new TaskNotificationQueue();
    q.enqueue(makePending({ taskId: 'x' }));
    q.clear();
    q.enqueue(makePending({ taskId: 'x' }));
    expect(q.size).toBe(1);
  });

  test('one completion event fires the wake listener exactly once', () => {
    const q = new TaskNotificationQueue();
    const events: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data });
    }) as never);
    try {
      const woken: string[] = [];
      const off = q.onEnqueue((n) => woken.push(n.taskId));

      q.enqueue(makePending({ taskId: 'w1' }));
      q.enqueue(makePending({ taskId: 'w1' }));
      expect(woken).toEqual(['w1']);
      expect(events).toContainEqual({
        category: 'agent.task-notification',
        event: 'wake',
        data: { taskId: 'w1', size: 1 },
      });
      expect(events.filter(e => e.category === 'agent.task-notification' && e.event === 'wake')).toHaveLength(1);

      off();
      q.enqueue(makePending({ taskId: 'w2' }));
      expect(woken).toEqual(['w1']);

      const siblingWoken: string[] = [];
      q.onEnqueue((n) => siblingWoken.push(n.taskId));
      q.onEnqueue(() => { throw new Error('wake boom'); });
      q.enqueue(makePending({ taskId: 'w3' }));
      expect(q.size).toBe(3);
      expect(siblingWoken).toEqual(['w3']);
      expect(events).toContainEqual({
        category: 'agent.task-notification',
        event: 'wake-listener-failed',
        data: { taskId: 'w3', reason: 'wake boom' },
      });

      q.clear();
      q.enqueue(makePending({ taskId: 'w4' }));
      expect(q.size).toBe(1);
      expect(siblingWoken).toEqual(['w3', 'w4']);
    } finally {
      log.mockRestore();
    }
  });
});

// ── XML rendering ──

describe('renderTaskNotificationsXml', () => {
  test('empty array → empty string', () => {
    expect(renderTaskNotificationsXml([])).toBe('');
  });

  test('single done task — wraps in <task-notification>', () => {
    const xml = renderTaskNotificationsXml([
      makePending({ taskId: 't1', agentName: 'explore', output: 'found X' }),
    ]);
    expect(xml).toContain('<task-notification>');
    expect(xml).toContain('</task-notification>');
    expect(xml).toContain('id="t1"');
    expect(xml).toContain('agent="explore"');
    expect(xml).toContain('status="done"');
    expect(xml).toContain('<output>found X</output>');
  });

  test('label + team attrs present when set', () => {
    const xml = renderTaskNotificationsXml([
      makePending({ label: 'bg-1', teamName: 'study' }),
    ]);
    expect(xml).toContain('name="bg-1"');
    expect(xml).toContain('team="study"');
  });

  test('error state renders <error> before <output>', () => {
    const xml = renderTaskNotificationsXml([
      makePending({ state: 'error', errorMessage: 'boom', output: 'partial' }),
    ]);
    expect(xml).toContain('<error>boom</error>');
    expect(xml).toContain('<output>partial</output>');
    expect(xml).toContain('status="error"');
  });

  test('truncated attribute when truncated=true', () => {
    const xml = renderTaskNotificationsXml([
      makePending({ truncated: true, output: 'x'.repeat(500) + '…(truncated)' }),
    ]);
    expect(xml).toContain('truncated="true"');
  });

  test('XML special chars escaped', () => {
    const xml = renderTaskNotificationsXml([
      makePending({ output: '<evil>&\'"</evil>' }),
    ]);
    expect(xml).toContain('&lt;evil&gt;&amp;');
    expect(xml).not.toContain('<evil>');
  });

  test('duration formatted — sub-1s as ms, ≥1s as s', () => {
    const xml1 = renderTaskNotificationsXml([makePending({ durationMs: 400 })]);
    expect(xml1).toContain('duration="400ms"');
    const xml2 = renderTaskNotificationsXml([makePending({ durationMs: 8400 })]);
    expect(xml2).toContain('duration="8.4s"');
  });

  test('multiple tasks — each wrapped in <task>', () => {
    const xml = renderTaskNotificationsXml([
      makePending({ taskId: 'a' }),
      makePending({ taskId: 'b', state: 'aborted' }),
    ]);
    const taskMatches = xml.match(/<task /g);
    expect(taskMatches?.length).toBe(2);
    expect(xml).toContain('status="done"');
    expect(xml).toContain('status="aborted"');
  });
});

// ── AgentRegistry.onTaskDone wiring ──

describe('AgentRegistry.onTaskDone', () => {
  test('notifyTaskDone fires listeners in order', () => {
    const reg = new AgentRegistry();
    const calls: string[] = [];
    reg.onTaskDone((t) => calls.push(`A:${t.id}`));
    reg.onTaskDone((t) => calls.push(`B:${t.id}`));
    const dummy: AgentTask = {
      id: 't1',
      definition: simpleDef(),
      prompt: 'x',
      state: 'done',
      messages: [],
      controller: new AbortController(),
    };
    reg.notifyTaskDone(dummy);
    expect(calls).toEqual(['A:t1', 'B:t1']);
  });

  test('listener throws do not break dispatch', () => {
    const reg = new AgentRegistry();
    const calls: string[] = [];
    reg.onTaskDone(() => { throw new Error('boom'); });
    reg.onTaskDone((t) => calls.push(t.id));
    reg.notifyTaskDone({
      id: 't2',
      definition: simpleDef(),
      prompt: 'x',
      state: 'done',
      messages: [],
      controller: new AbortController(),
    });
    expect(calls).toEqual(['t2']);
  });

  test('dispose() unsubscribes', () => {
    const reg = new AgentRegistry();
    const calls: string[] = [];
    const sub = reg.onTaskDone((t) => calls.push(t.id));
    sub.dispose();
    reg.notifyTaskDone({
      id: 't3',
      definition: simpleDef(),
      prompt: 'x',
      state: 'done',
      messages: [],
      controller: new AbortController(),
    });
    expect(calls.length).toBe(0);
  });

  test('registry.spawn drives runner.onTerminal → notifyTaskDone', async () => {
    const reg = new AgentRegistry();
    const fired: string[] = [];
    reg.onTaskDone((t) => fired.push(`${t.id}:${t.state}`));
    const provider = fakeProvider([[{ type: 'text', delta: 'hello' }]]);
    const handle = reg.spawn({
      definition: simpleDef(),
      prompt: 'go',
      provider,
    });
    // Drain the events to completion.
    for await (const _ev of handle.events) { void _ev; }
    expect(fired.length).toBe(1);
    expect(fired[0]).toBe(`${handle.task.id}:done`);
  });

  test('runner fires onTerminal with state=error on throw', async () => {
    const reg = new AgentRegistry();
    const fired: AgentTask[] = [];
    reg.onTaskDone((t) => fired.push(t));
    const failingProvider: LLMProvider = {
      name: 'fail',
      defaultModel: 'x',
      available: () => true,
      async *streamChat() { throw new Error('provider down'); },
      async *chat() { throw new Error('provider down'); },
    };
    const handle = reg.spawn({
      definition: simpleDef(),
      prompt: 'go',
      provider: failingProvider,
    });
    for await (const _ev of handle.events) { void _ev; }
    expect(fired.length).toBe(1);
    expect(fired[0]!.state).toBe('error');
  });
});

// ── Auto-wire: background only ──

describe('wireTaskNotifications (manual wiring)', () => {
  let reg: AgentRegistry;
  let q: TaskNotificationQueue;
  let dispose: () => void;

  beforeEach(() => {
    reg = new AgentRegistry();
    q = new TaskNotificationQueue();
    dispose = wireTaskNotifications(q, reg);
  });

  test('background=true task enqueues', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'async done' }]]);
    const handle = reg.spawn({
      definition: simpleDef('research'),
      prompt: 'long',
      provider,
      background: true,
    });
    for await (const _ev of handle.events) { void _ev; }
    const drained = q.drain();
    expect(drained.length).toBe(1);
    expect(drained[0]!.state).toBe('done');
    expect(drained[0]!.output).toBe('async done');
    expect(drained[0]!.agentName).toBe('research');
  });

  test('background completion queues once, returns routing to foreground, and logs why without changing UI focus', async () => {
    const events: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data });
    }) as never);
    try {
      const provider = fakeProvider([[{ type: 'text', delta: 'async done' }]]);
      const handle = reg.spawn({
        definition: simpleDef('background-focus'),
        prompt: 'long',
        provider,
        background: true,
      });
      for await (const _ev of handle.events) { void _ev; }

      expect(q.drain()).toHaveLength(1);
      expect(handle.task.background).toBe(false);
      expect(events).toContainEqual({
        category: 'agent.task-routing',
        event: 'auto-foreground-on-completion',
        data: {
          taskId: handle.task.id,
          state: 'done',
          finishedAt: handle.task.finishedAt,
          reason: 'background-task-completed',
        },
      });
    } finally {
      log.mockRestore();
    }
  });

  test('foreground completion neither queues nor emits an automatic routing transition', async () => {
    const events: Array<{ category: string; event: string }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
      events.push({ category, event });
    }) as never);
    try {
      const provider = fakeProvider([[{ type: 'text', delta: 'sync done' }]]);
      const handle = reg.spawn({
        definition: simpleDef('explore'),
        prompt: 'fast',
        provider,
      });
      for await (const _ev of handle.events) { void _ev; }
      expect(q.size).toBe(0);
      expect(handle.task.background).toBeFalsy();
      expect(events).not.toContainEqual({
        category: 'agent.task-routing',
        event: 'auto-foreground-on-completion',
      });
    } finally {
      log.mockRestore();
    }
  });

  test('50,000-character runner completion is preserved through queue drain and XML', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-result-'));
    const result = 'y'.repeat(49_990) + 'TAIL-12345';
    const localQueue = new TaskNotificationQueue(root);
    const localRegistry = new AgentRegistry();
    const off = wireTaskNotifications(localQueue, localRegistry);
    try {
      const handle = localRegistry.spawn({
        definition: simpleDef('data'), prompt: 'big',
        provider: fakeProvider([[{ type: 'text', delta: result }]]), background: true,
      });
      for await (const _ev of handle.events) { void _ev; }
      const [notification] = localQueue.drain();
      expect(notification?.state).toBe('done');
      expect(notification?.output.length).toBeLessThanOrEqual(TASK_NOTIFICATION_OUTPUT_CAP);
      expect(notification?.resultPath).toBeTruthy();
      const xml = renderTaskNotificationsXml([notification!]);
      expect(xml).toContain(`<result-path>${notification!.resultPath}</result-path>`);
      const opened = readFileSync(notification!.resultPath!, 'utf8');
      expect(opened).toBe(result);
      expect(opened.slice(-10)).toBe('TAIL-12345');
      console.log(`AGENT_RESULT queue-drain: summary-length=${notification!.output.length} opened-path=${notification!.resultPath} opened-length=${opened.length} tail=${opened.slice(-10)}`);
    } finally {
      off();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('result limit and write failures surface a reason instead of a successful truncated notification', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-result-fail-'));
    try {
      for (const [queue, reason] of [
        [new TaskNotificationQueue(root, 500), 'exceeds limit'],
        [new TaskNotificationQueue(join(root, 'missing', 'file', '\0'), 10_000), 'full result unavailable'],
      ] as const) {
        const input = 'x'.repeat(700);
        queue.enqueue(makePending({ output: input }));
        const [notification] = queue.drain();
        expect(notification?.state).toBe('error');
        expect(notification?.preservationError).toContain(reason);
        expect(notification?.resultPath).toBeUndefined();
        expect(notification?.output.length).toBeLessThanOrEqual(TASK_NOTIFICATION_OUTPUT_CAP);
        expect(renderTaskNotificationsXml([notification!])).toContain('<error>full result unavailable:');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('label + teamName propagated onto pending notification', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'ok' }]]);
    const handle = reg.spawn({
      definition: simpleDef('explore'),
      prompt: 'x',
      provider,
      background: true,
      label: 'bg-explore-1',
      teamName: 'study',
    });
    for await (const _ev of handle.events) { void _ev; }
    const drained = q.drain();
    expect(drained[0]!.label).toBe('bg-explore-1');
    expect(drained[0]!.teamName).toBe('study');
  });

  test('dispose() stops enqueues', async () => {
    dispose();
    const provider = fakeProvider([[{ type: 'text', delta: 'post-dispose' }]]);
    const handle = reg.spawn({
      definition: simpleDef(),
      prompt: 'x',
      provider,
      background: true,
    });
    for await (const _ev of handle.events) { void _ev; }
    expect(q.size).toBe(0);
  });
});

// ── Global wire smoke ──

describe('global wire', () => {
  beforeEach(() => {
    globalTaskNotificationQueue.clear();
    globalAgentRegistry.clear();
    // clear() wipes listeners; re-install the global wire so the
    // next spawn still enqueues.
    rewireGlobalTaskNotifications();
  });

  test('globalTaskNotificationQueue receives background completions', async () => {
    const provider = fakeProvider([[{ type: 'text', delta: 'global bg' }]]);
    const handle = globalAgentRegistry.spawn({
      definition: simpleDef('global-research'),
      prompt: 'g',
      provider,
      background: true,
    });
    for await (const _ev of handle.events) { void _ev; }
    const drained = globalTaskNotificationQueue.drain();
    expect(drained.length).toBe(1);
    expect(drained[0]!.agentName).toBe('global-research');
  });
});
