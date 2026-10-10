import { expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GhCliResult } from '../git-fs/gh-cli.js';
import { debug } from '../debug/log.js';
import { hqWork, proveMergedPr } from './seats.js';

function response(value: unknown, overrides: Partial<GhCliResult> = {}): GhCliResult {
  return { ok: true, exitCode: 0, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0),
    maybeTruncated: false, ...overrides };
}

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.trim();
}

function withMirror(check: (repo: string, temp: string) => void): void {
  const temp = mkdtempSync(join(tmpdir(), 'hq-pr-proof-'));
  const repo = join(temp, 'repo.git');
  try {
    git(temp, 'init', '--bare', repo);
    git(repo, 'config', 'remote.origin.url', 'https://github.com/acme/hq.git');
    check(repo, temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test('merged PR proof queries the HQ origin even when invoked from a different repository', () => withMirror((repo, temp) => {
  const other = join(temp, 'other');
  git(temp, 'init', other);
  git(other, 'config', 'remote.origin.url', 'https://github.com/foreign/wrong.git');
  const calls: string[][] = [];
  const cwd = process.cwd();
  try {
    process.chdir(other);
    const proof = proveMergedPr(repo, 'work/TC-fix', 'b'.repeat(40), args => {
      calls.push(args);
      return args.at(-1) === 'github.com/acme/hq'
        ? response([{ number: 21, headRefOid: 'a'.repeat(40) }, { number: 42, headRefOid: 'b'.repeat(40) }])
        : response([{ number: 99, headRefOid: 'b'.repeat(40) }]);
    });
    expect(proof).toEqual({ status: 'pr-merged', number: 42 });
  } finally {
    process.chdir(cwd);
  }
  expect(calls).toEqual([['pr', 'list', '--state', 'merged', '--head', 'work/TC-fix', '--json', 'number,headRefOid', '--limit', '1000', '--repo', 'github.com/acme/hq']]);
}));

test('branch match without a matching head commit cannot prove a merge', () => withMirror(repo => {
  const gh = () => response([{ number: 42, headRefOid: 'a'.repeat(40) }]);
  expect(proveMergedPr(repo, 'work/TC-fix', 'b'.repeat(40), gh)).toEqual({ status: 'not-merged' });
  expect(proveMergedPr(repo, 'work/TC-fix', 'a'.repeat(40).toUpperCase(), gh)).toEqual({ status: 'not-merged' });
  expect(proveMergedPr(repo, 'work/TC-fix', 'a'.repeat(40), () => response([]))).toEqual({ status: 'not-merged' });
}));

test('a merged PR beyond the default 30 results is found, and a full unmatched page stays unknown', () => withMirror(repo => {
  const tip = 'b'.repeat(40);
  const older = Array.from({ length: 999 }, (_, index) => ({ number: index + 1, headRefOid: 'a'.repeat(40) }));
  expect(proveMergedPr(repo, 'work/TC-fix', tip, () => response([...older, { number: 1000, headRefOid: tip }]))).toEqual({ status: 'pr-merged', number: 1000 });
  expect(proveMergedPr(repo, 'work/TC-fix', tip, () => response([...older, { number: 1000, headRefOid: 'a'.repeat(40) }]))).toEqual({ status: 'unknown' });
  expect(proveMergedPr(repo, 'work/TC-fix', tip, () => response(older))).toEqual({ status: 'not-merged' });
}));

test('unavailable, truncated and malformed PR responses are unknown, never proof', () => withMirror(repo => {
  const tip = 'a'.repeat(40);
  const record = [{ number: 42, headRefOid: tip }];
  expect(proveMergedPr(repo, 'work/TC-fix', tip, () => response(record, { ok: false, exitCode: 1 }))).toEqual({ status: 'unknown' });
  expect(proveMergedPr(repo, 'work/TC-fix', tip, () => response(record, { maybeTruncated: true }))).toEqual({ status: 'unknown' });
  expect(proveMergedPr(repo, 'work/TC-fix', tip, () => { throw new Error('gh unavailable'); })).toEqual({ status: 'unknown' });
  expect(proveMergedPr(repo, 'work/TC-fix', tip, () => response(record, { stdout: Buffer.from('not json') }))).toEqual({ status: 'unknown' });
  for (const value of [{ number: 42, headRefOid: tip }, [null], [{ number: '42', headRefOid: tip }],
    [{ number: 42 }], [{ number: 42, headRefOid: tip }, { number: 0, headRefOid: tip }]]) {
    expect(proveMergedPr(repo, 'work/TC-fix', tip, () => response(value))).toEqual({ status: 'unknown' });
  }
}));

test('a local-only or missing HQ origin cannot be replaced by the caller repository', () => withMirror((repo, temp) => {
  const gh = (): GhCliResult => { throw new Error('unexpected gh invocation'); };
  git(repo, 'config', 'remote.origin.url', join(temp, 'local.git'));
  expect(proveMergedPr(repo, 'work/TC-fix', 'a'.repeat(40), gh)).toEqual({ status: 'unknown' });
  git(repo, 'config', '--unset', 'remote.origin.url');
  expect(proveMergedPr(repo, 'work/TC-fix', 'a'.repeat(40), gh)).toEqual({ status: 'unknown' });
}));

test('missing branch or tip never invokes gh or returns a proof', () => withMirror(repo => {
  const gh = (): GhCliResult => { throw new Error('unexpected gh invocation'); };
  expect(proveMergedPr(repo, '', 'a'.repeat(40), gh)).toEqual({ status: 'unknown' });
  expect(proveMergedPr(repo, 'work/TC-fix', '', gh)).toEqual({ status: 'unknown' });
}));

test('work done consumes exact merged PR proof for a clean tip not on origin/main', () => {
  const temp = mkdtempSync(join(tmpdir(), 'hq-pr-proof-'));
  const root = join(temp, 'house');
  const remote = join(temp, 'remote.git');
  const seed = join(temp, 'seed');
  const cli = join(import.meta.dir, '../../bin/elanous.mjs');
  try {
    mkdirSync(root);
    git(temp, 'init', '--bare', remote);
    git(temp, 'init', '-b', 'main', seed);
    git(seed, 'config', 'user.name', 'Fixture');
    git(seed, 'config', 'user.email', 'fixture@example.test');
    writeFileSync(join(seed, 'README'), 'base\n');
    git(seed, 'add', 'README');
    git(seed, 'commit', '-m', 'base');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-u', 'origin', 'main');
    const init = spawnSync('bun', [cli, `--test=${join(temp, 'test-state')}`, 'hq', 'init', '--root', root], {
      cwd: seed, encoding: 'utf8', env: { ...process.env, HOME: temp },
    });
    expect(init.status, init.stderr).toBe(0);
    const work = hqWork('new', 'TC', 'proof', { root }).path;
    writeFileSync(join(work, 'feature'), 'unlanded\n');
    git(work, 'add', 'feature');
    git(work, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'feature');
    const tip = git(work, 'rev-parse', 'HEAD');
    const branch = 'work/TC-proof';
    const mirror = join(root, 'repo.git');
    git(mirror, 'config', 'remote.origin.url', 'https://github.com/acme/hq.git');
    git(mirror, 'config', `url.${remote}.insteadOf`, 'https://github.com/acme/hq.git');
    const calls: string[][] = [];
    const gh = (args: string[]): GhCliResult => {
      calls.push(args);
      return response([{ number: 8, headRefOid: tip }]);
    };
    const events: Array<{ branch: string; tip: string; rule: string }> = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'hq.work' && event === 'done-judged') events.push(data as { branch: string; tip: string; rule: string });
    });
    try {
      expect(() => hqWork('done', 'TC', 'proof', { root, gh: () => response([{ number: 8, headRefOid: 'f'.repeat(40) }]) })).toThrow('not merged');
      expect(existsSync(work)).toBe(true);
      // A tip merged to a different base must not authorize removal from an origin/main worktree.
      expect(() => hqWork('done', 'TC', 'proof', { root, gh: args => args.includes('--base')
        ? response([]) : response([{ number: 8, headRefOid: tip }]) })).toThrow('not merged');
      expect(existsSync(work)).toBe(true);
      expect(hqWork('done', 'TC', 'proof', { root, gh }).outcome).toBe('removed');
      expect(calls).toEqual([['pr', 'list', '--state', 'merged', '--head', branch, '--base', 'main', '--json', 'number,headRefOid', '--limit', '1000', '--repo', 'github.com/acme/hq']]);
      expect(existsSync(work)).toBe(false);
      expect(events.at(-1)).toEqual({ branch, tip, rule: 'pr-merged' });
    } finally { log.mockRestore(); }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 120_000);
