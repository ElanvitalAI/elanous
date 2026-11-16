import { afterEach, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, readdirSync, renameSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadNexusAppHost } from './app-host.js';
import { createAppDeploymentGrantProvider } from './app-build-run-authority.js';
import type { DeploymentApprovalProvider } from './app-deployment-approval-intent.js';
import { createDynamicAppPublisher, createDynamicAppPublishRoute, createDynamicAppDeployHook,
  DeploymentGrantAuthorizationError, verifiedDynamicOwner,
  type DeploymentGrantBinding, type DeploymentGrantProvider } from './dynamic-app-publish.js';
import { buildSharedAppTools } from '../../agent/shared-app-tools.js';
import { getToolLoopPhaseRejectedCalls } from '../../llm.js';

// The product service intentionally requires macOS sandbox-exec. Linux runs the
// explicit refusal case below; service success and cleanup are measured on macOS.
const serviceTest = process.platform === 'darwin' ? test : test.skip;
const linuxTest = process.platform === 'darwin' ? test.skip : test;

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
test('owner endpoint memberId binds to the current member-store handle', () => {
  let active = true;
  let handle: string | null = 'test-slot';
  const store: Parameters<typeof verifiedDynamicOwner>[1] = {
    activeForAuth: () => active,
    memberPlanForMember: () => ({} as NonNullable<ReturnType<typeof store.memberPlanForMember>>),
    publicUserSlugForMember: () => handle,
    memberForPublicUserSlug: slug => slug === 'test-slot' ? 'member-a' : null,
  };
  expect(verifiedDynamicOwner({ memberId: 'member-a' }, store)).toEqual({ memberId: 'member-a', userSlug: 'test-slot' });
  expect(verifiedDynamicOwner({ memberId: 'member-a', userSlug: 'attacker' }, store)).toEqual({ memberId: 'member-a', userSlug: 'test-slot' });
  handle = 'retired-slot';
  expect(verifiedDynamicOwner({ memberId: 'member-a' }, store)).toBeNull();
  handle = 'test-slot'; active = false;
  expect(verifiedDynamicOwner({ memberId: 'member-a' }, store)).toBeNull();
});
async function fixture(options: { wrongMarker?: boolean; expired?: boolean; expiresInMs?: number;
  authorizationPollMsForTesting?: number; denyArtifact?: boolean; missingSourceHead?: boolean;
  withoutGrantProvider?: boolean; wrongGrantOwner?: boolean; failIssueOnce?: boolean;
  tamperSealBeforeActivation?: boolean; failRevoke?: boolean; denyRevoke?: boolean;
  failServiceStopAfterStop?: boolean; failServiceStopOnceBeforeStop?: boolean; failUnregisterOnce?: boolean;
  providerRevokeStatus?: 403 | 429; approvalFlow?: boolean; approvedExpiryShorterMs?: number;
  noncanonicalExpiry?: boolean; routeRegistration?: boolean; routeRegistrationFails?: boolean;
  routeAckLostOnce?: boolean; routeUnregisterFailsOnce?: boolean; routeUnregisterFailures?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dynamic-publish-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['apps', 'sources', 'seals', 'runtime']) mkdirSync(join(root, name), { mode: 0o700 });
  const { appHost } = loadNexusAppHost(join(root, 'apps'), undefined,
    { key: randomBytes(32).toString('hex'), dir: join(root, 'sessions') });
  let unregisterAttempts = 0;
  if (options.failUnregisterOnce && appHost.unregisterDynamicService) {
    const unregister = appHost.unregisterDynamicService.bind(appHost);
    appHost.unregisterDynamicService = (...args) => {
      unregisterAttempts++;
      if (unregisterAttempts === 1) throw new Error('synthetic unregister refused');
      return unregister(...args);
    };
  }
  let serviceStopAttempts = 0;
  let capturedServingAuthorization: (() => boolean | Promise<boolean>) | undefined;
  if (options.failServiceStopAfterStop || options.failServiceStopOnceBeforeStop) {
    const register = appHost.registerDynamicService!.bind(appHost);
    appHost.registerDynamicService = binding => {
      capturedServingAuthorization = binding.stillAuthorized;
      const stop = binding.service.stop;
      (binding.service as { stop: () => Promise<void> }).stop = async () => {
        serviceStopAttempts++;
        if (options.failServiceStopOnceBeforeStop && serviceStopAttempts === 1)
          throw new Error('synthetic service stop refused before stop');
        await stop();
        if (options.failServiceStopAfterStop) throw new Error('synthetic service stop rejection');
      };
      register(binding);
    };
  }
  cleanup.push(() => appHost.close());
  const grants = new Map<string, DeploymentGrantBinding>();
  let grantCheckFails = false;
  let heldGrantCheck: { entered: () => void; released: Promise<void> } | undefined;
  let revokeFails = !!options.failRevoke;
  let failIssue = !!options.failIssueOnce;
  const issuedIds: string[] = [];
  const issuedInputs: Array<Omit<DeploymentGrantBinding, 'grantId' | 'grantVersion'>> = [];
  const issuedRevocations: string[] = [];
  let relayKeyId: string | undefined = options.approvalFlow
    ? '14bcb6e5-1338-4253-a746-e520595d5604' : 'synthetic-relay-key';
  let browserApproved = false;
  let approvalStarts = 0;
  const approvalProvider: DeploymentApprovalProvider = {
    start: async () => {
      const approvalId = ++approvalStarts === 1
        ? '8f195ad4-a4e2-4b31-a7bc-155602760279'
        : '7a02f763-b20d-471a-a34c-37b62ec48692';
      return { approvalId,
      approvalUrl: 'https://api.elanous.ai/v1/members/deployment-approvals/' + approvalId,
      pendingExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
    },
    poll: async binding => browserApproved
      ? { status: 'approved', expiresAt: new Date(Date.parse(binding.expiresAt)
        - (options.approvedExpiryShorterMs ?? 0)).toISOString() } : { status: 'pending' },
  };
  const deploymentGrants: DeploymentGrantProvider = {
    issue: async input => {
      issuedIds.push(input.deploymentId);
      issuedInputs.push(input);
      if (failIssue) { failIssue = false; throw new Error('synthetic issue timeout'); }
      const grant: DeploymentGrantBinding = { ...input,
        ownerId: options.wrongGrantOwner ? 'foreign-owner' : input.ownerId,
        grantId: 'grant-' + randomBytes(12).toString('hex'),
        grantVersion: 1, expiresAt: new Date(Math.min(Date.parse(input.expiresAt)
          - (options.approvedExpiryShorterMs ?? 0), Date.now() + 24 * 60 * 60 * 1_000)).toISOString() };
      grants.set(grant.grantId, grant);
      return grant;
    },
    introspect: async grantId => {
      const held = heldGrantCheck;
      if (held) { heldGrantCheck = undefined; held.entered(); await held.released; }
      return grantCheckFails ? null : grants.get(grantId) ?? null;
    },
    revoke: async (grantId, owner) => {
      if (options.denyRevoke) throw new DeploymentGrantAuthorizationError();
      if (revokeFails) throw new Error('synthetic revoke unavailable');
      const grant = grants.get(grantId);
      if (!grant || grant.ownerId !== owner.memberId) throw new Error('grant revoke refused');
      grants.delete(grantId);
    },
    revokeIssued: async (grantId, _owner, _appSlug) => {
      issuedRevocations.push(grantId);
      grants.delete(grantId);
    },
  };
  const credentials = new Map<string, string>();
  const providerForPublisher = options.providerRevokeStatus === undefined ? deploymentGrants
    : createAppDeploymentGrantProvider({ root: join(root, 'grants'),
      getSession: () => ({ nexusUrl: 'https://api.elanous.ai', appSlug: 'demo-app', sessionToken: 'aps_synthetic_first' }),
      fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (init?.method === 'DELETE') return Response.json({ error: 'revoke-not-confirmed' },
          { status: options.providerRevokeStatus });
        if (target.endsWith('/introspect')) {
          const credential = new Headers(init?.headers).get('authorization')?.slice('Bearer '.length) ?? '';
          const id = credentials.get(credential);
          const grant = id && grants.get(id);
          if (!grant) return Response.json({ error: 'unknown' }, { status: 401 });
          const { ownerId, ...publicGrant } = grant;
          return Response.json({ ...publicGrant, memberId: ownerId });
        }
        const input = JSON.parse(String(init?.body)) as Omit<DeploymentGrantBinding, 'grantId' | 'grantVersion'>;
        const grant: DeploymentGrantBinding = { ...input, ownerId: 'member-a',
          grantId: 'grant-' + randomBytes(12).toString('hex'),
          grantVersion: 1 };
        const credential = 'dpg_' + randomBytes(32).toString('base64url');
        grants.set(grant.grantId, grant); credentials.set(credential, grant.grantId);
        const { ownerId, ...publicGrant } = grant;
        return Response.json({ ...publicGrant, memberId: ownerId, credential }, { status: 201 });
      }) as typeof fetch });
  const expiry = new Date(Date.now() + (options.expired ? -60_000 : options.expiresInMs ?? 60_000)).toISOString();
  const registeredRoutes: Array<{ ownerId: string; user: string; app: string; deploymentId: string;
    grantId: string; expiresAt: string }> = [];
  const unregisteredRoutes: Array<{ user: string; app: string; deploymentId: string; grantId: string }> = [];
  let routeAckLost = !!options.routeAckLostOnce;
  let routeUnregisterFailures = options.routeUnregisterFailures ?? (options.routeUnregisterFailsOnce ? 1 : 0);
  let routeUnregisterAttempts = 0;
  const publisher = createDynamicAppPublisher({ sourceRoot: join(root, 'sources'), sealRoot: join(root, 'seals'),
    runtimeRoot: join(root, 'runtime'), appHost, testMemberId: 'member-a', testHandle: 'test-slot',
    ...(options.routeRegistration ? { relayRoutes: {
      register: async (input: (typeof registeredRoutes)[number]) => {
        if (options.routeRegistrationFails) throw new Error('synthetic relay registration refusal');
        registeredRoutes.push(input);
        if (routeAckLost) { routeAckLost = false; throw new Error('synthetic relay acknowledgement lost'); }
      },
      unregister: async (input: (typeof unregisteredRoutes)[number]) => {
        routeUnregisterAttempts++;
        if (routeUnregisterFailures > 0) {
          routeUnregisterFailures--;
          throw new Error('synthetic relay unregister unavailable');
        }
        unregisteredRoutes.push(input);
      },
    } } : {}),
    testApprovalExpiresAt: options.noncanonicalExpiry ? expiry.replace(/\.\d{3}Z$/u, 'Z') : expiry,
    authorizationPollMsForTesting: options.authorizationPollMsForTesting,
    issuerSourceHead: options.missingSourceHead ? undefined : 'a'.repeat(40),
    relayKeyId: () => relayKeyId,
    ...(options.approvalFlow ? { deploymentApprovals: approvalProvider } : {}),
    ...(options.withoutGrantProvider ? {} : { deploymentGrants: providerForPublisher }),
    approveArtifact: () => !options.denyArtifact,
    verifyPublic: async url => {
      if (options.routeRegistration && registeredRoutes.length === unregisteredRoutes.length) {
        return { status: 404, marker: null };
      }
      const response = await appHost.handle(new Request(url, { headers: { host: new URL(url).host } }));
      if (options.tamperSealBeforeActivation) {
        const seal = readdirSync(join(root, 'seals')).find(name => name.startsWith('source-'))!;
        writeFileSync(join(root, 'seals', seal, 'ARCHITECTURE.md'), '# changed after public verification\n');
      }
      return { status: response?.status ?? 404, marker: options.wrongMarker ? '0'.repeat(48)
        : response?.headers.get('x-elanous-dynamic-route') ?? null };
    } });
  cleanup.push(() => publisher.close());
  const owner = { memberId: 'member-a', userSlug: 'test-slot' };
  let active = true;
  const route = createDynamicAppPublishRoute(publisher, async request => {
    if (!active) return null;
    const auth = request.headers.get('authorization');
    return auth === 'Bearer aps_synthetic_a' ? owner
      : auth === 'Bearer aps_synthetic_b' ? { memberId: 'member-b', userSlug: 'other-slot' } : null;
  });
  const call = async (action: string, runId = 'run-a', deploymentId?: string, token = 'aps_synthetic_a') => {
    const response = await route(new Request('http://localhost/v1/apps/demo-app/dynamic-deployment', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ action, runId, ...(deploymentId ? { deploymentId } : {}) }),
    }));
    return { status: response?.status, body: await response?.json() as Record<string, unknown> };
  };
  const writeSource = (sourceRoot: string, overrides: { digest?: string; schema?: string; port?: number } = {}) => {
    mkdirSync(sourceRoot, { mode: 0o700 });
    mkdirSync(join(sourceRoot, 'backend'), { mode: 0o700 });
    const backend = 'export default { fetch(request: Request) { return new Response(new URL(request.url).pathname === "/" ? "demo front" : "demo api"); } };\n';
    writeFileSync(join(sourceRoot, 'backend/server.ts'), backend, { mode: 0o600 });
    writeFileSync(join(sourceRoot, 'ARCHITECTURE.md'), '# demo\n', { mode: 0o600 });
    const receipt = { schemaVersion: overrides.schema ?? 'source-artifact@1', root: sourceRoot,
      files: { 'ARCHITECTURE.md': sha('# demo\n'), 'backend/server.ts': overrides.digest ?? sha(backend) },
      metadata: { runtime: { startCommand: ['bun', 'backend/server.ts'], ...(overrides.port === undefined ? {} : { port: overrides.port }), healthPath: '/health' } },
      executed: false, published: false };
    writeFileSync(join(sourceRoot, 'source-artifact.json'), JSON.stringify(receipt), { mode: 0o600 });
  };
  return { root, appHost, publisher, route, call, writeSource, registeredRoutes, unregisteredRoutes,
    routeUnregisterAttempts: () => routeUnregisterAttempts,
    grantCount: () => grants.size,
    serviceStopAttempts: () => serviceStopAttempts,
    checkServingAuthorization: async () => !!await capturedServingAuthorization?.(),
    unregisterAttempts: () => unregisterAttempts,
    holdNextGrantCheck: () => {
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      heldGrantCheck = { entered, released };
      return { entered: enteredPromise, release };
    },
    setRevokeFails: (value: boolean) => { revokeFails = value; },
    issuedIds,
    issuedInputs,
    approveInBrowser: () => { browserApproved = true; },
    issuedRevocations,
    revoke: () => { active = false; },
    revokeGrant: () => { grants.clear(); },
    setRelayKeyId: (value: string | undefined) => { relayKeyId = value; },
    failGrantCheck: () => { grantCheckFails = true; },
    tamperGrant: (change: Partial<DeploymentGrantBinding>) => {
      for (const [id, grant] of grants) grants.set(id, { ...grant, ...change });
    },
  };
}

