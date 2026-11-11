import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('fake GCP lifecycle requires approval and never calls GCP', () => {
  const repoRoot = resolve(import.meta.dir, '../..');
  const result = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, 'gcp-architect-expand-fake-world.ts')],
    { cwd: repoRoot },
  );

  expect(result.exitCode).toBe(0);
  const output = new TextDecoder().decode(result.stdout);
  const simulation = JSON.parse(output);

  expect(simulation.deniedBeforeSideEffect).toBe(true);
  expect(simulation.invalidApprovalsDeniedBeforeSideEffect).toBe(true);
  expect(simulation.shortage).not.toEqual([]);
  expect(simulation.approval).toBe('fake-user');
  expect(simulation.nonIdleCheckAt).toBe('2026-11-10T04:01:00.000Z');
  expect(simulation.nonIdleStopTriggered).toBe(false);
  expect(simulation.stateAfterNonIdleCheck).toBe('running');
  expect(simulation.projectStateBeforeIdleStopAt).toBe('2026-11-10T04:01:29.999Z');
  expect(simulation.stoppedBeforeIdleTtl).toBe(false);
  expect(simulation.projectStateBeforeIdleStop).toBe('running');
  expect(simulation.idleStopTriggered).toBe(true);
  expect(simulation.projectStateAfterIdleStop).toBe('stopped');
  expect(simulation.project.stateHistory).toEqual(['created', 'running', 'stopped']);
  expect(simulation.project.stoppedAt).toBe('2026-11-10T04:01:30.000Z');
  expect(simulation.costLedger.map((event: { event: string }) => event.event)).toEqual([
    'estimate',
    'usage',
    'stopped',
  ]);
  expect(simulation.activeLeases).toBe(0);
  expect(simulation.realGcpCalls).toBe(0);
});
