import { expect, test } from 'bun:test';
import { createMemberStore } from './member-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

const consent = { consents: { privacy: 'v1', terms: 'v1' } };
const identity = (sub: string) => ({ sub, email: `${sub}@example.test`, name: sub, emailVerified: true as const });

test('three-member invite chain records attribution and event, and rotation revokes old links', () => {
  const store = createMemberStore({ path: ':memory:' });
  try {
    const a = store.register(identity('a'), consent, '2026-11-12T00:00:00.000Z');
    store.provisionEventCode({ code: 'EVENT', maxUses: ['a', 'b', 'c'].length, startsAt: '2026-11-11T00:00:00Z', endsAt: '2026-11-13T00:00:00Z' });
    const b = store.register(identity('b'), { ...consent, referralCode: a.referralCode, eventCode: 'EVENT' }, '2026-11-12T00:01:00.000Z');
    const c = store.register(identity('c'), { ...consent, referralCode: b.referralCode }, '2026-11-12T00:02:00.000Z');
    expect(store.referralsForMember(a.id)).toEqual([{ inviteeId: b.id, referralCode: a.referralCode, eventCode: 'EVENT', invitedAt: '2026-11-12T00:01:00.000Z' }]);
    expect(store.referralsForMember(b.id)).toEqual([{ inviteeId: c.id, referralCode: b.referralCode, eventCode: null, invitedAt: '2026-11-12T00:02:00.000Z' }]);
    expect(() => store.register(identity('a'), { ...consent, referralCode: a.referralCode })).toThrow();
    expect(() => store.register(identity('b'), { ...consent, referralCode: a.referralCode })).toThrow();
    const next = store.rotateReferralCode(a.id);
    expect(next).not.toBe(a.referralCode);
    expect(store.validateCode(a.referralCode, 'referral').valid).toBe(false);
    expect(store.validateCode(next, 'referral').valid).toBe(true);
    expect(store.revokeReferralCode(a.id)).toBe(true);
    expect(store.validateCode(next, 'referral').valid).toBe(false);
  } finally { store.close(); }
});

test('revoked invite codes stay revoked across store reopening while attribution survives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'member-referral-'));
  const path = join(dir, 'members.sqlite');
  try {
    const first = createMemberStore({ path });
    let ownerId: string;
    let oldCode: string;
    let nextCode: string;
    try {
      const owner = first.register(identity('persistent-owner'), consent);
      ownerId = owner.id;
      oldCode = owner.referralCode;
      const invitee = first.register(identity('persistent-invitee'), { ...consent, referralCode: oldCode });
      expect(first.referralsForMember(ownerId)[0]?.inviteeId).toBe(invitee.id);
      nextCode = first.rotateReferralCode(ownerId);
    } finally { first.close(); }
    const reopened = createMemberStore({ path });
    try {
      expect(reopened.validateCode(oldCode, 'referral').valid).toBe(false);
      expect(reopened.activeReferralCodeForMember(ownerId)).toBe(nextCode);
      expect(reopened.referralsForMember(ownerId)[0]?.referralCode).toBe(oldCode);
      expect(reopened.revokeReferralCode(ownerId)).toBe(true);
    } finally { reopened.close(); }
    const revoked = createMemberStore({ path });
    try { expect(revoked.activeReferralCodeForMember(ownerId)).toBeNull(); }
    finally { revoked.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy NOCASE invite ledger migrates without changing codes, then rejects case variants', () => {
  const dir = mkdtempSync(join(tmpdir(), 'member-referral-case-'));
  const path = join(dir, 'members.sqlite');
  try {
    const legacy = createMemberStore({ path });
    const owner = legacy.register(identity('case-owner'), consent);
    const invitee = legacy.register(identity('case-invitee'), { ...consent, referralCode: owner.referralCode });
    legacy.close();
    const db = new Database(path);
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE member_referrals;
      DROP TABLE member_referral_codes;
      CREATE TABLE member_referral_codes (
        code TEXT PRIMARY KEY COLLATE NOCASE, member_id TEXT NOT NULL REFERENCES members(id),
        created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE TABLE member_referrals (
        invitee_id TEXT PRIMARY KEY REFERENCES members(id), inviter_id TEXT NOT NULL REFERENCES members(id),
        code TEXT NOT NULL COLLATE NOCASE REFERENCES member_referral_codes(code),
        event_code TEXT, invited_at TEXT NOT NULL, CHECK(invitee_id != inviter_id)
      );
    `);
    db.query('INSERT INTO member_referral_codes (code, member_id, created_at) VALUES (?, ?, ?)')
      .run('AaBb1234', owner.id, owner.createdAt);
    db.query('INSERT INTO member_referrals (invitee_id, inviter_id, code, event_code, invited_at) VALUES (?, ?, ?, ?, ?)')
      .run(invitee.id, owner.id, 'aAbB1234', null, invitee.createdAt);
    db.query('UPDATE members SET referral_code = ? WHERE id = ?').run('AaBb1234', owner.id);
    db.exec('PRAGMA foreign_keys = ON');
    expect((db.query("SELECT sql FROM sqlite_master WHERE name = 'member_referral_codes'").get() as { sql: string }).sql).toContain('COLLATE NOCASE');
    expect((db.query('PRAGMA foreign_key_check').all() as unknown[])).toEqual([]);
    db.close();
    const migrated = createMemberStore({ path });
    try {
      expect(migrated.validateCode('AaBb1234', 'referral').valid).toBe(true);
      expect(migrated.validateCode('aAbB1234', 'referral').valid).toBe(false);
      expect(() => migrated.register(identity('case-wrong'), { ...consent, referralCode: 'aAbB1234' })).toThrow('invalid referral code');
      expect(migrated.referralsForMember(owner.id)[0]?.referralCode).toBe('AaBb1234');
      expect(migrated.register(identity('case-right'), { ...consent, referralCode: 'AaBb1234' }).invitedBy).toBe(owner.id);
    } finally { migrated.close(); }
    const reopened = createMemberStore({ path });
    try { expect(reopened.validateCode('aAbB1234', 'referral').valid).toBe(false); }
    finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
