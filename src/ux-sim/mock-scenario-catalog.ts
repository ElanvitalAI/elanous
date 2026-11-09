import { isRecord } from '../primitives/guards.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface MockScenarioDevice {
  id: string;
  name: string;
  /** Checklist requests this device explicitly covers. */
  checklistCells?: string[];
  implementation: string[];
  tests: string[];
  target: string;
  inputs: string[];
  observations: string[];
  entryCommands: string[];
  logsRecorded: 'yes' | 'no' | 'conditional' | 'runner-dependent';
  eventNames: string[];
  recentUse: { observedAt: string; runId: string; event: string; scenarioId: string; command: string } | null;
}

/** File-level inventory backing the grouped, runnable device records above. */
export interface MockScenarioSourceModule {
  id: string;
  path: string;
  boundary: string;
  deviceIds: string[];
  integrityCertificatePresent: boolean;
  integrityCertificatePath: string | null;
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
  version: 2;
  deviceCatalogVersion: number;
  worldEvents: Array<{ id: string; name: string; description: string }>;
  runEvidence: {
    scope: string;
    runId: string;
    event: { category: string; name: string };
    persistence: string;
    artifact: string;
  };
  devices: MockScenarioDevice[];
  sourceModules: MockScenarioSourceModule[];
  scenarios: MockScenarioEntry[];
  candidateAudit: {
    source: string;
    baseCommit: string;
    sourceRows: number;
    existingPaths: number;
    excludedPaths: number;
    sourceExclusions: Array<{ path: string; reason: string }>;
    catalogAdditions: Array<{ path: string; reason: string }>;
    omissionCheck: { requiredPaths: string[]; missingPaths: string[] };
    candidates: MockScenarioCandidate[];
  };
  discovery: { trackedRoot: string; candidateRoots: string[]; limits: string };
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

const CHECKLIST_CELL_ID = /^[A-Z0-9][A-Z0-9-]{0,79}$/;

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
  if (!isRecord(value) || value.version !== 2) throw new Error('mock scenario catalog must declare version: 2');
  if (!Number.isSafeInteger(value.deviceCatalogVersion) || Number(value.deviceCatalogVersion) < 1) {
    throw new Error('mock scenario catalog must declare a positive deviceCatalogVersion');
  }
  if (!Array.isArray(value.devices) || !Array.isArray(value.scenarios)) {
    throw new Error('mock scenario catalog requires devices and scenarios arrays');
  }
  const deviceIds = uniqueIds(value.devices, 'devices');
  uniqueIds(value.scenarios, 'scenarios');
  const rawWorldEvents = value.worldEvents === undefined ? [] : value.worldEvents;
  if (!Array.isArray(rawWorldEvents)) throw new Error('worldEvents must be an array');
  uniqueIds(rawWorldEvents, 'worldEvents');

  const worldEvents = rawWorldEvents.map((row, index) => {
    if (!isRecord(row)) throw new Error(`worldEvents[${index}] must be an object`);
    return {
      id: requireString(row.id, `worldEvents[${index}].id`),
      name: requireString(row.name, `worldEvents[${index}].name`),
      description: requireString(row.description, `worldEvents[${index}].description`),
    };
  });

