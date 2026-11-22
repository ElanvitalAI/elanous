/** Tiered cloud-sync quota boundary: catalog rows are the only place a limit lives. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberStore } from './member-store.js';
import { createBackupRecoveryKeyPair, createBackupSenderKeyPair, createMemberCloudBackupApi,
  decryptMemberBackup, encryptMemberBackup as encryptSignedMemberBackup,
  type BackupSenderKeyPair, type EncryptedMemberBackup } from './cloud-backup-e2e.js';

const cleanup: Array<() => void> = [];
let sender: BackupSenderKeyPair;
beforeEach(async () => { sender = await createBackupSenderKeyPair(); });
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
const text = (value: string) => new Uint8Array(Buffer.from(value, 'utf8'));
const encryptMemberBackup = (plaintext: Uint8Array, recoveryPublicKey: Uint8Array,
  input: { id?: string; generation?: number; dataKind?: string } = {}) =>
  encryptSignedMemberBackup(plaintext, recoveryPublicKey, sender, input);
// Wire length from format contracts only — never read back from a produced envelope (rule 11):
// id 36 chars, nonce 24B→32, ciphertext b64(plaintext+16), sealedKey 80B→108, pubkeys 32B→44,
// signature 64B→88, sha256 64 hex; the JSON key order matches the producer's envelope literal.
const b64 = (n: number) => Math.ceil(n / 3) * 4;
const wireBytesOf = (input: { plaintext: string; dataKind?: string }) =>
  Buffer.byteLength(JSON.stringify({ version: 1, id: 'A'.repeat(36), generation: 1,
    dataKind: input.dataKind ?? 'secrets', nonce: 'A'.repeat(32),
    ciphertext: 'A'.repeat(b64(Buffer.byteLength(input.plaintext, 'utf8') + 16)),
    sealedKey: 'A'.repeat(108), recoveryPublicKey: 'A'.repeat(44), sha256: '0'.repeat(64),
    senderPublicKey: 'A'.repeat(44), senderSignature: 'A'.repeat(88) }), 'utf8');

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-backup-quota-'));
  const store = createMemberStore({ path: join(dir, 'members.sqlite') });
  const api = createMemberCloudBackupApi({ dbPath: join(dir, 'backup.sqlite'), memberStore: store,
    now: () => new Date('2026-11-14T00:00:00Z') });
  const member = (name: string) => {
    const profile = store.register({ sub: `sub-${name}`, email: `${name}@example.test`, emailVerified: true, name },
      { consents: { privacy: 'v1', terms: 'v1' } });
    return { profile, token: store.createSession(profile.id, '2026-11-14T00:00:00Z').token };
  };
  const alice = member('alice');
  const bob = member('bob');
  const call = (token: string | null, method: string, path: string, body?: unknown,
    headers: Record<string, string> = {}) =>
    api.handle(new Request(`https://fake-storage.example.test${path}`, {
      method, headers: { ...(token ? { cookie: `__Host-elanous_member_session=${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })) as Promise<Response>;
  const base = '/v1/members/secret-backups';
  const post = (envelope: EncryptedMemberBackup, key: string) =>
    call(alice.token, 'POST', base, envelope, { 'if-match': '"0"', 'idempotency-key': key });
  const provision = (plan: string, entitlements: Record<string, unknown>) =>
    store.provisionPlan({ plan, entitlements });
  cleanup.push(() => { api.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, api, alice, bob, call, base, post, provision };
}

async function envelopeOf(payload: string, input: { id?: string; generation?: number; dataKind?: string } = {}) {
  const recovery = await createBackupRecoveryKeyPair();
  return { recovery, envelope: await encryptMemberBackup(text(`SYNTHETIC-${payload}`), recovery.publicKey, input) };
}

const FREE_SYNC = { 'relay.connect': true, 'backup.sync': true,
  'backup.maxSyncBytes': 4096, 'backup.maxGenerations': 2,
  'backup.dataKinds': ['sessions', 'memory', 'settings', 'secrets'] } as const;

test('catalog rows cap live generations and sync bytes; plan upgrade and row edits move the ceiling', async () => {
  const w = world();
  w.provision('free', { ...FREE_SYNC });
  const first = await envelopeOf('QUOTA-FIRST');
  const second = await envelopeOf('QUOTA-SECOND');
  const third = await envelopeOf('QUOTA-THIRD');
  const fourth = await envelopeOf('QUOTA-FOURTH');
  expect((await w.post(first.envelope, 'quota-first')).status).toBe(201);
  expect((await w.post(second.envelope, 'quota-second')).status).toBe(201);
  const generationCap = await w.post(third.envelope, 'quota-third');
  expect(generationCap.status).toBe(403);
  expect(await generationCap.json()).toMatchObject({ error: 'backup-quota-exceeded',
    quota: { reason: 'generations', maxGenerations: 2, liveGenerations: 2 } });
  // Plan upgrade widens the ceiling; the rejected request replays cleanly under the same key.
  w.provision('plus', { ...FREE_SYNC, 'backup.maxSyncBytes': 1_000_000, 'backup.maxGenerations': 4,
    'backup.dataKinds': ['sessions', 'memory', 'settings', 'secrets', 'app-source', 'app-db', 'docs'] });
  expect(w.store.assignPlan(w.alice.profile.id, 'plus')).toBe(true);
  expect((await w.post(third.envelope, 'quota-third')).status).toBe(201);
  // Catalog-row edit alone (no application code change) tightens the byte ceiling.
  const used = wireBytesOf({ plaintext: 'SYNTHETIC-QUOTA-FIRST' })
    + wireBytesOf({ plaintext: 'SYNTHETIC-QUOTA-SECOND' })
    + wireBytesOf({ plaintext: 'SYNTHETIC-QUOTA-THIRD' });
  w.provision('plus', { ...FREE_SYNC, 'backup.maxSyncBytes': used, 'backup.maxGenerations': 4,
    'backup.dataKinds': ['sessions', 'memory', 'settings', 'secrets'] });
  const byteCap = await w.post(fourth.envelope, 'quota-fourth');
  expect(byteCap.status).toBe(403);
  expect(await byteCap.json()).toMatchObject({ error: 'backup-quota-exceeded',
    quota: { reason: 'bytes', maxSyncBytes: used, usedSyncBytes: used } });
  // Widening the row again admits the same request.
  w.provision('plus', { ...FREE_SYNC, 'backup.maxSyncBytes': 1_000_000, 'backup.maxGenerations': 4,
    'backup.dataKinds': ['sessions', 'memory', 'settings', 'secrets'] });
  expect((await w.post(fourth.envelope, 'quota-fourth')).status).toBe(201);
});

test('envelope dataKind admission is catalog-row data: unentitled kind 403, row edit admits it', async () => {
  const w = world();
  w.provision('free', { ...FREE_SYNC });
  const denied = await envelopeOf('KIND-DENIED', { dataKind: 'app-source' });
  const rejected = await w.post(denied.envelope, 'kind-denied');
  expect(rejected.status).toBe(403);
  expect(await rejected.json()).toMatchObject({ error: 'backup-quota-exceeded',
    quota: { reason: 'kind', dataKind: 'app-source',
      dataKinds: ['sessions', 'memory', 'settings', 'secrets'] } });
  // A catalog-row edit alone (no application code change) admits the same request.
  w.provision('free', { ...FREE_SYNC, 'backup.dataKinds': ['sessions', 'memory', 'settings', 'secrets', 'app-source'] });
  expect((await w.post(denied.envelope, 'kind-denied')).status).toBe(201);
});

test('writes without a dataKind are rejected 400; legacy rows without it still decrypt', async () => {
  const w = world();
  w.provision('free', { ...FREE_SYNC });
  const { recovery, envelope } = await envelopeOf('KIND-LEGACY');
  const legacy: Record<string, unknown> = { ...envelope };
  delete legacy.dataKind;
  const missing = await w.call(w.alice.token, 'POST', w.base, legacy,
    { 'if-match': '"0"', 'idempotency-key': 'kind-legacy-missing' });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ error: 'invalid-request' });
  expect((await w.post(envelope, 'kind-legacy-typed')).status).toBe(201);
  const restored = await decryptMemberBackup(legacy, recovery,
    { id: envelope.id, minGeneration: 1, trustedSenderPublicKey: sender.publicKey });
  expect(Buffer.from(restored).toString()).toBe('SYNTHETIC-KIND-LEGACY');
});

test('rotation replaces the old envelope bytes instead of double-counting them', async () => {
  const w = world();
  const used = await (async () => {
    const one = await envelopeOf('ROTATE-ONE');
    w.provision('free', { ...FREE_SYNC, 'backup.maxSyncBytes': 1_000_000 });
    expect((await w.post(one.envelope, 'rotate-one')).status).toBe(201);
    const rotated = await encryptMemberBackup(text('SYNTHETIC-ROTATE-TWO'), one.recovery.publicKey,
      { id: one.envelope.id, generation: 2 });
    // Tighten the byte row to exactly one envelope: rotation must replace, not add.
    w.provision('free', { ...FREE_SYNC, 'backup.maxSyncBytes': wireBytesOf({ plaintext: 'SYNTHETIC-ROTATE-ONE' }), 'backup.maxGenerations': 2 });
    const headers = { 'if-match': '"1"', 'idempotency-key': 'rotate-two' };
    const bigger = await encryptMemberBackup(new Uint8Array(wireBytesOf({ plaintext: 'SYNTHETIC-ROTATE-ONE' }) + 2048), one.recovery.publicKey,
      { id: one.envelope.id, generation: 2 });
    expect((await w.call(w.alice.token, 'PUT', `${w.base}/${one.envelope.id}`, bigger, headers)).status).toBe(403);
    const fits = await w.call(w.alice.token, 'PUT', `${w.base}/${one.envelope.id}`, rotated, headers);
    expect(fits.status).toBe(200);
    return one;
  })();
  const listed = await w.call(w.alice.token, 'GET', w.base);
  const body = await listed.json() as { backups: Array<{ id: string }>; quota: { liveGenerations: number } };
  expect(body.backups.map(item => item.id)).toEqual([used.envelope.id]);
  expect(body.quota.liveGenerations).toBe(1);
});

test('list response carries the tier quota block including data-kind entitlements', async () => {
  const w = world();
  const empty = await w.call(w.alice.token, 'GET', w.base);
  // The free migration rows are the default quota contract, observed end to end.
  expect(await empty.json()).toMatchObject({ backups: [], quota: { plan: 'free',
    maxSyncBytes: 268435456, maxGenerations: 64, usedSyncBytes: 0, liveGenerations: 0,
    dataKinds: ['sessions', 'memory', 'settings'] } });
  const one = await envelopeOf('LIST-ONE', { dataKind: 'sessions' });
  expect((await w.post(one.envelope, 'list-one')).status).toBe(201);
  const filled = await w.call(w.alice.token, 'GET', w.base);
  expect(await filled.json()).toMatchObject({ quota: { plan: 'free',
    usedSyncBytes: wireBytesOf({ plaintext: 'SYNTHETIC-LIST-ONE', dataKind: 'sessions' }),
    liveGenerations: 1, dataKinds: ['sessions', 'memory', 'settings'] } });
  // The free default kinds exclude secrets: the default envelope kind is rejected until a
  // catalog row provisions it (review must-fix, OP #131157).
  const secretKind = await envelopeOf('LIST-SECRET-KIND');
  const secretDenied = await w.post(secretKind.envelope, 'list-secret-kind');
  expect(secretDenied.status).toBe(403);
  expect(await secretDenied.json()).toMatchObject({ error: 'backup-quota-exceeded',
    quota: { reason: 'kind', dataKind: 'secrets', dataKinds: ['sessions', 'memory', 'settings'] } });
  // The server stores ciphertext only, so data-kind gating is a client-side decision built on
  // this quota block; higher tiers widen the advertised kinds through catalog rows alone.
  w.provision('plus', { ...FREE_SYNC, 'backup.maxSyncBytes': 1_000_000, 'backup.maxGenerations': 4,
    'backup.dataKinds': ['sessions', 'memory', 'settings', 'app-source', 'app-db', 'docs'] });
  expect(w.store.assignPlan(w.bob.profile.id, 'plus')).toBe(true);
  const upper = await w.call(w.bob.token, 'GET', w.base);
  expect(await upper.json()).toMatchObject({ quota: { plan: 'plus',
    dataKinds: ['sessions', 'memory', 'settings', 'app-source', 'app-db', 'docs'] } });
});

test('missing or misconfigured backup entitlements fail closed', async () => {
  const w = world();
  const one = await envelopeOf('CLOSED-ONE');
  w.provision('free', { 'relay.connect': true });
  const denied = await w.post(one.envelope, 'closed-one');
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: 'backup-plan-required' });
  w.provision('free', { 'backup.sync': true });
  expect((await w.post(one.envelope, 'closed-two')).status).toBe(503);
  w.provision('free', { 'backup.sync': true, 'backup.maxSyncBytes': 'big', 'backup.maxGenerations': 2 });
  const misconfigured = await w.post(one.envelope, 'closed-three');
  expect(misconfigured.status).toBe(503);
  expect(await misconfigured.json()).toEqual({ error: 'quota-unavailable' });
  // Empty-string kind rows (e.g. [""]) are malformed, not a valid zero-kind catalog.
  w.provision('free', { 'backup.sync': true, 'backup.maxSyncBytes': 4096, 'backup.maxGenerations': 2,
    'backup.dataKinds': [''] });
  expect((await w.post(one.envelope, 'closed-four')).status).toBe(503);
  const listed = await w.call(w.alice.token, 'GET', w.base);
  expect(listed.status).toBe(503);
  expect(await listed.json()).toEqual({ error: 'quota-unavailable' });
  // Plan removal also fails the listing closed instead of serving a quota-less 200.
  w.provision('free', { 'relay.connect': true });
  const noPlan = await w.call(w.alice.token, 'GET', w.base);
  expect(noPlan.status).toBe(403);
  expect(await noPlan.json()).toEqual({ error: 'backup-plan-required' });
});
