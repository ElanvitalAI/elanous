import { afterEach, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTuiMemberSession } from '../../tui/member-session-contract.js';
import { createAppBuildRunAuthority, createAppDeploymentGrantProvider,
  loadAppBuildRunAuthorityKey, relayMemberKeyFingerprint } from './app-build-run-authority.js';

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

test('same app reconnect rebinds the seal and a different app still revokes the run', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-build-authority-'))); roots.push(root);
  const sessionPath = join(root, 'member-session.json');
  const first = { nexusUrl: 'https://api.elanous.ai', appSlug: 'synthetic-app', sessionToken: 'aps_first' };
  writeFileSync(sessionPath, JSON.stringify(first), { mode: 0o600 });
  const read = () => {
    try { return JSON.parse(readFileSync(sessionPath, 'utf8')) as typeof first; } catch { return undefined; }
  };
  const authority = createAppBuildRunAuthority({ root: join(root, 'authority'), hostKey: 'c'.repeat(64),
    retainedSession: read, relayKeyFingerprint: () => sha('emk-synthetic') });
  const grant = { ownerId: 'synthetic-owner', userSlug: 'syntheticowner', runId: 'run-1',
    appSlug: 'synthetic-app', sourceHead: 'f'.repeat(40), issuerExpiresAt: '2099-01-01T00:00:00Z' };
  authority.issue(grant, first);
  const replacement = { ...first, sessionToken: 'aps_replacement' };
  writeFileSync(sessionPath, JSON.stringify(replacement), { mode: 0o600 });
  expect(authority.resolve(grant.runId, grant.appSlug, grant.sourceHead)).toEqual({
    memberId: grant.ownerId, userSlug: grant.userSlug });
  expect(readFileSync(join(root, 'authority', 'run-1.json'), 'utf8')).not.toContain(replacement.sessionToken);
  expect(createAppBuildRunAuthority({ root: join(root, 'authority'), hostKey: 'c'.repeat(64),
    retainedSession: read, relayKeyFingerprint: () => sha('emk-synthetic') })
    .resolve(grant.runId, grant.appSlug, grant.sourceHead)?.memberId).toBe(grant.ownerId);
  writeFileSync(sessionPath, JSON.stringify({ ...replacement, appSlug: 'other-app' }), { mode: 0o600 });
  expect(authority.resolve(grant.runId, grant.appSlug, grant.sourceHead)).toBeNull();
  expect(readFileSync(join(root, 'authority', 'run-1.json.revoked'), 'utf8')).toBe('revoked\n');
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

test('relay null plus a replacement session keeps the new session hash when the key binds', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-build-authority-'))); roots.push(root);
  const sessionPath = join(root, 'member-session.json');
  const first = { nexusUrl: 'https://api.elanous.ai', appSlug: 'synthetic-app', sessionToken: 'aps_first' };
  writeFileSync(sessionPath, JSON.stringify(first), { mode: 0o600 });
  const read = () => JSON.parse(readFileSync(sessionPath, 'utf8')) as typeof first;
  let key: string | undefined;
  const authority = createAppBuildRunAuthority({ root: join(root, 'authority'), hostKey: 'e'.repeat(64),
    retainedSession: read, relayKeyFingerprint: () => key });
  const grant = { ownerId: 'synthetic-owner', userSlug: 'syntheticowner', runId: 'run-1',
    appSlug: 'synthetic-app', sourceHead: 'f'.repeat(40), issuerExpiresAt: '2099-01-01T00:00:00Z' };
  authority.issue(grant, first);
  const replacement = { ...first, sessionToken: 'aps_replacement' };
  writeFileSync(sessionPath, JSON.stringify(replacement), { mode: 0o600 });
  key = sha('operator-connected-emk');
  expect(authority.resolve(grant.runId, grant.appSlug, grant.sourceHead)?.memberId).toBe(grant.ownerId);
  const bound = JSON.parse(readFileSync(join(root, 'authority', 'run-1.json'), 'utf8')) as {
    sessionHash: string; relayKeyHash: string };
  expect(bound.sessionHash).toBe(sha('https://api.elanous.ai\0synthetic-app\0aps_replacement'));
  expect(bound.relayKeyHash).toBe(key);
  expect(createAppBuildRunAuthority({ root: join(root, 'authority'), hostKey: 'e'.repeat(64),
    retainedSession: () => first, relayKeyFingerprint: () => key })
    .resolve(grant.runId, grant.appSlug, grant.sourceHead)).toBeNull();
});

