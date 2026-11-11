import { debug } from '../debug/log.js';
import { buildResourceLedgerSnapshot, defaultResourceHosts, defaultResourceRun, type ResourceLedgerCliDeps } from '../cli/resource-ledger-cli.js';
import { readResourceLedger, reapResourceLeaseIfCurrent, type ResourceFinding } from './resource-ledger.js';
import { reconcileLeaseCleanup } from './lease-automation.js';
import { gateHostReservationRoot, inspectReleaseGateHost } from '../release-loop/gate-host-reservation.js';
import { existsSync } from 'node:fs';
import { readHostReadiness } from './host-readiness.js';
import { logsDbPath, LogStore, type LogStoreRow } from '../mss/logging/log-store.js';

type GateTrainFingerprint = { fp: string; entrance: 'self-gate' | 'train'; host?: string; reservedHost?: string };

export function activeGateTrainFingerprints(rows: readonly LogStoreRow[]): GateTrainFingerprint[] {
  const active = new Map<string, GateTrainFingerprint>();
  for (const row of rows.slice().sort((a, b) => a.ts_ms - b.ts_ms || a.id - b.id)) {
    if (!row.data) continue;
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(row.data);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      data = parsed as Record<string, unknown>;
    } catch { continue; }
    if (typeof data.fp !== 'string' || !data.fp.startsWith('fp_')) continue;
    if (row.event === 'end') { active.delete(data.fp); continue; }
    if (row.event !== 'begin' || (data.entrance !== 'self-gate' && data.entrance !== 'train')) continue;
    active.set(data.fp, { fp: data.fp, entrance: data.entrance,
      ...(typeof data.host === 'string' ? { host: data.host } : {}),
      ...(typeof data.reservedHost === 'string' ? { reservedHost: data.reservedHost } : {}) });
  }
  return [...active.values()];
}

export function readActiveGateTrainFingerprints(store: Pick<LogStore, 'query'>): GateTrainFingerprint[] {
  const latestByFp = new Map<string, LogStoreRow>();
  const pageSize = 1000;
  let beforeId: number | undefined;
  for (;;) {
    const page = store.query({ exactCategories: ['run.fp'], limit: pageSize, ...(beforeId !== undefined ? { beforeId } : {}) });
    for (const row of page) {
      if (!row.data) continue;
      try {
        const data: unknown = JSON.parse(row.data);
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        const fp = (data as Record<string, unknown>).fp;
        if (typeof fp === 'string' && fp.startsWith('fp_') && !latestByFp.has(fp)) latestByFp.set(fp, row);
      } catch { /* malformed rows do not hide other run fingerprints */ }
    }
    if (page.length < pageSize) break;
    const nextBeforeId = page[page.length - 1]?.id;
    if (nextBeforeId === undefined || nextBeforeId === beforeId) throw new Error('run.fp log pagination did not advance');
    beforeId = nextBeforeId;
  }
  return activeGateTrainFingerprints([...latestByFp.values()]);
}

function readGateTrainFingerprints(): GateTrainFingerprint[] {
  const path = logsDbPath();
  if (!existsSync(path)) throw new Error('run.fp log store is unavailable');
  const store = LogStore.openReadOnly(path);
  try { return readActiveGateTrainFingerprints(store); }
  finally { store.close(); }
}

export interface ResourceReconcileTickDeps {
  events?: ResourceLedgerCliDeps['events'];
  hosts?: ResourceLedgerCliDeps['hosts'];
  run?: ResourceLedgerCliDeps['run'];
  now?: ResourceLedgerCliDeps['now'];
  reap?: typeof reapResourceLeaseIfCurrent;
  cleanupExpired?: boolean;
  /** Active self-gate/train run.fp begin records from the local read-only log store. */
  fingerprints?: () => readonly GateTrainFingerprint[];
  releaseReservation?: () => ReturnType<typeof inspectReleaseGateHost>;
  log?: (event: string, data: Record<string, unknown>) => void;
  hostReadiness?: typeof readHostReadiness;
}

type GuardianFinding = ResourceFinding | { kind: 'release-reservation'; host: 'node-b'; id: string; detail: string; action: 'report-only' };

export type ResourceReconcileSnapshot = Awaited<ReturnType<typeof resourceReconcileTick>> & {
  stale: boolean; staleReason?: string; lastFailureAt?: string;
};
let latestResourceSnapshot: ResourceReconcileSnapshot | null = null;
let latestResourceFailure: { reason: string; failedAt: string } | null = null;
export function getLatestResourceSnapshot(): ResourceReconcileSnapshot | null { return latestResourceSnapshot; }
export function getLatestResourceFailure(): { reason: string; failedAt: string } | null { return latestResourceFailure; }
/** Test seam for the Nexus projection; production updates this only from the reconcile loop. */
export function setLatestResourceSnapshotForTest(snapshot: ResourceReconcileSnapshot | null): void { latestResourceSnapshot = snapshot; latestResourceFailure = null; }

