import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { debug } from '../debug/log.js';
import { releaseGitDiffPaths, releasePrFilePaths } from '../self-dev/release-path-guard.js';

const defaultExecFile = promisify(execFileCb);
const GIT_TIMEOUT = 20_000;

export type AppApiExecFile = (
  file: string,
  args: readonly string[],
  opts: { cwd: string; encoding: 'utf8'; timeout: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr?: string }>;

let execFileImpl: AppApiExecFile = (file, args, opts) => defaultExecFile(file, [...args], opts);

/** Tests inject the `gh` runner. Production keeps `execFile`. */
export function setAppApiExecFileForTest(impl: AppApiExecFile | undefined): void {
  execFileImpl = impl ?? ((file, args, opts) => defaultExecFile(file, [...args], opts));
}

/** App-token `gh` calls only. Caller names are fixed strings; the token value is never logged. */
const GH_APP_CALLERS = {
  'post-pr-comment-history': 'postPrComment',
  'post-pr-comment': 'postPrComment',
  'find-pr-comment': 'findPrComment',
  'edit-pr-comment': 'editPrComment',
  'add-pr-label-list': 'addPrLabel',
  'add-pr-label-create': 'addPrLabel',
  'add-pr-label': 'addPrLabel',
  'read-pr-files': 'readPrFiles',
} as const;

export type GhAppCaller = keyof typeof GH_APP_CALLERS;

export const APP_API_RATE_LIMIT_RETRY_CAP_MS = 15 * 60_000;

export class AppApiRateLimitError extends Error {
  readonly rateLimited = true as const;
  readonly status: 403 | 429;
  readonly resetAtMs: number | undefined;
  constructor(message: string, status: 403 | 429, resetAtMs: number | undefined) {
    super(message);
    this.name = 'AppApiRateLimitError';
    this.status = status;
    this.resetAtMs = resetAtMs;
  }
}

export function isAppApiRateLimitFailure(status: number | undefined, text: string, remaining?: string): boolean {
  if (remaining === '0') return true;
  if (status !== undefined && status !== 403 && status !== 429) return false;
  return /API rate limit exceeded|rate limit/i.test(text) && (status === 403 || status === 429 || status === undefined);
}

function ghHeader(stderr: string, name: string): string | undefined {
  const match = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(stderr);
  return match?.[1]?.trim();
}

function ghStatusCode(stderr: string, error: unknown): number | undefined {
  const fromHeader = ghHeader(stderr, 'HTTP') ?? ghHeader(stderr, 'status');
  const headerCode = fromHeader ? Number.parseInt(fromHeader, 10) : NaN;
  if (Number.isFinite(headerCode)) return headerCode;
  const text = `${stderr}\n${error instanceof Error ? error.message : String(error ?? '')}`;
  const match = /\b(403|429)\b/.exec(text);
  return match ? Number(match[1]) : undefined;
}

/** Wait until X-RateLimit-Reset, never longer than 15 minutes. Returns false when the reset is already past or unreadable. */
export async function waitForAppApiRateLimitReset(
  resetAtMs: number | undefined,
  now = Date.now(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs)) return false;
  const waitMs = Math.min(Math.max(0, resetAtMs - now), APP_API_RATE_LIMIT_RETRY_CAP_MS);
  if (waitMs <= 0) return false;
  await sleep(waitMs);
  return true;
}

export async function runGhApp(
  caller: GhAppCaller,
  args: readonly string[],
  opts: { cwd: string; encoding: 'utf8'; timeout: number; maxBuffer?: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  let status: number | undefined;
  let error: unknown;
  try {
    const result = await execFileImpl('gh', args, opts);
    stdout = result.stdout;
    stderr = result.stderr ?? '';
    status = 200;
  } catch (caught) {
    error = caught;
    const failed = caught as { stdout?: string; stderr?: string };
    stdout = typeof failed.stdout === 'string' ? failed.stdout : '';
    stderr = typeof failed.stderr === 'string' ? failed.stderr : '';
    status = ghStatusCode(stderr, caught);
  }
  const remaining = ghHeader(stderr, 'X-RateLimit-Remaining');
  debug.log('github.app-api', 'call', {
    caller: GH_APP_CALLERS[caller],
    endpoint: args.filter((arg) => !arg.startsWith('-')).at(-1) ?? 'gh',
    status: status ?? 0,
    remaining: remaining ?? '',
  });
  if (error) {
    const text = `${stderr}\n${error instanceof Error ? error.message : String(error)}`;
    if (isAppApiRateLimitFailure(status, text, remaining)) {
      const reset = ghHeader(stderr, 'X-RateLimit-Reset');
      const resetSeconds = reset ? Number(reset) : NaN;
      throw new AppApiRateLimitError(
        text.trim() || 'API rate limit exceeded',
        status === 429 ? 429 : 403,
        Number.isFinite(resetSeconds) ? resetSeconds * 1000 : undefined,
      );
    }
    throw error;
  }
  return { stdout, stderr };
}

export async function readPrFilesWithRateLimitFallback(input: {
  number: number;
  cwd: string;
  base?: string;
  env: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<string[]> {
  const env = input.env;
  const endpoint = [
    'api', '--paginate', '--slurp', '--method', 'GET', '-f', 'per_page=100',
    `repos/{owner}/{repo}/pulls/${input.number}/files`,
  ];
  const ghOpts = { cwd: input.cwd, encoding: 'utf8' as const, timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024 * 1024, env };
  const fromApi = async () => releasePrFilePaths(JSON.parse((await runGhApp('read-pr-files', endpoint, ghOpts)).stdout));
  const fromGit = async (): Promise<string[]> => {
    const base = input.base ?? 'origin/main';
    const { stdout } = await execFileImpl('git', ['diff', '--find-renames', '--name-status', '-z', `${base}...HEAD`], {
      cwd: input.cwd, encoding: 'utf8', timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024 * 1024,
    });
    return releaseGitDiffPaths(stdout);
  };
  try {
    return await fromApi();
  } catch (error) {
    if (!(error instanceof AppApiRateLimitError)) throw error;
    try {
      return await fromGit();
    } catch (gitError) {
      const waited = await waitForAppApiRateLimitReset(error.resetAtMs, input.now?.() ?? Date.now(), input.sleep);
      if (!waited) throw error;
      try {
        return await fromApi();
      } catch (retryError) {
        if (retryError instanceof AppApiRateLimitError) throw retryError;
        throw gitError;
      }
    }
  }
}
