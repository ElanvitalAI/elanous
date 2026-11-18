import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/** [턴 근본 R1b] CAPSULE-FLAGS-REMOVE-DEFAULT: the door is the only opener — the flag-off dispatch branches are gone. */
describe('entry has no flag-off turn path', () => {
  const entry = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');
  const dispatch = entry.slice(entry.indexOf('const dispatchQueued = (): void => {'), entry.indexOf('goalContinue?.noteHumanTurn();', entry.indexOf('const dispatchQueued = (): void => {')));

  test('dispatchQueued always reserves the door before the dequeue and sends notices through it', () => {
    expect(dispatch.includes('const reservation = opener === \'person\' ? door.reserveHuman() : door.reserveAuto();')).toBe(true);
    expect(dispatch.indexOf('door.reserve')).toBeLessThan(dispatch.indexOf('queue.dequeue()'));
    expect(dispatch.includes('dispatchNoticeThroughDoor(')).toBe(true);
    // the old direct notice chain (no reservation) is gone from dispatchQueued
    expect(dispatch.includes('void dispatchQueuedExternalEventOne({')).toBe(false);
    // the queue-notice label for turn-start observation survives on the door path
    expect(dispatch.split("turnStartLabel = { door: 'queue-notice'").length - 1).toBe(2);
  });

  test('a queueWake on an idle seat only offers the door', () => {
    expect(entry.includes("if (!busy) entryDoor?.door.offer('event');")).toBe(true);
    expect(entry.includes("else if (!busy) {\n          queueIdleWatchdog.noteDispatch();\n          dispatchQueued();")).toBe(false);
  });
});
