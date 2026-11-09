import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import { eligibleGateShardReceipt, gateShardRuntimeIdentityKey, type GateShardIdentity, type GateShardReceipt } from './gate-shard-dispatch.js';
import { runtimeIdentitiesMatch } from '../../src/runtime-identity.js';
import type { GateShardLedgerRow } from '../../src/release-loop/gate-shard-ledger.js';
import { mergePassingGateShardResults } from './gate-shard-receipt-carry.js';
import { gateFileReceiptKeyFromClosureDigest, type GateFileReceipt, type GateFileReceiptEnvelope } from './gate-file-receipts.js';

export interface GateShardSavedRun {
  output: string;
  rc: number;
  pass: number;
  fail: number;
  errors: number;
  ran: number;
  skipped?: number;
  files: number;
  passedIds: string[];
}

export interface GateShardSavedResult {
  receipt: GateShardReceipt;
  runs: GateShardSavedRun[];
}

/** A failure is suppressible only when its exact test identity has an owning checklist cell. */
export interface KnownFailOwnerRecord {
  failureId: string;
  checklistCellId: string;
  firstSeenCommit: string;
}

export interface KnownFailOwnerLedgerSnapshot { records: unknown[]; writable: boolean; }

function knownFailOwnerLedgerPath(root: string): string {
  return join(root, 'graph-runs', 'release-loop', 'known-fail-owner-ledger.json');
}

export function readKnownFailOwnerLedger(root: string): KnownFailOwnerLedgerSnapshot {
  const path = knownFailOwnerLedgerPath(root);
  if (!existsSync(path)) return { records: [], writable: true };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { schema?: unknown; records?: unknown };
    if (value?.schema !== 'known-fail-owner-ledger-v1' || !Array.isArray(value.records))
      return { records: [], writable: false };
    return { records: value.records, writable: true };
  } catch { return { records: [], writable: false }; }
}

export function appendKnownFailOwnerLedger(root: string, records: readonly unknown[]): void {
  const path = knownFailOwnerLedgerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock.d`;
  const deadline = Date.now() + 10_000;
  for (let attempt = 1; attempt <= 100; attempt++) {
    const token = `${process.pid}:${randomUUID()}`;
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner'), `${token}\n`);
      try {
        const snapshot = readKnownFailOwnerLedger(root);
        if (!snapshot.writable) throw new Error('known-fail owner ledger is unreadable; refusing to replace it');
        const additions = records.filter(isKnownFailOwnerRecord);
        const combined = [...snapshot.records];
        for (const addition of additions) {
          const existingForId = combined.filter(isKnownFailOwnerRecord).filter(item => item.failureId === addition.failureId);
          if (existingForId.some(item => item.checklistCellId === addition.checklistCellId)) continue;
          if (combined.some(item => JSON.stringify(item) === JSON.stringify(addition))) continue;
          combined.push(addition);
        }
        atomicJson(path, { schema: 'known-fail-owner-ledger-v1', records: combined });
        return;
      } finally {
        try {
          if (readFileSync(join(lock, 'owner'), 'utf8').trim() === token) rmSync(lock, { recursive: true, force: true });
        } catch { /* a stale-lock recovery or filesystem error already changed the lock */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const observed = statSync(lock);
        const owner = readFileSync(join(lock, 'owner'), 'utf8').trim();
        const pid = Number(owner.split(':', 1)[0]);
        if (Date.now() - observed.mtimeMs > 60_000 && Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code === 'ESRCH'
              && readFileSync(join(lock, 'owner'), 'utf8').trim() === owner
              && statSync(lock).ino === observed.ino) {
              try { renameSync(lock, `${lock}.stale.${process.pid}.${attempt}.${randomUUID()}`); } catch { /* holder may have released */ }
            }
          }
        }
      } catch { /* unknown or incomplete locks are not reaped */ }
      if (attempt === 100 || Date.now() >= deadline) throw new Error(`known-fail owner ledger lock timeout: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  throw new Error(`known-fail owner ledger lock timeout: ${lock}`);
}

export function isKnownFailOwnerRecord(value: unknown): value is KnownFailOwnerRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.failureId !== 'string' || !record.failureId.trim()) return false;
  const [sourcePath, ...testPath] = record.failureId.split(' > ');
  const validTestIdentity = !!sourcePath && !sourcePath.startsWith('/') && !sourcePath.split('/').includes('..')
    && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(sourcePath) && testPath.length > 0
    && testPath.every(part => !!part.trim());
  return validTestIdentity
    && typeof record.checklistCellId === 'string' && /^[A-Z0-9][A-Z0-9-]*$/.test(record.checklistCellId)
    && typeof record.firstSeenCommit === 'string' && /^[a-f0-9]{40}$/i.test(record.firstSeenCommit);
}

