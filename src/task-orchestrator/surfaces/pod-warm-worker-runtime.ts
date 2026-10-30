/** In-Pod warm worker. This module does not create a Pod or select a gate result. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { warmReferenceFromJobArtifacts } from '../../../scripts/release-loop/gate-warm-artifacts.js';
import { stateDirSourceForChild } from '../../agent/identity-env.js';
import { debug } from '../../debug/log.js';
import { decidePodReuseCleanup } from './pod-reuse-cleanup.js';
import { podSourceScript, type PodSource } from './pod-source-receive.js';
import type { WarmWorkerCommand, WarmWorkerFileResult, WarmWorkerReply } from './pod-warm-worker-protocol.js';

const token = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s);
const sha = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const keyValid = (key: WarmWorkerCommand['key'] | undefined): boolean => !!key && token(key.context)
  && typeof key.imageDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(key.imageDigest)
  && typeof key.lockHash === 'string' && /^[a-f0-9]{64}$/.test(key.lockHash)
  && token(key.architecture);
const testPath = (s: unknown): s is string => typeof s === 'string' && s.length < 512
  && /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.test\.tsx?$/.test(s)
  && !s.split('/').some(part => part === '..' || part === '.');
const withoutGitEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  return env;
};

const installedLockHashPath = (repoDir: string): string => join(repoDir, 'node_modules', '.elanous-installed-lock-hash');

function readInstalledLockHash(repoDir: string): string | null {
  try {
    const modules = lstatSync(join(repoDir, 'node_modules'));
    if (!modules.isDirectory() || modules.isSymbolicLink()) return null;
    const marker = installedLockHashPath(repoDir);
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const value = readFileSync(marker, 'utf8').trim();
    return /^[a-f0-9]{64}$/.test(value) ? value : null;
  } catch { return null; }
}

/** Record the image's installed dependency lock once source verification ties it to the worker key. */
function rememberInstalledLockHash(repoDir: string, lockHash: string): void {
  try {
    const modules = lstatSync(join(repoDir, 'node_modules'));
    if (!modules.isDirectory() || modules.isSymbolicLink()) return;
    const marker = installedLockHashPath(repoDir);
    if (existsSync(marker)) return;
    writeFileSync(marker, `${lockHash}\n`, { mode: 0o600, flag: 'wx' });
  } catch { /* an unknown installation stays unknown and min-sync will install before reuse */ }
}

function resolveThroughExistingAncestor(path: string): string | null {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try { return join(realpathSync(ancestor), ...suffix); }
    catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return null;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function hasCheckoutLocalSymlink(repoDir: string, path: string): boolean {
  if (path.split(sep).includes('..')) return true;
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if (!lstatSync(current).isSymbolicLink()) continue;
      const physicalParent = resolveThroughExistingAncestor(dirname(current));
      if (!physicalParent) continue;
      const physicalLink = join(physicalParent, basename(current));
      if (physicalLink === repoDir || physicalLink.startsWith(`${repoDir}${sep}`)) return true;
    } catch { return false; }
  }
  return false;
}

function runtimeDirectoryExclusions(repoDir: string, repoLexicalDir: string, directories: readonly { name: string; path: string }[]) {
  const additionalCleanExclusions: Array<{ name: string; pattern: string }> = [];
  const statusExclusions = new Set<string>();
  for (const directory of directories) {
    const lexical = resolve(directory.path);
    if (hasCheckoutLocalSymlink(repoDir, directory.path)) return null;
    const candidates = new Set([lexical]);
    const resolvedThroughAncestor = resolveThroughExistingAncestor(directory.path);
    if (resolvedThroughAncestor) candidates.add(resolvedThroughAncestor);
    for (const candidate of candidates) {
      const root = candidate.startsWith(`${repoDir}${sep}`) ? repoDir
        : candidate.startsWith(`${repoLexicalDir}${sep}`) ? repoLexicalDir : null;
      if (candidate === repoDir || candidate === repoLexicalDir) return null;
      if (!root) continue;
      const path = relative(root, candidate).split(sep).join('/');
      if (!path || path === '..' || path.startsWith('../')) return null;
      const escaped = path.replace(/[\\*?\[\]]/g, '\\$&');
      const pattern = `/${escaped}/`;
      if (!additionalCleanExclusions.some(item => item.pattern === pattern)) {
        additionalCleanExclusions.push({ name: directory.name, pattern });
      }
      statusExclusions.add(path);
    }
  }
  return { additionalCleanExclusions, statusExclusions: [...statusExclusions] };
}

