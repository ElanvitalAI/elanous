import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';

const WEB = 'https://nexus.example.test';
const stores: ReturnType<typeof createMemberStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

type Events = Array<{ appId: string; action: string }>;

/** A real member store and the real members API; the lifecycle ledger is a small fake that can be told an app was used. */
const world = (options: { lifecycle?: 'none' | 'created-only' } = {}) => {
  const store = createMemberStore({ path: ':memory:' });
  stores.push(store);
  store.provisionEventCode({ code: 'CHOOSE1', maxUses: Number.MAX_SAFE_INTEGER, startsAt: '2026-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z' });
  const events: Events = [];
  const lifecycle = {
    ensureCreated: (event: { appId: string; action: string }) => { if (!events.some(e => e.appId === event.appId && e.action === 'created')) events.push({ appId: event.appId, action: event.action }); return null; },
    events: (appId: string) => events.filter(e => e.appId === appId) as never,
  };
  const api = createMembersApi({ store, google: { redirectUri: `${WEB}/v1/members/oauth/google/callback` } as never,
    successRedirectUri: `${WEB}/app/`, webOrigin: WEB,
    ...(options.lifecycle === 'none' ? {} : { appLifecycle: lifecycle as never }) });
  const member = (name: string, eventCode: string | null = 'CHOOSE1') => {
    const m = store.register({ sub: name, email: `${name}@example.test`, emailVerified: true, name },
      { consents: { privacy: 'v1', terms: 'v1' }, ...(eventCode ? { eventCode } : {}) });
    const cookie = `__Host-elanous_member_session=${store.createSession(m.id).token}`;
    const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
      const response = await api.handle(new Request(`${WEB}${path}`, {
        method: init.method ?? 'GET',
        headers: { cookie, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }));
      return { status: response?.status ?? 0, json: await response?.json().catch(() => null) as Record<string, unknown> | null };
    };
    return { id: m.id, call };
  };
  return { store, api, events, member, markUsed: (appId: string) => events.push({ appId, action: 'promoted' }) };
};

test('the main path: a member on the legacy hash name picks a name; the slot, the public address and the owner check follow it', async () => {
  const w = world();
  const m = w.member('alice');
  const before = await m.call('/v1/members/app-slot');
  expect(before.status).toBe(200);
  const hash = (before.json!.appSlot as { appSlug: string }).appSlug;
  expect(hash).toMatch(/^[a-f0-9]{24}$/);

  const renamed = await m.call('/v1/members/app-slot/name', { method: 'POST', body: { appSlug: 'Ticketing' } });
  expect(renamed.status).toBe(200);
  expect(renamed.json).toMatchObject({ appSlot: { appSlug: 'ticketing' }, previousAppSlug: hash });
  expect(((renamed.json!.appSlot as { appUrl?: string }).appUrl ?? '')).toMatch(/^$|^https:\/\/ticketing--/);
  expect((await m.call('/v1/members/app-slot')).json).toMatchObject({ appSlot: { appSlug: 'ticketing' } });
  // The owner check answers for the new name and no longer for the old one.
  expect((await m.call('/v1/members/owner?appSlug=ticketing')).status).toBe(200);
  expect((await m.call(`/v1/members/owner?appSlug=${hash}`)).status).toBe(401);
});

test('the API refuses bad, reserved, legacy-space and taken names with distinct answers, and changes nothing', async () => {
  const w = world();
  const a = w.member('a1'); const b = w.member('b1');
  const name = (who: typeof a, appSlug: unknown) => who.call('/v1/members/app-slot/name', { method: 'POST', body: { appSlug } });
  expect((await name(a, 'ab--cd')).json).toEqual({ error: 'invalid-app-slug', reason: 'invalid-format' });
  expect((await name(a, 'admin')).json).toEqual({ error: 'invalid-app-slug', reason: 'reserved' });
  expect((await name(a, 'ticketing-sim')).json).toEqual({ error: 'invalid-app-slug', reason: 'reserved' });
  expect((await name(a, '0123456789abcdef01234567')).json).toEqual({ error: 'invalid-app-slug', reason: 'legacy-space' });
  expect((await name(a, 12)).status).toBe(400);
  expect((await a.call('/v1/members/app-slot/name', { method: 'POST', body: { appSlug: 'ok-name', extra: 1 } })).status).toBe(400);
  expect((await a.call('/v1/members/app-slot/name', { method: 'POST' })).status).toBe(400);
  expect((await name(a, 'ticketing')).status).toBe(200);
  expect(await name(b, 'Ticketing')).toMatchObject({ status: 409, json: { error: 'app-slug-taken' } });
  expect((await b.call('/v1/members/app-slot')).json).toMatchObject({ appSlot: { appSlug: expect.stringMatching(/^[a-f0-9]{24}$/) } });
  // Same name again is a quiet no-op, not an error.
  expect(await name(a, 'ticketing')).toMatchObject({ status: 200 });
});

test('a name check needs a session, answers one name at a time, and says «yours» for your own name', async () => {
  const w = world();
  const a = w.member('c1'); const b = w.member('d1');
  expect((await a.call('/v1/members/app-slot/name-check?name=ledger')).json).toEqual({ available: true, appSlug: 'ledger' });
  expect((await a.call('/v1/members/app-slot/name-check?name=www')).json).toEqual({ available: false, reason: 'reserved' });
  expect((await a.call('/v1/members/app-slot/name-check')).json).toEqual({ available: false, reason: 'invalid-format' });
  await a.call('/v1/members/app-slot/name', { method: 'POST', body: { appSlug: 'ledger' } });
  expect((await b.call('/v1/members/app-slot/name-check?name=ledger')).json).toEqual({ available: false, reason: 'taken' });
  expect((await a.call('/v1/members/app-slot/name-check?name=ledger')).json).toEqual({ available: true, appSlug: 'ledger' });
  const anonymous = await w.api.handle(new Request(`${WEB}/v1/members/app-slot/name-check?name=ledger`));
  expect(anonymous?.status).toBe(401);
  expect((await a.call('/v1/members/app-slot/name-check?name=ledger', { method: 'POST' })).status).toBe(405);
});

