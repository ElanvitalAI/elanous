import { createHash } from 'node:crypto';
import { isGraphProgressObservation, type GraphProgressObservation,
  type GraphSupervisorObservationInput } from '../graph-progress-observation.js';
import { appBuildNodeFailureSignal, type AppBuildCatalogNode } from './catalog-node-wrappers.js';
import { selectS2Correction, S2_DECLARATION_RULES, S2_GRAPH_IDENTITY } from './s2-declaration-rules.js';
import type { InProcessHandlerContext } from '../in-process-registry.js';

export const SUPERVISOR_CORRECTION_LIMIT = S2_DECLARATION_RULES.limits.maxCorrections;
export const SUPERVISOR_TOTAL_VISIT_LIMIT = S2_DECLARATION_RULES.limits.maxTotalVisits;
export const SUPERVISOR_TARGET_VISIT_LIMIT = S2_DECLARATION_RULES.limits.maxNodeVisits;

type FailedNode = 'files' | 'verify-repair' | 'site-scenario-local' | 'site-scenario-public';
export type AppBuildCorrectionReceipt = Extract<ReturnType<typeof selectS2Correction>, { ok: true }>['receipt'];

export interface AppBuildSupervisorDecision {
  readonly decision: 'correct' | 'failed';
  readonly outcome: string;
  readonly reasonCode: string;
  readonly graphCorrection?: AppBuildCorrectionReceipt;
}

const FAILED_NODES = new Set<FailedNode>([
  'files', 'verify-repair', 'site-scenario-local', 'site-scenario-public',
]);
const isFailedNode = (value: string): value is FailedNode => FAILED_NODES.has(value as FailedNode);
const isArtifactFailureNode = (value: FailedNode): value is Extract<AppBuildCatalogNode['node'], 'files' | 'verify-repair'> =>
  value === S2_GRAPH_IDENTITY.filesNodeId || value === S2_GRAPH_IDENTITY.verifyNodeId;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function validSnapshot(snapshot: GraphSupervisorObservationInput | undefined, graphId: string, runId: string):
  snapshot is GraphSupervisorObservationInput {
  if (!snapshot || snapshot.graphId !== graphId || snapshot.runId !== runId
    || !Array.isArray(snapshot.events) || snapshot.events.length > SUPERVISOR_TOTAL_VISIT_LIMIT
    || !Number.isSafeInteger(snapshot.lastSequence) || snapshot.lastSequence < 0
    || typeof snapshot.truncated !== 'boolean' || typeof snapshot.sequenceGapObserved !== 'boolean'
    || typeof snapshot.outOfOrderIgnored !== 'boolean') return false;
  let previous = 0;
  for (const event of snapshot.events) {
    if (!isGraphProgressObservation(event) || event.graphId !== graphId || event.runId !== runId
      || event.sequence <= previous) return false;
    previous = event.sequence;
  }
  return snapshot.lastSequence === previous;
}

function failureReason(nodeId: FailedNode, output: Record<string, unknown>): string | undefined {
  const evidence = record(output.evidence);
  const attempts = evidence?.attempts;
  if (!Array.isArray(attempts) || attempts.length !== 1) return undefined;
  if (isArtifactFailureNode(nodeId)) {
    return appBuildNodeFailureSignal(nodeId, { ok: false, outcome: 'failed',
      ...(typeof output.error === 'string' ? { error: output.error } : {}),
      ...(evidence ? { evidence } : {}),
    })?.reason;
  }
  const reason = record(attempts[0])?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

const sha256 = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A correction is a signed selector outcome for one declared edge, never a graph rewrite or grant. */
export function consumeAppBuildSupervisorFailure(input: Pick<InProcessHandlerContext,
  'graphId' | 'runId' | 'verifiedOwnerId' | 'graphObservation' | 'graphCorrection' | 'outputs'>): AppBuildSupervisorDecision {
  const failed = (reasonCode: string): AppBuildSupervisorDecision => ({ decision: 'failed', outcome: 'failed', reasonCode });
  if (!input.verifiedOwnerId) return failed('VERIFIED_OWNER_REQUIRED');
  if (input.graphId !== S2_GRAPH_IDENTITY.graphId || !validSnapshot(input.graphObservation, input.graphId, input.runId))
    return failed('OBSERVATION_INVALID');
  const budget = input.graphCorrection;
  if (!budget || !Number.isSafeInteger(budget.correctionCount) || !Number.isSafeInteger(budget.totalVisits)
    || !Number.isSafeInteger(budget.maxCorrections) || !Number.isSafeInteger(budget.maxTotalVisits)
    || !Number.isSafeInteger(budget.remainingSteps) || !Number.isSafeInteger(budget.nowMs)
    || !Number.isSafeInteger(budget.deadlineAtMs)
    || !record(budget.nodeVisits) || !Array.isArray(budget.priorFailedEventIds)
    || typeof budget.requiresVisitorWrite !== 'boolean'
    || !/^[a-f0-9]{64}$/u.test(budget.inputSha256)
    || !/^[a-f0-9]{64}$/u.test(budget.catalogSnapshotDigest)) return failed('TRUSTED_BUDGET_MISSING');
  if (Object.values(budget.nodeVisits).some(visits => !Number.isSafeInteger(visits)
    || visits < 0 || visits > SUPERVISOR_TARGET_VISIT_LIMIT)) return failed('NODE_VISIT_LIMIT');
  const latest = [...input.graphObservation.events].reverse()
    .find((event: GraphProgressObservation) => event.nodeId !== S2_GRAPH_IDENTITY.supervisorNodeId);
  if (!latest || latest.kind !== 'failed' || !isFailedNode(latest.nodeId)) return failed('NO_MATCHING_FAILURE');
  const output = record(input.outputs[latest.nodeId]);
  if (!output || output.outcome !== 'failed') return failed('FAILURE_OUTPUT_MISMATCH');
  const reasonCode = failureReason(latest.nodeId, output);
  if (!reasonCode) return failed('UNSUPPORTED_FAILURE');
  if (budget.remainingSteps <= 0) return failed('VISIT_BUDGET_EXHAUSTED');
  const failure = { graphId: input.graphId, runId: input.runId, nodeId: latest.nodeId,
    eventId: latest.eventId, sequence: latest.sequence, reasonCode,
    inputSha256: budget.inputSha256, outputSha256: sha256(output) };
  // Both the lifecycle event and failed output were checked above against the runner-owned snapshot.
  const selected = selectS2Correction(failure, {
    graphId: input.graphId, runId: input.runId, verifiedOwnerId: input.verifiedOwnerId,
    inputSha256: budget.inputSha256, observedFailures: [failure],
    consumedEventIds: budget.priorFailedEventIds, correctionsUsed: budget.correctionCount,
    maxCorrections: budget.maxCorrections, visitsUsed: budget.totalVisits,
    maxTotalVisits: budget.maxTotalVisits, nowMs: budget.nowMs,
    deadlineAtMs: budget.deadlineAtMs, requiresVisitorWrite: budget.requiresVisitorWrite,
  });
  if (!selected.ok) return failed(selected.code);
  const targetVisits = budget.nodeVisits[selected.receipt.targetNodeId] ?? 0;
  if (!Number.isSafeInteger(targetVisits) || targetVisits >= SUPERVISOR_TARGET_VISIT_LIMIT)
    return failed('TARGET_VISIT_LIMIT');
  return { decision: 'correct', outcome: selected.outcome, reasonCode,
    graphCorrection: selected.receipt };
}
