import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LogStore } from '../../src/mss/logging/log-store.js';

// GATE-OBS2-1 — the release graph runs auto-approve-node as its own process; its auto-decision must reach that universe's logs.db.
const REPO = resolve(import.meta.dir, '../..');
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('an auto-approve process spawned like the graph does writes release-loop.approve auto-decision to its own logs.db', () => {
  const root = mkdtempSync(join(tmpdir(), 'auto-approve-log-sink-'));
  scratch.push(root);
  const env: Record<string, string | undefined> = { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_CONFIG_DIR: root };
  // NODE_ENV=test turns the default store off; the graph child runs without it, and the state dir above keeps it isolated.
  delete env.NODE_ENV;
  // Minimal graph context: every metric is unmeasured, so the outcome is fail (rc 1), but the decision is still logged.
  env.ELANOUS_RUN_ID = 'process-run';
  env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ runId: 'graph-run', input: { version: '0.0.1', previousVersion: '0.0.0' }, outputs: {} });
  const run = spawnSync('bun', ['scripts/release-loop/auto-approve-node.ts'], { cwd: REPO, env, encoding: 'utf8', timeout: 60_000 });
  expect(run.error).toBeUndefined();
  expect({ status: run.status, stderr: run.status === 1 ? '' : run.stderr }).toEqual({ status: 1, stderr: '' });
  const dbPath = join(root, 'logs', 'logs.db');
  expect(existsSync(dbPath)).toBe(true);
  const store = LogStore.openReadOnly(dbPath);
  try {
    const rows = store.query({ exactCategories: ['release-loop.approve'] });
    expect(rows.map((row) => row.event)).toContain('auto-decision');
    expect(rows.every((row) => row.surface === 'release-loop')).toBe(true);
    const decision = rows.find((row) => row.event === 'auto-decision');
    expect(decision).toBeDefined();
    const data = JSON.parse(decision!.data ?? '{}') as { runId?: string; tuiSubcheck?: { runId?: string | null } };
    expect(data.runId).toBe('graph-run');
    expect(data.tuiSubcheck?.runId).toBe(data.runId);
  } finally { store.close(); }
}, 60_000);
