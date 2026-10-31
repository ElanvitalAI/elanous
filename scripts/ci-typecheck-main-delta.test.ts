import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function fixture(): { root: string; baseline: string; temp: string; fakeBin: string } {
  const root = mkdtempSync(join(tmpdir(), 'typecheck-main-delta-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const temp = join(root, 'tmp');
  const fakeBin = join(root, 'bin');
  mkdirSync(repo);
  mkdirSync(join(repo, 'node_modules'));
  mkdirSync(temp);
  mkdirSync(fakeBin);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'TSC delta test');
  git(repo, 'config', 'user.email', 'tsc-delta@test.local');
  writeFileSync(join(repo, 'package.json'), '{"name":"delta-fixture"}\n');
  writeFileSync(join(repo, 'tsc-diagnostics.txt'), 'src/old.ts(1,1): error TS1001: baseline debt\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'main baseline');
  const baseline = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'tsc-diagnostics.txt'), [
    'src/old.ts(1,1): error TS1001: baseline debt',
    'src/new.ts(2,1): error TS2002: introduced diagnostic',
    '',
  ].join('\n'));
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'integration head');
  const fakeBunx = join(fakeBin, 'bunx');
  writeFileSync(fakeBunx, '#!/bin/sh\n[ "$1" = tsc ] && [ "$2" = --noEmit ] && [ "$3" = --pretty ] && [ "$4" = false ] || exit 64\ncat tsc-diagnostics.txt\nexit 1\n');
  chmodSync(fakeBunx, 0o755);
  const fakeBun = join(fakeBin, 'bun');
  writeFileSync(fakeBun, '#!/bin/sh\n[ "$1" = install ] && [ "$2" = --frozen-lockfile ] || exit 64\nprintf "%s\\n" "$PWD" > "$BASELINE_INSTALL_MARKER"\nmkdir -p node_modules\n');
  chmodSync(fakeBun, 0o755);
  return { root: repo, baseline, temp, fakeBin };
}

function run(root: string, baseline: string, temp: string, fakeBin: string) {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'ci-typecheck-main-delta.sh');
  return spawnSync('bash', [script, baseline], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}`, TMPDIR: temp, BASELINE_INSTALL_MARKER: join(temp, 'baseline-install-path') },
  });
}

test('baseline-only diagnostics pass and the temporary baseline worktree is removed', () => {
  const { root, baseline, temp, fakeBin } = fixture();
  writeFileSync(join(root, 'tsc-diagnostics.txt'), 'src/old.ts(1,1): error TS1001: baseline debt\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'no new diagnostic');

  const result = run(root, baseline, temp, fakeBin);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('baseline_errors=1 head_errors=1 new_errors=0');
  expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
});

test('baseline diagnostic line movement does not become a new diagnostic', () => {
  const { root, baseline, temp, fakeBin } = fixture();
  writeFileSync(join(root, 'tsc-diagnostics.txt'), 'src/old.ts(7,3): error TS1001: baseline debt\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'move old diagnostic location');

  const result = run(root, baseline, temp, fakeBin);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('baseline_errors=1 head_errors=1 new_errors=0');
});

test('an integration-only TypeScript diagnostic fails the gate and is reported', () => {
  const { root, baseline, temp, fakeBin } = fixture();
  const result = run(root, baseline, temp, fakeBin);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('new_errors=1');
  expect(result.stderr).toContain('error: main-baseline tsc introduced 1 TypeScript diagnostic');
  expect(result.stderr).toContain('src/new.ts: error TS2002: introduced diagnostic');
  expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
});

test('changed continuation lines in a multiline diagnostic are detected', () => {
  const { root, baseline, temp, fakeBin } = fixture();
  writeFileSync(join(root, 'tsc-diagnostics.txt'), [
    'src/old.ts(1,1): error TS1001: baseline debt',
    '  Details: integration changed the incompatible type',
    '',
  ].join('\n'));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'change diagnostic continuation');

  const result = run(root, baseline, temp, fakeBin);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('new_errors=1');
  expect(result.stderr).toContain('Details: integration changed the incompatible type');
});

test('an additional duplicate TypeScript diagnostic is counted as new', () => {
  const { root, baseline, temp, fakeBin } = fixture();
  writeFileSync(join(root, 'tsc-diagnostics.txt'), [
    'src/old.ts(1,1): error TS1001: baseline debt',
    'src/old.ts(2,1): error TS1001: baseline debt',
    '',
  ].join('\n'));
  git(root, 'add', 'tsc-diagnostics.txt');
  git(root, 'commit', '-qm', 'duplicate baseline diagnostic');

  const result = run(root, baseline, temp, fakeBin);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('baseline_errors=1 head_errors=2 new_errors=1');
});

test('dependency changes install the pinned-main baseline in its own tree', () => {
  const { root, baseline, temp, fakeBin } = fixture();
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"example":"2.0.0"}}\n');
  writeFileSync(join(root, 'tsc-diagnostics.txt'), 'src/old.ts(1,1): error TS1001: baseline debt\n');
  git(root, 'add', 'package.json', 'tsc-diagnostics.txt');
  git(root, 'commit', '-qm', 'change dependency graph');

  const result = run(root, baseline, temp, fakeBin);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain('installing pinned-main dependencies independently');
  expect(result.stdout).toContain('baseline_errors=1 head_errors=1 new_errors=0');
  const installPath = readFileSync(join(temp, 'baseline-install-path'), 'utf8').trim();
  expect(installPath).toContain('/base');
  expect(installPath).not.toBe(root);
});

test('a failing diagnostics comparator fails closed', () => {
  const { root, baseline, temp, fakeBin } = fixture();
  const comm = join(fakeBin, 'comm');
  writeFileSync(comm, '#!/bin/sh\nexit 42\n');
  chmodSync(comm, 0o755);

  const result = run(root, baseline, temp, fakeBin);
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain('new_errors=0');
});

test('an invalid baseline refuses before running tsc', () => {
  const { root, temp, fakeBin } = fixture();
  const result = run(root, 'not-a-sha', temp, fakeBin);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('expected a pinned 40-character main baseline SHA');
});