test('rename is for an app that was never used: once it was promoted the name is locked; no ledger = no rename', async () => {
  const w = world();
  const m = w.member('e1');
  const slot = w.store.appSlotForMember(m.id)!;
  await m.call('/v1/members/app-slot'); // the read records the creation event
  expect((await m.call('/v1/members/app-slot/name', { method: 'POST', body: { appSlug: 'first-pick' } })).status).toBe(200);
  w.markUsed(slot.appId);
  expect(await m.call('/v1/members/app-slot/name', { method: 'POST', body: { appSlug: 'second-pick' } })).toMatchObject({ status: 409, json: { error: 'app-slug-locked' } });
  expect(w.store.appSlotForMember(m.id)?.appSlug).toBe('first-pick');

  const bare = world({ lifecycle: 'none' });
  const n = bare.member('f1');
  expect(await n.call('/v1/members/app-slot/name', { method: 'POST', body: { appSlug: 'wanted-name' } })).toMatchObject({ status: 503, json: { error: 'rename-unavailable' } });
});

test('only a signed-in member of this site can rename: no cookie, a foreign origin and the wrong method are all refused', async () => {
  const w = world();
  const m = w.member('g1');
  const anonymous = await w.api.handle(new Request(`${WEB}/v1/members/app-slot/name`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appSlug: 'sneaky-name' }) }));
  expect(anonymous?.status).toBe(401);
  expect((await m.call('/v1/members/app-slot/name', { method: 'POST', body: { appSlug: 'cross-site' }, headers: { origin: 'https://evil.example.test' } })).status).toBe(403);
  expect((await m.call('/v1/members/app-slot/name', { method: 'GET' })).status).toBe(405);
  expect(w.store.appSlotForMember(m.id)?.appSlug).toMatch(/^[a-f0-9]{24}$/); // none of the above changed anything
  const preflight = await w.api.handle(new Request(`${WEB}/v1/members/app-slot/name`, { method: 'OPTIONS', headers: { origin: WEB, 'access-control-request-method': 'POST' } }));
  expect(preflight?.ok).toBe(true);
});

test('creating a slot still works with no body (the legacy call) and with a chosen name; a bad body is refused', async () => {
  const w = world();
  const a = w.member('h1'); const b = w.member('i1'); const c = w.member('j1');
  // Registration already made the slots, so a second create is the documented 409 — for the legacy call and the named one alike.
  expect(await a.call('/v1/members/app-slot', { method: 'POST' })).toMatchObject({ status: 409, json: { error: 'app-slot-already-exists' } });
  expect(await b.call('/v1/members/app-slot', { method: 'POST', body: { appSlug: 'named-app' } })).toMatchObject({ status: 409 });
  expect((await c.call('/v1/members/app-slot', { method: 'POST', body: { appSlug: 'named-app', x: 1 } })).status).toBe(400);
  expect((await c.call('/v1/members/app-slot', { method: 'POST', body: 'not-an-object' })).status).toBe(400);
});

test('a member with no slot yet creates one with a chosen name through the API; the name rules and the one-slot rule hold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'member-slug-api-'));
  const path = join(dir, 'members.sqlite');
  const store = createMemberStore({ path });
  stores.push(store);
  try {
    store.provisionEventCode({ code: 'CHOOSE1', maxUses: Number.MAX_SAFE_INTEGER, startsAt: '2026-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z' });
    const api = createMembersApi({ store, google: { redirectUri: `${WEB}/v1/members/oauth/google/callback` } as never, successRedirectUri: `${WEB}/app/`, webOrigin: WEB });
    const make = (name: string) => {
      const m = store.register({ sub: name, email: `${name}@example.test`, emailVerified: true, name }, { consents: { privacy: 'v1', terms: 'v1' }, eventCode: 'CHOOSE1' });
      const raw = new Database(path); try { raw.query('DELETE FROM member_app_slots WHERE member_id = ?').run(m.id); } finally { raw.close(); }
      const cookie = `__Host-elanous_member_session=${store.createSession(m.id).token}`;
      return (init: { body?: unknown }) => api.handle(new Request(`${WEB}/v1/members/app-slot`, { method: 'POST',
        headers: { cookie, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }));
    };
    const first = make('k1'); const second = make('l1'); const third = make('m1');
    expect((await first({ body: { appSlug: 'admin' } }))?.status).toBe(400);
    const created = await first({ body: { appSlug: 'My-Notes' } });
    expect(created?.status).toBe(201);
    expect(await created?.json()).toMatchObject({ appSlot: { appSlug: 'my-notes' } });
    expect((await first({ body: { appSlug: 'other-name' } }))?.status).toBe(409); // one slot per member
    expect((await second({ body: { appSlug: 'my-notes' } }))?.status).toBe(409);   // taken
    const legacy = await third({}); // no body: the old call, the legacy hash name
    expect(legacy?.status).toBe(201);
    expect(((await legacy?.json()) as { appSlot: { appSlug: string } }).appSlot.appSlug).toMatch(/^[a-f0-9]{24}$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