linuxTest('non-Darwin dynamic publish refuses service activation and leaves no live app', async () => {
  const f = await fixture();
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('publish')).status).toBe(400);
  expect(f.grantCount()).toBe(0);
  expect(f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/'))).toBeFalsy();
});

serviceTest('native approval start pins deployment and browser-confirmed poll alone opens publish', async () => {
  const f = await fixture({ approvalFlow: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('publish')).status).toBe(400);
  const started = await f.call('approval-start');
  expect(started).toMatchObject({ status: 200, body: {
    status: 'approval-pending', approvalUrl: 'https://api.elanous.ai/v1/members/deployment-approvals/'
      + '8f195ad4-a4e2-4b31-a7bc-155602760279' } });
  expect((await f.call('approval-poll')).body.status).toBe('approval-pending');
  expect((await f.call('publish')).status).toBe(400);
  f.approveInBrowser();
  expect((await f.call('approval-poll')).body.status).toBe('approval-approved');
  const published = await f.call('publish');
  expect(published.body.status).toBe('published');
  expect(f.issuedIds).toEqual([String(published.body.deploymentId)]);
  const intent = readdirSync(join(f.root, 'seals', '.deployment-state'))
    .find(name => name.startsWith('intent-') && name.endsWith('.json'))!;
  const pinned = JSON.parse(readFileSync(join(f.root, 'seals', '.deployment-state', intent), 'utf8'));
  expect(pinned.deploymentId).toBe(published.body.deploymentId);
  expect(pinned.approvalId).toBe('8f195ad4-a4e2-4b31-a7bc-155602760279');
  expect(pinned).not.toHaveProperty('memberId');
});

