import { afterEach, expect, test } from 'bun:test';
import { createMemberStore } from '../members/member-store.js';
import { createMembersApi } from '../members/members-api.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { startNexusHttpServer } from './http-server.js';

// The member app-name routes through the REAL Nexus HTTP server. Every `/v1/` path that is not on the public allowlist is default-denied
// (it then needs the Nexus bearer), so a handler that works when called directly is still dead in production without its allowlist entry.
const WEB = 'https://nexus.example.test';
const servers: Array<{ stop(): void }> = [];
const stores: ReturnType<typeof createMemberStore>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(); for (const store of stores.splice(0)) store.close(); });

test('a signed-in member reaches the app-name routes through the HTTP gate (no Nexus bearer), and strangers still do not', async () => {
  const store = createMemberStore({ path: ':memory:' });
  stores.push(store);
  store.provisionEventCode({ code: 'GATE1', maxUses: Number.MAX_SAFE_INTEGER, startsAt: '2026-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z' });
  const member = store.register({ sub: 'gate-member', email: 'gate@example.test', emailVerified: true, name: 'Gate' },
    { consents: { privacy: 'v1', terms: 'v1' }, eventCode: 'GATE1' });
  const cookie = `__Host-elanous_member_session=${store.createSession(member.id).token}`;
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const server = startNexusHttpServer({
    state, registry: new TabRegistry(state), eventBus,
    membersApi: createMembersApi({ store, google: { redirectUri: `${WEB}/v1/members/oauth/google/callback` } as never,
      successRedirectUri: `${WEB}/app/`, webOrigin: WEB }),
    metaApi: { bearerToken: 'operator-token', noAuth: false },
    startPort: 47_000 + Math.floor(Math.random() * 1_000),
  });
  servers.push(server);
  const call = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, init);
  // The member website is another origin than the API, so a browser sends cross-site: no same-origin exemption from the bearer gate.
  const member_ = { cookie, origin: WEB, 'sec-fetch-site': 'cross-site' };

  // The routes answer from the member API (a member answer, never the gate's «unauthorized» for a missing Nexus bearer).
  const check = await call('/v1/members/app-slot/name-check?name=ledger', { headers: member_ });
  expect(check.status).toBe(200);
  expect(await check.json()).toEqual({ available: true, appSlug: 'ledger' });
  const rename = await call('/v1/members/app-slot/name', { method: 'POST', headers: { ...member_, 'content-type': 'application/json' }, body: JSON.stringify({ appSlug: 'ledger' }) });
  // The member API itself may refuse (here: no lifecycle ledger → 503 rename-unavailable); what matters is that the request got that far.
  expect(rename.status).toBe(503);
  expect(await rename.json()).toMatchObject({ error: 'rename-unavailable' });

  // Without the member session the member API answers 401 itself — not by accepting the Nexus bearer path.
  // The member website's Origin is sent here too, so the 401 is about the missing session — not about a missing Origin.
  const stranger = await call('/v1/members/app-slot/name-check?name=ledger', { headers: { origin: WEB, 'sec-fetch-site': 'cross-site' } });
  expect(stranger.status).toBe(401);
  const strangerBearer = await call('/v1/members/app-slot/name', { method: 'POST', headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json', origin: WEB, 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ appSlug: 'ledger' }) });
  expect(strangerBearer.status).toBe(401);
  // A valid member cookie sent from a page that is NOT the member website is refused by the member API itself (the cookie alone is not enough).
  const foreign = { cookie, origin: 'https://evil.example.test', 'sec-fetch-site': 'cross-site' };
  const foreignRename = await call('/v1/members/app-slot/name', { method: 'POST', headers: { ...foreign, 'content-type': 'application/json' }, body: JSON.stringify({ appSlug: 'stolen-name' }) });
  expect(foreignRename.status).toBe(403);
  const foreignCheck = await call('/v1/members/app-slot/name-check?name=stolen-name', { headers: foreign });
  // A read from a foreign page may be answered, but never with CORS permission for that page to read it.
  expect(foreignCheck.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.test');
  expect(store.appSlotForMember(member.id)?.appSlug).toMatch(/^[a-f0-9]{24}$/);
  // And the allowlist is exact: other methods on these paths are not opened.
  const wrongMethod = await call('/v1/members/app-slot/name', { method: 'DELETE', headers: { ...member_, authorization: 'Bearer wrong' } });
  expect(wrongMethod.status).toBe(401);
});
