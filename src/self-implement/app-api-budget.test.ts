import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawnSync } from 'node:child_process';
import { debug } from '../debug/log.js';
import { releasePathHold } from '../self-dev/release-path-guard.js';
import {
  APP_API_RATE_LIMIT_RETRY_CAP_MS,
  AppApiRateLimitError,
  isAppApiRateLimitFailure,
  readPrFilesWithRateLimitFallback,
  setAppApiExecFileForTest,
  waitForAppApiRateLimitReset,
} from './app-api-budget.js';

const execFileAsync = promisify(execFile);

const directories: string[] = [];
const previousPath = process.env.PATH;

afterEach(() => {
  setAppApiExecFileForTest(undefined);
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
}

function worktree(files: Record<string, string>, base = 'main'): { cwd: string; base: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'app-api-budget-'));
  directories.push(cwd);
  git(cwd, 'init', '-b', base);
  git(cwd, 'config', 'user.email', 'budget@example.com');
  git(cwd, 'config', 'user.name', 'budget');
  writeFileSync(join(cwd, 'keep.txt'), 'base\n');
  git(cwd, 'add', 'keep.txt');
  git(cwd, '-c', 'user.email=budget@example.com', '-c', 'user.name=budget', 'commit', '-m', 'base');
  for (const [path, body] of Object.entries(files)) {
    writeFileSync(join(cwd, path), body);
    git(cwd, 'add', path);
  }
  git(cwd, '-c', 'user.email=budget@example.com', '-c', 'user.name=budget', 'commit', '-m', 'head');
  const parent = spawnSync('git', ['rev-parse', 'HEAD~1'], { cwd, encoding: 'utf8' });
  if (parent.status !== 0 || !parent.stdout.trim()) throw new Error(parent.stderr || 'base commit missing');
  return { cwd, base: parent.stdout.trim() };
}

function ghScript(body: string): string {
  return `#!/bin/sh
printf '%s\\0' "$@" >> "$GH_LOG"
printf '\\n' >> "$GH_LOG"
if [ -n "$GH_STDERR" ]; then printf '%s\\n' "$GH_STDERR" >&2; fi
if [ "$GH_FAIL" = 1 ]; then exit 1; fi
printf '%s' "$GH_BODY"
`;
}

function installGh(cwd: string, opts: { fail?: boolean; stderr?: string; body?: string; script?: string }): string {
  const binary = join(cwd, 'gh');
  writeFileSync(binary, opts.script ?? ghScript(''));
  chmodSync(binary, 0o755);
  process.env.GH_LOG = join(cwd, 'gh.log');
  process.env.GH_FAIL = opts.fail ? '1' : '0';
  process.env.GH_STDERR = opts.stderr ?? '';
  process.env.GH_BODY = opts.body ?? '[]';
  writeFileSync(process.env.GH_LOG, '');
  setAppApiExecFileForTest(async (file, args, execOpts) => {
    const target = file === 'gh' ? binary : file;
    return execFileAsync(target, [...args], { ...execOpts, env: { ...process.env, ...execOpts.env } });
  });
  return binary;
}

function ghCalls(cwd: string): string[][] {
  const raw = readFileSync(join(cwd, 'gh.log'), 'utf8');
  return raw.split('\n').filter(Boolean).map((line) => line.split('\0').filter(Boolean));
}

