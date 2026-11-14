import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeRequest } from '../nexus/api/http-server.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';
import { loadNexusAppHost } from '../nexus/apps/app-host.js';
import { createMemberStore } from '../nexus/members/member-store.js';
import { generateDaemonKeyPair, serverIdFromPublicKey } from './channel.js';
import { connectRelayHost } from './host-connector.js';
import { createNexusRelayMemberVerifier } from './relay-member-verifier.js';
import { startRelayServer } from './relay-server.js';

test('public relay masks a foreign member like a missing app through routeRequest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-cross-member-404-'));
  const appsDir = join(root, 'apps');
  const appDir = join(appsDir, 'notes');
  mkdirSync(join(appDir, 'out'), { recursive: true });
  writeFileSync(join(appDir, 'app.yaml'), `apiVersion: elanous.app/v0
slug: notes
title: Member notes
frontend: { kind: static-export, out: out }
roles:
  owner: { via: nexus-session }
`);
  writeFileSync(join(appDir, 'out', 'index.html'), '<main>owner only</main>');
  const app = loadNexusAppHost(appsDir, undefined, {
    dir: join(root, 'auth'), key: 'relay-cross-member-fake-key-with-at-least-256-bits',
  }, 'owner');
  const members = createMemberStore({ path: ':memory:' });
  const register = (sub: string) => members.register({ sub, email: `${sub}@example.test`, emailVerified: true, name: sub },
    { consents: { privacy: 'v1', terms: 'v1' } });
  const owner = register('owner');
  const foreign = register('foreign');
  const daemonKeys = await generateDaemonKeyPair(new Uint8Array(32).fill(71));
  const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
  const signing = generateKeyPairSync('ed25519');
  const signingPublicKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const mint = (member: typeof owner) => members.mintMemberAccessToken(member.initialKey!.id, member.id,
    ['relay.connect'], 3600, serverId).token;
  const ownerToken = mint(owner);
  const foreignToken = mint(foreign);
  const memberForScope = (request: Request, scope: string, audience?: string) => members.memberForAccessToken(
    request.headers.get('authorization')?.slice(7) ?? '', scope, audience);
  const validateMemberToken = createNexusRelayMemberVerifier('https://hq.example.test/',
    (async (input: RequestInfo | URL, init?: RequestInit) => await routeRequest(new Request(input, init),
      { membersApi: { memberForScope } } as never, {} as never, null, createDevProxyRuntimeRef())
      ?? new Response('Not Found', { status: 404 })) as typeof fetch);
  const relay = startRelayServer({ trustedHostKeys: new Map([[serverId, signingPublicKey]]),
    memberRequired: true, hostOwnerMemberIds: new Map([[serverId, owner.id]]), validateMemberToken,
    publicDomain: 'elanous.app', publicServerId: serverId, publicUserId: 'owner' });
  let host: Awaited<ReturnType<typeof connectRelayHost>> | undefined;
  try {
    expect(app.issues).toEqual([]);
    host = await connectRelayHost({ relayUrl: `ws://127.0.0.1:${relay.port}/host`, daemonKeys,
      hostSigningKey: signing.privateKey, getMemberToken: async () => ownerToken,
      handleRequest: request => routeRequest(request, { appHost: app.appHost } as never,
        {} as never, null, createDevProxyRuntimeRef()),
    });
    const session = app.appHost.issueOwnerSession('notes', owner.id);
    const request = (slug: string, token: string, cookie = session.sessionToken) => fetch(
      `http://127.0.0.1:${relay.port}/`, { headers: {
        host: `${slug}--owner.elanous.app`, authorization: `Bearer ${token}`,
        cookie: `__Host-app-session=${cookie}`,
      } });
    const own = await request('notes', ownerToken);
    const cross = await request('notes', foreignToken);
    const missing = await request('missing', ownerToken);
    const foreignMissing = await request('missing', foreignToken);
    const unknownMemberAddress = await fetch(`http://127.0.0.1:${relay.port}/`, {
      headers: { host: 'notes--unknown.elanous.app', authorization: `Bearer ${foreignToken}` },
    });
    expect(own.status).toBe(200);
    expect(await own.text()).toContain('owner only');
    expect(cross.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreignMissing.status).toBe(404);
    expect(unknownMemberAddress.status).toBe(404);
    const maskedBody = await cross.text();
    expect(maskedBody).toBe('Not Found');
    expect(await missing.text()).toBe(maskedBody);
    expect(await foreignMissing.text()).toBe(maskedBody);
    expect(await unknownMemberAddress.text()).toBe(maskedBody);
    expect(Object.fromEntries(cross.headers)).toEqual(Object.fromEntries(missing.headers));
    expect(Object.fromEntries(foreignMissing.headers)).toEqual(Object.fromEntries(missing.headers));
    expect(Object.fromEntries(unknownMemberAddress.headers)).toEqual(Object.fromEntries(missing.headers));
    expect(cross.headers.has('x-nexus-app-host')).toBe(false);
    expect(cross.headers.has('x-nexus-app-origin')).toBe(false);
    expect((await request('notes', 'emt_invalid')).status).toBe(401);
  } finally {
    host?.close();
    relay.server.stop(true);
    members.close();
    app.appHost.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
