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

export interface MockScenarioCandidate {
  path: string;
  disposition: 'device' | 'scenario' | 'already-indexed' | 'excluded';
  entryCommand: string;
  logsRecorded: 'yes' | 'no' | 'conditional' | 'runner-dependent';
  logsDetail: string;
  deviceId?: string;
  scenarioIds?: string[];
  excludeReason?: string;
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
  candidateAudit: {
    source: string;
    baseCommit: string;
    sourceRows: number;
    existingPaths: number;
    excludedPaths: number;
    sourceExclusions: Array<{ path: string; reason: string }>;
    candidates: MockScenarioCandidate[];
  };
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
  if (!isRecord(value.candidateAudit) || !Array.isArray(value.candidateAudit.candidates) || !Array.isArray(value.candidateAudit.sourceExclusions)) {
    throw new Error('candidateAudit and candidateAudit.candidates are required');
  }
  const knownScenarioIds = new Set(scenarios.map((scenario) => scenario.id));
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const candidatePaths = new Set<string>();
  const sourceExclusions = value.candidateAudit.sourceExclusions.map((row, index) => {
    if (!isRecord(row)) throw new Error(`candidateAudit.sourceExclusions[${index}] must be an object`);
    const path = requireString(row.path, `candidateAudit.sourceExclusions[${index}].path`);
    if (candidatePaths.has(path)) throw new Error(`candidateAudit.sourceExclusions contains duplicate path: ${path}`);
    candidatePaths.add(path);
    return { path, reason: requireString(row.reason, `candidateAudit.sourceExclusions[${index}].reason`) };
  });
  const candidates = value.candidateAudit.candidates.map((row, index): MockScenarioCandidate => {
    if (!isRecord(row)) throw new Error(`candidateAudit.candidates[${index}] must be an object`);
    const path = requireString(row.path, `candidateAudit.candidates[${index}].path`);
    if (candidatePaths.has(path)) throw new Error(`candidateAudit.candidates contains duplicate path: ${path}`);
    candidatePaths.add(path);
    const disposition = requireString(row.disposition, `candidateAudit.candidates[${index}].disposition`);
    if (!['device', 'scenario', 'already-indexed', 'excluded'].includes(disposition)) {
      throw new Error(`candidateAudit.candidates[${index}].disposition is unknown: ${disposition}`);
    }
    const logsRecorded = requireString(row.logsRecorded, `candidateAudit.candidates[${index}].logsRecorded`);
    if (!['yes', 'no', 'conditional', 'runner-dependent'].includes(logsRecorded)) {
      throw new Error(`candidateAudit.candidates[${index}].logsRecorded is unknown: ${logsRecorded}`);
    }
    const deviceId = row.deviceId === undefined ? undefined : requireString(row.deviceId, `candidateAudit.candidates[${index}].deviceId`);
    if (deviceId && !deviceIds.has(deviceId)) throw new Error(`candidateAudit.candidates[${index}] references unknown device: ${deviceId}`);
    const scenarioIds = row.scenarioIds === undefined ? undefined : requireStringArray(row.scenarioIds, `candidateAudit.candidates[${index}].scenarioIds`);
    for (const scenarioId of scenarioIds ?? []) {
      if (!knownScenarioIds.has(scenarioId)) throw new Error(`candidateAudit.candidates[${index}] references unknown scenario: ${scenarioId}`);
    }
    const excludeReason = row.excludeReason === undefined ? undefined : requireString(row.excludeReason, `candidateAudit.candidates[${index}].excludeReason`);
    if (disposition === 'excluded' && !excludeReason) throw new Error(`candidateAudit.candidates[${index}] excluded entries require excludeReason`);
    if (disposition === 'excluded' && (deviceId || scenarioIds?.length)) {
      throw new Error(`candidateAudit.candidates[${index}] excluded entries cannot have catalog links`);
    }
    if (disposition === 'device' && (!deviceId || !scenarioIds?.length)) {
      throw new Error(`candidateAudit.candidates[${index}] device entries require deviceId and scenarioIds`);
    }
    if (disposition === 'scenario' && (!deviceId || !scenarioIds?.length)) {
      throw new Error(`candidateAudit.candidates[${index}] scenario entries require deviceId and scenarioIds`);
    }
    if (disposition === 'already-indexed' && !deviceId && !scenarioIds?.length) {
      throw new Error(`candidateAudit.candidates[${index}] already-indexed entries require a catalog link`);
    }
    if (scenarioIds?.length && !deviceId) {
      throw new Error(`candidateAudit.candidates[${index}] scenarioIds require a deviceId`);
    }
    if (deviceId) {
      const device = deviceById.get(deviceId)!;
      if (![...device.implementation, ...device.tests].includes(path)) {
        throw new Error(`candidateAudit.candidates[${index}] path is not registered by device ${deviceId}: ${path}`);
      }
    }
    for (const scenarioId of scenarioIds ?? []) {
      const scenario = scenarioById.get(scenarioId)!;
      if (scenario.device !== deviceId) {
        throw new Error(`candidateAudit.candidates[${index}] deviceId does not own scenario ${scenarioId}`);
      }
      if (![...scenario.implementation, ...scenario.tests].includes(path)) {
        throw new Error(`candidateAudit.candidates[${index}] path is not registered by scenario ${scenarioId}: ${path}`);
      }
    }
    return {
      path,
      disposition: disposition as MockScenarioCandidate['disposition'],
      entryCommand: requireString(row.entryCommand, `candidateAudit.candidates[${index}].entryCommand`),
      logsRecorded: logsRecorded as MockScenarioCandidate['logsRecorded'],
      logsDetail: requireString(row.logsDetail, `candidateAudit.candidates[${index}].logsDetail`),
      ...(deviceId ? { deviceId } : {}),
      ...(scenarioIds ? { scenarioIds } : {}),
      ...(excludeReason ? { excludeReason } : {}),
    };
  });
  const candidateAudit = value.candidateAudit;
  const sourceRows = candidateAudit.sourceRows;
  const baseCommit = candidateAudit.baseCommit;
  const existingPaths = candidateAudit.existingPaths;
  const excludedPaths = candidateAudit.excludedPaths;
  if (![sourceRows, existingPaths, excludedPaths].every((n) => Number.isInteger(n) && Number(n) >= 0)) {
    throw new Error('candidateAudit counts must be non-negative integers');
  }
  if (sourceRows !== candidates.length + sourceExclusions.length || excludedPaths !== candidates.filter((candidate) => candidate.disposition === 'excluded').length) {
    throw new Error('candidateAudit counts do not match the candidate rows');
  }
  if (Number(existingPaths) !== candidates.length) throw new Error('candidateAudit.existingPaths must equal the current candidate count');
  const runEvidence = value.runEvidence;
  if (!isRecord(runEvidence) || !isRecord(runEvidence.event)) throw new Error('runEvidence and runEvidence.event are required');
  if (!isRecord(value.discovery)) throw new Error('discovery is required');
  const event = runEvidence.event;
  const discovery = value.discovery;
  return {
    version: 1,
    devices,
    scenarios,
    candidateAudit: {
      source: requireString(candidateAudit.source, 'candidateAudit.source'),
      baseCommit: requireString(baseCommit, 'candidateAudit.baseCommit'),
      sourceRows: Number(sourceRows),
      existingPaths: Number(existingPaths),
      excludedPaths: Number(excludedPaths),
      sourceExclusions,
      candidates,
    },
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
    `후보 감사 ${catalog.candidateAudit.existingPaths}/${catalog.candidateAudit.sourceRows} 경로 확인 · 제외 ${catalog.candidateAudit.excludedPaths} · entry/logs 근거는 mock-scenario-catalog.json`,
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
