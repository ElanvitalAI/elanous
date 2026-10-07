import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEXT_MD_PATH, resolveNextMdConflict } from '../release-loop/next-md-merge.js';
import { getDefaultLogStore } from '../mss/logging/log-store.js';

type Command = (bin: string, args: readonly string[], cwd: string) => { status: number | null; stdout: string; stderr: string };
export type L8MergeQueueInput = { number: number; cwd: string; matchHeadCommit: string };
export type L8MergeQueueResult = { merged: boolean; baseRefName?: string; mergeCommit?: string; detail?: string };
/** Read-only integration report. Never a landing decision and never a remote write. */
export type L8ChangedTestResult = { file: string; passed: boolean; pass: number; fail: number; detail?: string };
export type L8IntegrationEvaluation = {
  number: number;
  head: string;
  base?: string;
  /** True only when the candidate integrates (next.md-only conflicts resolved) and every changed test passed. */
  feasible: boolean;
  conflictingFiles: string[];
  /** True when there is no conflict, or every conflict path is exactly release/next.md. */
  conflictsLimitedToNextMd: boolean;
  changedTests: L8ChangedTestResult[];
  detail?: string;
};
export type L8MergeQueueDeps = {
  command?: Command;
  /** Must identify the same shared repository across all harness processes. */
  acquire?: (cwd: string) => Promise<() => void>;
};

export type L8ShadowVerdict = { number: number; head: string; base?: string; verdict: 'pass' | 'conflict' | 'fail'; detail?: string; tests: string[]; at: string };
export type L8ShadowQueueState = { pending: { number: number; head: string }[]; verdicts: L8ShadowVerdict[] };
export type L8ShadowQueueDeps = L8MergeQueueDeps & { observe?: (verdict: L8ShadowVerdict) => void | Promise<void> };

function shadowCommand(execute: Command, bin: string, args: string[], cwd: string): string {
  const result = execute(bin, args, cwd);
  if (result.status !== 0) throw new Error(`${bin} ${args.join(' ')}: ${(result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 500)}`);
  return args.includes('-z') ? result.stdout : result.stdout.trim();
}

function shadowQueuePath(cwd: string, execute: Command): string {
  const dir = shadowCommand(execute, 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!dir) throw new Error('merge queue common git directory unavailable');
  return join(dir, 'elanous-l8-shadow-queue.json');
}

function readShadowQueue(path: string): L8ShadowQueueState {
  if (!existsSync(path)) return { pending: [], verdicts: [] };
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || !('pending' in value) || !Array.isArray(value.pending)
    || !value.pending.every((p: { number?: number; head?: string }) => Number.isSafeInteger(p?.number) && p.number! > 0 && typeof p.head === 'string' && /^[0-9a-f]{40}$/i.test(p.head))
    || !('verdicts' in value) || !Array.isArray(value.verdicts)) throw new Error('invalid shadow queue ledger');
  return value as L8ShadowQueueState;
}

function writeShadowQueue(path: string, state: L8ShadowQueueState): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

async function withShadowQueue<T>(cwd: string, deps: L8ShadowQueueDeps, fn: (state: L8ShadowQueueState, path: string) => Promise<T>): Promise<T> {
  const release = await (deps.acquire ?? acquireL8MergeQueue)(cwd);
  try {
    const path = shadowQueuePath(cwd, deps.command ?? command);
    return await fn(readShadowQueue(path), path);
  } finally { release(); }
}

export function shadowPrNumber(raw: string): number {
  const text = raw.replace(/^#/, '');
  const number = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(number)) throw new Error('expected a positive PR number');
  return number;
}

export async function statusL8ShadowQueue(cwd: string, deps: L8ShadowQueueDeps = {}): Promise<L8ShadowQueueState> {
  return withShadowQueue(cwd, deps, async (state) => state);
}