test('every retired session generation stays refused across A→B→C→A and restarts', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-build-authority-'))); roots.push(root);
  const sessionPath = join(root, 'member-session.json');
  const first = { nexusUrl: 'https://api.elanous.ai', appSlug: 'synthetic-app', sessionToken: 'aps_first' };
  writeFileSync(sessionPath, JSON.stringify(first), { mode: 0o600 });
  const read = () => {
    try { return JSON.parse(readFileSync(sessionPath, 'utf8')) as typeof first; } catch { return undefined; }
  };
  // A fresh authority per resolve stands in for a restart: nothing in-process survives.
  const make = () => createAppBuildRunAuthority({ root: join(root, 'authority'), hostKey: 'f'.repeat(64),
    retainedSession: read, relayKeyFingerprint: () => sha('emk-synthetic') });
  const grant = { ownerId: 'synthetic-owner', userSlug: 'syntheticowner', runId: 'run-1',
    appSlug: 'synthetic-app', sourceHead: 'f'.repeat(40), issuerExpiresAt: '2099-01-01T00:00:00Z' };
  make().issue(grant, first);
  for (const token of ['aps_second', 'aps_third']) {
    writeFileSync(sessionPath, JSON.stringify({ ...first, sessionToken: token }), { mode: 0o600 });
    expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)?.memberId).toBe(grant.ownerId);
  }
  writeFileSync(sessionPath, JSON.stringify(first), { mode: 0o600 });
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)).toBeNull();
  expect(readFileSync(join(root, 'authority', 'run-1.json.revoked'), 'utf8')).toBe('revoked\n');
});

test('a corrupted sidecar ledger refuses the rebinding instead of laundering an empty history', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-build-authority-'))); roots.push(root);
  const sessionPath = join(root, 'member-session.json');
  const first = { nexusUrl: 'https://api.elanous.ai', appSlug: 'synthetic-app', sessionToken: 'aps_first' };
  writeFileSync(sessionPath, JSON.stringify(first), { mode: 0o600 });
  const read = () => {
    try { return JSON.parse(readFileSync(sessionPath, 'utf8')) as typeof first; } catch { return undefined; }
  };
  // A fresh authority per resolve stands in for a restart: nothing in-process survives.
  const make = () => createAppBuildRunAuthority({ root: join(root, 'authority'), hostKey: 'f'.repeat(64),
    retainedSession: read, relayKeyFingerprint: () => sha('emk-synthetic') });
  const grant = { ownerId: 'synthetic-owner', userSlug: 'syntheticowner', runId: 'run-1',
    appSlug: 'synthetic-app', sourceHead: 'f'.repeat(40), issuerExpiresAt: '2099-01-01T00:00:00Z' };
  make().issue(grant, first);
  writeFileSync(sessionPath, JSON.stringify({ ...first, sessionToken: 'aps_second' }), { mode: 0o600 });
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)?.memberId).toBe(grant.ownerId);
  const ledger = join(root, 'authority', 'run-1.json.sessions');
  const sealPath = join(root, 'authority', 'run-1.json');
  const sealed = readFileSync(sealPath, 'utf8');
  // Corrupt the retired-generation sidecar past the 4096-byte verification bound:
  // the rebind is refused — never continued as an empty history — seal untouched.
  writeFileSync(ledger, 'x'.repeat(4097));
  writeFileSync(sessionPath, JSON.stringify({ ...first, sessionToken: 'aps_third' }), { mode: 0o600 });
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)).toBeNull();
  expect(readFileSync(sealPath, 'utf8')).toBe(sealed);
  // A restart keeps refusing: the unreadable history never launders into a rebind.
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)).toBeNull();
  expect(readFileSync(sealPath, 'utf8')).toBe(sealed);
});

