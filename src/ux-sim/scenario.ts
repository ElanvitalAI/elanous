import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { debug } from '../debug/log.js';
import { streamCodexResponsesEvents } from '../llm.js';
import { LogStore, StoreSink, type LogStoreRow } from '../mss/logging/log-store.js';
import { getTestStateRoot } from '../nexus/paths.js';
import { simRenderLogFrame } from './render-frame.js';

export interface ScenarioV0 {
  version: 0;
  id: string;
  isolation: 'test';
  triggers: [{ id: string; type: 'codex.responses.fetch'; status: number; count?: number }];
  expect: {
    screen: { mode: 'widget'; snapshot: { contains: string[]; excludes?: string[] } };
    logs: [{ category: string; event: string; level: string; count?: number; data?: Record<string, unknown> }];
  };
}

export interface ScenarioResult {
  id: string;
  pass: boolean;
  trigger: { id: string; type: string; status: number; expectedCount: number; fetchCount: number; error: string | null };
  screen: { pass: boolean; containsMissing: string[]; excludesFound: string[]; snapshot: string };
  logs: { pass: boolean; category: string; event: string; level: string | null; expectedLevel: string; levelMismatch: boolean; expectedCount: number; observedCount: number; matchedData: Record<string, unknown>; evidenceLine: string; dataMismatch: string[] };
  failureReasons: string[];
}

let previousScenarioTurn: Promise<void> = Promise.resolve();
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${where} has unsupported key(s): ${extra.join(', ')}`);
}

function requiredString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${where} must be a non-empty string`);
  return value;
}

export function parseScenarioV0(source: string): ScenarioV0 {
  const value = record(parseYaml(source), 'scenario');
  exactKeys(value, ['version', 'id', 'isolation', 'triggers', 'expect'], 'scenario');
  if (value.version !== 0) throw new Error('scenario.version must be 0');
  const id = requiredString(value.id, 'scenario.id');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('scenario.id must be lowercase letters, digits, and hyphens');
  if (value.isolation !== 'test') throw new Error('scenario.isolation must be test');

  if (!Array.isArray(value.triggers) || value.triggers.length !== 1) throw new Error('scenario.triggers must contain exactly one registered trigger');
  const trigger = record(value.triggers[0], 'scenario.triggers[0]');
  exactKeys(trigger, ['id', 'type', 'status', 'count'], 'scenario.triggers[0]');
  const triggerId = requiredString(trigger.id, 'scenario.triggers[0].id');
  if (trigger.type !== 'codex.responses.fetch') throw new Error(`unregistered scenario trigger: ${String(trigger.type)}`);
  if (!Number.isInteger(trigger.status) || (trigger.status as number) < 400 || (trigger.status as number) > 499) throw new Error('codex.responses.fetch.status must be an HTTP 4xx status');
  if (trigger.count !== undefined && (!Number.isInteger(trigger.count) || (trigger.count as number) < 1)) throw new Error('codex.responses.fetch.count must be a positive integer');

  const expect = record(value.expect, 'scenario.expect');
  exactKeys(expect, ['screen', 'logs'], 'scenario.expect');
  const screen = record(expect.screen, 'scenario.expect.screen');
  exactKeys(screen, ['mode', 'snapshot'], 'scenario.expect.screen');
  if (screen.mode !== 'widget') throw new Error('scenario.expect.screen.mode must be widget');
  const snapshot = record(screen.snapshot, 'scenario.expect.screen.snapshot');
  exactKeys(snapshot, ['contains', 'excludes'], 'scenario.expect.screen.snapshot');
  if (!Array.isArray(snapshot.contains) || snapshot.contains.length === 0 || snapshot.contains.some((s) => typeof s !== 'string' || s.length === 0)) {
    throw new Error('scenario.expect.screen.snapshot.contains must contain at least one non-empty string');
  }
  if (snapshot.excludes !== undefined && (!Array.isArray(snapshot.excludes) || snapshot.excludes.some((s) => typeof s !== 'string'))) {
    throw new Error('scenario.expect.screen.snapshot.excludes must be an array of strings');
  }

  if (!Array.isArray(expect.logs) || expect.logs.length !== 1) throw new Error('scenario.expect.logs must contain exactly one expected event');
  const expectedLog = record(expect.logs[0], 'scenario.expect.logs[0]');
  exactKeys(expectedLog, ['category', 'event', 'level', 'count', 'data'], 'scenario.expect.logs[0]');
  const category = requiredString(expectedLog.category, 'scenario.expect.logs[0].category');
  const event = requiredString(expectedLog.event, 'scenario.expect.logs[0].event');
  const level = requiredString(expectedLog.level, 'scenario.expect.logs[0].level');
  if (expectedLog.count !== undefined && (!Number.isInteger(expectedLog.count) || (expectedLog.count as number) < 1)) throw new Error('scenario.expect.logs[0].count must be a positive integer; absent events cannot pass');
  if (expectedLog.data !== undefined) record(expectedLog.data, 'scenario.expect.logs[0].data');

  return {
    version: 0,
    id,
    isolation: 'test',
    triggers: [{ id: triggerId, type: 'codex.responses.fetch', status: trigger.status as number, ...(trigger.count !== undefined ? { count: trigger.count as number } : {}) }],
    expect: {
      screen: {
        mode: 'widget',
        snapshot: { contains: snapshot.contains as string[], ...(snapshot.excludes ? { excludes: snapshot.excludes as string[] } : {}) },
      },
      logs: [{ category, event, level, ...(expectedLog.count !== undefined ? { count: expectedLog.count as number } : {}), ...(expectedLog.data ? { data: expectedLog.data as Record<string, unknown> } : {}) }],
    },
  };
}

