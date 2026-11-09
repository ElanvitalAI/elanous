import { expect, test } from 'bun:test';
import { constants as fsConstants, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAppHost } from '../../ux-sim/fake-app-host.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from '../api/event-bus.js';
import { startNexusHttpServer } from '../api/http-server.js';
import { loadNexusAppHost } from './app-host.js';
import { createMemberStore } from '../members/member-store.js';
import { FakeAppDbBackupStore } from '../../ux-sim/fake-app-db-backup-world.js';

const manifest = `apiVersion: elanous.app/v0
slug: voice-note
title: Voice notes
frontend:
  kind: static-export
  out: out
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
roles:
  owner: { via: nexus-session }
  viewer: { via: share-link }
rpc:
  list:
    sql: SELECT id, title FROM notes ORDER BY id
    params: {}
    allow: [owner, viewer]
  add:
    sql: INSERT INTO notes (id, title) VALUES (:id, :title)
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
actions:
  transcribe:
    builtin: stt
    input: { audio: object-ref }
    output: { text: text }
    uses: [cred:openai.api_key]
`;

function writeApp(appsDir: string, body: string, appManifest = manifest): string {
  const appDir = join(appsDir, 'voice-note');
  const outDir = join(appDir, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(appDir, 'app.yaml'), appManifest);
  writeFileSync(join(outDir, 'index.html'), body);
  return outDir;
}

const APP_AUTH_KEY = 'nexus-app-host-test-signing-key-with-at-least-256-bits';

async function appRequest(appHost: ReturnType<typeof loadNexusAppHost>['appHost'], path = '/', method = 'GET', cookie?: string): Promise<Response> {
  return (await appHost.handle(new Request(`http://nexus.invalid${path}`, {
    method,
    headers: { host: 'voice-note.app.localhost', ...(cookie ? { cookie } : {}) },
  })))!;
}

