import { expect, test } from 'bun:test';
import { constants as fsConstants, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAppHost } from '../../ux-sim/fake-app-host.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from '../api/event-bus.js';
import { startNexusHttpServer } from '../api/http-server.js';
import { loadNexusAppHost } from './app-host.js';

const manifest = `apiVersion: elanous.app/v0
slug: voice-note
title: Voice notes
frontend:
  kind: static-export
  out: out
`;

function writeApp(appsDir: string, body: string): string {
  const appDir = join(appsDir, 'voice-note');
  const outDir = join(appDir, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(appDir, 'app.yaml'), manifest);
  writeFileSync(join(outDir, 'index.html'), body);
  return outDir;
}

function appRequest(appHost: ReturnType<typeof loadNexusAppHost>['appHost'], path = '/', method = 'GET'): Response {
  return appHost.handle(new Request(`http://nexus.invalid${path}`, {
    method,
    headers: { host: 'voice-note.app.localhost' },
  }))!;
}

test('NEXUS-APP-HOST-FS-HARDEN mounts an immutable snapshot on an isolated app origin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-app-host-snapshot-'));
  const outDir = writeApp(root, '<main>version one</main>');
  const simulatedApps = createFakeAppHost([{
    slug: 'voice-note', current: 'v1', versions: [
      { id: 'v1', files: { '/index.html': '<main>version one</main>' } },
      { id: 'v2', files: { '/index.html': '<main>version two</main>' } },
    ],
  }]);

  const first = loadNexusAppHost(root);
  expect(first.issues).toEqual([]);
  expect(first.appHost.slugs).toEqual(['voice-note']);
  const state = createNexusState({ nexusVersion: 'test', phase: 'app-host-fs-harden' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const server = startNexusHttpServer({
    state, eventBus, registry: new TabRegistry(state), startPort: 45000 + Math.floor(Math.random() * 1000),
    portRange: 20, appHost: first.appHost,
  });
  try {
    const app = await fetch(`${server.url}/`, { headers: { host: `voice-note.app.localhost:${server.port}` } });
    expect(app.status).toBe(200);
    expect(await app.text()).toContain('version one');
    expect(app.headers.get('x-nexus-app-origin')).toBe(`http://voice-note.app.localhost:${server.port}`);

    const appApi = await fetch(`${server.url}/v1/health`, { headers: { host: `voice-note.app.localhost:${server.port}` } });
    expect(appApi.status).toBe(404);
    const pwaRoot = await fetch(`${server.url}/`, { redirect: 'manual' });
    expect(pwaRoot.status).toBe(302);
    expect(pwaRoot.headers.get('location')).toBe('/app/');

    // The simulation device changes the active deployment while the first mount serves its
    // captured snapshot. A later mount sees v2; the live mount never reopens mutable paths.
    simulatedApps.deploy('voice-note', 'v2');
    const simulatedV2 = simulatedApps.fetch('voice-note.app.sim.invalid', '/index.html');
    expect(simulatedV2.status).toBe(200);
    writeFileSync(join(outDir, 'index.html'), simulatedV2.body);
    expect(await (await fetch(`${server.url}/`, { headers: { host: `voice-note.app.localhost:${server.port}` } })).text())
      .toContain('version one');
    const second = loadNexusAppHost(root);
    expect(second.issues).toEqual([]);
    expect(await appRequest(second.appHost).text()).toContain('version two');
  } finally {
    server.stop();
    first.appHost.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('NEXUS-APP-HOST-FS-HARDEN rejects symlink swaps, nested links, and hardlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-app-host-race-'));
  const outDir = writeApp(root, '<main>safe</main>');
  const outside = join(root, 'private.html');
  writeFileSync(outside, '<main>must never escape</main>');
  let swapped = false;
  let nonBlockingOpen = false;
  const canonicalIndex = join(realpathSync(outDir), 'index.html');
  try {
    const raced = loadNexusAppHost(root, {
      beforeOpen(path, flags) {
        nonBlockingOpen ||= Boolean(fsConstants.O_NONBLOCK && (flags & fsConstants.O_NONBLOCK));
        if (swapped || path !== canonicalIndex) return;
        swapped = true;
        const original = join(outDir, 'index.original.html');
        renameSync(path, original);
        symlinkSync(outside, path);
      },
    });
    expect(swapped).toBe(true);
    expect(nonBlockingOpen).toBe(true);
    expect(raced.appHost.slugs).toEqual([]);
    expect(raced.issues).toHaveLength(1);
    expect(raced.issues[0]?.reason).toMatch(/changed|symbolic|linked/i);

    // A stable but explicitly linked export is rejected as well.
    rmSync(join(outDir, 'index.html'), { force: true });
    symlinkSync(outside, join(outDir, 'index.html'));
    const linked = loadNexusAppHost(root);
    expect(linked.appHost.slugs).toEqual([]);
    expect(linked.issues[0]?.reason).toMatch(/symbolic|linked/i);

    rmSync(join(outDir, 'index.html'), { force: true });
    linkSync(outside, join(outDir, 'index.html'));
    const hardlinked = loadNexusAppHost(root);
    expect(hardlinked.appHost.slugs).toEqual([]);
    expect(hardlinked.issues[0]?.reason).toMatch(/linked/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('NEXUS-APP-HOST-FS-HARDEN keeps same-event-loop mounts complete and rejects traversal paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-app-host-serial-'));
  writeApp(root, '<main>stable</main>');
  try {
    const results = await Promise.all([
      Promise.resolve().then(() => loadNexusAppHost(root)),
      Promise.resolve().then(() => loadNexusAppHost(root)),
    ]);
    expect(results.map(result => result.appHost.slugs)).toEqual([['voice-note'], ['voice-note']]);
    expect(await appRequest(results[0]!.appHost, '/%252e%252e/private.html').text()).toBe('Not Found');
    expect(appRequest(results[1]!.appHost, '/', 'POST').status).toBe(405);
    results.forEach(result => result.appHost.close());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('NEXUS-APP-HOST-FS-HARDEN detects a version changed and restored mid-mount', () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-app-host-mixed-'));
  const outDir = writeApp(root, '<main>version one</main>');
  const laterFile = join(outDir, 'later.txt');
  writeFileSync(laterFile, 'later');
  const simulatedApps = createFakeAppHost([{
    slug: 'voice-note', current: 'v1', versions: [
      { id: 'v1', files: { '/index.html': '<main>version one</main>' } },
      { id: 'v2', files: { '/index.html': '<main>version two</main>' } },
    ],
  }]);
  let deployed = false;
  try {
    const result = loadNexusAppHost(root, {
      beforeOpen(path) {
        if (deployed || path !== realpathSync(laterFile)) return;
        deployed = true;
        simulatedApps.deploy('voice-note', 'v2');
        writeFileSync(join(outDir, 'index.html'), simulatedApps.fetch('voice-note.app.sim.invalid', '/index.html').body);
        simulatedApps.rollback('voice-note');
        writeFileSync(join(outDir, 'index.html'), simulatedApps.fetch('voice-note.app.sim.invalid', '/index.html').body);
      },
    });
    expect(deployed).toBe(true);
    expect(result.appHost.slugs).toEqual([]);
    expect(result.issues[0]?.reason).toContain('changed during snapshot');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('NEXUS-APP-HOST-FS-HARDEN rejects a mixed snapshot when a later file changes the earlier file version', () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-app-host-mixed-version-'));
  const outDir = writeApp(root, '<main>version one</main>');
  const laterFile = join(outDir, 'later.txt');
  writeFileSync(laterFile, 'later');
  const simulatedApps = createFakeAppHost([{
    slug: 'voice-note', current: 'v1', versions: [
      { id: 'v1', files: { '/index.html': '<main>version one</main>' } },
      { id: 'v2', files: { '/index.html': '<main>version two</main>' } },
    ],
  }]);
  let deployed = false;
  try {
    const result = loadNexusAppHost(root, {
      beforeOpen(path) {
        if (deployed || path !== realpathSync(laterFile)) return;
        deployed = true;
        simulatedApps.deploy('voice-note', 'v2');
        writeFileSync(join(outDir, 'index.html'), simulatedApps.fetch('voice-note.app.sim.invalid', '/index.html').body);
      },
    });
    expect(deployed).toBe(true);
    expect(result.appHost.slugs).toEqual([]);
    expect(result.issues[0]?.reason).toContain('changed during snapshot');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(platform() === 'win32')('NEXUS-APP-HOST-FS-HARDEN rejects a FIFO swapped in at the open boundary without blocking', () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-app-host-fifo-'));
  const outDir = writeApp(root, '<main>safe</main>');
  const canonicalIndex = join(realpathSync(outDir), 'index.html');
  let replacedWithFifo = false;
  try {
    const result = loadNexusAppHost(root, {
      openFile(path, flags, openReal) {
        if (path !== canonicalIndex) return openReal();
        expect(Boolean(fsConstants.O_NONBLOCK && (flags & fsConstants.O_NONBLOCK))).toBe(true);
        unlinkSync(path);
        execFileSync('mkfifo', [path]);
        replacedWithFifo = true;
        return openReal();
      },
    });
    expect(replacedWithFifo).toBe(true);
    expect(result.appHost.slugs).toEqual([]);
    expect(result.issues[0]?.reason).toMatch(/regular|changed|linked/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('NEXUS-APP-HOST-FS-HARDEN rejects a nested directory swap to an external export', () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-app-host-nested-race-'));
  const outDir = writeApp(root, '<main>safe</main>');
  const nestedDir = join(outDir, 'assets');
  const outsideDir = join(root, 'outside');
  mkdirSync(nestedDir);
  mkdirSync(outsideDir);
  writeFileSync(join(nestedDir, 'runtime.js'), 'safe');
  writeFileSync(join(outsideDir, 'runtime.js'), 'secret');
  const canonicalNested = realpathSync(nestedDir);
  const canonicalRuntime = join(canonicalNested, 'runtime.js');
  let swapped = false;
  try {
    const result = loadNexusAppHost(root, {
      beforeOpen(path) {
        if (swapped || path !== canonicalRuntime) return;
        swapped = true;
        renameSync(nestedDir, `${nestedDir}.original`);
        symlinkSync(outsideDir, nestedDir);
      },
    });
    expect(swapped).toBe(true);
    expect(result.appHost.slugs).toEqual([]);
    expect(result.issues[0]?.reason).toMatch(/changed|escapes/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
