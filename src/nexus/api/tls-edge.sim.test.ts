import { expect, test } from 'bun:test';
import { createMemberStore } from '../members/member-store.js';
import { routeRequest } from './http-server.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { trustedTlsEdgeFromEnv } from './tls-edge.js';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('TLS edge proof loads only from an owner-only file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-tls-edge-'));
  const path = join(dir, 'edge-secret');
  // Source: #36294 uses a private TLS edge proof; this fixture matches its minimum entropy length.
  writeFileSync(path, 'test-only-edge-secret-0123456789abcdef', { mode: 0o600 });
  const env = { ELANOUS_NEXUS_TLS_EDGE_SECRET_FILE: path, ELANOUS_NEXUS_TLS_EDGE_ORIGIN: 'https://mbp.tailnet-example.ts.net:31415' };
  try {
    expect(trustedTlsEdgeFromEnv(env)?.origin).toBe(env.ELANOUS_NEXUS_TLS_EDGE_ORIGIN);
    chmodSync(path, 0o644);
    expect(() => trustedTlsEdgeFromEnv(env)).toThrow('owner-only');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('local HTTP TLS-edge hop authenticates relay introspection and rejects untrusted forwarding headers', async () => {
  const store = createMemberStore({ path: ':memory:' });
  const member = store.register({ sub: 'edge-member', email: 'edge@example.test', emailVerified: true, name: 'Edge' },
    { consents: { privacy: 'v1', terms: 'v1' } });
  const audience = 'a'.repeat(64);
  // Source: #36200 defaults access tokens to one hour.
  const token = store.mintMemberAccessToken(member.initialKey!.id, member.id, ['relay.connect'], 3600, audience).token;
  const edge = { origin: 'https://mbp.tailnet-example.ts.net:31415', secret: 'test-only-edge-secret-0123456789abcdef' };
  const backend = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: async (request, server) => await routeRequest(request, { trustedTlsEdge: edge,
      membersApi: { memberForScope: (candidate: Request, scope: string, bound?: string) =>
        store.memberForAccessToken(candidate.headers.get('authorization')?.slice(7) ?? '', scope, bound) } } as never,
      server as never, null, createDevProxyRuntimeRef()) ?? new Response(null, { status: 404 }) });
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => {
    const headers = new Headers(request.headers);
    for (const name of ['x-forwarded-proto', 'x-forwarded-host', 'x-elanous-tls-edge-secret']) headers.delete(name);
    headers.set('x-forwarded-proto', 'https');
    headers.set('x-forwarded-host', new URL(edge.origin).host);
    headers.set('x-elanous-tls-edge-secret', edge.secret);
    return fetch(`http://127.0.0.1:${backend.port}${new URL(request.url).pathname}${new URL(request.url).search}`,
      { method: request.method, headers });
  } });
  try {
    const path = `/v1/tokens/introspect?audience=${audience}`;
    const headers = { authorization: `Bearer ${token}` };
    const throughProxy = await fetch(`http://127.0.0.1:${proxy.port}${path}`, { method: 'POST', headers });
    expect(throughProxy.status).toBe(200);
    expect(await throughProxy.json()).toEqual({ memberId: member.id });
    const forged = await fetch(`http://127.0.0.1:${backend.port}${path}`, { method: 'POST',
      headers: { ...headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': new URL(edge.origin).host } });
    expect(forged.status).toBe(403);
    store.revokeMemberKey(member.id, member.initialKey!.id);
    expect((await fetch(`http://127.0.0.1:${proxy.port}${path}`, { method: 'POST', headers })).status).toBe(401);
  } finally { proxy.stop(true); backend.stop(true); store.close(); }
});
