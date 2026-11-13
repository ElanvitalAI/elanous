// Nexus wsBridgeOpts wiring: pass wsAuthVerifier only when bearerToken
// is present. Executes buildNexusWsBridgeAuth — the unit runNexus uses
// when assembling wsBridgeOpts (same shape as src/boot/acp-server.ts).

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { buildNexusWsBridgeAuth, daemonThinStage1, DAEMON_THIN_STAY_ALLOWLIST, runNexus, type DaemonThinStayAllowlistClass } from './index.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { ProjectStore } from '../project/project-store.js';
import { createSession } from '../session/index.js';
import { createMemberStore } from './members/member-store.js';
import { listAbsorbScraps } from '../intake-plane/items.js';
import { handleCreateTab } from './api/tabs-mutations.js';
import { startNexusHttpServer } from './api/http-server.js';
import { handleBoardRoute } from './api/board-api.js';
import { createRegistryBackend } from './webterm/pty.js';
import { createFakeStt } from '../ux-sim/fake-stt.js';
import { fakeElevenLabsAudioBytes, startFakeElevenLabs } from '../ux-sim/fake-elevenlabs.js';
import { appSecretId } from './config/secrets/app-secret-ledger.js';
import { deleteAppSecretValue, fileBackend, setAppSecretValue } from './config/secrets/file-backend.js';
import { setCredentialSlotAsync } from './config/secrets/cred-slots.js';
import type { StartOpts } from '../pty-shell/registry.js';
import { setTestStateRoot } from './paths.js';
import { __resetIdentityForTests, __setIdentityFileForTests } from '../mss/identity-store.js';
import type { NexusFunnelEvent } from './apps/funnel-observe.js';
import type { PwaShareDeps, PwaShareResult } from '../cli/pwa-share.js';
import type { ShareMountResult } from '../cli/share-auto-mount.js';

const CONFIGURED_TOKEN = 'configured-token-xxxxxxxxxxxxxxxxxxxx';

/** ⛔ 이 파일이 만든 임시 디렉토리를 걷는다 — 반복 실행에서 /tmp 가 샌다. */
const tempDirs: string[] = [];
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

test('NEXUS boot starts a webterm tab in the associated conversation project folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-webterm-project-'));
  const previous = process.env.ELANOUS_SESSION_ROOT;
  let nexus: Awaited<ReturnType<typeof runNexus>>;
  try {
    setElanousConfigDir(root);
    setTestStateRoot(root);
    process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    const folder = join(root, 'project');
    mkdirSync(folder);
    const project = new ProjectStore(root).create({ name: 'sample', primaryFolder: folder });
    const assigned = createSession({ projectId: project.id });
    const plain = createSession();
    const observed: StartOpts[] = [];
    nexus = await runNexus({ detachForTesting: true, skipHttpServer: true, skipRuntimeApi: true,
      skipSupervisor: true, mcpEnabled: false, skipRestoreFromPending: true, toolCwd: root,
      cleanGhostTailscaleServeFn: async () => {}, webtermSpawn: (opts) => createRegistryBackend(opts, {
        startPty: (spawn) => {
          observed.push(spawn);
          return { id: `pty-${observed.length}` } as ReturnType<typeof import('../pty-shell/registry.js').startPty>;
        },
        onPtyEvent: () => () => {},
      }),
    });
    if (!nexus) throw new Error('NEXUS failed to start');
    const supervisor = { startTab: async () => {} } as unknown as import('./supervisor/index.js').Supervisor;
    const create = async (id: string, sessionId: string, cwd?: string) => {
      const response = await handleCreateTab(new Request('http://localhost/v1/nexus/tabs', {
        method: 'POST', body: JSON.stringify({ kind: 'webterm', id, sessionId, kindOpts: cwd ? { cwd } : {} }),
      }), { state: nexus!.state, registry: nexus!.registry, supervisor });
      expect(response.status).toBe(201);
    };
    await create('webterm:project', assigned.id);
    await create('webterm:plain', plain.id);
    await create('webterm:explicit', assigned.id, root);
    expect(observed.map(spawn => spawn.workdir)).toEqual([folder, root, root]);
  } finally {
    nexus?.release();
    resetElanousConfigDir();
    setTestStateRoot(null);
    if (previous === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('APP-MADE-WITH-BADGE deploy wiring forwards verified owner entitlements to the app host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-app-deploy-badge-entitlement-'));
  const previousPublicUserId = process.env.ELANOUS_PUBLIC_APP_USER_ID;
  const previousGoogleRedirect = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  let nexus: Awaited<ReturnType<typeof runNexus>> | undefined;
  let ownerServer: ReturnType<typeof Bun.serve> | undefined;
  let httpOpts: import('./api/http-server.js').NexusHttpServerOpts | undefined;
  try {
    setElanousConfigDir(root);
    setTestStateRoot(root);
    process.env.ELANOUS_PUBLIC_APP_USER_ID = 'public-owner';
    delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
    const owner = {
      memberId: 'member-badge', userSlug: 'public-owner', plan: 'managed',
      // Source: 내부 문서 `nexus-revenue-and-market` §2⑤ — managed plans remove free attribution.
      entitlements: { 'nexus.app.attribution': 0 },
    };
    // Source: Bun.serve uses port 0 to bind an ephemeral local test endpoint.
    ownerServer = Bun.serve({ port: 0, fetch: () => Response.json(owner) });
    nexus = await runNexus({
      detachForTesting: true, skipHttpServer: false, skipRuntimeApi: true,
      skipSupervisor: true, mcpEnabled: false, skipEnvMigration: true,
      skipRestoreFromPending: true, registerDaemonTab: false, registerSettingsTab: false,
      skipPushcutChannel: true, skipPwaChannel: true, skipTelegramChannel: true,
      skipDiscordChannel: true, skipTerminalChannel: true, skipIntentPrediction: true,
      cleanGhostTailscaleServeFn: async () => {},
      appSiteDeploymentOperations: {
        createFromTemplate: async ({ appSlug }) => {
          const appRoot = join(root, 'nexus', 'apps', appSlug);
          const outputRoot = join(appRoot, 'out');
          mkdirSync(outputRoot, { recursive: true });
          writeFileSync(join(appRoot, 'app.yaml'), `apiVersion: elanous.app/v0
slug: ${appSlug}
title: ${appSlug === 'lecture-scrap' ? 'Public lecture notes' : 'Team notes app'}
frontend:
  kind: static-export
  out: out
roles:
  public: { via: public-read }
`);
          writeFileSync(join(outputRoot, 'index.html'), '<html><body><main>managed app</main></body></html>');
          return { appRoot, appSlug };
        },
        build: async ({ source }) => ({ appRoot: join(source.appRoot, 'out'), verifyText: 'managed-deploy-proof' }),
        publish: async () => {},
        // Source: app-site-deploy treats HTTP 200 with its marker as a successful publish verification.
        verify: async ({ verifyText }) => ({ status: 200, body: verifyText }),
      },
      startNexusHttpServerFn: ((opts: import('./api/http-server.js').NexusHttpServerOpts) => {
        httpOpts = opts;
        const port = ownerServer!.port;
        if (port === undefined) throw new Error('owner server has no port');
        return { port, hostname: '127.0.0.1', url: ownerServer!.url.toString(), stop: () => {} };
      }) as typeof import('./api/http-server.js').startNexusHttpServer,
    });
    if (!nexus || !httpOpts) throw new Error('Nexus deploy routes were not wired');
    const { appRoutes, appHost, boardEventStore } = httpOpts;
    if (!appRoutes || !appHost || !boardEventStore) throw new Error('Nexus deploy dependencies were not wired');
    const deployRequest = (appSlug = 'lecture-scrap') => new Request(`http://nexus.invalid/v1/apps/${appSlug}/deploy`, {
      method: 'POST', headers: {
        authorization: 'Bearer aps_abcdefghijklmnopqrstuvwxyz123456', 'content-type': 'application/json',
      }, body: JSON.stringify({ templateId: 'next-app-lecture-scrap' }),
    });
    let deployResponse: Response | undefined;
    for (const route of appRoutes) {
      deployResponse = await route(deployRequest()) ?? undefined;
      if (deployResponse) break;
    }
    // Source: app-site-deploy returns HTTP 200 after the owner deployment verifies successfully.
    expect(deployResponse?.status).toBe(200);
    const published = await boardEventStore.query({ memberId: owner.memberId, type: 'board.card' });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ type: 'board.card', memberId: owner.memberId,
      cardId: 'app-lecture-scrap', state: 'released', appSlug: 'lecture-scrap',
      title: 'Public lecture notes', result: { publicUrl: 'https://lecture-scrap--public-owner.elanous.app' } });
    expect(published[0]?.runId).toMatch(/^[0-9a-f-]{36}$/);
    const boardResponse = await handleBoardRoute(new Request('http://localhost/v1/board'), '/v1/board', {
      resolveOwner: async () => ({ memberId: owner.memberId }), store: boardEventStore,
    });
    expect(boardResponse?.status).toBe(200);
    const cards = (await boardResponse!.json()).cards;
    expect(cards).toMatchObject([{
      id: 'app-lecture-scrap', memberId: owner.memberId, state: 'deployed',
      title: 'Public lecture notes', publicUrl: 'https://lecture-scrap--public-owner.elanous.app/',
    }]);
    expect(cards[0].runId).toBe(published[0]?.runId);
    const hosted = await appHost.handle(new Request('http://lecture-scrap.app.localhost/', {
      headers: { host: 'lecture-scrap.app.localhost' },
    }));
    // Source: the Nexus app host returns HTTP 200 for a mounted public-read HTML response.
    expect(hosted?.status).toBe(200);
    const html = await hosted!.text();
    expect(html).toContain('<main>managed app</main>');
    expect(html).not.toContain('made-with-badge');
    expect(html).not.toContain('made with elanous');
    let otherDeploy: Response | undefined;
    for (const route of appRoutes) {
      otherDeploy = await route(deployRequest('team-notes')) ?? undefined;
      if (otherDeploy) break;
    }
    expect(otherDeploy?.status).toBe(200);
    const otherEvents = await boardEventStore.query({ memberId: owner.memberId, type: 'board.card' });
    expect(otherEvents.find(event => event.cardId === 'app-team-notes')).toMatchObject({
      appSlug: 'team-notes', title: 'Team notes app', state: 'released',
    });
    const otherBoard = await handleBoardRoute(new Request('http://localhost/v1/board'), '/v1/board', {
      resolveOwner: async () => ({ memberId: owner.memberId }), store: boardEventStore,
    });
    expect((await otherBoard!.json()).cards).toContainEqual(expect.objectContaining({
      id: 'app-team-notes', title: 'Team notes app', state: 'deployed',
    }));
  } finally {
    await nexus?.release();
    ownerServer?.stop();
    resetElanousConfigDir();
    setTestStateRoot(null);
    if (previousPublicUserId === undefined) delete process.env.ELANOUS_PUBLIC_APP_USER_ID;
    else process.env.ELANOUS_PUBLIC_APP_USER_ID = previousPublicUserId;
    if (previousGoogleRedirect === undefined) delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
    else process.env.GOOGLE_OAUTH_REDIRECT_URI = previousGoogleRedirect;
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Nexus wsBridgeOpts auth wiring', () => {
  test('configured-auth: bearerToken present → createAuthVerifier is passed as wsAuthVerifier', () => {
    // ⛔ `configDir` 를 «반드시» 준다 — 안 주면 이 시험이 사람 홈의 «실제» 봉투를 읽어
    //    개발자 기계마다 다른 답이 나온다(2026-09-01 실측: 실제 봉투의 active 가 이 토큰이 아니라 빨강).
    //    ⭐ 빈 디렉토리 = 「봉투 없음」 ⇒ 부팅 토큰 하나로 오늘과 똑같이 동작한다(가용성 보존 경로).
    const noEnvelope = mkdtempSync(join(tmpdir(), 'nexus-auth-no-envelope-'));
    tempDirs.push(noEnvelope);
    const opts = buildNexusWsBridgeAuth(CONFIGURED_TOKEN, { configDir: noEnvelope });
    expect(opts.wsAuthVerifier).toBeDefined();
    expect(opts.wsAuthVerifier!.verify({ kind: 'auth', token: CONFIGURED_TOKEN }))
      .toEqual({ ok: true });
    expect(opts.wsAuthVerifier!.verify({ kind: 'auth', token: 'wrong-token-yyyyyyyyyyyyyyyyyyyy' }))
      .toEqual({ ok: false, reason: 'bad-token' });
    expect('noAuth' in opts).toBe(false);
  });

  test('no-token startup: verifier omitted; dead noAuth is not assigned on wsBridgeOpts', () => {
    const opts = buildNexusWsBridgeAuth(undefined);
    expect(opts.wsAuthVerifier).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(opts, 'wsAuthVerifier')).toBe(false);
    expect('noAuth' in opts).toBe(false);
    expect(opts).toEqual({});
  });
});

