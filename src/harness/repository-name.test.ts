import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { resolveRepositoryName } from './repository-name.js';

const ghArgs = ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'];

describe('resolveRepositoryName', () => {
  test('--repo wins over harness.repo and GH_REPO without invoking gh', () => {
    let calls = 0;
    expect(resolveRepositoryName({ repo: '  flag/repo  ', config: { harness: { repo: 'config/repo' } },
      env: { GH_REPO: 'env/repo' }, cwd: '/nonexistent', executeGh: () => { calls++; return 'gh/repo'; } })).toBe('flag/repo');
    expect(calls).toBe(0);
  });

  test('harness.repo wins over GH_REPO without invoking gh', () => {
    let calls = 0;
    expect(resolveRepositoryName({ config: { harness: { repo: 'config/repo' } }, env: { GH_REPO: 'env/repo' },
      cwd: '/nonexistent', executeGh: () => { calls++; return 'gh/repo'; } })).toBe('config/repo');
    expect(calls).toBe(0);
  });

  test('GH_REPO works without git and blanks fall through to the next source', () => {
    let calls = 0;
    expect(resolveRepositoryName({ repo: ' ', config: { harness: { repo: '' } }, env: { GH_REPO: ' env/repo ' },
      cwd: '/nonexistent', executeGh: () => { calls++; return 'gh/repo'; } })).toBe('env/repo');
    expect(calls).toBe(0);
  });

  test('only a git cwd can fall back to gh repo view', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-repository-'));
    const git = join(root, 'checkout');
    const fake = join(root, 'fake');
    mkdirSync(git);
    mkdirSync(join(fake, '.git'), { recursive: true });
    execFileSync('git', ['init', '-q', git]);
    mkdirSync(join(git, 'nested'));
    const calls: string[][] = [];
    const options = { config: { harness: {} }, env: {}, executeGh: (args: string[]) => {
      calls.push(args);
      return '  gh/repo\n';
    } };
    try {
      expect(() => resolveRepositoryName({ ...options, cwd: root })).toThrow('저장소 이름 없음');
      expect(() => resolveRepositoryName({ ...options, cwd: fake })).toThrow('저장소 이름 없음');
      expect(calls).toEqual([]);
      expect(resolveRepositoryName({ ...options, cwd: join(git, 'nested') })).toBe('gh/repo');
      expect(calls).toEqual([ghArgs]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('invalid explicit names do not silently fall back to another repository', () => {
    for (const source of [
      { repo: '../wrong', config: { harness: { repo: 'config/repo' } }, env: { GH_REPO: 'env/repo' }, error: 'invalid --repo' },
      { config: { harness: { repo: 'no-slash' } }, env: { GH_REPO: 'env/repo' }, error: 'invalid harness.repo' },
      { config: { harness: {} }, env: { GH_REPO: 'bad/name/extra' }, error: 'invalid GH_REPO' },
    ]) {
      let calls = 0;
      expect(() => resolveRepositoryName({ ...source, cwd: '/nonexistent', executeGh: () => { calls++; return 'gh/repo'; } }))
        .toThrow(source.error);
      expect(calls).toBe(0);
    }
  });

  test('empty, failed, or invalid gh responses produce an actionable error', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-repository-'));
    execFileSync('git', ['init', '-q', root]);
    try {
      for (const executeGh of [() => '', () => 'not-a-repo']) {
        expect(() => resolveRepositoryName({ config: { harness: {} }, env: {}, cwd: root, executeGh }))
          .toThrow('저장소 이름 없음 — --repo 또는 harness.repo 설정');
      }
      expect(() => resolveRepositoryName({ config: { harness: {} }, env: {}, cwd: root,
        executeGh: () => { throw new Error('gh unavailable\n    at execFileSync'); } })).toThrow('gh unavailable');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
