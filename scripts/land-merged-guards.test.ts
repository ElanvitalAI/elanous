import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LAND_MERGED_GUARD_TESTS, runLandMergedGuards } from './land-merged-guards.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function fixture(violates: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'land-merged-guard-')); roots.push(root);
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'state.txt'), 'safe'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  git(root, 'switch', '-qc', 'candidate');
  writeFileSync(join(root, 'state.txt'), violates ? 'unsafe' : 'safe candidate');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'candidate'); const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', '-q', '-');
  for (const file of LAND_MERGED_GUARD_TESTS) {
    const path = join(root, file); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "import {test,expect} from 'bun:test'; import {readFileSync} from 'node:fs'; test('guard',()=>expect(readFileSync('state.txt','utf8')).not.toContain('unsafe'));\n");
  }
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'add guards on main'); const main = git(root, 'rev-parse', 'HEAD');
  git(root, 'merge', '-q', '--no-ff', '--no-edit', head);
  return { root, main, head };
}

test('checks the actual merge with newly landed main guards and refuses a boundary violation', () => {
  const bad = fixture(true);
  expect(runLandMergedGuards(bad.root, bad.main, bad.head)).toBe(1);
  const good = fixture(false);
  expect(runLandMergedGuards(good.root, good.main, good.head)).toBe(0);
  expect(runLandMergedGuards(good.root, good.head, good.main)).toBe(2);
  writeFileSync(join(good.root, 'state.txt'), 'unsafe');
  expect(runLandMergedGuards(good.root, good.main, good.head)).toBe(2);
  git(good.root, 'restore', 'state.txt');
  rmSync(join(good.root, LAND_MERGED_GUARD_TESTS[0]));
  expect(runLandMergedGuards(good.root, good.main, good.head)).toBe(2);
});
