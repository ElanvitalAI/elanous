import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppSourceSnapshotError, createAppSourceSnapshot, restoreAppSourceSnapshot } from '../nexus/apps/app-source-snapshot.js';
import { createObjectStore } from '../storage/object-store.js';
import { createFakeAppSourceWorld } from './fake-app-source-world.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function sourceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'app-source-fixture-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'app.yaml'), 'slug: notes\n');
  writeFileSync(join(root, 'src', 'index.ts'), 'export const version = 1;\n');
  return root;
}

describe('SIM-APP-SOURCE-SNAPSHOT', () => {
  test('captures source at the deployment key and restore pins the next build to that revision', () => {
    const world = createFakeAppSourceWorld();
    const source = sourceRoot();
    try {
      const snapshot = world.snapshot({ appSlug: 'notes', deploymentId: 'deploy-1', sourceRoot: source });
      expect(snapshot.objectKey).toBe(`apps/notes/source/deploy-1--${snapshot.fingerprint}`);
      expect(snapshot.files).toBe(2);
      writeFileSync(join(source, 'src', 'index.ts'), 'export const version = 2;\n');
      const restored = world.restore({ appSlug: 'notes', deploymentId: 'deploy-1', sourceRoot: source, expectedFingerprint: snapshot.fingerprint });
      expect(readFileSync(join(source, 'src', 'index.ts'), 'utf8')).toBe('export const version = 2;\n');
      expect(readFileSync(join(restored.nextBuildInput.sourcePath, 'src', 'index.ts'), 'utf8')).toBe('export const version = 1;\n');
      expect(restored.nextBuildInput.sourceRevisionId).toBe('deploy-1');
      expect(world.restore({ appSlug: 'notes', deploymentId: 'deploy-1', sourceRoot: source, expectedFingerprint: snapshot.fingerprint }).nextBuildInput.sourcePath)
        .toBe(restored.nextBuildInput.sourcePath);
      expect(world.records().map((entry) => entry.kind)).toEqual(['source-snapshot-created', 'source-snapshot-restored', 'source-snapshot-restored']);
    } finally { world.close(); }
  });

  test('rejects a build fingerprint mismatch without changing source and records the reason', () => {
    const world = createFakeAppSourceWorld();
    const source = sourceRoot();
    try {
      world.snapshot({ appSlug: 'notes', deploymentId: 'deploy-2', sourceRoot: source });
      writeFileSync(join(source, 'src', 'index.ts'), 'keep this source');
      expect(() => world.restore({ appSlug: 'notes', deploymentId: 'deploy-2', sourceRoot: source, expectedFingerprint: 'f'.repeat(64) }))
        .toThrow('build and source');
      expect(readFileSync(join(source, 'src', 'index.ts'), 'utf8')).toBe('keep this source');
      expect(world.records().at(-1)).toMatchObject({ kind: 'source-snapshot-rejected', reason: 'source-mismatch' });
    } finally { world.close(); }
  });

  test('fails closed on missing and corrupt snapshots before touching the restore target', () => {
    const world = createFakeAppSourceWorld();
    const missing = sourceRoot();
    const corrupt = sourceRoot();
    try {
      expect(() => world.restore({ appSlug: 'notes', deploymentId: 'absent', sourceRoot: missing, expectedFingerprint: 'a'.repeat(64) }))
        .toThrow(AppSourceSnapshotError);
      const snapshot = world.snapshot({ appSlug: 'notes', deploymentId: 'deploy-3', sourceRoot: corrupt });
      world.tamper(snapshot.objectKey, '{broken');
      writeFileSync(join(corrupt, 'src', 'index.ts'), 'unchanged');
      expect(() => world.restore({ appSlug: 'notes', deploymentId: 'deploy-3', sourceRoot: corrupt, expectedFingerprint: snapshot.fingerprint }))
        .toThrow('unreadable or corrupt');
      expect(readFileSync(join(corrupt, 'src', 'index.ts'), 'utf8')).toBe('unchanged');
      expect(world.records().at(-1)).toMatchObject({ kind: 'source-snapshot-rejected', reason: 'corrupt' });
    } finally { world.close(); }
  });

  test('blocks secret-bearing sources before writing an object or exposing the value in errors', () => {
    const world = createFakeAppSourceWorld();
    const source = sourceRoot();
    const secret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    try {
      writeFileSync(join(source, 'src', 'leak.ts'), `const key = '${secret}';`);
      let error: unknown;
      try { world.snapshot({ appSlug: 'notes', deploymentId: 'deploy-4', sourceRoot: source }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(AppSourceSnapshotError);
      expect((error as Error).message).not.toContain(secret);
      expect(world.read('apps/notes/source/deploy-4')).toBeUndefined();
    } finally { world.close(); }
  });

  test('stores different source revisions under immutable fingerprinted keys for one deployment', () => {
    const world = createFakeAppSourceWorld();
    const source = sourceRoot();
    try {
      const first = world.snapshot({ appSlug: 'notes', deploymentId: 'deploy-5', sourceRoot: source });
      writeFileSync(join(source, 'src', 'index.ts'), 'different source');
      const second = world.snapshot({ appSlug: 'notes', deploymentId: 'deploy-5', sourceRoot: source });
      expect(second.objectKey).not.toBe(first.objectKey);
      expect(world.read(first.objectKey)).toContain(first.fingerprint);
      expect(world.read(second.objectKey)).toContain(second.fingerprint);
      expect(world.records()).toHaveLength(2);
    } finally { world.close(); }
  });

  test('concurrent requests for different source contents preserve both fingerprinted deployment revisions', async () => {
    const world = createFakeAppSourceWorld();
    const firstSource = sourceRoot();
    const secondSource = sourceRoot();
    writeFileSync(join(firstSource, 'src', 'index.ts'), 'revision one');
    writeFileSync(join(secondSource, 'src', 'index.ts'), 'revision two');
    try {
      const [first, second] = await Promise.all([
        Promise.resolve().then(() => world.snapshot({ appSlug: 'notes', deploymentId: 'deploy-race', sourceRoot: firstSource })),
        Promise.resolve().then(() => world.snapshot({ appSlug: 'notes', deploymentId: 'deploy-race', sourceRoot: secondSource })),
      ]);
      expect(first.fingerprint).not.toBe(second.fingerprint);
      expect(first.objectKey).not.toBe(second.objectKey);
      const restoredFirst = world.restore({ appSlug: 'notes', deploymentId: 'deploy-race', sourceRoot: firstSource, expectedFingerprint: first.fingerprint });
      const restoredSecond = world.restore({ appSlug: 'notes', deploymentId: 'deploy-race', sourceRoot: secondSource, expectedFingerprint: second.fingerprint });
      expect(readFileSync(join(restoredFirst.nextBuildInput.sourcePath, 'src', 'index.ts'), 'utf8')).toBe('revision one');
      expect(readFileSync(join(restoredSecond.nextBuildInput.sourcePath, 'src', 'index.ts'), 'utf8')).toBe('revision two');
    } finally { world.close(); }
  });

  test('separate Bun processes racing on one deployment preserve both immutable source objects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'app-source-process-race-'));
    roots.push(root);
    const firstSource = sourceRoot();
    const secondSource = sourceRoot();
    writeFileSync(join(firstSource, 'src', 'index.ts'), 'process revision one');
    writeFileSync(join(secondSource, 'src', 'index.ts'), 'process revision two');
    const readyOne = join(root, 'ready-one');
    const readyTwo = join(root, 'ready-two');
    const start = join(root, 'start');
    const outputOne = join(root, 'result-one.json');
    const outputTwo = join(root, 'result-two.json');
    const worker = fileURLToPath(new URL('./fake-app-source-concurrent-writer.ts', import.meta.url));
    const launch = (source: string, ready: string, output: string) => {
      const child = spawn(process.execPath, [worker, root, source, 'deploy-process-race', ready, start, output], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr += String(chunk); });
      const done = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`snapshot worker exited ${code}: ${stderr}`)));
      });
      return { child, done };
    };
    const first = launch(firstSource, readyOne, outputOne);
    const second = launch(secondSource, readyTwo, outputTwo);
    try {
      for (let attempt = 0; attempt < 500 && !(existsSync(readyOne) && existsSync(readyTwo)); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(existsSync(readyOne) && existsSync(readyTwo)).toBe(true);
      writeFileSync(start, 'go');
      await Promise.all([first.done, second.done]);

      const firstSnapshot = JSON.parse(readFileSync(outputOne, 'utf8')) as { fingerprint: string; objectKey: string };
      const secondSnapshot = JSON.parse(readFileSync(outputTwo, 'utf8')) as { fingerprint: string; objectKey: string };
      expect(firstSnapshot.fingerprint).not.toBe(secondSnapshot.fingerprint);
      expect(firstSnapshot.objectKey).not.toBe(secondSnapshot.objectKey);
      const store = createObjectStore({ provider: 'local', localDir: join(root, 'objects'), bucket: '', publicBucket: '', prefix: 'apps' });
      const restoredOne = restoreAppSourceSnapshot({ appSlug: 'notes', deploymentId: 'deploy-process-race', sourceRoot: firstSource,
        expectedFingerprint: firstSnapshot.fingerprint, objectStore: store, record() {} });
      const restoredTwo = restoreAppSourceSnapshot({ appSlug: 'notes', deploymentId: 'deploy-process-race', sourceRoot: secondSource,
        expectedFingerprint: secondSnapshot.fingerprint, objectStore: store, record() {} });
      expect(readFileSync(join(restoredOne.nextBuildInput.sourcePath, 'src', 'index.ts'), 'utf8')).toBe('process revision one');
      expect(readFileSync(join(restoredTwo.nextBuildInput.sourcePath, 'src', 'index.ts'), 'utf8')).toBe('process revision two');
    } finally {
      if (first.child.exitCode === null) first.child.kill();
      if (second.child.exitCode === null) second.child.kill();
    }
  });

  test('reads legacy deployment-key snapshots while preserving the old key contract', () => {
    const world = createFakeAppSourceWorld();
    const source = sourceRoot();
    try {
      const current = world.snapshot({ appSlug: 'notes', deploymentId: 'deploy-legacy', sourceRoot: source });
      world.seed('apps/notes/source/deploy-legacy', world.read(current.objectKey)!);
      world.remove(current.objectKey);
      const restored = world.restore({ appSlug: 'notes', deploymentId: 'deploy-legacy', sourceRoot: source, expectedFingerprint: current.fingerprint });
      expect(readFileSync(join(restored.nextBuildInput.sourcePath, 'src', 'index.ts'), 'utf8')).toBe('export const version = 1;\n');
    } finally { world.close(); }
  });

  test('reads the earlier fingerprint-child key layout when the current content key is absent', () => {
    const world = createFakeAppSourceWorld();
    const source = sourceRoot();
    try {
      const current = world.snapshot({ appSlug: 'notes', deploymentId: 'deploy-nested', sourceRoot: source });
      world.seed(`apps/notes/source/deploy-nested/${current.fingerprint}`, world.read(current.objectKey)!);
      world.remove(current.objectKey);
      const restored = world.restore({ appSlug: 'notes', deploymentId: 'deploy-nested', sourceRoot: source, expectedFingerprint: current.fingerprint });
      expect(readFileSync(join(restored.nextBuildInput.sourcePath, 'src', 'index.ts'), 'utf8')).toBe('export const version = 1;\n');
    } finally { world.close(); }
  });

  test('skips a stale legacy deployment object when the requested prior fingerprint child exists', () => {
    const staleSource = sourceRoot();
    const expectedSource = sourceRoot();
    const objects = new Map<string, string>();
    const objectStore = {
      put(key: string, body: string) { objects.set(key, body); },
      head(key: string) { return { exists: objects.has(key) }; },
      get(key: string, destination: string) {
        const body = objects.get(key);
        if (body === undefined) throw new Error('object not found');
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, body);
      },
      list(prefix: string) { return [...objects.keys()].filter(key => key.startsWith(prefix)); },
    };
    const record = () => {};
    try {
      writeFileSync(join(staleSource, 'src', 'index.ts'), 'stale revision');
      const stale = createAppSourceSnapshot({ appSlug: 'notes', deploymentId: 'deploy-mixed-legacy', sourceRoot: staleSource, objectStore, record });
      const expected = createAppSourceSnapshot({ appSlug: 'notes', deploymentId: 'deploy-mixed-legacy', sourceRoot: expectedSource, objectStore, record });
      objects.set('apps/notes/source/deploy-mixed-legacy', objects.get(stale.objectKey)!);
      objects.set(`apps/notes/source/deploy-mixed-legacy/${expected.fingerprint}`, objects.get(expected.objectKey)!);
      objects.delete(stale.objectKey);
      objects.delete(expected.objectKey);

      const restored = restoreAppSourceSnapshot({ appSlug: 'notes', deploymentId: 'deploy-mixed-legacy', sourceRoot: expectedSource,
        expectedFingerprint: expected.fingerprint, objectStore, record });
      expect(readFileSync(join(restored.nextBuildInput.sourcePath, 'src', 'index.ts'), 'utf8')).toBe('export const version = 1;\n');
      expect(restored.fingerprint).toBe(expected.fingerprint);
    } finally { rmSync(staleSource, { recursive: true, force: true }); rmSync(expectedSource, { recursive: true, force: true }); }
  });

  test('restores into an immutable build revision and leaves current source intact if ledger append fails', () => {
    const world = createFakeAppSourceWorld();
    const source = sourceRoot();
    try {
      const snapshot = world.snapshot({ appSlug: 'notes', deploymentId: 'deploy-6', sourceRoot: source });
      writeFileSync(join(source, 'src', 'index.ts'), 'live source remains active');
      expect(() => restoreAppSourceSnapshot({
        appSlug: 'notes', deploymentId: 'deploy-6', sourceRoot: source, expectedFingerprint: snapshot.fingerprint,
        objectStore: { put() { throw new Error('unused'); }, head() { return { exists: true }; }, list() { return [snapshot.objectKey]; }, get(key, path) {
          const body = world.read(key);
          if (body === undefined) throw new Error('missing');
          writeFileSync(path, body);
        } }, record() { throw new Error('ledger unavailable'); },
      })).toThrow('ledger record failed');
      expect(readFileSync(join(source, 'src', 'index.ts'), 'utf8')).toBe('live source remains active');
      const retried = world.restore({ appSlug: 'notes', deploymentId: 'deploy-6', sourceRoot: source, expectedFingerprint: snapshot.fingerprint });
      expect(readFileSync(join(retried.nextBuildInput.sourcePath, 'src', 'index.ts'), 'utf8')).toBe('export const version = 1;\n');
    } finally { world.close(); }
  });

  test('rejects a symlink at any revision path component before writing outside the source root', () => {
    const world = createFakeAppSourceWorld();
    const source = sourceRoot();
    const outside = mkdtempSync(join(tmpdir(), 'app-source-outside-'));
    roots.push(outside);
    try {
      const snapshot = world.snapshot({ appSlug: 'notes', deploymentId: 'deploy-link', sourceRoot: source });
      symlinkSync(outside, join(source, '.app-source-revisions'));
      expect(() => world.restore({ appSlug: 'notes', deploymentId: 'deploy-link', sourceRoot: source, expectedFingerprint: snapshot.fingerprint }))
        .toThrow('symbolic link');
      expect(existsSync(join(outside, 'notes', 'deploy-link', snapshot.fingerprint, 'src', 'index.ts'))).toBe(false);
    } finally { world.close(); }
  });

  test('keeps excluded working directories in the active source tree while the build revision omits them', () => {
    const world = createFakeAppSourceWorld();
    const source = sourceRoot();
    try {
      mkdirSync(join(source, '.git'), { recursive: true });
      mkdirSync(join(source, 'node_modules', 'kept'), { recursive: true });
      writeFileSync(join(source, '.git', 'HEAD'), 'ref: refs/heads/main');
      writeFileSync(join(source, 'node_modules', 'kept', 'marker.txt'), 'preserve');
      const snapshot = world.snapshot({ appSlug: 'notes', deploymentId: 'deploy-7', sourceRoot: source });
      const restored = world.restore({ appSlug: 'notes', deploymentId: 'deploy-7', sourceRoot: source, expectedFingerprint: snapshot.fingerprint });
      expect(readFileSync(join(source, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main');
      expect(readFileSync(join(source, 'node_modules', 'kept', 'marker.txt'), 'utf8')).toBe('preserve');
      expect(() => readFileSync(join(restored.nextBuildInput.sourcePath, 'node_modules', 'kept', 'marker.txt'))).toThrow();
    } finally { world.close(); }
  });
});
