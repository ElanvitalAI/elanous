import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { WorldScenarioResult } from './world.js';

export type SuiteTarget = 'sim' | 'real';
export interface SuiteReceipt {
  readonly pass: boolean;
  readonly steps: readonly { id: string; outcome: string; invariant: string; durationMs: number | null }[];
  readonly eventKinds: readonly string[];
}
export interface SuiteCase { readonly id: string; readonly worldFile: string; readonly scenarioFile: string; readonly baselineFile: string }
export interface SuiteDifference { readonly scenario: string; readonly field: string; readonly baseline: unknown; readonly actual: unknown }
export interface SuiteRunResult { readonly pass: boolean; readonly scenarios: number; readonly differences: readonly SuiteDifference[]; readonly measurement: 'measured' | 'unmeasured' }

function stableText(value: string): string {
  return value.replace(/\b(?:runId|run-id)=[^\s,)]+/g, 'runId=<run>')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<time>')
    .replace(/\/tmp\/[^\s,)]+/g, '<tmp>');
}

function observationOutcome(observation: WorldScenarioResult['observations'][number]): string {
  const verdict = stableText(observation.gateOutcome ?? observation.verdict);
  return observation.event.startsWith('chaos-') && observation.durationMs !== undefined
    ? verdict.replace(/ \((?:unrecovered|\d+ms)\)$/, '') : verdict;
}

/** Retain only declared, reproducible result fields; volatile run IDs, wall time, and paths are excluded. */
export function receiptFromWorld(result: WorldScenarioResult): SuiteReceipt {
  const recoverySteps = (result.observations.some((observation) => observation.event.startsWith('chaos-'))
    ? [] : (result.recovery?.observations ?? [])).map((observation, index) => ({
    id: `recovery:${index}:${observation.kind}`, outcome: stableText(observation.recoveryVerdict),
    invariant: observation.recoveredAtMs === null ? 'fail' : 'pass', durationMs: observation.recoveryMs,
  }));
  return {
    pass: result.pass,
    steps: [...result.observations.map((observation) => ({ id: observation.event,
      outcome: observationOutcome(observation),
      invariant: observation.invariant ?? (observation.gateOutcome === 'ok' ? 'pass'
        : observation.gateOutcome === 'fail' ? 'fail' : 'unmeasured'),
      durationMs: observation.durationMs ?? null })), ...recoverySteps],
    eventKinds: [...result.observations.map((observation) => observation.event),
      ...(result.recovery?.timeline.map((event) => event.kind) ?? [])],
  };
}

/** Production sim adapter; one fresh world per run prevents the determinism replay from inheriting state. */
export async function runSimWorldSuiteCase(item: SuiteCase): Promise<SuiteReceipt> {
  const { createWorld, destroyWorldById, runWorldScenario } = await import('./world.js');
  const world = await createWorld(item.worldFile);
  try { return receiptFromWorld(await runWorldScenario(world, item.scenarioFile)); }
  finally { await destroyWorldById(world.id); }
}

function ownedFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink();
}

/** A suite contains one directory per scenario, each with a world, scenario, and target-specific baseline. */
export function discoverSuiteCases(folder: string, target: SuiteTarget): SuiteCase[] {
  const root = resolve(folder);
  if (!lstatSync(root).isDirectory()) throw new Error(`suite is not a directory: ${root}`);
  const cases = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => ({ id: entry.name, worldFile: join(root, entry.name, 'world.yaml'),
      scenarioFile: join(root, entry.name, 'scenario.yaml'), baselineFile: join(root, entry.name, `baseline.${target}.json`) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (cases.length === 0) throw new Error(`suite has no scenarios: ${root}`);
  for (const item of cases) {
    if (!ownedFile(item.worldFile) || !ownedFile(item.scenarioFile)) throw new Error(`scenario ${item.id} needs owned world.yaml and scenario.yaml`);
    if (basename(item.id) !== item.id) throw new Error(`invalid scenario id: ${item.id}`);
  }
  return cases;
}

function compareReceipt(id: string, baseline: SuiteReceipt, actual: SuiteReceipt, tolerancePercent: number): SuiteDifference[] {
  const differences: SuiteDifference[] = [];
  const compare = (field: string, before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) differences.push({ scenario: id, field, baseline: before, actual: after });
  };
  compare('step.ids', baseline.steps.map((step) => step.id), actual.steps.map((step) => step.id));
  compare('pass', baseline.pass, actual.pass);
  compare('eventKinds', baseline.eventKinds, actual.eventKinds);
  const occurrences = (steps: SuiteReceipt['steps']) => {
    const counts = new Map<string, number>();
    return steps.map((step) => {
      const occurrence = (counts.get(step.id) ?? 0) + 1;
      counts.set(step.id, occurrence);
      return { step, key: `${step.id}\u0000${occurrence}`, label: occurrence === 1 ? step.id : `${step.id}#${occurrence}` };
    });
  };
  const actualByKey = new Map(occurrences(actual.steps).map((entry) => [entry.key, entry.step]));
  for (const entry of occurrences(baseline.steps)) {
    const step = entry.step;
    const current = actualByKey.get(entry.key);
    if (!current) continue;
    compare(`${entry.label}.outcome`, step.outcome, current.outcome);
    compare(`${entry.label}.invariant`, step.invariant, current.invariant);
    if (step.durationMs === null || current.durationMs === null) compare(`${entry.label}.durationMs`, step.durationMs, current.durationMs);
    else if (Math.abs(current.durationMs - step.durationMs) > step.durationMs * tolerancePercent / 100) {
      differences.push({ scenario: id, field: `${entry.label}.durationMs`, baseline: step.durationMs, actual: current.durationMs });
    }
  }
  return differences;
}

function readBaseline(path: string): { tolerancePercent: number; receipt: SuiteReceipt } {
  if (!ownedFile(path)) throw new Error(`baseline missing: ${path}`);
  const value = JSON.parse(readFileSync(path, 'utf8')) as { tolerancePercent?: unknown; receipt?: unknown };
  if (typeof value.tolerancePercent !== 'number' || !Number.isFinite(value.tolerancePercent)
    || value.tolerancePercent < 0 || value.tolerancePercent > 100) throw new Error(`invalid baseline: ${path}`);
  return { tolerancePercent: value.tolerancePercent, receipt: validateReceipt(value.receipt, path) };
}

function validateReceipt(value: unknown, label: string): SuiteReceipt {
  const receipt = value as Partial<SuiteReceipt> | null;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || typeof receipt.pass !== 'boolean' || !Array.isArray(receipt.steps)
    || !Array.isArray(receipt.eventKinds)
    || receipt.eventKinds.some((event) => typeof event !== 'string' || !event.trim())
    || receipt.steps.some((step) => !step || typeof step !== 'object'
      || typeof step.id !== 'string' || !step.id.trim()
      || typeof step.outcome !== 'string'
      || typeof step.invariant !== 'string' || !step.invariant.trim()
      || (step.durationMs !== null && (typeof step.durationMs !== 'number'
        || !Number.isFinite(step.durationMs) || step.durationMs < 0)))) {
    throw new Error(`invalid suite receipt: ${label}`);
  }
  return receipt as SuiteReceipt;
}

