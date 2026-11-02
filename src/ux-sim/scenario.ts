import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { debug } from '../debug/log.js';
import type { LogSink } from '../mss/logging/sink.js';
import { streamCodexResponsesEvents } from '../llm.js';
import { LogStore, StoreSink, type LogStoreRow } from '../mss/logging/log-store.js';
import { getTestStateRoot } from '../nexus/paths.js';
import { simRenderLogFrame } from './render-frame.js';
import { assessDraftInventory, buildDraftInventory } from './draft-inventory-builder.js';
import { reviewerPrecheckFixtureDocument, runAuthorReviewerPrecheckDevice, type AuthorReviewerPrecheckDeviceResult, type AuthorReviewerPrecheckVariant } from './author-reviewer-precheck-device.js';
import { runGraphRuntimeOverlayEventPathDevice, type GraphRuntimeOverlayEventPathResult } from './graph-runtime-overlay-event-path.js';

export type ScenarioTrigger = {
  id: string;
  type: 'codex.responses.fetch' | 'codex.responses.fetch-network-error' | 'ux.draft-inventory.evaluate' | 'ux.author-reviewer-precheck.evaluate' | 'ux.graph-runtime-overlay.evaluate';
  status?: number;
  count?: number;
  variant?: AuthorReviewerPrecheckVariant;
};

export interface ScenarioV0 {
  version: 0;
  id: string;
  isolation: 'test';
  seed: number;
  triggers: [ScenarioTrigger];
  expect: {
    screen: { mode: 'widget'; snapshot: { contains: string[]; excludes?: string[] } };
    logs: [{ category: string; event: string; level: string; count?: number; data?: Record<string, unknown> }];
  };
}

export interface ScenarioResult {
  id: string;
  runId: string;
  seed: number;
  evidenceArtifact: string;
  runEvidence: { category: string; event: string; persisted: boolean };
  pass: boolean;
  trigger: { id: string; type: string; status: number | null; expectedCount: number; fetchCount: number; error: string | null };
  screen: { pass: boolean; containsMissing: string[]; excludesFound: string[]; snapshot: string };
  logs: { pass: boolean; category: string; event: string; level: string | null; expectedLevel: string; levelMismatch: boolean; expectedCount: number; observedCount: number; matchedData: Record<string, unknown>; evidenceLine: string; dataMismatch: string[] };
  failureReasons: string[];
  authorReviewerPrecheck?: AuthorReviewerPrecheckDeviceResult;
  graphRuntimeOverlay?: GraphRuntimeOverlayEventPathResult;
}

/** Test-only fault injection for proving ScenarioV0 rejects corrupted device output and events. */
export interface ScenarioV0TestOverrides {
  runAuthorReviewerPrecheckDevice?: typeof runAuthorReviewerPrecheckDevice;
  transformAuthorReviewerPrecheckEventData?: (data: Record<string, unknown>) => Record<string, unknown>;
}

type AuthorPrecheckCliFault = 'corrupt-revised-document' | 'missing-author-run-id' | 'wrong-author-run-id';

function authorPrecheckCliFault(): AuthorPrecheckCliFault | null {
  if (!getTestStateRoot()) return null;
  const fault = process.env.ELANOUS_UX_SIM_TEST_FAULT;
  return fault === 'corrupt-revised-document' || fault === 'missing-author-run-id' || fault === 'wrong-author-run-id'
    ? fault
    : null;
}

let previousScenarioTurn: Promise<void> = Promise.resolve();
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SENSITIVE_EXPECTATION_KEY = /(?:token|secret|password|prompt|authorization|credential|api.?key|request.?body)/i;

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${where} has unsupported key(s): ${extra.join(', ')}`);
}

function validateExpectationData(value: Record<string, unknown>, where = 'scenario.expect.logs[0].data'): void {
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_EXPECTATION_KEY.test(key)) throw new Error(`${where} cannot include sensitive field: ${key}`);
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      validateExpectationData(entry as Record<string, unknown>, `${where}.${key}`);
    } else if (Array.isArray(entry)) {
      entry.forEach((item, index) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          validateExpectationData(item as Record<string, unknown>, `${where}.${key}[${index}]`);
        }
      });
    }
  }
}

function requiredString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${where} must be a non-empty string`);
  return value;
}

