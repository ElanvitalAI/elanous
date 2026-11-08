import { setDefaultTimeout, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import * as setupLinkTokens from './setup-link-tokens.js';
import { claimCredentialRegistrationLinkToken, claimSetupLinkToken, consumeCredentialRegistrationBearer, issueCredentialRegistrationLinkToken, issueSetupLinkToken, matchSetupBearer, revokeCredentialRegistrationLinkToken, SETUP_LINK_TTL_MS } from './setup-link-tokens.js';
import { issueTempToken, matchTempToken } from './temp-tokens.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

let dir: string;
const now = Date.parse('2026-01-01T00:00:00Z');
const store = () => readFileSync(join(dir, 'setup-link-tokens.json'), 'utf8');

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'els-')); setElanousConfigDir(dir); });
afterEach(() => { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); });

describe('setup-link token storage and claim', () => {
  test('bearer TTL is not part of the public module API', () => {
    expect(Object.keys(setupLinkTokens)).not.toContain('SETUP_BEARER_TTL_MS');
  });

  test('els_ token expires in exactly ten minutes; store has only hashes and private file permissions', () => {
    const issued = issueSetupLinkToken({ now });
    expect(issued.token).toMatch(/^els_[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt).toBe(new Date(now + SETUP_LINK_TTL_MS).toISOString());
    expect(SETUP_LINK_TTL_MS).toBe(600_000);
    expect(statSync(join(dir, 'setup-link-tokens.json')).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(store());
    expect(parsed.tokens).toEqual([{ hash: createHash('sha256').update(issued.token).digest('hex'), expiresAt: issued.expiresAt }]);
    expect(store()).not.toContain(issued.token);
  });

  test('unknown, used, and exactly expired links have distinct outcomes without creating a bearer', () => {
    const issued = issueSetupLinkToken({ now });
    expect(claimSetupLinkToken('els_bad', { now })).toEqual({ ok: false, reason: 'unknown' });
    expect(claimSetupLinkToken('els_' + 'A'.repeat(43), { now })).toEqual({ ok: false, reason: 'unknown' });
    expect(claimSetupLinkToken(issued.token, { now: now + SETUP_LINK_TTL_MS })).toEqual({ ok: false, reason: 'expired' });
    expect(store()).not.toContain('bearerHash');
    const live = issueSetupLinkToken({ now });
    const claimed = claimSetupLinkToken(live.token, { now: now + SETUP_LINK_TTL_MS - 1 });
    expect(claimed.ok).toBe(true);
    expect(claimSetupLinkToken(live.token, { now: now + SETUP_LINK_TTL_MS + 1 })).toEqual({ ok: false, reason: 'used' });
    expect(claimSetupLinkToken(issued.token, { now: now + SETUP_LINK_TTL_MS + 1 })).toEqual({ ok: false, reason: 'expired' });
  });

  test('one claim mints a separate scoped bearer, stores only its hash, validates until expiry', () => {
    const issued = issueSetupLinkToken({ now });
    const claimed = claimSetupLinkToken(issued.token, { now: now + 1 });
    if (!claimed.ok) throw new Error('expected successful claim');
    expect(claimed.bearer).toMatch(/^elsb_[A-Za-z0-9_-]{43}$/);
    expect(claimed.bearer).not.toBe(issued.token);
    const raw = store();
    expect(raw).not.toContain(issued.token);
    expect(raw).not.toContain(claimed.bearer);
    expect(raw).toContain(createHash('sha256').update(claimed.bearer).digest('hex'));
    expect(matchSetupBearer(claimed.bearer, { now: now + 1 })).toEqual({ expiresAt: claimed.expiresAt });
    expect(matchSetupBearer(claimed.bearer, { now: now + SETUP_LINK_TTL_MS + 1 })).toEqual({ expiresAt: claimed.expiresAt });
    expect(matchSetupBearer(claimed.bearer, { now: Date.parse(claimed.expiresAt) })).toBeNull();
    expect(matchSetupBearer(issued.token, { now: now + 1 })).toBeNull();
    expect(matchSetupBearer('elsb_' + 'A'.repeat(43), { now: now + 1 })).toBeNull();
  });

  test('credential registration links bind a short-lived bearer to one slot and consume it once', () => {
    const issued = issueCredentialRegistrationLinkToken('cred:openai.api_key', { now });
    expect(issued.expiresAt).toBe(new Date(now + SETUP_LINK_TTL_MS).toISOString());
    expect(() => issueCredentialRegistrationLinkToken('cred:unknown.api_key', { now })).toThrow('ELANOUS_CREDENTIAL_SLOT_UNSUPPORTED');
    expect(claimSetupLinkToken(issued.token, { now: now + 1 })).toEqual({ ok: false, reason: 'unknown' });
    expect(claimCredentialRegistrationLinkToken(issued.token, { now: Date.parse(issued.expiresAt) })).toEqual({ ok: false, reason: 'expired' });

    const link = issueCredentialRegistrationLinkToken('cred:openai.api_key', { now });
    const claimed = claimCredentialRegistrationLinkToken(link.token, { now: now + 1 });
    if (!claimed.ok) throw new Error('expected successful credential link claim');
    expect(claimed.slot).toBe('cred:openai.api_key');
    expect(Date.parse(claimed.expiresAt)).toBe(now + 1 + 5 * 60_000);
    expect(claimed.bearer).toMatch(/^elcr_[A-Za-z0-9_-]{43}$/);
    expect(consumeCredentialRegistrationBearer(claimed.bearer, 'cred:elevenlabs.api_key', { now: now + 2 }))
      .toEqual({ ok: false, reason: 'wrong-slot' });
    expect(consumeCredentialRegistrationBearer(claimed.bearer, claimed.slot, { now: now + 2 }))
      .toEqual({ ok: true, slot: 'cred:openai.api_key' });
    expect(consumeCredentialRegistrationBearer(claimed.bearer, claimed.slot, { now: now + 3 }))
      .toEqual({ ok: false, reason: 'used' });
    expect(consumeCredentialRegistrationBearer(claimed.bearer, claimed.slot, { now: Date.parse(claimed.expiresAt) }))
      .toEqual({ ok: false, reason: 'expired' });

    const expiring = issueCredentialRegistrationLinkToken('cred:openai.api_key', { now });
    const expiringClaim = claimCredentialRegistrationLinkToken(expiring.token, { now: now + 1 });
    if (!expiringClaim.ok) throw new Error('expected successful credential link claim');
    expect(consumeCredentialRegistrationBearer(expiringClaim.bearer, expiringClaim.slot, { now: Date.parse(expiringClaim.expiresAt) }))
      .toEqual({ ok: false, reason: 'expired' });
    expect(store()).not.toContain(link.token);
    expect(store()).not.toContain(claimed.bearer);
  });

  test('credential claim checks expiry after waiting for the token-store lock', async () => {
    const link = issueCredentialRegistrationLinkToken('cred:openai.api_key', { now });
    const parsed = JSON.parse(store()) as { tokens: Array<{ hash: string; expiresAt: string }> };
    const linkHash = createHash('sha256').update(link.token).digest('hex');
    const entry = parsed.tokens.find((candidate) => candidate.hash === linkHash)!;
    entry.expiresAt = new Date(Date.now() + 80).toISOString();
    writeFileSync(join(dir, 'setup-link-tokens.json'), JSON.stringify(parsed), { mode: 0o600 });

    const fixture = join(import.meta.dir, 'setup-link-tokens.fixture.ts');
    const child = Bun.spawn([process.execPath, fixture, 'hold-for', dir, '', '', '180'], { stdout: 'pipe', stderr: 'pipe' });
    const reader = child.stdout.getReader();
    await reader.read();
    const result = claimCredentialRegistrationLinkToken(link.token, { dir });
    expect(result).toEqual({ ok: false, reason: 'expired' });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exit).toBe(0);
    expect(stderr).toBe('');
  });

  test('owner cancellation revokes both an unclaimed link and an exchanged bearer', () => {
    const link = issueCredentialRegistrationLinkToken('cred:openai.api_key', { now });
    expect(revokeCredentialRegistrationLinkToken(link.token, { now: now + 1 })).toBe(true);
    expect(claimCredentialRegistrationLinkToken(link.token, { now: now + 2 })).toEqual({ ok: false, reason: 'revoked' });
    expect(revokeCredentialRegistrationLinkToken(link.token, { now: now + 2 })).toBe(false);

    const exchanged = issueCredentialRegistrationLinkToken('cred:openai.api_key', { now });
    const claimed = claimCredentialRegistrationLinkToken(exchanged.token, { now: now + 1 });
    if (!claimed.ok) throw new Error('expected successful credential link claim');
    expect(revokeCredentialRegistrationLinkToken(exchanged.token, { now: now + 2 })).toBe(true);
    expect(consumeCredentialRegistrationBearer(claimed.bearer, claimed.slot, { now: now + 3 }))
      .toEqual({ ok: false, reason: 'revoked' });

    const nearExpiry = issueCredentialRegistrationLinkToken('cred:openai.api_key', { now });
    const lateClaim = claimCredentialRegistrationLinkToken(nearExpiry.token, { now: now + SETUP_LINK_TTL_MS - 1 });
    if (!lateClaim.ok) throw new Error('expected late credential link claim');
    expect(revokeCredentialRegistrationLinkToken(nearExpiry.token, { now: now + SETUP_LINK_TTL_MS + 1 })).toBe(true);
    expect(consumeCredentialRegistrationBearer(lateClaim.bearer, lateClaim.slot, { now: now + SETUP_LINK_TTL_MS + 2 }))
      .toEqual({ ok: false, reason: 'revoked' });
  });

  test('owner temp-token storage and matching remain independent of setup links', () => {
    const owner = issueTempToken({ now, ttlMs: 60_000 });
    const link = issueSetupLinkToken({ now });
    expect(matchTempToken(owner.token, { now })).not.toBeNull();
    expect(matchTempToken(link.token, { now })).toBeNull();
    expect(claimSetupLinkToken(owner.token, { now })).toEqual({ ok: false, reason: 'unknown' });
    expect(readFileSync(join(dir, 'temp-tokens.json'), 'utf8')).not.toContain(link.token);
    expect(store()).not.toContain(owner.token);
  });

  test('independent processes racing to claim the same token mint exactly one bearer', async () => {
    const issued = issueSetupLinkToken({ now });
    const fixture = join(import.meta.dir, 'setup-link-tokens.fixture.ts');
    const children = Array.from({ length: 8 }, () => Bun.spawn(
      [process.execPath, fixture, 'claim', dir, issued.token, String(now + 1)],
      { stdout: 'pipe', stderr: 'pipe' },
    ));
    const results = await Promise.all(children.map(async (child) => {
      const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit).toBe(0);
      expect(errors).toBe('');
      return JSON.parse(output) as ReturnType<typeof claimSetupLinkToken>;
    }));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual(Array.from({ length: 7 }, () => ({ ok: false, reason: 'used' })));
  });

  test('an owner process dying while holding the lock does not strand issuance or claiming', async () => {
    const issued = issueSetupLinkToken({ now });
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'setup-link-tokens.fixture.ts'), 'hold', dir],
      { stdout: 'pipe', stderr: 'pipe' });
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toBe('locked\n');
      expect(() => issueSetupLinkToken({ now })).toThrow('setup link store is locked');
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }
    expect(issueSetupLinkToken({ now }).token).toMatch(/^els_/);
    expect(claimSetupLinkToken(issued.token, { now: now + 1 }).ok).toBe(true);
  });
});
