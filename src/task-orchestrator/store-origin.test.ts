import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { hostname, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore, TOX_SCHEMA_VERSION } from './store.js';
import { createTask, type TaskExecution } from './types.js';

const originalHostId = process.env.ELANOUS_HOST_ID;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalHostId === undefined) delete process.env.ELANOUS_HOST_ID;
  else process.env.ELANOUS_HOST_ID = originalHostId;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function execution(taskId: string, id: string, overrides: Partial<TaskExecution> = {}): TaskExecution {
  return {
    id, taskId, startedAt: 1234, status: 'completed',
    surface: { kind: 'llm-direct', prompt: 'origin test' },
    ...overrides,
  };
}

describe('TaskStore execution origin', () => {
  test('defaults to the installed host identity and hostname but preserves explicit origin', () => {
    process.env.ELANOUS_HOST_ID = '01THISHOST';
    const store = new TaskStore({ path: ':memory:' });
    try {
      const task = createTask({ title: 'origin', surface: { kind: 'llm-direct', prompt: 'origin test' } });
      store.saveTask(task);
      const captureArtifacts = [{ path: '/state/artifacts/capture/demo.png', mimeType: 'image/png', runId: 'run-1',
        linearIssueId: 'parent-1', externalShare: true, sensitivity: 'public', createdAt: 1236 }];
      store.saveExecution(execution(task.id, 'exec:default', { runId: 'run-1', captureArtifacts }));
      store.saveExecution(execution(task.id, 'exec:pod', { startedAt: 1235, hostId: '01PODHOST', hostname: 'pod-name' }));

      expect(store.getExecution('exec:default')?.hostId).toBe('01THISHOST');
      expect(store.getExecution('exec:default')?.hostname).toBe(hostname());
      expect(store.getExecution('exec:default')?.runId).toBe('run-1');
      expect(store.getExecution('exec:default')?.captureArtifacts).toEqual(captureArtifacts);
      expect(store.getExecution('exec:pod')?.hostId).toBe('01PODHOST');
      expect(store.getExecution('exec:pod')?.hostname).toBe('pod-name');
      expect(store.listExecutions(task.id).map((row) => row.hostId)).toEqual(['01PODHOST', '01THISHOST']);
      expect(store.schemaVersion()).toBe(TOX_SCHEMA_VERSION);
    } finally {
      store.close();
    }
  });

  test('migrates a legacy file row without fabricating its origin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tox-origin-'));
    tempDirs.push(dir);
    const path = join(dir, 'tasks.db');
    const initial = new TaskStore({ path, noWal: true });
    const task = createTask({ title: 'legacy', surface: { kind: 'llm-direct', prompt: 'origin test' } });
    initial.saveTask(task);
    initial.close();

    const db = new Database(path);
    try {
      db.exec('DROP TABLE tox_executions');
      db.exec(`CREATE TABLE tox_executions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tox_tasks(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER,
        status TEXT NOT NULL, surface_json TEXT NOT NULL, surface_address TEXT,
        output TEXT, output_path TEXT, error_json TEXT, token_input INTEGER,
        token_output INTEGER, cost_usd REAL, model_id TEXT
      )`);
      db.prepare('INSERT INTO tox_executions (id, task_id, started_at, status, surface_json) VALUES (?, ?, ?, ?, ?)')
        .run('exec:legacy', task.id, 1234, 'completed', JSON.stringify(task.surface));
    } finally {
      db.close();
    }

    const migrated = new TaskStore({ path, noWal: true });
    try {
      const row = migrated.getExecution('exec:legacy');
      expect(row).not.toBeNull();
      expect(Object.hasOwn(row!, 'hostId')).toBe(false);
      expect(Object.hasOwn(row!, 'hostname')).toBe(false);
      expect(migrated.schemaVersion()).toBe(TOX_SCHEMA_VERSION);
      expect(migrated.listExecutions(task.id)[0]?.id).toBe('exec:legacy');
    } finally {
      migrated.close();
    }
    const check = new Database(path);
    try {
      const columns = check.prepare('PRAGMA table_info(tox_executions)').all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toContain('host_id');
      expect(columns.map((c) => c.name)).toContain('hostname');
      expect(check.prepare('SELECT host_id, hostname FROM tox_executions WHERE id = ?').get('exec:legacy'))
        .toEqual({ host_id: null, hostname: null });
      const indexes = check.prepare('PRAGMA index_list(tox_executions)').all() as Array<{ name: string }>;
      expect(indexes.map((i) => i.name)).toContain('idx_tox_executions_host');
    } finally {
      check.close();
    }
  });
});
