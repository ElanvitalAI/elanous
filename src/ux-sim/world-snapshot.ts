import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { getTestStateRoot } from '../nexus/paths.js';
import { parseSimWorld } from './world.js';
import { assertSimWorldOwnership, createSimWorld, destroySimWorld, listSimWorlds, type SimWorld, type SimWorldOptions } from './world-store.js';

const SNAPSHOT_FORMAT = 1;
const SNAPSHOT_ID = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const WORLD_ENTRIES = ['config', 'devices', 'fixtures', 'state', 'tmp', 'world.json'] as const;
const RESTORE_ENTRIES = ['config', 'fixtures', 'state', 'tmp'] as const;

interface SnapshotEntry {
  readonly path: string;
  readonly kind: 'directory' | 'file';
  readonly mode: number;
  readonly size?: number;
  readonly sha256?: string;
}

interface SnapshotManifest {
  readonly format: 1;
  readonly worldId: string;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly entries: readonly SnapshotEntry[];
}

export interface SimWorldSnapshotOptions extends SimWorldOptions {
  readonly now?: () => Date;
  /** Deterministic restore failure injection for rollback tests; not exposed by the CLI. */
  readonly beforeRestoreInstallForTesting?: (name: string, index: number) => void;
  /** Deterministic fork failure injection for cleanup tests; not exposed by the CLI. */
  readonly beforeForkInstallForTesting?: (name: string, index: number) => void;
}

function assertSimUniverse(): void {
  if (!getTestStateRoot()) throw new Error('sim world snapshots require an explicit --test universe');
}

function requireWorld(id: string, options: SimWorldOptions): SimWorld {
  const world = listSimWorlds(options).find(candidate => candidate.id === id);
  if (!world) throw new Error(`sim world not found or unsupported world format: ${id}`);
  assertSimWorldOwnership(world);
  return world;
}

function validateSnapshotId(id: string): void {
  if (!SNAPSHOT_ID.test(id)) throw new Error(`invalid sim snapshot id ${JSON.stringify(id)}`);
}

function validateWorldId(id: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(id)) throw new Error(`invalid sim world id ${JSON.stringify(id)}`);
}

