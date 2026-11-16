import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Database } from 'bun:sqlite';
import type { DeploymentGrantBinding } from './deployment-grant-store.js';

export interface DeploymentApproval extends DeploymentGrantBinding {
  readonly approvalId: string;
  readonly requestedExpiresAt: string;
  readonly pendingExpiresAt: string;
  readonly approvedExpiresAt: string | null;
  readonly approvedAt: string | null;
  readonly consumedGrantId: string | null;
}

type ApprovalRow = {
  approval_id: string; member_id: string; app_slug: string; run_id: string; deployment_id: string;
  source_head: string; artifact_digest: string; relay_key_id: string; requested_expires_at: string;
  created_at: string; pending_expires_at: string; approved_at: string | null;
  approved_expires_at: string | null; csrf_hash: string | null; consumed_grant_id: string | null;
};

function approval(row: ApprovalRow): DeploymentApproval {
  return { approvalId: row.approval_id, memberId: row.member_id, appSlug: row.app_slug,
    runId: row.run_id, deploymentId: row.deployment_id, sourceHead: row.source_head,
    artifactDigest: row.artifact_digest, relayKeyId: row.relay_key_id,
    requestedExpiresAt: row.requested_expires_at, pendingExpiresAt: row.pending_expires_at,
    approvedAt: row.approved_at, approvedExpiresAt: row.approved_expires_at,
    consumedGrantId: row.consumed_grant_id };
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export function ensureDeploymentApprovalSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS deployment_approvals (
    approval_id TEXT PRIMARY KEY, member_id TEXT NOT NULL, app_slug TEXT NOT NULL,
    run_id TEXT NOT NULL, deployment_id TEXT NOT NULL, source_head TEXT NOT NULL,
    artifact_digest TEXT NOT NULL, relay_key_id TEXT NOT NULL,
    requested_expires_at TEXT NOT NULL, created_at TEXT NOT NULL, pending_expires_at TEXT NOT NULL,
    approved_at TEXT, approved_expires_at TEXT, csrf_hash TEXT, consumed_grant_id TEXT
  );
  CREATE INDEX IF NOT EXISTS deployment_approvals_owner
    ON deployment_approvals(member_id, app_slug, approval_id);`);
}

/** The same private SQLite file must be supplied to the grant store. */
export function openDeploymentApprovalStore(path: string, now: () => number = Date.now) {
  if (path !== ':memory:' && !isAbsolute(path)) throw new Error('absolute approval ledger path required');
  if (path !== ':memory:') {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) throw new Error('approval ledger must be owner-only regular file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const db = new Database(path, { create: true });
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  ensureDeploymentApprovalSchema(db);
  const byId = db.query('SELECT * FROM deployment_approvals WHERE approval_id = ?');
  const setNonce = db.query('UPDATE deployment_approvals SET csrf_hash = ? WHERE approval_id = ? AND approved_at IS NULL');
  const setApproved = db.query(`UPDATE deployment_approvals SET approved_at = ?, approved_expires_at = ?, csrf_hash = NULL
    WHERE approval_id = ? AND approved_at IS NULL AND csrf_hash = ?`);
  return {
    lookup(approvalId: string): DeploymentApproval | null {
      const row = byId.get(approvalId) as ApprovalRow | null;
      return row ? approval(row) : null;
    },
    propose(binding: DeploymentGrantBinding, requestedExpiresAt: string) {
      const createdMs = now();
      const requestedMs = Date.parse(requestedExpiresAt);
      if (!Number.isFinite(createdMs) || !Number.isFinite(requestedMs) || requestedMs <= createdMs)
        return null;
      const approvalId = randomUUID();
      const pendingExpiresAt = new Date(createdMs + 5 * 60_000).toISOString();
      db.query(`INSERT INTO deployment_approvals (approval_id, member_id, app_slug, run_id,
        deployment_id, source_head, artifact_digest, relay_key_id, requested_expires_at,
        created_at, pending_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        approvalId, binding.memberId, binding.appSlug, binding.runId, binding.deploymentId,
        binding.sourceHead, binding.artifactDigest, binding.relayKeyId, requestedExpiresAt,
        new Date(createdMs).toISOString(), pendingExpiresAt);
      return { approvalId, pendingExpiresAt };
    },
    forOwner(approvalId: string, memberId: string): DeploymentApproval | null {
      const row = byId.get(approvalId) as ApprovalRow | null;
      return row?.member_id === memberId ? approval(row) : null;
    },
    prepareConfirmation(approvalId: string, memberId: string) {
      db.exec('BEGIN IMMEDIATE;');
      try {
        const row = byId.get(approvalId) as ApprovalRow | null;
        if (!row || row.member_id !== memberId || row.approved_at || Date.parse(row.pending_expires_at) <= now()) {
          db.exec('COMMIT;'); return null;
        }
        const nonce = randomBytes(32).toString('base64url');
        setNonce.run(hash(nonce), approvalId);
        db.exec('COMMIT;');
        return { approval: approval(row), nonce };
      } catch (error) { db.exec('ROLLBACK;'); throw error; }
    },
    approve(approvalId: string, memberId: string, nonce: string): DeploymentApproval | null {
      if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) return null;
      db.exec('BEGIN IMMEDIATE;');
      try {
        const row = byId.get(approvalId) as ApprovalRow | null;
        const approvedMs = now();
        if (!row || row.member_id !== memberId || row.approved_at || !row.csrf_hash
          || row.csrf_hash !== hash(nonce) || Date.parse(row.pending_expires_at) <= approvedMs
          || Date.parse(row.requested_expires_at) <= approvedMs) {
          db.exec('COMMIT;'); return null;
        }
        const approvedAt = new Date(approvedMs).toISOString();
        const approvedExpiresAt = new Date(Math.min(Date.parse(row.requested_expires_at), approvedMs + 24 * 60 * 60_000)).toISOString();
        setApproved.run(approvedAt, approvedExpiresAt, approvalId, row.csrf_hash);
        db.exec('COMMIT;');
        return { ...approval(row), approvedAt, approvedExpiresAt };
      } catch (error) { db.exec('ROLLBACK;'); throw error; }
    },
    poll(approvalId: string, memberId: string) {
      const row = byId.get(approvalId) as ApprovalRow | null;
      if (!row || row.member_id !== memberId) return { status: 'denied' as const };
      const currentMs = now();
      if (row.approved_at) {
        if (Date.parse(row.approved_at) + 5 * 60_000 <= currentMs || Date.parse(row.approved_expires_at!) <= currentMs)
          return { status: 'expired' as const };
        return { status: 'approved' as const, approval: approval(row) };
      }
      if (Date.parse(row.pending_expires_at) <= currentMs
        || Date.parse(row.requested_expires_at) <= currentMs) return { status: 'expired' as const };
      return { status: 'pending' as const, pendingExpiresAt: row.pending_expires_at };
    },
    close() { db.close(); },
  };
}
