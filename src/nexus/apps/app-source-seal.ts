import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, renameSync, rmSync, closeSync, fstatSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 256;
const DIGEST = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SealedAppSource {
  readonly sealPath: string;
  readonly artifactDigest: string;
  readonly ownerId: string;
  readonly runId: string;
  readonly files: number;
  readonly runtime: { readonly startCommand: readonly string[]; readonly port?: number; readonly healthPath: string };
  readonly frontendRoot?: string;
  /** Immutable bytes captured from the verified source during sealing, keyed below frontendRoot. */
  readonly frontendAssets?: ReadonlyMap<string, Buffer>;
}

export interface SealAppSourceInput {
  /** A trusted publisher caller supplies this exact root; never take it from an HTTP request. */
  readonly sourceRoot: string;
  readonly sealRoot: string;
  readonly ownerId: string;
  readonly runId: string;
  /** Rechecks the verified owner/run/approval both before and just before publication. */
  readonly stillAuthorized: () => boolean | Promise<boolean>;
}

type RecordValue = Record<string, unknown>;
function refuse(): never { throw new Error('app source seal refused'); }
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  return value as RecordValue;
}
function exactKeys(value: RecordValue, keys: readonly string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) refuse();
}
function safePath(path: string): boolean {
  const parts = path.split('/');
  return path.length > 0 && Buffer.byteLength(path) <= 1024 && parts.length <= 16 && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0')
    && parts.every(part => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'));
}
function sha256(data: Uint8Array | string): string { return createHash('sha256').update(data).digest('hex'); }
function identity(path: string): { dev: bigint; ino: bigint } {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse();
  return { dev: stat.dev, ino: stat.ino };
}
function sameIdentity(path: string, original: { dev: bigint; ino: bigint }): void {
  const current = identity(path);
  if (current.dev !== original.dev || current.ino !== original.ino) refuse();
}
function readRegular(path: string, limit: number): Buffer {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)
    || (before.mode & 0o077n) !== 0n || process.getuid && before.uid !== BigInt(process.getuid())) refuse();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > BigInt(limit)) refuse();
    // A producer may grow a file after lstat. Read at most its declared size plus one byte.
    const data = Buffer.allocUnsafe(Number(before.size) + 1);
    let length = 0;
    while (length < data.length) {
      const count = readSync(fd, data, length, data.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (length !== Number(before.size) || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeNs !== before.mtimeNs
      || named.dev !== before.dev || named.ino !== before.ino) refuse();
    return data.subarray(0, length);
  } finally { closeSync(fd); }
}
function sourceNames(root: string): string[] {
  const names: string[] = [];
  let entries = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > 16) refuse();
    const reader = opendirSync(directory);
    try { for (let entry = reader.readSync(); entry; entry = reader.readSync()) {
      if (++entries > MAX_FILES * 2) refuse();
      const name = entry.name;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) refuse();
      const relativePath = relative(root, path).split(sep).join('/');
      if (relativePath === 'source-artifact.json') continue;
      if (!safePath(relativePath)) refuse();
      if (stat.isDirectory()) visit(path, depth + 1);
      else if (stat.isFile()) names.push(relativePath);
      else refuse();
      if (names.length > MAX_FILES) refuse();
    } } finally { reader.closeSync(); }
  };
  visit(root, 0);
  return names;
}

