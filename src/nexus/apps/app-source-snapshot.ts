import { createHash } from 'node:crypto';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { ObjectStore } from '../../storage/object-store.js';
import { acquireLockAsync } from '../../storage/file-lock.js';

const MAX_FILES = 10_000;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.next', 'out', 'dist', '.app-source-revisions']);
const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY(?: BLOCK)?-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/i,
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|(?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}|AIza[A-Za-z0-9_-]{35})\b/,
  /\b(?:api[_-]?key|secret[_-]?key|access[_-]?key|token)\s*[=:]\s*["']?[A-Za-z0-9_./+~-]{20,}={0,2}/i,
];

export type AppSourceLedgerRecord =
  | { kind: 'source-snapshot-created'; appSlug: string; deploymentId: string; fingerprint: string; files: number; bytes: number }
  | { kind: 'source-snapshot-restored'; appSlug: string; deploymentId: string; fingerprint: string }
  | { kind: 'source-snapshot-rejected'; appSlug: string; deploymentId: string; reason: 'missing' | 'source-mismatch' | 'corrupt' };

export interface AppSourceSnapshotOptions {
  readonly appSlug: string;
  readonly deploymentId: string;
  /** The source directory only; generated build output is stored separately. */
  readonly sourceRoot: string;
  readonly objectStore: Pick<ObjectStore, 'put' | 'get' | 'head' | 'list'>;
  /** Appends one durable lifecycle record. The caller owns ledger persistence. */
  readonly record: (entry: AppSourceLedgerRecord) => void;
}

export interface AppSourceSnapshotResult {
  readonly appSlug: string;
  readonly deploymentId: string;
  readonly fingerprint: string;
  readonly files: number;
  readonly bytes: number;
  readonly objectKey: string;
}

export interface AppSourceRestoreResult {
  readonly appSlug: string;
  readonly deploymentId: string;
  readonly fingerprint: string;
  /** The next build must use this exact source revision. */
  readonly nextBuildInput: { readonly sourceRevisionId: string; readonly sourcePath: string };
}

interface SnapshotFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
  readonly data: string;
}

interface SnapshotManifest {
  readonly schema: 1;
  readonly appSlug: string;
  readonly deploymentId: string;
  readonly fingerprint: string;
  readonly files: readonly SnapshotFile[];
}

export class AppSourceSnapshotError extends Error {
  constructor(readonly code: 'invalid-input' | 'secret-found' | 'limit-exceeded' | 'snapshot-exists' | 'missing-snapshot' | 'source-mismatch' | 'corrupt-snapshot', message: string) {
    super(message);
    this.name = 'AppSourceSnapshotError';
  }
}

function validSlug(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function validDeploymentId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== '.' && value !== '..';
}

function objectKey(appSlug: string, deploymentId: string, fingerprint: string): string {
  return `apps/${appSlug}/source/${deploymentId}--${fingerprint}`;
}

function legacyObjectKey(appSlug: string, deploymentId: string): string {
  return `apps/${appSlug}/source/${deploymentId}`;
}

function safeRelativePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..') && !parts.some((part) => part.includes(':'));
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fingerprintOf(files: readonly Pick<SnapshotFile, 'path' | 'sha256' | 'size' | 'mode'>[]): string {
  return sha256(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, sha256: digest, size, mode }) => ({ path, sha256: digest, size, mode }))));
}

function isEnvSecretFile(path: string): boolean {
  const name = basename(path);
  return /^\.env(?:\.|$)/.test(name) && !/^\.env\.(?:example|sample|template)$/.test(name);
}

/** Shared source-content guard for snapshots and outbound Git history scans. */
export function containsSecret(text: string): boolean {
  const candidates = [text, text.replace(/(?:%[0-9a-f]{2})+/gi, (value) => {
    try { return decodeURIComponent(value); } catch { return value; }
  })];
  if (candidates.some((candidate) => SECRET_PATTERNS.some((pattern) => pattern.test(candidate)))) return true;
  for (const encoded of text.match(/[A-Za-z0-9+/]{24,}={0,2}/g) ?? []) {
    const stride = 16_384;
    const overlap = 512;
    for (let start = 0; start < encoded.length; start += stride - overlap) {
      const alignedStart = start - (start % 4);
      let end = Math.min(encoded.length, start + stride);
      end -= (end - alignedStart) % 4;
      const decoded = Buffer.from(encoded.slice(alignedStart, Math.max(alignedStart + 4, end)), 'base64').toString('latin1');
      if (SECRET_PATTERNS.some((pattern) => pattern.test(decoded))) return true;
      if (end >= encoded.length) break;
    }
  }
  return false;
}

