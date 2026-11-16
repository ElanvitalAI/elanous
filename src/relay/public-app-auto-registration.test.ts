import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, realpathSync, fsyncSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { generateDaemonKeyPair, serverIdFromPublicKey } from './channel.js';
import { connectRelayHost } from './host-connector.js';
import { createRelayAutoAppRegistrar, loadAutoPublicAppRegistrations, loadRelayPublicPolicySnapshot,
  createRelayPublicPolicyReloader, validatedRelayPublicPolicySnapshot } from './public-app-auto-registration.js';
import { startRelayServer } from './relay-server.js';

const serverId = 'a'.repeat(64);
const key = Buffer.alloc(32, 1).toString('base64url');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'relay-auto-policy-')); roots.push(root);
  const files = { trustedHostKeys: join(root, 'keys.json'), hostOwnerMembers: join(root, 'owners.json'),
    publicDispatch: join(root, 'routes.json'), publicRead: join(root, 'read.json') };
  const put = (path: string, value: unknown) => { writeFileSync(path, JSON.stringify(value)); chmodSync(path, 0o600); };
  put(files.trustedHostKeys, { [serverId]: key });
  put(files.hostOwnerMembers, { [serverId]: 'owner-1' });
  put(files.publicDispatch, { routes: [{ user: 'alice', serverId, ownerMemberId: 'owner-1' }] });
  put(files.publicRead, { apps: [{ user: 'alice', app: 'tickets' }] });
  return { files, put };
}

