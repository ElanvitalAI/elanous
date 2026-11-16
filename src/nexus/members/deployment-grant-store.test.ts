import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { openDeploymentGrantStore, type DeploymentGrantBinding } from './deployment-grant-store.js';
import { openDeploymentApprovalStore } from './deployment-approval-store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const binding: DeploymentGrantBinding = { memberId: 'member-a', appSlug: 'demo-app', runId: 'run-1',
  deploymentId: 'dyn-11111111-1111-4111-8111-111111111111', sourceHead: 'b'.repeat(40),
  artifactDigest: 'c'.repeat(64), relayKeyId: '22222222-2222-4222-8222-222222222222' };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'deployment-grant-store-'));
  dirs.push(dir);
  const path = join(dir, 'server.sqlite');
  let clock = Date.parse('2026-11-16T00:00:00Z');
  const now = () => clock;
  const store = openDeploymentGrantStore(path, now);
  const approvals = openDeploymentApprovalStore(path, now);
  function approve(input: DeploymentGrantBinding = binding, requestedExpiresAt = '2026-11-16T02:00:00Z') {
    const proposed = approvals.propose(input, requestedExpiresAt)!;
    const prepared = approvals.prepareConfirmation(proposed.approvalId, input.memberId)!;
    expect(approvals.approve(proposed.approvalId, input.memberId, prepared.nonce)).not.toBeNull();
    return { ...input, approvalId: proposed.approvalId, requestedExpiresAt };
  }
  return { path, store, approvals, now, approve, advance(ms: number) { clock += ms; } };
}

test('approval and credential insert are atomic across separate SQLite connections', () => {
  const f = fixture();
  const second = openDeploymentGrantStore(f.path, f.now);
  const input = f.approve();
  const first = f.store.issue(input);
  expect(first.status).toBe('issued');
  if (first.status !== 'issued') throw new Error('issue failed');
  expect(first.grant.approvalId).toBe(input.approvalId);
  expect(first.credential).toMatch(/^dpg_[A-Za-z0-9_-]{43}$/);
  f.advance(5 * 60_000);
  expect(second.issue(input)).toEqual({ status: 'already-issued',
    grantId: first.grant.grantId, grantVersion: 1 });
  expect(f.approvals.lookup(input.approvalId)?.consumedGrantId).toBe(first.grant.grantId);
  expect(second.issue({ ...input, artifactDigest: 'd'.repeat(64) })).toEqual({ status: 'binding-conflict' });
  expect(second.issue({ ...input, approvalId: '00000000-0000-4000-8000-000000000000' }))
    .toEqual({ status: 'invalid-approval' });
  expect(readFileSync(f.path).includes(Buffer.from(first.credential))).toBe(false);
  expect(statSync(f.path).mode & 0o077).toBe(0);
  expect(second.byCredential(first.credential)?.grantId).toBe(first.grant.grantId);
  second.close(); f.approvals.close(); f.store.close();
});

test('revoke cannot reuse consumed approval; fresh owner approval increments version', () => {
  const f = fixture();
  const input = f.approve();
  const first = f.store.issue(input);
  if (first.status !== 'issued') throw new Error('issue failed');
  expect(f.store.revoke(first.grant.grantId, 'foreign', binding.appSlug)).toBe(false);
  expect(f.store.revoke(first.grant.grantId, binding.memberId, binding.appSlug)).toBe(true);
  expect(f.store.byCredential(first.credential)).toBeNull();
  expect(f.store.issue(input)).toEqual({ status: 'invalid-approval' });
  const replacement = f.store.issue(f.approve());
  expect(replacement.status).toBe('issued');
  if (replacement.status !== 'issued') throw new Error('reissue failed');
  expect(replacement.grant.grantVersion).toBe(2);
  expect(replacement.credential).not.toBe(first.credential);
  f.approvals.close(); f.store.close();
});

test('approved but unissued record expires after five minutes', () => {
  const f = fixture();
  const input = f.approve();
  f.advance(5 * 60_000);
  expect(f.store.issue(input)).toEqual({ status: 'invalid-approval' });
  expect(f.approvals.lookup(input.approvalId)?.consumedGrantId).toBeNull();
  f.approvals.close(); f.store.close();
});