function appAuthOptions(root: string, now = () => Date.UTC(2026, 0, 1)) {
  return { dir: join(root, 'auth-tokens'), databaseDirectory: join(root, 'databases'), key: APP_AUTH_KEY, now };
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

  const first = loadNexusAppHost(root, undefined, appAuthOptions(root));
  let second: ReturnType<typeof loadNexusAppHost> | undefined;
  expect(first.issues).toEqual([]);
  expect(first.appHost.slugs).toEqual(['voice-note']);
  expect((await appRequest(first.appHost)).status).toBe(401);
  expect(first.appHost.getManifest('voice-note')?.actions).toEqual({
    transcribe: {
      builtin: 'stt',
      input: { audio: 'object-ref' },
      output: { text: 'text' },
      uses: ['cred:openai.api_key'],
    },
  });
  const state = createNexusState({ nexusVersion: 'test', phase: 'app-host-fs-harden' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const server = startNexusHttpServer({
    state, eventBus, registry: new TabRegistry(state), startPort: 45000 + Math.floor(Math.random() * 1000),
    portRange: 20, appHost: first.appHost, metaApi: { bearerToken: 'owner-auth', noAuth: false },
  });
  try {
    const deniedIssue = await fetch(`${server.url}/v1/nexus/apps/voice-note/invitations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invitedBy: 'owner-1' }),
    });
    expect(deniedIssue.status).toBe(401);
    const issue = await fetch(`${server.url}/v1/nexus/apps/voice-note/invitations`, {
      method: 'POST', headers: { authorization: 'Bearer owner-auth', 'content-type': 'application/json' },
      body: JSON.stringify({ invitedBy: 'owner-1' }),
    });
    expect(issue.status).toBe(201);
    const issueBody = await issue.json() as { invitation: { token: string } };
    const accepted = await fetch(`${server.url}/__auth/accept?token=${encodeURIComponent(issueBody.invitation.token)}`, {
      headers: { host: `voice-note.app.localhost:${server.port}` }, redirect: 'manual',
    });
    expect(accepted.status).toBe(303);
    const cookie = accepted.headers.get('set-cookie')!.split(';', 1)[0]!;
    const app = await fetch(`${server.url}/`, { headers: { host: `voice-note.app.localhost:${server.port}`, cookie: `theme=dark; ${cookie}` } });
    expect(app.status).toBe(200);
    expect(await app.text()).toContain('version one');
    expect(app.headers.get('x-nexus-app-origin')).toBe(`http://voice-note.app.localhost:${server.port}`);

    const list = await fetch(`${server.url}/__rpc/list`, {
      method: 'POST', headers: { host: `voice-note.app.localhost:${server.port}`, origin: `http://voice-note.app.localhost:${server.port}`, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ params: {} }),
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ rows: [] });
    const forbidden = await fetch(`${server.url}/__rpc/add`, {
      method: 'POST', headers: { host: `voice-note.app.localhost:${server.port}`, origin: `http://voice-note.app.localhost:${server.port}`, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ params: { id: '1', title: 'no' }, role: 'owner' }),
    });
    expect(forbidden.status).toBe(400); // A client cannot override the authenticated share-link role.
    const ownerOnly = await fetch(`${server.url}/__rpc/add`, {
      method: 'POST', headers: { host: `voice-note.app.localhost:${server.port}`, origin: `http://voice-note.app.localhost:${server.port}`, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ params: { id: '1', title: 'no' } }),
    });
    expect(ownerOnly.status).toBe(403);
    const unauthenticatedRpc = await fetch(`${server.url}/__rpc/list`, {
      method: 'POST', headers: { host: `voice-note.app.localhost:${server.port}`, origin: `http://voice-note.app.localhost:${server.port}`, 'content-type': 'application/json' }, body: JSON.stringify({ params: {} }),
    });
    expect(unauthenticatedRpc.status).toBe(401);
    const crossOrigin = await fetch(`${server.url}/__rpc/list`, {
      method: 'POST', headers: { host: `voice-note.app.localhost:${server.port}`, origin: 'http://attacker.invalid', cookie, 'content-type': 'application/json' }, body: JSON.stringify({ params: {} }),
    });
    expect(crossOrigin.status).toBe(403);
    const nonJson = await fetch(`${server.url}/__rpc/list`, {
      method: 'POST', headers: { host: `voice-note.app.localhost:${server.port}`, origin: `http://voice-note.app.localhost:${server.port}`, cookie, 'content-type': 'text/plain' }, body: '{"params":{}}',
    });
    expect(nonJson.status).toBe(415);
    const tooLarge = await fetch(`${server.url}/__rpc/list`, {
      method: 'POST', headers: { host: `voice-note.app.localhost:${server.port}`, origin: `http://voice-note.app.localhost:${server.port}`, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ params: { title: 'x'.repeat(65 * 1024) } }),
    });
    expect(tooLarge.status).toBe(413);
    const oversizedBytes = new TextEncoder().encode(JSON.stringify({ params: { title: 'x'.repeat(65 * 1024) } }));
    const streamingRequest = new Request('http://nexus.invalid/__rpc/list', {
      method: 'POST',
      headers: { host: `voice-note.app.localhost:${server.port}`, origin: `http://voice-note.app.localhost:${server.port}`, cookie, 'content-type': 'application/json' },
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(oversizedBytes.slice(0, 32 * 1024)); controller.enqueue(oversizedBytes.slice(32 * 1024)); controller.close(); },
      }),
    });
    expect(streamingRequest.headers.get('content-length')).toBeNull();
    expect((await first.appHost.handle(streamingRequest))?.status).toBe(413);
    const undeclaredRole = await fetch(`${server.url}/v1/nexus/apps/voice-note/invitations`, {
      method: 'POST', headers: { authorization: 'Bearer owner-auth', 'content-type': 'application/json' },
      body: JSON.stringify({ invitedBy: 'owner-1', role: 'admin' }),
    });
    expect(undeclaredRole.status).toBe(400);

    const ownerInviteResponse = await fetch(`${server.url}/v1/nexus/apps/voice-note/invitations`, {
      method: 'POST', headers: { authorization: 'Bearer owner-auth', 'content-type': 'application/json' },
      body: JSON.stringify({ invitedBy: 'owner-1', role: 'owner' }),
    });
    expect(ownerInviteResponse.status).toBe(400);
    expect(() => first.appHost.issueInvitation('voice-note', 'owner-1', undefined, 'owner'))
      .toThrow('app role is not available through a share-link invitation');
    const viewerList = await fetch(`${server.url}/__rpc/list`, {
      method: 'POST', headers: { host: `voice-note.app.localhost:${server.port}`, origin: `http://voice-note.app.localhost:${server.port}`, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ params: {} }),
    });
    expect(await viewerList.json()).toEqual({ rows: [] });

    const appApi = await fetch(`${server.url}/v1/health`, { headers: { host: `voice-note.app.localhost:${server.port}`, cookie } });
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
    expect(await (await fetch(`${server.url}/`, { headers: { host: `voice-note.app.localhost:${server.port}`, cookie } })).text())
      .toContain('version one');
    second = loadNexusAppHost(root, undefined, appAuthOptions(root));
    expect(second.issues).toEqual([]);
    expect(await (await appRequest(second.appHost, '/', 'GET', `theme=dark; ${cookie}`)).text()).toContain('version two');
  } finally {
    server.stop();
    first.appHost.close();
    second?.appHost.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('public-read RPC remains anonymous with an unrelated cookie', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-app-host-public-read-cookie-'));
  const appDir = join(root, 'public-note');
  mkdirSync(join(appDir, 'out'), { recursive: true });
  writeFileSync(join(appDir, 'app.yaml'), `apiVersion: elanous.app/v0
slug: public-note
title: Public note
frontend:
  kind: static-export
  out: out
tables:
  notes:
    columns:
      id: { type: text, primary: true }
roles:
  public: { via: public-read }
rpc:
  list:
    sql: SELECT id FROM notes ORDER BY id
    params: {}
    allow: [public]
`);
  writeFileSync(join(appDir, 'out', 'index.html'), '<main>public</main>');
  const loaded = loadNexusAppHost(root, undefined, appAuthOptions(root));
  try {
    expect(loaded.issues).toEqual([]);
    const response = await loaded.appHost.handle(new Request('http://public-note.app.localhost/__rpc/list', {
      method: 'POST', headers: { host: 'public-note.app.localhost', origin: 'http://public-note.app.localhost',
        cookie: 'unrelated=1', 'content-type': 'application/json' }, body: JSON.stringify({ params: {} }),
    }));
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ rows: [] });
  } finally {
    loaded.appHost.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('app host can mount a newly published app without restarting and wires its database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-app-host-dynamic-mount-'));
  const appsDir = join(root, 'apps');
  mkdirSync(appsDir, { recursive: true });
  const { appHost, issues } = loadNexusAppHost(appsDir, undefined, appAuthOptions(root));
  try {
    expect(issues).toEqual([]);
    expect(appHost.slugs).toEqual([]);
    const appDir = join(appsDir, 'new-app');
    mkdirSync(join(appDir, 'out'), { recursive: true });
    writeFileSync(join(appDir, 'app.yaml'), manifest.replace('voice-note', 'new-app'));
    writeFileSync(join(appDir, 'out', 'index.html'), '<main>new app</main>');
    appHost.mountDirectory('new-app');
    expect(appHost.slugs).toEqual(['new-app']);
    expect(appHost.getManifest('new-app')?.slug).toBe('new-app');
    const response = await appHost.handle(new Request('http://new-app.app.localhost/', {
      headers: { host: 'new-app.app.localhost' },
    }));
    expect(response?.status).toBe(401);
    const invitation = appHost.issueInvitation('new-app', 'test-owner', undefined, 'viewer');
    const accepted = await appHost.handle(new Request(`http://new-app.app.localhost/__auth/accept?token=${encodeURIComponent(invitation.token)}`, {
      headers: { host: 'new-app.app.localhost' },
    }));
    const cookie = accepted?.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookie).toContain('__Host-app-session=');
    const rpc = await appHost.handle(new Request('http://new-app.app.localhost/__rpc/list', {
      method: 'POST', headers: { host: 'new-app.app.localhost', origin: 'http://new-app.app.localhost', cookie: cookie!, 'content-type': 'application/json' }, body: '{}',
    }));
    expect(rpc?.status).toBe(200);
    expect(await rpc?.json()).toEqual({ rows: [] });
    expect(() => appHost.mountDirectory('new-app')).toThrow('app is already mounted');
  } finally {
    appHost.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('NEXUS-APP-DB-RPC-WIRE preserves invitations for legacy manifests without viewer roles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-app-host-legacy-role-'));
  const appDir = join(root, 'legacy');
  mkdirSync(join(appDir, 'out'), { recursive: true });
  writeFileSync(join(appDir, 'app.yaml'), `apiVersion: elanous.app/v0\nslug: legacy\ntitle: Legacy\nfrontend: { kind: static-export, out: out }\nroles: { owner: { via: nexus-session } }\n`);
  writeFileSync(join(appDir, 'out', 'index.html'), '<main>legacy</main>');
  const blockedDbPath = join(root, 'blocked-db-path');
  writeFileSync(blockedDbPath, 'static app must not initialize SQLite');
  const { appHost, issues } = loadNexusAppHost(root, undefined, { ...appAuthOptions(root), databaseDirectory: blockedDbPath });
  try {
    expect(issues).toEqual([]);
    const invite = appHost.issueInvitation('legacy', 'owner-1');
    expect(invite.role).toBe('viewer');
    expect(() => appHost.issueInvitation('legacy', 'owner-1', undefined, 'admin')).toThrow('app role is not declared');
    const accepted = await appHost.handle(new Request(`http://nexus.invalid/__auth/accept?token=${encodeURIComponent(invite.token)}`, {
      headers: { host: 'legacy.app.localhost' },
    }));
    expect(accepted?.status).toBe(303);
  } finally {
    appHost.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('NEXUS-APP-DB-RPC-WIRE rechecks session expiry after a slow RPC body', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-app-host-rpc-expiry-'));
  writeApp(root, '<main>notes</main>', manifest.replace('allow: [owner]', 'allow: [viewer]'));
  let now = Date.UTC(2026, 0, 1);
  const { appHost } = loadNexusAppHost(root, undefined, appAuthOptions(root, () => now));
  try {
    const invitation = appHost.issueInvitation('voice-note', 'owner-1');
    const accepted = await appHost.handle(new Request(`http://nexus.invalid/__auth/accept?token=${encodeURIComponent(invitation.token)}`, {
      headers: { host: 'voice-note.app.localhost' },
    }));
    const cookie = accepted!.headers.get('set-cookie')!.split(';', 1)[0]!;
    const bytes = new TextEncoder().encode(JSON.stringify({ params: { id: 'slow', title: 'must not execute' } }));
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 12));
        setTimeout(() => { now += 60 * 60_000 + 1; controller.enqueue(bytes.slice(12)); controller.close(); }, 10);
      },
    });
    const response = await appHost.handle(new Request('http://nexus.invalid/__rpc/add', {
      method: 'POST', headers: { host: 'voice-note.app.localhost', origin: 'http://voice-note.app.localhost', cookie, 'content-type': 'application/json' }, body: slowBody,
    }));
    expect(response?.status).toBe(401);

    const freshInvitation = appHost.issueInvitation('voice-note', 'owner-1');
    const freshAccepted = await appHost.handle(new Request(`http://nexus.invalid/__auth/accept?token=${encodeURIComponent(freshInvitation.token)}`, {
      headers: { host: 'voice-note.app.localhost' },
    }));
    const freshCookie = freshAccepted!.headers.get('set-cookie')!.split(';', 1)[0]!;
    const rows = await appHost.handle(new Request('http://nexus.invalid/__rpc/list', {
      method: 'POST', headers: { host: 'voice-note.app.localhost', origin: 'http://voice-note.app.localhost', cookie: freshCookie, 'content-type': 'application/json' }, body: JSON.stringify({ params: {} }),
    }));
    expect(await rows!.json()).toEqual({ rows: [] });
  } finally {
    appHost.close();
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
      Promise.resolve().then(() => loadNexusAppHost(root, undefined, appAuthOptions(root))),
      Promise.resolve().then(() => loadNexusAppHost(root, undefined, appAuthOptions(root))),
    ]);
    expect(results.map(result => result.appHost.slugs)).toEqual([['voice-note'], ['voice-note']]);
    const invite = results[0]!.appHost.issueInvitation('voice-note', 'owner-1');
    const accepted = await appRequest(results[0]!.appHost, `/__auth/accept?token=${encodeURIComponent(invite.token)}`);
    const cookie = accepted.headers.get('set-cookie')!.split(';', 1)[0]!;
    expect(await (await appRequest(results[0]!.appHost, '/%252e%252e/private.html', 'GET', cookie)).text()).toBe('Not Found');
    expect((await appRequest(results[1]!.appHost, '/', 'POST', cookie)).status).toBe(405);
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

