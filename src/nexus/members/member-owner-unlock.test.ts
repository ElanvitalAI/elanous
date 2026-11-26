// MEMBER-HANDLE-OWNER-UNLOCK (대표 11-26): the owner claims a reserved handle with an owner unlock code. Expectations are literals,
// independent of the product constants (rule 11): the env name, the five unlockable names, «admin», 5 attempts per hour, 429, 403.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';
import { renderMemberHandlePage } from './member-handle-page.js';

const roots: string[] = [];
const stores: ReturnType<typeof createMemberStore>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A throwaway test value written into a temp file; not a real secret.
const TEST_CODE = 'unit-test-unlock-value-0123456789';

function world(options: { secret?: string | null; mode?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'member-owner-unlock-'));
  roots.push(root);
  const secretPath = join(root, 'owner-unlock-code');
  if (options.secret !== null) {
    writeFileSync(secretPath, (options.secret ?? TEST_CODE) + '\n', { mode: 0o600 });
    chmodSync(secretPath, options.mode ?? 0o600);
  }
  const pin = createHash('sha256').update('owner@example.test').digest('hex');
  const store = createMemberStore({ path: join(root, 'members.sqlite'), reservedJoosungGoogleEmailSha256: pin });
  stores.push(store);
  let clock = Date.parse('2026-11-26T10:00:00.000Z');
  const api = createMembersApi({
    store, google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
    successRedirectUri: 'https://app.example.test/signup/complete',
    now: () => clock,
    ownerUnlockEnv: { ELANOUS_MEMBER_OWNER_UNLOCK_CODE_FILE: secretPath },
  });
  const register = (sub: string, email: string) => store.register(
    { sub, email, emailVerified: true, name: sub }, { consents: { privacy: 'v1', terms: 'v1' } },
  );
  const put = async (token: string, body: Record<string, unknown>) => (await api.handle(new Request(
    'https://api.example.test/v1/members/handle', {
      method: 'PUT', headers: { cookie: '__Host-elanous_member_session=' + token }, body: JSON.stringify(body),
    })))!;
  return { store, api, register, put, secretPath, advance: (ms: number) => { clock += ms; } };
}

test('right code plus owner account claims ElanvitalAI; the audit row says claimed and holds no code', async () => {
  const w = world();
  const owner = w.register('owner', 'Owner@example.test');
  const response = await w.put(owner.session.token, { handle: 'ElanvitalAI', ownerUnlockCode: TEST_CODE });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(TEST_CODE);
  expect(JSON.parse(text).handle).toBe('ElanvitalAI');
  expect(w.store.memberForHandle('ElanvitalAI')).toBe(owner.id);
  const audit = w.store.ownerUnlockAttempts(owner.id);
  expect(audit.map(row => [row.handle, row.outcome])).toEqual([['ElanvitalAI', 'claimed']]);
  expect(JSON.stringify(audit)).not.toContain(TEST_CODE);
});

test('each unlockable name works for the owner with the right code', async () => {
  for (const name of ['elanvital', 'monad', 'elanous', 'user']) {
    const w = world();
    const owner = w.register('owner', 'owner@example.test');
    expect((await w.put(owner.session.token, { handle: name, ownerUnlockCode: TEST_CODE })).status).toBe(200);
    expect(w.store.memberForHandle(name)).toBe(owner.id);
  }
});

test('wrong code is refused 403 and audited bad-code', async () => {
  const w = world();
  const owner = w.register('owner', 'owner@example.test');
  const response = await w.put(owner.session.token, { handle: 'ElanvitalAI', ownerUnlockCode: 'wrong-value-wrong-value' });
  expect(response.status).toBe(403);
  expect((await response.json()).error).toBe('member-id-reserved');
  expect(w.store.memberForHandle('ElanvitalAI')).toBe(null);
  expect(w.store.ownerUnlockAttempts(owner.id).map(row => row.outcome)).toEqual(['bad-code']);
});

test('right code plus a non-owner account is refused 403 and audited not-owner', async () => {
  const w = world();
  const other = w.register('other', 'other@example.test');
  const response = await w.put(other.session.token, { handle: 'ElanvitalAI', ownerUnlockCode: TEST_CODE });
  expect(response.status).toBe(403);
  expect(w.store.memberForHandle('ElanvitalAI')).toBe(null);
  expect(w.store.ownerUnlockAttempts(other.id).map(row => row.outcome)).toEqual(['not-owner']);
});

