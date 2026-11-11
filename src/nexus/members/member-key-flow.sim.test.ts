import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberStore } from './member-store.js';
import { createMemberTokenApi } from './member-token-api.js';
import { createMembersApi } from './members-api.js';
import { routeRequest } from '../api/http-server.js';
import { createDevProxyRuntimeRef } from '../api/admin-dev-proxy.js';
import type { HqLlmProxyDeps } from '../api/hq-llm-proxy.js';

test('fake signup exchanges a one-time member key for a scoped token and revokes both', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'member-key-sim-'));
  const path = join(dir, 'members.sqlite');
  let now = Date.parse('2026-11-09T00:00:00.000Z');
  const store = createMemberStore({ path, now: () => now });
  try {
    const member = store.register({ sub: 'sim-google', email: 'sim@example.test', emailVerified: true, name: 'Sim' },
      { consents: { privacy: 'v1', terms: 'v1' } });
    const first = member.initialKey!;
    expect(first.key.startsWith('emk_')).toBe(true);
    expect(store.memberForGoogleSub('sim-google')).not.toHaveProperty('initialKey');
    expect(store.listMemberKeys(member.id)).toMatchObject([{ id: first.id, name: 'signup' }]);
    const api = createMemberTokenApi({ store, now: () => now });
    let cancelled = false;
    const oversized = new Request('https://hq.ts.net/v1/tokens', { method: 'POST',
      headers: { authorization: `Bearer ${first.key}`, 'content-type': 'application/json' },
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(17_000)); },
        cancel() { cancelled = true; },
      }),
    });
    expect(oversized.headers.has('content-length')).toBe(false);
    expect((await api.handle(oversized)).status).toBe(400);
    expect(cancelled).toBe(true);
    const plainRemote = await routeRequest(new Request('http://100.100.1.1/v1/tokens', { method: 'POST',
      headers: { authorization: `Bearer ${first.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scopes: ['llm.proxy'] }),
    }), { membersApi: { handle: async () => undefined, handleToken: (request: Request) => api.handle(request) } } as never,
    { requestIP: () => ({ address: '100.100.1.2' }) } as never, null, createDevProxyRuntimeRef());
    expect(plainRemote?.status).toBe(403);
    const plainLoopback = await routeRequest(new Request('http://127.0.0.1/v1/tokens', { method: 'POST',
      headers: { authorization: `Bearer ${first.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scopes: ['relay.connect'] }),
    }), { membersApi: { handle: async () => undefined, handleToken: (request: Request) => api.handle(request) } } as never,
    { requestIP: () => ({ address: '127.0.0.1' }) } as never, null, createDevProxyRuntimeRef());
    expect(plainLoopback?.status).toBe(403);
    const mint = async (key: string, scopes: string[], ttlSec?: number): Promise<Response> => {
      const response = await routeRequest(new Request('https://100.100.1.1/v1/tokens', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scopes, ...(ttlSec === undefined ? {} : { ttlSec }), audience: '100.100.1.2' }),
      }), { membersApi: { handle: async () => undefined, handleToken: (request: Request) => api.handle(request) } } as never,
      { requestIP: () => ({ address: '100.100.1.2' }) } as never, null, createDevProxyRuntimeRef());
      if (!response) throw new Error('token route unmounted');
      return response;
    };
    expect((await mint(first.key, ['llm.proxy'])).status).toBe(403);
    expect((await mint(first.key, ['scraps.write'])).status).toBe(400);
    const relayMint = await mint(first.key, ['relay.connect']);
    expect(relayMint.status).toBe(201);
    const relayIssued = await relayMint.json() as { token: string; scopes: string[] };
    expect(relayIssued.scopes).toEqual(['relay.connect']);
    expect(store.memberForAccessToken(relayIssued.token, 'relay.connect', '100.100.1.2'))
      .toMatchObject({ memberId: member.id, keyId: first.id });
    expect(store.memberForAccessToken(relayIssued.token, 'llm.proxy', '100.100.1.2')).toBeNull();
    store.provisionPlan({ plan: 'sim-owner', entitlements: { 'llm.proxy': true } });
    store.assignPlan(member.id, 'sim-owner');
    expect((await api.handle(new Request('https://hq.ts.net/v1/tokens', { method: 'POST',
      headers: { authorization: `Bearer ${first.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scopes: ['llm.proxy'], audience: 'forged-host' }),
    }))).status).toBe(400);
    const response = await mint(first.key, ['llm.proxy']);
    expect(response.status).toBe(201);
    const issued = await response.json() as { token: string; memberId: string; scopes: string[]; expiresAt: string };
    expect(issued.token.startsWith('emt_')).toBe(true);
    expect(issued.memberId).toBe(member.id);
    expect(store.memberForAccessToken(issued.token, 'llm.proxy', '100.100.1.2')).toMatchObject({ memberId: member.id, keyId: first.id });
    expect(store.memberForAccessToken(issued.token, 'scraps.write', '100.100.1.2')).toBeNull();
    const proxyRequest = (token: string, protocol: 'http' | 'https') => new Request(`${protocol}://100.100.1.1/v1/llm/proxy`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ seat: 'R-PROXY', purpose: 'review', messages: [{ role: 'user', content: 'hello' }] }) });
    const ledger: unknown[] = [];
    const route = (peer: string, token = issued.token, protocol: 'http' | 'https' = 'https') => routeRequest(proxyRequest(token, protocol), { membersApi: {
      handle: async () => undefined, memberForScope: (request: Request, scope: string, audience?: string) => api.memberForScope(request, scope, audience),
    }, llmProxySimulation: {
      run: async () => ({ events: [{ type: 'text', delta: 'fake upstream' }], usage: { inputTokens: 5, outputTokens: 2 }, billing: 'subscription' }),
      record: (event: Parameters<HqLlmProxyDeps['record']>[0]) => ledger.push(event),
    } } as never, { requestIP: () => ({ address: peer }) } as never, null, createDevProxyRuntimeRef());
    const wrongPeer = await route('100.100.1.3');
    expect(wrongPeer?.status).toBe(401);
    expect((await route('100.100.1.2', issued.token, 'http'))?.status).toBe(403);
    const proxy = await route('100.100.1.2');
    expect(proxy?.status).toBe(200);
    expect((await proxy!.json() as { events: unknown[] }).events).toHaveLength(1);
    expect(ledger).toMatchObject([{ host: '100.100.1.2', purpose: 'review', costUsd: 0, costBasis: 'subscription' }]);
    store.assignPlan(member.id, 'free');
    expect((await route('100.100.1.2'))?.status).toBe(401);
    store.assignPlan(member.id, 'sim-owner');
    expect(readFileSync(path).includes(first.key)).toBe(false);
    expect(readFileSync(path).includes(issued.token)).toBe(false);
    const memberApi = createMembersApi({ store, google: {
      redirectUri: 'https://hq.ts.net/v1/members/oauth/google/callback',
    } as never, successRedirectUri: 'https://app.example.test/signup/complete', webOrigin: 'https://app.example.test', now: () => now });
    const manage = async (method: string, endpoint: string, body?: unknown): Promise<Response> => {
      const response = await routeRequest(new Request(`https://hq.ts.net${endpoint}`, {
        method, headers: { cookie: `__Host-elanous_member_session=${member.session.token}`, origin: 'https://app.example.test',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { membersApi: memberApi } as never, {} as never, null, createDevProxyRuntimeRef());
      if (!response) throw new Error('member key management route unmounted');
      return response;
    };
    expect((await manage('DELETE', `/v1/member/keys/${first.id}`)).status).toBe(200);
    expect((await mint(first.key, ['llm.proxy'])).status).toBe(401);
    expect(store.memberForAccessToken(issued.token, 'llm.proxy', '100.100.1.2')).toBeNull();
    expect((await route('100.100.1.2'))?.status).toBe(401);
    expect(store.listMemberKeys(member.id)).toEqual([]);
    expect(store.memberForSession(member.session.token)).not.toBeNull();
    const created = await manage('POST', '/v1/member/keys', { name: 'second' });
    expect(created.status).toBe(201);
    const second = await created.json() as { id: string; key: string };
    expect(() => store.rotateMemberKey(member.id, second.id, undefined, () => { throw new Error('disk full'); })).toThrow('disk full');
    expect(store.memberForKey(second.key)).toMatchObject({ keyId: second.id });
    const secondToken = await mint(second.key, ['llm.proxy']);
    expect(secondToken.status).toBe(201);
    const secondIssued = await secondToken.json() as { token: string };
    const old = second.key;
    const rotatedResponse = await manage('POST', `/v1/member/keys/${second.id}/rotate`);
    expect(rotatedResponse.status).toBe(201);
    const rotated = await rotatedResponse.json() as { id: string; key: string };
    expect((await mint(old, ['llm.proxy'])).status).toBe(401);
    expect(store.memberForAccessToken(secondIssued.token, 'llm.proxy', '100.100.1.2')).toBeNull();
    expect((await route('100.100.1.2', secondIssued.token))?.status).toBe(401);
    const rotatedMint = await mint(rotated.key, ['llm.proxy']);
    expect(rotatedMint.status).toBe(201);
    const rotatedIssued = await rotatedMint.json() as { token: string };
    expect((await route('100.100.1.2', rotatedIssued.token))?.status).toBe(200);
    const listed = await manage('GET', '/v1/member/keys');
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(listedText).not.toContain(rotated.key);
    expect(JSON.parse(listedText).keys).toMatchObject([{ id: rotated.id, name: 'second' }]);
    const wal = `${path}-wal`;
    for (const file of [path, ...(existsSync(wal) ? [wal] : [])]) {
      const stored = readFileSync(file);
      expect(stored.includes(first.key)).toBe(false);
      expect(stored.includes(second.key)).toBe(false);
      expect(stored.includes(rotated.key)).toBe(false);
      expect(stored.includes(secondIssued.token)).toBe(false);
    }
    const auditDb = new Database(path, { readonly: true });
    try {
      const events = auditDb.query('SELECT actor_member_id, key_id, action, at FROM member_key_events ORDER BY rowid').all();
      expect(events).toContainEqual({ actor_member_id: member.id, key_id: first.id, action: 'revoked', at: new Date(now).toISOString() });
      expect(events).toContainEqual({ actor_member_id: member.id, key_id: second.id, action: 'rotated-out', at: new Date(now).toISOString() });
      expect(JSON.stringify(events)).not.toContain(rotated.key);
    } finally { auditDb.close(); }
    now += 3_600_001;
    const newer = await mint(rotated.key, ['llm.proxy'], 1);
    expect(newer.status).toBe(201);
    const short = await newer.json() as { token: string };
    now += 1_001;
    expect(store.memberForAccessToken(short.token, 'llm.proxy', '100.100.1.2')).toBeNull();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
