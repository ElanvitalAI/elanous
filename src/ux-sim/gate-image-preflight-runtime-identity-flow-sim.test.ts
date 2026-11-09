import { expect, test } from 'bun:test';
import { GATE_IMAGE_PREFLIGHT_INTEGRATED_SCENARIOS, runGateImagePreflightIntegratedScenario } from './gate-image-preflight-runtime-identity-flow-sim.js';

test('release preflight and gate pinning use one runtime identity before digest-only Pod pulls', async () => {
  for (const scenario of GATE_IMAGE_PREFLIGHT_INTEGRATED_SCENARIOS) {
    const result = await runGateImagePreflightIntegratedScenario(scenario);
    if (scenario.expected === 'preflight-rejected') {
      expect(result).toMatchObject({ outcome: 'preflight-rejected', probeHosts: ['aws1', 'aws2'], pin: null });
      expect(result.detail).toContain(scenario.detailIncludes);
      continue;
    }
    if (scenario.expected === 'gate-image-rejected') {
      expect(result).toMatchObject({ outcome: 'gate-image-rejected', pinExists: false,
        gateImageProbeCalls: ['pool-node-b', 'pool-mshq'],
        gateImageProbeRows: [{ context: 'pool-node-b', digest: `sha256:${'a'.repeat(64)}` },
          { context: 'pool-mshq', digest: `sha256:${'d'.repeat(64)}` }], probeHosts: ['aws1', 'aws2'] });
      expect(result.detail).toContain(scenario.detailIncludes);
      continue;
    }
    if (scenario.expected === 'preflight-pin-rejected') {
      expect(result).toMatchObject({ outcome: 'preflight-pin-rejected', pinExists: true,
        pin: { digest: `sha256:${'a'.repeat(64)}`, commit: '1'.repeat(40), runId: 'sim-gate-run' },
        gateImageProbeCalls: ['pool-a', 'pool-b'], appliedJobImageRefs: [], jobApplyCount: 0, probeHosts: ['aws1', 'aws2'] });
      expect(result.detail).toContain(scenario.detailIncludes);
      continue;
    }
    if (scenario.expected === 'pod-image-rejected') {
      expect(result).toMatchObject({ outcome: 'pod-image-rejected', pinExists: true,
        podObservedDigest: `sha256:${'d'.repeat(64)}`, pinnedDigest: `sha256:${'a'.repeat(64)}`,
        appliedJobImageRefs: [`k3d-elanous-registry:5051/elanous-harness@sha256:${'a'.repeat(64)}`
        ] });
      expect(result.detail).toContain(scenario.detailIncludes);
      continue;
    }
    expect(result).toMatchObject({ outcome: 'pinned', preflightLevel: 'ok', gateOutcome: 'ok', pinExists: true,
      appliedJobImageRefs: [`k3d-elanous-registry:5051/elanous-harness@sha256:${'a'.repeat(64)}`,
        `k3d-elanous-registry:5052/elanous-harness@sha256:${'a'.repeat(64)}`],
      pin: { digest: `sha256:${'a'.repeat(64)}`, commit: '1'.repeat(40), runId: 'sim-gate-run' } });
    if (scenario.tagDriftPool) {
      const port = scenario.tagDriftPool === 'pool-a' ? '5051' : '5052';
      expect(result.tagProbeRows).toContainEqual({ registryPort: port, digest: `sha256:${'d'.repeat(64)}` });
    }
    expect(result.appliedJobImageRefs).toHaveLength(2);
  }
});
