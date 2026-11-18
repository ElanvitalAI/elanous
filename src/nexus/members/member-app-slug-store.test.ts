import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_RETIRED_APP_SLUGS, createMemberStore } from './member-store.js';

const stores: ReturnType<typeof createMemberStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const setup = (path?: string) => {
  const dbPath = path ?? join((() => { const dir = mkdtempSync(join(tmpdir(), 'member-slug-')); dirs.push(dir); return dir; })(), 'members.sqlite');
  const store = createMemberStore({ path: dbPath });
  stores.push(store);
  store.provisionEventCode({ code: 'CHOOSE1', maxUses: Number.MAX_SAFE_INTEGER, startsAt: '2026-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z' });
  const make = (name: string, eventCode: string | null = 'CHOOSE1') => store.register(
    { sub: name, email: `${name}@example.test`, emailVerified: true, name },
    { consents: { privacy: 'v1', terms: 'v1' }, ...(eventCode ? { eventCode } : {}) });
  // Registering with an event code already gives the member a slot (the legacy hash name). A member WITHOUT a slot — the state the
  // create path serves — is made by removing it.
  const dropSlot = (memberId: string): void => {
    const db = new Database(dbPath);
    try { db.query('DELETE FROM member_app_slots WHERE member_id = ?').run(memberId); } finally { db.close(); }
  };
  return { store, make, dropSlot, dbPath };
};

test('a member chooses the app name when the slot is created; the internal id stays the stable hash id', () => {
  const { store, make, dropSlot } = setup();
  const alice = make('alice');
  dropSlot(alice.id);
  const created = store.createAppSlotForMember(alice.id, '2026-11-17T00:00:00.000Z', { appSlug: '  Ticketing ' });
  expect(created.outcome).toBe('created');
  if (created.outcome !== 'created') return;
  expect(created.slot.appSlug).toBe('ticketing');
  expect(created.slot.appId).toMatch(/^kaist-[a-f0-9]{24}$/); // lifecycle ledger and auth codes keep their id
  expect(created.slot.lifecycleEvent.appId).toBe(created.slot.appId);
  expect(store.appSlotForMember(alice.id)?.appSlug).toBe('ticketing');
});

test('without a chosen name the slug is the legacy hash, exactly as before (backward compatible)', () => {
  const { store, make, dropSlot } = setup();
  const bob = make('bob');
  // Registration with an event code made the slot: the legacy hash name.
  const slot = store.appSlotForMember(bob.id)!;
  expect(slot.appSlug).toMatch(/^[a-f0-9]{24}$/);
  expect(slot.appId).toBe(`kaist-${slot.appSlug}`);
  expect(store.createAppSlotForMember(bob.id, undefined, { appSlug: 'wants-new' })).toMatchObject({ outcome: 'already-exists' });
  expect(store.appSlotForMember(bob.id)?.appSlug).toBe(slot.appSlug); // create never renames
  // Created without a name (the old behaviour) is the same hash.
  dropSlot(bob.id);
  const again = store.createAppSlotForMember(bob.id);
  expect(again.outcome).toBe('created');
  if (again.outcome !== 'created') return;
  expect(again.slot.appSlug).toBe(slot.appSlug);
  // The legacy slug still finds its owner; an unknown one does not.
  expect(store.publicUserSlugForApp(slot.appSlug)).toBe(store.publicUserSlugForMember(bob.id));
  expect(store.publicUserSlugForApp('f'.repeat(24))).toBeNull();
  // The native path is unchanged too.
  const carol = make('carol', null);
  expect(store.ensureNativeAppSlotForMember(carol.id)?.appSlug).toMatch(/^[a-f0-9]{24}$/);
});

