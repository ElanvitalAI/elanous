// 폴더 «밖» 그림자 저장소 — 사용자 폴더에 `.git` 을 만들지 않고
// `<instanceRoot>/shadow-repos/<대상 해시>` 에서 `--git-dir`·`--work-tree` 로만 이력·비교·되돌리기를 남긴다.
// git 바이너리가 없으면 `<instanceRoot>/shadow-snapshots/<대상 해시>/<시각>/` 사본으로 떨어진다.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { debug } from '../debug/log.js';

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface ShadowGitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type ShadowGit = (args: string[], opts?: ShadowGitOptions) => GitResult;

export interface ShadowContext {
  target: string;
  instanceRoot: string;
  git?: ShadowGit;
  now?: () => Date;
}

export interface ShadowPaths {
  key: string;
  gitDir: string;
  snapshotsDir: string;
}

export interface ShadowSnapshotResult {
  commit: string;
  changed: number;
  mode: 'git' | 'copy';
}

export interface ShadowCommit {
  commit: string;
  at: string;
  message: string;
  changed: number;
}

const AUTHOR = 'elanous <elanous@localhost>';
const DEFAULT_EXCLUDES = ['node_modules/', '.env*', '.git/'];
const TARGET_MARKER = 'elanous-target';

function systemGit(args: string[], opts: ShadowGitOptions = {}): GitResult {
  const result = spawnSync('git', args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return { status: 127, stdout: '', stderr: 'git: command not found' };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function gitOf(ctx: ShadowContext): ShadowGit {
  return ctx.git ?? systemGit;
}

function nowOf(ctx: ShadowContext): Date {
  return ctx.now ? ctx.now() : new Date();
}

/** ISO-8601 시각을 디렉터리 이름으로 쓸 수 있게 콜론을 뺀다. */
export function snapshotStamp(at: Date): string {
  return at.toISOString().replace(/:/g, '');
}

export function shadowKey(target: string): string {
  const real = existsSync(target) ? realpathSync(target) : resolve(target);
  return createHash('sha256').update(real).digest('hex').slice(0, 16);
}

export function shadowPaths(target: string, instanceRoot: string): ShadowPaths {
  const key = shadowKey(target);
  return {
    key,
    gitDir: join(instanceRoot, 'shadow-repos', key),
    snapshotsDir: join(instanceRoot, 'shadow-snapshots', key),
  };
}

function gitBase(paths: ShadowPaths, target: string): string[] {
  return ['--git-dir', paths.gitDir, '--work-tree', target];
}

function authorEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'elanous',
    GIT_AUTHOR_EMAIL: 'elanous@localhost',
    GIT_COMMITTER_NAME: 'elanous',
    GIT_COMMITTER_EMAIL: 'elanous@localhost',
  };
}

function ensureBare(ctx: ShadowContext, paths: ShadowPaths, target: string, git: ShadowGit): void {
  if (!existsSync(join(paths.gitDir, 'HEAD'))) {
    mkdirSync(paths.gitDir, { recursive: true });
    const init = git(['init', '--bare', paths.gitDir], { env: authorEnv() });
    if (init.status !== 0) throw new Error(`shadow git init failed: ${init.stderr || init.stdout}`);
  }
  const excludePath = join(paths.gitDir, 'info', 'exclude');
  mkdirSync(join(paths.gitDir, 'info'), { recursive: true });
  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  const missing = DEFAULT_EXCLUDES.filter((line) => !existing.split('\n').includes(line));
  if (missing.length > 0) {
    const body = existing.length === 0 ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
    writeFileSync(excludePath, `${body}${missing.join('\n')}\n`);
  }
  writeFileSync(join(paths.gitDir, TARGET_MARKER), `${resolve(target)}\n`);
}

function gitMissing(result: GitResult): boolean {
  return result.status === 127;
}

/** 직전 커밋 대비 이번 커밋에서 바뀐 경로 수. 첫 커밋은 트리의 파일 수. */
function changedSinceParent(git: ShadowGit, paths: ShadowPaths, target: string, commit: string): number {
  const parent = git([...gitBase(paths, target), 'rev-parse', '--verify', `${commit}^`], { env: authorEnv() });
  if (parent.status !== 0) {
    const tree = git([...gitBase(paths, target), 'ls-tree', '-r', '--name-only', commit], { env: authorEnv() });
    return tree.stdout.split('\n').filter((line) => line.length > 0).length;
  }
  const diff = git(
    [...gitBase(paths, target), 'diff', '--name-only', parent.stdout.trim(), commit],
    { env: authorEnv() },
  );
  return diff.stdout.split('\n').filter((line) => line.length > 0).length;
}

