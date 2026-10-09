import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireL8MergeQueue, enqueueL8ShadowQueue, evaluateL8Integration, runL8MergeQueue, runL8ShadowQueue, statusL8ShadowQueue, type L8MergeQueueDeps } from './l8-merge-queue.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function fixture(otherConflict = false, changeTest = true) {
  const root = mkdtempSync(join(tmpdir(), 'l8-queue-test-'));
  roots.push(root);
  const remote = join(root, 'remote');
  const cwd = join(root, 'checkout');
  mkdirSync(remote);
  git(remote, 'init', '-q', '-b', 'main');
  git(remote, 'config', 'user.name', 'test');
  git(remote, 'config', 'user.email', 'test@localhost');
  git(remote, 'config', 'receive.denyCurrentBranch', 'ignore');
  mkdirSync(join(remote, 'release'));
  const base = '# Next\n\n## Feat\n\n- old\n';
  writeFileSync(join(remote, 'release/next.md'), base);
  writeFileSync(join(remote, 'src.test.ts'), 'test("old", () => {});\n');
  writeFileSync(join(remote, 'other.ts'), 'export const x = 0;\n');
  writeFileSync(join(remote, 'bun.lock'), 'fixture lockfile');
  git(remote, 'add', 'release/next.md', 'src.test.ts', 'other.ts', 'bun.lock');
  git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'base');
  git(remote, 'checkout', '-qb', 'feature');
  writeFileSync(join(remote, 'release/next.md'), base.replace('- old\n', '- old\n- feature\n'));
  if (changeTest) writeFileSync(join(remote, 'src.test.ts'), 'test("new", () => {});\n');
  if (otherConflict) writeFileSync(join(remote, 'other.ts'), 'export const x = 2;\n');
  git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'feature');
  const head = git(remote, 'rev-parse', 'HEAD');
  git(remote, 'update-ref', 'refs/pull/7/head', head);
  git(remote, 'checkout', '-q', 'main');
  writeFileSync(join(remote, 'release/next.md'), base.replace('- old\n', '- old\n- main\n'));
  if (otherConflict) writeFileSync(join(remote, 'other.ts'), 'export const x = 1;\n');
  git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'main advanced');
  git(root, 'clone', '-q', remote, cwd);
  mkdirSync(join(cwd, 'node_modules'));
  mkdirSync(join(cwd, 'node_modules', 'typescript'));
  writeFileSync(join(cwd, 'node_modules', 'typescript', 'package.json'), '{}');
  return { remote, cwd, head };
}
function deps(remote: string, opts: { failTest?: boolean; failInstall?: boolean; onInstall?: (cwd: string) => void; onTest?: () => void; beforePush?: () => void; afterPush?: () => void } = {}) {
  const calls: string[][] = [];
  const pushes: string[] = [];
  const initialMain = git(remote, 'rev-parse', 'main');
  const injected: L8MergeQueueDeps = {
    acquire: async () => () => {},
    command: (bin, args, cwd) => {
      if (bin === 'gh' && args[1] === 'view') {
        const main = git(remote, 'rev-parse', 'main');
        const head = git(remote, 'rev-parse', 'feature');
        const merged = main !== initialMain && spawnSync('git', ['merge-base', '--is-ancestor', head, main], { cwd: remote }).status === 0;
        return { status: 0, stdout: JSON.stringify({ headRefOid: head, headRefName: 'feature', baseRefName: 'main', state: merged ? 'MERGED' : 'OPEN', isDraft: false, isCrossRepository: false, mergeCommit: merged ? { oid: main } : null }), stderr: '' };
      }
      if (bin === 'bun' && args[0] === 'install') {
        calls.push([...args]); opts.onInstall?.(cwd);
        if (opts.failInstall) return { status: 1, stdout: '', stderr: 'lockfile install failed' };
        mkdirSync(join(cwd, 'node_modules'), { recursive: true });
        return { status: 0, stdout: 'installed from candidate lockfile', stderr: '' };
      }
      if (bin === 'bun' && args[0] === 'test') {
        calls.push([...args]); opts.onTest?.();
        return { status: opts.failTest ? 1 : 0, stdout: opts.failTest ? '0 pass\n1 fail\nRan 1 test across 1 file' : '1 pass\n0 fail\nRan 1 test across 1 file', stderr: '' };
      }
      if (bin === 'git' && args[0] === 'push') { opts.beforePush?.(); pushes.push(args.filter((a) => a.startsWith('HEAD:')).join(' ')); }
      const r = spawnSync(bin, [...args], { cwd, encoding: 'utf8' });
      if (bin === 'git' && args[0] === 'push' && r.status === 0) opts.afterPush?.();
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  };
  return { injected, calls, pushes };
}

function shadowDeps(remote: string, resolveConflict?: (file: string, conflicted: string, target: string, worktree: string) => Promise<string>, onIntegrated?: (cwd: string) => void) {
  const { injected, calls, pushes } = deps(remote);
  const observed: unknown[] = [];
  const queueDeps = { ...injected, resolveConflict, observe: (verdict: unknown) => { observed.push(verdict); },
    command: (bin: string, args: readonly string[], cwd: string) => {
      if (bin === 'bun' && args[0] === 'run' && args[1] === 'test:deterministic') {
        calls.push([...args]);
        onIntegrated?.(cwd);
        return { status: 0, stdout: '1 pass\n0 fail\nRan 1 test across 1 file', stderr: '' };
      }
      return injected.command!(bin, args, cwd);
    },
  };
  return { queueDeps, calls, pushes, observed };
}

test('shadow queue uses context resolution for ordinary conflicts and preserves next.md additions', async () => {
  const { cwd, remote, head } = fixture(true);
  const main = git(remote, 'rev-parse', 'main');
  const seen: string[] = [];
  const { queueDeps, calls, pushes, observed } = shadowDeps(remote, async (file, conflicted, target, worktree) => {
    seen.push(file);
    expect(target).toBe(head);
    expect(worktree).not.toBe(cwd);
    expect(conflicted).toContain('<<<<<<<');
    return 'export const x = 3; // feature and main\n';
  }, (path) => {
    expect(readFileSync(join(path, 'other.ts'), 'utf8')).toBe('export const x = 3; // feature and main\n');
    const note = readFileSync(join(path, 'release/next.md'), 'utf8');
    expect(note).toContain('- main');
    expect(note).toContain('- feature');
    expect(git(path, 'diff', '--name-only', '--diff-filter=U')).toBe('');
  });
  await enqueueL8ShadowQueue(cwd, 7, queueDeps);
  const verdict = await runL8ShadowQueue(cwd, queueDeps);
  expect(verdict?.verdict).toBe('pass');
  expect(verdict?.detail).toBe('release/next.md auto-resolved');
  expect(seen).toEqual(['other.ts']);
  expect(calls).toEqual([['install', '--frozen-lockfile'], ['run', 'test:deterministic', 'src.test.ts']]);
  expect(pushes).toEqual([]);
  expect(observed).toHaveLength(1);
  expect(await statusL8ShadowQueue(cwd, queueDeps)).toMatchObject({ pending: [], verdicts: [{ verdict: 'pass' }] });
  expect(git(remote, 'rev-parse', 'main')).toBe(main);
  expect(git(remote, 'rev-parse', 'feature')).toBe(head);
});

test('shadow queue rejects unresolved context without tests, push or changes to remote refs', async () => {
  const { cwd, remote, head } = fixture(true);
  const main = git(remote, 'rev-parse', 'main');
  const { queueDeps, calls, pushes } = shadowDeps(remote, async (_file, conflicted) => conflicted);
  await enqueueL8ShadowQueue(cwd, 7, queueDeps);
  const verdict = await runL8ShadowQueue(cwd, queueDeps);
  expect(verdict?.verdict).toBe('conflict');
  expect(verdict?.detail).toContain('conflict-markers-remain');
  expect(calls).toEqual([]);
  expect(pushes).toEqual([]);
  expect(git(remote, 'rev-parse', 'main')).toBe(main);
  expect(git(remote, 'rev-parse', 'feature')).toBe(head);
});

test('shadow queue treats a resolver exception as a conflict and never runs tests', async () => {
  const { cwd, remote, head } = fixture(true);
  const main = git(remote, 'rev-parse', 'main');
  const { queueDeps, calls, pushes } = shadowDeps(remote, async () => { throw new Error('resolver unavailable'); });
  await enqueueL8ShadowQueue(cwd, 7, queueDeps);
  const verdict = await runL8ShadowQueue(cwd, queueDeps);
  expect(verdict?.verdict).toBe('conflict');
  expect(verdict?.detail).toContain('conflict-resolver-interrupted');
  expect(calls).toEqual([]);
  expect(pushes).toEqual([]);
  expect(git(remote, 'rev-parse', 'main')).toBe(main);
  expect(git(remote, 'rev-parse', 'feature')).toBe(head);
});

test('shadow queue reports a file/directory conflict as conflict without consulting the resolver', async () => {
  const { cwd, remote } = fixture();
  git(remote, 'checkout', '-q', 'feature');
  writeFileSync(join(remote, 'other.ts'), 'export const x = 5;\n');
  git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'feature edits other');
  git(remote, 'update-ref', 'refs/pull/7/head', git(remote, 'rev-parse', 'HEAD'));
  git(remote, 'checkout', '-q', 'main');
  git(remote, 'rm', '-q', 'other.ts');
  mkdirSync(join(remote, 'other.ts'));
  writeFileSync(join(remote, 'other.ts', 'inner.ts'), 'export const y = 1;\n');
  git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'main turns other into a directory');
  const main = git(remote, 'rev-parse', 'main');
  const seen: string[] = [];
  const { queueDeps, calls, pushes } = shadowDeps(remote, async (file) => { seen.push(file); return ''; });
  await enqueueL8ShadowQueue(cwd, 7, queueDeps);
  const verdict = await runL8ShadowQueue(cwd, queueDeps);
  expect(verdict?.verdict).toBe('conflict');
  expect(verdict?.detail).toContain('other.ts');
  expect(seen).toEqual([]);
  expect(calls).toEqual([]);
  expect(pushes).toEqual([]);
  expect(git(remote, 'rev-parse', 'main')).toBe(main);
});

