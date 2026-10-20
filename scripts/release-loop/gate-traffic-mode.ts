import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../src/debug/log.js';

type TrafficBoard = Record<string, unknown> & { global: string };
type PatchResult = { changed: true; previous: string; warning?: string } | { changed: false; current: string };

const defaultTrafficPath = () => join(homedir(), 'elanous-hq', 'seat-state', 'OP', 'traffic.json');
const trafficPath = (env: NodeJS.ProcessEnv) => env.ELANOUS_TRAFFIC_SIGNAL || defaultTrafficPath();

function releaseGateContext(env: NodeJS.ProcessEnv): boolean {
  const source = env.ELANOUS_GRAPH_CONTEXT;
  if (!source) return false;
  try {
    const raw = JSON.parse(source.trimStart().startsWith('{') ? source : readFileSync(source, 'utf8')) as Record<string, unknown>;
    return raw.graphId === 'release-loop' && raw.nodeId === 'gate';
  } catch {
    return false;
  }
}

function withTrafficLock<T>(path: string, action: () => T): T {
  const lock = `${path}.lock.d`;
  const deadline = Date.now() + 10_000;
  for (let attempt = 1; attempt <= 100; attempt++) {
    try { mkdirSync(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = statSync(lock).mtimeMs;
        const owner = Number(readFileSync(join(lock, 'pid'), 'utf8').trim());
        if (Date.now() - stat > 60_000 && Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); }
          catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code === 'ESRCH'
              && Number(readFileSync(join(lock, 'pid'), 'utf8').trim()) === owner) {
              try { renameSync(lock, `${lock}.stale.${process.pid}.${attempt}`); } catch { /* owner may have released it */ }
            }
          }
        }
      } catch { /* unknown owner and unreadable locks are never reaped */ }
      if (attempt === 100 || Date.now() >= deadline) throw new Error(`traffic lock timeout: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      continue;
    }
    try {
      writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
      return action();
    } finally {
      rmSync(join(lock, 'pid'), { force: true });
      try { rmdirSync(lock); } catch { /* another writer replaced the lock directory */ }
    }
  }
  throw new Error(`traffic lock timeout: ${lock}`);
}

function patchGlobal(path: string, next: string, reason: string, onlyIf?: string): PatchResult {
  return withTrafficLock(path, () => {
    if (!existsSync(path)) throw new Error(`traffic board missing: ${path}`);
    const board = JSON.parse(readFileSync(path, 'utf8')) as TrafficBoard;
    if (!board || typeof board !== 'object' || Array.isArray(board) || typeof board.global !== 'string') {
      throw new Error(`invalid traffic board: ${path}`);
    }
    if (onlyIf !== undefined && board.global !== onlyIf) return { changed: false, current: board.global };
    const updated: TrafficBoard = { ...board, global: next, reason, updatedAt: new Date().toISOString() };
    const at = new Date();
    const stamp = [at.getMonth() + 1, at.getDate(), at.getHours(), at.getMinutes(), at.getSeconds()].map(value => String(value).padStart(2, '0')).join('');
    const suffix = `bak-${stamp}-${randomUUID().slice(0, 8)}-global-${next}`;
    const backup = `${path}.${suffix}`;
    const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
    const payload = `${JSON.stringify(updated)}\n`;
    writeFileSync(backup, readFileSync(path));
    writeFileSync(temp, payload, { mode: statSync(path).mode & 0o777 });
    try { renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
    try {
      const verify = JSON.parse(readFileSync(path, 'utf8')) as TrafficBoard;
      if (verify.global !== next) return { changed: true, previous: board.global, warning: `traffic verification mismatch: ${path}` };
    } catch (error) {
      // rename already committed the requested mode; keep the lease so the caller still attempts cleanup.
      return { changed: true, previous: board.global, warning: `traffic verification failed: ${String(error)}` };
    }
    return { changed: true, previous: board.global };
  });
}

/** Hold dispatcher traffic at gate only for the release-loop's gate node, then restore conditionally. */
export async function runWithReleaseGateTraffic<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  if (!releaseGateContext(env)) return run();
  const path = trafficPath(env);
  let started: PatchResult;
  try { started = patchGlobal(path, 'gate', 'release gate running', 'green'); }
  catch (error) {
    debug.log('release-loop.gate', 'traffic gate set failed', { path, error: String(error) }, { level: 'warn' });
    return run(); // The traffic board is advisory; it must not block publication.
  }
  if (!started.changed) return run(); // Existing gate/yellow (or any operator change) belongs to its owner.
  if (started.warning) debug.log('release-loop.gate', 'traffic gate verification failed', { path, error: started.warning }, { level: 'warn' });
  let restoreResult: Promise<void> | undefined;
  const restoreOnce = () => restoreResult ??= Promise.resolve().then(() => {
    try {
      const restored = patchGlobal(path, started.previous, 'release gate finished', 'gate');
      if (!restored.changed) debug.log('release-loop.gate', 'traffic restore skipped', { path, current: restored.current }, { level: 'warn' });
      else if (restored.warning) debug.log('release-loop.gate', 'traffic restore verification failed', { path, error: restored.warning }, { level: 'warn' });
    } catch (error) {
      debug.log('release-loop.gate', 'traffic restore failed', { path, error: String(error) }, { level: 'warn' });
    }
  });
  const interrupt = (signal: NodeJS.Signals) => {
    void restoreOnce().finally(() => {
      process.removeListener(signal, signal === 'SIGINT' ? onSigint : onSigterm);
      process.kill(process.pid, signal);
    });
  };
  const onSigint = () => interrupt('SIGINT');
  const onSigterm = () => interrupt('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    return await run();
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    await restoreOnce();
  }
}
