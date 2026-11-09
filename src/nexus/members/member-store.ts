import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nexusRootDir } from '../paths.js';
import { createAppLifecycleEvent, validateAppLifecycleEvent, type AppLifecycleEvent } from '../apps/app-lifecycle-ledger.js';

export interface MemberSignupIntent {
  readonly consents: Readonly<Record<string, string>>;
  readonly referralCode?: string;
  readonly eventCode?: string;
}

export interface GoogleMemberIdentity {
  readonly sub: string;
  readonly email: string;
  readonly emailVerified: true;
  readonly name: string;
}

export interface MemberProfile {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly referralCode: string;
  readonly invitedBy: string | null;
  readonly eventCode: string | null;
  readonly createdAt: string;
}

export interface MemberPlanEntitlements {
  readonly plan: string;
  readonly entitlements: Readonly<Record<string, unknown>>;
}

export interface MemberAppSlot {
  readonly appId: string;
  readonly appSlug: string;
  readonly memberId: string;
  readonly templateSlug: string;
  readonly createdAt: string;
  readonly lifecycleEvent: AppLifecycleEvent;
}

export type MemberAppSlotCreation =
  | { readonly outcome: 'created' | 'already-exists'; readonly slot: MemberAppSlot }
  | { readonly outcome: 'member-not-found' | 'event-code-required' };

export type MemberCodeValidation =
  | { readonly valid: true; readonly kind: 'referral' | 'event'; readonly referredReward: 'none' | null; readonly benefit?: 'non-monetary'; readonly finalizesAt?: string }
  | { readonly valid: false; readonly reason: 'invalid' | 'inactive' | 'exhausted' };

