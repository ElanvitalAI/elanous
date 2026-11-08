import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cutReleaseBranch } from './cut-branch.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cut-branch-test-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  // Test-fixture isolation: a pod may install a global core.hooksPath pre-push guard that
  // refuses pushes to refs/heads/main and release/* branches. Point the fixture repo (and
  // its worktrees, which share this config) at a hooks directory that never exists so the
  // bare-remote pushes below run hookless. Scoped to this temp repo only.
  git(repo, 'config', 'core.hooksPath', join(root, 'no-hooks'));
  git(repo, 'remote', 'add', 'origin', remote);
  const commit = (name: string, content: string) => {
    writeFileSync(join(repo, name), content);
    git(repo, 'add', name);
    git(repo, 'commit', '-q', '-m', name);
    return git(repo, 'rev-parse', 'HEAD');
  };
  commit('package.json', '{"version":"0.2.4"}\n');
  const base = git(repo, 'rev-parse', 'HEAD');
  const pick = commit('repair.txt', 'fixed\n');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return { root, repo, git, commit, base, pick };
}

test('dry-run prints the ordered plan and leaves no release branch', () => {
  const f = fixture();
  const lines: string[] = [];
  const result = cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [f.pick], dryRun: true, repoRoot: f.repo, log: (line) => lines.push(line) });
  expect(result).toEqual({ branch: 'release/0.2.4', commit: null, dryRun: true });
  expect(lines[0]).toContain(`${f.base} + ${f.pick}`);
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.4')).toBe('');
});

test('picked fixes are cherry-picked in order and pushed; resulting SHA can be used as the cut', () => {
  const f = fixture();
  const second = f.commit('repair-two.txt', 'fixed again\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  const result = cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [f.pick, second], repoRoot: f.repo, log: () => {} });
  expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
  const commit = result.commit!;
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.4').split('\t')[0]).toBe(commit);
  expect(f.git(f.repo, 'show', `${commit}:repair.txt`)).toBe('fixed');
  expect(f.git(f.repo, 'show', `${commit}:repair-two.txt`)).toBe('fixed again');
  expect(f.git(f.repo, 'rev-parse', 'origin/main')).toBe(second);
});

test('a freshly cloned checkout can select the pushed release tip absent from its local objects', () => {
  const f = fixture();
  const branch = cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [f.pick], repoRoot: f.repo, log: () => {} });
  const clone = join(f.root, 'fresh');
  f.git(f.root, 'clone', '-q', '--single-branch', '--branch', 'main', join(f.root, 'remote.git'), clone);
  const selected = spawnSync(process.execPath, [resolve(import.meta.dir, 'version-node.ts'), 'release', '--version', '0.2.4', '--cut-commit', branch.commit!, '--json'], {
    cwd: clone, encoding: 'utf8', env: { ...process.env, ELANOUS_GRAPH_CONTEXT: '' },
  });
  expect(selected.status).toBe(0);
  expect(JSON.parse(selected.stdout.trim().split('\n').at(-1)!)).toMatchObject({ outcome: 'ok', commit: branch.commit, pr: null });
  expect(f.git(clone, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.4').split('\t')[0]).toBe(branch.commit!);
});

test('a pick not on origin/main is refused before branch creation', () => {
  const f = fixture();
  f.git(f.repo, 'checkout', '-q', '-b', 'unmerged');
  const stray = f.commit('stray.txt', 'not on main\n');
  expect(() => cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [stray], repoRoot: f.repo, log: () => {} })).toThrow('not an ancestor of origin/main');
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.4')).toBe('');
});

test('existing remote branch is refused without changing its tip and names --append', () => {
  const f = fixture();
  const existing = cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [f.pick], repoRoot: f.repo, log: () => {} });
  expect(() => cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [f.pick], repoRoot: f.repo, log: () => {} })).toThrow('--append');
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.4').split('\t')[0]).toBe(existing.commit!);
});

