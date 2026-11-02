import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { assertSimWorldOwnership, createSimWorld, destroySimWorld, listSimWorlds } from './world-store.js';

const roots: string[] = [];
let priorTestRoot: string | undefined;

function worldsDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'sim-world-lifecycle-'));
  roots.push(root);
  priorTestRoot = getTestStateRoot();
  setTestStateRoot(root);
  const worlds = join(root, 'worlds');
  mkdirSync(worlds, { mode: 0o700 });
  return realpathSync(worlds);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  setTestStateRoot(priorTestRoot ?? null);
});

describe('sim world lifecycle', () => {
  test('refuses to access sim storage without an explicit isolated test universe', () => {
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(null);
    expect(() => createSimWorld('no-test-root')).toThrow('explicit --test universe');
    expect(() => listSimWorlds()).toThrow('explicit --test universe');
    expect(() => destroySimWorld('no-test-root')).toThrow('explicit --test universe');
  });

  test('creates a private world layout and lists it by its recorded identity', () => {
    const root = worldsDir();
    const world = createSimWorld('night-train-1', { worldsDir: root, now: () => new Date('2026-11-01T12:00:00.000Z') });

    expect(world).toEqual({
      id: 'night-train-1',
      rootDir: join(root, 'night-train-1'),
      stateDir: join(root, 'night-train-1', 'state'),
      configDir: join(root, 'night-train-1', 'config'),
      fixturesDir: join(root, 'night-train-1', 'fixtures'),
      tmpDir: join(root, 'night-train-1', 'tmp'),
      createdAt: '2026-11-01T12:00:00.000Z',
    });
    expect(lstatSync(world.rootDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(world.rootDir, 'world.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(world.rootDir, 'world.json'), 'utf8'))).toEqual({
      format: 1, id: 'night-train-1', createdAt: '2026-11-01T12:00:00.000Z',
    });
    expect(listSimWorlds({ worldsDir: root })).toEqual([world]);
  });

  test('rejects invalid ids and never adopts or overwrites an existing directory', () => {
    const root = worldsDir();
    expect(() => createSimWorld('../outside', { worldsDir: root })).toThrow('invalid sim world id');
    expect(() => createSimWorld('Uppercase', { worldsDir: root })).toThrow('invalid sim world id');

    mkdirSync(join(root, 'reserved'), { recursive: true });
    const sentinel = join(root, 'reserved', 'keep.txt');
    writeFileSync(sentinel, 'leave intact');
    expect(() => createSimWorld('reserved', { worldsDir: root })).toThrow();
    expect(readFileSync(sentinel, 'utf8')).toBe('leave intact');
    expect(() => destroySimWorld('reserved', { worldsDir: root })).toThrow();
    expect(readFileSync(sentinel, 'utf8')).toBe('leave intact');
  });

  test('destroys only the selected complete world and reports a missing world without side effects', () => {
    const root = worldsDir();
    const first = createSimWorld('first', { worldsDir: root });
    const second = createSimWorld('second', { worldsDir: root });
    writeFileSync(join(first.stateDir, 'ledger.json'), '{}');

    expect(destroySimWorld('first', { worldsDir: root })).toBe(true);
    expect(destroySimWorld('first', { worldsDir: root })).toBe(false);
    expect(listSimWorlds({ worldsDir: root })).toEqual([second]);
    expect(readFileSync(join(second.rootDir, 'world.json'), 'utf8')).toContain('"id": "second"');
  });

  test('ignores incomplete folders and refuses to destroy a symlinked world', () => {
    const root = worldsDir();
    mkdirSync(join(root, 'incomplete'), { mode: 0o700 });
    writeFileSync(join(root, 'incomplete', 'world.json'), JSON.stringify({
      format: 1, id: 'incomplete', createdAt: '2026-11-01T12:00:00.000Z',
    }), { mode: 0o600 });
    const target = createSimWorld('target', { worldsDir: root });
    symlinkSync(target.rootDir, join(root, 'linked'));

    expect(listSimWorlds({ worldsDir: root }).map(world => world.id)).toEqual(['target']);
    expect(() => destroySimWorld('incomplete', { worldsDir: root })).toThrow('layout is invalid');
    expect(() => destroySimWorld('linked', { worldsDir: root })).toThrow('refusing to destroy non-directory');
    expect(readFileSync(join(target.rootDir, 'world.json'), 'utf8')).toContain('"id": "target"');
  });

  test('refuses a symlinked manifest and preserves its external target', () => {
    const root = worldsDir();
    const outside = join(roots[roots.length - 1]!, 'outside');
    const unowned = join(root, 'unowned');
    const target = createSimWorld('target', { worldsDir: root });
    mkdirSync(outside);
    mkdirSync(unowned, { mode: 0o700 });
    for (const name of ['state', 'config', 'fixtures', 'tmp']) mkdirSync(join(unowned, name), { mode: 0o700 });
    symlinkSync(join(target.rootDir, 'world.json'), join(unowned, 'world.json'));
    writeFileSync(join(outside, 'sentinel'), 'must remain');

    expect(listSimWorlds({ worldsDir: root }).map(world => world.id)).toEqual(['target']);
    expect(() => destroySimWorld('unowned', { worldsDir: root })).toThrow('manifest must be an owned 0600 file');
    expect(readFileSync(join(target.rootDir, 'world.json'), 'utf8')).toContain('"id": "target"');
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('must remain');
  });

  test('keeps replacement directories intact during reservation, initialization, and destroy', () => {
    const root = worldsDir();
    const movedCreate = join(roots[roots.length - 1]!, 'moved-create');
    expect(() => createSimWorld('create-race', {
      worldsDir: root,
      afterCreateReservationForTesting: (rootDir) => {
        renameSync(rootDir, movedCreate);
        mkdirSync(rootDir, { mode: 0o700 });
      },
    })).toThrow('path changed during creation');
    expect(readdirSync(join(root, 'create-race'))).toEqual([]);
    expect(lstatSync(movedCreate).isDirectory()).toBe(true);

    const movedDuringInit = join(roots[roots.length - 1]!, 'moved-during-init');
    const duringInitSentinel = join(root, 'init-race', 'replacement-sentinel');
    expect(() => createSimWorld('init-race', {
      worldsDir: root,
      afterWorldDirectoryForTesting: (rootDir, name) => {
        if (name !== 'state') return;
        renameSync(rootDir, movedDuringInit);
        mkdirSync(rootDir, { mode: 0o700 });
        writeFileSync(duringInitSentinel, 'replacement survives');
      },
    })).toThrow('path changed during creation');
    expect(readFileSync(duringInitSentinel, 'utf8')).toBe('replacement survives');
    expect(existsSync(join(movedDuringInit, 'state'))).toBe(true);
    expect(existsSync(join(movedDuringInit, 'config'))).toBe(false);

    const world = createSimWorld('destroy-race', { worldsDir: root });
    const movedDestroy = join(roots[roots.length - 1]!, 'moved-destroy');
    const destroySentinel = join(world.rootDir, 'replacement-sentinel');
    let preserved = '';
    try { destroySimWorld('destroy-race', {
      worldsDir: root,
      beforeDestroyRenameForTesting: () => {
        renameSync(world.rootDir, movedDestroy);
        mkdirSync(world.rootDir, { mode: 0o700 });
        writeFileSync(destroySentinel, 'replacement survives');
      },
    }); } catch (error) { preserved = String(error); }
    const quarantinedReplacement = preserved.match(/preserved at (.+)$/)?.[1];
    expect(preserved).toContain('path changed during removal');
    expect(quarantinedReplacement).toBeTruthy();
    expect(readFileSync(join(quarantinedReplacement!, 'replacement-sentinel'), 'utf8')).toBe('replacement survives');
    expect(readFileSync(join(movedDestroy, 'world.json'), 'utf8')).toContain('"id": "destroy-race"');

    const beforeDelete = createSimWorld('quarantine-race', { worldsDir: root });
    const movedOriginal = join(roots[roots.length - 1]!, 'moved-quarantine-original');
    let quarantineError = '';
    try { destroySimWorld('quarantine-race', {
      worldsDir: root,
      beforeQuarantineRemovalForTesting: (quarantineDir) => {
        renameSync(quarantineDir, movedOriginal);
        mkdirSync(quarantineDir, { mode: 0o700 });
        writeFileSync(join(quarantineDir, 'replacement-sentinel'), 'quarantine replacement survives');
      },
    }); } catch (error) { quarantineError = String(error); }
    expect(quarantineError).toContain('quarantine changed before removal');
    const quarantinedPath = quarantineError.match(/preserved at (.+)$/)?.[1];
    expect(quarantinedPath).toBeTruthy();
    expect(readFileSync(join(quarantinedPath!, 'replacement-sentinel'), 'utf8')).toBe('quarantine replacement survives');
    expect(readFileSync(join(movedOriginal, 'world.json'), 'utf8')).toContain(`"id": "${beforeDelete.id}"`);
  });

  test('validates ids even when the world directory does not exist', () => {
    const base = mkdtempSync(join(tmpdir(), 'sim-world-missing-'));
    roots.push(base);
    const root = join(base, 'missing-worlds');
    expect(() => destroySimWorld('../escape', { worldsDir: root })).toThrow('invalid sim world id');
  });

  test('uses one canonical root when the configured worlds directory is a symlink', () => {
    const realWorldsDir = worldsDir();
    mkdirSync(realWorldsDir, { recursive: true });
    const alias = join(roots[roots.length - 1]!, 'worlds-alias');
    symlinkSync(realWorldsDir, alias, 'dir');
    const world = createSimWorld('through-alias', { worldsDir: alias });

    expect(world.rootDir).toBe(join(realWorldsDir, 'through-alias'));
    expect(listSimWorlds({ worldsDir: alias })).toEqual([world]);
    expect(destroySimWorld('through-alias', { worldsDir: alias })).toBe(true);
  });

  test('checks a physical symlink boundary before creating any worlds directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'sim-world-boundary-'));
    roots.push(base);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(base);
    const outside = mkdtempSync(join(tmpdir(), 'sim-world-outside-'));
    roots.push(outside);
    const escape = join(base, 'escape');
    symlinkSync(outside, escape, 'dir');
    const requested = join(escape, 'new-worlds');

    expect(() => createSimWorld('blocked', { worldsDir: requested })).toThrow('escaped the test universe');
    expect(existsSync(requested)).toBe(false);
    expect(existsSync(join(outside, 'new-worlds'))).toBe(false);
  });

  test('rechecks the physical parent before creating the worlds directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'sim-world-parent-race-'));
    roots.push(base);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(base);
    const outside = mkdtempSync(join(tmpdir(), 'sim-world-parent-outside-'));
    roots.push(outside);
    const parent = join(base, 'worlds-parent');
    const movedParent = join(base, 'moved-worlds-parent');
    mkdirSync(parent);
    const requested = join(parent, 'new-worlds');

    expect(() => createSimWorld('blocked-parent-race', {
      worldsDir: requested,
      beforeWorldsDirectoryCreateForTesting: (parentDir) => {
        renameSync(parentDir, movedParent);
        symlinkSync(outside, parentDir, 'dir');
      },
    })).toThrow('sim world storage escaped the test universe');

    expect(existsSync(join(outside, 'new-worlds'))).toBe(false);
    expect(lstatSync(movedParent).isDirectory()).toBe(true);
    expect(lstatSync(parent).isSymbolicLink()).toBe(true);
  });

  test('requires a private worlds directory before quarantine-based deletion', () => {
    const base = mkdtempSync(join(tmpdir(), 'sim-world-public-root-'));
    roots.push(base);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(base);
    const publicWorlds = join(base, 'public-worlds');
    mkdirSync(publicWorlds, { mode: 0o755 });

    expect(() => createSimWorld('blocked', { worldsDir: publicWorlds })).toThrow('private 0700 directory');
    expect(existsSync(join(publicWorlds, 'blocked'))).toBe(false);
  });

  test('ownership assertion binds the caller root to private permissions and matching metadata', () => {
    const root = worldsDir();
    const world = createSimWorld('owned', { worldsDir: root });
    expect(() => assertSimWorldOwnership({ id: world.id, rootDir: world.rootDir })).not.toThrow();
    expect(listSimWorlds({ worldsDir: root }).map(item => item.id)).toEqual(['owned']);

    writeFileSync(join(world.rootDir, 'world.json'), JSON.stringify({
      format: 1, id: 'different-world', createdAt: world.createdAt,
    }), { mode: 0o600 });
    expect(() => destroySimWorld(world.id, { worldsDir: root })).toThrow('manifest does not match');
    writeFileSync(join(world.rootDir, 'world.json'), JSON.stringify({
      format: 1, id: world.id, createdAt: world.createdAt,
    }), { mode: 0o600 });

    chmodSync(world.rootDir, 0o755);
    expect(() => destroySimWorld(world.id, { worldsDir: root })).toThrow('0700 directory');
    chmodSync(world.rootDir, 0o700);
  });

  test('ownership assertion rejects a matching-looking world outside the test state root', () => {
    const root = worldsDir();
    const outside = mkdtempSync(join(tmpdir(), 'sim-world-unowned-'));
    roots.push(outside);
    const worldRoot = join(outside, 'declared');
    mkdirSync(worldRoot, { mode: 0o700 });
    writeFileSync(join(worldRoot, 'world.json'), JSON.stringify({ format: 1, id: 'declared', createdAt: '2026-11-01T00:00:00.000Z' }), { mode: 0o600 });

    expect(() => assertSimWorldOwnership({ id: 'declared', rootDir: worldRoot })).toThrow('escaped the test universe');
  });

});
