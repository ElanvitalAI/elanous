import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beginResourceLease, endResourceLease, type ResourceLane } from './resource-ledger.js';
import { testProcessSignal } from '../instance/test-write-guard.js';

export interface HeartbeatWorkerOptions {
  intervalMs?: number;
  /** Test-only shared mock clock. Production callers must omit this. */
  mockClock?: SharedArrayBuffer;
  /** Test-only signal incremented after each durable heartbeat. */
  mockHeartbeatCounter?: SharedArrayBuffer;
}

export function resourceLeaseHeartbeatInterval(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs < 30_000) throw new Error('resource lease ttl must be at least 30000ms for heartbeat');
  return Math.max(1, Math.min(30_000, Math.floor(ttlMs / 3)));
}

export async function startResourceLeaseHeartbeatWorker(leaseId: string, ledgerPath?: string,
  options: HeartbeatWorkerOptions = {}): Promise<() => Promise<void>> {
  const modulePath = fileURLToPath(import.meta.url).replace(/lease-heartbeat-worker\.(ts|js)$/, 'resource-ledger.$1');
  const moduleUrl = pathToFileURL(modulePath).href;
  const failureBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { heartbeatResourceLease } = await import(workerData.moduleUrl);
      const beat = (at) => {
        heartbeatResourceLease(workerData.leaseId, undefined, new Date(at), workerData.ledgerPath);
        if (workerData.mockHeartbeatCounter) {
          const counter = new Int32Array(workerData.mockHeartbeatCounter);
          Atomics.add(counter, 0, 1);
          Atomics.notify(counter, 0);
        }
      };
      let timer;
      if (workerData.mockClock) {
        const clock = new BigInt64Array(workerData.mockClock);
        let last = Atomics.load(clock, 0);
        const interval = BigInt(workerData.intervalMs);
        beat(Number(last));
        parentPort.postMessage({ ready: true });
        timer = setInterval(() => {
          const now = Atomics.load(clock, 0);
          if (now - last < interval) return;
          last = now;
          try { beat(Number(now)); } catch (error) {
            Atomics.store(new Int32Array(workerData.failureBuffer), 0, 1);
            parentPort.postMessage({ error: String(error) }); process.exit(1);
          }
        }, 1);
      } else {
        beat(Date.now());
        parentPort.postMessage({ ready: true });
        timer = setInterval(() => {
          try { beat(Date.now()); } catch (error) {
            Atomics.store(new Int32Array(workerData.failureBuffer), 0, 1);
            parentPort.postMessage({ error: String(error) }); process.exit(1);
          }
        }, workerData.intervalMs);
      }
      parentPort.on('message', message => {
        if (!message || message.stop !== true) return;
        clearInterval(timer);
        parentPort.postMessage({ stopped: true });
        parentPort.close();
      });
    })().catch(error => parentPort.postMessage({ error: String(error) }));
  `, { eval: true, workerData: { moduleUrl, leaseId, ledgerPath, failureBuffer, intervalMs: options.intervalMs ?? 30_000,
    ...(options.mockClock ? { mockClock: options.mockClock } : {}),
    ...(options.mockHeartbeatCounter ? { mockHeartbeatCounter: options.mockHeartbeatCounter } : {}) } });
  worker.unref();
  let exited: number | undefined;
  let workerError: Error | undefined;
  worker.on('exit', code => { exited = code; });
  worker.on('error', error => { workerError = error; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('resource heartbeat worker readiness timed out'));
    }, 5_000);
    worker.once('message', (message: { ready?: boolean; error?: string }) => {
      clearTimeout(timer);
      if (message.ready) resolve();
      else {
        void worker.terminate();
        reject(new Error(message.error ?? 'resource heartbeat worker failed before ready'));
      }
    });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`resource heartbeat worker exited before ready (${code})`));
    });
  });
  return async () => {
    if (exited !== undefined || workerError) throw workerError ?? new Error(`resource heartbeat worker already exited (${exited})`);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('exit', onExit);
        worker.off('error', onError);
        if (error) reject(error); else resolve();
      };
      const onMessage = (message: { stopped?: boolean; error?: string }) => {
        if (message.stopped) finish();
        else if (message.error) finish(new Error(message.error));
      };
      const onExit = (code: number) => finish(new Error(`resource heartbeat worker exited before stop (${code})`));
      const onError = (error: Error) => finish(error);
      const timer = setTimeout(() => {
        void worker.terminate();
        finish(new Error('resource heartbeat worker stop timed out'));
      }, 5_000);
      worker.on('message', onMessage);
      worker.once('exit', onExit);
      worker.once('error', onError);
      if (exited !== undefined || workerError) finish(workerError ?? new Error(`resource heartbeat worker already exited (${exited})`));
      else worker.postMessage({ stop: true });
    });
    if (Atomics.load(new Int32Array(failureBuffer), 0) !== 0) throw new Error('resource heartbeat worker failed during operation');
  };
}

/** C/U/D around an operation whose owner event loop cannot run interval callbacks. */
export async function withBlockingResourceLease<T>(input: {
  host: string; lane: ResourceLane; ttlMs: number;
  resources?: { cpu?: number; memoryBytes?: number; shards?: number; pods?: number };
  mission?: { cell?: string; goalId?: string; pr?: number };
}, run: (leaseId: string) => T, deps: {
  /** Test seam for proving end-lease failures stay visible to the caller. */
  endLease?: typeof endResourceLease;
  startHeartbeat?: typeof startResourceLeaseHeartbeatWorker;
  statePath?: string;
} = {}): Promise<T> {
  const intervalMs = resourceLeaseHeartbeatInterval(input.ttlMs);
  const fp = `fp_${randomUUID().replaceAll('-', '')}`;
  const started = beginResourceLease({ fp, host: input.host, lane: input.lane,
    resources: input.resources ?? {}, mission: input.mission ?? {}, ttlMs: input.ttlMs }, deps.statePath);
  let stop: (() => Promise<void>) | undefined;
  let operationError: unknown;
  try {
    stop = deps.startHeartbeat
      ? await deps.startHeartbeat(started.id, deps.statePath)
      : testProcessSignal() ? async () => {} : await startResourceLeaseHeartbeatWorker(started.id, deps.statePath,
        { intervalMs });
    return await run(started.id);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try { await stop?.(); } catch (error) { cleanupError = error; }
    try {
      (deps.endLease ?? endResourceLease)(started.id, 'blocking operation finished', process.env.ELANOUS_HARNESS_SEAT ?? 'unknown', new Date(), deps.statePath);
    } catch (error) {
      cleanupError = cleanupError ? new AggregateError([cleanupError, error], 'resource lease cleanup failed') : error;
    }
    if (cleanupError) {
      if (operationError) throw new AggregateError([operationError, cleanupError], 'operation and resource lease cleanup failed');
      throw cleanupError;
    }
  }
}
