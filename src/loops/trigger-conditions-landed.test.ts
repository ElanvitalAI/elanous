// OP-OBSERVE-LANDED (11-27 22:39 live) — the bulletin said «착지: +0 (… main 총 0)» while 8 PRs had landed that hour:
// landedCount ran `git rev-list` in the installed package dir (not a git repo) and mapped the empty output to 0.
// countOriginMain: a real repo → its origin/main commit count; every failure → null (the bulletin's «측정 실패»), never 0.
// Expectations are literals (rule 11): commit counts are the commits this test makes.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countOriginMain } from './trigger-conditions.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'landed-count-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

describe('countOriginMain', () => {
  test('a real repo: counts the commits on origin/main', () => {
    git(dir, 'init', '-q', '-b', 'main');
    for (const n of ['a', 'b', 'c']) { writeFileSync(join(dir, n), n); git(dir, 'add', n); git(dir, 'commit', '-q', '-m', n); }
    git(dir, 'update-ref', 'refs/remotes/origin/main', git(dir, 'rev-parse', 'HEAD'));
    expect(countOriginMain(dir)).toBe(3);
  });

  test('a directory that is not a git repo (the installed package dir) → null, not 0', () => {
    expect(countOriginMain(dir)).toBeNull();
  });

  test('a repo without origin/main → null', () => {
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a'), 'a'); git(dir, 'add', 'a'); git(dir, 'commit', '-q', '-m', 'a');
    expect(countOriginMain(dir)).toBeNull();
  });

  test('no repo resolved → null without running git', () => {
    let ran = 0;
    expect(countOriginMain(null, () => { ran += 1; return { status: 0, stdout: '5\n' }; })).toBeNull();
    expect(ran).toBe(0);
  });

  test('git non-zero · empty · non-numeric · zero · spawn throws → null', () => {
    expect(countOriginMain('/r', () => ({ status: 128, stdout: '' }))).toBeNull();
    expect(countOriginMain('/r', () => ({ status: null, stdout: '' }))).toBeNull();
    expect(countOriginMain('/r', () => ({ status: 0, stdout: '' }))).toBeNull();
    expect(countOriginMain('/r', () => ({ status: 0, stdout: 'fatal: bad\n' }))).toBeNull();
    expect(countOriginMain('/r', () => ({ status: 0, stdout: '0\n' }))).toBeNull();
    expect(countOriginMain('/r', () => { throw new Error('ENOENT git'); })).toBeNull();
  });

  test('passes the resolved repo to git -C', () => {
    const seen: string[][] = [];
    expect(countOriginMain('/hq/repo.git', (a) => { seen.push(a); return { status: 0, stdout: '40123\n' }; })).toBe(40123);
    expect(seen).toEqual([['-C', '/hq/repo.git', 'rev-list', '--count', 'origin/main']]);
  });
});
