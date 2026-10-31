import { expect, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { LogStore } from '../mss/logging/log-store.js';
import { parseScenarioV0, resolveScenarioFilePath, runScenarioFile, runScenarioV0, writeScenarioEvidenceArtifact } from './scenario.js';

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
    expect(artifact).toMatchObject({ id: run.id, runId: run.runId, seed: 28736, pass: true, runEvidence: { runId: run.runId, persisted: true } });
    expect(run.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.runEvidence).toEqual({ category: 'ux.sim.scenario', event: 'completed', persisted: true });
    const store = new LogStore(join(getTestStateRoot()!, 'logs', 'logs.db'), { readonly: true });
    try {
      const linked = store.queryByDataKeys({ exactCategories: ['ux.sim.scenario'], runIds: [run.runId] }).filter((row) => row.event === 'completed');
      expect(linked).toHaveLength(1);
      expect(JSON.parse(linked[0]!.data!)).toMatchObject({ runId: run.runId, scenarioId: run.id, deviceVerdict: 'PASS' });
      const codexRows = store.query({ exactCategories: ['llm.codex'], events: ['request-rejected-shape'], instances: [`ux-sim:${run.id}:${run.runId}`], limit: 10 });
      expect(codexRows).toHaveLength(1);
      expect(JSON.parse(codexRows[0]!.data!)).not.toHaveProperty('runId');
    } finally { store.close(); }
    expect(JSON.stringify(artifact)).not.toContain('scenario-fake-token');
    expect(JSON.stringify(artifact)).not.toContain('scenario test input');
    return run;
  });
  expect(result.pass).toBe(true);
  expect(result.seed).toBe(28736);
  expect(result.evidenceArtifact).toMatch(/\/ux-sim\/evidence\/codex-request-rejected-shape-400-seed-28736-run-[0-9a-f-]{36}\.json$/);
  expect(result.trigger).toMatchObject({ id: 'codex-400', type: 'codex.responses.fetch', status: 400, expectedCount: 2, fetchCount: 2 });
  expect(result.screen).toMatchObject({ pass: true, containsMissing: [], excludesFound: [] });
  expect(result.logs).toMatchObject({ pass: true, category: 'llm.codex', event: 'request-rejected-shape', expectedCount: 1, observedCount: 1, matchedData: { status: 400 }, dataMismatch: [] });
  expect(result.logs.evidenceLine).toContain('"status":400');
});

test('UX-MS-09 scenario evaluates real draft triage and persists runId-scoped completion evidence', async () => {
  await withTestState(async () => {
    const run = await runScenarioFile('scenarios/ux-sim/draft-inventory-200.yaml');
    expect(run.pass).toBe(true);
    expect(run.trigger).toMatchObject({ id: 'draft-inventory-200', type: 'ux.draft-inventory.evaluate', expectedCount: 1, fetchCount: 1 });
    expect(run.screen).toMatchObject({ pass: true, containsMissing: [], excludesFound: [] });
    expect(run.logs).toMatchObject({ pass: true, category: 'ux.sim.draft-inventory', event: 'assessed', observedCount: 1, dataMismatch: [] });
    const store = new LogStore(join(getTestStateRoot()!, 'logs', 'logs.db'), { readonly: true });
    try {
      const assessed = store.queryByDataKeys({ exactCategories: ['ux.sim.draft-inventory'], runIds: [run.runId] }).filter((row) => row.event === 'assessed');
      const completed = store.queryByDataKeys({ exactCategories: ['ux.sim.scenario'], runIds: [run.runId] }).filter((row) => row.event === 'completed');
      expect(assessed).toHaveLength(1);
      expect(JSON.parse(assessed[0]!.data!)).toMatchObject({
        runId: run.runId,
        total: 200,
        byScenario: { 'merged-twin': 25, 'duplicate-open': 25, 'harvest-reference': 25, 'all-files-landed': 25, 'protected-label': 25, running: 25, stale: 25, harvestable: 25 },
        byAction: { close: 125, keep: 75 },
        triageByAction: { 'close-a': 0, 'close-b': 75, 'close-c': 25, harvest: 25, human: 75 },
        mismatchCount: 0,
        protectedOrRunningClosed: 0,
      });
      expect(completed).toHaveLength(1);
      expect(JSON.parse(completed[0]!.data!)).toMatchObject({ runId: run.runId, scenarioId: 'ux-draft-inventory-200', deviceVerdict: 'PASS' });
      expect(readFileSync(run.evidenceArtifact, 'utf8')).toContain(run.runId);
    } finally { store.close(); }
  });
});

test('repeated ScenarioV0 runs keep distinct evidence artifacts and correlated logs rows', async () => {
  await withTestState(async () => {
    const first = await runScenarioFile('scenarios/ux-sim/provider-4xx-no-provider.yaml');
    const second = await runScenarioFile('scenarios/ux-sim/provider-4xx-no-provider.yaml');

    expect(first.pass).toBe(true);
    expect(second.pass).toBe(true);
    expect(first.runId).not.toBe(second.runId);
    expect(first.evidenceArtifact).not.toBe(second.evidenceArtifact);
    expect(existsSync(first.evidenceArtifact)).toBe(true);
    expect(existsSync(second.evidenceArtifact)).toBe(true);
    const store = new LogStore(join(getTestStateRoot()!, 'logs', 'logs.db'), { readonly: true });
    try {
      for (const run of [first, second]) {
        const linked = store.queryByDataKeys({ exactCategories: ['ux.sim.scenario'], runIds: [run.runId] }).filter((row) => row.event === 'completed');
        expect(linked).toHaveLength(1);
        expect(JSON.parse(readFileSync(run.evidenceArtifact, 'utf8'))).toMatchObject({ runId: run.runId, runEvidence: { runId: run.runId, persisted: true } });
        const persistedRows = store.query({ instances: [`ux-sim:${run.id}:${run.runId}`], limit: 100 });
        const persistedCategories = persistedRows.map((row) => row.category).sort();
        expect(persistedCategories).toEqual([run.logs.category, 'ux.sim.scenario'].sort());
        expect(JSON.stringify(persistedRows)).not.toContain('scenario-fake-token');
        expect(JSON.stringify(persistedRows)).not.toContain('scenario test request');
        expect(JSON.stringify(persistedRows)).not.toContain(`scenario test input seed=${run.seed}`);
      }
    } finally { store.close(); }
  });
});

