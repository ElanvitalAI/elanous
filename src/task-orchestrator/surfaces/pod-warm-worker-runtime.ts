/** In-Pod warm worker. This module does not create a Pod or select a gate result. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { warmReferenceFromJobArtifacts } from '../../../scripts/release-loop/gate-warm-artifacts.js';
import { stateDirSourceForChild } from '../../agent/identity-env.js';
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
    removeScratch?: (path: string) => void;
    now?: () => number;
  }) {}

  handle(command: WarmWorkerCommand): Promise<WarmWorkerOutcome> {
    const next = this.tail.then(() => this.execute(command)).catch((): WarmWorkerOutcome => {
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
      || !token(command.envProfile) || (command.baselineSha !== undefined && !sha(command.baselineSha))
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
    if (!warmWorkerSourceMatches(repo, command.cutSha, command.key.lockHash)) {
      this.quarantined = true;
      return { reply: null, quarantineWorker: true, reason: 'quarantined' };
    }
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
}
