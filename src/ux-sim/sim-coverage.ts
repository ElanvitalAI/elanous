import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getTestStateRoot } from '../nexus/paths.js';
import { loadMockScenarioCatalog, type MockScenarioCatalog } from './mock-scenario-catalog.js';
import { requestMockDevice } from './mock-device-requests.js';
import { deviceFidelityStatus } from './device-fidelity.js';

const COVERAGE_FORMAT = 1;
const EVENT_ALIASES: Record<string, string> = { 'dead-pid-lock': 'EV-0042', 'host-reboot': 'EV-0107' };
const TOP_UNCOVERED_LIMIT = 10;

export interface SimCoverageReceipt {
  format: 1;
  runId: string;
  worldId: string;
  scenarioId: string;
  completedAt: string;
  pass: boolean;
  verdict?: 'green' | 'yellow' | 'red';
  recordingIds?: string[];
  codePathCoveragePercent: number;
  codePaths: string[];
  eventKinds: string[];
  eventIds: string[];
  devices: Array<{ id: string; fingerprint: string }>;
}

export interface SimCoverageReport {
  runCount: number;
  coverageBasis: 'assembled-device-source-modules';
  codePathCoverage: { covered: number; total: number; percent: number };
  eventCoverage: { covered: number; total: number; percent: number };
  deviceCoverage: { fingerprinted: number; total: number; percent: number };
  uncoveredPaths: Array<{ path: string; deviceIds: string[]; coveredRuns: number }>;
  receipts: SimCoverageReceipt[];
}

interface CoverageWorld {
  id: string;
  spec: { devices: string[]; events: Array<{ at: string; id: string }> };
}

function sha(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

function isTestModulePath(path: string): boolean {
  return /\.(?:test|spec)\.[^/]+$/.test(path);
}

function privateDirectory(path: string, root: string): string {
  const rootPath = realpathSync(root);
  const physical = realpathSync(path);
  const rel = relative(rootPath, physical);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('sim coverage storage escaped the explicit test universe');
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) {
    throw new Error('sim coverage storage must be a private 0700 directory: ' + path);
  }
  return physical;
}

function coverageRunsDirectory(create: boolean): { root: string; directory?: string } {
  const configuredRoot = getTestStateRoot();
  if (!configuredRoot) throw new Error('sim coverage requires an explicit --test universe');
  const logicalRoot = resolve(configuredRoot);
  const rootInfo = lstatSync(logicalRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('sim coverage test root must be a real directory');
  const root = realpathSync(logicalRoot);
  let parent = root;
  for (const path of [join(root, 'sim'), join(root, 'sim', 'coverage'), join(root, 'sim', 'coverage', 'runs')]) {
    if (!create) {
      try { lstatSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { root };
        throw error;
      }
    }
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return { root };
        throw error;
      }
    }
    parent = privateDirectory(path, parent);
  }
  return { root, directory: parent };
}

function codePaths(deviceIds: string[], catalog: MockScenarioCatalog, repoRoot: string): string[] {
  const selected = new Set(deviceIds);
  return catalog.sourceModules.filter((module) => module.deviceIds.some((id) => selected.has(id)))
    .map((module) => module.path)
    .filter((path) => !isTestModulePath(path)
      && !path.startsWith('/') && !path.split('/').some((segment) => segment === '.' || segment === '..')
      && resolve(repoRoot, path).startsWith(resolve(repoRoot) + sep)
      && realpathSync(resolve(repoRoot, path)).startsWith(realpathSync(repoRoot) + sep));
}

function implementationFingerprint(deviceId: string, catalog: MockScenarioCatalog, repoRoot: string): string {
  const device = catalog.devices.find((candidate) => candidate.id === deviceId);
  if (!device) throw new Error('sim coverage references unknown device: ' + deviceId);
  const ownedPaths = codePaths([deviceId], catalog, repoRoot);
  const implementationPaths = [...new Set([...ownedPaths, ...device.implementation])];
  const physicalRepo = realpathSync(repoRoot);
  const entries = [...implementationPaths].sort().map((path) => {
    if (path.startsWith('/') || path.split('/').some((segment) => segment === '.' || segment === '..')) {
      throw new Error('sim coverage catalog path escaped repository: ' + path);
    }
    const absolute = resolve(repoRoot, path);
    if (!absolute.startsWith(resolve(repoRoot) + sep)) throw new Error('sim coverage catalog path escaped repository: ' + path);
    const physical = realpathSync(absolute);
    const relativePath = relative(physicalRepo, physical);
    if (!relativePath || relativePath === '..' || relativePath.startsWith('..' + sep) || isAbsolute(relativePath)) {
      throw new Error('sim coverage catalog path escaped repository through a link: ' + path);
    }
    return path + '\0' + sha(readFileSync(physical));
  });
  return sha(entries.join('\n'));
}

function registeredEventId(kind: string, catalog: MockScenarioCatalog): string | undefined {
  if (catalog.worldEvents.some((event) => event.id === kind)) return kind;
  const alias = EVENT_ALIASES[kind];
  return alias && catalog.worldEvents.some((event) => event.id === alias) ? alias : undefined;
}

