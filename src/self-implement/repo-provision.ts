import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { SENSITIVE_GLOBS, SENSITIVE_PATTERNS } from '../boot/daemon-tools/path-guard.js';
import { ELANOUS_RUNTIME_ARTIFACT_DIRS, ELANOUS_RUNTIME_ARTIFACT_PATHS } from './gate-scope.js';
import { runGhCliWithResult, type GhCliResult } from '../git-fs/gh-cli.js';
import { debug } from '../debug/log.js';
import { runGitCommand } from '../git-fs/runner.js';
import type { GitRunResult } from '../git-fs/retry.js';
import type { HarnessTargetResolution } from './harness-target-options.js';

const GIT_TIMEOUT_MS = 30_000;
const ELANOUS_WORK_GLOB = '.elanous/';
const ELANOUS_TEST_GLOB = '.elanous-test/';

interface IgnoreSnapshot {
  path: string;
  backupPath?: string;
  restore(): void;
  discard(): void;
}

export type RepoProvisionResult =
  | { status: 'provisioned'; target: string; resolution: HarnessTargetResolution; ignoreFile: { added: number; preserved: number; created: boolean } }
  | { status: 'already-git'; target: string; resolution: HarnessTargetResolution; ignoreFile: { added: number; preserved: number; created: boolean } }
  | { status: 'not-applicable'; target: string; reason: string };

interface RepoProvisionDeps {
  runGit?: (cwd: string, args: string[]) => GitRunResult;
}

export type RepositoryNameAvailability =
  | { status: 'exists'; repository: string }
  | { status: 'available'; repository: string }
  | { status: 'unknown'; repository: string; reason: string };

export interface RepositoryPublishPreflight {
  target: string;
  repository: string;
  branch?: string;
  head?: string;
  ignored: readonly string[];
  committed: readonly string[];
  credentialCandidates: readonly string[];
  blockers: readonly string[];
  repositoryNameSuggestion?: string;
  remoteAvailability: RepositoryNameAvailability;
}

interface CommittedPathScan {
  paths: readonly string[];
  error?: string;
}

export type RepositoryPublishResult =
  | { status: 'blocked'; report: RepositoryPublishPreflight; guidance: string }
  | { status: 'created'; report: RepositoryPublishPreflight }
  | { status: 'push-failed'; report: RepositoryPublishPreflight; guidance: string };

export interface RepositoryPublishDeps {
  runGit?: (cwd: string, args: string[]) => GitRunResult;
  runGh?: (args: string[]) => GhCliResult;
}

export interface RepositoryVisibilityPreflight extends RepositoryPublishPreflight {
  remote?: string;
}

export type RepositoryVisibilityResult =
  | { status: 'blocked'; report: RepositoryVisibilityPreflight; guidance: string }
  | { status: 'already-public'; report: RepositoryVisibilityPreflight; repository: string }
  | { status: 'promoted'; report: RepositoryVisibilityPreflight; repository: string };

export type RepositoryRemoteVisibility =
  | { status: 'private'; repository: string }
  | { status: 'public'; repository: string }
  | { status: 'blocked'; guidance: string };

function gitResult(cwd: string, args: string[], deps: Pick<RepositoryPublishDeps, 'runGit'>): GitRunResult {
  return (deps.runGit ?? ((dir, command) => runGitCommand(dir, command, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS })))(cwd, args);
}

function gitText(cwd: string, args: string[], deps: Pick<RepositoryPublishDeps, 'runGit'>): string | undefined {
  const result = gitResult(cwd, args, deps);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function validRepositoryName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

function suggestRepositoryName(name: string): string {
  const suggestion = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-+/g, '-');
  return suggestion && validRepositoryName(suggestion) ? suggestion : 'repository-name';
}

function repositoryNameAvailability(repository: string, deps: RepositoryPublishDeps): RepositoryNameAvailability {
  const runGh = deps.runGh ?? runGhCliWithResult;
  const auth = runGh(['api', 'user', '--jq', '.login']);
  if (!auth.ok) return { status: 'unknown', repository, reason: 'GitHub.com authentication or current owner lookup is unavailable' };
  const owner = auth.stdout.toString().trim();
  if (!owner) return { status: 'unknown', repository, reason: 'GitHub current owner lookup returned no owner' };
  const remote = runGh(['api', `repos/${owner}/${repository}`]);
  if (remote.ok) return { status: 'exists', repository: `${owner}/${repository}` };
  if (remote.exitCode === 1 && /\b404\b|not found/i.test(Buffer.concat([remote.stderr, remote.stdout]).toString())) {
    return { status: 'available', repository: `${owner}/${repository}` };
  }
  return { status: 'unknown', repository: `${owner}/${repository}`, reason: `GitHub repository availability lookup failed (exit ${remote.exitCode})` };
}

