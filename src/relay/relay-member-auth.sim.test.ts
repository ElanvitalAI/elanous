import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { serverIdFromPublicKey } from './channel.js';
import { startRelayServer } from './relay-server.js';
import { createMemberStore } from '../nexus/members/member-store.js';
import { routeRequest } from '../nexus/api/http-server.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';
import { createNexusRelayMemberVerifier } from './relay-member-verifier.js';

test('relay member gate rejects missing, expired, revoked and foreign tokens while preserving the default', async () => {
  const signing = generateKeyPairSync('ed25519');
  const publicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const host = generateKeyPairSync('x25519');
  const serverId = serverIdFromPublicKey(new Uint8Array(host.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)));
  const trustedHostKeys = new Map([[serverId, publicKey]]);
  let now = Date.parse('2026-11-10T00:00:00.000Z');
  const nexus = createMemberStore({ path: ':memory:', now: () => now });
  const register = (sub: string) => nexus.register({ sub, email: `${sub}@example.test`, emailVerified: true, name: sub },
    { consents: { privacy: 'v1', terms: 'v1' } });
  const owner = register('owner');
  const foreign = register('foreign');
  // Source: #36200 defaults member tokens to one hour; expiry is overridden below.
  const mint = (member: typeof owner, ttlSec = 3600) => nexus.mintMemberAccessToken(member.initialKey!.id, member.id,
    ['relay.connect'], ttlSec, serverId).token;
  const valid = mint(owner);
  const alien = mint(foreign);
  const expired = mint(owner, 1);
  now += 1001;
  const introspect = (token: string, protocol: 'http' | 'https' = 'https') => routeRequest(
    new Request(`${protocol}://hq.ts.net/v1/tokens/introspect?audience=${serverId}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    }), { membersApi: { memberForScope: (request: Request, scope: string, audience?: string) =>
      nexus.memberForAccessToken(request.headers.get('authorization')?.slice(7) ?? '', scope, audience,
        new Date(now).toISOString()) } } as never,
    {} as never, null, createDevProxyRuntimeRef());
  const validateMemberToken = createNexusRelayMemberVerifier('https://hq.ts.net/',
    (async (input: RequestInfo | URL, init?: RequestInit) => await routeRequest(new Request(input, init),
      { membersApi: { memberForScope: (request: Request, scope: string, audience?: string) =>
        nexus.memberForAccessToken(request.headers.get('authorization')?.slice(7) ?? '', scope, audience,
          new Date(now).toISOString()) } } as never,
      {} as never, null, createDevProxyRuntimeRef()) ?? new Response(null, { status: 404 })) as typeof fetch);
  expect((await introspect(valid, 'http'))?.status).toBe(403);
  const legacy = startRelayServer({ trustedHostKeys });
  try {
    const response = await fetch(`http://127.0.0.1:${legacy.port}/client?serverId=${serverId}`);
    expect(response.status).toBe(426);
  } finally { legacy.stop(); }
  const owners = new Map([[serverId, owner.id]]);
  const relay = startRelayServer({ trustedHostKeys, memberRequired: true,
    hostOwnerMemberIds: owners, validateMemberToken });
  try {
    const request = (path: 'host' | 'client', token?: string) => fetch(`http://127.0.0.1:${relay.port}/${path}?serverId=${serverId}`,
      token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
    for (const path of ['host', 'client'] as const) {
      expect((await request(path)).status).toBe(401);
      expect((await request(path, expired)).status).toBe(401);
      expect((await request(path, alien)).status).toBe(401);
      expect((await request(path, valid)).status).toBe(426);
    }
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/host?serverId=${serverId}`, [valid]);
      ws.addEventListener('open', () => resolve(ws), { once: true });
      ws.addEventListener('error', () => reject(new Error('valid member handshake failed')), { once: true });
    });
    socket.close();
    const publicRelay = startRelayServer({ trustedHostKeys, memberRequired: true,
      hostOwnerMemberIds: new Map([[serverId, owner.id]]), validateMemberToken,
      publicDomain: 'elanous.app', publicServerId: serverId, publicUserId: 'owner' });
    try {
      const address = `http://127.0.0.1:${publicRelay.port}/`;
      expect((await fetch(address, { headers: { host: 'notes--owner.elanous.app' } })).status).toBe(401);
      expect((await fetch(address, { headers: { host: 'notes--owner.elanous.app', authorization: `Bearer ${valid}` } })).status).toBe(503);
    } finally { publicRelay.stop(); }
    nexus.revokeMemberKey(owner.id, owner.initialKey!.id);
    expect((await request('client', valid)).status).toBe(401);
    owners.delete(serverId);
    expect((await request('client', valid)).status).toBe(401);
  } finally { relay.stop(); nexus.close(); }
});
