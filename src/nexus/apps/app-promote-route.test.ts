import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppLifecycleEvent } from './app-lifecycle-ledger.js';
import { createAppLifecycleStore } from './app-db.js';
import { createAppPromoteRoute } from './app-promote.js';
import { createAppSimulationRoute } from './app-simulation-route.js';
import { createAppSimulationStore } from './app-simulation-db.js';
import { fingerprintAppSourceDirectory, withAppSourceLock } from './app-source-snapshot.js';
import { createFakeAppHost } from '../../ux-sim/fake-app-host.js';

test('owner Nexus promote route gates the live lifecycle write on the matching simulation receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-promote-route-'));
  const sourceRoot = join(root, 'apps', 'demo-app');
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, 'app.yaml'), 'slug: demo-app\n');
  const simulations = createAppSimulationStore(join(root, 'simulation.sqlite'));
  const lifecycle = createAppLifecycleStore(join(root, 'lifecycle.sqlite'));
  const fingerprint = fingerprintAppSourceDirectory(sourceRoot);
  const host = createFakeAppHost([{ slug: 'demo-app', current: 'v1', versions: [{ id: 'v1', files: { 'index.html': '<main>fake app host passed</main>' } }] }]);
  lifecycle.ensureCreated(createAppLifecycleEvent({ appId: 'demo-app', action: 'created', environment: 'simulation', actor: 'system' }));
  const simulationRoute = createAppSimulationRoute({ store: simulations, authorize: request => request.headers.get('authorization') === 'Bearer member-owner',
    hasApp: appId => appId === 'demo-app', fingerprintApp: () => fingerprint,
    withSourceLock: (appId, run) => withAppSourceLock(appId, sourceRoot, run), publish: () => undefined,
    runSimulation: () => {
      const response = host.fetch('demo-app.app.sim.invalid', '/');
      const receiptId = 'route-sim-receipt';
      return { runId: 'route-sim-run', events: [{ kind: 'app.sim.step', appId: 'demo-app', runId: 'route-sim-run', ts: 1,
        data: { step: 'host-check', message: response.body.includes('fake app host passed') ? 'fake host passed' : 'fake host failed', receiptId, path: '/', status: response.status } }],
      receipts: [{ id: receiptId, appId: 'demo-app', runId: 'route-sim-run', outcome: response.status === 200 ? 'passed' : 'failed', summary: 'fake host result' }] };
    }, observeError: error => { throw error; } });
  const ownerHeaders = { authorization: 'Bearer member-owner' };
  const simulationResponse = await simulationRoute(new Request('http://nexus.invalid/v1/apps/demo-app/simulations/run', { method: 'POST', headers: ownerHeaders }));
  expect(simulationResponse?.status).toBe(200);
  const stored = simulations.snapshot('demo-app');
  const receiptId = stored.receipts[0]!.id;
  const route = createAppPromoteRoute({ simulations, lifecycle, hasApp: appId => appId === 'demo-app',
    authorizeOwner: request => request.headers.get('authorization') === 'Bearer member-owner',
    currentFingerprint: () => fingerprint,
    withSourceLock: (appId, run) => withAppSourceLock(appId, sourceRoot, run),
    config: () => ({ appPromoteReceiptTtlMs: 60_000 }) });
  const url = 'http://nexus.invalid/v1/apps/demo-app/promote';
  const body = { appId: 'demo-app', fingerprint, receiptId };
  try {
    expect((await route(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })))?.status).toBe(401);
    const response = await route(new Request(url, { method: 'POST', headers: { authorization: 'Bearer member-owner', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const payload = await response?.json();
    expect(response?.status, JSON.stringify(payload)).toBe(200);
    expect(payload).toMatchObject({ ok: true, promotion: { appId: 'demo-app', fingerprint, receiptId: 'route-sim-receipt' } });
    expect(lifecycle.snapshot('demo-app')?.status).toBe('live');
  } finally {
    simulations.close();
    lifecycle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
