import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { LogStore } from '../mss/logging/log-store.js';
import { assembleWorld, createWorld, destroyWorld } from './world.js';
import { withSimClock } from './fake-clock.js';
import { runLedgerDir, runLedgerPath } from '../self-implement/run-ledger.js';
import { encodeRlaRunIdForFixturePath, RLA_EVENT_RESPONSE_EVENTS, RLA_EVENT_RESPONSE_SAMPLE_COUNT, runRlaEventResponseScorecard, type RlaEventResponseRuntime } from './rla-event-response-scorecard.js';

const REPO = resolve(import.meta.dir, '../..');
const catalog = loadMockScenarioCatalog();

test('catalog schema, scenario/device links, evidence contract, and all ux-sim simulation worlds are indexed', () => {
  expect(parseMockScenarioCatalog(catalog)).toEqual(catalog);
  expect(catalog.scenarios.map((scenario) => scenario.id)).toEqual([
    'APP-CONTRACT-SECRET-ENTROPY', 'UX-MS-01', 'UX-MS-02', 'RELEASE-MACROPHAGE-HEAL', 'RELEASE-GRAPH-PREPUB-FANOUT', 'UX-MS-03', 'UX-MS-04', 'UX-MS-05', 'UX-MS-06',
    'UX-MS-07', 'UX-MS-08', 'UX-MS-09', 'UX-MS-11', 'UX-MS-12', 'NIGHT-TRAIN-DEAD-PID-LOCK', 'AUTHOR-PRECHECK-APPLIED',
    'AUTHOR-PRECHECK-REJECTED-UNPROVABLE', 'SAFE-PUBLIC-COPY-PUBLISH-REDACTION', 'SW-FREEZE', 'SIM-HQ-MOVE', 'SIM-CHAIN-LAND',
    'UX-MS-13', 'RLA-LAUNCH-COUNTDOWN-1107', 'APP-WEB-DRIVE-TENANT', 'APP-SOURCE-SNAPSHOT', 'GOOGLE-DRIVE-LIST-READONLY',
    'GIT-PUSH-TIMEOUT-PARTIAL-OUTCOME-REMOTE-VERIFY', 'TASK-TEMP-CLEANUP',
  ]);
  expect(catalog.runEvidence.scope).toContain('ScenarioV0 YAML runs only');
  expect(catalog.worldEvents.map((event) => event.id)).toEqual(['EV-0042', 'EV-0107', 'hq-move',
    ...RLA_EVENT_RESPONSE_EVENTS.map(({ id }) => id), 'gate-pools-pinned-sweep', 'gate-mshq-unavailable',
    'gate-both-unavailable', 'gate-digest-mismatch', 'gate-no-pinned-image']);

  const implementation = new Set(catalog.devices.flatMap((device) => device.implementation));
  for (const path of implementation) expect(existsSync(join(REPO, path))).toBe(true);
  for (const path of catalog.devices.flatMap((device) => device.tests)) expect(existsSync(join(REPO, path))).toBe(true);
  for (const scenario of catalog.scenarios) {
    for (const path of [...scenario.implementation, ...scenario.tests]) expect(existsSync(join(REPO, path))).toBe(true);
  }

  expect(catalog.candidateAudit.sourceRows).toBe(36);
  expect(catalog.candidateAudit.existingPaths).toBe(35);
  expect(catalog.candidateAudit.excludedPaths).toBe(catalog.candidateAudit.candidates.filter((candidate) => candidate.disposition === 'excluded').length);
  expect(catalog.candidateAudit.candidates).toHaveLength(58);
  expect(catalog.candidateAudit.catalogAdditions).toContainEqual(expect.objectContaining({ path: 'src/ux-sim/safe-public-copy-publish.ts' }));
  expect(catalog.candidateAudit.catalogAdditions).toContainEqual(expect.objectContaining({ path: 'src/ux-sim/seminar-rehearsal.test.ts' }));
  expect(catalog.candidateAudit.catalogAdditions).toContainEqual(expect.objectContaining({ path: 'scripts/release-loop/gate-bisect.ts' }));
  expect(catalog.candidateAudit.catalogAdditions).toContainEqual(expect.objectContaining({ path: 'scripts/release-loop/gate-bisect.test.ts' }));
  expect(catalog.candidateAudit.catalogAdditions).toContainEqual(expect.objectContaining({ path: 'scripts/release-loop/gate-bisect-sidecar.ts' }));
  expect(catalog.candidateAudit.catalogAdditions).toContainEqual(expect.objectContaining({ path: 'src/release-loop/macrophage-heal.ts' }));
  expect(catalog.candidateAudit.catalogAdditions).toContainEqual(expect.objectContaining({ path: 'src/ux-sim/fake-google-drive-world.ts' }));
  expect(catalog.candidateAudit.catalogAdditions).toContainEqual(expect.objectContaining({ path: 'src/ux-sim/fake-google-drive-world.test.ts' }));
  expect(catalog.candidateAudit.catalogAdditions).toContainEqual(expect.objectContaining({ path: 'src/ux-sim/git-push-timeout-partial-outcome-remote-verify.ts' }));
  expect(catalog.candidateAudit.catalogAdditions).toContainEqual(expect.objectContaining({ path: 'src/ux-sim/fake-temp-cleanup.ts' }));
  expect(catalog.candidateAudit.catalogAdditions).toContainEqual(expect.objectContaining({ path: 'src/ux-sim/fake-temp-cleanup.test.ts' }));
  expect(catalog.candidateAudit.candidates.filter((candidate) => existsSync(join(REPO, candidate.path)))).toHaveLength(58);
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
  const sourceModules = new Map(catalog.sourceModules.map((module) => [module.path, module]));
  const worldFiles = listSourceModuleFiles(join(REPO, 'src/ux-sim')).filter((path) => path.endsWith('-world.ts'));
  expect([...sourceModules.keys()].filter((path) => path.endsWith('-world.ts')).sort()).toEqual(worldFiles.sort());
  for (const module of catalog.sourceModules) {
    expect(module.id).toMatch(/^MD-UX-SIM-/);
    expect(module.boundary.length).toBeGreaterThan(0);
    expect(module.boundary).not.toContain('module-local implementation');
    expect(module.boundary).not.toContain('; exports ');
    expect(module.boundary).not.toContain('...');
    expect(module.deviceIds.length).toBeGreaterThan(0);
    expect(module.deviceIds.map((id) => catalog.devices.find((device) => device.id === id)?.target)).not.toContain(module.boundary);
    expect(module.integrityCertificatePresent).toBe(false);
    expect(module.integrityCertificatePath).toBeNull();
  }
  const boundaryFor = (path: string) => sourceModules.get(path)?.boundary;
  expect(boundaryFor('src/ux-sim/fault-cred-expiry.ts')).toContain('Grok subscription expiry');
  expect(boundaryFor('src/ux-sim/fault-sqlite-busy.ts')).toContain('SQLite write lock');
  expect(boundaryFor('src/ux-sim/fault-pool-cap.ts')).toContain('omitted :N default capacity');
  expect(boundaryFor('src/ux-sim/fake-browser-page.ts')).toContain('CDP page navigation');
  expect(boundaryFor('src/ux-sim/fake-cloud-vm.ts')).toContain('never calls a cloud provider');
  expect(boundaryFor('src/ux-sim/fake-fleet.ts')).toContain('per-context Kubernetes fixtures');
  expect(boundaryFor('src/ux-sim/fault-glm-no-credential.ts')).toContain('credential absent');
  expect(boundaryFor('src/ux-sim/in-process-cli.ts')).toContain('registered Commander action');
  expect(boundaryFor('src/ux-sim/world.ts')).toContain('assembles their fakes');
  expect(boundaryFor('src/ux-sim/mock-authoring-first-run.ts')).toContain('first-run child probe');
  expect(boundaryFor('src/ux-sim/skills-tools-shell-device.ts')).toContain('before spawn');
  expect(boundaryFor('src/ux-sim/research-decision-chain.ts')).toContain('production Think Lens decision chain');
  expect(boundaryFor('src/ux-sim/scenario.ts')).toContain('executes its registered trigger');
  expect(boundaryFor('src/ux-sim/slash-menu-frames.ts')).toContain('counting full-screen clears');
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

test('APP-CONTRACT-SECRET-ENTROPY catalogs the production-parser corpus device', () => {
  const device = catalog.devices.find((entry) => entry.id === 'app-contract-secret-entropy');
  expect(device).toMatchObject({
    checklistCells: ['APP-CONTRACT-SECRET-ENTROPY'],
    implementation: ['src/ux-sim/app-contract-secret-entropy.ts'],
    tests: ['src/ux-sim/app-contract-secret-entropy.test.ts'],
  });
  expect(device?.entryCommands).toContain('bun test src/ux-sim/app-contract-secret-entropy.test.ts');
});

test('APP-WEB-DRIVE-TENANT catalogs the tenant-isolated readonly Drive world', () => {
  const device = catalog.devices.find((entry) => entry.id === 'fake-app-drive-world');
  expect(device).toMatchObject({
    checklistCells: ['APP-WEB-DRIVE-TENANT'],
    implementation: ['src/ux-sim/fake-app-drive-world.ts', 'src/nexus/apps/drive-contract.ts'],
    tests: ['src/ux-sim/fake-app-drive-world.test.ts'],
  });
  expect(device?.entryCommands).toContain('bun test src/ux-sim/fake-app-drive-world.test.ts');
  expect(catalog.scenarios.find((entry) => entry.id === 'APP-WEB-DRIVE-TENANT'))
    .toMatchObject({ device: 'fake-app-drive-world', kind: 'tenant-drive-read-isolation' });
});

test('APP-SOURCE-SNAPSHOT catalogs the preexisting fake snapshot world', () => {
  const device = catalog.devices.find((entry) => entry.id === 'fake-app-source-world');
  expect(device).toMatchObject({
    checklistCells: ['APP-SOURCE-SNAPSHOT'],
    implementation: ['src/ux-sim/fake-app-source-concurrent-writer.ts', 'src/ux-sim/fake-app-source-world.ts', 'src/nexus/apps/app-source-snapshot.ts'],
    tests: ['src/ux-sim/fake-app-source-world.test.ts'],
  });
  expect(catalog.scenarios.find((entry) => entry.id === 'APP-SOURCE-SNAPSHOT'))
    .toMatchObject({ device: 'fake-app-source-world', kind: 'source-snapshot-integrity' });
});

test('GOOGLE-DRIVE-LIST-READONLY catalogs the synthetic metadata-only Google Drive world', () => {
  const device = catalog.devices.find((entry) => entry.id === 'fake-google-drive-world');
  expect(device).toMatchObject({
    checklistCells: ['APP-OAUTH-ONE'],
    implementation: ['src/ux-sim/fake-google-drive-world.ts'],
    tests: ['src/ux-sim/fake-google-drive-world.test.ts'],
  });
  expect(catalog.scenarios.find((entry) => entry.id === 'GOOGLE-DRIVE-LIST-READONLY'))
    .toMatchObject({ device: 'fake-google-drive-world', kind: 'oauth-readonly-simulation' });
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

test('file-level source module inventory is required for catalog consumers', () => {
  const missingInventory = structuredClone(catalog) as unknown as Record<string, unknown>;
  delete missingInventory.sourceModules;
  expect(() => parseMockScenarioCatalog(missingInventory)).toThrow('sourceModules must be an array');
});

test('catalog devices may declare checklist coverage for request resolution', () => {
  const covered = structuredClone(catalog);
  covered.devices[0]!.checklistCells = ['SIM-DEVICE-REQUEST-NEXUS'];
  expect(parseMockScenarioCatalog(covered).devices[0]?.checklistCells).toEqual(['SIM-DEVICE-REQUEST-NEXUS']);
  covered.devices[0]!.checklistCells = ['SIM-DEVICE-REQUEST-NEXUS', 'SIM-DEVICE-REQUEST-NEXUS'];
  expect(() => parseMockScenarioCatalog(covered)).toThrow('checklistCells must not contain duplicates');
});

test('file-level MD registry rejects duplicate paths, stale names, and unsupported certificate claims', () => {
  const duplicatePath = structuredClone(catalog);
  duplicatePath.sourceModules[1]!.path = duplicatePath.sourceModules[0]!.path;
  expect(() => parseMockScenarioCatalog(duplicatePath)).toThrow('sourceModules contains duplicate path');

  const staleName = structuredClone(catalog);
  staleName.sourceModules[0]!.id = 'MD-UX-SIM-STALE-NAME';
  expect(() => parseMockScenarioCatalog(staleName)).toThrow('stable MD- path name');

  const escapedPath = structuredClone(catalog);
  escapedPath.sourceModules[0]!.path = 'src/ux-sim/..';
  expect(() => parseMockScenarioCatalog(escapedPath)).toThrow('must stay inside src/ux-sim');

  const windowsEscapedPath = structuredClone(catalog);
  windowsEscapedPath.sourceModules[0]!.path = 'src/ux-sim/..\\..\\outside.ts';
  expect(() => parseMockScenarioCatalog(windowsEscapedPath)).toThrow('must stay inside src/ux-sim');

  const unsupportedCertificate = structuredClone(catalog);
  unsupportedCertificate.sourceModules[0]!.integrityCertificatePresent = true;
  expect(() => parseMockScenarioCatalog(unsupportedCertificate)).toThrow('must agree with integrityCertificatePresent');
});

test('read-only device registry prints entry, logs, event, recent-use, and omission metadata', () => {
  const output = renderMockScenarioDevices(catalog).join('\n');
  expect(output).toContain('Mock device registry · read-only');
  expect(output).toContain('fake-github\tFake GitHub CLI and API');
  expect(output).toContain('entry=bun test src/ux-sim/fake-gh.test.ts');
  expect(output).toContain('events=(none recorded)');
  expect(output).toContain('recent=(not recorded)');
  expect(output).toContain('omission check: required=4 missing=0');
  expect(output).toContain('MD-UX-SIM-FAKE-CLOCK-TS\tsrc/ux-sim/fake-clock.ts');
  expect(output).toContain('devices=fake-clock');
  expect(output).toContain('certificate=no');
  expect(renderMockScenarioDeviceMarkdownTable(catalog).join('\n')).toContain('| Owning device IDs |');
  expect(renderMockScenarioDeviceMarkdownTable(catalog).join('\n')).toContain('| fake-clock |');
});

function listSourceModuleFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listSourceModuleFiles(path);
    if (entry.name.endsWith('.test.ts')) return [];
    return entry.name.endsWith('.ts') || entry.name.endsWith('.json')
      ? [`src/ux-sim/${path.slice(join(REPO, 'src/ux-sim').length + 1)}`]
      : [];
  });
}

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
  const scenarioCandidate = wrongOwner.candidateAudit.candidates.find((candidate) => candidate.scenarioIds?.length && candidate.deviceId !== 'scenario-runner')!;
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
  expect(renderMockScenarioList(catalog).join('\n')).toContain('후보 감사 58/59');
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
  expect(list.stdout).toContain('후보 감사 58/59');

  const show = spawnSync('bun', ['scripts/ux-sim.ts', 'show', 'UX-MS-11'], { cwd: REPO, encoding: 'utf8' });
  expect(show.status).toBe(0);
  expect(show.stdout).toContain('Codex request-shape 400 recovery boundary');

  const devices = spawnSync('bun', ['scripts/ux-sim.ts', 'devices'], { cwd: REPO, encoding: 'utf8' });
  expect(devices.status).toBe(0);
  expect(devices.stdout).toContain('Mock device registry · read-only');
  expect(devices.stdout).toContain('recent=(not recorded)');
  expect(devices.stdout).toContain('omission check: required=4 missing=0');

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

test('RLA-EVENT-RESPONSE-SCORECARD records ten event traces in the isolated Nexus ledger and fails unsafe responses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-response-scorecard-'));
  const previousRoot = getTestStateRoot();
  setTestStateRoot(root);
  const worldFile = join(root, 'world.yaml');
  writeFileSync(worldFile, JSON.stringify({
    world: 'rla-event-response-scorecard', seed: 0, devices: ['world-runtime'],
    clock: { start: '2026-11-06T00:00:00.000Z', speed: 1 },
    events: RLA_EVENT_RESPONSE_EVENTS.map(({ id }) => ({ at: '+0ms', id })),
  }));
  let world: Awaited<ReturnType<typeof createWorld>> | undefined;
  try {
    world = await createWorld(worldFile);
    const assembled = assembleWorld(world);
    const runtime = assembled.devices.get('world-runtime') as { inject: RlaEventResponseRuntime['inject'] };
    expect(encodeRlaRunIdForFixturePath('run.1').join('/')).not.toBe(encodeRlaRunIdForFixturePath('run_1').join('/'));
    expect(encodeRlaRunIdForFixturePath('\ud800').join('/')).not.toBe(encodeRlaRunIdForFixturePath('\ud801').join('/'));
    expect(encodeRlaRunIdForFixturePath('x'.repeat(128)).every((segment) => segment.length <= 240)).toBe(true);
    const collidingRunIds = ['run.1', 'run_1'] as const;
    const runId = 'run-1';
    const fixtureRunId = collidingRunIds[0];
    const injectWithCanonicalLedgerId: RlaEventResponseRuntime['inject'] = (options) => runtime.inject({
      ...options, runId: options.runId === fixtureRunId ? runId : options.runId,
    });
    const result = await withSimClock(Date.parse('2026-11-06T00:00:00.000Z'), (clock) => runRlaEventResponseScorecard(world!, {
      clock, inject: injectWithCanonicalLedgerId, runId: fixtureRunId,
      responder: async ({ eventId, incident }, observe) => {
        expect(incident.readState()).toMatchObject({ eventId, status: 'injected', facts: RLA_EVENT_RESPONSE_EVENTS.find((event) => event.id === eventId)!.facts });
        clock.tick(1_000);
        observe.detected(true);
        clock.tick(eventId === 'RLA-ER-01' ? 599_000 : 1_000);
        observe.judged(RLA_EVENT_RESPONSE_EVENTS.find((event) => event.id === eventId)!.target);
        incident.writeRecoveryState({ ...RLA_EVENT_RESPONSE_EVENTS.find((event) => event.id === eventId)!.expectedRecovery });
        clock.tick(eventId === 'RLA-ER-02' ? 300_000 : 1_000);
        observe.recovered('automatic');
      },
    }));

    expect(result.pass).toBe(true);
    expect(result.evidenceBasis).toBe('isolated-world-state');
    expect(result.scores).toHaveLength(10);
    expect(result.scores.every((score) => score.samples === RLA_EVENT_RESPONSE_SAMPLE_COUNT && score.successRate === 1)).toBe(true);
    expect(result.scores.find((score) => score.eventId === 'RLA-ER-01')).toMatchObject({ baseline: 'immediate detection; attribution 9m; repair/land ≈90m; 4 human resumes', averageDetectionMs: 1_000, averageJudgmentMs: 599_000, averageAttributionMs: 600_000 });
    expect(result.scores.find((score) => score.eventId === 'RLA-ER-02')?.averageRecoveryMs).toBe(300_000);

    const ledgerPath = runLedgerPath(runId, runLedgerDir(world.root));
    const ledgerRows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { event: string; timestamp: string; data: Record<string, unknown> });
    const stages = ledgerRows.filter((row) => row.event === 'rla-event-response-stage');
    expect(stages).toHaveLength(10 * RLA_EVENT_RESPONSE_SAMPLE_COUNT * 4);
    expect(stages.slice(0, 4).map((row) => row.data.stage)).toEqual(['injected', 'detected', 'judged', 'recovered']);
    expect(stages.every((row) => row.data.injected === true && row.data.level === 'L0')).toBe(true);
    const phaseTimes = stages.slice(0, 4).map((row) => Date.parse(row.timestamp));
    expect(phaseTimes.every((time, index) => index === 0 || time > phaseTimes[index - 1]!)).toBe(true);
    expect(phaseTimes[2]! - phaseTimes[0]!).toBe(600_000);
    expect(result.scores[0]!.averageAttributionMs).toBe(600_000);
    expect(phaseTimes[3]! - phaseTimes[2]!).toBe(1_000);
    expect(result.scores[0]!.averageRecoveryMs).toBe(1_000);
    expect(stages[3]?.data).toMatchObject({ postconditionsMet: true, failedConditions: [], recoveryEvidence: { attributed: true, repairNodeCreated: true, autoResumed: true } });
    const incidentFixturePath = String(stages[0]?.data.incidentFixture);
    expect(existsSync(incidentFixturePath)).toBe(true);
    expect(JSON.parse(readFileSync(incidentFixturePath, 'utf8'))).toMatchObject({ status: 'recovered', facts: { introducedRegressions: 1 } });

    const failedRunId = collidingRunIds[1];
    const failed = await withSimClock(Date.parse('2026-11-06T00:00:00.000Z'), (clock) => runRlaEventResponseScorecard(world!, {
      clock, inject: runtime.inject, runId: failedRunId,
      responder: async ({ eventId, sample, incident }, observe) => {
        if (eventId === 'RLA-ER-07' && sample === 1) return;
        clock.tick(1_000);
        observe.detected(true);
        if (eventId === 'RLA-ER-06' && sample === 1) return;
        clock.tick(eventId === 'RLA-ER-01' && sample === 3 ? 599_001 : 1_000);
        observe.judged(eventId === 'RLA-ER-04' ? 'incorrect response' : RLA_EVENT_RESPONSE_EVENTS.find((event) => event.id === eventId)!.target);
        incident.writeRecoveryState({ ...RLA_EVENT_RESPONSE_EVENTS.find((event) => event.id === eventId)!.expectedRecovery });
        clock.tick(1_000);
        observe.recovered(eventId === 'RLA-ER-03' ? 'manual' : eventId === 'RLA-ER-05' ? 'none' : 'automatic');
        if (eventId === 'RLA-ER-08' && sample === 1) throw new Error('post-recovery fixture error');
      },
    }));
    expect(failed.pass).toBe(false);
    expect(failed.scores.find((score) => score.eventId === 'RLA-ER-01')?.pass).toBe(false);
    expect(failed.scores.find((score) => score.eventId === 'RLA-ER-03')).toMatchObject({ recovery: 'manual', pass: false });
    expect(failed.scores.find((score) => score.eventId === 'RLA-ER-04')).toMatchObject({ successRate: 0, pass: false });
    expect(failed.scores.find((score) => score.eventId === 'RLA-ER-05')).toMatchObject({ successRate: 0, pass: false });
    expect(failed.scores).toHaveLength(10);
    expect(failed.scores.find((score) => score.eventId === 'RLA-ER-06')).toMatchObject({
      samples: 3, measuredDetectionSamples: 3, measuredJudgmentSamples: 2, measuredRecoverySamples: 2,
      averageJudgmentMs: 1_000, successCount: 2, successRate: 2 / 3, pass: false,
    });
    expect(failed.scores.find((score) => score.eventId === 'RLA-ER-07')).toMatchObject({ detection: 'unmeasured', measuredDetectionSamples: 2, successCount: 2, successRate: 2 / 3, pass: false });
    expect(failed.scores.find((score) => score.eventId === 'RLA-ER-08')).toMatchObject({ successCount: 2, successRate: 2 / 3, pass: false });
    const failedRows = readFileSync(runLedgerPath(failedRunId, runLedgerDir(world.root)), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { event: string; data: Record<string, unknown> });
    const failedAction = failedRows.find((row) => row.event === 'rla-event-response-stage' && row.data.eventId === 'RLA-ER-04' && row.data.stage === 'recovered');
    expect(failedAction?.data).toMatchObject({ postconditionsMet: true, failedConditions: [], failureReasons: ['response-action-mismatch'] });
    const failedRecovery = failedRows.find((row) => row.event === 'rla-event-response-stage' && row.data.eventId === 'RLA-ER-05' && row.data.stage === 'recovered');
    expect(failedRecovery?.data).toMatchObject({ postconditionsMet: true, failedConditions: [], recoveryLevel: 'none', failureReasons: ['recovery-not-achieved'] });
    expect(failedRows.find((row) => row.event === 'rla-event-response-sample-verdict' && row.data.eventId === 'RLA-ER-04' && row.data.sample === 1)?.data)
      .toMatchObject({ success: false, failureReasons: ['recovery-postconditions-failed'] });
    const incomplete = failedRows.find((row) => row.event === 'rla-event-response-stage' && row.data.eventId === 'RLA-ER-06' && row.data.stage === 'incomplete');
    expect(incomplete).toBeDefined();
    expect(JSON.parse(readFileSync(String(incomplete?.data.incidentFixture), 'utf8'))).toMatchObject({ status: 'incomplete' });
    const sampleVerdicts = failedRows.filter((row) => row.event === 'rla-event-response-sample-verdict');
    expect(sampleVerdicts).toHaveLength(30);
    expect(sampleVerdicts.find((row) => row.data.eventId === 'RLA-ER-08' && row.data.sample === 1)?.data).toMatchObject({ success: false, responseError: 'post-recovery fixture error', failureReasons: ['responder-error'] });
    const secondRunFixturePath = String(failedRows.find((row) => row.data.eventId === 'RLA-ER-01' && row.data.stage === 'injected')?.data.incidentFixture);
    expect(secondRunFixturePath).not.toBe(incidentFixturePath);
    expect(JSON.parse(readFileSync(incidentFixturePath, 'utf8'))).toMatchObject({ status: 'recovered' });

    const store = new LogStore(join(world.root, 'logs', 'logs.db'), { readonly: true });
    try {
      const logs = store.query({ categories: ['release-loop.event-response'], limit: 300 });
      expect(logs.length).toBeGreaterThanOrEqual(20 * RLA_EVENT_RESPONSE_SAMPLE_COUNT * 4 - 1);
      expect(logs.filter((row) => row.event === 'sample-verdict')).toHaveLength(2 * RLA_EVENT_RESPONSE_EVENTS.length * RLA_EVENT_RESPONSE_SAMPLE_COUNT);
      expect(logs.every((row) => {
        const data = typeof row.data === 'string' ? JSON.parse(row.data) as Record<string, unknown>
          : row.data && typeof row.data === 'object' ? row.data as Record<string, unknown> : {};
        return data.injected === true && data.level === 'L0';
      })).toBe(true);
    } finally { store.close(); }

    const longFixtureRunId = 'x'.repeat(128);
    const injectLongIdWithCanonicalLedgerId: RlaEventResponseRuntime['inject'] = (options) => runtime.inject({
      ...options, runId: options.runId === longFixtureRunId ? 'run-128' : options.runId,
    });
    await withSimClock(Date.parse('2026-11-06T00:00:00.000Z'), (clock) => runRlaEventResponseScorecard(world!, {
      clock, inject: injectLongIdWithCanonicalLedgerId, runId: longFixtureRunId, responder: async () => {},
    }));
    const longFixturePath = join(world.root, 'fixtures', 'rla-event-response', ...encodeRlaRunIdForFixturePath(longFixtureRunId), 'rla-er-01-1.json');
    expect(existsSync(longFixturePath)).toBe(true);
    expect(readFileSync(longFixturePath, 'utf8')).toContain('introducedRegressions');
  } finally {
    if (world) await destroyWorld(world);
    setTestStateRoot(previousRoot ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
