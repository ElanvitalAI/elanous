import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { podChildResultScenario, renderPodChildResult } from './fault-pod-child-result.js';
import { simGlmNoCredential } from './fault-glm-no-credential.js';
import { simPoolCap } from './fault-pool-cap.js';
import { podCodex503Scenario, simPodCodex503 } from './fault-pod-codex-503.js';
import { createFakeKubectl } from './fake-kubectl.js';
import { measurePoolLease, recommendConcurrency } from '../task-orchestrator/surfaces/pod-lease.js';
import { parsePodPool } from '../task-orchestrator/surfaces/pod-pool.js';
import { loadMockScenarioCatalog, parseMockScenarioCatalog, renderMockScenarioDetails, renderMockScenarioDeviceMarkdownTable, renderMockScenarioDevices, renderMockScenarioList } from './mock-scenario-catalog.js';

const REPO = resolve(import.meta.dir, '../..');
const catalog = loadMockScenarioCatalog();

test('catalog schema, scenario/device links, evidence contract, and all ux-sim runtime modules are indexed', () => {
  expect(parseMockScenarioCatalog(catalog)).toEqual(catalog);
  expect(catalog.scenarios.map((scenario) => scenario.id)).toEqual([
    'UX-MS-01', 'UX-MS-02', 'RELEASE-GRAPH-PREPUB-FANOUT', 'UX-MS-03', 'UX-MS-04', 'UX-MS-05', 'UX-MS-06',
    'UX-MS-07', 'UX-MS-08', 'UX-MS-09', 'UX-MS-11', 'UX-MS-12', 'NIGHT-TRAIN-DEAD-PID-LOCK',
    'AUTHOR-PRECHECK-APPLIED', 'AUTHOR-PRECHECK-REJECTED-UNPROVABLE', 'SAFE-PUBLIC-COPY-PUBLISH-REDACTION', 'SW-FREEZE',
  ]);
  expect(catalog.runEvidence.scope).toContain('ScenarioV0 YAML runs only');
  expect(catalog.worldEvents.map((event) => event.id)).toEqual(['EV-0042', 'EV-0107']);

  const implementation = new Set(catalog.devices.flatMap((device) => device.implementation));
  for (const path of implementation) expect(existsSync(join(REPO, path))).toBe(true);
  for (const path of catalog.devices.flatMap((device) => device.tests)) expect(existsSync(join(REPO, path))).toBe(true);
  for (const scenario of catalog.scenarios) {
    for (const path of [...scenario.implementation, ...scenario.tests]) expect(existsSync(join(REPO, path))).toBe(true);
  }

  expect(catalog.candidateAudit.sourceRows).toBe(36);
  expect(catalog.candidateAudit.existingPaths).toBe(35);
  expect(catalog.candidateAudit.excludedPaths).toBe(catalog.candidateAudit.candidates.filter((candidate) => candidate.disposition === 'excluded').length);
  expect(catalog.candidateAudit.candidates).toHaveLength(37);
  expect(catalog.candidateAudit.catalogAdditions).toContainEqual(expect.objectContaining({ path: 'src/ux-sim/safe-public-copy-publish.ts' }));
  expect(catalog.candidateAudit.catalogAdditions).toContainEqual(expect.objectContaining({ path: 'src/ux-sim/seminar-rehearsal.test.ts' }));
  expect(catalog.candidateAudit.candidates.filter((candidate) => existsSync(join(REPO, candidate.path)))).toHaveLength(37);
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
      expect(scenario.device).toBe(candidate.deviceId!);
      expect([...scenario.implementation, ...scenario.tests]).toContain(candidate.path);
    }
  }

  expect(catalog.candidateAudit.omissionCheck.missingPaths).toEqual([]);
  for (const path of catalog.candidateAudit.omissionCheck.requiredPaths) {
    expect(catalog.candidateAudit.candidates.some((candidate) => candidate.path === path) || catalog.candidateAudit.sourceExclusions.some((row) => row.path === path)).toBe(true);
    expect(existsSync(join(REPO, path))).toBe(true);
  }
  expect(catalog.devices.every((device) => device.entryCommands.length > 0 && ['yes', 'no', 'conditional', 'runner-dependent'].includes(device.logsRecorded))).toBe(true);
  expect(catalog.devices.find((device) => device.id === 'research-decision-chain')?.eventNames).toEqual([
    'research.lens/second-order-applied', 'research.lens/second-order-skipped',
  ]);
  expect(catalog.devices.find((device) => device.id === 'research-decision-chain')?.implementation).toContain('src/ux-sim/research-decision-chain.ts');
  expect(catalog.candidateAudit.candidates.some((candidate) => candidate.path.includes('research-decision-chain'))).toBe(false);

  const unindexed = readdirSync(import.meta.dir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => `src/ux-sim/${file}`)
    .filter((path) => !implementation.has(path));
  expect(unindexed).toEqual([]);
});

