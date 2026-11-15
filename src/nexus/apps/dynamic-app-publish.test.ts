import { afterEach, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadNexusAppHost } from './app-host.js';
import { createDynamicAppPublisher, createDynamicAppPublishRoute, createDynamicAppDeployHook, verifiedDynamicOwner } from './dynamic-app-publish.js';
import { buildSharedAppTools } from '../../agent/shared-app-tools.js';
import { getToolLoopPhaseRejectedCalls } from '../../llm.js';

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
  authorizationPollMsForTesting?: number; denyArtifact?: boolean; missingSourceHead?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dynamic-publish-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['apps', 'sources', 'seals', 'runtime']) mkdirSync(join(root, name), { mode: 0o700 });
  const { appHost } = loadNexusAppHost(join(root, 'apps'), undefined,
    { key: randomBytes(32).toString('hex'), dir: join(root, 'sessions') });
  cleanup.push(() => appHost.close());
  const publisher = createDynamicAppPublisher({ sourceRoot: join(root, 'sources'), sealRoot: join(root, 'seals'),
    runtimeRoot: join(root, 'runtime'), appHost, testMemberId: 'member-a', testHandle: 'test-slot',
    testApprovalExpiresAt: new Date(Date.now() + (options.expired ? -60_000 : options.expiresInMs ?? 60_000)).toISOString(),
    authorizationPollMsForTesting: options.authorizationPollMsForTesting,
    issuerSourceHead: options.missingSourceHead ? undefined : 'a'.repeat(40),
    approveArtifact: () => !options.denyArtifact,
    verifyPublic: async url => {
      const response = await appHost.handle(new Request(url, { headers: { host: new URL(url).host } }));
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
  return { root, appHost, publisher, route, call, writeSource, revoke: () => { active = false; } };
}

test('actual reserve route -> source receipt -> service -> public host -> scoped undo', async () => {
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
});

test('registered app_deploy waits for verification, then consumes a sealed generated app through the owner route', async () => {
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

test('revoked owner session stops serving an already registered public route', async () => {
  const f = await fixture();
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  expect((await f.call('publish')).status).toBe(200);
  f.revoke();
  const response = await f.appHost.handle(new Request('https://demo-app--test-slot.elanous.app/',
    { headers: { host: 'demo-app--test-slot.elanous.app' } }));
  expect(response?.status).toBe(503);
});

test('expired approval permits authenticated cleanup without a publish grant', async () => {
  const f = await fixture({ expiresInMs: 1_500, authorizationPollMsForTesting: 5_000 });
  const reserved = await f.call('reserve');
  f.writeSource(reserved.body.sourceRoot as string);
  const published = await f.call('publish');
  expect(published.status).toBe(200);
  await Bun.sleep(Math.max(0, Date.parse(String(reserved.body.issuerExpiresAt)) - Date.now() + 20));
  expect((await f.call('undo', 'run-a', String(published.body.deploymentId))).status).toBe(200);
  expect(readdirSync(join(f.root, 'runtime'))).toEqual([]);
});

test('approval expiry and session revocation automatically stop service and free port', async () => {
  for (const revoked of [false, true]) {
    const f = await fixture({ expiresInMs: revoked ? 60_000 : 800, authorizationPollMsForTesting: 20 });
    const reserved = await f.call('reserve', revoked ? 'run-revoked' : 'run-expired');
    f.writeSource(reserved.body.sourceRoot as string);
    const published = await f.call('publish', revoked ? 'run-revoked' : 'run-expired');
    expect(published.status).toBe(200);
    if (revoked) f.revoke();
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
