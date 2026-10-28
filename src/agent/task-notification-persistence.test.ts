import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveTaskNotificationPaths, TaskNotificationQueue, type PendingTaskNotification } from './task-notification.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const notice: PendingTaskNotification = {
  taskId: 'task-restart-1', agentName: 'self-implement', state: 'done', output: 'run completed', truncated: false,
  durationMs: 12, finishedAt: 100,
};

test('pending task notifications survive queue recreation and replay wake when the dashboard restores its consumer', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-notice-'));
  roots.push(root);
  const path = join(root, 'outbox.json');
  const first = new TaskNotificationQueue(join(root, 'results'), 1000, path);
  first.enqueue(notice);
  const restarted = new TaskNotificationQueue(join(root, 'results'), 1000, path);
  const woke: string[] = [];
  const listener = (item: PendingTaskNotification) => woke.push(item.taskId);
  restarted.onEnqueue(listener);
  restarted.replayPendingWakes(listener);
  expect(woke).toEqual(['task-restart-1']);
  expect(restarted.drain()).toEqual([notice]);

  const afterDelivery = new TaskNotificationQueue(join(root, 'results'), 1000, path);
  afterDelivery.enqueue(notice);
  expect(afterDelivery.size).toBe(0);
});

test('default task notification persistence follows the isolated state root', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-notice-state-'));
  roots.push(root);
  const previous = process.env.ELANOUS_STATE_DIR;
  const previousDataDir = process.env.ELANOUS_DATA_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  delete process.env.ELANOUS_DATA_DIR;
  try {
    const paths = resolveTaskNotificationPaths();
    expect(paths.resultDir).toBe(join(root, 'data', 'agent-results'));
    expect(paths.persistencePath).toBe(join(root, 'data', 'agent-task-notifications.json'));
    const queue = new TaskNotificationQueue(paths.resultDir, 1000, paths.persistencePath);
    queue.enqueue(notice);
    expect(existsSync(paths.persistencePath)).toBe(true);
    process.env.ELANOUS_DATA_DIR = join(root, 'explicit-data');
    const explicit = resolveTaskNotificationPaths();
    expect(explicit.resultDir).toBe(join(root, 'explicit-data', 'agent-results'));
    expect(explicit.persistencePath).toBe(join(root, 'explicit-data', 'agent-task-notifications.json'));
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    if (previousDataDir === undefined) delete process.env.ELANOUS_DATA_DIR;
    else process.env.ELANOUS_DATA_DIR = previousDataDir;
  }
});
