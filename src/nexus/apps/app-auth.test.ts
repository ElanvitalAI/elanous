import { afterEach, describe, expect, test } from 'bun:test';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_AUTH_CONTRACT_CASES, runAppAuthContractMatrix, type AppAuthCaseInput, type AppAuthContractPort } from '../../ux-sim/fake-app-auth.js';
import { createAppAuth } from './app-auth.js';

const dirs: string[] = [];
const KEY = 'app-auth-contract-test-key-with-at-least-256-bits';
const INITIAL_TIME = Date.UTC(2026, 0, 1);

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'app-auth-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function contractPort(): AppAuthContractPort {
  return {
    createCase(input: AppAuthCaseInput) {
      let clock = INITIAL_TIME;
      const auth = createAppAuth({ dir: tempDir(), key: KEY, now: () => clock,
        sessionTtlMs: input.action === 'session-expired' ? input.ttlMs : 60_000 });
      return {
        issueInvitation: value => auth.issueInvitation(value),
        acceptInvitation: value => auth.acceptInvitation(value),
        verifySession: value => auth.verifySession(value),
        revokeSession: value => auth.revokeSession(value),
        signUp: value => auth.signUp(value),
        getSessionRecord: value => auth.getSessionRecord(value),
        advanceTime(ms) { clock += ms; },
      };
    },
  };
}

describe('NEXUS-APP-AUTH-S1', () => {
  test('passes the SIM-APPAUTH contract matrix against the production port', async () => {
    const results = await runAppAuthContractMatrix(contractPort());
    expect(results).toHaveLength(APP_AUTH_CONTRACT_CASES.length);
    expect(results.every(result => result.passed)).toBe(true);
  });

  test('keeps session claims verifiable across instances and revokes the backing temp token', () => {
    const dir = tempDir();
    const issuer = createAppAuth({ dir, key: KEY, now: () => INITIAL_TIME });
    const invite = issuer.issueInvitation({ appSlug: 'notes', invitedBy: 'owner-17' });
    const accepted = issuer.acceptInvitation({ appSlug: 'notes', token: invite.token });
    const restarted = createAppAuth({ dir, key: KEY, now: () => INITIAL_TIME });

    expect(accepted.sessionToken).toStartWith('aps_');
    expect(accepted.sessionToken).not.toContain('owner-17');
    expect(accepted.sessionToken).not.toContain('elt_');
    expect(restarted.verifySession({ appSlug: 'notes', token: accepted.cookie! }).status).toBe(200);
    expect(restarted.getSessionRecord(accepted.sessionToken!)?.invitedBy).toBe('owner-17');
    expect(restarted.revokeSession(accepted.cookie!)).toBe(true);
    expect(restarted.verifySession({ appSlug: 'notes', token: accepted.sessionToken! }).status).toBe(401);
  });

  test('accepts unexpired v1 invitation and session tokens that predate role claims as owner', () => {
    const dir = tempDir();
    const auth = createAppAuth({ dir, key: KEY, now: () => INITIAL_TIME });
    const currentInvite = auth.issueInvitation({ appSlug: 'notes', invitedBy: 'owner-17' });
    const invitePayload = JSON.parse(Buffer.from(currentInvite.token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    delete invitePayload.role;
    const encodedInvite = Buffer.from(JSON.stringify(invitePayload)).toString('base64url');
    const oldInvite = `${encodedInvite}.${createHmac('sha256', KEY).update(encodedInvite).digest('base64url')}`;
    const accepted = auth.acceptInvitation({ appSlug: 'notes', token: oldInvite });
    expect(accepted.role).toBe('owner');

    const packed = Buffer.from(accepted.sessionToken!.slice(4), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(KEY).digest(), packed.subarray(0, 12));
    decipher.setAAD(Buffer.from('elanous-nexus-app-session-v1'));
    decipher.setAuthTag(packed.subarray(-16));
    const oldClaims = JSON.parse(Buffer.concat([decipher.update(packed.subarray(12, -16)), decipher.final()]).toString('utf8')) as Record<string, unknown>;
    delete oldClaims.role;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(KEY).digest(), iv);
    cipher.setAAD(Buffer.from('elanous-nexus-app-session-v1'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(oldClaims), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    const oldSession = `aps_${Buffer.concat([iv, encrypted]).toString('base64url')}`;
    expect(auth.verifySession({ appSlug: 'notes', token: oldSession })).toEqual({ status: 200, role: 'owner' });
  });

  test('requires a stable 256-bit signing key and rejects malformed app identifiers', () => {
    expect(() => createAppAuth({ dir: tempDir(), key: 'short' })).toThrow('at least 256 bits');
    const auth = createAppAuth({ dir: tempDir(), key: KEY, now: () => INITIAL_TIME });
    expect(() => auth.issueInvitation({ appSlug: 'Invalid-Slug', invitedBy: 'owner' })).toThrow('appSlug');
    expect(() => auth.issueInvitation({ appSlug: 'notes', invitedBy: ' ' })).toThrow('invitedBy');
  });

  test('keeps an invitation link reusable until its expiry; session revocation only revokes that session', () => {
    const auth = createAppAuth({ dir: tempDir(), key: KEY, now: () => INITIAL_TIME });
    const invitation = auth.issueInvitation({ appSlug: 'notes', invitedBy: 'owner-17', ttlMs: 60_000 });
    const first = auth.acceptInvitation({ appSlug: 'notes', token: invitation.token });
    expect(auth.revokeSession(first.sessionToken!)).toBe(true);
    const next = auth.acceptInvitation({ appSlug: 'notes', token: invitation.token });
    expect(next.status).toBe(200);
    expect(auth.verifySession({ appSlug: 'notes', token: next.sessionToken! }).status).toBe(200);
  });
});
