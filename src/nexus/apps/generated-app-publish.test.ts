import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { tmpdir } from 'node:os';
import { loadNexusAppHost } from './app-host.js';
import { createAppAuth } from './app-auth.js';
import { createGeneratedAppPublisher, createGeneratedAppPublishRoute, listenOnAppHost, withGeneratedAppsPrivateIngress, type GeneratedArtifact } from './generated-app-publish.js';
import { emptyGraphCapabilityRegistry, dispatchGraphContract } from '../../graph-runner/capabilities.js';
import { registerAbsorbAppSourceProvider } from '../../graph-runner/capability-providers/absorb-app-source.js';
import { registerAppPublishProvider, createAppPublishTransport } from '../../graph-runner/capability-providers/app-publish.js';
import { withAppSourceLock } from './app-source-snapshot.js';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'generated-app-publish-'));
  const appsRoot = join(root, 'apps'); mkdirSync(appsRoot);
  const key = randomBytes(32).toString('hex');
  const { appHost } = loadNexusAppHost(appsRoot, undefined, {
    key, dir: join(root, 'auth'), databaseDirectory: join(root, 'db'),
  });
  const publisher = createGeneratedAppPublisher({ artifactRoot: root, appsRoot, appHost,
    databaseDirectory: join(root, 'db'), sessionDirectory: join(root, 'auth'),
    listen: async (host, slug, previous) => listenOnAppHost(host, slug, '127.0.0.1', true, previous) });
  const route = createGeneratedAppPublishRoute(publisher, async request => {
    const auth = request.headers.get('authorization');
    return auth === 'Bearer aps_synthetic_a' ? 'member-a' : auth === 'Bearer aps_synthetic_b' ? 'member-b' : null;
  }, 'https://nexus.example.test');
  const transport = createAppPublishTransport(() => ({ nexusUrl: 'http://127.0.0.1', sessionToken: 'aps_synthetic_a' }),
    (async (url: RequestInfo | URL, init?: RequestInit) => await route(new Request(String(url), init))
      ?? new Response(null, { status: 404 })) as typeof fetch);
  const registry = registerAppPublishProvider(emptyGraphCapabilityRegistry(), transport);
  const source = registerAbsorbAppSourceProvider(emptyGraphCapabilityRegistry(), root).providers.at(-1)!;
  const context = { graphId: 'absorb-build', runId: 'run-publish-a', nodeId: 'build', verifiedOwnerId: 'member-a',
    input: { context: { memberId: 'member-a' } }, graphInput: { context: { memberId: 'member-a' } }, outputs: {} };
  const manifestYaml = 'apiVersion: elanous.app/v0\nslug: generated-app\ntitle: Generated app\nfrontend:\n  kind: static-export\n  out: out\nroles:\n  public:\n    via: public-read\n  owner:\n    via: nexus-session\ntables:\n  notes:\n    columns:\n      id: { type: text, primary: true }\n      title: { type: text }\nrpc:\n  list:\n    sql: SELECT id, title FROM notes ORDER BY id\n    params: {}\n    allow: [owner]\n  add:\n    sql: INSERT INTO notes (id, title) VALUES (:id, :title)\n    params: { id: { type: text }, title: { type: text } }\n    allow: [owner]\n';
  const html = '<!doctype html><html><body><h1>Generated application</h1></body></html>';
  const built = await source.invoke({ ...context, nodeInput: { memberId: 'member-a', appId: 'generated-app',
    suggestion: { owner: 'member-a', appId: 'generated-app' }, draft: { manifestYaml, html } } });
  const artifact = (built.result as { artifact: GeneratedArtifact }).artifact;
  const invoke = (input: Record<string, unknown>, contract = 'app-publish.action@1' as 'app.publish@1' | 'app-publish.action@1') =>
    dispatchGraphContract(contract, { ...context, nodeId: String(input.action), nodeInput: { requireOwner: 'member-a', ...input } }, registry);
  return { root, appsRoot, key, appHost, publisher, route, artifact, invoke, context,
    cleanup: () => { publisher.close(); appHost.close(); rmSync(root, { recursive: true, force: true }); } };
}

async function otherMemberArtifact(f: Awaited<ReturnType<typeof fixture>>, runId = 'run-publish-b') {
  const source = registerAbsorbAppSourceProvider(emptyGraphCapabilityRegistry(), f.root).providers.at(-1)!;
  const built = await source.invoke({ ...f.context, runId, verifiedOwnerId: 'member-b',
    input: { context: { memberId: 'member-b' } }, graphInput: { context: { memberId: 'member-b' } },
    nodeInput: { memberId: 'member-b', appId: 'generated-app',
      suggestion: { owner: 'member-b', appId: 'generated-app' },
      draft: { manifestYaml: stringify({ ...f.artifact.manifest, title: 'Other member' }),
        html: '<!doctype html><html><body><h1>Other member</h1></body></html>' } } });
  expect(built.ok).toBe(true);
  return (built.result as { artifact: GeneratedArtifact }).artifact;
}

test('actual writer -> capability HTTP consumer -> existing app host -> URL -> own undo, without a template', async () => {
  const f = await fixture();
  try {
    const simulated = await f.invoke({ action: 'simulate', artifact: f.artifact });
    expect(simulated).toMatchObject({ ok: true, outcome: 'done' });
    expect(simulated).toMatchObject({ ok: true, outcome: 'done' });
    const receipt = (simulated.evidence as { receipt: string }).receipt;
    const published = await f.invoke({ action: 'publish', artifact: f.artifact, receipt, requirePassingReceipt: true });
    expect(published).toMatchObject({ ok: true, result: { status: 'published', runId: f.context.runId } });
    const result = published.result as { resultUrl: string; deploymentId: string };
    expect((await fetch(result.resultUrl)).status).toBe(200);
    const ingress = withGeneratedAppsPrivateIngress(f.appHost, f.publisher.isPrivateSlug);
    for (const host of ['generated-app.app.localhost', 'generated-app--synthetic.elanous.app']) {
      expect((await ingress.handle(new Request('http://' + host + '/', { headers: { host } })))?.status).toBe(404);
    }
    expect(await (await fetch(result.resultUrl)).text()).toContain('Generated application');
    expect((await fetch(result.resultUrl, { method: 'POST', headers: { origin: 'https://foreign.example.test' } })).status).toBe(403);
    const repeated = await f.invoke({ action: 'publish', artifact: f.artifact, receipt, requirePassingReceipt: true });
    expect(repeated.result).toMatchObject({ deploymentId: result.deploymentId, resultUrl: result.resultUrl });
    const foreign = await f.route(new Request('http://127.0.0.1/v1/apps/generated-app/generated-deployment', {
      method: 'POST', headers: { authorization: 'Bearer aps_synthetic_b', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'undo', runId: f.context.runId, deploymentId: result.deploymentId }),
    }));
    expect(foreign?.status).toBe(400);
    expect((await fetch(result.resultUrl)).status).toBe(200);
    const undone = await f.invoke({ action: 'undo', appSlug: 'generated-app',
      deploymentRunId: f.context.runId, deploymentId: result.deploymentId }, 'app.publish@1');
    expect(undone).toMatchObject({ ok: true, result: { status: 'undone' } });
    expect(f.appHost.slugs).not.toContain('generated-app');
    expect(existsSync(join(f.appsRoot, 'generated-app'))).toBe(false);
    expect(existsSync(f.artifact.staticExportDir)).toBe(true);
    expect(f.publisher.isPrivateSlug('generated-app')).toBe(false);
    const republished = await f.invoke({ action: 'publish', artifact: f.artifact, receipt, requirePassingReceipt: true });
    const next = republished.result as { resultUrl: string; deploymentId: string };
    expect(next.deploymentId).not.toBe(result.deploymentId);
    expect((await f.invoke({ action: 'undo', appSlug: 'generated-app',
      deploymentRunId: f.context.runId, deploymentId: result.deploymentId })).ok).toBe(true);
    expect((await fetch(next.resultUrl)).status).toBe(200);
    expect(f.publisher.isPrivateSlug('generated-app')).toBe(true);
  } finally { f.cleanup(); }
});