describe('complete relay policy reload', () => {
  test('bad intermediate files keep the prior route, then a complete new snapshot swaps it', async () => {
    const { files, put } = fixture();
    const initial = loadRelayPublicPolicySnapshot(files, 'elanous.app');
    const relay = startRelayServer({ port: 0, hostname: '127.0.0.1', publicDomain: 'elanous.app',
      memberRequired: true, validateMemberToken: async () => null, ...initial });
    const get = async (user: string) => (await fetch(`http://127.0.0.1:${relay.port}/`,
      { headers: { host: `tickets--${user}.elanous.app` } })).status;
    try {
      expect(await get('alice')).toBe(503);
      expect(await get('bobby')).toBe(404);
      put(files.publicDispatch, { routes: [{ user: 'bobby', serverId, ownerMemberId: 'owner-1' }] });
      expect(() => loadRelayPublicPolicySnapshot(files, 'elanous.app')).toThrow();
      expect(await get('alice')).toBe(503);
      put(files.publicRead, { apps: [{ user: 'bobby', app: 'tickets' }] });
      relay.reloadPublicPolicySnapshot(loadRelayPublicPolicySnapshot(files, 'elanous.app'));
      expect(await get('alice')).toBe(404);
      expect(await get('bobby')).toBe(503);
      expect(() => relay.reloadPublicPolicySnapshot(validatedRelayPublicPolicySnapshot({
        ...initial, hostOwnerMemberIds: new Map([[serverId, 'owner-2']]),
      }, 'elanous.app'))).toThrow();
      expect(await get('bobby')).toBe(503);
    } finally { relay.stop(); }
  });

  test('private file symlink and owner-mode drift refuse before touching a live snapshot', () => {
    const { files } = fixture();
    chmodSync(files.publicRead, 0o644);
    expect(() => loadRelayPublicPolicySnapshot(files, 'elanous.app')).toThrow();
  });

  test('existing owner and pinned handle register GET, reject foreign authority, and undo exact grant', async () => {
    const { files } = fixture();
    const autoRegistrations = join(realpathSync(roots[roots.length - 1]!), 'auto-apps.json');
    const initial = loadRelayPublicPolicySnapshot(files, 'elanous.app');
    const relay = startRelayServer({ port: 0, hostname: '127.0.0.1', publicDomain: 'elanous.app',
      memberRequired: true, validateMemberToken: async () => null, ...initial });
    const registrar = createRelayAutoAppRegistrar({ file: autoRegistrations, domain: 'elanous.app',
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, 'elanous.app'),
      apply: candidate => relay.reloadPublicPolicySnapshot(candidate) });
    const registration = { ownerId: 'owner-1', serverId, user: 'alice', app: 'booking',
      deploymentId: 'dyn-12345678-1234-4123-8123-123456789abc', grantId: 'grant-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const request = (method: string) => fetch(`http://127.0.0.1:${relay.port}/reserve`,
      { method, headers: { host: 'booking--alice.elanous.app' } });
    try {
      expect((await request('GET')).status).toBe(401);
      expect(() => registrar.register(serverId, 'foreign-owner', registration)).toThrow();
      expect(() => registrar.register('b'.repeat(64), 'owner-1', registration)).toThrow();
      expect(() => registrar.register(serverId, 'owner-1', { ...registration, user: 'bobby' })).toThrow();
      expect(() => registrar.register(serverId, 'owner-1', { ...registration,
        visitorWrite: { user: 'alice', app: 'booking' } } as never)).toThrow();
      expect((await request('GET')).status).toBe(401);
      registrar.register(serverId, 'owner-1', registration);
      expect((await request('GET')).status).toBe(503);
      expect((await request('POST')).status).toBe(401);
      expect(() => registrar.unregister(serverId, 'owner-1', { user: 'alice', app: 'booking',
        deploymentId: registration.deploymentId, grantId: 'wrong-grant' })).toThrow();
      expect((await request('GET')).status).toBe(503);
      registrar.unregister(serverId, 'owner-1', { user: 'alice', app: 'booking',
        deploymentId: registration.deploymentId, grantId: registration.grantId });
      expect((await request('GET')).status).toBe(401);
    } finally { relay.stop(); }
  });

  test('authenticated product host control registers its app and anonymous GET reaches the app', async () => {
    const { files, put } = fixture();
    const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(13));
    const actualServerId = serverIdFromPublicKey(daemonKeys.publicKey);
    const signingKeys = generateKeyPairSync('ed25519');
    const der = signingKeys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    const actualKey = der.subarray(-32).toString('base64url');
    put(files.trustedHostKeys, { [actualServerId]: actualKey });
    put(files.hostOwnerMembers, { [actualServerId]: 'owner-1' });
    put(files.publicDispatch, { routes: [{ user: 'alice', serverId: actualServerId, ownerMemberId: 'owner-1' }] });
    const autoRegistrations = join(realpathSync(roots[roots.length - 1]!), 'auto-apps.json');
    const initial = loadRelayPublicPolicySnapshot(files, 'elanous.app');
    let registrar: ReturnType<typeof createRelayAutoAppRegistrar>;
    const relay = startRelayServer({ port: 0, hostname: '127.0.0.1', publicDomain: 'elanous.app',
      memberRequired: true, validateMemberToken: async () => ({ memberId: 'owner-1' }), ...initial,
      autoAppRegistration: {
        register: (host, owner, input) => registrar.register(host, owner, input),
        unregister: (host, owner, input) => registrar.unregister(host, owner, input),
      } });
    registrar = createRelayAutoAppRegistrar({ file: autoRegistrations, domain: 'elanous.app',
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, 'elanous.app'),
      apply: candidate => relay.reloadPublicPolicySnapshot(candidate) });
    const host = await connectRelayHost({ relayUrl: `ws://127.0.0.1:${relay.port}/host`, daemonKeys,
      hostSigningKey: signingKeys.privateKey, getMemberToken: async () => 'emt_fake_test_member',
      handleRequest: async () => new Response('booking served', { status: 200 }) });
    const request = (method: string) => fetch(`http://127.0.0.1:${relay.port}/reserve`,
      { method, headers: { host: 'booking--alice.elanous.app' } });
    const registration = { ownerId: 'owner-1', user: 'alice', app: 'booking',
      deploymentId: 'dyn-12345678-1234-4123-8123-123456789abc', grantId: 'grant-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString() };
    try {
      expect((await request('GET')).status).toBe(401);
      await expect(host.registerPublicApp({ ...registration, ownerId: 'foreign' })).rejects.toThrow();
      expect((await request('GET')).status).toBe(401);
      await host.registerPublicApp(registration);
      const response = await request('GET');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('booking served');
      expect((await request('POST')).status).toBe(401);
      await host.unregisterPublicApp({ user: 'alice', app: 'booking',
        deploymentId: registration.deploymentId, grantId: registration.grantId });
      expect((await request('GET')).status).toBe(401);
    } finally { host.close(); relay.stop(); }
  });

  test('grant expiry denies anonymous read even while a broken static file prevents reload', async () => {
    const { files } = fixture();
    const autoRegistrations = join(realpathSync(roots[roots.length - 1]!), 'auto-apps.json');
    const initial = loadRelayPublicPolicySnapshot(files, 'elanous.app');
    const relay = startRelayServer({ port: 0, hostname: '127.0.0.1', publicDomain: 'elanous.app',
      memberRequired: true, validateMemberToken: async () => null, ...initial });
    const registrar = createRelayAutoAppRegistrar({ file: autoRegistrations, domain: 'elanous.app',
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, 'elanous.app'),
      apply: candidate => relay.reloadPublicPolicySnapshot(candidate) });
    const request = () => fetch(`http://127.0.0.1:${relay.port}/`,
      { headers: { host: 'booking--alice.elanous.app' } });
    try {
      registrar.register(serverId, 'owner-1', { ownerId: 'owner-1', serverId, user: 'alice', app: 'booking',
        deploymentId: 'dyn-12345678-1234-4123-8123-123456789abc', grantId: 'grant-1',
        expiresAt: new Date(Date.now() + 40).toISOString() });
      expect((await request()).status).toBe(503);
      chmodSync(files.publicRead, 0o644);
      expect(() => loadRelayPublicPolicySnapshot({ ...files, autoRegistrations }, 'elanous.app')).toThrow();
      await new Promise(resolve => setTimeout(resolve, 60));
      expect((await request()).status).toBe(401);
    } finally { relay.stop(); }
  });

  test('automatic grant expiry does not override an existing static public read', async () => {
    const { files, put } = fixture();
    put(files.publicRead, { apps: [{ user: 'alice', app: 'tickets' }, { user: 'alice', app: 'booking' }] });
    const autoRegistrations = join(realpathSync(roots[roots.length - 1]!), 'auto-apps.json');
    const initial = loadRelayPublicPolicySnapshot(files, 'elanous.app');
    const relay = startRelayServer({ port: 0, hostname: '127.0.0.1', publicDomain: 'elanous.app',
      memberRequired: true, validateMemberToken: async () => null, ...initial });
    const registrar = createRelayAutoAppRegistrar({ file: autoRegistrations, domain: 'elanous.app',
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, 'elanous.app'),
      apply: candidate => relay.reloadPublicPolicySnapshot(candidate) });
    const get = () => fetch(`http://127.0.0.1:${relay.port}/`,
      { headers: { host: 'booking--alice.elanous.app' } });
    try {
      registrar.register(serverId, 'owner-1', { ownerId: 'owner-1', serverId, user: 'alice', app: 'booking',
        deploymentId: 'dyn-12345678-1234-4123-8123-123456789abc', grantId: 'grant-1',
        expiresAt: new Date(Date.now() + 40).toISOString() });
      expect((await get()).status).toBe(503);
      await new Promise(resolve => setTimeout(resolve, 60));
      expect((await get()).status).toBe(503);
    } finally { relay.stop(); }
  });

  test('exact grant removal closes anonymous GET while a static policy file is corrupt', async () => {
    const { files } = fixture();
    const autoRegistrations = join(realpathSync(roots[roots.length - 1]!), 'auto-apps.json');
    const initial = loadRelayPublicPolicySnapshot(files, 'elanous.app');
    const relay = startRelayServer({ port: 0, hostname: '127.0.0.1', publicDomain: 'elanous.app',
      memberRequired: true, validateMemberToken: async () => null, ...initial });
    const registrar = createRelayAutoAppRegistrar({ file: autoRegistrations, domain: 'elanous.app',
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, 'elanous.app'),
      apply: candidate => relay.reloadPublicPolicySnapshot(candidate) });
    const registration = { ownerId: 'owner-1', serverId, user: 'alice', app: 'booking',
      deploymentId: 'dyn-12345678-1234-4123-8123-123456789abc', grantId: 'grant-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const get = () => fetch(`http://127.0.0.1:${relay.port}/`,
      { headers: { host: 'booking--alice.elanous.app' } });
    try {
      registrar.register(serverId, 'owner-1', registration);
      expect((await get()).status).toBe(503);
      chmodSync(files.publicRead, 0o644);
      expect(() => registrar.register(serverId, 'owner-1', { ...registration, app: 'another' })).toThrow();
      registrar.unregister(serverId, 'owner-1', { user: 'alice', app: 'booking',
        deploymentId: registration.deploymentId, grantId: registration.grantId });
      expect((await get()).status).toBe(401);
      expect(loadAutoPublicAppRegistrations(autoRegistrations)).toEqual([]);
    } finally { relay.stop(); }
  });

  test('persistent post-rename sync failure blocks reload and restart; retirement closes live GET', async () => {
    const { files } = fixture();
    const autoRegistrations = join(realpathSync(roots[roots.length - 1]!), 'auto-apps.json');
    const initial = loadRelayPublicPolicySnapshot(files, 'elanous.app');
    const relay = startRelayServer({ port: 0, hostname: '127.0.0.1', publicDomain: 'elanous.app',
      memberRequired: true, validateMemberToken: async () => null, ...initial });
    let fault = false; let syncCount = 0;
    const registrar = createRelayAutoAppRegistrar({ file: autoRegistrations, domain: 'elanous.app',
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, 'elanous.app'),
      apply: candidate => relay.reloadPublicPolicySnapshot(candidate),
      syncDirectory: fd => {
        if (fault && ++syncCount >= 2) throw new Error('synthetic directory sync failure');
        fsyncSync(fd);
      } });
    const registration = { ownerId: 'owner-1', serverId, user: 'alice', app: 'booking',
      deploymentId: 'dyn-12345678-1234-4123-8123-123456789abc', grantId: 'grant-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const get = () => fetch(`http://127.0.0.1:${relay.port}/`,
      { headers: { host: 'booking--alice.elanous.app' } });
    try {
      registrar.register(serverId, 'owner-1', registration);
      expect((await get()).status).toBe(503);
      fault = true; syncCount = 0;
      expect(() => registrar.unregister(serverId, 'owner-1', { user: 'alice', app: 'booking',
        deploymentId: registration.deploymentId, grantId: registration.grantId })).toThrow();
      expect(existsSync(autoRegistrations + '.pending')).toBe(true);
      expect(() => loadRelayPublicPolicySnapshot({ ...files, autoRegistrations }, 'elanous.app')).toThrow();
      expect((await get()).status).toBe(401);
      expect(() => registrar.unregister(serverId, 'owner-1', { user: 'alice', app: 'booking',
        deploymentId: registration.deploymentId, grantId: registration.grantId }))
        .toThrow('synthetic directory sync failure');
      expect(existsSync(autoRegistrations + '.pending')).toBe(true);
      expect((await get()).status).toBe(401);
      fault = false;
      registrar.unregister(serverId, 'owner-1', { user: 'alice', app: 'booking',
        deploymentId: registration.deploymentId, grantId: registration.grantId });
      expect(existsSync(autoRegistrations + '.pending')).toBe(false);
      expect(loadAutoPublicAppRegistrations(autoRegistrations)).toEqual([]);
      relay.reloadPublicPolicySnapshot(loadRelayPublicPolicySnapshot({ ...files, autoRegistrations }, 'elanous.app'));
      expect((await get()).status).toBe(401);
    } finally { relay.stop(); }
  });

  test('post-rename registration sync failure never opens an unacknowledged GET', async () => {
    const { files } = fixture();
    const autoRegistrations = join(realpathSync(roots[roots.length - 1]!), 'auto-apps.json');
    const initial = loadRelayPublicPolicySnapshot(files, 'elanous.app');
    const relay = startRelayServer({ port: 0, hostname: '127.0.0.1', publicDomain: 'elanous.app',
      memberRequired: true, validateMemberToken: async () => null, ...initial });
    let syncCount = 0; let fault = true;
    const registrar = createRelayAutoAppRegistrar({ file: autoRegistrations, domain: 'elanous.app',
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, 'elanous.app'),
      apply: candidate => relay.reloadPublicPolicySnapshot(candidate),
      syncDirectory: fd => {
        if (fault && ++syncCount >= 2) throw new Error('synthetic directory sync failure');
        fsyncSync(fd);
      } });
    try {
      expect(() => registrar.register(serverId, 'owner-1', { ownerId: 'owner-1', serverId,
        user: 'alice', app: 'booking', deploymentId: 'dyn-12345678-1234-4123-8123-123456789abc',
        grantId: 'grant-1', expiresAt: new Date(Date.now() + 60_000).toISOString() })).toThrow();
      expect(existsSync(autoRegistrations + '.pending')).toBe(true);
      expect(() => loadRelayPublicPolicySnapshot({ ...files, autoRegistrations }, 'elanous.app')).toThrow();
      expect((await fetch(`http://127.0.0.1:${relay.port}/`,
        { headers: { host: 'booking--alice.elanous.app' } })).status).toBe(401);
      // A separate process runs the same startup loader after the fault clears.
      fault = false;
      const startup = Bun.spawn([process.execPath, '-e', `
        import { ensureRelayAutoRegistrationFile, loadRelayPublicPolicySnapshot } from
          ${JSON.stringify(new URL('./public-app-auto-registration.ts', import.meta.url).href)};
        const path = ${JSON.stringify(autoRegistrations)};
        const files = ${JSON.stringify({ ...files, autoRegistrations })};
        ensureRelayAutoRegistrationFile(path);
        const policy = loadRelayPublicPolicySnapshot(files, 'elanous.app');
        if (policy.publicReadableApps.has('alice/booking')) process.exit(2);
      `], { stdout: 'pipe', stderr: 'pipe' });
      expect(await startup.exited).toBe(0);
      expect(existsSync(autoRegistrations + '.pending')).toBe(false);
      expect(loadAutoPublicAppRegistrations(autoRegistrations)).toEqual([]);
      const restarted = loadRelayPublicPolicySnapshot({ ...files, autoRegistrations }, 'elanous.app');
      relay.reloadPublicPolicySnapshot(restarted);
      expect((await fetch(`http://127.0.0.1:${relay.port}/`,
        { headers: { host: 'booking--alice.elanous.app' } })).status).toBe(401);
    } finally { relay.stop(); }
  });

  test('registrar apply updates timer fingerprint before a file reverts to its prior policy', async () => {
    const { files, put } = fixture();
    const autoRegistrations = join(realpathSync(roots[roots.length - 1]!), 'auto-apps.json');
    const initial = loadRelayPublicPolicySnapshot(files, 'elanous.app');
    const relay = startRelayServer({ port: 0, hostname: '127.0.0.1', publicDomain: 'elanous.app',
      memberRequired: true, validateMemberToken: async () => null, ...initial });
    const allFiles = { ...files, autoRegistrations };
    // The same reloader methods are used by relay-cli registrar.apply and its timer.
    const reloader = createRelayPublicPolicyReloader(initial,
      () => loadRelayPublicPolicySnapshot(allFiles, 'elanous.app'),
      candidate => relay.reloadPublicPolicySnapshot(candidate));
    const registrar = createRelayAutoAppRegistrar({ file: autoRegistrations, domain: 'elanous.app',
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, 'elanous.app'), apply: reloader.apply });
    const get = () => fetch(`http://127.0.0.1:${relay.port}/`,
      { headers: { host: 'booking--alice.elanous.app' } });
    try {
      registrar.register(serverId, 'owner-1', { ownerId: 'owner-1', serverId, user: 'alice', app: 'booking',
        deploymentId: 'dyn-12345678-1234-4123-8123-123456789abc', grantId: 'grant-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect((await get()).status).toBe(503);
      put(autoRegistrations, { apps: [] });
      expect(reloader.refresh()).toBe(true);
      expect((await get()).status).toBe(401);
      expect(reloader.refresh()).toBe(false);
    } finally { relay.stop(); }
  });

  test('removing the pinned handle retires its app registration before a later pin can reuse it', async () => {
    const { files, put } = fixture();
    const autoRegistrations = join(realpathSync(roots[roots.length - 1]!), 'auto-apps.json');
    const initial = loadRelayPublicPolicySnapshot(files, 'elanous.app');
    const relay = startRelayServer({ port: 0, hostname: '127.0.0.1', publicDomain: 'elanous.app',
      memberRequired: true, validateMemberToken: async () => null, ...initial });
    const registrar = createRelayAutoAppRegistrar({ file: autoRegistrations, domain: 'elanous.app',
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, 'elanous.app'),
      apply: candidate => relay.reloadPublicPolicySnapshot(candidate) });
    const request = () => fetch(`http://127.0.0.1:${relay.port}/`,
      { headers: { host: 'booking--alice.elanous.app' } });
    try {
      registrar.register(serverId, 'owner-1', { ownerId: 'owner-1', serverId, user: 'alice', app: 'booking',
        deploymentId: 'dyn-12345678-1234-4123-8123-123456789abc', grantId: 'grant-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect((await request()).status).toBe(503);
      put(files.publicDispatch, { routes: [{ user: 'bobby', serverId, ownerMemberId: 'owner-1' }] });
      put(files.publicRead, { apps: [{ user: 'bobby', app: 'tickets' }] });
      registrar.sweepExpired();
      expect(loadAutoPublicAppRegistrations(autoRegistrations)).toEqual([]);
      expect((await request()).status).toBe(404);
      put(files.publicDispatch, { routes: [{ user: 'alice', serverId, ownerMemberId: 'owner-1' }] });
      put(files.publicRead, { apps: [{ user: 'alice', app: 'tickets' }] });
      relay.reloadPublicPolicySnapshot(loadRelayPublicPolicySnapshot({ ...files, autoRegistrations }, 'elanous.app'));
      expect((await request()).status).toBe(401);
    } finally { relay.stop(); }
  });

  test('completed owner rotation revokes an old auto app instead of retaining the old snapshot', async () => {
    const { files, put } = fixture();
    const autoRegistrations = join(realpathSync(roots[roots.length - 1]!), 'auto-apps.json');
    const initial = loadRelayPublicPolicySnapshot(files, 'elanous.app');
    const relay = startRelayServer({ port: 0, hostname: '127.0.0.1', publicDomain: 'elanous.app',
      memberRequired: true, validateMemberToken: async () => null, ...initial });
    const registrar = createRelayAutoAppRegistrar({ file: autoRegistrations, domain: 'elanous.app',
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, 'elanous.app'),
      apply: candidate => relay.reloadPublicPolicySnapshot(candidate) });
    const request = () => fetch(`http://127.0.0.1:${relay.port}/`,
      { headers: { host: 'booking--alice.elanous.app' } });
    try {
      const registration = { ownerId: 'owner-1', serverId, user: 'alice', app: 'booking',
        deploymentId: 'dyn-12345678-1234-4123-8123-123456789abc', grantId: 'grant-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString() };
      registrar.register(serverId, 'owner-1', registration);
      expect((await request()).status).toBe(503);
      put(files.hostOwnerMembers, { [serverId]: 'owner-2' });
      put(files.publicDispatch, { routes: [{ user: 'alice', serverId, ownerMemberId: 'owner-2' }] });
      registrar.sweepExpired();
      expect(loadAutoPublicAppRegistrations(autoRegistrations)).toEqual([]);
      expect((await request()).status).toBe(401);
      expect(() => registrar.register(serverId, 'owner-1', registration)).toThrow();
    } finally { relay.stop(); }
  });

  test('owner rotation plus post-rename sync failure withdraws live GET and recovers the exact retirement', async () => {
    const { files, put } = fixture();
    const autoRegistrations = join(realpathSync(roots[roots.length - 1]!), 'auto-apps.json');
    const initial = loadRelayPublicPolicySnapshot(files, 'elanous.app');
    const relay = startRelayServer({ port: 0, hostname: '127.0.0.1', publicDomain: 'elanous.app',
      memberRequired: true, validateMemberToken: async () => null, ...initial });
    let fault = false; let syncCount = 0;
    const registrar = createRelayAutoAppRegistrar({ file: autoRegistrations, domain: 'elanous.app',
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, 'elanous.app'),
      apply: candidate => relay.reloadPublicPolicySnapshot(candidate),
      syncDirectory: fd => {
        if (fault && ++syncCount >= 2) throw new Error('synthetic directory sync failure');
        fsyncSync(fd);
      } });
    const request = () => fetch(`http://127.0.0.1:${relay.port}/`,
      { headers: { host: 'booking--alice.elanous.app' } });
    try {
      registrar.register(serverId, 'owner-1', { ownerId: 'owner-1', serverId, user: 'alice', app: 'booking',
        deploymentId: 'dyn-12345678-1234-4123-8123-123456789abc', grantId: 'grant-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect((await request()).status).toBe(503);
      put(files.hostOwnerMembers, { [serverId]: 'owner-2' });
      put(files.publicDispatch, { routes: [{ user: 'alice', serverId, ownerMemberId: 'owner-2' }] });
      fault = true; syncCount = 0;
      expect(() => registrar.sweepExpired()).toThrow('synthetic directory sync failure');
      expect(existsSync(autoRegistrations + '.pending')).toBe(true);
      expect((await request()).status).toBe(401);
      expect(() => loadRelayPublicPolicySnapshot({ ...files, autoRegistrations }, 'elanous.app')).toThrow();
      fault = false;
      registrar.sweepExpired();
      expect(existsSync(autoRegistrations + '.pending')).toBe(false);
      expect(loadAutoPublicAppRegistrations(autoRegistrations)).toEqual([]);
      expect((await request()).status).toBe(401);
      relay.reloadPublicPolicySnapshot(loadRelayPublicPolicySnapshot({ ...files, autoRegistrations }, 'elanous.app'));
      expect((await request()).status).toBe(401);
    } finally { relay.stop(); }
  });

  test('removed handle pin plus post-rename sync failure cannot keep the former app reachable', async () => {
    const { files, put } = fixture();
    const autoRegistrations = join(realpathSync(roots[roots.length - 1]!), 'auto-apps.json');
    const initial = loadRelayPublicPolicySnapshot(files, 'elanous.app');
    const relay = startRelayServer({ port: 0, hostname: '127.0.0.1', publicDomain: 'elanous.app',
      memberRequired: true, validateMemberToken: async () => null, ...initial });
    let fault = false; let syncCount = 0;
    const registrar = createRelayAutoAppRegistrar({ file: autoRegistrations, domain: 'elanous.app',
      staticPolicy: () => loadRelayPublicPolicySnapshot(files, 'elanous.app'),
      apply: candidate => relay.reloadPublicPolicySnapshot(candidate),
      syncDirectory: fd => {
        if (fault && ++syncCount >= 2) throw new Error('synthetic directory sync failure');
        fsyncSync(fd);
      } });
    const request = () => fetch(`http://127.0.0.1:${relay.port}/`,
      { headers: { host: 'booking--alice.elanous.app' } });
    try {
      registrar.register(serverId, 'owner-1', { ownerId: 'owner-1', serverId, user: 'alice', app: 'booking',
        deploymentId: 'dyn-12345678-1234-4123-8123-123456789abc', grantId: 'grant-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect((await request()).status).toBe(503);
      put(files.publicDispatch, { routes: [{ user: 'bobby', serverId, ownerMemberId: 'owner-1' }] });
      put(files.publicRead, { apps: [{ user: 'bobby', app: 'tickets' }] });
      fault = true; syncCount = 0;
      expect(() => registrar.sweepExpired()).toThrow('synthetic directory sync failure');
      expect((await request()).status).toBe(404);
      expect(existsSync(autoRegistrations + '.pending')).toBe(true);
      fault = false;
      registrar.sweepExpired();
      expect(loadAutoPublicAppRegistrations(autoRegistrations)).toEqual([]);
      expect(existsSync(autoRegistrations + '.pending')).toBe(false);
      expect((await request()).status).toBe(404);
    } finally { relay.stop(); }
  });
});