/** Invalid, duplicate, or ownerless records never cover a measured failure. */
export function auditKnownFailFailures(failureIds: readonly string[], value: unknown): {
  covered: KnownFailOwnerRecord[]; residual: string[];
} {
  const rows = Array.isArray(value) ? value : [];
  const idCounts = new Map<string, number>();
  const validById = new Map<string, KnownFailOwnerRecord>();
  for (const row of rows) {
    const id = row && typeof row === 'object' && !Array.isArray(row)
      && typeof (row as Record<string, unknown>).failureId === 'string'
      ? (row as Record<string, string>).failureId : undefined;
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    if (isKnownFailOwnerRecord(row)) validById.set(row.failureId, row);
  }
  const ids = [...new Set(failureIds)].sort();
  const covered = ids.flatMap(id => idCounts.get(id) === 1 && validById.has(id) ? [validById.get(id)!] : []);
  return { covered, residual: ids.filter(id => idCounts.get(id) !== 1 || !validById.has(id)) };
}

/** A failed shard may be inherited only when the prior same-head verdict judged every failure preexisting. */
export function reusableGateShardFailures(receipt: GateShardReceipt, head40: string,
  preexistingIds: readonly string[] | undefined): boolean {
  const ids = [...receipt.failureIds, ...receipt.errorIds];
  if (!ids.length) return true;
  if (receipt.head40 !== head40 || !Array.isArray(preexistingIds)
    || !preexistingIds.every((id) => typeof id === 'string')) return false;
  const files = new Set(receipt.files);
  const baseline = preexistingIds.filter((id) => {
    const separator = id.indexOf(' > ');
    return separator > 0 && files.has(id.slice(0, separator));
  });
  return baseline.length > 0
    && JSON.stringify([...new Set(ids)].sort()) === JSON.stringify([...new Set(baseline)].sort());
}

export function gateShardReceiptPath(root: string, shardId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(shardId)) throw new Error('invalid shard id');
  return join(root, `${shardId}.receipt.json`);
}

function gateFileReceiptPath(root: string, key: string): string {
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('invalid gate file receipt key');
  return join(root, 'files', `${key.toLowerCase()}.json`);
}

function gateFileReceiptHistoryPath(root: string, key: string, recordSha256: string): string {
  if (!/^[a-f0-9]{64}$/i.test(key) || !/^[a-f0-9]{64}$/i.test(recordSha256)) throw new Error('invalid gate file receipt history key');
  return join(root, 'files', `${key.toLowerCase()}.${recordSha256.toLowerCase()}.json`);
}

function fileReceiptRecordSha256(receipt: GateFileReceipt): string {
  return createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
}

function validFileFailureIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === 'string' && id.trim().length > 0);
}

function validGateFileReceiptMeasurement(value: unknown): value is GateFileReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<GateFileReceipt>;
  return typeof receipt.file === 'string' && Array.isArray(receipt.closureFiles)
    && receipt.closureFiles.every((file) => typeof file === 'string') && receipt.closureFiles.includes(receipt.file)
    && typeof receipt.closureDigest === 'string' && /^[a-f0-9]{64}$/i.test(receipt.closureDigest)
    && typeof receipt.imageDigest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(receipt.imageDigest)
    && typeof receipt.key === 'string' && /^[a-f0-9]{64}$/i.test(receipt.key)
    && receipt.key === gateFileReceiptKeyFromClosureDigest(receipt.file, receipt.closureDigest, receipt.imageDigest)
    && typeof receipt.sourceHead40 === 'string' && /^[a-f0-9]{40}$/i.test(receipt.sourceHead40)
    && (receipt.carriedToHead40 === undefined || (typeof receipt.carriedToHead40 === 'string' && /^[a-f0-9]{40}$/i.test(receipt.carriedToHead40)))
    && (receipt.lane === undefined || ['train', 'cut', 'isolated-recheck'].includes(receipt.lane))
    && (receipt.opaqueReasons === undefined || (Array.isArray(receipt.opaqueReasons)
      && receipt.opaqueReasons.length > 0 && receipt.opaqueReasons.every((reason) => typeof reason === 'string' && !!reason.trim())))
    && (receipt.owner === undefined || typeof receipt.owner === 'string')
    && (receipt.outcome === 'pass' || (receipt.outcome === 'fail' && typeof receipt.owner === 'string'
      && !!receipt.owner.trim() && validFileFailureIds(receipt.failureIds))
      || (receipt.outcome === 'error' && typeof receipt.owner === 'string' && !!receipt.owner.trim() && validFileFailureIds(receipt.errorIds)));
}

