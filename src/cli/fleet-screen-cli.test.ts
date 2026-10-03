import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

function writeManifest(path: string, id: string, instance: string, startedAt: number, frameAt: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const d = new Database(path);
  d.run(`CREATE TABLE pty_manifest (
    id TEXT, kind TEXT, cmd TEXT, workdir TEXT, owner_pid INTEGER, instance TEXT,
    started_at INTEGER, alive INTEGER, exit_code INTEGER, snapshot TEXT, snapshot_at INTEGER,
    frame TEXT, frame_at INTEGER, run_id TEXT, space_id TEXT, session_id TEXT, closed_at INTEGER, updated_at INTEGER
  )`);
  d.run(
    'INSERT INTO pty_manifest VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, 'self', 'x', null, 1, instance, startedAt, 1, null, '', 0, `\x1b[31m${id}`, frameAt, '', '', '', 0, frameAt],
  );
  d.close();
}

describe('fleet screen CLI', () => {
  test('--all read-only union excludes tests by default, deduplicates DBs, preserves labels, and sorts by frame time', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-screen-'));
    try {
      const home = join(root, 'home');
      const prod = join(home, '.elanous');
      const other = join(root, 'other');
      const testState = join(root, 'test', '.elanous-test');
      writeManifest(join(prod, 'pty', 'manifest.db'), 'prod', 'prod-label', 20, 200);
      writeManifest(join(other, 'pty', 'manifest.db'), 'other', 'other-label', 10, 100);
      writeManifest(join(testState, 'pty', 'manifest.db'), 'test', 'test-label', 30, 300);
      mkdirSync(join(prod, 'logs'), { recursive: true });
      writeFileSync(join(prod, 'logs', 'instances.json'), JSON.stringify({ instances: [
        { name: 'other', stateDir: other, pid: process.pid, startedAt: 'x', kind: 'prod' },
        { name: 'test:x', stateDir: testState, pid: process.pid, startedAt: 'x', kind: 'test' },
        { name: 'other-duplicate', stateDir: other, pid: process.pid, startedAt: 'x', kind: 'prod' },
      ] }));
      const run = (args: string[]) => spawnSync(process.execPath, ['bin/elanous.mjs', 'fleet', 'screen', '--all', '--json', ...args], {
        cwd: process.cwd(), env: { ...process.env, HOME: home }, encoding: 'utf8',
      });
      const defaultRun = run([]);
      expect(defaultRun.status).toBe(0);
      expect(JSON.parse(defaultRun.stdout).map((row: { id: string; instance: string }) => [row.id, row.instance]))
        .toEqual([['other', 'other-label'], ['prod', 'prod-label']]);
      const withTest = run(['--include-test']);
      expect(withTest.status).toBe(0);
      expect(JSON.parse(withTest.stdout).map((row: { id: string }) => row.id)).toEqual(['other', 'prod', 'test']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
