import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { createAppSimulationStore } from './app-simulation-db.js';
import { createAppSimulationRoute } from './app-simulation-route.js';
import type { AppSimulationRun } from './app-simulation-runner.js';
import { loadNexusAppHost } from './app-host.js';
import { fingerprintAppSourceDirectory } from './app-source-snapshot.js';

const roots: string[] = [];
let runDeclaredAppSimulation: typeof import('./app-simulation-runner.js').runDeclaredAppSimulation;
beforeAll(async () => {
  ({ runDeclaredAppSimulation } = await import('./app-simulation-runner.js'));
}, 120_000);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('only an explicit authorized run writes app.sim events and a receipt to the sim store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-simulation-route-'));
  roots.push(root);
  const store = createAppSimulationStore(join(root, 'app-simulation.sqlite'));
  const published: Array<{ kind: string; detail: Record<string, unknown> }> = [];
  const runSimulation = () => ({ runId: 'demo-run-1', events: [{ kind: 'app.sim.step' as const, appId: 'voice-notes', runId: 'demo-run-1', ts: 100,
    data: { step: 'transcription', message: '받아쓰기 확인', receiptId: 'demo-receipt' } }],
  receipts: [{ id: 'demo-receipt', appId: 'voice-notes', runId: 'demo-run-1', outcome: 'passed' as const, summary: '완료' }] });
  const route = createAppSimulationRoute({ store, authorize: request => request.headers.get('authorization') === 'Bearer owner',
    hasApp: slug => slug === 'voice-notes', fingerprintApp: () => 'a'.repeat(64), publish: event => published.push(event), runSimulation });
  try {
    const path = 'http://nexus.invalid/v1/apps/voice-notes/simulations/run';
    expect((await route(new Request(path, { method: 'POST' })))?.status).toBe(401);
    expect(store.snapshot('voice-notes').status).toBe('not-created');
    const response = await route(new Request(path, { method: 'POST', headers: { authorization: 'Bearer owner' } }));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ ok: true, simulation: { status: 'passed',
      events: [{ kind: 'app.sim.step', appId: 'voice-notes' }], receipts: [{ id: 'demo-receipt', outcome: 'passed', appFingerprint: 'a'.repeat(64) }] } });
    expect(published).toHaveLength(1);
  } finally { store.close(); }
});

test('declared app.yaml scenarios produce a persisted proof tied to the served source fingerprint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-simulation-proof-route-'));
  roots.push(root);
  writeFileSync(join(root, 'app.yaml'), `apiVersion: elanous.app/v0
slug: voice-notes
title: Voice notes
frontend: { kind: static-export }
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
roles: { owner: { via: nexus-session } }
rpc:
  addNote:
    sql: INSERT INTO notes (id, title) VALUES (:id, :title)
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
actions:
  makeAd: { builtin: generate, async: true, spend: owner-confirm, uses: [cred:higgsfield.secret] }
simulate:
  connectors:
    makeAd: { fake: generate-job, profile: slow-then-ok }
  scenarios:
    - name: happy-path
      steps: [{ action: makeAd, as: owner }]
      expect: [{ screen-text: Ready }]
    - name: provider-failure-recovery
      steps: [{ action: makeAd, as: owner }]
      expect: [{ screen-text: Ready }]
`);
  const store = createAppSimulationStore(join(root, 'app-simulation.sqlite'));
  const fingerprint = 'a'.repeat(64);
  const resultForScenario = (scenario: string, index: number) => {
    const runId = `declared-run-${index}`;
    const receiptId = `declared-receipt-${index}`;
    return { name: scenario, passed: true, failedExpectations: [], networkSandboxEstablished: true,
      evidence: { events: ['simulation-step'], tableRows: {}, screenText: 'Ready' },
      externalNetworkAttempts: 0, blockedNetworkAttempts: 0, unmeasuredCount: 0, externalNetworkEvents: [], result: {
      runId,
      events: [{ kind: 'app.sim.step' as const, appId: 'voice-notes', runId, ts: index,
        data: { step: 'simulation-step', message: 'completed', receiptId } }],
      receipts: [{ id: receiptId, appId: 'voice-notes', runId, outcome: 'passed' as const, summary: 'completed' }],
    } };
  };
  const declaredRun: AppSimulationRun = { appSlug: 'voice-notes', passed: true,
    networkEvidence: { sandboxEstablished: true, externalNetworkAttempts: 0, blockedNetworkAttempts: 0, unmeasuredCount: 0 },
    scenarios: [resultForScenario('happy-path', 1), resultForScenario('provider-failure-recovery', 2)] };
  const route = createAppSimulationRoute({ store,
    authorize: () => true, hasApp: slug => slug === 'voice-notes', publish: () => undefined,
    appSourceRoot: () => root, fingerprintApp: () => fingerprint,
    runDeclaredSimulation: async () => declaredRun,
  });
  try {
    const response = await route(new Request('http://nexus.invalid/v1/apps/voice-notes/simulations/run', { method: 'POST' }));
    expect(response?.status).toBe(200);
    expect(store.snapshot('voice-notes').receipts[0]?.conceptProof).toMatchObject({
      verdict: 'passed', appFingerprint: fingerprint,
      sandboxEstablished: true, externalNetworkAttempts: 0, blockedNetworkAttempts: 0, unmeasuredCount: 0,
      requiredScenarios: [{ id: 'happy-path', outcome: 'passed' }, { id: 'provider-failure-recovery', outcome: 'passed' }],
    });
  } finally { store.close(); }
});

