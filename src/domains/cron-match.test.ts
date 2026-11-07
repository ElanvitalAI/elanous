import { test, expect, describe } from 'bun:test';
import { matchField, cronMatches, prevScheduledFire } from './cron-match.js';
import { resolveTimeZone } from '../time/time-zone.js';

describe('matchField', () => {
  test('별표는 항상 매칭', () => {
    expect(matchField('*', 0, 0, 59)).toBe(true);
    expect(matchField('*', 59, 0, 59)).toBe(true);
  });
  test('단일 값', () => {
    expect(matchField('45', 45, 0, 59)).toBe(true);
    expect(matchField('45', 44, 0, 59)).toBe(false);
  });
  test('스텝 */n', () => {
    expect(matchField('*/10', 0, 0, 59)).toBe(true);
    expect(matchField('*/10', 30, 0, 59)).toBe(true);
    expect(matchField('*/10', 35, 0, 59)).toBe(false);
  });
  test('범위 a-b', () => {
    expect(matchField('8-20', 8, 0, 23)).toBe(true);
    expect(matchField('8-20', 20, 0, 23)).toBe(true);
    expect(matchField('8-20', 21, 0, 23)).toBe(false);
    expect(matchField('8-20', 7, 0, 23)).toBe(false);
  });
  test('목록 a,b,c', () => {
    expect(matchField('8,12,15,19', 12, 0, 23)).toBe(true);
    expect(matchField('8,12,15,19', 13, 0, 23)).toBe(false);
  });
});

// ⚠️ 시각 픽스처는 **절대 순간(ISO)** 으로 만들고 판정 시간대를 **명시 주입**한다.
// 종전엔 `new Date(2026, 6, 9, 7, 45)`(로컬 생성자) + 암묵 로컬 판정이라 "개발 머신이
// KST"라는 전제에 얹혀 있었다. 자기일관적이라 통과는 했지만, 시간대를 계약으로
// 승격한 뒤엔 config.timezone 하나만 달라져도 깨진다.
const KST = 'Asia/Seoul';
/** 2026-07-09(목) 07:45 KST = 2026-07-08T22:45Z — 아침 브리핑이 서 있는 그 경계. */
const THU_0745 = new Date('2026-07-08T22:45:00Z');
const THU_0746 = new Date('2026-07-08T22:46:00Z');
const MON_0900 = new Date('2026-07-06T00:00:00Z'); // 2026-07-06(월) 09:00 KST

describe('cronMatches', () => {
  test('45 7 * * * — 07:45 매칭, 07:46 불매칭', () => {
    expect(cronMatches('45 7 * * *', THU_0745, { timeZone: KST })).toBe(true);
    expect(cronMatches('45 7 * * *', THU_0746, { timeZone: KST })).toBe(false);
  });
  test('*/10 매분경계', () => {
    expect(cronMatches('*/10 * * * *', new Date('2026-07-08T21:30:00Z'), { timeZone: KST })).toBe(true);
    expect(cronMatches('*/10 * * * *', new Date('2026-07-08T21:35:00Z'), { timeZone: KST })).toBe(false);
  });
  test('5,35 8-20 * * 1-5 — 평일 장중만', () => {
    expect(cronMatches('5,35 8-20 * * 1-5', new Date('2026-07-08T23:05:00Z'), { timeZone: KST })).toBe(true);  // 목 08:05
    expect(cronMatches('5,35 8-20 * * 1-5', new Date('2026-07-08T23:06:00Z'), { timeZone: KST })).toBe(false);
    expect(cronMatches('5,35 8-20 * * 1-5', new Date('2026-07-10T23:05:00Z'), { timeZone: KST })).toBe(false); // 토 08:05
  });
  test('0 9 * * 1 — 월요일만', () => {
    expect(cronMatches('0 9 * * 1', MON_0900, { timeZone: KST })).toBe(true);
    expect(cronMatches('0 9 * * 1', new Date('2026-07-09T00:00:00Z'), { timeZone: KST })).toBe(false); // 목 09:00
  });
  test('dow 7 = 일요일', () => {
    expect(cronMatches('0 20 * * 7', new Date('2026-07-12T11:00:00Z'), { timeZone: KST })).toBe(true); // 일 20:00
  });

  // ── ★ 회귀 잠금: 시간대 종속 끊기 ──────────────────────────────────
  test('★ 같은 순간이라도 판정 시간대가 다르면 결과가 다르다', () => {
    // 2026-07-08T22:45Z = KST 07:45(7/9) = UTC 22:45(7/8)
    expect(cronMatches('45 7 * * *', THU_0745, { timeZone: KST })).toBe(true);
    expect(cronMatches('45 7 * * *', THU_0745, { timeZone: 'UTC' })).toBe(false);
    expect(cronMatches('45 22 * * *', THU_0745, { timeZone: 'UTC' })).toBe(true);
  });

  test('★ 날짜/요일도 시간대를 따라 움직인다', () => {
    // KST 로는 목요일(7/9), UTC 로는 수요일(7/8).
    expect(cronMatches('45 7 * * 4', THU_0745, { timeZone: KST })).toBe(true);   // 4=목
    expect(cronMatches('45 22 * * 3', THU_0745, { timeZone: 'UTC' })).toBe(true); // 3=수
  });

  // ⚠️ "프로세스 TZ 를 바꿔도 흔들리지 않는다"를 `process.env.TZ` 변이로 검증하지
  // 않는다 — 실측상 되돌릴 수 없어(TZ 설정 후 delete 해도 그대로) 같은 프로세스의
  // 후속 테스트 파일이 전부 오염된다. 실제로 이 테스트의 초안이 catch-up 테스트 4건을
  // 깨뜨렸고 파일 순서를 뒤집으면 통과했다. 독립성은 아래처럼 **두 명시 시간대가
  // 서로 다른 결과를 낸다**로 증명하면 충분하다 — 어느 쪽도 ambient 를 읽지 않는다.
  test('★ 명시 시간대는 서로 독립 — 한쪽 결과가 다른 쪽에 영향받지 않는다', () => {
    const zones = ['Asia/Seoul', 'UTC', 'America/New_York', 'Europe/London'];
    // 순서를 바꿔 두 번 평가해도 각 시간대의 판정은 동일해야 한다(상태 없음).
    const first = zones.map((tz) => cronMatches('45 7 * * *', THU_0745, { timeZone: tz }));
    const second = [...zones].reverse().map((tz) => cronMatches('45 7 * * *', THU_0745, { timeZone: tz }));
    expect(first).toEqual([true, false, false, false]);
    expect(second).toEqual([...first].reverse());
  });
});

