import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { createWorld, destroyWorld, executeWorldScenario, runWorldScenario, verifyWorldNetworkIsolation } from './world.js';
import type { ChaosHqMoveReceipt } from './chaos-hq-move-world.js';

const worldPath = join(import.meta.dir, '../../scenarios/ux-sim/chaos-hq-move-world.yaml');
const scenarioPath = join(import.meta.dir, '../../scenarios/ux-sim/chaos-hq-move.yaml');

for (const fault of ['none', 'restart-denied', 'claim-denied', 'queue-loss'] as const) {
  test(`world consumer executes all HQ chaos scenarios and observes ${fault}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'hq-chaos-consumer-'));
    const previousRoot = getTestStateRoot();
    const previousSandbox = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    setTestStateRoot(root);
    process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
    try {
      const world = await createWorld(worldPath);
      try {
        const scenario = join(root, 'scenario.yaml');
        writeFileSync(scenario, readFileSync(scenarioPath, 'utf8').replace('approveKong: true', `approveKong: true, fault: ${fault}`));
        const result = await executeWorldScenario(world, scenario);
        expect(result.pass).toBe(fault === 'none');
        expect(result.observations.map(row => row.event)).toEqual([
          'monkey-1', 'monkey-2', 'monkey-3', 'gorilla-1', 'gorilla-2', 'gorilla-3', 'kong-1', 'kong-2', 'kong-3',
        ]);
        const rows = result.observations.map(row => JSON.parse(row.verdict) as ChaosHqMoveReceipt);
        for (const row of rows) {
          expect(row.realMachineStops).toBe(0);
          const shouldLose = fault !== 'none';
          expect(row.lostTasks).toBe(shouldLose ? ((fault === 'restart-denied' || fault === 'claim-denied') && !row.scenario.startsWith('monkey') ? 3 : 1) : 0);
          if (!row.scenario.startsWith('monkey') && row.scenario.endsWith('-3')) {
            if (fault === 'restart-denied') {
              expect(row.returnedWorkerFenceProof).toBeUndefined();
              expect(row.events).not.toContain('returned-workers:task-ack-fenced');
            } else {
              expect(row.returnedWorkerFenceProof?.caller).toEqual(row.returnedWorkerFenceProof?.assignment);
              expect(row.returnedWorkerFenceProof?.deniedAck).toBe(false);
              expect(row.returnedWorkerFenceProof?.permittedAck).toBe(true);
            }
          }
          if (row.scenario.startsWith('monkey')) {
            const claimed = row.events.some(event => event.startsWith('replacement-claim:accepted:'));
            expect(row.events.includes('old-pid-ack:rejected-after-reassignment')).toBe(claimed);
            if (fault === 'claim-denied') expect(claimed).toBe(false);
          }
          if (!shouldLose) {
            expect(row.recoveredAt).toBeGreaterThan(row.faultAt);
            expect(row.tasks.map(task => task.id).sort()).toEqual(['task-01', 'task-02', 'task-03']);
          }
        }
      } finally { await destroyWorld(world); }
    } finally {
      setTestStateRoot(previousRoot ?? null);
      if (previousSandbox === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
      else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = previousSandbox;
      rmSync(root, { recursive: true, force: true });
    }
  });
}


test('supported world runner consumes the matrix under OS network isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-chaos-sandbox-'));
  const previousRoot = getTestStateRoot();
  setTestStateRoot(root);
  try {
    const world = await createWorld(worldPath);
    try {
      expect(await verifyWorldNetworkIsolation(world, scenarioPath)).toBe(true);
      const result = await runWorldScenario(world, scenarioPath);
      expect(result.pass, JSON.stringify(result)).toBe(true);
      expect(result.observations).toHaveLength(9);
      // Source: 내부 문서 `chaos-hq-move-sim-0312`; recovery is completion minus fault time, with completion after the fault.
      expect(result.observations.every(row => row.invariant === 'pass' && row.durationMs! > 0)).toBe(true);
    } finally { await destroyWorld(world); }
  } finally {
    setTestStateRoot(previousRoot ?? null);
    rmSync(root, { recursive: true, force: true });
  }
});
