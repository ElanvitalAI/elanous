import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { SecretBackend } from '../config/secrets/types.js';
import { createMemberStore } from './member-store.js';
import { createCloudSecretVault, type TrustedVaultPrincipal } from './cloud-secret-vault.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

function fixture() {
  const dir = mkdtempSync(join(process.cwd(), '.cloud-vault-test-'));
  const memberStore = createMemberStore({ path: join(dir, 'members.sqlite') });
  const values = new Map<string, string>();
  const calls = { get: 0, set: 0, delete: 0, failDelete: false };
  const backend: SecretBackend = {
    id: 'gcp',
    async get(key) { calls.get++; return values.get(key); },
    async set(key, value) { calls.set++; values.set(key, value); },
    async delete(key) { calls.delete++; if (calls.failDelete) throw new Error('fake cloud unavailable'); return values.delete(key); },
    async list() { return [...values.keys()]; },
    async isAvailable() { return { ok: true }; },
  };
  const vaultPath = join(dir, 'vault.sqlite');
  let clock = new Date('2026-11-13T00:00:00Z');
  const revokedSessions = new Set<string>();
  const open = () => createCloudSecretVault({ dbPath: vaultPath, backend, memberStore,
    now: () => clock, isPrincipalActive: p => !revokedSessions.has(p.memberId) });
  let vault = open();
  cleanup.push(() => { vault.close(); memberStore.close(); rmSync(dir, { recursive: true, force: true }); });
  const member = (sub: string) => memberStore.register(
    { sub, email: `${sub}@example.test`, emailVerified: true, name: sub },
    { consents: { privacy: 'v1', terms: 'v1' } },
  );
  const alice = member('alice');
  const bob = member('bob');
  memberStore.provisionPlan({ plan: 'advanced', entitlements: { 'cloud.secret.store': true, 'cloud.secret.use': true } });
  memberStore.assignPlan(alice.id, 'advanced');
  const principal = (memberId: string): TrustedVaultPrincipal => ({ memberId, sessionExpiresAt: '2026-11-14T00:00:00Z' });
  return { memberStore, values, calls, backend, vaultPath, get vault() { return vault; }, reopen() { vault.close(); vault = open(); },
    second() { const other = open(); cleanup.unshift(() => other.close()); return other; },
    advance(ms: number) { clock = new Date(clock.getTime() + ms); }, revokeSession(memberId: string) { revokedSessions.add(memberId); },
    alice: principal(alice.id), bob: principal(bob.id) };
}

test('trusted principal uses real member plan seam and fake backend; owner and purpose stay bound', async () => {
  const f = fixture();
  const input = { provider: 'gcp' as const, purposes: ['cloud.deploy'], value: 'CANARY-private-value' };
  await expect(f.vault.register(f.bob, input)).rejects.toThrow('CLOUD_VAULT_PLAN_DENIED');
  expect(f.calls.set).toBe(0);
  const forgedBody = { ...input, memberId: f.bob.memberId }; // runtime input can contain an untrusted owner
  const item = await f.vault.register(f.alice, forgedBody);
  expect(item).toMatchObject({ provider: 'gcp', generation: 1, state: 'active' });
  expect(JSON.stringify(item)).not.toContain(input.value);
  expect(f.vault.list(f.bob)).toEqual([]);
  await expect(f.vault.use(f.bob, item.id, 'cloud.deploy', async () => 'bad')).rejects.toThrow('CLOUD_VAULT_PLAN_DENIED');
  f.memberStore.assignPlan(f.bob.memberId, 'advanced');
  await expect(f.vault.use(f.bob, item.id, 'cloud.deploy', async () => 'bad')).rejects.toThrow('CLOUD_VAULT_NOT_FOUND');
  expect(f.calls.get).toBe(0);
  await expect(f.vault.use(f.alice, item.id, 'cloud.read', async () => 'bad')).rejects.toThrow('CLOUD_VAULT_USE_DENIED');
  const used = await f.vault.use(f.alice, item.id, 'cloud.deploy', async value => value === input.value);
  expect(used).toBe(true);
  expect(f.vault.auditEvents(f.alice, item.id)).toEqual(['register-pending', 'registered', 'use-authorized']);
  expect(() => f.vault.auditEvents(f.bob, item.id)).toThrow('CLOUD_VAULT_NOT_FOUND');
  await expect(f.vault.register({ ...f.alice, sessionRevoked: true }, input)).rejects.toThrow('CLOUD_VAULT_SESSION_DENIED');
  await expect(f.vault.register({ ...f.alice, sessionExpiresAt: '2026-11-12T00:00:00Z' }, input)).rejects.toThrow('CLOUD_VAULT_SESSION_DENIED');
  f.revokeSession(f.alice.memberId);
  await expect(f.vault.use(f.alice, item.id, 'cloud.deploy', async () => 'bad')).rejects.toThrow('CLOUD_VAULT_SESSION_DENIED');
  expect(f.calls.set).toBe(1);
});

