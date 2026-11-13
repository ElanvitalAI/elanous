/** Member-owned cloud credentials. This service receives a principal from a trusted
 * server caller; the authentication route and live cloud binding are later slices. */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import type { SecretBackend } from '../config/secrets/types.js';
import type { MemberStore, MemberPlanEntitlements } from './member-store.js';

export interface TrustedVaultPrincipal {
  readonly memberId: string;
  readonly sessionExpiresAt: string;
  readonly sessionRevoked?: boolean;
}

export interface VaultMetadata {
  readonly id: string;
  readonly provider: 'gcp' | 'aws';
  readonly purposes: readonly string[];
  readonly generation: number;
  readonly state: 'active' | 'pending-deletion';
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

type VaultRow = {
  id: string; owner: string; provider: 'gcp' | 'aws'; purposes: string;
  generation: number; pending_generation: number | null; generation_highwater: number;
  state: 'pending' | 'active' | 'deleting' | 'deleted';
  created_at: string; revoked_at: string | null;
};

export interface CloudSecretVaultOptions {
  readonly dbPath: string;
  readonly backend: SecretBackend;
  readonly memberStore: Pick<MemberStore, 'memberPlanForMember'>;
  /** Supplied by the trusted server caller; no user body or auth route is consulted here. */
  readonly isPrincipalActive: (principal: TrustedVaultPrincipal) => boolean;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

const PURPOSE = /^[a-z][a-z0-9.-]{0,63}$/;
const MAX_VALUE_BYTES = 8 * 1024;
const MAX_SECRETS = 5;
// Source: TC #27113 — a pending remote write must stay fenced from orphan cleanup.
const PENDING_WRITE_LEASE_MS = 5 * 60_000;

function deny(code: string): never { throw new Error(`CLOUD_VAULT_${code}`); }
function remoteId(id: string, generation: number): string { return `member-vault/${id}/v${generation}`; }
function cleanPurposes(purposes: readonly string[]): string[] {
  if (!Array.isArray(purposes) || purposes.length === 0 || purposes.length > 16
    || purposes.some(p => typeof p !== 'string' || !PURPOSE.test(p))) deny('PURPOSE_INVALID');
  return [...new Set(purposes)].sort();
}
function limit(plan: MemberPlanEntitlements, key: string, fallback: number): number {
  const value = plan.entitlements[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) deny('PLAN_INVALID');
  return value;
}

export function createCloudSecretVault(options: CloudSecretVaultOptions) {
  mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(options.dbPath, { create: true });
  chmodSync(options.dbPath, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS vault_secrets (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, provider TEXT NOT NULL, purposes TEXT NOT NULL,
    generation INTEGER NOT NULL, pending_generation INTEGER, state TEXT NOT NULL,
    created_at TEXT NOT NULL, revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS vault_owner_state ON vault_secrets(owner, state);
  CREATE TABLE IF NOT EXISTS vault_cleanup (
    remote_id TEXT PRIMARY KEY, secret_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
    lease_expires_at TEXT, retain INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0, last_deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS vault_audit (id INTEGER PRIMARY KEY, secret_id TEXT NOT NULL, event TEXT NOT NULL, at TEXT NOT NULL);
  `);
  // A concurrent service may win an ALTER race. Only accept that error when the
  // required column is now present. Existing cleanup rows reserve old generations.
  const hasColumn = (table: string, column: string) =>
    (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(entry => entry.name === column);
  const addColumn = (table: string, column: string, definition: string) => {
    if (hasColumn(table, column)) return;
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); }
    catch (error) { if (!hasColumn(table, column)) throw error; }
  };
  // Hold the SQLite writer lock from schema upgrade through the last legacy
  // cleanup reservation. A second opener cannot expose rotate() between the
  // highwater snapshot and its backfill, even across separate processes.
  db.exec('BEGIN IMMEDIATE');
  try {
    addColumn('vault_secrets', 'generation_highwater', 'INTEGER NOT NULL DEFAULT 1');
    addColumn('vault_cleanup', 'lease_expires_at', 'TEXT');
    addColumn('vault_cleanup', 'retain', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('vault_cleanup', 'version', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('vault_cleanup', 'last_deleted_at', 'TEXT');
    db.exec('UPDATE vault_secrets SET generation_highwater=MAX(generation_highwater,generation,COALESCE(pending_generation,0))');
    const cleanupRows = db.query('SELECT remote_id,secret_id,lease_expires_at FROM vault_cleanup').all() as Array<{
      remote_id: string; secret_id: string; lease_expires_at: string | null;
    }>;
    for (const cleanup of cleanupRows) {
      const suffix = cleanup.remote_id.slice(cleanup.remote_id.lastIndexOf('/v') + 2);
      const generation = Number(suffix);
      if (!Number.isSafeInteger(generation) || generation < 1) continue;
      const secret = db.query('SELECT generation,state FROM vault_secrets WHERE id=?')
        .get(cleanup.secret_id) as { generation: number; state: string } | null;
      if (!secret) continue;
      db.query('UPDATE vault_secrets SET generation_highwater=MAX(generation_highwater,?) WHERE id=?')
        .run(generation, cleanup.secret_id);
      // A legacy pending writer has no separately recorded lease deadline. Fence it
      // closed on upgrade and keep its deletion intent for a late remote set.
      if ((secret.state === 'pending' || generation > secret.generation) && cleanup.lease_expires_at === null) {
        db.query("UPDATE vault_cleanup SET lease_expires_at='1970-01-01T00:00:00.000Z',retain=1,version=version+1 WHERE remote_id=?")
          .run(cleanup.remote_id);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const id = () => options.newId?.() ?? randomUUID();
  const row = (secretId: string) => db.query('SELECT * FROM vault_secrets WHERE id = ?').get(secretId) as VaultRow | null;
  const audit = (secretId: string, event: string) => db.query('INSERT INTO vault_audit(secret_id,event,at) VALUES (?,?,?)').run(secretId, event, now());
  const principal = (p: TrustedVaultPrincipal) => {
    let active = false;
    try { active = options.isPrincipalActive(p); } catch { deny('SESSION_DENIED'); }
    if (!p || typeof p.memberId !== 'string' || !p.memberId || p.memberId.length > 256
      || !active || p.sessionRevoked || !Number.isFinite(Date.parse(p.sessionExpiresAt))
      || Date.parse(p.sessionExpiresAt) <= Date.parse(now())) deny('SESSION_DENIED');
    return p.memberId;
  };
  const plan = (p: TrustedVaultPrincipal, scope: 'store' | 'use') => {
    const memberId = principal(p);
    let found: MemberPlanEntitlements | null;
    try { found = options.memberStore.memberPlanForMember(memberId); }
    catch { deny('PLAN_UNAVAILABLE'); }
    if (!found || found.plan !== 'advanced' || found.entitlements[`cloud.secret.${scope}`] !== true) deny('PLAN_DENIED');
    return found;
  };
  const owned = (p: TrustedVaultPrincipal, secretId: string) => {
    const memberId = principal(p);
    const found = row(secretId);
    if (!found || found.owner !== memberId || found.state === 'deleted') deny('NOT_FOUND');
    return found;
  };
  const metadata = (found: VaultRow): VaultMetadata => ({
    id: found.id, provider: found.provider, purposes: JSON.parse(found.purposes) as string[],
    generation: found.generation, state: found.state === 'active' ? 'active' : 'pending-deletion',
    createdAt: found.created_at, revokedAt: found.revoked_at,
  });
  const queueDelete = (secretId: string, generation: number, notBefore = now(), writerLease?: string) => {
    db.query(`INSERT INTO vault_cleanup(remote_id,secret_id,next_attempt_at,lease_expires_at,retain) VALUES (?,?,?,?,?)
      ON CONFLICT(remote_id) DO UPDATE SET
        next_attempt_at=MIN(vault_cleanup.next_attempt_at,excluded.next_attempt_at),
        lease_expires_at=COALESCE(vault_cleanup.lease_expires_at,excluded.lease_expires_at),
        retain=MAX(vault_cleanup.retain,excluded.retain),version=vault_cleanup.version+1`)
      .run(remoteId(secretId, generation), secretId, notBefore, writerLease ?? null, writerLease ? 1 : 0);
  };
  const leaseUntil = () => new Date(Date.parse(now()) + PENDING_WRITE_LEASE_MS).toISOString();
  const assertPendingWriteLease = (secretId: string, generation: number) => {
    const cleanup = db.query('SELECT lease_expires_at FROM vault_cleanup WHERE remote_id=?')
      .get(remoteId(secretId, generation)) as { lease_expires_at: string | null } | null;
    if (!cleanup?.lease_expires_at || cleanup.lease_expires_at <= now()) deny('WRITE_LEASE_EXPIRED');
  };

  async function reconcile(): Promise<{ pending: number; deleted: number }> {
    const pending = db.query(`SELECT remote_id,secret_id,attempts,version,retain,last_deleted_at
      FROM vault_cleanup WHERE next_attempt_at<=? ORDER BY remote_id`)
      .all(now()) as Array<{remote_id: string; secret_id: string; attempts: number;
        version: number; retain: number; last_deleted_at: string | null}>;
    let deleted = 0;
    for (const item of pending) {
      try {
        await options.backend.delete(item.remote_id);
        db.transaction(() => {
          const changed = item.retain
            ? db.query(`UPDATE vault_cleanup SET attempts=attempts+1,next_attempt_at=?,
                last_deleted_at=COALESCE(last_deleted_at,?),version=version+1
                WHERE remote_id=? AND version=?`)
                .run(new Date(Date.parse(now()) + Math.min(2 ** Math.min(item.attempts + 1, 12) * 1000, 60 * 60_000)).toISOString(),
                  now(), item.remote_id, item.version)
            : db.query('DELETE FROM vault_cleanup WHERE remote_id=? AND version=?').run(item.remote_id, item.version);
          if (changed.changes === 0) return; // another writer renewed this cleanup intent
          if (!item.last_deleted_at) audit(item.secret_id, 'remote-deleted');
          const remaining = db.query(`SELECT COUNT(*) AS n FROM vault_cleanup
            WHERE secret_id=? AND (retain=0 OR last_deleted_at IS NULL)`).get(item.secret_id) as { n: number };
          if (remaining.n === 0) {
            // Crash recovery stays terminal: a pending row whose writer lease expired
            // never activates, so its quota slot is released instead of resurrected.
            const abandoned = db.query("UPDATE vault_secrets SET state='deleted' WHERE id=? AND state='pending'").run(item.secret_id);
            if (abandoned.changes > 0) audit(item.secret_id, 'register-abandoned');
            db.query("UPDATE vault_secrets SET state='deleted' WHERE id=? AND state='deleting'").run(item.secret_id);
          }
        })();
        deleted++;
      } catch {
        const delay = Math.min(2 ** Math.min(item.attempts + 1, 12) * 1000, 60 * 60_000);
        db.query('UPDATE vault_cleanup SET attempts=attempts+1,next_attempt_at=?,version=version+1 WHERE remote_id=? AND version=?')
          .run(new Date(Date.parse(now()) + delay).toISOString(), item.remote_id, item.version);
      }
    }
    return { pending: (db.query('SELECT COUNT(*) AS n FROM vault_cleanup WHERE retain=0 OR last_deleted_at IS NULL').get() as {n:number}).n, deleted };
  }

  async function register(p: TrustedVaultPrincipal, input: { provider: 'gcp' | 'aws'; purposes: readonly string[]; value: string }) {
    const paid = plan(p, 'store');
    const memberId = principal(p);
    if (input.provider !== 'gcp' && input.provider !== 'aws') deny('PROVIDER_INVALID');
    const purposes = cleanPurposes(input.purposes);
    if (typeof input.value !== 'string' || input.value.length === 0
      || Buffer.byteLength(input.value, 'utf8') > Math.min(MAX_VALUE_BYTES, limit(paid, 'cloud.secret.maxBytes', MAX_VALUE_BYTES))) deny('VALUE_INVALID');
    const secretId = id();
    db.transaction(() => {
      const count = db.query("SELECT COUNT(*) AS n FROM vault_secrets WHERE owner=? AND state IN ('pending','active','deleting')").get(memberId) as {n:number};
      if (count.n >= Math.min(MAX_SECRETS, limit(paid, 'cloud.secret.maxItems', MAX_SECRETS))) deny('QUOTA');
      db.query("INSERT INTO vault_secrets(id,owner,provider,purposes,generation,state,created_at) VALUES (?,?,?,?,1,'pending',?)")
        .run(secretId, memberId, input.provider, JSON.stringify(purposes), now());
      const lease = leaseUntil();
      queueDelete(secretId, 1, lease, lease); // durable orphan cleanup waits for the writer's lease
      audit(secretId, 'register-pending');
    })();
    try {
      await options.backend.set(remoteId(secretId, 1), input.value);
      db.transaction(() => {
        plan(p, 'store');
        if (row(secretId)?.state !== 'pending') deny('RACE');
        assertPendingWriteLease(secretId, 1);
        db.query("UPDATE vault_secrets SET state='active' WHERE id=? AND state='pending'").run(secretId);
        db.query('DELETE FROM vault_cleanup WHERE remote_id=?').run(remoteId(secretId, 1));
        audit(secretId, 'registered');
      })();
    } catch {
      db.transaction(() => {
        db.query("UPDATE vault_secrets SET state='deleting',revoked_at=COALESCE(revoked_at,?) WHERE id=? AND state='pending'").run(now(), secretId);
        queueDelete(secretId, 1);
        audit(secretId, 'register-failed');
      })();
      deny('STORE_FAILED');
    }
    return metadata(row(secretId)!);
  }

  async function rotate(p: TrustedVaultPrincipal, secretId: string, value: string) {
    const paid = plan(p, 'store');
    const current = owned(p, secretId);
    if (typeof value !== 'string' || value.length === 0
      || Buffer.byteLength(value, 'utf8') > Math.min(MAX_VALUE_BYTES, limit(paid, 'cloud.secret.maxBytes', MAX_VALUE_BYTES))) deny('VALUE_INVALID');
    let next = 0;
    db.transaction(() => {
      const latest = owned(p, secretId);
      if (latest.state !== 'active' || latest.generation !== current.generation) deny('CONFLICT');
      // A crashed rotation's target stays reserved, never reused: once its cleanup
      // fence is consumed the owner may rotate again, but the next attempt takes a
      // strictly higher generation so a late writer can neither commit nor collide.
      if (latest.pending_generation !== null) {
        const fence = db.query('SELECT lease_expires_at FROM vault_cleanup WHERE remote_id=?')
          .get(remoteId(secretId, latest.pending_generation)) as { lease_expires_at: string | null } | null;
        if (fence?.lease_expires_at && fence.lease_expires_at > now()) deny('CONFLICT');
      }
      next = Math.max(latest.generation, latest.pending_generation ?? 0, latest.generation_highwater) + 1;
      db.query('UPDATE vault_secrets SET pending_generation=?,generation_highwater=? WHERE id=?').run(next, next, secretId);
      const lease = leaseUntil();
      queueDelete(secretId, next, lease, lease);
      audit(secretId, 'rotate-pending');
    })();
    try {
      await options.backend.set(remoteId(secretId, next), value);
      db.transaction(() => {
        plan(p, 'store');
        const latest = owned(p, secretId);
        if (latest.state !== 'active' || latest.pending_generation !== next) deny('CONFLICT');
        assertPendingWriteLease(secretId, next);
        db.query('UPDATE vault_secrets SET generation=?,pending_generation=NULL WHERE id=?').run(next, secretId);
        db.query('DELETE FROM vault_cleanup WHERE remote_id=?').run(remoteId(secretId, next));
        queueDelete(secretId, current.generation);
        audit(secretId, 'rotated');
      })();
    } catch {
      db.transaction(() => {
        db.query('UPDATE vault_secrets SET pending_generation=NULL WHERE id=? AND pending_generation=?').run(secretId, next);
        queueDelete(secretId, next);
        audit(secretId, 'rotate-failed');
      })();
      deny('ROTATE_FAILED');
    }
    await reconcile();
    return metadata(row(secretId)!);
  }

  async function revoke(p: TrustedVaultPrincipal, secretId: string): Promise<VaultMetadata> {
    const current = owned(p, secretId);
    db.transaction(() => {
      const latest = owned(p, secretId);
      if (latest.state === 'active' || latest.state === 'pending') {
        db.query("UPDATE vault_secrets SET state='deleting',revoked_at=? WHERE id=?").run(now(), secretId);
        queueDelete(secretId, latest.generation);
        if (latest.pending_generation !== null) queueDelete(secretId, latest.pending_generation);
        audit(secretId, 'revoked-local');
      }
    })();
    // A remote failure never undoes the durable local deny.
    await reconcile();
    return metadata(row(secretId) ?? current);
  }

  async function use<T>(p: TrustedVaultPrincipal, secretId: string, purpose: string, consume: (value: string) => Promise<T>): Promise<T> {
    plan(p, 'use');
    const found = owned(p, secretId);
    if (found.state !== 'active' || !PURPOSE.test(purpose) || !(JSON.parse(found.purposes) as string[]).includes(purpose)) deny('USE_DENIED');
    let value: string | undefined;
    try { value = await options.backend.get(remoteId(secretId, found.generation)); }
    catch { deny('BACKEND_UNAVAILABLE'); }
    if (value === undefined) deny('BACKEND_UNAVAILABLE');
    plan(p, 'use');
    const latest = owned(p, secretId);
    if (latest.state !== 'active' || latest.generation !== found.generation) deny('USE_DENIED');
    db.transaction(() => audit(secretId, 'use-authorized'))();
    return consume(value);
  }

  // Retained cleanup intents must outlive a writer that dies just after its
  // remote set. Recheck them for the lifetime of this service; a later set can
  // land after an earlier delete, and the next sweep then removes it.
  let sweeping = false;
  const cleanupTimer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void reconcile().catch(() => {}).finally(() => { sweeping = false; });
  }, 30_000);
  cleanupTimer.unref?.();

  return {
    register, rotate, revoke, use, reconcile,
    list(p: TrustedVaultPrincipal): VaultMetadata[] {
      const memberId = principal(p);
      return (db.query("SELECT * FROM vault_secrets WHERE owner=? AND state!='deleted' ORDER BY created_at,id").all(memberId) as VaultRow[]).map(metadata);
    },
    auditEvents(p: TrustedVaultPrincipal, secretId: string): string[] {
      const found = row(secretId);
      if (!found || found.owner !== principal(p)) deny('NOT_FOUND');
      return (db.query('SELECT event FROM vault_audit WHERE secret_id=? ORDER BY id').all(secretId) as {event:string}[]).map(x => x.event);
    },
    close() { clearInterval(cleanupTimer); db.close(); },
  };
}