test('shadow queue still resolves next.md alone without invoking the ordinary-file resolver', async () => {
  const { cwd, remote } = fixture();
  const { queueDeps, calls } = shadowDeps(remote, async () => { throw new Error('not an ordinary conflict'); });
  await enqueueL8ShadowQueue(cwd, 7, queueDeps);
  const verdict = await runL8ShadowQueue(cwd, queueDeps);
  expect(verdict?.verdict).toBe('pass');
  expect(verdict?.detail).toBe('release/next.md auto-resolved');
  expect(calls).toEqual([['install', '--frozen-lockfile'], ['run', 'test:deterministic', 'src.test.ts']]);
});

test('a second queue entrant waits for the first PR to release the shared git slot', async () => {
  const { cwd } = fixture();
  const releaseFirst = await acquireL8MergeQueue(cwd);
  let acquiredSecond = false;
  const second = acquireL8MergeQueue(cwd).then((release) => { acquiredSecond = true; release(); });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(acquiredSecond).toBe(false);
  releaseFirst();
  await second;
  expect(acquiredSecond).toBe(true);
});

test('serial candidate on fresh main resolves next.md, runs only changed tests and pins integrated head', async () => {
  const { cwd, remote, head } = fixture();
  const { injected, calls, pushes } = deps(remote);
  const result = await runL8MergeQueue({ number: 7, cwd, matchHeadCommit: head }, injected);
  expect(result.merged).toBe(true);
  expect(calls).toEqual([['install', '--frozen-lockfile'], ['test', 'src.test.ts']]);
  expect(pushes).toHaveLength(1);
  expect(pushes).toEqual(['HEAD:refs/heads/feature HEAD:refs/heads/main']);
  expect(result.mergeCommit).toBe(git(remote, 'rev-parse', 'main'));
  expect(git(remote, 'merge-base', '--is-ancestor', head, 'main')).toBe('');
  const note = git(remote, 'show', 'main:release/next.md');
  expect(note).toContain('- feature');
  expect(note).toContain('- main');
  expect(note.split('- main').length - 1).toBe(1);
  expect(readFileSync(join(cwd, 'release/next.md'), 'utf8')).not.toContain('- feature');
});