test('SW-FREEZE catalogs the persisted three-pass rehearsal device and focused entry command', () => {
  const scenario = catalog.scenarios.find((entry) => entry.id === 'SW-FREEZE');
  expect(scenario).toMatchObject({ device: 'first-run-and-seminar', implementation: ['src/ux-sim/seminar-rehearsal.ts'], tests: ['src/ux-sim/seminar-rehearsal.test.ts'] });
  expect(scenario?.observe).toContain('a matching owner approval records the next build and starts its pass count');
  const device = catalog.devices.find((entry) => entry.id === 'first-run-and-seminar');
  expect(device?.entryCommands).toContain('bun test src/ux-sim/mock-authoring-first-run.test.ts src/ux-sim/seminar-rehearsal.test.ts src/ux-sim/classic-tui-seat-scenarios.test.ts src/ux-sim/next-tui-seat-scenarios.test.ts');
  expect(catalog.candidateAudit.candidates).toContainEqual(expect.objectContaining({ path: 'src/ux-sim/seminar-rehearsal.test.ts', scenarioIds: ['SW-FREEZE'] }));
});

test('world event registry rejects duplicate IDs and missing descriptions', () => {
  const duplicate = structuredClone(catalog);
  duplicate.worldEvents[1]!.id = duplicate.worldEvents[0]!.id;
  expect(() => parseMockScenarioCatalog(duplicate)).toThrow('worldEvents contains duplicate id');

  const emptyDescription = structuredClone(catalog);
  emptyDescription.worldEvents[0]!.description = '';
  expect(() => parseMockScenarioCatalog(emptyDescription)).toThrow('worldEvents[0].description');
});

test('version 2 catalogs without the optional world event registry remain readable', () => {
  const legacy = structuredClone(catalog) as unknown as Record<string, unknown>;
  delete legacy.worldEvents;
  expect(parseMockScenarioCatalog(legacy).worldEvents).toEqual([]);
});

test('read-only device registry prints entry, logs, event, recent-use, and omission metadata', () => {
  const output = renderMockScenarioDevices(catalog).join('\n');
  expect(output).toContain('Mock device registry · read-only');
  expect(output).toContain('fake-github\tFake GitHub CLI and API');
  expect(output).toContain('entry=bun test src/ux-sim/fake-gh.test.ts');
  expect(output).toContain('events=(none recorded)');
  expect(output).toContain('recent=(not recorded)');
  expect(output).toContain('omission check: required=3 missing=0');
});

test('generated manual catalog block matches the canonical JSON in memory', () => {
  const manual = readFileSync(join(REPO, 'docs/manual/MANUAL-ux-simulation-devices-2026-08-23.md'), 'utf8');
  const begin = '<!-- BEGIN GENERATED MOCK DEVICE CATALOG -->';
  const end = '<!-- END GENERATED MOCK DEVICE CATALOG -->';
  const startAt = manual.indexOf(begin);
  const endAt = manual.indexOf(end);
  expect(startAt).toBeGreaterThanOrEqual(0);
  expect(endAt).toBeGreaterThan(startAt);
  const actual = manual.slice(startAt, endAt + end.length);
  const expected = [
    begin,
    '> 이 표는 `src/ux-sim/mock-scenario-catalog.json`에서 생성한다. 갱신: `bun scripts/generate-ux-sim-device-manual.ts`.',
    '',
    ...renderMockScenarioDeviceMarkdownTable(catalog),
    end,
  ].join('\n');
  expect(actual).toBe(expected);
});

