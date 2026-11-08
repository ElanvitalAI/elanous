import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { assessIntroducedMainFixedPick, chooseGatePrescription, classifyGateShadow, gateTriageShadowFromContext, gateTriageShadowFromSavedVerdict, logGateTriageShadow, priorGateDecisionsFromLedger } from './gate-triage-node';
import type { GateResult } from './gate-types.js';
import { debug } from '../../src/debug/log';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as yaml } from 'yaml';
import { resetEffectiveInstanceRoot } from '../../src/instance/resolve.js';

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
  expect(gateTriageShadowFromContext(context).mainFixedPick).toBeUndefined();
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
  const context = { runId: 'run-shadow', input: { version: '0.2.30', previousVersion: '0.2.29', gateExecutor: 'pod',
    adaptiveHealVisitState: { gate: 1, gateTriage: 1 } },
    outputs: { gate: { ...gate({ outcome: 'regression', introduced: ['src/a.test.ts: fails'] }), outcome: 'fail' } } };
  const run = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, ELANOUS_GRAPH_CONTEXT: JSON.stringify(context) },
  });
  expect(run.status).toBe(0);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
  expect(result).toMatchObject({ outcome: 'ok', classification: 'regression',
    verdict: 'pass',
    prescription: { action: 'append-repair-and-resume', visitState: { gate: 1, gateTriage: 1 },
      repairNode: { input: { runId: 'run-shadow', failureIds: ['src/a.test.ts: fails'] } } } });
});

