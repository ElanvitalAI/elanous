import { runMacrophageHeal, type MacrophageScrap } from '../release-loop/macrophage-heal.js';

const SIMULATION_TIME = new Date('2026-11-10T00:00:00.000Z');

/** Run the production macrophage planner against an isolated incident inventory. */
export function simulateRlaMacrophageHealTimeoutAndStaleOutput() {
  const inventory: MacrophageScrap[] = [
    {
      id: 'timeout-budget-exhausted',
      kind: 'flaky-timeout-test',
      evidence: { flaky: false, timeoutBurned: true, detail: 'injected gate timeout budget exhausted' },
    },
    {
      id: 'stale-generated-output',
      kind: 'stale-generated-artifact',
      evidence: { sourceFingerprint: 'source-current', generatedFingerprint: 'output-prior' },
    },
    {
      id: 'matching-generated-output',
      kind: 'stale-generated-artifact',
      evidence: { sourceFingerprint: 'same', generatedFingerprint: 'same' },
    },
    {
      id: 'unmeasured-timeout',
      kind: 'flaky-timeout-test',
      evidence: { flaky: false },
    },
  ];

  return {
    injector: 'rla-macrophage-heal-timeout-stale-output',
    result: runMacrophageHeal({
      phase: 'idle',
      mode: 'simulation',
      now: SIMULATION_TIME,
      consecutiveFailureLimit: 3,
      inventory,
    }),
    inventory,
  };
}