export function resolveRepositoryRoot(cwd: string, deps: Pick<RepositoryPublishDeps, 'runGit'> = {}): string | undefined {
  return gitText(cwd, ['rev-parse', '--show-toplevel'], deps);
}

function remoteOriginUrl(cwd: string, deps: Pick<RepositoryPublishDeps, 'runGit'>): string | undefined {
  return gitText(cwd, ['remote', 'get-url', 'origin'], deps);
}

function remoteRepository(cwd: string, deps: Pick<RepositoryPublishDeps, 'runGit'>): string | undefined {
  const remote = remoteOriginUrl(cwd, deps);
  if (!remote) return undefined;
  const https = /^https:\/\/([^/?#:]+)(?::\d+)?\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/.exec(remote);
  const ssh = /^(?:ssh:\/\/)?git@([^/:]+)(?::\d+)?[/:]([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/.exec(remote);
  const match = https ?? ssh;
  if (!match || match[1].toLowerCase() !== 'github.com') return undefined;
  return `${match[2]}/${match[3]}`;
}

function remoteCommittedPaths(cwd: string, deps: Pick<RepositoryPublishDeps, 'runGit'>): CommittedPathScan {
  const origin = remoteOriginUrl(cwd, deps);
  if (!origin) return { paths: [] };
  const scanDirectory = mkdtempSync(join(tmpdir(), 'elanous-public-scan-'));
  try {
    if (gitResult(scanDirectory, ['init', '--bare'], deps).status !== 0) {
      return { paths: [], error: 'could not initialize isolated repository history scan' };
    }
    const fetched = gitResult(scanDirectory, ['fetch', '--no-write-fetch-head', origin, '+refs/*:refs/remotes/public-scan/*'], deps);
    if (fetched.status !== 0) return { paths: [], error: 'could not synchronize every advertised GitHub origin ref before scanning public scope' };
    return committedPaths(scanDirectory, deps);
  } finally {
    rmSync(scanDirectory, { recursive: true, force: true });
  }
}

function visibilityReport(target: string, deps: Pick<RepositoryPublishDeps, 'runGit'>): RepositoryVisibilityPreflight {
  const remote = remoteRepository(target, deps);
  return {
    target,
    repository: basename(target),
    ignored: [],
    committed: [],
    credentialCandidates: [],
    blockers: remote ? [] : ['target must have a GitHub.com origin remote before it can be made public'],
    remoteAvailability: { status: 'unknown', repository: basename(target), reason: 'repository availability is not applicable to a visibility transition' },
    ...(remote ? { remote } : {}),
  };
}

export function repositoryRemoteVisibilityForTarget(target: string, deps: RepositoryPublishDeps): RepositoryRemoteVisibility {
  return repositoryRemoteVisibility(visibilityReport(target, deps), deps);
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function matchingVisibilityPreflight(confirmed: RepositoryVisibilityPreflight, report: RepositoryVisibilityPreflight): boolean {
  return confirmed.target === report.target
    && confirmed.repository === report.repository
    && confirmed.remote === report.remote
    && confirmed.branch === report.branch
    && confirmed.head === report.head
    && samePaths(confirmed.ignored, report.ignored)
    && samePaths(confirmed.committed, report.committed)
    && samePaths(confirmed.credentialCandidates, report.credentialCandidates)
    && confirmed.remoteAvailability.status === report.remoteAvailability.status
    && confirmed.remoteAvailability.repository === report.remoteAvailability.repository
    && confirmed.blockers.length === 0;
}

function workingTreePaths(root: string, current = root): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const absolute = join(current, entry.name);
    const path = join(current === root ? '' : current.slice(root.length + 1), entry.name);
    if (entry.isDirectory()) paths.push(...workingTreePaths(root, absolute));
    else paths.push(path);
  }
  return paths;
}

function committedPaths(cwd: string, deps: Pick<RepositoryPublishDeps, 'runGit'>): CommittedPathScan {
  const revisions = gitResult(cwd, ['rev-list', '--all'], deps);
  if (revisions.status !== 0) return { paths: [], error: 'could not scan reachable repository history (git rev-list --all failed)' };
  const paths = new Set<string>();
  for (const commit of revisions.stdout.trim().split('\n').filter(Boolean)) {
    const tree = gitResult(cwd, ['ls-tree', '-r', '--name-only', commit], deps);
    if (tree.status !== 0) return { paths: [], error: `could not scan reachable repository history (git ls-tree failed for ${commit})` };
    for (const path of tree.stdout.split('\n').filter(Boolean)) paths.add(path.replace(/\\/g, '/'));
  }
  return { paths: [...paths].sort() };
}

/** Read-only publication gate. It reports the exact ignore policy, reachable committed paths,
 * and sensitive candidates before any GitHub operation is eligible to run. */
export function preflightRepositoryPublish(target: string, deps: RepositoryPublishDeps = {}, checkAvailability = true): RepositoryPublishPreflight {
  const cwd = target;
  const repository = basename(cwd);
  const branch = gitText(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], deps);
  const head = gitText(cwd, ['rev-parse', '--verify', 'HEAD'], deps);
  const scan = committedPaths(cwd, deps);
  const committed = scan.paths;
  const credentialCandidates = [...new Set([...committed, ...workingTreePaths(cwd)]
    .map((path) => path.replace(/\\/g, '/'))
    .filter((path) => SENSITIVE_PATTERNS.some((pattern) => pattern.test(path))))].sort();
  const blockers: string[] = [];
  const nameIsValid = validRepositoryName(repository);
  const repositoryNameSuggestion = nameIsValid ? undefined : suggestRepositoryName(repository);
  if (scan.error) blockers.push(scan.error);
  if (!nameIsValid) blockers.push(`directory name ${JSON.stringify(repository)} is not a valid GitHub repository name; rename it to a name using letters, numbers, '.', '_', or '-' and starting with a letter or number (for example ${JSON.stringify(repositoryNameSuggestion)})`);
  if (gitText(cwd, ['rev-parse', '--is-inside-work-tree'], deps) !== 'true') blockers.push('target is not a git work tree');
  if (!head) blockers.push('repository has no HEAD commit');
  if (!branch) blockers.push('HEAD is detached or has no branch');
  if (gitText(cwd, ['remote'], deps)) blockers.push('repository already has a remote');
  if (credentialCandidates.length) blockers.push(`credential candidates are committed: ${credentialCandidates.join(', ')}`);
  const remoteAvailability = nameIsValid && blockers.length === 0 && checkAvailability
    ? repositoryNameAvailability(repository, deps)
    : { status: 'unknown' as const, repository, reason: !checkAvailability ? 'GitHub availability was not checked for this preflight' : nameIsValid ? 'GitHub availability was not checked because local preflight is blocked' : 'GitHub availability was not checked because the directory name is invalid' };
  if (remoteAvailability.status === 'exists') blockers.push(`GitHub repository ${remoteAvailability.repository} already exists`);
  if (remoteAvailability.status === 'unknown' && nameIsValid && blockers.length === 0) blockers.push(`GitHub repository availability could not be confirmed: ${remoteAvailability.reason}`);
  const report = { target: cwd, repository, ...(branch ? { branch } : {}), ...(head ? { head } : {}), ignored: [...SENSITIVE_GLOBS], committed, credentialCandidates, blockers, ...(repositoryNameSuggestion ? { repositoryNameSuggestion } : {}), remoteAvailability };
  debug.log('repo-provision', 'publish-preflight', { target: cwd, repository, branch: branch ?? null, ignored: report.ignored, committed, credentialCandidates, blockers, repositoryNameSuggestion: repositoryNameSuggestion ?? null, remoteAvailability });
  return report;
}

/** Read-only public-visibility gate. It scans advertised origin history in an isolated bare
 * repository so the target work tree receives neither fetched objects nor temporary refs. */
export function preflightRepositoryVisibility(target: string, deps: RepositoryPublishDeps = {}): RepositoryVisibilityPreflight {
  const remote = remoteRepository(target, deps);
  const publish = preflightRepositoryPublish(target, deps, false);
  const remoteScan = remote ? remoteCommittedPaths(target, deps) : { paths: [] };
  const committed = [...new Set([...publish.committed, ...remoteScan.paths])].sort();
  const credentialCandidates = [...new Set([...committed, ...workingTreePaths(target)]
    .map((path) => path.replace(/\\/g, '/'))
    .filter((path) => SENSITIVE_PATTERNS.some((pattern) => pattern.test(path))))].sort();
  const blockers = [...publish.blockers.filter((blocker) => blocker !== 'repository already has a remote')];
  if (!remote) blockers.push('target must have a GitHub.com origin remote before it can be made public');
  if (remoteScan.error) blockers.push(remoteScan.error);
  if (credentialCandidates.length && !blockers.some((blocker) => blocker.startsWith('credential candidates are committed:'))) {
    blockers.push(`credential candidates are committed: ${credentialCandidates.join(', ')}`);
  }
  const report = { ...publish, ...(remote ? { remote } : {}), committed, credentialCandidates, blockers };
  debug.log('repo-provision', 'visibility-preflight', {
    target,
    repository: report.repository,
    remote: remote ?? null,
    ignored: report.ignored,
    committed: report.committed,
    credentialCandidates: report.credentialCandidates,
    blockers,
  });
  return report;
}

export function repositoryRemoteVisibility(report: RepositoryVisibilityPreflight, deps: RepositoryPublishDeps): RepositoryRemoteVisibility {
  if (!report.remote) return { status: 'blocked', guidance: 'GitHub origin repository is unavailable; resolve the remote and retry.' };
  const runGh = deps.runGh ?? runGhCliWithResult;
  const visibility = runGh(['repo', 'view', report.remote, '--json', 'isPrivate']);
  if (!visibility.ok) return { status: 'blocked', guidance: 'Verify GitHub.com authentication and access to the origin repository, then run repo public again.' };
  try {
    const parsed: unknown = JSON.parse(visibility.stdout.toString());
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { isPrivate?: unknown }).isPrivate !== 'boolean') {
      return { status: 'blocked', guidance: 'GitHub returned an unreadable visibility response; verify the repository and retry.' };
    }
    return (parsed as { isPrivate: boolean }).isPrivate
      ? { status: 'private', repository: report.remote }
      : { status: 'public', repository: report.remote };
  } catch {
    return { status: 'blocked', guidance: 'GitHub returned an unreadable visibility response; verify the repository and retry.' };
  }
}

