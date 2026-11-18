import { describe, expect, test } from 'bun:test';
import { debug } from './log.js';
import { emitTurnLife } from './turn-life.js';
import { createNextTuiQueue } from '../tui/core/queue.js';
import { createInternalTurnGate } from '../tui/input/internal-turn.js';
import type { LogRecord } from '../mss/logging/record.js';

// ── OBSERVE-TURN-EVENT-LIFECYCLE ──────────────────────────────────────────────
// 'turn-life' 관측 사건이 실제 debug 회로로 방출되는지 `debug.registerSink` 로
// 붙잡아 검증한다. 관측 호출은 fail-open 이고, 시험도 마찬가지로 finally 에서
// sink 해제와 debug 게이트 원상복구를 한다.

describe('turn-life observation events (registerSink capture)', () => {
  function capture(): { seen: LogRecord[]; done: () => void } {
    const seen: LogRecord[] = [];
    const off = debug.registerSink({ name: 'turn-life-test', emit: (rec) => { seen.push(rec); } });
    debug.enable(); // dispatcher 는 isAnySinkEnabled() 일 때만 방출한다.
    return { seen, done: () => { off(); debug.disable(); } };
  }

  test('emitTurnLife → debug 회로: category turn-life · event · data 그대로', () => {
    const { seen, done } = capture();
    try {
      emitTurnLife('turn-life:test-ping', { marker: 1 });
      const hit = seen.find((r) => r.category === 'turn-life' && r.event === 'turn-life:test-ping');
      expect(hit).toBeDefined();
      // logger 가 payload 에 runId·hostId 를 보태므로(enrichDebugRecord) 부분 매치로 검증한다.
      expect(hit?.data).toMatchObject({ marker: 1 });
    } finally { done(); }
  });

  test('queue: enqueue → event-queued · dequeue → event-dequeued (itemId · boundary)', () => {
    const { seen, done } = capture();
    try {
      const queue = createNextTuiQueue({ log: () => {} });
      const item = queue.enqueue('hello');
      const queued = seen.find((r) => r.event === 'turn-life:event-queued');
      expect(queued?.category).toBe('turn-life');
      expect(queued?.data).toMatchObject({ itemId: item.id, kind: 'user', delivery: 'queue', queuedCount: 1 });
      expect(queued?.data).toMatchObject({ eventId: item.id }); // 출처: TC #91989 — user 항목은 msgId 없음 → eventId=item.id
      expect(queue.settle('draft')).toEqual({ kind: 'wake' });
      expect(queue.dequeue()).toEqual({ kind: 'submit', itemKind: 'user', id: item.id, text: 'hello', remaining: 0, afterInterrupt: false });
      const dequeued = seen.find((r) => r.event === 'turn-life:event-dequeued');
      expect(dequeued?.data).toMatchObject({ itemId: item.id, source: null });
      expect(dequeued?.data).toMatchObject({ eventId: item.id }); // 출처: TC #91989 — user 항목은 msgId 없음 → eventId=item.id
      expect(Object.keys(dequeued?.data ?? {})).toContain('boundary');
    } finally { done(); }
  });

  test('internal-turn gate: busy 반납 → event-while-busy (source · action defer)', () => {
    const { seen, done } = capture();
    try {
      const gate = createInternalTurnGate({
        isTurnRunning: () => true,
        getBufferText: () => undefined,
        getTypeaheadCount: () => 0,
      });
      const result = gate.startTurnIfIdle('테스트', { origin: 'scheduled' });
      expect(result).toMatchObject({ opened: false, reason: 'NotIdle' });
      const busy = seen.find((r) => r.event === 'turn-life:event-while-busy');
      expect(busy?.category).toBe('turn-life');
      expect(busy?.data).toMatchObject({ source: 'scheduled', action: 'defer' });
    } finally { done(); }
  });

  test('internal-turn gate: 문이 열리면 event-queued (itemId = eventId = turnId)', () => {
    // 출처: TC #91989 — 내부 문 사건의 eventId 는 그 문의 turnId(제 싸움 id)다.
    const { seen, done } = capture();
    try {
      const gate = createInternalTurnGate({
        isTurnRunning: () => false,
        getBufferText: () => undefined,
        getTypeaheadCount: () => 0,
      });
      gate.port.attach(() => true); // requestYield 가 true 를 반환해야 문이 열린다.
      const result = gate.startTurnIfIdle('테스트', { origin: 'scheduled' });
      expect(result).toMatchObject({ opened: true });
      if (result.opened !== true) throw new Error('gate did not open');
      const queued = seen.find((r) => r.event === 'turn-life:event-queued');
      expect(queued?.category).toBe('turn-life');
      expect(queued?.data).toMatchObject({ itemId: result.turnId, eventId: result.turnId, kind: 'internal', source: 'scheduled', delivery: 'queue' });
    } finally { done(); }
  });
});
