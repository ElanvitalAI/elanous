import { expect, test } from 'bun:test';
import { runGateImageLayeredDeltaScenario } from './gate-image-layered-delta-sim.js';

test('source-only commit reuses one runtime image and Pod checks out the exact source delta', async () => {
  const result = await runGateImageLayeredDeltaScenario();
  expect(result).toMatchObject({ outcome: 'reused-runtime-and-checked-out-source-delta', builds: 1, pushes: 1,
    sameRuntimeKeyAcrossSourceCommits: true,
    runtimeKeyChangesWithMeasuredBaseDigest: true,
    imageHadSecondCommitBeforePod: false, podHasSecondCommitAfterReceive: true,
    checkedOut: result.secondCommit, sourceValue: 'export const value = 2;',
    pins: [{ commit: result.firstCommit, digest: `sha256:${'c'.repeat(64)}` },
      { commit: result.secondCommit, digest: `sha256:${'c'.repeat(64)}` }] });
  expect(result.sourceOutput).toContain(`ELANOUS_POD_SOURCE commit ${result.secondCommit}`);
});