export function parseScenarioV0(source: string): ScenarioV0 {
  const value = record(parseYaml(source), 'scenario');
  exactKeys(value, ['version', 'id', 'isolation', 'seed', 'triggers', 'expect'], 'scenario');
  if (value.version !== 0) throw new Error('scenario.version must be 0');
  const id = requiredString(value.id, 'scenario.id');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('scenario.id must be lowercase letters, digits, and hyphens');
  if (value.isolation !== 'test') throw new Error('scenario.isolation must be test');
  if (!Number.isInteger(value.seed) || (value.seed as number) < 0 || (value.seed as number) > 0xffffffff) throw new Error('scenario.seed must be an unsigned 32-bit integer');

  if (!Array.isArray(value.triggers) || value.triggers.length !== 1) throw new Error('scenario.triggers must contain exactly one registered trigger');
  const trigger = record(value.triggers[0], 'scenario.triggers[0]');
  exactKeys(trigger, ['id', 'type', 'status', 'count', 'variant'], 'scenario.triggers[0]');
  const triggerId = requiredString(trigger.id, 'scenario.triggers[0].id');
  if (trigger.type !== 'codex.responses.fetch' && trigger.type !== 'codex.responses.fetch-network-error' && trigger.type !== 'ux.draft-inventory.evaluate' && trigger.type !== 'ux.author-reviewer-precheck.evaluate' && trigger.type !== 'ux.graph-runtime-overlay.evaluate') throw new Error(`unregistered scenario trigger: ${String(trigger.type)}`);
  if (trigger.type === 'codex.responses.fetch' && (!Number.isInteger(trigger.status) || (trigger.status as number) < 400 || (trigger.status as number) > 499)) throw new Error('codex.responses.fetch.status must be an HTTP 4xx status');
  if ((trigger.type === 'codex.responses.fetch-network-error' || trigger.type === 'ux.draft-inventory.evaluate') && trigger.status !== undefined) throw new Error(`${trigger.type} does not accept status`);
  if (trigger.count !== undefined && (!Number.isInteger(trigger.count) || (trigger.count as number) < 1)) throw new Error('codex.responses.fetch.count must be a positive integer');
  if (trigger.type === 'ux.draft-inventory.evaluate' && trigger.count !== 200) throw new Error('ux.draft-inventory.evaluate.count must be 200');
  if (trigger.type === 'ux.author-reviewer-precheck.evaluate' && trigger.variant !== 'applied' && trigger.variant !== 'rejected-unprovable') throw new Error('ux.author-reviewer-precheck.evaluate.variant must be applied or rejected-unprovable');
  if (trigger.type !== 'ux.author-reviewer-precheck.evaluate' && trigger.variant !== undefined) throw new Error(`${String(trigger.type)} does not accept variant`);
  if (trigger.type === 'ux.author-reviewer-precheck.evaluate' && (trigger.status !== undefined || trigger.count !== undefined)) throw new Error('ux.author-reviewer-precheck.evaluate does not accept status or count');
  if (trigger.type === 'ux.graph-runtime-overlay.evaluate' && (trigger.status !== undefined || trigger.count !== undefined || trigger.variant !== undefined)) throw new Error('ux.graph-runtime-overlay.evaluate does not accept status, count, or variant');

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
  if (category === 'ux.sim.scenario' && event === 'completed') {
    throw new Error('scenario.expect.logs cannot use reserved event ux.sim.scenario/completed');
  }
  const level = requiredString(expectedLog.level, 'scenario.expect.logs[0].level');
  if (expectedLog.count !== undefined && (!Number.isInteger(expectedLog.count) || (expectedLog.count as number) < 0)) throw new Error('scenario.expect.logs[0].count must be a non-negative integer');
  if (expectedLog.count === 0 && trigger.type !== 'codex.responses.fetch-network-error') throw new Error('zero expected log events are allowed only for codex.responses.fetch-network-error');
  if (expectedLog.data !== undefined) {
    const data = record(expectedLog.data, 'scenario.expect.logs[0].data');
    validateExpectationData(data);
    if (category === 'llm.codex' && event === 'request-rejected-shape' && 'status' in data && typeof data.status !== 'number') {
      throw new Error('scenario.expect.logs[0].data.status must be numeric');
    }
  }

  return {
    version: 0,
    id,
    isolation: 'test',
    seed: value.seed as number,
    triggers: [{ id: triggerId, type: trigger.type as ScenarioTrigger['type'], ...(trigger.status !== undefined ? { status: trigger.status as number } : {}), ...(trigger.count !== undefined ? { count: trigger.count as number } : {}), ...(trigger.variant !== undefined ? { variant: trigger.variant as AuthorReviewerPrecheckVariant } : {}) }],
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

function resolveRunIdExpectation(value: unknown, runId: string): unknown {
  if (value === '$runId') return runId;
  if (Array.isArray(value)) return value.map((entry) => resolveRunIdExpectation(entry, runId));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, resolveRunIdExpectation(entry, runId)]));
  }
  return value;
}

