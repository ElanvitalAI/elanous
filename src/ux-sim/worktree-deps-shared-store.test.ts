import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { prepareWorktreeDependencies, linkWorktreeDependencies } from '../git-fs/worktree.js';
import { addHarnessWorktree } from '../harness/harness-worktree-add.js';
import { readWorktreeCreatedAt, seedWorktreeDependencyRepository, snapshotDependencySource } from './worktree-deps-shared-store.js';

const roots: string[] = [];
const originalStoreDir = process.env.ELANOUS_WORKTREE_DEPS_DIR;
const originalStateDir = process.env.ELANOUS_STATE_DIR;
afterEach(() => {
  if (originalStoreDir === undefined) delete process.env.ELANOUS_WORKTREE_DEPS_DIR;
  else process.env.ELANOUS_WORKTREE_DEPS_DIR = originalStoreDir;
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
  for (const root of roots.splice(0)) {
    const pending = [root];
    while (pending.length > 0) {
      const path = pending.pop()!;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        chmodSync(path, stat.mode | 0o700);
        pending.push(...readdirSync(path).map((name) => join(path, name)));
      } else chmodSync(path, stat.mode | 0o600);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('default shared store follows the canonical isolated state root', () => {
  const root = tempRoot();
  const repo = join(root, 'repo');
  const tree = targetTree(root, 'state-root-tree');
  const stateDir = join(root, 'isolated-state');
  mkdirSync(join(repo, 'node_modules', 'fixture-pkg'), { recursive: true });
  writeFileSync(join(repo, 'bun.lock'), 'lock-v1\n');
  writeFileSync(join(tree, 'bun.lock'), 'lock-v1\n');
  writeFileSync(join(repo, 'node_modules', 'fixture-pkg', 'index.js'), 'isolated-source');
  delete process.env.ELANOUS_WORKTREE_DEPS_DIR;
  process.env.ELANOUS_STATE_DIR = stateDir;

  const result = linkWorktreeDependencies(repo, tree);

  const storeRoot = realpathSync(join(elanousStateRoot(), 'worktree-deps'));
  expect(result.linked).toContain('node_modules');
  expect(realpathSync(join(tree, 'node_modules'))).toBe(join(storeRoot,
    createHash('sha256').update(realpathSync(repo)).digest('hex').slice(0, 16), lockHash(), 'node_modules'));
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ux-worktree-deps-shared-'));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function targetTree(root: string, name: string, lock = 'lock-v1\n'): string {
  const target = join(root, name);
  mkdirSync(join(target, 'apps', 'pwa'), { recursive: true });
  writeFileSync(join(target, 'package.json'), '{"name":"worktree-deps-sim","version":"1.0.0"}\n');
  writeFileSync(join(target, 'bun.lock'), lock);
  writeFileSync(join(target, 'apps', 'pwa', 'package.json'), '{"name":"worktree-deps-pwa-sim","version":"1.0.0"}\n');
  writeFileSync(join(target, 'apps', 'pwa', 'bun.lock'), lock);
  return target;
}

function repoHash(repo: string): string {
  return createHash('sha256').update(realpathSync(join(repo, '.git'))).digest('hex').slice(0, 16);
}

function lockHash(lock = 'lock-v1\n'): string {
  return createHash('sha256').update(lock).digest('hex');
}

// Keep this handshake bounded like the fake-bin installer barrier in src/ux-sim/fake-bin.test.ts.
const SIM_FILE_WAIT_TIMEOUT_MS = 5_000;

function waitForFile(path: string, timeoutMs = SIM_FILE_WAIT_TIMEOUT_MS): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (existsSync(path)) { resolve(); return; }
      if (Date.now() - started >= timeoutMs) { reject(new Error(`timed out waiting for ${path}`)); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('same lock reuses one isolated store; changed lock installs independently; source bytes and creation time stay intact', () => {
  const root = tempRoot();
  const repo = join(root, 'repo');
  const store = join(root, 'shared-store');
  const trees = join(root, 'trees');
  mkdirSync(repo, { recursive: true });
  mkdirSync(trees, { recursive: true });
  seedWorktreeDependencyRepository(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'sim');
  git(repo, 'config', 'user.email', 'sim@example.invalid');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'dependency fixture');
  const before = snapshotDependencySource(repo);
  const createdAt = '2026-11-08T00:00:00.000Z';
  process.env.ELANOUS_WORKTREE_DEPS_DIR = store;

  const first = addHarnessWorktree({ repoRoot: repo, branch: 'sim/deps-a', base: 'HEAD', worktreeRoot: trees, createdAt });
  const second = addHarnessWorktree({ repoRoot: repo, branch: 'sim/deps-b', base: 'HEAD', worktreeRoot: trees, createdAt });
  const after = snapshotDependencySource(repo);

  expect(realpathSync(join(first.path, 'node_modules'))).toBe(realpathSync(join(second.path, 'node_modules')));
  expect(realpathSync(join(first.path, 'node_modules'))).not.toBe(realpathSync(join(repo, 'node_modules')));
  expect(lstatSync(join(first.path, 'node_modules', 'fixture-pkg', 'index.js')).mode & 0o222).toBe(0);
  expect(lstatSync(realpathSync(join(first.path, 'node_modules'))).mode & 0o222).toBe(0);
  expect(before.files).toEqual(after.files);
  expect(first.createdAt).toBe(createdAt);
  expect(second.createdAt).toBe(createdAt);
  expect(readWorktreeCreatedAt(first.path)).toBe(createdAt);
  expect(readWorktreeCreatedAt(second.path)).toBe(createdAt);
  let preparationInstallCount = 0;
  const prepare = (path: string): void => prepareWorktreeDependencies(repo, path, {}, {
    sharedDependencyStoreRoot: store,
    installDependencies: () => { preparationInstallCount += 1; return { status: 0 }; },
  });
  prepare(first.path);
  prepare(second.path);
  expect(preparationInstallCount).toBe(0);
  expect(realpathSync(join(first.path, 'node_modules'))).toBe(realpathSync(join(second.path, 'node_modules')));

  const changed = targetTree(root, 'changed-lock-tree', 'lock-v2\n');
  const installs: string[] = [];
  const mismatch = linkWorktreeDependencies(repo, changed, [], { sharedStoreRoot: store });
  expect(mismatch.skippedLockMismatch).toContain('node_modules');
  prepareWorktreeDependencies(repo, changed, { dependencyFallbackRoot: join(root, 'missing-fallback') }, {
    sharedDependencyStoreRoot: store,
    installDependencies: (cwd) => {
      installs.push(cwd);
      mkdirSync(join(cwd, 'node_modules', 'fresh-install'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', 'fresh-install', 'lock.txt'), 'lock-v2\n');
      return { status: 0 };
    },
  });
  expect(installs).toContain(changed);
  expect(lstatSync(join(changed, 'node_modules')).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(changed, 'node_modules', 'fresh-install', 'lock.txt'), 'utf8')).toBe('lock-v2\n');
  expect(snapshotDependencySource(repo).files).toEqual(before.files);
});

test('an aged dependency-store lock with a dead owner is atomically recovered before linking', () => {
  const root = tempRoot();
  const repo = join(root, 'repo');
  const worktree = targetTree(root, 'worktree');
  const store = join(root, 'shared-store');
  mkdirSync(join(repo, 'node_modules', 'fixture-pkg'), { recursive: true });
  writeFileSync(join(repo, 'bun.lock'), 'lock-v1\n');
  writeFileSync(join(repo, 'node_modules', 'fixture-pkg', 'index.js'), 'from-source');
  const scope = createHash('sha256').update(realpathSync(repo)).digest('hex').slice(0, 16);
  const lockDir = join(store, scope, lockHash(), 'node_modules.lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, startedAt: 1 }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockDir, old, old);

  const linked = linkWorktreeDependencies(repo, worktree, [], { sharedStoreRoot: store });

  expect(linked.failed).toEqual([]);
  expect(linked.linked).toContain('node_modules');
  expect(existsSync(lockDir)).toBe(false);
  expect(readFileSync(join(worktree, 'node_modules', 'fixture-pkg', 'index.js'), 'utf8')).toBe('from-source');
  expect(existsSync(join(store, scope, lockHash(), 'node_modules.complete.json'))).toBe(true);
});

test('an aged dependency-store lock without an owner PID is recovered by the age threshold', () => {
  const root = tempRoot();
  const repo = join(root, 'repo');
  const worktree = targetTree(root, 'worktree');
  const store = join(root, 'shared-store');
  mkdirSync(join(repo, 'node_modules', 'fixture-pkg'), { recursive: true });
  writeFileSync(join(repo, 'bun.lock'), 'lock-v1\n');
  writeFileSync(join(repo, 'node_modules', 'fixture-pkg', 'index.js'), 'from-source');
  const scope = createHash('sha256').update(realpathSync(repo)).digest('hex').slice(0, 16);
  const lockDir = join(store, scope, lockHash(), 'node_modules.lock');
  mkdirSync(lockDir, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockDir, old, old);

  const linked = linkWorktreeDependencies(repo, worktree, [], { sharedStoreRoot: store });

  expect(linked.failed).toEqual([]);
  expect(linked.linked).toContain('node_modules');
  expect(existsSync(lockDir)).toBe(false);
  expect(readFileSync(join(worktree, 'node_modules', 'fixture-pkg', 'index.js'), 'utf8')).toBe('from-source');
});

test('a recent ownerless lock and an aged lock with a live owner are preserved', () => {
  const root = tempRoot();
  const repo = join(root, 'repo');
  const store = join(root, 'shared-store');
  mkdirSync(join(repo, 'node_modules', 'fixture-pkg'), { recursive: true });
  writeFileSync(join(repo, 'bun.lock'), 'lock-v1\n');
  writeFileSync(join(repo, 'node_modules', 'fixture-pkg', 'index.js'), 'from-source');
  const scope = createHash('sha256').update(realpathSync(repo)).digest('hex').slice(0, 16);
  const lockDir = join(store, scope, lockHash(), 'node_modules.lock');

  const recentTree = targetTree(root, 'recent-ownerless-tree');
  mkdirSync(lockDir, { recursive: true });
  const recent = linkWorktreeDependencies(repo, recentTree, [], { sharedStoreRoot: store, testHooks: { lockWaitMs: 50 } });
  expect(recent.failed.some((entry) => entry.reason.includes('timed out waiting for dependency-store lock'))).toBe(true);
  expect(existsSync(lockDir)).toBe(true);
  expect(existsSync(join(recentTree, 'node_modules'))).toBe(false);

  rmSync(lockDir, { recursive: true, force: true });
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: 1 }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockDir, old, old);
  const liveTree = targetTree(root, 'live-owner-tree');
  const live = linkWorktreeDependencies(repo, liveTree, [], { sharedStoreRoot: store, testHooks: { lockWaitMs: 50 } });
  expect(live.failed.some((entry) => entry.reason.includes('timed out waiting for dependency-store lock'))).toBe(true);
  expect(existsSync(lockDir)).toBe(true);
  expect(existsSync(join(liveTree, 'node_modules'))).toBe(false);
});

test('an orphan recovery gate fails closed and is preserved for explicit recovery', () => {
  const root = tempRoot();
  const repo = join(root, 'repo');
  const worktree = targetTree(root, 'worktree');
  const store = join(root, 'shared-store');
  mkdirSync(join(repo, 'node_modules', 'fixture-pkg'), { recursive: true });
  writeFileSync(join(repo, 'bun.lock'), 'lock-v1\n');
  writeFileSync(join(repo, 'node_modules', 'fixture-pkg', 'index.js'), 'from-source');
  const scope = createHash('sha256').update(realpathSync(repo)).digest('hex').slice(0, 16);
  const recoveryGate = join(store, scope, lockHash(), 'node_modules.lock.recovery');
  mkdirSync(recoveryGate, { recursive: true });
  writeFileSync(join(recoveryGate, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, startedAt: 1 }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(recoveryGate, old, old);

  const linked = linkWorktreeDependencies(repo, worktree, [], { sharedStoreRoot: store });

  expect(linked.failed.some((entry) => entry.reason.includes('stale dependency-store recovery gate; manual recovery required'))).toBe(true);
  expect(existsSync(recoveryGate)).toBe(true);
  expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
});

test('incomplete or modified shared copies are rebuilt from the source tree', () => {
  const root = tempRoot();
  const repo = join(root, 'repo');
  const tree = targetTree(root, 'integrity-tree');
  const store = join(root, 'shared-store');
  mkdirSync(join(repo, 'node_modules', 'fixture-pkg'), { recursive: true });
  writeFileSync(join(repo, 'bun.lock'), 'lock-v1\n');
  writeFileSync(join(tree, 'bun.lock'), 'lock-v1\n');
  writeFileSync(join(repo, 'node_modules', 'fixture-pkg', 'index.js'), 'complete-source');
  const scope = createHash('sha256').update(realpathSync(repo)).digest('hex').slice(0, 16);
  const shared = join(store, scope, lockHash(), 'node_modules');
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, 'partial.txt'), 'interrupted copy');

  const first = linkWorktreeDependencies(repo, tree, [], { sharedStoreRoot: store });
  expect(first.failed).toEqual([]);
  expect(first.linked).toContain('node_modules');
  expect(readFileSync(join(tree, 'node_modules', 'fixture-pkg', 'index.js'), 'utf8')).toBe('complete-source');
  chmodSync(join(shared, 'fixture-pkg', 'index.js'), 0o600);
  writeFileSync(join(shared, 'fixture-pkg', 'index.js'), 'tampered');
  const secondTree = targetTree(root, 'integrity-tree-second');
  linkWorktreeDependencies(repo, secondTree, [], { sharedStoreRoot: store });
  expect(readFileSync(join(secondTree, 'node_modules', 'fixture-pkg', 'index.js'), 'utf8')).toBe('complete-source');
});

test('PWA dependency links compare the workspace lock independently from the root lock', () => {
  const root = tempRoot();
  const repo = join(root, 'repo');
  const tree = targetTree(root, 'pwa-lock-mismatch-tree');
  const store = join(root, 'shared-store');
  mkdirSync(join(repo, 'node_modules', 'fixture-pkg'), { recursive: true });
  mkdirSync(join(repo, 'apps', 'pwa', 'node_modules', 'fixture-pwa'), { recursive: true });
  writeFileSync(join(repo, 'bun.lock'), 'root-lock\n');
  writeFileSync(join(tree, 'bun.lock'), 'root-lock\n');
  writeFileSync(join(repo, 'apps', 'pwa', 'bun.lock'), 'pwa-lock-v1\n');
  writeFileSync(join(tree, 'apps', 'pwa', 'bun.lock'), 'pwa-lock-v2\n');

  const result = linkWorktreeDependencies(repo, tree, [], { sharedStoreRoot: store });

  expect(result.linked).toContain('node_modules');
  expect(result.skippedLockMismatch).toEqual(['apps/pwa/node_modules']);
  expect(existsSync(join(tree, 'node_modules'))).toBe(true);
  expect(existsSync(join(tree, 'apps', 'pwa', 'node_modules'))).toBe(false);
});

test('changed matching lockfiles replace an existing link to the old shared generation', () => {
  const root = tempRoot();
  const repo = join(root, 'repo');
  const tree = targetTree(root, 'updated-lock-tree');
  const store = join(root, 'shared-store');
  mkdirSync(join(repo, 'node_modules', 'fixture-pkg'), { recursive: true });
  writeFileSync(join(repo, 'bun.lock'), 'lock-v1\n');
  writeFileSync(join(tree, 'bun.lock'), 'lock-v1\n');
  writeFileSync(join(repo, 'node_modules', 'fixture-pkg', 'index.js'), 'generation-one');

  linkWorktreeDependencies(repo, tree, [], { sharedStoreRoot: store });
  const oldTarget = realpathSync(join(tree, 'node_modules'));
  writeFileSync(join(repo, 'bun.lock'), 'lock-v2\n');
  writeFileSync(join(tree, 'bun.lock'), 'lock-v2\n');

  const result = linkWorktreeDependencies(repo, tree, [], { sharedStoreRoot: store });

  expect(result.linked).toContain('node_modules');
  expect(realpathSync(join(tree, 'node_modules'))).not.toBe(oldTarget);
  expect(readFileSync(join(tree, 'node_modules', 'fixture-pkg', 'index.js'), 'utf8')).toBe('generation-one');
});

test('unrecognized dependency symlinks are preserved and reported as conflicts', () => {
  const root = tempRoot();
  const repo = join(root, 'repo');
  const tree = targetTree(root, 'untrusted-link-tree');
  const store = join(root, 'shared-store');
  const untrusted = join(root, 'untrusted-node-modules');
  mkdirSync(join(repo, 'node_modules', 'fixture-pkg'), { recursive: true });
  mkdirSync(untrusted, { recursive: true });
  writeFileSync(join(repo, 'bun.lock'), 'lock-v1\n');
  writeFileSync(join(tree, 'bun.lock'), 'lock-v1\n');
  writeFileSync(join(repo, 'node_modules', 'fixture-pkg', 'index.js'), 'managed');
  writeFileSync(join(untrusted, 'unexpected.js'), 'untrusted');
  symlinkSync(untrusted, join(tree, 'node_modules'), 'dir');

  const result = linkWorktreeDependencies(repo, tree, [], { sharedStoreRoot: store });

  expect(result.failed.some((entry) => entry.path === 'node_modules' && entry.reason.includes('not managed'))).toBe(true);
  expect(realpathSync(join(tree, 'node_modules'))).toBe(realpathSync(untrusted));
  expect(readFileSync(join(tree, 'node_modules', 'unexpected.js'), 'utf8')).toBe('untrusted');
});

test('absolute dependency symlinks back into the source tree make the copy unshareable', () => {
  const root = tempRoot();
  const repo = join(root, 'repo');
  const tree = targetTree(root, 'absolute-link-tree');
  const store = join(root, 'shared-store');
  mkdirSync(join(repo, 'node_modules', 'fixture-pkg'), { recursive: true });
  mkdirSync(join(repo, 'packages', 'workspace'), { recursive: true });
  writeFileSync(join(repo, 'bun.lock'), 'lock-v1\n');
  writeFileSync(join(tree, 'bun.lock'), 'lock-v1\n');
  writeFileSync(join(repo, 'node_modules', 'fixture-pkg', 'index.js'), 'from-source');
  symlinkSync(join(repo, 'node_modules'), join(tree, 'node_modules'), 'dir');
  symlinkSync(join(repo, 'packages', 'workspace'), join(repo, 'node_modules', 'fixture-pkg', 'workspace'), 'dir');

  const result = linkWorktreeDependencies(repo, tree, [], { sharedStoreRoot: store });

  expect(result.skippedUnshareableSource).toContain('node_modules');
  expect(existsSync(join(tree, 'node_modules'))).toBe(false);
  const scope = createHash('sha256').update(realpathSync(repo)).digest('hex').slice(0, 16);
  expect(existsSync(join(store, scope, lockHash(), 'node_modules'))).toBe(false);
});

test('copy failure detaches a preexisting direct dependency link', () => {
  const root = tempRoot();
  const repo = join(root, 'repo');
  const tree = targetTree(root, 'copy-failure-tree');
  const store = join(root, 'shared-store');
  mkdirSync(join(repo, 'node_modules', 'fixture-pkg'), { recursive: true });
  writeFileSync(join(repo, 'bun.lock'), 'lock-v1\n');
  writeFileSync(join(repo, 'node_modules', 'fixture-pkg', 'index.js'), 'source');
  symlinkSync(join(repo, 'node_modules'), join(tree, 'node_modules'), 'dir');

  const result = linkWorktreeDependencies(repo, tree, [], {
    sharedStoreRoot: store,
    copyTree: () => { throw new Error('copy interrupted'); },
  });

  expect(result.failed.some((entry) => entry.path === 'node_modules' && entry.reason.includes('copy interrupted'))).toBe(true);
  expect(existsSync(join(tree, 'node_modules'))).toBe(false);
});

test('concurrent stale-lock recovery and new acquisition stay serialized and publish one complete copy', async () => {
  const root = tempRoot();
  const repo = join(root, 'repo');
  const store = join(root, 'shared-store');
  const firstTree = targetTree(root, 'tree-a');
  const secondTree = targetTree(root, 'tree-b');
  mkdirSync(join(repo, 'node_modules', 'fixture-pkg'), { recursive: true });
  writeFileSync(join(repo, 'bun.lock'), 'lock-v1\n');
  writeFileSync(join(repo, 'node_modules', 'fixture-pkg', 'index.js'), 'complete-source');
  const scope = createHash('sha256').update(realpathSync(repo)).digest('hex').slice(0, 16);
  const staleLock = join(store, scope, lockHash(), 'node_modules.lock');
  mkdirSync(staleLock, { recursive: true });
  writeFileSync(join(staleLock, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, startedAt: 1 }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(staleLock, old, old);
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/git-fs/worktree.ts')).href;
  const recoveryPaused = join(root, 'recovery-paused');
  const recoveryRelease = join(root, 'recovery-release');
  const childScript = `
    import { appendFileSync, cpSync, existsSync, writeFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { linkWorktreeDependencies } from ${JSON.stringify(moduleUrl)};
    const [repo, tree, store, started, ready, go] = [process.env.SIM_REPO, process.env.SIM_TREE, process.env.SIM_STORE, process.env.SIM_STARTED, process.env.SIM_READY, process.env.SIM_GO];
    writeFileSync(ready, 'ready');
    while (!existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    const testHooks = {
      ...(process.env.SIM_PAUSE_RECOVERY ? { afterLockQuarantined: () => {
        writeFileSync(process.env.SIM_RECOVERY_PAUSED, 'paused');
        while (!existsSync(process.env.SIM_RECOVERY_RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      } } : {}),
      ...(process.env.SIM_GATE_WAIT ? { onRecoveryGateWait: () => writeFileSync(process.env.SIM_GATE_WAIT, 'waiting') } : {}),
    };
    const result = linkWorktreeDependencies(repo, tree, [], { sharedStoreRoot: store, testHooks, copyTree: (source, destination) => {
      appendFileSync(started, 'copy-started\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
      cpSync(source, destination, { recursive: true });
    }});
    process.stdout.write(JSON.stringify(result));
  `;
  const spawnLinker = (tree: string, ready: string, go: string, pauseRecovery = false, gateWait?: string) => spawn(process.execPath, ['-e', childScript], {
    cwd: root,
    env: { ...process.env, SIM_REPO: repo, SIM_TREE: tree, SIM_STORE: store, SIM_STARTED: join(root, 'copies.log'), SIM_READY: ready, SIM_GO: go,
      SIM_PAUSE_RECOVERY: pauseRecovery ? '1' : '', SIM_RECOVERY_PAUSED: recoveryPaused, SIM_RECOVERY_RELEASE: recoveryRelease, SIM_GATE_WAIT: gateWait ?? '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const firstReady = join(root, 'first.ready');
  const secondReady = join(root, 'second.ready');
  const go = join(root, 'go');
  const copies = join(root, 'copies.log');
  const first = spawnLinker(firstTree, firstReady, go, true);
  const firstResult = waitForChild(first);
  await waitForFile(firstReady);
  writeFileSync(go, 'go');
  await waitForFile(recoveryPaused);
  const secondGateWait = join(root, 'second-gate-wait');
  const second = spawnLinker(secondTree, secondReady, go, false, secondGateWait);
  const secondResult = waitForChild(second);
  await waitForFile(secondReady);
  await waitForFile(secondGateWait);
  expect(existsSync(join(root, 'copies.log'))).toBe(false);
  writeFileSync(recoveryRelease, 'release');
  const [a, b] = await Promise.all([firstResult, secondResult]);

  expect(a.code).toBe(0);
  expect(b.code).toBe(0);
  expect(a.stderr).toBe('');
  expect(b.stderr).toBe('');
  expect(readFileSync(copies, 'utf8').trim().split('\n')).toEqual(['copy-started']);
  expect(existsSync(staleLock)).toBe(false);
  expect(realpathSync(join(firstTree, 'node_modules'))).toBe(realpathSync(join(secondTree, 'node_modules')));
  expect(readFileSync(join(firstTree, 'node_modules', 'fixture-pkg', 'index.js'), 'utf8')).toBe('complete-source');
});