function makeReceipt(input: {
  world: CoverageWorld;
  deviceIds: string[];
  pass: boolean;
  verdict?: 'green' | 'yellow' | 'red';
  scenarioFile: string;
  observations: Array<{ event: string; verdict: string }>;
  recordingIds?: string[];
  now: Date;
  repoRoot: string;
  catalog: MockScenarioCatalog;
}): Omit<SimCoverageReceipt, 'codePathCoveragePercent'> {
  const scenarioId = basename(input.scenarioFile).replace(/[^A-Za-z0-9._-]/g, '_') || 'scenario';
  const deviceIds = [...new Set(input.deviceIds.map((id) =>
    id === 'fake-gh' ? 'fake-github' : id === 'mail' ? 'sim-mailbox' : id.split(':', 1)[0]!,
  ))].sort();
  const devices = deviceIds.map((id) => ({ id, fingerprint: implementationFingerprint(id, input.catalog, input.repoRoot) }));
  const paths = new Set(codePaths(deviceIds, input.catalog, input.repoRoot));
  const eventKinds = [...new Set(input.observations.map((observation) => observation.event))].sort();
  const eventIds = [...new Set(eventKinds
    .map((kind) => registeredEventId(kind, input.catalog))
    .filter((id): id is string => Boolean(id)))].sort();
  return {
    format: COVERAGE_FORMAT,
    runId: randomUUID(),
    worldId: input.world.id,
    scenarioId,
    completedAt: input.now.toISOString(),
    pass: input.pass,
    ...(input.verdict ? { verdict: input.verdict } : {}),
    ...(input.recordingIds?.length ? { recordingIds: [...new Set(input.recordingIds)].sort() } : {}),
    codePaths: [...paths].sort(),
    eventKinds,
    eventIds,
    devices,
  };
}

function validateReceipt(value: unknown, path: string): SimCoverageReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('sim coverage receipt is invalid: ' + path);
  const row = value as Record<string, unknown>;
  if (row.format !== COVERAGE_FORMAT || typeof row.runId !== 'string' || typeof row.worldId !== 'string'
    || typeof row.scenarioId !== 'string' || typeof row.completedAt !== 'string' || typeof row.pass !== 'boolean'
    || typeof row.codePathCoveragePercent !== 'number' || row.codePathCoveragePercent < 0 || row.codePathCoveragePercent > 100
    || !Array.isArray(row.codePaths)
    || row.codePaths.some((entry) => typeof entry !== 'string') || !Array.isArray(row.eventKinds)
    || row.eventKinds.some((entry) => typeof entry !== 'string') || !Array.isArray(row.eventIds)
    || row.eventIds.some((entry) => typeof entry !== 'string') || !Array.isArray(row.devices)
    || (row.recordingIds !== undefined && (!Array.isArray(row.recordingIds) || row.recordingIds.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))))
    || (row.verdict !== undefined && !['green', 'yellow', 'red'].includes(String(row.verdict)))) {
    throw new Error('sim coverage receipt is invalid: ' + path);
  }
  const devices = row.devices.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('sim coverage receipt device is invalid: ' + path);
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint)) {
      throw new Error('sim coverage receipt device is invalid: ' + path);
    }
    return { id: item.id, fingerprint: item.fingerprint };
  });
  return {
    format: COVERAGE_FORMAT, runId: row.runId, worldId: row.worldId, scenarioId: row.scenarioId,
    completedAt: row.completedAt, codePathCoveragePercent: row.codePathCoveragePercent,
    pass: row.pass,
    ...(row.verdict ? { verdict: row.verdict as SimCoverageReceipt['verdict'] } : {}),
    ...(Array.isArray(row.recordingIds) ? { recordingIds: row.recordingIds as string[] } : {}),
    codePaths: row.codePaths as string[], eventKinds: row.eventKinds as string[],
    eventIds: row.eventIds as string[], devices,
  };
}

function readReceipts(directory: string): SimCoverageReceipt[] {
  return readdirSync(directory).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).sort().map((name) => {
    const path = join(directory, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) {
      throw new Error('sim coverage receipt must be an owned 0600 file: ' + path);
    }
    const receipt = validateReceipt(JSON.parse(readFileSync(path, 'utf8')), path);
    if (receipt.runId + '.json' !== name) throw new Error('sim coverage receipt filename does not match runId: ' + path);
    return receipt;
  });
}

function persistReceipt(directory: string, receipt: SimCoverageReceipt): void {
  const temporary = join(directory, '.' + receipt.runId + '.tmp');
  const target = join(directory, receipt.runId + '.json');
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(temporary, target); }
  finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function percent(covered: number, total: number): number { return total === 0 ? 100 : Math.round((covered / total) * 10000) / 100; }

