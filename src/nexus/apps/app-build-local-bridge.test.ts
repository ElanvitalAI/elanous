import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppBuildLocalIssuerBridge, OFFICIAL_MEMBER_ORIGIN, readLocalAppBuildIssuer } from './app-build-local-bridge.js';
import { createAppBuildRunAuthority } from './app-build-run-authority.js';
import { createDynamicAppPublisher, createDynamicAppPublishRoute, useVerifiedMemberIssuer } from './dynamic-app-publish.js';
import type { NexusAppHost } from './app-host.js';
import { getAuthPeerAddress, registerAuthPeerAddress } from '../api/meta-api.js';
import { routeRequest, type NexusHttpServerOpts } from '../api/http-server.js';
import { createDevProxyRuntimeRef } from '../api/admin-dev-proxy.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const head = 'a'.repeat(40);
test('issuer mode derives from the complete test identity, not expiry alone', () => {
  expect(useVerifiedMemberIssuer({})).toBe(true);
  expect(useVerifiedMemberIssuer({ testApprovalExpiresAt: '2099-01-01T00:00:00Z' })).toBe(true);
  expect(useVerifiedMemberIssuer({ testMemberId: 'member-a' })).toBe(false);
  expect(useVerifiedMemberIssuer({ testHandle: 'handle-a' })).toBe(false);
  expect(useVerifiedMemberIssuer({ testMemberId: 'member-a', testHandle: 'handle-a' })).toBe(false);
});
function setup(expired = false, mode: 'test' | 'member' | 'none' | 'partial' = 'test', missingExpiry = false,
  now?: () => number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-issuer-'))); roots.push(root);
  const sources = join(root, 'sources'); const seals = join(root, 'seals'); const runtime = join(root, 'runtime');
  for (const path of [sources, seals, runtime]) mkdirSync(path, { mode: 0o700 });
  const owner = { memberId: 'synthetic-owner', userSlug: 'syntheticowner' };
  let receipt = { ...owner }; let available = true;
  const sent: Array<{ url: string; auth: string | null }> = [];
  const session = { nexusUrl: OFFICIAL_MEMBER_ORIGIN, sessionToken: 'aps_synthetic_sdk', appSlug: 'synthetic-app' };
  const publisherOptions = { sourceRoot: sources, sealRoot: seals, runtimeRoot: runtime,
    appHost: {} as NexusAppHost,
    ...(mode === 'test' ? { testMemberId: owner.memberId, testHandle: owner.userSlug }
      : mode === 'partial' ? { testMemberId: owner.memberId } : {}),
    ...(mode === 'member' ? { verifiedMemberIssuer: true, issuerClaimKey: 'b'.repeat(64) } : {}),
    testApprovalExpiresAt: missingExpiry ? undefined
      : expired ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z', issuerSourceHead: head,
    approveArtifact: () => false, now };
  const publisher = createDynamicAppPublisher(publisherOptions);
  const options = { publisher, sourceHead: head, getSession: () => available ? session : undefined,
    peerAddress: getAuthPeerAddress,
    authorizeControl: (request: Request) => request.headers.get('authorization') === 'Bearer synthetic-local-control',
    fetcher: (async (url, init) => { sent.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      return Response.json(receipt); }) as typeof fetch };
  const bridge = createAppBuildLocalIssuerBridge(options);
  const request = (action = 'reserve', headers: Record<string, string> = {}, origin = 'http://127.0.0.1:31415',
    runId = 'synthetic-run') => {
    const candidate = new Request(origin + '/v1/apps/synthetic-app/dynamic-deployment-local', { method: 'POST',
      headers: { authorization: 'Bearer synthetic-local-control', 'content-type': 'application/json',
        'x-elanous-app-build-owner': owner.memberId, 'x-elanous-app-build-head': head, ...headers },
      body: JSON.stringify({ action, runId }) });
    registerAuthPeerAddress(candidate, '127.0.0.1'); return candidate;
  };
  return { root, sources, owner, session, options, publisherOptions, sent, bridge, publisher, request,
    receipt(value: typeof receipt) { receipt = value; }, unavailable() { available = false; } };
}

test('verified member mode reserves without test-only member environment values', async () => {
  const h = setup(false, 'member');
  const response = await h.bridge(h.request());
  expect(response?.status).toBe(200);
  const grant = await response!.json();
  expect(grant.ownerId).toBe(h.owner.memberId);
  expect(grant.appSlug).toBe(h.session.appSlug);
  expect((await h.bridge(h.request('attest')))?.status).toBe(200);
  h.receipt({ ...h.owner, memberId: 'foreign' });
  expect((await h.bridge(h.request('attest')))?.status).not.toBe(200);
});