/** Gather each configured host once, hand discrepancies to the guardian event stream, and reap only an absent expired lease. */
export async function resourceReconcileTick(overrides: ResourceReconcileTickDeps = {}) {
  const now = overrides.now ?? (() => new Date());
  const snapshot = buildResourceLedgerSnapshot({
    events: overrides.events ?? readResourceLedger,
    hosts: overrides.hosts ?? defaultResourceHosts,
    run: overrides.run ?? defaultResourceRun,
    now,
  });
  const leasesByFp = new Map(snapshot.leases.map(lease => [lease.fp, lease]));
  let activeFingerprints: readonly GateTrainFingerprint[] = [];
  let fingerprintReadError: string | undefined;
  try { activeFingerprints = (overrides.fingerprints ?? readGateTrainFingerprints)(); }
  catch (error) { fingerprintReadError = error instanceof Error ? error.message : String(error); }
  const fingerprintFindings: ResourceFinding[] = activeFingerprints.flatMap<ResourceFinding>(run => {
    const lease = leasesByFp.get(run.fp);
    if (!lease) return [{ kind: 'orphan' as const, host: run.reservedHost ?? run.host ?? 'unknown', id: run.fp, fp: run.fp,
      detail: `active ${run.entrance} fingerprint has no active resource lease`, action: 'report-only' as const }];
    const expectedLane = run.entrance === 'train' ? 'train' : 'gate';
    const observedHost = run.reservedHost ?? run.host;
    if (lease.lane !== expectedLane || (observedHost && lease.host !== observedHost)) return [{ kind: 'drift' as const,
      host: observedHost ?? lease.host, id: run.fp, fp: run.fp,
      detail: `${run.entrance} fingerprint expected=${observedHost ?? 'unknown'}/${expectedLane} lease=${lease.host}/${lease.lane}`,
      action: 'report-only' as const }];
    return [];
  });
  const cleanupFindings = snapshot.findings.flatMap(finding => finding.kind === 'reaped-candidate'
    && finding.leaseHeartbeatAt && finding.leaseExpiresAtMs !== undefined && finding.observedAtMs !== undefined
    ? [{ kind: 'stale', id: finding.id, host: finding.host, leaseHeartbeatAt: finding.leaseHeartbeatAt,
        leaseExpiresAtMs: finding.leaseExpiresAtMs, observedAtMs: finding.observedAtMs, resourcePresent: false }]
    : []);
  const cleanup = await reconcileLeaseCleanup({ findings: cleanupFindings, mode: overrides.cleanupExpired ? 'cleanup' : 'dry-run', nowMs: now().getTime(),
    recordReaped: candidate => (overrides.reap ?? reapResourceLeaseIfCurrent)({ id: candidate.id,
      expectedHeartbeatAt: candidate.expectedLeaseHeartbeatAt, expectedExpiresAtMs: candidate.expectedLeaseExpiresAtMs,
      observedAtMs: candidate.observedAtMs }),
  });
  const releaseReservation = overrides.releaseReservation?.()
    ?? inspectReleaseGateHost(gateHostReservationRoot(), 'node-b', { reclaimDead: false });
  const findings: GuardianFinding[] = [...snapshot.findings, ...fingerprintFindings,
    ...(fingerprintReadError ? [{ kind: 'measurement-unavailable' as const, host: 'local', id: 'run.fp', detail: fingerprintReadError, action: 'report-only' as const }] : []),
    { kind: 'release-reservation' as const, host: 'node-b', id: releaseReservation.status,
    detail: releaseReservation.status === 'free' ? 'node-b release reservation is free'
      : `${releaseReservation.status}: ${releaseReservation.reason}${releaseReservation.runId ? ` · run=${releaseReservation.runId}` : ''}`,
    action: 'report-only' as const }];
  const event = { hosts: snapshot.measurements.length,
    findingCounts: findings.reduce<Record<string, number>>((counts, finding) => {
      counts[finding.kind] = (counts[finding.kind] ?? 0) + 1; return counts;
    }, {}),
    reaped: cleanup.reaped.length, skippedReap: cleanup.skipped.length, reapErrors: cleanup.errors.length,
    unmeasuredHosts: snapshot.measurements.filter(measurement => measurement.errors.length).map(measurement => measurement.host),
  };
  try { (overrides.log ?? ((name, data) => debug.log('loop.guardian', name, data)))('resource-reconcile', event); }
  catch { /* reconciliation is observation and must not stop the guardian */ }
  const hostReadiness = (overrides.hostReadiness ?? readHostReadiness)();
  const result = { ...snapshot, findings, cleanup, releaseReservation, hostReadiness };
  latestResourceSnapshot = { ...result, stale: false };
  latestResourceFailure = null;
  return result;
}

export const RESOURCE_RECONCILE_INTERVAL_MS = 5 * 60_000;

/** Start the guardian's 5-minute resource observation loop. Errors are logged and never escape the timer. */
export function startResourceReconcileLoop(options: { tick?: () => Promise<unknown>; intervalMs?: number; onError?: (error: unknown) => void } = {}): () => void {
  const intervalMs = options.intervalMs ?? RESOURCE_RECONCILE_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error('resource reconcile interval must be positive');
  let stopped = false;
  let inFlight = false;
  const run = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try { await (options.tick ?? (() => resourceReconcileTick()))(); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failedAt = new Date().toISOString();
      latestResourceFailure = { reason, failedAt };
      if (latestResourceSnapshot) latestResourceSnapshot = { ...latestResourceSnapshot, stale: true,
        staleReason: reason, lastFailureAt: failedAt };
      try { (options.onError ?? (reason => debug.log('loop.guardian', 'resource-reconcile-failed', { error: String(reason) }, { level: 'warn' })))(error); }
      catch { /* guardian loop remains alive */ }
    } finally { inFlight = false; }
  };
  void run();
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref?.();
  return () => { if (stopped) return; stopped = true; clearInterval(timer); };
}
