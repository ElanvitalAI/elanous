import { expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { assembleWarmPoolProviderConfig, fetchMachinePoolDeclarationsFromNexus } from '../../scripts/warm-pool-provider-config.js';
import { createNexusState } from '../nexus/state/state.js';
import { TabRegistry } from '../nexus/state/tab-registry.js';
import { NexusEventBus } from '../nexus/api/event-bus.js';
import { routeRequest, startNexusHttpServer, type NexusHttpServerOpts } from '../nexus/api/http-server.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';
import { issueMemberToken, MEMBER_TOKEN_TTL_MS, revokeMemberToken } from '../control-plane/member-tokens.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { createAppLifecycleEvent } from '../nexus/apps/app-lifecycle-ledger.js';
import { loadNexusAppHost } from '../nexus/apps/app-host.js';
import { createJsonlMemberEventStore } from '../nexus/api/member-event-store.js';
import type { MachinePoolDeclaration } from '../resource-ledger/machine-pool-inventory.js';
import { FAKE_MEMBER_OIDC_REDIRECT_URI, createFakeMemberOidcWorld } from './fake-member-oidc-world.js';
import { withSimClock } from './fake-clock.js';

const pool: MachinePoolDeclaration = {
  purpose: 'gate',
  members: [{ host: 'cloud-vm-a', count: 1, digest: 'sha256:' + 'a'.repeat(64), role: 'both' }],
  fanoutGroupId: 'fake-member-oidc-world-gate',
  fanoutGroup: { shard: { kind: 'gate', input: 'gate-input', result: 'gate-result', fingerprint: 'gate-fp' } },
  fingerprint: { runtime: 'bun-linux', environment: 'fake-public-vm', skillPacks: [] },
  cleanup: { procedure: 'delete fake pod', verify: 'fake pod absent' },
};

test('KAIST-SIGNUP-APP-SLOT: fake Google signup creates one isolated app slot and reuses the #36200 member-key flow', async () => {
  const world = createFakeMemberOidcWorld({ now: () => Date.parse('2026-11-14T01:00:00.000Z') });
  world.memberStore.provisionEventCode({ code: 'KAIST-2026', maxUses: 2 }); // Source: #36200 member fixture exercises two concurrent signups.
  try {
    const starts = await Promise.all([1, 2].map(() => world.membersApi.handle(new Request('https://members.example.test/v1/members', {
      method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ consents: { privacy: 'privacy-v1', terms: 'terms-v1' }, eventCode: 'KAIST-2026' }),
    }), '203.0.113.41')));
    expect(starts.every(response => response?.status === 201)).toBe(true);
    const pending = await Promise.all(starts.map(async response => {
      const { authorizationUrl } = await response!.json() as { authorizationUrl: string };
      return { ...world.googleWorld.authorize(authorizationUrl), stateCookie: response!.headers.get('set-cookie')!.split(';', 1)[0]! };
    }));
    const sessions = await Promise.all([...pending].reverse().map(async authorization => {
      const callback = await world.membersApi.handle(new Request(
        `${FAKE_MEMBER_OIDC_REDIRECT_URI}?code=${authorization.code}&state=${authorization.state}`,
        { headers: { cookie: authorization.stateCookie } },
      ));
      expect(callback?.status).toBe(200);
      return callback!.headers.get('set-cookie')!.split(';', 1)[0]!;
    }));
    const members = await Promise.all(sessions.map(async sessionCookie => {
      const profile = await world.membersApi.handle(new Request('https://members.example.test/v1/members', {
        headers: { cookie: sessionCookie, origin: 'https://app.example.test' },
      }));
      expect(profile?.status).toBe(200);
      return { sessionCookie, member: (await profile!.json() as { member: { id: string; email: string; eventCode: string } }).member };
    }));
    expect(members.map(row => row.member.email)).toEqual(['member-2@example.test', 'member-1@example.test']);
    expect(members.every(row => row.member.eventCode === 'KAIST-2026')).toBe(true);
    const slots = members.map(row => world.memberStore.appSlotForMember(row.member.id)!);
    expect(new Set(slots.map(slot => slot.appId)).size).toBe(2);
    for (const slot of slots) expect(world.appLifecycle.view(slot.appId)).toMatchObject({
      snapshot: { appId: slot.appId, status: 'draft', eventCount: 1 },
    });

    const firstMember = members[0]!;
    world.memberStore.provisionPlan({ plan: 'founding-sim', entitlements: { 'app.publish': true } });
    expect(world.memberStore.assignPlan(firstMember.member.id, 'founding-sim')).toBe(true);
    expect(world.memberStore.memberPlanForMember(firstMember.member.id)).toEqual({
      plan: 'founding-sim', entitlements: { 'app.publish': true },
    });

    const duplicateSlot = await world.membersApi.handle(new Request('https://members.example.test/v1/members/app-slot', {
      method: 'POST', headers: { cookie: firstMember.sessionCookie, origin: 'https://app.example.test' },
    }));
    expect(duplicateSlot?.status).toBe(409);
    expect((await duplicateSlot!.json()).error).toBe('app-slot-already-exists');

    const createdKey = await world.membersApi.handle(new Request('https://members.example.test/v1/member/keys', {
      method: 'POST', headers: { cookie: firstMember.sessionCookie, origin: 'https://app.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'sim-device' }),
    }));
    expect(createdKey?.status).toBe(201);
    const key = await createdKey!.json() as { id: string; key: string };
    expect(key.key).toMatch(/^emk_/);
    expect(world.memberStore.memberForKey(key.key)?.memberId).toBe(firstMember.member.id);
    const revokedKey = await world.membersApi.handle(new Request(`https://members.example.test/v1/member/keys/${key.id}`, {
      method: 'DELETE', headers: { cookie: firstMember.sessionCookie, origin: 'https://app.example.test' },
    }));
    expect(revokedKey?.status).toBe(200);
    expect(world.memberStore.memberForKey(key.key)).toBeNull();

    world.appLifecycle.ensureCreated(createAppLifecycleEvent({ appId: slots[0]!.templateSlug, action: 'created',
      environment: 'simulation', actor: 'system', appVersion: 'template-v1', appFingerprint: 'b'.repeat(64) }));
    expect(world.appLifecycle.view(slots[0]!.templateSlug).events).toHaveLength(1);
    expect(world.appLifecycle.view(slots[0]!.appId).events).toHaveLength(1);
  } finally { world.close(); }
});

