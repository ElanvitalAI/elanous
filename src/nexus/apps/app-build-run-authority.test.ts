import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
