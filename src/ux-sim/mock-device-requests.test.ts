import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { loadMockScenarioCatalog, type MockScenarioCatalog } from './mock-scenario-catalog.js';
import { listMockDeviceRequests, requestMockDevice } from './mock-device-requests.js';

const roots: string[] = [];
let priorRoot: string | null | undefined;

beforeEach(() => {
  priorRoot = getTestStateRoot();
});

afterEach(() => {
  setTestStateRoot(priorRoot ?? null);
  priorRoot = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sim-device-requests-'));
  roots.push(root);
  setTestStateRoot(root);
  return root;
}

test('records one isolated request, lists it as missing, then resolves it from catalog coverage', () => {
  setTemporaryRoot();
  const catalog = loadMockScenarioCatalog();
  const request = requestMockDevice({
    cellId: 'SIM-DEVICE-REQUEST-NEXUS',
    boundary: 'request registry persistence and missing-list route',
    nearestDeviceId: catalog.devices[0]!.id,
  }, { catalog, now: () => new Date('2026-11-03T00:00:00.000Z') });
  expect(request).toMatchObject({ state: 'missing', cellId: 'SIM-DEVICE-REQUEST-NEXUS', requestedAt: '2026-11-03T00:00:00.000Z' });
  expect(listMockDeviceRequests({ catalog })).toEqual([request]);
  const duplicate = requestMockDevice({
    cellId: 'SIM-DEVICE-REQUEST-NEXUS',
    boundary: 'request registry persistence and missing-list route',
    nearestDeviceId: catalog.devices[0]!.id,
  }, { catalog });
  expect(duplicate).toEqual(request);

  const expanded = structuredClone(catalog) as MockScenarioCatalog;
  expanded.devices[0]!.checklistCells = ['SIM-DEVICE-REQUEST-NEXUS'];
  expect(listMockDeviceRequests({ catalog: expanded })).toEqual([{ ...request, state: 'resolved', resolvedBy: catalog.devices[0]!.id }]);
});

test('migrates and preserves legacy requests.json while keeping the source intact', () => {
  const root = setTemporaryRoot();
  const catalog = loadMockScenarioCatalog();
  const legacyDir = join(root, 'mock-device-requests');
  const legacyPath = join(legacyDir, 'requests.json');
  const legacyRow = {
    id: 'legacy-request-1',
    cellId: 'LEGACY-DEVICE-REQUEST',
    boundary: 'preserve unresolved backlog during the per-request store upgrade',
    nearestDeviceId: catalog.devices[0]!.id,
    requestedAt: '2026-11-02T01:02:03.000Z',
  };
  mkdirSync(legacyDir, { mode: 0o700 });
  writeFileSync(legacyPath, JSON.stringify([legacyRow]) + '\n', { mode: 0o600 });
  expect(listMockDeviceRequests({ catalog })).toEqual([{ ...legacyRow, state: 'missing' }]);
  expect(readFileSync(legacyPath, 'utf8')).toBe(JSON.stringify([legacyRow]) + '\n');
  expect(existsSync(join(legacyDir, 'requests', ''))).toBe(true);
  expect(requestMockDevice({
    cellId: legacyRow.cellId,
    boundary: legacyRow.boundary,
    nearestDeviceId: legacyRow.nearestDeviceId,
  }, { catalog })).toEqual({ ...legacyRow, state: 'missing' });
  expect(listMockDeviceRequests({ catalog })).toEqual([{ ...legacyRow, state: 'missing' }]);
});

test('rejects a symlinked request parent before creating the requests directory outside test root', () => {
  const root = setTemporaryRoot();
  const outside = mkdtempSync(join(tmpdir(), 'sim-device-requests-outside-'));
  roots.push(outside);
  symlinkSync(outside, join(root, 'mock-device-requests'));
  expect(() => listMockDeviceRequests()).toThrow('private directory inside the test universe');
  expect(existsSync(join(outside, 'requests'))).toBe(false);
});

test('concurrent processes retain independent mock device requests', async () => {
  const root = setTemporaryRoot();
  const catalog = loadMockScenarioCatalog();
  const pathsUrl = new URL('../nexus/paths.js', import.meta.url).href;
  const requestsUrl = new URL('./mock-device-requests.js', import.meta.url).href;
  const childSource = [
    'import { setTestStateRoot } from ' + JSON.stringify(pathsUrl) + ';',
    'import { requestMockDevice } from ' + JSON.stringify(requestsUrl) + ';',
    'setTestStateRoot(process.env.MOCK_DEVICE_REQUEST_TEST_ROOT);',
    'const row = requestMockDevice({ cellId: "SIM-DEVICE-REQUEST-NEXUS", boundary: process.env.MOCK_DEVICE_REQUEST_BOUNDARY, nearestDeviceId: process.env.MOCK_DEVICE_REQUEST_NEAREST });',
    'console.log(row.id);',
  ].join('\n');
  const boundaries = Array.from({ length: 8 }, (_, index) => 'concurrent boundary ' + index);
  const ids = await Promise.all(boundaries.map(async (boundary) => {
    const child = Bun.spawn([process.execPath, '-e', childSource], {
      env: {
        MOCK_DEVICE_REQUEST_TEST_ROOT: root,
        MOCK_DEVICE_REQUEST_BOUNDARY: boundary,
        MOCK_DEVICE_REQUEST_NEAREST: catalog.devices[0]!.id,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error('mock device request child failed: ' + stderr);
    return stdout.trim();
  }));
  expect(new Set(ids).size).toBe(boundaries.length);
  const rows = listMockDeviceRequests({ catalog });
  expect(rows).toHaveLength(boundaries.length);
  expect(rows.map((row) => row.boundary).sort()).toEqual(boundaries.slice().sort());

  const sameBoundary = 'concurrent duplicate boundary';
  const duplicateIds = await Promise.all(Array.from({ length: 8 }, async () => {
    const child = Bun.spawn([process.execPath, '-e', childSource], {
      env: {
        MOCK_DEVICE_REQUEST_TEST_ROOT: root,
        MOCK_DEVICE_REQUEST_BOUNDARY: sameBoundary,
        MOCK_DEVICE_REQUEST_NEAREST: catalog.devices[0]!.id,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error('mock device duplicate child failed: ' + stderr);
    return stdout.trim();
  }));
  expect(new Set(duplicateIds).size).toBe(1);
  const allRows = listMockDeviceRequests({ catalog });
  expect(allRows).toHaveLength(boundaries.length + 1);
  expect(allRows.filter((row) => row.boundary === sameBoundary)).toHaveLength(1);
});

test('requires test isolation and rejects unknown nearest devices or malformed checklist IDs', () => {
  setTestStateRoot(null);
  expect(() => listMockDeviceRequests()).toThrow('explicit --test universe');
  setTemporaryRoot();
  const catalog = loadMockScenarioCatalog();
  expect(() => requestMockDevice({ cellId: '../secret', boundary: 'x', nearestDeviceId: catalog.devices[0]!.id }, { catalog })).toThrow('cell id');
  expect(() => requestMockDevice({ cellId: 'SIM-MISSING', boundary: 'x', nearestDeviceId: 'not-real' }, { catalog })).toThrow('unknown nearest mock device');
});
