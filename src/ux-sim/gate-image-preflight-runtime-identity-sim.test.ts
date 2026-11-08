import { expect, test } from 'bun:test';
import { GATE_IMAGE_PREFLIGHT_RUNTIME_SCENARIOS, runGateImagePreflightRuntimeScenario } from './gate-image-preflight-runtime-identity-sim.js';

test('gate preflight accepts only runtime metadata that exactly matches the cutoff pins', () => {
  for (const scenario of GATE_IMAGE_PREFLIGHT_RUNTIME_SCENARIOS) {
    const result = runGateImagePreflightRuntimeScenario(scenario);
    if (scenario.expected === 'accepted') {
      expect(result).toEqual({ ok: true });
    } else if (scenario.expected === 'image-drift') {
      expect(result).toEqual({ ok: false, reason: 'image-drift', fields: scenario.expectedFields });
    } else {
      expect(result).toEqual({ ok: false, reason: scenario.expected });
    }
  }
});
