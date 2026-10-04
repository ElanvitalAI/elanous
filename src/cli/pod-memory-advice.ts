import { readPodMemoryMeasurement, type MemoryMeasurement } from '../../scripts/measure-pod-memory-by-goal.js';

export type PodMemoryAdvice = {
  window: MemoryMeasurement['window'];
  sources: MemoryMeasurement['sources'];
  byGoalType: Array<{
    goalType: MemoryMeasurement['byGoalType'][number]['goalType'];
    recommended: 'standard' | 'high';
    limit: '16Gi' | '32Gi';
    reason: string;
    evidence: MemoryMeasurement['byGoalType'][number];
  }>;
};

/** Advice only: the launch selector and its configuration remain independent. */
export function advisePodMemory(measurement: MemoryMeasurement): PodMemoryAdvice {
  return {
    window: measurement.window,
    sources: measurement.sources,
    byGoalType: measurement.byGoalType.map((evidence) => {
      const high = evidence.oomKilled > 0 || (evidence.peakMiB.p95 !== null && evidence.peakMiB.p95 >= 16 * 1024);
      const reason = evidence.oomKilled > 0
        ? `${evidence.oomKilled}/${evidence.runs} OOMKilled; measured peak p50=${evidence.peakMiB.p50 ?? 'n/a'} MiB, p95=${evidence.peakMiB.p95 ?? 'n/a'} MiB (${evidence.measured}/${evidence.runs} measured)`
        : evidence.measured === 0
          ? `No measured peaks (${evidence.missingPeak}/${evidence.runs} missing); standard is provisional, not evidence of safety`
          : `Measured peak p50=${evidence.peakMiB.p50} MiB, p95=${evidence.peakMiB.p95} MiB (${evidence.measured}/${evidence.runs} measured, ${evidence.missingPeak} missing); ${high ? 'at or above' : 'below'} 16Gi`;
      return { goalType: evidence.goalType, recommended: high ? 'high' as const : 'standard' as const,
        limit: high ? '32Gi' as const : '16Gi' as const, reason, evidence };
    }),
  };
}

export function readPodMemoryAdvice(path?: string): PodMemoryAdvice {
  return advisePodMemory(readPodMemoryMeasurement(path));
}
