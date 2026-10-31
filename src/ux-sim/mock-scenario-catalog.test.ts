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
  expect(catalog.scenarios.map((scenario) => scenario.id)).toEqual([
    'UX-MS-01', 'UX-MS-02', 'UX-MS-03', 'UX-MS-04', 'UX-MS-05', 'UX-MS-06',
    'UX-MS-07', 'UX-MS-08', 'UX-MS-09', 'UX-MS-11',
  ]);
  expect(catalog.runEvidence.scope).toContain('ScenarioV0 YAML runs only');

  const implementation = new Set(catalog.devices.flatMap((device) => device.implementation));
  for (const path of implementation) expect(existsSync(join(REPO, path))).toBe(true);
  for (const path of catalog.devices.flatMap((device) => device.tests)) expect(existsSync(join(REPO, path))).toBe(true);
  for (const scenario of catalog.scenarios) {
    for (const path of [...scenario.implementation, ...scenario.tests]) expect(existsSync(join(REPO, path))).toBe(true);
  }

  expect(catalog.candidateAudit.sourceRows).toBe(34);
  expect(catalog.candidateAudit.existingPaths).toBe(33);
  expect(catalog.candidateAudit.excludedPaths).toBe(catalog.candidateAudit.candidates.filter((candidate) => candidate.disposition === 'excluded').length);
  expect(catalog.candidateAudit.candidates).toHaveLength(33);
  expect(catalog.candidateAudit.candidates.filter((candidate) => existsSync(join(REPO, candidate.path)))).toHaveLength(33);
  expect(catalog.candidateAudit.sourceExclusions).toHaveLength(1);
  expect(catalog.candidateAudit.sourceExclusions[0]).toMatchObject({ path: 'scenarios/ux-sim/MK-MS-01.yaml' });
  expect(catalog.candidateAudit.sourceExclusions[0]?.reason).toContain('#34039');
  for (const candidate of catalog.candidateAudit.candidates) {
    expect(candidate.entryCommand.length).toBeGreaterThan(0);
    expect(candidate.logsDetail.length).toBeGreaterThan(0);
    if (candidate.disposition === 'excluded') expect(candidate.excludeReason?.length).toBeGreaterThan(0);
    if (candidate.deviceId) {
      const device = catalog.devices.find((entry) => entry.id === candidate.deviceId)!;
      expect([...device.implementation, ...device.tests]).toContain(candidate.path);
    }
    for (const scenarioId of candidate.scenarioIds ?? []) {
      const scenario = catalog.scenarios.find((entry) => entry.id === scenarioId)!;
      expect(scenario.device).toBe(candidate.deviceId);
      expect([...scenario.implementation, ...scenario.tests]).toContain(candidate.path);
    }
  }

  const unindexed = readdirSync(import.meta.dir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => `src/ux-sim/${file}`)
    .filter((path) => !implementation.has(path));
  expect(unindexed).toEqual([]);
});

