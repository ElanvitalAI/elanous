import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { tmpdir } from 'node:os';
import { loadNexusAppHost } from './app-host.js';
import { createGeneratedAppPublisher, createGeneratedAppPublishRoute, listenOnAppHost, withGeneratedAppsPrivateIngress, type GeneratedArtifact } from './generated-app-publish.js';
import { emptyGraphCapabilityRegistry, dispatchGraphContract } from '../../graph-runner/capabilities.js';
import { registerAbsorbAppSourceProvider } from '../../graph-runner/capability-providers/absorb-app-source.js';
import { registerAppPublishProvider, createAppPublishTransport } from '../../graph-runner/capability-providers/app-publish.js';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'generated-app-publish-'));
  const appsRoot = join(root, 'apps'); mkdirSync(appsRoot);
  const { appHost } = loadNexusAppHost(appsRoot, undefined, {
    key: randomBytes(32).toString('hex'), dir: join(root, 'auth'), databaseDirectory: join(root, 'db'),
  });
  const publisher = createGeneratedAppPublisher({ artifactRoot: root, appsRoot, appHost,
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
  const manifestYaml = 'apiVersion: elanous.app/v0\nslug: generated-app\ntitle: Generated app\nfrontend:\n  kind: static-export\n  out: out\nroles:\n  public:\n    via: public-read\n';
  const html = '<!doctype html><html><body><h1>Generated application</h1></body></html>';
  const built = await source.invoke({ ...context, nodeInput: { memberId: 'member-a', appId: 'generated-app',
    suggestion: { owner: 'member-a', appId: 'generated-app' }, draft: { manifestYaml, html } } });
  const artifact = (built.result as { artifact: GeneratedArtifact }).artifact;
  const invoke = (input: Record<string, unknown>, contract = 'app-publish.action@1' as 'app.publish@1' | 'app-publish.action@1') =>
    dispatchGraphContract(contract, { ...context, nodeId: String(input.action), nodeInput: { requireOwner: 'member-a', ...input } }, registry);
  return { root, appsRoot, appHost, publisher, route, artifact, invoke, context,
    cleanup: () => { publisher.close(); appHost.close(); rmSync(root, { recursive: true, force: true }); } };
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
    restored = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, appHost: f.appHost,
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
  const publisher = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, appHost: f.appHost,
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
      recovered = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, appHost: f.appHost,
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
    restarted = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, appHost: f.appHost });
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
          restarted = createGeneratedAppPublisher({ artifactRoot: f.root, appsRoot: f.appsRoot, appHost: f.appHost,
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
