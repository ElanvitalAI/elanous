// Expectation table + verdict rule (SIM-WORLD §4 · 대표 quality bar 11-18). Pure: no fs, no clock.
// Rule 14 (seat-state/OPS/OPS-RULES.md §14): every input splits three ways first — absent → UNMEASURED,
// malformed → FAIL, value → judged — and a known-bad verdict is returned before an unknown one.
//   actual infra-error                          → infra-error        (known bad: kernel/device/module failure)
//   actual malformed (outcome shape is wrong)   → malformed          (FAIL; first 120 chars of the raw outcome kept)
//   actual absent (scenario returned nothing)   → unmeasured         (never a pass)
//   no expectation row                          → unlisted           (the expectation side's «absent»)
//   expected green · passes                     → pass
//   expected green · fails                      → regression
//   expected red   · previously green           → ratchet-violation  (a once-green row may never be red again)
//   expected red   · fails  · promote           → regression         (the PR claims green but it still fails)
//   expected red   · fails  · no observed reason → unmeasured         (a red must say why it is red)
//   expected red   · fails  · reason ≠ redReason → wrong-reason-red   (NOT xfail)
//   expected red   · fails  · reason = redReason → xfail              (reported, NOT a pass; the run stays ok)
//   expected red   · passes · no promote        → promote-required   (RED until this PR flips the row to green)
//   expected red   · passes · promote           → promoted
// «expected» is the BASE table row (main); «promote» = base red and head green; «previously green» = base greenSince.
import type { SimWorldActual, SimWorldEngine, SimWorldExpectEntry, SimWorldExpectTable, SimWorldExpectation, SimWorldScenarioOutcome, SimWorldVerdict } from './types.js';

export const SIM_WORLD_RED_VERDICTS: readonly SimWorldVerdict[] = ['promote-required', 'regression', 'ratchet-violation', 'infra-error', 'unlisted',
  'wrong-reason-red', 'unmeasured', 'malformed', 'contract-violation'];

export interface SimWorldJudgeInput {
  readonly expected: SimWorldExpectation | null;
  readonly actual: SimWorldActual;
  readonly previouslyGreen: boolean;
  readonly promote: boolean;
  /** The row's literal red reason (red rows only). */
  readonly redReason: string | null;
  /** The literal reason the failing scenario reported. */
  readonly observedReason: string | null;
}

export function judgeSimWorldScenario(input: SimWorldJudgeInput): SimWorldVerdict {
  if (input.actual === 'infra-error') return 'infra-error';
  if (input.actual === 'malformed') return 'malformed';
  if (input.actual === 'absent') return 'unmeasured';
  if (input.expected === null) return 'unlisted';
  if (input.expected === 'green') return input.actual === 'pass' ? 'pass' : 'regression';
  if (input.previouslyGreen) return 'ratchet-violation';
  if (input.actual === 'pass') return input.promote ? 'promoted' : 'promote-required';
  if (input.promote) return 'regression';
  if (!input.observedReason) return 'unmeasured';
  return input.observedReason === input.redReason ? 'xfail' : 'wrong-reason-red';
}

/** Rule 14 on the scenario's return value: absent · malformed · value. */
export function classifySimWorldOutcome(raw: unknown):
  { readonly actual: 'pass' | 'fail' | 'malformed' | 'absent'; readonly diff: string | null; readonly reason: string | null } {
  if (raw === undefined || raw === null) return { actual: 'absent', diff: 'scenario returned no outcome', reason: null };
  const value = raw as Partial<{ ok: unknown; diff: unknown; reason: unknown }>;
  const shapeOk = typeof raw === 'object' && !Array.isArray(raw) && (value.ok === true
    || (value.ok === false && typeof value.diff === 'string' && (value.reason === undefined || typeof value.reason === 'string')));
  if (!shapeOk) {
    let text: string;
    try { text = JSON.stringify(raw) ?? String(raw); } catch { text = String(raw); }
    return { actual: 'malformed', diff: `malformed scenario outcome: ${text.slice(0, 120)}`, reason: null };
  }
  const outcome = raw as SimWorldScenarioOutcome;
  if (outcome.ok) return { actual: 'pass', diff: null, reason: null };
  return { actual: 'fail', diff: outcome.diff, reason: outcome.reason?.trim() ? outcome.reason : null };
}

