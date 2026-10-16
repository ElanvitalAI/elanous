import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decidePrGateCache, type PrGateCacheInput } from './gate-pr-cache.js';

const base = 'a'.repeat(40), head = 'b'.repeat(40), main = 'c'.repeat(40);
const cohort = ['src/a.test.ts', 'src/b.test.ts'];
const summary = { head40: head, base40: base, remoteHost: 'node-b', verdict: 'passed', exitCode: 0,
  introduced: 0, unknown: 0, preconditionUnmet: 0, unrunImporters: 0, cohort };
const input = (patch: Partial<PrGateCacheInput> = {}): PrGateCacheInput => ({ summary, head, main, singlePr: true,
  baseAncestorOfHead: true, baseAncestorOfMain: true, mainChangedFiles: [], inertDocsAddedOnly: true,
  affectedTests: [], sourceDependencyOverlap: false, ...patch });

test('standalone exact-head remote gate can be reused on the same content or an inert doc append', () => {
  expect(decidePrGateCache(input())).toMatchObject({ decision: 'reuse', files: [], reason: 'same-content-base', head, base });
  expect(decidePrGateCache(input({ mainChangedFiles: ['docs/guide.md'] }))).toMatchObject({ decision: 'reuse', reason: 'main-doc-only-outside-radius' });
});

test('main movement outside the author cohort reuses; one reached test requests only that file', () => {
  expect(decidePrGateCache(input({ mainChangedFiles: ['src/other.ts'], affectedTests: [] }))).toMatchObject({ decision: 'reuse', reason: 'main-change-outside-pr-radius' });
  expect(decidePrGateCache(input({ mainChangedFiles: ['src/a.ts'], affectedTests: ['src/a.test.ts'] })))
    .toMatchObject({ decision: 'partial', files: ['src/a.test.ts'], reason: 'main-change-inside-pr-radius' });
  expect(decidePrGateCache(input({ mainChangedFiles: ['src/a.ts'], affectedTests: cohort })))
    .toMatchObject({ decision: 'full', reason: 'whole-author-cohort-affected' });
  expect(decidePrGateCache(input({ mainChangedFiles: ['src/a.ts'], sourceDependencyOverlap: true, affectedTests: [] })))
    .toMatchObject({ decision: 'full', reason: 'pr-source-dependency-without-recheck-test' });
  expect(decidePrGateCache(input({ mainChangedFiles: ['src/a.test.ts'], affectedTests: [] })))
    .toMatchObject({ decision: 'partial', files: ['src/a.test.ts'] });
});

test('bundle, wrong identity, missing coverage, ancestry or uncertain radius all run full', () => {
  const cases: Array<[Partial<PrGateCacheInput>, string]> = [
    [{ singlePr: false }, 'bundle-train'],
    [{ summary: { ...summary, head40: main } }, 'author-gate-unmeasured-or-incomplete'],
    [{ summary: { ...summary, unrunImporters: 3 } }, 'author-gate-unmeasured-or-incomplete'],
    [{ summary: { ...summary, remoteHost: '' } }, 'author-gate-unmeasured-or-incomplete'],
    [{ summary: { ...summary, remoteHost: 'localhost' } }, 'author-gate-unmeasured-or-incomplete'],
    [{ baseAncestorOfMain: false }, 'base-not-ancestor'],
    [{ mainChangedFiles: null }, 'main-diff-unmeasured'],
    [{ mainChangedFiles: ['bun.lock'] }, 'main-noncode-change'],
    [{ mainChangedFiles: ['test/fixtures/readme.md'] }, 'main-noncode-change'],
    [{ mainChangedFiles: ['src/__tests__/readme.md'] }, 'main-noncode-change'],
    [{ mainChangedFiles: ['docs/guide.md'], inertDocsAddedOnly: false }, 'main-document-change-not-addition'],
    [{ mainChangedFiles: ['src/a.ts'], affectedTests: null }, 'radius-unmeasured'],
    [{ mainChangedFiles: ['src/a.ts'], sourceDependencyOverlap: null }, 'pr-source-radius-unmeasured'],
    [{ mainChangedFiles: ['src/a.ts'], affectedTests: ['src/not-in-cohort.test.ts'] }, 'radius-unmeasured'],
  ];
  for (const [patch, reason] of cases) expect(decidePrGateCache(input(patch))).toMatchObject({ decision: 'full', reason, files: [] });
});

test('CLI measures committed ancestry, main diff and import radius from git objects', () => {
  const repo = mkdtempSync(join(tmpdir(), 'gate-pr-cache-'));
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    expect(run.status).toBe(0);
    return run.stdout.trim();
  };
  git('init', '-b', 'main');
  mkdirSync(join(repo, 'src')); mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'src/a.test.ts'), "import { a } from './a';\nif (!a) throw Error();\n");
  writeFileSync(join(repo, 'src/b.test.ts'), 'const b = 1;\n');
  writeFileSync(join(repo, 'docs/guide.md'), 'original\n');
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'base');
  const baseCommit = git('rev-parse', 'HEAD');
  git('switch', '-c', 'feature');
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;\n');
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'feature');
  const feature = git('rev-parse', 'HEAD');
  git('switch', 'main');
  writeFileSync(join(repo, 'docs/new.md'), 'append\n');
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'docs');
  const docsMain = git('rev-parse', 'HEAD');
  const proof = join(repo, 'author-summary.json');
  writeFileSync(proof, JSON.stringify({ ...summary, head40: feature, base40: baseCommit }));
  const decide = (mainSha: string) => {
    const run = spawnSync(process.execPath, [resolve(import.meta.dir, '../gate-pr-cache.ts'), '--summary', proof,
      '--repo', repo, '--head', feature, '--main', mainSha, '--single-pr'], { cwd: repo, encoding: 'utf8' });
    expect(run.status).toBe(0);
    return JSON.parse(run.stdout);
  };
  const missingFlag = spawnSync(process.execPath, [resolve(import.meta.dir, '../gate-pr-cache.ts'), '--summary', proof,
    '--repo', repo, '--head', feature, '--main', docsMain], { cwd: repo, encoding: 'utf8' });
  expect(missingFlag.status).toBe(2);
  expect(missingFlag.stderr).toContain('--single-pr');
  expect(decide(docsMain)).toMatchObject({ decision: 'reuse', reason: 'main-doc-only-outside-radius' });
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 3;\n');
  git('add', 'src/a.ts'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'main code');
  expect(decide(git('rev-parse', 'HEAD'))).toMatchObject({ decision: 'partial', files: ['src/a.test.ts'] });
  writeFileSync(join(repo, 'docs/guide.md'), 'revised\n');
  git('add', 'docs/guide.md'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'modify docs');
  expect(decide(git('rev-parse', 'HEAD'))).toMatchObject({ decision: 'full', reason: 'main-document-change-not-addition' });
}, 30_000);