test('an expired pending intent requires a fresh owner start and new deployment identity', async () => {
  const f = await fixture({ approvalFlow: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('approval-start')).status).toBe(200);
  const stateRoot = join(f.root, 'seals', '.deployment-state');
  const intent = readdirSync(stateRoot).find(name => name.startsWith('intent-') && name.endsWith('.json'))!;
  const old = JSON.parse(readFileSync(join(stateRoot, intent), 'utf8'));
  expect((await f.call('approval-start')).body.approvalUrl).toBe(
    'https://api.elanous.ai/v1/members/deployment-approvals/8f195ad4-a4e2-4b31-a7bc-155602760279');
  writeFileSync(join(stateRoot, intent), JSON.stringify({ ...old,
    pendingExpiresAt: new Date(Date.now() - 1).toISOString() }), { mode: 0o600 });
  const renewed = await f.call('approval-start');
  expect(renewed).toMatchObject({ status: 200, body: { status: 'approval-pending',
    approvalUrl: 'https://api.elanous.ai/v1/members/deployment-approvals/'
      + '7a02f763-b20d-471a-a34c-37b62ec48692' } });
  const next = JSON.parse(readFileSync(join(stateRoot, intent), 'utf8'));
  expect(next.deploymentId).not.toBe(old.deploymentId);
  expect(readdirSync(stateRoot)).toContain(intent + '.retired-' + old.deploymentId);
  expect(f.issuedIds).toHaveLength(0);
});

