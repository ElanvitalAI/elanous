// ELN-CAPSULE-COMPLETION-SCOPED — a seat's capsule completions belong to the session that started them, and a
// supplement completion still reaches an idle seat as a visible notice (never a turn).
// Expectations are literals (rule 11): session ids, labels and the notice text are written out, not rebuilt from
// product helpers.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry, globalAgentRegistry } from '../agent/registry.js';
import { TaskNotificationQueue, wireTaskNotifications } from '../agent/task-notification.js';
import type { AgentTask } from '../agent/types.js';
import { enqueueShellCompletionNotice } from '../skills/tools/shell.js';
import { drainNextTuiNotifications } from '../turn-capsule/session-drain.js';
import { CAPSULE_FRAME_PREFIX, parseCapsuleFrame } from '../turn-capsule/capsule-frame.js';
import { wireCapsuleDoneKnock } from '../tui/capsule-done-knock.js';
import { createChildNoticeProducers } from '../tui/core/notice-producers.js';
import { createNextTuiQueue } from '../tui/core/queue.js';
import type { CapsuleEvent } from '../turn-capsule/contract.js';
import { buildReplTools, watchCapsuleDone } from './index.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const freshQueue = (): TaskNotificationQueue => {
  const dir = mkdtempSync(join(tmpdir(), 'capsule-scoped-'));
  dirs.push(dir);
  return new TaskNotificationQueue(join(dir, 'results'));
};

describe('① completions are scoped to the starting session', () => {
  test('two sessions with concurrent RunShell bg completions each drain only their own', () => {
    const queue = freshQueue();
    enqueueShellCompletionNotice({ handle: { id: 'h-a' } as never, ok: true, exitCode: 0, durationMs: 5,
      label: 'job of A', parentSessionId: 'sess-A' }, queue);
    enqueueShellCompletionNotice({ handle: { id: 'h-b' } as never, ok: true, exitCode: 0, durationMs: 7,
      label: 'job of B', parentSessionId: 'sess-B' }, queue);
    const a = drainNextTuiNotifications(queue, 'sess-A');
    const b = drainNextTuiNotifications(queue, 'sess-B');
    expect(a.map((n) => [n.parentSessionId, n.label])).toEqual([['sess-A', 'job of A']]);
    expect(b.map((n) => [n.parentSessionId, n.label])).toEqual([['sess-B', 'job of B']]);
  });

  test('two sessions with concurrent background Agent completions each drain only their own', () => {
    const registry = new AgentRegistry();
    const queue = freshQueue();
    // Production registry → queue wiring (the same one the global pair uses at module load).
    const stop = wireTaskNotifications(queue, registry);
    const spawn = (sessionId: string, label: string): AgentTask => registry.spawn({
      definition: { name: 'general', description: 'd', systemPrompt: 'p' }, prompt: 'go', background: true,
      parentSessionId: sessionId, label,
    } as never).task;
    const a = spawn('sess-A', 'agent of A');
    const b = spawn('sess-B', 'agent of B');
    for (const task of [b, a]) { task.state = 'done'; registry.notifyTaskDone(task); }
    stop();
    expect(drainNextTuiNotifications(queue, 'sess-A').map((n) => n.label)).toEqual(['agent of A']);
    expect(drainNextTuiNotifications(queue, 'sess-B').map((n) => n.label)).toEqual(['agent of B']);
  });

  test('the Next REPL hands its session id to the Agent spawn (was undefined → any session drained it)', async () => {
    const seen: Array<string | undefined> = [];
    const spy = spyOn(globalAgentRegistry, 'spawn').mockImplementation(((opts: { parentSessionId?: string }) => {
      seen.push(opts.parentSessionId);
      throw new Error('stop-at-spawn');
    }) as never);
    try {
      for (const sessionId of ['sess-A', 'sess-B']) {
        const tools = buildReplTools({ nextTui: true, sessionId });
        await tools.dispatch('Agent', { description: 'scoped probe', prompt: 'noop', run_in_background: true }).catch(() => undefined);
      }
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual(['sess-A', 'sess-B']);
  }, 15_000);
});

describe('② a supplement completion is visible to an idle seat', () => {
  test('supplement Agent done → one capsule-done frame → one queued notice, no turn opened', () => {
    const registry = new AgentRegistry();
    const listeners: Array<(event: CapsuleEvent) => void> = [];
    const watch = watchCapsuleDone('sess-idle', registry, new Set(), (line) => {
      const event = parseCapsuleFrame(line.slice(CAPSULE_FRAME_PREFIX.length).trimEnd(), 'sess-idle');
      if (event) for (const listener of listeners) listener(event);
    });
    // Production TUI side: the Next TUI queue and its notice producers, as entry.ts wires them.
    const tuiQueue = createNextTuiQueue({ log: () => undefined, turnLifeLog: () => undefined });
    const childNotices = createChildNoticeProducers(tuiQueue);
    let knocks = 0;
    const stop = wireCapsuleDoneKnock({
      sessionId: 'sess-idle',
      subscribe: (_sessionId, listener) => { listeners.push(listener); return () => undefined; },
      enqueue: (event) => childNotices.capsuleDone(event, event.endedAt),
      knock: () => { knocks++; },
      busy: () => false,
    });
    const task = registry.spawn({ definition: { name: 'general', description: 'd', systemPrompt: 'p' }, prompt: 'go',
      background: true, parentSessionId: 'sess-idle', completionDelivery: 'supplement', label: 'side check' } as never).task;
    task.state = 'done';
    task.startedAt = 10_000;
    task.finishedAt = 14_000;
    registry.notifyTaskDone(task);
    stop();
    watch.dispose();
    expect(tuiQueue.pendingTexts.length).toBe(1);
    expect(tuiQueue.pendingTexts[0]).toContain('side check · ok · 4s');
    expect(knocks).toBe(0);
  });
});