test('admin stays unclaimable with the right code and the owner account', async () => {
  const w = world();
  const owner = w.register('owner', 'owner@example.test');
  const response = await w.put(owner.session.token, { handle: 'admin', ownerUnlockCode: TEST_CODE });
  expect(response.status).toBe(403);
  expect(w.store.memberForHandle('admin')).toBe(null);
  expect(w.store.ownerUnlockAttempts(owner.id).map(row => [row.handle, row.outcome])).toEqual([['admin', 'not-unlockable']]);
  // The store refuses admin even when told the route unlocked it.
  expect(() => w.store.claimHandle(owner.id, 'admin', undefined, { ownerUnlocked: true })).toThrow('reserved member ID');
});

test('the store re-checks the owner pin: an unlocked claim by a non-owner is still reserved', () => {
  const w = world();
  const other = w.register('other', 'other@example.test');
  expect(() => w.store.claimHandle(other.id, 'ElanvitalAI', undefined, { ownerUnlocked: true })).toThrow('reserved member ID');
});

test('rate limit: 5 attempts per member per hour, then 429 without a secret compare; the window reopens after an hour', async () => {
  const w = world();
  const owner = w.register('owner', 'owner@example.test');
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await w.put(owner.session.token, { handle: 'ElanvitalAI', ownerUnlockCode: 'wrong-value-' + attempt })).status).toBe(403);
  }
  const limited = await w.put(owner.session.token, { handle: 'ElanvitalAI', ownerUnlockCode: TEST_CODE });
  expect(limited.status).toBe(429);
  expect(w.store.memberForHandle('ElanvitalAI')).toBe(null);
  expect(w.store.ownerUnlockAttempts(owner.id).map(row => row.outcome))
    .toEqual(['bad-code', 'bad-code', 'bad-code', 'bad-code', 'bad-code', 'rate-limited']);
  // Another member has a separate budget.
  const other = w.register('other', 'other@example.test');
  expect((await w.put(other.session.token, { handle: 'monad', ownerUnlockCode: TEST_CODE })).status).toBe(403);
  w.advance(61 * 60_000);
  expect((await w.put(owner.session.token, { handle: 'ElanvitalAI', ownerUnlockCode: TEST_CODE })).status).toBe(200);
});

test('the rate limit survives a restart: it lives in the members DB', async () => {
  const root = mkdtempSync(join(tmpdir(), 'member-owner-unlock-restart-'));
  roots.push(root);
  const path = join(root, 'members.sqlite');
  const first = createMemberStore({ path });
  const member = first.register({ sub: 's', email: 's@example.test', emailVerified: true, name: 's' }, { consents: { privacy: 'v1', terms: 'v1' } });
  for (let attempt = 0; attempt < 5; attempt++) {
    expect(first.beginOwnerUnlockAttempt(member.id, 'monad', '2026-11-26T10:00:0' + attempt + '.000Z', '2026-11-26T09:00:00.000Z', 5)).not.toBe(null);
  }
  first.close();
  const second = createMemberStore({ path });
  stores.push(second);
  expect(second.beginOwnerUnlockAttempt(member.id, 'monad', '2026-11-26T10:00:09.000Z', '2026-11-26T09:00:00.000Z', 5)).toBe(null);
  expect(second.ownerUnlockAttempts(member.id).length).toBe(6);
});

test('fail-closed: a missing, group-readable or short secret file refuses the unlock (audited unavailable)', async () => {
  const cases: Array<{ secret?: string | null; mode?: number }> = [
    { secret: null },
    { mode: 0o644 },
    { secret: 'fifteen-bytes15' },
  ];
  for (const options of cases) {
    const w = world(options);
    const owner = w.register('owner', 'owner@example.test');
    const code = options.secret ?? TEST_CODE;
    expect((await w.put(owner.session.token, { handle: 'ElanvitalAI', ownerUnlockCode: code })).status).toBe(403);
    expect(w.store.memberForHandle('ElanvitalAI')).toBe(null);
    expect(w.store.ownerUnlockAttempts(owner.id).map(row => row.outcome)).toEqual(['unavailable']);
  }
  // Env unset entirely.
  const root = mkdtempSync(join(tmpdir(), 'member-owner-unlock-noenv-'));
  roots.push(root);
  const pin = createHash('sha256').update('owner@example.test').digest('hex');
  const store = createMemberStore({ path: join(root, 'members.sqlite'), reservedJoosungGoogleEmailSha256: pin });
  stores.push(store);
  const api = createMembersApi({
    store, google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
    successRedirectUri: 'https://app.example.test/signup/complete', ownerUnlockEnv: {},
  });
  const owner = store.register({ sub: 'o', email: 'owner@example.test', emailVerified: true, name: 'o' }, { consents: { privacy: 'v1', terms: 'v1' } });
  const response = await api.handle(new Request('https://api.example.test/v1/members/handle', {
    method: 'PUT', headers: { cookie: '__Host-elanous_member_session=' + owner.session.token },
    body: JSON.stringify({ handle: 'ElanvitalAI', ownerUnlockCode: TEST_CODE }),
  }));
  expect(response?.status).toBe(403);
});