test('fake-member-oidc-world test Nexus issues a real app-slot bearer that authorizes the board route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fake-member-oidc-test-nexus-'));
  const appsDir = join(root, 'apps');
  mkdirSync(appsDir);
  let nowMs = Date.parse('2026-11-14T01:00:00.000Z');
  const now = () => nowMs;
  let loaded: ReturnType<typeof loadNexusAppHost> | undefined;
  const world = createFakeMemberOidcWorld({
    now,
    testOnlyNexus: {
      phase: 'test',
      appHost: () => loaded?.appHost,
      publicUserSlug: 'kaist-test-owner',
    },
  });
  const boardEventStore = createJsonlMemberEventStore(join(root, 'member-events'));
  world.memberStore.provisionEventCode({ code: 'KAIST-IPHONE-SIM', maxUses: 1 }); // Source: #36518 — the fixture exercises a one-use event code.
  const state = createNexusState({ nexusVersion: 'sim', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  let nexus: ReturnType<typeof startNexusHttpServer> | undefined;
  try {
    loaded = loadNexusAppHost(appsDir, undefined, {
      dir: join(root, 'app-auth'), databaseDirectory: join(root, 'app-databases'),
      key: 'fake-member-test-nexus-signing-key-with-256-bits', now,
    });
    expect(loaded.issues).toEqual([]);
    const opts = { state, registry: new TabRegistry(state), eventBus, membersApi: world.membersApi,
      boardEventStore, appHost: loaded.appHost } as NexusHttpServerOpts;
    nexus = startNexusHttpServer({ ...opts, startPort: uniquePort(), portRange: 1 });
    const browserCookies = new Map<string, { value: string; secure: boolean; httpOnly: boolean; sameSite: string; path: string }>();
    const browserFetch = async (path: string, init: RequestInit = {}) => {
      const requestUrl = new URL(path, nexus!.url);
      const headers = new Headers(init.headers);
      const credentials = init.credentials ?? 'same-origin';
      if (credentials === 'include' || (credentials === 'same-origin' && requestUrl.origin === new URL(nexus!.url).origin)) {
        const cookies = [...browserCookies].filter(([, cookie]) => !cookie.secure || requestUrl.protocol === 'https:' || ['localhost', '127.0.0.1', '::1'].includes(requestUrl.hostname));
        if (cookies.length) headers.set('cookie', cookies.map(([name, cookie]) => `${name}=${cookie.value}`).join('; '));
      }
      const response = await fetch(requestUrl, { ...init, headers });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) {
        const [pair, ...attributes] = setCookie.split(';');
        const separator = pair!.indexOf('=');
        const name = pair!.slice(0, separator);
        const value = pair!.slice(separator + 1);
        if (attributes.some(attribute => /^\s*max-age=0\s*$/i.test(attribute))) browserCookies.delete(name);
        else browserCookies.set(name, {
          value,
          secure: attributes.some(attribute => /^\s*secure\s*$/i.test(attribute)),
          httpOnly: attributes.some(attribute => /^\s*httponly\s*$/i.test(attribute)),
          sameSite: attributes.find(attribute => /^\s*samesite=/i.test(attribute))?.split('=')[1]?.trim() ?? '',
          path: attributes.find(attribute => /^\s*path=/i.test(attribute))?.split('=')[1]?.trim() ?? '',
        });
      }
      return response;
    };

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const signupPage = await browserFetch(`/v1/members?flow=app-login&appRedirectUri=${encodeURIComponent('elanous://auth/callback')}&appCodeChallenge=${encodeURIComponent(challenge)}`);
    expect(signupPage.status).toBe(200);
    expect(signupPage.headers.get('content-type')).toContain('text/html');
    expect(signupPage.headers.get('content-security-policy')).toContain("script-src 'nonce-");
    const signupHtml = await signupPage.text();
    expect(signupHtml).toContain("fetch('/v1/members'");
    expect(signupHtml).toContain("credentials:'include'");
    const script = /<script nonce="([^"]+)">([\s\S]*?)<\/script>/.exec(signupHtml);
    expect(script?.[1]).toBeTruthy();
    expect(signupPage.headers.get('content-security-policy')).toContain(`script-src 'nonce-${script![1]}'`);
    let submit: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
    let authorizationUrlFromPage = '';
    let browserSignupStartResponse: Response | undefined;
    const status = { textContent: '' };
    const pageLocation = { search: new URL(signupPage.url).search, replace: (url: string) => { authorizationUrlFromPage = url; } };
    runInNewContext(script![2]!, {
      document: { getElementById: (id: string) => id === 'member-login' ? { addEventListener: (_name: string, listener: typeof submit) => { submit = listener; } } : status },
      FormData: class { get(name: string) { return ({ privacy: 'on', terms: 'on', eventCode: 'KAIST-IPHONE-SIM' } as Record<string, string>)[name] ?? null; } },
      URLSearchParams,
      fetch: async (url: string, init: RequestInit) => {
        const response = await browserFetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), origin: new URL(nexus!.url).origin } });
        if (new URL(url, nexus!.url).pathname === '/v1/members' && init.method === 'POST') browserSignupStartResponse = response;
        return response;
      },
      location: pageLocation,
      JSON,
    });
    expect(submit).toBeTypeOf('function');
    await submit!({ preventDefault() {} });
    expect(status.textContent).toBe('Google 로그인으로 이동합니다…');
    expect(authorizationUrlFromPage).toMatch(/^https:\/\//);
    const started = browserSignupStartResponse!;
    expect(started.status).toBe(201);
    expect(browserCookies.size).toBe(1);
    const stateCookie = [...browserCookies.values()][0]!;
    expect(stateCookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax', path: '/' });
    const authorizationUrl = authorizationUrlFromPage;
    const authorizationUrlParts = new URL(authorizationUrl);
    expect(authorizationUrlParts.searchParams.get('response_type')).toBe('code');
    expect(authorizationUrlParts.searchParams.get('redirect_uri')).toBe(FAKE_MEMBER_OIDC_REDIRECT_URI);
    expect(authorizationUrlParts.searchParams.get('state')).toBeTruthy();
    expect(authorizationUrlParts.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizationUrlParts.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrlParts.searchParams.has('nonce')).toBe(false);
    const authorization = world.googleWorld.authorize(authorizationUrl);
    const callback = await browserFetch(`${new URL(FAKE_MEMBER_OIDC_REDIRECT_URI).pathname}?code=${encodeURIComponent(authorization.code)}&state=${encodeURIComponent(authorization.state)}`, { redirect: 'manual' });
    expect(callback.status).toBe(303);
    const callbackUrl = new URL(callback.headers.get('location')!);
    expect(callbackUrl.protocol).toBe('elanous:');
    expect(callbackUrl.host).toBe('auth');
    expect(callbackUrl.pathname).toBe('/callback');
    const replayedCallback = await browserFetch(`${new URL(FAKE_MEMBER_OIDC_REDIRECT_URI).pathname}?code=${encodeURIComponent(authorization.code)}&state=${encodeURIComponent(authorization.state)}`, { redirect: 'manual' });
    expect(replayedCallback.status).toBe(401);
    const code = callbackUrl.searchParams.get('code')!;
    expect(callbackUrl.searchParams.get('state')).toBe(authorization.state);

    const member = world.memberStore.memberForGoogleSub('fake-google-member-1');
    expect(member).not.toBeNull();
    const slot = world.memberStore.appSlotForMember(member!.id)!;
    expect(slot).toBeDefined();
    const appDir = join(appsDir, slot.appSlug);
    const outDir = join(appDir, 'out');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(appDir, 'app.yaml'), `apiVersion: elanous.app/v0\nslug: ${slot.appSlug}\ntitle: Test member app\nfrontend:\n  kind: static-export\n  out: out\nroles:\n  owner: { via: nexus-session }\n  member: { via: share-link }\n`);
    writeFileSync(join(outDir, 'index.html'), '<main>test member app</main>');
    loaded.appHost.mountDirectory(slot.appSlug);

    const exchanged = await fetch(`${nexus.url}/v1/members/app-slot/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, state: authorization.state, codeVerifier: verifier }),
    });
    expect(exchanged.status).toBe(200);
    const session = await exchanged.json() as { appId: string; sessionToken: string; tokenType: string; expiresAt: string };
    expect(session).toMatchObject({ appId: slot.appId, tokenType: 'Bearer' });
    expect(session.sessionToken).toMatch(/^aps_/);
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(nowMs);
    const replayedExchange = await fetch(`${nexus.url}/v1/members/app-slot/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, state: authorization.state, codeVerifier: verifier }),
    });
    expect(replayedExchange.status).toBe(401);
    const verified = await fetch(`${nexus.url}/v1/members/owner?appSlug=${encodeURIComponent(slot.appSlug)}`, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ memberId: member!.id, userSlug: 'kaist-test-owner', plan: 'free' });

    const untrustedWorld = createFakeMemberOidcWorld({ now });
    try {
      const untrusted = await untrustedWorld.membersApi.handle(new Request(`https://members.example.test/v1/members/owner?appSlug=${slot.appSlug}`, {
        headers: { authorization: `Bearer ${session.sessionToken}` },
      }));
      expect(untrusted?.status).toBe(401);
    } finally { untrustedWorld.close(); }

    await boardEventStore.append({ type: 'board.card', cardId: 'fake-iphone-card', memberId: member!.id,
      state: 'suggested', title: 'Fake member board', at: new Date(now()).toISOString() });
    const board = await fetch(`${nexus.url}/v1/board`, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(board.status).toBe(200);
    expect(await board.json()).toMatchObject({ cards: [{ id: 'fake-iphone-card', memberId: member!.id }] });

    const anonymous = await fetch(`${nexus.url}/v1/board`);
    expect(anonymous.status).toBe(401);
  } finally {
    nexus?.stop();
    loaded?.appHost.close();
    world.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('RESOURCE-LEDGER-PUBLIC-AUTH: tailnet-free HTTPS VM reads only its pool through Nexus and builds its provider', async () => {
  await withSimClock(Date.parse('2026-11-10T00:00:00.000Z'), async clock => {
  const root = mkdtempSync(join(tmpdir(), 'fake-member-oidc-public-ledger-'));
  setElanousConfigDir(root);
  const ownerToken = 'fake-owner-token';
  const hostToken = issueMemberToken('cloud-vm-a');
  const otherHostToken = issueMemberToken('cloud-vm-b');
  const state = createNexusState({ nexusVersion: 'sim', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const opts = { state, registry: new TabRegistry(state), eventBus,
    metaApi: { bearerToken: ownerToken, noAuth: false } } as NexusHttpServerOpts;
  const server = { requestIP: () => ({ address: '127.0.0.1' }) } as never;
  const calls: Array<{ url: string; authorization: string | null; redirect: RequestInit['redirect'] }> = [];
  const simulatedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, authorization: request.headers.get('authorization'), redirect: init?.redirect });
    return await routeRequest(request, opts, server, null, createDevProxyRuntimeRef()) ?? new Response('Not Found', { status: 404 });
  }, { preconnect: fetch.preconnect });
  try {
    const declaration = await simulatedFetch('https://nexus.example.test/v1/resource-ledger/pools', {
      method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pool }),
    });
    expect(declaration.status).toBe(201);

    const publicUrl = 'https://nexus.example.test/v1/resource-ledger/pools';
    const pools = await fetchMachinePoolDeclarationsFromNexus(publicUrl, hostToken, simulatedFetch);
    expect(pools).toEqual([pool]);
    expect(calls.at(-1)).toEqual({ url: publicUrl, authorization: `Bearer ${hostToken}`, redirect: 'error' });
    expect(await fetchMachinePoolDeclarationsFromNexus(publicUrl, otherHostToken, simulatedFetch)).toEqual([]);
    expect((await simulatedFetch(publicUrl)).status).toBe(401);

    const provider = assembleWarmPoolProviderConfig({
      config: { pod: { warmPoolProfile: 'gate', warmPool: { namespace: 'sim', imageRepository: 'registry.example/elanous',
        imageDigest: pool.members[0]!.digest, baseImageDigest: 'sha256:' + 'f'.repeat(64), lockHash: 'c'.repeat(64),
        architecture: 'amd64', hostProbeUrl: 'http://127.0.0.1:10001/health', prodProbeUrl: 'http://core.elanous-prod:10002/',
        sourceUrl: 'https://github.com/ElanvitalAI/elanous.git', templates: [{ host: 'cloud-vm-a', tier: 'standard', nodeName: 'cloud-vm-a-node' }] } },
        harness: { imageCommit: 'd'.repeat(40), podPool: 'cloud-vm-a-context' } },
      controlUrl: 'https://control.example.test:8413', memberToken: 'f'.repeat(64),
      machineTokens: { 'cloud-vm-a': hostToken }, machinePools: pools,
    });
    expect(provider.poolTemplates).toHaveLength(1);
    expect(provider.poolTemplates[0]).toMatchObject({ host: 'cloud-vm-a', slotCount: 1 });

    const expiringToken = issueMemberToken('cloud-vm-expiring');
    const expiresAt = clock.now() + MEMBER_TOKEN_TTL_MS;
    clock.setTime(expiresAt - 1);
    expect((await simulatedFetch(publicUrl, { headers: { authorization: `Bearer ${expiringToken}` } })).status).toBe(200);
    clock.setTime(expiresAt);
    expect((await simulatedFetch(publicUrl, { headers: { authorization: `Bearer ${expiringToken}` } })).status).toBe(401);
    await expect(fetchMachinePoolDeclarationsFromNexus(publicUrl, expiringToken, simulatedFetch))
      .rejects.toThrow('Nexus resource-ledger request failed: HTTP 401');

    const revocableToken = issueMemberToken('cloud-vm-revocable');
    expect((await simulatedFetch(publicUrl, { headers: { authorization: `Bearer ${revocableToken}` } })).status).toBe(200);
    revokeMemberToken('cloud-vm-revocable');
    expect((await simulatedFetch(publicUrl, { headers: { authorization: `Bearer ${revocableToken}` } })).status).toBe(401);
    const callsBeforeHttpReject = calls.length;
    await expect(fetchMachinePoolDeclarationsFromNexus('http://public-nexus.example/v1/resource-ledger/pools', otherHostToken, simulatedFetch))
      .rejects.toThrow('must use HTTPS outside loopback or tailnet');
    expect(calls).toHaveLength(callsBeforeHttpReject);
  } finally {
    revokeMemberToken('cloud-vm-b');
    revokeMemberToken('cloud-vm-revocable');
    revokeMemberToken('cloud-vm-expiring');
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
  });
});

function uniquePort(): number {
  return 43000 + Math.floor(Math.random() * 2000); // Source: same ephemeral test-server range as src/nexus/api/http-server.test.ts#uniquePort.
}
