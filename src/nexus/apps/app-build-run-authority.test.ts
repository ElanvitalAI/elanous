import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTuiMemberSession } from '../../tui/member-session-contract.js';
import { createAppBuildRunAuthority, loadAppBuildRunAuthorityKey, relayMemberKeyFingerprint } from './app-build-run-authority.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('Nexus run seal survives SDK expiry but rejects other run/app, tampering and retirement', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-build-authority-'))); roots.push(root);
  const sessionPath = join(root, 'member-session.json');
  const configPath = join(root, 'config.json'); const keyPath = join(root, 'member.key');
  writeFileSync(sessionPath, JSON.stringify({ nexusUrl: 'https://api.elanous.ai', appSlug: 'synthetic-app',
    sessionToken: 'aps_synthetic_session', expiresAt: '2026-11-15T21:10:00Z' }), { mode: 0o600 });
  writeFileSync(keyPath, 'emk_SyntheticKey123', { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ nexus: { relay: { memberKeyFile: keyPath } } }), { mode: 0o600 });
  let time = Date.parse('2026-11-15T20:50:00Z');
  const authority = createAppBuildRunAuthority({ root: join(root, 'authority'), hostKey: 'a'.repeat(64),
    now: () => time, retainedSession: () => readTuiMemberSession(sessionPath, 0),
    relayKeyFingerprint: () => relayMemberKeyFingerprint(root) });
  const grant = { ownerId: 'synthetic-owner', userSlug: 'syntheticowner', runId: 'run-1',
    appSlug: 'synthetic-app', sourceHead: 'f'.repeat(40), issuerExpiresAt: '2026-11-15T23:30:00Z' };
  const live = readTuiMemberSession(sessionPath, time)!;
  authority.issue(grant, live);
  const seal = join(root, 'authority', 'run-1.json');
  expect(readFileSync(seal, 'utf8')).not.toContain(live.sessionToken);
  expect(authority.resolve('run-1', 'synthetic-app', grant.sourceHead)).toEqual({
    memberId: grant.ownerId, userSlug: grant.userSlug });
  time = Date.parse('2026-11-15T21:30:00Z');
  expect(readTuiMemberSession(sessionPath, time)).toBeUndefined();
  expect(authority.resolve('run-1', 'synthetic-app', grant.sourceHead)?.memberId).toBe(grant.ownerId);
  expect(authority.resolve('run-2', 'synthetic-app', grant.sourceHead)).toBeNull();
  expect(authority.resolve('run-1', 'other-app', grant.sourceHead)).toBeNull();
  expect(authority.resolve('run-1', 'synthetic-app', 'e'.repeat(40))).toBeNull();
  const bytes = readFileSync(seal, 'utf8');
  writeFileSync(seal, bytes.replace('synthetic-owner', 'foreign-owner'));
  expect(authority.resolve('run-1', 'synthetic-app', grant.sourceHead)).toBeNull();
  writeFileSync(seal, bytes);
  chmodSync(seal, 0o644);
  expect(authority.resolve('run-1', 'synthetic-app', grant.sourceHead)).toBeNull();
  chmodSync(seal, 0o600);
  rmSync(keyPath);
  expect(authority.resolve('run-1', 'synthetic-app', grant.sourceHead)).toBeNull();
  writeFileSync(keyPath, 'emk_ReplacedKey123', { mode: 0o600 });
  expect(authority.resolve('run-1', 'synthetic-app', grant.sourceHead)).toBeNull();
  writeFileSync(keyPath, 'emk_SyntheticKey123');
  expect(authority.resolve('run-1', 'synthetic-app', grant.sourceHead)).toBeNull();
  rmSync(sessionPath);
  expect(authority.resolve('run-1', 'synthetic-app', grant.sourceHead)).toBeNull();
});

test('observed member session removal permanently revokes a run even after identical bytes return', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-build-authority-'))); roots.push(root);
  const sessionPath = join(root, 'member-session.json');
  const session = { nexusUrl: 'https://api.elanous.ai', appSlug: 'synthetic-app', sessionToken: 'aps_synthetic' };
  writeFileSync(sessionPath, JSON.stringify(session), { mode: 0o600 });
  const authority = createAppBuildRunAuthority({ root: join(root, 'authority'), hostKey: 'd'.repeat(64),
    retainedSession: () => {
      try { return JSON.parse(readFileSync(sessionPath, 'utf8')) as typeof session; } catch { return undefined; }
    }, relayKeyFingerprint: () => sha('emk-synthetic') });
  const grant = { ownerId: 'synthetic-owner', userSlug: 'syntheticowner', runId: 'run-1',
    appSlug: 'synthetic-app', sourceHead: 'f'.repeat(40), issuerExpiresAt: '2099-01-01T00:00:00Z' };
  authority.issue(grant, session);
  expect(authority.resolve('run-1', grant.appSlug, grant.sourceHead)?.memberId).toBe(grant.ownerId);
  rmSync(sessionPath);
  expect(authority.resolve('run-1', grant.appSlug, grant.sourceHead)).toBeNull();
  expect(readFileSync(join(root, 'authority', 'run-1.json.revoked'), 'utf8')).toBe('revoked\n');
  writeFileSync(sessionPath, JSON.stringify(session), { mode: 0o600 });
  expect(authority.resolve('run-1', grant.appSlug, grant.sourceHead)).toBeNull();
});