function commitGit(ctx: ShadowContext, message: string): ShadowSnapshotResult {
  const git = gitOf(ctx);
  const paths = shadowPaths(ctx.target, ctx.instanceRoot);
  const target = resolve(ctx.target);
  ensureBare(ctx, paths, target, git);
  const base = gitBase(paths, target);
  const add = git([...base, 'add', '-A'], { env: authorEnv() });
  if (gitMissing(add)) return copySnapshot(ctx, message);
  if (add.status !== 0) throw new Error(`shadow git add failed: ${add.stderr || add.stdout}`);
  const commit = git(
    [...base, '-c', `user.name=elanous`, '-c', `user.email=elanous@localhost`, 'commit', '--allow-empty', '-m', message, `--author=${AUTHOR}`],
    { env: authorEnv() },
  );
  if (gitMissing(commit)) return copySnapshot(ctx, message);
  if (commit.status !== 0) throw new Error(`shadow git commit failed: ${commit.stderr || commit.stdout}`);
  const rev = git([...base, 'rev-parse', 'HEAD'], { env: authorEnv() });
  const hash = rev.stdout.trim();
  const changed = changedSinceParent(git, paths, target, hash);
  debug.log('shadow.repo', 'snapshot', { key: paths.key, mode: 'git', commit: hash, changed });
  return { commit: hash, changed, mode: 'git' };
}

const COPY_SKIP_DIRS = new Set(['node_modules', '.git']);

function copyExcluded(name: string): boolean {
  if (COPY_SKIP_DIRS.has(name)) return true;
  if (name === '.env' || name.startsWith('.env')) return true;
  return false;
}

function copyTree(from: string, to: string): number {
  mkdirSync(to, { recursive: true });
  let count = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (copyExcluded(entry.name)) continue;
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      count += copyTree(src, dst);
    } else if (entry.isFile()) {
      cpSync(src, dst);
      count += 1;
    }
  }
  return count;
}

function copySnapshot(ctx: ShadowContext, message: string): ShadowSnapshotResult {
  const paths = shadowPaths(ctx.target, ctx.instanceRoot);
  const stamp = snapshotStamp(nowOf(ctx));
  const dest = join(paths.snapshotsDir, stamp);
  const changed = copyTree(resolve(ctx.target), dest);
  writeFileSync(join(dest, '.elanous-shadow-message'), `${message}\n`);
  debug.log('shadow.repo', 'snapshot', { key: paths.key, mode: 'copy', commit: stamp, changed });
  return { commit: stamp, changed, mode: 'copy' };
}

function gitAvailable(ctx: ShadowContext): boolean {
  const git = gitOf(ctx);
  const probe = git(['--version']);
  return !gitMissing(probe) && probe.status === 0;
}

export function snapshotShadow(ctx: ShadowContext & { message: string }): ShadowSnapshotResult {
  if (!gitAvailable(ctx)) return copySnapshot(ctx, ctx.message);
  return commitGit(ctx, ctx.message);
}

function parseLog(stdout: string): Array<Omit<ShadowCommit, 'changed'>> {
  const records = stdout.split('\x1e').map((block) => block.trim()).filter((block) => block.length > 0);
  const out: Array<Omit<ShadowCommit, 'changed'>> = [];
  for (const block of records) {
    const [commit = '', at = '', ...messageParts] = block.split('\x1f');
    out.push({ commit, at, message: messageParts.join('\x1f') });
  }
  return out;
}

export function listShadow(ctx: ShadowContext): ShadowCommit[] {
  if (!gitAvailable(ctx)) return listCopies(ctx);
  const paths = shadowPaths(ctx.target, ctx.instanceRoot);
  if (!existsSync(join(paths.gitDir, 'HEAD'))) return [];
  const git = gitOf(ctx);
  const target = resolve(ctx.target);
  const log = git(
    [...gitBase(paths, target), 'log', '--format=%H%x1f%aI%x1f%s%x1e'],
    { env: authorEnv() },
  );
  if (log.status !== 0) return [];
  return parseLog(log.stdout).map((row) => ({
    ...row,
    changed: changedSinceParent(git, paths, target, row.commit),
  }));
}

function listCopies(ctx: ShadowContext): ShadowCommit[] {
  const paths = shadowPaths(ctx.target, ctx.instanceRoot);
  if (!existsSync(paths.snapshotsDir)) return [];
  const stamps = readdirSync(paths.snapshotsDir).filter((name) => !name.startsWith('.'));
  stamps.sort().reverse();
  return stamps.map((stamp) => {
    const dir = join(paths.snapshotsDir, stamp);
    const messagePath = join(dir, '.elanous-shadow-message');
    const message = existsSync(messagePath) ? readFileSync(messagePath, 'utf8').trim() : '';
    const changed = readdirSync(dir).filter((name) => name !== '.elanous-shadow-message').length;
    return { commit: stamp, at: stamp, message, changed };
  });
}

