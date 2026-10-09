import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { peerEditRunGate } from '../nexus/api/graph-peer-edit.js';
import { observeModelInputTokens } from '../harness/model-input-observation.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { latestGraphRun, runGraph, type GraphRunOptions, type GraphRunState } from './runner.js';

export interface GraphTickOptions {
  startIfIdle?: boolean;
  input?: unknown;
  mineDir?: string;
  deps?: GraphRunOptions['deps'] & { notify?: () => void | Promise<void>; isAlive?: (pid: number) => boolean };
}

export interface GraphTickResult {
  action: 'waiting' | 'resumed' | 'started' | 'idle' | 'refused';
  runId?: string;
  status?: GraphRunState['status'] | 'refused';
  reason?: 'peer-edit-unapproved' | 'peer-edit-unreadable';
}

/** One tick owns the graph from the latest-state read through notification and the chosen action. */
export async function graphTick(path: string, options: GraphTickOptions = {}): Promise<GraphTickResult> {
  const mineDir = options.mineDir ?? join(elanousStateRoot(), 'graphs');
  const inside = (dir: string, file: string): boolean => {
    const contained = relative(dir, file);
    return contained !== '' && contained !== '..' && !contained.startsWith(`..${sep}`) && !isAbsolute(contained);
  };
  const inspect = (): { source: string; graphId: string; ids: string[] } => {
    const source = readFileSync(path, 'utf8');
    const document: unknown = parseYaml(source);
    const graphId = document && typeof document === 'object' && !Array.isArray(document)
      ? (document as Record<string, unknown>).graph_id : undefined;
    if (typeof graphId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(graphId) || graphId === '.' || graphId === '..') {
      throw new Error(`invalid graph id: ${String(graphId)}`);
    }
    const ids: string[] = [];
    const file = resolve(path);
    const realFile = realpathSync(path);
    let realMine: string | undefined;
    try { realMine = realpathSync(mineDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const candidate of [file, realFile]) {
      if (inside(resolve(mineDir), candidate) || (realMine && inside(realMine, candidate))) {
        const name = basename(candidate);
        if (/\.ya?ml$/.test(name)) ids.push(name.replace(/\.ya?ml$/, ''));
      }
    }
    if (ids.length) ids.push(graphId);
    return { source, graphId, ids: [...new Set(ids)] };
  };
  const initial = inspect();
  const graphId = initial.graphId;
  const peerRefusal = (ids: string[]): GraphTickResult | null => {
    for (const id of ids) {
      const gate = peerEditRunGate(mineDir, id);
      if (gate.ok) continue;
      debug.log('graph.runner', 'tick-peer-edit-refused', {
        id,
        editedBy: gate.error === 'peer-edit-unapproved' ? gate.record.editedBy : undefined,
        version: gate.error === 'peer-edit-unapproved' ? gate.record.version : undefined,
      });
      return { action: 'refused', status: 'refused', reason: gate.error };
    }
    return null;
  };
  const refused = peerRefusal(initial.ids);
  if (refused) return refused;
  const peerEditRefused = Symbol('tick-peer-edit-refused');
  let nodeRefusal: GraphTickResult | null = null;
  const runDeps: GraphRunOptions['deps'] = {
    ...options.deps,
    beforeNode: () => {
      options.deps?.beforeNode?.();
      nodeRefusal = peerRefusal([...new Set([...initial.ids, ...inspect().ids])]);
      if (nodeRefusal) throw peerEditRefused;
    },
  };
  const root = options.deps?.root ?? effectiveInstanceRoot();
  const lock = join(root, 'graph-runs', graphId, '.tick.lock');
  mkdirSync(join(root, 'graph-runs', graphId), { recursive: true });
  const releaseRecovery = await acquireRecoveryGuard(`${lock}.recovery.guard`, graphId);
  const tickId = `graph-${randomUUID()}`;
  let acquired = false;
  try {
    acquireTickLock(lock, graphId, options.deps?.isAlive ?? processAlive);
    acquired = true;
    await options.deps?.notify?.();
    const current = inspect();
    const refusedAfterNotify = peerRefusal([...new Set([...initial.ids, ...current.ids])]);
    if (refusedAfterNotify) return refusedAfterNotify;
    // The run identity and executed bytes must agree with the ledger and the gate.
    if (current.graphId !== graphId) throw new Error(`graph id changed during tick: ${graphId} -> ${current.graphId}`);
    const latest = latestGraphRun(graphId, root);
    const growthCard = latest?.growthPark
      ? (options.deps?.growthDecision?.list ?? ((filters: { status: 'all' }) => new DecisionLedger({ stateDir: root }).list(filters)))({ status: 'all' })
        .find(entry => entry.id === latest.growthPark?.decisionId && entry.refs?.includes(latest.growthPark.decisionRef))
      : undefined;
    const growthDecided = growthCard?.status === 'decided' && growthCard.decidedBy?.kind === 'human' &&
      (growthCard.choice === 'a' || growthCard.choice === 'b');
    let result: GraphTickResult;
    if (latest?.status === 'awaiting-approval' && !latest.pending?.decision && !growthDecided) {
      result = { action: 'waiting', runId: latest.runId, status: latest.status };
    } else if (latest?.status === 'running' || (latest?.status === 'awaiting-approval' && (latest.pending?.decision || growthDecided))) {
      const state = await runGraph(path, { resumeRunId: latest.runId, graphSource: current.source, deps: { ...runDeps, root } });
      result = { action: 'resumed', runId: state.runId, status: state.status };
    } else if (options.startIfIdle) {
      const state = await runGraph(path, { input: options.input, graphSource: current.source, deps: { ...runDeps, root } });
      result = { action: 'started', runId: state.runId, status: state.status };
    } else {
      result = { action: 'idle' };
    }
    (options.deps?.log ?? ((event: string, data: Record<string, unknown>) => debug.log('graph.runner', event, data)))
      ('tick', { graphId, action: result.action, ...(result.runId ? { runId: result.runId } : {}) });
    return result;
  } catch (error) {
    if (error === peerEditRefused && nodeRefusal) return nodeRefusal;
    throw error;
  } finally {
    try {
      if (acquired) {
        observeModelInputTokens({ scope: 'loop-tick', nodeKind: 'graph-tick', graphId, tickId });
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
