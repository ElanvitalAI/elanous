import { expect, test } from 'bun:test';
import { evaluateExpectRecovers, runWorldChaosFault, runWorldChaosSchedule } from './world-chaos-runtime.js';
import { createFakePsDevice } from './fake-ps.js';
import type { SimChaosFault, SimWorldProcess } from './world-schema.js';

const processFixture: SimWorldProcess = { id: 'worker', host: 'node-b', releaseVersion: '0.2.45' };

for (const signal of ['KILL', 'TERM'] as const) {
  test(`SIM-CHAOS: ${signal} is delivered to the declared process before production readiness rechecks its lock`, async () => {
    const fault: SimChaosFault = { at: '+5m', monkey: { kill: 'worker host=node-b', signal } };
    const observed = await runWorldChaosFault(fault, [processFixture]);
    expect(observed).toMatchObject({
      faultVerdict: `worker host=node-b received ${signal}; already-running`,
      recoveryVerdict: 'ready', recoveredAtMs: 300_250, recoveryMs: 250,
      metrics: { hitlCount: 0, lostLedgerRows: null, schedulableCpuMillicores: null },
    });
    expect(evaluateExpectRecovers(observed, { withinMs: 250, hitlCount: 0 })).toEqual({ pass: true, failures: [], unmeasured: [] });
  });
}

test('SIM-CHAOS: shared fake-time timeline orders injection between declared faults', async () => {
  const faults: SimChaosFault[] = [
    { at: '+1m', monkey: { kill: 'worker host=node-b', signal: 'TERM' } },
    { at: '+3m', monkey: { kill: 'worker host=node-b', signal: 'KILL' } },
  ];
  const processTable = createFakePsDevice({ processes: [processFixture] });
  const result = await runWorldChaosSchedule(faults, [processFixture], undefined, undefined, [{
    atMs: 60_100,
    run: () => ({ injectionId: 'inj-between', runId: 'run-between', ledgerPath: '/tmp/ledger', ledgerRows: [] }),
  }], undefined, 0, undefined, processTable);
  expect(result.timeline).toEqual([
    { atMs: 60_000, kind: 'fault-start', target: 'worker host=node-b' },
    { atMs: 60_100, kind: 'injection', target: 'inj-between' },
    { atMs: 60_250, kind: 'fault-recovery', target: 'worker host=node-b' },
    { atMs: 180_000, kind: 'fault-start', target: 'worker host=node-b' },
    { atMs: 180_250, kind: 'fault-recovery', target: 'worker host=node-b' },
  ]);
  expect(result.observations.map((row) => row.recoveryMs)).toEqual([250, 250]);
  expect(result.observations.map((row) => row.recoveredAtMs)).toEqual([60_250, 180_250]);
  expect(processTable.find('worker', 'node-b')?.pid).toBe(1_700_000_002);
});

test('SIM-CHAOS: a fault recovery at the injection instant completes first', async () => {
  const result = await runWorldChaosSchedule([{ at: '+1m', monkey: { kill: 'worker host=node-b', signal: 'TERM' } }],
    [processFixture], undefined, undefined, [{
      atMs: 60_250,
      run: () => ({ injectionId: 'inj-at-recovery', runId: 'run-at-recovery', ledgerPath: '/tmp/ledger', ledgerRows: [] }),
    }], undefined, 0, undefined, createFakePsDevice({ processes: [processFixture] }));
  expect(result.timeline).toEqual([
    { atMs: 60_000, kind: 'fault-start', target: 'worker host=node-b' },
    { atMs: 60_250, kind: 'fault-recovery', target: 'worker host=node-b' },
    { atMs: 60_250, kind: 'injection', target: 'inj-at-recovery' },
  ]);
});

test('SIM-CHAOS: monkey kill mutates the same fake ps inventory used for later reads', async () => {
  const processTable = createFakePsDevice({ processes: [processFixture] });
  await runWorldChaosFault({ at: '+1m', monkey: { kill: 'worker host=node-b', signal: 'KILL' } }, [processFixture], undefined, 0, processTable);
  expect(processTable.list('node-b')).toHaveLength(1);
  expect(processTable.pidAlive(1_700_000_000)).toBe(false);
  expect(processTable.find('worker', 'node-b')?.pid).toBe(1_700_000_001);
  await runWorldChaosFault({ at: '+2m', monkey: { kill: 'worker host=node-b', signal: 'TERM' } }, [processFixture], undefined, 0, processTable);
  expect(processTable.find('worker', 'node-b')?.pid).toBe(1_700_000_002);
});

test('SIM-CHAOS: runtime refuses a target absent from the world process registry', async () => {
  await expect(runWorldChaosFault({ at: '+1m', monkey: { kill: 'other host=node-b', signal: 'KILL' } }, [processFixture]))
    .rejects.toThrow('world.chaos monkey target is not declared: other host=node-b');
});
