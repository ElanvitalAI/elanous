import type { WarmPodProvider, WarmReplayInput } from '../task-orchestrator/surfaces/pod-warm-worker-provider.js';
import { resolveWarmPodPhasePlan, type WarmPodPhaseSchedule } from '../task-orchestrator/surfaces/pod-warm-switch.js';
export type PodPhaseSimulationStep =
  | { atMs: number; type: 'reconcile' }
  | { atMs: number; type: 'gate-request'; input: WarmReplayInput; selection: Parameters<WarmPodProvider['request']>[1] };
export interface PodPhaseSimulationObservation {
  atMs: number;
  phase: string;
  target: number;
  actual: number;
  prewarmDurationMs: number;
  firstGateRequestWarmHit?: boolean;
  fallbackReason?: string;
}
/** Replay the real provider boundary; only its clock and external adapters are supplied by the simulation. */
export async function simulatePodPhasePrewarm(input: { schedule: WarmPodPhaseSchedule; provider: Pick<WarmPodProvider, 'reconcilePool' | 'request'>; setNow: (atMs: number) => void; measureNow?: () => number; steps: readonly PodPhaseSimulationStep[]; }): Promise<PodPhaseSimulationObservation[]> {
  const observations: PodPhaseSimulationObservation[] = [];
  for (const step of [...input.steps].sort((left, right) => left.atMs - right.atMs)) {
    input.setNow(step.atMs);
    const plan = resolveWarmPodPhasePlan(step.atMs, input.schedule);
    const target = Object.values(plan.targets).reduce((sum, count) => sum + (count ?? 0), 0);
    if (step.type === 'reconcile') {
      const measureNow = input.measureNow ?? Date.now;
      const startedAt = measureNow();
      const result = await input.provider.reconcilePool();
      observations.push({ atMs: step.atMs, phase: plan.phase, target: result.target, actual: result.ready,
        prewarmDurationMs: measureNow() - startedAt });
      continue;
    }
    const replay = await input.provider.request(step.input, step.selection);
    const warmHit = replay.command !== null && replay.transport.status === 'observed';
    observations.push({ atMs: step.atMs, phase: plan.phase, target, actual: warmHit ? 1 : 0, prewarmDurationMs: 0,
      firstGateRequestWarmHit: warmHit, ...(!warmHit ? { fallbackReason: replay.transport.reason } : {}) });
  }
  return observations;
}