test('revocation marker ENOSPC retires the signed seal and stays refused after restart', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-build-authority-'))); roots.push(root);
  const session = { nexusUrl: 'https://api.elanous.ai', appSlug: 'synthetic-app', sessionToken: 'aps_synthetic' };
  let retained: typeof session | undefined = session;
  const opts = { root: join(root, 'authority'), hostKey: 'e'.repeat(64),
    retainedSession: () => retained, relayKeyFingerprint: () => sha('emk-synthetic') };
  const authority = createAppBuildRunAuthority({ ...opts, writeRevocationMarker: () => {
    const error = new Error('disk full') as NodeJS.ErrnoException; error.code = 'ENOSPC'; throw error;
  } });
  const grant = { ownerId: 'synthetic-owner', userSlug: 'syntheticowner', runId: 'run-1',
    appSlug: 'synthetic-app', sourceHead: 'f'.repeat(40), issuerExpiresAt: '2099-01-01T00:00:00Z' };
  authority.issue(grant, session);
  retained = undefined;
  expect(authority.resolve(grant.runId, grant.appSlug, grant.sourceHead)).toBeNull();
  expect(() => readFileSync(join(opts.root, 'run-1.json'))).toThrow();
  retained = session;
  expect(createAppBuildRunAuthority(opts).resolve(grant.runId, grant.appSlug, grant.sourceHead)).toBeNull();
});

test('run authority expires within two hours even if C approval lasts longer', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-build-authority-'))); roots.push(root);
  let time = Date.parse('2026-11-15T20:50:00Z');
  const session = { nexusUrl: 'https://api.elanous.ai', appSlug: 'synthetic-app', sessionToken: 'aps_synthetic' };
  const authority = createAppBuildRunAuthority({ root: join(root, 'authority'), hostKey: 'b'.repeat(64),
    now: () => time, retainedSession: () => session, relayKeyFingerprint: () => sha('emk-synthetic') });
  const grant = { ownerId: 'synthetic-owner', userSlug: 'syntheticowner', runId: 'run-1',
    appSlug: 'synthetic-app', sourceHead: 'f'.repeat(40), issuerExpiresAt: '2099-01-01T00:00:00Z' };
  authority.issue(grant, session);
  time += 2 * 60 * 60 * 1_000;
  expect(authority.resolve('run-1', 'synthetic-app', grant.sourceHead)).toBeNull();
});

test('reserve can precede relay connection; first C check binds the key and retirement revokes it', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-build-authority-'))); roots.push(root);
  let time = Date.parse('2026-11-15T20:50:00Z');
  let key: string | undefined;
  const session = { nexusUrl: 'https://api.elanous.ai', appSlug: 'synthetic-app', sessionToken: 'aps_synthetic' };
  const authority = createAppBuildRunAuthority({ root: join(root, 'authority'), hostKey: 'c'.repeat(64),
    now: () => time, retainedSession: () => session, relayKeyFingerprint: () => key });
  const grant = { ownerId: 'synthetic-owner', userSlug: 'syntheticowner', runId: 'run-1',
    appSlug: 'synthetic-app', sourceHead: 'f'.repeat(40), issuerExpiresAt: '2099-01-01T00:00:00Z' };
  authority.issue(grant, session);
  time += 30 * 60 * 1_000;
  expect(authority.resolve('run-1', 'synthetic-app', grant.sourceHead)).toBeNull();
  key = sha('operator-connected-emk');
  expect(authority.resolve('run-1', 'synthetic-app', grant.sourceHead)?.memberId).toBe(grant.ownerId);
  const bound = readFileSync(join(root, 'authority', 'run-1.json'), 'utf8');
  expect(bound).toContain(key);
  key = undefined;
  expect(authority.resolve('run-1', 'synthetic-app', grant.sourceHead)).toBeNull();
  key = sha('rotated-emk');
  expect(authority.resolve('run-1', 'synthetic-app', grant.sourceHead)).toBeNull();
});

test('Nexus signing key persists privately and refuses a world-readable replacement', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-build-authority-'))); roots.push(root);
  const path = join(root, 'nexus', 'run-authority.key');
  const first = loadAppBuildRunAuthorityKey(path);
  expect(first).toMatch(/^[a-f0-9]{64}$/u);
  expect(loadAppBuildRunAuthorityKey(path)).toBe(first);
  chmodSync(path, 0o644);
  expect(() => loadAppBuildRunAuthorityKey(path)).toThrow('BUILD_RUN_AUTHORITY_REFUSED');
});
