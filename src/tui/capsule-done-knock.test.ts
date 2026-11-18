import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import type { CapsuleDoneEvent, CapsuleEvent } from '../turn-capsule/contract.js';
import { wireCapsuleDoneKnock } from './capsule-done-knock.js';
import { capsuleDoneNotice, createChildNoticeProducers } from './core/notice-producers.js';
import { createNextTuiQueue } from './core/queue.js';

const DONE: CapsuleDoneEvent = {
  type: 'capsule-done', capsuleId: 'c-7', kind: 'agent', sessionId: 's-1',
  startedAt: 1_000, endedAt: 61_000, status: 'ok', summary: 'scan · ok · 60s',
};

function harness() {
  const queue = createNextTuiQueue();
  const notices = createChildNoticeProducers(queue);
  const listeners: Array<(event: CapsuleEvent) => void> = [];
  let knocks = 0;
  let unsubscribed = 0;
  const stop = wireCapsuleDoneKnock({
    sessionId: 's-1',
    subscribe: (sessionId, listener) => { expect(sessionId).toBe('s-1'); listeners.push(listener); return () => { unsubscribed++; }; },
    enqueue: (event) => notices.capsuleDone(event, event.endedAt),
    knock: () => { knocks++; },
  });
  return { queue, listeners, stop, knocks: () => knocks, unsubscribed: () => unsubscribed };
}

describe('B1 TUI wiring — capsule-done → one notice + one knock (always on)', () => {

  test('stage on: done → notice queued with source capsule-done and the capsule id · one knock · turn-life logged', () => {
    const log = spyOn(debug, 'log');
    const h = harness();
    h.listeners[0]!(DONE);
    const life = log.mock.calls.filter((call) => call[0] === 'turn-life' && call[1] === 'turn-life:capsule-done-knock');
    log.mockRestore();
    expect(h.knocks()).toBe(1);
    expect(h.queue.items.map((item) => item.kind === 'notice' ? [item.source, item.text] : null)).toEqual([
      ['capsule-done', capsuleDoneNotice(DONE)],
    ]);
    expect(capsuleDoneNotice(DONE)).toBe('캡슐 완료: agent scan · ok · 60s — ok · capsule:c-7');
    expect(life.length).toBe(1);
    expect(life[0]![2]).toMatchObject({ sessionId: 's-1', capsuleId: 'c-7', queued: true });
  });

  test('a replay of the same capsule while still queued = no second notice, no second knock; progress never knocks', () => {
    const h = harness();
    h.listeners[0]!(DONE);
    h.listeners[0]!(DONE);
    h.listeners[0]!({ type: 'capsule-progress', capsuleId: 'c-8', kind: 'agent', sessionId: 's-1', at: 1, line: 'x' });
    expect(h.knocks()).toBe(1);
    expect(h.queue.items.length).toBe(1);
    h.listeners[0]!({ ...DONE, capsuleId: 'c-9' });
    expect(h.knocks()).toBe(2);
    h.stop!();
    expect(h.unsubscribed()).toBe(1);
  });
});