/** Makes an existing private GitHub repository public only after the caller confirms the exact
 * preflight report. A changed scan requires a fresh confirmation; an already-public remote is a no-op. */
export function makeRepositoryPublic(target: string, deps: RepositoryPublishDeps, confirmed: RepositoryVisibilityPreflight): RepositoryVisibilityResult {
  const initialVisibility = repositoryRemoteVisibilityForTarget(target, deps);
  if (initialVisibility.status === 'public') {
    const report = visibilityReport(target, deps);
    debug.log('repo-provision', 'already-public', { target, repository: report.repository, remote: report.remote, at: new Date().toISOString() });
    return { status: 'already-public', report, repository: initialVisibility.repository };
  }
  const report = preflightRepositoryVisibility(target, deps);
  const remoteVisibility = repositoryRemoteVisibility(report, deps);
  if (remoteVisibility.status === 'public') {
    debug.log('repo-provision', 'already-public', { target, repository: report.repository, remote: report.remote, at: new Date().toISOString() });
    return { status: 'already-public', report, repository: remoteVisibility.repository };
  }
  if (!confirmed || !matchingVisibilityPreflight(confirmed, report) || report.blockers.length !== 0) {
    const changed = { ...report, blockers: [...report.blockers, 'repository state changed after confirmation; review the new report and confirm again'] };
    const guidance = report.credentialCandidates.length
      ? 'Remove the listed credential files from every reachable ref and the working tree, commit the removal, then run repo public again.'
      : 'Review the current repository state, resolve the listed blockers, then run repo public again.';
    debug.log('repo-provision', 'visibility-blocked', { target, repository: report.repository, remote: report.remote ?? null, blockers: changed.blockers, credentialCandidates: report.credentialCandidates }, { level: 'error' });
    return { status: 'blocked', report: changed, guidance };
  }
  if (remoteVisibility.status === 'blocked') {
    debug.log('repo-provision', 'visibility-blocked', { target, repository: report.repository, remote: report.remote, blockers: ['GitHub repository visibility response was invalid'] }, { level: 'error' });
    return { status: 'blocked', report, guidance: remoteVisibility.guidance };
  }
  const runGh = deps.runGh ?? runGhCliWithResult;
  const changed = runGh(['repo', 'edit', report.remote!, '--visibility', 'public', '--accept-visibility-change-consequences']);
  if (!changed.ok) {
    debug.log('repo-provision', 'visibility-failed', { target, repository: report.repository, remote: report.remote, stage: 'make-public', exitCode: changed.exitCode }, { level: 'error' });
    return { status: 'blocked', report, guidance: 'GitHub did not change repository visibility; verify permissions and retry.' };
  }
  debug.log('repo-provision', 'made-public', { target, repository: report.repository, remote: report.remote, from: 'private', to: 'public', ignored: report.ignored, committed: report.committed, at: new Date().toISOString() });
  return { status: 'promoted', report, repository: report.remote! };
}

