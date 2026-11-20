// SEAT-TURN-MIDTURN-MAIL (OP #106231/#106233 · 설계 OP #106281 · OP #106762 ⓐ 세션 1회) — 레지스트리 단위시험(② · 도착순).
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearMidTurnEvents,
  drainMidTurnEvents,
  enqueueMidTurnEvent,
  midTurnEventCount,
} from './mid-turn-events.js';

const SEAT_A = 'midturn-test-seat-a';
const SEAT_B = 'midturn-test-seat-b';

describe('mid-turn-events — 세션별 턴 중 이벤트함', () => {
  beforeEach(() => {
    clearMidTurnEvents(SEAT_A);
    clearMidTurnEvents(SEAT_B);
  });

  test('도착순 보존 — drain 는 비우면서 들어온 순서 그대로 낸다', () => {
    expect(enqueueMidTurnEvent(SEAT_A, { kind: 'seat-mail', id: '101', text: 'mail 101' })).toBe(true);
    expect(enqueueMidTurnEvent(SEAT_A, { kind: 'capsule-done', id: 'caps-7', text: 'capsule 7 done' })).toBe(true);
    expect(enqueueMidTurnEvent(SEAT_A, { kind: 'seat-mail', id: '102', text: 'mail 102' })).toBe(true);
    expect(midTurnEventCount(SEAT_A)).toBe(3);
    const drained = drainMidTurnEvents(SEAT_A);
    expect(drained.map((e) => [e.kind, e.id, e.text])).toEqual([
      ['seat-mail', '101', 'mail 101'],
      ['capsule-done', 'caps-7', 'capsule 7 done'],
      ['seat-mail', '102', 'mail 102'],
    ]);
    expect(drained.every((e) => typeof e.occurredAt === 'number')).toBe(true);
    expect(midTurnEventCount(SEAT_A)).toBe(0); // 비웠다
    expect(drainMidTurnEvents(SEAT_A)).toEqual([]); // 두 번째 배수는 빈값
  });

  test('② 중복 0 — 같은 (kind,id) 가 대기 중이거나 세션에서 이미 배수됐으면 안 들어감', () => {
    expect(enqueueMidTurnEvent(SEAT_A, { kind: 'seat-mail', id: '42', text: '[seat-mail] #42 첫 도착' })).toBe(true);
    expect(enqueueMidTurnEvent(SEAT_A, { kind: 'seat-mail', id: '42', text: '[seat-mail] #42 재도착(무시)' })).toBe(false);
    expect(midTurnEventCount(SEAT_A)).toBe(1);
    const drained = drainMidTurnEvents(SEAT_A);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.text).toBe('[seat-mail] #42 첫 도착'); // 첫 도착 문면이 보존된다
    // OP #106762 ⓐ — 세션 1회: 배수된 (kind,id) 는 다시 안 들어간다(우편 재방출·capsule 리플레이 방지).
    expect(enqueueMidTurnEvent(SEAT_A, { kind: 'seat-mail', id: '42', text: '[seat-mail] #42 또 도착' })).toBe(false);
    expect(midTurnEventCount(SEAT_A)).toBe(0);
    // kind 가 다르면 같은 id 라도 별개 사건이다.
    expect(enqueueMidTurnEvent(SEAT_A, { kind: 'capsule-done', id: '42', text: 'capsule' })).toBe(true);
    clearMidTurnEvents(SEAT_A);
  });

  test('onDrained — 배수 시 원본 큐에서 같은 사건을 지운다(pending-input.ts:29 계약)', () => {
    const originalQueue = new Set(['q-1', 'q-2']);
    const seenAt: number[] = [];
    expect(
      enqueueMidTurnEvent(SEAT_B, { kind: 'seat-mail', id: '201', text: 'mail 201' }, (texts, items) => {
        expect(texts).toEqual(['mail 201']);
        for (const item of items) {
          if (item.kind === 'seat-mail' && item.id === '201') {
            originalQueue.delete('q-1'); // ① 원본 큐에서 그 항목을 지운다
            seenAt.push(item.occurredAt); // ② seen 계기 — 끼워 넣은 시점에 기록한다
          }
        }
      }),
    ).toBe(true);
    expect(midTurnEventCount(SEAT_B)).toBe(1);
    drainMidTurnEvents(SEAT_B);
    expect(originalQueue.has('q-1')).toBe(false); // 지워졌다
    expect(originalQueue.has('q-2')).toBe(true); // 다른 항목은 그대로
    expect(seenAt).toHaveLength(1);
  });

  test('세션 1회(OP #106762 ⓐ) — clearMidTurnEvents 는 배수된 (kind,id) 집합도 비운다', () => {
    expect(enqueueMidTurnEvent(SEAT_A, { kind: 'seat-mail', id: '7', text: 'first' })).toBe(true);
    expect(drainMidTurnEvents(SEAT_A)).toHaveLength(1);
    expect(enqueueMidTurnEvent(SEAT_A, { kind: 'seat-mail', id: '7', text: 'again' })).toBe(false); // 세션 동안 한 번
    clearMidTurnEvents(SEAT_A);
    expect(enqueueMidTurnEvent(SEAT_A, { kind: 'seat-mail', id: '7', text: 'after clear' })).toBe(true); // 집합도 비웠다
  });

  test('세션 격리 — 다른 세션 함은 건드리지 않는다 · clear 는 그 세션만 비운다', () => {
    enqueueMidTurnEvent(SEAT_A, { kind: 'seat-mail', id: '1', text: 'a' });
    enqueueMidTurnEvent(SEAT_B, { kind: 'seat-mail', id: '1', text: 'b' });
    expect(midTurnEventCount(SEAT_A)).toBe(1);
    expect(midTurnEventCount(SEAT_B)).toBe(1);
    clearMidTurnEvents(SEAT_A);
    expect(midTurnEventCount(SEAT_A)).toBe(0);
    expect(midTurnEventCount(SEAT_B)).toBe(1); // B 는 살아 있다
    expect(drainMidTurnEvents(SEAT_B).map((e) => e.text)).toEqual(['b']);
  });
});
