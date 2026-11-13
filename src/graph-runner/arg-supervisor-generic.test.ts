import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyGateShadow } from '../../scripts/release-loop/gate-triage-node.js';
import { planAdaptiveGateHeal } from '../../scripts/release-loop/adaptive-gate-heal.js';
import type { GateResult } from '../../scripts/release-loop/gate-types.js';
import { runArgSupervisorTick, type ArgMutationState, type ArgSupervisorPorts } from './arg-supervisor.js';
import { runGraph, type GraphRunOptions } from './runner.js';

const releaseDir = resolve(import.meta.dir, '../../graphs/release');
const loopId = 'loop:host-reservation-watch@1';
const genericLoopSource = `apiVersion: elanous.dev/loop/v1
id: '${loopId}'
card: { title: Host Reservation Watch, supervises: [release-loop], role: primary, extensions: [elanous.dev/arg] }
authority: [reroute, add-node, repair, hitl]
policy:
  scope: run
  approval: { resultType: input_required }
knowledgePacks: [../release-edge-vocabulary.yaml, ../macrophage-subscriber.yaml]
templateMemory: { graph: ../release-loop.yaml }
graph: ./supervisor.yaml
`;
const genericTargetSource = `graph_id: release-loop
version: 1
supervisors:
  - { ref: '${loopId}', role: primary, scope: run, authority: [reroute, add-node, repair, hitl], requires: [elanous.dev/arg] }
entry_node: gate
terminal_nodes: [done]
nodes:
  - { node_id: gate, kind: gate, recipe: none, max_visits: 2 }
  - { node_id: gate-triage, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: gate, on: outcome, map: { fail: gate-triage, ok: done } }
  - { from: gate-triage, on: outcome, map: { ok: done } }
`;
const genericSupervisorSource = `graph_id: host-reservation-supervisor
version: 1
entry_node: observe
terminal_nodes: [done, failed, needs-human]
nodes:
  - { node_id: observe, kind: agent, recipe: 'cmd:observe', max_visits: 1 }
  - { node_id: propose, kind: agent, recipe: 'cmd:propose', max_visits: 1 }
  - { node_id: validate, kind: judge, recipe: 'cmd:validate', max_visits: 1 }
  - { node_id: apply, kind: agent, recipe: 'cmd:apply', max_visits: 1 }
  - { node_id: verify, kind: gate, recipe: 'cmd:verify', max_visits: 1 }
  - { node_id: rollback, kind: agent, recipe: 'cmd:rollback', max_visits: 1 }
  - { node_id: needs-human, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: observe, on: outcome, map: { ok: propose, fail: failed } }
  - { from: propose, on: outcome, map: { ok: validate, fail: failed } }
  - { from: validate, on: outcome, map: { ok: apply, input_required: needs-human, fail: failed } }
  - { from: apply, on: outcome, map: { ok: verify, input_required: needs-human, fail: failed } }
  - { from: verify, on: outcome, map: { ok: done, fail: rollback } }
  - { from: rollback, on: outcome, map: { ok: failed, fail: failed } }
`;
const genericRecipesSource = `observe: { command: 'arg:observe' }
propose: { command: 'arg:propose' }
validate: { command: 'arg:validate' }
apply: { command: 'arg:apply' }
verify: { command: 'arg:verify' }
rollback: { command: 'arg:rollback' }
`;
// Source: initial graph revision fixture from graphs/release/rla/loop.yaml ARG contract.
const initialRevision = 1;
const retry = { kind: 'retry-edge' as const, from: 'gate-triage', to: 'gate',
  triggerEvent: 'release.gate.failed', rationale: 'generic supervisor retry' };