function snapshotRoot(world: SimWorld): string {
  const dir = join(world.rootDir, 'snapshots');
  try {
    const info = lstatSync(dir);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) {
      throw new Error(`sim snapshot directory must be an owned 0700 directory: ${dir}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(dir, { mode: 0o700 });
  }
  return dir;
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeRelativePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.includes('\\')) return false;
  const parts = value.split('/');
  return parts.every(part => part !== '' && part !== '.' && part !== '..');
}

function collectAndCopy(source: string, destination: string, base: string, entries: SnapshotEntry[]): void {
  const info = lstatSync(source);
  if (info.isSymbolicLink()) throw new Error(`sim snapshot refuses symlink: ${source}`);
  const rel = relative(base, source).split(sep).join('/');
  if (!safeRelativePath(rel)) throw new Error(`sim snapshot path is invalid: ${rel}`);
  const mode = info.mode & 0o777;
  if (info.isDirectory()) {
    entries.push({ path: rel, kind: 'directory', mode });
    mkdirSync(destination, { mode });
    chmodSync(destination, mode);
    for (const name of readdirSync(source).sort()) {
      collectAndCopy(join(source, name), join(destination, name), base, entries);
    }
    return;
  }
  if (!info.isFile()) throw new Error(`sim snapshot refuses non-regular file: ${source}`);
  const bytes = readFileSync(source);
  writeFileSync(destination, bytes, { mode, flag: 'wx' });
  chmodSync(destination, mode);
  entries.push({ path: rel, kind: 'file', mode, size: bytes.byteLength, sha256: hash(bytes) });
}

function copyWorldPayload(world: SimWorld, payloadDir: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  for (const name of WORLD_ENTRIES) {
    const source = join(world.rootDir, name);
    const destination = join(payloadDir, name);
    collectAndCopy(source, destination, world.rootDir, entries);
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function scanPayload(payloadDir: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  const scan = (path: string, rel: string): void => {
    if (!safeRelativePath(rel)) throw new Error(`sim snapshot path is invalid: ${rel}`);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(`sim snapshot refuses symlink: ${rel}`);
    const mode = info.mode & 0o777;
    if (info.isDirectory()) {
      entries.push({ path: rel, kind: 'directory', mode });
      for (const name of readdirSync(path).sort()) scan(join(path, name), `${rel}/${name}`);
      return;
    }
    if (!info.isFile()) throw new Error(`sim snapshot refuses non-regular file: ${rel}`);
    const bytes = readFileSync(path);
    entries.push({ path: rel, kind: 'file', mode, size: bytes.byteLength, sha256: hash(bytes) });
  };
  for (const name of readdirSync(payloadDir).sort()) scan(join(payloadDir, name), name);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function sameEntries(expected: readonly SnapshotEntry[], actual: readonly SnapshotEntry[]): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual);
}

function readSnapshot(world: SimWorld, snapshotId: string): { root: string; payload: string; manifest: SnapshotManifest } {
  validateSnapshotId(snapshotId);
  const root = join(snapshotRoot(world), snapshotId);
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || (rootInfo.mode & 0o777) !== 0o700) {
    throw new Error(`sim snapshot is not an owned 0700 directory: ${root}`);
  }
  const metadataPath = join(root, 'snapshot.json');
  const metadataInfo = lstatSync(metadataPath);
  if (metadataInfo.isSymbolicLink() || !metadataInfo.isFile() || (metadataInfo.mode & 0o777) !== 0o600) {
    throw new Error(`sim snapshot metadata is invalid: ${metadataPath}`);
  }
  const manifest = JSON.parse(readFileSync(metadataPath, 'utf8')) as SnapshotManifest;
  if (manifest.format !== SNAPSHOT_FORMAT || manifest.worldId !== world.id || manifest.snapshotId !== snapshotId
    || typeof manifest.createdAt !== 'string' || !Array.isArray(manifest.entries)) {
    throw new Error(`sim snapshot metadata does not match ${world.id}/${snapshotId}`);
  }
  const payload = join(root, 'payload');
  const payloadInfo = lstatSync(payload);
  if (payloadInfo.isSymbolicLink() || !payloadInfo.isDirectory() || (payloadInfo.mode & 0o777) !== 0o700) {
    throw new Error(`sim snapshot payload is invalid: ${payload}`);
  }
  const actual = scanPayload(payload);
  if (!sameEntries(manifest.entries, actual)) throw new Error(`sim snapshot integrity check failed: ${world.id}/${snapshotId}`);
  const topLevel = [...new Set(actual.map(entry => entry.path.split('/')[0]))].sort();
  if (JSON.stringify(topLevel) !== JSON.stringify([...WORLD_ENTRIES].sort())) {
    throw new Error(`sim snapshot world layout is invalid: ${world.id}/${snapshotId}`);
  }
  return { root, payload, manifest };
}

function removeIfOwned(path: string): void {
  try {
    const info = lstatSync(path);
    if (info.isDirectory() && !info.isSymbolicLink()) rmSync(path, { recursive: true, force: false });
    else rmSync(path, { force: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Save an immutable, checksummed copy of a complete format-1 world. */
export function snapshotSimWorld(worldId: string, snapshotId: string = randomUUID(), options: SimWorldSnapshotOptions = {}): SnapshotManifest {
  assertSimUniverse();
  validateSnapshotId(snapshotId);
  const world = requireWorld(worldId, options);
  const root = snapshotRoot(world);
  const snapshotDir = join(root, snapshotId);
  mkdirSync(snapshotDir, { mode: 0o700 }); // Exclusive reservation: an existing snapshot is never replaced.
  const payload = join(snapshotDir, 'payload');
  try {
    mkdirSync(payload, { mode: 0o700 });
    const entries = copyWorldPayload(world, payload);
    const manifest: SnapshotManifest = {
      format: SNAPSHOT_FORMAT,
      worldId,
      snapshotId,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      entries,
    };
    // Metadata is the commit marker: incomplete snapshots never look complete.
    writeFileSync(join(snapshotDir, 'snapshot.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return manifest;
  } catch (error) {
    removeIfOwned(snapshotDir);
    throw error;
  }
}

function copyPayloadTo(source: string, destination: string): void {
  for (const name of readdirSync(source).sort()) {
    collectAndCopy(join(source, name), join(destination, name), source, []);
  }
}

/** Restore the selected immutable snapshot in place, rolling back on replacement failure. */
export function restoreSimWorld(worldId: string, snapshotId: string, options: SimWorldSnapshotOptions = {}): void {
  assertSimUniverse();
  const world = requireWorld(worldId, options);
  const snapshot = readSnapshot(world, snapshotId);
  const staging = join(world.rootDir, `.restore-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    copyPayloadTo(snapshot.payload, staging);
    const stagedManifest = JSON.parse(readFileSync(join(staging, 'world.json'), 'utf8')) as Record<string, unknown>;
    if (stagedManifest.format !== 1 || stagedManifest.id !== worldId) throw new Error(`snapshot belongs to a different world: ${snapshotId}`);

    const backup = join(world.rootDir, `.restore-backup-${randomUUID()}`);
    mkdirSync(backup, { mode: 0o700 });
    const moved: string[] = [];
    const installed: string[] = [];
    try {
      for (const [index, name] of RESTORE_ENTRIES.entries()) {
        options.beforeRestoreInstallForTesting?.(name, index);
        renameSync(join(world.rootDir, name), join(backup, name));
        moved.push(name);
        renameSync(join(staging, name), join(world.rootDir, name));
        installed.push(name);
      }
      assertSimWorldOwnership(world);
    } catch (error) {
      for (const name of installed.reverse()) removeIfOwned(join(world.rootDir, name));
      for (const name of moved.reverse()) renameSync(join(backup, name), join(world.rootDir, name));
      removeIfOwned(backup);
      throw error;
    }
    removeIfOwned(backup);
  } finally {
    removeIfOwned(staging);
  }
}

/** Clone a snapshot into a new, independent format-1 world with a fresh identity. */
export function forkSimWorld(worldId: string, snapshotId: string, newWorldId: string, options: SimWorldSnapshotOptions = {}): SimWorld {
  assertSimUniverse();
  validateWorldId(newWorldId);
  const source = requireWorld(worldId, options);
  const snapshot = readSnapshot(source, snapshotId);
  if (listSimWorlds(options).some(world => world.id === newWorldId)) throw new Error(`sim world already exists: ${newWorldId}`);
  const target = createSimWorld(newWorldId, options);
  const staging = join(target.rootDir, `.fork-${randomUUID()}`);
  try {
    mkdirSync(staging, { mode: 0o700 });
    copyPayloadTo(snapshot.payload, staging);
    const manifestPath = join(staging, 'world.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    if (manifest.format !== 1 || manifest.id !== worldId) throw new Error(`snapshot belongs to a different world: ${snapshotId}`);
    manifest.id = newWorldId;
    manifest.createdAt = (options.now ?? (() => new Date()))().toISOString();
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    chmodSync(manifestPath, 0o600);
    if (manifest.declarationFormat === 'yaml') {
      const yamlSpecPath = join(staging, 'config', 'world.yaml');
      const yamlInfo = lstatSync(yamlSpecPath);
      if (yamlInfo.isSymbolicLink() || !yamlInfo.isFile() || (yamlInfo.mode & 0o777) !== 0o600) {
        throw new Error(`YAML world spec must be an owned 0600 file: ${yamlSpecPath}`);
      }
      const yamlSpec = parseSimWorld(readFileSync(yamlSpecPath, 'utf8'));
      if (yamlSpec.world !== worldId) throw new Error(`snapshot belongs to a different YAML world: ${snapshotId}`);
      writeFileSync(yamlSpecPath, `${JSON.stringify({ ...yamlSpec, world: newWorldId }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(yamlSpecPath, 0o600);
    }

    const backup = join(target.rootDir, `.fork-backup-${randomUUID()}`);
    mkdirSync(backup, { mode: 0o700 });
    const moved: string[] = [];
    const installed: string[] = [];
    try {
      for (const [index, name] of WORLD_ENTRIES.entries()) {
        options.beforeForkInstallForTesting?.(name, index);
        renameSync(join(target.rootDir, name), join(backup, name));
        moved.push(name);
        renameSync(join(staging, name), join(target.rootDir, name));
        installed.push(name);
      }
      assertSimWorldOwnership(target);
    } catch (error) {
      for (const name of installed.reverse()) removeIfOwned(join(target.rootDir, name));
      for (const name of moved.reverse()) renameSync(join(backup, name), join(target.rootDir, name));
      removeIfOwned(backup);
      throw error;
    }
    removeIfOwned(backup);
  } catch (error) {
    // Do not leave the initially reserved or partially copied target behind.
    try { destroySimWorld(target.id, options); } catch { /* preserve the original failure */ }
    throw error;
  } finally {
    removeIfOwned(staging);
  }
  return requireWorld(newWorldId, options);
}
