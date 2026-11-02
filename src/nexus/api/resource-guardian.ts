import { getLatestResourceFailure, getLatestResourceSnapshot } from '../../resource-ledger/guardian-reconcile.js';
import { redactSecretText } from '../../debug/log.js';
import { jsonResponse } from './json-response.js';

const safeText = (text: string) => redactSecretText(text).split(/(\s+)/u).map(part => part.includes('/') ? '[path]' : part).join('');

/** Project the last guardian decision only. This endpoint never triggers collection or cleanup. */
export function handleResourceGuardianApi(): Response {
  const snapshot = getLatestResourceSnapshot();
  if (!snapshot) {
    const failure = getLatestResourceFailure();
    return jsonResponse({ state: failure ? 'failed' : 'pending', stale: true, observedAt: null,
      ...(failure ? { staleReason: safeText(failure.reason), lastFailureAt: failure.failedAt } : { staleReason: 'guardian-has-not-reconciled' }),
      findings: [], cleanup: { reaped: 0, skipped: 0, errors: 0 } });
  }
  return jsonResponse({ state: snapshot.stale ? 'stale' : 'ready', stale: snapshot.stale,
    observedAt: snapshot.observedAt,
    ...(snapshot.staleReason ? { staleReason: safeText(snapshot.staleReason) } : {}),
    ...(snapshot.lastFailureAt ? { lastFailureAt: snapshot.lastFailureAt } : {}),
    findings: snapshot.findings.map(finding => ({ kind: finding.kind, host: finding.host, id: finding.id,
      ...('fp' in finding && finding.fp ? { fp: finding.fp } : {}), detail: safeText(finding.detail), action: finding.action })),
    cleanup: { reaped: snapshot.cleanup.reaped.length, skipped: snapshot.cleanup.skipped.length, errors: snapshot.cleanup.errors.length },
    releaseReservation: { status: snapshot.releaseReservation.status,
      reason: 'reason' in snapshot.releaseReservation ? safeText(snapshot.releaseReservation.reason) : 'free' },
  });
}
