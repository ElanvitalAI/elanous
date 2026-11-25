// OP-HANDLES-L5 (TRACE-OP-RESOURCE-OPTIMIZATION-1125 §6-3 · §7 L5): the pre-approved resource pool.
// A read-only run in the test universe on a pool host needs no RES approval — seats stop asking «RES 승인 슬롯?» and
// stop holding work behind it (11-25 13:30 MK «RES 확인 전 실행 금지» NEED HUMAN). The default lives in code; RES owns
// the override in its ledger `<seat-state>/RES/PREGATE-HOSTS.json` ({ "hosts": [{ "host": "minim5", "preApproved": true }] }).
// A ledger that is present and readable replaces the default (only its preApproved=true rows count); an absent or broken
// ledger keeps the default. Anything outside the pool (prod universe · a write · another host · paid VM) asks as before.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Code default (대표 11-25 L5): local test hosts. mshq is HQ (seats · review) and stays out of the pool. */
export const PREAPPROVED_TEST_HOSTS: readonly string[] = ['minim5', 'node-b', 'node-c'];
export const PREAPPROVED_SCOPE = 'read-only test-universe runs';
export const PREGATE_HOSTS_LEDGER = join('RES', 'PREGATE-HOSTS.json');

export interface PreapprovedPool {
  readonly hosts: readonly string[];
  readonly scope: string;
  /** `code-default` or the ledger path the hosts came from. */
  readonly source: string;
}

const HOST = /^[a-z][a-z0-9-]{0,62}$/;

export function preapprovedPool(seatStateRoot: string, read: (path: string) => string = path => readFileSync(path, 'utf8')): PreapprovedPool {
  const path = join(seatStateRoot, PREGATE_HOSTS_LEDGER);
  try {
    const raw = JSON.parse(read(path)) as { hosts?: unknown };
    if (!Array.isArray(raw.hosts)) throw new Error('hosts is not a list');
    const hosts = raw.hosts.flatMap((row): string[] => {
      if (!row || typeof row !== 'object') return [];
      const { host, preApproved } = row as { host?: unknown; preApproved?: unknown };
      return typeof host === 'string' && HOST.test(host.trim().toLowerCase()) && preApproved === true ? [host.trim().toLowerCase()] : [];
    });
    return { hosts: [...new Set(hosts)], scope: PREAPPROVED_SCOPE, source: path };
  } catch {
    return { hosts: [...PREAPPROVED_TEST_HOSTS], scope: PREAPPROVED_SCOPE, source: 'code-default' };
  }
}

export interface RunRequest {
  readonly host: string;
  readonly universe: 'test' | 'sim' | 'prod';
  readonly readOnly: boolean;
}

export type RunApproval = { readonly needsResApproval: false; readonly reason: string } | { readonly needsResApproval: true; readonly reason: string };

/** Pure: does this run need a RES approval slot? */
export function runNeedsResApproval(run: RunRequest, pool: PreapprovedPool): RunApproval {
  const host = run.host.trim().toLowerCase();
  if (!pool.hosts.includes(host)) return { needsResApproval: true, reason: `host ${host} is not in the pre-approved pool (${pool.hosts.join(' · ') || 'empty'})` };
  if (run.universe === 'prod') return { needsResApproval: true, reason: 'the production universe is never pre-approved' };
  if (!run.readOnly) return { needsResApproval: true, reason: 'a run that writes shared state is never pre-approved' };
  return { needsResApproval: false, reason: `pre-approved: ${PREAPPROVED_SCOPE} on ${host}` };
}

/** The one line SeatAssign mails carry so the receiving seat does not ask RES first. */
export function preapprovalLine(pool: PreapprovedPool): string {
  return pool.hosts.length
    ? `resources: pre-approved pool ${pool.hosts.join(' · ')} — ${PREAPPROVED_SCOPE} need no RES approval; just run (prod universe · writes · other hosts still ask RES)`
    : 'resources: the pre-approved pool is empty (RES ledger) — ask RES before running';
}
