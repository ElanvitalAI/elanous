import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { createNextTuiQueue } from './queue.js';
import { createQueueIdleWatchdog } from './queue-idle-watchdog.js';
import { createChildNoticeProducers } from './notice-producers.js';

/**
 * CAPSULE-DONE-KNOCK-PTY-E2E-FU (OP 11-22) — #39526 left an unattended seat holding result-only notices forever
 * (one hand seat: 11 results, one hour, no turn). Contract:
 *   idle ∧ nothing actionable ∧ passive results waited ≥ 2 min → exactly ONE turn that drains them as one bundle;
 *   while a turn runs → no extra turn; a person's line → dispatches at once.
 * Expected values are literals (rule 11): 2 min = 120 000 ms, the watchdog window here = 5 000 ms.
 */

const T0 = new Date('2026-11-22T10:00:00Z').getTime();
beforeEach(() => { setSystemTime(new Date(T0)); });
afterEach(() => { setSystemTime(); });
const at = (ms: number): void => { setSystemTime(new Date(T0 + ms)); };

/** A seat loop in miniature: the watchdog wake runs the same split entry.ts dispatchQueued makes. */
function seat() {
  const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  const notices = createChildNoticeProducers(queue);
  const turns: string[][] = [];
  let busy = false;
  const dispatch = (): void => {
    if (busy || queue.autoDispatchCount === 0) return; // entry.ts: nothing actionable → no turn
    if (queue.peekActionableKind() === 'user') {
      const one = queue.dequeueActionable();
      if (one.kind === 'submit') turns.push([one.text]);
    } else {
      const bundle = queue.drainNotices();
      if (bundle.kind === 'notices') turns.push(bundle.notices.map((n) => n.text));
    }
    busy = true;
  };
  const watchdog = createQueueIdleWatchdog({
    now: () => Date.now(), idle: () => !busy, queued: () => queue.autoDispatchCount,
    wake: () => { dispatch(); return true; }, log: () => {}, stallMs: 5_000,
  });
  queue.onEnqueued(() => { watchdog.noteQueued(); });
  /** Tick every 500 ms up to `untilMs` after T0 (the entry.ts cadence). */
  const runUntil = (fromMs: number, untilMs: number): void => {
    for (let t = fromMs; t <= untilMs; t += 500) { at(t); watchdog.tick(); }
  };
  const endTurn = (): void => { busy = false; watchdog.noteTurnBoundary(); };
  return { queue, notices, turns, runUntil, endTurn, setBusy: () => { busy = true; watchdog.noteTurnBoundary(); } };
}

const elevenCapsules = (notices: ReturnType<typeof createChildNoticeProducers>): void => {
  for (let i = 1; i <= 11; i++) notices.capsuleDone({ capsuleId: `cap-${i}`, kind: 'agent', status: 'ok', summary: `r${i}` });
};

test('(a) 11 capsule results on an idle seat: no turn before 2 min, exactly one bundled turn after', () => {
  const s = seat();
  elevenCapsules(s.notices);
  s.runUntil(0, 119_500);
  expect(s.turns.length).toBe(0);
  s.runUntil(120_000, 130_000);
  expect(s.turns.length).toBe(1);
  expect(s.turns[0]!.join('\n')).toContain('캡슐 완료 11건');
  expect(s.queue.count).toBe(0);
  // Later results wait for this turn to end — no second turn while it runs, however long.
  s.notices.sidetabResult({ mission: 'later', status: 'done' });
  s.runUntil(130_500, 400_000);
  expect(s.turns.length).toBe(1);
});

test('(b) results arriving while a turn runs open no extra turn', () => {
  const s = seat();
  s.setBusy();
  elevenCapsules(s.notices);
  s.notices.harnessChildFinished({ goal: 'g', outcome: 'done' });
  s.runUntil(0, 300_000);
  expect(s.turns.length).toBe(0);
  expect(s.queue.count).toBe(2);
});

test('(c) a person line still dispatches at once, ahead of waiting results', () => {
  const s = seat();
  elevenCapsules(s.notices);
  s.runUntil(0, 10_000);
  expect(s.turns.length).toBe(0);
  s.queue.enqueue('사람 한 줄');
  expect(s.queue.autoDispatchCount).toBe(1);
  expect(s.queue.peekActionableKind()).toBe('user');
  s.runUntil(10_500, 16_000);
  expect(s.turns).toEqual([['사람 한 줄']]);
});
