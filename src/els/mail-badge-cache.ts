// ELS-SERVER-MAINLOOP-STARVATION — `els ls` badges from memory, never from the mail ledger on the request path.
// The listing (attach re-lists every second, the stall watcher every 30 s, CLI pollers) reads `snapshot(seats)`: the
// last badges the worker computed, at once. The snapshot only *schedules* a refresh (next macrotask, so not even the
// postMessage runs on the request stack), at most one in flight and at most one start per MIN_REFRESH_MS. The worker
// itself answers «unchanged» when the ledger did not change. Badges may be a few seconds stale — that is the trade.
//
// Failure paths: a failed refresh (read error, busy ledger, worker crash or timeout) keeps the last badges and writes
// one stderr line per failure streak; the next refresh (≥ MIN_REFRESH_MS later) tries again on a new worker if the old
// one died. Before the first successful refresh a seat's badge is null (= «unknown», never «0»).
import { Worker } from 'node:worker_threads';
import { defaultMsgStorePath, type UnreadMailBadge } from '../msg/msg-store.js';
import { MAIL_BADGE_WORKER_KIND, type MailBadgeAnswer, type MailBadgeRequest } from './mail-badge-worker.js';

/** At most one refresh start per this window (the ledger read is ~137 ms on a 131 MB ledger, off-thread). */
const MIN_REFRESH_MS = 2_000;
/** A recount even with no ledger write: an expiring message changes a badge without any commit. */
const FORCE_RECOUNT_MS = 60_000;
/** A worker answer slower than this counts as a crash: the worker is dropped and the next refresh starts a new one. */
const WORKER_TIMEOUT_MS = 30_000;

export interface MailBadgeCompute {
  (request: MailBadgeRequest): Promise<MailBadgeAnswer>;
  dispose?(): void;
}

export interface MailBadgeCacheDeps {
  /** The off-thread read (tests inject); default: one persistent worker (src/els/mail-badge-worker.ts). */
  readonly compute?: MailBadgeCompute;
  /** Ledger path, resolved per refresh; default the msg store's own default path. */
  readonly path?: () => string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface MailBadgeCache {
  /** The cached badges for these seats (null = not known yet); schedules a refresh, never reads the ledger. */
  snapshot(seats: readonly string[]): ReadonlyMap<string, UnreadMailBadge | null>;
  /** Resolves once no refresh is scheduled or in flight (tests). */
  settled(): Promise<void>;
  dispose(): void;
}

export function createMailBadgeCache(deps: MailBadgeCacheDeps = {}): MailBadgeCache {
  const compute = deps.compute ?? workerCompute();
  const now = deps.now ?? Date.now;
  const pathOf = deps.path ?? (() => defaultMsgStorePath());
  const log = deps.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  let badges = new Map<string, UnreadMailBadge | null>();
  let wanted: string[] = [];
  let lastStart = Number.NEGATIVE_INFINITY;
  let lastRecount = Number.NEGATIVE_INFINITY;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  let failing = false;
  let disposed = false;

  const run = (): void => {
    scheduled = null;
    if (disposed) return;
    const startedAt = now();
    lastStart = startedAt;
    const force = startedAt - lastRecount >= FORCE_RECOUNT_MS;
    let request: MailBadgeRequest;
    try { request = { path: pathOf(), seats: [...wanted], force }; }
    catch (error) { fail(error); return; }
    inflight = compute(request).then((answer) => {
      if (!answer.ok) { fail(new Error(answer.error)); return; }
      if (answer.changed) badges = new Map(answer.badges);
      if (force) lastRecount = startedAt;
      failing = false;
    }, fail).finally(() => { inflight = null; });
  };
  const fail = (error: unknown): void => {
    if (failing) return;
    failing = true;
    log(`els: mail badge refresh failed, badges keep their last value: ${error instanceof Error ? error.message : String(error)}`);
  };

  return {
    snapshot(seats) {
      const unique = [...new Set(seats)];
      wanted = unique;
      if (!disposed && unique.length > 0 && scheduled === null && inflight === null && now() - lastStart >= MIN_REFRESH_MS) {
        scheduled = setTimeout(run, 0);
        scheduled.unref?.();
      }
      return new Map(unique.map((seat) => [seat, badges.get(seat) ?? null] as const));
    },
    async settled() {
      while (scheduled !== null || inflight !== null) {
        if (inflight) await inflight;
        else await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
    },
    dispose() {
      disposed = true;
      if (scheduled) clearTimeout(scheduled);
      scheduled = null;
      compute.dispose?.();
    },
  };
}

/** The part of a worker the compute uses (node:worker_threads Worker; tests pass a fake). */
export interface MailBadgeWorkerLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: MailBadgeAnswer & { id: number }) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<unknown>;
  unref?(): void;
}

const spawnBadgeWorker = (): MailBadgeWorkerLike =>
  new Worker(new URL('./mail-badge-worker.ts', import.meta.url), { workerData: { kind: MAIL_BADGE_WORKER_KIND } });

/**
 * One persistent worker; a crash, exit or timeout drops it (its pending answers fail) and the next request starts a new
 * one. JUD-B #39546 must ①: every worker is its own generation with its own pending map — a late `exit`/`error` from a
 * dropped worker touches only that generation, never the requests already waiting on its replacement.
 */
export function workerCompute(createWorker: () => MailBadgeWorkerLike = spawnBadgeWorker): MailBadgeCompute {
  type Pending = { resolve: (answer: MailBadgeAnswer) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  type Generation = { worker: MailBadgeWorkerLike; pending: Map<number, Pending>; dead: boolean };
  let current: Generation | null = null;
  let seq = 0;
  const drop = (gen: Generation, error: Error): void => {
    if (current === gen) current = null;
    if (gen.dead) return;
    gen.dead = true;
    for (const [id, entry] of gen.pending) { clearTimeout(entry.timer); gen.pending.delete(id); entry.reject(error); }
    void gen.worker.terminate().catch(() => { /* already gone */ });
  };
  const spawn = (): Generation => {
    const gen: Generation = { worker: createWorker(), pending: new Map(), dead: false };
    gen.worker.unref?.();
    gen.worker.on('message', (message) => {
      const entry = gen.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      gen.pending.delete(message.id);
      const { id: _id, ...answer } = message;
      entry.resolve(answer as MailBadgeAnswer);
    });
    gen.worker.on('error', (error) => drop(gen, error instanceof Error ? error : new Error(String(error))));
    gen.worker.on('exit', (code) => drop(gen, new Error(`mail badge worker exited (${code})`)));
    return gen;
  };
  const compute: MailBadgeCompute = (request) => new Promise<MailBadgeAnswer>((resolve, reject) => {
    let gen: Generation;
    try { gen = current ??= spawn(); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return; }
    const id = ++seq;
    const timer = setTimeout(() => drop(gen, new Error('mail badge worker timed out')), WORKER_TIMEOUT_MS);
    timer.unref?.();
    gen.pending.set(id, { resolve, reject, timer });
    try { gen.worker.postMessage({ id, ...request }); }
    catch (error) { drop(gen, error instanceof Error ? error : new Error(String(error))); }
  });
  compute.dispose = () => {
    const gen = current;
    current = null;
    if (gen) drop(gen, new Error('mail badge cache disposed'));
  };
  return compute;
}