describe('prevScheduledFire', () => {
  test('07:45 잡, 08:30 기준 → 오늘 07:45 반환(45분 전)', () => {
    const now = new Date('2026-07-08T23:30:00Z'); // KST 08:30
    const prev = prevScheduledFire('45 7 * * *', now, 6 * 3600_000, { timeZone: KST });
    expect(prev).not.toBeNull();
    // 절대 순간으로 단정 — 로컬 게터로 확인하면 머신 TZ 에 다시 종속된다.
    expect(prev!.toISOString()).toBe('2026-07-08T22:45:00.000Z');
  });
  test('grace 밖이면 null (07:45 잡, 6h grace, 20:00 기준 → 12h15m 전이라 못찾음)', () => {
    const now = new Date('2026-07-09T11:00:00Z'); // KST 20:00
    expect(prevScheduledFire('45 7 * * *', now, 6 * 3600_000, { timeZone: KST })).toBeNull();
  });
  test('현재 분에 매칭하면 그 분 반환(초 절삭)', () => {
    const now = new Date('2026-07-08T22:45:30Z');
    const prev = prevScheduledFire('45 7 * * *', now, 3600_000, { timeZone: KST });
    expect(prev!.toISOString()).toBe('2026-07-08T22:45:00.000Z');
  });
  test('월요일 잡, 목요일 기준 6h grace → null(요일 안맞음)', () => {
    const now = new Date('2026-07-09T00:30:00Z'); // KST 목 09:30
    expect(prevScheduledFire('0 9 * * 1', now, 6 * 3600_000, { timeZone: KST })).toBeNull();
  });
  test('★ 판정 시간대가 다르면 직전 발화 시각도 달라진다', () => {
    const now = new Date('2026-07-08T23:30:00Z'); // KST 08:30(7/9) · UTC 23:30(7/8)
    // grace 24h — 두 후보가 모두 범위 안에 들어오게 해서 "시각 자체가 다르다"를 본다.
    const kst = prevScheduledFire('45 7 * * *', now, 24 * 3600_000, { timeZone: KST });
    const utc = prevScheduledFire('45 7 * * *', now, 24 * 3600_000, { timeZone: 'UTC' });
    expect(kst!.toISOString()).toBe('2026-07-08T22:45:00.000Z'); // KST 07:45 = 45분 전
    expect(utc!.toISOString()).toBe('2026-07-08T07:45:00.000Z'); // UTC 07:45 = 15h45m 전
  });
  test('★ grace 는 판정 시간대에 따라 다른 결과를 낸다 (같은 6h 여도)', () => {
    const now = new Date('2026-07-08T23:30:00Z');
    // KST 07:45 는 45분 전이라 잡히고, UTC 07:45 는 15h45m 전이라 6h grace 밖이다.
    expect(prevScheduledFire('45 7 * * *', now, 6 * 3600_000, { timeZone: KST })).not.toBeNull();
    expect(prevScheduledFire('45 7 * * *', now, 6 * 3600_000, { timeZone: 'UTC' })).toBeNull();
  });

  test('시간대 생략 스캔은 포매터 두 개 이하로 명시 시간대 결과와 같다', () => {
    const now = new Date('2026-07-08T23:30:00Z');
    const timeZone = resolveTimeZone().timeZone;
    const original = Intl.DateTimeFormat;
    let constructions = 0;
    Intl.DateTimeFormat = new Proxy(original, {
      construct(target, args, newTarget) {
        constructions++;
        return Reflect.construct(target, args, newTarget);
      },
    });
    try {
      const implicit = prevScheduledFire('0 3 1 * *', now, 26 * 3600_000);
      const explicit = prevScheduledFire('0 3 1 * *', now, 26 * 3600_000, { timeZone });
      expect(implicit).toEqual(explicit);
      expect(constructions).toBeLessThanOrEqual(2);
    } finally {
      Intl.DateTimeFormat = original;
    }
  });
});
