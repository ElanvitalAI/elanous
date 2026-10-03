import { spawnSync } from 'node:child_process';
import { isElanousRuntimeArtifactPath } from './gate-scope.js';

export type UncommittedWork =
  | { status: 'clean'; trackedChanges: string[]; untrackedFiles: string[] }
  | { status: 'changes'; trackedChanges: string[]; untrackedFiles: string[] }
  | { status: 'unavailable'; reason: string };

/** Observe the index and working tree without staging, refreshing, or changing any files. */
export function detectUncommittedWork(worktree: string): UncommittedWork {
  const gitEnv = { ...process.env };
  for (const key of Object.keys(gitEnv)) {
    if (key.startsWith('GIT_')) delete gitEnv[key];
  }
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: worktree,
      env: gitEnv,
      encoding: 'utf8',
      timeout: 10_000,
    });
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    return { status: 'unavailable', reason: result.error?.message || stderr || 'git status failed' };
  }

  const trackedChanges = new Set<string>();
  const untrackedFiles = new Set<string>();
  const entries = result.stdout.split('\0');
  if (entries.at(-1) !== '') return { status: 'unavailable', reason: 'incomplete git status output' };
  entries.pop();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.length < 4 || entry[2] !== ' ') return { status: 'unavailable', reason: 'invalid git status output' };
    const kind = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) return { status: 'unavailable', reason: 'invalid git status path' };
    if (kind === '??') {
      if (!isElanousRuntimeArtifactPath(path) && path !== '.elanous-test' && !path.startsWith('.elanous-test/')
        && path !== '.elanous-skill-artifacts' && !path.startsWith('.elanous-skill-artifacts/')) {
        untrackedFiles.add(path);
      }
    } else if (kind !== '!!') {
      trackedChanges.add(path);
      if (kind.includes('R') || kind.includes('C')) {
        const original = entries[++i];
        if (!original) return { status: 'unavailable', reason: 'incomplete git rename/copy output' };
        if (kind.includes('R')) trackedChanges.add(original);
      }
    }
  }
  return trackedChanges.size || untrackedFiles.size
    ? { status: 'changes', trackedChanges: [...trackedChanges], untrackedFiles: [...untrackedFiles] }
    : { status: 'clean', trackedChanges: [], untrackedFiles: [] };
}
