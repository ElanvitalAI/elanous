import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { detectTestInterference, runBunTest } from '../../scripts/detect-test-interference.js';
import { runTestInterferenceGate } from '../../scripts/ci-test-interference-gate.js';

/**
 * The PWA's static build type-checks every `src/**` file it imports, under Next's stricter
 * `ProcessEnv` — a change that only touches `src/**` can break it while tsc and bun test stay
 * green (2026-09-27: two such changes kept main's PWA build red for two hours). Build whenever
 * app code or non-test source changed; test files are never imported by the PWA.
 */
export function needsPwaBuild(files: readonly string[]): boolean {
  return files.some((file) => file.startsWith('apps/pwa/') || (file.startsWith('src/') && !/\.test\.tsx?$/.test(file)));
}

export interface HostRegateInput { prNumber: number; headCommit: string; repoRoot: string }
export interface HostRegateResult { passed: boolean; failures: Array<{ step: string; detail: string }>; os: string }
export type HostRegateDeps = {
  command?: (bin: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string };
  interference?: (files: readonly string[], cwd: string) => Promise<{ passed: boolean; detail?: string; unmeasured?: boolean }>;
  makeTemp?: () => string;
  removeTemp?: (path: string) => void;
  acquire?: (repoRoot: string) => Promise<() => void>;
  log?: (event: 'passed' | 'failed' | 'unmeasured' | 'base-raced', data: Record<string, unknown>) => void;
};

const defaultCommand: NonNullable<HostRegateDeps['command']> = (bin, args, cwd, env) => {
  const r = spawnSync(bin, [...args], { cwd, env: env ?? process.env, encoding: 'utf8', timeout: 600_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? `${r.error.message} (command unavailable)` : '') };
};

/** The informational pr-land gate always returns zero; enforce its measured report and the combined test result instead. */
async function defaultInterference(files: readonly string[], cwd: string): Promise<{ passed: boolean; detail?: string; unmeasured?: boolean }> {
  const tests = files.filter((file) => /\.test\.tsx?$/.test(file));
  const neighbors = new Set<string>(tests);
  for (const file of tests) {
    for (const sibling of readdirSync(join(cwd, dirname(file)))) {
      if (/\.test\.tsx?$/.test(sibling)) neighbors.add(join(dirname(file), sibling));
    }
  }
  const selected = [...neighbors].sort();
  if (!selected.length) return { passed: true };
  // The informational pr-land gate always returns zero; its measured report is the verdict.
  let report: Awaited<ReturnType<typeof detectTestInterference>> | undefined;
  await runTestInterferenceGate({
    args: ['--changed-files', ...selected], log: () => {},
    detect: async (paths) => (report = await detectTestInterference(paths, (batch) => runBunTest(batch, undefined, cwd))),
  });
  if (!report || report.status === 'unmeasurable' || selected.length > report.order.length) return { passed: false, unmeasured: true, detail: 'test interference measurement unavailable or truncated' };
  if (report.isolatedFailures !== 0 || report.combinedFailures !== 0 || report.status === 'interference') {
    return { passed: false, detail: `isolated=${report.isolatedFailures}, combined=${report.combinedFailures}, interference=${report.status}` };
  }
  return { passed: true };
}

const SLOT_WAIT_MS = 30 * 60_000;

