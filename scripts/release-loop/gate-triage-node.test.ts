import { expect, test } from 'bun:test';
import { chooseGatePrescription, classifyGateShadow, gateTriageShadowFromContext, gateTriageShadowFromSavedVerdict, logGateTriageShadow, priorGateDecisionsFromLedger } from './gate-triage-node';
import type { GateResult } from './gate-node';
import { debug } from '../../src/debug/log';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as yaml } from 'yaml';

function gate(patch: Partial<GateResult> = {}): GateResult {
  return { outcome: 'ok', commit: 'abcdef0', introduced: [], preexisting: 0, fixed: null,
    knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1000, ...patch };
}

test('shadow triage reports successful classification and prefers unmeasured evidence', () => {
  const result = classifyGateShadow(gate({ outcome: 'error', introduced: ['src/a.test.ts: fails'],
    stalledShards: [{ shard: 1, files: ['src/b.test.ts'], reason: 'incomplete' }],
    stalledEnv: [{ file: 'src/c.test.ts', reason: 'no-output', local: 'passed' }] }),
  { highLoad: true, isolatedReproductions: 0 });
  expect(result).toMatchObject({ classification: 'unmeasured', outcome: 'ok', stalledFiles: ['src/b.test.ts'] });
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

test('standalone entrypoint succeeds with structured classification', () => {
  const context = { runId: 'run-shadow', input: { version: '0.2.30', previousVersion: '0.2.29' },
    outputs: { gate: { ...gate({ outcome: 'regression', introduced: ['src/a.test.ts: fails'] }), outcome: 'fail' } } };
  const run = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, ELANOUS_GRAPH_CONTEXT: JSON.stringify(context) },
  });
  expect(run.status).toBe(0);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
  expect(result).toMatchObject({ outcome: 'ok', classification: 'regression',
    prescription: { action: 'repair-card', runId: 'run-shadow', failureIds: ['src/a.test.ts: fails'] } });
});

test('successful triage still follows the release failure restoration edge', () => {
  const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as {
    edges: Array<{ from: string; map: Record<string, string> }> };
  const triage = graph.edges.find(edge => edge.from === 'gate-triage');
  expect(triage?.map).toEqual({ ok: 'traffic-failed-restore', fail: 'traffic-failed-restore', error: 'traffic-failed-restore' });
  expect(graph.edges.find(edge => edge.from === 'traffic-failed-restore')?.map)
    .toEqual({ ok: 'failed', fail: 'failed', error: 'failed' });
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
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout.trim().split('\n').at(-1)!)).toMatchObject({ classification: 'regression', outcome: 'ok' });
  expect(gateTriageShadowFromSavedVerdict({ ...saved, outcome: 'error', introduced: [],
    stalledShards: [{ shard: 1, files: ['src/stalled.test.ts'], reason: 'incomplete' }] }).result.classification).toBe('unmeasured');
  expect(() => gateTriageShadowFromSavedVerdict({ ...saved, stalledEnv: [null] })).toThrow('gate output is missing');
});

test('0.2.40 failure evidence selects only the matching gate prescription', () => {
  const ids = [
    'scripts/ratchets/test-interference-patterns.test.ts > 래칫 — 허용 목록 > ⭐ 저장소 전수 — 허용 목록 밖 새 위반 0 (시간·수를 함께 남긴다)',
    'test/anatomy-doc-source-citations.test.ts > current-state anatomy document has recognized, non-stale source citations',
    'test/rules-contract.test.ts > R-TST35 — 시험의 exitCode 복원에 «?? 0» 이 있다(래칫) > 전 시험 파일의 위반이 기준선(0) 이하다',
  ];
  const regression = gate({ outcome: 'regression', commit: '31960bf01044b268b77f4f0c3774df823f13576c', introduced: ids });
  const savedReplay = gateTriageShadowFromSavedVerdict({ version: '0.2.40', commit: regression.commit,
    outcome: 'regression', introduced: ids, loadFlaky: [] });
  expect(savedReplay.result).toMatchObject({ classification: 'regression', commit: regression.commit, introduced: ids });
  const context = { runId: '0.2.40-shadow', input: { version: '0.2.40', previousVersion: '0.2.38', gateExecutor: 'pod' },
    outputs: { gate: regression as unknown as Record<string, unknown> } };
  expect(chooseGatePrescription(context, gateTriageShadowFromContext(context))).toEqual({
    action: 'repair-card', reason: 'introduced gate regressions', runId: '0.2.40-shadow',
    commit: regression.commit, failureIds: ids,
  });
  expect(chooseGatePrescription({ ...context, runId: undefined }, gateTriageShadowFromContext(context)).runId).toBeNull();
  const host = gate({ outcome: 'error', commit: regression.commit,
    stalledShards: [{ shard: 0, files: ['test/a.test.ts'], reason: 'unattributed', summaryFailures: 39, namedFailures: 78 }] });
  const hostContext = { ...context, input: { ...context.input, gateExecutor: 'host' },
    outputs: { gate: host as unknown as Record<string, unknown> } };
  expect(chooseGatePrescription(hostContext, gateTriageShadowFromContext(hostContext))).toMatchObject({
    action: 'rerun-pod', reason: 'host gate attribution incomplete', commit: regression.commit,
  });
  const hostError = gate({ outcome: 'error', commit: regression.commit,
    error: 'cut host sweep incomplete (rc=1; failure attribution summary=39, identified=78)' });
  expect(chooseGatePrescription({ ...hostContext, outputs: { gate: hostError as unknown as Record<string, unknown> } },
    gateTriageShadowFromContext({ ...hostContext, outputs: { gate: hostError as unknown as Record<string, unknown> } })))
    .toMatchObject({ action: 'rerun-pod', reason: 'host gate attribution incomplete' });
  const exhausted = classifyGateShadow(regression, { priorDecisions: [
    { classification: 'regression', commit: regression.commit, failureIds: ids },
    { classification: 'regression', commit: regression.commit, failureIds: ids },
  ] });
  expect(chooseGatePrescription(context, exhausted).action).toBe('decision-card');
});