/** Persist the latest file result and archive every distinct measurement for the same content key. */
export function saveGateFileReceipt(root: string, receipt: GateFileReceipt): GateFileReceiptEnvelope {
  if (!validGateFileReceiptMeasurement(receipt)) throw new Error('incomplete gate file receipt');
  return withGateShardReceiptLock(root, `file-${receipt.key}`, () => {
    const path = gateFileReceiptPath(root, receipt.key);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const existing = readGateFileReceipt(root, receipt.key);
      if (!existing || existing.file !== receipt.file || existing.closureDigest !== receipt.closureDigest
        || existing.imageDigest !== receipt.imageDigest)
        throw new Error(`gate file receipt CAS collision: ${receipt.file}`);
      const { recordSha256: _recordSha256, ...existingReceipt } = existing;
      if (fileReceiptRecordSha256(existingReceipt) === fileReceiptRecordSha256(receipt)) return existing;
      const archivePath = gateFileReceiptHistoryPath(root, existing.key, existing.recordSha256);
      if (!existsSync(archivePath)) atomicJson(archivePath, existing);
    }
    const envelope = { ...receipt, recordSha256: fileReceiptRecordSha256(receipt) };
    atomicJson(path, envelope);
    return envelope;
  });
}

function readValidGateFileReceipt(path: string, key: string): GateFileReceiptEnvelope | null {
  try {
    const row = JSON.parse(readFileSync(path, 'utf8')) as GateFileReceiptEnvelope;
    const { recordSha256, ...receipt } = row;
    if (!/^[a-f0-9]{64}$/i.test(recordSha256) || fileReceiptRecordSha256(receipt) !== recordSha256
      || !validGateFileReceiptMeasurement(receipt) || receipt.key !== key) return null;
    return row;
  } catch { return null; }
}

/** Read current and archived measurements without treating an archive as the current result. */
export function readGateFileReceiptHistory(root: string, key: string): GateFileReceiptEnvelope[] {
  try {
    const directory = join(root, 'files');
    const prefix = `${key.toLowerCase()}.`;
    const paths = [gateFileReceiptPath(root, key), ...readdirSync(directory)
      .filter((name) => name.startsWith(prefix) && name !== `${key.toLowerCase()}.json`).map((name) => join(directory, name))];
    return paths.flatMap((path) => {
      const row = readValidGateFileReceipt(path, key);
      return row ? [row] : [];
    });
  } catch { return []; }
}

/** Read only the current self-consistent receipt; history never substitutes for a damaged current record. */
export function readGateFileReceipt(root: string, key: string): GateFileReceiptEnvelope | null {
  try { return readValidGateFileReceipt(gateFileReceiptPath(root, key), key); }
  catch { return null; }
}

const HISTORY_HEADS_PER_SHARD = 5;
function archivedReceiptPath(root: string, shardId: string, head40: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(shardId) || !/^[a-f0-9]{40}$/i.test(head40)) throw new Error('invalid gate receipt history key');
  return join(root, `${shardId}.receipt.${head40.toLowerCase()}.json`);
}

export function nextGateShardAttempt(root: string, shardId: string): number {
  try {
    const previous = JSON.parse(readFileSync(gateShardReceiptPath(root, shardId), 'utf8')) as { attempt?: unknown };
    return Number.isSafeInteger(previous.attempt) && (previous.attempt as number) > 0 ? (previous.attempt as number) + 1 : 1;
  } catch { return 1; }
}

/** Planning may inspect an unmeasured predecessor; only readGateShardResult authorizes reuse. */
function receiptRecordSha256(value: Omit<GateShardReceipt, 'recordSha256'>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function validReceiptRecordIntegrity(value: GateShardReceipt): boolean {
  if (!value.recordSha256 || !/^[a-f0-9]{64}$/i.test(value.recordSha256)) return false;
  const { recordSha256: _checksum, ...record } = value;
  return receiptRecordSha256(record) === value.recordSha256;
}

export function readGateShardManifest(root: string, shardId: string): GateShardReceipt | null {
  try {
    const value = JSON.parse(readFileSync(gateShardReceiptPath(root, shardId), 'utf8')) as GateShardReceipt;
    const sources = value as GateShardReceipt & { sourceRunIds?: unknown; sourceEvidence?: unknown };
    const sourceRunIdsValid = sources.sourceRunIds === undefined || (Array.isArray(sources.sourceRunIds)
      && sources.sourceRunIds.every((id) => typeof id === 'string'));
    const sourceEvidenceValid = sources.sourceEvidence === undefined || (Array.isArray(sources.sourceEvidence)
      && sources.sourceEvidence.every((row) => !!row && typeof row === 'object'
        && typeof (row as { runId?: unknown }).runId === 'string'
        && typeof (row as { evidencePath?: unknown }).evidencePath === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._-]*\.result\.json$/.test((row as { evidencePath: string }).evidencePath)
        && typeof (row as { evidenceSha256?: unknown }).evidenceSha256 === 'string'
        && /^[a-f0-9]{64}$/i.test((row as { evidenceSha256: string }).evidenceSha256)));
    return value && value.id === shardId && Array.isArray(value.files)
      && Array.isArray(value.failureIds) && value.failureIds.every((id) => typeof id === 'string')
      && Array.isArray(value.errorIds) && value.errorIds.every((id) => typeof id === 'string')
      && sourceRunIdsValid && sourceEvidenceValid
      && (value.status === 'complete' || value.status === 'unmeasured')
      && (value.status !== 'complete' || validReceiptRecordIntegrity(value)) ? value : null;
  } catch { return null; }
}

