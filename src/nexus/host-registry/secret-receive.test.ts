import { describe, expect, test } from 'bun:test';
import { canReceiveSecret, parseSecretReceiveField, SECRET_RECEIVE_STALE_MS, type SecretReceiveField } from './secret-receive.js';

const NOW = 1_800_000_000_000;
const FP = `SHA256:${'A'.repeat(43)}`;
const field: SecretReceiveField = { allowed: true, maxSensitivity: 'high', path: 'ssh', pubKeyFingerprint: FP, lastVerifiedMs: NOW - 1000 };
const host = (f: Partial<SecretReceiveField> | undefined = {}, hb: number | undefined = NOW - 1000) => ({ secretReceive: f === undefined ? undefined : { ...field, ...f }, lastHeartbeatMs: hb });

describe('canReceiveSecret', () => {
  test('ok when allowed, path, pubkey, fresh heartbeat and sensitivity within max', () => {
    expect(canReceiveSecret(host(), 'high', NOW)).toEqual({ ok: true });
    expect(canReceiveSecret(host({ maxSensitivity: 'med' }), 'low', NOW)).toEqual({ ok: true });
  });
  test('each of the five reasons', () => {
    expect(canReceiveSecret(host({ allowed: false }), 'low', NOW)).toEqual({ ok: false, reason: 'not-allowed' });
    expect(canReceiveSecret(host({ path: '' }), 'low', NOW)).toEqual({ ok: false, reason: 'no-path' });
    expect(canReceiveSecret(host({ pubKeyFingerprint: undefined }), 'low', NOW)).toEqual({ ok: false, reason: 'no-pubkey' });
    expect(canReceiveSecret(host({}, NOW - SECRET_RECEIVE_STALE_MS - 1), 'low', NOW)).toEqual({ ok: false, reason: 'stale-host' });
    expect(canReceiveSecret(host({ maxSensitivity: 'low' }), 'med', NOW)).toEqual({ ok: false, reason: 'sensitivity' });
  });
  test('stale boundary: exactly staleMs is fresh; custom staleMs; missing heartbeat is stale', () => {
    expect(canReceiveSecret(host({}, NOW - SECRET_RECEIVE_STALE_MS), 'low', NOW)).toEqual({ ok: true });
    expect(canReceiveSecret(host({}, NOW - 5001), 'low', NOW, { staleMs: 5000 })).toEqual({ ok: false, reason: 'stale-host' });
    expect(canReceiveSecret({ secretReceive: field }, 'low', NOW)).toEqual({ ok: false, reason: 'stale-host' });
  });
  test('fixed order: not-allowed > no-path > no-pubkey > stale-host > sensitivity', () => {
    const all = { allowed: false, path: '', pubKeyFingerprint: undefined, maxSensitivity: 'low' } as const;
    const stale = NOW - SECRET_RECEIVE_STALE_MS - 1;
    expect(canReceiveSecret(host(all, stale), 'high', NOW)).toMatchObject({ reason: 'not-allowed' });
    expect(canReceiveSecret(host({ ...all, allowed: true }, stale), 'high', NOW)).toMatchObject({ reason: 'no-path' });
    expect(canReceiveSecret(host({ ...all, allowed: true, path: 'ssh' }, stale), 'high', NOW)).toMatchObject({ reason: 'no-pubkey' });
    expect(canReceiveSecret(host({ ...all, allowed: true, path: 'ssh', pubKeyFingerprint: FP }, stale), 'high', NOW)).toMatchObject({ reason: 'stale-host' });
    expect(canReceiveSecret(host({ ...all, allowed: true, path: 'ssh', pubKeyFingerprint: FP }), 'high', NOW)).toMatchObject({ reason: 'sensitivity' });
  });
  test('fail-closed: host or field missing, allowed not true, unknown sensitivity values', () => {
    expect(canReceiveSecret(undefined, 'low', NOW)).toEqual({ ok: false, reason: 'not-allowed' });
    expect(canReceiveSecret({ lastHeartbeatMs: NOW }, 'low', NOW)).toEqual({ ok: false, reason: 'not-allowed' });
    expect(canReceiveSecret(host({ allowed: 'yes' as never }), 'low', NOW)).toEqual({ ok: false, reason: 'not-allowed' });
    expect(canReceiveSecret(host(), 'top' as never, NOW)).toEqual({ ok: false, reason: 'not-allowed' });
    expect(canReceiveSecret(host({ maxSensitivity: 'top' as never }), 'low', NOW)).toEqual({ ok: false, reason: 'not-allowed' });
  });
  test('does not mutate its inputs', () => {
    const h = host(); const snap = JSON.stringify(h);
    canReceiveSecret(h, 'med', NOW);
    expect(JSON.stringify(h)).toBe(snap);
  });
});

describe('parseSecretReceiveField', () => {
  test('accepts the allow-listed shape and returns a copy', () => {
    const r = parseSecretReceiveField(field);
    expect(r).toEqual({ ok: true, field });
    if (r.ok) expect(r.field).not.toBe(field);
  });
  test('accepts the minimal shape (no fingerprint, no lastVerifiedMs)', () => {
    expect(parseSecretReceiveField({ allowed: false, maxSensitivity: 'low', path: 'tailnet' }).ok).toBe(true);
  });
  test('rejects unknown keys, bad types and bad maxSensitivity', () => {
    for (const raw of [{ ...field, extra: 1 }, { ...field, secret: 'x' }, { ...field, maxSensitivity: 'top' }, { ...field, allowed: 'true' }, { ...field, lastVerifiedMs: -1 }, null, 'x', [], { allowed: true }]) {
      expect(parseSecretReceiveField(raw).ok).toBe(false);
    }
  });
  test('rejects secret-looking values (fake canaries) in any string field', () => {
    for (const bad of ['sk-FAKE0000', 'ghp_FAKE0000', 'ems_FAKE0000', 'emt_FAKE0000', 'eyJFAKE0000', 'A'.repeat(40), `${'ab+/'.repeat(12)}==`]) {
      expect(parseSecretReceiveField({ ...field, path: bad }).ok).toBe(false);
      expect(parseSecretReceiveField({ ...field, pubKeyFingerprint: bad }).ok).toBe(false);
    }
  });
  test('fingerprint must be exactly SHA256:<43 base64>', () => {
    for (const bad of ['SHA256:short', `SHA256:${'A'.repeat(44)}`, `MD5:${'A'.repeat(43)}`, `sha256:${'A'.repeat(43)}`, `SHA256:${'A'.repeat(42)}!`]) {
      expect(parseSecretReceiveField({ ...field, pubKeyFingerprint: bad }).ok).toBe(false);
    }
  });
  test('does not mutate its input', () => {
    const raw = { ...field }; const snap = JSON.stringify(raw);
    parseSecretReceiveField(raw);
    expect(JSON.stringify(raw)).toBe(snap);
  });
});
