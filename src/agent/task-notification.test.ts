// Focused unit tests for src/agent/task-notification.ts — the semantic
// event record + wake/drain multi-consumer hooks + per-surface XML
// renderer that the UX controller RFC (내부 문서 `RFC-ux-controller-generator`)
// builds on. Preserves behavior: queue semantics, fan-out hook contract,
// XML rendering are unchanged.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TASK_NOTIFICATION_OUTPUT_CAP,
  TaskNotificationQueue,
  type PendingTaskNotification,
  renderTaskNotificationsXml,
  wireTaskNotifications,
} from './task-notification.js';

function freshQueue(): { queue: TaskNotificationQueue; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'task-notif-test-'));
  return { queue: new TaskNotificationQueue(dir), dir };
}

function pending(partial: Partial<PendingTaskNotification> = {}): PendingTaskNotification {
  return {
    taskId: 't1',
    agentName: 'nexus',
    state: 'done',
    output: 'ok',
    truncated: false,
    durationMs: 2500,
    finishedAt: Date.now(),
    ...partial,
  };
}

describe('TaskNotificationQueue — wake/drain multi-consumer hooks', () => {
  test('enqueue fires each wake listener once per real enqueue; duplicate taskId is dropped', () => {
    const { queue } = freshQueue();
    const seenA: string[] = [];
    const seenB: string[] = [];
    queue.onEnqueue((n) => seenA.push(n.taskId));
    queue.onEnqueue((n) => seenB.push(n.taskId));
    queue.enqueue(pending());
    queue.enqueue(pending()); // same taskId → dedup, no second wake
    expect(seenA).toEqual(['t1']);
    expect(seenB).toEqual(['t1']);
    expect(queue.size).toBe(1);
  });

  test('wake listener throwing does not lose the queued notification or break siblings', () => {
    const { queue } = freshQueue();
    queue.onEnqueue(() => {
      throw new Error('boom');
    });
    const seen: string[] = [];
    queue.onEnqueue((n) => seen.push(n.taskId));
    queue.enqueue(pending());
    expect(seen).toEqual(['t1']);
    expect(queue.size).toBe(1);
  });

  test('drain returns queued items, fires drain listeners with the batch, then empties', () => {
    const { queue } = freshQueue();
    const wake: string[] = [];
    const drained: number[] = [];
    queue.onEnqueue((n) => wake.push(n.taskId));
    queue.onDrain((items) => drained.push(items.length));
    queue.enqueue(pending({ taskId: 'a' }));
    queue.enqueue(pending({ taskId: 'b' }));
    const out = queue.drain();
    expect(out.map((n) => n.taskId)).toEqual(['a', 'b']);
    expect(drained).toEqual([2]);
    expect(queue.size).toBe(0);
    expect(queue.drain()).toEqual([]); // second drain: empty, no listener re-fire
    expect(drained).toEqual([2]);
    // seen-dedup survives drain: re-enqueue same taskId stays dropped
    queue.enqueue(pending({ taskId: 'a' }));
    expect(queue.size).toBe(0);
  });

  test('oversized output is truncated, persisted to resultPath, and rendered as such', () => {
    const { queue, dir } = freshQueue();
    const big = 'x'.repeat(TASK_NOTIFICATION_OUTPUT_CAP + 10);
    const captured: PendingTaskNotification[] = [];
    queue.onEnqueue((n) => captured.push(n));
    queue.enqueue(pending({ output: big }));
    expect(captured.length).toBe(1);
    const enqueued = captured[0];
    expect(enqueued.truncated).toBe(true);
    expect(enqueued.output.length).toBe(TASK_NOTIFICATION_OUTPUT_CAP);
    expect(enqueued.resultPath).toBeDefined();
    if (enqueued.resultPath) {
      expect(existsSync(enqueued.resultPath)).toBe(true);
      expect(readFileSync(enqueued.resultPath, 'utf8').length).toBe(big.length);
      expect(enqueued.resultPath.startsWith(dir)).toBe(true);
    }
  });
});

describe('renderTaskNotificationsXml — per-surface format generator precedent', () => {
  test('renders one <task-notification> block with task attrs, empty input renders empty string', () => {
    expect(renderTaskNotificationsXml([])).toBe('');
    const xml = renderTaskNotificationsXml([pending({ label: '핵심 노드', teamName: 't-a' })]);
    expect(xml).toContain('<task-notification>');
    expect(xml).toContain('id="t1"');
    expect(xml).toContain('agent="nexus"');
    expect(xml).toContain('name="핵심 노드"');
    expect(xml).toContain('team="t-a"');
    expect(xml).toContain('status="done"');
    expect(xml).toContain('duration="2.5s"');
    expect(xml).toContain('<output>ok</output>');
    expect(xml).toContain('</task-notification>');
    expect(xml).not.toContain('kind="status-receipt"');
  });

  test('statusReceipt option stamps kind="status-receipt" and error state carries <error>', () => {
    const xml = renderTaskNotificationsXml([pending({ state: 'error', errorMessage: 'kaboom' })], {
      statusReceipt: true,
    });
    expect(xml).toContain('<task-notification kind="status-receipt" request="none">');
    expect(xml).toContain('status="error"');
    expect(xml).toContain('<error>kaboom</error>');
  });
});

describe('wireTaskNotifications — production wiring path (registry → queue)', () => {
  test('background done task enqueues; foreground task does not', () => {
    const { queue } = freshQueue();
    const woken: string[] = [];
    queue.onEnqueue((n) => woken.push(n.taskId));
    let handler: ((task: unknown) => void) | null = null;
    const fakeRegistry = {
      onTaskDone(cb: (task: unknown) => void) {
        handler = cb;
        return { dispose() { handler = null; } };
      },
      markForeground() {
        return false;
      },
    };
    const disposer = wireTaskNotifications(
      queue,
      fakeRegistry as unknown as Parameters<typeof wireTaskNotifications>[1],
    );
    expect(handler).not.toBeNull();
    // background done task → enqueued
    (handler as unknown as (t: unknown) => void)({
      id: 'bg-1',
      definition: { name: 'researcher' },
      state: 'done',
      result: 'found it',
      background: true,
      startedAt: Date.now() - 500,
      finishedAt: Date.now(),
    });
    // foreground task → not enqueued (already awaited in tool loop)
    (handler as unknown as (t: unknown) => void)({
      id: 'fg-1',
      definition: { name: 'researcher' },
      state: 'done',
      result: 'sync',
      background: false,
      startedAt: Date.now() - 100,
      finishedAt: Date.now(),
    });
    expect(woken).toEqual(['bg-1']);
    expect(queue.has('bg-1')).toBe(true);
    expect(queue.has('fg-1')).toBe(false);
    disposer();
  });
});
