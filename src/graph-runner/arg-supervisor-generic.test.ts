import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyGateShadow } from '../../scripts/release-loop/gate-triage-node.js';
import { planAdaptiveGateHeal } from '../../scripts/release-loop/adaptive-gate-heal.js';
import type { GateResult } from '../../scripts/release-loop/gate-types.js';
import { runArgSupervisorTick, type ArgMutationState, type ArgSupervisorPorts } from './arg-supervisor.js';
import { claimIncident, createMemoryIncidentClaimStore, isIncidentClaimCurrent, withIncidentClaim } from '../supervision/incident-claim.js';
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
// Source: graph-next implementation §2.6 — same-incident two-supervisor fake race fixtures.
const alphaLoopId = 'loop:race-alpha-watch@1';
const betaLoopId = 'loop:race-beta-watch@1';
const healerLoopId = 'loop:race-healer@1';
const loopCard = (id: string) => genericLoopSource.replace(`id: '${loopId}'`, `id: '${id}'`);
const raceTargetSource = `graph_id: release-loop
version: 1
supervisors:
  - { ref: '${alphaLoopId}', role: primary, scope: run, authority: [reroute, add-node, repair, hitl], requires: [elanous.dev/arg] }
  - { ref: '${healerLoopId}', role: healer, scope: run, authority: [cleanup] }
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
type LedgerRecord = { readonly verb: string; readonly outcome: string; readonly gateEventId: string;
  readonly beforeRevision?: number; readonly graphRevision?: number | null };
const readLedger = (root: string): readonly LedgerRecord[] =>
  readFileSync(join(root, 'graph-supervisors/actions.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as LedgerRecord);
const writeRaceFixtures = (root: string): { readonly alphaPath: string; readonly betaPath: string } => {
  const alphaDir = join(root, 'race-alpha-watch');
  const betaDir = join(root, 'race-beta-watch');
  mkdirSync(alphaDir, { recursive: true });
  mkdirSync(betaDir, { recursive: true });
  writeFileSync(join(root, 'release-loop.yaml'), raceTargetSource);
  writeFileSync(join(root, 'release-edge-vocabulary.yaml'), readFileSync(join(releaseDir, 'release-edge-vocabulary.yaml'), 'utf8'));
  writeFileSync(join(root, 'macrophage-subscriber.yaml'), readFileSync(join(releaseDir, 'macrophage-subscriber.yaml'), 'utf8'));
  for (const dir of [alphaDir, betaDir]) {
    writeFileSync(join(dir, 'loop.yaml'), loopCard(dir === alphaDir ? alphaLoopId : betaLoopId));
    writeFileSync(join(dir, 'supervisor.yaml'), genericSupervisorSource);
    writeFileSync(join(dir, 'recipes.yaml'), genericRecipesSource);
  }
  return { alphaPath: join(alphaDir, 'loop.yaml'), betaPath: join(betaDir, 'loop.yaml') };
};
const probePorts = (log: string[]): ArgSupervisorPorts => {
  const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated generic supervisor' });
  return {
    observe: () => { log.push('observe'); return ok(); },
    propose: () => { log.push('propose'); return { ...ok(), effect: retry }; },
    validate: () => { log.push('validate'); return ok(); },
    verify: () => { log.push('verify'); return ok(); },
  };
};

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

// Source: graph-next implementation §2.6 — in a two-supervisor same-incident fake race only one
// owner may apply effects; out-of-authority graphs, different run IDs, and expired claims are refused.
test('a same-incident supervisor race refuses every non-owner claimant without applying effects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-generic-race-'));
  const { alphaPath, betaPath } = writeRaceFixtures(root);
  const store = createMemoryIncidentClaimStore();
  const clock = { nowMs: 10_000 };
  const now = () => clock.nowMs;
  const leaseMs = 1_000;
  const contendedOrder = [healerLoopId, alphaLoopId] as const;
  const freshState = (): ArgMutationState =>
    ({ graphRevision: initialRevision, adaptiveGraphEdges: [], adaptiveGraphVocabulary: [] });
  try {
    // The uncontended owner applies the effect and journals claim and apply as distinct records.
    const owned = freshState();
    await runArgSupervisorTick({ loopPath: alphaPath, root, targetGraphId: 'release-loop',
      targetRunId: 'race-run', gateEventId: 'evt-owned', graphRevision: initialRevision, operation: 'reroute',
      mutableState: owned, incidentClaim: { store, now, leaseMs }, ports: probePorts([]) });
    expect(owned.adaptiveGraphEdges).toEqual([expect.objectContaining({ eventId: 'evt-owned', subscriberId: alphaLoopId })]);
    const ownedRecords = readLedger(root).filter(record => record.gateEventId === 'evt-owned');
    expect(ownedRecords.find(record => record.verb === 'claim'))
      .toMatchObject({ outcome: 'claimed', beforeRevision: initialRevision, graphRevision: initialRevision });
    expect(ownedRecords.find(record => record.verb === 'apply'))
      .toMatchObject({ outcome: 'ok', beforeRevision: initialRevision, graphRevision: initialRevision + 1 });

    // The healer supervisor holds the live claim; the racing ARG tick is denied before any effect.
    const healerClaim = await claimIncident(store, { incidentId: 'release-loop:race-run:evt-contended',
      ownerLoopRef: healerLoopId, ownerOrder: contendedOrder, now, leaseMs });
    if (healerClaim.disposition !== 'claimed') throw new Error('expected the healer to hold the contended claim');
    const raceLog: string[] = [];
    const racerState = freshState();
    await expect(runArgSupervisorTick({ loopPath: alphaPath, root, targetGraphId: 'release-loop',
      targetRunId: 'race-run', gateEventId: 'evt-contended', graphRevision: initialRevision, operation: 'reroute',
      mutableState: racerState, incidentClaim: { store, ownerOrder: contendedOrder, now, leaseMs },
      ports: probePorts(raceLog) }))
      .rejects.toThrow('RLA incident claim denied: another owner holds the active incident lease');
    expect(raceLog).toEqual([]);
    expect(racerState).toEqual(freshState());
    expect(readLedger(root).some(record => record.gateEventId === 'evt-contended')).toBe(false);

    // 권한 밖 그래프: an undeclared supervisor and an unsupervised graph are both refused.
    const betaLog: string[] = [];
    const betaState = freshState();
    await expect(runArgSupervisorTick({ loopPath: betaPath, root, targetGraphId: 'release-loop',
      targetRunId: 'race-run', gateEventId: 'evt-contended', graphRevision: initialRevision, operation: 'reroute',
      mutableState: betaState, incidentClaim: { store, ownerOrder: contendedOrder, now, leaseMs },
      ports: probePorts(betaLog) }))
      .rejects.toThrow('target graph has no matching ARG supervisor declaration');
    await expect(runArgSupervisorTick({ loopPath: betaPath, root, targetGraphId: 'unrelated-graph',
      targetRunId: 'race-run', gateEventId: 'evt-contended', graphRevision: initialRevision, operation: 'reroute',
      mutableState: betaState, incidentClaim: { store, ownerOrder: contendedOrder, now, leaseMs },
      ports: probePorts(betaLog) }))
      .rejects.toThrow('supervisor loop card does not authorize the target graph');
    expect(betaLog).toEqual([]);
    expect(betaState).toEqual(freshState());

    // 다른 run ID: a different run is a different incident, so the racer is not its first owner,
    // and the live claim token cannot authorize fenced effects under the other run's incident.
    await expect(runArgSupervisorTick({ loopPath: alphaPath, root, targetGraphId: 'release-loop',
      targetRunId: 'other-run', gateEventId: 'evt-contended', graphRevision: initialRevision, operation: 'reroute',
      mutableState: freshState(), incidentClaim: { store, ownerOrder: contendedOrder, now, leaseMs },
      ports: probePorts([]) }))
      .rejects.toThrow('RLA incident claim denied: requested owner is not first in the incident order');
    expect(await isIncidentClaimCurrent(store, { incidentId: 'release-loop:race-run:evt-contended',
      claimToken: healerClaim.claim.claimToken, now })).toBe(true);
    expect(await isIncidentClaimCurrent(store, { incidentId: 'release-loop:other-run:evt-contended',
      claimToken: healerClaim.claim.claimToken, now })).toBe(false);
    expect((await withIncidentClaim(store, { incidentId: 'release-loop:other-run:evt-contended',
      claimToken: healerClaim.claim.claimToken, now }, () => 'effect-applied')).current).toBe(false);

    // 만료 claim: an expired owner cannot reclaim its own incident; only the successor escalates.
    const staleClaim = await claimIncident(store, { incidentId: 'release-loop:stale-run:evt-stale',
      ownerLoopRef: alphaLoopId, ownerOrder: [alphaLoopId, healerLoopId] as const, now, leaseMs });
    if (staleClaim.disposition !== 'claimed') throw new Error('expected alpha to hold the stale claim');
    clock.nowMs = 11_500;
    await expect(runArgSupervisorTick({ loopPath: alphaPath, root, targetGraphId: 'release-loop',
      targetRunId: 'stale-run', gateEventId: 'evt-stale', graphRevision: initialRevision, operation: 'reroute',
      mutableState: freshState(), incidentClaim: { store, ownerOrder: [alphaLoopId, healerLoopId] as const,
        now, leaseMs }, ports: probePorts([]) }))
      .rejects.toThrow('RLA incident claim denied: requested owner is not the configured escalation successor');

    // A claim that expires the moment it is granted fences the tick before any port or ledger write.
    let steppedNow = 0;
    await expect(runArgSupervisorTick({ loopPath: alphaPath, root, targetGraphId: 'release-loop',
      targetRunId: 'fenced-run', gateEventId: 'evt-fenced', graphRevision: initialRevision, operation: 'reroute',
      mutableState: freshState(), incidentClaim: { store, now: () => (steppedNow += 10_000), leaseMs },
      ports: probePorts([]) }))
      .rejects.toThrow('RLA incident claim expired or was fenced by an escalation');
    expect(readLedger(root).some(record => record.gateEventId === 'evt-fenced')).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Source: graph-next implementation §2.6 — the escalation record (상신 기록) and the effect record
// (적용 기록) stay distinct while exactly one owner applies the contended incident's effect.
test('an expired incident escalates to its successor, who alone applies the effect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arg-generic-escalation-'));
  const { alphaPath } = writeRaceFixtures(root);
  const store = createMemoryIncidentClaimStore();
  const clock = { nowMs: 10_000 };
  const now = () => clock.nowMs;
  const leaseMs = 1_000;
  const contendedOrder = [healerLoopId, alphaLoopId] as const;
  try {
    const healerClaim = await claimIncident(store, { incidentId: 'release-loop:race-run:evt-contended',
      ownerLoopRef: healerLoopId, ownerOrder: contendedOrder, now, leaseMs });
    if (healerClaim.disposition !== 'claimed') throw new Error('expected the healer to hold the contended claim');
    clock.nowMs = 11_500; // The healer lease expired; alpha is the configured escalation successor.
    const log: string[] = [];
    const state: ArgMutationState = { graphRevision: initialRevision, adaptiveGraphEdges: [], adaptiveGraphVocabulary: [] };
    const escalated = await runArgSupervisorTick({ loopPath: alphaPath, root, targetGraphId: 'release-loop',
      targetRunId: 'race-run', gateEventId: 'evt-contended', graphRevision: initialRevision, operation: 'reroute',
      mutableState: state, incidentClaim: { store, ownerOrder: contendedOrder, now, leaseMs },
      ports: probePorts(log) });
    expect(log).toEqual(['observe', 'propose', 'validate', 'verify']);
    expect(escalated.resultType).toBe('complete');
    expect(state.graphRevision).toBe(initialRevision + 1);
    expect(state.adaptiveGraphEdges).toEqual([expect.objectContaining({
      eventId: 'evt-contended', subscriberId: alphaLoopId })]);

    // One ownership record and one effect record; the claim record precedes apply and moves no revision.
    const records = readLedger(root).filter(record => record.gateEventId === 'evt-contended');
    const claimRecords = records.filter(record => record.verb === 'claim');
    const applyRecords = records.filter(record => record.verb === 'apply');
    expect(claimRecords).toEqual([expect.objectContaining({ outcome: 'escalated',
      beforeRevision: initialRevision, graphRevision: initialRevision })]);
    expect(applyRecords).toEqual([expect.objectContaining({ outcome: 'ok',
      beforeRevision: initialRevision, graphRevision: initialRevision + 1 })]);
    expect(records.indexOf(claimRecords[0]!)).toBeLessThan(records.indexOf(applyRecords[0]!)); // 출처: 내부 문서 `graph-next-implementation` §2.6 상신 기록이 적용 기록보다 먼저 남는다

    // The escalation record lives in the claim ledger's history with both lease windows; the
    // effect record lives in the action ledger with the revision advance — the two never merge.
    const after = await claimIncident(store, { incidentId: 'release-loop:race-run:evt-contended',
      ownerLoopRef: alphaLoopId, ownerOrder: contendedOrder, now, leaseMs });
    if (after.disposition !== 'denied') throw new Error('expected the escalated incident to be completed');
    expect(after.claim?.history).toEqual([
      { ownerLoopRef: healerLoopId, claimedAtMs: 10_000, expiresAtMs: 11_000 },
      { ownerLoopRef: alphaLoopId, claimedAtMs: 11_500, expiresAtMs: 12_500 },
    ]);
    expect(after.claim?.completedAtMs).toBe(11_500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
