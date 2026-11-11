import { expect, test } from 'bun:test';
import { constants as fsConstants, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import { createFakeAppHost } from '../../ux-sim/fake-app-host.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from '../api/event-bus.js';
import { startNexusHttpServer } from '../api/http-server.js';
import { loadNexusAppHost } from './app-host.js';
import { MADE_WITH_BADGE_ENTITLEMENT } from './made-with-badge.js';
import { createMemberStore } from '../members/member-store.js';
import { FakeAppDbBackupStore } from '../../ux-sim/fake-app-db-backup-world.js';
import type { SimReceipt } from '../../ux-sim/sim-receipt.js';

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

test('app host applies the made-with attribution only with a passing concept proof', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-app-host-made-with-badge-'));
  const outDir = writeApp(root, '<html><body><footer data-elanous-made-with-badge="true"><footer data-elanous-made-with-badge="true">old</footer></footer><main>hello</main><plaintext>plain tail </body></plaintext></html>');
  writeFileSync(join(outDir, 'template.html'), '<html><body><main>template</main><template><template><div></body></div></template></template><plaintext>template tail</plaintext></html>');
  writeFileSync(join(outDir, 'textarea.html'), '<html><body><main>start</main><textarea>unterminated </body>');
  writeFileSync(join(outDir, 'comparison.html'), '<html><body><p>1 < 2 <textarea><footer data-elanous-made-with-badge="true">user example</footer></textarea></p></body></html>');
  writeFileSync(join(outDir, 'legacy.html'), Buffer.from('<html><head><meta charset="x-app-legacy"></head><body>caf\u00e9</body></html>', 'latin1'));
  writeFileSync(join(outDir, 'comment-charset.html'), '<html><head><!-- <meta charset="windows-1252"> --><script>const example = "<meta charset=windows-1252>";</script></head><body>😃</body></html>');
  writeFileSync(join(outDir, 'attribute-charset.html'), '<html><head><meta name=example value="charset=windows-1252"></head><body>😃</body></html>');
  writeFileSync(join(outDir, 'utf8-bom.html'), Buffer.concat([Buffer.from('efbbbf', 'hex'), Buffer.from('<html><head><meta charset="windows-1252"></head><body>😃</body></html>')]));
  writeFileSync(join(outDir, 'utf16.html'), iconv.encode('\uFEFF<html><body><main>utf16 app</main><footer data-elanous-made-with-badge="true">old</footer></body></html>', 'utf-16le'));
  writeFileSync(join(outDir, 'utf16-no-bom.html'), iconv.encode('<html><head><meta charset="utf-16le"></head><body>utf16 no bom</body></html>', 'utf-16le'));
  writeFileSync(join(outDir, 'utf16-leading-space.html'), iconv.encode(' \n<html><head><meta charset="utf-16le"></head><body>utf16 leading space</body></html>', 'utf-16le'));
  writeFileSync(join(outDir, 'utf16be.html'), iconv.encode('\uFEFF<html><body>utf16be app</body></html>', 'utf-16le').swap16());
  writeFileSync(join(outDir, 'utf16be-leading-space.html'), iconv.encode(' \n<html><head><meta charset="utf-16be"></head><body>utf16be leading space</body></html>', 'utf-16le').swap16());
  writeFileSync(join(outDir, 'utf16-prefix.html'), iconv.encode('hello<html><head><meta charset="utf-16le"></head><body>utf16 prefix</body></html>', 'utf-16le'));
  writeFileSync(join(outDir, 'utf16be-prefix.html'), iconv.encode('hello<html><head><meta charset="utf-16be"></head><body>utf16be prefix</body></html>', 'utf-16le').swap16());
  writeFileSync(join(outDir, 'invalid-utf8.html'), Buffer.concat([
    Buffer.from('<html><body><main>invalid '), Buffer.from('\u00ff', 'latin1'),
    Buffer.from('</main><footer data-elanous-made-with-badge="true">old</footer></body></html>'),
  ]));
  writeFileSync(join(outDir, 'invalid-declared-utf8.html'), Buffer.concat([
    Buffer.from('<html><head><meta charset="utf-8"></head><body><main>invalid '), Buffer.from('\u00ff', 'latin1'),
    Buffer.from('</main><footer data-elanous-made-with-badge="true">old</footer></body></html>'),
  ]));
  try {
    const loaded = loadNexusAppHost(root, undefined, appAuthOptions(root));
    const proof = { schema: 'elanous.sim-receipt.v1', appSimulationReceiptId: 'receipt-proof', appSimulationRunId: 'run-proof',
      appId: 'voice-note', appFingerprint: 'a'.repeat(64), deviceCatalogVersion: 1,
      requiredScenarios: [{ id: 'happy-path', outcome: 'passed' as const }], sandboxEstablished: true,
      externalNetworkAttempts: 0, blockedNetworkAttempts: 0, unmeasuredCount: 0,
      eventLedgerPath: 'app-simulation.sqlite#run-proof', createdAt: '2026-11-10T08:00:00.000Z',
      verdict: 'passed' as const, reasons: [], receiptFingerprint: 'b'.repeat(64) } satisfies SimReceipt;
    loaded.appHost.setConceptProofResolver(() => proof);
    const invitation = loaded.appHost.issueInvitation('voice-note', 'test');
    const accepted = (await loaded.appHost.handle(new Request(
      `http://voice-note.app.localhost/__auth/accept?token=${encodeURIComponent(invitation.token)}`,
      { headers: { host: 'voice-note.app.localhost' } },
    )))!;
    const cookie = accepted.headers.get('set-cookie')!.split(';', 1)[0]!;
    const fetchPage = async (path: string): Promise<Response> => (await loaded.appHost.handle(new Request(`http://voice-note.app.localhost${path}`, {
      headers: { host: 'voice-note.app.localhost', cookie },
    })))!;

    const response = await fetchPage('/');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<main>hello</main>');
    expect(body).toContain('<plaintext>plain tail </body></plaintext></html>');
    expect(body.indexOf('class="elanous-made-with-badge"')).toBeLessThan(body.indexOf('<plaintext>'));
    expect(body.match(/<footer[^>]*class="elanous-made-with-badge"/g)).toHaveLength(1);

    const templateBody = await (await fetchPage('/template.html')).text();
    expect(templateBody.indexOf('class="elanous-made-with-badge"')).toBeGreaterThan(templateBody.lastIndexOf('</template>'));
    expect(templateBody.indexOf('class="elanous-made-with-badge"')).toBeLessThan(templateBody.indexOf('<plaintext>'));
    expect(templateBody).toContain('<template><template><div></body></div></template></template>');

    const textareaBody = await (await fetchPage('/textarea.html')).text();
    expect(textareaBody.indexOf('class="elanous-made-with-badge"')).toBeLessThan(textareaBody.indexOf('<textarea>'));
    expect(textareaBody).toContain('<textarea>unterminated </body>');

    const comparisonBody = await (await fetchPage('/comparison.html')).text();
    expect(comparisonBody).toContain('<p>1 < 2 <textarea><footer data-elanous-made-with-badge="true">user example</footer></textarea></p>');
    expect(comparisonBody.match(/<footer[^>]*class="elanous-made-with-badge"/g)).toHaveLength(1);

    const legacyResponse = await fetchPage('/legacy.html');
    expect(legacyResponse.headers.get('content-type')).toContain('charset=x-app-legacy');
    const legacyHtml = Buffer.from(await legacyResponse.arrayBuffer()).toString('latin1');
    expect(legacyHtml).toMatch(/<body>caf\u00e9</);
    expect(legacyHtml).toContain('made with elanous');

    const commentCharsetResponse = await fetchPage('/comment-charset.html');
    expect(commentCharsetResponse.headers.get('content-type')).toContain('charset=utf-8');
    expect(await commentCharsetResponse.text()).toContain('<body>😃<footer');

    const attributeCharset = await (await fetchPage('/attribute-charset.html')).text();
    expect(attributeCharset).toContain('<body>😃<footer');
    const utf8BomResponse = await fetchPage('/utf8-bom.html');
    expect(utf8BomResponse.headers.get('content-type')).toContain('charset=utf-8');
    const utf8BomBytes = Buffer.from(await utf8BomResponse.arrayBuffer());
    expect(utf8BomBytes.toString('hex').startsWith('efbbbf')).toBe(true);
    expect(new TextDecoder('utf-8').decode(utf8BomBytes)).toContain('<body>😃<footer');

    const utf16Response = await fetchPage('/utf16.html');
    expect(utf16Response.headers.get('content-type')).toContain('charset=utf-16le');
    const utf16Bytes = Buffer.from(await utf16Response.arrayBuffer());
    expect(utf16Bytes.toString('hex').startsWith('fffe')).toBe(true);
    const utf16Html = new TextDecoder('utf-16le').decode(utf16Bytes);
    expect(utf16Html).toContain('<main>utf16 app</main>');
    expect(utf16Html.match(/<footer[^>]*class="elanous-made-with-badge"/g)).toHaveLength(1);
    const utf16NoBomResponse = await fetchPage('/utf16-no-bom.html');
    expect(utf16NoBomResponse.headers.get('content-type')).toContain('charset=utf-16le');
    expect(new TextDecoder('utf-16le').decode(await utf16NoBomResponse.arrayBuffer())).toContain('utf16 no bom');
    const utf16beResponse = await fetchPage('/utf16be.html');
    expect(utf16beResponse.headers.get('content-type')).toContain('charset=utf-16be');
    const utf16beBytes = Buffer.from(await utf16beResponse.arrayBuffer());
    expect(utf16beBytes.toString('hex').startsWith('feff')).toBe(true);
    expect(new TextDecoder('utf-16be').decode(utf16beBytes)).toContain('utf16be app');
    const utf16LeadingSpace = await fetchPage('/utf16-leading-space.html');
    expect(utf16LeadingSpace.headers.get('content-type')).toContain('charset=utf-16le');
    expect(new TextDecoder('utf-16le').decode(await utf16LeadingSpace.arrayBuffer())).toContain('utf16 leading space');
    const utf16beLeadingSpace = await fetchPage('/utf16be-leading-space.html');
    expect(utf16beLeadingSpace.headers.get('content-type')).toContain('charset=utf-16be');
    expect(new TextDecoder('utf-16be').decode(await utf16beLeadingSpace.arrayBuffer())).toContain('utf16be leading space');
    const utf16Prefix = await fetchPage('/utf16-prefix.html');
    expect(utf16Prefix.headers.get('content-type')).toContain('charset=utf-16le');
    expect(new TextDecoder('utf-16le').decode(await utf16Prefix.arrayBuffer())).toContain('utf16 prefix');
    const utf16bePrefix = await fetchPage('/utf16be-prefix.html');
    expect(utf16bePrefix.headers.get('content-type')).toContain('charset=utf-16be');
    expect(new TextDecoder('utf-16be').decode(await utf16bePrefix.arrayBuffer())).toContain('utf16be prefix');

    const invalidUtf8Response = await fetchPage('/invalid-utf8.html');
    expect(invalidUtf8Response.headers.get('content-type')).toContain('charset=windows-1252');
    const invalidUtf8Html = Buffer.from(await invalidUtf8Response.arrayBuffer()).toString('latin1');
    expect(invalidUtf8Html).toContain('<main>invalid \u00ff</main>');
    expect(invalidUtf8Html.match(/<footer[^>]*class="elanous-made-with-badge"/g)).toHaveLength(1);
    const invalidDeclaredUtf8Response = await fetchPage('/invalid-declared-utf8.html');
    expect(invalidDeclaredUtf8Response.headers.get('content-type')).toContain('charset=utf-8');
    const invalidDeclaredUtf8Html = Buffer.from(await invalidDeclaredUtf8Response.arrayBuffer()).toString('latin1');
    expect(invalidDeclaredUtf8Html).toContain('<main>invalid \u00ff</main>');
    expect(invalidDeclaredUtf8Html.match(/<footer[^>]*class="elanous-made-with-badge"/g)).toHaveLength(1);

    loaded.appHost.unmountDirectory('voice-note');
    // Source: 내부 문서 `nexus-revenue-and-market` §2⑤ — managed plan entitlement removes attribution.
    loaded.appHost.mountDirectory('voice-note', { [MADE_WITH_BADGE_ENTITLEMENT]: 0 });
    const managedInvitation = loaded.appHost.issueInvitation('voice-note', 'test');
    const managedAccepted = (await loaded.appHost.handle(new Request(
      `http://voice-note.app.localhost/__auth/accept?token=${encodeURIComponent(managedInvitation.token)}`,
      { headers: { host: 'voice-note.app.localhost' } },
    )))!;
    const managedCookie = managedAccepted.headers.get('set-cookie')!.split(';', 1)[0]!;
    const managedBody = await (await loaded.appHost.handle(new Request('http://voice-note.app.localhost/', {
      headers: { host: 'voice-note.app.localhost', cookie: managedCookie },
    })))!.text();
    expect(managedBody).toContain('<main>hello</main>');
    expect(managedBody).not.toContain('made-with-badge');
    expect(managedBody).not.toContain('made with elanous');
    const managedUtf16 = (await loaded.appHost.handle(new Request('http://voice-note.app.localhost/utf16.html', {
      headers: { host: 'voice-note.app.localhost', cookie: managedCookie },
    })))!;
    const managedUtf16Html = new TextDecoder('utf-16le').decode(await managedUtf16!.arrayBuffer());
    expect(managedUtf16Html).toContain('<main>utf16 app</main>');
    expect(managedUtf16Html).not.toContain('made-with-badge');
    expect(managedUtf16Html).not.toContain('old');
    const managedInvalidUtf8 = await loaded.appHost.handle(new Request('http://voice-note.app.localhost/invalid-utf8.html', {
      headers: { host: 'voice-note.app.localhost', cookie: managedCookie },
    }));
    const managedInvalidUtf8Html = Buffer.from(await managedInvalidUtf8!.arrayBuffer()).toString('latin1');
    expect(managedInvalidUtf8Html).toContain('<main>invalid \u00ff</main>');
    expect(managedInvalidUtf8Html).not.toContain('made-with-badge');
    expect(managedInvalidUtf8Html).not.toContain('old');
    const managedDeclaredInvalidUtf8 = await loaded.appHost.handle(new Request('http://voice-note.app.localhost/invalid-declared-utf8.html', {
      headers: { host: 'voice-note.app.localhost', cookie: managedCookie },
    }));
    const managedDeclaredInvalidHtml = Buffer.from(await managedDeclaredInvalidUtf8!.arrayBuffer()).toString('latin1');
    expect(managedDeclaredInvalidHtml).toContain('<main>invalid \u00ff</main>');
    expect(managedDeclaredInvalidHtml).not.toContain('made-with-badge');
    expect(managedDeclaredInvalidHtml).not.toContain('old');
    const managedUnknownCharset = await loaded.appHost.handle(new Request('http://voice-note.app.localhost/legacy.html', {
      headers: { host: 'voice-note.app.localhost', cookie: managedCookie },
    }));
    const managedUnknownCharsetHtml = Buffer.from(await managedUnknownCharset!.arrayBuffer()).toString('latin1');
    expect(managedUnknownCharsetHtml).toContain('<body>caf\u00e9</body>');
    expect(managedUnknownCharsetHtml).not.toContain('made-with-badge');
    loaded.appHost.close();

    writeFileSync(join(root, '.elanous-app-host-state', 'voice-note.json.tmp-interrupted'), '{"badgeDisabled":');
    const restarted = loadNexusAppHost(root, undefined, appAuthOptions(root));
    const restartedInvitation = restarted.appHost.issueInvitation('voice-note', 'test');
    const restartedAccepted = (await restarted.appHost.handle(new Request(
      `http://voice-note.app.localhost/__auth/accept?token=${encodeURIComponent(restartedInvitation.token)}`,
      { headers: { host: 'voice-note.app.localhost' } },
    )))!;
    const restartedCookie = restartedAccepted.headers.get('set-cookie')!.split(';', 1)[0]!;
    const restartedBody = await (await restarted.appHost.handle(new Request('http://voice-note.app.localhost/', {
      headers: { host: 'voice-note.app.localhost', cookie: restartedCookie },
    })))!.text();
    expect(restartedBody).toContain('<main>hello</main>');
    expect(restartedBody).not.toContain('made-with-badge');
    expect(restartedBody).not.toContain('made with elanous');
    restarted.appHost.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('app host serves the made-with badge bound to the persisted passing simulation proof', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-app-host-sim-receipt-'));
  writeApp(root, '<html><body><textarea><footer data-elanous-made-with-badge="true">user example</footer></textarea><main>proof-backed app</main></body></html>');
  const loaded = loadNexusAppHost(root, undefined, appAuthOptions(root));
  try {
    const proof = {
      schema: 'elanous.sim-receipt.v1', appSimulationReceiptId: 'receipt-1', appSimulationRunId: 'run-1',
      appId: 'voice-note', appFingerprint: 'a'.repeat(64), deviceCatalogVersion: 1,
      requiredScenarios: [{ id: 'happy-path', outcome: 'passed' }], sandboxEstablished: true,
      externalNetworkAttempts: 0, blockedNetworkAttempts: 0, unmeasuredCount: 0,
      eventLedgerPath: 'app-simulation.sqlite#run-1', createdAt: '2026-11-10T08:00:00.000Z',
      verdict: 'passed', reasons: [], receiptFingerprint: 'b'.repeat(64),
    } as SimReceipt;
    loaded.appHost.setConceptProofResolver(() => proof);
    const invitation = loaded.appHost.issueInvitation('voice-note', 'test');
    const accepted = (await loaded.appHost.handle(new Request(
      `http://voice-note.app.localhost/__auth/accept?token=${encodeURIComponent(invitation.token)}`,
      { headers: { host: 'voice-note.app.localhost' } },
    )))!;
    const cookie = accepted.headers.get('set-cookie')!.split(';', 1)[0]!;
    const response = await appRequest(loaded.appHost, '/', 'GET', cookie);
    const html = await response.text();
    expect(html).toContain('data-elanous-made-with-badge="true"');
    expect(html).toContain(`data-sim-receipt-fingerprint="${proof.receiptFingerprint}"`);
    expect(html).toContain('<textarea><footer data-elanous-made-with-badge="true">user example</footer></textarea>');
    expect(html.match(/data-sim-receipt-fingerprint=/g)).toHaveLength(1);

    loaded.appHost.setConceptProofResolver(() => undefined);
    const withoutProof = await (await appRequest(loaded.appHost, '/', 'GET', cookie)).text();
    expect(withoutProof).not.toContain('data-sim-receipt-fingerprint=');
    expect(withoutProof).not.toContain('made with elanous');
  } finally { loaded.appHost.close(); rmSync(root, { recursive: true, force: true }); }
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
    // Source: src/nexus/members/member-store.test.ts — the current free-plan catalog includes relay.connect.
    expect(loaded.appHost.resolveVerifiedOwner('voice-note', owner.sessionToken, members, 'public-owner')).toEqual({
      memberId: member.id, userSlug: 'public-owner', plan: 'free', entitlements: { 'relay.connect': true },
    });
    expect(loaded.appHost.resolveVerifiedOwner('other-app', owner.sessionToken, members, 'public-owner')).toBeNull();
    expect(loaded.appHost.resolveVerifiedOwner('voice-note', owner.sessionToken, members, '')).toBeNull();
    expect(loaded.appHost.resolveVerifiedMemberOwner(owner.sessionToken, members, 'public-owner')?.memberId).toBe(member.id);
    expect(loaded.appHost.resolveVerifiedMemberOwner('aps_invalid', members, 'public-owner')).toBeNull();
  } finally {
    members.close(); loaded.appHost.close(); rmSync(root, { recursive: true, force: true });
  }
});