test('candidate lockfile dependencies are installed in the disposable checkout despite caller modules', async () => {
  const { cwd, remote } = fixture();
  git(remote, 'checkout', '-q', 'feature');
  writeFileSync(join(remote, 'bun.lock'), 'candidate lockfile');
  git(remote, 'add', 'bun.lock'); git(remote, 'commit', '-qm', 'update candidate dependencies');
  const head = git(remote, 'rev-parse', 'HEAD');
  git(remote, 'update-ref', 'refs/pull/7/head', head);
  let candidatePath = '';
  const { injected, calls, pushes } = deps(remote, { onInstall: (path) => {
    candidatePath = path;
    expect(path).not.toBe(cwd);
    expect(readFileSync(join(path, 'bun.lock'), 'utf8')).toBe('candidate lockfile');
    expect(readFileSync(join(cwd, 'bun.lock'), 'utf8')).toBe('fixture lockfile');
    expect(existsSync(join(path, 'node_modules'))).toBe(false);
  } });
  const result = await runL8MergeQueue({ number: 7, cwd, matchHeadCommit: head }, injected);
  expect(result.merged).toBe(true);
  expect(candidatePath).not.toBe('');
  expect(calls).toEqual([['install', '--frozen-lockfile'], ['test', 'src.test.ts']]);
  expect(pushes).toHaveLength(1);
});