/** Creates only a private GitHub repository and pushes the current branch after a caller has
 * performed an explicit affirmative confirmation. A supplied report must still match the live
 * repository state; any change requires a new confirmation rather than publishing a different ref. */
export function publishRepository(target: string, deps: RepositoryPublishDeps, confirmed: RepositoryPublishPreflight): RepositoryPublishResult {
  const report = preflightRepositoryPublish(target, deps);
  if (!confirmed) {
    const blockers = ['explicit affirmative confirmation report is required before creating a remote'];
    debug.log('repo-provision', 'publish-blocked', { target, repository: report.repository, blockers }, { level: 'error' });
    return { status: 'blocked', report: { ...report, blockers: [...report.blockers, ...blockers] }, guidance: 'Review the preflight report and explicitly confirm the exact branch before publishing.' };
  }
  if (confirmed.target !== report.target || confirmed.repository !== report.repository || confirmed.branch !== report.branch || confirmed.head !== report.head || confirmed.remoteAvailability.status !== report.remoteAvailability.status || confirmed.remoteAvailability.repository !== report.remoteAvailability.repository || confirmed.blockers.length !== 0 || report.blockers.length !== 0) {
    const changed = { ...report, blockers: [...report.blockers, 'repository state changed after confirmation; review the new report and confirm again'] };
    debug.log('repo-provision', 'publish-blocked', { target, repository: report.repository, blockers: changed.blockers }, { level: 'error' });
    return { status: 'blocked', report: changed, guidance: 'Review the changed repository state, then run the command again to confirm the exact branch.' };
  }
  if (report.blockers.length) {
    const guidance = report.credentialCandidates.length
      ? 'Remove the listed credential files from every reachable ref, commit the removal, then run the command again.'
      : 'Resolve the listed preflight blockers, then run the command again.';
    debug.log('repo-provision', 'publish-blocked', { target, repository: report.repository, blockers: report.blockers, credentialCandidates: report.credentialCandidates }, { level: 'error' });
    return { status: 'blocked', report, guidance };
  }
  const runGh = deps.runGh ?? runGhCliWithResult;
  const auth = runGh(['auth', 'status', '--hostname', 'github.com']);
  if (!auth.ok) {
    debug.log('repo-provision', 'publish-blocked', { target, repository: report.repository, blockers: ['GitHub.com authentication is unavailable'] }, { level: 'error' });
    return { status: 'blocked', report: { ...report, blockers: ['GitHub.com authentication is unavailable'] }, guidance: 'Authenticate with GitHub.com, then run the command again.' };
  }
  const created = runGh(['repo', 'create', report.repository, '--private', '--source', target, '--remote', 'origin']);
  if (!created.ok) {
    debug.log('repo-provision', 'publish-failed', { target, repository: report.repository, stage: 'create', exitCode: created.exitCode }, { level: 'error' });
    return { status: 'blocked', report: { ...report, blockers: ['GitHub private repository creation failed'] }, guidance: 'Check GitHub permissions and repository-name availability, then retry.' };
  }
  const refspec = `${report.head!}:refs/heads/${report.branch!}`;
  const pushed = gitResult(target, ['push', '-u', 'origin', refspec], deps);
  if (pushed.status !== 0) {
    debug.log('repo-provision', 'publish-failed', { target, repository: report.repository, branch: report.branch, head: report.head, refspec, stage: 'push', status: pushed.status }, { level: 'error' });
    return { status: 'push-failed', report, guidance: `Remote ${report.repository} was created; push ${refspec} manually after resolving the Git error.` };
  }
  debug.log('repo-provision', 'published', { target, repository: report.repository, branch: report.branch, head: report.head, refspec, visibility: 'private', at: new Date().toISOString() });
  return { status: 'created', report };
}