test('recent-use receipt is parsed and rendered when an observed run exists', () => {
  const withRecentUse = structuredClone(catalog);
  const receipt = {
    observedAt: '2026-11-01T03:00:00.000Z',
    runId: 'run-4f7b6cc7-1012-45cc-a1b6-0d7d0e6f550e',
    event: 'ux.sim.scenario/completed',
    scenarioId: 'UX-MS-01',
    command: 'bun bin/elanous.mjs --test sim run scenarios/ux-sim/provider-4xx-no-provider.yaml',
  };
  withRecentUse.devices[0]!.recentUse = receipt;

  const parsed = parseMockScenarioCatalog(withRecentUse);
  expect(parsed.devices[0]?.recentUse).toEqual(receipt);
  expect(renderMockScenarioDevices(parsed).join('\n')).toContain(
    `recent=${receipt.observedAt} runId=${receipt.runId} event=${receipt.event} scenario=${receipt.scenarioId} cmd=${receipt.command}`,
  );
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
  expect(() => parseMockScenarioCatalog(inconsistentExistingPaths)).toThrow('existingPaths must equal the baseline candidate count after catalog additions');

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
  expect(renderMockScenarioList(catalog).join('\n')).toContain('후보 감사 37/38');
  expect(renderMockScenarioDetails(catalog, 'UX-MS-11').join('\n')).toContain('request-shape 400');
  expect(() => renderMockScenarioDetails(catalog, 'UX-MS-99')).toThrow('unknown mock scenario id');
});

test('ux-sim list/show/devices CLI exposes the catalog without launching a simulation', () => {
  const list = spawnSync('bun', ['scripts/ux-sim.ts', 'list'], { cwd: REPO, encoding: 'utf8' });
  expect(list.status).toBe(0);
  expect(list.stdout).toContain('UX-MS-01');
  expect(list.stdout).toContain('UX-MS-07');
  expect(list.stdout).toContain('UX-MS-11');
  expect(list.stdout).toContain('UX-MS-12');
  expect(list.stdout).toContain('후보 감사 37/38');

  const show = spawnSync('bun', ['scripts/ux-sim.ts', 'show', 'UX-MS-11'], { cwd: REPO, encoding: 'utf8' });
  expect(show.status).toBe(0);
  expect(show.stdout).toContain('Codex request-shape 400 recovery boundary');

  const devices = spawnSync('bun', ['scripts/ux-sim.ts', 'devices'], { cwd: REPO, encoding: 'utf8' });
  expect(devices.status).toBe(0);
  expect(devices.stdout).toContain('Mock device registry · read-only');
  expect(devices.stdout).toContain('recent=(not recorded)');
  expect(devices.stdout).toContain('omission check: required=3 missing=0');

  const unknown = spawnSync('bun', ['scripts/ux-sim.ts', 'show', 'UX-MS-99'], { cwd: REPO, encoding: 'utf8' });
  expect(unknown.status).toBe(2);
  expect(unknown.stderr).toContain('unknown mock scenario id');
}, 15000);

test('eln sim devices --json exposes the full catalog through the CLI entry point', () => {
  const result = spawnSync('bun', ['bin/elanous.mjs', '--test', 'sim', 'devices', '--json'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(result.status, result.stderr).toBe(0);
  const payload = JSON.parse(result.stdout) as typeof catalog;
  expect(payload).toEqual(catalog);
  expect(payload.devices.map((device) => device.id)).toEqual(catalog.devices.map((device) => device.id));
  expect(payload.scenarios).toEqual(catalog.scenarios);
  expect(payload.runEvidence).toEqual(catalog.runEvidence);
}, 35000);
