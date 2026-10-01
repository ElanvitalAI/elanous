import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../../src/domains/schedule-registry.js';

export interface CheckoutStep { name: string; ok: boolean; seconds: number; tail: string }
export interface CheckoutResult { pr: number; mergeSha: string; ok: boolean; steps: CheckoutStep[] }
export interface CheckoutDeps {
  git: (args: string[], options: { cwd: string; timeout: number }) => string;
  run: (args: string[], options: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv }) => string;
  now: () => number;
}

const LIMIT_MS = 600_000;
const tail = (text: string): string => text.trimEnd().split('\n').slice(-20).join('\n');
const validPath = (file: string): boolean => file.length > 0 && !file.startsWith('/') && !file.startsWith('-') && !file.split('/').includes('..');
const errorOutput = (error: unknown): string => {
  if (!error || typeof error !== 'object') return String(error);
  const e = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
  return [e.stdout, e.stderr, e.message].filter(Boolean).map(String).join('\n') || String(error);
};
const defaultDeps: CheckoutDeps = {
  git: (args, options) => execFileSync('git', args, { ...options, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }),
  run: (args, options) => {
    const result = spawnSync('bun', args, { ...options, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0) throw { stdout: result.stdout, stderr: result.stderr, message: result.error?.message ?? `bun exit ${result.status}` };
    return `${result.stdout}${result.stderr}`;
  },
  now: Date.now,
};

/** A single merge commit, with installed dependencies owned by its detached worktree. */
export function verifyCleanCheckout({ pr, mergeSha, files, deps = defaultDeps }: {
  pr: number; mergeSha: string; files: string[]; deps?: CheckoutDeps;
}): CheckoutResult {
  const steps: CheckoutStep[] = [];
  const root = repoRoot();
  const start = deps.now();
  const deadline = start + LIMIT_MS;
  const workspace = mkdtempSync(join(tmpdir(), 'landing-heal-clean-'));
  const checkout = join(workspace, 'checkout');
  let ok = true;
  const step = (name: string, command: (timeout: number) => string): boolean => {
    const began = deps.now();
    try {
      const remaining = deadline - began;
      if (remaining <= 0) throw new Error('clean checkout 600s timeout');
      const out = command(remaining);
      steps.push({ name, ok: true, seconds: (deps.now() - began) / 1000, tail: tail(out) });
      return true;
    } catch (error) {
      steps.push({ name, ok: false, seconds: (deps.now() - began) / 1000, tail: tail(errorOutput(error)) });
      ok = false;
      return false;
    }
  };
  try {
    if (step('worktree add', (timeout) => {
      const commit = `${mergeSha}^{commit}`;
      const git = (args: string[]) => {
        const remaining = Math.min(timeout, deadline - deps.now());
        if (remaining <= 0) throw new Error('clean checkout 600s timeout');
        return deps.git(args, { cwd: root, timeout: remaining });
      };
      try {
        git(['cat-file', '-e', commit]);
      } catch (error) {
        if (deadline - deps.now() <= 0) throw error;
        git(['fetch', '--no-tags', 'origin', mergeSha]);
        git(['cat-file', '-e', commit]);
      }
      return git(['worktree', 'add', '--detach', checkout, mergeSha]);
    })) {
      if (step('bun install --frozen-lockfile', (timeout) => deps.run(['install', '--frozen-lockfile'], { cwd: checkout, timeout }))) {
        const changedTests = files.filter((file) => /\.(?:test|spec)\.[^/]+$/.test(file));
        const unsupported = changedTests.filter((file) => !validPath(file) || !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file));
        const tests = [...new Set(changedTests.filter((file) => validPath(file)))];
        if (unsupported.length) {
          step('select changed tests', () => { throw new Error(`unsupported changed test files: ${unsupported.join(', ')}`); });
        } else if (tests.length) {
          step('bun test', (timeout) => {
            const out = deps.run(['test', ...tests], { cwd: checkout, timeout });
            const count = /Ran (\d+) tests? across (\d+) files?/.exec(out);
            if (!count || Number(count[1]) === 0) throw new Error(`bun test did not run any tests: ${tail(out)}`);
            if (Number(count[2]) !== tests.length) throw new Error(`bun test ran ${count[2]} of ${tests.length} changed test files: ${tail(out)}`);
            return out;
          });
        } else if (files.some((file) => validPath(file) && /\.tsx?$/.test(file))) {
          // ci-typecheck-changed.ts rejects --base: its supported base selector is TSC_BASE_REF.
          step('typecheck changed', (timeout) => deps.run(['run', 'scripts/ci-typecheck-changed.ts'], {
            cwd: checkout, timeout, env: { ...process.env, TSC_BASE_REF: `${mergeSha}^`, GITHUB_BASE_REF: '' },
          }));
        } else {
          step('select changed TypeScript', () => { throw new Error('no existing changed .ts files to verify'); });
        }
      }
    }
  } finally {
    // Cleanup has its own budget: exhausting the PR deadline must not skip removal.
    const cleanupStart = deps.now();
    try {
      const out = deps.git(['worktree', 'remove', '--force', checkout], { cwd: root, timeout: 30_000 });
      steps.push({ name: 'worktree remove', ok: true, seconds: (deps.now() - cleanupStart) / 1000, tail: tail(out) });
    } catch (error) {
      steps.push({ name: 'worktree remove', ok: false, seconds: (deps.now() - cleanupStart) / 1000, tail: tail(errorOutput(error)) });
      ok = false;
    }
    try { rmSync(workspace, { recursive: true, force: true }); }
    catch (error) { steps.push({ name: 'remove temporary folder', ok: false, seconds: 0, tail: tail(errorOutput(error)) }); ok = false; }
    if (existsSync(workspace)) { steps.push({ name: 'remove temporary folder', ok: false, seconds: 0, tail: 'temporary folder still exists' }); ok = false; }
  }
  return { pr, mergeSha, ok, steps };
}