test('a single malformed sidecar history row refuses the rebinding instead of being filtered away', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-build-authority-'))); roots.push(root);
  const sessionPath = join(root, 'member-session.json');
  const first = { nexusUrl: 'https://api.elanous.ai', appSlug: 'synthetic-app', sessionToken: 'aps_first' };
  writeFileSync(sessionPath, JSON.stringify(first), { mode: 0o600 });
  const read = () => {
    try { return JSON.parse(readFileSync(sessionPath, 'utf8')) as typeof first; } catch { return undefined; }
  };
  const make = () => createAppBuildRunAuthority({ root: join(root, 'authority'), hostKey: 'f'.repeat(64),
    retainedSession: read, relayKeyFingerprint: () => sha('emk-synthetic') });
  const grant = { ownerId: 'synthetic-owner', userSlug: 'syntheticowner', runId: 'run-1',
    appSlug: 'synthetic-app', sourceHead: 'f'.repeat(40), issuerExpiresAt: '2099-01-01T00:00:00Z' };
  make().issue(grant, first);
  const ledger = join(root, 'authority', 'run-1.json.sessions');
  const sealPath = join(root, 'authority', 'run-1.json');
  // A→B retires A into the ledger.
  writeFileSync(sessionPath, JSON.stringify({ ...first, sessionToken: 'aps_second' }), { mode: 0o600 });
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)?.memberId).toBe(grant.ownerId);
  const retiredA = sha('https://api.elanous.ai\0synthetic-app\0aps_first');
  const sealed = readFileSync(sealPath, 'utf8');
  // One corrupted row amid valid ones: the whole history is unprovable, so the
  // B→C rebind is refused — never continued past the bad row with the good ones.
  writeFileSync(ledger, 'not-a-hash\n' + retiredA + '\n');
  writeFileSync(sessionPath, JSON.stringify({ ...first, sessionToken: 'aps_third' }), { mode: 0o600 });
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)).toBeNull();
  expect(readFileSync(sealPath, 'utf8')).toBe(sealed);
  // A restart keeps refusing while the corrupted row stays.
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)).toBeNull();
  expect(readFileSync(sealPath, 'utf8')).toBe(sealed);
  // The row is repaired: the rebind proceeds — the refusal was the corruption alone.
  writeFileSync(ledger, retiredA + '\n');
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)?.memberId).toBe(grant.ownerId);
  expect(readFileSync(ledger, 'utf8')).toBe(retiredA + '\n'
    + sha('https://api.elanous.ai\0synthetic-app\0aps_second') + '\n');
});