function assertNoSecrets(files: readonly { path: string; data: Uint8Array }[]): void {
  for (const file of files) {
    if (isEnvSecretFile(file.path)) throw new AppSourceSnapshotError('secret-found', `source contains an environment secret file: ${file.path}`);
    const text = Buffer.from(file.data).toString('latin1').replaceAll('\0', '');
    if (containsSecret(text)) {
      throw new AppSourceSnapshotError('secret-found', `source contains a secret-shaped value: ${file.path}`);
    }
  }
}

function collectFiles(rootPath: string): Array<{ path: string; data: Uint8Array; mode: number }> {
  let root: string;
  try { root = realpathSync(rootPath); }
  catch { throw new AppSourceSnapshotError('invalid-input', 'source root is unavailable'); }
  let rootStat;
  try { rootStat = lstatSync(rootPath); } catch { throw new AppSourceSnapshotError('invalid-input', 'source root is unavailable'); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new AppSourceSnapshotError('invalid-input', 'source root must be a real directory');

  const files: Array<{ path: string; data: Uint8Array; mode: number }> = [];
  let total = 0;
  const visit = (dir: string): void => {
    const names = readdirSync(dir).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      if (EXCLUDED_DIRS.has(name)) continue;
      const absolute = join(dir, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new AppSourceSnapshotError('invalid-input', 'source contains a symbolic link');
      if (stat.isDirectory()) { visit(absolute); continue; }
      if (!stat.isFile()) throw new AppSourceSnapshotError('invalid-input', 'source contains a non-regular file');
      const path = relative(root, absolute).split(sep).join('/');
      if (!safeRelativePath(path)) throw new AppSourceSnapshotError('invalid-input', 'source contains an invalid path');
      const data = readFileSync(absolute);
      total += data.byteLength;
      if (files.length >= MAX_FILES || total > MAX_TOTAL_BYTES) throw new AppSourceSnapshotError('limit-exceeded', 'source snapshot exceeds the MVP size limit');
      files.push({ path, data, mode: stat.mode & 0o777 });
    }
  };
  visit(root);
  if (!files.length) throw new AppSourceSnapshotError('invalid-input', 'source directory is empty');
  assertNoSecrets(files);
  return files;
}

/** Compute the same stable identity used by immutable source snapshots without writing an object. */
export function fingerprintAppSourceDirectory(sourceRoot: string): string {
  const files = collectFiles(sourceRoot);
  return fingerprintOf(files.map(({ path, data, mode }) => ({ path, sha256: sha256(data), size: data.byteLength, mode })));
}

/** Serialize source changes and promotion decisions across Nexus processes for one app. */
export async function withAppSourceLock<T>(appSlug: string, sourceRoot: string, run: (assertHeld: () => void) => T | Promise<T>): Promise<T> {
  if (!validSlug(appSlug)) throw new AppSourceSnapshotError('invalid-input', 'app slug is invalid');
  const parent = dirname(resolve(sourceRoot));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // Live holders cannot be evicted by mtime, so this lock spans awaited publish work even if the event loop stalls.
  // A dead process is still reclaimed immediately from the PID embedded in the lock token.
  const release = await acquireLockAsync(join(parent, `.${appSlug}.source.lock`), { breakDeadHolder: true });
  try {
    const assertHeld = () => {
      if (!release.stillHeld()) throw new AppSourceSnapshotError('invalid-input', 'app source lock was lost');
    };
    assertHeld();
    return await run(assertHeld);
  } finally { release.release(); }
}

function parseManifest(path: string, appSlug: string, deploymentId: string): SnapshotManifest {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<SnapshotManifest>;
    if (value.schema !== 1 || value.appSlug !== appSlug || value.deploymentId !== deploymentId
      || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)
      || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > MAX_FILES) throw new Error('shape');
    let total = 0;
    const files: SnapshotFile[] = [];
    for (const raw of value.files) {
      if (!raw || typeof raw.path !== 'string' || !safeRelativePath(raw.path) || typeof raw.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(raw.sha256) || !Number.isSafeInteger(raw.size) || raw.size < 0
        || !Number.isSafeInteger(raw.mode) || raw.mode < 0 || raw.mode > 0o777 || typeof raw.data !== 'string') throw new Error('file');
      const data = Buffer.from(raw.data, 'base64');
      if (data.toString('base64') !== raw.data || data.byteLength !== raw.size || sha256(data) !== raw.sha256) throw new Error('digest');
      total += data.byteLength;
      if (total > MAX_TOTAL_BYTES) throw new Error('size');
      files.push(raw as SnapshotFile);
    }
    if (new Set(files.map((file) => file.path)).size !== files.length || fingerprintOf(files) !== value.fingerprint) throw new Error('fingerprint');
    return value as SnapshotManifest;
  } catch {
    throw new AppSourceSnapshotError('corrupt-snapshot', 'source snapshot is unreadable or corrupt');
  }
}