describe('Nexus startup bearer token', () => {
  let isolated: string;
  let previousNoAuth: string | undefined;
  beforeEach(() => {
    isolated = mkdtempSync(join(tmpdir(), 'nexus-auth-boot-'));
    setElanousConfigDir(isolated);
    setTestStateRoot(isolated);
    previousNoAuth = process.env.ELANOUS_NEXUS_NO_AUTH;
    delete process.env.ELANOUS_NEXUS_NO_AUTH;
  });
  afterEach(() => {
    resetElanousConfigDir();
    setTestStateRoot(null);
    if (previousNoAuth === undefined) delete process.env.ELANOUS_NEXUS_NO_AUTH;
    else process.env.ELANOUS_NEXUS_NO_AUTH = previousNoAuth;
    rmSync(isolated, { recursive: true, force: true });
  });

  async function boot(noAuth?: boolean, realServer = false) {
    let captured: import('./api/http-server.js').NexusHttpServerOpts | undefined;
    const nexus = await runNexus({
      detachForTesting: true, skipHttpServer: false, skipRuntimeApi: false,
      toolCwd: isolated, skipSupervisor: true, mcpEnabled: false, cleanGhostTailscaleServeFn: async () => {},
      skipPushcutChannel: true, skipPwaChannel: true, skipTelegramChannel: true,
      skipDiscordChannel: true, skipTerminalChannel: true, skipIntentPrediction: true,
      ...(noAuth === undefined ? {} : { noAuth }),
      ...(realServer ? { httpStartPort: 49000 + Math.floor(Math.random() * 2000) } : {
        startNexusHttpServerFn: ((opts: import('./api/http-server.js').NexusHttpServerOpts) => {
          captured = opts;
          return { port: 31415, hostname: '127.0.0.1', url: 'http://127.0.0.1:31415', stop: () => {} };
        }) as typeof import('./api/http-server.js').startNexusHttpServer,
      }),
    });
    if (!nexus || (!realServer && !captured) || !nexus.httpServer) throw new Error('Nexus did not bind');
    return { nexus, captured: captured! };
  }

  test('live Nexus rejects a headerless REST mutation and unauthenticated ACP websocket', async () => {
    const { nexus } = await boot(undefined, true);
    const base = nexus.httpServer!.url;
    try {
      const rest = await fetch(`${base}/v1/nexus/tabs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'chat', id: 'unauthorized' }),
      });
      expect(rest.status).toBe(401);
      expect(await rest.json()).toEqual({ error: 'unauthorized' });

      const ws = new WebSocket(base.replace(/^http:/, 'ws:') + '/v1/acp');
      try {
        const opened = new Promise<void>((resolve, reject) => {
          ws.addEventListener('open', () => resolve(), { once: true });
          ws.addEventListener('error', () => reject(new Error('ACP websocket upgrade failed')), { once: true });
        });
        await Promise.race([opened, Bun.sleep(3_000).then(() => { throw new Error('ACP websocket open timed out'); })]);
        const rejected = new Promise<{ code: number; reason: string }>((resolve, reject) => {
          ws.addEventListener('close', event => resolve({ code: event.code, reason: event.reason }), { once: true });
          ws.addEventListener('error', () => reject(new Error('ACP websocket failed before auth rejection')), { once: true });
        });
        ws.send(JSON.stringify({ kind: 'auth' }));
        expect(await Promise.race([rejected, Bun.sleep(3_000).then(() => { throw new Error('ACP websocket auth rejection timed out'); })]))
          .toEqual({ code: 1008, reason: 'auth_failed' });
      } finally { ws.close(); }
    } finally { nexus.release(); }
  }, 20_000);

  test('missing token is created with mode 0600 and gates both REST and websocket', async () => {
    const { nexus, captured } = await boot();
    try {
      const path = join(isolated, 'acp-token');
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const token = readFileSync(path, 'utf8');
      expect(token.length).toBeGreaterThan(0);
      expect(captured.metaApi?.noAuth).toBe(false);
      expect(captured.metaApi?.bearerToken).toBe(token);
      expect(captured.wsBridge?.wsAuthVerifier?.verify({ kind: 'auth', token } as Parameters<NonNullable<NonNullable<typeof captured.wsBridge>['wsAuthVerifier']>['verify']>[0])).toEqual({ ok: true });
      expect(nexus.runtime.httpAuth).toBe('on');
    } finally { nexus.release(); }
  });

  test('runNexus routes the shared runtime event bus into authenticated app database writers', async () => {
    const appDir = join(isolated, 'nexus', 'apps', 'runtime-notes');
    mkdirSync(join(appDir, 'out'), { recursive: true });
    writeFileSync(join(appDir, 'app.yaml'), `apiVersion: elanous.app/v0
slug: runtime-notes
title: Runtime notes
frontend: { kind: static-export, out: out }
roles:
  owner: { via: share-link }
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
rpc:
  list:
    sql: SELECT id, title FROM notes ORDER BY id
    params: {}
    allow: [owner]
  add:
    sql: INSERT INTO notes (id, title) VALUES (:id, :title)
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
`);
    writeFileSync(join(appDir, 'out', 'index.html'), '<main>runtime notes</main>');
    const { nexus, captured } = await boot();
    const appHost = captured.appHost;
    if (!appHost) throw new Error('app host did not mount');
    const seen: string[] = [];
    const unsubscribe = nexus.eventBus.subscribe(event => seen.push(event.kind), ['app.row.']);
    try {
      expect(captured.eventBus).toBe(nexus.eventBus);
      const invitation = appHost.issueInvitation('runtime-notes', 'sim-owner', undefined, 'owner');
      const accepted = (await appHost.handle(new Request(
        `http://nexus.invalid/__auth/accept?token=${encodeURIComponent(invitation.token)}`,
        { headers: { host: 'runtime-notes.app.localhost' } },
      )))!;
      expect(accepted.status).toBe(303);
      const cookie = accepted.headers.get('set-cookie')!.split(';', 1)[0]!;
      const base = { host: 'runtime-notes.app.localhost', origin: 'http://runtime-notes.app.localhost', cookie, 'content-type': 'application/json' };
      const list = await appHost.handle(new Request('http://nexus.invalid/__rpc/list', {
        method: 'POST', headers: base, body: JSON.stringify({ params: {} }),
      }));
      expect(list?.status).toBe(200);
      expect(seen).toEqual([]);
      const insert = await appHost.handle(new Request('http://nexus.invalid/__rpc/add', {
        method: 'POST', headers: base, body: JSON.stringify({ params: { id: '1', title: 'runtime write' } }),
      }));
      expect(insert?.status).toBe(200);
      expect(seen).toEqual(['app.row.insert']);
    } finally {
      unsubscribe();
      appHost.close();
      nexus.release();
    }
  });

  test('live Nexus dispatches manifest STT through the app route registry and closed secret boundary', async () => {
    const appDir = join(isolated, 'nexus', 'apps', 'voice-note');
    mkdirSync(join(appDir, 'out'), { recursive: true });
    writeFileSync(join(appDir, 'app.yaml'), `apiVersion: elanous.app/v0\nslug: voice-note\ntitle: Voice notes\nfrontend:\n  kind: static-export\n  out: out\nroles:\n  owner: {}\nactions:\n  transcribe:\n    builtin: stt\n    input: { audio: object-ref }\n    output: { text: text }\n    uses: [cred:openai.api_key]\n  makeAd:\n    builtin: generate\n    async: true\n    spend: owner-confirm\n    uses: [cred:higgsfield.key_id, cred:higgsfield.secret]\nstorage:\n  prefix: apps/voice-note/\n  quotaBytes: 1024\n  upload:\n    allow: [owner]\n    types: [audio/wav, image/png, video/mp4]\n    maxBytes: 512\n`);
    writeFileSync(join(appDir, 'out', 'index.html'), '<main>voice note</main>');
    writeFileSync(join(isolated, 'acp-token'), `${CONFIGURED_TOKEN}\n`);
    await setCredentialSlotAsync('cred:openai.api_key', 'shared-openai-must-not-be-used');
    await setAppSecretValue(appSecretId('other-app', 'OPENAI_API_KEY'), 'other-app-must-not-be-used');
    const fakeStt = createFakeStt();
    const observedApiKeys: string[] = [];
    const nexus = await runNexus({
      detachForTesting: true, skipHttpServer: false, skipRuntimeApi: false,
      httpStartPort: 49000 + Math.floor(Math.random() * 2000), toolCwd: isolated,
      skipSupervisor: true, mcpEnabled: false, cleanGhostTailscaleServeFn: async () => {},
      skipPushcutChannel: true, skipPwaChannel: true, skipTelegramChannel: true,
      skipDiscordChannel: true, skipTerminalChannel: true, skipIntentPrediction: true,
      appActionDepsForTesting: {
        transcribe: async input => {
          observedApiKeys.push(input.apiKey);
          const result = await fakeStt.transcribe({ audio: input.audio, language: input.language as 'ko' | 'en' | undefined });
          return { text: result.text, language: result.language, durationMs: 12 };
        },
      },
    });
    if (!nexus?.httpServer) throw new Error('Nexus did not bind');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const target = String(input);
      const headers = new Headers(init?.headers);
      if (target.endsWith('/files/generate-upload-url')) {
        expect(headers.get('authorization')).toBe('Key sim-higgsfield-key-id:sim-higgsfield-secret');
        return Response.json({ upload_url: 'https://storage.fake.invalid/upload/1', upload_headers: { 'x-sim-upload': 'signed' }, public_url: 'https://storage.fake.invalid/image/1.png' });
      }
      if (target === 'https://storage.fake.invalid/upload/1') {
        expect(headers.get('authorization')).toBeNull();
        return new Response(null, { status: 200 });
      }
      if (target.endsWith('/bytedance/seedance-2.0/image-to-video')) {
        expect(headers.get('authorization')).toBe('Key sim-higgsfield-key-id:sim-higgsfield-secret');
        expect(JSON.parse(String(init?.body))).toMatchObject({ image_url: 'https://storage.fake.invalid/image/1.png' });
        return Response.json({ request_id: 'simulated-provider-request' }, { status: 202 });
      }
      if (target.endsWith('/requests/simulated-provider-request/status')) {
        expect(headers.get('authorization')).toBe('Key sim-higgsfield-key-id:sim-higgsfield-secret');
        return Response.json({ status: 'completed', video: { url: 'https://media.higgsfield.ai/result.mp4' } });
      }
      if (target === 'https://media.higgsfield.ai/result.mp4') {
        expect(headers.get('authorization')).toBeNull();
        return new Response(new Uint8Array([9, 8, 7]), { headers: { 'content-type': 'video/mp4', 'content-length': '3' } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const url = `${nexus.httpServer.url}/v1/apps/voice-note/actions/transcribe`;
      const audio = Buffer.from('fake-stt-contract-audio');
      const headers = { 'content-type': 'audio/wav', 'x-audio-filename': 'sample.wav' };
      const unauthorized = await fetch(url, { method: 'POST', headers, body: audio });
      expect(unauthorized.status).toBe(401);
      const authorizedHeaders = { ...headers, authorization: `Bearer ${CONFIGURED_TOKEN}` };
      const denied = await fetch(url, { method: 'POST', headers: authorizedHeaders, body: audio });
      expect(denied.status).toBe(503);
      expect(await denied.json()).toEqual({ error: 'credential-unavailable' });
      await setAppSecretValue(appSecretId('voice-note', 'OPENAI_API_KEY'), 'simulated-openai-key');
      const succeeded = await fetch(url, { method: 'POST', headers: authorizedHeaders, body: audio });
      expect(succeeded.status).toBe(200);
      expect(await succeeded.json()).toMatchObject({ ok: true, text: '안녕하세요', language: 'ko' });
      expect(observedApiKeys).toEqual(['simulated-openai-key']);

      const storageUrl = `${nexus.httpServer.url}/v1/apps/voice-note/storage`;
      expect((await fetch(storageUrl)).status).toBe(401);
      const signedResponse = await fetch(`${storageUrl}/uploads`, {
        method: 'POST', headers: { authorization: `Bearer ${CONFIGURED_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'audio/entry.wav', expiresInMs: 60_000 }),
      });
      expect(signedResponse.status).toBe(200);
      const signedUrl = (await signedResponse.json() as { url: string }).url;
      expect(new URL(signedUrl).origin).toBe(nexus.httpServer.url);
      const uploadedBytes = Buffer.from('fake-stt-contract-audio');
      const uploaded = await fetch(signedUrl, { method: 'PUT', headers: { 'content-type': 'audio/wav' }, body: uploadedBytes });
      expect(uploaded.status).toBe(201);
      const listed = await fetch(storageUrl, { headers: { authorization: `Bearer ${CONFIGURED_TOKEN}` } });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ files: ['audio/entry.wav'] });
      const read = await fetch(`${storageUrl}?key=audio%2Fentry.wav`, { headers: { authorization: `Bearer ${CONFIGURED_TOKEN}` } });
      expect(read.status).toBe(200);
      expect(read.headers.get('content-type')).toBe('audio/wav');
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(uploadedBytes);

      const storedAudioRequest = JSON.stringify({ audio: 'audio/entry.wav', language: 'ko' });
      const unauthorizedAfterStorage = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: storedAudioRequest,
      });
      expect(unauthorizedAfterStorage.status).toBe(401);
      expect(await deleteAppSecretValue(appSecretId('voice-note', 'OPENAI_API_KEY'))).toBe(true);
      const missingCredentialAfterStorage = await fetch(url, {
        method: 'POST', headers: { ...authorizedHeaders, 'content-type': 'application/json' }, body: storedAudioRequest,
      });
      expect(missingCredentialAfterStorage.status).toBe(503);
      expect(await missingCredentialAfterStorage.json()).toEqual({ error: 'credential-unavailable' });
      await setAppSecretValue(appSecretId('voice-note', 'OPENAI_API_KEY'), 'simulated-openai-key');
      const transcribedStoredAudio = await fetch(url, {
        method: 'POST', headers: { ...authorizedHeaders, 'content-type': 'application/json' }, body: storedAudioRequest,
      });
      expect(transcribedStoredAudio.status).toBe(200);
      expect(await transcribedStoredAudio.json()).toMatchObject({ ok: true, text: '안녕하세요' });
      expect(observedApiKeys).toEqual(['simulated-openai-key', 'simulated-openai-key']);
      await setAppSecretValue(appSecretId('voice-note', 'HIGGSFIELD_KEY_ID'), 'sim-higgsfield-key-id');
      await setAppSecretValue(appSecretId('voice-note', 'HIGGSFIELD_SECRET'), 'sim-higgsfield-secret');
      const imageUploadResponse = await fetch(`${storageUrl}/uploads`, {
        method: 'POST', headers: { authorization: `Bearer ${CONFIGURED_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'products/input.png', expiresInMs: 60_000 }),
      });
      expect(imageUploadResponse.status).toBe(200);
      const imageUploadUrl = (await imageUploadResponse.json() as { url: string }).url;
      expect((await fetch(imageUploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Uint8Array([1, 2, 3]) })).status).toBe(201);
      const generateResponse = await fetch(`${nexus.httpServer.url}/v1/apps/voice-note/actions/makeAd`, {
        method: 'POST', headers: { ...authorizedHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Make a product clip', image: 'products/input.png', confirmSpend: true }),
      });
      expect(generateResponse.status).toBe(202);
      const queued = await generateResponse.json() as { jobId: string; eventsUrl: string; status: string };
      expect(queued).toMatchObject({ status: 'queued' });
      const statusResponse = await fetch(`${nexus.httpServer.url}/v1/apps/voice-note/jobs/${queued.jobId}`, {
        headers: { authorization: `Bearer ${CONFIGURED_TOKEN}` },
      });
      expect(statusResponse.status).toBe(200);
      expect(await statusResponse.json()).toMatchObject({ job: { status: 'completed', resultKey: `apps/voice-note/generated/${queued.jobId}.mp4` } });
      const eventsResponse = await fetch(`${nexus.httpServer.url}${queued.eventsUrl}`, { headers: { authorization: `Bearer ${CONFIGURED_TOKEN}` } });
      expect(eventsResponse.status).toBe(200);
      const eventsText = await eventsResponse.text();
      expect(eventsText).toContain('event: job');
      expect(eventsText).toContain('"status":"completed"');
    } finally { globalThis.fetch = originalFetch; nexus.release(); }
  }, 30_000);

  test('live runNexus boot wires four funnel events using installation identity and hashed identifiers', async () => {
    const identity = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const identityFile = join(isolated, 'identity.json');
    __setIdentityFileForTests(identityFile);
    writeFileSync(identityFile, JSON.stringify({ elanous_id: identity, created_at: new Date(0).toISOString(), schema_version: 1 }));
    const appDir = join(isolated, 'nexus', 'apps', 'voice-note');
    mkdirSync(join(appDir, 'out'), { recursive: true });
    writeFileSync(join(appDir, 'app.yaml'), `apiVersion: elanous.app/v0\nslug: voice-note\ntitle: Voice notes\nfrontend: { kind: static-export, out: out }\nroles: { owner: { via: nexus-session }, viewer: { via: share-link } }\nactions:\n  summarize:\n    builtin: summarize\n    input: { text: text }\n    output: { text: text }\n    uses: [cred:openai.api_key]\nstorage:\n  prefix: apps/voice-note/\n  quotaBytes: 5\n  upload:\n    allow: [owner]\n    types: [audio/wav]\n    maxBytes: 512\n`);
    writeFileSync(join(appDir, 'out', 'index.html'), '<main>voice notes</main>');
    writeFileSync(join(isolated, 'acp-token'), `${CONFIGURED_TOKEN}\n`);
    await setAppSecretValue(appSecretId('voice-note', 'OPENAI_API_KEY'), 'isolated-summary-key');
    const events: NexusFunnelEvent[] = [];
    const nexus = await runNexus({
      detachForTesting: true, skipHttpServer: false, skipRuntimeApi: false,
      httpStartPort: 49000 + Math.floor(Math.random() * 2000), toolCwd: isolated,
      skipSupervisor: true, mcpEnabled: false, cleanGhostTailscaleServeFn: async () => {},
      skipPushcutChannel: true, skipPwaChannel: true, skipTelegramChannel: true,
      skipDiscordChannel: true, skipTerminalChannel: true, skipIntentPrediction: true,
      appActionDepsForTesting: { summarize: async ({ text }) => `summary: ${text}` },
      funnelObserverForTesting: event => { events.push(event); },
    }).catch(error => {
      __setIdentityFileForTests(null);
      __resetIdentityForTests();
      throw error;
    });
    if (!nexus?.httpServer) {
      __setIdentityFileForTests(null);
      __resetIdentityForTests();
      throw new Error('Nexus did not bind');
    }
    try {
      const authorization = { authorization: `Bearer ${CONFIGURED_TOKEN}` };
      const invitationResponse = await fetch(`${nexus.httpServer.url}/v1/nexus/apps/voice-note/invitations`, {
        method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ invitedBy: 'raw-owner-id-must-not-be-logged' }),
      });
      expect(invitationResponse.status).toBe(201);
      const invitation = await invitationResponse.json() as { invitation: { token: string } };
      const accepted = await fetch(`${nexus.httpServer.url}/__auth/accept?token=${encodeURIComponent(invitation.invitation.token)}`, {
        headers: { host: 'voice-note.app.localhost' }, redirect: 'manual',
      });
      expect(accepted.status).toBe(303);
      const appOpen = await fetch(nexus.httpServer.url, {
        headers: { host: 'voice-note.app.localhost', cookie: accepted.headers.get('set-cookie')! },
      });
      expect(appOpen.status).toBe(200);

      const actionUrl = `${nexus.httpServer.url}/v1/apps/voice-note/actions/summarize`;
      for (const text of ['first successful action', 'later successful action']) {
        const action = await fetch(actionUrl, {
          method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        expect(action.status).toBe(200);
      }

      const storageUrl = `${nexus.httpServer.url}/v1/apps/voice-note/storage/uploads`;
      const signUpload = async (key: string) => {
        const response = await fetch(storageUrl, {
          method: 'POST', headers: { ...authorization, 'content-type': 'application/json' },
          body: JSON.stringify({ key, expiresInMs: 60_000, role: 'owner' }),
        });
        expect(response.status).toBe(200);
        return (await response.json() as { url: string }).url;
      };
      const firstUpload = await fetch(await signUpload('audio/first.wav'), {
        method: 'PUT', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array([1, 2, 3, 4, 5]),
      });
      expect(firstUpload.status).toBe(201);
      const overQuotaUpload = await fetch(await signUpload('audio/over-quota.wav'), {
        method: 'PUT', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array([6]),
      });
      expect(overQuotaUpload.status).toBe(413);

      const accountHash = createHash('sha256').update(`nexus-funnel:account:${identity}`).digest('hex');
      const appHash = createHash('sha256').update('nexus-funnel:app:voice-note').digest('hex');
      expect(events.map(event => event.type)).toEqual(['invite-sent', 'app-open', 'first-success', 'limit-reached']);
      expect(events.every(event => event.accountHash === accountHash)).toBe(true);
      for (const event of events) {
        if (event.type === 'app-open' || event.type === 'first-success' || event.type === 'limit-reached') {
          expect(event.appHash).toBe(appHash);
        }
      }
      expect(JSON.stringify(events)).not.toContain(identity);
      expect(JSON.stringify(events)).not.toContain('voice-note');
      expect(JSON.stringify(events)).not.toContain('raw-owner-id-must-not-be-logged');
    } finally {
      nexus.release();
      __setIdentityFileForTests(null);
      __resetIdentityForTests();
    }
  }, 30_000);

  test('live Nexus dispatches manifest TTS through fake ElevenLabs and closed secret boundary', async () => {
    const appDir = join(isolated, 'nexus', 'apps', 'voice-note');
    mkdirSync(join(appDir, 'out'), { recursive: true });
    writeFileSync(join(appDir, 'app.yaml'), `apiVersion: elanous.app/v0\nslug: voice-note\ntitle: Voice notes\nfrontend:\n  kind: static-export\n  out: out\nactions:\n  speak:\n    builtin: tts\n    input: { text: text, voiceId: text }\n    output: { audioBase64: text, mimeType: text }\n    uses: [cred:elevenlabs.api_key]\n`);
    writeFileSync(join(appDir, 'out', 'index.html'), '<main>voice note</main>');
    writeFileSync(join(isolated, 'acp-token'), `${CONFIGURED_TOKEN}\n`);
    await setCredentialSlotAsync('cred:elevenlabs.api_key', 'shared-elevenlabs-must-not-be-used');
    const fake = await startFakeElevenLabs({ apiKey: 'sim-elevenlabs-key' });
    const originalFetch = globalThis.fetch;
    const nexus = await runNexus({
      detachForTesting: true, skipHttpServer: false, skipRuntimeApi: false,
      httpStartPort: 49000 + Math.floor(Math.random() * 2000), toolCwd: isolated,
      skipSupervisor: true, mcpEnabled: false, cleanGhostTailscaleServeFn: async () => {},
      skipPushcutChannel: true, skipPwaChannel: true, skipTelegramChannel: true,
      skipDiscordChannel: true, skipTerminalChannel: true, skipIntentPrediction: true,
    });
    if (!nexus?.httpServer) {
      await fake.close();
      throw new Error('Nexus did not bind');
    }
    try {
      let providerUrl = '';
      let providerInit: RequestInit | undefined;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const requestedUrl = String(input);
        if (!requestedUrl.startsWith('https://api.elevenlabs.io/')) return originalFetch(input, init);
        providerUrl = requestedUrl;
        providerInit = init;
        const parsed = new URL(requestedUrl);
        return originalFetch(`${fake.baseUrl}${parsed.pathname}${parsed.search}`, init);
      }) as typeof fetch;
      const url = `${nexus.httpServer.url}/v1/apps/voice-note/actions/speak`;
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${CONFIGURED_TOKEN}` };
      const body = JSON.stringify({ text: 'Hello from app TTS', voiceId: 'fake-voice' });
      const unauthorized = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      expect(unauthorized.status).toBe(401);
      const denied = await fetch(url, { method: 'POST', headers, body });
      expect(denied.status).toBe(503);
      expect(await denied.json()).toEqual({ error: 'credential-unavailable' });
      await setAppSecretValue(appSecretId('voice-note', 'ELEVENLABS_API_KEY'), 'sim-elevenlabs-key');
      const succeeded = await fetch(url, { method: 'POST', headers, body });
      expect(succeeded.status).toBe(200);
      expect(await succeeded.json()).toEqual({
        ok: true, audioBase64: fakeElevenLabsAudioBytes('Hello from app TTS').toString('base64'), mimeType: 'audio/pcm',
      });
      expect(providerUrl).toBe('https://api.elevenlabs.io/v1/text-to-speech/fake-voice?output_format=mp3_44100_128');
      expect(providerInit?.redirect).toBe('error');
      expect(new Headers(providerInit?.headers).get('xi-api-key')).toBe('sim-elevenlabs-key');
      expect(fake.requests()).toEqual([{
        method: 'POST', path: '/v1/text-to-speech/fake-voice?output_format=mp3_44100_128', text: 'Hello from app TTS', status: 200,
      }]);
    } finally { globalThis.fetch = originalFetch; nexus.release(); await fake.close(); }
  }, 30_000);

  test('existing token is reused without modifying its file contents', async () => {
    const path = join(isolated, 'acp-token');
    writeFileSync(path, `${CONFIGURED_TOKEN}\n`);
    const { nexus, captured } = await boot();
    try {
      expect(readFileSync(path, 'utf8')).toBe(`${CONFIGURED_TOKEN}\n`);
      expect(captured.metaApi?.bearerToken).toBe(CONFIGURED_TOKEN);
    } finally { nexus.release(); }
  });

  test('explicit --no-auth and env=1 bypass both gates without creating a token', async () => {
    for (const viaEnv of [false, true]) {
      if (viaEnv) process.env.ELANOUS_NEXUS_NO_AUTH = '1';
      const { nexus, captured } = await boot(viaEnv ? undefined : true);
      try {
        expect(captured.metaApi?.noAuth).toBe(true);
        expect(captured.metaApi?.bearerToken).toBeUndefined();
        expect(captured.wsBridge?.wsAuthVerifier).toBeUndefined();
        expect(existsSync(join(isolated, 'acp-token'))).toBe(false);
        expect(nexus.runtime.httpAuth).toBe('off');
      } finally { nexus.release(); }
    }
  });

  test('both explicit opt-outs print a banner warning and emit nexus.auth with source', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const { debug } = await import('../debug/log.js');
    const log = spyOn(debug, 'log');
    try {
      for (const viaEnv of [false, true]) {
        warn.mockClear();
        log.mockClear();
        if (viaEnv) process.env.ELANOUS_NEXUS_NO_AUTH = '1';
        let finish!: () => void;
        const done = new Promise<void>(resolve => { finish = resolve; });
        const boot = runNexus({
          ...(viaEnv ? {} : { noAuth: true }), headless: true, headlessDoneForTesting: done,
          skipHeadlessSetupCheckForTesting: true, autoMountShare: false,
          skipHttpServer: false, skipRuntimeApi: false, skipSupervisor: true,
          skipPushcutChannel: true, skipPwaChannel: true, skipTelegramChannel: true,
          skipDiscordChannel: true, skipTerminalChannel: true, skipIntentPrediction: true,
          toolCwd: isolated, mcpEnabled: false, cleanGhostTailscaleServeFn: async () => {},
          startNexusHttpServerFn: (() => ({ port: 31415, hostname: '127.0.0.1', url: 'http://127.0.0.1:31415', stop: () => {} })) as typeof import('./api/http-server.js').startNexusHttpServer,
        });
        try {
          const deadline = Date.now() + 8_000;
          while (!warn.mock.calls.some(([message]) => String(message).includes('AUTH DISABLED')) && Date.now() < deadline) await Bun.sleep(5);
          expect(warn.mock.calls.some(([message]) => String(message).includes('AUTH DISABLED'))).toBe(true);
          expect(log.mock.calls.some(([category, event, data]) => category === 'nexus.auth'
            && event === 'explicit-opt-out'
            && (data as { source?: string }).source === (viaEnv ? 'ELANOUS_NEXUS_NO_AUTH' : '--no-auth'))).toBe(true);
        } finally {
          finish();
          await boot;
        }
      }
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test('other env values are not opt-outs', async () => {
    process.env.ELANOUS_NEXUS_NO_AUTH = 'true';
    const { nexus, captured } = await boot();
    try {
      expect(captured.metaApi?.noAuth).toBe(false);
      expect(captured.metaApi?.bearerToken).toBeDefined();
    } finally { nexus.release(); }
  });

  test('empty existing token fails closed before the HTTP listener binds', async () => {
    writeFileSync(join(isolated, 'acp-token'), '  \n');
    let bound = false;
    await expect(runNexus({
      detachForTesting: true, skipHttpServer: false, skipRuntimeApi: false,
      toolCwd: isolated, skipSupervisor: true, mcpEnabled: false,
      startNexusHttpServerFn: ((() => { bound = true; throw new Error('bound unexpectedly'); }) as unknown) as typeof import('./api/http-server.js').startNexusHttpServer,
    })).rejects.toThrow('Nexus auth token is empty');
    expect(bound).toBe(false);
    expect(existsSync(join(isolated, 'nexus', '.lock'))).toBe(false);
  });

  test('token creation failure aborts before the HTTP listener binds', async () => {
    const invalidConfigDir = join(isolated, 'config-file');
    writeFileSync(invalidConfigDir, 'not a directory');
    setElanousConfigDir(invalidConfigDir);
    let bound = false;
    await expect(runNexus({
      detachForTesting: true, skipHttpServer: false, skipRuntimeApi: false,
      toolCwd: isolated, skipSupervisor: true, mcpEnabled: false,
      startNexusHttpServerFn: ((() => { bound = true; throw new Error('bound unexpectedly'); }) as unknown) as typeof import('./api/http-server.js').startNexusHttpServer,
    })).rejects.toThrow();
    expect(bound).toBe(false);
    expect(existsSync(join(isolated, 'nexus', '.lock'))).toBe(false);
  });

  test('token read failure aborts before the HTTP listener binds', async () => {
    mkdirSync(join(isolated, 'acp-token'));
    let bound = false;
    await expect(runNexus({
      detachForTesting: true, skipHttpServer: false, skipRuntimeApi: false,
      toolCwd: isolated, skipSupervisor: true, mcpEnabled: false,
      startNexusHttpServerFn: ((() => { bound = true; throw new Error('bound unexpectedly'); }) as unknown) as typeof import('./api/http-server.js').startNexusHttpServer,
    })).rejects.toThrow();
    expect(bound).toBe(false);
    expect(existsSync(join(isolated, 'nexus', '.lock'))).toBe(false);
  });
});

describe('runNexus · headless auto-mount share unmount on exit', () => {
  let stateRoot: string;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-share-unmount-'));
    setTestStateRoot(stateRoot);
  });

  afterEach(() => {
    setTestStateRoot(null);
    rmSync(stateRoot, { recursive: true, force: true });
  });

  async function runHeadlessShareLifecycle(args: {
    mount: ShareMountResult;
    disable?: (deps: PwaShareDeps) => Promise<PwaShareResult>;
  }): Promise<{ disableCalls: PwaShareDeps[]; mountedPort?: number }> {
    const disableCalls: PwaShareDeps[] = [];
    let finish!: () => void;
    let mountedPort: number | undefined;
    let observed!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const mounted = new Promise<void>((resolve) => { observed = resolve; });
    const boot = runNexus({
      headless: true,
      skipHeadlessSetupCheckForTesting: true,
      headlessDoneForTesting: done,
      autoMountShare: true,
      skipHttpServer: false,
      skipSupervisor: true,
      skipRuntimeApi: true,
      skipPushcutChannel: true,
      skipPwaChannel: true,
      skipTelegramChannel: true,
      skipTerminalChannel: true,
      skipDiscordChannel: true,
      skipIntentPrediction: true,
      mountShareIfEnabledFn: async ({ httpPort }) => {
        mountedPort = httpPort;
        observed();
        return args.mount;
      },
      pwaShareDisableFn: async (deps: PwaShareDeps = {}) => {
        disableCalls.push(deps);
        if (args.disable) return args.disable(deps);
        return { exitCode: 0 };
      },
    });
    await mounted;
    finish();
    await boot;
    return { disableCalls, ...(mountedPort !== undefined ? { mountedPort } : {}) };
  }

  test('serving auto-mount is revisited after 60 seconds by the default coordinator, then walked on clean exit', async () => {
    let now = 0;
    const intervals = new Map<ReturnType<typeof setInterval>, { callback: () => void; ms: number; next: number }>();
    const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number) => {
      const timer = { unref: () => timer } as unknown as ReturnType<typeof setInterval>;
      intervals.set(timer, { callback, ms, next: now + ms });
      return timer;
    }) as typeof setInterval);
    const clearSpy = spyOn(globalThis, 'clearInterval').mockImplementation(((timer: ReturnType<typeof setInterval>) => {
      intervals.delete(timer);
    }) as typeof clearInterval);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const mountPorts: number[] = [];
    const disablePorts: number[] = [];
    let shareTimer: ReturnType<typeof setInterval> | undefined;
    const boot = runNexus({
      headless: true,
      skipHeadlessSetupCheckForTesting: true,
      headlessDoneForTesting: done,
      skipHttpServer: false,
      skipSupervisor: true,
      skipRuntimeApi: true,
      autoMountShare: true,
      mountShareIfEnabledFn: async ({ httpPort }) => {
        mountPorts.push(httpPort);
        return { outcome: 'serving', url: `https://host.tailnet.ts.net:${httpPort}/app/` };
      },
      pwaShareDisableFn: async ({ port } = {}) => {
        if (port !== undefined) disablePorts.push(port);
        return { exitCode: 0 };
      },
    });
    try {
      const deadline = Date.now() + 8_000;
      while (!process.listeners('SIGINT').some((listener) => listener.name === 'onSigint') && Date.now() < deadline) {
        await Bun.sleep(5);
      }
      expect(process.listeners('SIGINT').some((listener) => listener.name === 'onSigint')).toBe(true);
      expect(mountPorts).toHaveLength(1);
      expect(mountPorts[0]).toBeGreaterThan(0);
      // Advance a virtual interval clock, not just a spy on an unrelated 60s timer.
      const advance = async (ms: number): Promise<void> => {
        const end = now + ms;
        while (true) {
          const next = Math.min(...[...intervals.values()].map((interval) => interval.next));
          if (next > end) break;
          now = next;
          for (const [timer, interval] of intervals) {
            if (interval.next !== now) continue;
            interval.next += interval.ms;
            const callsBefore = mountPorts.length;
            interval.callback();
            if (mountPorts.length > callsBefore) shareTimer = timer;
          }
          await Promise.resolve();
        }
        now = end;
        await Promise.resolve();
      };
      await advance(59_999);
      expect(mountPorts).toHaveLength(1);
      await advance(1);
      expect(mountPorts).toEqual([mountPorts[0], mountPorts[0]]);
    } finally {
      finish();
      await boot;
      clearSpy.mockRestore();
      intervalSpy.mockRestore();
    }
    expect(disablePorts).toEqual([mountPorts[0]]);
    expect(shareTimer).toBeDefined();
    expect(intervals.has(shareTimer!)).toBe(false);
  });

  test('skipped auto-mount does not call pwaShareDisable on exit', async () => {
    const { disableCalls } = await runHeadlessShareLifecycle({
      mount: { outcome: 'skipped', reason: 'switch-disabled' },
    });
    expect(disableCalls).toHaveLength(0);
  });

  test('failed auto-mount does not call pwaShareDisable on exit', async () => {
    const { disableCalls } = await runHeadlessShareLifecycle({
      mount: { outcome: 'failed', reason: 'serve-error', serveExitCode: 1 },
    });
    expect(disableCalls).toHaveLength(0);
  });

  test('a later reconciliation mounts the live port after boot was skipped', async () => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const mountPorts: number[] = [];
    const disablePorts: number[] = [];
    const boot = runNexus({
      headless: true,
      skipHeadlessSetupCheckForTesting: true,
      headlessDoneForTesting: done,
      skipSupervisor: true,
      skipRuntimeApi: true,
      skipHttpServer: false,
      autoMountShare: true,
      shareCoordinatorIntervalMsForTesting: 15,
      mountShareIfEnabledFn: async ({ httpPort }) => {
        mountPorts.push(httpPort);
        return mountPorts.length === 1
          ? { outcome: 'skipped', reason: 'tailscale-down' }
          : { outcome: 'serving', url: `https://host.tailnet.ts.net:${httpPort}/app/` };
      },
      pwaShareDisableFn: async ({ port } = {}) => {
        if (port !== undefined) disablePorts.push(port);
        return { exitCode: 0 };
      },
    });
    try {
      const deadline = Date.now() + 8_000;
      while (mountPorts.length < 2 && Date.now() < deadline) await Bun.sleep(5);
      expect(mountPorts.length).toBeGreaterThanOrEqual(2);
    } finally {
      finish();
      await boot;
    }
    expect(disablePorts).toEqual([mountPorts[0]!]);
  }, 15_000);

  test('in-flight reconciliation completes before port unmount', async () => {
    let finish!: () => void;
    let mountStarted!: () => void;
    let finishMount!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const started = new Promise<void>((resolve) => { mountStarted = resolve; });
    const mountFinished = new Promise<void>((resolve) => { finishMount = resolve; });
    const mountPorts: number[] = [];
    const disablePorts: number[] = [];
    const boot = runNexus({
      headless: true,
      skipHeadlessSetupCheckForTesting: true,
      skipSupervisor: true,
      skipRuntimeApi: true,
      autoMountShare: true,
      shareCoordinatorIntervalMsForTesting: 15,
      mountShareIfEnabledFn: async ({ httpPort }) => {
        mountPorts.push(httpPort);
        if (mountPorts.length === 2) {
          mountStarted();
          await mountFinished;
        }
        return { outcome: 'serving', url: 'https://host.tailnet.ts.net/app/' };
      },
      pwaShareDisableFn: async ({ port } = {}) => {
        if (port !== undefined) disablePorts.push(port);
        return { exitCode: 0 };
      },
      headlessDoneForTesting: done,
      skipHttpServer: false,
    });
    try {
      await started;
      finish();
      await Bun.sleep(20);
      expect(disablePorts).toHaveLength(0);
      finishMount();
      await boot;
      expect(disablePorts).toEqual([mountPorts[0]!]);
    } finally {
      finishMount();
      finish();
      await boot;
    }
  });

  test('boot-mounted share is reconciled on the configured cadence, and shutdown clears the timer without changing per-port unmount', async () => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const mountPorts: number[] = [];
    const disablePorts: number[] = [];
    const intervalSpy = spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = spyOn(globalThis, 'clearInterval');
    const boot = runNexus({
      headless: true,
      skipHeadlessSetupCheckForTesting: true,
      headlessDoneForTesting: done,
      skipHttpServer: false,
      skipSupervisor: true,
      skipRuntimeApi: true,
      autoMountShare: true,
      shareCoordinatorIntervalMsForTesting: 15,
      mountShareIfEnabledFn: async ({ httpPort }) => {
        mountPorts.push(httpPort);
        return { outcome: 'serving', url: `https://host.tailnet.ts.net:${httpPort}/app/` };
      },
      pwaShareDisableFn: async ({ port } = {}) => {
        if (port !== undefined) disablePorts.push(port);
        return { exitCode: 0 };
      },
    });
    try {
      const deadline = Date.now() + 8_000;
      while (mountPorts.length < 2 && Date.now() < deadline) await Bun.sleep(5);
      expect(mountPorts.length).toBeGreaterThanOrEqual(2);
    } finally {
      finish();
      await boot;
    }
    try {
      const shareTimer = intervalSpy.mock.results.find((_result, index) =>
        intervalSpy.mock.calls[index]?.[1] === 15)?.value;
      expect(shareTimer).toBeDefined();
      expect(clearIntervalSpy.mock.calls.some(([timer]) => timer === shareTimer)).toBe(true);
    } finally {
      clearIntervalSpy.mockRestore();
      intervalSpy.mockRestore();
    }
    expect(disablePorts).toEqual([mountPorts[0]!]);
    const callsAfterExit = mountPorts.length;
    await Bun.sleep(50);
    expect(mountPorts).toHaveLength(callsAfterExit);
  }, 15_000);

  test('pwaShareDisable failure is announced and does not block clean exit', async () => {
    const { disableCalls } = await runHeadlessShareLifecycle({
      mount: { outcome: 'serving', url: 'https://mbp.tailnet.ts.net:31415/app/' },
      disable: async () => {
        throw new Error('tailscale serve unmount exploded');
      },
    });
    expect(disableCalls).toHaveLength(1);
  });
});