test('downgrade keeps metadata and revoke; durable deny survives cloud deletion failure and restart', async () => {
  const f = fixture();
  const item = await f.vault.register(f.alice, { provider: 'aws', purposes: ['cloud.deploy'], value: 'CANARY-revoke' });
  f.memberStore.assignPlan(f.alice.memberId, 'free');
  expect(f.vault.list(f.alice)).toHaveLength(1);
  await expect(f.vault.register(f.alice, { provider: 'aws', purposes: ['cloud.deploy'], value: 'denied' })).rejects.toThrow('CLOUD_VAULT_PLAN_DENIED');
  await expect(f.vault.rotate(f.alice, item.id, 'denied')).rejects.toThrow('CLOUD_VAULT_PLAN_DENIED');
  await expect(f.vault.use(f.alice, item.id, 'cloud.deploy', async () => true)).rejects.toThrow('CLOUD_VAULT_PLAN_DENIED');
  f.calls.failDelete = true;
  expect((await f.vault.revoke(f.alice, item.id)).state).toBe('pending-deletion');
  expect(f.values.size).toBe(1);
  f.reopen();
  expect(f.vault.list(f.alice)[0]?.state).toBe('pending-deletion');
  await expect(f.vault.use(f.alice, item.id, 'cloud.deploy', async () => true)).rejects.toThrow();
  f.calls.failDelete = false;
  expect(await f.vault.reconcile()).toMatchObject({ pending: 1, deleted: 0 });
  f.advance(2000);
  expect(await f.vault.reconcile()).toMatchObject({ pending: 0, deleted: 1 });
  expect(f.values.size).toBe(0);
  expect(f.vault.list(f.alice)).toEqual([]);
  expect(f.vault.auditEvents(f.alice, item.id)).toContain('revoked-local');
});

test('rotate fences generations and cleans old remote version; quota rejects before remote write', async () => {
  const f = fixture();
  const item = await f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'old' });
  const rotated = await f.vault.rotate(f.alice, item.id, 'new');
  expect(rotated.generation).toBe(2);
  expect(f.values.size).toBe(1);
  expect(await f.vault.use(f.alice, item.id, 'cloud.deploy', async value => value)).toBe('new');
  for (let i = 1; i < 5; i++) await f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: String(i) });
  const writes = f.calls.set;
  await expect(f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'sixth' })).rejects.toThrow('CLOUD_VAULT_QUOTA');
  await expect(f.vault.rotate(f.alice, item.id, '😀'.repeat(2049))).rejects.toThrow('CLOUD_VAULT_VALUE_INVALID');
  expect(f.calls.set).toBe(writes);
});

test('revoke racing an in-flight rotate never reactivates the secret', async () => {
  const f = fixture();
  const item = await f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'old' });
  const otherProcess = f.second();
  const originalSet = f.backend.set;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.backend.set = async (key, value) => { await barrier; return originalSet(key, value); };
  const rotation = f.vault.rotate(f.alice, item.id, 'new');
  await otherProcess.revoke(f.alice, item.id);
  release();
  await expect(rotation).rejects.toThrow('CLOUD_VAULT_ROTATE_FAILED');
  await f.vault.reconcile();
  expect(f.vault.list(f.alice)).toEqual([]);
  expect(f.values.size).toBe(0);
});

