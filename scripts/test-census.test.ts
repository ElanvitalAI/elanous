import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseFor, numericCandidateEvidence, sourcePathFor } from './test-census';

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Census simulation', GIT_AUTHOR_EMAIL: 'census@example.invalid', GIT_COMMITTER_NAME: 'Census simulation', GIT_COMMITTER_EMAIL: 'census@example.invalid' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  return execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('test census source attribution', () => {
  it('simulates expected-value provenance from the literal through blame to the commit rationale', () => {
    const repo = mkdtempSync(join(tmpdir(), 'test-census-numeric-provenance-'));
    try {
      git(repo, 'init', '-q', '-b', 'main');
      const sourcePath = join(repo, 'retry-contract.test.ts');
      writeFileSync(sourcePath, "test('caps retries at the documented remote quota', () => {\n  expect(retryCount).toBeLessThan(4);\n  expect(windowCount).toBe(5);\n});\n");
      git(repo, 'add', 'retry-contract.test.ts');
      git(repo, 'commit', '-q', '-m', 'Cap retries at the remote quota', '-m', 'Reason: the provider rejects a fifth attempt in one window.');
      const commit = git(repo, 'rev-parse', 'HEAD').trim();

      expect(numericCandidateEvidence(sourcePath, [{ literal: '4', line: 2 }, { literal: '5', line: 3 }], repo)).toEqual([
        { literal: '4', line: 2, blameCommit: commit, reason: 'Cap retries at the remote quota\n\nReason: the provider rejects a fifth attempt in one window.' },
        { literal: '5', line: 3, blameCommit: commit, reason: 'Cap retries at the remote quota\n\nReason: the provider rejects a fifth attempt in one window.' },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps absent blame or rationale visibly unknown instead of inventing a source', () => {
    const repo = mkdtempSync(join(tmpdir(), 'test-census-numeric-untracked-'));
    try {
      git(repo, 'init', '-q', '-b', 'main');
      const sourcePath = join(repo, 'untracked.test.ts');
      writeFileSync(sourcePath, 'expect(value).toBe(7);\n');
      expect(numericCandidateEvidence(sourcePath, [{ literal: '7', line: 1 }], repo)).toEqual([{
        literal: '7',
        line: 1,
        blameCommit: null,
        reason: null,
      }]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps shallow-boundary attribution unknown when the introducing commit is outside history', () => {
    const repo = mkdtempSync(join(tmpdir(), 'test-census-numeric-shallow-source-'));
    const shallow = mkdtempSync(join(tmpdir(), 'test-census-numeric-shallow-clone-'));
    try {
      git(repo, 'init', '-q', '-b', 'main');
      const sourcePath = join(repo, 'retry-contract.test.ts');
      writeFileSync(sourcePath, "const description = 'initial';\nexpect(retryCount).toBeLessThan(4);\n");
      git(repo, 'add', 'retry-contract.test.ts');
      git(repo, 'commit', '-q', '-m', 'Introduce retry limit', '-m', 'Reason: cap retries to protect the provider quota.');
      writeFileSync(sourcePath, "const description = 'updated';\nexpect(retryCount).toBeLessThan(4);\n");
      git(repo, 'add', 'retry-contract.test.ts');
      git(repo, 'commit', '-q', '-m', 'Update fixture description');
      execFileSync('git', ['clone', '-q', '--depth=1', `file://${repo}`, shallow], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

      expect(numericCandidateEvidence(join(shallow, 'retry-contract.test.ts'), [{ literal: '4', line: 2 }], shallow)).toEqual([{
        literal: '4',
        line: 2,
        blameCommit: null,
        reason: null,
      }]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  it('rejects a classname that only matches the final nested suite segment', () => {
    const source = {
      title: 'case name',
      templateFragments: ['case name'],
      suite: ['Outer', 'Inner'],
      body: undefined,
      line: 1,
      assertions: [],
    };
    const row = {
      file: 'test/example.test.ts',
      classname: 'Inner',
      name: 'case name',
      suitePath: ['Outer', 'Inner'],
      line: 1,
      seconds: 0,
      attempts: [],
      result: 'passed',
    } as Parameters<typeof caseFor>[0];

    expect(caseFor(row, [source])).toBeUndefined();
  });

  it('keeps absolute JUnit paths inside the selected source root', () => {
    expect(sourcePathFor('/snapshot/repo/test/example.test.ts', '/snapshot/repo')).toBe('/snapshot/repo/test/example.test.ts');
    expect(sourcePathFor('/other/repo/test/example.test.ts', '/snapshot/repo')).toBeUndefined();
  });
});
