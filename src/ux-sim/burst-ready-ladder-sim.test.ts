import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { runBurstReadyLadderSimulation } from './burst-ready-ladder-sim.js';

test('S1 executes each purpose-specific warm-up, admission, and TTL stop through the existing fake cloud VM', async () => {
  const result = await runBurstReadyLadderSimulation(randomUUID(), 'burst-ready-ladder-s1');

  expect(result.pass).toBe(true);
  expect(result.mockVmCount).toBe(6);
  expect(result.forbiddenTerminateCount).toBe(0);
  expect(result.allPreparedOneHourAhead).toBe(true);
  expect(result.allPrematureAdmissionsRejected).toBe(true);
  expect(result.allReadyBeforeAdmissionRejected).toBe(true);
  expect(result.allAdmittedReady).toBe(true);
  expect(result.allDeadlineDraining).toBe(true);
  expect(result.allPostExpiryAdmissionsRejected).toBe(true);
  expect(result.allLeasesDrainedAfterExpiry).toBe(true);
  expect(result.allPoweredOnDurationMatches).toBe(true);
  expect(result.allStoppedAfterDrain).toBe(true);
  expect(result.runs.map((run) => [run.purpose, run.ttlHours])).toEqual([
    ['gate', 2], ['gate', 4], ['implementation', 2], ['implementation', 4], ['execution', 2], ['execution', 4],
  ]);
  for (const run of result.runs) {
    expect(run.preparedAt).toBe(run.admittedAt - 60 * 60 * 1000);
    expect(run.prematureAdmissionRejected).toBe(true);
    expect(run.earlyReadyAdmissionRejected).toBe(true);
    expect(run.postExpiryAdmissionRejected).toBe(true);
    expect(run.drainingAt).toBe(run.admittedAt + run.ttlHours * 60 * 60 * 1000);
    expect(run.leaseClosedAt).toBe(run.drainingAt + 5 * 60 * 1000);
    expect(run.stoppedAt).toBe(run.leaseClosedAt);
    expect(run.poweredOnMs).toBe((run.ttlHours + 1) * 60 * 60 * 1000 + 5 * 60 * 1000);
    expect(run.finalState).toBe('parked');
  }
});