test('undo keeps the slug bound to its verified member across publisher restart', async () => {
  const f = await fixture();
  let restarted: ReturnType<typeof createGeneratedAppPublisher> | undefined;
  try {
    const aSimulation = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    const aDeployment = await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: aSimulation.receipt });
    const aSession = f.appHost.issueOwnerSession('generated-app', 'member-a');
    const aCookie = `__Host-app-session=${aSession.sessionToken}`;
    const rpc = (name: string, cookie?: string, params: Record<string, unknown> = {}) => f.appHost.handle(new Request(
      'http://generated-app.app.localhost/__rpc/' + name, { method: 'POST', headers: {
        host: 'generated-app.app.localhost', 'content-type': 'application/json',
        ...(cookie ? { cookie, origin: 'http://generated-app.app.localhost' } : {}),
      }, body: JSON.stringify({ params }) }));
    expect((await rpc('add', aCookie, { id: 'a-1', title: 'member-a private row' }))?.status).toBe(200);
    expect((await rpc('list'))?.status).toBe(403);
    await f.publisher.execute('member-a', { action: 'undo', runId: f.context.runId, deploymentId: aDeployment.deploymentId });
    f.publisher.close();
    restarted = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth'), appHost: f.appHost,
      listen: async (host, slug, previous) => listenOnAppHost(host, slug, '127.0.0.1', true, previous) });

    // A second member uses the real source writer and receives a valid simulation receipt.
    const bRun = 'run-publish-b';
    const bArtifact = await otherMemberArtifact(f, bRun);
    const bSimulation = await restarted.execute('member-b', { action: 'simulate', runId: bRun, artifact: bArtifact });
    await expect(restarted.execute('member-b', { action: 'publish', runId: bRun,
      artifact: bArtifact, receipt: bSimulation.receipt })).rejects.toThrow('generated app operation refused');
    expect(existsSync(join(f.appsRoot, 'generated-app'))).toBe(false);
    expect(restarted.isPrivateSlug('generated-app')).toBe(false);
    const aAgain = await restarted.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: aSimulation.receipt });
    expect((await fetch(String(aAgain.resultUrl))).status).toBe(200);
    expect(await (await fetch(String(aAgain.resultUrl))).text()).toContain('Generated application');
    expect((await rpc('list'))?.status).toBe(403);
    const rows = await rpc('list', aCookie);
    expect(rows?.status).toBe(200);
    expect(await rows?.json()).toEqual({ rows: [{ id: 'a-1', title: 'member-a private row' }] });
  } finally { restarted?.close(); f.cleanup(); }
});