export interface MemberStore {
  provisionEventCode(input: { readonly code: string; readonly maxUses: number }): void;
  recordSignupStart(networkKey: string, at: string, windowStartsAt: string, limit: number): boolean;
  consumeOAuthState(state: string, expiresAt: string, now?: string): boolean;
  validateCode(code: string, kind?: 'referral' | 'event', now?: string): MemberCodeValidation;
  register(identity: GoogleMemberIdentity, intent: MemberSignupIntent, now?: string): MemberProfile;
  memberForGoogleSub(sub: string): MemberProfile | null;
  memberPlanForMember(memberId: string): MemberPlanEntitlements | null;
  provisionPlan(input: { readonly plan: string; readonly entitlements: Readonly<Record<string, unknown>> }): void;
  assignPlan(memberId: string, plan: string): boolean;
  appSlotForMember(memberId: string): MemberAppSlot | null;
  createAppSlotForMember(memberId: string, now?: string): MemberAppSlotCreation;
  createSession(memberId: string, now?: string): { token: string; expiresAt: string };
  memberForSession(token: string, now?: string): MemberProfile | null;
  requestDeletion(token: string, now?: string): boolean;
  close(): void;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const EVENT_START = '2026-11-13T15:00:00.000Z'; // 2026-11-14 00:00 Asia/Seoul
const EVENT_END = '2026-11-15T15:00:00.000Z';   // 2026-11-16 00:00 Asia/Seoul
const EVENT_FINALIZATION_MS = 14 * 24 * 60 * 60_000;
const HASHED_OAUTH_STATE = /^[a-f0-9]{64}$/;
export const KAIST_APP_TEMPLATE_SLUG = 'next-app-lecture-scrap';

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function iso(value: string | number | Date): string { return new Date(value).toISOString(); }
function referralCode(): string { return randomBytes(6).toString('base64url').toUpperCase().replace(/[-_]/g, 'X'); }

/** Persistent private member records, short-lived OAuth replay hashes and revocable sessions. */
export function createMemberStore(options: { readonly path?: string; readonly now?: () => number } = {}): MemberStore {
  const privateDir = join(nexusRootDir(), 'members');
  const path = options.path ?? join(privateDir, 'members.sqlite');
  if (!options.path) {
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    chmodSync(privateDir, 0o700);
  } else if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY, google_sub TEXT NOT NULL UNIQUE, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      name TEXT NOT NULL, referral_code TEXT NOT NULL UNIQUE, invited_by TEXT REFERENCES members(id),
      event_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS member_plan_catalog (
      plan TEXT PRIMARY KEY, entitlements_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS member_plan_assignments (
      member_id TEXT PRIMARY KEY REFERENCES members(id), plan TEXT NOT NULL REFERENCES member_plan_catalog(plan)
    );
    CREATE TABLE IF NOT EXISTS member_consents (
      member_id TEXT NOT NULL REFERENCES members(id), policy TEXT NOT NULL, revision TEXT NOT NULL,
      accepted_at TEXT NOT NULL, PRIMARY KEY (member_id, policy, revision)
    );
    CREATE TABLE IF NOT EXISTS member_event_codes (
      code TEXT PRIMARY KEY COLLATE NOCASE, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
      max_uses INTEGER NOT NULL CHECK(max_uses > 0), benefit_kind TEXT NOT NULL CHECK(benefit_kind = 'non-monetary')
    );
    CREATE TABLE IF NOT EXISTS member_event_uses (
      code TEXT NOT NULL COLLATE NOCASE REFERENCES member_event_codes(code),
      member_id TEXT NOT NULL REFERENCES members(id), used_at TEXT NOT NULL, finalizes_at TEXT NOT NULL,
      PRIMARY KEY (code, member_id)
    );
    CREATE TABLE IF NOT EXISTS member_app_slots (
      app_id TEXT PRIMARY KEY, member_id TEXT NOT NULL UNIQUE REFERENCES members(id),
      template_slug TEXT NOT NULL, created_at TEXT NOT NULL, lifecycle_event_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS member_oauth_consumed_states (
      state_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS member_oauth_start_attempts (
      network_hash TEXT NOT NULL, requested_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS member_oauth_start_attempts_network_time ON member_oauth_start_attempts(network_hash, requested_at);
    CREATE TABLE IF NOT EXISTS member_sessions (
      token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id),
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS member_sessions_member ON member_sessions(member_id, expires_at);
    CREATE TABLE IF NOT EXISTS member_deletion_requests (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), requested_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'cancelled'))
    );
    DROP TABLE IF EXISTS member_signup_states;
  `);
  // 0.3.9 ships only the free plan and an empty entitlement map. Further plans are catalog rows,
  // never branches or numeric limits in application code.
  db.query(`INSERT OR IGNORE INTO member_plan_catalog (plan, entitlements_json) VALUES ('free', '{}')`).run();
  db.query(`INSERT OR IGNORE INTO member_plan_assignments (member_id, plan)
    SELECT id, 'free' FROM members`).run();
  const nowMs = options.now ?? Date.now;
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error('member store is closed'); };

  function profile(row: Record<string, unknown>): MemberProfile {
    return {
      id: String(row.id), email: String(row.email), name: String(row.name), referralCode: String(row.referral_code),
      invitedBy: row.invited_by == null ? null : String(row.invited_by),
      eventCode: row.event_code == null ? null : String(row.event_code), createdAt: String(row.created_at),
    };
  }

  function appSlot(row: Record<string, unknown>): MemberAppSlot {
    let lifecycleEvent: AppLifecycleEvent;
    try { lifecycleEvent = validateAppLifecycleEvent(JSON.parse(String(row.lifecycle_event_json))); }
    catch { throw new Error('member app slot is corrupt'); }
    const appId = String(row.app_id);
    const appSlug = /^kaist-([a-f0-9]{24})$/.exec(appId)?.[1];
    const memberId = String(row.member_id);
    if (!appSlug || lifecycleEvent.appId !== appId || lifecycleEvent.action !== 'created' || lifecycleEvent.outcome !== 'succeeded') {
      throw new Error('member app slot lifecycle identity mismatch');
    }
    return { appId, appSlug, memberId, templateSlug: String(row.template_slug), createdAt: String(row.created_at), lifecycleEvent };
  }

  function readAppSlot(memberId: string): MemberAppSlot | null {
    const row = db.query('SELECT app_id, member_id, template_slug, created_at, lifecycle_event_json FROM member_app_slots WHERE member_id = ?')
      .get(memberId) as Record<string, unknown> | null;
    return row ? appSlot(row) : null;
  }

  function insertAppSlot(memberId: string, at: string): MemberAppSlot {
    const existing = readAppSlot(memberId);
    if (existing) return existing;
    const appHash = hash(memberId).slice(0, 24);
    const appId = `kaist-${appHash}`;
    const appSlug = appHash;
    const lifecycleEvent = createAppLifecycleEvent({ appId, action: 'created', environment: 'live', actor: 'user', occurredAt: at });
    db.query(`INSERT INTO member_app_slots (app_id, member_id, template_slug, created_at, lifecycle_event_json)
      VALUES (?, ?, ?, ?, ?)`).run(appId, memberId, KAIST_APP_TEMPLATE_SLUG, at, JSON.stringify(lifecycleEvent));
    return { appId, appSlug, memberId, templateSlug: KAIST_APP_TEMPLATE_SLUG, createdAt: at, lifecycleEvent };
  }

  function validate(code: string, kind?: 'referral' | 'event', at = iso(nowMs())): MemberCodeValidation {
    const normalized = code.trim().toUpperCase();
    if (!normalized || normalized.length > 80) return { valid: false, reason: 'invalid' };
    if (kind !== 'event') {
      const referral = db.query('SELECT id FROM members WHERE referral_code = ? COLLATE NOCASE').get(normalized) as { id: string } | null;
      if (referral) return { valid: true, kind: 'referral', referredReward: 'none' };
      if (kind === 'referral') return { valid: false, reason: 'invalid' };
    }
    const event = db.query('SELECT starts_at, ends_at, max_uses FROM member_event_codes WHERE code = ? COLLATE NOCASE').get(normalized) as { starts_at: string; ends_at: string; max_uses: number } | null;
    if (event) {
      if (at < event.starts_at || at >= event.ends_at) return { valid: false, reason: 'inactive' };
      const uses = db.query('SELECT COUNT(*) AS count FROM member_event_uses WHERE code = ? COLLATE NOCASE').get(normalized) as { count: number };
      if (Number(uses.count) >= Number(event.max_uses)) return { valid: false, reason: 'exhausted' };
      return { valid: true, kind: 'event', referredReward: null, benefit: 'non-monetary', finalizesAt: iso(Date.parse(at) + EVENT_FINALIZATION_MS) };
    }
    return { valid: false, reason: 'invalid' };
  }

  return {
    provisionEventCode(input) {
      assertOpen();
      if (!input.code.trim() || !Number.isSafeInteger(input.maxUses) || input.maxUses < 1) throw new Error('invalid event code configuration');
      db.query(`INSERT INTO member_event_codes (code, starts_at, ends_at, max_uses, benefit_kind)
        VALUES (?, ?, ?, ?, 'non-monetary') ON CONFLICT(code) DO UPDATE SET
        starts_at = excluded.starts_at, ends_at = excluded.ends_at, max_uses = excluded.max_uses`).run(input.code.trim().toUpperCase(), EVENT_START, EVENT_END, input.maxUses);
    },
    recordSignupStart(networkKey, at, windowStartsAt, limit) {
      assertOpen();
      const networkHash = hash(networkKey || 'unknown');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.query('DELETE FROM member_oauth_start_attempts WHERE requested_at <= ?').run(windowStartsAt);
        const count = db.query('SELECT COUNT(*) AS count FROM member_oauth_start_attempts WHERE network_hash = ? AND requested_at > ?')
          .get(networkHash, windowStartsAt) as { count: number };
        if (Number(count.count) >= limit) { db.exec('COMMIT'); return false; }
        db.query('INSERT INTO member_oauth_start_attempts (network_hash, requested_at) VALUES (?, ?)').run(networkHash, at);
        db.exec('COMMIT');
        return true;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    consumeOAuthState(state, expiresAt, at = iso(nowMs())) {
      assertOpen();
      if (!state || state.length > 512 || !HASHED_OAUTH_STATE.test(state)) return false;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.query('DELETE FROM member_oauth_consumed_states WHERE expires_at <= ?').run(at);
        db.query('INSERT INTO member_oauth_consumed_states (state_hash, expires_at) VALUES (?, ?)').run(state, expiresAt);
        db.exec('COMMIT');
        return true;
      } catch (error) {
        db.exec('ROLLBACK');
        if (String(error).includes('UNIQUE constraint failed')) return false;
        throw error;
      }
    },
    validateCode: validate,
    register(identity, intent, at = iso(nowMs())) {
      assertOpen();
      if (!identity.sub || !identity.email || !identity.name || identity.emailVerified !== true) throw new Error('verified Google identity required');
      const consents = Object.entries(intent.consents);
      if (!consents.some(([policy, revision]) => policy === 'privacy' && revision.trim())
        || !consents.some(([policy, revision]) => policy === 'terms' && revision.trim())) throw new Error('privacy and terms consent required');
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db.query('SELECT * FROM members WHERE google_sub = ?').get(identity.sub) as Record<string, unknown> | null;
        let row: Record<string, unknown>;
        if (existing) {
          const memberId = String(existing.id);
          let eventCode = existing.event_code == null ? null : String(existing.event_code);
          if (intent.eventCode) {
            const requestedCode = intent.eventCode.trim().toUpperCase();
            if (eventCode && eventCode !== requestedCode) throw new Error('member already used a different event code');
            if (!eventCode) {
              const validation = validate(requestedCode, 'event', at);
              if (!validation.valid) throw new Error(`event code ${validation.reason}`);
              eventCode = requestedCode;
              db.query('UPDATE members SET event_code = ? WHERE id = ?').run(eventCode, memberId);
              db.query('INSERT INTO member_event_uses (code, member_id, used_at, finalizes_at) VALUES (?, ?, ?, ?)')
                .run(eventCode, memberId, at, iso(Date.parse(at) + EVENT_FINALIZATION_MS));
            }
          }
          db.query('UPDATE members SET email = ?, name = ?, updated_at = ? WHERE id = ?').run(identity.email, identity.name, at, memberId);
          row = db.query('SELECT * FROM members WHERE id = ?').get(memberId) as Record<string, unknown>;
          if (eventCode) insertAppSlot(memberId, at);
        } else {
          let inviter: string | null = null;
          if (intent.referralCode) {
            const referral = validate(intent.referralCode, 'referral', at);
            if (!referral.valid) throw new Error('invalid referral code');
            const referrer = db.query('SELECT id FROM members WHERE referral_code = ? COLLATE NOCASE').get(intent.referralCode.trim()) as { id: string } | null;
            inviter = referrer?.id ?? null;
          }
          let eventCode: string | null = null;
          if (intent.eventCode) {
            const event = validate(intent.eventCode, 'event', at);
            if (!event.valid) throw new Error(`event code ${event.reason}`);
            eventCode = intent.eventCode.trim().toUpperCase();
          }
          const id = randomUUID();
          let ownCode = referralCode();
          while (db.query('SELECT 1 FROM members WHERE referral_code = ?').get(ownCode)) ownCode = referralCode();
          db.query(`INSERT INTO members (id, google_sub, email, name, referral_code, invited_by, event_code, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, identity.sub, identity.email, identity.name, ownCode, inviter, eventCode, at, at);
          row = db.query('SELECT * FROM members WHERE id = ?').get(id) as Record<string, unknown>;
          db.query(`INSERT INTO member_plan_assignments (member_id, plan) VALUES (?, 'free')`).run(id);
          if (eventCode) {
            const finalizesAt = iso(Date.parse(at) + EVENT_FINALIZATION_MS);
            db.query('INSERT INTO member_event_uses (code, member_id, used_at, finalizes_at) VALUES (?, ?, ?, ?)').run(eventCode, id, at, finalizesAt);
            insertAppSlot(id, at);
          }
        }
        for (const [policy, revision] of consents) {
          db.query(`INSERT INTO member_consents (member_id, policy, revision, accepted_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(member_id, policy, revision) DO NOTHING`).run(String(row.id), policy, revision, at);
        }
        db.exec('COMMIT');
        return profile(row);
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    appSlotForMember(memberId) {
      assertOpen();
      return readAppSlot(memberId);
    },
    memberForGoogleSub(sub) {
      assertOpen();
      if (!sub || sub.length > 256) return null;
      const row = db.query('SELECT * FROM members WHERE google_sub = ?').get(sub) as Record<string, unknown> | null;
      return row ? profile(row) : null;
    },
    memberPlanForMember(memberId) {
      assertOpen();
      if (!memberId || memberId.length > 256) return null;
      const row = db.query(`SELECT a.plan, c.entitlements_json FROM member_plan_assignments a
        JOIN member_plan_catalog c ON c.plan = a.plan WHERE a.member_id = ?`).get(memberId) as { plan: string; entitlements_json: string } | null;
      if (!row) return null;
      try {
        const value: unknown = JSON.parse(row.entitlements_json);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        return { plan: row.plan, entitlements: value as Readonly<Record<string, unknown>> };
      } catch { return null; }
    },
    provisionPlan(input) {
      assertOpen();
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.plan)) throw new Error('invalid member plan key');
      const encoded = JSON.stringify(input.entitlements);
      if (typeof encoded !== 'string') throw new Error('invalid member plan entitlements');
      if (Buffer.byteLength(encoded) > 16 * 1024) throw new Error('member plan entitlements too large');
      db.query(`INSERT INTO member_plan_catalog (plan, entitlements_json) VALUES (?, ?)
        ON CONFLICT(plan) DO UPDATE SET entitlements_json = excluded.entitlements_json`).run(input.plan, encoded);
    },
    assignPlan(memberId, plan) {
      assertOpen();
      const result = db.query(`INSERT INTO member_plan_assignments (member_id, plan) VALUES (?, ?)
        ON CONFLICT(member_id) DO UPDATE SET plan = excluded.plan`).run(memberId, plan);
      return Number(result.changes) > 0;
    },
    createAppSlotForMember(memberId, at = iso(nowMs())) {
      assertOpen();
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = readAppSlot(memberId);
        if (existing) { db.exec('COMMIT'); return { outcome: 'already-exists', slot: existing }; }
        const member = db.query('SELECT event_code FROM members WHERE id = ?').get(memberId) as { event_code: string | null } | null;
        if (!member) { db.exec('COMMIT'); return { outcome: 'member-not-found' }; }
        if (!member.event_code) { db.exec('COMMIT'); return { outcome: 'event-code-required' }; }
        const slot = insertAppSlot(memberId, at);
        db.exec('COMMIT');
        return { outcome: 'created', slot };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    createSession(memberId, at = iso(nowMs())) {
      assertOpen();
      const token = randomBytes(32).toString('base64url');
      const expiresAt = iso(Date.parse(at) + SESSION_TTL_MS);
      db.query('INSERT INTO member_sessions (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(hash(token), memberId, at, expiresAt);
      return { token, expiresAt };
    },
    memberForSession(token, at = iso(nowMs())) {
      assertOpen();
      if (!token || token.length > 512) return null;
      const row = db.query(`SELECT m.* FROM member_sessions s JOIN members m ON m.id = s.member_id
        WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`).get(hash(token), at) as Record<string, unknown> | null;
      return row ? profile(row) : null;
    },
    requestDeletion(token, at = iso(nowMs())) {
      assertOpen();
      const session = db.query('SELECT member_id FROM member_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?').get(hash(token), at) as { member_id: string } | null;
      if (!session) return false;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.query(`INSERT INTO member_deletion_requests (id, member_id, requested_at) VALUES (?, ?, ?)`)
          .run(randomUUID(), session.member_id, at);
        db.query('UPDATE member_sessions SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').run(at, session.member_id);
        db.exec('COMMIT');
        return true;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
