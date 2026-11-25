// RAIL30 ③ — where the steward runs `gh pr list` (11-25: rc=1 outside a git cwd → «source-missing:prs» all day).
// Expected values are literals; the filesystem and git are injected.
import { expect, test } from 'bun:test';
import { githubSlug, resolveGhTarget, type GhTargetDeps } from './sources.js';

const deps = (over: Partial<GhTargetDeps> = {}): GhTargetDeps => ({
  codeRoot: '/opt/checkout/elanous',
  exists: (p) => p === '/opt/checkout/elanous/.git' || p === '/srv/release-repo',
  originUrl: (dir) => (dir === '/opt/checkout/elanous' ? 'git@github.com:acme/elanous-agent.git' : dir === '/srv/release-repo' ? 'https://github.com/acme/release.git' : null),
  packageRepoUrl: () => 'git+https://github.com/acme/from-package.git',
  ...over,
});

test('config owner/name → --repo only (no cwd needed)', () => {
  expect(resolveGhTarget('acme/elanous-agent', deps())).toEqual({ args: ['--repo', 'acme/elanous-agent'] });
});

test('config checkout path → cwd there ⊕ --repo from its origin', () => {
  expect(resolveGhTarget('/srv/release-repo', deps())).toEqual({ cwd: '/srv/release-repo', args: ['--repo', 'acme/release'] });
});

test('no config, running from a checkout → its git root as cwd ⊕ --repo from origin', () => {
  expect(resolveGhTarget(undefined, deps({ codeRoot: '/opt/checkout/elanous' }))).toEqual({ cwd: '/opt/checkout/elanous', args: ['--repo', 'acme/elanous-agent'] });
});

test('no config, installed copy (no .git anywhere) → --repo from package.json repository', () => {
  expect(resolveGhTarget(undefined, deps({ codeRoot: '/prefix/current/node_modules/elanous', exists: () => false })))
    .toEqual({ cwd: '/prefix/current/node_modules/elanous', args: ['--repo', 'acme/from-package'] });
});

test('githubSlug reads https · ssh · git+https · rejects others', () => {
  expect(githubSlug('https://github.com/ElanvitalAI/elanous.git')).toBe('ElanvitalAI/elanous');
  expect(githubSlug('git@github.com:ElanvitalAI/elanous.git')).toBe('ElanvitalAI/elanous');
  expect(githubSlug('git+https://github.com/ElanvitalAI/elanous.git')).toBe('ElanvitalAI/elanous');
  expect(githubSlug('https://gitlab.com/a/b.git')).toBeNull();
  expect(githubSlug(null)).toBeNull();
});