test('failed frozen-lockfile installation refuses to run tests or merge', async () => {
  const { cwd, remote, head } = fixture();
  const { injected, calls, pushes } = deps(remote, { failInstall: true });
  const result = await runL8MergeQueue({ number: 7, cwd, matchHeadCommit: head }, injected);
  expect(result.merged).toBe(false);
  expect(result.detail).toContain('lockfile install failed');
  expect(calls).toEqual([['install', '--frozen-lockfile']]);
  expect(pushes).toEqual([]);
});

test('a PR without changed test files skips bun test rather than running the suite', async () => {
  const { cwd, remote, head } = fixture(false, false);
  const { injected, calls, pushes } = deps(remote);
  const result = await runL8MergeQueue({ number: 7, cwd, matchHeadCommit: head }, injected);
  expect(result.merged).toBe(true);
  expect(calls).toEqual([]);
  expect(pushes).toHaveLength(1);
});

test('a stale pinned PR head cannot enter the queue or change its branch', async () => {
  const { cwd, remote, head } = fixture();
  const { injected, calls, pushes } = deps(remote);
  const stale = '0'.repeat(40);
  const result = await runL8MergeQueue({ number: 7, cwd, matchHeadCommit: stale }, injected);
  expect(result.merged).toBe(false);
  expect(result.detail).toContain('PR head, base, or ready/open state changed');
  expect(calls).toEqual([]);
  expect(pushes).toEqual([]);
  expect(git(remote, 'rev-parse', 'feature')).toBe(head);
});

test('changed test failure leaves the remote PR head untouched', async () => {
  const { cwd, remote, head } = fixture();
  const { injected, pushes } = deps(remote, { failTest: true });
  const result = await runL8MergeQueue({ number: 7, cwd, matchHeadCommit: head }, injected);
  expect(result.merged).toBe(false);
  expect(result.detail).toContain('changed tests failed');
  expect(git(remote, 'rev-parse', 'feature')).toBe(head);
  expect(pushes).toEqual([]);
});

test('non-release conflicts fail closed without pushing or running tests', async () => {
  const { cwd, remote, head } = fixture(true);
  const { injected, calls, pushes } = deps(remote);
  const result = await runL8MergeQueue({ number: 7, cwd, matchHeadCommit: head }, injected);
  expect(result.merged).toBe(false);
  expect(result.detail).toContain('other.ts');
  expect(calls).toEqual([]);
  expect(pushes).toEqual([]);
  expect(git(remote, 'rev-parse', 'feature')).toBe(head);
});