test('actual publish route keeps owner DB and app session private through undo and foreign retry', async () => {
  const f = await fixture();
  try {
    const post = async (token: string, body: Record<string, unknown>) => await f.route(new Request(
      'http://127.0.0.1/v1/apps/generated-app/generated-deployment', {
        method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })) ?? new Response(null, { status: 404 });
    const aSim = await post('aps_synthetic_a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    expect(aSim.status).toBe(200);
    const aReceipt = (await aSim.json() as { receipt: string }).receipt;
    const aPublish = await post('aps_synthetic_a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: aReceipt });
    expect(aPublish.status).toBe(200);
    const aResult = await aPublish.json() as { resultUrl: string; deploymentId: string };
    const aSession = f.appHost.issueOwnerSession('generated-app', 'member-a');
    const rpc = async (url: string, name: string, cookie?: string, params: Record<string, unknown> = {}) => await fetch(
      new URL('/__rpc/' + name, url), { method: 'POST', headers: { 'content-type': 'application/json',
        ...(cookie ? { cookie: '__Host-app-session=' + cookie, origin: new URL(url).origin } : {}),
      }, body: JSON.stringify({ params }) });
    expect((await rpc(aResult.resultUrl, 'add', aSession.sessionToken, { id: 'private-a', title: 'owner-a row' })).status).toBe(200);
    expect((await rpc(aResult.resultUrl, 'list')).status).toBe(403);
    expect((await post('aps_synthetic_a', { action: 'undo', runId: f.context.runId,
      deploymentId: aResult.deploymentId })).status).toBe(200);
    const bArtifact = await otherMemberArtifact(f);
    const bSim = await post('aps_synthetic_b', { action: 'simulate', runId: bArtifact.runId, artifact: bArtifact });
    expect(bSim.status).toBe(200);
    const bReceipt = (await bSim.json() as { receipt: string }).receipt;
    expect((await post('aps_synthetic_b', { action: 'publish', runId: bArtifact.runId,
      artifact: bArtifact, receipt: bReceipt })).status).toBe(400);
    const aAgain = await post('aps_synthetic_a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: aReceipt });
    expect(aAgain.status).toBe(200);
    const aAgainUrl = (await aAgain.json() as { resultUrl: string }).resultUrl;
    expect((await rpc(aAgainUrl, 'list')).status).toBe(403);
    const rows = await rpc(aAgainUrl, 'list', aSession.sessionToken);
    expect(rows.status).toBe(200);
    expect(await rows.json()).toEqual({ rows: [{ id: 'private-a', title: 'owner-a row' }] });
  } finally { f.cleanup(); }
});

for (const damage of ['missing', 'untrusted-mode'] as const) test('actual publish route refuses a new owner when the old receipt is ' + damage + ' but DB remains', async () => {
  const f = await fixture();
  try {
    const post = async (token: string, body: Record<string, unknown>) => await f.route(new Request(
      'http://127.0.0.1/v1/apps/generated-app/generated-deployment', {
        method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })) ?? new Response(null, { status: 404 });
    const aSim = await post('aps_synthetic_a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    expect(aSim.status).toBe(200);
    const aReceipt = (await aSim.json() as { receipt: string }).receipt;
    const aPublish = await post('aps_synthetic_a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: aReceipt });
    expect(aPublish.status).toBe(200);
    const deploymentId = (await aPublish.json() as { deploymentId: string }).deploymentId;
    expect((await post('aps_synthetic_a', { action: 'undo', runId: f.context.runId, deploymentId })).status).toBe(200);
    const database = join(f.root, 'db', 'generated-app.db');
    expect(existsSync(database)).toBe(true);
    const receiptPath = join(f.root, 'generated-app-deployments', deploymentId + '.json');
    if (damage === 'missing') rmSync(receiptPath);
    else chmodSync(receiptPath, 0o644);
    const bArtifact = await otherMemberArtifact(f);
    const bSim = await post('aps_synthetic_b', { action: 'simulate', runId: bArtifact.runId, artifact: bArtifact });
    expect(bSim.status).toBe(200);
    const bReceipt = (await bSim.json() as { receipt: string }).receipt;
    expect((await post('aps_synthetic_b', { action: 'publish', runId: bArtifact.runId,
      artifact: bArtifact, receipt: bReceipt })).status).toBe(400);
    expect(existsSync(database)).toBe(true);
    expect(existsSync(join(f.appsRoot, 'generated-app'))).toBe(false);
  } finally { f.cleanup(); }
});

test('app host refuses a foreign owner session on a generated mount', async () => {
  const f = await fixture();
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    const staleForeign = createAppAuth({ key: f.key, dir: join(f.root, 'auth', 'generated-app') })
      .issueTrustedSession({ appSlug: 'generated-app', memberId: 'member-b', role: 'owner' });
    const a = f.appHost.issueOwnerSession('generated-app', 'member-a');
    expect(a.sessionToken).toStartWith('aps_');
    expect(() => f.appHost.issueOwnerSession('generated-app', 'member-b')).toThrow();
    const foreignRpc = await f.appHost.handle(new Request('http://generated-app.app.localhost/__rpc/list', {
      method: 'POST', headers: { host: 'generated-app.app.localhost', origin: 'http://generated-app.app.localhost',
        cookie: '__Host-app-session=' + staleForeign.sessionToken, 'content-type': 'application/json' },
      body: JSON.stringify({ params: {} }),
    }));
    expect(foreignRpc?.status).toBe(401);
  } finally { f.cleanup(); }
});

test('generated owner RPC refuses a legacy shared invitation claiming the owner role', async () => {
  const f = await fixture();
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    const owner = f.appHost.issueOwnerSession('generated-app', 'member-a');
    const rpc = (cookie: string, name: string, params: Record<string, string>) => f.appHost.handle(new Request(
      'http://generated-app.app.localhost/__rpc/' + name, { method: 'POST', headers: {
        host: 'generated-app.app.localhost', origin: 'http://generated-app.app.localhost',
        cookie, 'content-type': 'application/json',
      }, body: JSON.stringify({ params }) }));
    expect((await rpc('__Host-app-session=' + owner.sessionToken, 'add', { id: 'owner-secret', title: 'private' }))?.status).toBe(200);
    const invitation = createAppAuth({ key: f.key, dir: join(f.root, 'auth', 'generated-app') })
      .issueInvitation({ appSlug: 'generated-app', invitedBy: 'member-a', role: 'owner' });
    const accepted = await f.appHost.handle(new Request(
      'http://generated-app.app.localhost/__auth/accept?token=' + encodeURIComponent(invitation.token),
      { headers: { host: 'generated-app.app.localhost' } }));
    expect(accepted?.status).toBe(303);
    const invitedCookie = accepted?.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(invitedCookie).toStartWith('__Host-app-session=');
    expect((await rpc(invitedCookie, 'list', {}))?.status).toBe(401);
    expect((await rpc('__Host-app-session=' + owner.sessionToken, 'list', {}))?.status).toBe(200);
  } finally { f.cleanup(); }
});

test('app host refuses a different generated source on the previous owner DB and session', async () => {
  const f = await fixture();
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    const published = await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    const a = f.appHost.issueOwnerSession('generated-app', 'member-a');
    const rpc = (name: string) => f.appHost.handle(new Request('http://generated-app.app.localhost/__rpc/' + name, {
      method: 'POST', headers: { host: 'generated-app.app.localhost', origin: 'http://generated-app.app.localhost',
        cookie: '__Host-app-session=' + a.sessionToken, 'content-type': 'application/json' },
      body: JSON.stringify({ params: name === 'add' ? { id: 'a-private', title: 'member-a-only' } : {} }),
    }));
    expect((await rpc('add'))?.status).toBe(200);
    await f.publisher.execute('member-a', { action: 'undo', runId: f.context.runId, deploymentId: published.deploymentId });
    const other = await otherMemberArtifact(f);
    const target = join(f.appsRoot, 'generated-app');
    cpSync(dirname(other.staticExportDir), target, { recursive: true });
    expect(() => f.appHost.mountDirectory('generated-app')).toThrow();
    expect(f.appHost.slugs).not.toContain('generated-app');
    rmSync(target, { recursive: true });
    const again = await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    expect((await fetch(String(again.resultUrl))).status).toBe(200);
    expect((await rpc('list'))?.status).toBe(200);
  } finally { f.cleanup(); }
});

test('generated owner binding survives host restart with the original owner session and DB row', async () => {
  const f = await fixture();
  let host: ReturnType<typeof loadNexusAppHost>['appHost'] | undefined;
  let publisher: ReturnType<typeof createGeneratedAppPublisher> | undefined;
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    const session = f.appHost.issueOwnerSession('generated-app', 'member-a');
    const rpc = (target: typeof f.appHost, name: string) => target.handle(new Request('http://generated-app.app.localhost/__rpc/' + name, {
      method: 'POST', headers: { host: 'generated-app.app.localhost', origin: 'http://generated-app.app.localhost',
        cookie: '__Host-app-session=' + session.sessionToken, 'content-type': 'application/json' },
      body: JSON.stringify({ params: name === 'add' ? { id: 'a-private', title: 'member-a-only' } : {} }),
    }));
    expect((await rpc(f.appHost, 'add'))?.status).toBe(200);
    f.publisher.close(); f.appHost.close();
    host = loadNexusAppHost(f.appsRoot, undefined, { key: f.key, dir: join(f.root, 'auth'),
      databaseDirectory: join(f.root, 'db') }).appHost;
    publisher = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, appHost: host,
      databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth'),
      listen: async (appHost, slug, previous) => listenOnAppHost(appHost, slug, '127.0.0.1', true, previous) });
    expect(await publisher.restore()).toEqual({ restored: 1, unavailable: 0 });
    expect(() => host!.issueOwnerSession('generated-app', 'member-b')).toThrow();
    const rows = await rpc(host, 'list');
    expect(rows?.status).toBe(200);
    expect(await rows?.json()).toEqual({ rows: [{ id: 'a-private', title: 'member-a-only' }] });
  } finally { publisher?.close(); host?.close(); f.cleanup(); }
});

test('damaged generated owner binding refuses owner sessions and RPC without deleting DB', async () => {
  const f = await fixture();
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    const session = f.appHost.issueOwnerSession('generated-app', 'member-a');
    const ownerFile = join(f.root, 'auth', '.generated-owner-bindings', 'generated-app.json');
    chmodSync(ownerFile, 0o644);
    expect(() => f.appHost.issueOwnerSession('generated-app', 'member-b')).toThrow();
    const response = await f.appHost.handle(new Request('http://generated-app.app.localhost/__rpc/list', {
      method: 'POST', headers: { host: 'generated-app.app.localhost', origin: 'http://generated-app.app.localhost',
        cookie: '__Host-app-session=' + session.sessionToken, 'content-type': 'application/json' },
      body: JSON.stringify({ params: {} }),
    }));
    expect(response?.status).toBe(404);
    expect(existsSync(join(f.root, 'db', 'generated-app.db'))).toBe(true);
  } finally { f.cleanup(); }
});

test('RPC rechecks generated owner binding after reading the request body', async () => {
  const f = await fixture();
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    const session = f.appHost.issueOwnerSession('generated-app', 'member-a');
    const ownerFile = join(f.root, 'auth', '.generated-owner-bindings', 'generated-app.json');
    const response = await f.appHost.handle(new Request('http://generated-app.app.localhost/__rpc/list', {
      method: 'POST', headers: { host: 'generated-app.app.localhost', origin: 'http://generated-app.app.localhost',
        cookie: '__Host-app-session=' + session.sessionToken, 'content-type': 'application/json' },
      body: new ReadableStream({ pull(controller) {
        chmodSync(ownerFile, 0o644);
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ params: {} })));
        controller.close();
      } }), duplex: 'half',
    } as RequestInit));
    expect(response?.status).toBe(401);
    expect(existsSync(join(f.root, 'db', 'generated-app.db'))).toBe(true);
  } finally { f.cleanup(); }
});

