/** Isolated product-dispatch trial: actual eln CLI, scripted one-tool-call model and estimated token accounting. */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { estimateTokens } from '../../src/tokens.js';
import { dispatchRunShell, type RunShellDispatchResult } from '../../src/skills/tools/shell.js';

type Query = { command: string[]; select?: string; contains?: string };
type Task = { id: string; queries: Query[]; expected: Array<string | number | boolean> };
const VERSION = '0.3.33';
const route = (seat: string): Query => ({ command: ['eln', 'msg', 'route', seat, '--json'], select: 'source' });
const release = (action: string): Query => ({ command: ['eln', 'release', 'checklist', action, '--version', VERSION, '--json'], select: 'green' });
const tasks: Task[] = [
  { id: 'health-and-release', queries: [
    { command: ['eln', 'ops', 'health', '--json'], select: 'healthy' }, release('status'),
  ], expected: [true, 0] },
  { id: 'two-unknown-routes', queries: [route('SIM-UNKNOWN-A'), route('SIM-UNKNOWN-B')], expected: ['unresolved', 'unresolved'] },
  { id: 'empty-memory', queries: [
    { command: ['eln', 'memory', 'list'], contains: 'No memories yet' },
    { command: ['eln', 'memory', 'search', 'absent'], contains: 'No matches' },
  ], expected: [true, true] },
  { id: 'mail-and-route', queries: [
    { command: ['eln', 'msg', 'list', '--to', 'SIM-UNKNOWN-A'], contains: 'No messages.' }, route('SIM-UNKNOWN-A'),
  ], expected: [true, 'unresolved'] },
  { id: 'two-ops-views', queries: [
    { command: ['eln', 'ops', 'status', '--json'], select: 'health.healthy' },
    { command: ['eln', 'ops', 'health', '--json'], select: 'anomalyCount' },
  ], expected: [true, 0] },
  { id: 'two-checklist-views', queries: [release('list'), release('status')], expected: [0, 0] },
  { id: 'missing-log-store', queries: [
    { command: ['eln', 'logs', '--since', '1m', '--json'] },
  ], expected: ['exit:1'] },
];

function selectScalar(text: string, path: string): string | number | boolean {
  const parsed = JSON.parse(text) as unknown;
  const value = path.split('.').reduce<unknown>((current, key) =>
    current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>)[key] : undefined, parsed);
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new Error(`missing scalar ${path}`);
  return value;
}

function answerFromSingle(query: Query, result: RunShellDispatchResult): string | number | boolean {
  if (result.exitCode !== 0 || result.outcome !== 'exit') return `exit:${result.exitCode}`;
  if (query.select) return selectScalar(result.stdout, query.select);
  if (query.contains) return result.stdout.includes(query.contains);
  return 'ok';
}

function answerFromScript(query: Query, step: { exitCode: number | null; outcome: string; selected?: Record<string, unknown>; preview?: string }): string | number | boolean {
  if (step.exitCode !== 0 || step.outcome !== 'exit') return `exit:${step.exitCode}`;
  if (query.select) {
    const value = step.selected?.[query.select];
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new Error(`script missing scalar ${query.select}`);
    return value;
  }
  if (query.contains) return (step.preview ?? '').includes(query.contains);
  return 'ok';
}

