// OP 11-18 #85461: the member home is served by the API origin (api.elanous.ai/v1/members/home), and its «내 주소 두 가지»
// card names the app with same-origin POSTs. Those two writes accept the API's own origin as well as the website; every
// other write keeps the website origin only; a foreign origin is refused; a request without Origin keeps today's rule.
import { afterEach, expect, test } from 'bun:test';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';

const API = 'https://api.example.test';
const WEB = 'https://app.example.test';
const FOREIGN = 'https://evil.example.test';
const stores: ReturnType<typeof createMemberStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function world() {
  const store = createMemberStore({ path: ':memory:' });
  stores.push(store);
  store.provisionEventCode({ code: 'HOME1', maxUses: Number.MAX_SAFE_INTEGER, startsAt: '2026-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z' });
  const api = createMembersApi({ store, google: { redirectUri: `${API}/v1/members/oauth/google/callback` } as never,
    successRedirectUri: `${WEB}/members/`, webOrigin: WEB,
    appLifecycle: { ensureCreated: () => {}, events: () => [] } as never });
  /** withEventCode: the member gets the legacy slot at sign-up (the home then renames it with POST app-slot/name). */
  const member = (name: string, withEventCode = true) => {
    const m = store.register({ sub: name, email: `${name}@example.test`, emailVerified: true, name },
      { consents: { privacy: 'v1', terms: 'v1' }, ...(withEventCode ? { eventCode: 'HOME1' } : {}) });
    store.claimHandle(m.id, name);
    const cookie = `__Host-elanous_member_session=${store.createSession(m.id).token}`;
    const call = async (path: string, method: string, origin: string | null, body?: unknown) => {
      const response = await api.handle(new Request(`${API}${path}`, { method,
        headers: { cookie, ...(origin === null ? {} : { origin }), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
      return { status: response?.status ?? 0, json: await response?.json().catch(() => null) as Record<string, unknown> | null };
    };
    return { id: m.id, call };
  };
  return { store, member };
}

test('the home «이름 정하기» works from the API origin and from the website; a foreign origin is 403', async () => {
  const { store, member } = world();
  const fromApi = member('homeapi');
  // The member has its legacy slot; the home renames it (POST app-slot/name) — from the API origin.
  expect((await fromApi.call('/v1/members/app-slot/name', 'POST', API, { appSlug: 'notes' })).status).toBe(200);
  expect(store.appSlotForMember(fromApi.id)?.appSlug).toBe('notes');
  const fromWeb = member('homeweb');
  expect((await fromWeb.call('/v1/members/app-slot/name', 'POST', WEB, { appSlug: 'webshop' })).status).toBe(200);
  const fromForeign = member('homeevil');
  const before = store.appSlotForMember(fromForeign.id)?.appSlug;
  expect(await fromForeign.call('/v1/members/app-slot/name', 'POST', FOREIGN, { appSlug: 'stolen' })).toEqual({ status: 403, json: { error: 'origin-not-allowed' } });
  expect(store.appSlotForMember(fromForeign.id)?.appSlug).toBe(before);
});

test('POST app-slot from the API origin passes the origin check: a member without a slot gets the route\'s own answer', async () => {
  const { member } = world();
  // Without an event code there is no slot to rename; creating one is the route's own rule (event-code-required) —
  // the point here is that it is no longer «origin-not-allowed».
  const plain = member('noslot', false);
  expect(await plain.call('/v1/members/app-slot', 'POST', API, { appSlug: 'mine' })).toEqual({ status: 403, json: { error: 'event-code-required' } });
  expect(await plain.call('/v1/members/app-slot', 'POST', FOREIGN, { appSlug: 'mine' })).toEqual({ status: 403, json: { error: 'origin-not-allowed' } });
  // A member that already has a slot: 409 already-exists from the API origin (again the route, not the origin rule).
  const evented = member('hasslot');
  expect((await evented.call('/v1/members/app-slot', 'POST', API, { appSlug: 'again' })).json).toEqual({ error: 'app-slot-already-exists' });
});

test('every other write keeps the website origin only — the API origin is still refused there', async () => {
  const { member } = world();
  const m = member('keepweb');
  expect((await m.call('/v1/member/keys', 'POST', API, { name: 'laptop' })).status).toBe(403);
  expect((await m.call('/v1/members/handle', 'PUT', API, { handle: 'other' })).status).toBe(403);
  expect((await m.call('/v1/members', 'DELETE', API)).status).toBe(403);
  expect((await m.call('/v1/members/newsletter-preference', 'PUT', API, { subscribed: true })).status).toBe(403);
});

test('a request without Origin keeps today\'s rule (not refused for its origin)', async () => {
  const { store, member } = world();
  const m = member('noorigin');
  expect((await m.call('/v1/members/app-slot/name', 'POST', null, { appSlug: 'plain' })).status).toBe(200);
  expect(store.appSlotForMember(m.id)?.appSlug).toBe('plain');
});