function readSnapshot(store: Pick<ObjectStore, 'get'>, key: string, slug: string, deploymentId: string): SnapshotManifest {
  const dir = mkdtempSync(join(tmpdir(), 'app-source-snapshot-read-'));
  const path = join(dir, 'snapshot.json');
  try {
    store.get(key, path);
    return parseManifest(path, slug, deploymentId);
  } catch (error) {
    if (error instanceof AppSourceSnapshotError) throw error;
    throw new AppSourceSnapshotError('missing-snapshot', 'source snapshot is missing or unreadable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function assertIdentity(input: Pick<AppSourceSnapshotOptions, 'appSlug' | 'deploymentId'>): void {
  if (!validSlug(input.appSlug) || !validDeploymentId(input.deploymentId)) {
    throw new AppSourceSnapshotError('invalid-input', 'app slug or deployment id is invalid');
  }
}

/** Store one immutable, private object per deployment revision. Repeated identical calls are idempotent. */
export function createAppSourceSnapshot(input: AppSourceSnapshotOptions): AppSourceSnapshotResult {
  assertIdentity(input);
  const files = collectFiles(input.sourceRoot);
  const metadata = files.map(({ path, data, mode }) => ({ path, sha256: sha256(data), size: data.byteLength, mode }));
  const fingerprint = fingerprintOf(metadata);
  const key = objectKey(input.appSlug, input.deploymentId, fingerprint);
  if (input.objectStore.head(key).exists) {
    const existing = readSnapshot(input.objectStore, key, input.appSlug, input.deploymentId);
    if (existing.fingerprint !== fingerprint) throw new AppSourceSnapshotError('corrupt-snapshot', 'immutable source snapshot key contains different source');
    const bytes = metadata.reduce((sum, file) => sum + file.size, 0);
    input.record({ kind: 'source-snapshot-created', appSlug: input.appSlug, deploymentId: input.deploymentId, fingerprint, files: files.length, bytes });
    return { appSlug: input.appSlug, deploymentId: input.deploymentId, fingerprint, files: files.length, bytes, objectKey: key };
  }
  const manifest: SnapshotManifest = {
    schema: 1, appSlug: input.appSlug, deploymentId: input.deploymentId, fingerprint,
    files: files.map(({ path, data, mode }, index) => ({ ...metadata[index]!, data: Buffer.from(data).toString('base64') })),
  };
  const serialized = JSON.stringify(manifest);
  input.objectStore.put(key, serialized, { contentType: 'application/json' });
  const bytes = metadata.reduce((sum, file) => sum + file.size, 0);
  input.record({ kind: 'source-snapshot-created', appSlug: input.appSlug, deploymentId: input.deploymentId, fingerprint, files: files.length, bytes });
  return { appSlug: input.appSlug, deploymentId: input.deploymentId, fingerprint, files: files.length, bytes, objectKey: key };
}

/** Validate the whole snapshot, then materialize a separate immutable path for the next build. */
export function restoreAppSourceSnapshot(input: AppSourceSnapshotOptions & { readonly expectedFingerprint: string }): AppSourceRestoreResult {
  assertIdentity(input);
  if (!/^[a-f0-9]{64}$/.test(input.expectedFingerprint)) throw new AppSourceSnapshotError('invalid-input', 'expected source fingerprint is invalid');
  const key = objectKey(input.appSlug, input.deploymentId, input.expectedFingerprint);
  let manifest: SnapshotManifest;
  try { manifest = readSnapshot(input.objectStore, key, input.appSlug, input.deploymentId); }
  catch (error) {
    if (error instanceof AppSourceSnapshotError && error.code === 'missing-snapshot') {
      const legacyKey = legacyObjectKey(input.appSlug, input.deploymentId);
      const priorFingerprintKey = `apps/${input.appSlug}/source/${input.deploymentId}/${input.expectedFingerprint}`;
      let fallback: SnapshotManifest | undefined;
      let sawFingerprintMismatch = false;
      for (const candidate of [legacyKey, priorFingerprintKey]) {
        if (!input.objectStore.head(candidate).exists) continue;
        try { fallback = readSnapshot(input.objectStore, candidate, input.appSlug, input.deploymentId); }
        catch (fallbackError) {
          if (fallbackError instanceof AppSourceSnapshotError && fallbackError.code === 'missing-snapshot') continue;
          input.record({ kind: 'source-snapshot-rejected', appSlug: input.appSlug, deploymentId: input.deploymentId, reason: 'corrupt' });
          throw fallbackError;
        }
        if (fallback.fingerprint !== input.expectedFingerprint) {
          sawFingerprintMismatch = true;
          fallback = undefined;
          continue;
        }
        break;
      }
      if (fallback) manifest = fallback;
      else {
        const sourcePrefix = `apps/${input.appSlug}/source/`;
        const deploymentPrefix = `${sourcePrefix}${input.deploymentId}--`;
        const siblings = input.objectStore.list(sourcePrefix);
        if (siblings.some(candidate => candidate.startsWith(deploymentPrefix))) {
        input.record({ kind: 'source-snapshot-rejected', appSlug: input.appSlug, deploymentId: input.deploymentId, reason: 'source-mismatch' });
        throw new AppSourceSnapshotError('source-mismatch', 'build and source snapshot fingerprints differ');
        }
        if (sawFingerprintMismatch) {
          input.record({ kind: 'source-snapshot-rejected', appSlug: input.appSlug, deploymentId: input.deploymentId, reason: 'source-mismatch' });
          throw new AppSourceSnapshotError('source-mismatch', 'build and source snapshot fingerprints differ');
        }
        input.record({ kind: 'source-snapshot-rejected', appSlug: input.appSlug, deploymentId: input.deploymentId, reason: 'missing' });
        throw error;
      }
    } else {
      input.record({ kind: 'source-snapshot-rejected', appSlug: input.appSlug, deploymentId: input.deploymentId, reason: 'corrupt' });
      throw error;
    }
  }
  if (manifest.fingerprint !== input.expectedFingerprint) {
    input.record({ kind: 'source-snapshot-rejected', appSlug: input.appSlug, deploymentId: input.deploymentId, reason: 'source-mismatch' });
    throw new AppSourceSnapshotError('source-mismatch', 'build and source snapshot fingerprints differ');
  }
  const decoded = manifest.files.map((file) => ({ path: file.path, data: Buffer.from(file.data, 'base64') }));
  try { assertNoSecrets(decoded); }
  catch {
    input.record({ kind: 'source-snapshot-rejected', appSlug: input.appSlug, deploymentId: input.deploymentId, reason: 'corrupt' });
    throw new AppSourceSnapshotError('corrupt-snapshot', 'source snapshot failed the secret scan');
  }

  let sourceRoot: string;
  try {
    sourceRoot = realpathSync(input.sourceRoot);
    const rootStat = lstatSync(input.sourceRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('not a real directory');
  } catch { throw new AppSourceSnapshotError('invalid-input', 'source root must be a real directory'); }
  const revisionsRoot = join(sourceRoot, '.app-source-revisions');
  let parent = revisionsRoot;
  for (const part of [input.appSlug, input.deploymentId]) {
    try { mkdirSync(parent, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new AppSourceSnapshotError('invalid-input', 'source revision directory is unavailable');
    }
    const parentStat = lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new AppSourceSnapshotError('invalid-input', 'source revision path must not contain a symbolic link');
    parent = join(parent, part);
  }
  try { mkdirSync(parent, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new AppSourceSnapshotError('invalid-input', 'source revision directory is unavailable');
  }
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new AppSourceSnapshotError('invalid-input', 'source revision path must not contain a symbolic link');
  const target = resolve(parent, manifest.fingerprint);
  try { if (lstatSync(target).isSymbolicLink()) throw new Error('symlink'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppSourceSnapshotError('invalid-input', 'source revision target must not be a symbolic link'); }
  const stage = mkdtempSync(join(parent, '.restore-'));
  try {
    for (const file of manifest.files) {
      const destination = join(stage, ...file.path.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      const contents = Buffer.from(file.data, 'base64');
      writeFileSync(destination, contents, { flag: 'wx' });
      chmodSync(destination, file.mode);
    }
    try {
      renameSync(stage, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      // Another identical restore won the immutable revision path. Verify it before reusing it.
      const existing = collectFiles(target).map(file => ({ path: file.path, size: file.data.byteLength, sha256: sha256(file.data), mode: file.mode }))
        .sort((a, b) => a.path.localeCompare(b.path));
      const expected = manifest.files.map(({ path, size, sha256: digest, mode }) => ({ path, size, sha256: digest, mode }))
        .sort((a, b) => a.path.localeCompare(b.path));
      if (JSON.stringify(existing) !== JSON.stringify(expected)) throw error;
    }
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw new AppSourceSnapshotError('corrupt-snapshot', 'source restore could not be applied atomically');
  } finally { rmSync(stage, { recursive: true, force: true }); }
  try {
    input.record({ kind: 'source-snapshot-restored', appSlug: input.appSlug, deploymentId: input.deploymentId, fingerprint: manifest.fingerprint });
  } catch {
    // The immutable revision is not selected by any build until this call returns its input.
    // Keep it as an unreferenced, safe-to-retry artifact; never destroy the caller's current source.
    throw new AppSourceSnapshotError('corrupt-snapshot', 'source revision was prepared but its ledger record failed');
  }
  return { appSlug: input.appSlug, deploymentId: input.deploymentId, fingerprint: manifest.fingerprint,
    nextBuildInput: { sourceRevisionId: input.deploymentId, sourcePath: target } };
}
