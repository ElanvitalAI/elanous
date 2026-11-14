import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberStore } from './member-store.js';

const stores: ReturnType<typeof createMemberStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

test('member plan is read from the catalog and free includes relay access', () => {
  const store = createMemberStore({ path: ':memory:' });
  stores.push(store);
  const member = store.register({ sub: 'google-sub', email: 'member@example.test', emailVerified: true, name: 'Member' }, {
    consents: { privacy: 'rev-1', terms: 'rev-1' },
  });
  expect(store.memberPlanForMember(member.id)).toEqual({ plan: 'free', entitlements: { 'relay.connect': true } });

  store.provisionPlan({ plan: 'catalog-row', entitlements: { feature: true } });
  expect(store.assignPlan(member.id, 'catalog-row')).toBe(true);
  expect(store.memberPlanForMember(member.id)).toEqual({ plan: 'catalog-row', entitlements: { feature: true } });
});

test('event-code provisioning keeps the current default window unless dates are supplied', () => {
  const store = createMemberStore({ path: ':memory:' });
  stores.push(store);

  store.provisionEventCode({ code: 'DEFAULT-WINDOW', maxUses: Number.MAX_SAFE_INTEGER });
  expect(store.validateCode('DEFAULT-WINDOW', 'event', '2026-11-13T14:59:59.999Z'))
    .toEqual({ valid: false, reason: 'inactive' });
  expect(store.validateCode('DEFAULT-WINDOW', 'event', '2026-11-13T15:00:00.000Z').valid).toBe(true);
  expect(store.validateCode('DEFAULT-WINDOW', 'event', '2026-11-15T15:00:00.000Z'))
    .toEqual({ valid: false, reason: 'inactive' });

  store.provisionEventCode({
    code: 'EXTENDED-WINDOW',
    maxUses: Number.MAX_SAFE_INTEGER,
    startsAt: '2026-11-20T00:00:00.000Z',
    endsAt: '2026-11-30T15:00:00.000Z',
  });
  expect(store.validateCode('EXTENDED-WINDOW', 'event', '2026-11-19T23:59:59.999Z'))
    .toEqual({ valid: false, reason: 'inactive' });
  expect(store.validateCode('EXTENDED-WINDOW', 'event', '2026-11-20T00:00:00.000Z').valid).toBe(true);
  expect(store.validateCode('EXTENDED-WINDOW', 'event', '2026-11-30T15:00:00.000Z'))
    .toEqual({ valid: false, reason: 'inactive' });

  store.provisionEventCode({
    code: 'START-ONLY',
    maxUses: Number.MAX_SAFE_INTEGER,
    startsAt: '2026-11-10T00:00:00.000Z',
  });
  expect(store.validateCode('START-ONLY', 'event', '2026-11-12T00:00:00.000Z').valid).toBe(true);

  store.provisionEventCode({
    code: 'END-ONLY',
    maxUses: Number.MAX_SAFE_INTEGER,
    endsAt: '2026-11-20T00:00:00.000Z',
  });
  expect(store.validateCode('END-ONLY', 'event', '2026-11-18T00:00:00.000Z').valid).toBe(true);

  store.provisionEventCode({
    code: 'OFFSET-WINDOW',
    maxUses: Number.MAX_SAFE_INTEGER,
    startsAt: '2026-11-20T09:00:00+09:00',
    endsAt: '2026-12-01T00:00:00.000Z',
  });
  expect(store.validateCode('OFFSET-WINDOW', 'event', '2026-11-20T00:00:00.000Z').valid).toBe(true);

  store.provisionEventCode({
    code: 'MINUTE-PRECISION-WINDOW',
    maxUses: Number.MAX_SAFE_INTEGER,
    startsAt: '2026-11-20T00:00Z',
    endsAt: '2026-12-01T00:00Z',
  });
  expect(store.validateCode('MINUTE-PRECISION-WINDOW', 'event', '2026-11-20T00:00:00.000Z').valid).toBe(true);
});

test('event-code provisioning rejects malformed or empty windows', () => {
  const store = createMemberStore({ path: ':memory:' });
  stores.push(store);

  expect(() => store.provisionEventCode({ code: 'BAD-DATE', maxUses: Number.MAX_SAFE_INTEGER, startsAt: 'not-a-date' }))
    .toThrow('invalid event code configuration');
  expect(() => store.provisionEventCode({
    code: 'INVALID-CALENDAR-DATE',
    maxUses: Number.MAX_SAFE_INTEGER,
    startsAt: '2026-02-30T00:00:00.000Z',
  })).toThrow('invalid event code configuration');
  expect(() => store.provisionEventCode({
    code: 'REVERSED-WINDOW',
    maxUses: Number.MAX_SAFE_INTEGER,
    startsAt: '2026-11-30T15:00:00.000Z',
    endsAt: '2026-11-20T00:00:00.000Z',
  })).toThrow('invalid event code configuration');
});

