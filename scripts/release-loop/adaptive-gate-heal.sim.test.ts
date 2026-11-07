import { expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateResult } from './gate-node.js';
import { planAdaptiveGateHeal } from './adaptive-gate-heal.js';
import { classifyGateShadow } from './gate-triage-node.js';

test('RLA-ARG-ADAPTIVE-HEAL sim: production decision core consumes injected gate events in the declared order', () => {
  const graph = parseYaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as {
    nodes: Array<{ node_id: string; max_visits: number }>;
  };
  const world = parseYaml(readFileSync(join(import.meta.dir, '../../scenarios/ux-sim/rla-arg-adaptive-heal.yaml'), 'utf8')) as {
    cases: Array<{ id: string; inject: { outcome: GateResult['outcome']; introduced?: string[]; executor?: 'host' | 'pod'; error?: string;
      gatePodPool?: string; stalledShards?: GateResult['stalledShards']; repeat?: number };
      expect: { classification?: string; action: string; events: string[] } }>;
  };
  const base = (outcome: GateResult['outcome'], patch: Partial<GateResult> = {}): GateResult => ({ outcome, commit: 'a'.repeat(40),
    introduced: [], preexisting: 0, fixed: null, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1, ...patch });
  for (const scenario of world.cases) {
    const gate = base(scenario.inject.outcome, { introduced: scenario.inject.introduced ?? [],
      ...(scenario.inject.error === undefined ? {} : { error: scenario.inject.error }),
      ...(scenario.inject.stalledShards === undefined ? {} : { stalledShards: scenario.inject.stalledShards }) });
    const repeat = scenario.inject.repeat ?? 0;
    const prior = repeat ? Array.from({ length: repeat }, () => ({ classification: 'regression' as const,
      commit: gate.commit, failureIds: [...(scenario.inject.introduced ?? [])] })) : undefined;
    const triage = classifyGateShadow(gate, prior ? { priorDecisions: prior } : {});
    const plan = planAdaptiveGateHeal({ version: '0.3.6', runId: `sim-${scenario.id}`, gate, triage,
      gateExecutor: scenario.inject.executor, gatePodPool: scenario.inject.gatePodPool,
      visitState: { gate: 1, gateTriage: 1 } });
    if (scenario.expect.classification) expect(triage.classification, scenario.id).toBe(scenario.expect.classification);
    expect(String(plan.disposition.action)).toBe(scenario.expect.action);
    expect(plan.events.map((event) => String(event.name))).toEqual(scenario.expect.events);
    expect(plan.attribution.commit).toBe(gate.commit);
    if (plan.disposition.action === 'append-repair-and-resume') {
      expect(plan.disposition.repairNode.input.failureIds).toEqual(scenario.inject.introduced ?? []);
      expect(plan.disposition.resumeFrom).toBe(plan.disposition.repairNode.nodeId);
      expect(plan.disposition.rerunGateAt).toBe('gate');
      expect(plan.disposition.visitLimits).toEqual({ gate: 2, gateTriage: 2 });
      expect(plan.disposition.maxRepairRetries).toBe(1);
      expect(graph.nodes.find((node) => node.node_id === 'gate')?.max_visits).toBe(plan.disposition.visitLimits.gate);
      expect(graph.nodes.find((node) => node.node_id === 'gate-triage')?.max_visits).toBe(plan.disposition.visitLimits.gateTriage);
    }
    if (plan.disposition.action === 'append-image-repair-and-resume') {
      expect(plan.disposition.repairNode.input).toEqual({ version: '0.3.6', runId: `sim-${scenario.id}`,
        commit: triage.commit, pool: scenario.inject.gatePodPool,
        failureCode: scenario.inject.error?.includes('pod-gate-missing-run-scope')
          ? 'pod-gate-missing-run-scope' : 'pod-gate-missing-cut-image-pin' });
      expect(plan.disposition.repairNode.recipe).toBe('cmd:gate-image-repair');
      expect(plan.disposition.resumeFrom).toBe(plan.disposition.repairNode.nodeId);
      expect(plan.disposition.visitLimits).toEqual({ gate: 2, gateTriage: 2 });
    }
  }
});

test('RLA-ARG-ADAPTIVE-HEAL sim: missing graph context or gate output records an unmeasured decision', () => {
  const cwd = join(import.meta.dir, '../..');
  for (const context of [undefined, { runId: 'sim-missing-gate', input: { version: '0.3.6', previousVersion: '0.3.5' }, outputs: {} }]) {
    const stateDir = mkdtempSync(join(tmpdir(), 'rla-arg-missing-context-'));
    const env: NodeJS.ProcessEnv = { ...process.env, ELANOUS_STATE_DIR: stateDir };
    if (context) env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
    else delete env.ELANOUS_GRAPH_CONTEXT;
    const run = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], { cwd, encoding: 'utf8', timeout: 20_000, env });
    expect(run.status, run.stderr).toBe(1);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { adaptiveHeal: { disposition: { action: string };
      events: Array<{ name: string; data?: Record<string, unknown> }> } };
    expect(result.adaptiveHeal.disposition.action).toBe('decision-required');
    expect(result.adaptiveHeal.events.map((event) => event.name)).toEqual([
      'gate.result.received', 'gate.failures.attributed', 'heal.classified', 'heal.hitl.decided',
    ]);
    if (context) expect(result.adaptiveHeal.events[0]?.data).toMatchObject({ runId: 'sim-missing-gate', version: '0.3.6' });
  }
});