test('changed relay binding cannot reuse pending approval but can retire it after pending expiry', async () => {
  const f = await fixture({ approvalFlow: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('approval-start')).status).toBe(200);
  const stateRoot = join(f.root, 'seals', '.deployment-state');
  const intent = readdirSync(stateRoot).find(name => name.startsWith('intent-') && name.endsWith('.json'))!;
  const old = JSON.parse(readFileSync(join(stateRoot, intent), 'utf8'));
  f.setRelayKeyId('451cd16a-30d1-45ba-8496-d58e9215c29e');
  expect((await f.call('approval-start')).status).toBe(400);
  writeFileSync(join(stateRoot, intent), JSON.stringify({ ...old,
    pendingExpiresAt: new Date(Date.now() - 1).toISOString() }), { mode: 0o600 });
  expect((await f.call('approval-start')).status).toBe(200);
  const next = JSON.parse(readFileSync(join(stateRoot, intent), 'utf8'));
  expect(next.relayKeyId).toBe('451cd16a-30d1-45ba-8496-d58e9215c29e');
  expect(next.deploymentId).not.toBe(old.deploymentId);
  expect(f.issuedIds).toHaveLength(0);
});

serviceTest('grant issue preserves the pending requested expiry while enforcing shorter browser approval expiry', async () => {
  const f = await fixture({ approvalFlow: true, approvedExpiryShorterMs: 30_000 });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('approval-start')).status).toBe(200);
  const intent = readdirSync(join(f.root, 'seals', '.deployment-state'))
    .find(name => name.startsWith('intent-') && name.endsWith('.json'))!;
  const pending = JSON.parse(readFileSync(join(f.root, 'seals', '.deployment-state', intent), 'utf8'));
  f.approveInBrowser();
  expect((await f.call('approval-poll')).body.status).toBe('approval-approved');
  expect((await f.call('publish')).body.status).toBe('published');
  expect(f.issuedInputs).toHaveLength(1);
  expect(f.issuedInputs[0]!.expiresAt).toBe(pending.expiresAt);
  expect(f.issuedInputs[0]!.approvalId).toBe(pending.approvalId);
});

serviceTest('noncanonical requested expiry bytes stay pinned through approval and grant issue', async () => {
  const f = await fixture({ approvalFlow: true, noncanonicalExpiry: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('approval-start')).status).toBe(200);
  const stateRoot = join(f.root, 'seals', '.deployment-state');
  const intent = readdirSync(stateRoot).find(name => name.startsWith('intent-') && name.endsWith('.json'))!;
  const pinned = JSON.parse(readFileSync(join(stateRoot, intent), 'utf8'));
  expect(pinned.expiresAt).toMatch(/T\d\d:\d\d:\d\dZ$/u);
  f.approveInBrowser();
  expect((await f.call('approval-poll')).body.status).toBe('approval-approved');
  expect((await f.call('publish')).body.status).toBe('published');
  expect(f.issuedInputs[0]!.expiresAt).toBe(pinned.expiresAt);
});

serviceTest('actual reserve route -> source receipt -> service -> public host -> scoped undo', async () => {
  const f = await fixture();
  const reserved = await f.call('reserve');
  expect(reserved.status).toBe(200);
  expect(reserved.body).toMatchObject({ ownerId: 'member-a', userSlug: 'test-slot', runId: 'run-a', appSlug: 'demo-app' });
  expect(reserved.body.sourceHead).toBe('a'.repeat(40));
  expect(Date.parse(String(reserved.body.issuerExpiresAt))).toBeGreaterThan(Date.now());
  expect(await f.call('attest')).toEqual(reserved);
  f.writeSource(reserved.body.sourceRoot as string);
  const inspected = await f.call('inspect');
  // source: #64039 STEP2 fixture has the two files emitted above.
  expect(inspected).toMatchObject({ status: 200, body: { status: 'inspected', declaredPort: null, files: 2 } });
  expect(inspected.body.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
  const published = await f.call('publish');
  expect(published.status).toBe(200);
  expect(published.body).toMatchObject({ status: 'published', publicUrl: 'https://demo-app--test-slot.elanous.app' });
  const fetchHost = (host: string, path: string) => f.appHost.handle(new Request('https://' + host + path, { headers: { host } }));
  expect(await (await fetchHost('demo-app--test-slot.elanous.app', '/'))?.text()).toBe('demo front');
  const health = await fetchHost('demo-app--test-slot.elanous.app', '/api/health');
  expect(health?.status).toBe(200);
  expect(await health?.text()).toBe('demo api');
  expect((await fetchHost('demo-app--other-slot.elanous.app', '/'))?.status).toBe(404);
  expect((await fetchHost('demo-app.app.localhost', '/'))?.status).toBe(200);
  expect((await f.call('publish')).status).toBe(400);
  expect((await fetchHost('demo-app--test-slot.elanous.app', '/'))?.status).toBe(200);
  expect((await f.call('undo', 'run-a', published.body.deploymentId as string, 'aps_synthetic_b')).status).toBe(400);
  expect((await f.call('undo', 'run-a', published.body.deploymentId as string)).status).toBe(200);
  expect((await f.call('undo', 'run-a', published.body.deploymentId as string)).status).toBe(400);
  expect((await fetchHost('demo-app--test-slot.elanous.app', '/'))?.status).toBe(404);
  const records = readdirSync(join(f.root, 'seals', '.deployment-state'));
  expect(records).toContain('active-' + published.body.deploymentId + '.json.retired');
  const next = await f.call('publish');
  expect(next.status).toBe(200);
  expect(next.body.deploymentId).not.toBe(published.body.deploymentId);
  expect((await f.call('undo', 'run-a', next.body.deploymentId as string)).status).toBe(200);
});

serviceTest('publisher registers the verified grant through the product relay path before URL verification and undoes it', async () => {
  const f = await fixture({ routeRegistration: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  const published = await f.call('publish');
  expect(published.status).toBe(200);
  expect(f.registeredRoutes).toHaveLength(1);
  expect(f.registeredRoutes[0]).toMatchObject({ ownerId: 'member-a', user: 'test-slot', app: 'demo-app',
    deploymentId: published.body.deploymentId, grantId: expect.stringMatching(/^grant-/u) });
  expect((await f.call('undo', 'run-a', published.body.deploymentId as string)).status).toBe(200);
  expect(f.unregisteredRoutes).toEqual([{ user: 'test-slot', app: 'demo-app',
    deploymentId: published.body.deploymentId as string, grantId: f.registeredRoutes[0]!.grantId }]);
});

serviceTest('relay registration refusal leaves no published service or active grant', async () => {
  const f = await fixture({ routeRegistration: true, routeRegistrationFails: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('publish')).status).toBe(400);
  expect(f.registeredRoutes).toHaveLength(0);
  expect(f.unregisteredRoutes).toHaveLength(1);
  expect(f.grantCount()).toBe(0);
  expect(f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/'))).toBeFalsy();
});

serviceTest('lost relay acknowledgement and failed removal retain exact durable route for retry', async () => {
  const f = await fixture({ routeRegistration: true, routeAckLostOnce: true,
    routeUnregisterFailsOnce: true, authorizationPollMsForTesting: 100 });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('publish')).status).toBe(400);
  const route = f.registeredRoutes[0]!;
  expect(route).toBeDefined();
  const path = join(f.root, 'seals', '.deployment-state', 'route-' + route.deploymentId + '.json');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ownerId: route.ownerId,
    user: route.user, app: route.app, deploymentId: route.deploymentId, grantId: route.grantId });
  expect(f.unregisteredRoutes).toEqual([]);
  const until = Date.now() + 2_000;
  while (f.unregisteredRoutes.length === 0 && Date.now() < until)
    await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.unregisteredRoutes).toEqual([{ user: route.user, app: route.app,
    deploymentId: route.deploymentId, grantId: route.grantId }]);
  expect(f.routeUnregisterAttempts()).toBe(2);
  expect(f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/'))).toBeFalsy();
});

