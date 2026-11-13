import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wireTox } from '../boot.js';
import { hydrateGraph, TaskStore } from '../store.js';
import { dispatchTaskCreate } from './create.js';

test('Telegram intake task is durable while ready and before any dispatcher execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tox-intake-task-'));
  const path = join(root, 'tasks.db');
  const store = new TaskStore({ path });
  const boot = wireTox({ store, startFeedbackLoop: false, startRetryPolicy: false, tox: { loop: { enabled: false } } });
  let createdId: string | undefined;
  try {
    const created = await dispatchTaskCreate({
      title: '흡수: https://example.org/post',
      surface: { kind: 'llm-direct', prompt: '이 링크를 흡수하고 노트로 저장하세요: https://example.org/post' },
    });
    createdId = created.taskId;
    expect(createdId).toBeDefined();
    expect(store.getTask(createdId!)?.status).toBe('ready');
  } finally {
    boot.dispose();
    store.close();
  }
  const reopened = new TaskStore({ path });
  try {
    expect(hydrateGraph(reopened).getTask(createdId!)?.status).toBe('ready');
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});
