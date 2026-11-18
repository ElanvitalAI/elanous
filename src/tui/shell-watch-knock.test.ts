/** O1 parent seam unit test — injected subscribe/enqueue/knock, no PTY (TC-H-CX-2 인계 #92526). */
import { describe, expect, spyOn, test } from 'bun:test';
import type { CapsuleEvent } from '../turn-capsule/contract.js';
import { wireShellWatchKnock } from './shell-watch-knock.js';
import { debug } from '../debug/log.js';

const baseEvent = {
  type: 'capsule-progress', kind: 'shell', capsuleId: 'shell-watch:0', sessionId: 'seat-A', at: 1, line: 'watch hit',
} as const;

describe('wireShellWatchKnock (O1 parent seam)', () => {
  test('a shell-watch progress line enqueues one notice and knocks once', () => {
    const log = spyOn(debug, 'log');
    const notices: { text: string; at: number }[] = [];
    let knocks = 0;
    let emit: (event: CapsuleEvent) => void = () => {};
    const stop = wireShellWatchKnock({
      sessionId: 'seat-A',
      subscribe: (_sessionId, listener) => { emit = listener; return () => { emit = () => {}; }; },
      enqueue: (text, at) => { notices.push({ text, at }); return true; },
      knock: () => { knocks += 1; },
    });
    emit(baseEvent);
    stop();
    expect(notices).toEqual([{ text: '감시 줄: watch hit', at: 1 }]);
    expect(knocks).toBe(1);
    expect(log).toHaveBeenCalledWith('turn-life', 'turn-life:event-arrived', {
      sessionId: 'seat-A', capsuleId: 'shell-watch:0', source: 'watch', queued: true,
    });
    log.mockRestore();
  });

  test('unrelated capsule progress does not knock', () => {
    const notices: { text: string; at: number }[] = [];
    let knocks = 0;
    let emit: (event: CapsuleEvent) => void = () => {};
    wireShellWatchKnock({
      sessionId: 'seat-A',
      subscribe: (_sessionId, listener) => { emit = listener; return () => {}; },
      enqueue: (text, at) => { notices.push({ text, at }); return true; },
      knock: () => { knocks += 1; },
    });
    emit({ ...baseEvent, capsuleId: 'shell-run:9', line: 'not a watch' });
    expect(notices).toEqual([]);
    expect(knocks).toBe(0);
  });

  test('other sessions are ignored', () => {
    const notices: { text: string; at: number }[] = [];
    let knocks = 0;
    let emit: (event: CapsuleEvent) => void = () => {};
    wireShellWatchKnock({
      sessionId: 'seat-A',
      subscribe: (_sessionId, listener) => { emit = listener; return () => {}; },
      enqueue: (text, at) => { notices.push({ text, at }); return true; },
      knock: () => { knocks += 1; },
    });
    emit({ ...baseEvent, sessionId: 'seat-B' });
    expect(notices).toEqual([]);
    expect(knocks).toBe(0);
  });

  test('capsuleIds already seen do not knock twice', () => {
    const notices: { text: string; at: number }[] = [];
    let knocks = 0;
    let emit: (event: CapsuleEvent) => void = () => {};
    wireShellWatchKnock({
      sessionId: 'seat-A',
      subscribe: (_sessionId, listener) => { emit = listener; return () => {}; },
      enqueue: (text, at) => { notices.push({ text, at }); return true; },
      knock: () => { knocks += 1; },
    });
    emit(baseEvent);
    emit(baseEvent);
    expect(notices).toEqual([{ text: '감시 줄: watch hit', at: 1 }]);
    expect(knocks).toBe(1);
  });

  test('stop() unsubscribes', () => {
    const notices: { text: string; at: number }[] = [];
    let knocks = 0;
    let emit: (event: CapsuleEvent) => void = () => {};
    const stop = wireShellWatchKnock({
      sessionId: 'seat-A',
      subscribe: (_sessionId, listener) => { emit = listener; return () => { emit = () => {}; }; },
      enqueue: (text, at) => { notices.push({ text, at }); return true; },
      knock: () => { knocks += 1; },
    });
    emit(baseEvent);
    stop();
    emit({ ...baseEvent, capsuleId: 'shell-watch:1', line: 'second' });
    expect(notices).toEqual([{ text: '감시 줄: watch hit', at: 1 }]);
    expect(knocks).toBe(1);
  });
});