test('declared runner evidence persists through proof storage and reaches hosted app HTML', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-simulation-proof-e2e-'));
  roots.push(root);
  const appsRoot = join(root, 'apps');
  const appRoot = join(appsRoot, 'voice-notes');
  const outRoot = join(appRoot, 'out');
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(join(outRoot, 'index.html'), '<html><body><main>simulated notes</main></body></html>');
  writeFileSync(join(appRoot, 'app.yaml'), `apiVersion: elanous.app/v0
slug: voice-notes
title: Voice notes
frontend: { kind: static-export, out: out }
roles:
  owner: { via: nexus-session }
  public: { via: public-read }
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
rpc:
  addNote:
    sql: INSERT INTO notes (id, title) VALUES (:id, :title)
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
simulate:
  scenarios:
    - name: add-note
      steps: [{ rpc: addNote, as: owner, params: { id: n1, title: Hello } }]
      expect: [{ table: notes, rows: 1 }, { event: rpc.addNote.completed }]
`);
  const store = createAppSimulationStore(join(root, 'app-simulation.sqlite'));
  const hosted = loadNexusAppHost(appsRoot);
  expect(hosted.issues).toEqual([]);
  hosted.appHost.setConceptProofResolver((slug) => {
    const proof = store.snapshot(slug).receipts.find(receipt => receipt.conceptProof)?.conceptProof;
    return proof?.appFingerprint === fingerprintAppSourceDirectory(appRoot) ? proof : undefined;
  });
  let routeError: unknown;
  const route = createAppSimulationRoute({ store, authorize: () => true,
    hasApp: slug => slug === 'voice-notes', publish: () => undefined,
    appSourceRoot: slug => slug === 'voice-notes' ? appRoot : '',
    fingerprintApp: () => fingerprintAppSourceDirectory(appRoot),
    observeError: error => { routeError = error; },
    runDeclaredSimulation: async (slug) => {
      return runDeclaredAppSimulation({ manifest: hosted.appHost.getManifest(slug)! }, async (args) => {
        if (args[2] === 'create-yaml') {
          const world = parseYaml(readFileSync(args[3]!, 'utf8')) as { world: string };
          return { status: 0, stdout: JSON.stringify({ id: world.world }) };
        }
        if (args[2] === 'run') {
          const scenario = parseYaml(readFileSync(args[4]!, 'utf8')) as {
            appSimulation: { manifest: { slug: string }; scenario: { name: string } };
          };
          const runId = 'integrated-app-run';
          const receiptId = 'integrated-app-receipt';
          return { status: 0, stdout: JSON.stringify({ pass: true, devices: ['fake-clock'],
            appSimulation: { runId, events: [{ kind: 'app.sim.step', appId: scenario.appSimulation.manifest.slug,
              runId, ts: 1, data: { step: 'rpc.addNote.completed', message: scenario.appSimulation.scenario.name, receiptId } }],
            receipts: [{ id: receiptId, appId: scenario.appSimulation.manifest.slug, runId, outcome: 'passed', summary: 'scenario passed' }] },
            appSimulationEvidence: { events: ['rpc.addNote.completed'], tableRows: { notes: 1 }, screenText: '' },
            externalNetworkEvents: [] }) };
        }
        return { status: 0, stdout: '' };
      });
    },
  });
  try {
    const response = await route(new Request('http://nexus.invalid/v1/apps/voice-notes/simulations/run', { method: 'POST' }));
    if (response?.status !== 200) throw routeError;
    expect(response?.status).toBe(200);
    expect(store.snapshot('voice-notes').receipts[0]?.conceptProof).toMatchObject({
      verdict: 'passed', sandboxEstablished: true, externalNetworkAttempts: 0,
      blockedNetworkAttempts: 0, unmeasuredCount: 0,
      requiredScenarios: [{ id: 'add-note', outcome: 'passed' }],
    });
    expect(store.snapshot('voice-notes').events[0]?.data.step).toBe('rpc.addNote.completed');
    const served = await hosted.appHost.handle(new Request('http://voice-notes.app.localhost/', {
      headers: { host: 'voice-notes.app.localhost' },
    }));
    const html = await served!.text();
    expect(html).toContain('data-elanous-made-with-badge="true"');
    const proof = store.snapshot('voice-notes').receipts[0]?.conceptProof;
    expect(html).toContain(`data-sim-receipt-fingerprint="${proof?.receiptFingerprint}"`);
  } finally { store.close(); hosted.appHost.close(); }
});

test('source mutation during simulation rejects without storing a promotable receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-simulation-source-change-'));
  roots.push(root);
  const store = createAppSimulationStore(join(root, 'app-simulation.sqlite'));
  let fingerprintReads = 0;
  const route = createAppSimulationRoute({ store, authorize: () => true, hasApp: () => true,
    fingerprintApp: () => ++fingerprintReads === 1 ? 'a'.repeat(64) : 'b'.repeat(64), publish: () => undefined,
    runSimulation: () => ({ runId: 'changed-source-run', events: [{ kind: 'app.sim.step', appId: 'voice-notes', runId: 'changed-source-run', ts: 100,
      data: { step: 'source-check', message: 'simulation completed', receiptId: 'changed-source-receipt' } }],
    receipts: [{ id: 'changed-source-receipt', appId: 'voice-notes', runId: 'changed-source-run', outcome: 'passed' as const, summary: 'passed' }] }) });
  try {
    const response = await route(new Request('http://nexus.invalid/v1/apps/voice-notes/simulations/run', { method: 'POST' }));
    expect(response?.status).toBe(502);
    expect(store.snapshot('voice-notes').status).toBe('not-created');
  } finally { store.close(); }
});