test('legacy deployment receipt restores a missing host owner binding before sessions resume', async () => {
  const f = await fixture();
  let host: ReturnType<typeof loadNexusAppHost>['appHost'] | undefined;
  let publisher: ReturnType<typeof createGeneratedAppPublisher> | undefined;
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    f.publisher.close(); f.appHost.close();
    const ownerFile = join(f.root, 'auth', '.generated-owner-bindings', 'generated-app.json');
    rmSync(ownerFile);
    host = loadNexusAppHost(f.appsRoot, undefined, { key: f.key, dir: join(f.root, 'auth'),
      databaseDirectory: join(f.root, 'db') }).appHost;
    expect(() => host!.issueOwnerSession('generated-app', 'member-b')).toThrow();
    publisher = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, appHost: host,
      databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth'),
      listen: async (appHost, slug, previous) => listenOnAppHost(appHost, slug, '127.0.0.1', true, previous) });
    expect(existsSync(ownerFile)).toBe(true);
    expect(await publisher.restore()).toEqual({ restored: 1, unavailable: 0 });
    expect(host.issueOwnerSession('generated-app', 'member-a').sessionToken).toStartWith('aps_');
    expect(() => host!.issueOwnerSession('generated-app', 'member-b')).toThrow();
  } finally { publisher?.close(); host?.close(); f.cleanup(); }
});

test('unknown generated source owner stays private when receipt and binding are both absent', async () => {
  const f = await fixture();
  let host: ReturnType<typeof loadNexusAppHost>['appHost'] | undefined;
  let publisher: ReturnType<typeof createGeneratedAppPublisher> | undefined;
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    const published = await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    f.publisher.close(); f.appHost.close();
    rmSync(join(f.root, 'auth', '.generated-owner-bindings', 'generated-app.json'));
    rmSync(join(f.root, 'generated-app-deployments', String(published.deploymentId) + '.json'));
    host = loadNexusAppHost(f.appsRoot, undefined, { key: f.key, dir: join(f.root, 'auth'),
      databaseDirectory: join(f.root, 'db') }).appHost;
    publisher = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, appHost: host,
      databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth') });
    expect(() => host!.issueOwnerSession('generated-app', 'member-b')).toThrow();
    expect((await host.handle(new Request('http://generated-app.app.localhost/', {
      headers: { host: 'generated-app.app.localhost' } })))?.status).toBe(404);
    expect(existsSync(join(f.root, 'db', 'generated-app.db'))).toBe(true);
  } finally { publisher?.close(); host?.close(); f.cleanup(); }
});

for (const nextOwner of [null, 'member-b']) test('publish refuses an owner session that becomes ' + (nextOwner ?? 'absent') + ' after the initial route check', async () => {
  const f = await fixture();
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    let checks = 0;
    const route = createGeneratedAppPublishRoute(f.publisher, async () => ++checks === 1 ? 'member-a' : nextOwner,
      'https://nexus.example.test');
    const response = await route(new Request('http://127.0.0.1/v1/apps/generated-app/generated-deployment', {
      method: 'POST', headers: { authorization: 'Bearer aps_synthetic_a', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'publish', runId: f.context.runId, artifact: f.artifact, receipt: simulated.receipt }),
    }));
    expect(response?.status).toBe(400);
    expect(checks).toBe(2);
    expect(existsSync(join(f.appsRoot, 'generated-app'))).toBe(false);
  } finally { f.cleanup(); }
});

test('generated publish route releases a stalled body when the request is aborted', async () => {
  const f = await fixture();
  const abort = new AbortController();
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let bodyReadStarted: () => void = () => {};
  const reading = new Promise<void>(resolve => { bodyReadStarted = resolve; });
  try {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      bodyController = controller;
      controller.enqueue(new TextEncoder().encode('{"action":"publish"'));
    }, pull() { bodyReadStarted(); } });
    const request = new Request('http://127.0.0.1/v1/apps/generated-app/generated-deployment', {
      method: 'POST', headers: { authorization: 'Bearer aps_synthetic_a', 'content-type': 'application/json' },
      body, signal: abort.signal, duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const pending = f.route(request);
    await reading;
    abort.abort();
    const settled = await Promise.race([pending.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 100))]);
    expect(settled).toBe(true);
    expect((await pending)?.status).toBe(400);
    expect(existsSync(join(f.appsRoot, 'generated-app'))).toBe(false);
  } finally {
    try { bodyController?.close(); } catch { /* the body may already be cancelled */ }
    f.cleanup();
  }
});

test('generated publish route releases a stalled owner lookup when the request is aborted', async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    const route = createGeneratedAppPublishRoute(f.publisher, async () => await new Promise<string | null>(() => {}));
    const pending = route(new Request('http://127.0.0.1/v1/apps/generated-app/generated-deployment', {
      method: 'POST', headers: { authorization: 'Bearer aps_synthetic_a', 'content-type': 'application/json' },
      body: '{}', signal: abort.signal,
    }));
    abort.abort();
    const settled = await Promise.race([pending.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 100))]);
    expect(settled).toBe(true);
    expect((await pending)?.status).toBe(400);
    expect(existsSync(join(f.appsRoot, 'generated-app'))).toBe(false);
  } finally { f.cleanup(); }
});

test('publish refuses when owner expires while waiting for the slug source lock', async () => {
  const f = await fixture();
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const enteredLock = new Promise<void>(resolve => { entered = resolve; });
  const held = withAppSourceLock('generated-app', join(f.appsRoot, 'generated-app'), async () => {
    entered();
    await new Promise<void>(resolve => { release = resolve; });
  });
  try {
    await enteredLock;
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    let owner: string | null = 'member-a';
    let checks = 0;
    const route = createGeneratedAppPublishRoute(f.publisher, async () => { checks++; return owner; });
    const pending = route(new Request('http://127.0.0.1/v1/apps/generated-app/generated-deployment', {
      method: 'POST', headers: { authorization: 'Bearer aps_synthetic_a', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'publish', runId: f.context.runId, artifact: f.artifact, receipt: simulated.receipt }),
    }));
    for (let i = 0; i < 100 && checks < 2; i++) await Bun.sleep(5);
    expect(checks).toBe(2);
    owner = null;
    release();
    await held;
    const response = await pending;
    expect(response?.status).toBe(400);
    expect(existsSync(join(f.appsRoot, 'generated-app'))).toBe(false);
  } finally { release(); await held; f.cleanup(); }
});

test('owner expiry after staging leaves an unbound receipt and permits a new verified member', async () => {
  const f = await fixture();
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    let checks = 0;
    const route = createGeneratedAppPublishRoute(f.publisher, async () => ++checks <= 3 ? 'member-a' : null);
    const response = await route(new Request('http://127.0.0.1/v1/apps/generated-app/generated-deployment', {
      method: 'POST', headers: { authorization: 'Bearer aps_synthetic_a', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'publish', runId: f.context.runId, artifact: f.artifact, receipt: simulated.receipt }),
    }));
    expect(response?.status).toBe(400);
    expect(checks).toBe(4);
    expect(existsSync(join(f.appsRoot, 'generated-app'))).toBe(false);
    const ledger = join(f.root, 'generated-app-deployments');
    const receiptName = readdirSync(ledger).find(name => /^dep-[0-9a-f]{64}\.json$/.test(name));
    expect(receiptName).toBeDefined();
    expect(JSON.parse(readFileSync(join(ledger, receiptName!), 'utf8'))).toMatchObject({ state: 'undone', ownerBound: false });
    const other = await otherMemberArtifact(f);
    const bSimulated = await f.publisher.execute('member-b', { action: 'simulate', runId: other.runId, artifact: other });
    const published = await f.publisher.execute('member-b', { action: 'publish', runId: other.runId,
      artifact: other, receipt: bSimulated.receipt });
    expect(await (await fetch(String(published.resultUrl))).text()).toContain('Other member');
  } finally { f.cleanup(); }
});

