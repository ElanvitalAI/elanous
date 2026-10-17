import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { parseScenarioV0, resolveScenarioFilePath, runScenarioFile, runScenarioV0 } from './scenario.js';

async function withTestState<T>(run: () => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-test-state-'));
  const previous = getTestStateRoot();
  setTestStateRoot(root);
  try {
    return await run();
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}

test('YAML scenario runs the real Codex 400 path and compares widget plus stored log event', async () => {
  const result = await withTestState(() => runScenarioFile('scenarios/ux-sim/provider-4xx-no-provider.yaml'));
  expect(result.pass).toBe(true);
  expect(result.trigger).toMatchObject({ id: 'codex-400', type: 'codex.responses.fetch', status: 400, expectedCount: 2, fetchCount: 2 });
  expect(result.screen).toMatchObject({ pass: true, containsMissing: [], excludesFound: [] });
  expect(result.logs).toMatchObject({ pass: true, category: 'llm.codex', event: 'request-rejected-shape', expectedCount: 1, observedCount: 1, matchedData: { status: 400 }, dataMismatch: [] });
  expect(result.logs.evidenceLine).toContain('"status":400');
});

test('a triggered 401 with no shape event is reported as an observed event absence, never PASS', async () => {
  const source = readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8');
  const scenario = parseScenarioV0(source);
  scenario.triggers[0].status = 401;
  scenario.expect.screen.snapshot.contains = ['Codex API 401'];
  const result = await withTestState(() => runScenarioV0(scenario));
  expect(result.pass).toBe(false);
  expect(result.trigger.error).toContain('Codex API 401');
  expect(result.logs.observedCount).toBe(0);
  expect(result.failureReasons).toContain('expected-log-event-absent');
});

test('a log level mismatch fails the scenario comparison', async () => {
  const scenario = parseScenarioV0(readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
  scenario.expect.logs[0].level = 'error';
  const result = await withTestState(() => runScenarioV0(scenario));
  expect(result.pass).toBe(false);
  expect(result.logs.level).toBe('debug');
  expect(result.logs.expectedLevel).toBe('error');
  expect(result.logs.levelMismatch).toBe(true);
  expect(result.failureReasons).toContain('log-level-mismatch:expected-error-observed-debug');
});

test('a trigger call-count mismatch fails the scenario comparison', async () => {
  const scenario = parseScenarioV0(readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
  scenario.triggers[0].count = 1;
  const result = await withTestState(() => runScenarioV0(scenario));
  expect(result.pass).toBe(false);
  expect(result.trigger.fetchCount).toBe(2);
  expect(result.failureReasons).toContain('trigger-count-mismatch:expected-1-observed-2');
});

test('scenario parser rejects an unregistered trigger and missing expectations', () => {
  const unregistered = `version: 0\nid: bad-trigger\nisolation: test\ntriggers:\n  - id: x\n    type: shell.exec\n    status: 400\nexpect: {}`;
  expect(() => parseScenarioV0(unregistered)).toThrow('unregistered scenario trigger');
  const missingTrigger = `version: 0\nid: no-trigger\nisolation: test\ntriggers: []\nexpect: {}`;
  expect(() => parseScenarioV0(missingTrigger)).toThrow('exactly one registered trigger');
});

test('runner requires isolated test mode and scenario paths stay under scenarios/', async () => {
  await expect(runScenarioFile('scenarios/ux-sim/provider-4xx-no-provider.yaml')).rejects.toThrow('--test');
  await withTestState(async () => {
    await expect(runScenarioFile('../secrets.yaml')).rejects.toThrow('inside the repository scenarios/');
  });
});

test('runner rejects a scenario symlink that resolves outside scenarios/', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-symlink-'));
  try {
    mkdirSync(join(root, 'scenarios'));
    const outside = join(root, 'outside.yaml');
    writeFileSync(outside, readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
    symlinkSync(outside, join(root, 'scenarios', 'escape.yaml'));
    expect(() => resolveScenarioFilePath('scenarios/escape.yaml', root)).toThrow('inside the repository scenarios/');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner rejects a scenarios/ directory symlink that resolves outside the repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-scenarios-root-symlink-'));
  try {
    const repository = join(root, 'repo');
    const outside = join(root, 'outside');
    mkdirSync(repository);
    mkdirSync(outside);
    writeFileSync(join(outside, 'scenario.yaml'), readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
    symlinkSync(outside, join(repository, 'scenarios'), 'dir');
    expect(() => resolveScenarioFilePath('scenarios/scenario.yaml', repository)).toThrow('inside the repository scenarios/');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('public runner enforces test mode and revalidates its registered trigger schema', async () => {
  const scenario = parseScenarioV0(readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
  await expect(runScenarioV0(scenario)).rejects.toThrow('--test');
  const unregistered = { ...scenario, triggers: [{ ...scenario.triggers[0], type: 'shell.exec' }] } as unknown as typeof scenario;
  await withTestState(async () => {
    await expect(runScenarioV0(unregistered)).rejects.toThrow('unregistered scenario trigger');
  });
});
