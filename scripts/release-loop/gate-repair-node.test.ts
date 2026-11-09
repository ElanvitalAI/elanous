import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { simulateGateRepairMultiFile, simulateGateRepairRecoveryIdDedupe } from '../../src/ux-sim/gate-repair-multi-file-sim.js';

test('GATE-REPAIR-MULTI-FILE: a 15-file repair run lands independent repairs and returns only failed or coupled files to HITL', async () => {
  const simulation = await simulateGateRepairMultiFile();
  expect(simulation.verdict).toBe('green');
  expect(simulation.sourceFiles).toBe(15);
  expect(simulation.startedChildren).toBe(13);
  expect(simulation.childStartsByFile).toEqual(Object.fromEntries(Array.from({ length: 13 }, (_, index) =>
    [`src/repair-fixtures/source-${String(index).padStart(2, '0')}.ts`, 1])));
  expect(simulation.maxConcurrentChildren).toBe(2);
  expect(simulation.featureWritesUnderTempRoot).toBe(true);
  expect([...simulation.repairedFiles].sort()).toEqual(Array.from({ length: 12 }, (_, index) =>
    `src/repair-fixtures/source-${String(index).padStart(2, '0')}.ts`).sort());
  expect([...simulation.hitlFiles].sort()).toEqual(['src/repair-fixtures/source-12.ts', 'src/repair-fixtures/source-13.ts', 'src/repair-fixtures/source-14.ts'].sort());
  expect([...simulation.remainingFailureIds].sort()).toEqual([
    'src/repair-fixtures/test-12.test.ts > failure-12',
    'src/repair-fixtures/test-13.test.ts > failure-13',
    'src/repair-fixtures/test-14.test.ts > failure-14',
  ].sort());
  expect(new Set(simulation.remainingFailureIds).size).toBe(3);
});

test('GATE-REPAIR-MULTI-FILE: recovery-required returns deduplicated remaining failures too', async () => {
  const recovery = await simulateGateRepairRecoveryIdDedupe();
  expect(recovery.outcome).toBe('recovery-required');
  expect(recovery.recoveryAttempted).toBe(true);
  expect(recovery.humanRequiredFailureIds).toEqual(['src/repair-fixtures/recovery.test.ts > repeated recovery failure']);
  expect(recovery.remainingFailureIds).toEqual(['src/repair-fixtures/recovery.test.ts > repeated recovery failure']);
});

test('GATE-REPAIR-MULTI-FILE simulation is present alongside generated main inventory rows', () => {
  const manual = readFileSync(join(import.meta.dir, '../../docs/manual/MANUAL-ux-simulation-devices-2026-08-23.md'), 'utf8');
  expect(manual).toContain('| gate-repair-multi-file-sim |');
  expect(manual).toContain('| install-one-liner-failsafe |');
});