export async function enqueueL8ShadowQueue(cwd: string, number: number, deps: L8ShadowQueueDeps = {}): Promise<L8ShadowQueueState> {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('expected a positive PR number');
  return withShadowQueue(cwd, deps, async (state, path) => {
    const execute = deps.command ?? command;
    const view = JSON.parse(shadowCommand(execute, 'gh', ['pr', 'view', String(number), '--json', 'headRefOid,baseRefName,state,isDraft,isCrossRepository'], cwd)) as {
      headRefOid?: string; baseRefName?: string; state?: string; isDraft?: boolean; isCrossRepository?: boolean;
    };
    if (!view.headRefOid || !/^[0-9a-f]{40}$/i.test(view.headRefOid) || view.baseRefName !== 'main'
      || view.state !== 'OPEN' || view.isDraft !== false || view.isCrossRepository !== false) throw new Error('PR is not an open, ready, same-repository main PR');
    if (state.pending.some((p) => p.number === number)) throw new Error(`PR #${number} already queued`);
    state.pending.push({ number, head: view.headRefOid });
    writeShadowQueue(path, state);
    return state;
  });
}

/** Evaluate one pinned queue head against freshly fetched main. Never push or call a merge API. */
export async function runL8ShadowQueue(cwd: string, deps: L8ShadowQueueDeps = {}): Promise<L8ShadowVerdict | null> {
  return withShadowQueue(cwd, deps, async (state, path) => {
    const item = state.pending[0];
    if (!item) return null;
    const execute = deps.command ?? command;
    const run = (bin: string, args: string[], where = cwd) => shadowCommand(execute, bin, args, where);
    const verdict: L8ShadowVerdict = { number: item.number, head: item.head, verdict: 'fail', tests: [], at: new Date().toISOString() };
    const view = JSON.parse(run('gh', ['pr', 'view', String(item.number), '--json', 'headRefOid,baseRefName,state,isDraft,isCrossRepository'])) as {
      headRefOid?: string; baseRefName?: string; state?: string; isDraft?: boolean; isCrossRepository?: boolean;
    };
    if (view.headRefOid !== item.head || view.baseRefName !== 'main' || view.state !== 'OPEN'
      || view.isDraft !== false || view.isCrossRepository !== false) throw new Error('queued PR changed or is not ready');
    run('git', ['fetch', 'origin', 'refs/heads/main']);
    const base = run('git', ['rev-parse', 'FETCH_HEAD']);
    if (!/^[0-9a-f]{40}$/i.test(base)) throw new Error('main commit unavailable');
    verdict.base = base;
    run('git', ['fetch', 'origin', `refs/pull/${item.number}/head`]);
    if (run('git', ['rev-parse', 'FETCH_HEAD']) !== item.head) throw new Error('fetched PR head changed');
    let temp: string | undefined;
    let attached = false;
    try {
      temp = mkdtempSync(join(tmpdir(), 'elanous-l8-shadow-'));
      run('git', ['worktree', 'add', '--detach', temp, base]);
      attached = true;
      const fork = run('git', ['merge-base', base, item.head], temp);
      const changed = run('git', ['diff', '--name-only', '-z', fork, item.head], temp).split('\0').filter(Boolean);
      if (!changed.length) throw new Error('PR changed-file paths unavailable');
      const diff = run('git', ['diff', '--name-only', '-z', '--diff-filter=ACMRT', fork, item.head], temp);
      const files = diff.split('\0').filter(Boolean);
      if (changed.some((file) => file.startsWith('-') || file.startsWith('/') || file.split('/').includes('..') || file.includes('\\'))) throw new Error('unsafe changed-file path');
      verdict.tests = files.filter((file) => /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(file));
      const merge = execute('git', ['-c', 'user.name=elanous shadow', '-c', 'user.email=shadow@localhost', 'merge', '--no-ff', '--no-edit', item.head], temp);
      let autoResolvedNextMd = false;
      if (merge.status !== 0) {
        const unresolved = run('git', ['diff', '--name-only', '--diff-filter=U'], temp).split('\n').filter(Boolean);
        if (!unresolved.length) throw new Error(`git merge failed: ${merge.stderr.trim() || `exit ${merge.status}`}`);
        if (unresolved.length === 1 && unresolved[0] === NEXT_MD_PATH) {
          const stage = (n: number): string => {
            const result = execute('git', ['show', `:${n}:${NEXT_MD_PATH}`], temp!);
            if (result.status !== 0) throw new Error(`release/next.md stage ${n} unavailable: ${result.stderr}`);
            return result.stdout;
          };
          // Stage 2 is main in this checkout; preserve the incoming PR (stage 3) and union main's additions.
          const resolved = resolveNextMdConflict(stage(1), stage(2), stage(3));
          if (resolved === null) {
            verdict.verdict = 'conflict';
            verdict.detail = 'release/next.md conflict is not append-only';
          } else {
            writeFileSync(join(temp, NEXT_MD_PATH), resolved);
            run('git', ['add', '--', NEXT_MD_PATH], temp);
            run('git', ['-c', 'user.name=elanous shadow', '-c', 'user.email=shadow@localhost', 'commit', '-m', 'Integrate PR for L8 shadow evaluation'], temp);
            autoResolvedNextMd = true;
          }
        } else {
          verdict.verdict = 'conflict';
          verdict.detail = unresolved.join('\n');
        }
      }
      if (merge.status === 0 || autoResolvedNextMd) {
        if (verdict.tests.length) {
          if (verdict.tests.some((file) => !existsSync(join(temp!, file)))) throw new Error('changed test path unavailable');
          run('bun', ['install', '--frozen-lockfile'], temp);
          const result = execute('bun', ['run', 'test:deterministic', ...verdict.tests], temp);
          const output = `${result.stdout}\n${result.stderr}`;
          const counts = /\b(\d+) pass\b[\s\S]*?\b(\d+) fail\b[\s\S]*?Ran ([1-9]\d*) tests? across ([1-9]\d*) files?/.exec(output);
          if (!counts || Number(counts[1]) + Number(counts[2]) !== Number(counts[3])
            || Number(counts[4]) !== verdict.tests.length || (result.status !== 0 && Number(counts[2]) === 0)) {
            throw new Error(`changed tests unmeasured: ${output.slice(-400)}`);
          }
          if (Number(counts[2]) > 0 || Number(counts[1]) === 0) {
            verdict.detail = `changed tests failed: ${output.slice(-400)}`;
          } else {
            verdict.verdict = 'pass';
          }
        } else {
          verdict.verdict = 'pass';
        }
        if (autoResolvedNextMd) {
          verdict.detail = verdict.detail ? `release/next.md auto-resolved; ${verdict.detail}` : 'release/next.md auto-resolved';
        }
      }
    } finally {
      try {
        if (attached && temp) run('git', ['worktree', 'remove', '--force', temp]);
      } finally {
        if (temp) rmSync(temp, { recursive: true, force: true });
      }
    }
    if (verdict.verdict === 'pass') {
      run('git', ['fetch', 'origin', 'refs/heads/main']);
      if (run('git', ['rev-parse', 'FETCH_HEAD']) !== verdict.base) throw new Error('main advanced during shadow verification');
      const current = JSON.parse(run('gh', ['pr', 'view', String(item.number), '--json', 'headRefOid,baseRefName,state,isDraft,isCrossRepository'])) as {
        headRefOid?: string; baseRefName?: string; state?: string; isDraft?: boolean; isCrossRepository?: boolean;
      };
      if (current.headRefOid !== item.head || current.baseRefName !== 'main' || current.state !== 'OPEN'
        || current.isDraft !== false || current.isCrossRepository !== false) throw new Error('PR changed during shadow verification');
    }
    // A rejected insert leaves the pinned item queued for a later evaluation.
    await (deps.observe ?? ((entry) => {
      const store = getDefaultLogStore();
      if (!store) throw new Error('merge-queue observation store unavailable');
      store.insertBatch([{ rec: { ts: new Date().toISOString(), category: 'merge-queue', event: 'shadow-verdict', data: entry }, surface: 'merge-queue' }]);
    }))(verdict);
    state.pending.shift();
    state.verdicts.push(verdict);
    writeShadowQueue(path, state);
    return verdict;
  });
}

