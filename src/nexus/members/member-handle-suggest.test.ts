import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';
import { isPublicRoute } from '../api/public-routes.js';
import {
  HANDLE_PATTERN, STATIC_DISPATCH_HANDLE_NAMES, RESERVED_MEMBER_HANDLES, slugFromName, suggestAlternatives,
} from './member-handle-suggest.js';

const WEB = 'https://nexus.example.test';
const stores: ReturnType<typeof createMemberStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

test('slugFromName: ASCII name, accents, spaces and case collapse to [a-z0-9]', () => {
  expect(slugFromName('Jane Doe')).toBe('janedoe');
  expect(slugFromName('José Núñez')).toBe('josenunez');
});

test('slugFromName: Korean name is romanized deterministically (revised romanization per syllable)', () => {
  expect(slugFromName('김주성')).toBe('gimjuseong');
  expect(slugFromName('박 서연')).toBe('bakseoyeon');
  expect(slugFromName('김주성')).toBe(slugFromName('김주성'));
});

test('slugFromName: mixed script keeps both halves', () => {
  expect(slugFromName('김Jun')).toBe('gimjun');
});

test('slugFromName: empty name falls back to the email local part, then to member', () => {
  expect(slugFromName('', 'Alice.Kim')).toBe('alicekim');
  expect(slugFromName('', undefined)).toBe('member');
  expect(slugFromName('  ', '!!')).toBe('member');
});

test('slugFromName: fewer than 3 usable characters falls back; leading digits are dropped; long names are cut at 20', () => {
  expect(slugFromName('Al', 'alice')).toBe('alice');
  expect(slugFromName('Al')).toBe('member');
  expect(slugFromName('2024kim')).toBe('kim');
  expect(slugFromName('12', 'bob99')).toBe('bob99');
  expect(slugFromName('abcdefghijklmnopqrstuvwxyz')).toBe('abcdefghijklmnopqrst');
  expect(slugFromName('日本語', 'taro')).toBe('taro');
});

test('slugFromName always satisfies the claim pattern', () => {
  for (const name of ['', 'a', '😀😀😀', '김', '가나다라마바사아자차카타파하가나다라마바사', '123456', 'Ünï']) {
    expect(HANDLE_PATTERN.test(slugFromName(name))).toBe(true);
  }
});

test('suggestAlternatives: three distinct valid candidates in a fixed order, never the base', () => {
  const out = suggestAlternatives('janedoe', () => false);
  expect(out).toEqual(['janedoe1', 'janedoe2', 'janedoe3']);
  expect(suggestAlternatives('janedoe', () => false)).toEqual(out);
});

test('suggestAlternatives: skips taken, reserved and static dispatch names; trims the stem to 20', () => {
  expect(suggestAlternatives('janedoe', c => c === 'janedoe1' || c === 'janedoe3')).toEqual(['janedoe2', 'janedoe4', 'janedoe5']);
  const seen: string[] = [];
  suggestAlternatives('admin', c => { seen.push(c); return false; });
  expect(seen.includes('admin')).toBe(false);
  expect(suggestAlternatives('ap', () => false, 2)).toEqual(['ap1', 'ap2']);
  expect(suggestAlternatives('abcdefghijklmnopqrst', () => false, 2)).toEqual(['abcdefghijklmnopqrs1', 'abcdefghijklmnopqrs2']);
});

test('the static dispatch names include everything the relay refuses, pinned against the relay source', () => {
  const source = readFileSync(join(import.meta.dir, '../../relay/relay-server.ts'), 'utf8');
  const literal = '["www", "docs", "api", "admin", "relay", "mail"]';
  expect(source.includes(literal)).toBe(true);
  for (const name of JSON.parse(literal) as string[]) expect(STATIC_DISPATCH_HANDLE_NAMES.has(name)).toBe(true);
  for (const name of ['app', 'v1']) expect(STATIC_DISPATCH_HANDLE_NAMES.has(name)).toBe(true);
  expect(RESERVED_MEMBER_HANDLES.has('user')).toBe(true);
});

