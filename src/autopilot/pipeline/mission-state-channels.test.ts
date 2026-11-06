// 조율자 격상 P1 foundation — 채널 reducer 프리미티브 + arcHint 손실 차단 검증.
import { test, expect, describe } from 'bun:test';
import { applyChannelUpdate, applyChannelUpdates, effectiveArcHint, MISSION_CHANNEL_REDUCERS, cursorUpdate, readCursor, signalUpdate, readSignal } from './mission-state-channels.js';

describe('mission-state-channels — reducer 프리미티브(P1 foundation)', () => {
  // reduceChannel 은 src/agent-substrate/state-channels.ts 의 재수출 — 순수 reducer 표(lastValue·append·null 보존)는
  // src/agent-substrate/state-channels.test.ts 가 잠근다. 여기서는 미션 스키마(arcHint=append)와 손실 체인만 본다.
  test('arcHint 는 append 채널(스키마)', () => {
    expect(MISSION_CHANNEL_REDUCERS.arcHint).toBe('append');
    expect(MISSION_CHANNEL_REDUCERS.decisions).toBe('lastValue');
  });

  test('★ INCIDENT 손실체인 차단 — arcHint=5 후 undefined 가 와도 5 유지', () => {
    let s = applyChannelUpdate({}, 'arcHint', 5);       // 사용자가 5 아크 선택
    expect(effectiveArcHint(s)).toBe(5);
    s = applyChannelUpdate(s, 'arcHint', undefined);    // 하류 파싱 실패(종전엔 여기서 소실)
    expect(effectiveArcHint(s)).toBe(5);                // ★ append 라 여전히 5
    s = applyChannelUpdate(s, 'arcHint', 2);            // 이후 재판정 2
    expect(effectiveArcHint(s)).toBe(2);                // 마지막 non-null
  });

  test('lastValue 채널이었다면 소실됐을 것(대조)', () => {
    // decisions(lastValue)는 undefined 로 덮이면 소실 — arcHint 를 append 로 둔 이유.
    let s = applyChannelUpdate({}, 'decisions', { scope: 'heavy' });
    s = applyChannelUpdate(s, 'decisions', undefined);
    expect(s.decisions).toBeUndefined(); // lastValue 는 덮어씀(대조군)
  });

  test('applyChannelUpdates — 배치 fold', () => {
    const s = applyChannelUpdates({}, [
      { channel: 'arcHint', value: 3 },
      { channel: 'research', value: { ok: true } },
      { channel: 'arcHint', value: 4 },
    ]);
    expect(effectiveArcHint(s)).toBe(4);
    expect(s.research).toEqual({ ok: true });
    expect(s.arcHint).toEqual([3, 4]); // append 이력
  });

  test('알 수 없는 채널은 lastValue(보수적)', () => {
    expect(applyChannelUpdate({}, 'unknownChan', 1).unknownChan).toBe(1);
  });
});

describe('UR3 재개 커서 — cursorUpdate·readCursor(리플레이→재개)', () => {
  test('cursor 는 lastValue 채널', () => {
    expect(MISSION_CHANNEL_REDUCERS.cursor).toBe('lastValue');
  });
  test('cursorUpdate → readCursor 왕복', () => {
    const state = applyChannelUpdates({}, [cursorUpdate({ phaseId: 'task:1', phaseTitle: '조사', reason: 'goto seq 3' })]);
    expect(readCursor(state)?.phaseId).toBe('task:1');
    expect(readCursor(state)?.reason).toBe('goto seq 3');
  });
  test('null 로 클리어(1회 소비) → readCursor undefined', () => {
    let state = applyChannelUpdates({}, [cursorUpdate({ phaseId: 'task:1' })]);
    state = applyChannelUpdates(state, [cursorUpdate(null)]);
    expect(readCursor(state)).toBeUndefined();
  });
  test('빈 State·빈 phaseId → undefined(비파괴)', () => {
    expect(readCursor({})).toBeUndefined();
    expect(readCursor({ cursor: { phaseId: '' } })).toBeUndefined();
  });
});

describe('CW3 signal control — signalUpdate·readSignal(조율자→walker mid-phase 신호)', () => {
  test('signal 은 lastValue 채널', () => {
    expect(MISSION_CHANNEL_REDUCERS.signal).toBe('lastValue');
  });
  test('signalUpdate(abort) → readSignal 왕복', () => {
    const state = applyChannelUpdates({}, [signalUpdate({ kind: 'abort', reason: '조율자 개입·과부하', at: 111 })]);
    expect(readSignal(state)?.kind).toBe('abort');
    expect(readSignal(state)?.reason).toBe('조율자 개입·과부하');
    expect(readSignal(state)?.at).toBe(111);
  });
  test('signalUpdate(pause) → readSignal 왕복', () => {
    const state = applyChannelUpdates({}, [signalUpdate({ kind: 'pause' })]);
    expect(readSignal(state)?.kind).toBe('pause');
  });
  test('null 로 클리어(walker 소비 후·1회성) → readSignal undefined', () => {
    let state = applyChannelUpdates({}, [signalUpdate({ kind: 'abort' })]);
    state = applyChannelUpdates(state, [signalUpdate(null)]);
    expect(readSignal(state)).toBeUndefined();
  });
  test('빈 State·미지의 kind → undefined(비파괴·무회귀 방어)', () => {
    expect(readSignal({})).toBeUndefined();
    expect(readSignal({ signal: { kind: 'bogus' } })).toBeUndefined();
    expect(readSignal({ signal: null })).toBeUndefined();
  });
});
