import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDaemonKeyPair, serverIdFromPublicKey } from './channel.js';
import { connectRelayHost } from './host-connector.js';
import { loadPublicAppReadConfig } from './public-app-read.js';
import { startRelayServer } from './relay-server.js';

async function identity() {
  const signing = generateKeyPairSync('ed25519');
  const daemonKeys = await generateDaemonKeyPair();
  return { daemonKeys, signing, serverId: serverIdFromPublicKey(daemonKeys.publicKey),
    publicKey: signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') };
}

test('an authenticated connector serves only opted-in anonymous GET/HEAD; controls, private apps and writes stay gated', async () => {
  const id = await identity();
  const requests: string[] = [];
  const credentials: Array<Array<string | null>> = [];
  const charged: Array<{ memberId: string; direction: string; bytes: number }> = [];
  const usage = { ingressBytes: 0, egressBytes: 0 };
  let rejectTraffic = false;
  const relay = startRelayServer({ trustedHostKeys: new Map([[id.serverId, id.publicKey]]),
    memberRequired: true, hostOwnerMemberIds: new Map([[id.serverId, 'synthetic-owner']]),
    validateMemberToken: async (token, serverId) => token === 'emt_synthetic' && serverId === id.serverId ? { memberId: 'synthetic-owner' } : null,
    publicDomain: 'elanous.app', publicServerId: id.serverId, publicUserId: 'alice',
    publicReadableApps: new Set(['alice/tickets', 'alice/stopped']),
    trafficCap: { mode: 'measure-only' }, trafficStore: {
      read: () => ({ ...usage }),
      charge: event => {
        charged.push(event);
        if (rejectTraffic) return { status: 'limited', usage: { ...usage } };
        usage[event.direction === 'ingress' ? 'ingressBytes' : 'egressBytes'] += event.bytes;
        return { status: 'allowed', usage: { ...usage } };
      },
    },
    appKillSwitch: { isDown: (_user, app) => app === 'stopped', applyIncident: () => { throw new Error('unexpected report'); } } });
  const origin = `http://127.0.0.1:${relay.port}`;
  let connector: Awaited<ReturnType<typeof connectRelayHost>> | undefined;
  try {
    const get = (method = 'GET', app = 'tickets', path = '/', extra: Record<string, string> = {}) => fetch(origin + path,
      { method, headers: { host: `${app}--alice.elanous.app`, ...extra } });
    expect((await get())?.status).toBe(503); // No authenticated host yet; never synthesize success.
    connector = await connectRelayHost({ relayUrl: `ws://127.0.0.1:${relay.port}`, daemonKeys: id.daemonKeys,
      hostSigningKey: id.signing.privateKey, getMemberToken: () => 'emt_synthetic',
      handleRequest: request => { requests.push(request.method + ' ' + new URL(request.url).hostname);
        credentials.push(['authorization', 'cookie', 'sec-websocket-protocol'].map(name => request.headers.get(name)));
        return new Response(request.method === 'HEAD' ? null : '<main>synthetic ticket queue</main>', { status: 200 }); } });
    const response = await get(); expect(response.status).toBe(200);
    expect(await response.text()).toContain('synthetic ticket queue');
    const head = await get('HEAD'); expect(head.status).toBe(200); expect(await head.text()).toBe('');
    const synthetic = { authorization: 'Bearer emt_syntheticAudience', cookie: 'synthetic_session=not-real',
      'sec-websocket-protocol': 'emt_syntheticProtocol, synthetic-app-protocol' };
    for (const method of ['GET', 'HEAD']) expect((await get(method, 'tickets', '/', synthetic)).status).toBe(200);
    expect(credentials).toEqual(Array.from({ length: requests.length }, () => [null, null, null]));
    expect((await get('GET', 'tickets', '/', { upgrade: 'websocket', connection: 'Upgrade' })).status).toBe(404);
    expect((await get('GET', 'private'))?.status).toBe(401);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) expect((await get(method)).status).toBe(401);
    expect((await get('GET', 'tickets', '/host'))?.status).toBe(401);
    expect((await get('GET', 'tickets', '/client'))?.status).toBe(401);
    expect((await get('GET', 'tickets', '/host?serverId=' + id.serverId, { upgrade: 'websocket', connection: 'Upgrade' }))?.status).toBe(401);
    expect((await get('GET', 'stopped'))?.status).toBe(403);
    expect((await get('GET', 'tickets', '/.well-known/elanous/apps'))?.status).toBe(200);
    expect((await get('GET', 'tickets', '/.well-known/elanous/report'))?.status).toBe(403);
    expect(requests).toEqual(['GET tickets.app.localhost', 'HEAD tickets.app.localhost',
      'GET tickets.app.localhost', 'HEAD tickets.app.localhost']);
    expect(charged.every(event => event.memberId === 'synthetic-owner')).toBe(true);
    expect(charged.some(event => event.direction === 'ingress' && Boolean(event.bytes))).toBe(true);
    expect(charged.some(event => event.direction === 'egress' && Boolean(event.bytes))).toBe(true);
    expect(relay.stats(id.serverId).publicSlots).toBe(0);
    const forwardedBeforeDenial = requests.length;
    rejectTraffic = true;
    expect((await get()).status).toBe(429);
    expect(requests.length).toBe(forwardedBeforeDenial);
    expect(relay.stats(id.serverId).publicSlots).toBe(0);
    expect(relay.stats(id.serverId).host).toBe(true);
  } finally { connector?.close(); relay.stop(); }
});

