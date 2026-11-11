import { expect, test } from 'bun:test';
import { simulateRlaMacrophageHealTimeoutAndStaleOutput } from './rla-macrophage-heal-timeout-stale-output-sim.js';

test('RLA-MACROPHAGE-HEAL sim injects exhausted timeout and stale generated output through the real planner', () => {
  const { injector, result, inventory } = simulateRlaMacrophageHealTimeoutAndStaleOutput();

  expect(injector).toBe('rla-macrophage-heal-timeout-stale-output');
  expect(result.status).toBe('simulated');
  expect(result.events).toMatchObject([
    { id: 'timeout-budget-exhausted', action: 'quarantine-test', applied: true,
      evidence: 'flaky=false; timeoutBurned=true' },
    { id: 'stale-generated-output', action: 'regenerate', applied: true,
      evidence: 'source=source-current; generated=output-prior' },
    { id: 'matching-generated-output', action: 'retain', applied: false,
      evidence: 'source/generated fingerprints do not prove staleness' },
    { id: 'unmeasured-timeout', action: 'retain', applied: false,
      evidence: 'flaky=false; timeoutBurned=unknown' },
  ]);
  expect(result.remaining).toEqual(['matching-generated-output', 'unmeasured-timeout']);
  expect(inventory).toHaveLength(4);
});
