import { expect, setDefaultTimeout, test } from 'bun:test';
import { runTaskCleanupIntegration, simulateTempCleanup } from './fake-temp-cleanup.js';

setDefaultTimeout(120_000);

test('temporary artifacts from task-agent suites are removed after a normal run', () => {
  const result = simulateTempCleanup({ outcome: 'pass' });
  expect(result.trackedDirectories).toBe(3);
  expect(result.remainingOwnedDirectories).toEqual([]);
  expect(result.unownedDirectoryPreserved).toBe(true);
  expect(result.fixtureContents).toEqual(['task-hand-', 'ta-live-', 'task-card-evidence-']);
});

test('temporary artifacts are removed when a suite fails after creating them', () => {
  const result = simulateTempCleanup({ outcome: 'throw-after-create' });
  expect(result.trackedDirectories).toBe(3);
  expect(result.remainingOwnedDirectories).toEqual([]);
  expect(result.unownedDirectoryPreserved).toBe(true);
  expect(result.fixtureContents).toEqual(['task-hand-', 'ta-live-', 'task-card-evidence-']);
});

test('real card-evidence suite cleanup removes owned TMPDIR roots and fails under cleanup-removal mutation', () => {
  const cleanRun = runTaskCleanupIntegration();
  expect(cleanRun.exitCode).toBe(0);
  expect(cleanRun.suiteSummary).toContain('59 pass');
  expect(cleanRun.taskOwnedLeftovers).toEqual([]);
  expect(cleanRun.unownedDirectoryPreserved).toBe(true);

  const mutatedRun = runTaskCleanupIntegration({ disableCleanup: true });
  expect(mutatedRun.exitCode).toBe(1);
  expect(mutatedRun.suiteSummary).toMatch(/\d+ fail/);
  expect(mutatedRun.taskOwnedLeftovers.length).toBeGreaterThan(0);
  expect(mutatedRun.unownedDirectoryPreserved).toBe(true);
});