  const devices = value.devices.map((row, index): MockScenarioDevice => {
    if (!isRecord(row)) throw new Error(`devices[${index}] must be an object`);
    const checklistCells = row.checklistCells === undefined
      ? undefined
      : requireStringArray(row.checklistCells, `devices[${index}].checklistCells`);
    if (checklistCells && new Set(checklistCells).size !== checklistCells.length) {
      throw new Error(`devices[${index}].checklistCells must not contain duplicates`);
    }
    if (checklistCells?.some((cellId) => !CHECKLIST_CELL_ID.test(cellId))) {
      throw new Error(`devices[${index}].checklistCells must contain valid checklist IDs`);
    }
    return {
      id: requireString(row.id, `devices[${index}].id`),
      name: requireString(row.name, `devices[${index}].name`),
      ...(checklistCells ? { checklistCells } : {}),
      implementation: requireStringArray(row.implementation, `devices[${index}].implementation`),
      tests: requireStringArray(row.tests, `devices[${index}].tests`),
      target: requireString(row.target, `devices[${index}].target`),
      inputs: requireStringArray(row.inputs, `devices[${index}].inputs`),
      observations: requireStringArray(row.observations, `devices[${index}].observations`),
      entryCommands: requireStringArray(row.entryCommands, `devices[${index}].entryCommands`),
      logsRecorded: parseLogsRecorded(row.logsRecorded, `devices[${index}].logsRecorded`),
      eventNames: requireStringArray(row.eventNames, `devices[${index}].eventNames`, true),
      recentUse: parseRecentUse(row.recentUse, `devices[${index}].recentUse`),
    };
  });
  const rawSourceModules = value.sourceModules;
  if (!Array.isArray(rawSourceModules)) throw new Error('sourceModules must be an array');
  const sourceModuleIds = new Set<string>();
  const sourceModulePaths = new Set<string>();
  const sourceModules = rawSourceModules.map((row, index): MockScenarioSourceModule => {
    const path = `sourceModules[${index}]`;
    if (!isRecord(row)) throw new Error(`${path} must be an object`);
    const id = requireString(row.id, `${path}.id`);
    const sourcePath = requireString(row.path, `${path}.path`);
    const pathSegments = sourcePath.split('/');
    if (!sourcePath.startsWith('src/ux-sim/') || sourcePath.includes('\\') || pathSegments.some((segment) => !segment || segment === '.' || segment === '..') || !/\.(?:ts|json)$/.test(sourcePath)) {
      throw new Error(`${path}.path must stay inside src/ux-sim`);
    }
    if (sourceModulePaths.has(sourcePath)) throw new Error(`sourceModules contains duplicate path: ${sourcePath}`);
    const expectedId = `MD-${sourcePath.replace(/^src\/ux-sim\//, 'UX-SIM-').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toUpperCase()}`;
    if (id !== expectedId) throw new Error(`${path}.id must match its stable MD- path name: ${expectedId}`);
    if (sourceModuleIds.has(id)) throw new Error(`sourceModules contains duplicate id: ${id}`);
    sourceModuleIds.add(id);
    sourceModulePaths.add(sourcePath);
    const deviceIds = requireStringArray(row.deviceIds, `${path}.deviceIds`);
    if (new Set(deviceIds).size !== deviceIds.length) throw new Error(`${path}.deviceIds must not contain duplicates`);
    for (const deviceId of deviceIds) {
      const device = devices.find((entry) => entry.id === deviceId);
      if (!device) throw new Error(`${path}.deviceIds references unknown device: ${deviceId}`);
      if (!device.implementation.includes(sourcePath)) throw new Error(`${path}.path is not implemented by ${deviceId}: ${sourcePath}`);
    }
    if (typeof row.integrityCertificatePresent !== 'boolean') {
      throw new Error(`${path}.integrityCertificatePresent must be boolean`);
    }
    const integrityCertificatePath = row.integrityCertificatePath === null
      ? null : requireString(row.integrityCertificatePath, `${path}.integrityCertificatePath`);
    if (row.integrityCertificatePresent !== Boolean(integrityCertificatePath)) {
      throw new Error(`${path}.integrityCertificatePath must agree with integrityCertificatePresent`);
    }
    return {
      id,
      path: sourcePath,
      boundary: requireString(row.boundary, `${path}.boundary`),
      deviceIds,
      integrityCertificatePresent: row.integrityCertificatePresent,
      integrityCertificatePath,
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
  const rawCatalogAdditions = value.candidateAudit.catalogAdditions ?? [];
  if (!Array.isArray(rawCatalogAdditions)) throw new Error('candidateAudit.catalogAdditions must be an array');
  const catalogAdditions = rawCatalogAdditions.map((row) => {
    if (!isRecord(row)) throw new Error('candidateAudit.catalogAdditions rows must be objects');
    return {
      path: requireString(row.path, 'candidateAudit.catalogAdditions.path'),
      reason: requireString(row.reason, 'candidateAudit.catalogAdditions.reason'),
    };
  });
  const additionPaths = new Set<string>();
  const candidatePathSet = new Set(candidates.map((candidate) => candidate.path));
  for (const addition of catalogAdditions) {
    if (additionPaths.has(addition.path)) throw new Error('candidateAudit.catalogAdditions contains duplicate path: ' + addition.path);
    if (!candidatePathSet.has(addition.path)) throw new Error('candidateAudit.catalogAdditions path is not a current candidate: ' + addition.path);
    additionPaths.add(addition.path);
  }
  const omissionCheck = value.candidateAudit.omissionCheck;
  if (!isRecord(omissionCheck)) throw new Error('candidateAudit.omissionCheck is required');
  const requiredPaths = requireStringArray(omissionCheck.requiredPaths, 'candidateAudit.omissionCheck.requiredPaths');
  const missingPaths = requireStringArray(omissionCheck.missingPaths, 'candidateAudit.omissionCheck.missingPaths', true);
  const indexedCandidatePaths = new Set([...candidates, ...sourceExclusions].map((row) => row.path));
  for (const path of requiredPaths) {
    if (!indexedCandidatePaths.has(path)) throw new Error(`candidateAudit.omissionCheck path is not accounted for: ${path}`);
  }
  if (missingPaths.some((path) => !requiredPaths.includes(path))) throw new Error('candidateAudit.omissionCheck.missingPaths must be required paths');
  const candidateAudit = value.candidateAudit;
  const sourceRows = candidateAudit.sourceRows;
  const baseCommit = candidateAudit.baseCommit;
  const existingPaths = candidateAudit.existingPaths;
  const excludedPaths = candidateAudit.excludedPaths;
  if (![sourceRows, existingPaths, excludedPaths].every((n) => Number.isInteger(n) && Number(n) >= 0)) {
    throw new Error('candidateAudit counts must be non-negative integers');
  }
  const baselineCandidateCount = candidates.length - catalogAdditions.length;
  const baselineExcludedCount = candidates.filter((candidate) => candidate.disposition === 'excluded' && !additionPaths.has(candidate.path)).length;
  if (sourceRows !== baselineCandidateCount + sourceExclusions.length || excludedPaths !== baselineExcludedCount) {
    throw new Error('candidateAudit counts do not match the candidate rows');
  }
  if (Number(existingPaths) !== baselineCandidateCount) throw new Error('candidateAudit.existingPaths must equal the baseline candidate count after catalog additions');
  const runEvidence = value.runEvidence;
  if (!isRecord(runEvidence) || !isRecord(runEvidence.event)) throw new Error('runEvidence and runEvidence.event are required');
  if (!isRecord(value.discovery)) throw new Error('discovery is required');
  const event = runEvidence.event;
  const discovery = value.discovery;
  return {
    version: 2,
    deviceCatalogVersion: Number(value.deviceCatalogVersion),
    worldEvents,
    devices,
    sourceModules,
    scenarios,
    candidateAudit: {
      source: requireString(candidateAudit.source, 'candidateAudit.source'),
      baseCommit: requireString(baseCommit, 'candidateAudit.baseCommit'),
      sourceRows: Number(sourceRows),
      existingPaths: Number(existingPaths),
      excludedPaths: Number(excludedPaths),
      sourceExclusions,
      catalogAdditions,
      omissionCheck: { requiredPaths, missingPaths },
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

const FRAGMENTS_ROOT = 'catalog/ux-sim/mock-scenario-catalog-fragments';

export function loadMockScenarioCatalogFromRoot(repoRoot: string): MockScenarioCatalog {
  const root = resolve(repoRoot, FRAGMENTS_ROOT);
  const read = (path: string): unknown => JSON.parse(readFileSync(resolve(root, path), 'utf8')) as unknown;
  const rows = (collection: string): unknown[] => {
    const directory = resolve(root, collection);
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((name) => name.endsWith('.json')).sort().map((name) => {
      if (!/^\d{5}--[a-z0-9][a-z0-9-]*\.json$/.test(name)) throw new Error(`${collection}/${name} must use a five-digit ordering slot and identity slug`);
      return read(`${collection}/${name}`);
    });
  };
  const metadata = read('metadata.json');
  if (!isRecord(metadata) || !isRecord(metadata.candidateAudit)) throw new Error('catalog fragment metadata is invalid');
  const audit = metadata.candidateAudit;
  return parseMockScenarioCatalog({
    candidateAudit: { source: audit.source, baseCommit: audit.baseCommit, sourceRows: audit.sourceRows, existingPaths: audit.existingPaths,
      excludedPaths: audit.excludedPaths, catalogAdditions: rows('catalog-additions'), sourceExclusions: rows('source-exclusions'),
      omissionCheck: { requiredPaths: rows('omission-required-paths'), missingPaths: rows('omission-missing-paths') }, candidates: rows('candidates') },
    deviceCatalogVersion: metadata.deviceCatalogVersion, devices: rows('devices'), discovery: metadata.discovery,
    runEvidence: metadata.runEvidence, scenarios: rows('scenarios'), sourceModules: rows('source-modules'), version: metadata.version, worldEvents: rows('world-events'),
  });
}

export function loadMockScenarioCatalog(): MockScenarioCatalog {
  return loadMockScenarioCatalogFromRoot(fileURLToPath(new URL('../..', import.meta.url)));
}

export function renderMockScenarioList(catalog: MockScenarioCatalog): string[] {
  const reviewedRows = catalog.candidateAudit.sourceRows + catalog.candidateAudit.catalogAdditions.length;
  const reviewedPaths = catalog.candidateAudit.existingPaths + catalog.candidateAudit.catalogAdditions.length;
  return [
    'Mock scenario catalog · reusable devices and scenario references',
    ...catalog.scenarios.map((scenario) => `${scenario.id}\t${scenario.kind}\t${scenario.name}`),
    `장치 ${catalog.devices.length} · 시나리오 ${catalog.scenarios.length} · 자세히: bun scripts/ux-sim.ts show <MS-id>`,
    '후보 감사 ' + reviewedPaths + '/' + reviewedRows + ' 경로 확인 · 제외 ' + catalog.candidateAudit.excludedPaths + ' · entry/logs 근거는 catalog/ux-sim/mock-scenario-catalog-fragments/',
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

/** Read-only device inventory; it reports stored evidence metadata and never runs a device. */
export function renderMockScenarioDevices(catalog: MockScenarioCatalog): string[] {
  return [
    'Mock device registry · read-only',
    ...catalog.devices.map((device) => [
      `${device.id}\t${device.name}`,
      `entry=${device.entryCommands.join(' ⊕ ')}`,
      `logs=${device.logsRecorded}`,
      `events=${device.eventNames.length ? device.eventNames.join(',') : '(none recorded)'}`,
      `recent=${device.recentUse ? `${device.recentUse.observedAt} runId=${device.recentUse.runId} event=${device.recentUse.event} scenario=${device.recentUse.scenarioId} cmd=${device.recentUse.command}` : '(not recorded)'}`,
    ].join('\t')),
    `omission check: required=${catalog.candidateAudit.omissionCheck.requiredPaths.length} missing=${catalog.candidateAudit.omissionCheck.missingPaths.length}`,
    'Source module registry · MD name · file boundary · integrity certificate (recorded)',
    ...catalog.sourceModules.map((module) => `${module.id}\t${module.path}\t${module.boundary}\tdevices=${module.deviceIds.join(',')}\tcertificate=${module.integrityCertificatePresent ? module.integrityCertificatePath : 'no'}`),
  ];
}

/** Markdown source generated for the human registry in MANUAL §1. */
export function renderMockScenarioDeviceMarkdownTable(catalog: MockScenarioCatalog): string[] {
  const escape = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
  return [
    '| ID | 장치 | 구현 · 시험 | 진입 명령 | test logs 근거 | 최근 사용 근거 |',
    '|---|---|---|---|---|---|',
    ...catalog.devices.map((device) => {
      const recent = device.recentUse
        ? `${device.recentUse.observedAt} · ${device.recentUse.runId} · ${device.recentUse.event} · ${device.recentUse.scenarioId}`
        : '기록 없음';
      return `| ${escape(device.id)} | ${escape(device.name)} | 구현: ${escape(device.implementation.join('<br>'))}<br>시험: ${escape(device.tests.join('<br>'))} | ${escape(device.entryCommands.join('<br>'))} | ${escape(device.logsRecorded)} · ${escape(device.eventNames.join(', ') || '(없음)')} | ${escape(recent)} |`;
    }),
    '',
    '### Source-file registry',
    '',
    '| MD name | Source file | Boundary | Owning device IDs | Integrity certificate recorded |',
    '|---|---|---|---|---|',
    ...catalog.sourceModules.map((module) => `| ${escape(module.id)} | ${escape(module.path)} | ${escape(module.boundary)} | ${escape(module.deviceIds.join(', '))} | ${module.integrityCertificatePresent ? escape(module.integrityCertificatePath ?? 'yes') : 'no'} |`),
  ];
}

function parseLogsRecorded(value: unknown, path: string): MockScenarioDevice['logsRecorded'] {
  const result = requireString(value, path);
  if (!['yes', 'no', 'conditional', 'runner-dependent'].includes(result)) throw new Error(`${path} is unknown: ${result}`);
  return result as MockScenarioDevice['logsRecorded'];
}

function parseRecentUse(value: unknown, path: string): MockScenarioDevice['recentUse'] {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error(`${path} must be an object or null`);
  return {
    observedAt: requireString(value.observedAt, `${path}.observedAt`),
    runId: requireString(value.runId, `${path}.runId`),
    event: requireString(value.event, `${path}.event`),
    scenarioId: requireString(value.scenarioId, `${path}.scenarioId`),
    command: requireString(value.command, `${path}.command`),
  };
}