test('undo preserves the live app when owner expires while waiting for its source lock', async () => {
  const f = await fixture();
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const enteredLock = new Promise<void>(resolve => { entered = resolve; });
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    const published = await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    const held = withAppSourceLock('generated-app', join(f.appsRoot, 'generated-app'), async () => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
    });
    try {
      await enteredLock;
      let owner: string | null = 'member-a';
      let checks = 0;
      const route = createGeneratedAppPublishRoute(f.publisher, async () => { checks++; return owner; });
      const pending = route(new Request('http://127.0.0.1/v1/apps/generated-app/generated-deployment', {
        method: 'POST', headers: { authorization: 'Bearer aps_synthetic_a', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'undo', runId: f.context.runId, deploymentId: published.deploymentId }),
      }));
      for (let i = 0; i < 100 && checks < 2; i++) await Bun.sleep(5);
      expect(checks).toBe(2);
      owner = null;
      release();
      await held;
      expect((await pending)?.status).toBe(400);
      expect(existsSync(join(f.appsRoot, 'generated-app'))).toBe(true);
      expect((await fetch(String(published.resultUrl))).status).toBe(200);
    } finally { release(); await held; }
  } finally { f.cleanup(); }
});

test('simulation expiry refuses to write a reusable receipt', async () => {
  const f = await fixture();
  try {
    let checks = 0;
    const route = createGeneratedAppPublishRoute(f.publisher, async () => ++checks <= 2 ? 'member-a' : null);
    const response = await route(new Request('http://127.0.0.1/v1/apps/generated-app/generated-deployment', {
      method: 'POST', headers: { authorization: 'Bearer aps_synthetic_a', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'simulate', runId: f.context.runId, artifact: f.artifact }),
    }));
    expect(response?.status).toBe(400);
    expect(checks).toBe(3);
    expect(readdirSync(join(f.root, 'generated-app-deployments')).filter(name => name.startsWith('sim-'))).toEqual([]);
    expect(f.appHost.slugs).toEqual([]);
  } finally { f.cleanup(); }
});

test('repeat publish refuses an expired owner without replacing the live URL', async () => {
  const f = await fixture();
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const enteredLock = new Promise<void>(resolve => { entered = resolve; });
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    const published = await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    const held = withAppSourceLock('generated-app', join(f.appsRoot, 'generated-app'), async () => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
    });
    try {
      await enteredLock;
      let owner: string | null = 'member-a';
      let checks = 0;
      const route = createGeneratedAppPublishRoute(f.publisher, async () => { checks++; return owner; });
      const pending = route(new Request('http://127.0.0.1/v1/apps/generated-app/generated-deployment', {
        method: 'POST', headers: { authorization: 'Bearer aps_synthetic_a', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'publish', runId: f.context.runId, artifact: f.artifact, receipt: simulated.receipt }),
      }));
      for (let i = 0; i < 100 && checks < 2; i++) await Bun.sleep(5);
      expect(checks).toBe(2);
      owner = null;
      release();
      await held;
      expect((await pending)?.status).toBe(400);
      expect((await fetch(String(published.resultUrl))).status).toBe(200);
      expect(readdirSync(join(f.root, 'generated-app-deployments')).filter(name => name.startsWith('dep-'))).toHaveLength(1);
    } finally { release(); await held; }
  } finally { f.cleanup(); }
});

test('cookie publish refuses an expired owner after the source lock wait', async () => {
  const f = await fixture();
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const enteredLock = new Promise<void>(resolve => { entered = resolve; });
  const held = withAppSourceLock('generated-app', join(f.appsRoot, 'generated-app'), async () => {
    entered();
    await new Promise<void>(resolve => { release = resolve; });
  });
  try {
    await enteredLock;
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    let owner: string | null = 'member-a';
    let checks = 0;
    const route = createGeneratedAppPublishRoute(f.publisher, async () => { checks++; return owner; },
      'https://nexus.example.test');
    const pending = route(new Request('http://127.0.0.1/v1/apps/generated-app/generated-deployment', {
      method: 'POST', headers: { cookie: 'synthetic-owner-session=a', origin: 'https://nexus.example.test',
        'content-type': 'application/json' },
      body: JSON.stringify({ action: 'publish', runId: f.context.runId, artifact: f.artifact, receipt: simulated.receipt }),
    }));
    for (let i = 0; i < 100 && checks < 2; i++) await Bun.sleep(5);
    expect(checks).toBe(2);
    owner = null;
    release();
    await held;
    expect((await pending)?.status).toBe(400);
    expect(existsSync(join(f.appsRoot, 'generated-app'))).toBe(false);
  } finally { release(); await held; f.cleanup(); }
});

for (const abandonedState of ['undone', 'pending'] as const) {
  test('a real pre-mount failure leaves a reusable ' + abandonedState + ' receipt', async () => {
    const f = await fixture();
    let slugReads = 0;
    const failingHost = new Proxy(f.appHost, { get(target, property, receiver) {
      if (property === 'slugs' && ++slugReads === 2) throw new Error('fake pre-mount host read failed');
      return Reflect.get(target, property, receiver);
    } });
    const failing = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth'), appHost: failingHost });
    let restarted: ReturnType<typeof createGeneratedAppPublisher> | undefined;
    try {
      const aSimulation = await failing.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
      await expect(failing.execute('member-a', { action: 'publish', runId: f.context.runId,
        artifact: f.artifact, receipt: aSimulation.receipt })).rejects.toThrow('fake pre-mount host read failed');
      expect(existsSync(join(f.root, 'db', 'generated-app.db'))).toBe(false);
      expect(existsSync(join(f.appsRoot, 'generated-app'))).toBe(false);
      const ledger = join(f.root, 'generated-app-deployments');
      const receipts = readdirSync(ledger).filter(name => /^dep-[0-9a-f]{64}\.json$/.test(name));
      expect(receipts).toHaveLength(1);
      const receiptPath = join(ledger, receipts[0]!);
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      expect(receipt).toMatchObject({ ownerId: 'member-a', slug: 'generated-app', state: 'undone', ownerBound: false });
      if (abandonedState === 'pending') writeFileSync(receiptPath, JSON.stringify({ ...receipt, state: 'pending' }));
      failing.close();
      restarted = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth'), appHost: f.appHost,
        listen: async (host, slug, previous) => listenOnAppHost(host, slug, '127.0.0.1', true, previous) });
      const artifact = await otherMemberArtifact(f);
      const simulated = await restarted.execute('member-b', { action: 'simulate', runId: artifact.runId, artifact });
      const published = await restarted.execute('member-b', { action: 'publish', runId: artifact.runId,
        artifact, receipt: simulated.receipt });
      expect(await (await fetch(String(published.resultUrl))).text()).toContain('Other member');
      if (abandonedState === 'pending') {
        await restarted.execute('member-a', { action: 'undo', runId: f.context.runId, deploymentId: receipt.id });
        expect((await fetch(String(published.resultUrl))).status).toBe(200);
      }
    } finally { restarted?.close(); failing.close(); f.cleanup(); }
  });
}

