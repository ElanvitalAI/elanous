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
import { latestGraphRun, listGraphRuns, runGraph, type GraphRunOptions, type GraphRunState } from './runner.js';
import { createDefaultMarketDataRegistry } from './capability-providers/market-data/registry.js';
import { claimGraphTriggerDispatchLease, GRAPH_TRIGGER_DISPATCH_LEASE_MS, GRAPH_TRIGGER_DISPATCH_RENEWAL_DIVISOR,
  getGraphTriggerDispatchBinding, releaseGraphTriggerDispatchLease, renewGraphTriggerDispatchLease,
  isGraphTriggerDispatchLeaseOwnerActive, withGraphTriggerDispatchLeaseFence } from '../loops/graph-trigger-dispatch-lease.js';

export interface GraphTickOptions {
  startIfIdle?: boolean;
  /** Resume this exact persisted run instead of whichever run happens to be latest. */
  resumeRunId?: string;
  /** Stable upstream trigger identity; absent values give this tick a unique dispatch key. */
  triggerId?: string;
  dedupeKey?: string;
  /** Explicit registry location for isolated tests or multi-root dispatch deployments. */
  registryRoot?: string;
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
    capabilityProviders: options.deps?.capabilityProviders ?? createDefaultMarketDataRegistry(),
    beforeNode: () => {
      options.deps?.beforeNode?.();
      nodeRefusal = peerRefusal([...new Set([...initial.ids, ...inspect().ids])]);
      if (nodeRefusal) throw peerEditRefused;
    },
  };
  const root = options.deps?.root ?? effectiveInstanceRoot();
  const tickId = `graph-${randomUUID()}`;
  const triggerId = options.triggerId ?? `graph:${graphId}`;
  const dedupeKey = options.dedupeKey ?? options.resumeRunId ?? tickId;
  const registryRoot = options.registryRoot ?? effectiveInstanceRoot();
  const priorBinding = getGraphTriggerDispatchBinding({ triggerId, dedupeKey, graphId }, { registryRoot });
  const boundRoot = priorBinding?.stateRoot ?? root;
  if (options.deps?.root && priorBinding && resolve(root) !== resolve(priorBinding.stateRoot))
    throw new Error(`graph trigger dispatch binding conflict: ${triggerId}/${dedupeKey}`);
  const observedLatest = priorBinding
    ? listGraphRuns(boundRoot).runs.find(run => run.graphId === graphId && run.runId === priorBinding.runId) ?? null
    : options.resumeRunId
      ? listGraphRuns(boundRoot).runs.find(run => run.graphId === graphId && run.runId === options.resumeRunId) ?? null
      : latestGraphRun(graphId, boundRoot);
  if (options.resumeRunId && !observedLatest) throw new Error(`graph run not found: ${graphId}/${options.resumeRunId}`);
  const suggestedRunId = priorBinding?.runId ?? (observedLatest && (observedLatest.status === 'running' || observedLatest.status === 'awaiting-approval')
    ? observedLatest.runId : tickId);
  const leaseClaim = claimGraphTriggerDispatchLease({ triggerId, dedupeKey, graphId, runId: suggestedRunId },
    { registryRoot, stateRoot: boundRoot });
  if (!leaseClaim.claimed) return { action: 'waiting', runId: leaseClaim.lease.runId };
  const executionRoot = leaseClaim.lease.stateRoot;
  const lock = join(executionRoot, 'graph-runs', graphId, '.tick.lock');
  mkdirSync(join(executionRoot, 'graph-runs', graphId), { recursive: true });
  let acquired = false;
  let releaseRecovery: (() => void) | undefined;
  try {
    releaseRecovery = await acquireRecoveryGuard(`${lock}.recovery.guard`, graphId);
    acquireTickLock(lock, graphId, options.deps?.isAlive ?? processAlive,
      leaseClaim.reclaimedOwner, leaseClaim.lease.owner, registryRoot);
    acquired = true;
    releaseRecovery();
    releaseRecovery = undefined;
    await options.deps?.notify?.();
    const current = inspect();
    const refusedAfterNotify = peerRefusal([...new Set([...initial.ids, ...current.ids])]);
    if (refusedAfterNotify) return refusedAfterNotify;
    // The run identity and executed bytes must agree with the ledger and the gate.
    if (current.graphId !== graphId) throw new Error(`graph id changed during tick: ${graphId} -> ${current.graphId}`);
    const latest = leaseClaim.lease.runId === tickId && !priorBinding
      ? latestGraphRun(graphId, executionRoot)
      : listGraphRuns(executionRoot).runs.find(run => run.graphId === graphId && run.runId === leaseClaim.lease.runId) ?? null;
    if (options.resumeRunId && !latest) throw new Error(`graph run not found: ${graphId}/${options.resumeRunId}`);
    const legacyApprovalNeedsReissue = latest?.status === 'awaiting-approval' && !!latest.pending &&
      !latest.pending.inputSha256 && !latest.growthPark;
    if (options.resumeRunId && (latest?.status !== 'awaiting-approval' || (!latest.pending?.decision && !legacyApprovalNeedsReissue))) {
      throw new Error(`graph run is not awaiting a recorded decision: ${graphId}/${options.resumeRunId}`);
    }
    const growthCard = latest?.growthPark
      ? (options.deps?.growthDecision?.list ?? ((filters: { status: 'all' }) => new DecisionLedger({ stateDir: root }).list(filters)))({ status: 'all' })
        .find(entry => entry.id === latest.growthPark?.decisionId && entry.refs?.includes(latest.growthPark.decisionRef))
      : undefined;
    const growthDecided = growthCard?.status === 'decided' && growthCard.decidedBy?.kind === 'human' &&
      (growthCard.choice === 'a' || growthCard.choice === 'b');
    let result: GraphTickResult;
    if (latest?.status === 'awaiting-approval' && !latest.pending?.decision && !growthDecided && !legacyApprovalNeedsReissue) {
      result = { action: 'waiting', runId: latest.runId, status: latest.status };
    } else if (latest?.status === 'running' || (latest?.status === 'awaiting-approval' && (latest.pending?.decision || growthDecided || legacyApprovalNeedsReissue)) || options.startIfIdle) {
      const resuming = latest?.status === 'running' || (latest?.status === 'awaiting-approval' && (latest.pending?.decision || growthDecided || legacyApprovalNeedsReissue));
      const runId = resuming ? latest!.runId : leaseClaim.lease.runId;
      if (priorBinding && latest && !resuming && latest.status !== 'running' && latest.status !== 'awaiting-approval') {
        result = { action: 'idle', runId, status: latest.status };
      } else {
        let leaseOwned = true;
        const renew = () => {
          try { leaseOwned = leaseOwned && renewGraphTriggerDispatchLease(leaseClaim.lease); }
          catch { leaseOwned = false; }
        };
        const leaseTimer = setInterval(renew, Math.floor(GRAPH_TRIGGER_DISPATCH_LEASE_MS / GRAPH_TRIGGER_DISPATCH_RENEWAL_DIVISOR));
        leaseTimer.unref?.();
        const beforePersist = (state: GraphRunState) => {
          runDeps.beforePersist?.(state);
          if (!leaseOwned || !renewGraphTriggerDispatchLease(leaseClaim.lease)) {
            leaseOwned = false;
            throw new Error(`graph trigger dispatch lease lost: ${leaseClaim.lease.triggerId}/${leaseClaim.lease.dedupeKey}`);
          }
        };
        const withPersistFence = (state: GraphRunState, persist: () => void) =>
          withGraphTriggerDispatchLeaseFence(leaseClaim.lease, persist);
        try {
          const state = await runGraph(path, resuming
            ? { resumeRunId: runId, graphSource: current.source, deps: { ...runDeps, root: executionRoot, beforePersist, withPersistFence } }
            : { runId, input: options.input, graphSource: current.source, deps: { ...runDeps, root: executionRoot, beforePersist, withPersistFence } });
          result = { action: resuming ? 'resumed' : 'started', runId: state.runId, status: state.status };
        } finally {
          clearInterval(leaseTimer);
        }
      }
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
        const ours = `${process.pid}\n${leaseClaim.lease.owner}`;
        try {
          releaseRecovery = await acquireRecoveryGuard(`${lock}.recovery.guard`, graphId);
          if (readFileSync(join(lock, 'owner'), 'utf8') === ours) {
            unlinkSync(join(lock, 'owner'));
            rmdirSync(lock);
          }
        } finally {
          releaseRecovery?.();
          releaseRecovery = undefined;
        }
      }
    } finally {
      releaseRecovery?.();
      releaseGraphTriggerDispatchLease(leaseClaim.lease);
    }
  }
}

