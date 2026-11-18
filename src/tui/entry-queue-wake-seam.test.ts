import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/** C6 sim seam (CX-9 #89715): the barrier must run before the wake is decided, or the race is not held. */
describe('queueWakeBarrierForTest — the C6 seam sits before the door and the dispatch', () => {
  const entry = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');
  const start = entry.indexOf('if (key === queueWake) {');
  const branch = entry.slice(start, entry.indexOf('render();', start));

  test('awaited barrier, then the door offer — in that order (the door is the only opener since R1b)', () => {
    const barrierAt = branch.indexOf('await options.queueWakeBarrierForTest(seen)');
    const doorAt = branch.indexOf("entryDoor?.door.offer('event')");
    expect(start).not.toBe(-1);
    expect(barrierAt).not.toBe(-1);
    expect(doorAt).toBeGreaterThan(barrierAt);
  });

  test('the seam is observed as a turn-life event and production leaves it unset', () => {
    expect(branch.includes("emitTurnLife('turn-life:queue-wake-seen'")).toBe(true);
    expect(branch.includes('if (options.queueWakeBarrierForTest) {')).toBe(true);
  });
});