function remainingGitStatusPaths(statusPorcelainZ: string): string[] {
  const records = statusPorcelainZ.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!/^[ MADRCU?!][ MADRCU?!] /.test(record)) continue;
    paths.push(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2))) i++;
  }
  return paths;
}

export interface WarmWorkerRunFile {
  file: string;
  cutSha: string;
  attemptId: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  junitPath: string;
  deadlineAt: number;
}
export type WarmWorkerFileRunner = (request: WarmWorkerRunFile) => Promise<number>;
type WarmWorkerGitResult = { status: number | null; stdout?: string | null };

/** Recheck the source bytes before every request, not only at Pod init. */
export function warmWorkerSourceMatches(repoDir: string, cutSha: string, lockHash: string): boolean {
  try {
    const env = withoutGitEnvironment();
    const git = (args: string[]) => spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
    const top = git(['rev-parse', '--show-toplevel']);
    const head = git(['rev-parse', 'HEAD']);
    const dirty = git(['status', '--porcelain', '--untracked-files=no']);
    // Git status deliberately trusts assume-unchanged and skip-worktree bits.
    // A reusable Pod cannot trust those bits because tests execute worktree bytes.
    const tracked = git(['ls-files', '-v', '-z']);
    return top.status === 0 && realpathSync(top.stdout.trim()) === realpathSync(repoDir)
      && head.status === 0 && head.stdout.trim() === cutSha
      && dirty.status === 0 && dirty.stdout.trim() === ''
      && tracked.status === 0 && tracked.stdout.split('\0').filter(Boolean).every(entry => entry.startsWith('H '))
      && createHash('sha256').update(readFileSync(join(repoDir, 'bun.lock'))).digest('hex') === lockHash;
  } catch { return false; }
}

export interface WarmWorkerOutcome {
  reply: WarmWorkerReply | null;
  /** A missing or partial result cannot enter the comparator as measured evidence. */
  quarantineWorker: boolean;
  reason: 'complete' | 'invalid-command' | 'missing-artifact' | 'execution-error' | 'cleanup-failed' | 'quarantined';
  artifactsDir?: string;
}

/** One runtime serializes commands so cleanup has completed before the next test can start. */
export class WarmWorkerRuntime {
  private tail: Promise<unknown> = Promise.resolve();
  private quarantined = false;
  constructor(private readonly options: {
    repoDir: string;
    scratchDir: string;
    artifactsRoot: string;
    workerId: string;
    runFile: WarmWorkerFileRunner;
    runGit?: (args: readonly string[]) => WarmWorkerGitResult;
    removeScratch?: (path: string) => void;
    now?: () => number;
    /** POD-REUSE-MIN-SYNC — 새 base 요청의 최소 동기화 원천: 호스트 미러 마운트(기본 /host-mirror). */
    mirrorPath?: string;
    /** POD-REUSE-MIN-SYNC — 부모가 넘긴 git bundle(있으면 호스트 미러보다 먼저). */
    minSyncBundle?: { bundlePath: string; sha256: string; sizeBytes: number };
    /** 시험 심 — min-sync 수신 스크립트 실행(기본: 체크아웃 안에서 bash -c). */
    runMinSync?: (script: string) => { status: number | null; stdout: string; stderr: string };
  }) {}