describe('runNexus · fallback signal share unmount', () => {
  let stateRoot: string;
  let previousExit: typeof process.exit;
  let previousSigterm: Array<(...args: unknown[]) => void>;
  let previousSigint: Array<(...args: unknown[]) => void>;
  let previousIsTty: PropertyDescriptor | undefined;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-fallback-unmount-'));
    setTestStateRoot(stateRoot);
    previousExit = process.exit;
    previousSigterm = process.listeners('SIGTERM').slice() as Array<(...args: unknown[]) => void>;
    previousSigint = process.listeners('SIGINT').slice() as Array<(...args: unknown[]) => void>;
    previousIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  });

  afterEach(() => {
    process.exit = previousExit;
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    for (const listener of previousSigterm) process.on('SIGTERM', listener as never);
    for (const listener of previousSigint) process.on('SIGINT', listener as never);
    if (previousIsTty) Object.defineProperty(process.stdin, 'isTTY', previousIsTty);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    setTestStateRoot(null);
    rmSync(stateRoot, { recursive: true, force: true });
  });

  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 8_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await Bun.sleep(10);
    }
  }

  async function runFallbackShareLifecycle(args: {
    signal: 'SIGTERM' | 'SIGINT';
    mount: ShareMountResult;
    disable?: (deps: PwaShareDeps) => Promise<PwaShareResult>;
  }): Promise<{ disableCalls: PwaShareDeps[]; mountedPort?: number; completed: boolean; exitCodes: number[] }> {
    const disableCalls: PwaShareDeps[] = [];
    const mountPorts: number[] = [];
    const exitCodes: number[] = [];
    let mountedPort: number | undefined;
    let observed!: () => void;
    const mounted = new Promise<void>((resolve) => { observed = resolve; });
    process.exit = ((code?: number) => {
      exitCodes.push(code ?? 0);
      return undefined as never;
    }) as typeof process.exit;
    const boot = runNexus({
      headless: false,
      autoMountShare: true,
      skipHttpServer: false,
      skipSupervisor: true,
      skipRuntimeApi: true,
      skipPushcutChannel: true,
      skipPwaChannel: true,
      skipTelegramChannel: true,
      skipTerminalChannel: true,
      skipDiscordChannel: true,
      skipIntentPrediction: true,
      skipEnvMigration: true,
      skipRestoreFromPending: true,
      registerDaemonTab: false,
      registerSettingsTab: false,
      mcpEnabled: false,
      shareCoordinatorIntervalMsForTesting: 15,
      mountShareIfEnabledFn: async ({ httpPort }) => {
        mountPorts.push(httpPort);
        mountedPort = httpPort;
        observed();
        return args.mount;
      },
      pwaShareDisableFn: async (deps: PwaShareDeps = {}) => {
        disableCalls.push(deps);
        if (args.disable) return args.disable(deps);
        return { exitCode: 0 };
      },
    });
    await mounted;
    await waitFor(
      () => process.listeners(args.signal).some((listener) => listener.name === (args.signal === 'SIGTERM' ? 'onSigterm' : 'onSigint')),
      `${args.signal} handler`,
    );
    await waitFor(() => mountPorts.length >= 2, 'share reconciliation tick');
    const nexusSignalHandler = process.listeners(args.signal).find((listener) =>
      listener.name === (args.signal === 'SIGTERM' ? 'onSigterm' : 'onSigint'));
    expect(nexusSignalHandler).toBeDefined();
    (nexusSignalHandler as () => void)();
    await boot;
    const callsAfterExit = mountPorts.length;
    await Bun.sleep(50);
    expect(mountPorts).toHaveLength(callsAfterExit);
    expect(process.listeners(args.signal)).not.toContain(nexusSignalHandler);
    return {
      disableCalls,
      completed: true,
      exitCodes,
      ...(mountedPort !== undefined ? { mountedPort } : {}),
    };
  }

  test('fallback SIGTERM walks the auto-mounted daemon port exactly once', async () => {
    const { disableCalls, mountedPort, completed, exitCodes } = await runFallbackShareLifecycle({
      signal: 'SIGTERM',
      mount: { outcome: 'serving', url: 'https://mbp.tailnet.ts.net:31415/app/' },
    });
    expect(completed).toBe(true);
    expect(disableCalls).toHaveLength(1);
    expect(disableCalls[0]?.port).toBe(mountedPort);
    expect(mountedPort).toBeGreaterThan(0);
    expect(exitCodes).toContain(75);
  });

  test('fallback SIGINT walks the auto-mounted daemon port exactly once', async () => {
    const { disableCalls, mountedPort, completed } = await runFallbackShareLifecycle({
      signal: 'SIGINT',
      mount: { outcome: 'serving', url: 'https://mbp.tailnet.ts.net:31415/app/' },
    });
    expect(completed).toBe(true);
    expect(disableCalls).toHaveLength(1);
    expect(disableCalls[0]?.port).toBe(mountedPort);
    expect(mountedPort).toBeGreaterThan(0);
  });

  test('fallback SIGTERM does not call pwaShareDisable when share was not mounted', async () => {
    const { disableCalls, completed } = await runFallbackShareLifecycle({
      signal: 'SIGTERM',
      mount: { outcome: 'skipped', reason: 'switch-disabled' },
    });
    expect(completed).toBe(true);
    expect(disableCalls).toHaveLength(0);
  });

  test('fallback SIGINT does not call pwaShareDisable when share was not mounted', async () => {
    const { disableCalls, completed } = await runFallbackShareLifecycle({
      signal: 'SIGINT',
      mount: { outcome: 'skipped', reason: 'switch-disabled' },
    });
    expect(completed).toBe(true);
    expect(disableCalls).toHaveLength(0);
  });

  test('fallback SIGTERM still completes when pwaShareDisable rejects', async () => {
    const { disableCalls, completed } = await runFallbackShareLifecycle({
      signal: 'SIGTERM',
      mount: { outcome: 'serving', url: 'https://mbp.tailnet.ts.net:31415/app/' },
      disable: async () => {
        throw new Error('tailscale serve unmount exploded');
      },
    });
    expect(completed).toBe(true);
    expect(disableCalls).toHaveLength(1);
  });

  test('fallback SIGINT still completes when pwaShareDisable rejects', async () => {
    const { disableCalls, completed } = await runFallbackShareLifecycle({
      signal: 'SIGINT',
      mount: { outcome: 'serving', url: 'https://mbp.tailnet.ts.net:31415/app/' },
      disable: async () => {
        throw new Error('tailscale serve unmount exploded');
      },
    });
    expect(completed).toBe(true);
    expect(disableCalls).toHaveLength(1);
  });
});