/** Read the current manifest plus a bounded set of older, independently keyed head manifests. */
export function readGateShardManifestHistory(root: string, shardId: string): GateShardReceipt[] {
  const current = readGateShardManifest(root, shardId);
  let names: string[];
  try { names = readdirSync(root).filter((name) => new RegExp(`^${shardId}\\.receipt\\.[a-f0-9]{40}\\.json$`, 'i').test(name)); }
  catch { return current ? [current] : []; }
  const archived = names.flatMap((name) => {
    try {
      const value = JSON.parse(readFileSync(join(root, name), 'utf8')) as GateShardReceipt;
      return value?.id === shardId && Array.isArray(value.files) && Array.isArray(value.failureIds) && Array.isArray(value.errorIds)
        && (value.status === 'unmeasured' || (value.status === 'complete' && validReceiptRecordIntegrity(value))) ? [value] : [];
    } catch { return []; }
  });
  const rows = [...archived, ...(current ? [current] : [])];
  return [...new Map(rows.map((row) => [`${row.head40}:${row.attempt}`, row])).values()]
    .sort((a, b) => (a === current ? -1 : b === current ? 1 : Date.parse(b.measuredAt) - Date.parse(a.measuredAt)))
    .slice(0, HISTORY_HEADS_PER_SHARD);
}

function preservePreviousHead(root: string, shardId: string, nextHead40: string): void {
  const previous = readGateShardManifest(root, shardId);
  if (!previous || previous.status !== 'complete' || previous.head40 === nextHead40) return;
  atomicJson(archivedReceiptPath(root, shardId, previous.head40), previous);
  const pattern = new RegExp(`^${shardId}\\.receipt\\.([a-f0-9]{40})\\.json$`, 'i');
  const history = readdirSync(root).flatMap((name) => {
    const match = pattern.exec(name);
    if (!match) return [];
    const receipt = readGateShardManifestAt(root, name, shardId);
    return receipt ? [{ name, measuredAt: Date.parse(receipt.measuredAt), head: match[1]!.toLowerCase() }] : [];
  }).sort((a, b) => b.measuredAt - a.measuredAt);
  for (const stale of history.slice(HISTORY_HEADS_PER_SHARD)) rmSync(join(root, stale.name), { force: true });
}

function readGateShardManifestAt(root: string, name: string, shardId: string): GateShardReceipt | null {
  try {
    const value = JSON.parse(readFileSync(join(root, name), 'utf8')) as GateShardReceipt;
    return value && value.id === shardId && Array.isArray(value.files) && Array.isArray(value.failureIds)
      && Array.isArray(value.errorIds) && (value.status === 'unmeasured' || value.status === 'complete')
      && (value.status !== 'complete' || validReceiptRecordIntegrity(value)) ? value : null;
  } catch { return null; }
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}-${process.pid}-${randomUUID()}.tmp`);
  try { writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 }); renameSync(temp, path); }
  finally { if (existsSync(temp)) rmSync(temp); }
}

const RECEIPT_LOCK_EX = 2;
const RECEIPT_LOCK_NB = 4;
const RECEIPT_LOCK_UN = 8;
type ReceiptFlock = (fd: number, operation: number) => number;
let receiptFlock: ReceiptFlock | undefined;

function gateReceiptFlock(): ReceiptFlock {
  if (receiptFlock) return receiptFlock;
  const libraries = process.platform === 'darwin'
    ? ['/usr/lib/libSystem.B.dylib', 'libc.dylib']
    : ['libc.so.6', `libc.musl-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`];
  let lastError: unknown;
  for (const library of libraries) {
    try {
      const loaded = dlopen(library, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
      receiptFlock = (fd, operation) => loaded.symbols.flock(fd, operation) as number;
      return receiptFlock;
    } catch (error) { lastError = error; }
  }
  throw new Error(`gate shard receipt flock unavailable: ${String(lastError)}`);
}

function withGateReceiptKernelLock<T>(path: string, action: () => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const flock = gateReceiptFlock();
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const deadline = Date.now() + 10_000;
  try {
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    if (!opened.isFile() || (opened.mode & 0o077) !== 0 || opened.ino !== current.ino || opened.dev !== current.dev)
      throw new Error(`gate shard receipt lock is not a private regular file: ${path}`);
    while (flock(fd, RECEIPT_LOCK_EX | RECEIPT_LOCK_NB) !== 0) {
      if (Date.now() >= deadline) throw new Error(`gate shard receipt lock timeout: ${path}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    const locked = lstatSync(path);
    if (opened.ino !== locked.ino || opened.dev !== locked.dev) throw new Error(`gate shard receipt lock changed: ${path}`);
    return action();
  } finally {
    try { flock(fd, RECEIPT_LOCK_UN); } finally { closeSync(fd); }
  }
}