test('verified member reservations get a fresh two-hour lease without restarting the issuer', async () => {
  let clock = Date.parse('2026-11-16T00:00:00.000Z');
  const h = setup(false, 'member', true, () => clock);
  const first = await (await h.bridge(h.request()))!.json() as { issuerExpiresAt: string };
  expect(first.issuerExpiresAt).toBe('2026-11-16T02:00:00.000Z');
  clock += 3 * 60 * 60 * 1_000;
  expect((await h.bridge(h.request('attest')))?.status).not.toBe(200);
  const second = await h.bridge(h.request('reserve', {}, 'http://127.0.0.1:31415', 'second-run'));
  expect(second?.status).toBe(200);
  expect((await second!.json() as { issuerExpiresAt: string }).issuerExpiresAt).toBe('2026-11-16T05:00:00.000Z');
});

test('shifting both private claim times into the future cannot reopen a member reservation after restart', async () => {
  const h = setup(false, 'member', true);
  const grant = await (await h.bridge(h.request()))!.json() as { sourceRoot: string };
  const claimPath = join(grant.sourceRoot, '..', 'synthetic-app.claim.json');
  const claim = JSON.parse(readFileSync(claimPath, 'utf8')) as Record<string, unknown>;
  claim.issuedAt = '2099-01-01T00:00:00.000Z';
  claim.issuerExpiresAt = '2099-01-01T02:00:00.000Z';
  writeFileSync(claimPath, JSON.stringify(claim), { mode: 0o600 });
  expect((await h.bridge(h.request('attest')))?.status).not.toBe(200);
  const restarted = createAppBuildLocalIssuerBridge({ ...h.options,
    publisher: createDynamicAppPublisher(h.publisherOptions) });
  expect((await restarted(h.request('attest')))?.status).not.toBe(200);
  expect((await restarted(h.request('reserve', {}, 'http://127.0.0.1:31415', 'fresh-run')))?.status).toBe(200);
});

test('member claim rejects another valid root, bad signatures, and an untrusted restart key', async () => {
  const h = setup(false, 'member', true);
  const grant = await (await h.bridge(h.request()))!.json() as { sourceRoot: string };
  const claimPath = join(grant.sourceRoot, '..', 'synthetic-app.claim.json');
  const original = JSON.parse(readFileSync(claimPath, 'utf8')) as Record<string, unknown>;
  const attest = async () => (await h.bridge(h.request('attest')))?.status;
  for (const changed of [
    { ...original, root: String(original.root).replace(/[0-9a-f]{32}$/u, 'c'.repeat(32)) },
    { ...original, signature: undefined },
    { ...original, signature: 'c' },
    { ...original, signature: 'c'.repeat(64) },
  ]) {
    writeFileSync(claimPath, JSON.stringify(changed), { mode: 0o600 });
    expect(await attest()).not.toBe(200);
  }
  writeFileSync(claimPath, JSON.stringify(original), { mode: 0o600 });
  expect(await attest()).toBe(200);
  for (const issuerClaimKey of ['c'.repeat(64), undefined]) {
    const restarted = createAppBuildLocalIssuerBridge({ ...h.options,
      publisher: createDynamicAppPublisher({ ...h.publisherOptions, issuerClaimKey }) });
    expect((await restarted(h.request('attest')))?.status).not.toBe(200);
    if (!issuerClaimKey) expect((await restarted(h.request('reserve', {}, 'http://127.0.0.1:31415', 'fresh-missing')))?.status).not.toBe(200);
  }
});