const KEY = /^(memory|ta|graph|supervisors|seat-mail|capsule-events|seat-mail-roundtrip)\/[A-Za-z0-9][A-Za-z0-9_-]*(@(legacy|graph))?$/u;

/** Parse and validate sim-world-expect.json; throws with the offending key so a bad table is loud. */
export function parseSimWorldExpectTable(text: string): SimWorldExpectTable {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('sim-world expect table must be an object');
  const table = value as { schema?: unknown; entries?: unknown };
  if (table.schema !== 1) throw new Error('sim-world expect table must declare schema: 1');
  if (!table.entries || typeof table.entries !== 'object' || Array.isArray(table.entries)) throw new Error('sim-world expect table requires entries');
  const entries: Record<string, SimWorldExpectEntry> = {};
  for (const [key, raw] of Object.entries(table.entries as Record<string, unknown>)) {
    if (!KEY.test(key)) throw new Error(`sim-world expect key is invalid: ${key}`);
    const row = raw as Partial<SimWorldExpectEntry> | null;
    if (!row || (row.expect !== 'red' && row.expect !== 'green')) throw new Error(`sim-world expect row needs expect red|green: ${key}`);
    if (typeof row.reason !== 'string' || !row.reason.trim()) throw new Error(`sim-world expect row needs a reason: ${key}`);
    if (row.greenSince !== undefined && (typeof row.greenSince !== 'string' || !row.greenSince.trim()))
      throw new Error(`sim-world expect greenSince must be a non-empty string: ${key}`);
    if (row.expect === 'green' && row.greenSince === undefined) throw new Error(`sim-world expect green row needs greenSince: ${key}`);
    if (row.expect === 'red' && (typeof row.redReason !== 'string' || !row.redReason.trim()))
      throw new Error(`sim-world expect red row needs a literal redReason: ${key}`);
    entries[key] = { expect: row.expect, reason: row.reason, ...(row.greenSince !== undefined ? { greenSince: row.greenSince } : {}),
      ...(row.expect === 'red' ? { redReason: row.redReason } : {}) };
  }
  return { schema: 1, entries };
}

/**
 * Effective expectation per (scenario, engine) after engine precedence: key `<world>/<scenario>@<engine>` for both
 * engines, from the engine row when present, else the engine-agnostic row. The ratchet compares these, so no row
 * shape (adding an engine row, dropping one for a common row) can turn an effective green red.
 */
export function effectiveSimWorldExpectations(table: SimWorldExpectTable): Map<string, SimWorldExpectEntry> {
  const effective = new Map<string, SimWorldExpectEntry>();
  const scenarios = new Set(Object.keys(table.entries).map((key) => key.replace(/@(legacy|graph)$/u, '')));
  for (const scenario of [...scenarios].sort()) {
    const [world, id] = scenario.split('/') as [string, string];
    for (const engine of ['legacy', 'graph'] as const) {
      const found = lookupSimWorldExpectation(table, world, id, engine);
      if (found) effective.set(`${scenario}@${engine}`, found.entry);
    }
  }
  return effective;
}

/** Engine-specific row first (`ta/A01@graph`), then the engine-agnostic row (`ta/A01`). */
export function lookupSimWorldExpectation(table: SimWorldExpectTable, world: string, scenario: string, engine: SimWorldEngine):
  { readonly key: string; readonly entry: SimWorldExpectEntry } | null {
  for (const key of [`${world}/${scenario}@${engine}`, `${world}/${scenario}`]) {
    const entry = table.entries[key];
    if (entry) return { key, entry };
  }
  return null;
}

/** Resolve the judge inputs from the head table (this tree) and the base table (main; defaults to head). */
export function resolveSimWorldExpectation(head: SimWorldExpectTable, base: SimWorldExpectTable | null,
  world: string, scenario: string, engine: SimWorldEngine): Omit<SimWorldJudgeInput, 'actual' | 'observedReason'> {
  const headRow = lookupSimWorldExpectation(head, world, scenario, engine)?.entry ?? null;
  const baseRow = base ? lookupSimWorldExpectation(base, world, scenario, engine)?.entry ?? null : headRow;
  const expectedRow = baseRow ?? headRow;
  return {
    expected: expectedRow?.expect ?? null,
    promote: baseRow?.expect === 'red' && headRow?.expect === 'green',
    previouslyGreen: Boolean(baseRow?.greenSince),
    redReason: expectedRow?.redReason ?? null,
  };
}
