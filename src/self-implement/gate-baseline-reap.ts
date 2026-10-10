import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { runGitCommand, type GitCommandRunner } from '../git-fs/runner.js';

export interface GateWorktreeReapResult {
  ok: boolean;
  listed: number;
  candidates: number;
  removed: number;
  keptLive: number;
  keptYoung: number;
  deferred: number;
  failed: number;
  orphanDirsRemoved: number;
}

export interface GateWorktreeReapOptions {
  prefixes?: readonly string[];
  minAgeMs?: number;
  max?: number;
}

export interface GateWorktreeReapDeps {
  run?: GitCommandRunner;
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
  tmpRoots?: readonly string[];
}

interface Registration { path: string; reason?: string }

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function registrations(output: string): Registration[] {
  return output.split(/\n\s*\n/).flatMap((block) => {
    const lines = block.split('\n');
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    if (!path || !isAbsolute(path)) return [];
    return [{ path: resolve(path), reason: lines.find((line) => line.startsWith('locked '))?.slice('locked '.length) }];
  });
}

function metadataFor(path: string, metadataRoot: string): string | undefined {
  for (const entry of readdirSync(metadataRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = join(metadataRoot, entry.name);
    const gitdir = join(folder, 'gitdir');
    try {
      if (!lstatSync(gitdir).isFile()) continue;
      const target = readFileSync(gitdir, 'utf8').trim();
      if (isAbsolute(target) && resolve(target) === join(path, '.git')) return folder;
    } catch { continue; }
  }
  return undefined;
}

/** Only gate-prefixed registrations and direct children of the supplied temp roots are eligible. */
export function reapStaleGateWorktrees(
  cwd: string,
  opts: GateWorktreeReapOptions = {},
  deps: GateWorktreeReapDeps = {},
): GateWorktreeReapResult {
  const result: GateWorktreeReapResult = {
    ok: false, listed: 0, candidates: 0, removed: 0, keptLive: 0,
    keptYoung: 0, deferred: 0, failed: 0, orphanDirsRemoved: 0,
  };
  const emit = (): GateWorktreeReapResult => {
    if (!result.ok || result.candidates > 0) debug.log('self-implement.gate-baseline', 'reap', { ...result });
    return result;
  };
  const run = deps.run ?? runGitCommand;
  const git = (args: string[]) => run(cwd, args, { encoding: 'utf8', timeout: 60_000 });
  try {
    const listing = git(['worktree', 'list', '--porcelain']);
    if (listing.status !== 0 || listing.signal || typeof listing.stdout !== 'string') return emit();
    if (!listing.stdout.startsWith('worktree ')) return emit();
    const entries = registrations(listing.stdout);
    result.ok = true;
    result.listed = entries.length;
    const prefixes = opts.prefixes ?? ['elanous-gate-baseline-'];
    const minAgeMs = opts.minAgeMs ?? 2 * 60 * 60_000;
    const max = Math.max(0, opts.max ?? 20);
    const now = (deps.now ?? Date.now)();
    const isAlive = deps.isPidAlive ?? pidAlive;
    const registered = new Set(entries.map((entry) => entry.path));
    const matches = (path: string) => prefixes.some((prefix) => prefix.length > 0 && basename(path).startsWith(prefix));
    const candidates = entries.filter((entry) => matches(entry.path));
    result.candidates = candidates.length;
    let metadataRoot: string | undefined;
    const getMetadataRoot = (): string | undefined => {
      if (metadataRoot) return metadataRoot;
      const common = git(['rev-parse', '--git-common-dir']);
      if (common.status !== 0 || typeof common.stdout !== 'string' || !common.stdout.trim()) return undefined;
      const root = common.stdout.trim();
      metadataRoot = join(realpathSync(isAbsolute(root) ? root : resolve(cwd, root)), 'worktrees');
      return metadataRoot;
    };
    let attempted = 0;
    for (const entry of candidates) {
      try {
        const owner = entry.reason?.match(/^elanous-gate pid=([1-9]\d*)\b/);
        if (owner && isAlive(Number(owner[1]))) {
          result.keptLive++;
          continue;
        }
        const started = owner ? entry.reason?.match(/\bstarted=(\d+)\b/) : undefined;
        const startedAt = started ? Number(started[1]) : undefined;
        const root = startedAt === undefined || !existsSync(entry.path) ? getMetadataRoot() : undefined;
        const metadata = root ? metadataFor(entry.path, root) : undefined;
        const timestamp = startedAt !== undefined && Number.isSafeInteger(startedAt)
          ? startedAt : metadata ? statSync(metadata).mtimeMs : undefined;
        if (timestamp === undefined || !Number.isFinite(timestamp)) { result.failed++; continue; }
        if (now - timestamp < minAgeMs) { result.keptYoung++; continue; }
        if (attempted >= max) { result.deferred++; continue; }
        attempted++;
        const removed = git(['worktree', 'remove', '--force', '--force', entry.path]);
        if (removed.status === 0) { result.removed++; continue; }
        // A missing checkout cannot be removed by git. Verify the single metadata record before unlinking it.
        if (!existsSync(entry.path) && metadata && metadataFor(entry.path, root!) === metadata) {
          rmSync(metadata, { recursive: true });
          result.removed++;
        } else result.failed++;
      } catch { result.failed++; }
    }
    for (const root of deps.tmpRoots ?? [realpathSync(tmpdir())]) {
      try {
        const realRoot = realpathSync(root);
        for (const entry of readdirSync(realRoot, { withFileTypes: true })) {
          const path = join(realRoot, entry.name);
          if (!entry.isDirectory() || !matches(path) || registered.has(path)) continue;
          try {
            const stat = lstatSync(path);
            if (!stat.isDirectory() || now - stat.mtimeMs < minAgeMs) continue;
            // A checkout owned by another repository is absent from this repository's listing.
            // Its .git file (or directory) must never be treated as an unregistered orphan.
            // With no .git, only an empty directory is provably unused; preserve unknown contents.
            if (existsSync(join(path, '.git')) || readdirSync(path).length !== 0) continue;
            rmSync(path, { recursive: true });
            result.orphanDirsRemoved++;
          } catch { result.failed++; }
        }
      } catch { result.failed++; }
    }
  } catch {
    result.ok = false;
  }
  return emit();
}
