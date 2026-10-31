import { describe, expect, test } from 'bun:test';
import { createTurnThrowSim } from './turn-throw-sim.js';

describe('turn throw simulation', () => {
  test('throws at the configured turn stage after the injectable delay', async () => {
    const sleeps: number[] = [];
    const simulate = createTurnThrowSim({
      stage: 'loadAttachments',
      delayMs: 25,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    });
    await simulate('beginCodeEditTurn');
    await expect(simulate('loadAttachments')).rejects.toThrow('simulated turn body failure at loadAttachments');
    expect(sleeps).toEqual([25]);
  });

  test('rejects invalid stage and delay values', () => {
    expect(() => createTurnThrowSim({ stage: ' ' })).toThrow('stage must be non-empty');
    expect(() => createTurnThrowSim({ stage: 'createOptionalSpecs', delayMs: -1 })).toThrow('delayMs must be a non-negative');
  });
});