describe('runNexus · MCP handshake timeout wiring', () => {
  let stateRoot: string;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-mcp-timeout-'));
    setTestStateRoot(stateRoot);
  });

  afterEach(() => {
    setTestStateRoot(null);
    rmSync(stateRoot, { recursive: true, force: true });
  });

  test('runNexus initial boot and reload pass unset, global, and server override configuration to the registrar', async () => {
    const calls: Array<{ servers: import('../user-config.js').McpServerSpec[]; handshakeTimeoutMs?: number }> = [];
    let httpOpts: import('./api/http-server.js').NexusHttpServerOpts | undefined;
    const initial = {
      mcp: {
        handshakeTimeoutMs: 7_000,
        servers: [
          { id: 'global', transport: 'stdio', command: ['global'] },
          { id: 'override', transport: 'stdio', command: ['override'], handshakeTimeoutMs: 12_000 },
        ],
      },
    };
    const reloaded = {
      mcp: {
        servers: [{ id: 'default', transport: 'stdio', command: ['default'] }],
      },
    };
    const nexus = await runNexus({
      detachForTesting: true,
      skipHttpServer: false,
      skipSupervisor: true,
      skipRuntimeApi: true,
      skipPushcutChannel: true,
      skipPwaChannel: true,
      skipTelegramChannel: true,
      skipTerminalChannel: true,
      skipDiscordChannel: true,
      skipIntentPrediction: true,
      skipEnvMigration: true,
      skipRestoreFromPending: true,
      registerDaemonTab: false,
      registerSettingsTab: false,
      getMcpUserConfigForTesting: () => initial as never,
      reloadUserConfigForTesting: () => reloaded as never,
      registerMcpClientsFn: async (opts) => {
        calls.push({ servers: opts.servers, ...(opts.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: opts.handshakeTimeoutMs }) });
        return { clients: [], registered: 0, perServer: {}, shutdown: async () => {} };
      },
      startNexusHttpServerFn: ((opts: import('./api/http-server.js').NexusHttpServerOpts) => {
        httpOpts = opts;
        return { port: 31415, stop: () => {} } as never;
      }) as typeof import('./api/http-server.js').startNexusHttpServer,
    });
    if (!nexus) throw new Error('runNexus returned undefined');

    try {
      await Promise.resolve();
      expect(calls).toEqual([{
        handshakeTimeoutMs: 7_000,
        servers: [
          { id: 'global', transport: 'stdio', command: ['global'] },
          { id: 'override', transport: 'stdio', command: ['override'], handshakeTimeoutMs: 12_000 },
        ],
      }]);
      expect(httpOpts?.reloadMcpClients).toBeDefined();
      await httpOpts!.reloadMcpClients!();
      expect(calls[1]).toEqual({
        servers: [{ id: 'default', transport: 'stdio', command: ['default'] }],
      });
    } finally {
      await nexus.release();
    }
  }, 15_000);
});

