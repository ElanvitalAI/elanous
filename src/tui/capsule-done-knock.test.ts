import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import type { CapsuleDoneEvent, CapsuleEvent } from '../turn-capsule/contract.js';
import { wireCapsuleDoneKnock } from './capsule-done-knock.js';
import { capsuleDoneNotice, createChildNoticeProducers } from './core/notice-producers.js';
import { createNextTuiQueue } from './core/queue.js';
import { clearMidTurnEvents, drainMidTurnEvents, enqueueMidTurnEvent, midTurnEventCount } from '../session/mid-turn-events.js';

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

describe('B1 TUI wiring — capsule-done waits in one notice without a result-only wake', () => {

  test('done → notice queued with source capsule-done and the capsule id · no result-only knock · turn-life logged', () => {
    const log = spyOn(debug, 'log');
    const h = harness();
    h.listeners[0]!(DONE);
    const life = log.mock.calls.filter((call) => call[0] === 'turn-life' && call[1] === 'turn-life:capsule-done-knock');
    log.mockRestore();
    expect(h.knocks()).toBe(0);
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
    expect(h.knocks()).toBe(0);
    expect(h.queue.items.length).toBe(1);
    h.listeners[0]!({ ...DONE, capsuleId: 'c-9' });
    expect(h.knocks()).toBe(0);
    // 출처: #126740 이 fixture 는 c-7 과 c-9 두 고유 완료 프레임을 보냈다.
    expect(h.queue.items[0]).toMatchObject({ capsuleCount: 2 });
    h.stop!();
    expect(h.unsubscribed()).toBe(1);
  });
});

// SEAT-TURN-MIDTURN-MAIL ④ · OP #106762 ⓐ 리터럴 — busy 턴 중 완료는 이벤트함에 큐 노티스 문면 그대로를
// 한 건 싣고, 배수 시 큐 항목을 지운다(제거 1회 · 같은 capsule 세션 1회).
describe('④ mid-turn adapter — busy turn sees the capsule, idle still knocks', () => {

  function busyHarness(session: string) {
    const queue = createNextTuiQueue();
    const notices = createChildNoticeProducers(queue);
    const listeners: Array<(event: CapsuleEvent) => void> = [];
    let knocks = 0;
    const removals: Array<{ source: string; msgId?: number; text?: string; capsuleId?: string }> = [];
    wireCapsuleDoneKnock({
      sessionId: session,
      subscribe: (_sessionId, listener) => { listeners.push(listener); return () => {}; },
      enqueue: (event) => notices.capsuleDone(event, event.endedAt),
      knock: () => { knocks++; },
      busy: () => true,
      enqueueMidTurn: (event, onDrained) => enqueueMidTurnEvent(session, event, onDrained),
      removeQueuedNotice: (match) => {
        removals.push(match);
        if (match.capsuleId) return Number(queue.removeCapsuleDoneNotice(match.capsuleId));
        const wanted = queue.items.filter((item) => item.kind === 'notice' && item.source === match.source && item.text === match.text);
        let removed = 0;
        for (const item of wanted) { try { queue.cancel(item.id, 'mid-turn-carried'); removed += 1; } catch { /* fail-open */ } }
        return removed;
      },
    });
    return { queue, listeners, knocks: () => knocks, removals };
  }

  test('⑤ busy: 이벤트 문면 = 큐 노티스 문면 · drain → 큐 제거 1회 · 재전파 이벤트 0(세션 1회)', () => {
    const session = 'midturn-capsule-literal';
    clearMidTurnEvents(session);
    const h = busyHarness(session);
    h.listeners[0]!(DONE);
    expect(midTurnEventCount(session)).toBe(1);
    expect(h.knocks()).toBe(0);
    const drained = drainMidTurnEvents(session);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.kind).toBe('capsule-done');
    expect(drained[0]!.id).toBe('capsule:c-7');
    expect(drained[0]!.text).toBe(capsuleDoneNotice(DONE)); // 실제 노티스 문면(캡슐 완료: … — 문면 일치)
    expect(h.removals).toEqual([{ source: 'capsule-done', text: capsuleDoneNotice(DONE), capsuleId: DONE.capsuleId }]); // 제거 1회
    expect(h.queue.items.filter((item) => item.source === 'capsule-done')).toHaveLength(0); // 큐는 비었다
    h.listeners[0]!(DONE); // 재전파 — 세션 1회(OP #106762 ⓐ)
    expect(midTurnEventCount(session)).toBe(0); // 리플레이 이벤트 0건
    expect(h.removals).toHaveLength(1); // 배수 뒤 재전파는 제거도 다시 하지 않는다(이미 지웠다)
    clearMidTurnEvents(session);
  });

  test('busy: one mid-turn event per capsule, no double on replay', () => {
    const session = 'midturn-capsule-replay';
    clearMidTurnEvents(session);
    const h = busyHarness(session);
    h.listeners[0]!(DONE);
    expect(midTurnEventCount(session)).toBe(1);
    h.listeners[0]!(DONE); // 재전파(대기 중) — 중복 0(예전 Date.now id 와 달리 같은 id 로 막힌다)
    expect(midTurnEventCount(session)).toBe(1);
    expect(h.knocks()).toBe(0); // 결과 알림만으로 새 턴을 열지 않는다
    const drained = drainMidTurnEvents(session);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.id).toBe('capsule:c-7');
    clearMidTurnEvents(session);
  });

  test('idle: mid-turn deps wired but busy=false → no mid-turn event or result-only knock', () => {
    const session = 'midturn-capsule-idle';
    clearMidTurnEvents(session);
    const queue = createNextTuiQueue();
    const notices = createChildNoticeProducers(queue);
    const listeners: Array<(event: CapsuleEvent) => void> = [];
    let knocks = 0;
    wireCapsuleDoneKnock({
      sessionId: session,
      subscribe: (_sessionId, listener) => { listeners.push(listener); return () => {}; },
      enqueue: (event) => notices.capsuleDone(event, event.endedAt),
      knock: () => { knocks++; },
      busy: () => false,
      enqueueMidTurn: (event) => enqueueMidTurnEvent(session, event),
    });
    listeners[0]!(DONE);
    expect(knocks).toBe(0);
    expect(midTurnEventCount(session)).toBe(0);
    clearMidTurnEvents(session);
  });
});
