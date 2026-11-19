import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/** TC #92565 — turn-start 사건 5방출점의 eventId 결속 리터럴 대조(#38804 eventId 규칙의 turn-start 확장). */
describe('turn-start 관측 eventId 결속 — 5 방출점 리터럴', () => {
  const entry = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');

  test('1813 라벨 매칭 배선 — 매칭된 라벨의 eventId 칸이 그대로 방출된다', () => {
    // 출처: #38845 — 느슨한 숫자 경계 대신 순서 리터럴 단언: 첫 방출 블록 안에서
    // door 배선이 turnSessionId 앞에 오고 eventId 확산 라인이 그 사이에 있는지 본문 그대로로 증명한다.
    const at = entry.indexOf("emitTurnLife('turn-life:turn-start', {");
    const block = entry.slice(at, entry.indexOf('turnSessionId,', at));
    expect(block).toContain("door: matched ? label!.door : 'human',"); // 출처: #38804 — 라벨 문 리터럴
    expect(block).toContain('...(matched && label!.eventId !== undefined ? { eventId: label!.eventId } : {})'); // 출처: #38804 — eventId 확산
  });

  test('채팅 턴 밖 busy 4분기 — eventId = turnSessionId(id) 리터럴', () => {
    const doors = ['internal', 'provider', 'harness'] as const;
    const busy = entry.match(/emitTurnLife\('turn-life:turn-start', \{ door: '[a-z]+', turnSessionId: id[^}]*\}\)/g) ?? [];
    expect(busy.length).toBe(4); // 출처: #38804 내부(internal)·provider·harness 방출점 수 — internal×2(compact·now) + provider + harness
    for (const line of busy) {
      expect(line).toContain('eventId: id');
    }
    for (const door of doors) {
      expect(busy.filter((line) => line.includes(`door: '${door}'`)).length).toBe(door === 'internal' ? 2 : 1);
    }
  });

  test('라벨 세터 4곳 — eventId 값 규칙(알림·queue-user = msgId ?? id #38804 · internal = turnId)', () => {
    expect(entry.includes("source: held.source ?? undefined, eventId: held.msgId ?? held.id }")).toBe(true); // held-notice — 출처: #38804
    expect(entry.includes("source: handoff.source ?? undefined, eventId: handoff.msgId ?? handoff.id }")).toBe(true); // replay notice — 출처: #38804
    expect(entry.includes("itemId: handoff.id, eventId: handoff.msgId ?? handoff.id }")).toBe(true); // queue-user — 출처: #38804
    expect(entry.includes("itemId: request.turnId, eventId: request.turnId }")).toBe(true); // internal-turn gate
  });

  test('우편(msgId 있음) 1건의 사슬 — 도착→큐→꺼냄(#38804) → turn-start 도 같은 eventId 리터럴', () => {
    // 출처: OP msg:93180 must 1ⓑ — #38804 의 seat-mail-arrival.test.ts 리터럴이 우편 1통(msgId=7)의
    // arrived·queued·dequeued·acked 네 사건을 eventId 7,7,7,7 로 증명한다. 이 시험은 그 사슬의 다섯째
    // 다리(turn-start)가 같은 표현식(item.msgId ?? item.id)을 쓰는지 원문 리터럴로 증명한다 — 두 시험을
    // 합치면 우편 1통의 다섯 사건 전부가 같은 7 이다.
    const labels = entry.match(/turnStartLabel = \{ door: 'queue-(?:notice|user)'[^}]*\};/g) ?? [];
    expect(labels.length).toBe(3); // 출처: OP msg:93180 — queue-notice 2곳(held·replay) + queue-user 1곳
    for (const line of labels) {
      const sameChainId = line.includes('eventId: held.msgId ?? held.id') || line.includes('eventId: handoff.msgId ?? handoff.id');
      expect(sameChainId).toBe(true); // 세 배선 모두 #38804 사슬 표현식
    }
    // 재접수(held)로 되돌아가도 msgId 가 떨어지지 않는다 — 사슬이 다시 시작돼도 같은 id.
    expect(entry.includes('...(handoff.msgId === undefined ? {} : { msgId: handoff.msgId })')).toBe(true);
    // 방출 지점은 라벨의 eventId 를 그대로 흘린다 — number 도 그대로(#38804 의 eventId 7 과 같은 값).
    expect(entry.includes('eventId?: string | number')).toBe(true);
    expect(entry.includes('label!.eventId !== undefined ? { eventId: label!.eventId }')).toBe(true);
  });
});