test('legacy grant ledger migrates without making unapproved credentials valid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deployment-grant-legacy-'));
  dirs.push(dir);
  const path = join(dir, 'server.sqlite');
  const credential = 'dpg_' + 'A'.repeat(43);
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE deployment_grants (
    grant_id TEXT PRIMARY KEY, member_id TEXT NOT NULL, app_slug TEXT NOT NULL,
    run_id TEXT NOT NULL, deployment_id TEXT NOT NULL, source_head TEXT NOT NULL,
    artifact_digest TEXT NOT NULL, relay_key_id TEXT NOT NULL, grant_version INTEGER NOT NULL,
    credential_hash TEXT NOT NULL UNIQUE, issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, revoked_at TEXT
  )`);
  db.query(`INSERT INTO deployment_grants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('33333333-3333-4333-8333-333333333333', binding.memberId, binding.appSlug,
      binding.runId, binding.deploymentId, binding.sourceHead, binding.artifactDigest,
      binding.relayKeyId, 1, createHash('sha256').update(credential).digest('hex'),
      '2026-11-16T00:00:00.000Z', '2026-11-16T02:00:00.000Z', null);
  db.close();
  chmodSync(path, 0o600);
  const store = openDeploymentGrantStore(path, () => Date.parse('2026-11-16T01:00:00Z'));
  expect(store.byCredential(credential)).toBeNull();
  expect(store.byId('33333333-3333-4333-8333-333333333333')?.approvalId).toBeNull();
  const approvals = openDeploymentApprovalStore(path, () => Date.parse('2026-11-16T01:00:00Z'));
  const requestedExpiresAt = '2026-11-16T02:00:00.000Z';
  const proposed = approvals.propose(binding, requestedExpiresAt)!;
  const prepared = approvals.prepareConfirmation(proposed.approvalId, binding.memberId)!;
  expect(approvals.approve(proposed.approvalId, binding.memberId, prepared.nonce)).not.toBeNull();
  const replacement = store.issue({ ...binding, approvalId: proposed.approvalId, requestedExpiresAt });
  expect(replacement.status).toBe('issued');
  if (replacement.status !== 'issued') throw new Error('legacy replacement failed');
  expect(replacement.grant.grantVersion).toBe(2);
  expect(store.byId('33333333-3333-4333-8333-333333333333')?.revokedAt).not.toBeNull();
  expect(store.byCredential(replacement.credential)?.approvalId).toBe(proposed.approvalId);
  approvals.close();
  store.close();
});

test('approval expiry wins a SQLite write-lock wait held by another process', async () => {
  let clockOffset = Date.parse('2026-11-16T00:00:00Z') - Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'deployment-grant-lock-race-'));
  dirs.push(dir);
  const path = join(dir, 'server.sqlite');
  const store = openDeploymentGrantStore(path, () => Date.now() + clockOffset);
  const approvals = openDeploymentApprovalStore(path, () => Date.now() + clockOffset);
  const proposed = approvals.propose(binding, '2026-11-16T02:00:00.000Z')!;
  const prepared = approvals.prepareConfirmation(proposed.approvalId, binding.memberId)!;
  const approved = approvals.approve(proposed.approvalId, binding.memberId, prepared.nonce)!;
  const child = Bun.spawn([process.execPath, '-e',
    "const { Database } = require('bun:sqlite'); const db = new Database(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked\\n'); setTimeout(() => { db.exec('COMMIT'); db.close(); }, 350);",
    path], { stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = child.stdout.getReader();
    const signal = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(signal.value)).toContain('locked');
    clockOffset = Date.parse(approved.approvedAt!) + 5 * 60_000 - Date.now() - 100;
    const started = Date.now();
    expect(store.issue({ ...binding, approvalId: proposed.approvalId,
      requestedExpiresAt: '2026-11-16T02:00:00.000Z' })).toEqual({ status: 'invalid-approval' });
    // Source: #37904 measured child lock 350 ms; 100 ms confirms a wait past the injected expiry boundary.
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(approvals.lookup(proposed.approvalId)?.consumedGrantId).toBeNull();
    expect(await child.exited).toBe(0);
  } finally { child.kill(); approvals.close(); store.close(); }
}, 10_000);
