import { debug } from '../debug/log.js';
import { parentPort, Worker } from 'node:worker_threads';
import { collectOverview, type CollectOptions } from './overview-collect.js';
import { computeVerdict, unmeasured, okCell, type Cell, type GateReservation, type OverviewSnapshot, type PodMemberRow } from './overview.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { getElanousConfigDirOverride, setElanousConfigDir } from '../elanous-config-dir.js';

const SNAPSHOT_MS = 10_000;
const POD_MS = 60_000;
const POD_STALE_MS = 2 * POD_MS;
/** Bounds for distinct (version, owner, since) keys: memo entries kept and collections in flight. */
const MAX_MEMO = 32;
const MAX_PENDING = 2;

type PodReading = { context: string; occupied: number | null; reason: string | null; observedAt: number; gate?: GateReservation };
type OverviewData = OverviewSnapshot & ReturnType<typeof computeVerdict> & { cacheAgeMs: number; durationMs: number; sources: string[]; refreshFailed: string | null };
type WorkerMessage = ({ kind: 'pods' } | { kind: 'snapshot'; options: CollectOptions }) & { configDir?: string };

/** The kubectl-capable grid reader lives in a worker, never on the HTTP event loop. */
const port = parentPort;
if (port) {
  port.on('message', async (message: WorkerMessage) => {
    try {
      // A worker does not share the main thread's module state: carry the daemon's universe in.
      if (message.configDir) setElanousConfigDir(message.configDir);
      if (message.kind === 'pods') {
        const { buildGridData } = await import('../nexus/api/grid.js');
        const rows = buildGridData().members.map((m) => ({ context: m.context, occupied: m.occupied, reason: m.reason, observedAt: Date.now(), ...(m.gate ? { gate: m.gate } : {}) }));
        port.postMessage({ rows });
      } else port.postMessage({ snapshot: await collectOverview(message.options) });
    } catch (error) {
      port.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function workerRead<T>(message: WorkerMessage, timeoutMs: number, field: 'rows' | 'snapshot'): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./overview-cache.ts', import.meta.url));
    let settled = false;
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const timeout = setTimeout(() => finish(new Error(`${field} 측정 시간 초과`)), timeoutMs);
    worker.on('message', (result: { rows?: PodReading[]; snapshot?: OverviewSnapshot; error?: string }) => {
      if (result.error) finish(new Error(result.error));
      else finish(undefined, result[field] as T);
    });
    worker.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    const configDir = getElanousConfigDirOverride();
    worker.postMessage({ ...message, ...(configDir ? { configDir } : {}) });
  });
}

const measurePodsInWorker = () => workerRead<PodReading[]>({ kind: 'pods' }, 55_000, 'rows');
const collectInWorker = (options: CollectOptions) => workerRead<OverviewSnapshot>({ kind: 'snapshot', options: { ...options, root: options.root ?? effectiveInstanceRoot() } }, 30_000, 'snapshot');

function pendingSnapshot(at: number, since: string, reason: string): OverviewSnapshot {
  const missing = <T>(name: string) => unmeasured<T>(name, reason);
  return {
    // Same resolution the collector uses; never the daemon's cwd.
    generatedAt: new Date(at).toISOString(), instanceRoot: effectiveInstanceRoot(), since,
    release: { version: missing('release.version'), run: missing('release.run'), schedule: missing('release.schedule'), checklist: missing('release.checklist') },
    tasks: { byOwner: missing('tasks.byOwner'), done: missing('tasks.done'), launchable: missing('tasks.launchable'), capacity: missing('tasks.capacity') },
    machines: { hosts: [], pods: [], parents: missing('machines.parents') },
    landings: missing('landings'), loops: [],
  };
}

export function createOverviewCache(deps: {
  collect?: (opts: CollectOptions) => Promise<OverviewSnapshot>;
  measurePods?: () => Promise<PodReading[]>;
  now?: () => number;
  schedule?: (tick: () => void, ms: number) => NodeJS.Timeout;
} = {}) {
  const now = deps.now ?? Date.now;
  const collect = deps.collect ?? collectInWorker;
  const backgroundSnapshot = !deps.collect;
  const measurePods = deps.measurePods ?? measurePodsInWorker;
  const schedule = deps.schedule ?? ((tick: () => void, ms: number): NodeJS.Timeout => setInterval(tick, ms));
  // The memo holds the collected snapshot only; Pod occupancy and the verdict are
  // overlaid at response time so a failed or stale (120 s) measurement shows at once.
  type Entry = { at: number; snapshot: OverviewSnapshot; durationMs: number; failure?: string; retryAt?: number };
  const memo = new Map<string, Entry>();
  const pending = new Map<string, Promise<void>>();
  let podRows: PodReading[] = [];
  let podFailure: string | null = null;
  let podTimer: ReturnType<typeof setInterval> | null = null;
  let podPending = false;

  const refreshPods = async () => {
    if (podPending) return;
    podPending = true;
    try { podRows = await measurePods(); podFailure = null; }
    catch (error) { podRows = []; podFailure = error instanceof Error ? error.message : String(error); }
    finally { podPending = false; }
  };
  const start = () => {
    if (podTimer) return;
    // The timer starts on the first authorized read; measurement never runs on the request stack.
    podTimer = schedule(() => { void refreshPods(); }, POD_MS);
    podTimer.unref();
  };
  /**
   * 게이트 예약 축(RES-FLOOR-BINDING 다섯째 축) — 「게이트 안 돎」은 측정된 값('none'), 못 잼은 사유를 남긴다.
   * 둘 다 구속 조건 후보에서 빠지지만 뜻은 다르다: 하나는 «게이트가 안 돈다», 다른 하나는 «모른다».
   */
  const overlayGate = (row: PodReading | undefined, at: number): Cell<GateReservation | 'none'> => {
    const observedAt = row ? new Date(row.observedAt).toISOString() : null;
    const stale = row !== undefined && at - row.observedAt >= POD_STALE_MS;
    if (podFailure || !row || stale) {
      return unmeasured('pod pool background measure', podFailure ?? (stale ? '낡음(120초)' : '측정 대기'), observedAt);
    }
    if (!row.gate) return unmeasured('pod pool background measure', row.reason ?? '게이트 예약 못 잼', observedAt);
    if (row.gate.jobs === 0) return okCell<GateReservation | 'none'>('none', 'pod pool background measure', observedAt);
    const gate = row.gate;
    if (!Number.isFinite(gate.unbound) || !Number.isFinite(gate.reservedMillicores) || !Number.isFinite(gate.schedulableMillicores)) {
      return unmeasured('pod pool background measure', '게이트 CPU 못 잼', observedAt);
    }
    return okCell<GateReservation | 'none'>(gate, 'pod pool background measure', observedAt);
  };
  /** Response-time Pod occupancy overlay — shared by /v1/ops/overview and /v1/ops/resources. */
  const overlayPods = (snapshot: OverviewSnapshot, at: number): PodMemberRow[] => {
    const byContext = new Map(podRows.map((row) => [row.context, row]));
    return snapshot.machines.pods.map((pod) => {
      const row = byContext.get(pod.context);
      const stale = row && at - row.observedAt >= POD_STALE_MS;
      const occupied = !podFailure && row && !stale && row.occupied !== null
        ? okCell(row.occupied, 'pod pool background measure', new Date(row.observedAt).toISOString())
        : unmeasured<number>('pod pool background measure', podFailure ?? (stale ? '낡음(120초)' : row?.reason ?? '측정 대기'), row ? new Date(row.observedAt).toISOString() : null);
      return { ...pod, occupied, gate: overlayGate(row, at) };
    });
  };
  const present = (entry: Entry): OverviewData => {
    const at = now();
    const pods = overlayPods(entry.snapshot, at);
    const full = { ...entry.snapshot, machines: { ...entry.snapshot.machines, pods } };
    return { ...full, ...computeVerdict(full), durationMs: entry.durationMs,
      sources: [full.release.run.source, full.tasks.launchable.source, full.tasks.capacity.source],
      cacheAgeMs: Math.max(0, at - entry.at), refreshFailed: entry.failure ?? null };
  };
  /** Read-only view of the freshest memo entry (RES-FLOOR-API) — never collects, never measures, never waits. */
  const peek = (): { snapshot: OverviewSnapshot; pods: PodMemberRow[]; at: number } | null => {
    let freshest: Entry | null = null;
    for (const entry of memo.values()) if (!freshest || entry.at > freshest.at) freshest = entry;
    if (!freshest) return null;
    const at = now();
    return { snapshot: freshest.snapshot, pods: overlayPods(freshest.snapshot, at), at };
  };
  const get = async (options: Pick<CollectOptions, 'version' | 'owner'> & { sinceMs?: number; sinceLabel?: string } = {}): Promise<OverviewData> => {
    start();
    const key = JSON.stringify([options.version ?? null, options.owner ?? null, options.sinceMs ?? 3_600_000]);
    const at = now();
    // Drop expired entries of other keys, then cap the memo (oldest first).
    for (const [other, entry] of memo) if (other !== key && !pending.has(other) && at - entry.at >= SNAPSHOT_MS && (entry.retryAt ?? 0) <= at) memo.delete(other);
    const cached = memo.get(key);
    // A failed refresh keeps the original collection time (true age) and only delays the retry.
    if (cached && (at - cached.at < SNAPSHOT_MS || backgroundSnapshot && pending.has(key) || (cached.retryAt ?? 0) > at)) return present(cached);
    let current = pending.get(key);
    if (!current && pending.size >= MAX_PENDING) {
      // Collections in flight are capped; answer from what we have instead of starting another worker.
      const entry = cached ?? { at, snapshot: pendingSnapshot(at, options.sinceLabel ?? '최근 1h', '동시 수집 상한'), durationMs: 0 };
      return present({ ...entry, failure: entry.failure ?? `동시 수집 상한(${MAX_PENDING})` });
    }
    if (!current) {
      // Evict only when a new key is about to be stored, never on a hit for an existing key.
      if (!memo.has(key)) while (memo.size >= MAX_MEMO) { const oldest = [...memo.keys()].find((other) => !pending.has(other)); if (!oldest) break; memo.delete(oldest); }
      if (backgroundSnapshot && !cached) {
        // Placeholder until the worker answers; it is not a collection.
        memo.set(key, { at, snapshot: pendingSnapshot(at, options.sinceLabel ?? '최근 1h', '백그라운드 스냅숏 수집 대기'), durationMs: 0 });
      }
      current = (async () => {
        const startAt = now();
        const snapshot = await collect({ sinceMs: options.sinceMs ?? 3_600_000, sinceLabel: options.sinceLabel ?? '최근 1h',
          ...(options.version ? { version: options.version } : {}), ...(options.owner ? { owner: options.owner } : {}), now: startAt });
        // Age counts from when collection started (= snapshot.generatedAt), not when it finished.
        const entry = { at: startAt, snapshot, durationMs: now() - startAt };
        memo.set(key, entry);
        const verdict = present(entry);
        debug.log('ops.overview', 'verdict', { verdict: verdict.verdict, reasons: verdict.reasons, cacheAgeMs: verdict.cacheAgeMs, durationMs: entry.durationMs });
      })();
      pending.set(key, current);
      void current.then(
        () => { pending.delete(key); },
        (error) => {
          pending.delete(key);
          debug.log('ops.overview', 'refresh-failed', { reason: error instanceof Error ? error.message : String(error) });
          const prior = memo.get(key);
          if (prior) memo.set(key, { ...prior, failure: error instanceof Error ? error.message : String(error), retryAt: now() + SNAPSHOT_MS });
        },
      );
    }
    if (!backgroundSnapshot) {
      try { await current; }
      catch (error) { if (!memo.has(key)) throw error; }
    }
    return present(memo.get(key)!);
  };
  return { get, peek, memoSize: () => memo.size, stop: () => { if (podTimer) clearInterval(podTimer); podTimer = null; memo.clear(); } };
}
