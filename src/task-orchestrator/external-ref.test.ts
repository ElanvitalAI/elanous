import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, TOX_SCHEMA_VERSION } from './store.js';
import { createTask } from './types.js';

function task(ref: string) {
  return createTask({ title: ref, surface: { kind: 'llm-direct', prompt: ref },
    generatedBy: { kind: 'external', provider: 'linear', ref }, approval: { state: 'pending' } });
}

test('migration preserves legacy rows with NULL identity and unique index rejects duplicate external identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tox-external-'));
  const path = join(dir, 'tasks.db');
  try {
    const old = new TaskStore({ path, noWal: true });
    const legacy = createTask({ title: 'legacy', surface: { kind: 'llm-direct', prompt: 'legacy' } });
    old.saveTask(legacy);
    old.close();
    const db = new Database(path);
    db.exec('DROP INDEX idx_tox_tasks_external_ref');
    db.exec('ALTER TABLE tox_tasks DROP COLUMN approval_json');
    db.exec('ALTER TABLE tox_tasks DROP COLUMN external_provider');
    db.exec('ALTER TABLE tox_tasks DROP COLUMN external_ref');
    db.exec('PRAGMA user_version = 3');
    db.close();
    const store = new TaskStore({ path, noWal: true });
    try {
      expect(store.schemaVersion()).toBe(TOX_SCHEMA_VERSION);
      expect(store.getTask(legacy.id)?.generatedBy).toBeUndefined();
      const first = task('LIN-1');
      store.saveTask(first);
      expect(() => store.saveTask(task('LIN-1'))).toThrow();
      expect(store.findTaskByExternalRef('linear', 'LIN-1')?.id).toBe(first.id);
      expect(store.listTasks()).toHaveLength(2);
      expect(store.getTask(first.id)?.approval).toEqual({ state: 'pending' });
      store.saveTask({ ...first, title: 'updated' });
      expect(store.findTaskByExternalRef('linear', 'LIN-1')?.title).toBe('updated');
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