test('remote write followed by failure stays denied and is cleaned after restart', async () => {
  const f = fixture();
  const originalSet = f.backend.set;
  f.backend.set = async (key, value) => { await originalSet(key, value); throw new Error('fake crash after write'); };
  await expect(f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'CANARY-orphan' }))
    .rejects.toThrow('CLOUD_VAULT_STORE_FAILED');
  expect(f.values.size).toBe(1);
  f.reopen();
  expect(f.vault.list(f.alice)[0]?.state).toBe('pending-deletion');
  expect(await f.vault.reconcile()).toMatchObject({ pending: 0, deleted: 1 });
  expect(f.values.size).toBe(0);
});

test('plan downgrade during remote rotation cannot activate the new generation', async () => {
  const f = fixture();
  const item = await f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'old' });
  const originalSet = f.backend.set;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.backend.set = async (key, value) => { await barrier; return originalSet(key, value); };
  const rotation = f.vault.rotate(f.alice, item.id, 'new');
  f.memberStore.assignPlan(f.alice.memberId, 'free');
  release();
  await expect(rotation).rejects.toThrow('CLOUD_VAULT_ROTATE_FAILED');
  await f.vault.reconcile();
  expect(f.vault.list(f.alice)[0]?.generation).toBe(1);
  expect(f.values.size).toBe(1);
  expect([...f.values.values()]).toEqual(['old']);
});

test('malformed and zero plan quotas fail before any remote write', async () => {
  const f = fixture();
  const input = { provider: 'gcp' as const, purposes: ['cloud.deploy'], value: 'credential' };
  f.memberStore.provisionPlan({ plan: 'advanced', entitlements: {
    'cloud.secret.store': true, 'cloud.secret.use': true, 'cloud.secret.maxItems': 'five',
  } });
  await expect(f.vault.register(f.alice, input)).rejects.toThrow('CLOUD_VAULT_PLAN_INVALID');
  f.memberStore.provisionPlan({ plan: 'advanced', entitlements: {
    'cloud.secret.store': true, 'cloud.secret.use': true, 'cloud.secret.maxBytes': 0,
  } });
  await expect(f.vault.register(f.alice, input)).rejects.toThrow('CLOUD_VAULT_VALUE_INVALID');
  expect(f.calls.set).toBe(0);
});

test('packet maxItems quota blocks the second registration before remote write', async () => {
  const f = fixture();
  f.memberStore.provisionPlan({ plan: 'advanced', entitlements: {
    'cloud.secret.store': true, 'cloud.secret.use': true, 'cloud.secret.maxItems': 1,
  } });
  const input = { provider: 'gcp' as const, purposes: ['cloud.deploy'], value: 'credential' };
  await f.vault.register(f.alice, input);
  await expect(f.vault.register(f.alice, input)).rejects.toThrow('CLOUD_VAULT_QUOTA');
  expect(f.calls.set).toBe(1);
  expect(f.vault.list(f.alice)).toHaveLength(1);
});

test('second service cannot reconcile a generation while backend set is in flight', async () => {
  const f = fixture();
  const secondService = f.second();
  const originalSet = f.backend.set;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.backend.set = async (key, value) => { await originalSet(key, value); await barrier; };
  const registration = f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'credential' });
  expect(f.values.size).toBe(1);
  expect(await secondService.reconcile()).toEqual({ pending: 1, deleted: 0 });
  expect(f.values.size).toBe(1);
  release();
  const item = await registration;
  expect(item.state).toBe('active');
  expect(await secondService.use(f.alice, item.id, 'cloud.deploy', async value => value)).toBe('credential');
});

