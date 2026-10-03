import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEXT_MD_PATH, resolveNextMdConflict } from '../release-loop/next-md-merge.js';

type Command = (bin: string, args: readonly string[], cwd: string) => { status: number | null; stdout: string; stderr: string };
export type L8MergeQueueInput = { number: number; cwd: string; matchHeadCommit: string };
export type L8MergeQueueResult = { merged: boolean; baseRefName?: string; mergeCommit?: string; detail?: string };
export type L8MergeQueueDeps = {
  command?: Command;
  /** Must identify the same shared repository across all harness processes. */
  acquire?: (cwd: string) => Promise<() => void>;
};

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
