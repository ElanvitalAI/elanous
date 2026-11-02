type LeaseHeartbeatCancel = () => void;
type LeaseHeartbeatScheduler = (tick: () => void | Promise<void>, intervalMs: number) => LeaseHeartbeatCancel;

interface LeaseHeartbeatOptions {
  leaseId: string;
  ttlMs: number;
  intervalMs?: number;
  heartbeat: (leaseId: string) => void | Promise<void>;
  onError?: (leaseId: string, error: unknown) => void | Promise<void>;
  schedule?: LeaseHeartbeatScheduler;
}

const scheduleInterval: LeaseHeartbeatScheduler = (tick, intervalMs) => {
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
};

/** Keep a lease fresh while its owner runs. A failed beat is observable but never throws into the owner. */
export function startLeaseHeartbeat(options: LeaseHeartbeatOptions): LeaseHeartbeatCancel {
  const intervalMs = options.intervalMs ?? 30_000;
  if (!options.leaseId.trim()) throw new Error('lease heartbeat requires leaseId');
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) throw new Error('lease heartbeat requires positive ttlMs');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 30_000 || intervalMs > 60_000 || intervalMs >= options.ttlMs) {
    throw new Error('lease heartbeat interval must be 30–60 seconds and shorter than ttlMs');
  }

  let stopped = false;
  let inFlight = false;
  const cancelTimer = (options.schedule ?? scheduleInterval)(async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try { await options.heartbeat(options.leaseId); }
    catch (error) {
      void Promise.resolve().then(() => options.onError?.(options.leaseId, error)).catch(() => { /* observation must not affect the lease owner */ });
    } finally { inFlight = false; }
  }, intervalMs);
  return () => {
    if (stopped) return;
    stopped = true;
    cancelTimer();
  };
}

interface ReconcileCleanupFinding {
  kind: string;
  id: string;
  host: string;
  /** Lease heartbeat timestamp used as the compare-and-set version by the recorder. */
  leaseHeartbeatAt?: string;
  leaseExpiresAtMs?: number;
  observedAtMs?: number;
  resourcePresent?: boolean;
}

interface ReconcileCleanupResult {
  mode: 'dry-run' | 'cleanup';
  candidates: Array<{ id: string; host: string; expectedLeaseHeartbeatAt: string; expectedLeaseExpiresAtMs: number; observedAtMs: number }>;
  reaped: Array<{ id: string; host: string }>;
  skipped: Array<{ id: string; host: string }>;
  errors: Array<{ id: string; host: string; detail: string }>;
  mutations: string[];
}

interface ReconcileCleanupOptions {
  findings: readonly ReconcileCleanupFinding[];
  mode?: 'dry-run' | 'cleanup';
  nowMs?: number;
  /** Atomically compare heartbeat version and expiry, then append an auditable event; false means heartbeat won the race. */
  recordReaped?: (candidate: { id: string; host: string; expectedLeaseHeartbeatAt: string; expectedLeaseExpiresAtMs: number; observedAtMs: number }) => boolean | Promise<boolean>;
}

/** Dry-run is the default. Cleanup only records reaped lease candidates; it never touches Pods, processes, or files. */
export async function reconcileLeaseCleanup(options: ReconcileCleanupOptions): Promise<ReconcileCleanupResult> {
  const mode = options.mode ?? 'dry-run';
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('reconcile requires a non-negative safe integer nowMs');
  const candidates = [...new Map(options.findings
    .filter(finding => finding.kind === 'stale'
      && typeof finding.leaseHeartbeatAt === 'string'
      && Number.isFinite(Date.parse(finding.leaseHeartbeatAt))
      && Number.isSafeInteger(finding.leaseExpiresAtMs)
      && Number.isSafeInteger(finding.observedAtMs)
      && finding.leaseExpiresAtMs! <= nowMs
      && finding.observedAtMs! >= finding.leaseExpiresAtMs!
      && finding.observedAtMs! <= nowMs
      && finding.resourcePresent === false)
    .map(finding => [`${finding.host}\0${finding.id}`, {
      id: finding.id,
      host: finding.host,
      expectedLeaseHeartbeatAt: finding.leaseHeartbeatAt!,
      expectedLeaseExpiresAtMs: finding.leaseExpiresAtMs!,
      observedAtMs: finding.observedAtMs!,
    }])).values()];
  const result: ReconcileCleanupResult = { mode, candidates, reaped: [], skipped: [], errors: [], mutations: [] };
  if (mode === 'dry-run') return result;
  if (!options.recordReaped) throw new Error('cleanup mode requires recordReaped callback');

  for (const candidate of candidates) {
    try {
      if (await options.recordReaped(candidate)) {
        result.reaped.push({ id: candidate.id, host: candidate.host });
        result.mutations.push(`lease-reaped:${candidate.host}:${candidate.id}`);
      } else {
        result.skipped.push({ id: candidate.id, host: candidate.host });
      }
    } catch (error) {
      result.errors.push({ id: candidate.id, host: candidate.host, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