/** Verify TC's source-artifact@1 bytes, then atomically publish a private copy. */
export async function sealAppSource(input: SealAppSourceInput): Promise<SealedAppSource> {
  if (!isAbsolute(input.sourceRoot) || !isAbsolute(input.sealRoot) || !ID.test(input.ownerId) || !ID.test(input.runId)) refuse();
  if (!await input.stillAuthorized()) refuse();
  const sourceRoot = resolve(input.sourceRoot);
  const sourceIdentity = identity(sourceRoot);
  if (realpathSync(sourceRoot) !== sourceRoot) refuse();
  const sourceStat = lstatSync(sourceRoot);
  if ((sourceStat.mode & 0o077) !== 0 || process.getuid && sourceStat.uid !== process.getuid()) refuse();
  const raw = readRegular(join(sourceRoot, 'source-artifact.json'), MAX_MANIFEST_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { refuse(); }
  const artifact = record(parsed);
  exactKeys(artifact, ['schemaVersion', 'root', 'files', 'metadata', 'executed', 'published']);
  if (artifact.schemaVersion !== 'source-artifact@1' || artifact.root !== sourceRoot || artifact.executed !== false || artifact.published !== false) refuse();
  const files = record(artifact.files);
  const names = Object.keys(files).sort();
  if (!names.length || names.length > MAX_FILES || !names.includes('ARCHITECTURE.md')
    || names.some(name => !safePath(name) || !DIGEST.test(String(files[name])))) refuse();
  const actualNames = sourceNames(sourceRoot).sort();
  if (actualNames.join('\0') !== names.join('\0')) refuse();
  const metadata = record(artifact.metadata);
  const runtime = record(metadata.runtime);
  if (Object.keys(runtime).some(key => !['startCommand', 'port', 'healthPath'].includes(key))) refuse();
  if (!Array.isArray(runtime.startCommand) || !runtime.startCommand.length || runtime.startCommand.length > 16
    || runtime.startCommand.some(arg => typeof arg !== 'string' || !arg || arg.length > 256 || /[\x00-\x1f]/u.test(arg))
    || (runtime.port !== undefined && (!Number.isInteger(runtime.port) || Number(runtime.port) < 31500 || Number(runtime.port) > 31599))
    || typeof runtime.healthPath !== 'string' || !/^\/[A-Za-z0-9/_-]*$/.test(runtime.healthPath)) refuse();
  const frontendRoot = metadata.frontendRoot;
  if (frontendRoot !== undefined && (typeof frontendRoot !== 'string' || !safePath(frontendRoot))) refuse();
  if (typeof frontendRoot === 'string' && !names.includes(frontendRoot + '/index.html')) refuse();
  if (metadata.apiPrefix !== undefined && metadata.apiPrefix !== '/api') refuse();
  // Keep model-supplied argv inert. The later service stage must independently allowlist it.
  const sealRoot = resolve(input.sealRoot);
  if (sealRoot === sourceRoot || relative(sourceRoot, sealRoot).split(sep)[0] !== '..'
    || relative(sealRoot, sourceRoot).split(sep)[0] !== '..') refuse();
  const sealIdentity = identity(sealRoot);
  const sealStat = lstatSync(sealRoot);
  if (realpathSync(sealRoot) !== sealRoot || (sealStat.mode & 0o077) !== 0
    || process.getuid && sealStat.uid !== process.getuid()) refuse();
  const sealId = 'source-' + randomUUID();
  const staging = join(sealRoot, '.' + sealId);
  const target = join(sealRoot, sealId);
  mkdirSync(staging, { mode: 0o700 });
  try {
    let total = 0;
    const frontendAssets = new Map<string, Buffer>();
    for (const name of names) {
      sameIdentity(sourceRoot, sourceIdentity);
      const source = join(sourceRoot, name);
      const parent = dirname(source);
      if (realpathSync(parent) !== parent) refuse();
      const bytes = readRegular(source, MAX_SOURCE_BYTES - total);
      total += bytes.byteLength;
      if (sha256(bytes) !== files[name]) refuse();
      if (typeof frontendRoot === 'string' && name.startsWith(frontendRoot + '/'))
        frontendAssets.set(name.slice(frontendRoot.length + 1), Buffer.from(bytes));
      const destination = join(staging, name);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
    }
    sameIdentity(sourceRoot, sourceIdentity);
    const artifactDigest = sha256(JSON.stringify({ schemaVersion: artifact.schemaVersion, root: sourceRoot,
      files: Object.fromEntries(names.map(name => [name, files[name]])), metadata, executed: false, published: false }));
    const sealed: SealedAppSource = { sealPath: target, artifactDigest, ownerId: input.ownerId,
      runId: input.runId, files: names.length, runtime: runtime as SealedAppSource['runtime'],
      ...(frontendRoot !== undefined ? { frontendRoot: frontendRoot as string, frontendAssets } : {}) };
    const { frontendAssets: _frontendAssets, ...receipt } = sealed;
    // Valid source files may be named seal.json. safePath rejects dot-prefixed
    // segments, so this private receipt directory cannot collide with the file map.
    const receiptRoot = join(staging, '.elanous');
    mkdirSync(receiptRoot, { mode: 0o700 });
    writeFileSync(join(receiptRoot, 'seal.json'), JSON.stringify({ ...receipt, sealPath: undefined }) + '\n', { flag: 'wx', mode: 0o600 });
    if (!await input.stillAuthorized()) refuse();
    sameIdentity(sourceRoot, sourceIdentity);
    sameIdentity(sealRoot, sealIdentity);
    renameSync(staging, target);
    return sealed;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
