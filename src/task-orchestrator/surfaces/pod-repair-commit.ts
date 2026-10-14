/** Pod repair result: a commit based on the exact PR head, returned without opening a PR. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const REPAIR_REF = 'refs/elanous/repair/result';
export const REPAIR_BUNDLE_MAX_BYTES = 5 * 1024 * 1024;
const SHA40 = /^[0-9a-f]{40}$/;

export interface PodRepairResult {
  pr: number;
  baseHead: string;
  runId: string;
  commit: string;
  bundleSha256: string;
}

/** Host-side receipt gate. A missing, mismatched, or truncated return is never a repair result. */
export function readPodRepairArtifact(artifactDir: string, expected: { pr: number; baseHead: string; runId?: string }): PodRepairResult {
  const result = JSON.parse(readFileSync(join(artifactDir, 'result.json'), 'utf8')) as Partial<PodRepairResult>;
  if (result.pr !== expected.pr || result.baseHead !== expected.baseHead || (expected.runId && result.runId !== expected.runId)
    || !result.runId || !SHA40.test(result.commit ?? '') || !/^[0-9a-f]{64}$/.test(result.bundleSha256 ?? '')) {
    throw new Error('repair result mismatch');
  }
  const bundle = readFileSync(join(artifactDir, 'commit.bundle'));
  if (bundle.length > REPAIR_BUNDLE_MAX_BYTES) throw new Error('repair bundle too large');
  if (createHash('sha256').update(bundle).digest('hex') !== result.bundleSha256) throw new Error('repair bundle checksum mismatch');
  return result as PodRepairResult;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function completedWorktree(output: string): { path: string; runId: string } {
  for (const line of output.trimEnd().split(/\r?\n/).reverse()) {
    if (!line.startsWith('{')) continue;
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (value.kind === 'self' && value.result && typeof value.result === 'object') value = value.result as Record<string, unknown>;
    if (value.stage !== 'worktree-completed' || value.ok !== true || typeof value.worktreePath !== 'string'
      || typeof value.runId !== 'string' || !value.runId)
      throw new Error('repair child final result is not a successful worktree-only result');
    return { path: value.worktreePath, runId: value.runId };
  }
  throw new Error('repair child did not return a successful worktree-only result');
}

/** Called in the Pod after the child exits successfully and before artifact export. */
export function writePodRepairCommit(input: { pr: number; baseHead: string; runId: string; output: string; repo: string; outbox: string }): PodRepairResult {
  if (!Number.isSafeInteger(input.pr) || input.pr < 1 || !SHA40.test(input.baseHead)) throw new Error('invalid repair PR or base head');
  if (!input.runId.trim()) throw new Error('repair parent run id missing');
  const { path, runId: childRunId } = completedWorktree(input.output);
  if (!isAbsolute(path)) throw new Error('repair worktree path is not absolute');
  const worktree = realpathSync(path);
  const repo = realpathSync(input.repo);
  if (worktree === repo) throw new Error('repair result must be a separate worktree');
  if (git(worktree, 'rev-parse', '--is-inside-work-tree') !== 'true') throw new Error('repair result is not a git worktree');
  const commonDir = (cwd: string) => realpathSync(resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir')));
  if (commonDir(worktree) !== commonDir(repo)) throw new Error('repair worktree belongs to another repository');
  if (git(worktree, 'config', '--worktree', '--get', 'elanous.harness.owner') !== `dev:${childRunId}`
    || git(worktree, 'config', '--worktree', '--get', 'elanous.harness.command') !== 'elanous dev')
    throw new Error('repair worktree is not owned by the completed child run');
  if (git(repo, 'rev-parse', 'HEAD') !== input.baseHead) throw new Error('Pod source head changed before repair export');
  git(worktree, 'cat-file', '-e', `${input.baseHead}^{commit}`);
  execFileSync('git', ['-C', worktree, 'add', '-A', '--', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const staged = git(worktree, 'diff', '--cached', '--name-only');
  if (staged) git(worktree, 'commit', '-m', `repair: PR #${input.pr} from ${input.baseHead.slice(0, 12)}`);
  const commit = git(worktree, 'rev-parse', 'HEAD');
  if (!SHA40.test(commit) || commit === input.baseHead) throw new Error('repair made no new commit');
  execFileSync('git', ['-C', worktree, 'merge-base', '--is-ancestor', input.baseHead, commit], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(worktree, 'update-ref', REPAIR_REF, commit);
  const dir = join(input.outbox, 'repair');
  mkdirSync(dir, { recursive: true });
  const bundle = join(dir, 'commit.bundle');
  execFileSync('git', ['-C', worktree, 'bundle', 'create', bundle, REPAIR_REF, `^${input.baseHead}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const size = statSync(bundle).size;
  if (size > REPAIR_BUNDLE_MAX_BYTES) throw new Error(`repair bundle too large: ${size} > ${REPAIR_BUNDLE_MAX_BYTES}`);
  const bundleSha256 = createHash('sha256').update(readFileSync(bundle)).digest('hex');
  const result = { pr: input.pr, baseHead: input.baseHead, runId: input.runId, commit, bundleSha256 };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}

if (import.meta.main) {
  try {
    const [pr, baseHead, outputPath, repo, outbox] = process.argv.slice(2);
    if (!pr || !baseHead || !outputPath || !repo || !outbox) throw new Error('usage: pod-repair-commit <pr> <base-head> <child-output> <repo> <outbox>');
    const result = writePodRepairCommit({ pr: Number(pr), baseHead, runId: process.env.ELANOUS_PARENT_RUN_ID ?? '', output: readFileSync(outputPath, 'utf8'), repo, outbox });
    console.log(`ELANOUS_POD_REPAIR_COMMIT ${result.pr} ${result.baseHead} ${result.commit}`);
  } catch (error) {
    console.error(`ELANOUS_POD_REPAIR_FAILED ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
