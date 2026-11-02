import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getTestStateRoot } from '../nexus/paths.js';

/**
 * Threat model: worlds live under an explicit private test root; other OS users
 * cannot replace entries in its 0700 directories. A process running as the same
 * UID can still race path-based syscalls, which portable Node fs cannot make
 * atomic. That stronger same-UID guarantee is tracked separately as
 * SIM-WORLD-ATOMIC-FS.
 */
const WORLD_FORMAT = 1;
const WORLD_ID = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

export interface SimWorld {
  readonly id: string;
  readonly rootDir: string;
  readonly stateDir: string;
  readonly configDir: string;
  readonly fixturesDir: string;
  readonly tmpDir: string;
  readonly createdAt: string;
}

export interface SimWorldOptions {
  /** Parent of all worlds. The default is `<effective state root>/sim/worlds`. */
  readonly worldsDir?: string;
  readonly now?: () => Date;
  /** Deterministic path-boundary race injection; not exposed by the CLI. */
  readonly beforeWorldsDirectoryCreateForTesting?: (parentDir: string, targetDir: string) => void;
  /** Deterministic reservation replacement injection for lifecycle tests; not exposed by the CLI. */
  readonly afterCreateReservationForTesting?: (rootDir: string) => void;
  /** Deterministic replacement injection after one child directory is initialized. */
  readonly afterWorldDirectoryForTesting?: (rootDir: string, name: string) => void;
  /** Deterministic race injection for lifecycle tests; not exposed by the CLI. */
  readonly beforeDestroyRenameForTesting?: () => void;
  /** Deterministic quarantine replacement injection for lifecycle tests; not exposed by the CLI. */
  readonly beforeQuarantineRemovalForTesting?: (quarantineDir: string) => void;
}

export interface SimWorldOwnershipDescriptor {
  readonly id: string;
  readonly rootDir: string;
}

function validateWorldId(id: string): string {
  if (!WORLD_ID.test(id)) {
    throw new Error(`invalid sim world id ${JSON.stringify(id)} (use 1–63 lowercase letters, numbers, or hyphens)`);
  }
  return id;
}

function configuredWorldsDir(options: SimWorldOptions, create: boolean): string | undefined {
  const testRoot = getTestStateRoot();
  if (!testRoot) throw new Error('sim worlds require an explicit --test universe');
  const logicalTestRoot = resolve(testRoot);
  const physicalTestRoot = realpathSync(logicalTestRoot);
  const requested = resolve(options.worldsDir ?? join(physicalTestRoot, 'sim', 'worlds'));
  const isChild = (root: string, candidate: string): boolean => {
    const path = relative(root, candidate);
    return Boolean(path) && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  const lexicalRoot = isChild(logicalTestRoot, requested) ? logicalTestRoot
    : isChild(physicalTestRoot, requested) ? physicalTestRoot : undefined;
  if (!lexicalRoot) {
    throw new Error('sim world storage escaped the test universe');
  }
  const lexicalRelative = relative(lexicalRoot, requested);
  const ensureInside = (physicalPath: string): void => {
    const physicalRelative = relative(physicalTestRoot, physicalPath);
    if (!physicalRelative || physicalRelative === '..' || physicalRelative.startsWith(`..${sep}`) || isAbsolute(physicalRelative)) {
      throw new Error('sim world storage escaped the test universe');
    }
  };

  // Walk one path component at a time. Recursive mkdir would follow an existing
  // symlink before the physical boundary was checked and could create outside the
  // explicit test universe.
  let cursor = physicalTestRoot;
  for (const part of lexicalRelative.split(sep)) {
    const next = join(cursor, part);
    try {
      const info = lstatSync(next);
      if (!info.isDirectory() && !info.isSymbolicLink()) {
        throw new Error(`sim world storage is not a directory: ${next}`);
      }
      const physical = realpathSync(next);
      ensureInside(physical);
      if (!lstatSync(physical).isDirectory()) throw new Error(`sim world storage is not a directory: ${next}`);
      cursor = physical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return undefined;
      // Best-effort revalidation immediately before the path-based create. A
      // same-UID process can still race this syscall; that is outside this API's
      // threat model (see SIM-WORLD-ATOMIC-FS).
      options.beforeWorldsDirectoryCreateForTesting?.(cursor, next);
      const currentParent = realpathSync(cursor);
      if (currentParent !== physicalTestRoot) ensureInside(currentParent);
      if (currentParent !== cursor || !lstatSync(currentParent).isDirectory()) {
        throw new Error(`sim world storage parent changed before create: ${cursor}`);
      }
      // `next` is under the revalidated in-universe parent. mkdir is
      // non-recursive so a competing entry fails closed instead of being adopted.
      mkdirSync(next, { mode: 0o700 });
      const physical = realpathSync(next);
      ensureInside(physical);
      cursor = physical;
    }
  }
  try {
    const physicalWorldsDir = realpathSync(cursor);
    ensureInside(physicalWorldsDir);
    const worldsInfo = lstatSync(physicalWorldsDir);
    if (worldsInfo.isSymbolicLink() || !worldsInfo.isDirectory() || (worldsInfo.mode & 0o777) !== 0o700) {
      throw new Error(`sim world storage must be a private 0700 directory: ${physicalWorldsDir}`);
    }
    return physicalWorldsDir;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !create) return undefined;
    throw error;
  }
}

