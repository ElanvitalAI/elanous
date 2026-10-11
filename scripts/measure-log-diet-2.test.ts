import { describe, expect, test } from 'bun:test';
import {
  LOG_DIET_2_LOAD,
  LOG_DIET_KEYS_0_2_23,
  REPLAY_FLUSH_EVERY_MS,
  buildReplayRecords,
  isJudgmentPath,
  measureLogDiet2,
  replayDiet,
} from './measure-log-diet-2.js';
import { LOG_DIET_KEYS, LogDietGuard } from '../src/debug/log-diet.js';

describe('LOG-DIET-2 판정선 (0.2.24 칸)', () => {
  const m = measureLogDiet2();

  test('기준선은 현재 정책의 부분집합이다 — 새 키 셋이 얼린 사본에는 없다', () => {
    expect(Object.keys(LOG_DIET_KEYS_0_2_23)).toHaveLength(6);
    for (const key of ['llm.credential/provider-key-missing', 'llm.credential/provider-key-resolved', 'pty.manifest/output-bytes-flushed']) {
      expect(LOG_DIET_KEYS_0_2_23[key]).toBeUndefined();
      expect(LOG_DIET_KEYS[key]).toBe('repeat');
    }
  });

  test('판정 ① 같은 부하에서 시간당 행이 60% 이상 준다', () => {
    expect(m.before.rowsOut).toBe(m.records); // 0.2.23 은 이 부하를 하나도 접지 못한다
    expect(m.reduction).toBeGreaterThanOrEqual(0.6);
    expect(m.after.rowsOut).toBeLessThan(m.before.rowsOut);
  });

  test('판정 ② 는 재생으로 판정하지 않는다 — 요약 행 비중은 참고값일 뿐이다', () => {
    expect(m.after.summaryShare).toBeGreaterThanOrEqual(0);
    expect(m.after.summaryShare).toBeLessThanOrEqual(1);
    expect(m.after.rowsOut).toBe(m.after.originalRows + m.after.summaryRows);
  });

  test('판정 ③ 판정 경로(미등록 키) 이벤트 손실이 0이다', () => {
    expect(m.after.judgmentRowsIn).toBeGreaterThan(0);
    expect(m.after.judgmentRowsOut).toBe(m.after.judgmentRowsIn);
    expect(m.after.judgmentLoss).toBe(0);
  });

  test('접힌 카운트는 사라지지 않는다 — 원본+요약 카운트 합이 입력과 같다', () => {
    expect(m.after.originalRows + m.after.suppressedTotal).toBe(m.records);
    expect(m.before.originalRows + m.before.suppressedTotal).toBe(m.records);
  });

  test('요약 행은 flush 주기마다 나오지 않고 절식 주기를 지킨다', () => {
    const records = buildReplayRecords(LOG_DIET_2_LOAD.slice(0, 1));
    const perFlush = replayDiet(
      records,
      now => new LogDietGuard({ now, summaryMinIntervalMs: 0, summaryMaxPending: 1 }),
      REPLAY_FLUSH_EVERY_MS,
    );
    const throttled = replayDiet(records, now => new LogDietGuard({ now }), REPLAY_FLUSH_EVERY_MS);
    expect(perFlush.summaryRows).toBeGreaterThan(throttled.summaryRows);
    expect(throttled.originalRows).toBe(perFlush.originalRows); // 접는 판정은 같다, 요약 «빈도»만 다르다
    expect(throttled.suppressedTotal).toBe(perFlush.suppressedTotal); // 카운트 총량은 보존된다
  });

  test('판정 경로 소비자 키 pod-lease/admit-by-usage 는 접지 않는다 — 반복 행이 전부 통과한다', () => {
    // dispatch-backpressure `admissionCounts` 와 TA parent-host 가 이 행을 로그에서 다시 세어 판정한다.
    expect(LOG_DIET_KEYS['pod-lease/admit-by-usage']).toBeUndefined();
    const guard = new LogDietGuard({ now: () => 0 });
    const rec = { category: 'pod-lease', event: 'admit-by-usage', data: { recommended: 0, runId: 'r1' } } as Parameters<LogDietGuard['admit']>[0];
    expect(Array.from({ length: 5 }, () => guard.admit(rec).pass)).toEqual([true, true, true, true, true]);
    expect(guard.drain()).toEqual([]);
  });

  test('미등록 키는 판정 경로이고 등록 키는 아니다', () => {
    expect(isJudgmentPath({ category: 'log-diet.replay', event: 'judgment-path' })).toBe(true);
    expect(isJudgmentPath({ category: 'llm.credential', event: 'provider-key-missing' })).toBe(false);
    expect(isJudgmentPath({ category: 'log.diet', event: 'suppressed' })).toBe(false);
  });
});