test('a failed source rename releases the slug without deleting a foreign path', async () => {
  const f = await fixture();
  const target = join(f.appsRoot, 'generated-app');
  let slugReads = 0;
  const failingHost = new Proxy(f.appHost, { get(host, property, receiver) {
    if (property === 'slugs' && ++slugReads === 2) writeFileSync(target, 'foreign path', { flag: 'wx' });
    return Reflect.get(host, property, receiver);
  } });
  const failing = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth'), appHost: failingHost });
  try {
    const simulated = await failing.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    await expect(failing.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt })).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('foreign path');
    expect(existsSync(join(f.root, 'db', 'generated-app.db'))).toBe(false);
    const ledger = join(f.root, 'generated-app-deployments');
    const receiptPath = join(ledger, readdirSync(ledger).find(name => /^dep-[0-9a-f]{64}\.json$/.test(name))!);
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toMatchObject({
      ownerId: 'member-a', state: 'undone', ownerBound: false,
    });
    rmSync(target);
    const artifact = await otherMemberArtifact(f);
    const bSimulation = await f.publisher.execute('member-b', { action: 'simulate', runId: artifact.runId, artifact });
    const published = await f.publisher.execute('member-b', { action: 'publish', runId: artifact.runId,
      artifact, receipt: bSimulation.receipt });
    expect((await fetch(String(published.resultUrl))).status).toBe(200);
  } finally { failing.close(); f.cleanup(); }
});

test('a failed listener after mount keeps durable auth and DB with the first member', async () => {
  const f = await fixture();
  const failing = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth'), appHost: f.appHost,
    listen: async () => { throw new Error('fake listener unavailable'); } });
  try {
    const simulated = await failing.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    await expect(failing.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt })).rejects.toThrow('fake listener unavailable');
    expect(existsSync(join(f.root, 'db', 'generated-app.db'))).toBe(true);
    expect(existsSync(join(f.appsRoot, 'generated-app'))).toBe(false);
    const artifact = await otherMemberArtifact(f);
    const bSimulation = await f.publisher.execute('member-b', { action: 'simulate', runId: artifact.runId, artifact });
    await expect(f.publisher.execute('member-b', { action: 'publish', runId: artifact.runId,
      artifact, receipt: bSimulation.receipt })).rejects.toThrow('generated app operation refused');
    const aAgain = await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    expect((await fetch(String(aAgain.resultUrl))).status).toBe(200);
  } finally { failing.close(); f.cleanup(); }
});

for (const survivingState of ['database', 'session'] as const) {
  test('a ' + survivingState + ' without a trusted owner receipt refuses first-writer takeover', async () => {
    const f = await fixture();
    try {
      const aSimulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
      const published = await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
        artifact: f.artifact, receipt: aSimulated.receipt });
      if (survivingState === 'session') f.appHost.issueOwnerSession('generated-app', 'member-a');
      await f.publisher.execute('member-a', { action: 'undo', runId: f.context.runId, deploymentId: published.deploymentId });
      const dbPath = join(f.root, 'db', 'generated-app.db');
      const authPath = join(f.root, 'auth', 'generated-app');
      if (survivingState === 'session') rmSync(dbPath);
      expect(existsSync(survivingState === 'database' ? dbPath : authPath)).toBe(true);
      rmSync(join(f.root, 'generated-app-deployments', String(published.deploymentId) + '.json'));
      const bArtifact = await otherMemberArtifact(f);
      const bSimulated = await f.publisher.execute('member-b', { action: 'simulate', runId: bArtifact.runId, artifact: bArtifact });
      await expect(f.publisher.execute('member-b', { action: 'publish', runId: bArtifact.runId,
        artifact: bArtifact, receipt: bSimulated.receipt })).rejects.toThrow('generated app operation refused');
      expect(existsSync(join(f.appsRoot, 'generated-app'))).toBe(false);
    } finally { f.cleanup(); }
  });
}

test('conflicting legacy owner receipts refuse both claimants without mounting', async () => {
  const f = await fixture();
  try {
    const aSimulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    const published = await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: aSimulated.receipt });
    await f.publisher.execute('member-a', { action: 'undo', runId: f.context.runId, deploymentId: published.deploymentId });
    const ledger = join(f.root, 'generated-app-deployments');
    const receipt = JSON.parse(readFileSync(join(ledger, String(published.deploymentId) + '.json'), 'utf8'));
    delete receipt.ownerBound;
    writeFileSync(join(ledger, String(published.deploymentId) + '.json'), JSON.stringify(receipt), { mode: 0o600 });
    // Synthetic historical conflict: the ledger itself contains two previously bound owners.
    const conflictId = 'dep-' + 'f'.repeat(64);
    writeFileSync(join(ledger, conflictId + '.json'), JSON.stringify({ ...receipt, id: conflictId, ownerId: 'member-b' }), { mode: 0o600 });
    const bArtifact = await otherMemberArtifact(f);
    const bSimulated = await f.publisher.execute('member-b', { action: 'simulate', runId: bArtifact.runId, artifact: bArtifact });
    await expect(f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: aSimulated.receipt })).rejects.toThrow('generated app operation refused');
    await expect(f.publisher.execute('member-b', { action: 'publish', runId: bArtifact.runId,
      artifact: bArtifact, receipt: bSimulated.receipt })).rejects.toThrow('generated app operation refused');
    expect(existsSync(join(f.appsRoot, 'generated-app'))).toBe(false);
  } finally { f.cleanup(); }
});

test('empty, foreign owner, forged run and CSRF fail closed before mounting', async () => {
  const f = await fixture();
  try {
    for (const artifact of [{}, { ...f.artifact, ownerId: 'member-b' }, { ...f.artifact, runId: 'forged-run' }]) {
      expect(await f.invoke({ action: 'simulate', artifact })).toMatchObject({ ok: false });
    }
    const response = await f.route(new Request('http://127.0.0.1/v1/apps/generated-app/generated-deployment', {
      method: 'POST', headers: { cookie: 'synthetic=not-a-session', origin: 'https://foreign.example.test' },
      body: '{}',
    }));
    expect(response?.status).toBe(403);
    expect((await f.route(new Request('http://127.0.0.1/v1/apps/generated-app/generated-deployment', { method: 'POST' })))?.status).toBe(401);
    await expect(f.publisher.execute('member-a', { action: 'simulate', runId: 'run-publish',
      artifact: { ...f.artifact, runId: 'run-publish' } })).rejects.toThrow();
    expect(f.appHost.slugs).toEqual([]);
  } finally { f.cleanup(); }
});

test('a changed export after simulation invalidates the receipt; symlinks cannot use it', async () => {
  const f = await fixture();
  try {
    const simulated = await f.invoke({ action: 'simulate', artifact: f.artifact });
    expect(simulated).toMatchObject({ ok: true, outcome: 'done' });
    const receipt = (simulated.evidence as { receipt: string }).receipt;
    const index = join(f.artifact.staticExportDir, 'index.html');
    const original = readFileSync(index, 'utf8');
    writeFileSync(index, original + '\n<p>changed after simulation</p>');
    expect(await f.invoke({ action: 'publish', artifact: f.artifact, receipt, requirePassingReceipt: true })).toMatchObject({ ok: false });
    writeFileSync(index, original);
    symlinkSync(join(f.root, 'outside'), join(f.artifact.staticExportDir, 'escape'));
    expect(await f.invoke({ action: 'simulate', artifact: f.artifact })).toMatchObject({ ok: false });
    expect(existsSync(join(f.appsRoot, 'generated-app'))).toBe(false);
  } finally { f.cleanup(); }
});

