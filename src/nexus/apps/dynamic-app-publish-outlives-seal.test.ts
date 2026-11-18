// APP-DEPLOY-OUTLIVES-BUILD-SEAL: a published app outlives the two-hour build seal.
// 11-16 01:10 an app was retired by the serving poll when its build seal expired and
// its public URL returned 404. This file drives the real run-authority seal clock past
// expiry while the serving poll keeps ticking, and proves the three boundaries:
//   (1) seal expiry alone keeps the deployment published and its public route served;
//   (2) explicit undo (revoke) retires it;
//   (3) the expired seal still denies new build work (inspect/publish).
import { afterEach, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNexusAppHost } from './app-host.js';
import { createAppBuildRunAuthority } from './app-build-run-authority.js';
import { createDynamicAppPublisher, type DeploymentGrantBinding,
  type DeploymentGrantProvider } from './dynamic-app-publish.js';

// Service activation requires macOS sandbox-exec, as in dynamic-app-publish.test.ts.
const serviceTest = process.platform === 'darwin' ? test : test.skip;
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

serviceTest('build seal expiry under the serving poll keeps the public URL; build stays denied; explicit undo retires', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dynamic-outlives-seal-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['apps', 'sources', 'seals', 'runtime']) mkdirSync(join(root, name), { mode: 0o700 });
  const { appHost } = loadNexusAppHost(join(root, 'apps'), undefined,
    { key: randomBytes(32).toString('hex'), dir: join(root, 'sessions') });
  cleanup.push(() => appHost.close());

  // Server-side deployment grant: valid well past the build seal, revocable only explicitly.
  const grants = new Map<string, DeploymentGrantBinding>();
  const deploymentGrants: DeploymentGrantProvider = {
    issue: async input => {
      const grant: DeploymentGrantBinding = { ...input, grantId: 'grant-' + randomBytes(12).toString('hex'), grantVersion: 1 };
      grants.set(grant.grantId, grant);
      return grant;
    },
    introspect: async grantId => grants.get(grantId) ?? null,
    revoke: async (grantId, owner) => {
      if (grants.get(grantId)?.ownerId !== owner.memberId) throw new Error('grant revoke refused');
      grants.delete(grantId);
    },
    revokeIssued: async grantId => { grants.delete(grantId); },
  };
  // Same fast poll as the existing grant-expiry retirement test, so many ticks run after seal expiry.
  const pollMs = 20; // 출처: #37893 (dynamic-app-publish.test.ts grant expiry poll)
  const approvalUntil = new Date(Date.now() + 60_000).toISOString(); // 출처: #37893 (fixture default expiry)
  const publisher = createDynamicAppPublisher({ sourceRoot: join(root, 'sources'), sealRoot: join(root, 'seals'),
    runtimeRoot: join(root, 'runtime'), appHost, testMemberId: 'member-a', testHandle: 'test-slot',
    testApprovalExpiresAt: approvalUntil, authorizationPollMsForTesting: pollMs,
    issuerSourceHead: 'a'.repeat(40), relayKeyId: () => 'synthetic-relay-key', deploymentGrants,
    approveArtifact: () => true,
    verifyPublic: async url => {
      const response = await appHost.handle(new Request(url, { headers: { host: new URL(url).host } }));
      return { status: response?.status ?? 404, marker: response?.headers.get('x-elanous-dynamic-route') ?? null };
    } });
  cleanup.push(() => publisher.close());

  // Real two-hour run-authority seal on an injected clock: this is the build authority.
  let time = Date.now();
  const session = { nexusUrl: 'https://api.elanous.ai', appSlug: 'demo-app', sessionToken: 'aps_synthetic' };
  const authority = createAppBuildRunAuthority({ root: join(root, 'authority'), hostKey: 'c'.repeat(64),
    now: () => time, retainedSession: () => session, relayKeyFingerprint: () => sha('emk-synthetic') });
  authority.issue({ ownerId: 'member-a', userSlug: 'test-slot', runId: 'run-a', appSlug: 'demo-app',
    sourceHead: 'a'.repeat(40), issuerExpiresAt: '2099-01-01T00:00:00Z' }, session);
  const sealHolds = () => {
    const owner = authority.resolve('run-a', 'demo-app', 'a'.repeat(40));
    return owner?.memberId === 'member-a' && owner.userSlug === 'test-slot';
  };
  expect(sealHolds()).toBe(true);

  const owner = { memberId: 'member-a', userSlug: 'test-slot' };
  const sourceRoot = publisher.reserve(owner, 'run-a', 'demo-app').sourceRoot;
  mkdirSync(sourceRoot, { mode: 0o700 });
  mkdirSync(join(sourceRoot, 'backend'), { mode: 0o700 });
  const backend = 'export default { fetch() { return new Response("demo front"); } };\n';
  writeFileSync(join(sourceRoot, 'backend/server.ts'), backend, { mode: 0o600 });
  writeFileSync(join(sourceRoot, 'ARCHITECTURE.md'), '# demo\n', { mode: 0o600 });
  writeFileSync(join(sourceRoot, 'source-artifact.json'), JSON.stringify({ schemaVersion: 'source-artifact@1',
    root: sourceRoot, files: { 'ARCHITECTURE.md': sha('# demo\n'), 'backend/server.ts': sha(backend) },
    metadata: { runtime: { startCommand: ['bun', 'backend/server.ts'], healthPath: '/health' } },
    executed: false, published: false }), { mode: 0o600 });

  const published = await publisher.publish(owner, 'run-a', 'demo-app', new Request('http://localhost/'), sealHolds);
  expect(published.status).toBe('published');
  const url = 'https://demo-app--test-slot.elanous.app/';
  const request = () => appHost.handle(new Request(url, { headers: { host: new URL(url).host } }));
  expect((await request())?.status).toBe(200);

  // Move the build clock to the seal's own recorded expiry; the seal now refuses.
  time = (JSON.parse(readFileSync(join(root, 'authority', 'run-a.json'), 'utf8')) as { expiresAt: number }).expiresAt;
  expect(sealHolds()).toBe(false);
  // Let the serving poll tick many times after seal expiry (the 11-16 retirement path).
  for (let tick = 0; tick < 10; tick++) await Bun.sleep(pollMs); // 출처: #37893 (poll ticks past seal)

  // (1) No explicit revoke: still published and publicly served; grant untouched.
  expect(publisher.isPublicSlug('demo-app')).toBe(true);
  expect(grants.size).toBe(1);
  expect(readdirSync(join(root, 'runtime'))).not.toEqual([]);
  expect((await request())?.status).toBe(200);
  expect((await request())?.status).toBe(200);

  // (3) The expired build seal still denies new build work; the app living is not a build grant.
  await expect(publisher.inspect(owner, 'run-a', 'demo-app', sealHolds)).rejects.toThrow();
  await expect(publisher.publish(owner, 'run-a', 'demo-app', new Request('http://localhost/'), sealHolds))
    .rejects.toThrow();
  expect((await request())?.status).toBe(200);

  // (2) Explicit undo revokes the server grant and retires the public route.
  const undone = await publisher.undo(owner, 'run-a', 'demo-app', published.deploymentId);
  expect(undone).toMatchObject({ status: 'undone', stopped: true, proof: 'server' });
  expect(grants.size).toBe(0);
  expect(publisher.isPublicSlug('demo-app')).toBe(false);
  expect((await request())?.status).toBe(404);
  expect(readdirSync(join(root, 'runtime'))).toEqual([]);
});
