import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { podChildResultScenario, renderPodChildResult } from './fault-pod-child-result.js';
import { simGlmNoCredential } from './fault-glm-no-credential.js';
import { simPoolCap } from './fault-pool-cap.js';
import { podCodex503Scenario, simPodCodex503 } from './fault-pod-codex-503.js';
import { createFakeKubectl } from './fake-kubectl.js';
import { measurePoolLease, recommendConcurrency } from '../task-orchestrator/surfaces/pod-lease.js';
import { parsePodPool } from '../task-orchestrator/surfaces/pod-pool.js';
import { loadMockScenarioCatalog, parseMockScenarioCatalog, renderMockScenarioDetails, renderMockScenarioList } from './mock-scenario-catalog.js';

const REPO = resolve(import.meta.dir, '../..');
const catalog = loadMockScenarioCatalog();

test('catalog schema, scenario/device links, evidence contract, and all ux-sim runtime modules are indexed', () => {
  expect(parseMockScenarioCatalog(catalog)).toEqual(catalog);
  expect(catalog.scenarios.map((scenario) => scenario.id)).toEqual(['UX-MS-01', 'UX-MS-02', 'UX-MS-03', 'UX-MS-04', 'UX-MS-05', 'UX-MS-06', 'UX-MS-07']);
  expect(catalog.runEvidence.scope).toContain('ScenarioV0 YAML runs only');

  const implementation = new Set(catalog.devices.flatMap((device) => device.implementation));
  for (const path of implementation) expect(existsSync(join(REPO, path))).toBe(true);
  for (const path of catalog.devices.flatMap((device) => device.tests)) expect(existsSync(join(REPO, path))).toBe(true);
  for (const scenario of catalog.scenarios) {
    for (const path of [...scenario.implementation, ...scenario.tests]) expect(existsSync(join(REPO, path))).toBe(true);
  }

  const unindexed = readdirSync(import.meta.dir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => `src/ux-sim/${file}`)
    .filter((path) => !implementation.has(path));
  expect(unindexed).toEqual([]);
});

test('MS-01, MS-04, and MS-07 ask registered devices for independent and distinguishable failure verdicts', async () => {
  const child = renderPodChildResult(podChildResultScenario()).join('\n');
  expect(child).toContain('failure=report-deficit');

  const credential = simGlmNoCredential({ zaiKey: false, openrouterKey: false });
  expect(credential.result).toBe('refused');
  expect(credential.error).toBeTruthy();
  const temporaryProviderFailure = await simPodCodex503(podCodex503Scenario({ fault: 'overload-503' }));
  const credentialRejected = await simPodCodex503(podCodex503Scenario({ fault: 'auth-401' }));
  expect(temporaryProviderFailure.result).toBe('zai-fallback');
  expect(credentialRejected.result).toBe('no-fallback');

  const pool = simPoolCap({ spec: 'pool-node-b@node-b', running: { 'pool-node-b': 2 } });
  expect(pool.recommendation).toMatchObject({ recommended: 0, limitedBy: 'pool-cap' });
  const failedPoolQuery = simPoolCap({ spec: 'pool-node-b@node-b', running: {}, queryFailures: { 'pool-node-b': 'kubectl query failed' } });
  expect(failedPoolQuery.members[0]?.running).toBeUndefined();
  expect(failedPoolQuery.members[0]?.queryError).toBe('kubectl query failed');
  expect(failedPoolQuery.recommendation).toBeNull();
  const queryFailureDevice = createFakeKubectl({ context: 'pool-node-b', node: 'node-1', failGetPods: 'connection refused' });
  const measuredFailure = measurePoolLease(parsePodPool('pool-node-b@node-b'), { kubectl: queryFailureDevice.kubectl, skipDnsProbe: true });
  const consumerDecision = recommendConcurrency(measuredFailure, { capacity: 2, accounts: -1, perAccount: -1 });
  expect(queryFailureDevice.calls.some((args) => args.includes('get') && args.includes('pods'))).toBe(true);
  expect(measuredFailure.members[0]).toMatchObject({ running: null, reason: expect.stringContaining('connection refused') });
  expect(consumerDecision).toMatchObject({ recommended: null, limitedBy: null, reason: expect.stringContaining('connection refused') });
});

test('list and show render registered scenarios and unknown ids fail closed', () => {
  expect(renderMockScenarioList(catalog).join('\n')).toContain('UX-MS-01\treport-deficit');
  expect(renderMockScenarioDetails(catalog, 'UX-MS-04').join('\n')).toContain('ScenarioV0 실행 증거');
  expect(() => renderMockScenarioDetails(catalog, 'UX-MS-99')).toThrow('unknown mock scenario id');
});

test('ux-sim list/show CLI exposes the catalog without launching a simulation', () => {
  const list = spawnSync('bun', ['scripts/ux-sim.ts', 'list'], { cwd: REPO, encoding: 'utf8' });
  expect(list.status).toBe(0);
  expect(list.stdout).toContain('UX-MS-01');
  expect(list.stdout).toContain('UX-MS-07');

  const show = spawnSync('bun', ['scripts/ux-sim.ts', 'show', 'UX-MS-01'], { cwd: REPO, encoding: 'utf8' });
  expect(show.status).toBe(0);
  expect(show.stdout).toContain('report-deficit');

  const unknown = spawnSync('bun', ['scripts/ux-sim.ts', 'show', 'UX-MS-99'], { cwd: REPO, encoding: 'utf8' });
  expect(unknown.status).toBe(2);
  expect(unknown.stderr).toContain('unknown mock scenario id');
});