describe('runNexus · scraps API wiring', () => {
  let stateRoot: string;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-scraps-wire-'));
    setTestStateRoot(stateRoot);
  });

  afterEach(() => {
    setTestStateRoot(null);
    rmSync(stateRoot, { recursive: true, force: true });
  });

  test('passes test-universe storage through the real Nexus HTTP startup and scraps route', async () => {
    let httpOpts: import('./api/http-server.js').NexusHttpServerOpts | undefined;
    const previousRedirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://example.test/v1/members/oauth/google/callback';
    const memberDb = createMemberStore({ path: join(stateRoot, 'nexus', 'members', 'members.sqlite') });
    const member = memberDb.register({ sub: 'nexus-scraps-startup-test', email: 'scraps-startup@example.test', emailVerified: true, name: 'Scraps Startup Test' }, {
      consents: { privacy: 'v1', terms: 'v1' },
    });
    const session = memberDb.createSession(member.id);
    memberDb.close();
    const nexus = await runNexus({
      detachForTesting: true,
      skipHttpServer: false,
      skipSupervisor: true,
      skipRuntimeApi: true,
      skipPushcutChannel: true,
      skipPwaChannel: true,
      skipTelegramChannel: true,
      skipTerminalChannel: true,
      skipDiscordChannel: true,
      skipIntentPrediction: true,
      skipEnvMigration: true,
      skipRestoreFromPending: true,
      registerDaemonTab: false,
      registerSettingsTab: false,
      startNexusHttpServerFn: ((opts: import('./api/http-server.js').NexusHttpServerOpts) => {
        httpOpts = opts;
        return startNexusHttpServer(opts);
      }) as typeof import('./api/http-server.js').startNexusHttpServer,
      httpStartPort: 48_000 + Math.floor(Math.random() * 2_000),
    });
    if (!nexus) throw new Error('runNexus returned undefined');

    try {
      expect(httpOpts?.scraps).toEqual({
        instanceRoot: join(stateRoot, 'nexus'),
        extractors: { digestWeb: expect.any(Function) },
      });
      if (!nexus.httpServer) throw new Error('Nexus HTTP server did not start');
      const response = await fetch(`${nexus.httpServer.url}/v1/scraps`, {
        method: 'POST',
        headers: { cookie: `__Host-elanous_member_session=${encodeURIComponent(session.token)}`, 'content-type': 'application/json', 'idempotency-key': 'nexus-startup-scraps-001' },
        body: JSON.stringify({ kind: 'text', source: 'tui', raw: { text: 'real startup test note' } }),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ memberId: member.id, status: 'absorbed' });
      expect(listAbsorbScraps(join(stateRoot, 'nexus'), member.id)).toHaveLength(1);
      const invalid = await fetch(`${nexus.httpServer.url}/v1/scraps`, {
        headers: { cookie: '__Host-elanous_member_session=invalid-session' },
      });
      expect(invalid.status).toBe(401);
    } finally {
      await nexus.release();
      if (previousRedirectUri === undefined) delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
      else process.env.GOOGLE_OAUTH_REDIRECT_URI = previousRedirectUri;
    }
  }, 15_000);
});

