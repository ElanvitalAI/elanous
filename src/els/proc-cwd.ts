import { Worker } from 'node:worker_threads';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** Demand-driven macOS shell PID cwd fallback. No polling, database access, or key-path hooks.
 * Dispose with the owning server. Results are observations, not process identity: the
 * caller must re-check its live PTY generation and OSC authority before persisting. */
export function createProcCwdReader(options: {
  // Injectable for deterministic worker failure tests; production uses a bounded deadline.
  createWorker?: () => Worker;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
} = {}) {
  let worker: Worker | undefined;
  let closed = false;
  let sequence = 0;
  const pending = new Map<number, (cwd: string | undefined) => void>();
  const fail = (source: Worker) => {
    if (worker !== source) return;
    worker = undefined;
    for (const done of pending.values()) done(undefined);
    pending.clear();
    void source.terminate();
  };
  function start(): Worker {
    if (worker) return worker;
    const extension = import.meta.url.endsWith('/proc-cwd.ts') ? 'ts' : 'js';
    const w = options.createWorker?.() ?? new Worker(new URL(`./proc-cwd-worker.${extension}`, import.meta.url));
    worker = w;
    w.unref();
    w.on('message', (message: { id: number; cwd?: string }) => {
      if (worker !== w) return;
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); done(message.cwd); }
    });
    w.on('error', () => fail(w));
    w.on('exit', () => fail(w));
    return w;
  }
  async function query(pid: number): Promise<string | undefined> {
    if (closed || (options.platform ?? process.platform) !== 'darwin' || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return undefined;
    let cwd: string | undefined;
    try {
      const w = start();
      cwd = await new Promise<string | undefined>(resolve => {
        const id = ++sequence;
        const timer = setTimeout(() => fail(w), options.timeoutMs ?? 2_000);
        timer.unref();
        pending.set(id, value => { clearTimeout(timer); resolve(value); });
        try { w.postMessage({ id, pid }); } catch { fail(w); }
      });
      if (closed || !cwd || !isAbsolute(cwd) || cwd.includes('\0')) return undefined;
      return (await stat(cwd)).isDirectory() && !closed ? cwd : undefined;
    } catch { return undefined; }
  }
  return {
    read(pid: number): Promise<string | undefined> {
      // Each request is a fresh observation: a shell may cd during an earlier read.
      return query(pid);
    },
    dispose(): void {
      closed = true;
      if (worker) fail(worker);
    },
  };
}