  handle(command: WarmWorkerCommand): Promise<WarmWorkerOutcome> {
    const next = this.tail.then(() => this.execute(command)).catch((error): WarmWorkerOutcome => {
      this.quarantined = true;
      return { reply: null, quarantineWorker: true, reason: 'execution-error' };
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async execute(command: WarmWorkerCommand): Promise<WarmWorkerOutcome> {
    if (this.quarantined) return { reply: null, quarantineWorker: true, reason: 'quarantined' };
    const now = this.options.now ?? Date.now;
    if (command?.protocol !== 1 || !token(command.runId) || !token(command.attemptId)
      || !sha(command.cutSha) || !token(command.leaseId)
      || !token(command.workerId) || command.workerId !== this.options.workerId
      || !Number.isSafeInteger(command.generation) || command.generation < 1
      || !Number.isFinite(command.deadlineAt)
      || command.envProfile !== 'gate-v1' || (command.baselineSha !== undefined && !sha(command.baselineSha))
      || !keyValid(command.key)
      || !Array.isArray(command.files) || command.files.length === 0
      || command.files.some(file => !testPath(file)) || new Set(command.files).size !== command.files.length) {
      return { reply: null, quarantineWorker: false, reason: 'invalid-command' };
    }
    if (command.deadlineAt <= now()) {
      this.quarantined = true;
      return { reply: null, quarantineWorker: true, reason: 'execution-error' };
    }
    const repo = realpathSync(this.options.repoDir);
    const sourceMatches = warmWorkerSourceMatches(repo, command.cutSha, command.key.lockHash);
    if (sourceMatches && readInstalledLockHash(repo) === null) rememberInstalledLockHash(repo, command.key.lockHash);
    if (!sourceMatches || readInstalledLockHash(repo) !== command.key.lockHash) {
      // POD-REUSE-MIN-SYNC — 같은 웜 Pod 로 들어온 새 base 요청: 상주 체크아웃을 호스트 미러(또는 부모가
      // 넘긴 bundle)에서만 최소 동기화한 뒤 같은 검증으로 다시 본다. min-sync 가 아니거나 실패면
      // 기존 폐기(quarantine) 판정이 그대로 선다.
      if (!this.minSyncReceive(repo, command)
        || !warmWorkerSourceMatches(repo, command.cutSha, command.key.lockHash)
        || readInstalledLockHash(repo) !== command.key.lockHash) {
        this.quarantined = true;
        return { reply: null, quarantineWorker: true, reason: 'quarantined' };
      }
    }
    debug.log('pod.warm', 'resident-checkout-verified', { runId: command.runId,
      attemptId: command.attemptId, workerId: command.workerId,
      checkoutPath: repo, verifiedHead: command.cutSha, verifiedLockHash: command.key.lockHash });
    for (const file of command.files) {
      let target: string;
      try { target = realpathSync(join(repo, file)); }
      catch { return { reply: null, quarantineWorker: false, reason: 'invalid-command' }; }
      if (!target.startsWith(`${repo}${sep}`)) return { reply: null, quarantineWorker: false, reason: 'invalid-command' };
      let component = repo;
      for (const part of file.split('/')) {
        component = join(component, part);
        if (lstatSync(component).isSymbolicLink()) {
          return { reply: null, quarantineWorker: false, reason: 'invalid-command' };
        }
      }
      const env = withoutGitEnvironment();
      const tracked = spawnSync('git', ['-C', repo, 'ls-files', '--error-unmatch', '--', file], { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
      if (tracked.status !== 0 || tracked.stdout.trim() !== file) {
        return { reply: null, quarantineWorker: false, reason: 'invalid-command' };
      }
    }
    const artifactsDir = resolve(this.options.artifactsRoot, command.runId, command.attemptId,
      command.leaseId, String(command.generation), command.workerId);
    const artifactsRoot = resolve(this.options.artifactsRoot);
    if (!artifactsDir.startsWith(`${artifactsRoot}${sep}`) || existsSync(artifactsDir)) {
      return { reply: null, quarantineWorker: false, reason: 'invalid-command' };
    }
    const runtimeExclusions = runtimeDirectoryExclusions(repo, resolve(this.options.repoDir), [
      { name: 'worker scratch directory', path: this.options.scratchDir },
      { name: 'worker artifacts directory', path: artifactsRoot },
    ]);
    if (!runtimeExclusions) {
      this.quarantined = true;
      try { debug.log('pod.reuse', 'clean-failed', {
        runId: command.runId, attemptId: command.attemptId, workerId: command.workerId,
        reason: 'unsafe-runtime-directory', remainingPaths: [],
      }, { level: 'warn' }); } catch { /* observation cannot revive an unsafe worker */ }
      return { reply: null, quarantineWorker: true, reason: 'cleanup-failed', artifactsDir };
    }
    mkdirSync(this.options.scratchDir, { recursive: true });
    mkdirSync(artifactsRoot, { recursive: true });
    mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
    const startedAt = now();
    const files: WarmWorkerFileResult[] = [];
    let reason: WarmWorkerOutcome['reason'] = 'complete';
    for (const [index, file] of command.files.entries()) {
      if (this.quarantined) break;
      const sandbox = mkdtempSync(join(this.options.scratchDir, 'warm-request-'));
      const dirs = Object.fromEntries(['home', 'state', 'tmp', 'config', 'cache', 'data', 'xdg-state', 'xdg-runtime'].map(name => [name, join(sandbox, name)]));
      for (const path of Object.values(dirs)) mkdirSync(path, { mode: 0o700 });
      const prefix = join(artifactsDir, `file-${index}`);
      const env: NodeJS.ProcessEnv = {
        ...withoutGitEnvironment(), HOME: dirs.home, ELANOUS_STATE_DIR: dirs.state,
        ELANOUS_STATE_DIR_SOURCE: stateDirSourceForChild(dirs.state), TMPDIR: dirs.tmp,
        XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache,
        XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs['xdg-state'], XDG_RUNTIME_DIR: dirs['xdg-runtime'],
        TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', ELANOUS_TEST_FAKE_LLM: '1',
      };
      let rc = 1;
      try {
        rc = await this.options.runFile({ file, cutSha: command.cutSha, attemptId: command.attemptId, cwd: this.options.repoDir, env,
          logPath: `${prefix}.log`, junitPath: `${prefix}.junit.xml`, deadlineAt: command.deadlineAt });
        if (rc !== 0 && rc !== 1) reason = 'execution-error';
        writeFileSync(`${prefix}.json`, JSON.stringify({ rc, files: [file], commit: command.cutSha,
          attemptId: command.attemptId, warmKey: command.key, jobExitCode: 0, jobFailed: false }), { mode: 0o600 });
        writeFileSync(`${prefix}.rc`, String(rc), { mode: 0o600 });
        if (existsSync(`${prefix}.log`) && existsSync(`${prefix}.junit.xml`)) {
          const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
          writeFileSync(`${prefix}.warm-manifest.json`, JSON.stringify({
            protocol: 1, cutSha: command.cutSha, attemptId: command.attemptId, file, rc,
            logSha256: sha256(`${prefix}.log`), junitSha256: sha256(`${prefix}.junit.xml`),
            metaSha256: sha256(`${prefix}.json`), rcSha256: sha256(`${prefix}.rc`),
          }), { mode: 0o600 });
        }
        const parsed = warmReferenceFromJobArtifacts(prefix, file,
          { cutSha: command.cutSha, attemptId: command.attemptId });
        if (parsed) files.push(parsed);
        else { reason = 'missing-artifact'; break; }
      } catch {
        reason = 'execution-error';
        break;
      } finally {
        try { (this.options.removeScratch ?? ((path: string) => rmSync(path, { recursive: true } )))(sandbox); }
        catch { this.quarantined = true; reason = 'cleanup-failed'; }
      }
      if (now() >= command.deadlineAt) reason = 'execution-error';
      if (reason !== 'complete') break;
    }
    if (now() >= command.deadlineAt) reason = 'execution-error';
    const sourceMatchedBeforeCleanup = warmWorkerSourceMatches(repo, command.cutSha, command.key.lockHash);
    // A worker accepts another request only after restoring the pinned source and removing prior-request artifacts.
    const cleanupPlan = decidePodReuseCleanup({
      base: command.cutSha,
      resetExitCode: 0,
      cleanExitCode: 0,
      statusExitCode: 0,
      statusPorcelain: '',
      ...runtimeExclusions,
    });
    const git = (args: readonly string[]): WarmWorkerGitResult => {
      try {
        return this.options.runGit?.(args) ?? spawnSync('git', [...args], {
          cwd: repo, encoding: 'utf8', env: withoutGitEnvironment(), maxBuffer: 16 * 1024 * 1024,
        });
      } catch {
        return { status: null, stdout: null };
      }
    };
    const rootMatches = () => {
      const top = git(['rev-parse', '--show-toplevel']);
      if (top.status !== 0 || !top.stdout?.trim()) return false;
      try { return realpathSync(top.stdout.trim()) === repo; } catch { return false; }
    };
    const discard = (reason: string, remainingPaths: readonly string[] = []): WarmWorkerOutcome => {
      this.quarantined = true;
      try { debug.log('pod.reuse', 'clean-failed', {
        runId: command.runId,
        attemptId: command.attemptId,
        workerId: command.workerId,
        reason,
        remainingPaths: remainingPaths.slice(0, 5),
      }, { level: 'warn' }); } catch { /* observation cannot revive an unsafe worker */ }
      return { reply: null, quarantineWorker: true, reason: 'cleanup-failed', artifactsDir };
    };
    if (!rootMatches()) return discard('checkout-root-mismatch');
    const reset = git(cleanupPlan.resetArgs);
    if (reset.status !== 0) {
      const failed = decidePodReuseCleanup({ base: command.cutSha, resetExitCode: reset.status,
        cleanExitCode: null, statusExitCode: null, statusPorcelain: '', ...runtimeExclusions });
      return discard(failed.reason ?? 'reset-failed');
    }
    if (!rootMatches()) return discard('checkout-root-mismatch');
    const clean = git(cleanupPlan.cleanArgs);
    if (clean.status !== 0) {
      const failed = decidePodReuseCleanup({ base: command.cutSha, resetExitCode: 0,
        cleanExitCode: clean.status, statusExitCode: null, statusPorcelain: '', ...runtimeExclusions });
      return discard(failed.reason ?? 'clean-failed');
    }
    if (!rootMatches()) return discard('checkout-root-mismatch');
    const status = git(cleanupPlan.statusArgs);
    if (status.status === 0 && typeof status.stdout !== 'string') return discard('status-output-missing');
    const cleanup = decidePodReuseCleanup({
      base: command.cutSha,
      resetExitCode: reset.status,
      cleanExitCode: clean.status,
      statusExitCode: status.status,
      statusPorcelain: status.stdout ?? '',
      remainingPaths: remainingGitStatusPaths(status.stdout ?? ''),
      ...runtimeExclusions,
    });
    if (cleanup.outcome === 'discard') {
      return discard(cleanup.reason ?? 'unknown', cleanup.remainingPaths);
    }
    if (!sourceMatchedBeforeCleanup) {
      this.quarantined = true;
      return { reply: null, quarantineWorker: true, reason: 'quarantined', artifactsDir };
    }
    if (reason !== 'complete') this.quarantined = true;
    if (reason !== 'complete' || files.length !== command.files.length) return { reply: null, quarantineWorker: true, reason, artifactsDir };
    if (!warmWorkerSourceMatches(repo, command.cutSha, command.key.lockHash)) {
      this.quarantined = true;
      return { reply: null, quarantineWorker: true, reason: 'quarantined', artifactsDir };
    }
    const finishedAt = now();
    if (finishedAt >= command.deadlineAt) {
      this.quarantined = true;
      return { reply: null, quarantineWorker: true, reason: 'execution-error', artifactsDir };
    }
    const reply: WarmWorkerReply = {
      protocol: 1, runId: command.runId, attemptId: command.attemptId, cutSha: command.cutSha,
      ...(command.baselineSha ? { baselineSha: command.baselineSha } : {}), leaseId: command.leaseId,
      generation: command.generation, workerId: command.workerId, key: command.key,
      envProfile: command.envProfile, startedAt, finishedAt, files,
    };
    writeFileSync(join(artifactsDir, 'reply.json'), JSON.stringify(reply), { mode: 0o600 });
    if (now() >= command.deadlineAt) {
      rmSync(join(artifactsDir, 'reply.json'));
      this.quarantined = true;
      return { reply: null, quarantineWorker: true, reason: 'execution-error', artifactsDir };
    }
    return { reply, quarantineWorker: false, reason: 'complete', artifactsDir };
  }

  /** POD-REUSE-MIN-SYNC — 체크아웃 head 또는 실제 설치 lock hash 가 요청과 다를 때만 시도한다.
   *  dirty source bytes 는 min-sync 대상으로 삼지 않는다. base 는 호스트 미러/부모 bundle 에서만 받는다(GitHub 호출 0) ·
   *  차이 파일만 checkout/reset 하고 남은 untracked·빌드 산출만 clean 한다. 성공 표지
   *  `ELANOUS_POD_STAGE min-sync <호출 수> <바뀐 파일 수> <소요 초>` 를 관측(pod.warm/min-sync)으로 남긴다. */
  private minSyncReceive(repo: string, command: WarmWorkerCommand): boolean {
    const git = (args: readonly string[]): WarmWorkerGitResult => {
      try {
        return this.options.runGit?.(args) ?? spawnSync('git', ['-C', repo, ...args], {
          encoding: 'utf8', env: withoutGitEnvironment(), maxBuffer: 16 * 1024 * 1024,
        });
      } catch { return { status: null, stdout: null }; }
    };
    const resident = git(['rev-parse', 'HEAD']);
    const previousHead = resident.status === 0 ? (resident.stdout ?? '').trim() : '';
    if (!sha(previousHead)) return false;
    const source: PodSource = {
      kind: 'min-sync', baseSha: command.cutSha, previousHead, lockHash: command.key.lockHash,
      ...(this.options.minSyncBundle ? { bundle: this.options.minSyncBundle } : {}),
    };
    const script = podSourceScript(source, 'https://github.com/unused/repo', this.options.mirrorPath ?? '/host-mirror', { checkoutDir: repo });
    let run: { status: number | null; stdout?: string | null };
    try {
      run = this.options.runMinSync?.(script) ?? spawnSync('bash', ['-c', script], {
        encoding: 'utf8', cwd: repo, env: withoutGitEnvironment(), maxBuffer: 16 * 1024 * 1024,
      });
    } catch { return false; }
    const out = run.stdout ?? '';
    const stage = /^ELANOUS_POD_STAGE min-sync (\d+) (\d+) (\d+)\r?$/m.exec(out);
    try {
      debug.log('pod.warm', 'min-sync', { runId: command.runId, attemptId: command.attemptId, workerId: command.workerId,
        baseSha: command.cutSha, previousHead, ok: run.status === 0,
        githubCalls: stage ? Number(stage[1]) : null, changedFiles: stage ? Number(stage[2]) : null, seconds: stage ? Number(stage[3]) : null });
    } catch { /* observation is fail-soft */ }
    return run.status === 0 && !!stage;
  }
}