test('an old database without the app_slug column is migrated in place and its slots keep working', () => {
  const dir = mkdtempSync(join(tmpdir(), 'member-slug-migrate-'));
  const path = join(dir, 'members.sqlite');
  try {
    const first = setup(path);
    const member = first.make('legacy');
    const legacySlug = first.store.appSlotForMember(member.id)!.appSlug;
    first.store.close(); stores.pop();
    const db = new Database(path);
    db.exec('DROP INDEX member_app_slots_app_slug; ALTER TABLE member_app_slots DROP COLUMN app_slug;');
    db.close();
    const reopened = createMemberStore({ path }); stores.push(reopened);
    expect(reopened.appSlotForMember(member.id)?.appSlug).toBe(legacySlug);
    expect(reopened.renameAppSlotForMember(member.id, 'my-app', '2026-11-17T00:00:00.000Z')).toMatchObject({ outcome: 'renamed', previousAppSlug: legacySlug });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a name must be valid, unreserved and free: invalid and reserved names never reach the table, a taken name is refused', () => {
  const { store, make, dropSlot } = setup();
  const a = make('a1'); const b = make('b1');
  dropSlot(a.id); dropSlot(b.id);
  expect(store.createAppSlotForMember(a.id, undefined, { appSlug: 'admin' })).toEqual({ outcome: 'slug-invalid', reason: 'reserved' });
  expect(store.createAppSlotForMember(a.id, undefined, { appSlug: 'ab--cd' })).toEqual({ outcome: 'slug-invalid', reason: 'invalid-format' });
  expect(store.createAppSlotForMember(a.id, undefined, { appSlug: '0123456789abcdef01234567' })).toEqual({ outcome: 'slug-invalid', reason: 'legacy-space' });
  expect(store.appSlotForMember(a.id)).toBeNull(); // nothing was created by the refusals
  expect(store.createAppSlotForMember(a.id, undefined, { appSlug: 'ticketing' }).outcome).toBe('created');
  expect(store.createAppSlotForMember(b.id, undefined, { appSlug: 'TICKETING' })).toEqual({ outcome: 'slug-taken' });
  expect(store.appSlugAvailability('ticketing', b.id)).toEqual({ available: false, reason: 'taken' });
  expect(store.appSlugAvailability('ticketing', a.id)).toEqual({ available: true, slug: 'ticketing' }); // your own name is yours
  expect(store.appSlugAvailability('ledger-app', b.id)).toEqual({ available: true, slug: 'ledger-app' });
  expect(store.appSlugAvailability('www', b.id)).toEqual({ available: false, reason: 'reserved' });
  expect(store.appSlugAvailability(42, b.id)).toEqual({ available: false, reason: 'invalid-format' });
  expect(store.createAppSlotForMember(b.id, undefined, { appSlug: 'ledger-app' }).outcome).toBe('created');
});

test('an event code is still required, and the chosen name does not change that', () => {
  const { store, make, dropSlot } = setup();
  const noCode = make('nocode', null);
  dropSlot(noCode.id);
  expect(store.createAppSlotForMember(noCode.id, undefined, { appSlug: 'my-notes' })).toEqual({ outcome: 'event-code-required' });
  expect(store.createAppSlotForMember('missing-member', undefined, { appSlug: 'my-notes' })).toEqual({ outcome: 'member-not-found' });
});

test('rename: the old name stays reserved to its owner, others cannot take it, the owner can come back, and the count is bounded', () => {
  const { store, make } = setup();
  const owner = make('owner1'); const other = make('other1');
  // The owner starts on the legacy hash name (made at registration) and picks a name — the main path.
  const hashSlug = store.appSlotForMember(owner.id)!.appSlug;
  expect(store.renameAppSlotForMember(owner.id, 'first-name')).toMatchObject({ outcome: 'renamed', previousAppSlug: hashSlug });
  expect(store.publicUserSlugForApp(hashSlug)).toBeNull();
  const renamed = store.renameAppSlotForMember(owner.id, 'second-name', '2026-11-17T01:00:00.000Z');
  expect(renamed).toMatchObject({ outcome: 'renamed', previousAppSlug: 'first-name' });
  expect(store.appSlotForMember(owner.id)?.appSlug).toBe('second-name');
  expect(store.publicUserSlugForApp('second-name')).toBe(store.publicUserSlugForMember(owner.id));
  expect(store.publicUserSlugForApp('first-name')).toBeNull(); // the old address no longer resolves to anyone
  expect(store.renameAppSlotForMember(other.id, 'first-name')).toEqual({ outcome: 'slug-taken' }); // retired by the owner, still the owner's
  expect(store.appSlugAvailability('first-name', other.id)).toEqual({ available: false, reason: 'taken' });
  expect(store.renameAppSlotForMember(owner.id, 'second-name')).toMatchObject({ outcome: 'unchanged' });
  expect(store.renameAppSlotForMember(owner.id, 'first-name')).toMatchObject({ outcome: 'renamed', previousAppSlug: 'second-name' });
  // A rename never touches the internal id.
  expect(store.appSlotForMember(owner.id)?.appId).toMatch(/^kaist-[a-f0-9]{24}$/);
  // Bounded: a member cannot reserve names without end.
  let outcome = '';
  for (let index = 0; index <= MAX_RETIRED_APP_SLUGS + 1; index++) outcome = store.renameAppSlotForMember(owner.id, `bounded-${index}-x`).outcome;
  expect(outcome).toBe('rename-limit');
});

test('rename refuses what a create would refuse, and needs a slot and an active member', () => {
  const ctx = setup();
  const { store, make } = ctx;
  const { dropSlot } = ctx;
  const member = make('renamer');
  dropSlot(member.id);
  expect(store.renameAppSlotForMember(member.id, 'anything-ok')).toEqual({ outcome: 'app-slot-not-found' });
  expect(store.renameAppSlotForMember('missing-member', 'anything-ok')).toEqual({ outcome: 'member-not-found' });
  store.createAppSlotForMember(member.id, undefined, { appSlug: 'start-name' });
  expect(store.renameAppSlotForMember(member.id, 'login')).toEqual({ outcome: 'slug-invalid', reason: 'reserved' });
  expect(store.renameAppSlotForMember(member.id, 'with space')).toEqual({ outcome: 'slug-invalid', reason: 'invalid-format' });
  expect(store.appSlotForMember(member.id)?.appSlug).toBe('start-name');
});