test('expired writer lease fences activation if cleanup runs before set returns', async () => {
  const f = fixture();
  const secondService = f.second();
  const originalSet = f.backend.set;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.backend.set = async (key, value) => { await originalSet(key, value); await barrier; };
  const registration = f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'credential' });
  f.advance(5 * 60_000 + 1);
  expect(await secondService.reconcile()).toEqual({ pending: 0, deleted: 1 });
  release();
  await expect(registration).rejects.toThrow('CLOUD_VAULT_STORE_FAILED');
  await secondService.reconcile();
  expect(f.vault.list(f.alice)).toEqual([]);
  expect(f.values.size).toBe(0);
});

test('second service cannot clean a pending rotation before its remote write resolves', async () => {
  const f = fixture();
  const item = await f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'old' });
  const secondService = f.second();
  const originalSet = f.backend.set;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.backend.set = async (key, value) => { await originalSet(key, value); await barrier; };
  const rotation = f.vault.rotate(f.alice, item.id, 'new');
  expect(f.values.size).toBe(2);
  expect(await secondService.reconcile()).toEqual({ pending: 1, deleted: 0 });
  release();
  expect((await rotation).generation).toBe(2);
  expect(await secondService.use(f.alice, item.id, 'cloud.deploy', async value => value)).toBe('new');
  expect([...f.values.values()]).toEqual(['new']);
});

test('crashed register writer releases its quota slot terminally after the lease', async () => {
  const f = fixture();
  const originalSet = f.backend.set;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.backend.set = async (key, value) => {
    if (value === 'CANARY-crashed') await barrier; // only the crashing writer stalls
    return originalSet(key, value);
  };
  const crashed = f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'CANARY-crashed' });
  void crashed.catch(() => {}); // the writer never resumes: simulated process crash
  const [stuck] = f.vault.list(f.alice);
  expect(stuck?.state).toBe('pending-deletion');
  f.advance(5 * 60_000 + 1);
  expect(await f.second().reconcile()).toEqual({ pending: 0, deleted: 1 });
  expect(f.vault.list(f.alice)).toEqual([]); // no pending zombie: recovery is terminal
  expect(f.vault.auditEvents(f.alice, stuck!.id)).toContain('register-abandoned');
  expect(f.values.has(`member-vault/${stuck!.id}/v1`)).toBe(false);
  for (let i = 0; i < 5; i++) { // the burned quota slot is reusable
    await f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: `fresh-${i}` });
  }
  await expect(f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'sixth' }))
    .rejects.toThrow('CLOUD_VAULT_QUOTA');
});

test('crashed rotate writer abandons its pending generation instead of wedging rotation', async () => {
  const f = fixture();
  const item = await f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'old' });
  const originalSet = f.backend.set;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.backend.set = async (key, value) => {
    if (value === 'never-lands') await barrier; // only the crashing writer stalls
    return originalSet(key, value);
  };
  const crashed = f.vault.rotate(f.alice, item.id, 'never-lands');
  void crashed.catch(() => {}); // the writer never resumes: simulated process crash
  f.advance(5 * 60_000 + 1);
  expect(await f.second().reconcile()).toEqual({ pending: 0, deleted: 1 });
  const retry = await f.vault.rotate(f.alice, item.id, 'second-attempt'); // no permanent CONFLICT
  expect(retry.generation).toBe(3); // the abandoned target 2 is reserved, never reused
  expect(await f.vault.use(f.alice, item.id, 'cloud.deploy', async value => value)).toBe('second-attempt');
  const events = f.vault.auditEvents(f.alice, item.id);
  expect(events.filter(event => event === 'rotated')).toHaveLength(1);
  expect(events).not.toContain('rotate-failed'); // the crashed attempt never committed or unwound
  expect(f.values.has(`member-vault/${item.id}/v2`)).toBe(false);
});

test('late rotate writer cannot commit once its expired lease fence is consumed', async () => {
  const f = fixture();
  const item = await f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'old' });
  const originalSet = f.backend.set;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.backend.set = async (key, value) => { await originalSet(key, value); await barrier; };
  const late = f.vault.rotate(f.alice, item.id, 'late-value');
  f.advance(5 * 60_000 + 1);
  expect(await f.second().reconcile()).toEqual({ pending: 0, deleted: 1 }); // fence consumed, remote v2 deleted
  release(); // the stalled writer resumes long after its lease expired
  await expect(late).rejects.toThrow('CLOUD_VAULT_ROTATE_FAILED');
  expect(f.vault.list(f.alice)[0]?.generation).toBe(1);
  expect(await f.vault.use(f.alice, item.id, 'cloud.deploy', async value => value)).toBe('old');
  await f.vault.reconcile();
  expect([...f.values.values()]).toEqual(['old']);
});