test('successful triage still follows the release failure restoration edge', () => {
  const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as {
    edges: Array<{ from: string; map: Record<string, string> }> };
  const triage = graph.edges.find(edge => edge.from === 'gate-triage');
  expect(triage?.map).toEqual({ ok: 'traffic-failed-restore', fail: 'gate-heal-decision', error: 'gate-heal-decision' });
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
  expect(gateTriageShadowFromContext(context).mainFixedPick).toBeUndefined();
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

test('GATE-INTRODUCED-MAIN-FIXED-PICK sim: only a measured first-parent transition with an intact rolling receipt is suggested', () => {
  const root = mkdtempSync(join(tmpdir(), 'introduced-main-fixed-pick-'));
  const cut = 'd'.repeat(40);
  const baseCommit = 'c'.repeat(40);
  const mainFailure = 'e'.repeat(40);
  const fix = 'b'.repeat(40);
  const tip = 'a'.repeat(40);
  const id = 'src/a.test.ts > introduced failure';
  const receiptPath = join(root, 'rolling-main-receipt.json');
  const receiptBody = JSON.stringify({ outcome: 'ok', commit: tip });
  writeFileSync(receiptPath, receiptBody);
  const receipt = { valid: true as const, commit: tip, receiptPath,
    sha256: createHash('sha256').update(receiptBody).digest('hex') };
  const makeMeasurement = (status: 'pass' | 'fail' | 'unmeasured', commit = tip) => {
    const receiptBody = JSON.stringify({ schema: 'main-standalone-v1', complete: true,
      runId: 'main-run-1', commit, results: [{ id, status }] });
    return { commit, runId: 'main-run-1', receiptSha256: createHash('sha256').update(receiptBody).digest('hex'), receiptBody };
  };
  const base = {
    cutCommit: cut,
    mainTip: tip,
    firstParentBaseCommit: baseCommit,
    firstParentCommits: [baseCommit, mainFailure, fix, tip],
    introducedIds: [id],
    cutResults: [{ id, status: 'fail' as const }],
    mainMeasurement: makeMeasurement('pass'),
    rollingRuns: [
      { commit: mainFailure, status: 'red' as const, introduced: [id] },
      { commit: fix, status: 'red' as const, introduced: [] },
      { commit: tip, status: 'green' as const, introduced: [], receipt },
    ],
  };
  try {
    expect(assessIntroducedMainFixedPick(base)).toMatchObject({
      status: 'measured', candidates: [{ failureId: id, commit: tip, source: 'main-head-fallback' }], unverifiedCandidates: [],
    });
    const laterRed = { commit: tip, status: 'red' as const, introduced: [id] };
    const fixReceiptBody = JSON.stringify({ outcome: 'ok', commit: fix });
    const fixReceiptPath = join(root, 'rolling-main-fix-receipt.json');
    writeFileSync(fixReceiptPath, fixReceiptBody);
    expect(assessIntroducedMainFixedPick({ ...base, rollingRuns: [
      base.rollingRuns[0]!,
      { commit: fix, status: 'green' as const, introduced: [], receipt: { valid: true as const, commit: fix,
        receiptPath: fixReceiptPath, sha256: createHash('sha256').update(fixReceiptBody).digest('hex') } },
      { ...base.rollingRuns[2]!, receipt },
    ] })).toMatchObject({ status: 'measured', candidates: [{ failureId: id, commit: fix, source: 'rolling-main-transition' }] });
    const ambiguousRollingRuns = [base.rollingRuns[0]!, base.rollingRuns[1]!, base.rollingRuns[2]!];
    expect(assessIntroducedMainFixedPick({ ...base, mainMeasurement: undefined, rollingRuns: ambiguousRollingRuns }))
      .toMatchObject({ status: 'unmeasured', candidates: [], unverifiedCandidates: [{ failureId: id }] });
    const exactRollingRuns = [base.rollingRuns[0]!,
      { commit: fix, status: 'green' as const, introduced: [], receipt: { valid: true as const, commit: fix,
        receiptPath: fixReceiptPath, sha256: createHash('sha256').update(fixReceiptBody).digest('hex') } },
      { ...base.rollingRuns[2]!, receipt }];
    expect(assessIntroducedMainFixedPick({ ...base,
      mainMeasurement: { ...base.mainMeasurement, receiptSha256: '0'.repeat(64) }, rollingRuns: exactRollingRuns }))
      .toMatchObject({ status: 'measured', candidates: [{ failureId: id, commit: fix, source: 'rolling-main-transition' }] });
    expect(assessIntroducedMainFixedPick({ ...base, mainMeasurement: makeMeasurement('unmeasured'), rollingRuns: exactRollingRuns }))
      .toMatchObject({ status: 'measured', candidates: [{ failureId: id, commit: fix, source: 'rolling-main-transition' }] });
    expect(assessIntroducedMainFixedPick({ ...base, mainMeasurement: makeMeasurement('fail') }))
      .toMatchObject({ status: 'measured', candidates: [], unverifiedCandidates: [] });
    expect(assessIntroducedMainFixedPick({ ...base, rollingRuns: [
      base.rollingRuns[0]!,
      { commit: fix, status: 'green' as const, introduced: [], receipt: { valid: true as const, commit: fix,
        receiptPath: fixReceiptPath, sha256: createHash('sha256').update(fixReceiptBody).digest('hex') } },
      laterRed,
    ] })).toMatchObject({ status: 'measured', candidates: [],
      unverifiedCandidates: [{ failureId: id, commit: tip, status: 'unverified' }] });
    expect(assessIntroducedMainFixedPick({ ...base, rollingRuns: [] })).toMatchObject({
      status: 'measured', candidates: [{ failureId: id, commit: tip, source: 'main-head-fallback' }],
    });
    const { rollingRuns, mainMeasurement, ...withoutRollingReceipts } = base;
    void rollingRuns;
    void mainMeasurement;
    expect(assessIntroducedMainFixedPick(withoutRollingReceipts)).toMatchObject({
      status: 'unmeasured', firstParentCommits: [baseCommit, mainFailure, fix, tip], candidates: [],
      unverifiedCandidates: [{ failureId: id, commit: tip, status: 'unverified', reason: 'execution receipt absent' }],
    });
    expect(assessIntroducedMainFixedPick({ ...base, rollingRuns: base.rollingRuns.map((run) => ({ ...run, introduced: [] })) }))
      .toMatchObject({ status: 'measured', candidates: [{ failureId: id, commit: tip, source: 'main-head-fallback' }] });
    expect(assessIntroducedMainFixedPick({ ...base, rollingRuns: base.rollingRuns.map((run) => ({
      commit: run.commit, status: 'red' as const, introduced: [id],
    })) })).toMatchObject({ status: 'measured', candidates: [],
      unverifiedCandidates: [{ failureId: id, commit: tip, status: 'unverified' }] });
    expect(assessIntroducedMainFixedPick({ ...base, rollingRuns: undefined, mainMeasurement: makeMeasurement('fail') }))
      .toMatchObject({ status: 'measured', candidates: [] });
    expect(assessIntroducedMainFixedPick({ ...base, mainMeasurement: makeMeasurement('pass', cut) }))
      .toMatchObject({ status: 'unmeasured', candidates: [], unverifiedCandidates: [{ failureId: id, status: 'unverified' }] });
    expect(assessIntroducedMainFixedPick({ ...base, mainMeasurement: makeMeasurement('unmeasured') }))
      .toMatchObject({ status: 'unmeasured', candidates: [], unverifiedCandidates: [{ failureId: id, status: 'unverified' }] });
    expect(assessIntroducedMainFixedPick({ ...base, mainMeasurement: { ...base.mainMeasurement, receiptSha256: '0'.repeat(64) } }))
      .toMatchObject({ status: 'unmeasured', candidates: [], unverifiedCandidates: [{ failureId: id, status: 'unverified' }] });
    expect(assessIntroducedMainFixedPick({ ...base, rollingRuns: [
      base.rollingRuns[0]!,
      { commit: fix, status: 'red' as const, introduced: [] },
      { commit: tip, status: 'red' as const, introduced: [] },
    ] })).toMatchObject({ status: 'measured', candidates: [{ failureId: id, commit: tip, source: 'main-head-fallback' }],
      unverifiedCandidates: [] });
    expect(assessIntroducedMainFixedPick({ ...base,
      rollingRuns: [{ ...base.rollingRuns[0]! }, { ...base.rollingRuns[1]!, receipt: { ...receipt, sha256: '0'.repeat(64) } }],
    })).toMatchObject({ status: 'measured', candidates: [{ failureId: id, commit: tip, source: 'main-head-fallback' }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-INTRODUCED-MAIN-FIXED-PICK sim: missing rolling-main receipts fall back to main-head recheck plus first-parent range', () => {
  const priorCwd = process.cwd();
  const priorStateDir = process.env.ELANOUS_STATE_DIR;
  const isolatedStateDir = mkdtempSync(join(tmpdir(), 'introduced-main-fixed-pick-state-'));
  const repo = mkdtempSync(join(tmpdir(), 'introduced-main-fixed-pick-git-'));
  process.env.ELANOUS_STATE_DIR = isolatedStateDir;
  resetEffectiveInstanceRoot();
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Gate fixed-pick simulation');
  git('config', 'user.email', 'gate-fixed-pick@example.invalid');
  writeFileSync(join(repo, 'fixture.txt'), 'base\n');
  git('add', 'fixture.txt');
  git('commit', '-qm', 'base');
  git('commit', '--allow-empty', '-qm', 'cut');
  const cutCommit = git('rev-parse', 'HEAD').stdout.trim();
  git('commit', '--allow-empty', '-qm', 'main standalone result');
  const mainTip = git('rev-parse', 'HEAD').stdout.trim();
  const bare = mkdtempSync(join(tmpdir(), 'introduced-main-fixed-pick-origin-'));
  spawnSync('git', ['init', '--bare', '-q', bare]);
  git('remote', 'add', 'origin', bare);
  git('push', '-q', 'origin', `HEAD:refs/heads/main`);
  git('update-ref', 'refs/remotes/origin/main', mainTip);
  const baseCommit = git('merge-base', cutCommit, mainTip).stdout.trim();
  const commits = git('rev-list', '--first-parent', '--reverse', `${baseCommit}..${mainTip}`)
    .stdout.trim().split(/\r?\n/).filter(Boolean);
  const id = 'src/a.test.ts > introduced failure';
  const measurementDir = join(isolatedStateDir, 'release', '0.3.7', 'main-standalone');
  mkdirSync(measurementDir, { recursive: true });
  const measurementBody = JSON.stringify({ schema: 'main-standalone-v1', complete: true,
    runId: 'main-run-1', commit: mainTip, results: [{ id, status: 'pass' }] });
  writeFileSync(join(measurementDir, 'main-run-1.json'), measurementBody);
  const context = { input: { version: '0.3.7', previousVersion: '0.3.6', gateTriageEvidence: {
    introducedMainFixedPick: { mainTip, firstParentCommits: [baseCommit, ...commits],
      mainMeasurement: { commit: mainTip, runId: 'main-run-1', receiptSha256: createHash('sha256').update(measurementBody).digest('hex'),
        receiptBody: measurementBody } },
  } }, outputs: { gate: gate({ outcome: 'regression', commit: cutCommit, introduced: [id] }) as unknown as Record<string, unknown> } };
  try {
    process.chdir(repo);
    expect(gateTriageShadowFromContext(context).mainFixedPick).toMatchObject({
      status: 'measured', firstParentCommits: [baseCommit, ...commits],
      candidates: [{ failureId: id, commit: mainTip, source: 'main-head-fallback' }], unverifiedCandidates: [],
    });
    git('update-ref', 'refs/remotes/origin/main', cutCommit);
    expect(gateTriageShadowFromContext(context).mainFixedPick).toMatchObject({
      status: 'unmeasured', candidates: [], unverifiedCandidates: [],
    });
  } finally {
    process.chdir(priorCwd);
    if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateDir;
    resetEffectiveInstanceRoot();
    rmSync(isolatedStateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test('GATE-INTRODUCED-MAIN-FIXED-PICK sim: live gate triage emits an unmeasured observation when no standalone result producer supplied a receipt', () => {
  const priorCwd = process.cwd();
  const priorStateDir = process.env.ELANOUS_STATE_DIR;
  const isolatedStateDir = mkdtempSync(join(tmpdir(), 'introduced-main-fixed-pick-live-state-'));
  const repo = mkdtempSync(join(tmpdir(), 'introduced-main-fixed-pick-live-git-'));
  process.env.ELANOUS_STATE_DIR = isolatedStateDir;
  resetEffectiveInstanceRoot();
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Gate fixed-pick live simulation');
  git('config', 'user.email', 'gate-fixed-pick@example.invalid');
  writeFileSync(join(repo, 'fixture.txt'), 'base\n');
  git('add', 'fixture.txt');
  git('commit', '-qm', 'base');
  git('commit', '--allow-empty', '-qm', 'cut');
  const cutCommit = git('rev-parse', 'HEAD').stdout.trim();
  git('commit', '--allow-empty', '-qm', 'main tip');
  const mainTip = git('rev-parse', 'HEAD').stdout.trim();
  const bare = mkdtempSync(join(tmpdir(), 'introduced-main-fixed-pick-live-origin-'));
  spawnSync('git', ['init', '--bare', '-q', bare]);
  git('remote', 'add', 'origin', bare);
  git('push', '-q', 'origin', 'HEAD:refs/heads/main');
  git('update-ref', 'refs/remotes/origin/main', mainTip);
  const baseCommit = git('merge-base', cutCommit, mainTip).stdout.trim();
  const commits = git('rev-list', '--first-parent', '--reverse', `${baseCommit}..${mainTip}`)
    .stdout.trim().split(/\r?\n/).filter(Boolean);
  const id = 'src/a.test.ts > introduced failure';
  const context = { input: { version: '0.3.7', previousVersion: '0.3.6' },
    outputs: { gate: gate({ outcome: 'regression', commit: cutCommit, introduced: [id] }) as unknown as Record<string, unknown> } };
  try {
    process.chdir(repo);
    expect(gateTriageShadowFromContext(context).mainFixedPick).toMatchObject({
      status: 'unmeasured', candidates: [], firstParentCommits: [baseCommit, ...commits],
      unverifiedCandidates: [{ failureId: id, commit: mainTip, status: 'unverified', reason: 'execution receipt absent' }],
    });
    const rollingPath = join(isolatedStateDir, 'release', '0.3.7', 'rolling-main-gate.json');
    mkdirSync(dirname(rollingPath), { recursive: true });
    writeFileSync(rollingPath, '{corrupt rolling receipt');
    expect(gateTriageShadowFromContext(context).mainFixedPick).toMatchObject({
      status: 'unmeasured', candidates: [], firstParentCommits: [baseCommit, ...commits],
      unverifiedCandidates: [{ failureId: id, commit: mainTip, status: 'unverified', reason: 'execution receipt absent' }],
    });
    const measurementDir = join(isolatedStateDir, 'release', '0.3.7', 'main-standalone');
    mkdirSync(measurementDir, { recursive: true });
    const receiptBody = JSON.stringify({ schema: 'main-standalone-v1', complete: true,
      runId: 'main-run-fallback', commit: mainTip, results: [{ id, status: 'pass' }] });
    writeFileSync(join(measurementDir, 'main-run-fallback.json'), receiptBody);
    const standaloneContext = { ...context, input: { ...context.input, gateTriageEvidence: {
      introducedMainFixedPick: { mainTip, firstParentCommits: [baseCommit, ...commits], mainMeasurement: {
        commit: mainTip, runId: 'main-run-fallback', receiptSha256: createHash('sha256').update(receiptBody).digest('hex'),
      } },
    } } };
    expect(gateTriageShadowFromContext(standaloneContext).mainFixedPick).toMatchObject({
      status: 'measured', firstParentCommits: [baseCommit, ...commits],
      candidates: [{ failureId: id, commit: mainTip, source: 'main-head-fallback' }], unverifiedCandidates: [],
    });
  } finally {
    process.chdir(priorCwd);
    if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateDir;
    resetEffectiveInstanceRoot();
    rmSync(isolatedStateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
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

test('malformed graph context exits with a fail-closed HITL prescription', () => {
  const run = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, ELANOUS_GRAPH_CONTEXT: JSON.stringify({ outputs: {} }) },
  });
  expect(run.status).toBe(1);
  expect(JSON.parse(run.stdout.trim().split('\n').at(-1)!)).toMatchObject({
    outcome: 'fail', verdict: 'fail', prescription: { action: 'decision-required' },
  });
});

test('rejected macrophage repair-ladder input emits decision-required for the live graph', () => {
  const failureId = 'src/a.test.ts > introduced regression';
  for (const ladder of [null, { runId: 'another-run', failureIds: [failureId], evidence: 'introduced' }]) {
    const run = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, ELANOUS_GRAPH_CONTEXT: JSON.stringify({ runId: 'active-run', input: {
        version: '0.3.7', previousVersion: '0.3.6', adaptiveHealVisitState: { gate: 1, gateTriage: 1 },
        macrophageRepairLadder: ladder,
      }, outputs: { gate: gate({ outcome: 'regression', introduced: [failureId] }) } }) },
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout.trim().split('\n').at(-1)!)).toMatchObject({
      outcome: 'fail', prescription: { action: 'decision-required' },
      adaptiveHeal: { disposition: { action: 'decision-required' },
        events: expect.arrayContaining([expect.objectContaining({ name: 'heal.hitl.decided' })]) },
    });
  }
});

test('successful gate triage emits the graph success verdict', () => {
  const run = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, ELANOUS_GRAPH_CONTEXT: JSON.stringify({
      input: { version: '0.2.40', previousVersion: '0.2.39', adaptiveHealVisitState: { gate: 1, gateTriage: 1 } },
      outputs: { gate: gate() },
    }) },
  });
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout.trim().split('\n').at(-1)!)).toMatchObject({ outcome: 'ok', verdict: 'pass' });
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
