import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ManagedTaskAdmissionStore, resolveManagedAdmissionRoot } from '../boot/daemon-tools/self-implement.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('managed admission claim is durable, idempotent, and supports terminal updates', () => {
  const root = mkdtempSync(join(tmpdir(), 'managed-admission-'));
  roots.push(root);
  const store = new ManagedTaskAdmissionStore(root);
  const input = { requestKey: 'session:s1:tool:t1', runId: 'run-1', taskId: 'task-1', parentSessionId: 's1', feature: 'demo', state: 'queued' as const };
  expect(store.claim(input).created).toBe(true);
  const duplicate = store.claim({ ...input, runId: 'run-2', taskId: 'task-2' });
  expect(duplicate.created).toBe(false);
  expect(duplicate.record).toMatchObject({ runId: 'run-1', taskId: 'task-1', state: 'queued' });
  const done = store.update(input.requestKey, { state: 'done', result: 'complete' });
  expect(done).toMatchObject({ state: 'done', result: 'complete' });
  expect(new ManagedTaskAdmissionStore(root).get(input.requestKey)).toEqual(done);
});

test('default admission ledger follows the isolated state root', () => {
  const root = mkdtempSync(join(tmpdir(), 'managed-admission-state-'));
  roots.push(root);
  const previous = process.env.ELANOUS_STATE_DIR;
  const previousDataDir = process.env.ELANOUS_DATA_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  delete process.env.ELANOUS_DATA_DIR;
  try {
    const expected = join(root, 'data', 'self-implement-admissions');
    const store = new ManagedTaskAdmissionStore();
    expect(resolveManagedAdmissionRoot()).toBe(expected);
    store.claim({ requestKey: 'isolated', runId: 'r', taskId: 't', feature: 'test', state: 'queued' });
    expect(existsSync(expected)).toBe(true);
    process.env.ELANOUS_DATA_DIR = join(root, 'explicit-data');
    expect(resolveManagedAdmissionRoot()).toBe(join(root, 'explicit-data', 'self-implement-admissions'));
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    if (previousDataDir === undefined) delete process.env.ELANOUS_DATA_DIR;
    else process.env.ELANOUS_DATA_DIR = previousDataDir;
  }
});
