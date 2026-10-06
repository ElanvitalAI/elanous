// `pr land --cwd <tree>` measures typecheck and mock-module restore against that tree, not process.cwd().
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGate } from '../../scripts/ci-typecheck-changed.js';
import { runMockModuleRestoreGate } from '../../scripts/ci-mock-module-restore-gate.js';

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

/** A repo whose only change since the root commit is a markdown file — zero .ts. */
function docsOnlyTree(): { dir: string; base: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prland-cwd-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'prland-cwd@example.com']);
  git(dir, ['config', 'user.name', 'prland-cwd']);
  writeFileSync(join(dir, 'README.md'), '# root\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'root']);
  const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  // The gate's default base is merge-base(origin/main). A bare temp repo has no remote, so publish main locally.
  git(dir, ['update-ref', 'refs/remotes/origin/main', base]);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'note.md'), '# note\n');
  writeFileSync(join(dir, 'docs', 'other.md'), '# other\n');
  git(dir, ['add', 'docs']);
  git(dir, ['commit', '-q', '-m', 'docs only']);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  return { dir, base, head };
}

function capture(run: (log: (message: string) => void, error: (message: string) => void, exit: (code: number) => never) => void): { lines: string[]; code: number } {
  const lines: string[] = [];
  let code = 0;
  const exit = ((next: number): never => {
    code = next;
    throw new Error(`exit ${next}`);
  });
  try {
    run((message) => lines.push(message), (message) => lines.push(message), exit);
  } catch (error) {
    if (code === 0) throw error;
  }
  return { lines, code };
}

test('tsc gate on --cwd docs-only tree reports base≠head, zero changed .ts, and PASS', () => {
  const { dir, base, head } = docsOnlyTree();
  expect(base).not.toBe(head);
  const { lines, code } = capture((log, error, exit) => {
    runGate({ cwd: dir, log, warn: error, error, exit });
  });
  const summary = lines.find((line) => line.startsWith('[tsc-gate] base='));
  expect(summary).toBeDefined();
  expect(summary).toContain(`base=${base}`);
  expect(summary).toContain(`head=${head}`);
  expect(summary).toContain('변경 .ts 0개');
  expect(lines.some((line) => line.startsWith('[tsc-gate] PASS'))).toBe(true);
  expect(code).toBe(0);
});

test('dropping cwd makes the same docs-only tree fail as base==HEAD (could not count)', () => {
  // History the 10-06 cut had: HEAD is an ancestor of origin/main, so the pinned base
  // (merge-base of that main) resolves to HEAD itself and the docs diff cannot be counted.
  const dir = mkdtempSync(join(tmpdir(), 'prland-cwd-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'prland-cwd@example.com']);
  git(dir, ['config', 'user.name', 'prland-cwd']);
  writeFileSync(join(dir, 'README.md'), '# root\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'root']);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'note.md'), '# note\n');
  git(dir, ['add', 'docs']);
  git(dir, ['commit', '-q', '-m', 'docs']);
  const docs = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const ahead = spawnSync('git', ['commit-tree', `${docs}^{tree}`, '-p', docs, '-m', 'cut moved on'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  git(dir, ['update-ref', 'refs/remotes/origin/main', ahead]);
  git(dir, ['checkout', '-q', '--detach', docs]);
  const saved = process.cwd();
  process.chdir(dir);
  let lines: string[] = [];
  let code = 0;
  try {
    ({ lines, code } = capture((log, error, exit) => {
      runGate({ baseRef: docs, log, warn: error, error, exit });
    }));
  } finally {
    process.chdir(saved);
  }
  const text = lines.join('\n');
  expect(code).toBe(1);
  expect(text).toContain(`base 가 HEAD(${docs})`);
  expect(text).toContain('못 셌음');
});

test('mock-module restore gate scans the landing tree, not the tree the process was launched from', () => {
  const clean = docsOnlyTree().dir;
  mkdirSync(join(clean, 'scripts'), { recursive: true });
  writeFileSync(join(clean, 'scripts', 'mock-module-restore-baseline.txt'), '# one grandfathered row keeps an empty scan measurable\n1\tsrc/kept.test.ts\n');
  expect(runMockModuleRestoreGate({ args: [], cwd: clean, log: () => {}, error: () => {} })).toBe(0);

  const dirty = docsOnlyTree().dir;
  mkdirSync(join(dirty, 'scripts'), { recursive: true });
  writeFileSync(join(dirty, 'scripts', 'mock-module-restore-baseline.txt'), '# measured\n');
  mkdirSync(join(dirty, 'src'), { recursive: true });
  writeFileSync(join(dirty, 'src', 'new.test.ts'), "import { mock } from 'bun:test';\nmock.module('node:fs', () => ({ readFileSync: () => '' }));\n");
  expect(runMockModuleRestoreGate({ args: [], cwd: dirty, log: () => {}, error: () => {} })).toBe(1);
});
