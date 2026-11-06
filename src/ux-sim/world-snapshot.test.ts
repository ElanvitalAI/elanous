import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { createSimWorld, listSimWorlds } from './world-store.js';
import { forkSimWorld, restoreSimWorld, snapshotSimWorld } from './world-snapshot.js';

const roots: string[] = [];
let priorTestRoot: string | undefined;

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'sim-world-snapshot-'));
  roots.push(root);
  priorTestRoot = getTestStateRoot();
  setTestStateRoot(root);
  return join(root, 'sim', 'worlds');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  setTestStateRoot(priorTestRoot ?? null);
});

describe('sim world snapshots', () => {
  test('restores a checksummed format-1 world snapshot without changing world identity', () => {
    const worldsDir = setup();
    const world = createSimWorld('baseline', { worldsDir });
    const worldManifestPath = join(world.rootDir, 'world.json');
    const devicePath = join(world.devicesDir, `${world.deviceModuleIds[0]}.json`);
    writeFileSync(join(world.stateDir, 'counter.json'), '{"value":1}\n', { mode: 0o600 });
    const snapshot = snapshotSimWorld(world.id, 'before-change', { worldsDir, now: () => new Date('2026-11-04T10:00:00.000Z') });
    writeFileSync(join(world.stateDir, 'counter.json'), '{"value":2}\n', { mode: 0o600 });
    writeFileSync(join(world.configDir, 'run.json'), '{"changed":true}\n', { mode: 0o600 });
    const currentManifest = JSON.parse(readFileSync(worldManifestPath, 'utf8')) as Record<string, unknown>;
    currentManifest.createdAt = '2026-11-04T11:00:00.000Z';
    writeFileSync(worldManifestPath, `${JSON.stringify(currentManifest, null, 2)}\n`, { mode: 0o600 });
    const currentDevice = JSON.parse(readFileSync(devicePath, 'utf8')) as Record<string, unknown>;
    currentDevice.preservedMarker = 'keep-current-device-metadata';
    writeFileSync(devicePath, `${JSON.stringify(currentDevice, null, 2)}\n`, { mode: 0o600 });
    const expectedManifest = readFileSync(worldManifestPath, 'utf8');
    const expectedDevice = readFileSync(devicePath, 'utf8');

    restoreSimWorld(world.id, snapshot.snapshotId, { worldsDir });

    expect(readFileSync(join(world.stateDir, 'counter.json'), 'utf8')).toBe('{"value":1}\n');
    expect(existsSync(join(world.configDir, 'run.json'))).toBe(false);
    expect(readFileSync(worldManifestPath, 'utf8')).toBe(expectedManifest);
    expect(readFileSync(devicePath, 'utf8')).toBe(expectedDevice);
    expect(listSimWorlds({ worldsDir })[0]?.createdAt).toBe('2026-11-04T11:00:00.000Z');
    expect(snapshot.entries.some(entry => entry.path === 'devices/MD-UX-SIM-FAKE-CLOCK-TS.json')).toBe(true);
  });

  test('rejects replacement, corrupt payloads, and symlinks without changing the world', () => {
    const worldsDir = setup();
    const world = createSimWorld('protected-world', { worldsDir });
    const external = join(roots[roots.length - 1]!, 'outside.txt');
    writeFileSync(external, 'external');
    writeFileSync(join(world.stateDir, 'keep.txt'), 'keep');
    const snapshot = snapshotSimWorld(world.id, 'protected', { worldsDir });

    expect(() => snapshotSimWorld(world.id, 'protected', { worldsDir })).toThrow();
    const payloadFile = join(world.rootDir, 'snapshots', snapshot.snapshotId, 'payload', 'state', 'keep.txt');
    writeFileSync(payloadFile, 'tampered');
    expect(() => restoreSimWorld(world.id, snapshot.snapshotId, { worldsDir })).toThrow('integrity check failed');
    expect(readFileSync(join(world.stateDir, 'keep.txt'), 'utf8')).toBe('keep');

    const linked = join(world.stateDir, 'external-link');
    symlinkSync(external, linked);
    expect(() => snapshotSimWorld(world.id, 'symlinked', { worldsDir })).toThrow('refuses symlink');
    expect(existsSync(join(world.rootDir, 'snapshots', 'symlinked'))).toBe(false);
    expect(readFileSync(external, 'utf8')).toBe('external');
  });

  test('preserves file and directory modes under a restrictive umask', () => {
    const worldsDir = setup();
    const world = createSimWorld('mode-preservation', { worldsDir });
    const nested = join(world.fixturesDir, 'public-fixture');
    const file = join(nested, 'sample.txt');
    mkdirSync(nested, { mode: 0o755 });
    chmodSync(nested, 0o755);
    writeFileSync(file, 'snapshot mode');
    chmodSync(file, 0o644);

    const previousUmask = process.umask(0o077);
    try {
      const snapshot = snapshotSimWorld(world.id, 'mode-check', { worldsDir });
      const payloadDir = join(world.rootDir, 'snapshots', snapshot.snapshotId, 'payload', 'fixtures', 'public-fixture');
      const payloadFile = join(payloadDir, 'sample.txt');
      expect(statSync(payloadDir).mode & 0o777).toBe(0o755);
      expect(statSync(payloadFile).mode & 0o777).toBe(0o644);

      writeFileSync(file, 'changed under restrictive umask');
      chmodSync(file, 0o600);
      chmodSync(nested, 0o700);
      restoreSimWorld(world.id, snapshot.snapshotId, { worldsDir });
      expect(readFileSync(file, 'utf8')).toBe('snapshot mode');
      expect(statSync(nested).mode & 0o777).toBe(0o755);
      expect(statSync(file).mode & 0o777).toBe(0o644);
    } finally {
      process.umask(previousUmask);
    }
  });

  test('rolls back every replaced state directory when a later install fails', () => {
    const worldsDir = setup();
    const world = createSimWorld('restore-rollback', { worldsDir });
    const dirs = ['config', 'fixtures', 'state', 'tmp'] as const;
    for (const name of dirs) writeFileSync(join(world.rootDir, name, 'value.txt'), `snapshot-${name}`);
    const snapshot = snapshotSimWorld(world.id, 'rollback', { worldsDir });
    for (const name of dirs) writeFileSync(join(world.rootDir, name, 'value.txt'), `current-${name}`);

    expect(() => restoreSimWorld(world.id, snapshot.snapshotId, {
      worldsDir,
      beforeRestoreInstallForTesting: (_name, index) => {
        if (index === 1) throw new Error('injected restore install failure');
      },
    })).toThrow('injected restore install failure');
    for (const name of dirs) expect(readFileSync(join(world.rootDir, name, 'value.txt'), 'utf8')).toBe(`current-${name}`);
  });

  test('forks a snapshot into an independent world with a fresh identity', () => {
    const worldsDir = setup();
    const source = createSimWorld('source-world', { worldsDir });
    writeFileSync(join(source.stateDir, 'result.json'), '{"side":"same"}\n', { mode: 0o600 });
    const unrelatedConfig = '{"world":"source-world","seed":0,"devices":[],"events":[]}\n';
    writeFileSync(join(source.configDir, 'world.yaml'), unrelatedConfig, { mode: 0o600 });
    const snapshot = snapshotSimWorld(source.id, 'fork-point', { worldsDir });

    const fork = forkSimWorld(source.id, snapshot.snapshotId, 'comparison-world', {
      worldsDir,
      now: () => new Date('2026-11-05T00:00:00.000Z'),
    });

    expect(readFileSync(join(fork.stateDir, 'result.json'), 'utf8')).toBe('{"side":"same"}\n');
    expect(readFileSync(join(fork.configDir, 'world.yaml'), 'utf8')).toBe(unrelatedConfig);
    expect(fork.id).toBe('comparison-world');
    expect(fork.createdAt).toBe('2026-11-05T00:00:00.000Z');
    expect(fork.deviceModuleIds).toEqual(source.deviceModuleIds);
    writeFileSync(join(fork.stateDir, 'result.json'), '{"side":"fork"}\n', { mode: 0o600 });
    expect(readFileSync(join(source.stateDir, 'result.json'), 'utf8')).toBe('{"side":"same"}\n');
    expect(listSimWorlds({ worldsDir }).map(world => world.id)).toEqual(['comparison-world', 'source-world']);
    expect(() => forkSimWorld(source.id, snapshot.snapshotId, 'comparison-world', { worldsDir })).toThrow('sim world already exists');
  });

  test('removes an incompletely forked world when installation fails', () => {
    const worldsDir = setup();
    const source = createSimWorld('source-for-failure', { worldsDir });
    const snapshot = snapshotSimWorld(source.id, 'failure-point', { worldsDir });

    expect(() => forkSimWorld(source.id, snapshot.snapshotId, 'failed-fork', {
      worldsDir,
      beforeForkInstallForTesting: (_name, index) => {
        if (index === 1) throw new Error('injected fork install failure');
      },
    })).toThrow('injected fork install failure');
    expect(listSimWorlds({ worldsDir }).map(world => world.id)).toEqual(['source-for-failure']);
    expect(existsSync(join(worldsDir, 'failed-fork'))).toBe(false);
  });

  test('requires an explicit test universe for snapshot operations', () => {
    const worldsDir = setup();
    const world = createSimWorld('isolated-only', { worldsDir });
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(null);
    expect(() => snapshotSimWorld(world.id, 'denied', { worldsDir })).toThrow('explicit --test universe');
    expect(() => restoreSimWorld(world.id, 'denied', { worldsDir })).toThrow('explicit --test universe');
    expect(() => forkSimWorld(world.id, 'denied', 'denied-fork', { worldsDir })).toThrow('explicit --test universe');
  });
});