serviceTest('orphan route intent is retried after publisher restart with the exact grant identity', async () => {
  const f = await fixture({ routeRegistration: true, routeAckLostOnce: true,
    routeUnregisterFailures: 100, authorizationPollMsForTesting: 100 });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('publish')).status).toBe(400);
  const route = f.registeredRoutes[0]!;
  const path = join(f.root, 'seals', '.deployment-state', 'route-' + route.deploymentId + '.json');
  expect(JSON.parse(readFileSync(path, 'utf8')).grantId).toBe(route.grantId);
  await f.publisher.close();
  const recovered: Array<{ user: string; app: string; deploymentId: string; grantId: string }> = [];
  const restarted = createDynamicAppPublisher({ sourceRoot: join(f.root, 'sources'),
    sealRoot: join(f.root, 'seals'), runtimeRoot: join(f.root, 'runtime'), appHost: f.appHost,
    authorizationPollMsForTesting: 20, approveArtifact: () => false,
    relayRoutes: { register: async () => { throw new Error('registration unavailable'); },
      unregister: async input => { recovered.push(input); } } });
  cleanup.push(() => restarted.close());
  const until = Date.now() + 2_000;
  while (recovered.length === 0 && Date.now() < until)
    await new Promise(resolve => setTimeout(resolve, 20));
  expect(recovered).toEqual([{ user: route.user, app: route.app,
    deploymentId: route.deploymentId, grantId: route.grantId }]);
  expect(readdirSync(join(f.root, 'seals', '.deployment-state')).some(name =>
    name === 'route-' + route.deploymentId + '.json')).toBe(false);
});

serviceTest('private intent retains one deployment identity across a failed issue retry; activation follows public verification', async () => {
  const f = await fixture({ failIssueOnce: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('publish')).status).toBe(400);
  const stateRoot = join(f.root, 'seals', '.deployment-state');
  const intentName = readdirSync(stateRoot).find(name => name.startsWith('intent-'))!;
  const intent = JSON.parse(readFileSync(join(stateRoot, intentName), 'utf8'));
  expect(intent.deploymentId).toMatch(/^dyn-[0-9a-f-]+$/);
  expect(readdirSync(stateRoot).filter(name => name.startsWith('active-'))).toEqual([]);
  const published = await f.call('publish');
  expect(published.status).toBe(200);
  expect(published.body.deploymentId).toBe(intent.deploymentId);
  expect(f.issuedIds).toEqual([intent.deploymentId, intent.deploymentId]);
  const activeName = 'active-' + intent.deploymentId + '.json';
  const active = JSON.parse(readFileSync(join(stateRoot, activeName), 'utf8'));
  expect(active).toMatchObject({ deploymentId: intent.deploymentId, ownerId: 'member-a',
    appSlug: 'demo-app', runId: 'run-a', artifactDigest: intent.artifactDigest });
  expect(readFileSync(join(stateRoot, activeName), 'utf8')).not.toContain('dpg_');
});

serviceTest('undo reports incomplete retirement when server and local proofs both fail', async () => {
  const f = await fixture({ failRevoke: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  const published = await f.call('publish');
  expect(published.status).toBe(200);
  rmSync(join(f.root, 'seals', '.deployment-state'), { recursive: true });
  expect(await f.call('undo', 'run-a', published.body.deploymentId as string)).toMatchObject({
    status: 409, body: { status: 'retirement-incomplete', stopped: true, durableRetirement: false },
  });
  expect(f.grantCount()).toBe(1);
  expect((await f.call('undo', 'run-a', published.body.deploymentId as string, 'aps_synthetic_b')).status).toBe(400);
  f.setRevokeFails(false);
  expect(await f.call('undo', 'run-a', published.body.deploymentId as string)).toMatchObject({
    status: 200, body: { status: 'undone', stopped: true, durableRetirement: true, proof: 'server' },
  });
  expect(f.grantCount()).toBe(0);
  expect((await f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/', {
    headers: { host: 'demo-app--test-slot.elanous.app' },
  })))?.status).toBe(404);
});

