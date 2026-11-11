import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface CronGitCredentialJob { id: string; remote: string; cwd: string; direction?: 'fetch' | 'push' }
export type CronGitCredentialObservation = { id: string; status: 'ready' | 'unmeasured' | 'unsupported';
  reason: 'credential-present' | 'credential-unavailable' | 'non-https-or-invalid' };
type CommandResult = { status: number | null; stdout: string };
type CredentialCommand = (input: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number) => CommandResult | Promise<CommandResult>;
type RemoteCommand = (remote: string, env: NodeJS.ProcessEnv, cwd: string, direction: 'fetch' | 'push', timeoutMs: number) => CommandResult | Promise<CommandResult>;
const CREDENTIAL_PROBE_TIMEOUT_MS = 10_000;
// Source: #36783 original spawnSync maxBuffer; retained to bound captured helper output.
const COMMAND_OUTPUT_MAX_BYTES = 1_024 * 1_024;
// Source: #36783 Terra must-fix — allow TERM cleanup before killing the remaining process group.
const PROCESS_GROUP_KILL_GRACE_MS = 250;

function runGit(args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number, input?: string): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn('git', args, { env, cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let closeObserved = false;
    let closeStatus: number | null = null;
    let forcedGroupCleanup = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch { /* already exited */ }
    };
    const finalize = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ status: timedOut || overflow ? null : status, stdout: timedOut || overflow ? '' : Buffer.concat(stdout).toString('utf8') });
    };
    const finish = (status: number | null) => {
      closeObserved = true;
      closeStatus = status;
      if (timedOut || overflow) {
        if (forcedGroupCleanup) finalize(closeStatus);
        return;
      }
      finalize(status);
    };
    const forceGroupCleanup = () => {
      forceKillTimer = undefined;
      killGroup('SIGKILL');
      forcedGroupCleanup = true;
      if (closeObserved) finalize(closeStatus);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      forceKillTimer = setTimeout(forceGroupCleanup, PROCESS_GROUP_KILL_GRACE_MS);
    }, timeoutMs);
    timeoutTimer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      capturedBytes += chunk.length;
      if (capturedBytes > COMMAND_OUTPUT_MAX_BYTES) {
        overflow = true;
        killGroup('SIGTERM');
        forceKillTimer ??= setTimeout(forceGroupCleanup, PROCESS_GROUP_KILL_GRACE_MS);
      } else stdout.push(chunk);
    });
    child.stderr.on('data', () => { /* drain without retaining stderr or secrets */ });
    child.stdin.on('error', () => { /* command may exit before consuming input */ });
    child.once('error', () => finish(null));
    child.once('close', code => finish(code));
    child.stdin.end(input);
  });
}

const credentialCommand: CredentialCommand = (input, env, cwd, timeoutMs) =>
  runGit(['credential', 'fill'], env, cwd, timeoutMs, input);
