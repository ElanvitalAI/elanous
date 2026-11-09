import { expect, test } from 'bun:test';
import { simulateGateRepairMultiFile, simulateGateRepairRecoveryIdDedupe } from './gate-repair-multi-file-sim.js';

test('gate repair multi-file sim: 15 files repair independently in bounded parallel batches; only failed and coupled files go to HITL', async () => {
  const result = await simulateGateRepairMultiFile();
  expect(result.verdict).toBe('green');
  expect(result.sourceFiles).toBe(15);
  expect(result.startedChildren).toBe(13);
  expect(result.childStartsByFile).toEqual(Object.fromEntries(Array.from({ length: 13 }, (_, index) =>
    [`src/repair-fixtures/source-${String(index).padStart(2, '0')}.ts`, 1])));
  expect(result.maxConcurrentChildren).toBe(2);
  expect(result.featureWritesUnderTempRoot).toBe(true);
  expect(result.repairedFiles).toHaveLength(12);
  expect(result.hitlFiles).toHaveLength(3);
  expect(result.remainingFailureIds).toHaveLength(3);
});

test('gate repair recovery sim: duplicate attribution is deduplicated when a landed repair needs recovery', async () => {
  const result = await simulateGateRepairRecoveryIdDedupe();
  expect(result.outcome).toBe('recovery-required');
  expect(result.recoveryAttempted).toBe(true);
  expect(result.humanRequiredFailureIds).toEqual(['src/repair-fixtures/recovery.test.ts > repeated recovery failure']);
  expect(result.remainingFailureIds).toEqual(['src/repair-fixtures/recovery.test.ts > repeated recovery failure']);
});
