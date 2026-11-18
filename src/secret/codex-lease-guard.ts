/**
 * HQ-VAULT V2 — consumer-side guard for a Codex OAuth «mirror lease».
 *
 * 🔗 내부 문서 `HQ-CREDENTIAL-VAULT` §3.3 (mirror lease) · §3.7 (만료 뒤 «자격 없음»을 시끄럽게).
 *
 * A lease is an access-only Codex entry the owner host (refresh owner) wrote into another universe or host.
 * It carries `lease` metadata and an EMPTY refresh token. The consumer:
 *   - uses the access token before `lease.expiresAt`;
 *   - at/after expiry (or once revoked) throws a typed error and logs `secret.lease.expired|revoked` —
 *     it never refreshes and never falls back to another store (AUTHORITY-EXPIRY-LOUD).
 *
 * ⛔ No token value is ever logged or put into an error message — only leaseId · times · owner host.
 */
import { debug } from '../debug/log.js';

export const SECRET_LOG_CATEGORY = 'secret';

/** Metadata the owner stamps beside the access token. Values-free by construction. */
export interface CodexLeaseMarker {
  readonly leaseId: string;
  readonly kind: 'oauth';
  readonly provider: 'codex';
  readonly owner: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt?: number;
}

export type CodexLeaseObserver = (event: string, data: Record<string, unknown>) => void;
let observer: CodexLeaseObserver | null = null;

/** Test seam — default writes to the shared log store (`eln logs --category secret`). */
export function _setCodexLeaseObserverForTesting(next: CodexLeaseObserver | null): void { observer = next; }

/** Emit a values-free `secret.*` event. Payload keys are fixed by callers; never pass a token. */
export function emitSecretEvent(event: string, data: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info'): void {
  if (observer) { observer(event, data); return; }
  try { debug.log(SECRET_LOG_CATEGORY, event, data, { level }); } catch { /* observation must not block auth */ }
}

export class CodexLeaseExpiredError extends Error {
  readonly code = 'SECRET_LEASE_EXPIRED';
  constructor(readonly leaseId: string, readonly expiresAt: number, readonly owner: string) {
    super(`Codex lease expired — 자격 없음 · 임대 만료 (leaseId=${leaseId}; expiredAt=${new Date(expiresAt).toISOString()}; owner=${owner}). `
      + `주인 호스트에서 \`eln secret lease codex --to <target> --renew\` 로 재임대한다. 갱신·다른 저장소 폴백은 하지 않는다.`);
    this.name = 'CodexLeaseExpiredError';
  }
}

export class CodexLeaseRevokedError extends Error {
  readonly code = 'SECRET_LEASE_REVOKED';
  constructor(readonly leaseId: string, readonly revokedAt: number, readonly owner: string) {
    super(`Codex lease revoked — 자격 없음 · 임대 회수 (leaseId=${leaseId}; revokedAt=${new Date(revokedAt).toISOString()}; owner=${owner}). 갱신·폴백 없음.`);
    this.name = 'CodexLeaseRevokedError';
  }
}

export class CodexLeaseInvalidError extends Error {
  readonly code = 'SECRET_LEASE_INVALID';
  constructor(readonly reason: 'refresh-present' | 'marker-malformed' | 'no-access') {
    super(`Codex lease rejected — 자격 없음 · 임대 형식 위반 (reason=${reason}). 갱신·폴백 없음.`);
    this.name = 'CodexLeaseInvalidError';
  }
}

function isFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }

/** Parse the marker. Returns null when the entry is not a lease at all (ordinary store entry). */
export function readCodexLeaseMarker(entry: unknown): CodexLeaseMarker | null | 'malformed' {
  if (!entry || typeof entry !== 'object') return null;
  const lease = (entry as { lease?: unknown }).lease;
  if (lease === undefined) return null;
  if (!lease || typeof lease !== 'object') return 'malformed';
  const m = lease as Record<string, unknown>;
  if (typeof m.leaseId !== 'string' || !m.leaseId || m.kind !== 'oauth' || m.provider !== 'codex'
    || typeof m.owner !== 'string' || !isFiniteNumber(m.issuedAt) || !isFiniteNumber(m.expiresAt)
    || (m.revokedAt !== undefined && !isFiniteNumber(m.revokedAt))) return 'malformed';
  return {
    leaseId: m.leaseId, kind: 'oauth', provider: 'codex', owner: m.owner,
    issuedAt: m.issuedAt, expiresAt: m.expiresAt, ...(m.revokedAt !== undefined ? { revokedAt: m.revokedAt as number } : {}),
  };
}

/** True when the store entry carries a lease marker (valid or not) — the caller must route it through the guard. */
export function isCodexLeaseEntry(entry: unknown): boolean { return readCodexLeaseMarker(entry) !== null; }

/**
 * Accept a leased entry before expiry; throw loudly otherwise. Never refreshes.
 * Returns the entry unchanged so call sites can `return assertCodexLeaseUsable(state)`.
 */
export function assertCodexLeaseUsable<T>(entry: T, opts: { now?: number; storeKey?: string } = {}): T {
  const now = opts.now ?? Date.now();
  const marker = readCodexLeaseMarker(entry);
  if (marker === null) return entry;
  const storeKey = opts.storeKey ?? 'openai-codex';
  if (marker === 'malformed') {
    emitSecretEvent('secret.lease.refused', { kind: 'oauth', provider: 'codex', side: 'consumer', reason: 'marker-malformed', storeKey }, 'error');
    throw new CodexLeaseInvalidError('marker-malformed');
  }
  const tokens = (entry as { tokens?: Record<string, unknown> }).tokens ?? {};
  if (marker.revokedAt !== undefined) {
    emitSecretEvent('secret.lease.revoked', { kind: 'oauth', provider: 'codex', side: 'consumer', leaseId: marker.leaseId, owner: marker.owner,
      revokedAt: new Date(marker.revokedAt).toISOString(), storeKey }, 'error');
    throw new CodexLeaseRevokedError(marker.leaseId, marker.revokedAt, marker.owner);
  }
  // A lease must never hold refresh authority — if one does, the file was tampered with or mis-written.
  const refreshA = tokens.refreshToken, refreshB = tokens.refresh_token;
  if ((typeof refreshA === 'string' && refreshA !== '') || (typeof refreshB === 'string' && refreshB !== '')) {
    emitSecretEvent('secret.lease.refused', { kind: 'oauth', provider: 'codex', side: 'consumer', leaseId: marker.leaseId, reason: 'refresh-present', storeKey }, 'error');
    throw new CodexLeaseInvalidError('refresh-present');
  }
  if (now >= marker.expiresAt) {
    emitSecretEvent('secret.lease.expired', { kind: 'oauth', provider: 'codex', side: 'consumer', leaseId: marker.leaseId, owner: marker.owner,
      expiresAt: new Date(marker.expiresAt).toISOString(), overdueSeconds: Math.round((now - marker.expiresAt) / 1000), storeKey }, 'error');
    throw new CodexLeaseExpiredError(marker.leaseId, marker.expiresAt, marker.owner);
  }
  if (typeof tokens.accessToken !== 'string' || !tokens.accessToken) {
    emitSecretEvent('secret.lease.refused', { kind: 'oauth', provider: 'codex', side: 'consumer', leaseId: marker.leaseId, reason: 'no-access', storeKey }, 'error');
    throw new CodexLeaseInvalidError('no-access');
  }
  return entry;
}
