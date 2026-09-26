import { ResourceLedger, ResourceLedgerError, type ResourceRecord } from './ledger.js';

/** Inclusive port bands; only the test band is allocated by the coordinator. */
export const PORT_BANDS = {
  reserved: [31413, 31415, 31420],
  test: { start: 31450, end: 31499 },
  offline: { start: 31500, end: 31509 },
} as const;

/** 한 번의 임대가 가질 수 있는 최장 수명(24시간). 이보다 긴 요청은 이 값으로 잘린다 — 죽은 주인이 대역을 영영 붙잡지 못하게. */
export const MAX_PORT_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

export interface PortLeaseRequest {
  machine: string;
  purpose: string;
  ttlMs: number;
  /** Authenticated token fingerprint; direct callers default to their machine identity. */
  owner?: string;
  /** Ports rejected by a local bind probe during this allocation attempt. */
  excluded?: readonly number[];
}

export function portLeaseId(port: number): string {
  return `port-lease:${port}`;
}

/** Allocate the lowest unleased test port, replacing an expired lease if needed. */
export function leasePort(request: PortLeaseRequest, ledger: ResourceLedger, now = Date.now()): ResourceRecord {
  const { machine, purpose, ttlMs } = request;
  if (!machine?.trim() || !purpose?.trim() || !Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(now) ||
      (request.owner !== undefined && !request.owner.trim())) {
    throw new ResourceLedgerError(400, 'invalid-port-lease');
  }
  if (request.excluded?.some(port => !Number.isInteger(port) || port < PORT_BANDS.test.start || port > PORT_BANDS.test.end)) {
    throw new ResourceLedgerError(400, 'invalid-port-lease');
  }
  const owner = request.owner ?? machine;
  return ledger.leaseTestPort({ machine, purpose, ttlMs: Math.min(ttlMs, MAX_PORT_LEASE_TTL_MS), owner }, PORT_BANDS.test, now, request.excluded);
}