describe('runNexus · MCP widget server binding', () => {
  let stateRoot: string;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-widget-bind-'));
    setTestStateRoot(stateRoot);
  });

  afterEach(() => {
    setTestStateRoot(null);
    rmSync(stateRoot, { recursive: true, force: true });
  });

  async function boot(mcp: {
    servers: Array<{ id: string; command: string[] }>;
    widgetServerId?: string;
  }) {
    let captured: import('./api/http-server.js').NexusHttpServerOpts | undefined;
    const nexus = await runNexus({
      detachForTesting: true,
      skipHttpServer: false,
      mcpEnabled: false,
      skipSupervisor: true,
      skipRuntimeApi: true,
      skipPushcutChannel: true,
      skipPwaChannel: true,
      skipTelegramChannel: true,
      skipTerminalChannel: true,
      skipDiscordChannel: true,
      skipIntentPrediction: true,
      skipEnvMigration: true,
      skipRestoreFromPending: true,
      registerDaemonTab: false,
      registerSettingsTab: false,
      startNexusHttpServerFn: ((opts: import('./api/http-server.js').NexusHttpServerOpts) => {
        captured = opts;
        return { port: 31415, stop: () => {} } as never;
      }) as typeof import('./api/http-server.js').startNexusHttpServer,
      getMcpUserConfigForTesting: () => ({ mcp } as never),
      registerMcpClientsFn: async () => ({
        clients: [],
        registered: 0,
        perServer: {},
        shutdown: async () => {},
      }),
    });
    if (!nexus) throw new Error('runNexus returned undefined');
    return { nexus, captured };
  }

  test('passes getMcpWidgetServerId only when widgetServerId names a configured server', async () => {
    const { nexus, captured } = await boot({
      widgetServerId: 'xcodebuild',
      servers: [
        { id: 'xcode', command: ['xcrun', 'mcpbridge'] },
        { id: 'xcodebuild', command: ['xcodebuildmcp', 'mcp'] },
        { id: 'higgsfield', command: ['higgsfield'] },
      ],
    });
    try {
      expect(captured?.getMcpWidgetServerId).toBeDefined();
      expect(captured?.getMcpWidgetServerId?.(new Request('http://nexus.test/v1/mcp/widgets/call'))).toBe('xcodebuild');
    } finally {
      await nexus.release();
    }
  }, 15_000);

  test('omits getMcpWidgetServerId when widgetServerId is absent so the sole-ready fallback stays in charge', async () => {
    const { nexus, captured } = await boot({
      servers: [
        { id: 'xcodebuild', command: ['xcodebuildmcp', 'mcp'] },
        { id: 'higgsfield', command: ['higgsfield'] },
      ],
    });
    try {
      expect(captured?.getMcpWidgetServerId).toBeUndefined();
    } finally {
      await nexus.release();
    }
  }, 15_000);

  test('omits getMcpWidgetServerId when widgetServerId is not in mcp.servers', async () => {
    const { nexus, captured } = await boot({
      widgetServerId: 'ghost',
      servers: [
        { id: 'xcodebuild', command: ['xcodebuildmcp', 'mcp'] },
        { id: 'higgsfield', command: ['higgsfield'] },
      ],
    });
    try {
      expect(captured?.getMcpWidgetServerId).toBeUndefined();
    } finally {
      await nexus.release();
    }
  }, 15_000);
});

