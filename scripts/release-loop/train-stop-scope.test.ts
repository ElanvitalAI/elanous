import { expect, test } from 'bun:test';
import { planTrainStopScope, stopTrainSlot, type TrainWorkerIdentity } from './train-stop-scope.js';

test('train stop is limited to one host/slot and the same process generation', async () => {
  const target: TrainWorkerIdentity = { host: 'node-b', slot: 2, pid: 1701, startToken: 'boot-7:100' };
  const other: TrainWorkerIdentity = { host: 'node-b', slot: 1, pid: 1702, startToken: 'boot-7:101' };
  const stopped: Array<{ worker: TrainWorkerIdentity; reason: string }> = [];
  let current: TrainWorkerIdentity | undefined = target;
  const adapter = {
    observe: async () => current,
    stopIfCurrent: async (scope: ReturnType<typeof planTrainStopScope>) => {
      if (!current || current.host !== scope.host || current.slot !== scope.slot || current.pid !== scope.pid
        || current.startToken !== scope.startToken) return false;
      stopped.push({ worker: current, reason: scope.reason });
      return true;
    },
  };
  const scope = planTrainStopScope(target, 'release-window');
  expect(await stopTrainSlot(scope, adapter)).toBe(true);
  expect(stopped).toEqual([{ worker: target, reason: 'release-window' }]);

  current = other;
  expect(await stopTrainSlot(scope, adapter)).toBe(false);
  current = { ...target, pid: target.pid + 1 };
  expect(await stopTrainSlot(scope, adapter)).toBe(false);
  current = { ...target, startToken: 'boot-7:102' };
  expect(await stopTrainSlot(scope, adapter)).toBe(false);
  current = undefined;
  expect(await stopTrainSlot(scope, adapter)).toBe(false);
  expect(stopped).toHaveLength(1);

  current = target;
  const reusedPid = { ...target, startToken: 'boot-7:200' };
  expect(await stopTrainSlot(scope, {
    ...adapter,
    observe: async () => { current = reusedPid; return target; },
  })).toBe(false);
  expect(stopped).toHaveLength(1);
});

test('train stop refuses wildcards, missing generation and empty reason', () => {
  const identity: TrainWorkerIdentity = { host: 'node-b', slot: 1, pid: 1, startToken: 'boot-1:1' };
  expect(() => planTrainStopScope({ ...identity, host: '*' }, 'stop')).toThrow();
  expect(() => planTrainStopScope({ ...identity, slot: 0 }, 'stop')).toThrow();
  expect(() => planTrainStopScope({ ...identity, pid: 0 }, 'stop')).toThrow();
  expect(() => planTrainStopScope({ ...identity, startToken: '' }, 'stop')).toThrow();
  expect(() => planTrainStopScope(identity, ' ')).toThrow();
});
