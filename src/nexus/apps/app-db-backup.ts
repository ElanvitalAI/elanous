import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { debug } from '../../debug/log.js';
import { appObjectKey, type ObjectStore } from '../../storage/object-store.js';

export const APP_DB_BACKUP_KEY_REF = 'NEXUS_BACKUP_KEY';
export const APP_DB_BACKUP_HISTORY_KEY_REF = 'NEXUS_BACKUP_KEY_HISTORY';
// source: 내부 문서 `RFC-guardian-resource-ledger` §⑪ — propagate the documented 30-day deletion policy to backup artifacts.
export const APP_DB_BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// source: 내부 문서 `RFC-guardian-resource-ledger` §⑪ — snapshots follow the documented daily cadence.
export const APP_DB_BACKUP_SNAPSHOT_MS = 24 * 60 * 60 * 1000;
export interface AppDbBackupStatus {
  readonly databaseId: string;
  readonly state: 'healthy' | 'unhealthy';
  readonly latestBackupAt?: string;
  readonly latestSnapshotAt?: string;
  readonly ageMs?: number;
  readonly keyRef: string;
  readonly keyId?: string;
  readonly lastError?: string;
}
export interface AppDbBackupOptions {
  readonly appSlug: string;
  readonly databasePath: string;
  readonly database: Database;
  readonly databaseWasPresent?: boolean;
  /** Initialize SQLite pragmas and contract schema only after recovery preflight succeeds. */
  readonly initializeDatabase?: () => void;
  readonly store: ObjectStore;
  /** Supplied by the shared credential manager; never read from env or a file. */
  readonly key?: Uint8Array;
  readonly schemaVersion?: string;
  readonly schemaHash?: string;
  readonly historicalKeys?: ReadonlyMap<string, Uint8Array>;
  readonly now?: () => number;
  readonly snapshotEveryMs?: number;
  readonly maxFreshnessMs?: number;
  readonly retentionMs?: number;
  readonly schedule?: boolean;
  /** Test seam for the final no-clobber publication race. */
  readonly beforeRestorePublishForTesting?: (targetPath: string) => void;
}
interface Envelope {
  readonly schema: 'nexus.app-db-backup/v1';
  readonly kind: 'snapshot' | 'wal';
  readonly databaseId: string;
  readonly keyRef: string;
  readonly keyId: string;
  readonly objectRef: string;
  readonly sourceEnvironment: 'nexus-app-db';
  readonly schemaVersion: string;
  readonly schemaHash: string;
  readonly eventId: string;
  readonly createdAt: string;
  readonly snapshotId: string;
  readonly previousEventId?: string;
  readonly walStartOffset?: number;
  readonly walEndOffset?: number;
  readonly walHeaderLength?: number;
  readonly plaintextSha256: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}