test('read grants are tenant-scoped, checked against pinned dispatch, and private by default', async () => {
  const alice = await identity(); const bob = await identity();
  const options = { memberRequired: true, publicDomain: 'elanous.app' as const,
    trustedHostKeys: new Map([[alice.serverId, alice.publicKey], [bob.serverId, bob.publicKey]]),
    hostOwnerMemberIds: new Map([[alice.serverId, 'member-a'], [bob.serverId, 'member-b']]),
    validateMemberToken: async () => null,
    publicDispatchRoutes: new Map([['alice', { serverId: alice.serverId, ownerMemberId: 'member-a' }],
      ['bobby', { serverId: bob.serverId, ownerMemberId: 'member-b' }]]) };
  expect(() => startRelayServer({ ...options, publicReadableApps: new Set(['unknown/tickets']) })).toThrow('binding');
  expect(() => startRelayServer({ ...options, publicReadableApps: new Set(['alice/api']) })).toThrow('binding');
  const relay = startRelayServer({ ...options, publicReadableApps: new Set(['alice/tickets']) });
  const privateRelay = startRelayServer(options);
  try {
    const request = (port: number | undefined, user: string) => {
      if (port === undefined) throw new Error('relay listener did not bind');
      return fetch(`http://127.0.0.1:${port}/`, { headers: { host: `tickets--${user}.elanous.app` } });
    };
    expect((await request(relay.port, 'alice')).status).toBe(503);
    expect((await request(relay.port, 'bobby')).status).toBe(401);
    expect((await request(privateRelay.port, 'alice')).status).toBe(401);
  } finally { relay.stop(); privateRelay.stop(); }
});

test('read projection is exact and owner-only; malformed, duplicate and symlink files fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-public-read-'));
  try {
    const path = join(root, 'read.json');
    writeFileSync(path, JSON.stringify({ apps: [{ user: 'alice', app: 'tickets' }] }), { mode: 0o600 });
    expect([...loadPublicAppReadConfig(path)]).toEqual(['alice/tickets']);
    writeFileSync(path, JSON.stringify({ apps: [{ user: 'alice', app: 'tickets', ownerId: 'forged' }] }));
    expect(() => loadPublicAppReadConfig(path)).toThrow('invalid');
    writeFileSync(path, JSON.stringify({ apps: [{ user: 'alice', app: 'tickets' }, { user: 'alice', app: 'tickets' }] }));
    expect(() => loadPublicAppReadConfig(path)).toThrow('duplicate');
    chmodSync(path, 0o644); expect(() => loadPublicAppReadConfig(path)).toThrow('owner-only');
    const link = join(root, 'link'); symlinkSync(path, link); expect(() => loadPublicAppReadConfig(link)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