test('explicitly revoked free relay entitlement survives store reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'member-free-plan-'));
  const path = join(dir, 'members.sqlite');
  let store = createMemberStore({ path });
  try {
    const member = store.register({ sub: 'free-sub', email: 'free@example.test', emailVerified: true, name: 'Free' },
      { consents: { privacy: 'v1', terms: 'v1' } });
    store.provisionPlan({ plan: 'free', entitlements: { 'relay.connect': false } });
    store.close();
    store = createMemberStore({ path });
    expect(store.memberPlanForMember(member.id)?.entitlements['relay.connect']).toBe(false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('signup issues one private member key and rotation invalidates the old key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'member-key-store-'));
  const path = join(dir, 'members.sqlite');
  const store = createMemberStore({ path });
  try {
    const member = store.register({ sub: 'key-sub', email: 'key@example.test', emailVerified: true, name: 'Key Member' },
      { consents: { privacy: 'v1', terms: 'v1' } });
    const first = member.initialKey!;
    expect(first.key.startsWith('emk_')).toBe(true);
    expect(store.memberForGoogleSub('key-sub')).not.toHaveProperty('initialKey');
    expect(store.listMemberKeys(member.id)).toMatchObject([{ id: first.id, name: 'signup' }]);
    expect(readFileSync(path).includes(first.key)).toBe(false);
    const rotated = store.rotateMemberKey(member.id, first.id);
    expect(store.listMemberKeys(member.id)).toMatchObject([{ id: rotated.id }]);
    expect(store.revokeMemberKey(member.id, rotated.id)).toBe(true);
    expect(store.listMemberKeys(member.id)).toEqual([]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('migrates existing app auth code tables to the PKCE challenge column', () => {
  const directory = mkdtempSync(join(tmpdir(), 'member-store-legacy-'));
  const path = join(directory, 'members.sqlite');
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE member_app_auth_codes (
    code_hash TEXT PRIMARY KEY, state_hash TEXT NOT NULL, member_id TEXT NOT NULL,
    app_id TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT
  )`);
  legacy.close();
  let store: ReturnType<typeof createMemberStore> | undefined;
  try {
    store = createMemberStore({ path });
    const migrated = new Database(path, { readonly: true });
    try {
      const columns = migrated.query('PRAGMA table_info(member_app_auth_codes)').all() as Array<{ name: string }>;
      expect(columns.some(column => column.name === 'code_challenge')).toBe(true);
    } finally { migrated.close(); }
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('persisted deletion state gates synchronous auth effects after reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'member-deletion-auth-'));
  const path = join(directory, 'members.sqlite');
  let store = createMemberStore({ path });
  try {
    const member = store.register({ sub: 'deleted-sub', email: 'deleted@example.test', emailVerified: true, name: 'Deleted' },
      { consents: { privacy: 'v1', terms: 'v1' } });
    let effects = 0;
    expect(store.withActiveForAuth(member.id, () => ++effects)).toEqual({ active: true, value: 1 });
    expect(store.requestDeletion(member.session.token)).toBe(true);
    store.close();
    store = createMemberStore({ path });
    expect(store.activeForAuth(member.id)).toBe(false);
    expect(store.withActiveForAuth(member.id, () => ++effects)).toEqual({ active: false });
    expect(effects).toBe(1);
    expect(() => store.createSession(member.id)).toThrow('member is not active for session');
    expect(() => store.register({ sub: 'deleted-sub', email: 'deleted@example.test', emailVerified: true, name: 'Deleted' },
      { consents: { privacy: 'v1', terms: 'v1' } })).toThrow('member is not active for registration');
    expect(store.ensureNativeAppSlotForMember(member.id)).toBeNull();
    const db = new Database(path);
    try {
      // Simulate a stale unrevoked row: persisted deletion must still deny its session.
      db.query('UPDATE member_sessions SET revoked_at = NULL WHERE member_id = ?').run(member.id);
      expect(store.memberForSession(member.session.token)).toBeNull();
      db.query("UPDATE member_deletion_requests SET status = 'completed' WHERE member_id = ?").run(member.id);
      expect(store.activeForAuth(member.id)).toBe(false);
      expect(store.memberForSession(member.session.token)).toBeNull();
      db.query("UPDATE member_deletion_requests SET status = 'cancelled' WHERE member_id = ?").run(member.id);
      expect(store.activeForAuth(member.id)).toBe(true);
      expect(store.memberForSession(member.session.token)?.id).toBe(member.id);
      expect(store.createSession(member.id).token).toBeTruthy();
    } finally { db.close(); }
    expect(store.activeForAuth('missing-member')).toBe(false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('deletion lookup failure is an error and cannot run an auth effect', () => {
  const directory = mkdtempSync(join(tmpdir(), 'member-deletion-lookup-'));
  const path = join(directory, 'members.sqlite');
  const store = createMemberStore({ path });
  try {
    const member = store.register({ sub: 'failure-sub', email: 'failure@example.test', emailVerified: true, name: 'Failure' },
      { consents: { privacy: 'v1', terms: 'v1' } });
    const db = new Database(path);
    try { db.exec('DROP TABLE member_deletion_requests'); } finally { db.close(); }
    let effects = 0;
    expect(() => store.activeForAuth(member.id)).toThrow();
    expect(() => store.withActiveForAuth(member.id, () => ++effects)).toThrow();
    expect(() => store.createSession(member.id)).toThrow();
    expect(() => store.memberForSession(member.session.token)).toThrow();
    expect(effects).toBe(0);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