describe('GitHub App API rate-limit budget', () => {
  test('classifies 403/429 rate-limit text and a zero remaining header, not other failures', () => {
    expect(isAppApiRateLimitFailure(403, 'API rate limit exceeded for installation ID 9')).toBe(true);
    expect(isAppApiRateLimitFailure(429, 'secondary rate limit')).toBe(true);
    expect(isAppApiRateLimitFailure(200, 'ok', '0')).toBe(true);
    expect(isAppApiRateLimitFailure(404, 'API rate limit exceeded')).toBe(false);
    expect(isAppApiRateLimitFailure(500, 'unavailable')).toBe(false);
  });

  test('waits until reset and never longer than 15 minutes; a past reset does not wait', async () => {
    const waits: number[] = [];
    const now = 1_000_000;
    expect(await waitForAppApiRateLimitReset(now + 20 * 60_000, now, async (ms) => { waits.push(ms); })).toBe(true);
    expect(waits).toEqual([APP_API_RATE_LIMIT_RETRY_CAP_MS]);
    expect(await waitForAppApiRateLimitReset(now - 1, now, async () => { throw new Error('slept'); })).toBe(false);
    expect(await waitForAppApiRateLimitReset(undefined, now, async () => { throw new Error('slept'); })).toBe(false);
  });

  test('an injected rate limit falls back to git diff and continues the release-path decision', async () => {
    const tree = worktree({ 'src-ordinary.ts': 'ok\n' });
    installGh(tree.cwd, {
      fail: true,
      stderr: 'HTTP: 403\nX-RateLimit-Remaining: 0\nX-RateLimit-Reset: 9999999999\nAPI rate limit exceeded for installation ID 42',
    });
    const calls: Array<Record<string, unknown>> = [];
    const original = debug.log.bind(debug);
    debug.log = ((category: string, event: string, data?: unknown) => {
      if (category === 'github.app-api') calls.push({ ...(data as object), event });
      return original(category, event, data);
    }) as typeof debug.log;
    try {
      const files = await readPrFilesWithRateLimitFallback({ number: 8, cwd: tree.cwd, base: tree.base, env: { GH_TOKEN: 'ghs_secret_token' } });
      expect(files).toContain('src-ordinary.ts');
      expect(releasePathHold(files)).toBeUndefined();
      expect(ghCalls(tree.cwd)).toHaveLength(1);
      expect(JSON.stringify(calls)).not.toContain('ghs_secret_token');
      expect(calls[0]).toMatchObject({ caller: 'readPrFiles', status: 403, remaining: '0' });
    } finally {
      debug.log = original;
    }
  });

  test('when the local diff is also unavailable, waits for reset and retries the file API once', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'app-api-budget-nogit-'));
    directories.push(cwd);
    let hits = 0;
    const script = `#!/bin/sh
hits=$(cat "$GH_HITS" 2>/dev/null || echo 0)
hits=$((hits + 1))
printf '%s' "$hits" > "$GH_HITS"
printf '%s\\0' "$@" >> "$GH_LOG"
printf '\\n' >> "$GH_LOG"
if [ "$hits" = 1 ]; then
  printf '%s\\n' 'HTTP: 429' 'X-RateLimit-Remaining: 0' 'X-RateLimit-Reset: 1' 'API rate limit exceeded' >&2
  exit 1
fi
printf '%s' '[[{"filename":"src/ordinary.ts"}]]'
`;
    installGh(cwd, { script });
    process.env.GH_HITS = join(cwd, 'hits');
    const waits: number[] = [];
    const files = await readPrFilesWithRateLimitFallback({
      number: 9,
      cwd,
      base: 'missing-base',
      env: {},
      now: () => 0,
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(files).toEqual(['src/ordinary.ts']);
    expect(releasePathHold(files)).toBeUndefined();
    expect(waits).toEqual([1000]);
    expect(ghCalls(cwd)).toHaveLength(2);
  });

  test('a failed retry keeps the rate-limit error so merge stays at zero with the limit named', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'app-api-budget-retry-'));
    directories.push(cwd);
    installGh(cwd, {
      fail: true,
      stderr: 'HTTP: 403\nX-RateLimit-Remaining: 0\nX-RateLimit-Reset: 1\nAPI rate limit exceeded for installation ID 7',
    });
    const waits: number[] = [];
    await expect(readPrFilesWithRateLimitFallback({
      number: 10,
      cwd,
      env: {},
      now: () => 0,
      sleep: async (ms) => { waits.push(ms); },
    })).rejects.toBeInstanceOf(AppApiRateLimitError);
    expect(waits).toEqual([1000]);
    expect(ghCalls(cwd)).toHaveLength(2);
  });

  test('removing the git diff fallback makes the first rate-limit case fail instead of continuing', async () => {
    const tree = worktree({ 'src-ordinary.ts': 'ok\n' });
    installGh(tree.cwd, {
      fail: true,
      stderr: 'HTTP: 403\nX-RateLimit-Remaining: 0\nAPI rate limit exceeded for installation ID 42',
    });
    await expect(readPrFilesWithRateLimitFallback({
      number: 8, cwd: tree.cwd, base: 'refs/does-not-exist', env: {},
    })).rejects.toBeInstanceOf(AppApiRateLimitError);
    const withFallback = await readPrFilesWithRateLimitFallback({ number: 8, cwd: tree.cwd, base: tree.base, env: {} });
    expect(releasePathHold(withFallback)).toBeUndefined();
    expect(withFallback).toContain('src-ordinary.ts');
  });
});