test('an existing app directory is never overwritten', async () => {
  const f = await fixture();
  try {
    const simulated = await f.invoke({ action: 'simulate', artifact: f.artifact });
    expect(simulated).toMatchObject({ ok: true, outcome: 'done' });
    const receipt = (simulated.evidence as { receipt: string }).receipt;
    mkdirSync(join(f.appsRoot, 'generated-app'));
    writeFileSync(join(f.appsRoot, 'generated-app', 'unrelated'), 'other deployment');
    expect(await f.invoke({ action: 'publish', artifact: f.artifact, receipt, requirePassingReceipt: true })).toMatchObject({ ok: false });
    expect(readFileSync(join(f.appsRoot, 'generated-app', 'unrelated'), 'utf8')).toBe('other deployment');
  } finally { f.cleanup(); }
});

test('an app without public-read is not silently widened to anonymous publication', async () => {
  const f = await fixture();
  try {
    const privateManifest = { ...f.artifact.manifest };
    delete privateManifest.roles;
    writeFileSync(join(f.artifact.staticExportDir, '..', 'app.yaml'), stringify(privateManifest));
    expect(await f.invoke({ action: 'simulate', artifact: { ...f.artifact, manifest: privateManifest } }))
      .toMatchObject({ ok: false });
    expect(f.appHost.slugs).toEqual([]);
  } finally { f.cleanup(); }
});

test('published listener restores its exact URL and own undo after publisher restart', async () => {
  const f = await fixture();
  let restored: ReturnType<typeof createGeneratedAppPublisher> | undefined;
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    const published = await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    f.publisher.close();
    restored = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth'), appHost: f.appHost,
      listen: async (host, slug, previous) => listenOnAppHost(host, slug, '127.0.0.1', true, previous) });
    expect(await restored.restore()).toEqual({ restored: 1, unavailable: 0 });
    expect(await (await fetch(String(published.resultUrl))).text()).toContain('Generated application');
    await restored.execute('member-a', { action: 'undo', runId: f.context.runId, deploymentId: published.deploymentId });
    expect(f.appHost.slugs).not.toContain('generated-app');
  } finally { restored?.close(); f.cleanup(); }
});

test('an external listener URL is refused and its mount is rolled back', async () => {
  const f = await fixture();
  let stopped = false;
  const publisher = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth'), appHost: f.appHost,
    listen: async () => ({ url: 'http://external.example.test:8080/', stop: () => { stopped = true; } }) });
  try {
    const simulated = await publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    await expect(publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt })).rejects.toThrow();
    expect(stopped).toBe(true);
    expect(publisher.isPrivateSlug('generated-app')).toBe(false);
    expect(f.appHost.slugs).toEqual([]);
    expect(existsSync(join(f.appsRoot, 'generated-app'))).toBe(false);
    expect(existsSync(f.artifact.staticExportDir)).toBe(true);
  } finally { publisher.close(); f.cleanup(); }
});

test('host build record refuses caller-relabelled source even under a matching run directory', async () => {
  const f = await fixture();
  try {
    const originalRun = dirname(dirname(f.artifact.staticExportDir));
    const forgedRun = join(dirname(originalRun), 'forged-run-ABC123');
    renameSync(originalRun, forgedRun);
    await expect(f.publisher.execute('member-a', { action: 'simulate', runId: 'forged-run',
      artifact: { ...f.artifact, runId: 'forged-run', staticExportDir: join(forgedRun, 'generated-app', 'out') } })).rejects.toThrow();
    expect(f.appHost.slugs).toEqual([]);
  } finally { f.cleanup(); }
});

for (const crashPoint of ['before-copy', 'partial-copy', 'after-rename', 'after-mount']) {
  test('restart recovers only its pending deployment at ' + crashPoint, async () => {
    const f = await fixture();
    let recovered: ReturnType<typeof createGeneratedAppPublisher> | undefined;
    try {
      const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
      const published = await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
        artifact: f.artifact, receipt: simulated.receipt });
      f.publisher.close();
      const ledger = join(f.root, 'generated-app-deployments');
      const receiptPath = join(ledger, String(published.deploymentId) + '.json');
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      receipt.state = 'pending';
      const target = join(f.appsRoot, 'generated-app');
      if (crashPoint === 'before-copy' || crashPoint === 'partial-copy') {
        f.appHost.unmountDirectory('generated-app');
        renameSync(target, receipt.stagingPath);
        if (crashPoint === 'before-copy') {
          for (const entry of readdirSync(receipt.stagingPath)) rmSync(join(receipt.stagingPath, entry), { recursive: true });
        } else rmSync(join(receipt.stagingPath, 'out', 'index.html'));
      } else if (crashPoint === 'after-rename') f.appHost.unmountDirectory('generated-app');
      writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
      mkdirSync(join(f.appsRoot, 'unrelated'));
      writeFileSync(join(f.appsRoot, 'unrelated', 'keep'), 'foreign bytes');
      recovered = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth'), appHost: f.appHost,
        listen: async (host, slug, previous) => listenOnAppHost(host, slug, '127.0.0.1', true, previous) });
      expect(await recovered.restore()).toEqual({ restored: 0, unavailable: 0 });
      expect(existsSync(target)).toBe(false);
      expect(existsSync(receipt.stagingPath)).toBe(false);
      expect(readFileSync(join(f.appsRoot, 'unrelated', 'keep'), 'utf8')).toBe('foreign bytes');
      expect(f.appHost.slugs).not.toContain('generated-app');
      expect(await recovered.execute('member-a', { action: 'undo', runId: f.context.runId,
        deploymentId: published.deploymentId })).toMatchObject({ status: 'undone' });
      const repeated = await recovered.execute('member-a', { action: 'publish', runId: f.context.runId,
        artifact: f.artifact, receipt: simulated.receipt });
      expect(repeated.status).toBe('published');
    } finally { recovered?.close(); f.cleanup(); }
  });
}

test('undone receipts do not reserve a future same-slug app on restart', async () => {
  const f = await fixture();
  let restarted: ReturnType<typeof createGeneratedAppPublisher> | undefined;
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    const published = await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    await f.publisher.execute('member-a', { action: 'undo', runId: f.context.runId, deploymentId: published.deploymentId });
    expect(f.publisher.isPrivateSlug('generated-app')).toBe(false);
    f.publisher.close();
    cpSync(dirname(f.artifact.staticExportDir), join(f.appsRoot, 'generated-app'), { recursive: true });
    f.appHost.mountDirectory('generated-app');
    restarted = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth'), appHost: f.appHost });
    expect(await restarted.restore()).toEqual({ restored: 0, unavailable: 0 });
    expect(restarted.isPrivateSlug('generated-app')).toBe(false);
    const shared = withGeneratedAppsPrivateIngress(f.appHost, restarted.isPrivateSlug);
    expect((await shared.handle(new Request('http://generated-app.app.localhost/', {
      headers: { host: 'generated-app.app.localhost' } })))?.status).toBe(200);
  } finally { restarted?.close(); f.cleanup(); }
});