function worldPath(worldsDir: string, id: string): string {
  const target = resolve(worldsDir, validateWorldId(id));
  const child = relative(resolve(worldsDir), target);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('sim world path escaped its root');
  }
  return target;
}

function manifestPath(rootDir: string): string {
  return join(rootDir, 'world.json');
}

/** Reject caller supplied roots unless their private directory and manifest identify this world. */
export function assertSimWorldOwnership(world: SimWorldOwnershipDescriptor): void {
  const resolvedRoot = resolve(world.rootDir);
  const testRoot = getTestStateRoot();
  if (!testRoot) throw new Error('sim worlds require an explicit --test universe');
  const physicalTestRoot = realpathSync(resolve(testRoot));
  const worldRelative = relative(physicalTestRoot, resolvedRoot);
  if (!worldRelative || worldRelative === '..' || worldRelative.startsWith(`..${sep}`) || isAbsolute(worldRelative)) {
    throw new Error(`sim world root escaped the test universe: ${resolvedRoot}`);
  }
  if (resolvedRoot !== realpathSync(resolvedRoot) || resolvedRoot.split(sep).at(-1) !== world.id) {
    throw new Error(`sim world root does not belong to ${world.id}`);
  }
  const rootInfo = lstatSync(resolvedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || (rootInfo.mode & 0o777) !== 0o700) {
    throw new Error(`sim world root must be an owned 0700 directory: ${resolvedRoot}`);
  }
  const path = manifestPath(resolvedRoot);
  const manifestInfo = lstatSync(path);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile() || (manifestInfo.mode & 0o777) !== 0o600) {
    throw new Error(`sim world manifest must be an owned 0600 file: ${path}`);
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const manifestId = manifest.id ?? manifest.world;
  if (manifestId !== world.id) throw new Error(`sim world manifest does not match ${world.id}`);
  if (manifest.format !== WORLD_FORMAT && manifest.world !== world.id) {
    throw new Error(`sim world metadata is invalid: ${resolvedRoot}`);
  }
  if (manifest.format === WORLD_FORMAT && typeof manifest.createdAt !== 'string') {
    throw new Error(`sim world metadata is invalid: ${resolvedRoot}`);
  }
}

function readWorld(rootDir: string, id: string): SimWorld {
  assertSimWorldOwnership({ id, rootDir });
  const path = manifestPath(rootDir);
  const manifestInfo = lstatSync(path);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
    throw new Error(`sim world metadata must be a regular file: ${path}`);
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (manifest.format !== WORLD_FORMAT || manifest.id !== id || typeof manifest.createdAt !== 'string') {
    throw new Error(`sim world metadata is invalid: ${rootDir}`);
  }
  for (const name of ['state', 'config', 'fixtures', 'tmp']) {
    let childInfo: ReturnType<typeof lstatSync>;
    try { childInfo = lstatSync(join(rootDir, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`sim world layout is invalid: ${rootDir}/${name}`);
      }
      throw error;
    }
    if (childInfo.isSymbolicLink() || !childInfo.isDirectory()) {
      throw new Error(`sim world layout is invalid: ${rootDir}/${name}`);
    }
  }
  return {
    id,
    rootDir,
    stateDir: join(rootDir, 'state'),
    configDir: join(rootDir, 'config'),
    fixturesDir: join(rootDir, 'fixtures'),
    tmpDir: join(rootDir, 'tmp'),
    createdAt: manifest.createdAt,
  };
}

function sameDirectory(
  left: ReturnType<typeof lstatSync>,
  right: ReturnType<typeof lstatSync>,
): boolean {
  return Boolean(left && right && left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino);
}