const reg = (store: ReturnType<typeof createMemberStore>, name: string, email = `${name}@example.test`) =>
  store.register({ sub: name, email, emailVerified: true, name }, { consents: { privacy: 'v1', terms: 'v1' } });

test('store.handleAvailability: ok, taken, reserved, invalid, retired slug', () => {
  const store = createMemberStore({ path: ':memory:' });
  stores.push(store);
  const a = reg(store, 'a1'); const b = reg(store, 'b1');
  store.claimHandle(a.id, 'alpha');
  expect(store.handleAvailability('freshname', b.id)).toEqual({ status: 'ok', alternatives: [] });
  expect(store.handleAvailability('alpha', b.id)).toEqual({ status: 'taken', alternatives: ['alpha1', 'alpha2', 'alpha3'] });
  expect(store.handleAvailability('alpha', a.id).status).toBe('ok');
  expect(store.handleAvailability('admin', b.id).status).toBe('reserved');
  expect(store.handleAvailability('www', b.id).status).toBe('reserved');
  expect(store.handleAvailability('user', b.id).status).toBe('reserved');
  expect(store.handleAvailability('A!', b.id)).toEqual({ status: 'invalid', alternatives: ['a10', 'a11', 'a12'] });
  expect(store.handleAvailability('9abc', b.id).status).toBe('invalid');
  expect(store.handleAvailability('emk_abc', b.id).status).toBe('invalid');
});

test('store.handleAvailability: a retired public slug stays taken, even for its former owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'handle-avail-'));
  const path = join(root, 'members.sqlite');
  const store = createMemberStore({ path });
  stores.push(store);
  const a = reg(store, 'a2'); const b = reg(store, 'b2');
  const raw = new Database(path);
  raw.query('INSERT INTO member_public_user_slugs (user_slug, member_id, retired) VALUES (?, ?, 1)').run('legacyslug1', a.id);
  raw.close();
  expect(store.handleAvailability('legacyslug1', b.id).status).toBe('taken');
  expect(store.handleAvailability('legacyslug1', a.id).status).toBe('taken');
  rmSync(root, { recursive: true, force: true });
});

const world = () => {
  const store = createMemberStore({ path: ':memory:' });
  stores.push(store);
  const api = createMembersApi({ store, google: { redirectUri: `${WEB}/v1/members/oauth/google/callback` } as never,
    successRedirectUri: `${WEB}/app/`, webOrigin: WEB });
  const member = (name: string, email = `${name}@example.test`) => {
    const m = reg(store, name, email);
    const cookie = `__Host-elanous_member_session=${store.createSession(m.id).token}`;
    const call = async (path: string, init: { method?: string; body?: string } = {}) => {
      const response = await api.handle(new Request(`${WEB}${path}`, { method: init.method ?? 'GET', body: init.body, headers: { cookie, 'content-type': 'application/json' } }));
      return { status: response?.status ?? 0, json: await response?.json().catch(() => null) as Record<string, unknown> | null };
    };
    return { id: m.id, call };
  };
  return { api, store, member };
};

test('reserved names are rejected by availability, direct claims and authenticated PUT without mutation', async () => {
  const w = world();
  const m = w.member('reserved-tester');
  for (const name of ['www', 'docs', 'api', 'admin', 'relay', 'mail', 'app', 'user', 'monad']) {
    expect((await m.call(`/v1/members/handle/check?handle=${name}`)).json?.status).toBe('reserved');
    expect(() => w.store.claimHandle(m.id, name)).toThrow('reserved member ID');
    const result = await m.call('/v1/members/handle', { method: 'PUT', body: JSON.stringify({ handle: name }) });
    expect(result.status).toBe(403);
    expect(result.json).toEqual({ error: 'member-id-reserved' });
    expect(w.store.handleForMember(m.id)).toBeNull();
    expect(w.store.memberForHandle(name)).toBeNull();
  }
  const ok = await m.call('/v1/members/handle', { method: 'PUT', body: JSON.stringify({ handle: 'ordinary123' }) });
  expect(ok.status).toBe(200);
  expect(w.store.handleForMember(m.id)).toBe('ordinary123');
});