test('late rotate writer cannot steal a newer attempt on the same secret', async () => {
  const f = fixture();
  const item = await f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'old' });
  const originalSet = f.backend.set;
  let releaseStale!: () => void;
  const staleBarrier = new Promise<void>(resolve => { releaseStale = resolve; });
  f.backend.set = async (key, value) => {
    if (value === 'stale-value') await staleBarrier; // the stale writer stalls before its write lands
    return originalSet(key, value);
  };
  const stale = f.vault.rotate(f.alice, item.id, 'stale-value');
  f.advance(5 * 60_000 + 1);
  expect(await f.second().reconcile()).toEqual({ pending: 0, deleted: 1 }); // stale fence consumed
  const fresh = await f.vault.rotate(f.alice, item.id, 'fresh-value'); // owner rotates again
  expect(fresh.generation).toBe(3);
  releaseStale(); // the stale write finally lands on its reserved, unreferenced generation
  await expect(stale).rejects.toThrow('CLOUD_VAULT_ROTATE_FAILED');
  expect(await f.vault.use(f.alice, item.id, 'cloud.deploy', async value => value)).toBe('fresh-value');
  expect(f.vault.list(f.alice)[0]?.generation).toBe(3);
  await f.vault.reconcile();
  expect([...f.values.values()]).toEqual(['fresh-value']);
});

test('failed retry cannot reuse a late writer generation after its cleanup fence was consumed', async () => {
  const f = fixture();
  const item = await f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'old' });
  const originalSet = f.backend.set;
  let releaseStale!: () => void;
  const staleBarrier = new Promise<void>(resolve => { releaseStale = resolve; });
  f.backend.set = async (key, value) => {
    if (value === 'stale-v2') await staleBarrier;
    if (value === 'failed-v3') throw new Error('fake backend failure');
    return originalSet(key, value);
  };
  const stale = f.vault.rotate(f.alice, item.id, 'stale-v2');
  f.advance(5 * 60_000 + 1);
  const otherProcess = f.second();
  expect(await otherProcess.reconcile()).toEqual({ pending: 0, deleted: 1 });
  await expect(otherProcess.rotate(f.alice, item.id, 'failed-v3'))
    .rejects.toThrow('CLOUD_VAULT_ROTATE_FAILED');
  const fresh = await otherProcess.rotate(f.alice, item.id, 'fresh-v4');
  expect(fresh.generation).toBe(4); // v2 and failed v3 remain burned across services
  releaseStale(); // v2 lands after v4 is already active
  await expect(stale).rejects.toThrow('CLOUD_VAULT_ROTATE_FAILED');
  expect(await otherProcess.use(f.alice, item.id, 'cloud.deploy', async value => value)).toBe('fresh-v4');
  await otherProcess.reconcile();
  expect([...f.values.values()]).toEqual(['fresh-v4']);
});

test('cleanup retry does not extend a pending writer lease', async () => {
  const f = fixture();
  const originalSet = f.backend.set;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.backend.set = async (key, value) => { await originalSet(key, value); await barrier; };
  const registration = f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'late' });
  f.advance(5 * 60_000 + 1);
  f.calls.failDelete = true;
  expect(await f.second().reconcile()).toEqual({ pending: 1, deleted: 0 });
  f.calls.failDelete = false;
  release();
  await expect(registration).rejects.toThrow('CLOUD_VAULT_STORE_FAILED');
  await f.vault.reconcile();
  expect(f.vault.list(f.alice)).toEqual([]);
  expect(f.values.size).toBe(0);
});

