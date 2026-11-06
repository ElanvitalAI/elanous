import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMockScenarioCatalog } from './mock-scenario-catalog.js';
import {
  APP_AUTH_CONTRACT_CASES,
  tamperSignedToken,
  createFakeAppAuth,
  runAppAuthContractMatrix,
  type AppAuthCaseInput,
  type AppAuthContractPort,
  type AppAuthContractSubject,
} from './fake-app-auth.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-app-auth-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const now = Date.UTC(2026, 0, 1);

describe('SIM-APPAUTH: invitation and host-only app sessions', () => {
  test('registers implementation and focused test in the device catalog', () => {
    const device = loadMockScenarioCatalog().devices.find((entry) => entry.id === 'fake-app-auth');
    expect(device?.implementation).toContain('src/ux-sim/fake-app-auth.ts');
    expect(device?.tests).toContain('src/ux-sim/fake-app-auth.test.ts');
    expect(device?.entryCommands).toContain('bun test src/ux-sim/fake-app-auth.test.ts');
  });

  test('acceptance issues a host-only session and preserves the inviter', () => {
    const auth = createFakeAppAuth({ dir: tempDir(), key: 'test-signing-key', now: () => now });
    const invitation = auth.issueInvitation({ appSlug: 'notes', invitedBy: 'owner-17', ttlMs: 60_000 });
    const accepted = auth.acceptInvitation({ appSlug: 'notes', token: invitation.token });

    expect(accepted.status).toBe(200);
    expect(accepted.cookie).toMatch(/^__Host-app-session=/);
    expect(accepted.cookie).toContain('Secure');
    expect(accepted.cookie).toContain('Path=/');
    expect(accepted.cookie).not.toMatch(/(?:^|;\s*)Domain=/i);
    expect(auth.getSessionRecord(accepted.sessionToken!)?.invitedBy).toBe('owner-17');
    expect(auth.verifySession({ appSlug: 'notes', token: accepted.sessionToken! }).status).toBe(200);
  });

  test('rejects tampering, cross-app use, expiry, revoked sessions, and uninvited signup', () => {
    const dir = tempDir();
    let clock = now;
    const auth = createFakeAppAuth({ dir, key: 'test-signing-key', now: () => clock });
    const invitation = auth.issueInvitation({ appSlug: 'notes', invitedBy: 'owner-17', ttlMs: 1_000 });

    expect(auth.acceptInvitation({ appSlug: 'notes', token: tamperSignedToken(invitation.token) }).status).toBe(401);
    expect(tamperSignedToken(invitation.token)).toHaveLength(invitation.token.length);
    expect(auth.acceptInvitation({ appSlug: 'tasks', token: invitation.token }).status).toBe(401);
    expect(auth.signUp({ appSlug: 'notes' }).status).toBe(401);

    const accepted = auth.acceptInvitation({ appSlug: 'notes', token: invitation.token });
    expect(accepted.status).toBe(200);
    expect(auth.verifySession({ appSlug: 'tasks', token: accepted.sessionToken! }).status).toBe(401);
    auth.revokeSession(accepted.sessionToken!);
    expect(auth.verifySession({ appSlug: 'notes', token: accepted.sessionToken! }).status).toBe(401);

    const expiring = auth.issueInvitation({ appSlug: 'notes', invitedBy: 'owner-17', ttlMs: 1_000 });
    clock += 1_000;
    expect(auth.acceptInvitation({ appSlug: 'notes', token: expiring.token }).status).toBe(401);

    let sessionClock = now;
    const shortSessionAuth = createFakeAppAuth({ dir: tempDir(), key: 'session-expiry-key', now: () => sessionClock, sessionTtlMs: 1_000 });
    const validInvite = shortSessionAuth.issueInvitation({ appSlug: 'notes', invitedBy: 'owner-17', ttlMs: 60_000 });
    const shortSession = shortSessionAuth.acceptInvitation({ appSlug: 'notes', token: validInvite.token });
    expect(shortSessionAuth.verifySession({ appSlug: 'notes', token: shortSession.sessionToken! }).status).toBe(200);
    sessionClock += 1_000;
    expect(shortSessionAuth.verifySession({ appSlug: 'notes', token: shortSession.sessionToken! }).status).toBe(401);
  });

  test('revokeSession refuses tokens issued by another instance sharing the same dir', () => {
    const dir = tempDir();
    const owner = createFakeAppAuth({ dir, key: 'owner-key', now: () => now });
    const stranger = createFakeAppAuth({ dir, key: 'stranger-key', now: () => now });
    const invite = owner.issueInvitation({ appSlug: 'notes', invitedBy: 'owner-17', ttlMs: 60_000 });
    const accepted = owner.acceptInvitation({ appSlug: 'notes', token: invite.token });
    expect(stranger.revokeSession(accepted.sessionToken!)).toBe(false);
    expect(stranger.revokeSession(accepted.cookie!)).toBe(false);
    expect(owner.verifySession({ appSlug: 'notes', token: accepted.sessionToken! }).status).toBe(200);
    expect(owner.revokeSession(accepted.cookie!)).toBe(true);
    expect(owner.verifySession({ appSlug: 'notes', token: accepted.sessionToken! }).status).toBe(401);
  });

  test('the matrix rejects length-only signature checks and cookies that do not carry the session', async () => {
    const lengthOnly: AppAuthContractPort = {
      createCase(input) {
        let clock = now;
        const auth = createFakeAppAuth({ dir: tempDir(), key: `length-${input.action}`, now: () => clock, sessionTtlMs: input.action === 'session-expired' ? input.ttlMs : 60_000 });
        let lastValid = '';
        return {
          issueInvitation(value) { const issued = auth.issueInvitation(value); lastValid = issued.token; return issued; },
          // Defect: accepts any token with the same length as the last issued one.
          acceptInvitation(value) { return auth.acceptInvitation({ ...value, token: value.token.length === lastValid.length ? lastValid : value.token }); },
          verifySession(value) { return auth.verifySession(value); },
          revokeSession(value) { return auth.revokeSession(value); },
          signUp(value) { return auth.signUp(value); },
          getSessionRecord(value) { return auth.getSessionRecord(value); },
          advanceTime(ms) { clock += ms; },
        };
      },
    };
    await expect(runAppAuthContractMatrix(lengthOnly)).rejects.toThrow('tampered invitation is rejected');

    const badCookie: AppAuthContractPort = {
      createCase(input) {
        let clock = now;
        const auth = createFakeAppAuth({ dir: tempDir(), key: `cookie-${input.action}`, now: () => clock, sessionTtlMs: input.action === 'session-expired' ? input.ttlMs : 60_000 });
        return {
          issueInvitation(value) { return auth.issueInvitation(value); },
          acceptInvitation(value) {
            const accepted = auth.acceptInvitation(value);
            return accepted.cookie ? { ...accepted, cookie: accepted.cookie.replace(/=([^;]*)/, '=not-the-session') } : accepted;
          },
          verifySession(value) { return auth.verifySession(value); },
          revokeSession(value) { return auth.revokeSession(value); },
          signUp(value) { return auth.signUp(value); },
          getSessionRecord(value) { return auth.getSessionRecord(value); },
          advanceTime(ms) { clock += ms; },
        };
      },
    };
    await expect(runAppAuthContractMatrix(badCookie)).rejects.toThrow('invitation acceptance creates a host-only session and records inviter');
  });

  test('exports named input/expectation cases and runs them through real port methods', async () => {
    const calls: string[] = [];
    const port: AppAuthContractPort = {
      createCase(input: AppAuthCaseInput): AppAuthContractSubject {
        let clock = now;
        const auth = createFakeAppAuth({ dir: tempDir(), key: `portable-${input.action}`, now: () => clock, sessionTtlMs: input.action === 'session-expired' ? input.ttlMs : 60_000 });
        return {
          issueInvitation(value) { calls.push('issueInvitation'); return auth.issueInvitation(value); },
          acceptInvitation(value) { calls.push('acceptInvitation'); return auth.acceptInvitation(value); },
          verifySession(value) { calls.push('verifySession'); return auth.verifySession(value); },
          revokeSession(value) { calls.push('revokeSession'); return auth.revokeSession(value); },
          signUp(value) { calls.push('signUp'); return auth.signUp(value); },
          getSessionRecord(value) { calls.push('getSessionRecord'); return auth.getSessionRecord(value); },
          advanceTime(ms) { clock += ms; },
        };
      },
    };
    const results = await runAppAuthContractMatrix(port);
    expect(APP_AUTH_CONTRACT_CASES.every((item) => item.name && item.input && item.expected)).toBe(true);
    expect(results).toHaveLength(APP_AUTH_CONTRACT_CASES.length);
    expect(calls).toContain('issueInvitation');
    expect(calls).toContain('acceptInvitation');
    expect(calls).toContain('getSessionRecord');
    expect(calls).toContain('verifySession');
  });

  test('the matrix rejects an implementation that stores the wrong inviter', async () => {
    const defectivePort: AppAuthContractPort = {
      createCase(input) {
        let clock = now;
        const auth = createFakeAppAuth({ dir: tempDir(), key: `defective-${input.action}`, now: () => clock, sessionTtlMs: input.action === 'session-expired' ? input.ttlMs : 60_000 });
        return {
          issueInvitation(value) { return auth.issueInvitation({ ...value, invitedBy: 'different-owner' }); },
          acceptInvitation(value) { return auth.acceptInvitation(value); },
          verifySession(value) { return auth.verifySession(value); },
          revokeSession(value) { return auth.revokeSession(value); },
          signUp(value) { return auth.signUp(value); },
          getSessionRecord(value) { return auth.getSessionRecord(value); },
          advanceTime(ms) { clock += ms; },
        };
      },
    };

    await expect(runAppAuthContractMatrix(defectivePort)).rejects.toThrow('invitation acceptance creates a host-only session and records inviter');
  });

  test('the matrix rejects a session implementation that always returns unauthorized', async () => {
    const defectivePort: AppAuthContractPort = {
      createCase(input) {
        let clock = now;
        const auth = createFakeAppAuth({ dir: tempDir(), key: `expired-${input.action}`, now: () => clock, sessionTtlMs: input.action === 'session-expired' ? input.ttlMs : 60_000 });
        return {
          issueInvitation(value) { return auth.issueInvitation(value); },
          acceptInvitation(value) { return auth.acceptInvitation(value); },
          verifySession(_value) { return { status: 401 }; },
          revokeSession(value) { return auth.revokeSession(value); },
          signUp(value) { return auth.signUp(value); },
          getSessionRecord(value) { return auth.getSessionRecord(value); },
          advanceTime(ms) { clock += ms; },
        };
      },
    };

    await expect(runAppAuthContractMatrix(defectivePort)).rejects.toThrow('invitation acceptance creates a host-only session and records inviter');
  });

  test('the exported contract matrix passes against the in-device reference implementation', async () => {
    const auth = createFakeAppAuth({ dir: tempDir(), key: 'matrix-signing-key', now: () => now });
    const result = await auth.runContractMatrix();
    expect(result.every((entry) => entry.passed)).toBe(true);
    const expiryCase = result.find((entry) => entry.input.action === 'session-expired');
    expect(expiryCase?.actual.sessionStatus).toBe(200);
    expect(expiryCase?.actual.sessionStatusAfterExpiry).toBe(401);
    const crossAppSessionCase = result.find((entry) => entry.input.action === 'session-cross-app');
    expect(crossAppSessionCase?.actual.sessionStatus).toBe(200);
    expect(crossAppSessionCase?.actual.crossAppSessionStatus).toBe(401);
    const revokeCase = result.find((entry) => entry.input.action === 'revoke');
    expect(revokeCase?.actual.sessionStatus).toBe(200);
    expect(revokeCase?.actual.sessionStatusAfterRevoke).toBe(401);
  });
});