test('a non-RLA supervisor completes the ARG lifecycle only with matching graph authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-generic-supervisor-'));
  const loopDir = join(root, 'host-reservation-watch');
  mkdirSync(loopDir, { recursive: true });
  const loopPath = join(loopDir, 'loop.yaml');
  const graphPath = join(root, 'release-loop.yaml');
  const mutableState: ArgMutationState = { graphRevision: initialRevision, adaptiveGraphEdges: [], adaptiveGraphVocabulary: [] };
  const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated generic supervisor' });
  const ports: ArgSupervisorPorts = {
    observe: ok,
    propose: () => ({ ...ok(), effect: retry }),
    validate: ok,
    verify: ok,
  };

  try {
    writeFileSync(loopPath, genericLoopSource);
    writeFileSync(graphPath, genericTargetSource);
    writeFileSync(join(root, 'release-edge-vocabulary.yaml'), readFileSync(join(releaseDir, 'release-edge-vocabulary.yaml'), 'utf8'));
    writeFileSync(join(root, 'macrophage-subscriber.yaml'), readFileSync(join(releaseDir, 'macrophage-subscriber.yaml'), 'utf8'));
    writeFileSync(join(loopDir, 'supervisor.yaml'), genericSupervisorSource);
    writeFileSync(join(loopDir, 'recipes.yaml'), genericRecipesSource);

    const result = await runArgSupervisorTick({ loopPath, root, targetGraphId: 'release-loop',
      targetRunId: 'host-reservation-watch-run', gateEventId: 'host-reservation-watch-failed',
      graphRevision: initialRevision, operation: 'reroute', mutableState, ports });

    expect(result.graphRun.path).toEqual(['observe', 'propose', 'validate', 'apply', 'verify', 'done']);
    expect(mutableState.adaptiveGraphEdges).toEqual([expect.objectContaining({
      from: retry.from, to: retry.to, eventId: 'host-reservation-watch-failed', subscriberId: loopId,
    })]);

    writeFileSync(loopPath, genericLoopSource.replace(loopId, 'invalid-identity'));
    const invalidState: ArgMutationState = { graphRevision: initialRevision, adaptiveGraphEdges: [], adaptiveGraphVocabulary: [] };
    await expect(runArgSupervisorTick({ loopPath, root, targetGraphId: 'release-loop',
      targetRunId: 'invalid-supervisor-run', gateEventId: 'invalid-supervisor-failed',
      graphRevision: initialRevision, operation: 'reroute', mutableState: invalidState, ports }))
      .rejects.toThrow('supervisor loop card does not authorize the target graph');
    expect(invalidState.adaptiveGraphEdges).toEqual([]);

    writeFileSync(loopPath, genericLoopSource);
    writeFileSync(graphPath, genericTargetSource.replace(loopId, 'loop:rla@1'));
    const deniedState: ArgMutationState = { graphRevision: initialRevision, adaptiveGraphEdges: [], adaptiveGraphVocabulary: [] };
    await expect(runArgSupervisorTick({ loopPath, root, targetGraphId: 'release-loop',
      targetRunId: 'mismatched-supervisor-run', gateEventId: 'mismatched-supervisor-failed',
      graphRevision: initialRevision, operation: 'reroute', mutableState: deniedState, ports }))
      .rejects.toThrow('target graph has no matching ARG supervisor declaration');
    expect(deniedState.adaptiveGraphEdges).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit release run invokes the RLA ARG tick without the legacy environment opt-in', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-live-no-optin-'));
  const previousOptIn = process.env.ELANOUS_RLA_ARG_LIVE;
  delete process.env.ELANOUS_RLA_ARG_LIVE;
  const commit = 'e'.repeat(40);
  let gateVisits = 0;
  const reply = (value: Record<string, unknown>, exitCode = 0) => ({ exitCode, stdout: JSON.stringify(value), stderr: '' });
  try {
    const runBash: NonNullable<GraphRunOptions['deps']>['runBash'] = async (body, opts) => {
      const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as {
        graphId: string; nodeId: string; runId: string;
        input: Record<string, unknown>; outputs: Record<string, GateResult>;
      };
      if (context.nodeId === 'cutoff') return reply({ outcome: 'ok', cutoff: { sha: commit }, candidatePath: 'fixture:legacy' });
      if (context.nodeId === 'gate-cutover-switch') return reply({ outcome: 'audit' });
      if (context.graphId === 'pod-reuse-prep' && context.nodeId === 'pending')
        return reply({ outcome: 'legacy', verdict: 'legacy', reason: 'fixture', receiptPath: '' });
      if (body.includes('gate-node.ts --json')) {
        gateVisits++;
        return gateVisits === 1
          ? reply({ outcome: 'error', commit, introduced: [], stalledEnv: [], error: 'failure attribution incomplete' }, 2)
          : reply({ outcome: 'ok', commit, introduced: [], stalledEnv: [] });
      }
      if (body.includes('gate-triage-node.ts')) {
        const gate = context.outputs.gate!;
        const triage = classifyGateShadow(gate);
        const plan = planAdaptiveGateHeal({ version: '0.3.7', runId: context.runId, gate, triage,
          sourceOutcome: gate.outcome, gateExecutor: 'host', gatePodPool: 'pool-aws2@aws2:1',
          visitState: { gate: 1, gateTriage: 1 } });
        return reply({ ...triage, prescription: plan.disposition, adaptiveHeal: plan,
          gateExecutionId: context.input.adaptiveGateExecutionId });
      }
      return reply({ outcome: 'ok' });
    };
    const state = await runGraph(join(releaseDir, 'release-loop.yaml'), { runId: 'arg-live-no-optin', input: {
      version: '0.3.7', previousVersion: '0.3.6', gateExecutor: 'host', gatePodPool: 'pool-aws2@aws2:1',
      cutSha: commit, candidatePath: 'fixture:legacy', graphCutover: 'audit',
      graphCutoverEvidenceId: 'ARG-live-no-optin-sim',
    }, deps: { root, runBash, argFeedbackUniverse: 'test' }, quiet: true });
    expect(gateVisits).toBe(2);
    expect(state.path.filter(node => node === 'gate')).toHaveLength(2);
    expect(state.adaptiveGraphEdges).toEqual([expect.objectContaining({ subscriberId: 'loop:rla@1' })]);
    expect(readFileSync(join(root, 'graph-supervisors/actions.jsonl'), 'utf8')).toContain('"verb":"verify"');
  } finally {
    if (previousOptIn === undefined) delete process.env.ELANOUS_RLA_ARG_LIVE;
    else process.env.ELANOUS_RLA_ARG_LIVE = previousOptIn;
    rmSync(root, { recursive: true, force: true });
  }
});
