import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Database } from 'bun:sqlite';
import { ensureDeploymentApprovalSchema } from './deployment-approval-store.js';

export interface DeploymentGrantBinding {
  readonly memberId: string;
  readonly appSlug: string;
  readonly runId: string;
  readonly deploymentId: string;
  readonly sourceHead: string;
  readonly artifactDigest: string;
  readonly relayKeyId: string;
}

export interface DeploymentGrant extends DeploymentGrantBinding {
  readonly grantId: string;
  readonly approvalId: string | null;
  readonly grantVersion: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export type IssueGrantResult =
  | { readonly status: 'issued'; readonly grant: DeploymentGrant; readonly credential: string }
  | { readonly status: 'already-issued'; readonly grantId: string; readonly grantVersion: number }
  | { readonly status: 'binding-conflict' }
  | { readonly status: 'invalid-approval' }
  | { readonly status: 'invalid-expiry' };

export interface DeploymentGrantStore {
  issue(input: DeploymentGrantBinding & { readonly approvalId: string; readonly requestedExpiresAt: string }): IssueGrantResult;
  byCredential(credential: string): DeploymentGrant | null;
  byId(grantId: string): DeploymentGrant | null;
  revoke(grantId: string, memberId: string, appSlug: string): boolean;
  close(): void;
}

type GrantRow = {
  grant_id: string; approval_id: string | null; member_id: string; app_slug: string; run_id: string; deployment_id: string; source_head: string;
  artifact_digest: string; relay_key_id: string; grant_version: number; issued_at: string;
  expires_at: string; revoked_at: string | null;
};

function toGrant(row: GrantRow): DeploymentGrant {
  return { grantId: row.grant_id, approvalId: row.approval_id, memberId: row.member_id, appSlug: row.app_slug,
    runId: row.run_id, deploymentId: row.deployment_id, sourceHead: row.source_head, artifactDigest: row.artifact_digest,
    relayKeyId: row.relay_key_id, grantVersion: row.grant_version,
    issuedAt: row.issued_at, expiresAt: row.expires_at, revokedAt: row.revoked_at };
}

function digest(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}

/** A separate authoritative server ledger. The caller supplies a private absolute DB path. */
export function openDeploymentGrantStore(path: string, now: () => number = Date.now): DeploymentGrantStore {
  if (path !== ':memory:' && !isAbsolute(path)) throw new Error('absolute grant ledger path required');
  if (path !== ':memory:') {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) throw new Error('grant ledger must be owner-only regular file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const db = new Database(path, { create: true });
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployment_grants (
      grant_id TEXT PRIMARY KEY, approval_id TEXT, member_id TEXT NOT NULL, app_slug TEXT NOT NULL,
      run_id TEXT NOT NULL, deployment_id TEXT NOT NULL, source_head TEXT NOT NULL, artifact_digest TEXT NOT NULL,
      relay_key_id TEXT NOT NULL, grant_version INTEGER NOT NULL,
      credential_hash TEXT NOT NULL UNIQUE, issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, revoked_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS deployment_grants_active_binding
      ON deployment_grants(member_id, app_slug, run_id) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS deployment_grants_owner
      ON deployment_grants(member_id, app_slug, grant_id);
  `);
  // Existing private ledgers predate server approval; keep their rows for audit,
  // but never accept an unapproved legacy credential for introspection.
  const columns = db.query('PRAGMA table_info(deployment_grants)').all() as { name: string }[];
  if (!columns.some(column => column.name === 'approval_id')) db.exec('ALTER TABLE deployment_grants ADD COLUMN approval_id TEXT;');
  ensureDeploymentApprovalSchema(db);
  const byId = db.query('SELECT * FROM deployment_grants WHERE grant_id = ?');
  const byHash = db.query('SELECT * FROM deployment_grants WHERE credential_hash = ?');
  const byApproval = db.query('SELECT * FROM deployment_approvals WHERE approval_id = ?');
  const consumeApproval = db.query('UPDATE deployment_approvals SET consumed_grant_id = ? WHERE approval_id = ? AND consumed_grant_id IS NULL');
  const active = db.query(`SELECT * FROM deployment_grants
    WHERE member_id = ? AND app_slug = ? AND run_id = ? AND revoked_at IS NULL`);
  const nextVersion = db.query(`SELECT COALESCE(MAX(grant_version), 0) AS version FROM deployment_grants
    WHERE member_id = ? AND app_slug = ? AND run_id = ?`);
  const insert = db.query(`INSERT INTO deployment_grants
    (grant_id, approval_id, member_id, app_slug, run_id, deployment_id, source_head, artifact_digest, relay_key_id,
     grant_version, credential_hash, issued_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`);
  const revoke = db.query(`UPDATE deployment_grants SET revoked_at = ?
    WHERE grant_id = ? AND member_id = ? AND app_slug = ? AND revoked_at IS NULL`);

  return {
    issue(input) {
      const requestedMs = Date.parse(input.requestedExpiresAt);
      if (!Number.isFinite(requestedMs))
        return { status: 'invalid-expiry' };
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.approvalId))
        return { status: 'invalid-approval' };
      db.exec('BEGIN IMMEDIATE;');
      try {
        // A competing writer can hold this lock until an approval expires.
        // Read the clock only after acquisition, before any issuance decision.
        const issuedMs = now();
        if (!Number.isFinite(issuedMs) || requestedMs <= issuedMs) {
          db.exec('COMMIT;'); return { status: 'invalid-expiry' };
        }
        const approval = byApproval.get(input.approvalId) as {
          member_id: string; app_slug: string; run_id: string; deployment_id: string; source_head: string;
          artifact_digest: string; relay_key_id: string; requested_expires_at: string;
          approved_at: string | null; approved_expires_at: string | null; consumed_grant_id: string | null;
        } | null;
        if (!approval) {
          db.exec('COMMIT;'); return { status: 'invalid-approval' };
        }
        const sameBinding = approval.member_id === input.memberId && approval.app_slug === input.appSlug
          && approval.run_id === input.runId && approval.deployment_id === input.deploymentId
          && approval.source_head === input.sourceHead && approval.artifact_digest === input.artifactDigest
          && approval.relay_key_id === input.relayKeyId
          && approval.requested_expires_at === input.requestedExpiresAt;
        if (!sameBinding) { db.exec('COMMIT;'); return { status: 'binding-conflict' }; }
        if (approval.consumed_grant_id) {
          const consumed = byId.get(approval.consumed_grant_id) as GrantRow | null;
          db.exec('COMMIT;');
          return consumed && !consumed.revoked_at && Date.parse(consumed.expires_at) > issuedMs
            && consumed.approval_id === input.approvalId
            ? { status: 'already-issued', grantId: consumed.grant_id, grantVersion: consumed.grant_version }
            : { status: 'invalid-approval' };
        }
        if (!approval.approved_at || !approval.approved_expires_at
          || Date.parse(approval.approved_at) + 5 * 60_000 <= issuedMs
          || Date.parse(approval.approved_expires_at) <= issuedMs) {
          db.exec('COMMIT;'); return { status: 'invalid-approval' };
        }
        const existing = active.get(input.memberId, input.appSlug, input.runId) as GrantRow | null;
        // Legacy rows have no approval ID and cannot introspect. Retire one
        // under this same lock so it cannot block a newly approved grant.
        if (existing?.approval_id && Date.parse(existing.expires_at) > issuedMs) {
          db.exec('COMMIT;');
          return { status: 'binding-conflict' };
        }
        if (existing && revoke.run(new Date(issuedMs).toISOString(), existing.grant_id,
          existing.member_id, existing.app_slug).changes !== 1) throw new Error('active-grant-retire-race');
        const version = (nextVersion.get(input.memberId, input.appSlug, input.runId) as { version: number }).version + 1;
        const grantId = randomUUID();
        const credential = 'dpg_' + randomBytes(32).toString('base64url');
        const issuedAt = new Date(issuedMs).toISOString();
        const expiresAt = new Date(Math.min(requestedMs, Date.parse(approval.approved_expires_at),
          issuedMs + 24 * 60 * 60 * 1000)).toISOString();
        insert.run(grantId, input.approvalId, input.memberId, input.appSlug, input.runId, input.deploymentId,
          input.sourceHead, input.artifactDigest, input.relayKeyId, version, digest(credential), issuedAt, expiresAt);
        if (consumeApproval.run(grantId, input.approvalId).changes !== 1) throw new Error('approval-consume-race');
        db.exec('COMMIT;');
        return { status: 'issued', credential, grant: { grantId, approvalId: input.approvalId, memberId: input.memberId,
          appSlug: input.appSlug, runId: input.runId, deploymentId: input.deploymentId, sourceHead: input.sourceHead,
          artifactDigest: input.artifactDigest, relayKeyId: input.relayKeyId,
          grantVersion: version, issuedAt, expiresAt, revokedAt: null } };
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
    },
    byCredential(credential) {
      if (!/^dpg_[A-Za-z0-9_-]{43}$/.test(credential)) return null;
      const row = byHash.get(digest(credential)) as GrantRow | null;
      return row && row.approval_id && !row.revoked_at && Date.parse(row.expires_at) > now() ? toGrant(row) : null;
    },
    byId(grantId) {
      const row = byId.get(grantId) as GrantRow | null;
      return row ? toGrant(row) : null;
    },
    revoke(grantId, memberId, appSlug) {
      const row = byId.get(grantId) as GrantRow | null;
      if (!row || row.member_id !== memberId || row.app_slug !== appSlug) return false;
      if (!row.revoked_at) revoke.run(new Date(now()).toISOString(), grantId, memberId, appSlug);
      return true;
    },
    close() { db.close(); },
  };
}
