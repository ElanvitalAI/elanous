import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listActiveTerminalDirectories, isWorktreeInUse } from '../harness/harness-clean.js';
import type { MacrophageScrap } from './macrophage-heal.js';

export interface MacrophageSafeCleanupOptions {
  readonly repoRoot: string;
  readonly queueFile?: string;
  readonly worktreeRoot?: string;
  readonly run?: (command: string, args: string[], cwd?: string) => { status: number | null; stdout: string; stderr: string };
  readonly activeDirectories?: () => readonly string[];
}

function defaultRun(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function inside(root: string, path: string): boolean {
  let physicalRoot: string;
  let physicalPath: string;
  try { physicalRoot = realpathSync(root); physicalPath = realpathSync(path); }
  catch { return false; }
  const rel = relative(physicalRoot, physicalPath);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The cleanup worker itself is an active user of its checkout even without a registered terminal. */
function containsCurrentProcess(worktreePath: string): boolean {
  try {
    const rel = relative(realpathSync(worktreePath), realpathSync(process.cwd()));
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  } catch { return true; }
}

function parseWorktrees(output: string): Array<{ path: string; branch: string }> {
  const rows: Array<{ path: string; branch: string }> = [];
  let current: { path?: string; branch?: string } = {};
  const flush = () => { if (current.path && current.branch) rows.push({ path: current.path, branch: current.branch }); current = {}; };
  for (const line of output.split('\n')) {
    if (!line) { flush(); continue; }
    if (line.startsWith('worktree ')) current.path = line.slice(9);
    if (line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length);
  }
  flush();
  return rows;
}

function mergedPr(run: NonNullable<MacrophageSafeCleanupOptions['run']>, number: string): boolean {
  const result = run('gh', ['pr', 'view', number, '--repo', 'ElanvitalAI/elanous', '--json', 'state,mergedAt']);
  if (result.status !== 0) return false;
  try {
    const value = JSON.parse(result.stdout) as { state?: unknown; mergedAt?: unknown };
    return value.state === 'MERGED' && typeof value.mergedAt === 'string' && Number.isFinite(Date.parse(value.mergedAt));
  } catch { return false; }
}

function queueRows(queueFile: string): string[] {
  if (!existsSync(queueFile)) return [];
  return readFileSync(queueFile, 'utf8').split('\n').filter(Boolean);
}

function parseQueueRow(row: string): { number: string; head: string } | undefined {
  const [number, head, tree, evidence, ...rest] = row.split('\t');
  if (rest.length || !/^\d+$/.test(number ?? '') || !/^[0-9a-f]{40}$/i.test(head ?? '')
    || !isAbsolute(tree ?? '') || !isAbsolute(evidence ?? '')) return undefined;
  return { number: number!, head: head! };
}

function withQueueLock<T>(queueFile: string, action: () => T): T {
  const lockDir = `${queueFile}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { mkdirSync(lockDir); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  if (!acquired) throw new Error(`land queue lock busy: ${lockDir}`);
  try { return action(); } finally { rmSync(lockDir, { recursive: true, force: true }); }
}

export function createMacrophageSafeCleanup(options: MacrophageSafeCleanupOptions): {
  inventory(): MacrophageScrap[];
  cleanup(scrap: MacrophageScrap): string | undefined;
} {
  const repoRoot = resolve(options.repoRoot);
  const queueFile = resolve(options.queueFile ?? join(homedir(), 'elanous-hq/seat-state/OP/land-queue.tsv'));
  const worktreeRoot = resolve(options.worktreeRoot ?? join(homedir(), 'elanous-hq/work'));
  const run = options.run ?? defaultRun;
  const readActiveDirectories = (): { ok: boolean; value: readonly string[] } => {
    if (options.activeDirectories) return { ok: true, value: options.activeDirectories() };
    const result = listActiveTerminalDirectories();
    return result.ok ? { ok: true, value: result.value } : { ok: false, value: [] };
  };

  const inventory = (): MacrophageScrap[] => {
    const scraps: MacrophageScrap[] = [];
    for (const row of queueRows(queueFile)) {
      const parsed = parseQueueRow(row);
      if (!parsed || !mergedPr(run, parsed.number)) continue;
      scraps.push({ id: `land-queue:${parsed.number}:${parsed.head}`, kind: 'merged-land-queue-row',
        evidence: { mergedMainline: true, queueRow: row, detail: `merged PR #${parsed.number} exact queue row` } });
    }

    const listed = run('git', ['worktree', 'list', '--porcelain'], repoRoot);
    const merged = run('git', ['branch', '--merged', 'origin/main', '--format=%(refname:short)'], repoRoot);
    if (listed.status !== 0 || merged.status !== 0) return scraps;
    const mergedBranches = new Set(merged.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
    const active = readActiveDirectories();
    if (!active.ok) return scraps;
    for (const worktree of parseWorktrees(listed.stdout)) {
      if (!inside(worktreeRoot, worktree.path) || !mergedBranches.has(worktree.branch)
        || containsCurrentProcess(worktree.path)) continue;
      const status = run('git', ['status', '--porcelain', '--untracked-files=all'], worktree.path);
      if (status.status !== 0 || status.stdout.trim() || isWorktreeInUse(worktree.path, active.value)) continue;
      scraps.push({ id: `worktree:${worktree.branch}:${basename(worktree.path)}`, kind: 'orphan-worktree',
        owner: worktree.branch, evidence: { ownerRunStatus: 'done', ownershipVerified: true, mergedMainline: true,
          worktreePath: worktree.path, detail: 'under HQ work root; merged to origin/main; clean; no active terminal uses it' } });
    }
    return scraps;
  };

  const cleanup = (scrap: MacrophageScrap): string | undefined => {
    if (scrap.kind === 'merged-land-queue-row') {
      const row = scrap.evidence.queueRow;
      const parsed = typeof row === 'string' ? parseQueueRow(row) : undefined;
      if (!parsed || !scrap.evidence.mergedMainline || !mergedPr(run, parsed.number)) return undefined;
      return withQueueLock(queueFile, () => {
        if (lstatSync(queueFile).isSymbolicLink()) return undefined;
        const current = queueRows(queueFile);
        if (!current.includes(row!)) return undefined;
        const next = current.filter((entry) => entry !== row).join('\n');
        const temp = `${queueFile}.${randomUUID()}.tmp`;
        writeFileSync(temp, next ? `${next}\n` : '', { mode: statSync(queueFile).mode & 0o777 });
        renameSync(temp, queueFile);
        return `removed exact stale land-queue row for merged PR #${parsed.number}`;
      });
    }
    if (scrap.kind === 'orphan-worktree') {
      const worktreePath = scrap.evidence.worktreePath;
      const branch = scrap.owner;
      if (typeof worktreePath !== 'string' || !branch || !scrap.evidence.mergedMainline
        || !inside(worktreeRoot, worktreePath) || containsCurrentProcess(worktreePath)) return undefined;
      const merged = run('git', ['merge-base', '--is-ancestor', branch, 'origin/main'], repoRoot);
      const status = run('git', ['status', '--porcelain', '--untracked-files=all'], worktreePath);
      if (merged.status !== 0 || status.status !== 0 || status.stdout.trim()) return undefined;
      const active = readActiveDirectories();
      if (!active.ok || isWorktreeInUse(worktreePath, active.value)) return undefined;
      const removed = run('git', ['worktree', 'remove', worktreePath], repoRoot);
      return removed.status === 0 ? `removed clean inactive merged worktree ${branch}` : undefined;
    }
    return undefined;
  };
  return { inventory, cleanup };
}