serviceTest('undo accepts a durable local tombstone when server revocation is unavailable', async () => {
  const f = await fixture({ failRevoke: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  const published = await f.call('publish');
  expect(await f.call('undo', 'run-a', published.body.deploymentId as string)).toMatchObject({
    status: 200, body: { status: 'undone', stopped: true,
      durableRetirement: true, proof: 'local-tombstone' },
  });
  expect(f.grantCount()).toBe(1);
});

serviceTest('incomplete undo retries local retirement after its private state directory returns', async () => {
  const f = await fixture({ failRevoke: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  const published = await f.call('publish');
  const stateRoot = join(f.root, 'seals', '.deployment-state');
  renameSync(stateRoot, stateRoot + '.offline');
  expect(await f.call('undo', 'run-a', published.body.deploymentId as string)).toMatchObject({
    status: 409, body: { status: 'retirement-incomplete', durableRetirement: false },
  });
  renameSync(stateRoot + '.offline', stateRoot);
  expect(await f.call('undo', 'run-a', published.body.deploymentId as string)).toMatchObject({
    status: 200, body: { status: 'undone', durableRetirement: true, proof: 'local-tombstone' },
  });
  expect(f.grantCount()).toBe(1);
});

serviceTest('retirement retry must confirm service stop after an earlier stop failure', async () => {
  const f = await fixture({ failRevoke: true, failServiceStopOnceBeforeStop: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  const published = await f.call('publish');
  const deploymentId = published.body.deploymentId as string;
  expect((await f.call('undo', 'run-a', deploymentId)).status).toBe(400);
  expect(f.serviceStopAttempts()).toBe(1);
  expect((await f.call('publish')).status).toBe(400);
  expect(await f.call('undo', 'run-a', deploymentId)).toMatchObject({
    status: 200, body: { status: 'undone', stopped: true,
      durableRetirement: true, proof: 'local-tombstone' },
  });
  expect(f.serviceStopAttempts()).toBe(2);
  expect((await f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/', {
    headers: { host: 'demo-app--test-slot.elanous.app' },
  })))?.status).toBe(404);
});

serviceTest('failed route unregister and service stop cannot keep a public route serving', async () => {
  const f = await fixture({ failRevoke: true, failServiceStopOnceBeforeStop: true,
    failUnregisterOnce: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  const published = await f.call('publish');
  const deploymentId = published.body.deploymentId as string;
  expect((await f.call('undo', 'run-a', deploymentId)).status).toBe(400);
  expect(f.unregisterAttempts()).toBe(1);
  expect(f.serviceStopAttempts()).toBe(1);
  const host = 'demo-app--test-slot.elanous.app';
  expect((await f.appHost.handle(new Request('https://' + host + '/', { headers: { host } })))?.status)
    .not.toBe(200);
  expect((await f.call('publish')).status).toBe(400);
  expect(await f.call('undo', 'run-a', deploymentId)).toMatchObject({
    status: 200, body: { status: 'undone', stopped: true,
      durableRetirement: true, proof: 'local-tombstone' },
  });
  expect(f.unregisterAttempts()).toBe(2);
  expect(f.serviceStopAttempts()).toBe(2);
});

serviceTest('in-flight grant validation rechecks retirement after the server response', async () => {
  const f = await fixture({ failRevoke: true, failServiceStopOnceBeforeStop: true,
    failUnregisterOnce: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  const published = await f.call('publish');
  const held = f.holdNextGrantCheck();
  const serving = f.checkServingAuthorization();
  await held.entered;
  expect((await f.call('undo', 'run-a', published.body.deploymentId as string)).status).toBe(400);
  held.release();
  expect(await serving).toBe(false);
  expect(f.serviceStopAttempts()).toBe(1);
  expect(f.unregisterAttempts()).toBe(1);
});

serviceTest('undo accepts confirmed server revocation when the local retirement record is unavailable', async () => {
  const f = await fixture();
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  const published = await f.call('publish');
  rmSync(join(f.root, 'seals', '.deployment-state'), { recursive: true });
  expect(await f.call('undo', 'run-a', published.body.deploymentId as string)).toMatchObject({
    status: 200, body: { status: 'undone', stopped: true,
      durableRetirement: true, proof: 'server' },
  });
  expect(f.grantCount()).toBe(0);
});

test('undo preserves authenticated server denial rather than converting local retirement into success', async () => {
  const f = await fixture({ denyRevoke: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  const published = await f.call('publish');
  expect((await f.call('undo', 'run-a', published.body.deploymentId as string)).status).toBe(400);
  expect(f.grantCount()).toBe(1);
});

serviceTest('real HTTPS grant provider distinguishes retryable 429 from owner denial 403 during undo', async () => {
  for (const status of [429, 403] as const) {
    const f = await fixture({ providerRevokeStatus: status, approvalFlow: true });
    const reserved = await f.call('reserve');
    f.writeSource(reserved.body.sourceRoot as string);
    expect((await f.call('approval-start')).status).toBe(200);
    f.approveInBrowser();
    expect((await f.call('approval-poll')).body.status).toBe('approval-approved');
    const published = await f.call('publish');
    expect(published.status).toBe(200);
    const undone = await f.call('undo', 'run-a', published.body.deploymentId as string);
    if (status === 429) expect(undone).toMatchObject({ status: 200,
      body: { status: 'undone', durableRetirement: true, proof: 'local-tombstone' } });
    else expect(undone.status).toBe(400);
    expect(f.grantCount()).toBe(1);
    expect((await f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/', {
      headers: { host: 'demo-app--test-slot.elanous.app' },
    })))?.status).toBe(404);
  }
});

test('sealed bytes changed during public verification cannot create an activated deployment', async () => {
  const f = await fixture({ tamperSealBeforeActivation: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('publish')).status).toBe(400);
  expect(f.grantCount()).toBe(0);
  const records = readdirSync(join(f.root, 'seals', '.deployment-state'));
  expect(records.some(name => name.startsWith('active-'))).toBe(false);
  expect((await f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/', {
    headers: { host: 'demo-app--test-slot.elanous.app' },
  })))?.status).toBe(404);
});

serviceTest('current local relay key rotation retires a live grant without resurrection', async () => {
  const f = await fixture();
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('publish')).status).toBe(200);
  const request = () => f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/', {
    headers: { host: 'demo-app--test-slot.elanous.app' },
  }));
  expect((await request())?.status).toBe(200);
  f.setRelayKeyId('rotated-relay-key');
  expect((await request())?.status).toBe(503);
  expect((await request())?.status).toBe(404);
  f.setRelayKeyId('synthetic-relay-key');
  expect((await request())?.status).toBe(404);
});

