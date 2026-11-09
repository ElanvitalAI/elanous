import { expect, test } from 'bun:test';
import { runLightRcLongRunSimulation } from './light-rc-long-run-device.js';

test('long light-rc stays pending and an unmeasured host result is not presented as green', async () => {
  const result = await runLightRcLongRunSimulation();
  expect(result).toMatchObject({ pass: true, completedAfterHold: true });
  expect(result.result[0]).toStartWith('⛔');
  expect(result.result.join('\n')).toContain('simulated long-running light-rc became unmeasured');
  const earlyFailure = await runLightRcLongRunSimulation('bad-version');
  expect(earlyFailure).toMatchObject({ pass: false, completedAfterHold: false });
  expect(earlyFailure.result[0]).toContain('release version must be x.y.z');
});
