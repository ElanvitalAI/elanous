import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GROUNDING_TOKEN_SCOPES, mintGroundingToken, revokeGroundingRun, verifyGroundingToken } from './token.js';

describe('grounding token — Pod asks the host for citations, never reads the host universe', () => {
  const key = async () => 'k-test';
  const deps = (now = 1_000) => ({ key, now: () => now, revokedPath: join(mkdtempSync(join(tmpdir(), 'gtok-')), 'revoked.jsonl') });

  test('a minted token verifies with its claims', async () => {
    const d = deps();
    const { token, exp } = await mintGroundingToken({ runId: 'run-a', job: 'si-x', ttlMs: 60_000 }, d);
    expect(exp).toBe(61_000);
    expect(await verifyGroundingToken(token, d)).toEqual({ ok: true, runId: 'run-a', job: 'si-x', scope: 'grounding', exp: 61_000 });
  });

  test('each failure has its own reason (tamper · wrong key · expiry · revoke · garbage)', async () => {
    const d = deps();
    const { token } = await mintGroundingToken({ runId: 'run-a', job: 'si-x', ttlMs: 60_000 }, d);
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, runId: 'run-b', job: 'si-x', scope: 'grounding', exp: 61_000 })).toString('base64url');
    expect(await verifyGroundingToken(`${forged}.${sig}`, d)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(await verifyGroundingToken(token, { ...d, key: async () => 'other' })).toEqual({ ok: false, reason: 'bad-signature' });
    expect(await verifyGroundingToken(token, { ...d, now: () => 61_000 })).toEqual({ ok: false, reason: 'expired' });
    expect(await verifyGroundingToken('nope', d)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyGroundingToken(token, { ...d, key: async () => undefined })).toEqual({ ok: false, reason: 'no-key' });
    revokeGroundingRun('run-a', d);
    expect(await verifyGroundingToken(token, d)).toEqual({ ok: false, reason: 'revoked' });
    expect(payload).toBeTruthy();
  });

  test('revoking one run leaves another run\'s token alive', async () => {
    const d = deps();
    const a = await mintGroundingToken({ runId: 'run-a', job: 'j', ttlMs: 60_000 }, d);
    const b = await mintGroundingToken({ runId: 'run-b', job: 'j', ttlMs: 60_000 }, d);
    revokeGroundingRun('run-a', d);
    expect((await verifyGroundingToken(a.token, d)).ok).toBe(false);
    expect((await verifyGroundingToken(b.token, d)).ok).toBe(true);
  });

  test('gh-credential uses the same signed run claims, but neither other scope can cross its gate', async () => {
    const d = deps();
    expect(GROUNDING_TOKEN_SCOPES).toContain('gh-credential');
    const claims = { runId: 'run-gh', job: 'si-gh', ttlMs: 60_000 };
    const gh = await mintGroundingToken({ ...claims, scope: 'gh-credential' }, d);
    const ground = await mintGroundingToken(claims, d);
    const llm = await mintGroundingToken({ ...claims, scope: 'llm-credential' }, d);

    expect(gh.exp).toBe(61_000);
    expect(await verifyGroundingToken(gh.token, { ...d, expectedScope: 'gh-credential' })).toEqual({
      ok: true, runId: 'run-gh', job: 'si-gh', scope: 'gh-credential', exp: 61_000,
    });
    expect(await verifyGroundingToken(gh.token, d)).toEqual({ ok: false, reason: 'scope' });
    expect(await verifyGroundingToken(gh.token, { ...d, expectedScope: 'llm-credential' })).toEqual({ ok: false, reason: 'scope' });
    expect(await verifyGroundingToken(ground.token, { ...d, expectedScope: 'gh-credential' })).toEqual({ ok: false, reason: 'scope' });
    expect(await verifyGroundingToken(llm.token, { ...d, expectedScope: 'gh-credential' })).toEqual({ ok: false, reason: 'scope' });
  });

  test('gh-credential rejects an expired or revoked run through the shared verifier', async () => {
    const d = deps();
    const { token } = await mintGroundingToken({ runId: 'run-gh', job: 'si-gh', ttlMs: 60_000, scope: 'gh-credential' }, d);
    expect(await verifyGroundingToken(token, { ...d, expectedScope: 'gh-credential', now: () => 61_000 })).toEqual({ ok: false, reason: 'expired' });
    revokeGroundingRun('run-gh', d);
    expect(await verifyGroundingToken(token, { ...d, expectedScope: 'gh-credential' })).toEqual({ ok: false, reason: 'revoked' });
  });

  test('llm-credential shares the same sign/verify/revoke path and scopes do not cross', async () => {
    const d = deps();
    const cred = await mintGroundingToken({ runId: 'run-c', job: 'si-c', ttlMs: 60_000, scope: 'llm-credential' }, d);
    const ground = await mintGroundingToken({ runId: 'run-c', job: 'si-c', ttlMs: 60_000 }, d);
    expect(await verifyGroundingToken(cred.token, { ...d, expectedScope: 'llm-credential' })).toEqual({
      ok: true, runId: 'run-c', job: 'si-c', scope: 'llm-credential', exp: 61_000,
    });
    expect(await verifyGroundingToken(cred.token, d)).toEqual({ ok: false, reason: 'scope' });
    expect(await verifyGroundingToken(ground.token, { ...d, expectedScope: 'llm-credential' })).toEqual({ ok: false, reason: 'scope' });
    revokeGroundingRun('run-c', d);
    expect(await verifyGroundingToken(cred.token, { ...d, expectedScope: 'llm-credential' })).toEqual({ ok: false, reason: 'revoked' });
  });
});
