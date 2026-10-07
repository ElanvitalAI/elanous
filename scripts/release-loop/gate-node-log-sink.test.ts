import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LogStore } from '../../src/mss/logging/log-store.js';

// The release graph runs gate-node as its own process; its debug.log events must reach that universe's logs.db.
const REPO = resolve(import.meta.dir, '../..');
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('a gate process spawned like the graph does writes release-loop.gate events to its own logs.db', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-node-log-sink-'));
  scratch.push(root);
  const env: Record<string, string | undefined> = { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_CONFIG_DIR: root };
  delete env.ELANOUS_GRAPH_CONTEXT;
  // NODE_ENV=test turns the default store off; the graph child runs without it, and the state dir above keeps it isolated.
  delete env.NODE_ENV;
  const run = spawnSync('bun', ['scripts/release-loop/gate-node.ts', '--json'], { cwd: REPO, env, encoding: 'utf8', timeout: 60_000 });
  // Invalid input is the cheap path: no runner side effects, but the final `result` event is still logged.
  expect(run.status).toBe(2);
  const lines = run.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!).outcome).toBe('error');
  const dbPath = join(root, 'logs', 'logs.db');
  expect(existsSync(dbPath)).toBe(true);
  const store = LogStore.openReadOnly(dbPath);
  try {
    const rows = store.query({ exactCategories: ['release-loop.gate'] });
    expect(rows.map((row) => row.event)).toContain('result');
    expect(rows.every((row) => row.surface === 'release-loop')).toBe(true);
  } finally { store.close(); }
}, 60_000);
