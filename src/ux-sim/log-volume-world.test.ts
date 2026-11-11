import { expect, test } from 'bun:test';
import { currentGateCorrelationContext } from '../mss/logging/gate-correlation.js';
import { runLogVolumeWorld, runSharedGateTemplateWorld } from './log-volume-device.js';

test('concurrent runner gate observations preserve every run identity across async turns', async () => {
  // Source: this simulation generates one gate observation pair for each run identifier in the fixture.
  const runIds = Array.from({ length: 32 }, (_, index) => `log-volume-${index}`);
  const records = await runLogVolumeWorld(runIds);
  expect(records).toHaveLength(runIds.length * 2);
  for (const runId of runIds) {
    const matching = records.filter((record) => record.runId === runId);
    expect(matching).toHaveLength(2);
    for (const record of matching) expect(record).toMatchObject({
      invocation: `invocation-${runId}`, batch: `batch-${runId}`, phase: 'prepare',
    });
  }
  expect(currentGateCorrelationContext()).toBeUndefined();
});

test('reusing a gate context template leaves concurrent phases isolated', async () => {
  expect(await runSharedGateTemplateWorld()).toEqual(['first', 'second']);
});
