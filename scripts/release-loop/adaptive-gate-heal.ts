import { createHash } from 'node:crypto';
import type { GateResult } from './gate-types.js';
import type { GateTriageShadow } from './gate-triage-types.js';
import { macrophageEvidenceMatchesObservedGate, planMacrophageRepairLadder, type MacrophageRepairLadderDecision, type MacrophageRepairLadderInput } from '../../src/release-loop/macrophage-repair-ladder.js';

export type AdaptiveHealEventName =
  | 'gate.result.received'
  | 'gate.failures.attributed'
  | 'heal.classified'
  | 'heal.repair-node.planned'
  | 'heal.image-repair-node.planned'
  | 'heal.graph-append.planned'
  | 'heal.resume.decided'
  | 'heal.pod-retry.decided'
  | 'heal.hitl.decided'
  | 'heal.noop.decided'
  | 'heal.macrophage-ladder.decided';

export interface AdaptiveHealEvent {
  name: AdaptiveHealEventName;
  data: Record<string, unknown>;
}

export interface AdaptiveHealInput {
  version: string;
  runId: string;
  gate: GateResult;
  triage: GateTriageShadow;
  sourceOutcome?: GateResult['outcome'] | 'fail';
  gateExecutor?: 'host' | 'pod';
  gatePodPool?: string;
  /** Actual visits already consumed when this node executes; absence is unmeasured and fails closed. */
  visitState?: { gate: number; gateTriage: number };
  /** Optional bounded repair-ladder facts supplied by the release-loop adapter. */
  macrophageRepairLadder?: unknown;
}

export interface AdaptiveGateRepairNode {
  nodeId: string;
  kind: 'agent';
  recipe: 'cmd:gate-repair';
  maxVisits: 1;
  input: { version: string; runId: string; commit: string; failureIds: string[] };
}

export interface AdaptiveGateImageRepairNode {
  nodeId: string;
  kind: 'agent';
  recipe: 'cmd:gate-image-repair';
  maxVisits: 1;
  input: { version: string; runId: string; commit: string; pool: string;
    failureCode: 'pod-gate-missing-cut-image-pin' | 'pod-gate-missing-run-scope' };
}

export type AdaptiveHealDisposition =
  | { action: 'append-repair-and-resume'; repairNode: AdaptiveGateRepairNode; resumeFrom: string; rerunGateAt: 'gate'; visitState: { gate: number; gateTriage: number }; visitLimits: { gate: 2; gateTriage: 2 }; maxRepairRetries: 1 }
  | { action: 'append-image-repair-and-resume'; repairNode: AdaptiveGateImageRepairNode; resumeFrom: string; rerunGateAt: 'gate'; visitState: { gate: number; gateTriage: number }; visitLimits: { gate: 2; gateTriage: 2 }; maxRepairRetries: 1 }
  | { action: 'rerun-pod'; reason: string; resumeFrom: 'gate'; gatePodPool: string;
      visitState: { gate: number; gateTriage: number }; visitLimits: { gate: 2; gateTriage: 2 } }
  | { action: 'decision-required'; reason: string }
  | { action: 'no-op'; reason: string };

export interface AdaptiveGateHealPlan {
  attribution: { commit: string; failureIds: string[]; classification: GateTriageShadow['classification'] };
  disposition: AdaptiveHealDisposition;
  events: AdaptiveHealEvent[];
  macrophageRepairLadder?: MacrophageRepairLadderDecision;
}

function repairNodeId(commit: string, failureIds: readonly string[]): string {
  const identity = createHash('sha256').update(JSON.stringify({ commit, failureIds: [...failureIds].sort() })).digest('hex').slice(0, 12);
  return `gate-repair-${identity}`;
}

function imageRepairNodeId(runId: string, commit: string): string {
  const identity = createHash('sha256').update(JSON.stringify({ runId, commit, repair: 'cut-image-pin' })).digest('hex').slice(0, 12);
  return `gate-image-repair-${identity}`;
}

