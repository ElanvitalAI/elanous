import { createHash, randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { getTestStateRoot } from '../nexus/paths.js';
import { loadMockScenarioCatalog, type MockScenarioCatalog } from './mock-scenario-catalog.js';

export interface MockDeviceRequest {
  id: string;
  cellId: string;
  boundary: string;
  nearestDeviceId: string;
  requestedAt: string;
}

export interface MockDeviceRequestView extends MockDeviceRequest {
  state: 'missing' | 'resolved';
  resolvedBy?: string;
}

export class MockDeviceRequestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MockDeviceRequestInputError';
  }
}

const CELL_ID = /^[A-Z0-9][A-Z0-9-]{0,79}$/;
const MAX_BOUNDARY_LENGTH = 500;

function requestDirectoryPath(): string {
  const testRoot = getTestStateRoot();
  if (!testRoot) throw new Error('mock device requests require an explicit --test universe');
  const logicalRoot = resolve(testRoot);
  const rootInfo = lstatSync(logicalRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('mock device request test root must be a real directory');
  const physicalRoot = realpathSync(logicalRoot);
  const parent = join(physicalRoot, 'mock-device-requests');
  const directory = join(parent, 'requests');
  const rel = relative(physicalRoot, directory);
  if (!rel || rel === '..' || rel.startsWith('..' + sep)) throw new Error('mock device request storage escaped the test universe');
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentInfo = lstatSync(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() || (parentInfo.mode & 0o077) !== 0) {
      throw new Error('mock device request storage must be a private directory inside the test universe');
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error('cannot create mock device request storage: ' + (error instanceof Error ? error.message : String(error)));
  }
  for (const path of [parent, directory]) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) {
      throw new Error('mock device request storage must be a private directory inside the test universe');
    }
  }
  return directory;
}

function requestFilePath(directory: string, cellId: string, boundary: string): string {
  const key = createHash('sha256').update(cellId + '\0' + boundary).digest('hex');
  return join(directory, key + '.json');
}

function parseStoredRequest(value: unknown, path: string): MockDeviceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('mock device request is invalid: ' + path);
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.cellId !== 'string' || typeof item.boundary !== 'string'
    || typeof item.nearestDeviceId !== 'string' || typeof item.requestedAt !== 'string') {
    throw new Error('mock device request is invalid: ' + path);
  }
  return {
    id: item.id,
    cellId: item.cellId,
    boundary: item.boundary,
    nearestDeviceId: item.nearestDeviceId,
    requestedAt: item.requestedAt,
  };
}

function readRequest(path: string): MockDeviceRequest {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error('mock device request store must be a private regular file');
  }
  return parseStoredRequest(JSON.parse(readFileSync(path, 'utf8')), path);
}

function readLegacyRequests(directory: string): MockDeviceRequest[] {
  const path = join(dirname(directory), 'requests.json');
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
      throw new Error('legacy mock device request store must be a private regular file');
    }
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(value)) throw new Error('legacy mock device request store must be an array');
    return value.map((row, index) => parseStoredRequest(row, path + '[' + index + ']'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function requestKey(row: Pick<MockDeviceRequest, 'cellId' | 'boundary'>): string {
  return row.cellId + '\0' + row.boundary;
}

function readRequests(directory: string): MockDeviceRequest[] {
  const rows = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readRequest(join(directory, name)));
  const byKey = new Map(rows.map((row) => [requestKey(row), row]));
  // Keep requests.json as a durable migration source. Each legacy row is atomically
  // published to its keyed file; interrupted migrations safely retry on the next read.
  for (const legacy of readLegacyRequests(directory)) {
    const key = requestKey(legacy);
    if (!byKey.has(key)) byKey.set(key, writeRequest(directory, legacy));
  }
  return [...byKey.values()];
}

function writeRequest(directory: string, row: MockDeviceRequest): MockDeviceRequest {
  const target = requestFilePath(directory, row.cellId, row.boundary);
  const temporary = join(directory, '.' + process.pid + '.' + randomUUID() + '.tmp');
  try {
    writeFileSync(temporary, JSON.stringify(row) + '\n', { mode: 0o600, flag: 'wx' });
    try {
      // linkSync publishes the complete private file atomically and refuses to replace
      // a concurrent request with the same cell/boundary key.
      linkSync(temporary, target);
      return row;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readRequest(target);
      throw error;
    }
  } catch (error) {
    throw new Error('cannot write mock device request store: ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
  }
}

export function requestMockDevice(
  input: { cellId: string; boundary: string; nearestDeviceId: string },
  options: { catalog?: MockScenarioCatalog; now?: () => Date } = {},
): MockDeviceRequestView {
  const cellId = input.cellId.trim();
  const boundary = input.boundary.trim();
  const nearestDeviceId = input.nearestDeviceId.trim();
  if (!CELL_ID.test(cellId)) throw new MockDeviceRequestInputError('cell id must use uppercase letters, digits, or hyphens');
  if (!boundary || boundary.length > MAX_BOUNDARY_LENGTH) {
    throw new MockDeviceRequestInputError('boundary must be 1–' + MAX_BOUNDARY_LENGTH + ' characters');
  }
  const catalog = options.catalog ?? loadMockScenarioCatalog();
  if (!catalog.devices.some((device) => device.id === nearestDeviceId)) {
    throw new MockDeviceRequestInputError('unknown nearest mock device: ' + nearestDeviceId);
  }
  const directory = requestDirectoryPath();
  const duplicate = readRequests(directory).find((row) => row.cellId === cellId && row.boundary === boundary);
  if (duplicate) return resolveRequests([duplicate], catalog)[0]!;
  const row: MockDeviceRequest = {
    id: randomUUID(), cellId, boundary, nearestDeviceId,
    requestedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  return resolveRequests([writeRequest(directory, row)], catalog)[0]!;
}

export function listMockDeviceRequests(options: { catalog?: MockScenarioCatalog } = {}): MockDeviceRequestView[] {
  const catalog = options.catalog ?? loadMockScenarioCatalog();
  return resolveRequests(readRequests(requestDirectoryPath()), catalog);
}

function resolveRequests(rows: MockDeviceRequest[], catalog: MockScenarioCatalog): MockDeviceRequestView[] {
  return rows.map((row) => {
    const device = catalog.devices.find((entry) => entry.checklistCells?.includes(row.cellId));
    return device
      ? { ...row, state: 'resolved', resolvedBy: device.id }
      : { ...row, state: 'missing' };
  });
}

export function renderMockDeviceRequests(rows: MockDeviceRequestView[]): string {
  return JSON.stringify({
    missing: rows.filter((row) => row.state === 'missing'),
    resolved: rows.filter((row) => row.state === 'resolved'),
  }, null, 2);
}
