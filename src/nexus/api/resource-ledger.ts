import { buildResourceLedgerSnapshot, defaultResourceHosts, defaultResourceRun } from '../../cli/resource-ledger-cli.js';
import { readResourceLedger } from '../../resource-ledger/resource-ledger.js';
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
    const safeText = (text: string) => redactSecretText(text).split(/(\s+)/u).map(part => part.includes('/') ? '[path]' : part).join('');
    return jsonResponse({ ...publicSnapshot,
      findings: publicSnapshot.findings.map(finding => ({ ...finding, detail: safeText(finding.detail) })),
      measurements: publicSnapshot.measurements.map(measurement => ({ ...measurement, errors: measurement.errors.map(safeText),
        processes: measurement.processes.map(({ id, fp, lane, mission }) => ({ id, ...(fp ? { fp } : {}),
          ...(lane ? { lane } : {}), ...(mission ? { mission } : {}) })) })),
    });
  } catch {
    return jsonResponse({ error: 'resource-ledger-unavailable' }, 503);
  }
}
