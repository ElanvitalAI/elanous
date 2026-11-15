import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppBuildLocalIssuerBridge, OFFICIAL_MEMBER_ORIGIN, readLocalAppBuildIssuer } from './app-build-local-bridge.js';
import { createAppBuildRunAuthority } from './app-build-run-authority.js';
import { createDynamicAppPublisher } from './dynamic-app-publish.js';
import type { NexusAppHost } from './app-host.js';
import { getAuthPeerAddress, registerAuthPeerAddress } from '../api/meta-api.js';
import { routeRequest, type NexusHttpServerOpts } from '../api/http-server.js';
import { createDevProxyRuntimeRef } from '../api/admin-dev-proxy.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const head = 'a'.repeat(40);
function setup(expired = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-issuer-'))); roots.push(root);
  const sources = join(root, 'sources'); const seals = join(root, 'seals'); const runtime = join(root, 'runtime');
  for (const path of [sources, seals, runtime]) mkdirSync(path, { mode: 0o700 });
  const owner = { memberId: 'synthetic-owner', userSlug: 'syntheticowner' };
  let receipt = { ...owner }; let available = true;
  const sent: Array<{ url: string; auth: string | null }> = [];
  const session = { nexusUrl: OFFICIAL_MEMBER_ORIGIN, sessionToken: 'aps_synthetic_sdk', appSlug: 'synthetic-app' };
  const publisher = createDynamicAppPublisher({ sourceRoot: sources, sealRoot: seals, runtimeRoot: runtime,
    appHost: {} as NexusAppHost, testMemberId: owner.memberId, testHandle: owner.userSlug,
    testApprovalExpiresAt: expired ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z', issuerSourceHead: head,
    approveArtifact: () => false });
  const options = { publisher, sourceHead: head, getSession: () => available ? session : undefined,
    peerAddress: getAuthPeerAddress,
    authorizeControl: (request: Request) => request.headers.get('authorization') === 'Bearer synthetic-local-control',
    fetcher: (async (url, init) => { sent.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      return Response.json(receipt); }) as typeof fetch };
  const bridge = createAppBuildLocalIssuerBridge(options);
  const request = (action = 'reserve', headers: Record<string, string> = {}, origin = 'http://127.0.0.1:31415') => {
    const candidate = new Request(origin + '/v1/apps/synthetic-app/dynamic-deployment-local', { method: 'POST',
      headers: { authorization: 'Bearer synthetic-local-control', 'content-type': 'application/json',
        'x-elanous-app-build-owner': owner.memberId, 'x-elanous-app-build-head': head, ...headers },
      body: JSON.stringify({ action, runId: 'synthetic-run' }) });
    registerAuthPeerAddress(candidate, '127.0.0.1'); return candidate;
  };
  return { root, sources, owner, session, options, sent, bridge, request,
    receipt(value: typeof receipt) { receipt = value; }, unavailable() { available = false; } };
}

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