test('NEXUS-APP-HOST exposes backup health and isolated restore to trusted server callers', () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-app-host-backup-'));
  writeApp(root, '<main>backup</main>');
  const store = new FakeAppDbBackupStore();
  const loaded = loadNexusAppHost(root, undefined, {
    ...appAuthOptions(root),
    databaseBackup: { store, key: new Uint8Array(32).fill(17), schedule: false },
  });
  const target = join(root, 'restore', 'voice-note.db');
  try {
    expect(loaded.appHost.databaseBackupStatus('voice-note')?.state).toBe('healthy');
    expect(loaded.appHost.restoreDatabaseBackup('voice-note', target).targetEnvironment).toBe('isolated-restore');
    expect(existsSync(target)).toBe(true);
  } finally { loaded.appHost.close(); rmSync(root, { recursive: true, force: true }); }
});

test('verified owner resolves identity and entitlement only from the app session and member database', () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-verified-owner-'));
  const members = createMemberStore({ path: ':memory:' });
  writeApp(root, '<main>owner</main>');
  const member = members.register({ sub: 'verified-sub', email: 'verified@example.test', emailVerified: true, name: 'Verified' }, {
    consents: { privacy: 'rev-1', terms: 'rev-1' },
  });
  const loaded = loadNexusAppHost(root, undefined, appAuthOptions(root));
  const owner = loaded.appHost.issueOwnerSession('voice-note', member.id);
  try {
    expect(loaded.appHost.resolveVerifiedOwner('voice-note', owner.sessionToken, members, 'public-owner')).toEqual({
      memberId: member.id, userSlug: 'public-owner', plan: 'free', entitlements: {},
    });
    expect(loaded.appHost.resolveVerifiedOwner('other-app', owner.sessionToken, members, 'public-owner')).toBeNull();
    expect(loaded.appHost.resolveVerifiedOwner('voice-note', owner.sessionToken, members, '')).toBeNull();
  } finally {
    members.close(); loaded.appHost.close(); rmSync(root, { recursive: true, force: true });
  }
});