test('NEXUS boot prunes 30-day error reports without a receipt and arms a daily tick', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-er-prune-'));
  let nexus: Awaited<ReturnType<typeof runNexus>>;
  let tick = () => {};
  let interval = 0;
  try {
    setElanousConfigDir(root);
    setTestStateRoot(root);
    const now = new Date();
    const dayDir = (daysAgo: number) => {
      const at = new Date(now.getTime() - daysAgo * 86_400_000);
      const dir = join(root, 'error-reports', String(at.getUTCFullYear()), String(at.getUTCMonth() + 1).padStart(2, '0'), String(at.getUTCDate()).padStart(2, '0'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'er_x.json'), '{}');
      return dir;
    };
    const old = dayDir(40);
    const recent = dayDir(3);
    nexus = await runNexus({ detachForTesting: true, skipHttpServer: true, skipRuntimeApi: true,
      skipSupervisor: true, mcpEnabled: false, skipRestoreFromPending: true, toolCwd: root,
      cleanGhostTailscaleServeFn: async () => {},
      errorReportPruneScheduleForTesting: (fn, ms) => { tick = fn; interval = ms; return {}; } });
    if (!nexus) throw new Error('NEXUS failed to start');
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(interval).toBe(86_400_000);
    const later = dayDir(45);
    tick();
    expect(existsSync(later)).toBe(false);
  } finally {
    nexus?.release();
    resetElanousConfigDir();
    setTestStateRoot(null);
    rmSync(root, { recursive: true, force: true });
  }
});