test('actual saved release runs supply repeated symptom decisions to the live triage', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-history-'));
  const dir = join(root, 'graph-runs', 'release-loop');
  mkdirSync(dir, { recursive: true });
  const commit = '31960bf01044b268b77f4f0c3774df823f13576c';
  const ids = ['src/a.test.ts > failed'];
  const context = { runId: 'current', input: { version: '0.2.40', previousVersion: '0.2.38' },
    outputs: { gate: gate({ outcome: 'regression', commit, introduced: ids }) as unknown as Record<string, unknown> } };
  for (const [index, runId] of ['earlier-1', 'earlier-2'].entries()) {
    writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ runId, input: { version: '0.2.40' },
      nodes: [{ nodeId: 'gate-triage', executed: true,
        output: JSON.stringify({ classification: 'regression', commit, failureIds: ids }) }] }));
  }
  const history = priorGateDecisionsFromLedger(context, root);
  expect(history).toHaveLength(2);
  const triage = gateTriageShadowFromContext(context, undefined, history);
  expect(triage.classification).toBe('exhausted');
  expect(chooseGatePrescription(context, triage).action).toBe('decision-card');
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
  expect(run.status).toBe(0);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!);
  expect(result).toMatchObject({ classification: 'regression', outcome: 'ok', commit: saved.commit, introduced: [expectedId] });
});

test('malformed graph context exits with error outcome', () => {
  const run = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, ELANOUS_GRAPH_CONTEXT: JSON.stringify({ outputs: {} }) },
  });
  expect(run.status).toBe(1);
  expect(JSON.parse(run.stdout.trim().split('\n').at(-1)!)).toMatchObject({ outcome: 'error', verdict: 'fail' });
});

if (process.env.ELANOUS_GATE_HOST_LEDGER_0239) test('recorded host gate ledger produces rerun-pod and its prior triage is readable', () => {
  const path = process.env.ELANOUS_GATE_HOST_LEDGER_0239!;
  const state = JSON.parse(readFileSync(path, 'utf8')) as { runId: string; input: Record<string, unknown>;
    nodes: Array<{ nodeId: string; output?: string }> };
  const gateNode = state.nodes.find(node => node.nodeId === 'gate');
  if (!gateNode?.output) throw new Error('recorded host gate output missing');
  const gateOutput = JSON.parse(gateNode.output) as Record<string, unknown>;
  const context = { runId: 'new-release-run', input: state.input as { version: string; previousVersion: string },
    outputs: { gate: gateOutput } };
  expect(state.input.gateExecutor).toBe('host');
  expect(String(gateOutput.error)).toContain('failure attribution incomplete');
  expect(chooseGatePrescription(context, gateTriageShadowFromContext(context)))
    .toMatchObject({ action: 'rerun-pod', commit: gateOutput.commit });
  const root = dirname(dirname(dirname(path)));
  expect(priorGateDecisionsFromLedger(context, root))
    .toContainEqual(expect.objectContaining({ commit: gateOutput.commit, classification: 'unmeasured' }));
});