function gitFailure(args: string[], result: GitRunResult): never {
  const output = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
  throw new Error(`repo provision git ${args.join(' ')} failed${output ? `: ${output}` : ''}`);
}

/** ⛔ 단계마다 «한 줄»을 남긴다 — 「승격했다」만 남기면 «어느 단계에서» 멎었는지를 사후에 못 센다
 *  (무인 리뷰 must-fix · 2026-08-18 `#10120`). 축마다 한 칸이고 배열로 담지 않는다. */
function runGit(cwd: string, args: string[], deps: RepoProvisionDeps, step: string): void {
  const result = (deps.runGit ?? ((dir, command) => runGitCommand(dir, command, {
    encoding: 'utf8', timeout: GIT_TIMEOUT_MS,
  })))(cwd, args);
  debug.log('repo-provision', 'step', { target: cwd, step, ok: result.status === 0, status: result.status });
  if (result.status !== 0) gitFailure(args, result);
}

function replaceFileAtomically(path: string, contents: string, mode?: number): void {
  const temporary = join(dirname(path), `.${randomUUID()}.repo-provision`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', mode === undefined ? 0o600 : mode);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function prepareIgnoreSnapshot(target: string): IgnoreSnapshot {
  const path = join(target, '.gitignore');
  if (!existsSync(path)) {
    return {
      path,
      restore: () => rmSync(path, { force: true }),
      discard: () => {},
    };
  }
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('repo provision refuses a non-regular .gitignore');
  }
  const backupPath = join(target, `.${randomUUID()}.repo-provision-backup`);
  renameSync(path, backupPath);
  let backupActive = true;
  return {
    path,
    // ⛔ 이 칸을 «빠뜨리면» ensureIgnoreFile 이 원본을 못 읽어 사람이 쓴 무시 규칙이 «조용히 사라진다».
    //   📏 실측(2026-08-18): my-secret-rule/·build/ 를 담은 .gitignore 가 승격 뒤 «둘 다» 없어졌고
    //      자식 테스트 14개가 그것을 «한 건도» 안 덮었다. 회귀를 같은 PR 에 둔다.
    backupPath,
    restore: () => {
      if (!backupActive) return;
      rmSync(path, { force: true });
      renameSync(backupPath, path);
      backupActive = false;
    },
    discard: () => {
      if (!backupActive) return;
      rmSync(backupPath, { force: true });
      backupActive = false;
    },
  };
}