function matchesSubset(actual: unknown, expected: Record<string, unknown>, path = 'data'): string[] {
  let parsed = actual;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return [`${path}: stored data is not JSON`]; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [`${path}: expected object data`];
  const actualRecord = parsed as Record<string, unknown>;
  return Object.entries(expected).flatMap(([key, value]) => {
    if (!(key in actualRecord)) return [`${path}.${key}: missing`];
    if (value && typeof value === 'object' && !Array.isArray(value)) return matchesSubset(actualRecord[key], value as Record<string, unknown>, `${path}.${key}`);
    return JSON.stringify(actualRecord[key]) === JSON.stringify(value) ? [] : [`${path}.${key}: expected ${JSON.stringify(value)}, observed ${JSON.stringify(actualRecord[key])}`];
  });
}

function projectSubset(actual: unknown, expected: Record<string, unknown>): Record<string, unknown> {
  let parsed = actual;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return {}; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const actualRecord = parsed as Record<string, unknown>;
  const selected: Record<string, unknown> = {};
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (!(key in actualRecord)) continue;
    const actualValue = actualRecord[key];
    selected[key] = expectedValue && typeof expectedValue === 'object' && !Array.isArray(expectedValue)
      ? projectSubset(actualValue, expectedValue as Record<string, unknown>)
      : actualValue;
  }
  return selected;
}

function rowData(row: LogStoreRow): unknown {
  return row.data;
}

export function resolveScenarioFilePath(filePath: string, repositoryRoot = REPOSITORY_ROOT): string {
  const realRepositoryRoot = realpathSync(repositoryRoot);
  const scenarioRoot = resolve(realRepositoryRoot, 'scenarios');
  const fullPath = resolve(realRepositoryRoot, filePath);
  const rel = relative(scenarioRoot, fullPath);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(scenarioRoot, rel) !== fullPath) throw new Error('scenario file must be inside the repository scenarios/ directory');
  if (!['.yaml', '.yml', '.json'].includes(extname(fullPath).toLowerCase())) throw new Error('scenario file must use .yaml, .yml, or .json');
  const realScenarioRoot = realpathSync(scenarioRoot);
  if (realScenarioRoot !== scenarioRoot) throw new Error('scenario file must be inside the repository scenarios/ directory');
  const realScenarioPath = realpathSync(fullPath);
  const realRel = relative(realScenarioRoot, realScenarioPath);
  if (!realRel || realRel === '..' || realRel.startsWith(`..${sep}`)) throw new Error('scenario file must be inside the repository scenarios/ directory');
  if (realRel.split(sep).some((part) => part.startsWith('.'))) throw new Error('hidden scenario files cannot be run');
  return realScenarioPath;
}

/** Execute the one registered scenario trigger. Only the provider network boundary is faked. */
export async function runScenarioV0(scenario: ScenarioV0): Promise<ScenarioResult> {
  if (!getTestStateRoot()) throw new Error('scenario runner requires --test isolated mode');
  scenario = parseScenarioV0(JSON.stringify(scenario));
  const turn = previousScenarioTurn;
  let release!: () => void;
  previousScenarioTurn = new Promise<void>((resolveTurn) => { release = resolveTurn; });
  await turn;
  try {
    return await runScenarioV0Exclusive(scenario);
  } finally {
    release();
  }
}