interface WalState { readonly bytes: Buffer; readonly header: Buffer; readonly completeLength: number; readonly generation: string }
export interface AppDbBackupService {
  readonly databaseId: string;
  initialize(): void;
  recoveryPending(): boolean;
  assertAvailable(): void;
  assertWritesAllowed(): void;
  captureWal(): boolean;
  createSnapshot(): boolean;
  pruneExpired(): number;
  status(): AppDbBackupStatus;
  restoreTo(targetPath: string): { readonly path: string; readonly snapshotId: string; readonly walSegments: number; readonly rowsVerified: number; readonly targetEnvironment: 'isolated-restore' };
  close(): void;
}
const isoKey = (date: string) => date.replace(/[-:.]/g, '').replace('T', '-').replace('Z', '');
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const safeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function readWal(path: string): WalState | undefined {
  let bytes: Buffer;
  try { bytes = readFileSync(path); } catch { return undefined; }
  if (bytes.length < 32) return undefined;
  const magic = bytes.readUInt32BE(0), rawPageSize = bytes.readUInt32BE(8);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return undefined;
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
  if (!safeInteger(pageSize) || pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return undefined;
  const frameSize = 24 + pageSize;
  const completeLength = 32 + Math.floor((bytes.length - 32) / frameSize) * frameSize;
  const header = bytes.subarray(0, 32);
  return { bytes, header, completeLength, generation: [magic, header.readUInt32BE(16), header.readUInt32BE(20), pageSize].join(':') };
}
function validEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<Envelope>;
  return row.schema === 'nexus.app-db-backup/v1'
    && (row.kind === 'snapshot' || row.kind === 'wal')
    && typeof row.databaseId === 'string' && typeof row.keyRef === 'string' && typeof row.keyId === 'string'
    && typeof row.objectRef === 'string' && row.sourceEnvironment === 'nexus-app-db'
    && typeof row.schemaVersion === 'string' && typeof row.schemaHash === 'string'
    && typeof row.eventId === 'string' && typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt))
    && typeof row.snapshotId === 'string' && typeof row.plaintextSha256 === 'string'
    && typeof row.iv === 'string' && typeof row.tag === 'string' && typeof row.ciphertext === 'string'
    && (row.kind !== 'wal' || (safeInteger(row.walStartOffset) && safeInteger(row.walEndOffset)
      && Number(row.walEndOffset) > Number(row.walStartOffset) && row.walHeaderLength === 32));
}
export function createAppDbBackupService(options: AppDbBackupOptions): AppDbBackupService {
  const now = options.now ?? Date.now;
  const retentionMs = options.retentionMs ?? APP_DB_BACKUP_RETENTION_MS;
  const snapshotEveryMs = options.snapshotEveryMs ?? APP_DB_BACKUP_SNAPSHOT_MS;
  const maxFreshnessMs = options.maxFreshnessMs ?? snapshotEveryMs * 2;
  const databaseId = 'app:' + options.appSlug;
  const schemaVersion = options.schemaVersion ?? 'unknown';
  const schemaHash = options.schemaHash ?? 'unknown';
  const databasePath = resolve(options.databasePath);
  const recoveryMarker = databasePath + '.backup-restore-required';
  const prefix = appObjectKey(options.appSlug, 'db-backups') + '/';
  const headPath = appObjectKey(options.appSlug, 'db-backups/current.json');
  const key = options.key ? Buffer.from(options.key) : undefined;
  const keyId = key ? sha256(key).slice(0, 24) : undefined;
  const keyring = new Map<string, Buffer>();
  if (key && keyId) keyring.set(keyId, key);
  for (const [id, material] of options.historicalKeys ?? []) keyring.set(id, Buffer.from(material));
  let closed = false, restoreRequired = false, latestBackupAt: number | undefined, latestSnapshotAt: number | undefined;
  let lastError: string | undefined, activeSnapshotId = '', lastWalEventId: string | undefined, walOffset = 0, walGeneration = '', sequence = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const fail = (reason: string) => {
    if (lastError !== reason) debug.log('nexus.app-db-backup', 'unhealthy', { databaseId, keyRef: APP_DB_BACKUP_KEY_REF, reason }, { level: 'error' });
    lastError = reason;
    return false;
  };
  const assertReady = () => {
    if (!key || !keyId || key.byteLength !== 32) throw new Error('NEXUS_BACKUP_KEY is missing or invalid');
    if (options.store.provider === 'local') throw new Error('off-host backup storage is required');
  };
  const artifactKey = (kind: Envelope['kind'], event: string) =>
    appObjectKey(options.appSlug, 'db-backups/' + kind + '/' + event + '.json');
  function envelopeAad(value: Pick<Envelope, 'schema' | 'kind' | 'databaseId' | 'keyRef' | 'keyId' | 'objectRef' | 'sourceEnvironment' | 'schemaVersion' | 'schemaHash' | 'eventId' | 'createdAt' | 'snapshotId' | 'previousEventId' | 'walStartOffset' | 'walEndOffset' | 'walHeaderLength' | 'plaintextSha256'>): Buffer {
    return Buffer.from(JSON.stringify([value.schema, value.kind, value.databaseId, value.keyRef, value.keyId, value.objectRef, value.sourceEnvironment, value.schemaVersion, value.schemaHash, value.eventId, value.createdAt, value.snapshotId, value.previousEventId ?? null, value.walStartOffset ?? null, value.walEndOffset ?? null, value.walHeaderLength ?? null, value.plaintextSha256]));
  }
  function encrypt(kind: Envelope['kind'], plaintext: Uint8Array, fields: Pick<Envelope, 'snapshotId'> & Partial<Pick<Envelope, 'walStartOffset' | 'walEndOffset' | 'previousEventId'>>): Envelope {
    assertReady();
    const createdAt = new Date(now()).toISOString();
    const event = isoKey(createdAt) + '-' + String(++sequence).padStart(8, '0') + '-' + randomBytes(6).toString('hex');
    const metadata = { schema: 'nexus.app-db-backup/v1' as const, kind, databaseId, keyRef: APP_DB_BACKUP_KEY_REF,
      keyId: keyId!, objectRef: artifactKey(kind, event), sourceEnvironment: 'nexus-app-db' as const, schemaVersion, schemaHash,
      eventId: event, createdAt, snapshotId: fields.snapshotId,
      ...(fields.previousEventId ? { previousEventId: fields.previousEventId } : {}),
      ...(fields.walStartOffset !== undefined ? { walStartOffset: fields.walStartOffset } : {}),
      ...(fields.walEndOffset !== undefined ? { walEndOffset: fields.walEndOffset, walHeaderLength: 32 } : {}),
      plaintextSha256: sha256(plaintext) };
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key!, iv);
    cipher.setAAD(envelopeAad(metadata));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ...metadata, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
  }
  function put(envelope: Envelope): void {
    const path = artifactKey(envelope.kind, envelope.eventId);
    options.store.put(path, JSON.stringify(envelope), { contentType: 'application/json' });
    if (!options.store.head(path).exists) throw new Error('backup object not confirmed after upload');
  }
  function keys(): string[] { return options.store.list(prefix).filter(path => path.startsWith(prefix) && path !== headPath); }
  function load(path: string): Envelope {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-db-backup-read-')), file = join(dir, 'artifact.json');
    try {
      options.store.get(path, file);
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!validEnvelope(value) || value.databaseId !== databaseId || value.keyRef !== APP_DB_BACKUP_KEY_REF || value.objectRef !== path) throw new Error();
      return value;
    } catch { throw new Error('backup artifact unavailable or invalid'); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  interface BackupHead {
    schema: 'nexus.app-db-backup-head/v1';
    databaseId: string;
    snapshotId: string;
    walEndOffset: number;
    lastWalEventId?: string;
    updatedAt: string;
    keyId?: string;
    signature: string;
  }
  function headMac(material: Uint8Array, snapshotId: string, walEndOffset: number, lastWalEventId: string | undefined, updatedAt: string, headKeyId: string): Buffer {
    return createHmac('sha256', material).update(JSON.stringify([databaseId, snapshotId, walEndOffset, lastWalEventId ?? null, updatedAt, headKeyId])).digest();
  }
  function writeHead(value: Omit<BackupHead, 'schema' | 'databaseId' | 'updatedAt' | 'signature'>): void {
    const updatedAt = new Date(now()).toISOString();
    const signature = headMac(key!, value.snapshotId, value.walEndOffset, value.lastWalEventId, updatedAt, keyId!).toString('base64url');
    const head = { schema: 'nexus.app-db-backup-head/v1' as const, databaseId, updatedAt, ...value, keyId: keyId!, signature };
    options.store.put(headPath, JSON.stringify(head), { contentType: 'application/json' });
    if (!options.store.head(headPath).exists) throw new Error('backup head not confirmed after upload');
  }
  function loadHead(): BackupHead {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-db-backup-head-')), path = join(dir, 'head.json');
    try {
      options.store.get(headPath, path);
      const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<BackupHead>;
      if (value.schema !== 'nexus.app-db-backup-head/v1' || value.databaseId !== databaseId
        || typeof value.snapshotId !== 'string' || !safeInteger(value.walEndOffset)
        || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
        || (value.lastWalEventId !== undefined && typeof value.lastWalEventId !== 'string')
        || (value.keyId !== undefined && typeof value.keyId !== 'string') || typeof value.signature !== 'string') throw new Error();
      const supplied = Buffer.from(value.signature, 'base64url');
      const candidates = value.keyId
        ? [[value.keyId, keyring.get(value.keyId)] as const]
        : [...keyring.entries()];
      let authenticatedKeyId: string | undefined;
      for (const [candidateId, candidateKey] of candidates) {
        if (!candidateKey || !candidateId) continue;
        const expected = value.keyId
          ? headMac(candidateKey, value.snapshotId, value.walEndOffset, value.lastWalEventId, value.updatedAt, candidateId)
          : createHmac('sha256', candidateKey).update(JSON.stringify([databaseId, value.snapshotId, value.walEndOffset, value.lastWalEventId ?? null, value.updatedAt])).digest();
        if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) { authenticatedKeyId = candidateId; break; }
      }
      if (!authenticatedKeyId) throw new Error();
      return { ...value, keyId: authenticatedKeyId } as BackupHead;
    } catch { throw new Error('backup head unavailable or invalid'); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  function decrypt(envelope: Envelope): Buffer {
    const material = keyring.get(envelope.keyId);
    if (!material || material.byteLength !== 32) throw new Error('backup key ID is unavailable');
    try {
      const decipher = createDecipheriv('aes-256-gcm', material, Buffer.from(envelope.iv, 'base64url'));
      decipher.setAAD(envelopeAad(envelope));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      const bytes = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]);
      if (sha256(bytes) !== envelope.plaintextSha256) throw new Error();
      return bytes;
    } catch { throw new Error('backup authentication or checksum failed'); }
  }
  function allArtifacts(): Array<{ path: string; envelope: Envelope }> {
    return keys().map(path => ({ path, envelope: load(path) }))
      .sort((a, b) => a.envelope.createdAt.localeCompare(b.envelope.createdAt) || a.envelope.eventId.localeCompare(b.envelope.eventId));
  }
  function prune(): number {
    assertReady();
    const head = loadHead();
    const all = allArtifacts();
    // Authenticate every candidate before trusting its timestamp or chain identity for deletion.
    for (const item of all) decrypt(item.envelope);
    const cutoff = now() - retentionMs;
    const keepSnapshots = new Set(all.filter(item => Date.parse(item.envelope.createdAt) > cutoff).map(item => item.envelope.snapshotId));
    keepSnapshots.add(head.snapshotId);
    let removed = 0;
    for (const item of all) if (!keepSnapshots.has(item.envelope.snapshotId)) { options.store.delete(item.path); removed++; }
    return removed;
  }
  function snapshot(rebase = false, recoveryValidated = false): boolean {
    try {
      assertReady();
      if (!recoveryValidated && (restoreRequired || existsSync(recoveryMarker))) return fail('restore required before backup can resume');
      if (activeSnapshotId && !rebase && !captureWal()) return false;
      const checkpoint = options.database.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | null;
      if (checkpoint && Number(checkpoint.busy) !== 0) throw new Error('database WAL checkpoint busy');
      const bytes = Buffer.from(options.database.serialize()), snapshotId = randomBytes(16).toString('hex');
      put(encrypt('snapshot', bytes, { snapshotId }));
      writeHead({ snapshotId, walEndOffset: 32 });
      activeSnapshotId = snapshotId;
      lastWalEventId = undefined;
      const wal = readWal(databasePath + '-wal');
      walOffset = wal ? 32 : 0;
      walGeneration = wal?.generation ?? '';
      latestSnapshotAt = latestBackupAt = now();
      lastError = undefined;
      debug.log('nexus.app-db-backup', 'snapshot-written', { databaseId, keyRef: APP_DB_BACKUP_KEY_REF, keyId, snapshotId, schemaVersion, schemaHash, sourceEnvironment: 'nexus-app-db' });
      const after = readWal(databasePath + '-wal');
      walOffset = after ? 32 : 0;
      walGeneration = after?.generation ?? '';
      try { prune(); }
      catch (error) { fail(error instanceof Error ? error.message : 'backup retention failed'); }
      return true;
    } catch (error) { return fail(error instanceof Error ? error.message : 'backup snapshot failed'); }
  }
  function recoveryPending(): boolean { return restoreRequired || existsSync(recoveryMarker); }
  function assertAvailable(): void {
    if (recoveryPending()) throw new Error('app database recovery is pending');
  }
  function assertWritesAllowed(): void { assertAvailable(); }
  function captureWal(): boolean {
    if (closed) return fail('backup service is closed');
    if (restoreRequired || existsSync(recoveryMarker)) return fail('restore required before backup can resume');
    try {
      assertReady();
      const wal = readWal(databasePath + '-wal');
      if (!wal || wal.completeLength <= 32) return true;
      if (!activeSnapshotId) return snapshot(true);
      if ((walGeneration && wal.generation !== walGeneration) || wal.completeLength < walOffset) return snapshot(true);
      const start = Math.max(32, walOffset || 32);
      if (wal.completeLength <= start) return true;
      const frames = wal.bytes.subarray(start, wal.completeLength);
      if (!frames.length) return true;
      const envelope = encrypt('wal', Buffer.concat([wal.header, frames]), {
        snapshotId: activeSnapshotId, previousEventId: lastWalEventId, walStartOffset: start, walEndOffset: wal.completeLength });
      put(envelope);
      writeHead({ snapshotId: activeSnapshotId, walEndOffset: wal.completeLength, lastWalEventId: envelope.eventId });
      lastWalEventId = envelope.eventId;
      walOffset = wal.completeLength;
      walGeneration = wal.generation;
      latestBackupAt = now();
      lastError = undefined;
      debug.log('nexus.app-db-backup', 'wal-increment-written', { databaseId, keyRef: APP_DB_BACKUP_KEY_REF, keyId, snapshotId: activeSnapshotId, walStartOffset: start, walEndOffset: wal.completeLength, objectRef: envelope.objectRef, schemaVersion, schemaHash });
      return true;
    } catch (error) { return fail(error instanceof Error ? error.message : 'WAL backup failed'); }
  }
  function status(): AppDbBackupStatus {
    const ageMs = latestBackupAt === undefined ? undefined : Math.max(0, now() - latestBackupAt);
    const unhealthy = !key || !keyId || options.store.provider === 'local' || !!lastError || ageMs === undefined || ageMs > maxFreshnessMs;
    return { databaseId, state: unhealthy ? 'unhealthy' : 'healthy', keyRef: APP_DB_BACKUP_KEY_REF,
      ...(keyId ? { keyId } : {}), ...(latestBackupAt !== undefined ? { latestBackupAt: new Date(latestBackupAt).toISOString(), ageMs } : {}),
      ...(latestSnapshotAt !== undefined ? { latestSnapshotAt: new Date(latestSnapshotAt).toISOString() } : {}),
      ...(lastError ? { lastError } : {}) };
  }
  function restoreTo(targetPath: string): { path: string; snapshotId: string; walSegments: number; rowsVerified: number; targetEnvironment: 'isolated-restore' } {
    assertReady();
    const target = resolve(targetPath);
    if (target === databasePath || existsSync(target) || existsSync(target + '-wal') || existsSync(target + '-shm')) throw new Error('restore target must be a separate, empty path');
    const head = loadHead();
    const all = allArtifacts();
    const latest = all.find(item => item.envelope.kind === 'snapshot' && item.envelope.snapshotId === head.snapshotId);
    if (!latest) throw new Error('backup head snapshot is unavailable');
    const snapshotBytes = decrypt(latest.envelope);
    const byEvent = new Map(all.filter(item => item.envelope.kind === 'wal' && item.envelope.snapshotId === head.snapshotId)
      .map(item => [item.envelope.eventId, item]));
    const reverseChain: Array<{ path: string; envelope: Envelope }> = [];
    let cursor = head.lastWalEventId;
    while (cursor) {
      const item = byEvent.get(cursor);
      if (!item) throw new Error('WAL segment gap');
      reverseChain.push(item);
      cursor = item.envelope.previousEventId;
    }
    const segments = reverseChain.reverse();
    let expected = 32, walHeader: Buffer | undefined;
    const frames: Buffer[] = [];
    for (const item of segments) {
      const envelope = item.envelope, payload = decrypt(envelope);
      if (payload.length < 32 || payload.length - 32 !== Number(envelope.walEndOffset) - Number(envelope.walStartOffset)) throw new Error('WAL segment length mismatch');
      if (envelope.walStartOffset !== expected) throw new Error('WAL segment gap');
      const header = payload.subarray(0, 32);
      if (walHeader && !walHeader.equals(header)) throw new Error('WAL generation mismatch');
      walHeader ??= header; expected = envelope.walEndOffset!; frames.push(payload.subarray(32));
    }
    if (expected !== head.walEndOffset) throw new Error('WAL segment gap');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const tempRoot = mkdtempSync(join(dirname(target), '.app-db-restore-')), tempDb = join(tempRoot, 'restore.db');
    try {
      writeFileSync(tempDb, snapshotBytes, { flag: 'wx', mode: 0o600 });
      const modeSetter = new Database(tempDb);
      try { modeSetter.exec('PRAGMA journal_mode = WAL'); } finally { modeSetter.close(); }
      rmSync(tempDb + '-wal', { force: true });
      rmSync(tempDb + '-shm', { force: true });
      if (walHeader && frames.length) writeFileSync(tempDb + '-wal', Buffer.concat([walHeader, ...frames]), { flag: 'wx', mode: 0o600 });
      const restored = new Database(tempDb);
      let rowsVerified = 0;
      try {
        const check = restored.query('PRAGMA quick_check').get() as { quick_check?: string } | null;
        if (check?.quick_check !== 'ok') throw new Error('restored database quick_check failed');
        const tables = restored.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
        for (const table of tables) {
          const identifier = '"' + table.name.replaceAll('"', '""') + '"';
          const count = restored.query('SELECT COUNT(*) AS count FROM ' + identifier).get() as { count?: number } | null;
          rowsVerified += Number(count?.count ?? 0);
        }
        const result = restored.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | null;
        if (result && Number(result.busy) !== 0) throw new Error('restored database WAL checkpoint busy');
      } finally { restored.close(); }
      options.beforeRestorePublishForTesting?.(target);
      // Hard-link publication is atomic and fails with EEXIST if a racer creates the target.
      linkSync(tempDb, target);
      unlinkSync(tempDb);
      debug.log('nexus.app-db-backup', 'restore-verified', { databaseId, keyRef: APP_DB_BACKUP_KEY_REF, keyId: latest.envelope.keyId, snapshotId: latest.envelope.snapshotId, walSegments: segments.length, rowsVerified, targetEnvironment: 'isolated-restore' });
      return { path: target, snapshotId: latest.envelope.snapshotId, walSegments: segments.length, rowsVerified, targetEnvironment: 'isolated-restore' };
    } finally { rmSync(tempRoot, { recursive: true, force: true }); }
  }
  function initialize(): void {
    if (options.store.provider === 'local') { fail('off-host backup storage is required'); return; }
    if (!key || key.byteLength !== 32) { fail('NEXUS_BACKUP_KEY is missing or invalid'); return; }
    if (options.databaseWasPresent === false && !existsSync(recoveryMarker)) {
      writeFileSync(recoveryMarker, 'restore required\n', { flag: 'wx', mode: 0o600 });
    }
    const markerExists = existsSync(recoveryMarker);
    if (markerExists) restoreRequired = true;
    try {
      if (options.store.head(headPath).exists && (options.databaseWasPresent === false || markerExists)) {
        restoreRequired = true;
        const head = loadHead();
        const snapshot = allArtifacts().find(item => item.envelope.kind === 'snapshot' && item.envelope.snapshotId === head.snapshotId);
        if (!snapshot) throw new Error('backup head snapshot is unavailable');
        activeSnapshotId = head.snapshotId;
        lastWalEventId = head.lastWalEventId;
        walOffset = head.walEndOffset;
        latestBackupAt = Date.parse(head.updatedAt);
        latestSnapshotAt = Date.parse(snapshot.envelope.createdAt);
        fail('restore required before backup can resume');
      } else {
        restoreRequired = false;
        options.initializeDatabase?.();
        if (snapshot(true, true) && markerExists) rmSync(recoveryMarker, { force: true });
      }
    } catch (error) {
      if (existsSync(recoveryMarker)) restoreRequired = true;
      fail(error instanceof Error ? error.message : 'backup initialization failed');
    }
    if (options.schedule !== false && !closed) {
      // source: 내부 문서 `RFC-guardian-resource-ledger` §⑪ — retry recovery checks between daily snapshots to keep backup freshness observed.
      timer = setInterval(() => {
        try {
          if (restoreRequired || existsSync(recoveryMarker)) {
            // Recheck a previously unknown head before any snapshot can replace it.
            if (options.store.head(headPath).exists) { restoreRequired = true; return; }
            restoreRequired = false;
            options.initializeDatabase?.();
            if (latestSnapshotAt === undefined || now() - latestSnapshotAt >= snapshotEveryMs) {
              if (snapshot(true, true)) rmSync(recoveryMarker, { force: true });
            } else rmSync(recoveryMarker, { force: true });
            return;
          }
          if (latestSnapshotAt === undefined || now() - latestSnapshotAt >= snapshotEveryMs) snapshot();
          else { captureWal(); prune(); }
        } catch (error) {
          if (existsSync(recoveryMarker)) restoreRequired = true;
          fail(error instanceof Error ? error.message : 'backup timer failed');
        }
      }, Math.min(snapshotEveryMs, 60 * 60 * 1000));
      timer.unref?.();
    }
  }
  function close(): void {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    key?.fill(0);
    for (const material of keyring.values()) material.fill(0);
    keyring.clear();
  }
  return { databaseId, initialize, recoveryPending, assertAvailable, assertWritesAllowed, captureWal, createSnapshot: snapshot, pruneExpired: prune, status, restoreTo, close };
}