test('retained cleanup removes a set that lands after the first deletion and writer death', async () => {
  const f = fixture();
  const originalSet = f.backend.set;
  let releaseWrite!: () => void;
  let signalWritten!: () => void;
  const beforeWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
  const written = new Promise<void>(resolve => { signalWritten = resolve; });
  const never = new Promise<void>(() => {});
  f.backend.set = async (key, value) => {
    await beforeWrite;
    await originalSet(key, value);
    signalWritten();
    await never; // process disappears after remote set, before local commit/catch
  };
  const abandoned = f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'late-orphan' });
  void abandoned.catch(() => {});
  f.advance(5 * 60_000 + 1);
  const survivor = f.second();
  expect(await survivor.reconcile()).toEqual({ pending: 0, deleted: 1 });
  expect(f.values.size).toBe(0);
  releaseWrite();
  await written;
  expect(f.values.size).toBe(1);
  f.advance(2000);
  expect(await survivor.reconcile()).toMatchObject({ deleted: 1 });
  expect(f.values.size).toBe(0);
  expect(survivor.list(f.alice)).toEqual([]);
});

test('versioned cleanup preserves a renewed intent when concurrent reconcilers finish out of order', async () => {
  const f = fixture();
  const originalSet = f.backend.set;
  const originalDelete = f.backend.delete;
  let releaseWrite!: () => void;
  const beforeWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
  f.backend.set = async (key, value) => { await beforeWrite; return originalSet(key, value); };
  const late = f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'late-write' });
  f.advance(5 * 60_000 + 1);
  let signalFirstDelete!: () => void;
  let releaseFirstDelete!: () => void;
  const firstDeleted = new Promise<void>(resolve => { signalFirstDelete = resolve; });
  const firstBarrier = new Promise<void>(resolve => { releaseFirstDelete = resolve; });
  let deletes = 0;
  f.backend.delete = async key => {
    await originalDelete(key);
    if (++deletes === 1) { signalFirstDelete(); await firstBarrier; }
    return true;
  };
  const first = f.vault.reconcile();
  await firstDeleted;
  await f.second().reconcile();
  releaseWrite();
  await expect(late).rejects.toThrow('CLOUD_VAULT_STORE_FAILED');
  expect(f.values.size).toBe(1);
  releaseFirstDelete();
  await first;
  await f.vault.reconcile();
  expect(f.values.size).toBe(0);
});

test('legacy cleanup generations migrate into the persistent highwater', async () => {
  const f = fixture();
  const item = await f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'old' });
  const db = new Database(f.vaultPath);
  db.query('INSERT INTO vault_cleanup(remote_id,secret_id,next_attempt_at) VALUES (?,?,?)')
    .run(`member-vault/${item.id}/v2`, item.id, '2026-11-13T00:00:00.000Z');
  db.exec('ALTER TABLE vault_secrets DROP COLUMN generation_highwater');
  const legacyColumns = new Set((db.query('PRAGMA table_info(vault_cleanup)').all() as Array<{name: string}>).map(row => row.name));
  for (const column of ['last_deleted_at', 'version', 'retain', 'lease_expires_at'])
    if (legacyColumns.has(column)) db.exec(`ALTER TABLE vault_cleanup DROP COLUMN ${column}`);
  db.close();
  f.reopen();
  const rotated = await f.vault.rotate(f.alice, item.id, 'fresh');
  expect(rotated.generation).toBe(3); // v2 was reserved by the old cleanup row
  expect(await f.vault.use(f.alice, item.id, 'cloud.deploy', async value => value)).toBe('fresh');
});