const remoteCommand: RemoteCommand = async (remote, env, cwd, direction, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  const run = (args: string[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.resolve({ status: null, stdout: '' });
    return runGit(args, env, cwd, remaining);
  };
  // Git cannot derive a push URL from an unnamed URL when pushInsteadOf is configured.
  // Report uncertainty rather than declaring the fetch credential ready for a push.
  if (direction === 'push') {
    const rules = await run(['config', '--get-regexp', '^url\\..*\\.pushinsteadof$']);
    if (rules.status !== 1) {
      if (rules.status !== 0) return { status: null, stdout: '' };
      const applies = rules.stdout.split(/\r?\n/).some(line => {
        const separator = line.search(/\s/);
        return separator >= 0 && remote.startsWith(line.slice(separator).trimStart());
      });
      if (applies) return { status: null, stdout: '' };
    }
  }
  return run(['ls-remote', '--get-url', remote]);
};

function safeHttpsRemote(value: string): boolean {
  if (!/^https:\/\/[^/?#]+(?:\/|$)/.test(value) || /[\\\r\n\x00-\x1f\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password &&
      !url.search && !url.hash && !value.slice('https://'.length).split('/')[0]?.includes('@');
  } catch { return false; }
}

/** Probe the credential helper in the cron environment; never return helper output or command arguments. */
export async function auditCronGitCredentials(jobs: readonly CronGitCredentialJob[],
  run: CredentialCommand = credentialCommand, env: NodeJS.ProcessEnv = process.env,
  resolveRemote: RemoteCommand = remoteCommand, probeTimeoutMs = CREDENTIAL_PROBE_TIMEOUT_MS): Promise<CronGitCredentialObservation[]> {
  if (new Set(jobs.map(job => job.id)).size !== jobs.length ||
    jobs.some(job => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.id) ||
      typeof job.cwd !== 'string' || !isAbsolute(job.cwd) ||
      (job.direction !== undefined && !['fetch', 'push'].includes(job.direction))))
    throw new Error('invalid cron Git job identity');
  const observations: CronGitCredentialObservation[] = [];
  for (const job of jobs) {
    if (!safeHttpsRemote(job.remote)) {
      observations.push({ id: job.id, status: 'unsupported', reason: 'non-https-or-invalid' });
      continue;
    }
    const probeEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false',
      GCM_INTERACTIVE: 'never', GIT_CREDENTIAL_INTERACTIVE: 'never' };
    const deadline = Date.now() + probeTimeoutMs;
    const remainingBudget = () => Math.max(0, deadline - Date.now());
    const directions: Array<'fetch' | 'push'> = job.direction ? [job.direction] : ['fetch', 'push'];
    const effectiveUrls: string[] = [];
    for (const direction of directions) {
      let resolved: CommandResult;
      const timeoutMs = remainingBudget();
      if (timeoutMs === 0) {
        observations.push({ id: job.id, status: 'unmeasured', reason: 'credential-unavailable' });
        break;
      }
      try { resolved = await resolveRemote(job.remote, probeEnv, job.cwd, direction, timeoutMs); }
      catch {
        observations.push({ id: job.id, status: 'unmeasured', reason: 'credential-unavailable' });
        break;
      }
      if (resolved.status !== 0 || !resolved.stdout.trim()) {
        observations.push({ id: job.id, status: 'unmeasured', reason: 'credential-unavailable' });
        break;
      }
      effectiveUrls.push(resolved.stdout.trim());
    }
    if (observations.at(-1)?.id === job.id) continue;
    if (effectiveUrls.length > 1 && effectiveUrls[0] !== effectiveUrls[1]) {
      observations.push({ id: job.id, status: 'unmeasured', reason: 'credential-unavailable' });
      continue;
    }
    const effectiveRemote = effectiveUrls[0]!;
    if (!safeHttpsRemote(effectiveRemote)) {
      observations.push({ id: job.id, status: 'unsupported', reason: 'non-https-or-invalid' });
      continue;
    }
    // Git parses url= with its own credential URL rules, including percent-decoded paths.
    const input = `url=${effectiveRemote}\n\n`;
    let result: CommandResult;
    const timeoutMs = remainingBudget();
    if (timeoutMs === 0) {
      observations.push({ id: job.id, status: 'unmeasured', reason: 'credential-unavailable' });
      continue;
    }
    try { result = await run(input, probeEnv, job.cwd, timeoutMs); }
    catch {
      observations.push({ id: job.id, status: 'unmeasured', reason: 'credential-unavailable' });
      continue;
    }
    const fields = result.stdout.split(/\r?\n/).map(line => line.match(/^([^=]+)=(.*)$/))
      .filter((match): match is RegExpMatchArray => match !== null);
    const username = fields.find(field => field[1] === 'username')?.[2];
    const password = fields.find(field => field[1] === 'password')?.[2];
    observations.push(result.status === 0 && username && password
      ? { id: job.id, status: 'ready', reason: 'credential-present' }
      : { id: job.id, status: 'unmeasured', reason: 'credential-unavailable' });
  }
  return observations;
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--jobs-file')
      throw new Error('usage: cron-git-credential-audit.ts --jobs-file <json>');
    let jobs: unknown;
    try { jobs = JSON.parse(readFileSync(process.argv[3]!, 'utf8')); }
    catch { throw new Error('cannot read cron Git jobs file'); }
    if (!Array.isArray(jobs) || jobs.some(job => !job || typeof job !== 'object' ||
      typeof job.id !== 'string' || typeof job.remote !== 'string' || typeof job.cwd !== 'string')) throw new Error('invalid cron Git jobs file');
    const observations = await auditCronGitCredentials(jobs as CronGitCredentialJob[]);
    console.log(JSON.stringify({ observations }));
    if (observations.some(item => item.status !== 'ready')) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'cron Git credential audit failed');
    process.exitCode = 1;
  }
}