test('Bun test/spec TypeScript and JavaScript changes are the only test paths executed', async () => {
  const { cwd, remote } = fixture(false, false);
  git(remote, 'checkout', '-q', 'feature');
  for (const path of ['a.spec.ts', 'b.test.js', 'c.test.tsx', 'd.spec.jsx']) writeFileSync(join(remote, path), 'test("ok", () => {});\n');
  writeFileSync(join(remote, 'unrelated.ts'), 'export const n = 1;\n');
  git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'more test formats');
  const head = git(remote, 'rev-parse', 'HEAD');
  git(remote, 'update-ref', 'refs/pull/7/head', head);
  const { injected, calls } = deps(remote);
  expect((await runL8MergeQueue({ number: 7, cwd, matchHeadCommit: head }, injected)).merged).toBe(true);
  expect(calls).toEqual([['install', '--frozen-lockfile'], ['test', 'a.spec.ts', 'b.test.js', 'c.test.tsx', 'd.spec.jsx']]);
});

test('deleting a test file does not make it a runnable path', async () => {
  const { cwd, remote } = fixture(false, false);
  git(remote, 'checkout', '-q', 'feature');
  unlinkSync(join(remote, 'src.test.ts'));
  git(remote, 'add', '-u'); git(remote, 'commit', '-qm', 'delete obsolete test');
  const head = git(remote, 'rev-parse', 'HEAD');
  git(remote, 'update-ref', 'refs/pull/7/head', head);
  const { injected, calls } = deps(remote);
  expect((await runL8MergeQueue({ number: 7, cwd, matchHeadCommit: head }, injected)).merged).toBe(true);
  expect(calls).toEqual([]);
});

test('a server-side non-fast-forward rejection prevents merging against main advanced after the last fetch', async () => {
  const { cwd, remote, head } = fixture();
  const { injected, pushes } = deps(remote, { beforePush: () => {
    git(remote, 'checkout', '-q', 'main');
    writeFileSync(join(remote, 'after.txt'), 'new main');
    git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'main moved at push');
  } });
  const result = await runL8MergeQueue({ number: 7, cwd, matchHeadCommit: head }, injected);
  expect(result.merged).toBe(false);
  expect(result.detail).toContain('[rejected]');
  expect(pushes).toEqual(['HEAD:refs/heads/feature HEAD:refs/heads/main']);
  expect(spawnSync('git', ['merge-base', '--is-ancestor', head, 'main'], { cwd: remote }).status).toBe(1);
});

test('PR head advancing between verification and push rejects the atomic push — main never receives the stale head', async () => {
  const { cwd, remote, head } = fixture();
  const mainBefore = git(remote, 'rev-parse', 'main');
  let moved = '';
  const { injected, pushes } = deps(remote, { beforePush: () => {
    git(remote, 'checkout', '-q', 'feature');
    writeFileSync(join(remote, 'late.txt'), 'new feature head');
    git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'feature moved at push');
    moved = git(remote, 'rev-parse', 'HEAD');
    git(remote, 'update-ref', 'refs/pull/7/head', moved);
  } });
  const result = await runL8MergeQueue({ number: 7, cwd, matchHeadCommit: head }, injected);
  expect(result.merged).toBe(false);
  expect(result.detail).toContain('stale info');
  expect(pushes).toEqual(['HEAD:refs/heads/feature HEAD:refs/heads/main']);
  expect(git(remote, 'rev-parse', 'main')).toBe(mainBefore);
  expect(git(remote, 'rev-parse', 'feature')).toBe(moved);
});