test('candidate audit rejects duplicate paths, invalid dispositions, missing exclusions, and bad links', () => {
  const duplicate = structuredClone(catalog);
  duplicate.candidateAudit.candidates[1]!.path = duplicate.candidateAudit.candidates[0]!.path;
  expect(() => parseMockScenarioCatalog(duplicate)).toThrow('duplicate path');

  const invalidDisposition = structuredClone(catalog);
  invalidDisposition.candidateAudit.candidates[0]!.disposition = 'not-a-disposition' as never;
  expect(() => parseMockScenarioCatalog(invalidDisposition)).toThrow('disposition is unknown');

  const missingReason = structuredClone(catalog);
  const excluded = missingReason.candidateAudit.candidates.find((candidate) => candidate.disposition === 'excluded')!;
  delete excluded.excludeReason;
  expect(() => parseMockScenarioCatalog(missingReason)).toThrow('excluded entries require excludeReason');

  const excludedWithLinks = structuredClone(catalog);
  const contradictoryExcluded = excludedWithLinks.candidateAudit.candidates.find((candidate) => candidate.disposition === 'scenario')!;
  contradictoryExcluded.disposition = 'excluded';
  contradictoryExcluded.excludeReason = 'deliberately contradictory fixture';
  expect(() => parseMockScenarioCatalog(excludedWithLinks)).toThrow('excluded entries cannot have catalog links');

  const unlinkedDevice = structuredClone(catalog);
  const deviceCandidate = unlinkedDevice.candidateAudit.candidates.find((candidate) => candidate.disposition === 'device')!;
  delete deviceCandidate.deviceId;
  delete deviceCandidate.scenarioIds;
  expect(() => parseMockScenarioCatalog(unlinkedDevice)).toThrow('device entries require deviceId and scenarioIds');

  const unlinkedScenario = structuredClone(catalog);
  const scenarioLink = unlinkedScenario.candidateAudit.candidates.find((candidate) => candidate.disposition === 'scenario')!;
  delete scenarioLink.scenarioIds;
  expect(() => parseMockScenarioCatalog(unlinkedScenario)).toThrow('scenario entries require deviceId and scenarioIds');

  const unlinkedExisting = structuredClone(catalog);
  const existingCandidate = unlinkedExisting.candidateAudit.candidates.find((candidate) => candidate.disposition === 'already-indexed')!;
  delete existingCandidate.deviceId;
  delete existingCandidate.scenarioIds;
  expect(() => parseMockScenarioCatalog(unlinkedExisting)).toThrow('already-indexed entries require a catalog link');

  const unknownDevice = structuredClone(catalog);
  const linked = unknownDevice.candidateAudit.candidates.find((candidate) => candidate.deviceId)!;
  linked.deviceId = 'missing-device';
  expect(() => parseMockScenarioCatalog(unknownDevice)).toThrow('references unknown device');

  const wrongOwner = structuredClone(catalog);
  const scenarioCandidate = wrongOwner.candidateAudit.candidates.find((candidate) => candidate.scenarioIds?.length)!;
  scenarioCandidate.deviceId = 'scenario-runner';
  wrongOwner.devices.find((device) => device.id === 'scenario-runner')!.implementation.push(scenarioCandidate.path);
  expect(() => parseMockScenarioCatalog(wrongOwner)).toThrow('does not own scenario');

  const unknownScenario = structuredClone(catalog);
  const linkedScenario = unknownScenario.candidateAudit.candidates.find((candidate) => candidate.scenarioIds?.length)!;
  linkedScenario.scenarioIds = ['missing-scenario'];
  expect(() => parseMockScenarioCatalog(unknownScenario)).toThrow('references unknown scenario');

  const unrelatedPath = structuredClone(catalog);
  const pathCandidate = unrelatedPath.candidateAudit.candidates.find((candidate) => candidate.deviceId)!;
  pathCandidate.path = 'src/ux-sim/fake-kubectl.ts';
  expect(() => parseMockScenarioCatalog(unrelatedPath)).toThrow('path is not registered by device');

  const duplicateSourcePath = structuredClone(catalog);
  duplicateSourcePath.candidateAudit.sourceExclusions[0]!.path = duplicateSourcePath.candidateAudit.candidates[0]!.path;
  expect(() => parseMockScenarioCatalog(duplicateSourcePath)).toThrow('duplicate path');

  const missingSourceReason = structuredClone(catalog);
  delete (missingSourceReason.candidateAudit.sourceExclusions[0] as { reason?: string }).reason;
  expect(() => parseMockScenarioCatalog(missingSourceReason)).toThrow('sourceExclusions[0].reason');

  const inconsistentSourceRows = structuredClone(catalog);
  inconsistentSourceRows.candidateAudit.sourceRows -= 1;
  expect(() => parseMockScenarioCatalog(inconsistentSourceRows)).toThrow('counts do not match');

  const inconsistentExistingPaths = structuredClone(catalog);
  inconsistentExistingPaths.candidateAudit.existingPaths -= 1;
  expect(() => parseMockScenarioCatalog(inconsistentExistingPaths)).toThrow('existingPaths must equal the current candidate count');

  const inconsistentExcludedPaths = structuredClone(catalog);
  inconsistentExcludedPaths.candidateAudit.excludedPaths += 1;
  expect(() => parseMockScenarioCatalog(inconsistentExcludedPaths)).toThrow('counts do not match');
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
  expect(renderMockScenarioList(catalog).join('\n')).toContain('후보 감사 33/34');
  expect(renderMockScenarioDetails(catalog, 'UX-MS-11').join('\n')).toContain('request-shape 400');
  expect(() => renderMockScenarioDetails(catalog, 'UX-MS-99')).toThrow('unknown mock scenario id');
});

test('ux-sim list/show CLI exposes the catalog without launching a simulation', () => {
  const list = spawnSync('bun', ['scripts/ux-sim.ts', 'list'], { cwd: REPO, encoding: 'utf8' });
  expect(list.status).toBe(0);
  expect(list.stdout).toContain('UX-MS-01');
  expect(list.stdout).toContain('UX-MS-07');
  expect(list.stdout).toContain('UX-MS-11');
  expect(list.stdout).toContain('후보 감사 33/34');

  const show = spawnSync('bun', ['scripts/ux-sim.ts', 'show', 'UX-MS-11'], { cwd: REPO, encoding: 'utf8' });
  expect(show.status).toBe(0);
  expect(show.stdout).toContain('Codex request-shape 400 recovery boundary');

  const unknown = spawnSync('bun', ['scripts/ux-sim.ts', 'show', 'UX-MS-99'], { cwd: REPO, encoding: 'utf8' });
  expect(unknown.status).toBe(2);
  expect(unknown.stderr).toContain('unknown mock scenario id');
});