serviceTest('registered app_deploy waits for verification, then consumes a sealed generated app through the owner route', async () => {
  const f = await fixture();
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  const tools = buildSharedAppTools();
  expect(tools.specs.find(tool => tool.name === 'app_deploy')?.parameters).toMatchObject({
    properties: { runId: { type: 'string' } },
  });
  const deployCall = { id: 'deploy', name: 'app_deploy', args: { appId: 'demo-app', runId: 'run-a' } };
  const shellCall = { id: 'verify', name: 'RunShell', args: { command: 'bun test' } };
  expect(getToolLoopPhaseRejectedCalls('verify-action', [deployCall])).toEqual([deployCall]);
  expect(getToolLoopPhaseRejectedCalls('verify-action', [shellCall])).toEqual([]);
  expect(getToolLoopPhaseRejectedCalls(null, [deployCall])).toEqual([]);
  let confirmations = 0;
  const context = {
    surface: 'tui' as const, verifiedOwner: { id: 'member-a' },
    dynamicAppDeployHook: createDynamicAppDeployHook(new Request('http://localhost/v1/prompt', {
      headers: { authorization: 'Bearer aps_synthetic_a' },
    }), f.route),
    confirmChannels: [{ name: 'fake-human', request: async () => { confirmations++; return true; }, cancel: () => undefined }],
  };
  const args = { appId: 'demo-app', runId: 'run-a', requestText: '검증 후 배포해줘' };
  expect(await tools.dispatch('app_deploy', args, { ...context, verifiedOwner: undefined })).toMatchObject({ status: 'rejected' });
  const declined = { ...context, confirmChannels: [
    { name: 'decline', request: async () => false, cancel: () => undefined },
  ] };
  expect(await tools.dispatch('app_deploy', args, declined)).toMatchObject({ status: 'rejected' });
  expect(readdirSync(join(f.root, 'runtime'))).toEqual([]);
  expect(await tools.dispatch('app_deploy', args, context)).toMatchObject({
    status: 'published', publicUrl: 'https://demo-app--test-slot.elanous.app',
  });
  expect(confirmations).toBe(1);
  expect((await f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/',
    { headers: { host: 'demo-app--test-slot.elanous.app' } })))?.status).toBe(200);
  const foreign = { ...context, dynamicAppDeployHook: createDynamicAppDeployHook(new Request('http://localhost/v1/prompt', {
    headers: { authorization: 'Bearer aps_synthetic_b' },
  }), f.route) };
  expect(await tools.dispatch('app_deploy', args, foreign)).toMatchObject({ status: 'failed' });
  expect(confirmations).toBe(1);
});

test('foreign slot, unknown schema, digest mismatch, and revoked owner fail closed', async () => {
  const f = await fixture();
  expect((await f.call('reserve', 'run-a', undefined, 'aps_synthetic_b')).status).toBe(400);
  const selfDeclared = await f.route(new Request('http://localhost/v1/apps/demo-app/dynamic-deployment', {
    method: 'POST', headers: { authorization: 'Bearer aps_synthetic_a', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reserve', runId: 'run-a', ownerId: 'member-b' }),
  }));
  expect(selfDeclared?.status).toBe(400);
  const reserved = await f.call('reserve');
  expect((await f.call('attest', 'run-a', undefined, 'aps_synthetic_b')).status).toBe(400);
  f.writeSource(reserved.body.sourceRoot as string, { digest: '0'.repeat(64) });
  expect((await f.call('publish')).status).toBe(400);
  const unknown = await f.call('reserve', 'run-b');
  f.writeSource(unknown.body.sourceRoot as string, { schema: 'source-artifact@2' });
  expect((await f.call('publish', 'run-b')).status).toBe(400);
  expect((await f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/', { headers: { host: 'demo-app--test-slot.elanous.app' } })))?.status).toBe(404);
  f.revoke();
  expect((await f.call('publish')).status).toBe(401);
});

test('changed issuer source head refuses before sealing or service creation', async () => {
  const f = await fixture();
  const reserved = await f.call('reserve');
  expect(reserved.status).toBe(200);
  f.writeSource(reserved.body.sourceRoot as string);
  const claimPath = join(dirname(reserved.body.sourceRoot as string), 'demo-app.claim.json');
  const claim = JSON.parse(readFileSync(claimPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(claimPath, JSON.stringify({ ...claim, sourceHead: 'b'.repeat(40) }));
  expect((await f.call('attest')).status).toBe(400);
  expect((await f.call('inspect')).status).toBe(400);
  expect(readdirSync(join(f.root, 'seals'))).toEqual([]);
  expect(readdirSync(join(f.root, 'runtime'))).toEqual([]);
});

test('prewrite attest refuses changed owner, run, root or expiry in private claim', async () => {
  const f = await fixture();
  const reserved = await f.call('reserve');
  const claimPath = join(dirname(reserved.body.sourceRoot as string), 'demo-app.claim.json');
  const claim = JSON.parse(readFileSync(claimPath, 'utf8')) as Record<string, unknown>;
  for (const change of [{ ownerId: 'member-b' }, { runId: 'run-b' },
    { root: join(f.root, 'foreign-source') }, { issuerExpiresAt: '2099-01-01T00:00:00.000Z' }]) {
    writeFileSync(claimPath, JSON.stringify({ ...claim, ...change }));
    expect((await f.call('attest')).status).toBe(400);
  }
  writeFileSync(claimPath, JSON.stringify(claim));
  expect(await f.call('attest')).toEqual(reserved);
  expect(readdirSync(join(f.root, 'seals'))).toEqual([]);
  expect(readdirSync(join(f.root, 'runtime'))).toEqual([]);
});

serviceTest('ordinary owner session change does not retire a server-authorized deployment', async () => {
  const f = await fixture();
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('publish')).status).toBe(200);
  f.revoke();
  const response = await f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/',
    { headers: { host: 'demo-app--test-slot.elanous.app' } }));
  expect(response?.status).toBe(200);
});

serviceTest('build authority expiry does not retire a valid grant; failed online validation retires immediately', async () => {
  const f = await fixture({ authorizationPollMsForTesting: 5_000 });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  let buildAuthorized = true;
  const published = await f.publisher.publish({ memberId: 'member-a', userSlug: 'test-slot' },
    'run-a', 'demo-app', new Request('http://localhost/'), () => buildAuthorized);
  expect(published.status).toBe('published');
  buildAuthorized = false;
  const url = 'https://demo-app--test-slot.elanous.app/';
  const request = () => f.appHost.handle(new Request(url, { headers: { host: new URL(url).host } }));
  expect((await request())?.status).toBe(200);
  f.failGrantCheck();
  expect((await request())?.status).toBe(503);
  expect((await request())?.status).toBe(404);
  expect(readdirSync(join(f.root, 'runtime'))).toEqual([]);
});

test('missing or cross-bound deployment grant refuses before public route and service creation', async () => {
  for (const options of [{ withoutGrantProvider: true }, { wrongGrantOwner: true }]) {
    const f = await fixture(options);
    const reserved = await f.call('reserve');
    f.writeSource(reserved.body.sourceRoot as string);
    expect((await f.call('publish')).status).toBe(400);
    if (options.wrongGrantOwner) {
      expect(f.issuedRevocations).toHaveLength(1);
      expect(f.grantCount()).toBe(0);
    }
    expect(readdirSync(join(f.root, 'runtime'))).toEqual([]);
    expect((await f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/', {
      headers: { host: 'demo-app--test-slot.elanous.app' },
    })))?.status).toBe(404);
  }
});

