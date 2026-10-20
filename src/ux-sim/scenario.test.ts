import { expect, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { parseScenarioV0, resolveScenarioFilePath, runScenarioFile, runScenarioV0 } from './scenario.js';

async function withTestState<T>(run: () => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'ux-sim-test-state-'));
  const previous = getTestStateRoot();
  setTestStateRoot(root);
  try {
    return await run();
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}

test('YAML scenario runs the real Codex 400 path, compares widget plus stored log event, and persists seeded evidence', async () => {
  const result = await withTestState(async () => {
    const run = await runScenarioFile('scenarios/ux-sim/provider-4xx-no-provider.yaml');
    const artifact = JSON.parse(readFileSync(run.evidenceArtifact, 'utf8')) as Record<string, unknown>;
    expect(artifact).toMatchObject({ id: run.id, seed: 28736, pass: true });
    expect(JSON.stringify(artifact)).not.toContain('scenario-fake-token');
    expect(JSON.stringify(artifact)).not.toContain('scenario test input');
    return run;
  });
  expect(result.pass).toBe(true);
  expect(result.seed).toBe(28736);
  expect(result.evidenceArtifact).toContain('/ux-sim/evidence/codex-request-rejected-shape-400-seed-28736.json');
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

test('registered fetch network-error trigger passes with an explicit zero-event expectation', async () => {
  const scenario = parseScenarioV0(readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
  scenario.triggers[0].type = 'codex.responses.fetch-network-error';
  delete scenario.triggers[0].status;
  scenario.expect.logs[0].count = 0;
  scenario.expect.screen.snapshot.contains = ['scenario network error seed=28736'];
  const result = await withTestState(() => runScenarioV0(scenario));
  expect(result.trigger.fetchCount).toBe(2);
  expect(result.screen.pass).toBe(true);
  expect(result.logs).toMatchObject({ pass: true, expectedCount: 0, observedCount: 0 });
  expect(result.pass).toBe(true);
});

test('network-error artifact omits the inapplicable HTTP status', async () => {
  const scenario = parseScenarioV0(readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
  scenario.triggers[0].type = 'codex.responses.fetch-network-error';
  delete scenario.triggers[0].status;
  const artifactText = await withTestState(async () => {
    const result = await runScenarioV0(scenario);
    return readFileSync(result.evidenceArtifact, 'utf8');
  });
  expect(JSON.parse(artifactText).trigger).not.toHaveProperty('status');
});

test('network-error trigger schema has no HTTP status field', () => {
  const source = readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8')
    .replace('type: codex.responses.fetch', 'type: codex.responses.fetch-network-error')
    .replace('    status: 400\n', '');
  expect(parseScenarioV0(source).triggers[0]).toEqual({ id: 'codex-400', type: 'codex.responses.fetch-network-error', count: 2 });
});

test('failed scenario artifact redacts free-form expectation strings', async () => {
  const scenario = parseScenarioV0(readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
  scenario.expect.logs[0].level = 'scenario-fake-token';
  const artifactText = await withTestState(async () => {
    const run = await runScenarioV0(scenario);
    expect(run.pass).toBe(false);
    return readFileSync(run.evidenceArtifact, 'utf8');
  });
  expect(artifactText).not.toContain('scenario-fake-token');
  expect(artifactText).not.toContain('llm.codex');
  expect(artifactText).not.toContain('"category"');
  expect(artifactText).not.toContain('"event"');
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
  const unregistered = `version: 0\nid: bad-trigger\nisolation: test\nseed: 1\ntriggers:\n  - id: x\n    type: shell.exec\n    status: 400\nexpect: {}`;
  expect(() => parseScenarioV0(unregistered)).toThrow('unregistered scenario trigger');
  const missingTrigger = `version: 0\nid: no-trigger\nisolation: test\nseed: 1\ntriggers: []\nexpect: {}`;
  expect(() => parseScenarioV0(missingTrigger)).toThrow('exactly one registered trigger');
});

test('scenario parser admits only the two registered in-process Codex trigger types and requires a fixed seed', () => {
  const source = readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8');
  expect(parseScenarioV0(source).triggers[0].type).toBe('codex.responses.fetch');
  expect(() => parseScenarioV0(source.replace('seed: 28736', 'seed: -1'))).toThrow('unsigned 32-bit integer');
  expect(() => parseScenarioV0(source.replace('codex.responses.fetch', 'shell.exec'))).toThrow('unregistered scenario trigger');
  expect(() => parseScenarioV0(source.replace('count: 1\n      data:', 'count: 0\n      data:'))).toThrow('zero expected log events are allowed only');
});

test('runner requires isolated test mode and scenario paths stay under scenarios/', async () => {
  await expect(runScenarioFile('scenarios/ux-sim/provider-4xx-no-provider.yaml')).rejects.toThrow('--test');
  await withTestState(async () => {
    await expect(runScenarioFile('../secrets.yaml')).rejects.toThrow('inside the repository scenarios/');
  });
});

test('runner rejects a scenario symlink that resolves outside scenarios/', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'ux-sim-symlink-'));
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
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'ux-sim-scenarios-root-symlink-'));
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

test('artifact writer refuses a symlinked evidence directory', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'ux-sim-evidence-link-'));
  const outside = join(root, 'outside');
  mkdirSync(outside);
  const previous = getTestStateRoot();
  setTestStateRoot(root);
  try {
    symlinkSync(outside, join(root, 'ux-sim'));
    const scenario = parseScenarioV0(readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
    await expect(runScenarioV0(scenario)).rejects.toThrow('cannot contain symlinks');
    expect(() => readFileSync(join(outside, 'evidence', `${scenario.id}-seed-${scenario.seed}.json`), 'utf8')).toThrow();
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact writer rejects a symlinked test-state ancestor before creating directories', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'ux-sim-evidence-ancestor-'));
  const outside = join(root, 'outside');
  const linkedRoot = join(root, 'linked-state');
  mkdirSync(outside);
  symlinkSync(outside, linkedRoot);
  const previous = getTestStateRoot();
  setTestStateRoot(linkedRoot);
  const scenario = parseScenarioV0(readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
  try {
    await expect(runScenarioV0(scenario)).rejects.toThrow('cannot contain symlinks');
    expect(() => readFileSync(join(outside, 'ux-sim', 'evidence', `${scenario.id}-seed-${scenario.seed}.json`), 'utf8')).toThrow();
    expect(existsSync(join(outside, 'ux-sim'))).toBe(false);
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact writer atomically replaces a pre-existing evidence-file symlink without following it', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'ux-sim-evidence-file-link-'));
  const stateRoot = join(root, 'state');
  const outside = join(root, 'outside.json');
  mkdirSync(join(stateRoot, 'ux-sim', 'evidence'), { recursive: true });
  writeFileSync(outside, 'preserve-me');
  const previous = getTestStateRoot();
  setTestStateRoot(stateRoot);
  const scenario = parseScenarioV0(readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
  const artifact = join(stateRoot, 'ux-sim', 'evidence', `${scenario.id}-seed-${scenario.seed}.json`);
  try {
    symlinkSync(outside, artifact);
    await runScenarioV0(scenario);
    expect(readFileSync(outside, 'utf8')).toBe('preserve-me');
    expect(JSON.parse(readFileSync(artifact, 'utf8'))).toMatchObject({ id: scenario.id, seed: scenario.seed, pass: true });
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact update atomically replaces a hardlink without modifying its external target', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'ux-sim-evidence-hardlink-'));
  const stateRoot = join(root, 'state');
  const outside = join(root, 'outside.json');
  mkdirSync(join(stateRoot, 'ux-sim', 'evidence'), { recursive: true });
  writeFileSync(outside, 'preserve-me');
  const previous = getTestStateRoot();
  setTestStateRoot(stateRoot);
  const scenario = parseScenarioV0(readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
  const artifact = join(stateRoot, 'ux-sim', 'evidence', `${scenario.id}-seed-${scenario.seed}.json`);
  try {
    linkSync(outside, artifact);
    await runScenarioV0(scenario);
    expect(readFileSync(outside, 'utf8')).toBe('preserve-me');
    expect(JSON.parse(readFileSync(artifact, 'utf8'))).toMatchObject({ id: scenario.id, seed: scenario.seed, pass: true });
  } finally {
    setTestStateRoot(previous ?? null);
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
