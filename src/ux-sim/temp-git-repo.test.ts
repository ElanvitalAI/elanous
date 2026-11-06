import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempGitRepo, type TempGitRepo } from './temp-git-repo.js';

const fixtures: TempGitRepo[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });

test('copies an independent committed repo with the requested branch and ordered commits', () => {
  const first = createTempGitRepo({ branch: 'topic/one', files: { 'src/one.ts': 'one\n' }, commits: [
    { message: 'second', files: { 'src/two.ts': 'two\n' } },
  ] });
  fixtures.push(first);
  const second = createTempGitRepo({ branch: 'topic/two', files: { 'src/other.ts': 'other\n' } });
  fixtures.push(second);
  const firstRoot = first.root;

  expect(first.git(first.repo, ['branch', '--show-current'])).toBe('topic/one');
  expect(first.git(first.repo, ['log', '-2', '--format=%s']).split('\n')).toEqual(['second', 'fixture files']);
  expect(readFileSync(join(first.repo, 'src/one.ts'), 'utf8')).toBe('one\n');
  expect(readFileSync(join(first.repo, 'src/two.ts'), 'utf8')).toBe('two\n');
  expect(existsSync(join(first.repo, 'src/other.ts'))).toBe(false);
  expect(second.git(second.repo, ['branch', '--show-current'])).toBe('topic/two');
  expect(second.git(second.repo, ['log', '-1', '--format=%s'])).toBe('fixture files');
  expect(existsSync(join(second.repo, 'src/one.ts'))).toBe(false);
  expect(first.remote).not.toBe(second.remote);
  expect(first.git(first.repo, ['remote', 'get-url', 'origin'])).toBe(first.remote);
  first.git(first.repo, ['push', 'origin', 'topic/one']);
  expect(() => second.git(second.remote, ['show-ref', '--verify', 'refs/heads/topic/one'])).toThrow();
  first.cleanup();
  first.cleanup();
  expect(existsSync(firstRoot)).toBe(false);
});

test('removes a partially created fixture when an input file escapes the repository', () => {
  const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('ux-sim-git-repo-')));
  expect(() => createTempGitRepo({ files: { '../outside.txt': 'outside\n' } })).toThrow('must stay relative');
  const after = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('ux-sim-git-repo-')));
  expect(after).toEqual(before);
});