function suiteTolerance(folder: string): number {
  const path = join(resolve(folder), 'suite.json');
  if (!ownedFile(path)) throw new Error(`suite configuration missing: ${path}`);
  const value = JSON.parse(readFileSync(path, 'utf8')) as { durationTolerancePercent?: unknown };
  const tolerance = value.durationTolerancePercent;
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100)
    throw new Error(`invalid duration tolerance in ${path}`);
  return tolerance;
}

export async function runWorldRegressionSuite(input: {
  folder: string;
  target: SuiteTarget;
  updateBaseline?: boolean;
  /** The target adapter owns isolation, lifecycle, and execution. */
  run?: (item: SuiteCase, target: SuiteTarget) => Promise<SuiteReceipt>;
}): Promise<SuiteRunResult> {
  const cases = discoverSuiteCases(input.folder, input.target);
  const tolerancePercent = suiteTolerance(input.folder);
  const differences: SuiteDifference[] = [];
  const updates: Array<{ path: string; receipt: SuiteReceipt }> = [];
  if (!input.run) return { pass: false, scenarios: cases.length, measurement: 'unmeasured',
    differences: cases.map((item) => ({ scenario: item.id, field: 'target', baseline: input.target, actual: 'unmeasured: target runner unavailable' })) };
  for (const item of cases) {
    const baseline = ownedFile(item.baselineFile) ? readBaseline(item.baselineFile) : null;
    if (!baseline && !input.updateBaseline) {
      differences.push({ scenario: item.id, field: 'baseline', baseline: 'missing', actual: 'not run' });
      continue;
    }
    const actual = validateReceipt(await input.run(item, input.target), `${item.id} actual`);
    if (!actual.pass && (!baseline || input.updateBaseline || baseline.receipt.pass === false))
      differences.push({ scenario: item.id, field: 'scenario.pass', baseline: true, actual: false });
    if (input.target === 'sim') {
      const replay = validateReceipt(await input.run(item, input.target), `${item.id} replay`);
      differences.push(...compareReceipt(item.id, actual, replay, 0).map((difference) => ({ ...difference,
        field: `nondeterministic.${difference.field}` })));
    }
    if (baseline && !input.updateBaseline) differences.push(...compareReceipt(item.id, baseline.receipt, actual, tolerancePercent));
    if (input.updateBaseline) updates.push({ path: item.baselineFile, receipt: actual });
  }
  if (input.updateBaseline && differences.length === 0) {
    const staged: string[] = [];
    const committed: Array<{ path: string; previous: Buffer | null }> = [];
    try {
      for (const update of updates) {
        const temp = `${update.path}.new`;
        writeFileSync(temp, `${JSON.stringify({ tolerancePercent, receipt: update.receipt }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        staged.push(temp);
      }
      for (const update of updates) {
        const previous = ownedFile(update.path) ? readFileSync(update.path) : null;
        renameSync(`${update.path}.new`, update.path);
        committed.push({ path: update.path, previous });
      }
    } catch (error) {
      for (const update of committed.reverse()) {
        if (update.previous === null) rmSync(update.path);
        else writeFileSync(update.path, update.previous);
      }
      throw error;
    } finally {
      for (const temp of staged) if (existsSync(temp)) rmSync(temp);
    }
  }
  return { pass: differences.length === 0, scenarios: cases.length, differences, measurement: 'measured' };
}
