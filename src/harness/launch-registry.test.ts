import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goalPathFromArgv, launchBindingRunIds, readLaunchBinding, removeLaunchBinding, writeLaunchBinding } from './launch-registry.js';
import { defaultHarnessStopDeps, psProcessStartMs, stopHarnessRun } from './harness-stop.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

async function startedAt(pid: number): Promise<number> {
  for (let i = 0; i < 40; i++) {
    const at = psProcessStartMs(pid);
    if (at !== null) return at;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no start time for ${pid}`);
}

/** A long-lived child we own — only these PIDs are ever signalled by the test. */
function idleChild(cwd: string, extraArgs: string[]): ChildProcess {
  // Shaped like the real launcher (`bun bin/elanous.mjs …`) so the stop's process-table matcher treats it as one.
  mkdirSync(join(cwd, 'bin'), { recursive: true });
  writeFileSync(join(cwd, 'bin', 'elanous.mjs'), 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, ['bin/elanous.mjs', ...extraArgs], { cwd, stdio: 'ignore' });
  cleanups.push(() => { if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } } });
  return child;
}

test('goalPathFromArgv resolves --goal-file / --ask / --goal against the launcher cwd', () => {
  expect(goalPathFromArgv(['bun', 'x', 'self', 'orchestrate', '--goal-file', 'docs/goals/a.md'], '/w/tree')).toBe('/w/tree/docs/goals/a.md');
  expect(goalPathFromArgv(['bun', 'x', '--ask=/abs/g.md'], '/w')).toBe('/abs/g.md');
  expect(goalPathFromArgv(['bun', 'x', 'harness', 'say', 'text'], '/w')).toBeUndefined();
});

test('a binding round-trips, is listed for prefix resolution, and is removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-registry-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const runId = 'run-11111111-2222-3333-4444-555555555555';
  expect(writeLaunchBinding(runId, { pid: 4242, startedAt: 1000, cwd: '/w/tree', goalPath: '/w/tree/g.md', runsDir: '/w/tree/.elanous-test/self-dev-runs' }, dir)).not.toBeNull();
  expect(readLaunchBinding(runId, dir)).toEqual({ pid: 4242, startedAt: 1000, cwd: '/w/tree', goalPath: '/w/tree/g.md', runsDir: '/w/tree/.elanous-test/self-dev-runs' });
  expect(launchBindingRunIds(dir)).toEqual([runId]);
  removeLaunchBinding(runId, dir);
  expect(readLaunchBinding(runId, dir)).toBeNull();
  expect(writeLaunchBinding('../escape', { pid: 1, startedAt: 1, cwd: '/w' }, dir)).toBeNull();
});

test('harness stop finds and stops a run launched from another worktree with no pid.json in the caller universe', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stop-cross-tree-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  const other = join(root, 'other-tree');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(main, 'worktree', 'add', '-q', other);
  mkdirSync(join(other, 'docs', 'goals'), { recursive: true });
  writeFileSync(join(other, 'docs', 'goals', 'g.md'), '대상 경로: docs/x.md\n');
  const registry = join(root, 'registry');
  const runId = `run-${crypto.randomUUID()}`;

  // «self orchestrate» in the other tree: bound in the host registry only — its universe's pid.json is absent.
  const orchestrator = idleChild(other, ['self', 'orchestrate', '--goal-file', 'docs/goals/g.md']);
  // «harness ask» launcher in the other tree: unbound, its argv carries only the relative goal path.
  const launcher = idleChild(other, ['harness', 'ask', 'docs/goals/g.md']);
  const orchestratorStart = await startedAt(orchestrator.pid!);
  await startedAt(launcher.pid!);
  writeLaunchBinding(runId, { pid: orchestrator.pid!, startedAt: orchestratorStart, cwd: other,
    goalPath: join(other, 'docs', 'goals', 'g.md'), runsDir: join(other, '.elanous-test', 'self-dev-runs') }, registry);

  // The caller's own universe has no pid.json or ledger for this run (the 10-03 shape) — only the host binding knows it.
  const deps = defaultHarnessStopDeps({ kubeContexts: () => [], graceMs: 3_000 }, { launchRegistryDir: registry });
  const exited = (child: ChildProcess) => new Promise<void>((r) => { if (child.exitCode !== null || child.signalCode !== null) r(); else child.once('exit', () => r()); });
  const result = await stopHarnessRun(runId, deps, []);
  await Promise.all([exited(orchestrator), exited(launcher)]);

  expect(result.pidRecordFound).toBe(true);
  expect(['stopped', 'killed']).toContain(result.process);
  expect(result.candidates.map((c) => `${c.pid}:${c.via}`).sort()).toEqual([`${launcher.pid}:argv-goal`, `${orchestrator.pid}:pid.json`].sort());
  expect(orchestrator.signalCode ?? orchestrator.exitCode).not.toBeNull();
  expect(launcher.signalCode ?? launcher.exitCode).not.toBeNull();
}, 30_000);

test('a stale binding whose PID now belongs to another process is not signalled', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stop-stale-binding-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const registry = join(root, 'registry');
  const unrelated = idleChild(root, []);
  const actualStart = await startedAt(unrelated.pid!);
  const runId = `run-${crypto.randomUUID()}`;
  // Same PID, but recorded an hour earlier: a reused PID must fail the start-time check.
  writeLaunchBinding(runId, { pid: unrelated.pid!, startedAt: actualStart - 3_600_000, cwd: root }, registry);
  const result = await stopHarnessRun(runId, defaultHarnessStopDeps({ kubeContexts: () => [], graceMs: 500 }, { launchRegistryDir: registry }), []);
  expect(result.process).toBe('owner-mismatch');
  expect(unrelated.exitCode).toBeNull();
  expect(unrelated.signalCode).toBeNull();
}, 30_000);