for (const resume of ['undo-retry', 'restart']) {
  for (const crashPoint of ['after-deleting-record', 'after-unmount', 'after-remove']) {
    test('undo deletion resumes through ' + resume + ' at ' + crashPoint, async () => {
      const f = await fixture();
      let restarted: ReturnType<typeof createGeneratedAppPublisher> | undefined;
      try {
        const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
        const published = await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
          artifact: f.artifact, receipt: simulated.receipt });
        const target = join(f.appsRoot, 'generated-app');
        const receiptPath = join(f.root, 'generated-app-deployments', String(published.deploymentId) + '.json');
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        // Persist the exact states left by interruption; this is a recovery fixture, not a live crash claim.
        receipt.state = 'deleting';
        writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
        f.publisher.close();
        if (crashPoint !== 'after-deleting-record') f.appHost.unmountDirectory('generated-app');
        if (crashPoint === 'after-remove') rmSync(target, { recursive: true });
        mkdirSync(join(f.appsRoot, 'unrelated'));
        writeFileSync(join(f.appsRoot, 'unrelated', 'keep'), 'foreign bytes');
        const undo = { action: 'undo' as const, runId: f.context.runId, deploymentId: published.deploymentId };
        await expect(f.publisher.execute('member-b', undo)).rejects.toThrow();
        let publisher = f.publisher;
        if (resume === 'restart') {
          restarted = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth'), appHost: f.appHost,
            listen: async (host, slug, previous) => listenOnAppHost(host, slug, '127.0.0.1', true, previous) });
          publisher = restarted;
          expect(await publisher.restore()).toEqual({ restored: 0, unavailable: 0 });
        } else expect(await publisher.execute('member-a', undo)).toMatchObject({ status: 'undone' });
        expect(JSON.parse(readFileSync(receiptPath, 'utf8')).state).toBe('undone');
        expect(existsSync(target)).toBe(false);
        expect(f.appHost.slugs).not.toContain('generated-app');
        expect(publisher.isPrivateSlug('generated-app')).toBe(false);
        expect(readFileSync(join(f.appsRoot, 'unrelated', 'keep'), 'utf8')).toBe('foreign bytes');
        expect(existsSync(f.artifact.staticExportDir)).toBe(true);
        const next = await publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
          artifact: f.artifact, receipt: simulated.receipt });
        expect(next.deploymentId).not.toBe(published.deploymentId);
        expect(await publisher.execute('member-a', undo)).toMatchObject({ status: 'undone' });
        expect((await fetch(String(next.resultUrl))).status).toBe(200);
      } finally { restarted?.close(); f.cleanup(); }
    });
  }
}

for (const damage of ['invalid-json', 'wrong-id'] as const) test(damage + ' deployment receipt cannot expose a generated app on startup', async () => {
  const f = await fixture();
  let startup: ReturnType<typeof loadNexusAppHost>['appHost'] | undefined;
  let restarted: ReturnType<typeof createGeneratedAppPublisher> | undefined;
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    const published = await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    f.publisher.close(); f.appHost.close();
    const receiptPath = join(f.root, 'generated-app-deployments', String(published.deploymentId) + '.json');
    const original = readFileSync(receiptPath, 'utf8');
    writeFileSync(receiptPath, damage === 'invalid-json' ? '{invalid json'
      : JSON.stringify({ ...JSON.parse(original), id: 'dep-' + 'f'.repeat(64) }), { mode: 0o600 });
    startup = loadNexusAppHost(f.appsRoot, undefined, {
      key: randomBytes(32).toString('hex'), dir: join(f.root, 'auth'), databaseDirectory: join(f.root, 'db'),
    }).appHost;
    expect(startup.slugs).toContain('generated-app');
    restarted = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, appHost: startup,
      databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth') });
    expect(await restarted.restore()).toEqual({ restored: 0, unavailable: 1 });
    const ingress = withGeneratedAppsPrivateIngress(startup, restarted.isPrivateSlug);
    const response = await ingress.handle(new Request('http://generated-app.app.localhost/', {
      headers: { host: 'generated-app.app.localhost' },
    }));
    expect(response?.status).toBe(404);
    const bArtifact = await otherMemberArtifact(f);
    const bSimulated = await restarted.execute('member-b', { action: 'simulate', runId: bArtifact.runId, artifact: bArtifact });
    await expect(restarted.execute('member-b', { action: 'publish', runId: bArtifact.runId,
      artifact: bArtifact, receipt: bSimulated.receipt })).rejects.toThrow('generated app operation refused');
  } finally { restarted?.close(); startup?.close(); f.cleanup(); }
});

test('a mounted generated source with missing deployment receipt must not reach shared ingress', async () => {
  const f = await fixture();
  let startup: ReturnType<typeof loadNexusAppHost>['appHost'] | undefined;
  let restarted: ReturnType<typeof createGeneratedAppPublisher> | undefined;
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    const published = await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    f.publisher.close(); f.appHost.close();
    rmSync(join(f.root, 'generated-app-deployments', String(published.deploymentId) + '.json'));
    startup = loadNexusAppHost(f.appsRoot, undefined, {
      key: randomBytes(32).toString('hex'), dir: join(f.root, 'auth'), databaseDirectory: join(f.root, 'db'),
    }).appHost;
    expect(startup.slugs).toContain('generated-app');
    restarted = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, appHost: startup,
      databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth') });
    const shared = withGeneratedAppsPrivateIngress(startup, restarted.isPrivateSlug);
    expect((await shared.handle(new Request('http://generated-app.app.localhost/', {
      headers: { host: 'generated-app.app.localhost' },
    })))?.status).toBe(404);
  } finally { restarted?.close(); startup?.close(); f.cleanup(); }
});

test('a simulation alone does not hide an unrelated static app using the same slug', async () => {
  const f = await fixture();
  let restarted: ReturnType<typeof createGeneratedAppPublisher> | undefined;
  try {
    await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    const ordinary = join(f.appsRoot, 'generated-app');
    mkdirSync(join(ordinary, 'out'), { recursive: true });
    writeFileSync(join(ordinary, 'app.yaml'), 'apiVersion: elanous.app/v0\nslug: generated-app\ntitle: Ordinary app\nfrontend:\n  kind: static-export\n  out: out\nroles:\n  public:\n    via: public-read\n');
    writeFileSync(join(ordinary, 'out', 'index.html'), '<main>unrelated static app</main>');
    f.appHost.mountDirectory('generated-app');
    restarted = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, appHost: f.appHost,
      databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth') });
    expect(restarted.isPrivateSlug('generated-app')).toBe(false);
    const shared = withGeneratedAppsPrivateIngress(f.appHost, restarted.isPrivateSlug);
    expect((await shared.handle(new Request('http://generated-app.app.localhost/', {
      headers: { host: 'generated-app.app.localhost' },
    })))?.status).toBe(200);
  } finally { restarted?.close(); f.cleanup(); }
});

test('published generated source with both receipts missing must stay off shared ingress', async () => {
  const f = await fixture();
  let startup: ReturnType<typeof loadNexusAppHost>['appHost'] | undefined;
  let restarted: ReturnType<typeof createGeneratedAppPublisher> | undefined;
  try {
    const simulated = await f.publisher.execute('member-a', { action: 'simulate', runId: f.context.runId, artifact: f.artifact });
    const published = await f.publisher.execute('member-a', { action: 'publish', runId: f.context.runId,
      artifact: f.artifact, receipt: simulated.receipt });
    f.publisher.close(); f.appHost.close();
    rmSync(join(f.root, 'generated-app-deployments', String(published.deploymentId) + '.json'));
    rmSync(join(f.root, 'generated-app-deployments', String(simulated.receipt) + '.json'));
    startup = loadNexusAppHost(f.appsRoot, undefined, {
      key: randomBytes(32).toString('hex'), dir: join(f.root, 'auth'), databaseDirectory: join(f.root, 'db'),
    }).appHost;
    expect(startup.slugs).toContain('generated-app');
    restarted = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, appHost: startup,
      databaseDirectory: join(f.root, 'db'), sessionDirectory: join(f.root, 'auth') });
    const shared = withGeneratedAppsPrivateIngress(startup, restarted.isPrivateSlug);
    expect((await shared.handle(new Request('http://generated-app.app.localhost/', {
      headers: { host: 'generated-app.app.localhost' },
    })))?.status).toBe(404);
  } finally { restarted?.close(); startup?.close(); f.cleanup(); }
});