export async function runTrial(universe = mkdtempSync(join(tmpdir(), 'cx15-toolbatch-trial-'))) {
const bin = join(universe, 'bin');
const repository = resolve(import.meta.dir, '../..');
const oldPath = process.env.PATH ?? '';
const oldCanary = process.env.ELN_FAKE_SECRET;
try {
const { mkdirSync } = await import('node:fs');
mkdirSync(bin, { recursive: true });
const wrapper = join(bin, 'eln');
writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${join(repository, 'bin', 'elanous.mjs')}' '--test=${universe}' "$@"\n`);
chmodSync(wrapper, 0o700);
process.env.PATH = `${bin}:${oldPath}`;
process.env.ELN_FAKE_SECRET = 'synthetic-cx15-trial-secret';

// Materialize the isolated config once. The warmup is excluded from both arms.
const warmup = await dispatchRunShell({ command: ['eln', 'release', 'checklist', 'status', '--version', VERSION, '--json'] }, { availableToolNames: [] });
if (warmup.exitCode !== 0) throw new Error(`warmup failed: ${warmup.stderr}`);

const rows = [];
for (const task of tasks) {
  const baselineResults: RunShellDispatchResult[] = [];
  for (const query of task.queries) baselineResults.push(await dispatchRunShell({ command: query.command }, { availableToolNames: [] }));
  const baselineAnswer = task.queries.map((query, index) => answerFromSingle(query, baselineResults[index]!));
  const scriptResult = await dispatchRunShell({ script: task.queries.map((query, index) => ({
    id: `q${index}`, command: query.command, ...(query.select ? { select: [query.select] } : {}),
    ...(query.contains ? { headLines: 2 } : {}),
  })) }, { availableToolNames: [], scriptApproval: async () => ({ allowed: true, priorHumanApproval: false }) });
  const scriptReceipt = JSON.parse(scriptResult.stdout) as { steps: Array<{ exitCode: number | null; outcome: string; selected?: Record<string, unknown>; preview?: string }> };
  const scriptAnswer = task.queries.map((query, index) => answerFromScript(query, scriptReceipt.steps[index]!));
  const correct = JSON.stringify(baselineAnswer) === JSON.stringify(task.expected)
    && JSON.stringify(scriptAnswer) === JSON.stringify(task.expected);
  rows.push({ id: task.id, baselineTurns: baselineResults.length, scriptTurns: 1,
    baselineTokensEstimated: baselineResults.reduce((total, result) => total + estimateTokens(JSON.stringify(result)), 0),
    scriptTokensEstimated: estimateTokens(JSON.stringify(scriptResult)),
    baselineAnswer, scriptAnswer, expected: task.expected, correct,
    baselineFailures: baselineResults.filter((result) => result.exitCode !== 0).length,
    scriptFailures: scriptReceipt.steps.filter((step) => step.exitCode !== 0).length,
    scriptRunId: JSON.parse(scriptResult.stdout).runId });
}
const baselineTurns = rows.reduce((sum, row) => sum + row.baselineTurns, 0);
const scriptTurns = rows.reduce((sum, row) => sum + row.scriptTurns, 0);
const turnReduction = (baselineTurns - scriptTurns) / baselineTurns;
const sameAnswers = rows.every((row) => row.correct);
const baselineFailures = rows.reduce((sum, row) => sum + row.baselineFailures, 0);
const scriptFailures = rows.reduce((sum, row) => sum + row.scriptFailures, 0);
const report = { schema: 1, head: process.env.ELN_TRIAL_HEAD ?? 'unbound', universe,
  model: 'scripted-one-tool-call-per-turn', tokens: 'estimateTokens over tool responses; no provider billing usage',
  tasks: rows, totals: { baselineTurns, scriptTurns, turnReduction, sameAnswers, baselineFailures, scriptFailures,
    baselineTokensEstimated: rows.reduce((sum, row) => sum + row.baselineTokensEstimated, 0),
    scriptTokensEstimated: rows.reduce((sum, row) => sum + row.scriptTokensEstimated, 0) },
  decision: turnReduction >= 0.3 && sameAnswers && scriptFailures <= baselineFailures ? 'simulation-go' : 'discard' };
return report;
} finally {
  process.env.PATH = oldPath;
  if (oldCanary === undefined) delete process.env.ELN_FAKE_SECRET;
  else process.env.ELN_FAKE_SECRET = oldCanary;
}
}

if (import.meta.main) {
  const report = await runTrial();
  console.log(JSON.stringify(report));
  if (!report.totals.sameAnswers || report.totals.scriptFailures > report.totals.baselineFailures) process.exitCode = 1;
}