// Keep only lock-directory inspection/recovery serialized; the lease fences
// active persistence and lets an expired delivery replace a still-live pid.
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

/** A crashed or lease-expired tick must not wedge the schedule; lock owner records pid and lease token. */
function acquireTickLock(lock: string, graphId: string, isAlive: (pid: number) => boolean, reclaimedOwner?: string, leaseOwner?: string,
  registryRoot?: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { mkdirSync(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let ownerText: string | undefined;
      try { ownerText = readFileSync(join(lock, 'owner'), 'utf8').trim(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const [pidText, lockLeaseOwner] = ownerText?.split('\n') ?? [];
      const owner = pidText ? Number(pidText) : Number.NaN;
      // The stable flock spans the whole tick. An absent or empty owner is
      // safe to reclaim after a crash, including before or during owner creation.
      const liveLease = !!lockLeaseOwner && !!registryRoot && isGraphTriggerDispatchLeaseOwnerActive(registryRoot, lockLeaseOwner);
      const deadOwner = Number.isInteger(owner) && owner > 0 && !isAlive(owner) && !liveLease;
      const expiredLeaseOwner = !!reclaimedOwner && lockLeaseOwner === reclaimedOwner;
      if (attempt === 0 && (deadOwner || Number.isNaN(owner) || expiredLeaseOwner)) {
        let currentOwnerText: string | undefined;
        try { currentOwnerText = readFileSync(join(lock, 'owner'), 'utf8').trim(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (currentOwnerText !== ownerText || (ownerText !== undefined && ownerText !== '' && !deadOwner && !expiredLeaseOwner)) {
          throw new Error(`graph tick lock owner changed: ${graphId}`);
        }
        if (currentOwnerText !== undefined) unlinkSync(join(lock, 'owner'));
        rmdirSync(lock);
        debug.log('graph.runner', 'tick-lock-recovered', { graphId, owner });
        continue;
      }
      throw new Error(`graph tick already running: ${graphId}${Number.isInteger(owner) && owner > 0 ? ` (pid ${owner})` : ''}`);
    }
    try { writeFileSync(join(lock, 'owner'), `${process.pid}\n${leaseOwner ?? ''}`, { flag: 'wx' }); }
    catch (error) {
      try { rmdirSync(lock); } catch { /* another owner may have claimed the empty directory */ }
      throw error;
    }
    return;
  }
  throw new Error(`graph tick already running: ${graphId}`);
}