test('--append dry-run suggests up to two main commits defining imports from its conflict hunk without moving the release tip', () => {
  const f = fixture();
  mkdirSync(join(f.repo, 'src/cli'), { recursive: true });
  writeFileSync(join(f.repo, 'src/cli/helpers.ts'), "export * from './internal.js';\nexport { aliasTarget as dependencyAlias } from './internal.js';\nexport type * from './types.js';\nconst helperA = 1,\n  legacyHelper = () => {};\nlet optionalHelper;\nexport{ legacyHelper, optionalHelper };\ntype LocalType = { value: string };\nexport type { LocalType };\nimport { existingAlias as localAlias } from './internal.js';\nexport { localAlias as importedAlias };\nimport defaultHelper from './internal.js';\nexport { defaultHelper as defaultAlias };\n");
  writeFileSync(join(f.repo, 'src/cli/internal.ts'), 'export function oldHelper() {}\nexport function existingAlias() {}\nexport default function defaultHelper() {}\n');
  writeFileSync(join(f.repo, 'src/cli/types.ts'), 'export interface SharedType { value: string }\n');
  writeFileSync(join(f.repo, 'src/cli/release-cli.ts'), "import {\n  oldHelper,\n} from './helpers.js';\n");
  f.git(f.repo, 'add', 'src/cli/helpers.ts', 'src/cli/internal.ts', 'src/cli/types.ts', 'src/cli/release-cli.ts');
  f.git(f.repo, 'commit', '-q', '-m', 'add release cli fixture');
  const base = f.git(f.repo, 'rev-parse', 'HEAD');

  f.git(f.repo, 'checkout', '-q', '-b', 'fixture-release');
  writeFileSync(join(f.repo, 'package.json'), '{"version":"9.9.9"}\n');
  writeFileSync(join(f.repo, 'src/cli/release-cli.ts'), "import {\n  releaseOnly,\n} from './helpers.js';\n");
  f.git(f.repo, 'add', 'package.json', 'src/cli/release-cli.ts');
  f.git(f.repo, 'commit', '-q', '-m', 'cut release fixture');
  const releaseTip = f.git(f.repo, 'rev-parse', 'HEAD');
  f.git(f.repo, 'push', '-q', 'origin', `${releaseTip}:refs/heads/release/9.9.9`);

  f.git(f.repo, 'checkout', '-q', 'main');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  mkdirSync(join(f.repo, 'src/cli'), { recursive: true });
  writeFileSync(join(f.repo, 'src/cli/other.ts'), 'export function unrelatedMissing() {}\nexport function depA() {}\n');
  writeFileSync(join(f.repo, 'src/cli/release-cli.ts'), "import {\n  oldHelper,\n} from './helpers.js';\nimport { unrelatedMissing } from './other.js';\nimport { depA } from './other.js';\n");
  f.git(f.repo, 'add', 'src/cli/other.ts', 'src/cli/release-cli.ts');
  f.git(f.repo, 'commit', '-q', '-m', 'add unrelated import outside the future conflict hunk');
  const depA = f.commit('src/cli/internal.ts', 'export function oldHelper() {}\nexport function existingAlias() {}\nexport default function defaultHelper() {}\nexport function aliasTarget() {}\nexport function depA() {}\n');
  const depB = f.commit('src/cli/internal.ts', 'export function oldHelper() {}\nexport function existingAlias() {}\nexport default function defaultHelper() {}\nexport function aliasTarget() {}\nexport function depA() {}\nexport function depB() {}\n');
  f.commit('src/cli/internal.ts', 'export function oldHelper() {}\nexport function existingAlias() {}\nexport default function defaultHelper() {}\nexport function aliasTarget() {}\nexport function depA() {}\nexport function depB() {}\nexport function depC() {}\n');
  const picked = f.commit('src/cli/release-cli.ts', "import {\n  depA,\n  dependencyAlias,\n  importedAlias,\n  defaultAlias,\n  LocalType,\n  SharedType,\n  depB,\n  depC,\n  legacyHelper,\n} from './helpers.js';\nimport { unrelatedMissing } from './other.js';\nimport { depA } from './other.js';\n");
  f.git(f.repo, 'push', '-q', 'origin', 'main');

  const result = cutReleaseBranch({ version: '9.9.9', base, pick: [picked], append: true, dryRun: true, repoRoot: f.repo, log: () => {} });
  expect(result).toMatchObject({ branch: 'release/9.9.9', commit: null, dryRun: true });
  expect(result.dependencyPicks).toEqual([
    { sha: depA, path: 'src/cli/helpers.ts', symbols: ['depA', 'dependencyAlias'] },
    { sha: depB, path: 'src/cli/helpers.ts', symbols: ['depB'] },
  ]);
  expect(result.dependencyPicks).toHaveLength(2);
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/9.9.9').split('\t')[0]).toBe(releaseTip);
  expect(f.git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain('release-cut-append-dry-run-');
  expect(f.git(f.repo, 'show', `${depA}:src/cli/internal.ts`)).toContain('depA');
  expect(result.dependencyPicks?.flatMap((pick) => pick.symbols)).not.toContain('unrelatedMissing');
});

test('--append fast-forwards a new main pick onto release/9.9.9 and refuses a moved tip without force-push', () => {
  const f = fixture();
  writeFileSync(join(f.repo, 'package.json'), '{"version":"9.9.9"}\n');
  f.git(f.repo, 'add', 'package.json');
  f.git(f.repo, 'commit', '-q', '-m', 'bump 9.9.9');
  f.base = f.git(f.repo, 'rev-parse', 'HEAD');
  f.pick = f.commit('repair.txt', 'fixed on 9.9.9\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  f.git(f.repo, 'push', '-q', 'origin', `${f.pick}:refs/heads/release/9.9.9`);
  const existing = f.pick;
  const added = f.commit('repair-three.txt', 'fourth\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  const lines: string[] = [];
  const appended = cutReleaseBranch({ version: '9.9.9', base: f.base, pick: [added], append: true, repoRoot: f.repo, log: (line) => lines.push(line) });
  expect(appended.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(appended.commit).not.toBe(existing);
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/9.9.9').split('\t')[0]).toBe(appended.commit!);
  expect(f.git(f.repo, 'merge-base', '--is-ancestor', existing, appended.commit!)).toBe('');
  expect(f.git(f.repo, 'show', `${appended.commit}:repair-three.txt`)).toBe('fourth');
  expect(lines[0]).toContain('(append)');
  const sneak = f.commit('sneak.txt', 'moved\n');
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const bin = join(f.root, 'bin-append');
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = push ]; then
  "${realGit}" --git-dir="${join(f.root, 'remote.git')}" update-ref refs/heads/release/9.9.9 "${sneak}" || exit $?
fi
exec "${realGit}" "$@"
`);
  // The sneak is already the advertised tip. Move it again only when push runs, after fetch has pinned the lease.
  chmodSync(wrapper, 0o755);
  const next = f.commit('repair-four.txt', 'later\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  const oldPath = process.env.PATH;
  let refused: unknown;
  try {
    process.env.PATH = `${bin}:${oldPath}`;
    try { cutReleaseBranch({ version: '9.9.9', base: f.base, pick: [next], append: true, repoRoot: f.repo, log: () => {} }); }
    catch (error) { refused = error; }
  } finally {
    process.env.PATH = oldPath;
  }
  expect(refused).toBeInstanceOf(Error);
  expect((refused as Error).message).toMatch(/fast-forward refused|stale info/);
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/9.9.9').split('\t')[0]).toBe(sneak);
  expect(sneak).not.toBe(appended.commit);
  expect(f.git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain('release-cut-branch-');
});

// PR-HEAD-FETCH-STATELESS: a release branch force-moved on origin (non-fast-forward for the local
// tracking ref) must still be fetched with «+» and then pinned by the advertised-SHA check.
test('--append fetches a force-moved remote release tip instead of failing on a non-fast-forward tracking ref', () => {
  const f = fixture();
  writeFileSync(join(f.repo, 'package.json'), '{"version":"9.9.9"}\n');
  f.git(f.repo, 'add', 'package.json');
  f.git(f.repo, 'commit', '-q', '-m', 'bump 9.9.9');
  f.base = f.git(f.repo, 'rev-parse', 'HEAD');
  f.pick = f.commit('repair.txt', 'fixed on 9.9.9\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  f.git(f.repo, 'push', '-q', 'origin', `${f.pick}:refs/heads/release/9.9.9`);
  // A single-branch clone: the configured (forced) refspec covers main only, so git's opportunistic
  // remote-tracking update does not rescue the explicit release refspec — only its own «+» does.
  f.git(f.repo, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  f.git(f.repo, 'fetch', '-q', 'origin', 'refs/heads/release/9.9.9:refs/remotes/origin/release/9.9.9');
  f.git(f.repo, 'checkout', '-q', '--detach', f.base);
  const moved = f.commit('side.txt', 'force-moved release tip\n');
  f.git(f.repo, 'checkout', '-q', 'main');
  f.git(f.repo, 'push', '-q', '--force', 'origin', `${moved}:refs/heads/release/9.9.9`);
  expect(spawnSync('git', ['merge-base', '--is-ancestor', f.pick, moved], { cwd: f.repo }).status).toBe(1);
  const added = f.commit('repair-three.txt', 'fourth\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  const appended = cutReleaseBranch({ version: '9.9.9', base: f.base, pick: [added], append: true, repoRoot: f.repo, log: () => {} });
  expect(f.git(f.repo, 'rev-parse', 'refs/remotes/origin/release/9.9.9')).not.toBe(f.pick);
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/9.9.9').split('\t')[0]).toBe(appended.commit!);
  expect(f.git(f.repo, 'merge-base', '--is-ancestor', moved, appended.commit!)).toBe('');
});

test('--append refuses a pick already on the release branch and a missing branch', () => {
  const f = fixture();
  writeFileSync(join(f.repo, 'package.json'), '{"version":"9.9.9"}\n');
  f.git(f.repo, 'add', 'package.json');
  f.git(f.repo, 'commit', '-q', '-m', 'bump 9.9.9');
  f.base = f.git(f.repo, 'rev-parse', 'HEAD');
  f.pick = f.commit('repair.txt', 'fixed on 9.9.9\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  expect(() => cutReleaseBranch({ version: '9.9.9', base: f.base, pick: [f.pick], append: true, repoRoot: f.repo, log: () => {} })).toThrow('does not exist on origin');
  f.git(f.repo, 'push', '-q', 'origin', `HEAD:refs/heads/release/9.9.9`);
  expect(() => cutReleaseBranch({ version: '9.9.9', base: f.base, pick: [f.pick], append: true, repoRoot: f.repo, log: () => {} })).toThrow('already in release/9.9.9');
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/9.9.9').split('\t')[0]).toBe(f.pick);
});

test('a remote branch created after the absence check is refused and its tip preserved', () => {
  const f = fixture();
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = push ]; then
  "${realGit}" --git-dir="${join(f.root, 'remote.git')}" update-ref refs/heads/release/0.2.4 "${f.base}" || exit $?
fi
exec "${realGit}" "$@"
`);
  chmodSync(wrapper, 0o755);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${oldPath}`;
    expect(() => cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [f.pick], repoRoot: f.repo, log: () => {} })).toThrow('git push failed');
  } finally {
    process.env.PATH = oldPath;
  }
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.4').split('\t')[0]).toBe(f.base);
  expect(f.git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain('release-cut-branch-');
});

test('a competing remote branch created at the same tip is refused and preserved', () => {
  const f = fixture();
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = push ]; then
  for arg do :; done
  sha="\${arg%%:*}"
  printf '%s' "$sha" > "${join(f.root, 'competing-tip')}"
  # A real push carries the cherry-picked object; update-ref alone fails once the pick lands in a new second (new SHA).
  "${realGit}" push -q "${join(f.root, 'remote.git')}" "$sha:refs/heads/release/0.2.4" || exit $?
  output=$("${realGit}" "$@" 2>&1)
  rc=$?
  printf '%s\n' "$output" > "${join(f.root, 'push-result')}"
  printf '%s\n' "$output"
  exit "$rc"
fi
exec "${realGit}" "$@"
`);
  chmodSync(wrapper, 0o755);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${oldPath}`;
    expect(() => cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [f.pick], repoRoot: f.repo, log: () => {} })).toThrow('already exists on origin');
  } finally {
    process.env.PATH = oldPath;
  }
  const tip = f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.4').split('\t')[0];
  expect(tip).toBe(readFileSync(join(f.root, 'competing-tip'), 'utf8'));
  expect(readFileSync(join(f.root, 'push-result'), 'utf8')).toContain('up to date');
  expect(f.git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain('release-cut-branch-');
});

test('cherry-pick conflict names the file, stops and leaves no branch', () => {
  const f = fixture();
  f.commit('repair.txt', 'changed by main\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  // A main-ancestor base can still conflict when a later main commit is picked before an earlier one.
  const first = f.commit('repair.txt', 'first\n');
  const second = f.commit('repair.txt', 'second\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  expect(() => cutReleaseBranch({ version: '0.2.4', base: f.base, pick: [second, first], repoRoot: f.repo, log: () => {} })).toThrow('손으로 풀 곳: repair.txt');
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.4')).toBe('');
  expect(f.git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain('release-cut-branch-');
  expect(f.git(f.repo, 'status', '--porcelain')).toBe('');
  expect(readFileSync(join(f.repo, 'package.json'), 'utf8')).toContain('0.2.4');
});

/** RELEASE-APPEND-BASE-AUTO fixture: the cut commit (9.9.9 bump) lives only on the release branch — its parent is the main cut. */
function appendFixture() {
  const f = fixture();
  f.git(f.repo, 'checkout', '-q', '--detach');
  writeFileSync(join(f.repo, 'package.json'), '{"version":"9.9.9"}\n');
  f.git(f.repo, 'add', 'package.json');
  f.git(f.repo, 'commit', '-q', '-m', 'bump 9.9.9');
  const cut = f.git(f.repo, 'rev-parse', 'HEAD');
  const mainCut = f.pick;
  return { f, cut, mainCut };
}

test('RELEASE-APPEND-BASE-AUTO: --append resolves the main cut from the release tip first parent when --base is omitted', () => {
  const { f, cut, mainCut } = appendFixture();
  f.git(f.repo, 'push', '-q', 'origin', `${cut}:refs/heads/release/9.9.9`);
  f.git(f.repo, 'checkout', '-q', 'main');
  const added = f.commit('repair-three.txt', 'fourth\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  const lines: string[] = [];
  const appended = cutReleaseBranch({ version: '9.9.9', pick: [added], append: true, repoRoot: f.repo, log: (line) => lines.push(line) });
  expect(appended.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/9.9.9').split('\t')[0]).toBe(appended.commit!);
  expect(f.git(f.repo, 'merge-base', '--is-ancestor', cut, appended.commit!)).toBe('');
  expect(f.git(f.repo, 'merge-base', '--is-ancestor', mainCut, appended.commit!)).toBe('');
  expect(f.git(f.repo, 'show', `${appended.commit}:repair-three.txt`)).toBe('fourth');
  expect(lines[0]).toContain(`· base ${mainCut}`);
  expect(f.git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain('release-cut-branch-');
}, 120_000);

test('RELEASE-APPEND-BASE-AUTO: a cut commit as --base auto-corrects to its first parent with a 그 부모 notice', () => {
  const { f, cut, mainCut } = appendFixture();
  f.git(f.repo, 'push', '-q', 'origin', `${cut}:refs/heads/release/9.9.9`);
  f.git(f.repo, 'checkout', '-q', 'main');
  const added = f.commit('repair-three.txt', 'fourth\n');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  const lines: string[] = [];
  const appended = cutReleaseBranch({ version: '9.9.9', base: cut, pick: [added], append: true, repoRoot: f.repo, log: (line) => lines.push(line) });
  expect(appended.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(lines[0]).toContain(`그 부모 ${mainCut} 를 쓰라`);
  expect(lines[1]).toContain(`· base ${mainCut}`);
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/9.9.9').split('\t')[0]).toBe(appended.commit!);
}, 120_000);

test('RELEASE-APPEND-BASE-AUTO: --append with no ledger and no main-ancestor parent keeps the verbatim refusal', () => {
  const { f, cut } = appendFixture();
  f.git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'extra on branch');
  const tip = f.git(f.repo, 'rev-parse', 'HEAD');
  f.git(f.repo, 'push', '-q', 'origin', `${tip}:refs/heads/release/9.9.9`);
  f.git(f.repo, 'checkout', '-q', 'main');
  expect(() => cutReleaseBranch({ version: '9.9.9', pick: [f.pick], append: true, repoRoot: f.repo, log: () => {} }))
    .toThrow(`base ${cut} is not an ancestor of origin/main`);
}, 120_000);

test('RELEASE-APPEND-BASE-AUTO: --append uses the run ledger version-release record when --base is omitted', () => {
  const { f, cut, mainCut } = appendFixture();
  f.git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'extra on branch');
  const tip = f.git(f.repo, 'rev-parse', 'HEAD');
  f.git(f.repo, 'push', '-q', 'origin', `${tip}:refs/heads/release/9.9.9`);
  f.git(f.repo, 'checkout', '-q', 'main');
  const added = f.commit('repair-four.txt', 'fifth');
  f.git(f.repo, 'push', '-q', 'origin', 'main');
  const lines: string[] = [];
  const appended = cutReleaseBranch({
    version: '9.9.9', pick: [added], append: true, repoRoot: f.repo, log: (line) => lines.push(line),
    ledger: () => ({ commit: cut, branch: 'release/9.9.9' }),
  });
  expect(appended.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(lines[0]).toContain(`· base ${mainCut}`);
  expect(f.git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/9.9.9').split('\t')[0]).toBe(appended.commit!);
  expect(f.git(f.repo, 'merge-base', '--is-ancestor', mainCut, appended.commit!)).toBe('');
  expect(f.git(f.repo, 'show', `${appended.commit}:repair-four.txt`)).toBe('fifth');
  expect(f.git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain('release-cut-branch-');
}, 120_000);
