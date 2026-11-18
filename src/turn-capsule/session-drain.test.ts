import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskNotificationQueue, type PendingTaskNotification } from '../agent/task-notification.js';
import { drainNextTuiNotifications } from './session-drain.js';

const note = (taskId: string, parentSessionId?: string): PendingTaskNotification => ({
  taskId, agentName: 'general', state: 'done', output: taskId, truncated: false, durationMs: 1, finishedAt: 1,
  ...(parentSessionId ? { parentSessionId } : {}),
});

function queueWith(items: PendingTaskNotification[]) {
  const dir = mkdtempSync(join(tmpdir(), 'session-drain-'));
  const queue = new TaskNotificationQueue(join(dir, 'results'), 10_000_000, join(dir, 'queue.json'));
  for (const item of items) queue.enqueue(item);
  return { queue, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('K3-d — the Next TUI child drains only its own session', () => {
  test('scoped: own session + unscoped legacy delivered; the sibling session\'s receipt stays queued for its owner', () => {
    const { queue, cleanup } = queueWith([note('mine', 's-a'), note('sibling', 's-b'), note('legacy')]);
    try {
      expect(drainNextTuiNotifications(queue, 's-a').map((n) => n.taskId)).toEqual(['mine', 'legacy']);
      expect(drainNextTuiNotifications(queue, 's-b').map((n) => n.taskId)).toEqual(['sibling']);
    } finally { cleanup(); }
  });
});
