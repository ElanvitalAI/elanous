import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExportCheck } from './export-check-node.js';
import type { CommandRunner } from './node-verdict.js';

const commit = 'a'.repeat(40);

function check(exportStatus: number, buildStatus: number, index = false, pwaDependencies = true, pwaInstallStatus = 0, pwaInstallCreatesModules = true) {
  const root = mkdtempSync(join(tmpdir(), 'release-export-check-test-'));
  const repo = join(root, 'repo');
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  mkdirSync(join(repo, 'node_modules'), { recursive: true });
  if (pwaDependencies) mkdirSync(join(repo, 'apps', 'pwa', 'node_modules'), { recursive: true });
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.8', previousVersion: '0.2.7' }, outputs: { 'version-release': { commit } } });
  const run: CommandRunner = (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      mkdirSync(args[args.indexOf('--detach') + 1]!, { recursive: true });
      writeFileSync(join(args[args.indexOf('--detach') + 1]!, 'package.json'), JSON.stringify({ version: '0.2.8' }));
    }
    if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${commit}\n`, stderr: '' };
    if (command === 'bun' && args[0] === 'scripts/public-export.ts') {
      if (exportStatus === 0) {
        mkdirSync(join(args[2]!, 'apps', 'pwa'), { recursive: true });
      }
      return { status: exportStatus, stdout: '', stderr: exportStatus ? `leak ${'x'.repeat(310)}` : '' };
    }
    if (command === 'bun' && args[0] === 'install') {
      if (pwaInstallCreatesModules) mkdirSync(join(repo, 'apps', 'pwa', 'node_modules'), { recursive: true });
      return { status: pwaInstallStatus, stdout: '', stderr: pwaInstallStatus ? `install failed ${'z'.repeat(310)}` : '' };
    }
    if (command === 'bun' && args[0] === 'bin/elanous.mjs') {
      if (index) {
        mkdirSync(join(cwd!, 'apps', 'pwa', 'out'), { recursive: true });
        writeFileSync(join(cwd!, 'apps', 'pwa', 'out', 'index.html'), 'ok');
      }
      return { status: buildStatus, stdout: '', stderr: buildStatus ? `module missing ${'y'.repeat(310)}` : '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    const result = runExportCheck(run, repo);
    const add = calls.find((call) => call.args[0] === 'worktree' && call.args[1] === 'add')!;
    const source = add.args[add.args.indexOf('--detach') + 1]!;
    const exportDir = calls.find((call) => call.args[0] === 'scripts/public-export.ts')?.args[2];
    return { result, calls, exportDir, pwaModulesGone: !existsSync(join(repo, 'apps', 'pwa', 'node_modules')),
      sourceGone: !existsSync(source), tempGone: !existsSync(join(source, '..')) };
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('export leak stops before build and removes the cut worktree', () => {
  const { result, calls, sourceGone, tempGone } = check(1, 0);
  expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail', step: 'export', tail: 'x'.repeat(300) });
  expect(calls.filter((c) => c.command === 'bun')).toHaveLength(1);
  expect(calls.at(-1)?.args).toEqual(['worktree', 'remove', '--force', calls[0]!.args[calls[0]!.args.indexOf('--detach') + 1]!]);
  expect(sourceGone && tempGone).toBe(true);
});

test('build failure and missing index.html report the build tail', () => {
  const failed = check(0, 1);
  expect(failed.result).toMatchObject({ outcome: 'fail', verdict: 'fail', step: 'build', tail: 'y'.repeat(300) });
  expect(failed.calls.filter((c) => c.command === 'bun').map((c) => c.args.slice(0, 3))).toEqual([
    ['scripts/public-export.ts', '--out', failed.exportDir!], ['bin/elanous.mjs', 'nexus', 'build'],
  ]);
  expect(failed.calls.at(-1)?.args[1]).toBe('remove');
  const missing = check(0, 0);
  expect(missing.result).toMatchObject({ outcome: 'fail', step: 'build' });
});

test('missing PWA dependencies install in the release worktree before build', () => {
  const { result, calls, sourceGone, tempGone, exportDir } = check(0, 0, true, false);
  const install = calls.find((call) => call.args[0] === 'install');
  const build = calls.find((call) => call.args.includes('nexus'));
  expect(result).toMatchObject({ outcome: 'ok', verdict: 'pass', step: 'build' });
  expect(install).toMatchObject({ command: 'bun', args: ['install', '--cwd', expect.stringContaining('/apps/pwa'), '--frozen-lockfile'], cwd: expect.stringContaining('repo') });
  expect(calls.indexOf(install!)).toBeLessThan(calls.indexOf(build!));
  expect(build?.cwd).toBe(exportDir);
  expect(sourceGone && tempGone).toBe(true);
});

test('failed PWA install stops the build and still removes the temporary worktree', () => {
  const { result, calls, pwaModulesGone, sourceGone, tempGone } = check(0, 0, true, false, 1);
  expect(result).toMatchObject({
    outcome: 'fail', step: 'build', summary: 'build failed: PWA dependency install (rc=1)', tail: 'z'.repeat(300),
  });
  expect(calls.filter((c) => c.command === 'bun').map((call) => call.args[0])).toEqual(['scripts/public-export.ts', 'install']);
  expect(pwaModulesGone).toBe(true);
  expect(calls.at(-1)?.args[1]).toBe('remove');
  expect(sourceGone && tempGone).toBe(true);
});

test('successful PWA install without node_modules stops before build and removes the temporary worktree', () => {
  const { result, calls, sourceGone, tempGone } = check(0, 0, true, false, 0, false);
  expect(result).toMatchObject({ outcome: 'fail', step: 'build', summary: 'build failed: PWA dependency install did not create apps/pwa/node_modules (rc=0)' });
  expect(calls.filter((call) => call.command === 'bun').map((call) => call.args[0])).toEqual(['scripts/public-export.ts', 'install']);
  expect(calls.at(-1)?.args[1]).toBe('remove');
  expect(sourceGone && tempGone).toBe(true);
});

test('successful export and public PWA build remove the temporary worktree', () => {
  const { result, calls, sourceGone, tempGone } = check(0, 0, true);
  expect(result).toMatchObject({ outcome: 'ok', verdict: 'pass', step: 'build', tail: '' });
  expect(calls.some((call) => call.args[0] === 'install')).toBe(false);
  expect(calls.at(-1)?.args[1]).toBe('remove');
  expect(sourceGone && tempGone).toBe(true);
  expect(calls.some((c) => c.command === 'git' && c.args.includes('push'))).toBe(false);
});
