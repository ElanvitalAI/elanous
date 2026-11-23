import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import type { CapsuleDoneEvent, CapsuleEvent } from '../turn-capsule/contract.js';
import { wireCapsuleDoneKnock } from './capsule-done-knock.js';
import { capsuleDoneNotice, createChildNoticeProducers } from './core/notice-producers.js';
import { createNextTuiQueue } from './core/queue.js';
import { PASSIVE_RESULT_CARRY_MAX } from './passive-result-turn.js';

/**
 * ELN-CAPSULE-RESULT-NO-REPEAT-REPORT (OP 0.3.34 P1-4) — 캡슐 결과 = 원 일감 흡수 · 닫힌 칸 재보고 0.
 * 흡수(busy 턴 배수 · 다음 턴 passive carry)로 닫힌 캡슐 결과가 같은 큐(세션)에서 재주입(재play·재접속)
 * 되어도 두 번째 표면 보고가 나오지 않는다. 닫힘은 캡슐 단위 — 새 캡슐 완료는 그대로 한 번 보고된다.
 */

const DONE: CapsuleDoneEvent = {
  type: 'capsule-done', capsuleId: 'c-7', kind: 'shell', sessionId: 's-p14',
  startedAt: 1_000, endedAt: 61_000, status: 'ok', summary: 'Bash … ok · 45s',
};

function harness() {
  const queue = createNextTuiQueue();
  const notices = createChildNoticeProducers(queue);
  const listeners: Array<(event: CapsuleEvent) => void> = [];
  wireCapsuleDoneKnock({
    sessionId: 's-p14',
    subscribe: (_sessionId, listener) => { listeners.push(listener); return () => {}; },
    enqueue: (event) => notices.capsuleDone(event, event.endedAt),
    knock: () => {},
  });
  return { queue, listeners };
}

const capsuleRows = (queue: ReturnType<typeof createNextTuiQueue>) =>
  queue.items.filter((item) => item.source === 'capsule-done');

describe('ELN-CAPSULE-RESULT-NO-REPEAT-REPORT — 닫힌 칸(흡수된 캡슐 결과) 재보고 0', () => {
  test('busy 턴 배수로 흡수된 캡슐의 재주입 = 새 노티스 0 · knock 영수 queued:false', () => {
    const h = harness();
    h.listeners[0]!(DONE);
    expect(capsuleRows(h.queue)).toHaveLength(1);             // ① 첫 보고 — 원문 그대로
    expect(h.queue.items[0]!.text).toBe(capsuleDoneNotice(DONE));
    expect(h.queue.removeCapsuleDoneNotice(DONE.capsuleId)).toBe(true);   // ② busy 턴 배수 = 흡수
    expect(capsuleRows(h.queue)).toHaveLength(0);
    const log = spyOn(debug, 'log');
    h.listeners[0]!(DONE);                                    // ③ 재주입(재play·재접속)
    const life = log.mock.calls.filter((call) => call[0] === 'turn-life' && call[1] === 'turn-life:capsule-done-knock');
    log.mockRestore();
    expect(capsuleRows(h.queue)).toHaveLength(0);             // 닫힌 칸 재보고 0
    expect(life).toHaveLength(1);
    expect(life[0]![2]).toMatchObject({ capsuleId: 'c-7', queued: false });  // 무시(중복) 영수
  });

  test('다음 턴 passive carry 로 흡수된 캡슐의 재주입 = 새 노티스 0', () => {
    const h = harness();
    h.listeners[0]!(DONE);
    expect(capsuleRows(h.queue)).toHaveLength(1);
    const rows = h.queue.passiveResultNotices(PASSIVE_RESULT_CARRY_MAX);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.capsuleIds).toEqual([DONE.capsuleId]);
    expect(h.queue.consumePassiveResultNotices(rows)).toBe(1);   // ② 흡수 — 실제 턴이 결과를 싣는다
    expect(capsuleRows(h.queue)).toHaveLength(0);
    h.listeners[0]!(DONE);                                        // ③ 재주입
    expect(capsuleRows(h.queue)).toHaveLength(0);                 // 닫힌 칸 재보고 0
  });

  test('닫힘은 캡슐 단위 — 흡수 뒤 새 캡슐 완료는 그대로 한 번 보고된다', () => {
    const h = harness();
    h.listeners[0]!(DONE);
    expect(h.queue.consumeCapsuleDoneSummary()).toBe(true);       // ② 흡수 — 요약 행이 원 일감으로
    expect(capsuleRows(h.queue)).toHaveLength(0);
    h.listeners[0]!(DONE);                                        // ③ 재주입
    expect(capsuleRows(h.queue)).toHaveLength(0);                 // 닫힌 c-7 재보고 0
    const LATER: CapsuleDoneEvent = { ...DONE, capsuleId: 'c-9', summary: '다음 캡슐 · ok · 10s' };
    h.listeners[0]!(LATER);
    expect(capsuleRows(h.queue)).toHaveLength(1);                 // ④ 새 캡슐 = 새 칸, 그대로 보고
    expect(h.queue.items[0]!.text).toBe(capsuleDoneNotice(LATER));
  });
});