test('verified member mode has no direct dynamic-deployment route', async () => {
  const h = setup(false, 'member', true);
  let ownerLookup = 0;
  const route = createDynamicAppPublishRoute(h.publisher, async () => { ownerLookup++; return h.owner; });
  const response = await route(new Request('http://localhost/v1/apps/synthetic-app/dynamic-deployment', {
    method: 'POST', headers: { authorization: 'Bearer aps_synthetic_sdk', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reserve', runId: 'synthetic-run' }),
  }));
  expect(response?.status).toBe(403);
  expect(ownerLookup).toBe(0);
  expect(readdirSync(h.sources)).toEqual([]);
});

test('member mode is opt-in and still rejects a foreign app slot or missing session', async () => {
  const closed = setup(false, 'none');
  expect((await closed.bridge(closed.request()))?.status).not.toBe(200);
  expect(readdirSync(closed.sources)).toEqual([]);
  const h = setup(false, 'member');
  const foreign = createAppBuildLocalIssuerBridge({ ...h.options,
    getSession: () => ({ ...h.session, appSlug: 'foreign-app' }) });
  expect((await foreign(h.request()))?.status).not.toBe(200);
  h.unavailable();
  expect((await h.bridge(h.request()))?.status).not.toBe(200);
  expect(readdirSync(h.sources)).toEqual([]);
});

test('partial test identity or missing test expiry cannot fall into verified member mode', async () => {
  for (const h of [setup(false, 'partial'), setup(false, 'test', true)]) {
    expect((await h.bridge(h.request()))?.status).not.toBe(200);
    expect(readdirSync(h.sources)).toEqual([]);
  }
});

test('official SDK owner authorizes a local C claim without moving SDK credentials to the local request', async () => {
  const h = setup(); const response = await h.bridge(h.request()); expect(response?.status).toBe(200);
  const grant = await response!.json();
  expect(grant.ownerId).toBe(h.owner.memberId); expect(grant.sourceHead).toBe(head);
  expect(grant.sourceRoot.startsWith(h.sources + '/')).toBe(true);
  const claim = JSON.parse(readFileSync(join(grant.sourceRoot, '..', 'synthetic-app.claim.json'), 'utf8'));
  expect(claim.root).toBe(grant.sourceRoot); expect(claim.runId).toBe(grant.runId);
  expect((await (await h.bridge(h.request('attest')))!.json()).sourceRoot).toBe(grant.sourceRoot);
  expect(h.sent).not.toEqual([]);
  expect(h.sent.every(item => item.url === OFFICIAL_MEMBER_ORIGIN + '/v1/members/owner?appSlug=synthetic-app' && item.auth === 'Bearer aps_synthetic_sdk')).toBe(true);
  expect(h.session.nexusUrl).toBe(OFFICIAL_MEMBER_ORIGIN);
});

test('reserve pins the owner-verified session and refuses a replacement before seal issue', async () => {
  const h = setup();
  let reads = 0;
  const replacement = { ...h.session, sessionToken: 'aps_replacement' };
  const runAuthority = createAppBuildRunAuthority({ root: join(h.root, 'authority'), hostKey: 'a'.repeat(64),
    retainedSession: () => replacement, relayKeyFingerprint: () => 'b'.repeat(64) });
  const bridge = createAppBuildLocalIssuerBridge({ ...h.options, runAuthority,
    getSession: () => ++reads <= 2 ? h.session : replacement });
  expect((await bridge(h.request('reserve')))?.status).toBe(403);
  expect(reads).toBe(2);
  expect(() => readFileSync(join(h.root, 'authority', 'synthetic-run.json'))).toThrow();
});

test('undo after build-seal loss requires a fresh official owner before the publisher can revoke', async () => {
  const h = setup();
  const runAuthority = createAppBuildRunAuthority({ root: join(h.root, 'authority'), hostKey: 'a'.repeat(64),
    retainedSession: () => h.session, relayKeyFingerprint: () => 'b'.repeat(64) });
  let calls = 0;
  const publisher = { ...h.options.publisher, undo: async (_owner: typeof h.owner, _runId: string,
    _appSlug: string, deploymentId: string) => { calls++; return { status: 'undone' as const,
      deploymentId, stopped: true as const, durableRetirement: true as const, proof: 'server' as const }; } };
  const bridge = createAppBuildLocalIssuerBridge({ ...h.options, publisher, runAuthority });
  const request = () => {
    const value = new Request(h.request('undo'), { body: JSON.stringify({ action: 'undo', runId: 'synthetic-run',
      deploymentId: 'dyn-11111111-1111-4111-8111-111111111111' }) });
    registerAuthPeerAddress(value, '127.0.0.1');
    return value;
  };
  expect((await bridge(request()))?.status).toBe(200);
  expect(calls).toBe(1);
  expect(h.sent).not.toEqual([]);
  h.receipt({ ...h.owner, memberId: 'foreign' });
  expect((await bridge(request()))?.status).toBe(401);
  expect(calls).toBe(1);
});

test('approval start and poll recheck fresh APS owner instead of trusting a build seal', async () => {
  const h = setup();
  const runAuthority = createAppBuildRunAuthority({ root: join(h.root, 'authority'), hostKey: 'a'.repeat(64),
    retainedSession: () => h.session, relayKeyFingerprint: () => 'b'.repeat(64) });
  const actions: string[] = [];
  const publisher = { ...h.options.publisher,
    startApproval: async () => { actions.push('start'); return { status: 'approval-pending' as const,
      approvalUrl: 'https://api.elanous.ai/approval', pendingExpiresAt: '2099-01-01T00:00:00Z' }; },
    pollApproval: async () => { actions.push('poll'); return { status: 'approval-approved' as const }; },
  };
  const bridge = createAppBuildLocalIssuerBridge({ ...h.options, publisher, runAuthority });
  expect((await bridge(h.request('approval-start')))?.status).toBe(200);
  expect((await bridge(h.request('approval-poll')))?.status).toBe(200);
  expect(actions).toEqual(['start', 'poll']);
  expect(h.sent).toHaveLength(4);
  h.unavailable();
  expect((await bridge(h.request('approval-poll')))?.status).toBe(401);
  expect(actions).toEqual(['start', 'poll']);
});

test('remote host, browser, missing control credential and changed head refuse before official lookup or claim creation', async () => {
  for (const [headers, origin] of [
    [{ authorization: 'Bearer foreign' }, undefined], [{ cookie: 'synthetic=1' }, undefined],
    [{ origin: 'http://127.0.0.1:31415' }, undefined], [{ 'sec-fetch-site': 'cross-site' }, undefined],
    [{ 'x-elanous-app-build-head': 'f'.repeat(40) }, undefined], [{}, 'http://foreign.invalid'],
  ] as Array<[Record<string, string>, string | undefined]>) {
    const h = setup(); expect((await h.bridge(h.request('reserve', headers, origin)))!.status).not.toBe(200);
    expect(h.sent).toHaveLength(0); expect(readdirSync(h.sources)).toEqual([]);
  }
});

test('trusted router peer rejects remote or unknown sockets despite spoofed loopback Host and forwarded headers', async () => {
  for (const peer of ['203.0.113.9', undefined]) {
    const h = setup(); const candidate = h.request('reserve', {
      host: '127.0.0.1:31415', 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1',
    });
    const opts = { appRoutes: [h.bridge] } as unknown as NexusHttpServerOpts;
    const server = { requestIP: () => peer ? { address: peer } : null } as unknown as Parameters<typeof routeRequest>[2];
    const response = await routeRequest(candidate, opts, server, null, createDevProxyRuntimeRef());
    expect(response?.status).toBe(403); expect(h.sent).toHaveLength(0); expect(readdirSync(h.sources)).toEqual([]);
  }
});

test('registered IPv4 and IPv6 loopback sockets retain the authorized local claim path', async () => {
  for (const peer of ['127.0.0.1', '::1']) {
    const h = setup(); const candidate = h.request();
    const opts = { appRoutes: [h.bridge] } as unknown as NexusHttpServerOpts;
    const server = { requestIP: () => ({ address: peer }) } as unknown as Parameters<typeof routeRequest>[2];
    expect((await routeRequest(candidate, opts, server, null, createDevProxyRuntimeRef()))?.status).toBe(200);
  }
});

test('foreign official owner, changed handle, absent SDK session and expired C approval never issue a local claim', async () => {
  for (const kind of ['owner', 'handle', 'session', 'expiry']) {
    const h = setup(kind === 'expiry');
    if (kind === 'owner') h.receipt({ ...h.owner, memberId: 'foreign' });
    if (kind === 'handle') h.receipt({ ...h.owner, userSlug: 'foreign' });
    if (kind === 'session') h.unavailable();
    expect((await h.bridge(h.request()))!.status).not.toBe(200);
    expect(readdirSync(h.sources)).toEqual([]);
  }
});

test('absent claim is refused and a replaced SDK origin is never contacted', async () => {
  const h = setup(); expect((await h.bridge(h.request('attest')))!.status).not.toBe(200);
  const bridge = createAppBuildLocalIssuerBridge({ ...h.options,
    getSession: () => ({ ...h.session, nexusUrl: 'https://foreign.invalid' }) });
  h.sent.length = 0;
  expect((await bridge(h.request()))!.status).toBe(401); expect(h.sent).toHaveLength(0);
});

test('an SDK session for another or missing app slot cannot authenticate this local issuer route', async () => {
  for (const appSlug of ['foreign-app', undefined]) {
    const h = setup(); const bridge = createAppBuildLocalIssuerBridge({ ...h.options,
      getSession: () => ({ ...h.session, appSlug }) });
    expect((await bridge(h.request()))!.status).toBe(401);
    expect(h.sent).toHaveLength(0); expect(readdirSync(h.sources)).toEqual([]);
  }
});

test('local discovery uses existing private control files and fails closed on missing or insecure credentials', () => {
  const h = setup(); const path = join(h.root, 'local-runtime.json');
  writeFileSync(path, JSON.stringify({ pid: process.pid, httpAuth: 'on', httpPort: 31415 }), { mode: 0o600 });
  expect(() => readLocalAppBuildIssuer(h.root, path)).toThrow();
  const token = join(h.root, 'acp-token'); writeFileSync(token, 'synthetic-local-control', { mode: 0o600 });
  expect(readLocalAppBuildIssuer(h.root, path).origin).toBe('http://127.0.0.1:31415');
  chmodSync(token, 0o644); expect(() => readLocalAppBuildIssuer(h.root, path)).toThrow();
});