function parseDaemonThinInventory(markdown: string): {
  stay: Array<{ id: string; fileFunction: string; allowlistClass: DaemonThinStayAllowlistClass }>;
  leave: Array<{ id: string; fileFunction: string; why: string }>;
  removalOrder: string[];
} {
  const stay: Array<{ id: string; fileFunction: string; allowlistClass: DaemonThinStayAllowlistClass }> = [];
  const leave: Array<{ id: string; fileFunction: string; why: string }> = [];
  const removalOrder: string[] = [];
  const allowlist = new Set<string>(DAEMON_THIN_STAY_ALLOWLIST);
  let section: 'stay' | 'leave' | 'removalOrder' | null = null;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (line === '## stay') { section = 'stay'; continue; }
    if (line === '## leave') { section = 'leave'; continue; }
    if (line === '## removalOrder') { section = 'removalOrder'; continue; }
    if (!line || line.startsWith('#')) continue;
    if (section === 'stay') {
      const [id, fileFunction, allowlistClass] = line.split(' | ').map((part) => part.trim());
      if (!allowlist.has(allowlistClass)) throw new Error(`stay allowlist class not in allowlist: ${allowlistClass}`);
      stay.push({ id, fileFunction, allowlistClass: allowlistClass as DaemonThinStayAllowlistClass });
    } else if (section === 'leave') {
      const [id, fileFunction, why] = line.split(' | ').map((part) => part.trim());
      leave.push({ id, fileFunction, why });
    } else if (section === 'removalOrder') {
      removalOrder.push(line);
    }
  }
  return { stay, leave, removalOrder };
}

describe('daemonThinStage1 matches src/nexus/daemon-thin-inventory.md', () => {
  const inventory = parseDaemonThinInventory(readFileSync(join(import.meta.dir, 'daemon-thin-inventory.md'), 'utf8'));
  const encoded = daemonThinStage1();
  const allowlist = new Set<string>(DAEMON_THIN_STAY_ALLOWLIST);

  test('encodes the stay list, leave list, and removalOrder already written in the markdown', () => {
    expect([...encoded.stay]).toEqual(inventory.stay.map((row) => ({
      id: row.id, fileFunction: row.fileFunction, allowlistClass: row.allowlistClass,
    })));
    expect([...encoded.leave]).toEqual(inventory.leave.map((row) => ({
      id: row.id, fileFunction: row.fileFunction, why: row.why,
    })));
    expect([...encoded.removalOrder]).toEqual(inventory.removalOrder);
  });

  test('every stay entry is in the allowlist HTTP, PWA, dispatch/발송, SSE, cards', () => {
    expect(encoded.stay.length).toBeGreaterThan(0);
    for (const entry of encoded.stay) {
      expect(allowlist.has(entry.allowlistClass)).toBe(true);
    }
  });

  test('every leave entry is outside that allowlist', () => {
    expect(encoded.leave.length).toBeGreaterThan(0);
    for (const entry of encoded.leave) {
      expect(allowlist.has(entry.why.split(/[;·]/)[0]!.trim())).toBe(false);
    }
  });

  test('judgment, agent loop, and harness are leave when the measurement found them', () => {
    const leaveIds = new Set(encoded.leave.map((entry) => entry.id));
    expect(leaveIds.has('executor')).toBe(true);
    expect(leaveIds.has('agent-loop')).toBe(true);
    expect(leaveIds.has('harness')).toBe(true);
    expect(encoded.leave.find((entry) => entry.id === 'executor')?.why).toMatch(/judgment/);
    expect(encoded.leave.find((entry) => entry.id === 'agent-loop')?.why).toMatch(/agent loop/i);
    expect(encoded.leave.find((entry) => entry.id === 'harness')?.why).toMatch(/harness/);
  });

  test('removalOrder lists each leave id once and no stay id', () => {
    const leaveIds = encoded.leave.map((entry) => entry.id);
    const stayIds = new Set(encoded.stay.map((entry) => entry.id));
    expect([...encoded.removalOrder].sort()).toEqual([...leaveIds].sort());
    expect(new Set(encoded.removalOrder).size).toBe(encoded.removalOrder.length);
    for (const id of encoded.removalOrder) {
      expect(stayIds.has(id)).toBe(false);
    }
  });

  test('intentional wiring boundary: runNexus source does not call daemonThinStage1', () => {
    const source = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8');
    const runNexusBody = source.slice(source.indexOf('export async function runNexus'));
    expect(runNexusBody).not.toMatch(/\bdaemonThinStage1\s*\(/);
  });
});
