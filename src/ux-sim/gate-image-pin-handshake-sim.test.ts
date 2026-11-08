import { expect, test } from 'bun:test';
import { GATE_IMAGE_PIN_HANDSHAKE_SCENARIOS, runGateImagePinHandshakeScenario } from './gate-image-pin-handshake-sim.js';

for (const scenario of GATE_IMAGE_PIN_HANDSHAKE_SCENARIOS) {
  test(`gate image pin handshake: ${scenario.id}`, () => {
    const result = runGateImagePinHandshakeScenario(scenario);
    expect(result).toMatchObject(scenario.expected);
    if (scenario.tagDigestAtPodStart !== undefined) expect(result).toHaveProperty('tagDrifted', true);
    else if (result.gateMayStart) expect(result).toHaveProperty('tagDrifted', null);
  });
}
