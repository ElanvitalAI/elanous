import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LogStore } from '../../src/mss/logging/log-store.js';

const repo = resolve(import.meta.dir, '../..');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('unattended release parent wires the production macrophage, logs its decision, and persists its run receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'macrophage-parent-sink-sim-'));
  roots.push(root);
  const source = [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { setElanousConfigDir } from './src/elanous-config-dir.js';",
    "import { debug } from './src/debug/log.js';",
    "import { runUnattendedRelease } from './scripts/release-loop/unattended-release.js';",
    "const root = process.env.ELANOUS_STATE_DIR!; setElanousConfigDir(root);",
    "mkdirSync(join(root, 'release', '0.2.3'), { recursive: true });",
    "writeFileSync(join(root, 'release', '0.2.3', 'release.json'), JSON.stringify({ version: '0.2.3', publishedAt: 'sim' }));",
    "let runId = '';",
    "await runUnattendedRelease({ version: '0.2.4' }, { ledgerRoot: root, config: { gatePodPool: 'sim-pool' },",
    "checklist: () => ({ ok: true, red: [], undecided: [], blocked: [] }),",
    "graph: async (_path, options) => {",
    "const runtime = options as typeof options & { runId: string; eventBus: import('./src/graph-runner/graph-events.js').GraphEventBus }; runId = runtime.runId;",
    "await runtime.eventBus.publish({ graphId: 'release-loop', runId, type: 'node-end', source: { kind: 'node', nodeId: 'pre-gate-join' }, data: {} });",
    "await runtime.eventBus.flush({ graphId: 'release-loop', runId }); return { status: 'done' } as never; } });",
    "debug.flush(); console.log(JSON.stringify({ runId }));",
  ].join('\n');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    ELANOUS_STATE_DIR: root, ELANOUS_CONFIG_DIR: root };
  const run = spawnSync('bun', ['-e', source], { cwd: repo, env, encoding: 'utf8', timeout: 45_000 });
  if (run.status !== 0 || run.error) throw new Error(`parent sink simulation subprocess failed: status=${run.status} error=${run.error?.message ?? 'none'} stderr=${run.stderr}`);
  const runId = (JSON.parse(run.stdout.trim()) as { runId: string }).runId;
  const receiptPath = join(root, 'graph-runs', 'release-loop', `${runId}.json.contexts`, 'macrophage.jsonl');
  expect(existsSync(receiptPath)).toBe(true);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8').trim()) as {
    schema: string; runId: string; data: { id: string; phaseNodeId: string };
  };
  expect(receipt).toMatchObject({ schema: 'elanous.release.macrophage-receipt.v1', runId,
    data: { id: 'inventory', phaseNodeId: 'pre-gate-join' } });

  const dbPath = join(root, 'logs', 'logs.db');
  expect(existsSync(dbPath)).toBe(true);
  const store = LogStore.openReadOnly(dbPath);
  try {
    const rows = store.query({ exactCategories: ['release-loop.macrophage'] });
    expect(rows.some((row) => row.event === 'decision' && JSON.parse(row.data ?? '{}').runId === runId)).toBe(true);
    expect(rows.every((row) => row.surface === 'release-loop')).toBe(true);
  } finally { store.close(); }
}, 55_000);
