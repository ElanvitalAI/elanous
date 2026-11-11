import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nexusRootDir } from '../paths.js';
import { createAppLifecycleEvent, validateAppLifecycleEvent, type AppLifecycleEvent } from '../apps/app-lifecycle-ledger.js';

export interface MemberSignupIntent {
  readonly consents: Readonly<Record<string, string>>;
  readonly referralCode?: string;
  readonly eventCode?: string;
  /** OAuth-only native return URI; it is carried inside the encrypted state cookie, never persisted on the member. */
  readonly appRedirectUri?: string;
  /** S256 challenge for the verifier retained by the native app, preventing custom-scheme interception. */
  readonly appCodeChallenge?: string;
}

export interface MemberAppAuthCode {
  readonly appId: string;
  readonly memberId: string;
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

export interface MemberKeyInfo { readonly id: string; readonly name: string; readonly createdAt: string; readonly lastUsedAt: string | null }
export interface IssuedMemberKey extends MemberKeyInfo { readonly key: string }
export interface MemberRegistration extends MemberProfile { readonly initialKey?: IssuedMemberKey; readonly session: { readonly token: string; readonly expiresAt: string } }
export interface MemberKeyMatch { readonly memberId: string; readonly keyId: string }
export interface MemberAccessToken { readonly token: string; readonly memberId: string; readonly scopes: string[]; readonly expiresAt: string }
export interface MemberAccessMatch extends MemberKeyMatch { readonly scopes: string[]; readonly audience: string | null }

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
  activeReferralCodeForMember(memberId: string): string | null;
  referralsForMember(memberId: string): Array<{ inviteeId: string; referralCode: string; eventCode: string | null; invitedAt: string }>;
  rotateReferralCode(memberId: string, now?: string): string;
  revokeReferralCode(memberId: string, now?: string): boolean;
  provisionEventCode(input: {
    readonly code: string;
    readonly maxUses: number;
    readonly startsAt?: string;
    readonly endsAt?: string;
  }): void;
  recordSignupStart(networkKey: string, at: string, windowStartsAt: string, limit: number): boolean;
  consumeOAuthState(state: string, expiresAt: string, now?: string): boolean;
  createAppAuthCode?(input: { readonly code: string; readonly state: string; readonly codeChallenge: string; readonly memberId: string; readonly appId: string; readonly expiresAt: string }, now?: string): void;
  consumeAppAuthCode?(code: string, state: string, codeVerifier: string, now?: string): MemberAppAuthCode | null;
  pruneExpiredAppAuthCodes?(now?: string): number;
  validateCode(code: string, kind?: 'referral' | 'event', now?: string): MemberCodeValidation;
  register(identity: GoogleMemberIdentity, intent: MemberSignupIntent, now?: string): MemberRegistration;
  createMemberKey(memberId: string, name: string, now?: string, deliver?: (issued: IssuedMemberKey) => void): IssuedMemberKey;
  listMemberKeys(memberId: string): MemberKeyInfo[];
  revokeMemberKey(memberId: string, keyId: string, now?: string): boolean;
  rotateMemberKey(memberId: string, keyId: string, now?: string, deliver?: (issued: IssuedMemberKey) => void): IssuedMemberKey;
  memberForKey(key: string, now?: string): MemberKeyMatch | null;
  mintMemberAccessToken(keyId: string, memberId: string, scopes: string[], ttlSec: number, audience?: string, now?: string): MemberAccessToken;
  memberForAccessToken(token: string, scope: string, audience?: string, now?: string): MemberAccessMatch | null;
  listMemberAccessTokens(memberId: string): Array<{ id: string; scopes: string[]; expiresAt: string; createdAt: string }>;
  revokeMemberAccessToken(memberId: string, tokenId: string, now?: string): boolean;
  memberForGoogleSub(sub: string): MemberProfile | null;
  memberPlanForMember(memberId: string): MemberPlanEntitlements | null;
  provisionPlan(input: { readonly plan: string; readonly entitlements: Readonly<Record<string, unknown>> }): void;
  assignPlan(memberId: string, plan: string): boolean;
  appSlotForMember(memberId: string): MemberAppSlot | null;
  createAppSlotForMember(memberId: string, now?: string): MemberAppSlotCreation;
  createSession(memberId: string, now?: string): { token: string; expiresAt: string };
  memberForSession(token: string, now?: string): MemberProfile | null;
  reserveEventTry(memberId: string, eventCode: string, maxAttempts: number, now?: string): string | null;
  completeEventTry(reservationId: string, now?: string): boolean;
  releaseEventTry(reservationId: string): boolean;
  requestDeletion(token: string, now?: string): boolean;
  close(): void;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
// Source: KCB try execution is deadline-capped; this lease permits process recovery after a crash.
const MEMBER_TRY_RESERVATION_TTL_MS = 2 * 60_000;
const EVENT_START = '2026-11-13T15:00:00.000Z'; // 2026-11-14 00:00 Asia/Seoul
const EVENT_END = '2026-11-15T15:00:00.000Z';   // 2026-11-16 00:00 Asia/Seoul
const EVENT_WINDOW_ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/; // Source: event-window inputs use ISO 8601 extended date-time form.
const EVENT_FINALIZATION_MS = 14 * 24 * 60 * 60_000;
const HASHED_OAUTH_STATE = /^[a-f0-9]{64}$/;
const APP_AUTH_CODE_CLEANUP_INTERVAL_MS = 60_000;
const APP_AUTH_CODE_VALUE = /^[A-Za-z0-9_-]{32,128}$/;
const APP_AUTH_CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const APP_AUTH_CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
export const KAIST_APP_TEMPLATE_SLUG = 'next-app-lecture-scrap';

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function iso(value: string | number | Date): string { return new Date(value).toISOString(); }
function eventWindowTimestamp(value: string | undefined, fallback: string): string | null {
  const timestamp = value ?? fallback;
  const match = EVENT_WINDOW_ISO_TIMESTAMP.exec(timestamp);
  if (!match) return null;
  const [, year, month, day, hour, minute, providedSecond, fraction = ''] = match;
  const second = providedSecond ?? '00';
  const datePrefix = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const localDateTime = new Date(`${datePrefix}.${fraction.padEnd('000'.length, '0')}Z`);
  if (!Number.isFinite(localDateTime.getTime()) || !localDateTime.toISOString().startsWith(`${datePrefix}.`)) return null;
  const milliseconds = Date.parse(timestamp);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}
function referralCode(): string { return randomBytes(16).toString('base64url'); }
function base62(bytes: Buffer): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let encoded = '';
  do { encoded = alphabet[Number(value % 62n)]! + encoded; value /= 62n; } while (value > 0n);
  return encoded;
}
function newMemberKey(): string { return `emk_${base62(randomBytes(32))}`; }
function keyDigest(salt: string, key: string): string { return hash(`${salt}:${key}`); }

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
    CREATE TABLE IF NOT EXISTS member_referral_codes (
      code TEXT PRIMARY KEY COLLATE BINARY, member_id TEXT NOT NULL REFERENCES members(id),
      created_at TEXT NOT NULL, revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS member_referral_codes_owner ON member_referral_codes(member_id, revoked_at);
    CREATE TABLE IF NOT EXISTS member_referrals (
      invitee_id TEXT PRIMARY KEY REFERENCES members(id), inviter_id TEXT NOT NULL REFERENCES members(id),
      code TEXT NOT NULL COLLATE BINARY REFERENCES member_referral_codes(code),
      event_code TEXT, invited_at TEXT NOT NULL,
      CHECK(invitee_id != inviter_id)
    );
    CREATE INDEX IF NOT EXISTS member_referrals_inviter ON member_referrals(inviter_id, invited_at);
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
    CREATE TABLE IF NOT EXISTS member_app_auth_codes (
      code_hash TEXT PRIMARY KEY, state_hash TEXT NOT NULL, code_challenge TEXT NOT NULL, member_id TEXT NOT NULL REFERENCES members(id),
      app_id TEXT NOT NULL REFERENCES member_app_slots(app_id), expires_at TEXT NOT NULL, consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS member_app_auth_codes_expiry ON member_app_auth_codes(expires_at);
    CREATE TABLE IF NOT EXISTS member_oauth_start_attempts (
      network_hash TEXT NOT NULL, requested_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS member_oauth_start_attempts_network_time ON member_oauth_start_attempts(network_hash, requested_at);
    CREATE TABLE IF NOT EXISTS member_sessions (
      token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id),
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS member_sessions_member ON member_sessions(member_id, expires_at);
    CREATE TABLE IF NOT EXISTS member_event_try_attempts (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), event_code TEXT NOT NULL,
      requested_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('reserved', 'completed')),
      reservation_expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS member_event_try_attempts_member ON member_event_try_attempts(member_id, event_code);
    CREATE TABLE IF NOT EXISTS member_key_salts (
      member_id TEXT PRIMARY KEY REFERENCES members(id), salt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS member_keys (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), name TEXT NOT NULL,
      key_hash TEXT NOT NULL, lookup_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS member_keys_member ON member_keys(member_id, revoked_at);
    CREATE TABLE IF NOT EXISTS member_access_tokens (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), key_id TEXT NOT NULL REFERENCES member_keys(id),
      token_hash TEXT NOT NULL, scopes_json TEXT NOT NULL, audience TEXT,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS member_access_tokens_member ON member_access_tokens(member_id, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS member_access_tokens_hash ON member_access_tokens(token_hash);
    CREATE TABLE IF NOT EXISTS member_key_events (
      id TEXT PRIMARY KEY, actor_member_id TEXT NOT NULL REFERENCES members(id), key_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('created', 'revoked', 'rotated-out')), at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS member_deletion_requests (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), requested_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'cancelled'))
    );
    DROP TABLE IF EXISTS member_signup_states;
  `);
  // Old referral tables used NOCASE, which made each mixed-case secret accept many spellings.
  // Rebuild both linked tables once, preserving the exact bytes of every issued code and ledger row.
  const referralSchema = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'member_referral_codes'").get() as { sql: string }).sql;
  if (/code\s+TEXT\s+PRIMARY KEY\s+COLLATE\s+NOCASE/i.test(referralSchema)) {
    db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
    try {
      db.exec(`
        CREATE TABLE member_referral_codes_exact (
          code TEXT PRIMARY KEY COLLATE BINARY, member_id TEXT NOT NULL REFERENCES members(id),
          created_at TEXT NOT NULL, revoked_at TEXT
        );
        INSERT INTO member_referral_codes_exact SELECT code, member_id, created_at, revoked_at FROM member_referral_codes;
        CREATE TABLE member_referrals_exact (
          invitee_id TEXT PRIMARY KEY REFERENCES members(id), inviter_id TEXT NOT NULL REFERENCES members(id),
          code TEXT NOT NULL COLLATE BINARY REFERENCES member_referral_codes(code),
          event_code TEXT, invited_at TEXT NOT NULL, CHECK(invitee_id != inviter_id)
        );
        INSERT INTO member_referrals_exact
          SELECT r.invitee_id, r.inviter_id, c.code, r.event_code, r.invited_at
          FROM member_referrals r JOIN member_referral_codes c ON c.code = r.code COLLATE NOCASE;
      `);
      const oldRows = (db.query('SELECT COUNT(*) AS count FROM member_referrals').get() as { count: number }).count;
      const copiedRows = (db.query('SELECT COUNT(*) AS count FROM member_referrals_exact').get() as { count: number }).count;
      if (oldRows !== copiedRows) throw new Error('referral migration lost ledger rows');
      db.exec(`
        DROP TABLE member_referrals;
        DROP TABLE member_referral_codes;
        ALTER TABLE member_referral_codes_exact RENAME TO member_referral_codes;
        ALTER TABLE member_referrals_exact RENAME TO member_referrals;
        CREATE INDEX member_referral_codes_owner ON member_referral_codes(member_id, revoked_at);
        CREATE INDEX member_referrals_inviter ON member_referrals(inviter_id, invited_at);
      `);
      const foreignKeyErrors = db.query('PRAGMA foreign_key_check').all();
      if (foreignKeyErrors.length) throw new Error(`referral migration foreign key mismatch: ${JSON.stringify(foreignKeyErrors)}`);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
  // Preserve existing links and attribution when opening a pre-referral-ledger database.
  db.query(`INSERT OR IGNORE INTO member_referral_codes (code, member_id, created_at)
    SELECT referral_code, id, created_at FROM members`).run();
  db.query(`INSERT OR IGNORE INTO member_referrals (invitee_id, inviter_id, code, event_code, invited_at)
    SELECT invited.id, invited.invited_by, inviter.referral_code, invited.event_code, invited.created_at
    FROM members invited JOIN members inviter ON inviter.id = invited.invited_by
    WHERE invited.invited_by IS NOT NULL AND invited.id != invited.invited_by`).run();
  const eventTryColumns = db.query('PRAGMA table_info(member_event_try_attempts)').all() as Array<{ name: string }>;
  if (!eventTryColumns.some(column => column.name === 'status')) {
    db.exec("ALTER TABLE member_event_try_attempts ADD COLUMN status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('reserved', 'completed'))");
  }
  if (!eventTryColumns.some(column => column.name === 'reservation_expires_at')) {
    db.exec('ALTER TABLE member_event_try_attempts ADD COLUMN reservation_expires_at TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS member_event_try_attempts_reservation_expiry ON member_event_try_attempts(status, reservation_expires_at)');
  const appAuthColumns = db.query('PRAGMA table_info(member_app_auth_codes)').all() as Array<{ name: string }>;
  if (!appAuthColumns.some(column => column.name === 'code_challenge')) {
    // Existing installations can have one-time codes from the pre-PKCE schema. A nullable
    // column makes the migration safe; those old rows fail closed because exchange requires a match.
    db.exec('ALTER TABLE member_app_auth_codes ADD COLUMN code_challenge TEXT');
  }
  // 0.3.9 ships only the free plan and an empty entitlement map. Further plans are catalog rows,
  // never branches or numeric limits in application code.
  db.query(`INSERT OR IGNORE INTO member_plan_catalog (plan, entitlements_json) VALUES ('free', '{}')`).run();
  // Existing free members gain relay access through the plan data seam, including upgraded databases.
  db.query(`UPDATE member_plan_catalog SET entitlements_json = json_set(entitlements_json, '$."relay.connect"', json('true'))
    WHERE plan = 'free' AND json_type(entitlements_json, '$."relay.connect"') IS NULL`).run();
  db.query(`INSERT OR IGNORE INTO member_plan_assignments (member_id, plan)
    SELECT id, 'free' FROM members`).run();
  const nowMs = options.now ?? Date.now;
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error('member store is closed'); };
  const pruneExpiredAppAuthCodes = (at: string): number => Number(db.query(`DELETE FROM member_app_auth_codes
    WHERE expires_at <= ? OR consumed_at IS NOT NULL`).run(at).changes);
  const appAuthCodeCleanupTimer = setInterval(() => {
    if (closed) return;
    try { pruneExpiredAppAuthCodes(iso(nowMs())); } catch { /* cleanup retries on the next interval or exchange */ }
  }, APP_AUTH_CODE_CLEANUP_INTERVAL_MS);
  appAuthCodeCleanupTimer.unref();

  function profile(row: Record<string, unknown>): MemberProfile {
    return {
      id: String(row.id), email: String(row.email), name: String(row.name), referralCode: String(row.referral_code),
      invitedBy: row.invited_by == null ? null : String(row.invited_by),
      eventCode: row.event_code == null ? null : String(row.event_code), createdAt: String(row.created_at),
    };
  }

  function keyInfo(row: Record<string, unknown>): MemberKeyInfo {
    return { id: String(row.id), name: String(row.name), createdAt: String(row.created_at),
      lastUsedAt: row.last_used_at == null ? null : String(row.last_used_at) };
  }

  function insertMemberKey(memberId: string, name: string, at: string): IssuedMemberKey {
    const exists = db.query('SELECT 1 FROM members WHERE id = ?').get(memberId);
    if (!exists) throw new Error('member not found');
    const salt = db.query('SELECT salt FROM member_key_salts WHERE member_id = ?').get(memberId) as { salt: string } | null;
    const memberSalt = salt?.salt ?? randomBytes(32).toString('hex');
    if (!salt) db.query('INSERT INTO member_key_salts (member_id, salt) VALUES (?, ?)').run(memberId, memberSalt);
    const id = randomUUID();
    const key = newMemberKey();
    // The random 256-bit key has enough entropy for an indexed global digest; the
    // per-member salted digest remains the verifier and raw key is never persisted.
    db.query(`INSERT INTO member_keys (id, member_id, name, key_hash, lookup_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, memberId, name, keyDigest(memberSalt, key), hash(key), at);
    db.query(`INSERT INTO member_key_events (id, actor_member_id, key_id, action, at) VALUES (?, ?, ?, 'created', ?)`)
      .run(randomUUID(), memberId, id, at);
    return { id, name, key, createdAt: at, lastUsedAt: null };
  }

  function insertSession(memberId: string, at: string): { token: string; expiresAt: string } {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = iso(Date.parse(at) + SESSION_TTL_MS);
    db.query('INSERT INTO member_sessions (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(hash(token), memberId, at, expiresAt);
    return { token, expiresAt };
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
    const exact = code.trim();
    if (!exact || exact.length > 80) return { valid: false, reason: 'invalid' };
    if (kind !== 'event') {
      const referral = db.query('SELECT member_id FROM member_referral_codes WHERE code = ? COLLATE BINARY AND revoked_at IS NULL').get(exact) as { member_id: string } | null;
      if (referral) return { valid: true, kind: 'referral', referredReward: 'none' };
      if (kind === 'referral') return { valid: false, reason: 'invalid' };
    }
    const normalized = exact.toUpperCase();
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
    activeReferralCodeForMember(memberId) {
      assertOpen();
      return (db.query(`SELECT code FROM member_referral_codes WHERE member_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`).get(memberId) as { code: string } | null)?.code ?? null;
    },
    referralsForMember(memberId) {
      assertOpen();
      return (db.query(`SELECT invitee_id, code, event_code, invited_at FROM member_referrals
        WHERE inviter_id = ? ORDER BY invited_at, invitee_id`).all(memberId) as Array<{ invitee_id: string; code: string; event_code: string | null; invited_at: string }>)
        .map(row => ({ inviteeId: row.invitee_id, referralCode: row.code, eventCode: row.event_code, invitedAt: row.invited_at }));
    },
    rotateReferralCode(memberId, at = iso(nowMs())) {
      assertOpen();
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!db.query('SELECT 1 FROM members WHERE id = ?').get(memberId)) throw new Error('member not found');
        let code = referralCode();
        while (db.query('SELECT 1 FROM member_referral_codes WHERE code = ? COLLATE BINARY').get(code)) code = referralCode();
        db.query('UPDATE member_referral_codes SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').run(at, memberId);
        db.query('INSERT INTO member_referral_codes (code, member_id, created_at) VALUES (?, ?, ?)').run(code, memberId, at);
        db.query('UPDATE members SET referral_code = ?, updated_at = ? WHERE id = ?').run(code, at, memberId);
        db.exec('COMMIT');
        return code;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    revokeReferralCode(memberId, at = iso(nowMs())) {
      assertOpen();
      return Number(db.query('UPDATE member_referral_codes SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').run(at, memberId).changes) > 0;
    },
    provisionEventCode(input) {
      assertOpen();
      if (!input.code.trim() || !Number.isSafeInteger(input.maxUses) || input.maxUses < 1) throw new Error('invalid event code configuration');
      const startsAt = eventWindowTimestamp(input.startsAt, EVENT_START);
      const endsAt = eventWindowTimestamp(input.endsAt, EVENT_END);
      if (!startsAt || !endsAt || startsAt >= endsAt) throw new Error('invalid event code configuration');
      db.query(`INSERT INTO member_event_codes (code, starts_at, ends_at, max_uses, benefit_kind)
        VALUES (?, ?, ?, ?, 'non-monetary') ON CONFLICT(code) DO UPDATE SET
        starts_at = excluded.starts_at, ends_at = excluded.ends_at, max_uses = excluded.max_uses`).run(input.code.trim().toUpperCase(), startsAt, endsAt, input.maxUses);
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
    createAppAuthCode(input, at = iso(nowMs())) {
      assertOpen();
      if (!APP_AUTH_CODE_VALUE.test(input.code) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.state)
        || !APP_AUTH_CODE_CHALLENGE.test(input.codeChallenge)
        || !input.memberId || !input.appId || !Number.isFinite(Date.parse(input.expiresAt))
        || iso(input.expiresAt) !== input.expiresAt || input.expiresAt <= at) {
        throw new Error('invalid app auth code');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const slot = db.query('SELECT 1 AS found FROM member_app_slots WHERE app_id = ? AND member_id = ?').get(input.appId, input.memberId);
        if (!slot) throw new Error('app auth code owner does not match app slot');
        pruneExpiredAppAuthCodes(at);
        db.query(`INSERT INTO member_app_auth_codes (code_hash, state_hash, code_challenge, member_id, app_id, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(hash(input.code), hash(input.state), input.codeChallenge, input.memberId, input.appId, input.expiresAt);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    consumeAppAuthCode(code, state, codeVerifier, at = iso(nowMs())) {
      assertOpen();
      if (!APP_AUTH_CODE_VALUE.test(code) || !/^[A-Za-z0-9_-]{1,128}$/.test(state) || !APP_AUTH_CODE_VERIFIER.test(codeVerifier)) return null;
      db.exec('BEGIN IMMEDIATE');
      try {
        pruneExpiredAppAuthCodes(at);
        const codeHash = hash(code);
        const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
        const row = db.query(`SELECT app_id, member_id FROM member_app_auth_codes
          WHERE code_hash = ? AND state_hash = ? AND code_challenge = ? AND consumed_at IS NULL AND expires_at > ?`).get(codeHash, hash(state), codeChallenge, at) as
          { app_id: string; member_id: string } | null;
        if (!row) { db.exec('COMMIT'); return null; }
        const updated = db.query(`UPDATE member_app_auth_codes SET consumed_at = ?
          WHERE code_hash = ? AND state_hash = ? AND code_challenge = ? AND consumed_at IS NULL AND expires_at > ?`).run(at, codeHash, hash(state), codeChallenge, at);
        if (Number(updated.changes) !== 1) { db.exec('COMMIT'); return null; }
        db.exec('COMMIT');
        return { appId: row.app_id, memberId: row.member_id };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    pruneExpiredAppAuthCodes(at = iso(nowMs())) { assertOpen(); return pruneExpiredAppAuthCodes(at); },
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
        let initialKey: IssuedMemberKey | undefined;
        if (existing) {
          const memberId = String(existing.id);
          if (intent.referralCode) throw new Error('existing member cannot accept another referral');
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
            const referrer = db.query('SELECT member_id FROM member_referral_codes WHERE code = ? COLLATE BINARY AND revoked_at IS NULL').get(intent.referralCode.trim()) as { member_id: string } | null;
            inviter = referrer?.member_id ?? null;
          }
          let eventCode: string | null = null;
          if (intent.eventCode) {
            const event = validate(intent.eventCode, 'event', at);
            if (!event.valid) throw new Error(`event code ${event.reason}`);
            eventCode = intent.eventCode.trim().toUpperCase();
          }
          const id = randomUUID();
          let ownCode = referralCode();
          while (db.query('SELECT 1 FROM member_referral_codes WHERE code = ? COLLATE BINARY').get(ownCode)) ownCode = referralCode();
          db.query(`INSERT INTO members (id, google_sub, email, name, referral_code, invited_by, event_code, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, identity.sub, identity.email, identity.name, ownCode, inviter, eventCode, at, at);
          db.query('INSERT INTO member_referral_codes (code, member_id, created_at) VALUES (?, ?, ?)').run(ownCode, id, at);
          if (inviter) db.query(`INSERT INTO member_referrals (invitee_id, inviter_id, code, event_code, invited_at)
            VALUES (?, ?, ?, ?, ?)`).run(id, inviter, intent.referralCode!.trim(), eventCode, at);
          initialKey = insertMemberKey(id, 'signup', at);
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
        const session = insertSession(String(row.id), at);
        db.exec('COMMIT');
        return { ...profile(row), ...(initialKey ? { initialKey } : {}), session };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    createMemberKey(memberId, name, at = iso(nowMs()), deliver) {
      assertOpen();
      if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(name)) throw new Error('invalid member key name');
      db.exec('BEGIN IMMEDIATE');
      try { const issued = insertMemberKey(memberId, name, at); deliver?.(issued); db.exec('COMMIT'); return issued; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    listMemberKeys(memberId) {
      assertOpen();
      return (db.query(`SELECT id, name, created_at, last_used_at FROM member_keys WHERE member_id = ? AND revoked_at IS NULL ORDER BY created_at, id`)
        .all(memberId) as Record<string, unknown>[]).map(keyInfo);
    },
    revokeMemberKey(memberId, keyId, at = iso(nowMs())) {
      assertOpen();
      db.exec('BEGIN IMMEDIATE');
      try {
        const changed = Number(db.query(`UPDATE member_keys SET revoked_at = ? WHERE id = ? AND member_id = ? AND revoked_at IS NULL`)
          .run(at, keyId, memberId).changes) > 0;
        if (changed) db.query(`INSERT INTO member_key_events (id, actor_member_id, key_id, action, at) VALUES (?, ?, ?, 'revoked', ?)`)
          .run(randomUUID(), memberId, keyId, at);
        db.exec('COMMIT');
        return changed;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    rotateMemberKey(memberId, keyId, at = iso(nowMs()), deliver) {
      assertOpen();
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.query(`SELECT name FROM member_keys WHERE id = ? AND member_id = ? AND revoked_at IS NULL`)
          .get(keyId, memberId) as { name: string } | null;
        if (!row) throw new Error('member key not found');
        db.query(`UPDATE member_keys SET revoked_at = ? WHERE id = ?`).run(at, keyId);
        db.query(`INSERT INTO member_key_events (id, actor_member_id, key_id, action, at) VALUES (?, ?, ?, 'rotated-out', ?)`)
          .run(randomUUID(), memberId, keyId, at);
        const issued = insertMemberKey(memberId, row.name, at);
        deliver?.(issued);
        db.exec('COMMIT');
        return issued;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    memberForKey(key, at = iso(nowMs())) {
      assertOpen();
      if (typeof key !== 'string' || !/^emk_[A-Za-z0-9]{1,43}$/.test(key)) return null;
      const row = db.query(`SELECT k.id, k.member_id, k.key_hash, s.salt FROM member_keys k
        JOIN member_key_salts s ON s.member_id = k.member_id
        WHERE k.lookup_hash = ? AND k.revoked_at IS NULL`).get(hash(key)) as
        { id: string; member_id: string; key_hash: string; salt: string } | null;
      if (!row) return null;
      const digest = Buffer.from(keyDigest(row.salt, key), 'hex');
      const stored = Buffer.from(row.key_hash, 'hex');
      const found: MemberKeyMatch | null = stored.length === digest.length && timingSafeEqual(digest, stored)
        ? { memberId: row.member_id, keyId: row.id } : null;
      if (found) db.query('UPDATE member_keys SET last_used_at = ? WHERE id = ?').run(at, found.keyId);
      return found;
    },
    mintMemberAccessToken(keyId, memberId, scopes, ttlSec, audience, at = iso(nowMs())) {
      assertOpen();
      // NUMGUARD: short lived by default; cap at 24h so a leaked token cannot persist indefinitely.
      if (!Number.isSafeInteger(ttlSec) || ttlSec < 1 || ttlSec > 86_400) throw new Error('invalid token ttl');
      if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 16 || scopes.some(scope => !/^[a-z]+(?:\.[a-z]+)+$/.test(scope))) throw new Error('invalid scopes');
      if (audience !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(audience)) throw new Error('invalid audience');
      const key = db.query('SELECT 1 FROM member_keys WHERE id = ? AND member_id = ? AND revoked_at IS NULL').get(keyId, memberId);
      if (!key) throw new Error('member key inactive');
      const token = `emt_${base62(randomBytes(32))}`;
      const expiresAt = iso(Date.parse(at) + ttlSec * 1000);
      db.query(`INSERT INTO member_access_tokens (id, member_id, key_id, token_hash, scopes_json, audience, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), memberId, keyId, hash(token), JSON.stringify([...new Set(scopes)]), audience ?? null, at, expiresAt);
      return { token, memberId, scopes: [...new Set(scopes)], expiresAt };
    },
    memberForAccessToken(token, scope, audience, at = iso(nowMs())) {
      assertOpen();
      if (!/^emt_[A-Za-z0-9]{1,43}$/.test(token)) return null;
      const digest = Buffer.from(hash(token), 'hex');
      const rows = db.query(`SELECT t.member_id, t.key_id, t.token_hash, t.scopes_json, t.audience, c.entitlements_json FROM member_access_tokens t
        JOIN member_keys k ON k.id = t.key_id AND k.revoked_at IS NULL
        JOIN member_plan_assignments a ON a.member_id = t.member_id
        JOIN member_plan_catalog c ON c.plan = a.plan
        WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?`).all(hash(token), at) as Array<{ member_id: string; key_id: string; token_hash: string; scopes_json: string; audience: string | null; entitlements_json: string }>;
      let found: MemberAccessMatch | null = null;
      for (const row of rows) {
        const stored = Buffer.from(row.token_hash, 'hex');
        const matches = stored.length === digest.length && timingSafeEqual(stored, digest);
        if (!matches) continue;
        const scopes = JSON.parse(row.scopes_json) as string[];
        const entitlements = JSON.parse(row.entitlements_json) as Record<string, unknown>;
        if (scopes.includes(scope) && entitlements[scope] === true && (row.audience === null || row.audience === audience))
          found = { memberId: row.member_id, keyId: row.key_id, scopes, audience: row.audience };
      }
      return found;
    },
    listMemberAccessTokens(memberId) {
      assertOpen();
      const rows = db.query(`SELECT id, scopes_json, created_at, expires_at FROM member_access_tokens
        WHERE member_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`).all(memberId) as
        Array<{ id: string; scopes_json: string; created_at: string; expires_at: string }>;
      return rows.map(row => ({ id: row.id, scopes: JSON.parse(row.scopes_json) as string[], createdAt: row.created_at, expiresAt: row.expires_at }));
    },
    revokeMemberAccessToken(memberId, tokenId, at = iso(nowMs())) {
      assertOpen();
      return db.query(`UPDATE member_access_tokens SET revoked_at = ? WHERE id = ? AND member_id = ? AND revoked_at IS NULL`)
        .run(at, tokenId, memberId).changes > 0;
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
      return insertSession(memberId, at);
    },
    memberForSession(token, at = iso(nowMs())) {
      assertOpen();
      if (!token || token.length > 512) return null;
      const row = db.query(`SELECT m.* FROM member_sessions s JOIN members m ON m.id = s.member_id
        WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`).get(hash(token), at) as Record<string, unknown> | null;
      return row ? profile(row) : null;
    },
    reserveEventTry(memberId, eventCode, maxAttempts, at = iso(nowMs())) {
      assertOpen();
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) return null;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.query(`DELETE FROM member_event_try_attempts WHERE status = 'reserved' AND reservation_expires_at <= ?`).run(at);
        const member = db.query('SELECT event_code FROM members WHERE id = ?').get(memberId) as { event_code: string | null } | null;
        const count = db.query('SELECT count(*) AS n FROM member_event_try_attempts WHERE member_id = ? AND event_code = ?')
          .get(memberId, eventCode) as { n: number };
        if (member?.event_code?.toUpperCase() !== eventCode.toUpperCase() || count.n >= maxAttempts) {
          db.exec('COMMIT');
          return null;
        }
        const reservationId = randomUUID();
        const expiresAt = iso(Date.parse(at) + MEMBER_TRY_RESERVATION_TTL_MS);
        db.query(`INSERT INTO member_event_try_attempts (id, member_id, event_code, requested_at, status, reservation_expires_at)
          VALUES (?, ?, ?, ?, 'reserved', ?)`).run(reservationId, memberId, eventCode, at, expiresAt);
        db.exec('COMMIT');
        return reservationId;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    completeEventTry(reservationId, at = iso(nowMs())) {
      assertOpen();
      return Number(db.query(`UPDATE member_event_try_attempts SET status = 'completed', reservation_expires_at = NULL
        WHERE id = ? AND status = 'reserved' AND reservation_expires_at > ?`).run(reservationId, at).changes) > 0;
    },
    releaseEventTry(reservationId) {
      assertOpen();
      return Number(db.query(`DELETE FROM member_event_try_attempts WHERE id = ? AND status = 'reserved'`).run(reservationId).changes) > 0;
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
    close() { if (!closed) { closed = true; clearInterval(appAuthCodeCleanupTimer); db.close(); } },
  };
}
