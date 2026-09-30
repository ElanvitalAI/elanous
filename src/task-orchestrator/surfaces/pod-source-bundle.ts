import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { debug } from '../../debug/log.js';

const DEFAULT_MAX_SIZE_BYTES = 200 * 1024 * 1024;

type PackOptions = {
  repoDir: string;
  kind: 'worktree' | 'files';
  base: string;
  paths?: string[];
  outDir: string;
  maxSizeBytes?: number;
  mirrorHead?: string;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
};

type PackedBundle = {
  bundlePath: string;
  sha256: string;
  sizeBytes: number;
  baseCommit: string;
  headCommit: string;
  fileCount: number;
};

function git(repoDir: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const e = error as Error & { stderr?: Buffer | string };
    throw new Error(`git ${args[0]} failed: ${String(e.stderr ?? e.message).trim()}`);
  }
}

/** Package the host's on-disk files above a fetchable remote base without touching the user's index. */
export function packSourceBundle(options: PackOptions): PackedBundle {
  const { repoDir, kind, base, paths, outDir } = options;
  const log = options.log ?? ((category: string, event: string, data: Record<string, unknown>) => debug.log(category, event, data));
  const started = Date.now();
  let root = resolve(repoDir);
  const output = resolve(outDir);
  const env = { ...process.env, GIT_INDEX_FILE: `${output}/index.tmp`, GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: 'elanous pod source', GIT_AUTHOR_EMAIL: 'pod-source@elanous.local',
    GIT_COMMITTER_NAME: 'elanous pod source', GIT_COMMITTER_EMAIL: 'pod-source@elanous.local' };
  const bundlePath = `${output}/pod-source-${randomUUID()}.bundle`;
  let ref: string | undefined;
  let headCommit: string | undefined;
  let ownsIndex = false;
  let createdBundle = false;
  try {
    root = git(root, env, 'rev-parse', '--show-toplevel');
    const outputRelative = relative(root, output);
    if (!outputRelative || (!outputRelative.startsWith('..') && !isAbsolute(outputRelative))) {
      throw new Error('outDir must be outside the source worktree');
    }
    if (kind !== 'worktree' && kind !== 'files') throw new Error('unknown source kind');
    if (kind === 'files' && (!paths?.length || paths.some((path) => !path || path.startsWith('-') || isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.')))) {
      throw new Error('files requires nonempty relative paths inside the worktree');
    }
    const limit = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('invalid bundle size limit');
    const baseCommit = git(root, env, 'rev-parse', '--verify', `${base}^{commit}`);
    // Ask origin, not its potentially absent or stale local tracking refs. Fetch objects only.
    const { GIT_INDEX_FILE: _temporaryIndex, ...remoteEnv } = env;
    const remoteHead = git(root, remoteEnv, 'ls-remote', '--symref', 'origin', 'HEAD');
    const defaultBranch = /^ref: (refs\/heads\/[^\t\n]+)\tHEAD$/m.exec(remoteHead)?.[1];
    const remoteDefault = /^([0-9a-f]{40,64})\tHEAD$/m.exec(remoteHead)?.[1];
    if (!defaultBranch || !remoteDefault) throw new Error('origin does not advertise a default branch commit');
    git(root, remoteEnv, 'fetch', '--no-write-fetch-head', '--no-tags', '--refmap=', 'origin', defaultBranch);
    if (git(root, remoteEnv, 'ls-remote', 'origin', defaultBranch).split('\t')[0] !== remoteDefault) {
      throw new Error(`origin default branch (${defaultBranch}) changed during packing`);
    }
    try {
      git(root, env, 'merge-base', '--is-ancestor', baseCommit, remoteDefault);
    } catch {
      throw new Error(`base ${baseCommit} is not on origin default branch (${defaultBranch}); origin cannot supply this base`);
    }
    let existingParent = output;
    while (!existsSync(existingParent)) existingParent = dirname(existingParent);
    const realParentRelative = relative(realpathSync(root), realpathSync(existingParent));
    if (!realParentRelative || (!realParentRelative.startsWith('..') && !isAbsolute(realParentRelative))) {
      throw new Error('outDir must be outside the source worktree');
    }
    mkdirSync(output, { recursive: true });
    const realOutputRelative = relative(realpathSync(root), realpathSync(output));
    if (!realOutputRelative || (!realOutputRelative.startsWith('..') && !isAbsolute(realOutputRelative))) {
      throw new Error('outDir must be outside the source worktree');
    }
    const indexExists = (path: string): boolean => {
      try { lstatSync(path); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    if (indexExists(env.GIT_INDEX_FILE) || indexExists(`${env.GIT_INDEX_FILE}.lock`)) {
      throw new Error('temporary index already exists in outDir');
    }
    ownsIndex = true;
    git(root, env, 'read-tree', baseCommit);
    if (kind === 'worktree') git(root, env, 'add', '-A');
    else git(root, env, 'add', '--', ...paths!);
    const tree = git(root, env, 'write-tree');
    headCommit = git(root, env, 'commit-tree', tree, '-p', baseCommit, '-m', `elanous pod source (${kind})`);
    const fileCount = git(root, env, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', baseCommit, headCommit).split('\0').filter(Boolean).length;
    ref = `refs/elanous/pod-source/${randomUUID()}`;
    git(root, env, 'update-ref', ref, headCommit);
    createdBundle = true;
    let bundleRevision = ref;
    if (options.mirrorHead !== undefined) {
      // A thin bundle is usable only when its excluded history belongs to the packed base's lineage.
      const mirrorHead = options.mirrorHead;
      let sharedHistory = false;
      if (/^[0-9a-f]{40,64}$/.test(mirrorHead)) {
        try {
          git(root, env, 'cat-file', '-e', `${mirrorHead}^{commit}`);
          git(root, env, 'merge-base', '--is-ancestor', mirrorHead, baseCommit);
          sharedHistory = true;
        } catch { /* The mirror is unavailable or unrelated; include all history instead. */ }
      }
      bundleRevision = sharedHistory ? `${mirrorHead}..${ref}` : ref;
    }
    git(root, env, 'bundle', 'create', bundlePath, bundleRevision);
    git(root, env, 'update-ref', '-d', ref, headCommit);
    ref = undefined;
    const sizeBytes = statSync(bundlePath).size;
    if (sizeBytes > limit) throw new Error(`bundle size ${sizeBytes} exceeds limit ${limit} bytes`);
    const sha256 = createHash('sha256').update(readFileSync(bundlePath)).digest('hex');
    const result = { bundlePath, sha256, sizeBytes, baseCommit, headCommit, fileCount };
    log('pod.source', 'bundle-packed', { kind, baseCommit, headCommit, fileCount, sizeBytes, ms: Date.now() - started });
    return result;
  } catch (error) {
    if (createdBundle) rmSync(bundlePath, { force: true });
    const reason = error instanceof Error ? error.message : String(error);
    log('pod.source', 'bundle-refused', { kind, reason });
    throw error;
  } finally {
    if (ref && headCommit) git(root, env, 'update-ref', '-d', ref, headCommit);
    if (ownsIndex) {
      rmSync(env.GIT_INDEX_FILE, { force: true });
      rmSync(`${env.GIT_INDEX_FILE}.lock`, { force: true });
    }
  }
}
