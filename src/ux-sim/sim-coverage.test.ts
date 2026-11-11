import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { listMockDeviceRequests } from './mock-device-requests.js';
import { compareLlmCassetteRecording } from './device-fidelity.js';
import { loadMockScenarioCatalog } from './mock-scenario-catalog.js';
import { readSimCoverage, recordSimWorldCoverage } from './sim-coverage.js';

const scenarioFile = join(tmpdir(), 'external scenario.yaml');

test('world coverage records private per-run paths, events and device fingerprints in --test state', () => {
  const previous = getTestStateRoot();
  const root = mkdtempSync(join(tmpdir(), 'sim-coverage-'));
  try {
    setTestStateRoot(root);
    expect(readSimCoverage().runCount).toBe(0);
    expect(listMockDeviceRequests().length).toBeGreaterThan(0);

    const result = recordSimWorldCoverage({
      world: {
        id: 'night-train',
        spec: { devices: ['fake-clock', 'fake-gh'], events: [{ at: '+5m', id: 'dead-pid-lock' }, { at: '+9m', id: 'host-reboot' }] },
      },
      deviceIds: ['fake-clock', 'fake-kubectl:gcp2', 'scenario-runner'],
      pass: false,
      scenarioFile,
      observations: [{ event: 'live-pid-lock', verdict: 'already-running' }, { event: 'dead-pid-lock', verdict: 'ready' }],
      now: () => new Date('2026-11-05T00:00:00.000Z'),
    });

    expect(result.receipt.worldId).toBe('night-train');
    expect(result.receipt.scenarioId).toBe('external_scenario.yaml');
    expect(result.receipt.pass).toBe(false);
    expect(result.receipt.eventKinds).toEqual(['dead-pid-lock', 'live-pid-lock']);
    expect(result.receipt.eventIds).toEqual(['EV-0042']);
    expect(result.receipt.devices.some((device) => device.id === 'fake-clock')).toBe(true);
    expect(result.receipt.devices.some((device) => device.id === 'fake-kubectl')).toBe(true);
    expect(result.receipt.devices.some((device) => device.id === 'fake-github')).toBe(false);
    expect(result.receipt.devices.some((device) => device.id === 'world-runtime')).toBe(false);
    expect(result.receipt.codePaths).toContain('src/ux-sim/fake-clock.ts');
    expect(result.receipt.codePaths).toContain('src/ux-sim/mock-scenario-catalog.ts');
    expect(result.receipt.codePaths).not.toContain('src/cli/sim-cli.ts');
    expect(result.receipt.codePathCoveragePercent).toBeGreaterThan(0);
    expect(result.report.runCount).toBe(1);
    expect(result.report.codePathCoverage.percent).toBe(result.receipt.codePathCoveragePercent);

    const runs = join(root, 'sim/coverage/runs');
    const receiptPath = join(runs, readdirSync(runs)[0]!);
    expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(receiptPath, 'utf8')).runId).toBe(result.receipt.runId);
    expect(statSync(runs).mode & 0o777).toBe(0o700);
    expect(readSimCoverage().runCount).toBe(1);
    const catalog = loadMockScenarioCatalog();
    const reducedCatalog = { ...catalog, sourceModules: catalog.sourceModules.filter((module) => module.path !== 'src/ux-sim/fake-clock.ts') };
    expect(readSimCoverage({ catalog: reducedCatalog }).codePathCoverage.percent).toBeLessThanOrEqual(100);
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
});

test('an E4.5 mismatch retroactively yellows only green receipts that used its cassette', () => {
  const previous = getTestStateRoot();
  const root = mkdtempSync(join(tmpdir(), 'sim-coverage-cassette-'));
  try {
    setTestStateRoot(root);
    const cassetteId = 'c'.repeat(64); // Source: SHA-256 cassette request key shape.
    recordSimWorldCoverage({
      world: { id: 'llm-cassette-world', spec: { devices: ['fake-llm'], events: [] } },
      deviceIds: ['fake-llm'], pass: true, verdict: 'green', recordingIds: [cassetteId], scenarioFile,
      observations: [{ event: 'llm-response', verdict: 'replayed' }],
    });
    compareLlmCassetteRecording(cassetteId, [{ type: 'text', delta: 'saved' }], [{ type: 'text', delta: 'drifted' }]);
    const report = readSimCoverage();
    expect(report.receipts).toHaveLength(1);
    expect(report.receipts[0]).toMatchObject({ pass: false, verdict: 'yellow', recordingIds: [cassetteId] });
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed uncovered-path request does not persist a successful world receipt', () => {
  const previous = getTestStateRoot();
  const root = mkdtempSync(join(tmpdir(), 'sim-coverage-request-failure-'));
  try {
    setTestStateRoot(root);
    const catalog = loadMockScenarioCatalog();
    const result = () => recordSimWorldCoverage({
      world: { id: 'request-failure', spec: { devices: [], events: [] } },
      deviceIds: ['fake-clock'],
      pass: true,
      scenarioFile,
      observations: [],
      catalog: {
        ...catalog,
        sourceModules: [{
          id: 'missing-owner-module', path: 'src/ux-sim/mock-scenario-catalog.ts',
          boundary: 'test failure path', deviceIds: ['missing-device'],
          integrityCertificatePresent: false, integrityCertificatePath: null,
        }],
      },
    });

    expect(result).toThrow('unknown nearest mock device: missing-device');
    expect(readdirSync(join(root, 'sim/coverage/runs'))).toEqual([]);
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
});

test('device fingerprint changes when a catalog implementation path omitted from sourceModules changes', () => {
  const previous = getTestStateRoot();
  const stateRoot = mkdtempSync(join(tmpdir(), 'sim-coverage-fingerprint-state-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'sim-coverage-fingerprint-repo-'));
  try {
    setTestStateRoot(stateRoot);
    mkdirSync(join(repoRoot, 'src/ux-sim'), { recursive: true });
    mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
    writeFileSync(join(repoRoot, 'src/ux-sim/mock-scenario-catalog.ts'), 'export const version = 1;\n');
    const omittedImplementationPath = join(repoRoot, 'scripts/ux-sim.ts');
    writeFileSync(omittedImplementationPath, 'export const version = 1;\n');

    const catalog = loadMockScenarioCatalog();
    const scenarioRunner = catalog.devices.find((device) => device.id === 'scenario-runner')!;
    const fixtureCatalog = {
      ...catalog,
      devices: catalog.devices.map((device) => device.id === scenarioRunner.id
        ? { ...device, implementation: ['src/ux-sim/mock-scenario-catalog.ts', 'scripts/ux-sim.ts'] }
        : device),
      sourceModules: [{
        id: 'scenario-runner-catalog', path: 'src/ux-sim/mock-scenario-catalog.ts',
        boundary: 'coverage fixture', deviceIds: [scenarioRunner.id],
        integrityCertificatePresent: false, integrityCertificatePath: null,
      }],
    };
    const input = {
      world: { id: 'fingerprint-change', spec: { devices: [], events: [] } },
      deviceIds: [scenarioRunner.id], pass: true, scenarioFile, observations: [], repoRoot, catalog: fixtureCatalog,
    };
    const before = recordSimWorldCoverage(input).receipt.devices[0]!.fingerprint;
    writeFileSync(omittedImplementationPath, 'export const version = 2;\n');
    const after = recordSimWorldCoverage(input).receipt.devices[0]!.fingerprint;

    expect(after).not.toBe(before);
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