export function diffShadow(ctx: ShadowContext & { from: string; to?: string }): string {
  const to = ctx.to ?? 'WORKTREE';
  const paths = shadowPaths(ctx.target, ctx.instanceRoot);
  if (!gitAvailable(ctx)) {
    debug.log('shadow.repo', 'diff', { key: paths.key, mode: 'copy', commit: `${ctx.from}..${to}`, changed: 0 });
    return '';
  }
  const git = gitOf(ctx);
  const target = resolve(ctx.target);
  const args = to === 'WORKTREE'
    ? [...gitBase(paths, target), 'diff', '--unified', ctx.from]
    : [...gitBase(paths, target), 'diff', '--unified', ctx.from, to];
  const diff = git(args, { env: authorEnv() });
  const text = diff.stdout;
  const changed = text.split('\n').filter((line) => line.startsWith('diff --git ')).length;
  debug.log('shadow.repo', 'diff', { key: paths.key, mode: 'git', commit: `${ctx.from}..${to}`, changed });
  return text;
}

function trackedAt(git: ShadowGit, paths: ShadowPaths, target: string, commit: string): string[] {
  const tree = git([...gitBase(paths, target), 'ls-tree', '-r', '--name-only', commit], { env: authorEnv() });
  return tree.stdout.split('\n').filter((line) => line.length > 0);
}

/** 그림자 exclude·대상 `.gitignore` 에 걸리는 경로. 복원 때 지우면 안 된다(추적된 적 없는 파일). */
function ignoredByShadow(git: ShadowGit, paths: ShadowPaths, target: string, rel: string): boolean {
  const check = git(
    [...gitBase(paths, target), 'check-ignore', '--no-index', '-q', '--', rel],
    { env: authorEnv() },
  );
  return check.status === 0;
}

function removeUntrackedAgainst(git: ShadowGit, paths: ShadowPaths, target: string, keep: Set<string>): void {
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const abs = join(dir, entry.name);
      const rel = relative(target, abs).split(sep).join('/');
      if (ignoredByShadow(git, paths, target, rel)) continue;
      if (entry.isDirectory()) {
        walk(abs);
        if (!existsSync(abs)) continue;
        if (readdirSync(abs).length === 0 && !keep.has(rel)) rmSync(abs, { recursive: true });
      } else if (entry.isFile() && !keep.has(rel)) {
        rmSync(abs);
      }
    }
  };
  walk(target);
}

export function restoreShadow(ctx: ShadowContext & { commit: string }): ShadowSnapshotResult {
  const paths = shadowPaths(ctx.target, ctx.instanceRoot);
  if (!gitAvailable(ctx)) {
    throw new Error('shadow restore requires git');
  }
  const git = gitOf(ctx);
  const target = resolve(ctx.target);
  snapshotShadow({ ...ctx, message: `restore 전 ${ctx.commit}` });
  const checkout = git(
    [...gitBase(paths, target), 'checkout', ctx.commit, '--', '.'],
    { env: authorEnv() },
  );
  if (checkout.status !== 0) throw new Error(`shadow git checkout failed: ${checkout.stderr || checkout.stdout}`);
  const keep = new Set(trackedAt(git, paths, target, ctx.commit));
  removeUntrackedAgainst(git, paths, target, keep);
  const after = snapshotShadow({ ...ctx, message: `restore 후 ${ctx.commit}` });
  debug.log('shadow.repo', 'restore', { key: paths.key, mode: 'git', commit: ctx.commit, changed: after.changed });
  return after;
}

/** 대상이 이미 git 저장소인지 — 그림자 저장소(bare · 대상 밖)는 제외한다. */
export function targetIsGitRepo(target: string, git: ShadowGit = systemGit): boolean {
  const resolved = resolve(target);
  const inside = git(['-C', resolved, 'rev-parse', '--is-inside-work-tree']);
  if (gitMissing(inside) || inside.status !== 0) return false;
  if (inside.stdout.trim() !== 'true') return false;
  const top = git(['-C', resolved, 'rev-parse', '--show-toplevel']);
  if (top.status !== 0) return false;
  let topPath = top.stdout.trim();
  let targetPath = resolved;
  try { topPath = realpathSync(topPath); } catch { /* 비교는 원문으로 */ }
  try { targetPath = realpathSync(targetPath); } catch { /* 비교는 원문으로 */ }
  return topPath === targetPath || targetPath.startsWith(topPath + sep);
}
