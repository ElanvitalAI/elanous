import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveRemoteExportCheckInvocation, runExportCheck } from './export-check-node.js';
import type { CommandRunner } from './node-verdict.js';

const commit = 'a'.repeat(40);

function check(exportStatus: number, buildStatus: number, index = false, pwaDependencies = true, pwaInstallStatus = 0, pwaInstallCreatesModules = true, identity?: { commit: string; version: string }, buildOutput?: string) {
  const root = mkdtempSync(join(tmpdir(), 'release-export-check-test-'));
  const repo = join(root, 'repo');
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  mkdirSync(join(repo, 'node_modules'), { recursive: true });
  if (pwaDependencies) mkdirSync(join(repo, 'apps', 'pwa', 'node_modules'), { recursive: true });
  if (identity) delete process.env.ELANOUS_GRAPH_CONTEXT;
  else process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.8', previousVersion: '0.2.7' }, outputs: { 'version-release': { commit } } });
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
      return { status: buildStatus, stdout: '', stderr: buildStatus ? buildOutput ?? `module missing ${'y'.repeat(310)}` : '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    const result = runExportCheck(run, repo, identity);
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

test('build failure preserves ANSI-stripped TypeScript file and line diagnostics', () => {
  const first = '\u001b[31m./scripts/release-loop/gate-node.ts:4187:15 - error TS2339: Property \'summary\' does not exist on type GateResult.\u001b[39m';
  const spaced = '\u001b[31mapps/pwa/src/with spaces/page.tsx:22:3 - error TS2322: Type \'string\' is not assignable to type \'number\'.\u001b[39m';
  const output = [
    'Failed to compile.',
    first,
    first,
    'diagnostic appears before the bounded tail '.repeat(12),
    '\u001b[31msrc/graph-runner/runner.ts:1746:22 - error TS2488: Type \'unknown\' must have a [Symbol.iterator]() method.\u001b[39m',
    spaced,
    'Next.js build worker exited with code: 1',
  ].join('\n');
  const { result } = check(0, 1, false, true, 0, true, undefined, output);
  expect(result).toMatchObject({ outcome: 'fail', step: 'build', diagnostics: [
    './scripts/release-loop/gate-node.ts:4187 TS2339: Property \'summary\' does not exist on type GateResult.',
    'src/graph-runner/runner.ts:1746 TS2488: Type \'unknown\' must have a [Symbol.iterator]() method.',
    'apps/pwa/src/with spaces/page.tsx:22 TS2322: Type \'string\' is not assignable to type \'number\'.',
  ] });
  expect(result.tail).not.toContain('gate-node.ts');
  expect(result.diagnostics?.every((diagnostic) => !diagnostic.includes('\u001b['))).toBe(true);
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


test('pinned remote child checks the requested commit without graph context', () => {
  const { result, calls, sourceGone, tempGone } = check(0, 0, true, true, 0, true, { commit, version: '0.2.8' });
  expect(result).toMatchObject({ outcome: 'ok', verdict: 'pass', step: 'build' });
  expect(calls[0]?.args).toEqual(['worktree', 'add', '-q', '--detach', expect.any(String), commit]);
  expect(sourceGone && tempGone).toBe(true);
});

test('remote host-only invocation resolves commit and version from graph context', () => {
  const context = { input: { version: '0.3.6', exportCheckRemote: 'gcp2' }, outputs: { 'version-release': { commit } } } as never;
  expect(resolveRemoteExportCheckInvocation(['--remote', 'gcp2'], () => context)).toEqual({
    host: 'gcp2', commit, version: '0.3.6', graphContext: JSON.stringify(context),
  });
});

test('real export-check CLI sends graph commit/version through a fake SSH remote boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-check-cli-process-'));
  const bin = join(root, 'bin');
  const bareMirror = join(root, 'mirror.git');
  const sshScript = join(root, 'ssh-script.log');
  const sshArgs = join(root, 'ssh-args.log');
  const redactions = join(root, 'redactions.tsv');
  const ssh = join(bin, 'ssh');
  const currentCommit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  mkdirSync(bin, { recursive: true });
  const init = spawnSync('git', ['clone', '--bare', '--shared', '--quiet', process.cwd(), bareMirror], { encoding: 'utf8' });
  expect(init.status).toBe(0);
  writeFileSync(ssh, [
    '#!/bin/sh',
    'case "$*" in *git-receive-pack*) exec git-receive-pack "$MOCK_GATE_MIRROR";; esac',
    'printf \'%s\\n\' "$*" > "$MOCK_GATE_SSH_ARGS"',
    'cat > "$MOCK_GATE_SSH_SCRIPT"',
    'printf \'%s\\n\' "$MOCK_GATE_REMOTE_RESULT"',
    'printf \'\\n__GATE_REMOTE_RC=0\\n\' >&2',
  ].join('\n'));
  chmodSync(ssh, 0o755);
  writeFileSync(redactions, 'private-test-value\tpublic-placeholder\n', { mode: 0o600 });
  chmodSync(redactions, 0o600);
  const fakeResult = JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: 'fake remote export-check pass', step: 'build', tail: '' });
  const context = JSON.stringify({ input: { version: '0.3.6', previousVersion: '0.3.5' }, outputs: { 'version-release': { commit: currentCommit } } });
  try {
    const run = spawnSync(process.execPath, [join(import.meta.dir, 'export-check-node.ts'), '--remote', 'aws1'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ELANOUS_GRAPH_CONTEXT: context,
        ELANOUS_STATE_DIR: join(root, 'state'),
        ELANOUS_EXPORT_REDACTIONS: redactions,
        MOCK_GATE_MIRROR: bareMirror,
        MOCK_GATE_SSH_ARGS: sshArgs,
        MOCK_GATE_SSH_SCRIPT: sshScript,
        MOCK_GATE_REMOTE_RESULT: fakeResult,
      },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('"summary":"fake remote export-check pass"');
    const receivedScript = readFileSync(sshScript, 'utf8');
    expect(readFileSync(sshArgs, 'utf8')).toContain('aws1 sh -s');
    expect(receivedScript).toContain(`'bun' 'scripts/release-loop/export-check-node.ts' '--local' '--commit' '${currentCommit}' '--version' '0.3.6'`);
    expect(receivedScript).toContain('ELANOUS_GRAPH_CONTEXT="$W/payload-0"');
    expect(receivedScript).toContain(context);
    expect(receivedScript).toContain('private-test-value\tpublic-placeholder');
    expect(receivedScript).toContain(`git fetch -q origin refs/elanous/gate/${currentCommit}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test('pinned invocation requires both valued identity flags', () => {
  const readContext = () => { throw new Error('graph context should not be read'); };
  expect(() => resolveRemoteExportCheckInvocation(['--remote', 'aws1', '--commit', commit], readContext)).toThrow('--commit and --version must be provided together');
  expect(() => resolveRemoteExportCheckInvocation(['--remote', 'aws1', '--commit', '--version', '0.3.6'], readContext)).toThrow('--commit and --version require values');
});