/** Quarantine under the private (0700) worlds directory, then remove only the captured inode. */
function removeOwnedDirectory(
  path: string,
  expected: ReturnType<typeof lstatSync>,
  beforeRemovalForTesting?: (quarantineDir: string) => void,
): void {
  const quarantine = join(dirname(path), `.${randomUUID()}.sim-world-removal`);
  renameSync(path, quarantine);
  if (!sameDirectory(lstatSync(quarantine)!, expected)) {
    // Do not restore by rename: that could replace a newly-created empty directory.
    throw new Error(`sim world path changed during removal; preserved at ${quarantine}`);
  }
  beforeRemovalForTesting?.(quarantine);
  if (!sameDirectory(lstatSync(quarantine)!, expected)) {
    throw new Error(`sim world quarantine changed before removal; preserved at ${quarantine}`);
  }
  // configuredWorldsDir rejects non-private parents, so other OS users cannot
  // replace this unpredictable quarantine path between the identity check and rm.
  rmSync(quarantine, { recursive: true, force: false });
}

/** Create one isolated world directory without replacing or adopting existing files. */
export function createSimWorld(id: string, options: SimWorldOptions = {}): SimWorld {
  validateWorldId(id);
  const worldsDir = configuredWorldsDir(options, true)!;
  const rootDir = worldPath(worldsDir, id);

  // mkdir without recursive is the exclusive reservation: a duplicate id never reuses
  // or clears another world's state, including an empty pre-existing directory.
  mkdirSync(rootDir, { mode: 0o700 });
  const rootIdentity = lstatSync(rootDir);
  if (!rootIdentity.isDirectory() || (rootIdentity.mode & 0o777) !== 0o700 || readdirSync(rootDir).length > 0) {
    throw new Error(`sim world reservation changed before initialization; preserved: ${rootDir}`);
  }
  const assertReservation = (): void => {
    let current: NonNullable<ReturnType<typeof lstatSync>>;
    try { current = lstatSync(rootDir); }
    catch { throw new Error(`sim world path changed during creation: ${rootDir}`); }
    if (!sameDirectory(current, rootIdentity) || (current.mode & 0o777) !== 0o700) {
      throw new Error(`sim world path changed during creation: ${rootDir}`);
    }
  };
  try {
    // Capture the reservation identity before any test hook or other callback can
    // replace the path. Recheck it before every path-based initialization write.
    options.afterCreateReservationForTesting?.(rootDir);
    assertReservation();
    for (const name of ['state', 'config', 'fixtures', 'tmp']) {
      assertReservation();
      mkdirSync(join(rootDir, name), { mode: 0o700 });
      options.afterWorldDirectoryForTesting?.(rootDir, name);
      assertReservation();
    }
    const createdAt = (options.now ?? (() => new Date()))().toISOString();
    assertReservation();
    writeFileSync(manifestPath(rootDir), `${JSON.stringify({ format: WORLD_FORMAT, id, createdAt }, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    assertReservation();
    return readWorld(rootDir, id);
  } catch (error) {
    // Clean up only the directory whose identity this call captured. If the
    // world path was replaced, preserve it and let the caller see the failure.
    try {
      if (sameDirectory(lstatSync(rootDir), rootIdentity)) removeOwnedDirectory(rootDir, rootIdentity);
    } catch { /* preserve the original initialization error */ }
    throw error;
  }
}

/** List complete worlds only; incomplete or unrelated folders are not adopted. */
export function listSimWorlds(options: SimWorldOptions = {}): SimWorld[] {
  const worldsDir = configuredWorldsDir(options, false);
  if (!worldsDir) return [];
  const names = readdirSync(worldsDir);
  const worlds: SimWorld[] = [];
  for (const name of names.sort()) {
    if (!WORLD_ID.test(name)) continue;
    const rootDir = join(worldsDir, name);
    try {
      const rootInfo = lstatSync(rootDir);
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) continue;
      worlds.push(readWorld(rootDir, name));
    } catch { /* an unrelated or incomplete entry is not a world */ }
  }
  return worlds;
}

/** Destroy only a complete world created by this module, never a link or arbitrary folder. */
export function destroySimWorld(id: string, options: SimWorldOptions = {}): boolean {
  validateWorldId(id);
  const worldsDir = configuredWorldsDir(options, false);
  if (!worldsDir) return false;
  const rootDir = worldPath(worldsDir, id);
  let rootInfo;
  try { rootInfo = lstatSync(rootDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`refusing to destroy non-directory sim world: ${rootDir}`);
  }

  const canonicalRootDir = realpathSync(rootDir);
  const child = relative(worldsDir, canonicalRootDir);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`refusing to destroy sim world outside its root: ${rootDir}`);
  }
  readWorld(canonicalRootDir, id); // Require our manifest and complete layout before removal.
  if (!sameDirectory(lstatSync(rootDir), rootInfo)) throw new Error(`sim world path changed before removal: ${rootDir}`);
  options.beforeDestroyRenameForTesting?.();
  removeOwnedDirectory(rootDir, rootInfo, options.beforeQuarantineRemovalForTesting);
  return true;
}
