/** TA-PRELAUNCH-ALREADY-DONE: bounded evidence against a pinned, detached main tree. */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { inspectGoalDoneBoundary } from '../self-implement/goal-author.js';

export interface AlreadyDoneCandidate { mainSha: string; repository: string; command: string; exitCode: 0 }
export interface AlreadyDoneDecision { candidate?: AlreadyDoneCandidate; reason: string }

type SafeCommand = { argv: string[]; path: string };
const SHA = /^[0-9a-f]{40}$/i;
const SAFE_PATH = /^[A-Za-z0-9_./-]+$/;

/** A lexical command declaration is not authority to run shell or project scripts. */
export function parseAlreadyDoneCommand(command: string): SafeCommand | null {
  let input = command.trim();
  while (input.length >= 2 && ((input.startsWith('`') && input.endsWith('`'))
    || (input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))))
    input = input.slice(1, -1).trim();
  if (!input || /[\n\r\t`$;&|<>\\'"*?()[\]{}!]/.test(input)) return null;
  const argv = input.split(/ +/);
  let path: string | undefined;
  if (argv.length === 3 && argv[0] === 'test' && ['-f', '-e'].includes(argv[1]!)) path = argv[2];
  else if (argv.length === 5 && argv[0] === 'git' && argv[1] === 'ls-files' && argv[2] === '--error-unmatch' && argv[3] === '--') path = argv[4];
  else if (argv.length === 7 && argv[0] === 'git' && argv[1] === 'diff' && argv[2] === '--quiet'
    && SHA.test(argv[3]!) && argv[4] === 'HEAD' && argv[5] === '--') path = argv[6];
  if (!path || !SAFE_PATH.test(path) || isAbsolute(path) || path.startsWith('-')
    || path.split('/').some((part) => part === '..' || part === '.' || !part)) return null;
  return { argv, path };
}

export type PinnedGitResult = { status: number | null; stdout: string; error: boolean };
export type PrelaunchGitRunnerForTest = (cwd: string, argv: string[], timeout?: number) => PinnedGitResult;

export function runPinnedGit(cwd: string, argv: string[], timeout = 4_000, input?: string): PinnedGitResult {
  // Trust boundary: the operator's own repository and Git config. Drop inherited GIT_* overrides,
  // disable replace refs, hooks, and credential helpers; remote transport uses the operator's SSH config.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...argv],
    { cwd, env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024, ...(input !== undefined ? { input } : {}) });
  return { status: result.status, stdout: result.stdout ?? '', error: !!result.error };
}

function evaluatePinnedTree(root: string, sha: string, safe: SafeCommand, runGit: PrelaunchGitRunnerForTest): AlreadyDoneDecision {
  const { argv, path } = safe;
  // Every supported command names one tracked regular file in the pinned tree.
  // A symlink's filesystem -e/-f meaning is not inferable from its Git object.
  const entry = runGit(root, ['ls-tree', sha, '--', path]);
  if (entry.status !== 0 || entry.error) return { reason: 'evidence-unmeasured' };
  const match = /^(100644|100755|040000|120000) (blob|tree) [0-9a-f]{40}\t(.+)$/m.exec(entry.stdout);
  if (!match || match[3] !== path) return { reason: 'evidence-not-passing' };
  if (match[1] === '120000') return { reason: 'evidence-symlink-unmeasured' };
  if (!['100644', '100755'].includes(match[1]!) || match[2] !== 'blob') return { reason: 'evidence-path-not-tracked-file' };
  if (argv[0] === 'git' && argv[1] === 'diff') {
    const base = argv[3]!;
    if (base.toLowerCase() === sha.toLowerCase()) return { reason: 'diff-compares-main-to-itself' };
    const ancestor = runGit(root, ['merge-base', '--is-ancestor', base, sha]);
    if (ancestor.status !== 0) return { reason: 'diff-base-unverified' };
    const diff = runGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--quiet', base, sha, '--', path]);
    return { reason: diff.status === 0 ? 'evidence-passed-on-main' : diff.status === 1 && !diff.error ? 'evidence-not-passing' : 'evidence-unmeasured' };
  }
  return { reason: 'evidence-passed-on-main' };
}

/** Only an explicit project repository qualifies. Unknown target means preserve the live launch. */
export function inspectPrelaunchAlreadyDone(text: string, projectTarget?: string,
  deps: { runGit?: PrelaunchGitRunnerForTest; realpath?: (path: string) => string } = {}): AlreadyDoneDecision {
  const boundary = inspectGoalDoneBoundary(text);
  if (boundary.missing.length) return { reason: `boundary-missing:${boundary.missing.join(',')}` };
  const command = boundary.values['완료 경계 증거 명령'] ?? '';
  const safe = parseAlreadyDoneCommand(command);
  if (!safe) return { reason: 'evidence-command-unsupported' };
  const codeBoundary = boundary.values['완료 경계 코드'] ?? '';
  const realBoundary = boundary.values['완료 경계 실물'] ?? '';
  if (codeBoundary !== `기존 추적 파일 ${safe.path}` || realBoundary !== '원격 main의 일반 파일로 존재')
    return { reason: 'evidence-boundary-not-file-existence' };
  if (!projectTarget) return { reason: 'project-target-unverified' };
  let root: string;
  try { root = (deps.realpath ?? realpathSync)(projectTarget); } catch { return { reason: 'project-target-unreadable' }; }
  const runGit = deps.runGit ?? runPinnedGit;
  const top = runGit(root, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || top.stdout.trim() !== root) return { reason: 'project-root-unverified' };
  const origin = runGit(root, ['remote', 'get-url', 'origin']);
  const originUrl = origin.stdout.trim();
  // Keep credentials and arbitrary transports out of both the verifier and its card evidence.
  const repository = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(originUrl)?.[1];
  if (origin.status !== 0 || !repository) return { reason: 'origin-unverified' };
  const local = runGit(root, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim();
  const remote = runGit(root, ['ls-remote', 'origin', 'refs/heads/main'], 7_000);
  const sha = remote.stdout.trim().split(/\s+/)[0] ?? '';
  if (remote.status !== 0 || !SHA.test(sha) || local !== sha) return { reason: 'main-unverified-or-stale' };
  const evaluated = evaluatePinnedTree(root, sha, safe, runGit);
  if (evaluated.reason !== 'evidence-passed-on-main') return evaluated;
  const remoteAgain = runGit(root, ['ls-remote', 'origin', 'refs/heads/main'], 7_000);
  if (remoteAgain.status !== 0 || remoteAgain.stdout.trim().split(/\s+/)[0] !== sha) return { reason: 'main-moved' };
  return { candidate: { mainSha: sha, repository, command, exitCode: 0 }, reason: 'evidence-passed-on-main' };
}