function makeReport(receipts: SimCoverageReceipt[], catalog: MockScenarioCatalog): SimCoverageReport {
  receipts = receipts.map((receipt) => {
    if (!receipt.pass || !receipt.recordingIds?.length) return receipt;
    const comparison = deviceFidelityStatus('fake-llm', receipt.recordingIds);
    return comparison.verdict === 'yellow' ? { ...receipt, pass: false, verdict: 'yellow' } : receipt;
  });
  const allPaths = new Map<string, Set<string>>();
  for (const module of catalog.sourceModules) {
    const path = module.path;
    if (isTestModulePath(path)) continue;
    const owners = allPaths.get(path) ?? new Set<string>();
    for (const deviceId of module.deviceIds) owners.add(deviceId);
    allPaths.set(path, owners);
  }
  const coveredPaths = new Set(receipts.flatMap((receipt) => receipt.codePaths).filter((path) => allPaths.has(path)));
  const registeredEvents = new Set(catalog.worldEvents.map((event) => event.id));
  const eventIds = new Set(receipts.flatMap((receipt) => receipt.eventIds).filter((id) => registeredEvents.has(id)));
  const registeredDevices = new Set(catalog.devices.map((device) => device.id));
  const deviceIds = new Set(receipts.flatMap((receipt) => receipt.devices.map((device) => device.id)).filter((id) => registeredDevices.has(id)));
  const pathRuns = new Map<string, number>();
  for (const receipt of receipts) for (const path of new Set(receipt.codePaths.filter((item) => allPaths.has(item)))) {
    pathRuns.set(path, (pathRuns.get(path) ?? 0) + 1);
  }
  const uncoveredPaths = [...allPaths.entries()].filter(([path]) => !coveredPaths.has(path))
    .map(([path, owners]) => ({ path, deviceIds: [...owners].sort(), coveredRuns: pathRuns.get(path) ?? 0 }))
    .sort((a, b) => a.coveredRuns - b.coveredRuns || a.path.localeCompare(b.path)).slice(0, TOP_UNCOVERED_LIMIT);
  return {
    runCount: receipts.length,
    coverageBasis: 'assembled-device-source-modules',
    codePathCoverage: { covered: coveredPaths.size, total: allPaths.size, percent: percent(coveredPaths.size, allPaths.size) },
    eventCoverage: { covered: eventIds.size, total: catalog.worldEvents.length, percent: percent(eventIds.size, catalog.worldEvents.length) },
    deviceCoverage: { fingerprinted: deviceIds.size, total: catalog.devices.length, percent: percent(deviceIds.size, catalog.devices.length) },
    uncoveredPaths,
    receipts,
  };
}

function enqueueUncoveredRequests(report: SimCoverageReport, catalog: MockScenarioCatalog): number {
  let created = 0;
  for (const uncovered of report.uncoveredPaths) {
    const nearestDeviceId = uncovered.deviceIds[0];
    if (!nearestDeviceId) continue;
    const cellId = 'SIM-COV-' + sha(uncovered.path).slice(0, 16).toUpperCase();
    requestMockDevice({
      cellId,
      boundary: 'Uncovered simulation code path: ' + uncovered.path,
      nearestDeviceId,
    }, { catalog });
    created++;
  }
  return created;
}

export function recordSimWorldCoverage(input: {
  world: CoverageWorld;
  deviceIds: string[];
  pass: boolean;
  verdict?: 'green' | 'yellow' | 'red';
  scenarioFile: string;
  observations: Array<{ event: string; verdict: string }>;
  recordingIds?: string[];
  now?: () => Date;
  repoRoot?: string;
  catalog?: MockScenarioCatalog;
}): { receipt: SimCoverageReceipt; report: SimCoverageReport; requested: number } {
  const dirs = coverageRunsDirectory(true);
  if (!dirs.directory) throw new Error('sim coverage run storage was not created');
  const repoRoot = resolve(input.repoRoot ?? resolve(import.meta.dir, '../..'));
  const catalog = input.catalog ?? loadMockScenarioCatalog();
  const partialReceipt = makeReceipt({ ...input, now: (input.now ?? (() => new Date()))(), repoRoot, catalog });
  const allPaths = new Set(catalog.sourceModules.map((module) => module.path).filter((path) => !isTestModulePath(path)));
  const covered = new Set(partialReceipt.codePaths.filter((path) => allPaths.has(path)));
  const receipt: SimCoverageReceipt = { ...partialReceipt, codePathCoveragePercent: percent(covered.size, allPaths.size) };
  const report = makeReport([...readReceipts(dirs.directory), receipt], catalog);
  const requested = enqueueUncoveredRequests(report, catalog);
  persistReceipt(dirs.directory, receipt);
  return { receipt, report, requested };
}

export function readSimCoverage(options: {
  catalog?: MockScenarioCatalog;
} = {}): SimCoverageReport {
  const dirs = coverageRunsDirectory(false);
  const catalog = options.catalog ?? loadMockScenarioCatalog();
  const report = makeReport(dirs.directory ? readReceipts(dirs.directory) : [], catalog);
  enqueueUncoveredRequests(report, catalog);
  return report;
}