test('scenario parser rejects the reserved completion event as an expectation', () => {
  const base = parseScenarioV0(readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
  const scenario = {
    ...base,
    expect: { ...base.expect, logs: [{ category: 'ux.sim.scenario', event: 'completed', level: 'debug' }] },
  };
  expect(() => parseScenarioV0(JSON.stringify(scenario))).toThrow('reserved event ux.sim.scenario/completed');
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

test('scenario parser rejects log payload fields outside the persistence allowlist', () => {
  const scenario = parseScenarioV0(readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
  const expanded = {
    ...scenario,
    expect: { ...scenario.expect, logs: [{ ...scenario.expect.logs[0]!, data: { status: 400, prompt: 'secret' } }] },
  };
  expect(() => parseScenarioV0(JSON.stringify(expanded))).toThrow('cannot include sensitive field: prompt');
});

test('ScenarioV0 keeps arbitrary event data and empty data expectations backward compatible', () => {
  const base = parseScenarioV0(readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
  const generic = {
    ...base,
    expect: { ...base.expect, logs: [{ category: 'legacy.category', event: 'legacy-event', level: 'info', data: { code: 17, detail: { retryable: false } } }] },
  };
  expect(parseScenarioV0(JSON.stringify(generic)).expect.logs[0]).toMatchObject({ data: { code: 17, detail: { retryable: false } } });

  const emptyCodexData = {
    ...base,
    expect: { ...base.expect, logs: [{ ...base.expect.logs[0]!, data: {} }] },
  };
  expect(parseScenarioV0(JSON.stringify(emptyCodexData)).expect.logs[0]!.data).toEqual({});
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
    expect(existsSync(join(outside, 'evidence'))).toBe(false);
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner rejects a symlinked test-state root before creating logs or evidence', async () => {
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
    expect(existsSync(join(outside, 'logs', 'logs.db'))).toBe(false);
    expect(existsSync(join(outside, 'ux-sim'))).toBe(false);
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner rejects a symlinked logs directory before opening logs.db', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'ux-sim-logs-dir-link-'));
  const outside = join(root, 'outside');
  const stateRoot = join(root, 'state');
  mkdirSync(outside);
  mkdirSync(stateRoot);
  symlinkSync(outside, join(stateRoot, 'logs'), 'dir');
  const previous = getTestStateRoot();
  setTestStateRoot(stateRoot);
  const scenario = parseScenarioV0(readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
  try {
    await expect(runScenarioV0(scenario)).rejects.toThrow('cannot contain symlinks');
    expect(existsSync(join(outside, 'logs.db'))).toBe(false);
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner rejects a symlinked logs.db before opening the target', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'ux-sim-logs-file-link-'));
  const outside = join(root, 'outside.db');
  const stateRoot = join(root, 'state');
  mkdirSync(join(stateRoot, 'logs'), { recursive: true });
  writeFileSync(outside, 'preserve-me');
  symlinkSync(outside, join(stateRoot, 'logs', 'logs.db'));
  const previous = getTestStateRoot();
  setTestStateRoot(stateRoot);
  const scenario = parseScenarioV0(readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
  try {
    await expect(runScenarioV0(scenario)).rejects.toThrow('cannot contain symlinks');
    expect(readFileSync(outside, 'utf8')).toBe('preserve-me');
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner rejects a hardlinked logs.db before modifying its external target', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'ux-sim-logs-hardlink-'));
  const outside = join(root, 'outside.db');
  const stateRoot = join(root, 'state');
  mkdirSync(join(stateRoot, 'logs'), { recursive: true });
  writeFileSync(outside, 'preserve-me');
  linkSync(outside, join(stateRoot, 'logs', 'logs.db'));
  const previous = getTestStateRoot();
  setTestStateRoot(stateRoot);
  const scenario = parseScenarioV0(readFileSync('scenarios/ux-sim/provider-4xx-no-provider.yaml', 'utf8'));
  try {
    await expect(runScenarioV0(scenario)).rejects.toThrow('must not be a hardlink');
    expect(readFileSync(outside, 'utf8')).toBe('preserve-me');
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
  const artifact = join(stateRoot, 'ux-sim', 'evidence', `${scenario.id}-seed-${scenario.seed}-run-test.json`);
  try {
    symlinkSync(outside, artifact);
    writeScenarioEvidenceArtifact(join(stateRoot, 'ux-sim', 'evidence'), artifact, { id: scenario.id, seed: scenario.seed, pass: true });
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
  const artifact = join(stateRoot, 'ux-sim', 'evidence', `${scenario.id}-seed-${scenario.seed}-run-test.json`);
  try {
    linkSync(outside, artifact);
    writeScenarioEvidenceArtifact(join(stateRoot, 'ux-sim', 'evidence'), artifact, { id: scenario.id, seed: scenario.seed, pass: true });
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
