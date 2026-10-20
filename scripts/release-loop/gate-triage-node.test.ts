import { expect, test } from 'bun:test';
import { classifyGateShadow, gateTriageShadowFromContext, gateTriageShadowFromSavedVerdict, logGateTriageShadow } from './gate-triage-node';
import type { GateResult } from './gate-node';
import { debug } from '../../src/debug/log';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function gate(patch: Partial<GateResult> = {}): GateResult {
  return { outcome: 'ok', commit: 'abcdef0', introduced: [], preexisting: 0, fixed: null,
    knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1000, ...patch };
}

test('shadow triage keeps the existing failure exit and prefers unmeasured evidence', () => {
  const result = classifyGateShadow(gate({ outcome: 'error', introduced: ['src/a.test.ts: fails'],
    stalledShards: [{ shard: 1, files: ['src/b.test.ts'], reason: 'incomplete' }],
    stalledEnv: [{ file: 'src/c.test.ts', reason: 'no-output', local: 'passed' }] }),
  { highLoad: true, isolatedReproductions: 0 });
  expect(result).toMatchObject({ classification: 'unmeasured', outcome: 'fail', stalledFiles: ['src/b.test.ts'] });
});

test('load requires observed pressure and an isolated nonreproduction', () => {
  const sample = gate({ outcome: 'regression', introduced: ['src/a.test.ts: timeout'], loadFlaky: ['src/a.test.ts: timeout'] });
  expect(classifyGateShadow(sample).classification).toBe('regression');
  expect(classifyGateShadow(sample, { highLoad: true, isolatedReproductions: 1 }).classification).toBe('regression');
  expect(classifyGateShadow(sample, { highLoad: true, isolatedReproductions: 0 }).classification).toBe('regression');
  expect(classifyGateShadow(sample, { highLoad: true, isolatedReproductions: 0,
    isolatedCheckedFailureIds: [...sample.introduced] }).classification).toBe('load');
  expect(classifyGateShadow(gate({ ...sample, introduced: [...sample.introduced, 'src/other.test.ts > real failure'] }),
    { highLoad: true, isolatedReproductions: 0, isolatedCheckedFailureIds: [...sample.introduced] }).classification).toBe('regression');
  expect(classifyGateShadow(gate({ outcome: 'error', stalledShards: [{ shard: 1, files: ['src/a.test.ts'], reason: 'timeout' }] }),
    { highLoad: true, isolatedReproductions: 0, isolatedPassedFiles: ['src/a.test.ts'] }).classification).toBe('load');
  expect(classifyGateShadow(gate({ outcome: 'error', stalledShards: [{ shard: 1, files: ['src/a.test.ts', 'src/b.test.ts'], reason: 'timeout' }] }),
    { highLoad: true, isolatedReproductions: 0, isolatedPassedFiles: ['src/a.test.ts'] }).classification).toBe('unmeasured');
  expect(classifyGateShadow(gate({ loadFlaky: ['src/a.test.ts > timed out'] }),
    { highLoad: true, isolatedReproductions: 0 }).classification).toBe('clean');
  expect(classifyGateShadow(gate({ ...sample,
    stalledEnv: [{ file: 'src/other.test.ts', reason: 'no-output', local: 'failed' }] }),
  { highLoad: true, isolatedReproductions: 0, isolatedCheckedFailureIds: [...sample.introduced] }).classification).toBe('regression');
});

test('environment, regression, clean and exhaustion remain distinct', () => {
  const env = gate({ outcome: 'error', introduced: ['src/a.test.ts > fails'],
    stalledEnv: [{ file: 'src/a.test.ts', reason: 'no-output', local: 'passed' }] });
  expect(classifyGateShadow(env).classification).toBe('regression');
  expect(classifyGateShadow(env, { environmentFailureIds: [...env.introduced] }).classification).toBe('env');
  expect(classifyGateShadow(gate({ outcome: 'error', stalledEnv: env.stalledEnv })).classification).toBe('env');
  expect(classifyGateShadow(gate({ outcome: 'error', stalledEnv: [...env.stalledEnv,
    { file: 'src/b.test.ts', reason: 'no-output', local: 'failed' }] })).classification).toBe('unmeasured');
  expect(classifyGateShadow(gate({ outcome: 'ok', stalledEnv: env.stalledEnv })).classification).toBe('clean');
  expect(classifyGateShadow(gate({ ...env, introduced: [...env.introduced, 'src/b.test.ts > real failure'] })).classification).toBe('regression');
  expect(classifyGateShadow(gate({ outcome: 'regression', introduced: ['src/a.test.ts: fails'] })).classification).toBe('regression');
  expect(classifyGateShadow(gate()).classification).toBe('clean');
  const first = classifyGateShadow(env, { environmentFailureIds: [...env.introduced] });
  expect(classifyGateShadow(env, { environmentFailureIds: [...env.introduced], priorDecisions: [first, first] }).classification).toBe('exhausted');
  expect(classifyGateShadow(env, { environmentFailureIds: [...env.introduced], priorDecisions: [first,
    { classification: 'env', commit: env.commit, failureIds: ['other'] }] }).classification).toBe('env');
});

