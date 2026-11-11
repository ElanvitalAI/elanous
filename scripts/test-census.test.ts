import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseFor, numericCandidateEvidence, renderTestCensus, sourcePathFor } from './test-census';
import { createCensusOracleAxisWorld } from '../src/ux-sim/census-oracle-axis-world';

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Census simulation', GIT_AUTHOR_EMAIL: 'census@example.invalid', GIT_COMMITTER_NAME: 'Census simulation', GIT_COMMITTER_EMAIL: 'census@example.invalid' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  return execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('test census source attribution', () => {
  it('reports only declared, asserted oracle axes for uniquely matched JUnit cases in every format', () => {
    const world = createCensusOracleAxisWorld();
    try {
      world.writeSource([
        '// @oracle-axis X2:I1 X3:I4',
        "test('resume preserves terminal and graph state', () => { expect(true).toBe(true); });",
        '// @oracle-axis X4:I5',
        "test('declaration without a verdict', () => { const observed = true; });",
        '// @oracle-axis X4:I5',
        "test('ordinary method is not a verdict', () => { new Date().toISOString(); });",
        '// @oracle-axis X4:I5',
        "test('expect object method is not a verdict', () => { expect.toString(); });",
        '// @oracle-axis X4:I5',
        "test('uncalled helper is not a verdict', () => { const helper = () => expect(true).toBe(true); });",
        '// @oracle-axis X4:I5',
        "test('assert object method is not a verdict', () => { assert.toString(); });",
        '// @oracle-axis X4:I5',
        "test('uncalled object method is not a verdict', () => { const helper = { check() { expect(true).toBe(true); } }; });",
        '// @oracle-axis X4:I5',
        "test('invoked callback is a verdict', () => { [true].forEach(value => expect(value).toBe(true)); });",
        '// @oracle-axis X4:I5',
        "test('empty callback is not a verdict', () => { [].forEach(value => expect(value).toBe(true)); });",
        '// @oracle-axis X4:I5',
        "test('immediate function is a verdict', () => { (() => expect(true).toBe(true))(); });",
        '// @oracle-axis X4:I5',
        "test('failed before verdict', () => { expect(true).toBe(true); });",
        '// @oracle-axis X4:I5',
        '// unrelated comment',
        "test('stale annotation is not coverage', () => { expect(true).toBe(true); });",
        '// @oracle-axis X4:I5',
        '',
        "test('separated annotation is not coverage', () => { expect(true).toBe(true); });",
        '// @oracle-axis X4:I5',
        "test('custom matcher is a verdict', () => { expect(true).toPass(); });",
        '// @oracle-axis X2:I1',
        "test.skip('declared but skipped', () => { expect(true).toBe(true); });",
        "test('unclassified assertion', () => { expect(true).toBe(true); });",
      ].join('\n'));
      const args = [world.gateDir, '--source-root', world.root];
      const json = JSON.parse(renderTestCensus([...args, '--format', 'json'])) as { rows: Array<{ name: string; oracleAxes: string[] | null }> };
      const byName = new Map(json.rows.map((row) => [row.name, row.oracleAxes]));
      expect(byName.get('resume preserves terminal and graph state')).toEqual(['X2:I1', 'X3:I4']);
      expect(byName.get('declaration without a verdict')).toEqual([]);
      expect(byName.get('ordinary method is not a verdict')).toEqual([]);
      expect(byName.get('expect object method is not a verdict')).toEqual([]);
      expect(byName.get('uncalled helper is not a verdict')).toEqual([]);
      expect(byName.get('assert object method is not a verdict')).toEqual([]);
      expect(byName.get('uncalled object method is not a verdict')).toEqual([]);
      expect(byName.get('invoked callback is a verdict')).toEqual(['X4:I5']);
      expect(byName.get('empty callback is not a verdict')).toEqual([]);
      expect(byName.get('immediate function is a verdict')).toEqual(['X4:I5']);
      expect(byName.get('failed before verdict')).toBeNull();
      expect(byName.get('stale annotation is not coverage')).toEqual([]);
      expect(byName.get('separated annotation is not coverage')).toEqual([]);
      expect(byName.get('custom matcher is a verdict')).toEqual(['X4:I5']);
      expect(byName.get('declared but skipped')).toBeNull();
      expect(byName.get('unclassified assertion')).toEqual([]);
      expect(byName.get('unmatched name')).toBeNull();
      expect(byName.get('missing source')).toBeNull();
      const tsv = renderTestCensus([...args, '--format', 'tsv']);
      expect(tsv.split('\n')[1]).toContain('oracleAxes');
      expect(tsv).toContain('X2:I1,X3:I4');
      const markdown = renderTestCensus([...args, '--format', 'markdown']);
      expect(markdown).toContain('판정 오라클 축');
      expect(markdown).toContain('X2:I1, X3:I4');
      expect(markdown).toContain('미확인');
    } finally { world.dispose(); }
  });

  it('rejects a declared axis and invariant pair absent from the RFC mapping', () => {
    const world = createCensusOracleAxisWorld();
    try {
      world.writeSource("// @oracle-axis X4:I2\ntest('resume preserves terminal and graph state', () => { expect(true).toBe(true); });\n");
      expect(() => renderTestCensus([world.gateDir, '--source-root', world.root, '--format', 'json'])).toThrow('invalid oracle axis X4:I2');
    } finally { world.dispose(); }
  });

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

  it('attributes through a symlink alias but leaves a missing source unknown', () => {
    const repo = mkdtempSync(join(tmpdir(), 'test-census-source-real-'));
    const alias = `${repo}-alias`;
    try {
      git(repo, 'init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'quota.test.ts'), 'expect(retries).toBe(4);\n');
      git(repo, 'add', 'quota.test.ts');
      git(repo, 'commit', '-q', '-m', 'Cap retries at four');
      const commit = git(repo, 'rev-parse', 'HEAD').trim();
      symlinkSync(repo, alias, 'dir');
      expect(numericCandidateEvidence(join(alias, 'quota.test.ts'), [{ literal: '4', line: 1 }], realpathSync(repo))).toEqual([
        { literal: '4', line: 1, blameCommit: commit, reason: 'Cap retries at four' },
      ]);
      expect(numericCandidateEvidence(join(alias, 'missing.test.ts'), [{ literal: '4', line: 1 }], repo)).toEqual([
        { literal: '4', line: 1, blameCommit: null, reason: null },
      ]);
    } finally {
      rmSync(alias, { force: true });
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