/** Pure ARG core: consume an attributed gate result and plan repair-node append plus graph resume. */
export function planAdaptiveGateHeal(input: AdaptiveHealInput): AdaptiveGateHealPlan {
  const triage = input.triage;
  const failureIds = [...triage.introduced].sort();
  const attribution = { commit: triage.commit, failureIds, classification: triage.classification };
  const events: AdaptiveHealEvent[] = [
    { name: 'gate.result.received', data: { runId: input.runId, version: input.version, commit: triage.commit, outcome: input.sourceOutcome ?? input.gate.outcome } },
    { name: 'gate.failures.attributed', data: { commit: triage.commit, failureIds } },
    { name: 'heal.classified', data: { classification: triage.classification, reason: triage.reason } },
  ];
  let macrophageRepairLadder: MacrophageRepairLadderDecision | undefined;
  const visitState = input.visitState;
  const visitLimits = { gate: 2 as const, gateTriage: 2 as const };
  if (!visitState || !Number.isSafeInteger(visitState.gate) || !Number.isSafeInteger(visitState.gateTriage)
    || visitState.gate < 1 || visitState.gateTriage < 1
    || visitState.gate >= visitLimits.gate || visitState.gateTriage >= visitLimits.gateTriage) {
    const disposition = { action: 'decision-required' as const, reason: 'adaptive repair retry budget is exhausted or visit state is invalid' };
    events.push({ name: 'heal.hitl.decided', data: disposition });
    return { attribution, disposition, events, ...(macrophageRepairLadder ? { macrophageRepairLadder } : {}) };
  }
  if (Object.prototype.hasOwnProperty.call(input, 'macrophageRepairLadder')) {
    const rawLadder = input.macrophageRepairLadder as unknown;
    if (!rawLadder || typeof rawLadder !== 'object' || Array.isArray(rawLadder)) {
      const disposition = { action: 'decision-required' as const,
        reason: 'repair-ladder input is malformed; operator decision required' };
      events.push({ name: 'heal.hitl.decided', data: disposition });
      return { attribution, disposition, events };
    }
    const ladderInput = rawLadder as MacrophageRepairLadderInput;
    const ladderFailureIds = ladderInput.failureIds;
    const sameFailures = typeof ladderInput === 'object' && !Array.isArray(ladderInput)
      && ladderInput.runId === input.runId
      && Array.isArray(ladderFailureIds) && ladderFailureIds.every((id) => typeof id === 'string')
      && JSON.stringify([...ladderFailureIds].sort()) === JSON.stringify([...triage.failureIds].sort());
    const evidenceMatches = sameFailures
      && macrophageEvidenceMatchesObservedGate(ladderInput.evidence, input.gate, triage);
    if (!evidenceMatches) {
      const disposition = { action: 'decision-required' as const,
        reason: 'repair-ladder evidence failed run, failure-ID, or observed-gate verification' };
      events.push({ name: 'heal.hitl.decided', data: disposition });
      return { attribution, disposition, events };
    }
    macrophageRepairLadder = planMacrophageRepairLadder(ladderInput);
    events.push({ name: 'heal.macrophage-ladder.decided', data: { decision: macrophageRepairLadder } });
    if (macrophageRepairLadder.step === 'R0-remeasure') {
      const disposition = { action: 'decision-required' as const, reason: 'same-slice isolated remeasurement executor is not connected' };
      events.push({ name: 'heal.hitl.decided', data: disposition });
      return { attribution, disposition, events, macrophageRepairLadder };
    }
    if (macrophageRepairLadder.step === 'R1-single-file' || macrophageRepairLadder.step === 'R2-split-files') {
      const disposition = { action: 'decision-required' as const,
        reason: `${macrophageRepairLadder.step} needs a cut-append constrained repair executor before graph append` };
      events.push({ name: 'heal.hitl.decided', data: disposition });
      return { attribution, disposition, events, macrophageRepairLadder };
    }
    if (macrophageRepairLadder.step === 'R3-revert-proposal' || macrophageRepairLadder.step === 'R4-hitl'
      || macrophageRepairLadder.step === 'none') {
      const disposition = { action: 'decision-required' as const, reason: macrophageRepairLadder.reason };
      events.push({ name: 'heal.hitl.decided', data: disposition });
      return { attribution, disposition, events, macrophageRepairLadder };
    }
  }
  const failureCode = input.gate.error?.includes('pod-gate-missing-cut-image-pin') ? 'pod-gate-missing-cut-image-pin'
    : input.gate.error?.includes('pod-gate-missing-run-scope') ? 'pod-gate-missing-run-scope' : undefined;
  const missingCutImageScope = failureCode !== undefined;
  if (input.gate.outcome === 'error' && missingCutImageScope
    && input.gateExecutor === 'pod' && input.gatePodPool?.trim() && failureIds.length === 0) {
    const nodeId = imageRepairNodeId(input.runId, triage.commit);
    const repairNode: AdaptiveGateImageRepairNode = { nodeId, kind: 'agent', recipe: 'cmd:gate-image-repair', maxVisits: 1,
      input: { version: input.version, runId: input.runId, commit: triage.commit, pool: input.gatePodPool, failureCode: failureCode! } };
    const disposition = { action: 'append-image-repair-and-resume' as const, repairNode, resumeFrom: nodeId,
      rerunGateAt: 'gate' as const, visitState, visitLimits, maxRepairRetries: 1 as const };
    events.push(
      { name: 'heal.image-repair-node.planned', data: { nodeId, commit: triage.commit, pool: input.gatePodPool } },
      { name: 'heal.graph-append.planned', data: { after: 'gate-triage', nodeId } },
      { name: 'heal.resume.decided', data: { from: nodeId, rerunGateAt: 'gate' } },
    );
    return { attribution, disposition, events, ...(macrophageRepairLadder ? { macrophageRepairLadder } : {}) };
  }
  const unattributedHostFailure = input.gateExecutor === 'host'
    && input.gate.outcome === 'error' && failureIds.length === 0
    && (input.gate.error?.includes('failure attribution') === true
      || input.gate.stalledShards?.some((shard) => shard.reason === 'unattributed') === true);
  if (unattributedHostFailure && input.gatePodPool?.trim()) {
    const disposition = { action: 'rerun-pod' as const, reason: 'host gate attribution incomplete', resumeFrom: 'gate' as const,
      gatePodPool: input.gatePodPool, visitState, visitLimits };
    events.push({ name: 'heal.pod-retry.decided', data: disposition });
    return { attribution, disposition, events, ...(macrophageRepairLadder ? { macrophageRepairLadder } : {}) };
  }
  if (triage.classification === 'regression' && failureIds.length > 0) {
    const nodeId = repairNodeId(triage.commit, failureIds);
    const repairNode: AdaptiveGateRepairNode = { nodeId, kind: 'agent', recipe: 'cmd:gate-repair', maxVisits: 1,
      input: { version: input.version, runId: input.runId, commit: triage.commit, failureIds } };
    const disposition = { action: 'append-repair-and-resume' as const, repairNode, resumeFrom: nodeId,
      rerunGateAt: 'gate' as const, visitState, visitLimits, maxRepairRetries: 1 as const };
    events.push(
      { name: 'heal.repair-node.planned', data: { nodeId, failureIds } },
      { name: 'heal.graph-append.planned', data: { after: 'gate-triage', nodeId } },
      { name: 'heal.resume.decided', data: { from: nodeId, rerunGateAt: 'gate' } },
    );
    return { attribution, disposition, events, ...(macrophageRepairLadder ? { macrophageRepairLadder } : {}) };
  }
  if (triage.classification === 'clean') {
    const disposition = { action: 'no-op' as const, reason: triage.reason };
    events.push({ name: 'heal.noop.decided', data: disposition });
    return { attribution, disposition, events, ...(macrophageRepairLadder ? { macrophageRepairLadder } : {}) };
  }
  const disposition = { action: 'decision-required' as const, reason: `${triage.classification}: ${triage.reason}` };
  events.push({ name: 'heal.hitl.decided', data: disposition });
  return { attribution, disposition, events, ...(macrophageRepairLadder ? { macrophageRepairLadder } : {}) };
}