async function runScenarioV0Exclusive(scenario: ScenarioV0): Promise<ScenarioResult> {
  const root = mkdtempSync(join(tmpdir(), `ux-sim-${scenario.id}-`));
  const store = new LogStore(join(root, 'logs.db'), { instance: `ux-sim:${scenario.id}` });
  const sink = new StoreSink(store, `ux-sim:${scenario.id}`, { installExitHandlers: false });
  const off = debug.registerSink(sink);
  const originalFetch = globalThis.fetch;
  const trigger = scenario.triggers[0];
  let errorMessage: string | null = null;
  let fetchCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCount++;
    if (String(input) !== 'https://chatgpt.com/backend-api/codex/responses') throw new Error('scenario fake fetch received an unregistered URL');
    return new Response('{"detail":"Bad Request"}', { status: trigger.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  try {
    try {
      for await (const _event of streamCodexResponsesEvents('https://chatgpt.com/backend-api/codex/responses', 'scenario-fake-token', {
        model: 'gpt-6-sol',
        instructions: 'scenario test request',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'scenario test input' }] }],
        tools: [{ type: 'function', name: 'RunShell', description: 'test tool', parameters: {} }],
      }, undefined, { promptCache: false })) { /* consume the deterministic fake response */ }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    const screenText = simRenderLogFrame({ phase: 'idle', lines: errorMessage ? [errorMessage] : [] }, { width: 100, height: 12 }).text;
    const containsMissing = scenario.expect.screen.snapshot.contains.filter((fragment) => !screenText.includes(fragment));
    const excludesFound = (scenario.expect.screen.snapshot.excludes ?? []).filter((fragment) => screenText.includes(fragment));

    sink.flush();
    const expected = scenario.expect.logs[0];
    const rows = store.query({ exactCategories: [expected.category], events: [expected.event], limit: 1000 });
    const expectedCount = expected.count ?? 1;
    const levelMismatch = rows.some((row) => row.level !== expected.level);
    const dataMismatch = expected.data ? rows.flatMap((row) => matchesSubset(rowData(row), expected.data!)) : [];
    const logPass = rows.length === expectedCount && !levelMismatch && dataMismatch.length === 0;
    const screenPass = containsMissing.length === 0 && excludesFound.length === 0;
    const failureReasons: string[] = [];
    const expectedTriggerCount = trigger.count ?? 1;
    if (fetchCount !== expectedTriggerCount) failureReasons.push(`trigger-count-mismatch:expected-${expectedTriggerCount}-observed-${fetchCount}`);
    if (errorMessage === null) failureReasons.push('provider-error-not-observed');
    if (!screenPass) failureReasons.push('screen-snapshot-mismatch');
    if (rows.length === 0) failureReasons.push('expected-log-event-absent');
    else if (rows.length !== expectedCount) failureReasons.push(`log-event-count-mismatch:expected-${expectedCount}-observed-${rows.length}`);
    if (levelMismatch) failureReasons.push(`log-level-mismatch:expected-${expected.level}-observed-${rows[0]?.level ?? 'none'}`);
    if (dataMismatch.length) failureReasons.push('log-data-mismatch');

    return {
      id: scenario.id,
      pass: failureReasons.length === 0,
      trigger: { id: trigger.id, type: trigger.type, status: trigger.status, expectedCount: expectedTriggerCount, fetchCount, error: errorMessage },
      screen: { pass: screenPass, containsMissing, excludesFound, snapshot: screenText },
      logs: {
        pass: logPass,
        category: expected.category,
        event: expected.event,
        level: rows[0]?.level ?? null,
        expectedLevel: expected.level,
        levelMismatch,
        expectedCount,
        observedCount: rows.length,
        matchedData: rows[0] && expected.data ? projectSubset(rowData(rows[0]), expected.data) : {},
        evidenceLine: JSON.stringify({ category: expected.category, event: expected.event, level: rows[0]?.level ?? null, count: rows.length, data: rows[0] && expected.data ? projectSubset(rowData(rows[0]), expected.data) : {} }),
        dataMismatch,
      },
      failureReasons,
    };
  } finally {
    globalThis.fetch = originalFetch;
    off();
    sink.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

export async function runScenarioFile(filePath: string): Promise<ScenarioResult> {
  if (!getTestStateRoot()) throw new Error('scenario runner requires --test isolated mode');
  const realScenarioPath = resolveScenarioFilePath(filePath);
  const source = readFileSync(realScenarioPath, 'utf8');
  const scenario = parseScenarioV0(source);
  return runScenarioV0(scenario);
}
