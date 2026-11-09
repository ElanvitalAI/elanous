import { expect, test } from 'bun:test';
import { runReleaseSameVersionRunAdoptionSim } from './release-same-version-run-adoption-sim.js';

test('same-version failed release cut adopts the existing graph run without a second ledger entry', async () => {
  const evidence = await runReleaseSameVersionRunAdoptionSim();
  expect(evidence).toMatchObject({
    resumeRunId: evidence.existingRunId,
    returnedRunId: evidence.existingRunId,
    versionNodeBranch: 'release/0.3.7',
    versionNodeExisting: true,
    graphCalls: 2,
    resumeFrom: 'gate',
    resumedGateImagePin: 'cut-commit',
    firstGraphStatus: 'failed',
    secondGraphStatus: 'done',
    runLedgerCountBefore: 0,
    runLedgerCountAfter: 1,
    resumedExistingRun: true,
  });
  expect(evidence.existingRunId).toMatch(/^[0-9a-f-]{36}$/);
  expect(evidence.versionNodeCommit).toMatch(/^[0-9a-f]{40}$/);
});
