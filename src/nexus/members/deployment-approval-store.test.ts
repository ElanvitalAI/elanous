import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDeploymentApprovalStore } from './deployment-approval-store.js';
import type { DeploymentGrantBinding } from './deployment-grant-store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const binding: DeploymentGrantBinding = { memberId: 'owner-a', appSlug: 'demo-app', runId: 'run-1',
  deploymentId: 'dyn-11111111-1111-4111-8111-111111111111', sourceHead: 'a'.repeat(40),
  artifactDigest: 'b'.repeat(64), relayKeyId: '22222222-2222-4222-8222-222222222222' };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'deployment-approval-'));
  dirs.push(dir);
  const path = join(dir, 'server.sqlite');
  let clock = Date.parse('2026-11-16T00:00:00Z');
  const now = () => clock;
  const store = openDeploymentApprovalStore(path, now);
  return { path, store, now, advance(ms: number) { clock += ms; } };
}

test('owner browser confirmation is one-time, CSRF bound and visible to fresh APS poll', () => {
  const f = fixture();
  const pending = f.store.propose(binding, '2026-11-16T02:00:00Z')!;
  expect(f.store.poll(pending.approvalId, 'owner-a').status).toBe('pending');
  expect(f.store.poll(pending.approvalId, 'owner-b').status).toBe('denied');
  const browser = f.store.prepareConfirmation(pending.approvalId, 'owner-a')!;
  expect(f.store.approve(pending.approvalId, 'owner-b', browser.nonce)).toBeNull();
  expect(f.store.approve(pending.approvalId, 'owner-a', 'x'.repeat(43))).toBeNull();
  const approved = f.store.approve(pending.approvalId, 'owner-a', browser.nonce)!;
  expect(approved).toMatchObject({ ...binding, approvalId: pending.approvalId,
    approvedExpiresAt: '2026-11-16T02:00:00.000Z' });
  expect(f.store.approve(pending.approvalId, 'owner-a', browser.nonce)).toBeNull();
  expect(f.store.poll(pending.approvalId, 'owner-a').status).toBe('approved');
  expect(readFileSync(f.path).includes(Buffer.from(browser.nonce))).toBe(false);
  f.advance(5 * 60_000);
  expect(f.store.poll(pending.approvalId, 'owner-a').status).toBe('expired');
  f.store.close();
});

test('pending TTL and stale browser nonce fail closed across two SQLite connections', () => {
  const f = fixture();
  const second = openDeploymentApprovalStore(f.path, f.now);
  const pending = f.store.propose(binding, '2026-11-16T02:00:00Z')!;
  const first = f.store.prepareConfirmation(pending.approvalId, 'owner-a')!;
  const latest = second.prepareConfirmation(pending.approvalId, 'owner-a')!;
  expect(first.nonce).not.toBe(latest.nonce);
  expect(f.store.approve(pending.approvalId, 'owner-a', first.nonce)).toBeNull();
  f.advance(5 * 60_000);
  expect(second.approve(pending.approvalId, 'owner-a', latest.nonce)).toBeNull();
  expect(f.store.poll(pending.approvalId, 'owner-a').status).toBe('expired');
  second.close(); f.store.close();
});