test('GET /v1/members/handle/check needs a session and is GET-only', async () => {
  const w = world();
  const m = w.member('김주성', 'kim@example.test');
  const anonymous = await w.api.handle(new Request(`${WEB}/v1/members/handle/check?handle=abc`));
  expect(anonymous?.status).toBe(401);
  expect((await m.call('/v1/members/handle/check', { method: 'POST' })).status).toBe(405);
  expect((await m.call('/v1/members/handle/check?handle=a&handle=b')).status).toBe(400);
});

test('check: no handle param answers for the recommendation built from the caller name', async () => {
  const w = world();
  const m = w.member('김주성', 'kim@example.test');
  expect((await m.call('/v1/members/handle/check')).json).toEqual({
    handle: 'gimjuseong', status: 'ok', alternatives: [], suggestion: 'gimjuseong',
  });
});

test('check: ok vs taken with alternatives; a name that is taken gets its recommendation moved', async () => {
  const w = world();
  const a = w.member('Alice Kim'); const b = w.member('Bob Lee');
  expect((await a.call('/v1/members/handle/check?handle=alicekim')).json).toEqual({ handle: 'alicekim', status: 'ok', alternatives: [], suggestion: null });
  w.store.claimHandle(a.id, 'alicekim');
  expect((await b.call('/v1/members/handle/check?handle=alicekim')).json).toEqual({
    handle: 'alicekim', status: 'taken', alternatives: ['alicekim1', 'alicekim2', 'alicekim3'], suggestion: null,
  });
  expect((await b.call('/v1/members/handle/check?handle=www')).json).toMatchObject({ status: 'reserved' });
  expect((await b.call('/v1/members/handle/check?handle=Bad!')).json).toMatchObject({ status: 'invalid' });
});

test('check: a taken recommendation never comes back as the suggestion — an alternative or null does', async () => {
  const w = world();
  const a = w.member('Alice Kim'); const b = w.member('AliceKim', 'alice2@example.test');
  w.store.claimHandle(a.id, 'alicekim');
  // no ?handle=: the recommendation built from the caller name is taken, so the suggestion moves to a free alternative
  const moved = (await b.call('/v1/members/handle/check')).json as { handle: string; status: string; suggestion: string | null; alternatives?: string[] };
  expect(moved.status).toBe('taken');
  expect(moved.suggestion).not.toBe('alicekim');
  expect(moved.suggestion).toBe(moved.alternatives?.[0] ?? null);
  // with ?handle=: the suggestion is never about the caller's own recommendation
  expect((await b.call('/v1/members/handle/check?handle=alicekim')).json).toMatchObject({ suggestion: null });
});

test('real server path: POST /v1/members/handle/check answers 405 through the auth gate, not 401', async () => {
  const w = world();
  // the allowlist must let a non-GET reach the handler so it answers method-not-allowed instead of the gate's 401
  expect(isPublicRoute('POST', '/v1/members/handle/check', { setupMode: false })).toBe(true);
  expect(isPublicRoute('PUT', '/v1/members/handle/check', { setupMode: false })).toBe(true);
  expect(isPublicRoute('GET', '/v1/members/handle/check', { setupMode: false })).toBe(true);
  // no cookie: the method answer comes before any credential check
  const anonymousPost = await w.api.handle(new Request(`${WEB}/v1/members/handle/check`, { method: 'POST' }));
  expect(anonymousPost?.status).toBe(405);
  const anonymousPut = await w.api.handle(new Request(`${WEB}/v1/members/handle/check?handle=abc`, { method: 'PUT' }));
  expect(anonymousPut?.status).toBe(405);
});

test('check: never leaks another member email or name', async () => {
  const w = world();
  const a = w.member('Secret Person', 'secret.person@example.test'); const b = w.member('Other One');
  w.store.claimHandle(a.id, 'secretperson');
  const text = JSON.stringify((await b.call('/v1/members/handle/check?handle=secretperson')).json);
  expect(text.includes('example.test')).toBe(false);
  expect(text.includes('Secret')).toBe(false);
  expect(Object.keys(JSON.parse(text)).sort()).toEqual(['alternatives', 'handle', 'status', 'suggestion']);
});
