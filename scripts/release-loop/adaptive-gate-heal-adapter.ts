import type { GraphEvent, GraphEventBus, GraphEventScope } from '../../src/graph-runner/graph-events.js';
import type { GateResult } from './gate-node.js';
import { planAdaptiveGateHeal, type AdaptiveGateHealPlan, type AdaptiveGateRepairNode, type AdaptiveGateImageRepairNode } from './adaptive-gate-heal.js';
import type { GateTriageShadow } from './gate-triage-node.js';

export const RELEASE_GATE_FAILED_EVENT = 'release.gate.failed';

export interface AdaptiveGateHealAppendNodeRequest {
  readonly graphId: string;
  readonly runId: string;
  /** Stable bus event identity; append idempotency is keyed by (graphId, runId, eventId). */
  readonly eventId: string;
  readonly afterNodeId: 'gate-triage';
  readonly node: AdaptiveGateRepairNode | AdaptiveGateImageRepairNode;
  readonly resumeFrom: string;
  readonly rerunGateAt: 'gate';
  readonly visitState: { readonly gate: number; readonly gateTriage: number };
  readonly visitLimits: { readonly gate: 2; readonly gateTriage: 2 };
  readonly maxRepairRetries: 1;
}

export interface AdaptiveGateHealAppendNodeReceipt {
  readonly disposition: 'appended' | 'already-appended';
  readonly graphRevision: number;
}

/** Implemented by the graph-runner owner; appends durably and schedules the resume before resolving. */
export type AdaptiveGateHealAppendNode = (request: AdaptiveGateHealAppendNodeRequest) =>
  Promise<AdaptiveGateHealAppendNodeReceipt>;

export interface AdaptiveGateHealEventData {
  readonly version: string;
  readonly gate: GateResult;
  readonly triage: GateTriageShadow;
  readonly sourceOutcome?: GateResult['outcome'] | 'fail';
  readonly gateExecutor?: 'host' | 'pod';
  readonly gatePodPool?: string;
  readonly visitState?: { readonly gate: number; readonly gateTriage: number };
}

export interface AdaptiveGateHealAdapterDeps {
  readonly appendNode: AdaptiveGateHealAppendNode;
  readonly onPlan?: (plan: AdaptiveGateHealPlan, event: GraphEvent) => void | Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function eventData(event: GraphEvent): AdaptiveGateHealEventData {
  const value = event.data;
  if (!isRecord(value) || typeof value.version !== 'string' || !value.version.trim() ||
    !isRecord(value.gate) || !isRecord(value.triage)) {
    throw new Error('release.gate.failed requires version, gate result, and triage evidence');
  }
  const rawGate = value.gate as Record<string, unknown>;
  const rawGateOutcome = rawGate.outcome;
  const gate = (rawGateOutcome === 'fail' ? { ...rawGate, outcome: 'regression' } : rawGate) as unknown as GateResult;
  const triage = value.triage as unknown as GateTriageShadow;
  if (!['ok', 'regression', 'error', 'fail'].includes(String(rawGateOutcome)) || typeof gate.commit !== 'string' ||
    !Array.isArray(gate.introduced) || !gate.introduced.every((id) => typeof id === 'string') ||
    !['unmeasured', 'load', 'env', 'regression', 'clean', 'exhausted'].includes(triage.classification) ||
    typeof triage.commit !== 'string' || !Array.isArray(triage.introduced) || !triage.introduced.every((id) => typeof id === 'string')) {
    throw new Error('release.gate.failed contains invalid gate or triage evidence');
  }
  const rawVisits = value.visitState;
  const visitState = isRecord(rawVisits) && Number.isSafeInteger(rawVisits.gate) && Number.isSafeInteger(rawVisits.gateTriage)
    ? { gate: rawVisits.gate as number, gateTriage: rawVisits.gateTriage as number } : undefined;
  const sourceOutcome = value.sourceOutcome ?? (rawGateOutcome === 'fail' ? 'fail' : undefined);
  const gateExecutor = value.gateExecutor;
  const gatePodPool = typeof value.gatePodPool === 'string' && value.gatePodPool.trim() ? value.gatePodPool : undefined;
  return { version: value.version, gate, triage,
    ...(sourceOutcome === 'ok' || sourceOutcome === 'regression' || sourceOutcome === 'error' || sourceOutcome === 'fail'
      ? { sourceOutcome } : {}),
    ...(gateExecutor === 'host' || gateExecutor === 'pod' ? { gateExecutor } : {}),
    ...(gatePodPool ? { gatePodPool } : {}),
    ...(visitState ? { visitState } : {}) };
}

/** Consumes a real release.gate.failed envelope, plans through ARG core, then appends and resumes only repair plans. */
export function registerAdaptiveGateHealAdapter(
  bus: GraphEventBus,
  scope: GraphEventScope,
  deps: AdaptiveGateHealAdapterDeps,
): () => void {
  if (!bus.hasType(RELEASE_GATE_FAILED_EVENT)) bus.registerType(RELEASE_GATE_FAILED_EVENT);
  return bus.subscribe(async (event) => {
    if (event.type !== RELEASE_GATE_FAILED_EVENT || event.graphId !== scope.graphId || event.runId !== scope.runId ||
      event.source.kind !== 'node' || event.source.nodeId !== 'gate-triage' ||
      scope.dryRun === true || event.data?.dryRun === true) return;
    const input = eventData(event);
    const plan = planAdaptiveGateHeal({ ...input, runId: event.runId });
    await deps.onPlan?.(plan, event);
    if (plan.disposition.action !== 'append-repair-and-resume' && plan.disposition.action !== 'append-image-repair-and-resume') return;
    const disposition = plan.disposition;
    const receipt = await deps.appendNode({ graphId: event.graphId, runId: event.runId, eventId: event.eventId,
      afterNodeId: 'gate-triage', node: disposition.repairNode, resumeFrom: disposition.resumeFrom,
      rerunGateAt: disposition.rerunGateAt, visitState: disposition.visitState,
      visitLimits: disposition.visitLimits, maxRepairRetries: disposition.maxRepairRetries });
    if (!Number.isSafeInteger(receipt.graphRevision) || receipt.graphRevision < 1 ||
      !['appended', 'already-appended'].includes(receipt.disposition)) {
      throw new Error(`ARG appendNode returned an invalid receipt for ${disposition.repairNode.nodeId}`);
    }
  }, { type: RELEASE_GATE_FAILED_EVENT });
}
