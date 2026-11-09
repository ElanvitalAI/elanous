import { describe, expect, test } from 'bun:test';
import { fakeLandSlots, simulateFakeLandQueue, type FakeLandQueueItem } from './fake-land-queue.js';

const item = (number: number, file = `src/area-${number}/file.ts`): FakeLandQueueItem => ({
  number, head: number.toString(16).padStart(40, '0'), files: [file],
});

describe('fake LAND-QUEUE device', () => {
  test('load hysteresis expands below 60 and contracts at 80', () => {
    expect(fakeLandSlots(59, 2)).toBe(3);
    expect(fakeLandSlots(60, 3)).toBe(3);
    expect(fakeLandSlots(79, 2)).toBe(2);
    expect(fakeLandSlots(80, 3)).toBe(2);
  });

  test('depart uses the real train verdict path and respects 2→3 load slots', async () => {
    const result = await simulateFakeLandQueue({ queue: [item(1), item(2), item(3)], load: 40 });
    expect(result).toMatchObject({ slots: 3, departed: [[1, 2, 3]], waiting: [], stoppedAtCut: false });
    expect(result.verdicts).toEqual([1, 2, 3].map((number) => ({ number, verdict: 'pass' })));
  });

  test('unmeasured gate waits; it is not converted to a failure', async () => {
    const result = await simulateFakeLandQueue({ queue: [item(1)], load: 80, gates: ['unmeasured'] });
    expect(result.verdicts).toEqual([{ number: 1, verdict: 'unmeasured' }]);
  });

  test('expedite reorders and eject removes a queued PR before departure', async () => {
    const result = await simulateFakeLandQueue({ queue: [item(1), item(2), item(3)], load: 70, expedite: 3, eject: [2] });
    expect(result).toMatchObject({ slots: 2, departed: [[3, 1]], ejected: [2], waiting: [] });
  });

  test('cut-window stop leaves every candidate waiting without a train verdict', async () => {
    const result = await simulateFakeLandQueue({ queue: [item(1, 'src/already-landed.ts'), item(2)], load: 40, cutWindowOpen: false,
      landedFiles: ['src/already-landed.ts'] });
    expect(result).toMatchObject({ slots: 3, departed: [], waiting: [1, 2], stoppedAtCut: true, verdicts: [], conflicts: [] });
  });

  test('overlap conflict comes from merge-train integration and isolates its PR', async () => {
    const result = await simulateFakeLandQueue({ queue: [item(1), item(2)], load: 80, conflicting: [2] });
    expect(result.departed).toEqual([[1, 2]]);
    expect(result.verdicts).toEqual([{ number: 1, verdict: 'pass' }, { number: 2, verdict: 'conflict' }]);
  });

  test('landed paths decide conflict in the fake merge-tree boundary and receipts retain candidate heads', async () => {
    const overlap = item(7, 'src/release-loop/gate-node.ts');
    const clear = item(8, 'src/other.ts');
    const result = await simulateFakeLandQueue({ queue: [overlap, clear], load: 80, landedFiles: ['src/release-loop/gate-node.ts'] });
    expect(result.conflicts).toEqual([{ number: 7, files: ['src/release-loop/gate-node.ts'] }]);
    expect(result.receipts).toEqual([
      { number: 7, head: overlap.head, verdict: 'conflict' },
      { number: 8, head: clear.head, verdict: 'pass' },
    ]);
  });
});