function reapDeadLegacyReceiptLock(path: string): boolean {
  try {
    const stat = statSync(path);
    const lockDirectory = stat.isDirectory();
    const ownerPath = lockDirectory ? join(path, 'pid') : path;
    const record = readFileSync(ownerPath, 'utf8');
    const [ownerText] = record.trim().split('\n');
    const owner = Number(ownerText);
    if (!Number.isInteger(owner) || owner <= 0 || Date.now() - stat.mtimeMs <= 60_000) return false;
    try { process.kill(owner, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }

    const quarantine = `${path}.reap-${process.pid}-${randomUUID()}`;
    renameSync(path, quarantine);
    try {
      const movedStat = statSync(quarantine);
      const movedRecord = readFileSync(lockDirectory ? join(quarantine, 'pid') : quarantine, 'utf8');
      const [movedOwnerText] = movedRecord.trim().split('\n');
      if (movedStat.dev !== stat.dev || movedStat.ino !== stat.ino || movedRecord !== record
        || movedOwnerText !== ownerText || Date.now() - movedStat.mtimeMs <= 60_000) {
        if (!existsSync(path)) renameSync(quarantine, path);
        return false;
      }
      try { process.kill(Number(movedOwnerText), 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          rmSync(quarantine, { recursive: lockDirectory, force: true });
          return true;
        }
      }
      if (!existsSync(path)) renameSync(quarantine, path);
      return false;
    } catch (error) {
      if (!existsSync(path) && existsSync(quarantine)) {
        try { renameSync(quarantine, path); } catch { /* retain quarantine for manual inspection */ }
      }
      throw error;
    }
  } catch { return false; }
}

function acquireReceiptLease(path: string, deadline: number): string {
  const token = randomUUID();
  const record = `${process.pid}\n${token}\n`;
  const candidate = `${path}.${process.pid}.${token}.tmp`;
  writeFileSync(candidate, record, { flag: 'wx', mode: 0o600 });
  while (true) {
    try { linkSync(candidate, path); return record; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { rmSync(candidate, { force: true }); throw error; }
      if (!reapDeadLegacyReceiptLock(path) && Date.now() >= deadline) {
        rmSync(candidate, { force: true });
        throw new Error(`gate shard receipt lock timeout: ${path}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function releaseReceiptLease(path: string, candidate: string, record: string): void {
  try { if (readFileSync(path, 'utf8') === record) unlinkSync(path); } catch { /* lease already removed */ }
  rmSync(candidate, { force: true });
}

function withGateShardReceiptLock<T>(root: string, shardId: string, action: () => T): T {
  mkdirSync(root, { recursive: true });
  const receiptPath = gateShardReceiptPath(root, shardId);
  return withGateReceiptKernelLock(`${receiptPath}.flock`, () => {
    // Both names remain leased to exclude legacy mkdir and hard-link writers during rollout.
    const paths = [`${receiptPath}.lock`, `${receiptPath}.lock.d`].sort();
    const deadline = Date.now() + 10_000;
    const leases: Array<{ path: string; candidate: string; record: string }> = [];
    try {
      for (const path of paths) {
        const acquiredRecord = acquireReceiptLease(path, deadline);
        const token = acquiredRecord.trim().split('\n')[1]!;
        leases.push({ path, candidate: `${path}.${process.pid}.${token}.tmp`, record: acquiredRecord });
      }
      return action();
    } finally {
      for (const lease of leases.reverse()) releaseReceiptLease(lease.path, lease.candidate, lease.record);
    }
  });
}

export type GateShardReceiptInspection =
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'valid'; images: Array<{ imageDigest: string }>; receipts: GateShardReceipt[];
      invalidatedShardIds: string[]; invalidatedFiles: string[] };

/** The gate treats an empty formal receipt inventory as a full-sweep fallback reason. */
export function formalReceiptSetPresenceReason(receiptCount: number): 'formal-receipt-set-absent' | undefined {
  return receiptCount === 0 ? 'formal-receipt-set-absent' : undefined;
}

export type GateShardExecutionSummary = {
  plannedShards: number;
  reusedShards: number;
  rerunShards: number;
  unmeasuredShards: number;
  selectedFiles: number;
  carriedFiles: number;
  action: 'reuse' | 'partial-sweep' | 'full-sweep' | 'unmeasured';
};

/** Summarize the latest persisted shard decisions for one gate invocation, failing closed on missing rows. */
export function summarizeGateShardExecution(rows: readonly Pick<GateShardLedgerRow,
  'version' | 'phase' | 'commit' | 'invocationId' | 'shardId' | 'files' | 'state' | 'attribution' | 'reuseDecision'>[], expected: {
    version: string; phase: GateShardLedgerRow['phase']; commit: string; invocationId: string;
    shards: readonly { shardId: string; files: readonly string[] }[];
  }): GateShardExecutionSummary {
  const expectedShards = [...expected.shards];
  const expectedIds = expectedShards.map((shard) => shard.shardId);
  const expectedFiles = new Map(expectedShards.map((shard) => [shard.shardId, [...shard.files]]));
  const byId = new Map<string, (typeof rows)[number]>();
  if (new Set(expectedIds).size !== expectedIds.length || expectedShards.some((shard) => !shard.files.length
    || new Set(shard.files).size !== shard.files.length)) throw new Error('invalid expected shard inventory');
  if (!expectedIds.length) return { plannedShards: 0, reusedShards: 0, rerunShards: 0, unmeasuredShards: 0,
    selectedFiles: 0, carriedFiles: 0, action: 'unmeasured' };
  for (const row of rows) {
    if (row.version === expected.version && row.phase === expected.phase && row.commit === expected.commit
      && row.invocationId === expected.invocationId && expectedIds.includes(row.shardId)) byId.set(row.shardId, row);
  }
  let reusedShards = 0;
  let rerunShards = 0;
  let unmeasuredShards = 0;
  let selectedFiles = 0;
  let carriedFiles = 0;
  for (const id of expectedIds) {
    const row = byId.get(id);
    const files = expectedFiles.get(id)!;
    if (!row || row.state !== 'done' || row.attribution !== 'complete' || !Array.isArray(row.files)
      || JSON.stringify(row.files) !== JSON.stringify(files)) {
      unmeasuredShards++;
      continue;
    }
    if (row.reuseDecision === 'reuse') {
      reusedShards++;
      carriedFiles += files.length;
    } else if (row.reuseDecision === 'rerun') {
      rerunShards++;
      selectedFiles += files.length;
    } else unmeasuredShards++;
  }
  const plannedShards = expectedIds.length;
  const action = unmeasuredShards ? 'unmeasured'
    : reusedShards === plannedShards ? 'reuse'
      : rerunShards === plannedShards ? 'full-sweep' : 'partial-sweep';
  return { plannedShards, reusedShards, rerunShards, unmeasuredShards, selectedFiles, carriedFiles, action };
}

/** Validate the complete formal receipt set against independently recorded shard and test inventories. */
export function inspectGateShardReceipts(root: string, expected: {
  version: string; commit: string; base40: string; envFingerprint: string;
  runtimeIdentity: NonNullable<GateShardReceipt['runtimeIdentity']>; lockHash: string;
  graphPins: { graphSha: string; recipeSha: string }; graphEntry: string; recipeCommand: string; recipeTimeoutMs: number;
  shards: Array<{ id: string; files: string[] }>; tests: string[];
}): GateShardReceiptInspection {
  let names: string[];
  try { names = readdirSync(root).filter((name) => name.endsWith('.receipt.json')); }
  catch { return { kind: 'absent' }; }
  if (!names.length) return { kind: 'absent' };
  if (names.some((name) => !/^pod-\d+\.receipt\.json$/.test(name)))
    return { kind: 'invalid', reason: 'formal receipt directory contains an invalid shard filename' };
  const orderedNames = names.sort((a, b) => Number(/^pod-(\d+)/.exec(a)![1]) - Number(/^pod-(\d+)/.exec(b)![1]));
  const expectedShards = [...expected.shards].sort((a, b) => Number(/^pod-(\d+)/.exec(a.id)?.[1] ?? -1) - Number(/^pod-(\d+)/.exec(b.id)?.[1] ?? -1));
  if (!expectedShards.length || expectedShards.some((shard, index) => shard.id !== `pod-${index}`)
    || JSON.stringify(orderedNames) !== JSON.stringify(expectedShards.map((shard) => `${shard.id}.receipt.json`)))
    return { kind: 'invalid', reason: 'formal receipt shard set differs from the independent gate shard inventory' };
  const receipts: GateShardReceipt[] = [];
  const images: Array<{ imageDigest: string }> = [];
  const invalidatedShardIds: string[] = [];
  const invalidatedFiles: string[] = [];
  const expectedFiles = expectedShards.flatMap((shard) => shard.files);
  if (new Set(expectedFiles).size !== expectedFiles.length || JSON.stringify([...expectedFiles].sort()) !== JSON.stringify([...expected.tests].sort()))
    return { kind: 'invalid', reason: 'independent gate shard files do not cover the test inventory exactly' };
  let image: string | undefined;
  for (const shard of expectedShards) {
    const receipt = readGateShardManifest(root, shard.id);
    if (!receipt || receipt.status !== 'complete') return { kind: 'invalid', reason: `formal shard receipt is absent or incomplete: ${shard.id}` };
    if (receipt.version !== expected.version)
      return { kind: 'invalid', reason: `formal shard receipt version differs: ${shard.id}` };
    if (receipt.graphSha !== expected.graphPins.graphSha || receipt.recipeSha !== expected.graphPins.recipeSha)
      return { kind: 'invalid', reason: `formal shard receipt graph/source pins differ: ${shard.id}` };
    if (receipt.head40 !== expected.commit || receipt.base40 !== expected.base40)
      return { kind: 'invalid', reason: `formal shard receipt baseline commit/base differs: ${shard.id}` };
    if (!receipt.graphEntry || receipt.graphEntry !== expected.graphEntry)
      return { kind: 'invalid', reason: 'formal shard receipt graph entry differs: ' + shard.id };
    if (!receipt.recipeCommand || receipt.recipeCommand !== expected.recipeCommand || receipt.recipeTimeoutMs !== expected.recipeTimeoutMs)
      return { kind: 'invalid', reason: 'formal shard receipt recipe command differs: ' + shard.id };
    if (JSON.stringify(receipt.files) !== JSON.stringify(shard.files))
      return { kind: 'invalid', reason: `formal shard receipt file assignment differs: ${shard.id}` };
    if (!receipt.imageDigest || !/^sha256:[a-f0-9]{64}$/i.test(receipt.imageDigest))
      return { kind: 'invalid', reason: `formal shard receipt executed image digest is invalid: ${shard.id}` };
    if (!receipt.runtimeIdentity || receipt.envFingerprint !== receipt.runtimeIdentity.envFingerprint
      || receipt.envKey !== gateShardRuntimeIdentityKey(receipt.runtimeIdentity, receipt.lockfileHash)
      || receipt.envKey !== gateShardRuntimeIdentityKey(expected.runtimeIdentity, expected.lockHash)
      || !runtimeIdentitiesMatch({ baseImageDigest: receipt.runtimeIdentity.baseImageDigest ?? '', lockHash: receipt.lockfileHash ?? '',
        os: receipt.runtimeIdentity.platform, architecture: receipt.runtimeIdentity.architecture, bunVersion: receipt.runtimeIdentity.bunVersion },
      { baseImageDigest: expected.runtimeIdentity.baseImageDigest ?? '', lockHash: expected.lockHash,
        os: expected.runtimeIdentity.platform, architecture: expected.runtimeIdentity.architecture, bunVersion: expected.runtimeIdentity.bunVersion }))
      return { kind: 'invalid', reason: `formal shard receipt environment/runtime differs: ${shard.id}` };
    if (image && image !== receipt.imageDigest)
      return { kind: 'invalid', reason: `formal shard receipt image digest differs across shards: ${shard.id}` };
    image = receipt.imageDigest;
    images.push({ imageDigest: receipt.imageDigest });
    const result = readGateShardResult(root, { shard: { id: shard.id, files: shard.files }, head40: expected.commit,
      base40: expected.base40, envKey: gateShardRuntimeIdentityKey(receipt.runtimeIdentity, receipt.lockfileHash) ?? '' });
    if (!result) {
      invalidatedShardIds.push(shard.id);
      invalidatedFiles.push(...shard.files);
      continue;
    }
    if (result.runs.some((run) => run.passedIds.some((id) => !shard.files.includes(id.split(' > ', 1)[0]!))))
    {
      invalidatedShardIds.push(shard.id);
      invalidatedFiles.push(...shard.files);
      continue;
    }
    receipts.push(receipt);
  }
  if (!receipts.length) return { kind: 'invalid', reason: 'no intact formal shard payload remains reusable' };
  return { kind: 'valid', images, receipts, invalidatedShardIds, invalidatedFiles: [...new Set(invalidatedFiles)].sort() };
}

/** A new attempt invalidates an old success before host execution starts. */
export function markGateShardUnmeasured(root: string, receipt: GateShardReceipt): void {
  preservePreviousHead(root, receipt.id, receipt.head40);
  atomicJson(gateShardReceiptPath(root, receipt.id), { ...receipt, status: 'unmeasured' });
}

/** Save the actual measured bytes and bind their digest to the manifest. */
function saveGateShardResultUnlocked(root: string, result: GateShardSavedResult): GateShardReceipt {
  const { receipt: inputReceipt, runs: inputRuns } = result;
  if (!eligibleGateShardReceipt(inputReceipt, inputReceipt, inputReceipt.head40, inputReceipt.base40))
    throw new Error('incomplete gate shard receipt metadata');
  if (!inputRuns.length) throw new Error('gate shard result has no measured runs');
  const invalidRun = inputRuns.find((run) => !Number.isSafeInteger(run.ran) || run.ran < 0
    || !Number.isSafeInteger(run.files) || run.files < 1);
  if (invalidRun) throw new Error(`gate shard result has invalid run counts: ran=${invalidRun.ran} files=${invalidRun.files}`);
  const priorManifest = readGateShardManifest(root, inputReceipt.id);
  const priorResult = priorManifest ? readGateShardResultInternal(root, { shard: priorManifest, head40: priorManifest.head40,
    base40: priorManifest.base40, envKey: priorManifest.envKey }, true) : null;
  const merged = mergePassingGateShardResults(priorResult, result);
  const { receipt, runs } = merged;
  preservePreviousHead(root, receipt.id, receipt.head40);
  const payloadName = `${receipt.id}.attempt-${receipt.attempt}-${randomUUID()}.result.json`;
  const payloadBody = { runs, failureIds: receipt.failureIds, errorIds: receipt.errorIds };
  const payload = JSON.stringify(payloadBody) + '\n';
  const digest = createHash('sha256').update(payload).digest('hex');
  atomicJson(join(root, payloadName), payloadBody);
  const withSources = receipt as GateShardReceipt & {
    sourceEvidence?: Array<{ runId: string; evidencePath: string; evidenceSha256: string }>;
  };
  const currentSource = { runId: receipt.graphRunId ?? 'unscoped', evidencePath: payloadName, evidenceSha256: digest };
  const sourceEvidence = [...new Map([...(withSources.sourceEvidence ?? []), currentSource]
    .map((evidence) => [`${evidence.runId}:${evidence.evidenceSha256}`, evidence])).values()];
  const record = { ...receipt, sourceEvidence, evidencePath: payloadName, evidenceSha256: digest };
  const saved = { ...record, recordSha256: receiptRecordSha256(record) };
  atomicJson(gateShardReceiptPath(root, receipt.id), saved);
  return saved;
}

/** Serialize each shard's read/merge/write so concurrent successful runs retain all provenance. */
export function saveGateShardResult(root: string, result: GateShardSavedResult): GateShardReceipt {
  return withGateShardReceiptLock(root, result.receipt.id, () => saveGateShardResultUnlocked(root, result));
}

/** No manifest, stale identity, missing bytes or digest mismatch can become a reused pass. */
function readGateShardResultInternal(root: string, expected: { shard: GateShardIdentity; head40: string; base40: string; envKey: string; receipt?: GateShardReceipt },
  ignoreActiveWriterLease = false): GateShardSavedResult | null {
  try {
    if (!ignoreActiveWriterLease && (existsSync(`${gateShardReceiptPath(root, expected.shard.id)}.lock`)
      || existsSync(`${gateShardReceiptPath(root, expected.shard.id)}.lock.d`))) return null;
    const receipt = expected.receipt ?? readGateShardManifest(root, expected.shard.id);
    if (!receipt) return null;
    if (!eligibleGateShardReceipt(receipt, expected.shard, expected.head40, expected.base40, false, receipt.head40 === expected.head40)
      || receipt.envKey !== expected.envKey
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.result\.json$/.test(receipt.evidencePath)) return null;
    const payload = readFileSync(join(root, receipt.evidencePath), 'utf8');
    if (createHash('sha256').update(payload).digest('hex') !== receipt.evidenceSha256) return null;
    const parsed = JSON.parse(payload) as { runs?: GateShardSavedRun[]; failureIds?: string[]; errorIds?: string[] };
    if (!Array.isArray(parsed.runs) || parsed.runs.length === 0 || parsed.runs.some((run) =>
      typeof run.output !== 'string' || !Number.isSafeInteger(run.rc) || !Number.isSafeInteger(run.ran)
      || !Number.isSafeInteger(run.files) || !Array.isArray(run.passedIds) || !Number.isSafeInteger(run.pass)
      || !Number.isSafeInteger(run.fail) || !Number.isSafeInteger(run.errors)
      || (run.skipped !== undefined && (!Number.isSafeInteger(run.skipped) || run.skipped < 0))
      || run.pass < 0 || run.fail < 0 || run.errors < 0 || run.passedIds.length !== run.pass
      || run.pass + run.fail + run.errors + (run.skipped ?? 0) !== run.ran
      || new Set(run.passedIds).size !== run.passedIds.length || run.passedIds.some((id) => typeof id !== 'string' || !id.trim()))
      || JSON.stringify(parsed.failureIds) !== JSON.stringify(receipt.failureIds)
      || JSON.stringify(parsed.errorIds) !== JSON.stringify(receipt.errorIds)) return null;
    return { receipt, runs: parsed.runs };
  } catch { return null; }
}

export function readGateShardResult(root: string, expected: { shard: GateShardIdentity; head40: string; base40: string; envKey: string; receipt?: GateShardReceipt }): GateShardSavedResult | null {
  return readGateShardResultInternal(root, expected);
}

/** Carry a verified unchanged shard to a descendant commit without claiming it was remeasured. */
export function carryGateShardResult(root: string, expected: GateShardSavedResult, head40: string): GateShardReceipt {
  if (!/^[a-f0-9]{40}$/i.test(head40)) throw new Error('invalid carried gate shard head');
  const { recordSha256: _previousRecordSha256, ...receipt } = expected.receipt;
  return saveGateShardResult(root, { receipt: { ...receipt, head40 }, runs: expected.runs });
}
