import { allocatePodPhaseCandidates, resolvePodPhasePlan, type PodPhasePrewarmConfig,
  type PodPhaseSchedule, type PodPhaseTargets } from '../task-orchestrator/surfaces/pod-warm-switch.js';

/** Deterministic schedule replay for the production prewarm phase planner. */
export function simulatePodPhasePrewarm(input: { now: string; schedules: readonly PodPhaseSchedule[];
  candidates?: readonly { id: string; kind?: 'gate' | 'implementation'; cutSha: string; lockHash: string }[];
  config?: PodPhasePrewarmConfig; targetOverride?: PodPhaseTargets }) {
  const plan = resolvePodPhasePlan(input.schedules, Date.parse(input.now), input.config);
  const allocations = input.candidates ? allocatePodPhaseCandidates(input.candidates,
    input.targetOverride ?? plan.target, input.config ?? {}) : [];
  return { ...plan, assignments: allocations.map(row => ({ id: row.candidate.id, kind: row.kind })) };
}
