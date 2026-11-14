import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createMemberStore } from './member-store.js';
import { createBackupRecoveryKeyPair, createBackupSenderKeyPair, createMemberCloudBackupApi,
  decryptMemberBackup as decryptSignedMemberBackup, encryptMemberBackup as encryptSignedMemberBackup,
  maxBackupPlaintextBytes, MAX_BACKUP_WIRE_BYTES, type BackupSenderKeyPair, type EncryptedMemberBackup } from './cloud-backup-e2e.js';

const cleanup: Array<() => void> = [];
let sender: BackupSenderKeyPair;
beforeEach(async () => { sender = await createBackupSenderKeyPair(); });
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
const text = (value: string) => new Uint8Array(Buffer.from(value, 'utf8'));
const encryptMemberBackup = (plaintext: Uint8Array, recoveryPublicKey: Uint8Array,
  input: { id?: string; generation?: number } = {}) =>
  encryptSignedMemberBackup(plaintext, recoveryPublicKey, sender, input);
const decryptMemberBackup = (value: unknown, recovery: { publicKey: Uint8Array; secretKey: Uint8Array },
  expected: { id: string; minGeneration: number }) =>
  decryptSignedMemberBackup(value, recovery, { ...expected, trustedSenderPublicKey: sender.publicKey });

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-backup-e2e-'));
  const store = createMemberStore({ path: join(dir, 'members.sqlite') });
  const dbPath = join(dir, 'backup.sqlite');
  let now = new Date('2026-11-14T00:00:00Z');
  const api = createMemberCloudBackupApi({ dbPath, memberStore: store, now: () => now });
  const member = (name: string) => {
    const profile = store.register({ sub: `sub-${name}`, email: `${name}@example.test`, emailVerified: true, name },
      { consents: { privacy: 'v1', terms: 'v1' } });
    return { profile, token: store.createSession(profile.id, '2026-11-14T00:00:00Z').token };
  };
  const alice = member('alice');
  const bob = member('bob');
  const call = (token: string | null, method: string, path: string, body?: unknown,
    headers: Record<string, string> = {}, server = api) =>
    server.handle(new Request(`https://fake-storage.example.test${path}`, {
      method, headers: { ...(token ? { cookie: `__Host-elanous_member_session=${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })) as Promise<Response>;
  const base = '/v1/members/secret-backups';
  cleanup.push(() => { api.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, dbPath, store, api, alice, bob, call, base,
    advanceDays(days: number) { now = new Date(now.getTime() + days * 24 * 60 * 60_000); } };
}

test('free member encrypts before fake-server upload; server persists ciphertext only; recovery needs auth and key', async () => {
  const w = world();
  const recovery = await createBackupRecoveryKeyPair();
  const secret = 'SYNTHETIC-STATIC-KEY-ONLY';
  const envelope = await encryptMemberBackup(text(secret), recovery.publicKey);
  expect(JSON.stringify(envelope)).not.toContain(secret);
  expect(JSON.stringify(envelope)).not.toContain(Buffer.from(recovery.secretKey).toString('base64'));
  const posted = await w.call(w.alice.token, 'POST', w.base, envelope, { 'if-match': '"0"', 'idempotency-key': 'create-1' });
  expect(posted.status).toBe(201);
  expect(await posted.json()).toMatchObject({ id: envelope.id, generation: 1 });
  const db = new Database(w.dbPath);
  try {
    const stored = db.query('SELECT owner,envelope FROM member_backup').get() as { owner: string; envelope: string };
    expect(stored.owner).toBe(w.alice.profile.id);
    expect(stored.envelope).not.toContain(secret);
    expect(stored.envelope).not.toContain('memberId');
    expect(db.query('PRAGMA table_info(member_backup)').all().map((x: any) => x.name)).not.toContain('plaintext');
  } finally { db.close(); }
  const listed = await w.call(w.alice.token, 'GET', w.base);
  expect(await listed.json()).toEqual({ backups: [{ id: envelope.id, generation: 1, sha256: envelope.sha256 }] });
  const denied = await w.call(null, 'GET', `${w.base}/${envelope.id}`);
  expect(denied.status).toBe(401);
  const downloaded = await w.call(w.alice.token, 'GET', `${w.base}/${envelope.id}`);
  const received = (await downloaded.json() as { backup: EncryptedMemberBackup }).backup;
  expect(Buffer.from(await decryptMemberBackup(received, recovery, { id: envelope.id, minGeneration: received.generation })).toString()).toBe(secret);
  const wrong = await createBackupRecoveryKeyPair();
  await expect(decryptMemberBackup(received, wrong, { id: envelope.id, minGeneration: received.generation })).rejects.toThrow('BACKUP_RECOVERY_DENIED');
  const futureGeneration = received.generation + 1;
  await expect(decryptMemberBackup(received, recovery, { id: envelope.id, minGeneration: futureGeneration })).rejects.toThrow('BACKUP_RECOVERY_DENIED');
  w.advanceDays(31);
  expect((await w.call(w.alice.token, 'GET', `${w.base}/${envelope.id}`)).status).toBe(401);
});

test('fake server denies cross-member GET, list and forged owner fields without accessing other ciphertext', async () => {
  const w = world();
  const recovery = await createBackupRecoveryKeyPair();
  const envelope = await encryptMemberBackup(text('SYNTHETIC-A'), recovery.publicKey);
  expect((await w.call(w.alice.token, 'POST', w.base, envelope, { 'if-match': '"0"', 'idempotency-key': 'a' })).status).toBe(201);
  expect((await w.call(w.bob.token, 'GET', `${w.base}/${envelope.id}`)).status).toBe(404);
  expect(await (await w.call(w.bob.token, 'GET', w.base)).json()).toEqual({ backups: [] });
  const foreignRotation = await encryptMemberBackup(text('SYNTHETIC-B'), recovery.publicKey,
    { id: envelope.id, generation: 2 });
  expect((await w.call(w.bob.token, 'PUT', `${w.base}/${envelope.id}`, foreignRotation,
    { 'if-match': '"1"', 'idempotency-key': 'foreign-rotate' })).status).toBe(409);
  expect((await w.call(w.bob.token, 'DELETE', `${w.base}/${envelope.id}`, undefined,
    { 'if-match': '"1"' })).status).toBe(404);
  expect((await w.call(w.bob.token, 'POST', `${w.base}?memberId=${w.alice.profile.id}`, envelope,
    { 'if-match': '"0"', 'idempotency-key': 'forged-query' })).status).toBe(400);
  expect((await w.call(w.bob.token, 'POST', w.base, { ...envelope, memberId: w.alice.profile.id },
    { 'if-match': '"0"', 'idempotency-key': 'forged-body' })).status).toBe(400);
});

test('tamper fails client authentication; fake server rejects hash mismatch and stale CAS', async () => {
  const w = world();
  const recovery = await createBackupRecoveryKeyPair();
  const first = await encryptMemberBackup(text('SYNTHETIC-OLD'), recovery.publicKey);
  const headers = { 'if-match': '"0"', 'idempotency-key': 'first' };
  expect((await w.call(w.alice.token, 'POST', w.base, first, headers)).status).toBe(201);
  const damaged = { ...first, ciphertext: first.ciphertext.slice(0, -2) + 'AA' };
  await expect(decryptMemberBackup(damaged, recovery, { id: first.id, minGeneration: first.generation })).rejects.toThrow();
  await expect(decryptMemberBackup({ ...first, generation: 2 }, recovery,
    { id: first.id, minGeneration: first.generation })).rejects.toThrow('BACKUP_RECOVERY_DENIED');
  await expect(decryptMemberBackup({ ...first, sealedKey: first.sealedKey.slice(0, -2) + 'AA' }, recovery,
    { id: first.id, minGeneration: first.generation })).rejects.toThrow();
  expect((await w.call(w.alice.token, 'PUT', `${w.base}/${first.id}`, damaged,
    { 'if-match': '"1"', 'idempotency-key': 'tampered' })).status).toBe(400);
  const second = await encryptMemberBackup(text('SYNTHETIC-NEW'), recovery.publicKey, { id: first.id, generation: 2 });
  const rotated = await w.call(w.alice.token, 'PUT', `${w.base}/${first.id}`, second,
    { 'if-match': '"1"', 'idempotency-key': 'rotate' });
  expect(rotated.status).toBe(200);
  expect((await w.call(w.alice.token, 'POST', w.base, first, headers)).status).toBe(409);
  expect((await w.call(w.alice.token, 'PUT', `${w.base}/${first.id}`, second,
    { 'if-match': '"1"', 'idempotency-key': 'stale' })).status).toBe(409);
  await expect(decryptMemberBackup(first, recovery, { id: first.id, minGeneration: second.generation })).rejects.toThrow('BACKUP_RECOVERY_DENIED');
  const latest = await w.call(w.alice.token, 'GET', `${w.base}/${first.id}`);
  expect((await latest.json() as { backup: EncryptedMemberBackup }).backup.generation).toBe(2);
});

test('concurrent CAS rotations admit one generation and reject the loser', async () => {
  const w = world();
  const peer = createMemberCloudBackupApi({ dbPath: w.dbPath, memberStore: w.store,
    now: () => new Date('2026-11-14T00:00:00Z') });
  cleanup.push(() => peer.close());
  const recovery = await createBackupRecoveryKeyPair();
  const first = await encryptMemberBackup(text('SYNTHETIC-BASE'), recovery.publicKey);
  expect((await w.call(w.alice.token, 'POST', w.base, first,
    { 'if-match': '"0"', 'idempotency-key': 'concurrent-base' })).status).toBe(201);
  const left = await encryptMemberBackup(text('SYNTHETIC-LEFT'), recovery.publicKey,
    { id: first.id, generation: 2 });
  const right = await encryptMemberBackup(text('SYNTHETIC-RIGHT'), recovery.publicKey,
    { id: first.id, generation: 2 });
  const results = await Promise.all([
    w.call(w.alice.token, 'PUT', `${w.base}/${first.id}`, left,
      { 'if-match': '"1"', 'idempotency-key': 'concurrent-left' }),
    w.call(w.alice.token, 'PUT', `${w.base}/${first.id}`, right,
      { 'if-match': '"1"', 'idempotency-key': 'concurrent-right' }, peer),
  ]);
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  const currentResponse = await w.call(w.alice.token, 'GET', `${w.base}/${first.id}`);
  const currentBody = await currentResponse.json() as { backup: EncryptedMemberBackup };
  const current = currentBody.backup;
  expect(current.generation).toBe(2);
  const opened = Buffer.from(await decryptMemberBackup(current, recovery,
    { id: first.id, minGeneration: current.generation })).toString();
  expect(['SYNTHETIC-LEFT', 'SYNTHETIC-RIGHT']).toContain(opened);
});

test('separate process holds SQLite write lock before CAS reads committed generation', async () => {
  const w = world();
  const recovery = await createBackupRecoveryKeyPair();
  const first = await encryptMemberBackup(text('SYNTHETIC-PROCESS-BASE'), recovery.publicKey);
  const winner = await encryptMemberBackup(text('SYNTHETIC-PROCESS-WINNER'), recovery.publicKey,
    { id: first.id, generation: first.generation + 1 });
  const loser = await encryptMemberBackup(text('SYNTHETIC-PROCESS-LOSER'), recovery.publicKey,
    { id: first.id, generation: first.generation + 1 });
  expect((await w.call(w.alice.token, 'POST', w.base, first,
    { 'if-match': '"0"', 'idempotency-key': 'process-base' })).status).toBe(201);
  const lockHoldMs = 300;
  const script = `
    import { Database } from 'bun:sqlite';
    const db = new Database(process.env.TEST_DB_PATH);
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
    process.stdout.write('LOCKED\\n');
    await Bun.sleep(${lockHoldMs});
    db.query('UPDATE member_backup SET generation=?,envelope=?,sha256=? WHERE owner=? AND id=?')
      .run(Number(process.env.TEST_GENERATION), process.env.TEST_ENVELOPE, process.env.TEST_SHA,
        process.env.TEST_OWNER, process.env.TEST_BACKUP_ID);
    db.exec('COMMIT');
    db.close();
  `;
  const child = spawn(process.execPath, ['-e', script], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '',
      TEST_DB_PATH: w.dbPath, TEST_OWNER: w.alice.profile.id, TEST_BACKUP_ID: first.id,
      TEST_GENERATION: String(winner.generation), TEST_ENVELOPE: JSON.stringify(winner), TEST_SHA: winner.sha256 },
  });
  try {
    const [ready] = await Promise.race([
      once(child.stdout!, 'data'),
      Bun.sleep(2000).then(() => { throw new Error('fake SQLite lock child did not start'); }),
    ]);
    expect(String(ready)).toContain('LOCKED');
    const started = performance.now();
    const lost = await w.call(w.alice.token, 'PUT', `${w.base}/${first.id}`, loser,
      { 'if-match': '"1"', 'idempotency-key': 'process-loser' });
    expect(lost.status).toBe(409);
    // 출처: #36089 separate-connection contention review; the child holds BEGIN IMMEDIATE for lockHoldMs.
    expect(performance.now() - started).toBeGreaterThan(lockHoldMs / 3);
    const current = await w.call(w.alice.token, 'GET', `${w.base}/${first.id}`);
    expect((await current.json() as { backup: EncryptedMemberBackup }).backup.sha256).toBe(winner.sha256);
  } finally { child.kill(); }
});

test('a fake storage server cannot forge ciphertext or roll back below the client anchor', async () => {
  const w = world();
  const recovery = await createBackupRecoveryKeyPair();
  const first = await encryptMemberBackup(text('SYNTHETIC-ONE'), recovery.publicKey);
  const second = await encryptMemberBackup(text('SYNTHETIC-TWO'), recovery.publicKey,
    { id: first.id, generation: first.generation + 1 });
  expect((await w.call(w.alice.token, 'POST', w.base, first,
    { 'if-match': '"0"', 'idempotency-key': 'anchor-first' })).status).toBe(201);
  expect((await w.call(w.alice.token, 'PUT', `${w.base}/${first.id}`, second,
    { 'if-match': '"1"', 'idempotency-key': 'anchor-second' })).status).toBe(200);
  const db = new Database(w.dbPath);
  try {
    const forged = { ...second, ciphertext: first.ciphertext, sha256: first.sha256 };
    db.query('UPDATE member_backup SET envelope=? WHERE owner=? AND id=?')
      .run(JSON.stringify(forged), w.alice.profile.id, first.id);
    const tampered = await w.call(w.alice.token, 'GET', `${w.base}/${first.id}`);
    const tamperedBody = await tampered.json() as { backup: EncryptedMemberBackup };
    await expect(decryptMemberBackup(tamperedBody.backup, recovery,
      { id: first.id, minGeneration: second.generation })).rejects.toThrow('BACKUP_RECOVERY_DENIED');
    db.query('UPDATE member_backup SET generation=?,envelope=?,sha256=? WHERE owner=? AND id=?')
      .run(first.generation, JSON.stringify(first), first.sha256, w.alice.profile.id, first.id);
    const rolledBack = await w.call(w.alice.token, 'GET', `${w.base}/${first.id}`);
    const rolledBackBody = await rolledBack.json() as { backup: EncryptedMemberBackup };
    await expect(decryptMemberBackup(rolledBackBody.backup, recovery,
      { id: first.id, minGeneration: second.generation })).rejects.toThrow('BACKUP_RECOVERY_DENIED');
  } finally { db.close(); }
});

test('server with only the recovery public key cannot forge a trusted sender at a higher generation', async () => {
  const w = world();
  const recovery = await createBackupRecoveryKeyPair();
  const first = await encryptMemberBackup(text('SYNTHETIC-TRUSTED'), recovery.publicKey);
  expect((await w.call(w.alice.token, 'POST', w.base, first,
    { 'if-match': '"0"', 'idempotency-key': 'sender-trusted' })).status).toBe(201);
  const attacker = await createBackupSenderKeyPair();
  const forged = await encryptSignedMemberBackup(text('SYNTHETIC-FORGED'), recovery.publicKey, attacker,
    { id: first.id, generation: first.generation + 1 });
  // Fake storage may replace its row; it cannot change the separately pinned sender key.
  const db = new Database(w.dbPath);
  try {
    db.query('UPDATE member_backup SET generation=?,envelope=?,sha256=? WHERE owner=? AND id=?')
      .run(forged.generation, JSON.stringify(forged), forged.sha256, w.alice.profile.id, first.id);
    const downloaded = await w.call(w.alice.token, 'GET', `${w.base}/${first.id}`);
    const body = await downloaded.json() as { backup: EncryptedMemberBackup };
    await expect(decryptMemberBackup(body.backup, recovery,
      { id: first.id, minGeneration: forged.generation })).rejects.toThrow('BACKUP_RECOVERY_DENIED');
    await expect(decryptSignedMemberBackup({ ...body.backup, senderPublicKey: first.senderPublicKey }, recovery,
      { id: first.id, minGeneration: forged.generation, trustedSenderPublicKey: sender.publicKey }))
      .rejects.toThrow('BACKUP_RECOVERY_DENIED');
  } finally { db.close(); }
});

test('largest client-accepted plaintext fits the exact JSON/base64 wire ceiling', async () => {
  const w = world();
  const recovery = await createBackupRecoveryKeyPair();
  const probe = await encryptMemberBackup(text('SYNTHETIC-PROBE'), recovery.publicKey);
  const maximum = maxBackupPlaintextBytes(probe.id, probe.generation);
  const envelope = await encryptMemberBackup(new Uint8Array(maximum), recovery.publicKey,
    { id: probe.id, generation: probe.generation });
  expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThanOrEqual(MAX_BACKUP_WIRE_BYTES);
  expect((await w.call(w.alice.token, 'POST', w.base, envelope,
    { 'if-match': '"0"', 'idempotency-key': 'wire-boundary' })).status).toBe(201);
  await expect(encryptMemberBackup(new Uint8Array(maximum + 1), recovery.publicKey,
    { id: probe.id, generation: probe.generation })).rejects.toThrow('BACKUP_INVALID');
});

test('idempotent retry, same-key different bytes, restart, delete CAS and tombstone fencing', async () => {
  const w = world();
  const recovery = await createBackupRecoveryKeyPair();
  const first = await encryptMemberBackup(text('SYNTHETIC-RETRY'), recovery.publicKey);
  const headers = { 'if-match': '"0"', 'idempotency-key': 'stable' };
  const firstResponse = await w.call(w.alice.token, 'POST', w.base, first, headers);
  expect(firstResponse.status).toBe(201);
  expect((await w.call(w.alice.token, 'POST', w.base, first, headers)).status).toBe(200);
  const different = await encryptMemberBackup(text('SYNTHETIC-OTHER'), recovery.publicKey, { id: first.id });
  expect((await w.call(w.alice.token, 'POST', w.base, different, headers)).status).toBe(409);
  const reopened = createMemberCloudBackupApi({ dbPath: w.dbPath, memberStore: w.store,
    now: () => new Date('2026-11-14T00:00:00Z') });
  try {
    const request = (generation: number) => new Request(`https://fake-storage.example.test${w.base}/${first.id}`, {
      method: 'DELETE', headers: { cookie: `__Host-elanous_member_session=${w.alice.token}`, 'if-match': `"${generation}"` },
    });
    expect((await reopened.handle(request(0)))?.status).toBe(409);
    expect((await reopened.handle(request(1)))?.status).toBe(200);
    expect((await w.call(w.alice.token, 'GET', `${w.base}/${first.id}`)).status).toBe(404);
    expect((await w.call(w.alice.token, 'POST', w.base, first, headers)).status).toBe(409);
    expect((await w.call(w.alice.token, 'POST', w.base, first,
      { 'if-match': '"0"', 'idempotency-key': 'replay-after-delete' })).status).toBe(409);
  } finally { reopened.close(); }
});