function slotOwnerAlive(slot: string): boolean {
  try {
    const pid = Number(readFileSync(join(slot, 'pid'), 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function acquireSlot(repoRoot: string, opts: { waitMs?: number; pollMs?: number; now?: () => number } = {}): Promise<() => void> {
  const gitDir = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' });
  if (gitDir.status !== 0 || !gitDir.stdout.trim()) throw new Error('git common directory unavailable for host regate lock');
  const root = join(gitDir.stdout.trim(), 'elanous-host-regate');
  mkdirSync(root, { recursive: true });
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.waitMs ?? SLOT_WAIT_MS);
  for (;;) {
    for (let i = 0; i < 2; i++) {
      const slot = join(root, `slot-${i}`);
      try {
        mkdirSync(slot);
        writeFileSync(join(slot, 'pid'), String(process.pid));
        return () => rmSync(slot, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A slot left by a crashed host process would otherwise block every later run.
        // A slot without a pid file yet may be mid-acquire; only reclaim once its owner is known dead.
        if (existsSync(join(slot, 'pid')) && !slotOwnerAlive(slot)) {
          rmSync(slot, { recursive: true, force: true });
          debug.log('harness.host-regate', 'slot-reclaimed', { slot: `slot-${i}` });
        }
      }
    }
    if (now() >= deadline) throw new Error(`host regate slots busy for ${Math.round((opts.waitMs ?? SLOT_WAIT_MS) / 60_000)}m`);
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 250));
  }
}

export async function runHostRegate(input: HostRegateInput, deps: HostRegateDeps = {}): Promise<HostRegateResult> {
  const command = deps.command ?? defaultCommand;
  const log = deps.log ?? ((event: 'passed' | 'failed' | 'unmeasured' | 'base-raced', data: Record<string, unknown>) => debug.log('harness.host-regate', event, data));
  const failures: HostRegateResult['failures'] = [];
  let files: string[] = [];
  let base = '';
  let worktree: string | undefined;
  let attached = false;
  let release: (() => void) | undefined;
  const result = (event: 'passed' | 'failed' | 'unmeasured', step?: string, detail?: string): HostRegateResult => {
    if (step) failures.push({ step, detail: detail ?? 'unknown' });
    log(event, { pr: input.prNumber, files, os: process.platform, ...(step ? { failedStep: step } : {}) });
    return { passed: event === 'passed', failures, os: process.platform };
  };
  const run = (bin: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): string => {
    const r = command(bin, args, cwd, env);
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || `${bin} exited ${r.status}`).trim().slice(0, 300));
    return r.stdout.trim();
  };
  try {
    if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0 || !/^[0-9a-f]{40}$/i.test(input.headCommit)) return result('unmeasured', 'input', 'invalid PR number or checked head SHA');
    release = await (deps.acquire ?? acquireSlot)(input.repoRoot);
    type PrView = { headRefOid?: string; baseRefName?: string; baseRefOid?: string; state?: string; isDraft?: boolean };
    const readPr = (): PrView => JSON.parse(run('gh', ['pr', 'view', String(input.prNumber), '--json', 'headRefOid,baseRefName,baseRefOid,state,isDraft'], input.repoRoot));
    let view: PrView;
    try { view = readPr(); }
    catch (e) { return result('unmeasured', 'pr-view', String(e)); }
    if (view.headRefOid !== input.headCommit || view.state !== 'OPEN' || view.isDraft !== false || !view.baseRefName || !/^[0-9a-f]{40}$/i.test(view.baseRefOid ?? '')) return result('unmeasured', 'pr-head', 'PR head, base commit, ready state or open state unavailable or changed');
    const baseRefName = view.baseRefName;
    const baseCommit = view.baseRefOid;
    try {
      run('git', ['fetch', 'origin', `refs/heads/${baseRefName}`], input.repoRoot);
      if (run('git', ['rev-parse', 'FETCH_HEAD'], input.repoRoot) !== baseCommit) throw new Error('fetched PR base differs from checked SHA');
      run('git', ['fetch', 'origin', `refs/pull/${input.prNumber}/head`], input.repoRoot);
      if (run('git', ['rev-parse', 'FETCH_HEAD'], input.repoRoot) !== input.headCommit) throw new Error('fetched PR head differs from checked SHA');
      worktree = (deps.makeTemp ?? (() => mkdtempSync(join(tmpdir(), 'elanous-host-regate-'))))();
      run('git', ['worktree', 'add', '--detach', worktree, baseCommit], input.repoRoot);
      attached = true;
      if (run('git', ['rev-parse', 'HEAD'], worktree) !== baseCommit) throw new Error('worktree base HEAD mismatch');
      base = run('git', ['merge-base', baseCommit, input.headCommit], worktree);
      files = run('git', ['diff', '--name-only', base, input.headCommit], worktree).split('\n').filter(Boolean);
      if (!files.length) throw new Error('changed files unavailable');
      // Materialize the proposed merge of this exact PR head into the observed base.
      // A clean head checkout cannot expose integration breaks introduced by the base.
      try { run('git', ['merge', '--no-ff', '--no-commit', input.headCommit], worktree); }
      catch (e) { return result('failed', 'merge-conflict', String(e)); }
      run('git', ['-c', 'user.name=elanous host regate', '-c', 'user.email=regate@localhost', 'commit', '-m', 'host regate integration candidate'], worktree);
      if (run('git', ['rev-parse', 'HEAD^1'], worktree) !== baseCommit || run('git', ['rev-parse', 'HEAD^2'], worktree) !== input.headCommit) throw new Error('integration parents do not match PR base and checked head');
      if (!deps.command && !existsSync(join(worktree, 'scripts/ci-typecheck-changed.ts'))) throw new Error('typecheck gate unavailable in checked worktree');
      if (existsSync(join(input.repoRoot, 'node_modules')) && !existsSync(join(worktree, 'node_modules'))) symlinkSync(join(input.repoRoot, 'node_modules'), join(worktree, 'node_modules'), 'dir');
      if (needsPwaBuild(files) && existsSync(join(input.repoRoot, 'apps/pwa/node_modules')) && existsSync(join(worktree, 'apps/pwa')) && !existsSync(join(worktree, 'apps/pwa/node_modules'))) {
        symlinkSync(join(input.repoRoot, 'apps/pwa/node_modules'), join(worktree, 'apps/pwa/node_modules'), 'dir');
      }
    } catch (e) { return result('unmeasured', 'worktree', String(e)); }
    try {
      const interference = await (deps.interference ?? defaultInterference)(files, worktree);
      if (!interference.passed) return result(interference.unmeasured ? 'unmeasured' : 'failed', 'test-interference', interference.detail);
    } catch (e) { return result('unmeasured', 'test-interference', String(e)); }
    try { run('bun', ['scripts/ci-typecheck-changed.ts'], worktree, { ...process.env, TSC_BASE_REF: base }); }
    catch (e) { return result(String(e).includes('error TS') ? 'failed' : 'unmeasured', 'typecheck', String(e)); }
    if (needsPwaBuild(files)) {
      try { run('bun', ['bin/elanous.mjs', '--test', 'nexus', 'build'], worktree); }
      catch (e) { return result(String(e).includes('command unavailable') ? 'unmeasured' : 'failed', 'nexus-build', String(e)); }
    }
    let current: PrView;
    try { current = readPr(); }
    catch (e) { return result('unmeasured', 'pr-view', String(e)); }
    if (current.headRefOid !== input.headCommit || current.baseRefName !== baseRefName || current.baseRefOid !== baseCommit || current.state !== 'OPEN' || current.isDraft !== false) {
      return result('unmeasured', 'pr-base-changed', 'PR head or base changed during host regate; rerun against the new base');
    }
    // --match-head-commit pins the head. gh has no base pin, so the base was re-read just
    // above; the seconds between that read and the merge are checked after the fact below.
    try { run('gh', ['pr', 'merge', String(input.prNumber), '--squash', '--match-head-commit', input.headCommit], input.repoRoot); }
    catch (e) { return result('failed', 'merge', String(e)); }
    type MergedView = { state?: string; mergeCommit?: { oid?: string } | null };
    let merged: MergedView;
    try { merged = JSON.parse(run('gh', ['pr', 'view', String(input.prNumber), '--json', 'state,mergeCommit'], input.repoRoot)); }
    catch (e) { return result('unmeasured', 'merge-confirm', String(e)); }
    if (merged.state !== 'MERGED') return result('unmeasured', 'merge-confirm', `PR state after merge is ${merged.state ?? 'unknown'}`);
    const mergeCommit = merged.mergeCommit?.oid ?? '';
    let mergedOnto = '';
    try {
      run('git', ['fetch', 'origin', mergeCommit], input.repoRoot);
      mergedOnto = run('git', ['rev-parse', `${mergeCommit}^1`], input.repoRoot);
    } catch (e) {
      // Merged, but the parent could not be read: "unknown" is not "raced".
      log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'merge-parent', mergeCommit: mergeCommit || null, detail: String(e).slice(0, 200) });
    }
    if (mergedOnto && mergedOnto !== baseCommit) {
      log('base-raced', { pr: input.prNumber, files, os: process.platform, checkedBase: baseCommit, mergedOnto, mergeCommit });
    }
    return result('passed');
  } catch (e) {
    return result('unmeasured', 'host-regate', String(e));
  } finally {
    try { if (attached && worktree) run('git', ['worktree', 'remove', '--force', worktree], input.repoRoot); }
    catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'cleanup', detail: String(e) }); }
    try { if (worktree) (deps.removeTemp ?? ((path) => rmSync(path, { recursive: true, force: true })))(worktree); }
    catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'cleanup', detail: String(e) }); }
    try { release?.(); }
    catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'lock', detail: String(e) }); }
    if (failures.length) {
      const { step, detail } = failures[0]!;
      const body = `호스트 재게이트 실패(${process.platform}): ${step} — ${detail.replace(/\s+/g, ' ').slice(0, 180)}`;
      try { run('gh', ['pr', 'comment', String(input.prNumber), '--body', body], input.repoRoot); }
      catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'comment', detail: String(e) }); }
    }
  }
}