/** 돌려주는 두 수는 관측용이다 — 「몇 줄을 더했나」와 「사람이 쓴 줄이 몇 줄 살았나」.
 *  ⛔ 「추가됐나」와 「기존 것이 살아 있나」는 다른 값이라 «둘 다» 센다. */
/** elanous 가 관리하는 무시 항목(단일 출처). */
function managedIgnoreEntries(): string[] {
  return [
    ...SENSITIVE_GLOBS,
    'node_modules/',
    '.env*',
    'dist/',
    '.DS_Store',
    ELANOUS_WORK_GLOB,
    ELANOUS_TEST_GLOB,
    ...ELANOUS_RUNTIME_ARTIFACT_DIRS,
    ...ELANOUS_RUNTIME_ARTIFACT_PATHS,
  ].filter((entry, index, all) => all.indexOf(entry) === index);
}

/**
 * ⛔ 2026-09-23 (재현 판 실측) — `.gitignore` 를 작업 디렉토리에 «untracked» 로만 쓰면, 자식은 커밋된 HEAD 에서 만든
 *   «별도 워크트리»에서 일하므로 그 규칙이 없다(`check-ignore` 무반응) ⇒ `.elanous/debug/*.log` 가 또 커밋·diff 에 섞였다.
 *   공통 git 디렉토리의 `info/exclude` 는 «모든 워크트리»에 먹고 추적 파일을 안 건드린다 ⇒ 같은 항목을 거기에도 쓴다.
 */
