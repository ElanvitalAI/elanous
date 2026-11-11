import { buildResourceLedgerSnapshot, defaultResourceHosts, defaultResourceRun } from '../../cli/resource-ledger-cli.js';
import { activeResourcePools, declareResourcePool, latestWarmPoolPodReceipts, readResourceLedger, readResourceLedgerWithObservations, recordHostReadinessHeartbeat, replaceResourcePool, resourcePoolsForMachine, type HostReadinessHeartbeat } from '../../resource-ledger/resource-ledger.js';
import { redactSecretText } from '../../debug/log.js';
import { jsonResponse } from './json-response.js';

export type ResourceLedgerSnapshot = ReturnType<typeof buildResourceLedgerSnapshot>;
let snapshotOverride: (() => ResourceLedgerSnapshot) | null = null;

/** Test seam; production always reads the shared resource ledger and host measurements. */
export function setResourceLedgerSnapshotForTest(snapshot: (() => ResourceLedgerSnapshot) | null): void {
  snapshotOverride = snapshot;
}

export function handleResourceLedgerApi(): Response {
  try {
    const snapshot = (snapshotOverride ?? (() => buildResourceLedgerSnapshot({
      events: readResourceLedger,
      hosts: defaultResourceHosts,
      run: defaultResourceRun,
      now: () => new Date(),
    })))();
    // Machine-local paths are not part of the operator-facing API contract.
    const { ledgerPath: _ledgerPath, ...publicSnapshot } = snapshot;
    const safeText = (text: string) => redactSecretText(text).split(/(\s+)/u).map(part => part.includes('/') || part.includes('\\') ? '[path]' : part).join('');
    const ledgerEvents = readResourceLedger();
    const pools = activeResourcePools(ledgerEvents);
    const podReceipts = latestWarmPoolPodReceipts(ledgerEvents);
    return jsonResponse({ ...publicSnapshot, pools, podReceipts,
      findings: publicSnapshot.findings.map(finding => ({ ...finding, detail: safeText(finding.detail) })),
      recentReclaims: publicSnapshot.recentReclaims.map(reclaim => ({ ...reclaim, reason: safeText(reclaim.reason),
        ...(reclaim.stoppedBy === undefined ? {} : { stoppedBy: safeText(reclaim.stoppedBy) }) })),
      measurements: publicSnapshot.measurements.map(measurement => ({ ...measurement, errors: measurement.errors.map(safeText),
        processes: measurement.processes.map(({ id, fp, lane, mission }) => ({ id, ...(fp ? { fp } : {}),
          ...(lane ? { lane } : {}), ...(mission ? { mission } : {}) })) })),
    });
  } catch {
    return jsonResponse({ error: 'resource-ledger-unavailable' }, 503);
  }
}

/** Minimal machine-authenticated view used by warm-pool providers; it exposes only declarations for pools that include this machine. */
export function handleResourceLedgerPoolsApi(machine: string): Response {
  try {
    const { events, unknownEvents } = readResourceLedgerWithObservations();
    const pools = resourcePoolsForMachine(events, machine);
    const observations = unknownEvents.map(({ eventType, count }) => ({
      kind: 'unknown-ledger-event-skipped' as const, eventType, count,
    }));
    const response = jsonResponse({ pools, ...(observations.length ? { observations } : {}) });
    response.headers.set('cache-control', 'no-store'); return response;
  } catch { return jsonResponse({ error: 'resource-ledger-unavailable' }, 503); }
}

/** Owner-authenticated Nexus write path; declarations remain in the Nexus ledger, local files are caches. */
export async function handleResourceLedgerPoolDeclarationPost(req: Request): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  try {
    const fields = body && typeof body === 'object' && !Array.isArray(body)
      ? body as { pool?: unknown; expectedPool?: unknown } : {};
    const raw = fields.pool;
    if (!raw) return jsonResponse({ error: 'pool-required' }, 400);
    const created = fields.expectedPool === undefined
      ? declareResourcePool(raw as Parameters<typeof declareResourcePool>[0])
      : replaceResourcePool(raw as Parameters<typeof replaceResourcePool>[0],
        fields.expectedPool as Parameters<typeof replaceResourcePool>[1]);
    const response = jsonResponse({ ok: true, created }, created ? 201 : 200); response.headers.set('cache-control', 'no-store'); return response;
  } catch (error) { return jsonResponse({ error: error instanceof Error ? error.message : 'invalid-pool' }, 400); }
}

/** Machine-token-authenticated producer path; the host identity always comes from the token, not the body. */
export async function handleResourceLedgerHostReadinessPost(req: Request, machine: string,
  record: typeof recordHostReadinessHeartbeat = recordHostReadinessHeartbeat): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  const raw = body && typeof body === 'object' && !Array.isArray(body)
    ? ((body as { heartbeat?: unknown }).heartbeat ?? body) : undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return jsonResponse({ error: 'heartbeat-required' }, 400);
  const row = raw as Partial<HostReadinessHeartbeat>;
  if (row.host !== undefined && row.host !== machine) return jsonResponse({ error: 'host-token-mismatch' }, 403);
  try {
    const heartbeat = { ...row, host: machine } as HostReadinessHeartbeat;
    record(heartbeat);
    const response = jsonResponse({ ok: true, host: machine, at: heartbeat.at }, 201);
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch {
    return jsonResponse({ error: 'invalid-heartbeat' }, 400);
  }
}
