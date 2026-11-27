// THROUGHPUT-REPO (11-27 P0) — the installed controller resolved `repoRoot()` to the package dir (not a git repo) and
// could count neither lands/h nor open PRs. Independent literals; a real temp git repo for the positive case.
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDevRepoRoot } from './throughput-controller-live.js';

const root = mkdtempSync(join(tmpdir(), 'tp-repo-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });

describe('resolveDevRepoRoot', () => {
  test('installed package dir (no git) is skipped; the seat repo ~/elanous-hq/repo.git is found (a real repo with origin/main)', () => {
    const home = join(root, 'home'); const repo = join(home, 'elanous-hq', 'repo.git'); const pkg = join(root, 'pkg', 'node_modules', 'elanous');
    mkdirSync(repo, { recursive: true }); mkdirSync(pkg, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x (#1)');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(resolveDevRepoRoot({ env: {}, configPath: () => undefined, codeRoot: () => pkg, home })).toBe(repo);
  });
  test('order: ELANOUS_REPO → config repo.path → code root → ~/elanous-hq/repo.git; «~» expands', () => {
    const ok = new Set(['/env/repo', '/cfg/repo', '/code', '/h/elanous-hq/repo.git', '/h/dev/repo']);
    const isRepo = (p: string) => ok.has(p);
    expect(resolveDevRepoRoot({ env: { ELANOUS_REPO: '/env/repo' }, configPath: () => '/cfg/repo', codeRoot: () => '/code', home: '/h', isRepo })).toBe('/env/repo');
    expect(resolveDevRepoRoot({ env: {}, configPath: () => '/cfg/repo', codeRoot: () => '/code', home: '/h', isRepo })).toBe('/cfg/repo');
    expect(resolveDevRepoRoot({ env: {}, configPath: () => '~/dev/repo', codeRoot: () => '/code', home: '/h', isRepo })).toBe('/h/dev/repo');
    expect(resolveDevRepoRoot({ env: { ELANOUS_REPO: '/not/a/repo' }, configPath: () => { throw new Error('bad config'); }, codeRoot: () => '/code', home: '/h', isRepo })).toBe('/code');
  });
  test('no candidate is a repo → null (the snapshot marks lands «unmeasured», never 0)', () => {
    expect(resolveDevRepoRoot({ env: {}, configPath: () => undefined, codeRoot: () => join(root, 'nope'), home: join(root, 'nohome') })).toBe(null);
  });
});
