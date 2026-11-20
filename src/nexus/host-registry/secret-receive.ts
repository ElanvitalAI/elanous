/** Host-ledger "secret receive" field. Pure, no I/O. Only names and fingerprints live here, never a value. */
export type SecretSensitivity = 'low' | 'med' | 'high';
export interface SecretReceiveField {
  allowed: boolean;
  maxSensitivity: SecretSensitivity;
  /** Connection path name, e.g. 'ssh' | 'tailnet'. */
  path: string;
  pubKeyFingerprint?: string;
  lastVerifiedMs?: number;
}
export type SecretReceiveDenial = 'not-allowed' | 'sensitivity' | 'no-path' | 'no-pubkey' | 'stale-host';
export const SECRET_RECEIVE_STALE_MS = 15 * 60_000;

const RANK: Record<SecretSensitivity, number> = { low: 0, med: 1, high: 2 };
const isSensitivity = (v: unknown): v is SecretSensitivity => typeof v === 'string' && Object.hasOwn(RANK, v);

/** Order is fixed: not-allowed -> no-path -> no-pubkey -> stale-host -> sensitivity. Anything unknown is denied. */
export function canReceiveSecret(
  host: { secretReceive?: SecretReceiveField; lastHeartbeatMs?: number } | undefined,
  itemSensitivity: SecretSensitivity,
  now: number,
  opts: { staleMs?: number } = {},
): { ok: true } | { ok: false; reason: SecretReceiveDenial } {
  const f = host?.secretReceive;
  if (!f || f.allowed !== true || !isSensitivity(f.maxSensitivity) || !isSensitivity(itemSensitivity)) return { ok: false, reason: 'not-allowed' };
  if (typeof f.path !== 'string' || !f.path.trim()) return { ok: false, reason: 'no-path' };
  if (typeof f.pubKeyFingerprint !== 'string' || !f.pubKeyFingerprint.trim()) return { ok: false, reason: 'no-pubkey' };
  const hb = host?.lastHeartbeatMs;
  if (typeof hb !== 'number' || !Number.isFinite(hb) || !Number.isFinite(now) || now - hb > (opts.staleMs ?? SECRET_RECEIVE_STALE_MS)) return { ok: false, reason: 'stale-host' };
  if (RANK[itemSensitivity] > RANK[f.maxSensitivity]) return { ok: false, reason: 'sensitivity' };
  return { ok: true };
}

// Same shape rule as validateSupplyPolicy (src/secret/supply.ts SECRET_SHAPE, not exported there; copied, keep in sync).
const SECRET_SHAPE = /(sk-|ghp_|gho_|ems_|emt_|eyJ)|[A-Za-z0-9+/_=-]{40,}/;
const PATH_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/; // the only long string allowed; checked by exact format before any shape rule
const KEYS = ['allowed', 'maxSensitivity', 'path', 'pubKeyFingerprint', 'lastVerifiedMs'];

export function parseSecretReceiveField(raw: unknown): { ok: true; field: SecretReceiveField } | { ok: false; detail: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, detail: 'not-an-object' };
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !KEYS.includes(k))) return { ok: false, detail: 'unknown-key' };
  if (typeof o.allowed !== 'boolean') return { ok: false, detail: 'bad-allowed' };
  if (!isSensitivity(o.maxSensitivity)) return { ok: false, detail: 'bad-max-sensitivity' };
  if (typeof o.path !== 'string' || !PATH_NAME.test(o.path) || SECRET_SHAPE.test(o.path)) return { ok: false, detail: 'bad-path' };
  const field: SecretReceiveField = { allowed: o.allowed, maxSensitivity: o.maxSensitivity, path: o.path };
  if (o.pubKeyFingerprint !== undefined) {
    if (typeof o.pubKeyFingerprint !== 'string' || !FINGERPRINT.test(o.pubKeyFingerprint)) return { ok: false, detail: 'bad-fingerprint' };
    field.pubKeyFingerprint = o.pubKeyFingerprint;
  }
  if (o.lastVerifiedMs !== undefined) {
    if (typeof o.lastVerifiedMs !== 'number' || !Number.isFinite(o.lastVerifiedMs) || o.lastVerifiedMs < 0) return { ok: false, detail: 'bad-last-verified' };
    field.lastVerifiedMs = o.lastVerifiedMs;
  }
  return { ok: true, field };
}