test('a FIFO at the secret path is refused at once (no blocking open) and audited unavailable', async () => {
  const w = world({ secret: null });
  const fifo = w.secretPath;
  execFileSync('mkfifo', ['-m', '600', fifo]);
  const owner = w.register('owner', 'owner@example.test');
  // A blocking open would hang here until bun's per-test timeout fails the test.
  expect((await w.put(owner.session.token, { handle: 'ElanvitalAI', ownerUnlockCode: TEST_CODE })).status).toBe(403);
  expect(w.store.ownerUnlockAttempts(owner.id).map(row => row.outcome)).toEqual(['unavailable']);
});

test('length contract: a 256-byte secret is accepted and typeable; a 257-byte secret is refused; a 257-char code is 400', async () => {
  const secret256 = 'a'.repeat(256);
  const ok = world({ secret: secret256 });
  const owner = ok.register('owner', 'owner@example.test');
  expect((await ok.put(owner.session.token, { handle: 'monad', ownerUnlockCode: secret256 })).status).toBe(200);
  const secret257 = 'b'.repeat(257);
  const long = world({ secret: secret257 });
  const owner2 = long.register('owner', 'owner@example.test');
  expect((await long.put(owner2.session.token, { handle: 'monad', ownerUnlockCode: secret257.slice(0, 256) })).status).toBe(403);
  expect(long.store.ownerUnlockAttempts(owner2.id).map(row => row.outcome)).toEqual(['unavailable']);
  expect((await long.put(owner2.session.token, { handle: 'monad', ownerUnlockCode: secret257 })).status).toBe(400);
});

test('plain claims without a code are unchanged and write no audit row', async () => {
  const w = world();
  const owner = w.register('owner', 'owner@example.test');
  const other = w.register('other', 'other@example.test');
  expect((await w.put(other.session.token, { handle: 'ElanvitalAI' })).status).toBe(403);
  expect((await w.put(other.session.token, { handle: 'plainname' })).status).toBe(200);
  expect((await w.put(owner.session.token, { handle: 'user' })).status).toBe(200);
  expect(w.store.memberForHandle('user')).toBe(owner.id);
  expect(w.store.ownerUnlockAttempts(owner.id)).toEqual([]);
  expect(w.store.ownerUnlockAttempts(other.id)).toEqual([]);
});

test('request shape: unknown fields, an empty or non-string code are invalid (400) and are not audited', async () => {
  const w = world();
  const owner = w.register('owner', 'owner@example.test');
  for (const body of [
    { handle: 'ElanvitalAI', ownerUnlockCode: '' },
    { handle: 'ElanvitalAI', ownerUnlockCode: 7 },
    { handle: 'ElanvitalAI', extra: 'x' },
    { ownerUnlockCode: TEST_CODE },
  ]) expect((await w.put(owner.session.token, body)).status).toBe(400);
  expect(w.store.ownerUnlockAttempts(owner.id)).toEqual([]);
});

test('an app-session bearer cannot use an unlock code', async () => {
  const w = world();
  const owner = w.register('owner', 'owner@example.test');
  const response = await w.api.handle(new Request('https://api.example.test/v1/members/handle', {
    method: 'PUT', headers: { authorization: 'Bearer aps_forged' },
    body: JSON.stringify({ handle: 'ElanvitalAI', ownerUnlockCode: TEST_CODE }),
  }));
  expect(response?.status).toBe(401);
  expect(w.store.ownerUnlockAttempts(owner.id)).toEqual([]);
});

test('the handle page offers a password-type owner unlock code field that is never pre-filled', () => {
  const page = renderMemberHandlePage({ name: 'n', suggestedHandle: 'nnn', homeUrl: 'https://x.test/v1/members/home', nonce: 'abc' });
  expect(page).toContain('<input id="owner-unlock-code" type="password" autocomplete="off"');
  expect(page).toContain('payload.ownerUnlockCode = unlockCode');
  expect(page).not.toMatch(/id="owner-unlock-code"[^>]*value=/);
});
