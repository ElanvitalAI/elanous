import { setDefaultTimeout, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { registerFleetCommands } from './fleet-cli.js';

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
  test('--all read-only union excludes tests by default, deduplicates DBs, preserves labels, and sorts by frame time', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'fleet-screen-'));
    const previousHome = process.env.HOME;
    const previousState = process.env.ELANOUS_STATE_DIR;
    const previousConfig = process.env.ELANOUS_CONFIG_DIR;
    const originalWrite = process.stdout.write;
    let homeSpy: ReturnType<typeof spyOn> | undefined;
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
      const dbPaths = [prod, other, testState].map((state) => join(state, 'pty', 'manifest.db'));
      const before = dbPaths.map((path) => readFileSync(path));
      const registryPath = join(prod, 'logs', 'instances.json');
      const registryBefore = readFileSync(registryPath);
      const startedAt = performance.now();
      // The only child keeps the original real bin/elanous.mjs entrypoint and options.
      const defaultArgs = ['bin/elanous.mjs', 'fleet', 'screen', '--all', '--json'];
      const defaultRun = spawnSync(process.execPath, defaultArgs, {
        cwd: process.cwd(), env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: '', ELANOUS_CONFIG_DIR: '' }, encoding: 'utf8',
      });
      const childMs = performance.now() - startedAt;
      console.error(`fleet screen child: exit=${defaultRun.status}; ms=${childMs.toFixed(1)}`);
      expect(defaultRun.status).toBe(0);
      const defaultRows = JSON.parse(defaultRun.stdout) as Array<{ id: string; instance: string }>;
      expect(defaultRows.map((row) => [row.id, row.instance]))
        .toEqual([['other', 'other-label'], ['prod', 'prod-label']]);
      console.error(`fleet screen default: db rows=${defaultRows.map((row) => row.id).join(',')}`);
      for (let i = 0; i < dbPaths.length; i++) expect(readFileSync(dbPaths[i]!)).toEqual(before[i]);
      expect(readFileSync(registryPath)).toEqual(registryBefore);

      // Own the global HOME and output only while running the real registered Commander action.
      process.env.HOME = home;
      homeSpy = spyOn(os, 'homedir').mockReturnValue(home);
      delete process.env.ELANOUS_STATE_DIR;
      delete process.env.ELANOUS_CONFIG_DIR;
      let output = '';
      process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        output += chunk.toString();
        const callback = args.find((arg): arg is () => void => typeof arg === 'function');
        callback?.();
        return true;
      }) as typeof process.stdout.write;
      const program = new Command();
      registerFleetCommands(program);
      const actionStartedAt = performance.now();
      await program.parseAsync(['fleet', 'screen', '--all', '--json', '--include-test'], { from: 'user' });
      const actionMs = performance.now() - actionStartedAt;
      const withTest = JSON.parse(output) as Array<{ id: string; instance: string }>;
      expect(withTest.map((row) => row.id)).toEqual(['other', 'prod', 'test']);
      expect(withTest.map((row) => row.instance)).toEqual(['other-label', 'prod-label', 'test-label']);
      expect(withTest.slice(0, defaultRows.length).map((row) => [row.id, row.instance]))
        .toEqual(defaultRows.map((row) => [row.id, row.instance]));
      for (let i = 0; i < dbPaths.length; i++) expect(readFileSync(dbPaths[i]!)).toEqual(before[i]);
      expect(readFileSync(registryPath)).toEqual(registryBefore);
      console.error(`fleet screen fixture: db rows=${withTest.map((row) => row.id).join(',')}; action ms=${actionMs.toFixed(1)}`);
    } finally {
      homeSpy?.mockRestore();
      process.stdout.write = originalWrite;
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousState;
      if (previousConfig === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previousConfig;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