test('concurrent service openers finish legacy backfill before exposing rotation', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.cloud-vault-migrate-test-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'vault.sqlite');
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE vault_secrets (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, provider TEXT NOT NULL, purposes TEXT NOT NULL,
    generation INTEGER NOT NULL, pending_generation INTEGER, state TEXT NOT NULL,
    created_at TEXT NOT NULL, revoked_at TEXT);
    CREATE TABLE vault_cleanup (
    remote_id TEXT PRIMARY KEY, secret_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z');`);
  db.query("INSERT INTO vault_secrets VALUES ('legacy','alice','gcp','[\"deploy\"]',1,NULL,'active','2026-11-13T00:00:00Z',NULL)").run();
  db.query("INSERT INTO vault_cleanup(remote_id,secret_id) VALUES ('member-vault/legacy/v3','legacy')").run();
  // The parent writer lock holds both child processes at the migration gate.
  // After release, one must finish every schema/backfill statement before the
  // other opener returns; both must see the same reserved generation.
  db.exec('BEGIN IMMEDIATE');
  const moduleUrl = new URL('./cloud-secret-vault.ts', import.meta.url).href;
  const script = `const {createCloudSecretVault}=await import(${JSON.stringify(moduleUrl)});
    const path=${JSON.stringify(path)};
    const vault=createCloudSecretVault({dbPath:path,backend:{id:'gcp',set:async()=>{},get:async()=>undefined,delete:async()=>{},list:async()=>[],isAvailable:async()=>({ok:true})},memberStore:{memberPlanForMember:()=>null},isPrincipalActive:()=>true});
    const {Database}=await import('bun:sqlite'); const db=new Database(path);
    const highwater=db.query("SELECT generation_highwater FROM vault_secrets WHERE id='legacy'").get().generation_highwater;
    console.log(highwater); db.close(); vault.close();`;
  const children = [0, 1].map(() => Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' }));
  await Bun.sleep(100);
  db.exec('COMMIT');
  const results = await Promise.all(children.map(async child => ({
    exit: await child.exited,
    out: (await new Response(child.stdout).text()).trim(),
    err: await new Response(child.stderr).text(),
  })));
  expect(results.map(result => [result.exit, result.out, result.err])).toEqual([[0, '3', ''], [0, '3', '']]);
  expect((db.query("SELECT generation_highwater FROM vault_secrets WHERE id='legacy'").get() as {generation_highwater:number}).generation_highwater).toBe(3);
  const vault = createCloudSecretVault({ dbPath: path,
    backend: { id: 'gcp', set: async () => {}, get: async () => undefined, delete: async () => true,
      list: async () => [], isAvailable: async () => ({ ok: true }) },
    memberStore: { memberPlanForMember: () => ({ plan: 'advanced', entitlements: {'cloud.secret.store': true} }) },
    isPrincipalActive: () => true, now: () => new Date('2026-11-13T00:00:00Z') });
  cleanup.unshift(() => { vault.close(); db.close(); });
  const rotated = await vault.rotate({memberId:'alice',sessionExpiresAt:'2026-11-14T00:00:00Z'}, 'legacy', 'new');
  expect(rotated.generation).toBe(4);
});

test('remote set before local commit followed by process death is cleaned after restart', async () => {
  const f = fixture();
  const item = await f.vault.register(f.alice, { provider: 'gcp', purposes: ['cloud.deploy'], value: 'old' });
  const originalSet = f.backend.set;
  let remoteKey = '';
  let signalWritten!: () => void;
  const written = new Promise<void>(resolve => { signalWritten = resolve; });
  const never = new Promise<void>(() => {});
  f.backend.set = async (key, value) => {
    await originalSet(key, value);
    if (value === 'uncommitted-v2') { remoteKey = key; signalWritten(); await never; }
  };
  const abandoned = f.vault.rotate(f.alice, item.id, 'uncommitted-v2');
  void abandoned.catch(() => {});
  await written;
  expect(f.values.size).toBe(2); // remote set landed, SQLite generation is still v1
  f.reopen(); // original writer dies with no catch/finally cleanup
  expect(f.vault.list(f.alice)[0]?.generation).toBe(1);
  f.advance(5 * 60_000 + 1);
  await f.vault.reconcile();
  expect([...f.values.values()]).toEqual(['old']);
  await originalSet(remoteKey, 'uncommitted-v2'); // remote provider completes a delayed write after client death
  expect(f.values.size).toBe(2);
  f.advance(2000);
  await f.vault.reconcile(); // durable intent must recheck even after an earlier successful delete
  expect([...f.values.values()]).toEqual(['old']);
  expect(f.vault.list(f.alice)[0]?.generation).toBe(1);
});
