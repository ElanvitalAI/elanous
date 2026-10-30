import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface MockScenarioDevice {
  id: string;
  name: string;
  implementation: string[];
  tests: string[];
  target: string;
  inputs: string[];
  observations: string[];
}

export interface MockScenarioEntry {
  id: string;
  name: string;
  kind: string;
  device: string;
  implementation: string[];
  tests: string[];
  trigger: string;
  observe: string[];
  expected: string;
}

export interface MockScenarioCatalog {
  version: 1;
  runEvidence: {
    scope: string;
    runId: string;
    event: { category: string; name: string };
    persistence: string;
    artifact: string;
  };
  devices: MockScenarioDevice[];
  scenarios: MockScenarioEntry[];
  discovery: { trackedRoot: string; candidateRoots: string[]; limits: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} must be a non-empty string`);
  return value;
}

function requireStringArray(value: unknown, path: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${path} must be ${allowEmpty ? 'an' : 'a non-empty'} array of non-empty strings`);
  }
  return value as string[];
}

function uniqueIds(rows: unknown[], path: string): Set<string> {
  const ids = new Set<string>();
  rows.forEach((row, index) => {
    if (!isRecord(row)) throw new Error(`${path}[${index}] must be an object`);
    const id = requireString(row.id, `${path}[${index}].id`);
    if (ids.has(id)) throw new Error(`${path} contains duplicate id: ${id}`);
    ids.add(id);
  });
  return ids;
}

/** Validate the checked-in index before CLI output or scenario metadata is consumed. */
export function parseMockScenarioCatalog(value: unknown): MockScenarioCatalog {
  if (!isRecord(value) || value.version !== 1) throw new Error('mock scenario catalog must declare version: 1');
  if (!Array.isArray(value.devices) || !Array.isArray(value.scenarios)) throw new Error('mock scenario catalog requires devices and scenarios arrays');
  const deviceIds = uniqueIds(value.devices, 'devices');
  uniqueIds(value.scenarios, 'scenarios');

  const devices = value.devices.map((row, index): MockScenarioDevice => {
    if (!isRecord(row)) throw new Error(`devices[${index}] must be an object`);
    return {
      id: requireString(row.id, `devices[${index}].id`),
      name: requireString(row.name, `devices[${index}].name`),
      implementation: requireStringArray(row.implementation, `devices[${index}].implementation`),
      tests: requireStringArray(row.tests, `devices[${index}].tests`),
      target: requireString(row.target, `devices[${index}].target`),
      inputs: requireStringArray(row.inputs, `devices[${index}].inputs`),
      observations: requireStringArray(row.observations, `devices[${index}].observations`),
    };
  });
  const scenarios = value.scenarios.map((row, index): MockScenarioEntry => {
    if (!isRecord(row)) throw new Error(`scenarios[${index}] must be an object`);
    const device = requireString(row.device, `scenarios[${index}].device`);
    if (!deviceIds.has(device)) throw new Error(`scenarios[${index}] references unknown device: ${device}`);
    return {
      id: requireString(row.id, `scenarios[${index}].id`),
      name: requireString(row.name, `scenarios[${index}].name`),
      kind: requireString(row.kind, `scenarios[${index}].kind`),
      device,
      implementation: requireStringArray(row.implementation, `scenarios[${index}].implementation`),
      tests: requireStringArray(row.tests, `scenarios[${index}].tests`),
      trigger: requireString(row.trigger, `scenarios[${index}].trigger`),
      observe: requireStringArray(row.observe, `scenarios[${index}].observe`),
      expected: requireString(row.expected, `scenarios[${index}].expected`),
    };
  });
  if (!isRecord(value.runEvidence) || !isRecord(value.runEvidence.event)) throw new Error('runEvidence and runEvidence.event are required');
  if (!isRecord(value.discovery)) throw new Error('discovery is required');
  const runEvidence = value.runEvidence;
  const event = runEvidence.event;
  const discovery = value.discovery;
  return {
    version: 1,
    devices,
    scenarios,
    runEvidence: {
      scope: requireString(runEvidence.scope, 'runEvidence.scope'),
      runId: requireString(runEvidence.runId, 'runEvidence.runId'),
      event: { category: requireString(event.category, 'runEvidence.event.category'), name: requireString(event.name, 'runEvidence.event.name') },
      persistence: requireString(runEvidence.persistence, 'runEvidence.persistence'),
      artifact: requireString(runEvidence.artifact, 'runEvidence.artifact'),
    },
    discovery: {
      trackedRoot: requireString(discovery.trackedRoot, 'discovery.trackedRoot'),
      candidateRoots: requireStringArray(discovery.candidateRoots, 'discovery.candidateRoots'),
      limits: requireString(discovery.limits, 'discovery.limits'),
    },
  };
}

export function loadMockScenarioCatalog(): MockScenarioCatalog {
  const path = fileURLToPath(new URL('./mock-scenario-catalog.json', import.meta.url));
  return parseMockScenarioCatalog(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

export function renderMockScenarioList(catalog: MockScenarioCatalog): string[] {
  return [
    'Mock scenario catalog · reusable devices and scenario references',
    ...catalog.scenarios.map((scenario) => `${scenario.id}\t${scenario.kind}\t${scenario.name}`),
    `장치 ${catalog.devices.length} · 시나리오 ${catalog.scenarios.length} · 자세히: bun scripts/ux-sim.ts show <MS-id>`,
  ];
}

export function renderMockScenarioDetails(catalog: MockScenarioCatalog, id: string): string[] {
  const scenario = catalog.scenarios.find((entry) => entry.id === id);
  if (!scenario) throw new Error(`unknown mock scenario id: ${id}`);
  const device = catalog.devices.find((entry) => entry.id === scenario.device)!;
  return [
    `${scenario.id} · ${scenario.name}`,
    `유형: ${scenario.kind}`,
    `장치: ${device.name} (${device.id})`,
    `대상: ${device.target}`,
    `입력: ${device.inputs.join(' · ')}`,
    `주입: ${scenario.trigger}`,
    `관측: ${scenario.observe.join(' · ')}`,
    `기대: ${scenario.expected}`,
    `구현: ${scenario.implementation.join(' · ')}`,
    `시험: ${scenario.tests.join(' · ')}`,
    `ScenarioV0 실행 증거: ${catalog.runEvidence.scope} · runId → ${catalog.runEvidence.event.category}/${catalog.runEvidence.event.name} → test logs.db · ${catalog.runEvidence.artifact}`,
  ];
}