function authorReviewerPrecheckMatches(result: AuthorReviewerPrecheckDeviceResult, variant: AuthorReviewerPrecheckVariant): boolean {
  const exactSentence = 'The result has a measurable criterion and an observable source.';
  const unsupportedSentence = 'Add an unsupported requirement absent from the original ask.';
  const acceptance = '- The result has a measurable criterion.';
  const applied = variant === 'applied';
  const expectedDocument = applied
    ? result.originalDocument.replace(acceptance, `${acceptance}\n- ${exactSentence}`)
    : result.originalDocument;
  return result.originalDocument === reviewerPrecheckFixtureDocument()
    && result.status === (applied ? 'completed' : 'rejected-soft')
    && result.revisedDocument === expectedDocument
    && JSON.stringify(result.appliedFixes) === JSON.stringify(applied ? [exactSentence] : [])
    && JSON.stringify(result.unappliedItems) === JSON.stringify(applied ? [] : [unsupportedSentence]);
}

function rowData(row: LogStoreRow): unknown {
  return row.data;
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  let cursor: string = sep;
  for (const component of absolute.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('scenario evidence path cannot contain symlinks');
    } catch (error) {
      if (error instanceof Error && error.message === 'scenario evidence path cannot contain symlinks') throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
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
export async function runScenarioV0(scenario: ScenarioV0, testOverrides: ScenarioV0TestOverrides = {}): Promise<ScenarioResult> {
  if (!getTestStateRoot()) throw new Error('scenario runner requires --test isolated mode');
  scenario = parseScenarioV0(JSON.stringify(scenario));
  const turn = previousScenarioTurn;
  let release!: () => void;
  previousScenarioTurn = new Promise<void>((resolveTurn) => { release = resolveTurn; });
  await turn;
  try {
    return await runScenarioV0Exclusive(scenario, testOverrides);
  } finally {
    release();
  }
}

async function runScenarioV0Exclusive(scenario: ScenarioV0, testOverrides: ScenarioV0TestOverrides): Promise<ScenarioResult> {
  const stateRoot = getTestStateRoot()!;
  assertNoSymlinkComponents(stateRoot);
  mkdirSync(stateRoot, { recursive: true });
  if (!lstatSync(stateRoot).isDirectory()) throw new Error('scenario test-state root must be a directory');
  const logsDir = join(stateRoot, 'logs');
  assertNoSymlinkComponents(logsDir);
  mkdirSync(logsDir, { recursive: true });
  assertNoSymlinkComponents(logsDir);
  if (!lstatSync(logsDir).isDirectory()) throw new Error('scenario logs path must be a directory');
  const logsPath = join(logsDir, 'logs.db');
  assertNoSymlinkComponents(logsPath);
  try {
    const logsStat = lstatSync(logsPath);
    if (!logsStat.isFile()) throw new Error('scenario logs path must be a regular file');
    if (logsStat.nlink > 1) throw new Error('scenario logs path must not be a hardlink');
  } catch (error) {
    if (error instanceof Error && error.message === 'scenario logs path must be a regular file') throw error;
    if (error instanceof Error && error.message === 'scenario logs path must not be a hardlink') throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const runId = randomUUID();
  const instance = `ux-sim:${scenario.id}:${runId}`;
  const store = new LogStore(logsPath, { instance });
  const storeSink = new StoreSink(store, instance, { installExitHandlers: false });
  const expectedLog = {
    ...scenario.expect.logs[0],
    ...(scenario.expect.logs[0].data ? { data: resolveRunIdExpectation(scenario.expect.logs[0].data, runId) as Record<string, unknown> } : {}),
  };
  const trigger = scenario.triggers[0];
  const sink: LogSink = {
    name: storeSink.name,
    emit(rec) {
      if (rec.category === 'ux.sim.scenario' && rec.event === 'completed') {
        const data = rec.data && typeof rec.data === 'object' ? rec.data as Record<string, unknown> : {};
        storeSink.emit({
          ts: rec.ts,
          category: rec.category,
          event: rec.event,
          data: { runId, scenarioId: scenario.id, deviceVerdict: data.deviceVerdict },
        });
      } else if (rec.category === expectedLog?.category && rec.event === expectedLog.event
        && (trigger.type !== 'ux.graph-runtime-overlay.evaluate'
          || (rec.data && typeof rec.data === 'object' && (rec.data as Record<string, unknown>).stage === 'runtime'))) {
        storeSink.emit({
          ts: rec.ts,
          category: rec.category,
          event: rec.event,
          level: rec.level,
          ...(expectedLog.data ? {
            data: trigger.type === 'ux.author-reviewer-precheck.evaluate'
              ? projectSubset((() => {
                const raw = rec.data && typeof rec.data === 'object' ? rec.data as Record<string, unknown> : {};
                const transformed = testOverrides.transformAuthorReviewerPrecheckEventData?.(raw) ?? raw;
                switch (authorPrecheckCliFault()) {
                  case 'missing-author-run-id': {
                    const { authorRunId: _omitted, ...withoutAuthorRunId } = transformed;
                    return withoutAuthorRunId;
                  }
                  case 'wrong-author-run-id': return { ...transformed, authorRunId: 'wrong-run-id' };
                  default: return transformed;
                }
              })(), expectedLog.data)
              : trigger.type === 'ux.draft-inventory.evaluate'
                ? { runId, ...projectSubset(rec.data, expectedLog.data) }
              : projectSubset(rec.data, expectedLog.data),
          } : {}),
        });
      }
    },
  };
  const off = debug.registerSink(sink);
  const originalFetch = globalThis.fetch;
  let errorMessage: string | null = null;
  let fetchCount = 0;
  let triggerObserved = false;
  let screenLines: string[] = [];
  let authorReviewerPrecheck: AuthorReviewerPrecheckDeviceResult | undefined;
  let graphRuntimeOverlay: GraphRuntimeOverlayEventPathResult | undefined;
  if (trigger.type.startsWith('codex.')) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCount++;
      if (String(input) !== 'https://chatgpt.com/backend-api/codex/responses') throw new Error('scenario fake fetch received an unregistered URL');
      if (trigger.type === 'codex.responses.fetch-network-error') throw new Error(`scenario network error seed=${scenario.seed}`);
      return new Response('{"detail":"Bad Request"}', { status: trigger.status!, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  }

  try {
    if (trigger.type === 'ux.draft-inventory.evaluate') {
      const result = assessDraftInventory(buildDraftInventory(trigger.count));
      const data = {
        runId,
        total: result.total,
        byScenario: result.byScenario,
        byAction: result.byAction,
        triageByAction: result.triageByAction,
        mismatchCount: result.mismatches.length,
        protectedOrRunningClosed: result.protectedOrRunningClosed,
      };
      debug.log('ux.sim.draft-inventory', 'assessed', data);
      screenLines = [
        'Draft inventory simulation',
        `total=${result.total}`,
        `mismatches=${result.mismatches.length}`,
        `protectedOrRunningClosed=${result.protectedOrRunningClosed}`,
      ];
      triggerObserved = result.total === trigger.count
        && Object.values(result.byScenario).every((count) => count === 25)
        && result.mismatches.length === 0
        && result.protectedOrRunningClosed === 0;
    } else if (trigger.type === 'ux.author-reviewer-precheck.evaluate') {
      const runDevice = testOverrides.runAuthorReviewerPrecheckDevice ?? runAuthorReviewerPrecheckDevice;
      const deviceResult = await runDevice(runId, trigger.variant!);
      const result = authorPrecheckCliFault() === 'corrupt-revised-document'
        ? { ...deviceResult, revisedDocument: `${deviceResult.revisedDocument}\ncorrupted` }
        : deviceResult;
      authorReviewerPrecheck = result;
      const expectedStatus = trigger.variant === 'applied' ? 'completed' : 'rejected-soft';
      screenLines = [
        'Goal author reviewer precheck simulation',
        `variant=${trigger.variant}`,
        `status=${result.status}`,
      ];
      triggerObserved = result.status === expectedStatus && authorReviewerPrecheckMatches(result, trigger.variant!);
    } else if (trigger.type === 'ux.graph-runtime-overlay.evaluate') {
      graphRuntimeOverlay = await runGraphRuntimeOverlayEventPathDevice(stateRoot, runId, scenario.id);
      screenLines = [
        'Graph runtime overlay event stream simulation',
        `status=${graphRuntimeOverlay.status}`,
        `decisionObserved=${graphRuntimeOverlay.decisionObserved}`,
        `overlayApplied=${graphRuntimeOverlay.overlayApplied}`,
      ];
      triggerObserved = graphRuntimeOverlay.status === 'done' && graphRuntimeOverlay.decisionObserved && graphRuntimeOverlay.overlayApplied;
    } else {
      try {
        for await (const _event of streamCodexResponsesEvents('https://chatgpt.com/backend-api/codex/responses', 'scenario-fake-token', {
          model: 'gpt-6-sol',
          instructions: 'scenario test request',
          input: [{ role: 'user', content: [{ type: 'input_text', text: `scenario test input seed=${scenario.seed}` }] }],
          tools: [{ type: 'function', name: 'RunShell', description: 'test tool', parameters: {} }],
        }, undefined, { promptCache: false })) { /* consume the deterministic fake response */ }
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      triggerObserved = fetchCount === (trigger.count ?? 1) && errorMessage !== null;
      screenLines = errorMessage ? [errorMessage] : [];
    }

    const screenText = simRenderLogFrame({ phase: 'idle', lines: screenLines }, { width: 100, height: 12 }).text;
    const containsMissing = scenario.expect.screen.snapshot.contains.filter((fragment) => !screenText.includes(fragment));
    const excludesFound = (scenario.expect.screen.snapshot.excludes ?? []).filter((fragment) => screenText.includes(fragment));

    storeSink.flush();
    const expected = expectedLog;
    const rows = store.query({ exactCategories: [expected.category], events: [expected.event], instances: [instance], limit: 1000 });
    const expectedCount = expected.count ?? 1;
    const levelMismatch = rows.some((row) => row.level !== expected.level);
    const dataMismatch = expected.data ? rows.flatMap((row) => matchesSubset(rowData(row), expected.data!)) : [];
    const logPass = rows.length === expectedCount && !levelMismatch && dataMismatch.length === 0;
    const screenPass = containsMissing.length === 0 && excludesFound.length === 0;
    const failureReasons: string[] = [];
    const expectedTriggerCount = trigger.type.startsWith('codex.') ? trigger.count ?? 1 : 1;
    const observedTriggerCount = trigger.type.startsWith('codex.') ? fetchCount : triggerObserved ? 1 : 0;
    if (trigger.type.startsWith('codex.') && fetchCount !== expectedTriggerCount) failureReasons.push(`trigger-count-mismatch:expected-${expectedTriggerCount}-observed-${fetchCount}`);
    if (!triggerObserved) failureReasons.push(trigger.type.startsWith('codex.') ? 'provider-error-not-observed' : trigger.type === 'ux.draft-inventory.evaluate' ? 'draft-inventory-evaluation-failed' : trigger.type === 'ux.graph-runtime-overlay.evaluate' ? 'graph-runtime-overlay-result-mismatch' : 'author-reviewer-precheck-result-mismatch');
    if (!screenPass) failureReasons.push('screen-snapshot-mismatch');
    if (rows.length === 0 && expectedCount > 0) failureReasons.push('expected-log-event-absent');
    else if (rows.length !== expectedCount) failureReasons.push(`log-event-count-mismatch:expected-${expectedCount}-observed-${rows.length}`);
    if (levelMismatch) failureReasons.push(`log-level-mismatch:expected-${expected.level}-observed-${rows[0]?.level ?? 'none'}`);
    if (dataMismatch.length) failureReasons.push('log-data-mismatch');

    const devicePass = failureReasons.length === 0;
    const runEvidence = { category: 'ux.sim.scenario', event: 'completed' } as const;
    debug.log(runEvidence.category, runEvidence.event, {
      runId,
      scenarioId: scenario.id,
      deviceVerdict: devicePass ? 'PASS' : 'FAIL',
    });
    storeSink.flush();
    const persistedRunEvents = store.queryByDataKeys({ exactCategories: [runEvidence.category], runIds: [runId] })
      .filter((row) => row.event === runEvidence.event);
    const runEventPersisted = persistedRunEvents.length === 1;
    if (!runEventPersisted) failureReasons.push('run-evidence-event-not-persisted');

    const result: ScenarioResult = {
      id: scenario.id,
      runId,
      seed: scenario.seed,
      evidenceArtifact: '',
      runEvidence: { ...runEvidence, persisted: runEventPersisted },
      pass: failureReasons.length === 0,
      trigger: { id: trigger.id, type: trigger.type, status: trigger.status ?? null, expectedCount: expectedTriggerCount, fetchCount: observedTriggerCount, error: errorMessage },
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
      ...(authorReviewerPrecheck ? { authorReviewerPrecheck } : {}),
      ...(graphRuntimeOverlay ? { graphRuntimeOverlay } : {}),
    };
    const uxSimDir = join(stateRoot, 'ux-sim');
    const evidenceDir = join(uxSimDir, 'evidence');
    assertNoSymlinkComponents(evidenceDir);
    mkdirSync(uxSimDir, { recursive: true });
    if (!lstatSync(uxSimDir).isDirectory()) throw new Error('scenario evidence directory must stay inside test state');
    mkdirSync(evidenceDir, { recursive: true });
    assertNoSymlinkComponents(evidenceDir);
    if (!lstatSync(evidenceDir).isDirectory()) throw new Error('scenario evidence directory must stay inside test state');
    const evidenceArtifact = join(evidenceDir, `${scenario.id}-seed-${scenario.seed}-run-${runId}.json`);
    result.evidenceArtifact = evidenceArtifact;
    const artifact = {
      version: 0,
      id: scenario.id,
      runId,
      seed: scenario.seed,
      pass: result.pass,
      trigger: { type: result.trigger.type, ...(result.trigger.status !== null ? { status: result.trigger.status } : {}), expectedCount: result.trigger.expectedCount, fetchCount: result.trigger.fetchCount, errorObserved: result.trigger.error !== null },
      screen: { pass: result.screen.pass, snapshotSha256: createHash('sha256').update(result.screen.snapshot).digest('hex'), containsMissingCount: result.screen.containsMissing.length, excludesFoundCount: result.screen.excludesFound.length },
      logs: { pass: result.logs.pass, expectedCount: result.logs.expectedCount, observedCount: result.logs.observedCount, levelMismatch: result.logs.levelMismatch, dataMismatchCount: result.logs.dataMismatch.length },
      runEvidence: { runId: result.runId, persisted: result.runEvidence.persisted },
      failureReasonCount: result.failureReasons.length,
    };
    writeScenarioEvidenceArtifact(evidenceDir, evidenceArtifact, artifact);
    return result;
  } finally {
    globalThis.fetch = originalFetch;
    off();
    storeSink.close();
    store.close();
  }
}

/** Write one already-validated evidence record atomically without following a target link. */
export function writeScenarioEvidenceArtifact(evidenceDir: string, evidenceArtifact: string, artifact: unknown): void {
  assertNoSymlinkComponents(evidenceDir);
  const tempArtifact = join(evidenceDir, `.${randomUUID()}.tmp`);
  const fd = openSync(tempArtifact, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(artifact, null, 2)}\n`);
    closeSync(fd);
    assertNoSymlinkComponents(evidenceDir);
    renameSync(tempArtifact, evidenceArtifact);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tempArtifact); } catch { /* absent after successful rename */ }
    throw error;
  }
}

export async function runScenarioFile(filePath: string): Promise<ScenarioResult> {
  if (!getTestStateRoot()) throw new Error('scenario runner requires --test isolated mode');
  const realScenarioPath = resolveScenarioFilePath(filePath);
  const source = readFileSync(realScenarioPath, 'utf8');
  const scenario = parseScenarioV0(source);
  return runScenarioV0(scenario);
}
