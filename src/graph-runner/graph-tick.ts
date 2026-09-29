import { closeSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { latestGraphRun, runGraph, type GraphRunOptions, type GraphRunState } from './runner.js';

export interface GraphTickOptions {
  startIfIdle?: boolean;
  input?: unknown;
  deps?: GraphRunOptions['deps'] & { notify?: () => void | Promise<void>; isAlive?: (pid: number) => boolean };
}

export interface GraphTickResult {
  action: 'waiting' | 'resumed' | 'started' | 'idle';
  runId?: string;
  status?: GraphRunState['status'];
}

/** One tick owns the graph from the latest-state read through notification and the chosen action. */
export async function graphTick(path: string, options: GraphTickOptions = {}): Promise<GraphTickResult> {
  const document: unknown = parseYaml(readFileSync(path, 'utf8'));
  const graphId = document && typeof document === 'object' && !Array.isArray(document)
    ? (document as Record<string, unknown>).graph_id : undefined;
  if (typeof graphId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(graphId) || graphId === '.' || graphId === '..') {
    throw new Error(`invalid graph id: ${String(graphId)}`);
  }
  const root = options.deps?.root ?? effectiveInstanceRoot();
  const lock = join(root, 'graph-runs', graphId, '.tick.lock');
  mkdirSync(join(root, 'graph-runs', graphId), { recursive: true });
  const releaseRecovery = await acquireRecoveryGuard(`${lock}.recovery.guard`, graphId);
  let acquired = false;
  try {
    acquireTickLock(lock, graphId, options.deps?.isAlive ?? processAlive);
    acquired = true;
    await options.deps?.notify?.();
    const latest = latestGraphRun(graphId, root);
    let result: GraphTickResult;
    if (latest?.status === 'awaiting-approval' && !latest.pending?.decision) {
      result = { action: 'waiting', runId: latest.runId, status: latest.status };
    } else if (latest?.status === 'running' || (latest?.status === 'awaiting-approval' && latest.pending?.decision)) {
      const state = await runGraph(path, { resumeRunId: latest.runId, deps: { ...options.deps, root } });
      result = { action: 'resumed', runId: state.runId, status: state.status };
    } else if (options.startIfIdle) {
      const state = await runGraph(path, { input: options.input, deps: { ...options.deps, root } });
      result = { action: 'started', runId: state.runId, status: state.status };
    } else {
      result = { action: 'idle' };
    }
    (options.deps?.log ?? ((event: string, data: Record<string, unknown>) => debug.log('graph.runner', event, data)))
      ('tick', { graphId, action: result.action, ...(result.runId ? { runId: result.runId } : {}) });
    return result;
  } finally {
    try {
      if (acquired) {
        unlinkSync(join(lock, 'owner'));
        rmdirSync(lock);
      }
    } finally { releaseRecovery(); }
  }
}

// The stable inode is never unlinked: the kernel drops a dead claimant's
// exclusive flock even if it was killed during recovery.
async function acquireRecoveryGuard(path: string, graphId: string): Promise<() => void> {
  const library = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : process.platform === 'linux' ? 'libc.so.6' : null;
  if (!library) throw new Error('graph tick recovery requires flock');
  const { dlopen, FFIType } = await import('bun:ffi');
  const lib = dlopen(library, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  const flock = (fd: number, operation: number): number => lib.symbols.flock(fd, operation) as number;
  const fd = openSync(path, 'a');
  if (flock(fd, 2 | 4) !== 0) {
    closeSync(fd);
    throw new Error(`graph tick already running: ${graphId}`);
  }
  return () => { try { flock(fd, 8); } finally { closeSync(fd); } };
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** A crashed tick must not wedge the hourly schedule: the lock names its owner pid, and a dead owner's lock is taken over once. */
function acquireTickLock(lock: string, graphId: string, isAlive: (pid: number) => boolean): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { mkdirSync(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let ownerText: string | undefined;
      try { ownerText = readFileSync(join(lock, 'owner'), 'utf8').trim(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const owner = ownerText ? Number(ownerText) : Number.NaN;
      // The stable flock spans the whole tick. An absent or empty owner is
      // safe to reclaim after a crash, including before or during owner creation.
      const deadOwner = Number.isInteger(owner) && owner > 0 && !isAlive(owner);
      if (attempt === 0 && (deadOwner || Number.isNaN(owner))) {
        let currentOwnerText: string | undefined;
        try { currentOwnerText = readFileSync(join(lock, 'owner'), 'utf8').trim(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (currentOwnerText !== ownerText || (ownerText !== undefined && ownerText !== '' && !deadOwner)) {
          throw new Error(`graph tick lock owner changed: ${graphId}`);
        }
        if (currentOwnerText !== undefined) unlinkSync(join(lock, 'owner'));
        rmdirSync(lock);
        debug.log('graph.runner', 'tick-lock-recovered', { graphId, owner });
        continue;
      }
      throw new Error(`graph tick already running: ${graphId}${Number.isInteger(owner) && owner > 0 ? ` (pid ${owner})` : ''}`);
    }
    try { writeFileSync(join(lock, 'owner'), String(process.pid), { flag: 'wx' }); }
    catch (error) {
      try { rmdirSync(lock); } catch { /* another owner may have claimed the empty directory */ }
      throw error;
    }
    return;
  }
  throw new Error(`graph tick already running: ${graphId}`);
}