test('a push to the PR branch after the atomic merge is a new change and does not undo the tested merge', async () => {
  const { cwd, remote, head } = fixture();
  const { injected } = deps(remote, { afterPush: () => {
    git(remote, 'checkout', '-qf', 'feature');
    writeFileSync(join(remote, 'late.txt'), 'new feature head');
    git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'feature moved after push');
    git(remote, 'update-ref', 'refs/pull/7/head', git(remote, 'rev-parse', 'HEAD'));
  } });
  const result = await runL8MergeQueue({ number: 7, cwd, matchHeadCommit: head }, injected);
  expect(result.merged).toBe(true);
  expect(git(remote, 'rev-parse', 'main')).toBe(result.mergeCommit!);
  expect(spawnSync('git', ['merge-base', '--is-ancestor', head, 'main'], { cwd: remote }).status).toBe(0);
});

test('non-landing evaluation reports next.md-only feasibility and changed-test results without pushing', async () => {
  const { cwd, remote, head } = fixture();
  const mainBefore = git(remote, 'rev-parse', 'main');
  const featureBefore = git(remote, 'rev-parse', 'feature');
  const { injected, calls, pushes } = deps(remote);
  const report = await evaluateL8Integration({ number: 7, cwd, matchHeadCommit: head }, injected);
  expect(report.feasible).toBe(true);
  expect(report.conflictingFiles).toEqual(['release/next.md']);
  expect(report.conflictsLimitedToNextMd).toBe(true);
  expect(report.changedTests).toEqual([{ file: 'src.test.ts', passed: true, pass: 1, fail: 0 }]);
  expect(calls).toEqual([['install', '--frozen-lockfile'], ['test', 'src.test.ts']]);
  expect(pushes).toEqual([]);
  expect(git(remote, 'rev-parse', 'main')).toBe(mainBefore);
  expect(git(remote, 'rev-parse', 'feature')).toBe(featureBefore);
  expect(readFileSync(join(cwd, 'release/next.md'), 'utf8')).not.toContain('- feature');
});

test('non-landing evaluation reports non-next.md conflicts and does not run tests or push', async () => {
  const { cwd, remote, head } = fixture(true);
  const { injected, calls, pushes } = deps(remote);
  const report = await evaluateL8Integration({ number: 7, cwd, matchHeadCommit: head }, injected);
  expect(report.feasible).toBe(false);
  expect(report.conflictingFiles).toEqual(['other.ts', 'release/next.md']);
  expect(report.conflictsLimitedToNextMd).toBe(false);
  expect(report.changedTests).toEqual([]);
  expect(report.detail).toContain('other.ts');
  expect(calls).toEqual([]);
  expect(pushes).toEqual([]);
  expect(git(remote, 'rev-parse', 'feature')).toBe(head);
});

test('non-landing evaluation records a failed changed test and leaves both refs unmoved', async () => {
  const { cwd, remote, head } = fixture();
  const mainBefore = git(remote, 'rev-parse', 'main');
  const { injected, pushes } = deps(remote, { failTest: true });
  const report = await evaluateL8Integration({ number: 7, cwd, matchHeadCommit: head }, injected);
  expect(report.feasible).toBe(false);
  expect(report.conflictsLimitedToNextMd).toBe(true);
  expect(report.changedTests).toEqual([{ file: 'src.test.ts', passed: false, pass: 0, fail: 1, detail: '0 pass\n1 fail\nRan 1 test across 1 file\n' }]);
  expect(report.detail).toBe('changed tests failed');
  expect(pushes).toEqual([]);
  expect(git(remote, 'rev-parse', 'main')).toBe(mainBefore);
  expect(git(remote, 'rev-parse', 'feature')).toBe(head);
});

test('main advancing during changed tests prevents the stale candidate from being pushed', async () => {
  const { cwd, remote, head } = fixture();
  const { injected, pushes } = deps(remote, { onTest: () => {
    writeFileSync(join(remote, 'after.txt'), 'new main');
    git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'main moved');
  } });
  const result = await runL8MergeQueue({ number: 7, cwd, matchHeadCommit: head }, injected);
  expect(result.merged).toBe(false);
  expect(result.detail).toContain('main advanced');
  expect(pushes).toEqual([]);
  expect(git(remote, 'rev-parse', 'feature')).toBe(head);
});