test('RLA-ARG-ADAPTIVE-HEAL sim: exhausted graph visit budget produces HITL instead of another resume', () => {
  const gate: GateResult = { outcome: 'regression', commit: 'b'.repeat(40), introduced: ['src/release.test.ts > persistent failure'],
    preexisting: 0, fixed: null, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1 };
  const triage = classifyGateShadow(gate);
  const plan = planAdaptiveGateHeal({ version: '0.3.6', runId: 'sim-exhausted-visits', gate, triage,
    visitState: { gate: 2, gateTriage: 2 } });
  expect(plan.disposition).toEqual({ action: 'decision-required', reason: 'adaptive repair retry budget is exhausted or visit state is invalid' });
  expect(plan.events.at(-1)).toMatchObject({ name: 'heal.hitl.decided' });
});

test('RLA-ARG-ADAPTIVE-HEAL sim: live gate-triage node emits plans for regression, unmeasured, and repeated failures', () => {
  const world = parseYaml(readFileSync(join(import.meta.dir, '../../scenarios/ux-sim/rla-arg-adaptive-heal.yaml'), 'utf8')) as {
    cases: Array<{ id: string; inject: { outcome: GateResult['outcome']; introduced?: string[]; error?: string;
      stalledShards?: GateResult['stalledShards']; repeat?: number }; expect: { action: string; events: string[] } }>;
  };
  for (const id of ['introduced-regression', 'unmeasured-gate', 'repeated-signature']) {
    const scenario = world.cases.find((item) => item.id === id)!;
    const stateDir = mkdtempSync(join(tmpdir(), 'rla-arg-release-node-'));
    const commit = 'a'.repeat(40);
    const gate = { outcome: scenario.inject.outcome === 'regression' ? 'fail' as const : scenario.inject.outcome,
      commit, introduced: scenario.inject.introduced ?? [], preexisting: 0, fixed: null, knownEnv: 0, knownEnvCleared: [],
      stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1,
      ...(scenario.inject.error ? { error: scenario.inject.error } : {}),
      ...(scenario.inject.stalledShards ? { stalledShards: scenario.inject.stalledShards } : {}) };
    const priorDecisions = scenario.inject.repeat ? Array.from({ length: scenario.inject.repeat }, () => ({
      classification: 'regression', commit, failureIds: [...(scenario.inject.introduced ?? [])],
    })) : undefined;
    const run = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, ELANOUS_STATE_DIR: stateDir, ELANOUS_GRAPH_CONTEXT: JSON.stringify({ runId: `sim-live-${id}`,
        input: { version: '0.3.6', previousVersion: '0.3.5', gateExecutor: 'pod', adaptiveHealVisitState: { gate: 1, gateTriage: 1 },
          ...(priorDecisions ? { gateTriageEvidence: { priorDecisions } } : {}) }, outputs: { gate } }) } });
    expect(run.status, `${id}: ${run.stderr}`).toBe(0);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { adaptiveHeal: { disposition: { action: string };
      events: Array<{ name: string; data: Record<string, unknown> }> } };
    expect(result.adaptiveHeal.disposition.action, id).toBe(scenario.expect.action);
    expect(result.adaptiveHeal.events.map((event) => event.name), id).toEqual(scenario.expect.events);
    expect(result.adaptiveHeal.events[0]?.data.outcome, id).toBe(gate.outcome);
  }
});

test('RLA-ARG-ADAPTIVE-HEAL sim: missing runtime visit state fails closed to decision-required', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rla-arg-unknown-visits-'));
  const gate = { outcome: 'fail' as const, commit: 'c'.repeat(40), introduced: ['src/release.test.ts > regression'],
    preexisting: 0, fixed: null, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1 };
  const run = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8',
    timeout: 20_000, env: { ...process.env, HOME: stateDir, ELANOUS_STATE_DIR: stateDir, ELANOUS_CONFIG_DIR: stateDir, ELANOUS_NEXUS_DIR: stateDir,
      ELANOUS_GRAPH_CONTEXT: JSON.stringify({ runId: 'sim-unknown-visits', input: { version: '0.3.6', previousVersion: '0.3.5' }, outputs: { gate } }) } });
  expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { adaptiveHeal: { disposition: { action: string };
    events: Array<{ name: string }> } };
  expect(result.adaptiveHeal.disposition.action).toBe('decision-required');
  expect(result.adaptiveHeal.events.at(-1)?.name).toBe('heal.hitl.decided');
});