test('graph context consumes gate output without changing it', () => {
  const output = gate({ outcome: 'regression', introduced: ['a'] });
  const context = { input: { version: '0.2.30', previousVersion: '0.2.29' }, outputs: { gate: output as unknown as Record<string, unknown> } };
  expect(gateTriageShadowFromContext(context).classification).toBe('regression');
  const graphOutput = { ...output, outcome: 'fail', verdict: 'fail' };
  expect(gateTriageShadowFromContext({ ...context, outputs: { gate: graphOutput } })).toMatchObject({
    classification: 'regression', commit: output.commit, failureIds: ['a'],
  });
  expect(graphOutput.outcome).toBe('fail');
  expect(gateTriageShadowFromContext({ ...context, input: { ...context.input,
    gateTriageEvidence: { highLoad: true, isolatedReproductions: 0, isolatedCheckedFailureIds: ['a'] } },
    outputs: { gate: gate({ ...output, loadFlaky: ['a'] }) as unknown as Record<string, unknown> } }).classification).toBe('load');
  expect(output.outcome).toBe('regression');
  expect(() => gateTriageShadowFromContext({ ...context, outputs: {} })).toThrow('gate output is missing');
  expect(() => gateTriageShadowFromContext({ ...context, outputs: { gate: { ...output,
    stalledShards: [{ files: null, reason: 'timeout' }] } } })).toThrow('gate output is missing');
});

test('shadow decision records a graph.ground event', () => {
  const result = classifyGateShadow(gate());
  logGateTriageShadow(result, '0.2.30');
  expect(debug.events(20).some((event) => {
    const data = event.data as Record<string, unknown> | undefined;
    const evidence = data?.evidence as Record<string, unknown> | undefined;
    return event.category === 'graph.ground' && event.event === 'gate-triage-shadow'
      && data?.classification === 'clean' && data.commit === 'abcdef0'
      && data.reason === 'gate passed' && Array.isArray(data.failureIds)
      && evidence?.highLoad === null && evidence.isolatedCheckedFailureIds === null
      && evidence.environmentFailureIds === null;
  })).toBe(true);
  const id = 'src/a.test.ts > timed out';
  logGateTriageShadow(classifyGateShadow(gate({ outcome: 'regression', introduced: [id], loadFlaky: [id] }),
    { highLoad: true, isolatedReproductions: 0, isolatedCheckedFailureIds: [id] }), '0.2.30');
  expect(debug.events(20).some((event) => {
    const data = event.data as Record<string, unknown> | undefined;
    const evidence = data?.evidence as Record<string, unknown> | undefined;
    return event.category === 'graph.ground' && data?.classification === 'load'
      && evidence?.highLoad === true && evidence.isolatedReproductions === 0
      && Array.isArray(evidence.isolatedCheckedFailureIds)
      && evidence.isolatedCheckedFailureIds.includes(id);
  })).toBe(true);
});

test('standalone entrypoint preserves the failure exit and structured classification', () => {
  const context = { input: { version: '0.2.30', previousVersion: '0.2.29' },
    outputs: { gate: { ...gate({ outcome: 'regression', introduced: ['src/a.test.ts: fails'] }), outcome: 'fail' } } };
  const run = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, ELANOUS_GRAPH_CONTEXT: JSON.stringify(context) },
  });
  expect(run.status).toBe(1);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
  expect(result).toMatchObject({ outcome: 'fail', classification: 'regression' });
});

test('saved 0.2.29 gate verdict can be triaged without changing release state', () => {
  const saved = { version: '0.2.29', commit: 'e1783835d5b719e397b697452d1c2fe358b7c3f1',
    outcome: 'regression', introduced: ['src/self-implement/run-ledger.test.ts > unfinished run ledger cleanup disposition'],
    knownEnv: [], preexisting: [], loadFlaky: [] };
  expect(gateTriageShadowFromSavedVerdict(saved).result.classification).toBe('regression');
  const file = join(mkdtempSync(join(tmpdir(), 'gate-verdict-shadow-')), 'gate-verdict.json');
  writeFileSync(file, JSON.stringify(saved));
  const run = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts', '--gate-verdict', file], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
  });
  expect(run.status).toBe(1);
  expect(JSON.parse(run.stdout.trim().split('\n').at(-1)!)).toMatchObject({ classification: 'regression', outcome: 'fail' });
  expect(gateTriageShadowFromSavedVerdict({ ...saved, outcome: 'error', introduced: [],
    stalledShards: [{ shard: 1, files: ['src/stalled.test.ts'], reason: 'incomplete' }] }).result.classification).toBe('unmeasured');
  expect(() => gateTriageShadowFromSavedVerdict({ ...saved, stalledEnv: [null] })).toThrow('gate output is missing');
});

if (process.env.ELANOUS_GATE_VERDICT_0229) test('actual 0.2.29 saved verdict retains commit and failure IDs through CLI', () => {
  const file = process.env.ELANOUS_GATE_VERDICT_0229!;
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { commit: string; introduced: string[] };
  const expectedId = 'src/self-implement/run-ledger.test.ts > unfinished run ledger cleanup disposition > executes the cleanup CLI as plan-only by default, removes only on request, and blocks incomplete queries';
  expect(saved.commit).toBe('e1783835d5b719e397b697452d1c2fe358b7c3f1');
  expect(saved.introduced).toEqual([expectedId]);
  const run = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts', '--gate-verdict', file], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
  });
  expect(run.status).toBe(1);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!);
  expect(result).toMatchObject({ classification: 'regression', outcome: 'fail', commit: saved.commit, introduced: [expectedId] });
});
