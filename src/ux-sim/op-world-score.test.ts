import { describe, expect, test } from 'bun:test';
import { parseOpWorldAnswerKey } from './op-world-score.js';

describe('parseOpWorldAnswerKey — 원장·우편 일관 서울 날짜 기준 (terra r4 mustFix 3 · #39377)', () => {
  const localDate = '2026-11-21';

  test('UTC 원장 기록은 서울 자정 넘김을 우편과 같은 서울 날짜로 분류한다', () => {
    const tsv = '2026-11-20T16:00:00Z\tOP\t서울 기준 11-21 01:00 판단';
    const mail = [{ from: 'OP', id: '115549', createdAt: '2026-11-21T01:00:00+09:00', body: '같은 순간의 우편 기록' }];
    // 2026-11-20T16:00:00Z == 2026-11-21 01:00 KST — 두 소스 모두 서울 기준 2026-11-21 이어야 한다.
    // RED: 현재는 원장 날짜 부분(2026-11-20) 을 그대로 비교해 이 기록이 잘못 제외된다.
    expect(parseOpWorldAnswerKey(tsv, mail, localDate).map(row => row.id))
      .toEqual(['decision-ledger:1', 'op-mail:115549']);
  });

  test('서울 기준 다른 날짜인 UTC 원장 기록은 계속 제외된다', () => {
    // 2026-11-21T20:00:00Z == 서울 11-22 05:00 → 원장 날짜 부분(2026-11-21) 과 무관하게 11-21 에서 제외.
    // RED: 현재는 날짜 부분이 localDate 와 같아 이 기록이 잘못 포함된다.
    const tsv = '2026-11-21T20:00:00Z\tOP\t서울 기준 11-22 판단';
    expect(parseOpWorldAnswerKey(tsv, [], localDate)).toEqual([]);
  });

  test('무오프셋 원장 표기는 기록된 달력 날짜(서울 현지 기준)를 그대로 쓴다', () => {
    expect(parseOpWorldAnswerKey('11-21 09:30\tOP\t당일 판단', [], localDate).map(row => row.id))
      .toEqual(['decision-ledger:1']);
    expect(parseOpWorldAnswerKey('2026-11-21T09:30\tOP\t당일 판단', [], localDate).map(row => row.id))
      .toEqual(['decision-ledger:1']);
    expect(parseOpWorldAnswerKey('11-20 23:59\tOP\t전일 판단', [], localDate)).toEqual([]);
  });

  test('원장 timestamp 로 쓴 evidence time 은 원문 필드를 그대로 담는다', () => {
    const tsv = '2026-11-20T16:00:00Z\tOP\t서울 기준 11-21 01:00 판단';
    const [row] = parseOpWorldAnswerKey(tsv, [], localDate);
    expect(row?.time).toBe('2026-11-20T16:00:00Z');
    expect(row?.body).toBe(tsv);
  });
});