const command: Command = (bin, args, cwd) => {
  const r = spawnSync(bin, [...args], { cwd, encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error?.message ?? '') };
};

/** Serialize the whole read/integrate/test/merge transaction, not just the final push. */
export async function acquireL8MergeQueue(cwd: string): Promise<() => void> {
  const git = command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (git.status !== 0 || !git.stdout.trim()) throw new Error('merge queue common git directory unavailable');
  const slot = join(git.stdout.trim(), 'elanous-l8-merge-queue');
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    try {
      mkdirSync(slot);
      try { writeFileSync(join(slot, 'pid'), String(process.pid)); }
      catch (error) { rmSync(slot, { recursive: true, force: true }); throw new Error(`merge queue pid write failed: ${String(error)}`); }
      return () => rmSync(slot, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Fail closed on abandoned slots: never steal a slot while a live merge can own it.
      if (Date.now() >= deadline) throw new Error('merge queue occupied for 30 minutes');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

const TEST_PATH = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

function parseChangedTestCounts(output: string): { pass: number; fail: number; ran: number; files: number } | null {
  const counts = /\b(\d+) pass\b[\s\S]*?\b(\d+) fail\b[\s\S]*?Ran ([1-9]\d*) tests? across ([1-9]\d*) files?/.exec(output);
  if (!counts) return null;
  return { pass: Number(counts[1]), fail: Number(counts[2]), ran: Number(counts[3]), files: Number(counts[4]) };
}

/**
 * Report whether one pinned PR can integrate onto freshly fetched main.
 * Resolves an append-only release/next.md conflict in a disposable worktree only.
 * Never pushes, never calls a merge API, and never moves a remote ref.
 */
export async function evaluateL8Integration(input: L8MergeQueueInput, deps: L8MergeQueueDeps = {}): Promise<L8IntegrationEvaluation> {
  const report: L8IntegrationEvaluation = {
    number: input.number,
    head: input.matchHeadCommit,
    feasible: false,
    conflictingFiles: [],
    conflictsLimitedToNextMd: false,
    changedTests: [],
  };
  if (!Number.isSafeInteger(input.number) || input.number <= 0 || !/^[0-9a-f]{40}$/i.test(input.matchHeadCommit)) {
    return { ...report, detail: 'invalid PR number or pinned head' };
  }
  const execute = deps.command ?? command;
  const run = (bin: string, args: readonly string[], cwd: string): string => {
    const result = execute(bin, args, cwd);
    if (result.status !== 0) throw new Error(`${bin} ${args.join(' ')}: ${(result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 500)}`);
    return args.includes('-z') ? result.stdout : result.stdout.trim();
  };
  const refuseRemote = (bin: string, args: readonly string[]) => {
    if (bin === 'git' && args.some((arg) => arg === 'push' || arg === 'update-ref')) throw new Error('evaluation must not push');
    if (bin === 'gh' && args.some((arg) => arg === 'merge')) throw new Error('evaluation must not merge');
  };
  const guarded: Command = (bin, args, cwd) => {
    refuseRemote(bin, args);
    return execute(bin, args, cwd);
  };
  let temp: string | undefined;
  let attached = false;
  try {
    type View = { headRefOid?: string; headRefName?: string; baseRefName?: string; state?: string; isDraft?: boolean; isCrossRepository?: boolean };
    const view = JSON.parse(run('gh', ['pr', 'view', String(input.number), '--json', 'headRefOid,headRefName,baseRefName,state,isDraft,isCrossRepository'], input.cwd)) as View;
    if (view.headRefOid !== input.matchHeadCommit || view.baseRefName !== 'main' || view.state !== 'OPEN' || view.isDraft !== false || view.isCrossRepository !== false) {
      throw new Error('PR head, base, or ready/open state changed');
    }
    run('git', ['fetch', 'origin', 'refs/heads/main'], input.cwd);
    const base = run('git', ['rev-parse', 'FETCH_HEAD'], input.cwd);
    if (!/^[0-9a-f]{40}$/i.test(base)) throw new Error('main commit unavailable');
    report.base = base;
    run('git', ['fetch', 'origin', `refs/pull/${input.number}/head`], input.cwd);
    if (run('git', ['rev-parse', 'FETCH_HEAD'], input.cwd) !== input.matchHeadCommit) throw new Error('fetched PR head changed');
    temp = mkdtempSync(join(tmpdir(), 'elanous-l8-eval-'));
    run('git', ['worktree', 'add', '--detach', temp, input.matchHeadCommit], input.cwd);
    attached = true;
    const fork = run('git', ['merge-base', base, input.matchHeadCommit], temp);
    const paths = run('git', ['diff', '--name-only', '-z', fork, input.matchHeadCommit], temp).split('\0').filter(Boolean);
    if (!paths.length) throw new Error('PR changed-file paths unavailable');
    if (paths.some((path) => path.startsWith('-') || path.startsWith('/') || path.split('/').includes('..') || path.includes('\\'))) throw new Error('unsafe PR changed-file path');
    const livePaths = run('git', ['diff', '--name-only', '-z', '--diff-filter=ACMRT', fork, input.matchHeadCommit], temp).split('\0').filter(Boolean);
    const tests = livePaths.filter((path) => TEST_PATH.test(path));
    const merge = guarded('git', ['-c', 'user.name=elanous merge queue', '-c', 'user.email=queue@localhost', 'merge', '--no-ff', '--no-edit', base], temp);
    if (merge.status !== 0) {
      const unresolved = run('git', ['diff', '--name-only', '--diff-filter=U'], temp).split('\n').filter(Boolean);
      if (!unresolved.length) throw new Error(`git merge failed: ${(merge.stderr || `exit ${merge.status}`).trim()}`);
      report.conflictingFiles = unresolved;
      report.conflictsLimitedToNextMd = unresolved.length === 1 && unresolved[0] === NEXT_MD_PATH;
      if (!report.conflictsLimitedToNextMd) {
        report.detail = `merge conflicts: ${unresolved.join(', ')}`;
        return report;
      }
      const stage = (n: number): string => {
        const result = guarded('git', ['show', `:${n}:${NEXT_MD_PATH}`], temp!);
        if (result.status !== 0) throw new Error(`release/next.md stage ${n} unavailable: ${result.stderr}`);
        return result.stdout;
      };
      const resolved = resolveNextMdConflict(stage(1), stage(3), stage(2));
      if (resolved === null) {
        report.feasible = false;
        report.detail = 'release/next.md conflict is not append-only';
        return report;
      }
      writeFileSync(join(temp, NEXT_MD_PATH), resolved);
      run('git', ['add', '--', NEXT_MD_PATH], temp);
      run('git', ['-c', 'user.name=elanous merge queue', '-c', 'user.email=queue@localhost', 'commit', '-m', 'Integrate latest main for L8 evaluation'], temp);
    } else {
      report.conflictsLimitedToNextMd = true;
    }
    if (tests.length) {
      const unavailable = tests.filter((path) => !existsSync(join(temp!, path)));
      if (unavailable.length) throw new Error(`changed test paths unavailable: ${unavailable.join(', ')}`);
      run('bun', ['install', '--frozen-lockfile'], temp);
      for (const file of tests) {
        const result = guarded('bun', ['test', file], temp);
        const output = `${result.stdout}\n${result.stderr}`;
        const counts = parseChangedTestCounts(output);
        if (!counts || counts.pass + counts.fail !== counts.ran || counts.files !== 1 || (result.status !== 0 && counts.fail === 0)) {
          throw new Error(`changed tests unmeasured: ${output.slice(-400)}`);
        }
        const passed = result.status === 0 && counts.fail === 0 && counts.pass > 0;
        report.changedTests.push({ file, passed, pass: counts.pass, fail: counts.fail, ...(passed ? {} : { detail: output.slice(-400) }) });
      }
      if (report.changedTests.some((entry) => !entry.passed)) {
        report.detail = 'changed tests failed';
        return report;
      }
    }
    report.feasible = true;
    return report;
  } catch (error) {
    return { ...report, feasible: false, detail: String(error) };
  } finally {
    if (attached && temp) execute('git', ['worktree', 'remove', '--force', temp], input.cwd);
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

/** One PR per shared git directory, integrated on a freshly fetched main in a disposable worktree. */
export async function runL8MergeQueue(input: L8MergeQueueInput, deps: L8MergeQueueDeps = {}): Promise<L8MergeQueueResult> {
  if (!Number.isSafeInteger(input.number) || input.number <= 0 || !/^[0-9a-f]{40}$/i.test(input.matchHeadCommit)) {
    return { merged: false, detail: 'invalid PR number or pinned head' };
  }
  const execute = deps.command ?? command;
  const run = (bin: string, args: readonly string[], cwd: string): string => {
    const result = execute(bin, args, cwd);
    if (result.status !== 0) throw new Error(`${bin} ${args.join(' ')}: ${(result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 500)}`);
    return args.includes('-z') ? result.stdout : result.stdout.trim();
  };
  let release: (() => void) | undefined;
  let temp: string | undefined;
  let attached = false;
  try {
    release = await (deps.acquire ?? acquireL8MergeQueue)(input.cwd);
    type View = { headRefOid?: string; headRefName?: string; baseRefName?: string; state?: string; isDraft?: boolean; isCrossRepository?: boolean; mergeCommit?: { oid?: string } | null };
    const view = (): View => JSON.parse(run('gh', ['pr', 'view', String(input.number), '--json', 'headRefOid,headRefName,baseRefName,state,isDraft,isCrossRepository,mergeCommit'], input.cwd));
    const first = view();
    if (first.headRefOid !== input.matchHeadCommit || first.baseRefName !== 'main' || first.state !== 'OPEN' || first.isDraft !== false || first.isCrossRepository !== false || !first.headRefName || !/^[\w./-]+$/.test(first.headRefName) || first.headRefName.startsWith('-') || first.headRefName === 'main') {
      throw new Error('PR head, base, or ready/open state changed');
    }
    run('git', ['fetch', 'origin', 'refs/heads/main'], input.cwd);
    const base = run('git', ['rev-parse', 'FETCH_HEAD'], input.cwd);
    run('git', ['fetch', 'origin', `refs/pull/${input.number}/head`], input.cwd);
    if (run('git', ['rev-parse', 'FETCH_HEAD'], input.cwd) !== input.matchHeadCommit) throw new Error('fetched PR head changed');
    temp = mkdtempSync(join(tmpdir(), 'elanous-l8-'));
    run('git', ['worktree', 'add', '--detach', temp, input.matchHeadCommit], input.cwd);
    attached = true;
    const fork = run('git', ['merge-base', base, input.matchHeadCommit], temp);
    const paths = run('git', ['diff', '--name-only', '-z', fork, input.matchHeadCommit], temp).split('\0').filter(Boolean);
    if (!paths.length) throw new Error('PR changed-file paths unavailable');
    if (paths.some((path) => path.startsWith('-') || path.startsWith('/') || path.split('/').includes('..') || path.includes('\\'))) throw new Error('unsafe PR changed-file path');
    // Deleted tests are not runnable; a successful diff with no runnable paths is not a failed lookup.
    const livePaths = run('git', ['diff', '--name-only', '-z', '--diff-filter=ACMRT', fork, input.matchHeadCommit], temp).split('\0').filter(Boolean);
    const isBunTest = (path: string) => /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(path);
    const tests = livePaths.filter(isBunTest);
    const merge = execute('git', ['-c', 'user.name=elanous merge queue', '-c', 'user.email=queue@localhost', 'merge', '--no-ff', '--no-edit', base], temp);
    if (merge.status !== 0) {
      const unresolved = run('git', ['diff', '--name-only', '--diff-filter=U'], temp).split('\n').filter(Boolean);
      if (unresolved.length !== 1 || unresolved[0] !== NEXT_MD_PATH) throw new Error(`merge conflicts: ${unresolved.join(', ') || merge.stderr}`);
      const stage = (n: number): string => {
        const result = execute('git', ['show', `:${n}:${NEXT_MD_PATH}`], temp!);
        if (result.status !== 0) throw new Error(`release/next.md stage ${n} unavailable: ${result.stderr}`);
        return result.stdout;
      };
      // Git stage 2 is the PR and stage 3 is main; the resolver preserves stage 2 and unions main's additions.
      const resolved = resolveNextMdConflict(stage(1), stage(3), stage(2));
      if (resolved === null) throw new Error('release/next.md conflict is not append-only');
      writeFileSync(join(temp, NEXT_MD_PATH), resolved);
      run('git', ['add', '--', NEXT_MD_PATH], temp);
      run('git', ['-c', 'user.name=elanous merge queue', '-c', 'user.email=queue@localhost', 'commit', '-m', 'Integrate latest main for L8 merge queue'], temp);
    }
    if (tests.length) {
      const unavailable = tests.filter((path) => !existsSync(join(temp!, path)));
      if (unavailable.length) throw new Error(`changed test paths unavailable: ${unavailable.join(', ')}`);
      // The disposable checkout must resolve the integrated candidate's lockfile, never the caller's modules.
      run('bun', ['install', '--frozen-lockfile'], temp);
      const result = execute('bun', ['test', ...tests], temp);
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.status !== 0 || !/\b[1-9]\d* pass\b/.test(output) || !/\b0 fail\b/.test(output) || !/Ran [1-9]\d* tests? across [1-9]\d* files?/.test(output)) throw new Error(`changed tests failed or unmeasured: ${output.slice(-400)}`);
    }
    run('git', ['fetch', 'origin', 'refs/heads/main'], input.cwd);
    if (run('git', ['rev-parse', 'FETCH_HEAD'], input.cwd) !== base) throw new Error('main advanced during queue verification; retry on latest main');
    const current = view();
    if (current.headRefOid !== first.headRefOid || current.headRefName !== first.headRefName || current.baseRefName !== 'main' || current.state !== 'OPEN' || current.isDraft !== false || current.isCrossRepository !== false) throw new Error('PR changed during queue verification');
    const integrated = run('git', ['rev-parse', 'HEAD'], temp);
    const remoteHead = run('git', ['ls-remote', 'origin', `refs/heads/${first.headRefName}`], temp).split(/\s+/)[0];
    if (remoteHead !== input.matchHeadCommit) throw new Error('PR branch advanced before queue push');
    run('git', ['fetch', 'origin', 'refs/heads/main'], input.cwd);
    if (run('git', ['rev-parse', 'FETCH_HEAD'], input.cwd) !== base) throw new Error('main advanced before queue merge; retry on latest main');
    // One atomic push (review must-fix: head check and merge were not atomic): the PR branch moves to the tested commit only
    // while it still equals the pinned head (lease), and main moves to the same commit only as a fast-forward. The server
    // applies both ref updates or neither, so an advanced PR head or main rejects the whole merge — nothing stale lands.
    // main then contains the PR head, so GitHub records the PR as merged.
    run('git', ['push', '--atomic', `--force-with-lease=refs/heads/${first.headRefName}:${input.matchHeadCommit}`, 'origin',
      `HEAD:refs/heads/${first.headRefName}`, 'HEAD:refs/heads/main'], temp);
    // The push itself is the merge decision; confirm main holds exactly the tested commit (a later push to the PR branch is a new change, not this merge).
    run('git', ['fetch', 'origin', 'refs/heads/main'], input.cwd);
    if (run('git', ['rev-parse', 'FETCH_HEAD'], input.cwd) !== integrated) throw new Error('main does not point to tested merge commit');
    return { merged: true, baseRefName: 'main', mergeCommit: integrated };
  } catch (error) {
    return { merged: false, detail: String(error) };
  } finally {
    if (attached && temp) execute('git', ['worktree', 'remove', '--force', temp], input.cwd);
    if (temp) rmSync(temp, { recursive: true, force: true });
    release?.();
  }
}