test('a seal with a retired generation refuses the rebinding while the sidecar ledger is absent', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-build-authority-'))); roots.push(root);
  const sessionPath = join(root, 'member-session.json');
  const first = { nexusUrl: 'https://api.elanous.ai', appSlug: 'synthetic-app', sessionToken: 'aps_first' };
  writeFileSync(sessionPath, JSON.stringify(first), { mode: 0o600 });
  const read = () => {
    try { return JSON.parse(readFileSync(sessionPath, 'utf8')) as typeof first; } catch { return undefined; }
  };
  const make = () => createAppBuildRunAuthority({ root: join(root, 'authority'), hostKey: 'f'.repeat(64),
    retainedSession: read, relayKeyFingerprint: () => sha('emk-synthetic') });
  const grant = { ownerId: 'synthetic-owner', userSlug: 'syntheticowner', runId: 'run-1',
    appSlug: 'synthetic-app', sourceHead: 'f'.repeat(40), issuerExpiresAt: '2099-01-01T00:00:00Z' };
  make().issue(grant, first);
  const ledger = join(root, 'authority', 'run-1.json.sessions');
  const sealPath = join(root, 'authority', 'run-1.json');
  // A→B retires A: the seal now itself proves a retired generation exists.
  writeFileSync(sessionPath, JSON.stringify({ ...first, sessionToken: 'aps_second' }), { mode: 0o600 });
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)?.memberId).toBe(grant.ownerId);
  const sealed = readFileSync(sealPath, 'utf8');
  // The sidecar is lost: the seal's own previousSessionHash proves history
  // exists, so the absent ledger is an unverifiable history — never an empty
  // one. Neither a new session nor the retired A launders back in.
  rmSync(ledger);
  writeFileSync(sessionPath, JSON.stringify({ ...first, sessionToken: 'aps_third' }), { mode: 0o600 });
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)).toBeNull();
  writeFileSync(sessionPath, JSON.stringify(first), { mode: 0o600 });
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)).toBeNull();
  expect(readFileSync(sealPath, 'utf8')).toBe(sealed);
  // A restart keeps the refusal while the sidecar stays absent.
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)).toBeNull();
  expect(readFileSync(sealPath, 'utf8')).toBe(sealed);
  // The ledger returns with the retired generation: the rebind proceeds again.
  writeFileSync(ledger, sha('https://api.elanous.ai\0synthetic-app\0aps_first') + '\n', { mode: 0o600 });
  writeFileSync(sessionPath, JSON.stringify({ ...first, sessionToken: 'aps_third' }), { mode: 0o600 });
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)?.memberId).toBe(grant.ownerId);
});

test('a failed retirement append refuses the rebinding and leaves the seal unchanged', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-build-authority-'))); roots.push(root);
  const sessionPath = join(root, 'member-session.json');
  const first = { nexusUrl: 'https://api.elanous.ai', appSlug: 'synthetic-app', sessionToken: 'aps_first' };
  writeFileSync(sessionPath, JSON.stringify(first), { mode: 0o600 });
  const read = () => {
    try { return JSON.parse(readFileSync(sessionPath, 'utf8')) as typeof first; } catch { return undefined; }
  };
  const make = () => createAppBuildRunAuthority({ root: join(root, 'authority'), hostKey: 'f'.repeat(64),
    retainedSession: read, relayKeyFingerprint: () => sha('emk-synthetic') });
  const grant = { ownerId: 'synthetic-owner', userSlug: 'syntheticowner', runId: 'run-1',
    appSlug: 'synthetic-app', sourceHead: 'f'.repeat(40), issuerExpiresAt: '2099-01-01T00:00:00Z' };
  make().issue(grant, first);
  const ledger = join(root, 'authority', 'run-1.json.sessions');
  const sealPath = join(root, 'authority', 'run-1.json');
  // A→B: the first retirement lands in the ledger.
  writeFileSync(sessionPath, JSON.stringify({ ...first, sessionToken: 'aps_second' }), { mode: 0o600 });
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)?.memberId).toBe(grant.ownerId);
  expect(readFileSync(ledger, 'utf8')).toBe(sha('https://api.elanous.ai\0synthetic-app\0aps_first') + '\n');
  const sealed = readFileSync(sealPath, 'utf8');
  // B→C against a read-only ledger: the append fails, the rebind is refused,
  // and the seal keeps B — the unpersisted retirement never launders forward.
  chmodSync(ledger, 0o400);
  writeFileSync(sessionPath, JSON.stringify({ ...first, sessionToken: 'aps_third' }), { mode: 0o600 });
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)).toBeNull();
  expect(readFileSync(sealPath, 'utf8')).toBe(sealed);
  // A restart keeps the refusal while persistence stays broken.
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)).toBeNull();
  expect(readFileSync(sealPath, 'utf8')).toBe(sealed);
  // Persistence restored: C binds, and A and B stay refused afterwards.
  chmodSync(ledger, 0o600);
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)?.memberId).toBe(grant.ownerId);
  expect(readFileSync(ledger, 'utf8')).toContain(sha('https://api.elanous.ai\0synthetic-app\0aps_second'));
  writeFileSync(sessionPath, JSON.stringify(first), { mode: 0o600 });
  expect(make().resolve(grant.runId, grant.appSlug, grant.sourceHead)).toBeNull();
  expect(readFileSync(join(root, 'authority', 'run-1.json.revoked'), 'utf8')).toBe('revoked\n');
});