serviceTest('failed service stop still attempts grant revoke and reports both cleanup failures', async () => {
  const f = await fixture({ wrongMarker: true, failRevoke: true, failServiceStopAfterStop: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  let failure: unknown;
  try {
    await f.publisher.publish({ memberId: 'member-a', userSlug: 'test-slot' }, 'run-a', 'demo-app',
      new Request('https://api.elanous.ai/v1/apps/demo-app/dynamic-deployment'), () => true);
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  const messages = (failure as AggregateError).errors.map((error: Error) => error.message);
  expect(messages).toContain('synthetic service stop rejection');
  expect(messages).toContain('synthetic revoke unavailable');
  expect(f.grantCount()).toBe(1);
  expect((await f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/', {
    headers: { host: 'demo-app--test-slot.elanous.app' },
  })))?.status).toBe(404);
  expect((await f.call('publish')).status).toBe(400);
});

serviceTest('artifact binding drift in server introspection stops only the live deployment', async () => {
  const f = await fixture({ authorizationPollMsForTesting: 5_000 });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('publish')).status).toBe(200);
  f.tamperGrant({ artifactDigest: '0'.repeat(64) });
  const request = () => f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/', {
    headers: { host: 'demo-app--test-slot.elanous.app' },
  }));
  expect((await request())?.status).toBe(503);
  expect((await request())?.status).toBe(404);
});

serviceTest('expired approval permits authenticated cleanup without a publish grant', async () => {
  const f = await fixture({ expiresInMs: 1_500, authorizationPollMsForTesting: 5_000 });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  const published = await f.call('publish');
  expect(published.status).toBe(200);
  await Bun.sleep(Math.max(0, Date.parse(String(reserved.body.issuerExpiresAt)) - Date.now() + 20));
  expect((await f.call('undo', 'run-a', String(published.body.deploymentId))).status).toBe(200);
  expect(readdirSync(join(f.root, 'runtime'))).toEqual([]);
});

serviceTest('grant expiry and explicit revocation automatically stop service and free port', async () => {
  for (const revoked of [false, true]) {
    const f = await fixture({ expiresInMs: revoked ? 60_000 : 800, authorizationPollMsForTesting: 20 });
    const reserved = await f.call('reserve', revoked ? 'run-revoked' : 'run-expired');
    f.writeSource(reserved.body.sourceRoot as string);
    const published = await f.call('publish', revoked ? 'run-revoked' : 'run-expired');
    expect(published.status).toBe(200);
    if (revoked) f.revokeGrant();
    const deadline = Date.now() + 2_500;
    while (readdirSync(join(f.root, 'runtime')).length && Date.now() < deadline) await Bun.sleep(20);
    expect(readdirSync(join(f.root, 'runtime'))).toEqual([]);
    await expect(fetch(`http://127.0.0.1:${published.body.port}/health`,
      { signal: AbortSignal.timeout(500) })).rejects.toThrow();
    const response = await f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/',
      { headers: { host: 'demo-app--test-slot.elanous.app' } }));
    expect(response?.status).toBe(404);
  }
});

test('expired test approval and wrong public marker cannot leave a live route or port lease', async () => {
  const expired = await fixture({ expired: true });
  expect((await expired.call('reserve')).status).toBe(400);
  const unpinned = await fixture({ missingSourceHead: true });
  expect((await unpinned.call('reserve')).status).toBe(400);
  expect(readdirSync(join(unpinned.root, 'sources'))).toEqual([]);
  const f = await fixture({ wrongMarker: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('publish')).status).toBe(400);
  expect(f.grantCount()).toBe(0);
  expect(readdirSync(join(f.root, 'seals', '.deployment-state')).filter(name => name.startsWith('active-'))).toEqual([]);
  const response = await f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/',
    { headers: { host: 'demo-app--test-slot.elanous.app' } }));
  expect(response?.status).toBe(404);
  expect(readdirSync(join(f.root, 'runtime'))).toEqual([]);
});

test('missing exact artifact approval refuses before service process creation', async () => {
  const f = await fixture({ denyArtifact: true });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('publish')).status).toBe(400);
  expect(readdirSync(join(f.root, 'runtime'))).toEqual([]);
});