export function ensureInfoExclude(repoRoot: string): { added: number; path: string } | null {
  const r = runGitCommand(repoRoot, ['rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  const common = r.stdout.trim();
  const dir = join(isAbsolute(common) ? common : join(repoRoot, common), 'info');
  const path = join(dir, 'exclude');
  mkdirSync(dir, { recursive: true });
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const additions = managedIgnoreEntries().filter((e) => !lines.includes(e));
  if (additions.length > 0) {
    const prefix = existsSync(path) && !readFileSync(path, 'utf8').endsWith('\n') && readFileSync(path, 'utf8').length > 0 ? '\n' : '';
    appendFileSync(path, `${prefix}# elanous runtime artifacts (repo-provision)\n${additions.join('\n')}\n`);
  }
  return { added: additions.length, path };
}

function ensureIgnoreFile(snapshot: IgnoreSnapshot): { added: number; preserved: number; created: boolean } {
  const current = snapshot.backupPath ? readFileSync(snapshot.backupPath, 'utf8') : '';
  const lines = current.split(/\r?\n/).filter(Boolean);
  const managedEntries = managedIgnoreEntries();
  const additions = managedEntries.filter((glob) => !lines.includes(glob));
  const preserved = lines.filter((line) => !managedEntries.includes(line)).length;
  if (additions.length === 0) {
    snapshot.restore();
    return { added: 0, preserved, created: false };
  }
  replaceFileAtomically(
    snapshot.path,
    `${current}${current && !current.endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`,
    snapshot.backupPath ? lstatSync(snapshot.backupPath).mode : undefined,
  );
  return { added: additions.length, preserved, created: !snapshot.backupPath };
}

interface GitSnapshot {
  restore(): void;
  discard(): void;
}

function assertSafeGitTree(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('repo provision refuses a linked or non-directory .git');
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const childStats = lstatSync(child);
    if (childStats.isSymbolicLink()) {
      throw new Error('repo provision refuses a linked .git entry');
    }
    if (childStats.isFile() && childStats.nlink > 1) {
      throw new Error('repo provision refuses a hard-linked .git file');
    }
    if (childStats.isDirectory()) assertSafeGitTree(child);
  }
}

function snapshotGitDirectory(target: string): GitSnapshot | undefined {
  const gitPath = join(target, '.git');
  if (!existsSync(gitPath)) return undefined;
  assertSafeGitTree(gitPath);
  const snapshotRoot = mkdtempSync(join(tmpdir(), 'repo-provision-git-'));
  const snapshotPath = join(snapshotRoot, '.git');
  cpSync(gitPath, snapshotPath, { recursive: true, dereference: false, preserveTimestamps: true });
  return {
    restore: () => {
      rmSync(gitPath, { recursive: true, force: true });
      cpSync(snapshotPath, gitPath, { recursive: true, dereference: false, preserveTimestamps: true });
      rmSync(snapshotRoot, { recursive: true, force: true });
    },
    discard: () => rmSync(snapshotRoot, { recursive: true, force: true }),
  };
}

function rollbackProvision(target: string, ignoreSnapshot: IgnoreSnapshot, gitSnapshot: GitSnapshot | undefined): void {
  ignoreSnapshot.restore();
  if (gitSnapshot) gitSnapshot.restore();
  else rmSync(join(target, '.git'), { recursive: true, force: true });
}

/** Promotes an already-classified non-git directory in place; it never re-resolves the target. */
export function provisionRepository(
  target: HarnessTargetResolution,
  deps: RepoProvisionDeps = {},
): RepoProvisionResult {
  debug.log('repo-provision', 'classified', { target: target.canonicalTarget ?? target.target, status: target.status });
  if (target.status === 'git-repo') {
    const cwd = target.repoRoot ?? target.canonicalTarget ?? target.target;
    const ignoreSnapshot = prepareIgnoreSnapshot(cwd);
    let ignoreFile: { added: number; preserved: number; created: boolean };
    try {
      ignoreFile = ensureIgnoreFile(ignoreSnapshot);
      debug.log('repo-provision', 'step', { target: cwd, step: 'ignore', ok: true, ...ignoreFile });
      try {
        const excl = ensureInfoExclude(cwd);
        debug.log('repo-provision', 'step', { target: cwd, step: 'info-exclude', ok: excl !== null, ...(excl ?? {}) });
      } catch (error) {
        debug.log('repo-provision', 'step', { target: cwd, step: 'info-exclude', ok: false, reason: String(error) }, { level: 'warn' });
      }
    } catch (error) {
      try {
        ignoreSnapshot.restore();
      } catch (rollbackError) {
        debug.log('repo-provision', 'failed', {
          target: cwd,
          status: target.status,
          reason: String(error),
          rolledBack: false,
          rollbackReason: String(rollbackError),
        }, { level: 'error' });
      }
      debug.log('repo-provision', 'step', { target: cwd, step: 'ignore', ok: false, reason: String(error) }, { level: 'error' });
      throw error;
    }
    ignoreSnapshot.discard();
    const result = {
      status: 'already-git' as const,
      target: cwd,
      resolution: target,
      ignoreFile,
    };
    debug.log('repo-provision', 'skipped', { target: result.target, reason: result.status });
    return result;
  }
  if (target.status !== 'non-git-dir' || !target.canonicalTarget) {
    const result = { status: 'not-applicable' as const, target: target.canonicalTarget ?? target.target, reason: target.status };
    debug.log('repo-provision', 'skipped', { target: result.target, reason: result.reason });
    return result;
  }

  const cwd = target.canonicalTarget;
  // ⛔ 준비 단계도 «try 안»이다 — 밖에 두면 여기서 죽었을 때 관측이 «한 줄도» 안 남고
  //   「승격을 시도조차 안 했다」와 「준비에서 멎었다」가 같은 모양이 된다(회귀가 실측으로 잡았다).
  let gitSnapshot: GitSnapshot | undefined;
  let ignoreSnapshot: IgnoreSnapshot | undefined;
  let ignoreFile: { added: number; preserved: number; created: boolean } | undefined;
  try {
    gitSnapshot = snapshotGitDirectory(cwd);
    ignoreSnapshot = prepareIgnoreSnapshot(cwd);
    // ⛔ 성공 «뒤»에 한 번만 남긴다 — 앞뒤로 두 번 남기면 「단계당 한 줄」이 깨지고
    //   세는 사람이 같은 단계를 두 번 센다(무인 리뷰 should-fix · 2026-08-18 `#10120` 4R).
    debug.log('repo-provision', 'step', { target: cwd, step: 'prepare', ok: true });
  } catch (error) {
    debug.log('repo-provision', 'step', { target: cwd, step: 'prepare', ok: false, reason: String(error) }, { level: 'error' });
    debug.log('repo-provision', 'failed', {
      target: cwd, status: target.status, reason: String(error), rolledBack: true, stage: 'prepare',
    }, { level: 'error' });
    throw error;
  }
  try {
    debug.log('repo-provision', 'promoting', { target: cwd, status: target.status });
    runGit(cwd, ['init'], deps, 'init');
    runGit(cwd, ['config', 'user.email', 'elanous-repo-provision@local'], deps, 'config-email');
    runGit(cwd, ['config', 'user.name', 'elanous-repo-provision'], deps, 'config-name');
    // ⛔ 실패도 «한 줄»을 남긴다 — 안 남기면 「ignore 단계가 없다」와 「거기서 죽었다」가 같은 모양이 된다
    //   (무인 리뷰 must-fix · 2026-08-18 `#10120` 3R). 침묵이 정상과 구별 안 되면 그 자는 거짓을 생산한다.
    try {
      ignoreFile = ensureIgnoreFile(ignoreSnapshot!);
      debug.log('repo-provision', 'step', { target: cwd, step: 'ignore', ok: true, ...ignoreFile });
    } catch (error) {
      debug.log('repo-provision', 'step', { target: cwd, step: 'ignore', ok: false, reason: String(error) }, { level: 'error' });
      throw error;
    }
    // Keep the rollback snapshot until commit succeeds without staging it.
    runGit(cwd, ignoreSnapshot!.backupPath
      ? ['add', '-A', '--', '.', `:(exclude)${basename(ignoreSnapshot!.backupPath)}`]
      : ['add', '-A'], deps, 'add');
    runGit(cwd, ['commit', '--allow-empty', '-m', 'Initial repository baseline'], deps, 'commit');
  } catch (error) {
    // ⛔ 롤백 «자신»이 실패해도 원래 오류를 잃지 않는다 — 복구 실패가 원인을 덮으면
    //   사람은 「무엇 때문에 멎었나」를 영영 못 찾는다(무인 리뷰 should-fix · 2026-08-18 `#10120` 3R).
    //   ⇒ 복구 실패는 «별도 값»으로 남기고, 던지는 것은 «원래» 오류다.
    let rollbackError: unknown;
    try {
      rollbackProvision(cwd, ignoreSnapshot!, gitSnapshot);
    } catch (failure) {
      rollbackError = failure;
    }
    debug.log('repo-provision', 'failed', {
      target: cwd,
      status: target.status,
      reason: String(error),
      rolledBack: rollbackError === undefined,
      ...(rollbackError === undefined ? {} : { rollbackReason: String(rollbackError) }),
    }, { level: 'error' });
    throw error;
  }
  ignoreSnapshot?.discard();
  gitSnapshot?.discard();
  const resolution: HarnessTargetResolution = {
    ...target,
    status: 'git-repo',
    kind: 'git-repo',
    repoRoot: cwd,
  };
  const result = { status: 'provisioned' as const, target: cwd, resolution, ignoreFile: ignoreFile! };
  debug.log('repo-provision', 'provisioned', { target: result.target, status: result.status });
  return result;
}