test('a base-issued 11-field v1 seal keeps resolving after the upgrade', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-build-authority-'))); roots.push(root);
  const first = { nexusUrl: 'https://api.elanous.ai', appSlug: 'synthetic-app', sessionToken: 'aps_first' };
  const grant = { ownerId: 'synthetic-owner', userSlug: 'syntheticowner', runId: 'run-1',
    appSlug: 'synthetic-app', sourceHead: 'f'.repeat(40), issuerExpiresAt: '2099-01-01T00:00:00Z' };
  const opts = { root: join(root, 'authority'), hostKey: 'a'.repeat(64),
    retainedSession: () => first, relayKeyFingerprint: () => sha('emk-synthetic') };
  createAppBuildRunAuthority(opts).issue(grant, first);
  // Downgrade to the exact bytes a base binary would have stored: the 11-field
  // v1 shape, signed over the base payload (no previousSessionHash key at all).
  const sealPath = join(root, 'authority', 'run-1.json');
  const issued = JSON.parse(readFileSync(sealPath, 'utf8')) as Record<string, unknown>;
  const { previousSessionHash: _retired, ...baseSeal } = issued;
  baseSeal.signature = createHmac('sha256', 'a'.repeat(64))
    .update('elanous-app-build-run-authority-v1\0')
    .update(JSON.stringify({ version: baseSeal.version, ownerId: baseSeal.ownerId,
      userSlug: baseSeal.userSlug, runId: baseSeal.runId, appSlug: baseSeal.appSlug,
      sourceHead: baseSeal.sourceHead, issuedAt: baseSeal.issuedAt, expiresAt: baseSeal.expiresAt,
      sessionHash: baseSeal.sessionHash, relayKeyHash: baseSeal.relayKeyHash })).digest('hex');
  writeFileSync(sealPath, JSON.stringify(baseSeal) + '\n', { mode: 0o600 });
  expect(createAppBuildRunAuthority(opts).resolve(grant.runId, grant.appSlug, grant.sourceHead))
    .toEqual({ memberId: grant.ownerId, userSlug: grant.userSlug });
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

test('server deployment credential stays private; session refresh, revocation and offline failure are bounded', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-deployment-grant-'))); roots.push(root);
  const path = join(root, 'grants');
  let sessionToken = 'aps_synthetic_first';
  let valid = true; let offline = false; let wrongOwner = false; let ambiguousAlias = false;
  let wrongApprovalId = false;
  let revokeStatus: number | null = null;
  const credential = 'dpg_' + 'x'.repeat(43);
  const input = { deploymentId: 'dyn-11111111-1111-4111-8111-111111111111',
    ownerId: 'owner-a', appSlug: 'synthetic-app', runId: 'run-a',
    sourceHead: 'a'.repeat(40), artifactDigest: 'b'.repeat(64), relayKeyId: 'key-a',
    approvalId: '14bcb6e5-1338-4253-a746-e520595d5604',
    expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const publicBinding = { ...input, grantId: 'grant-a', grantVersion: 1 };
  const { ownerId: _ownerId, ...serverBinding } = publicBinding;
  const requests: Array<{ method: string; url: string; authorization: string | null }> = [];
  const fetcher = (async (value: string | URL | Request, init?: RequestInit) => {
    if (offline) throw new Error('offline');
    const url = String(value); const headers = new Headers(init?.headers);
    requests.push({ method: init?.method ?? 'GET', url, authorization: headers.get('authorization') });
    if (url.endsWith('/introspect')) return valid
      ? Response.json({ ...serverBinding, memberId: wrongOwner ? 'foreign' : input.ownerId,
        ...(wrongApprovalId ? { approvalId: '8f195ad4-a4e2-4b31-a7bc-155602760279' } : {}),
        ...(ambiguousAlias ? { ownerId: input.ownerId } : {}) })
      : Response.json({ error: 'revoked' }, { status: 401 });
    if (init?.method === 'DELETE') {
      if (revokeStatus !== null) return Response.json({ error: 'revoke-not-confirmed' }, { status: revokeStatus });
      valid = false; return Response.json({ revoked: true });
    }
    return Response.json({ ...serverBinding, memberId: wrongOwner ? 'foreign' : input.ownerId, credential,
      ...(wrongApprovalId ? { approvalId: '8f195ad4-a4e2-4b31-a7bc-155602760279' } : {}),
      ...(ambiguousAlias ? { ownerId: input.ownerId } : {}) },
      { status: 201 });
  }) as typeof fetch;
  const provider = createAppDeploymentGrantProvider({ root: path, fetcher,
    getSession: () => ({ nexusUrl: 'https://api.elanous.ai', sessionToken, appSlug: input.appSlug }) });
  await expect(provider.issue({ ...input, approvalId: undefined })).rejects.toThrow('DEPLOYMENT_GRANT_REFUSED');
  expect(requests).toHaveLength(0);
  wrongOwner = true;
  await expect(provider.issue(input)).rejects.toThrow('DEPLOYMENT_GRANT_REFUSED');
  expect(requests.at(-1)?.method).toBe('DELETE');
  wrongOwner = false;
  ambiguousAlias = true;
  await expect(provider.issue(input)).rejects.toThrow('DEPLOYMENT_GRANT_REFUSED');
  expect(requests.at(-1)?.method).toBe('DELETE');
  ambiguousAlias = false;
  wrongApprovalId = true;
  await expect(provider.issue(input)).rejects.toThrow('DEPLOYMENT_GRANT_REFUSED');
  expect(requests.at(-1)?.method).toBe('DELETE');
  wrongApprovalId = false;
  valid = true;
  expect(await provider.issue(input)).toEqual(publicBinding);
  expect(statSync(join(path, 'grant-a.json')).mode & 0o077).toBe(0);
  expect(readFileSync(join(path, 'grant-a.json'), 'utf8')).not.toContain(sessionToken);
  expect(requests[0]).toMatchObject({ method: 'POST', url: 'https://api.elanous.ai/v1/members/deployment-grants',
    authorization: 'Bearer aps_synthetic_first' });
  expect(await provider.introspect('grant-a')).toEqual(publicBinding);
  expect(requests.at(-1)?.authorization).toBe('Bearer ' + credential);
  sessionToken = 'aps_synthetic_refreshed';
  expect(await provider.introspect('grant-a')).toEqual(publicBinding);
  wrongOwner = true;
  expect(await provider.introspect('grant-a')).toBeNull();
  wrongOwner = false; ambiguousAlias = true;
  expect(await provider.introspect('grant-a')).toBeNull();
  ambiguousAlias = false;
  wrongApprovalId = true;
  expect(await provider.introspect('grant-a')).toBeNull();
  wrongApprovalId = false; offline = true;
  expect(await provider.introspect('grant-a')).toBeNull();
  offline = false;
  await expect(provider.revoke('grant-a', { memberId: 'foreign', userSlug: 'other' })).rejects.toThrow();
  revokeStatus = 429;
  await expect(provider.revoke('grant-a', { memberId: input.ownerId, userSlug: 'owner-a' }))
    .rejects.toThrow('DEPLOYMENT_GRANT_REFUSED');
  revokeStatus = 403;
  await expect(provider.revoke('grant-a', { memberId: input.ownerId, userSlug: 'owner-a' }))
    .rejects.toThrow('DEPLOYMENT_GRANT_AUTH_REFUSED');
  revokeStatus = null;
  await provider.revoke('grant-a', { memberId: input.ownerId, userSlug: 'owner-a' });
  expect(requests.at(-1)?.authorization).toBe('Bearer aps_synthetic_refreshed');
  valid = true;
  expect(await provider.introspect('grant-a')).toBeNull();
});

test('a valid issued grant is revoked when private credential persistence fails', async () => {
  for (const revokeStatus of [200, 503]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-deployment-persist-fail-'))); roots.push(root);
    const grantRoot = join(root, 'grants');
    mkdirSync(grantRoot, { mode: 0o700 });
    // A conflicting private path forces open(wx) to fail after the server 201.
    mkdirSync(join(grantRoot, 'grant-a.json'), { mode: 0o700 });
    const input = { deploymentId: 'dyn-22222222-2222-4222-8222-222222222222',
      ownerId: 'owner-a', appSlug: 'synthetic-app', runId: 'run-a',
      sourceHead: 'a'.repeat(40), artifactDigest: 'b'.repeat(64), relayKeyId: 'key-a',
      approvalId: '14bcb6e5-1338-4253-a746-e520595d5604',
      expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const requests: string[] = [];
    const provider = createAppDeploymentGrantProvider({ root: grantRoot,
      getSession: () => ({ nexusUrl: 'https://api.elanous.ai', sessionToken: 'aps_synthetic', appSlug: input.appSlug }),
      fetcher: (async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(init?.method ?? 'GET');
        if (init?.method === 'DELETE') return Response.json(revokeStatus === 200
          ? { revoked: true } : { error: 'synthetic-cleanup-unavailable' }, { status: revokeStatus });
        const { ownerId, ...binding } = { ...input, grantId: 'grant-a', grantVersion: 1 };
        return Response.json({ ...binding, memberId: ownerId, credential: 'dpg_' + 'x'.repeat(43) }, { status: 201 });
      }) as typeof fetch });
    const error = await provider.issue(input).then(() => undefined, failure => failure);
    expect(error).toBeInstanceOf(Error);
    if (revokeStatus === 503) expect((error as AggregateError).errors).toHaveLength(2);
    else expect((error as Error).message).toBe('DEPLOYMENT_GRANT_REFUSED');
    expect(requests).toEqual(['POST', 'DELETE']);
  }
});

test('lost one-time deployment credential is not recovered through an active-grant 409 retry', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-deployment-grant-'))); roots.push(root);
  const provider = createAppDeploymentGrantProvider({ root: join(root, 'grants'),
    getSession: () => ({ nexusUrl: 'https://api.elanous.ai', sessionToken: 'aps_synthetic', appSlug: 'synthetic-app' }),
    fetcher: (async () => Response.json({ error: 'credential-already-issued', grantId: 'grant-a', grantVersion: 1 },
      { status: 409 })) as unknown as typeof fetch });
  await expect(provider.issue({ deploymentId: 'dyn-22222222-2222-4222-8222-222222222222',
    ownerId: 'owner-a', appSlug: 'synthetic-app', runId: 'run-a',
    sourceHead: 'a'.repeat(40), artifactDigest: 'b'.repeat(64), relayKeyId: 'key-a',
    approvalId: '14bcb6e5-1338-4253-a746-e520595d5604',
    expiresAt: new Date(Date.now() + 60_000).toISOString() })).rejects.toThrow('DEPLOYMENT_GRANT_REFUSED');
  expect(await provider.introspect('grant-a')).toBeNull();
});
