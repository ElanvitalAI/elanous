import { describe, expect, test } from 'bun:test';
import { matchBotIntent, matchBotsIntent, matchRoutinesIntent, matchScreenIntent, saysPhoto } from './command-surface.js';

const resolveBot = (word: string): string | null =>
  ({ newsbot: 'newsbot', investor: 'investor', shotbot: 'shotbot', screenbot: 'screenbot' } as Record<string, string>)[word.toLowerCase()] ?? null;

describe('read-only bot command intents', () => {
  test('translates a bot-list request', () => {
    expect(matchBotsIntent('봇 목록 보여줘')).toBe('/bots');
  });

  test('translates a routines request', () => {
    expect(matchRoutinesIntent('루틴 뭐 있어')).toBe('/routines');
  });

  test('appointment app work and routine edits stay in the conversation', () => {
    expect(matchRoutinesIntent('동네 가게 예약 앱을 만들어줘')).toBeNull();
    expect(matchRoutinesIntent('예약 취소와 빈 시간 표시를 추가해줘')).toBeNull();
    expect(matchRoutinesIntent('예약 목록 보여줘')).toBeNull();
    expect(matchRoutinesIntent('루틴 목록에 새 항목 추가해줘')).toBeNull();
    expect(matchRoutinesIntent('루틴 목록 보여주는 앱 개발해줘')).toBeNull();
    expect(matchRoutinesIntent('루틴 목록 보여줘')).toBe('/routines');
  });

  test('translates one named bot status request', () => {
    expect(matchBotIntent('newsbot 상태', resolveBot)).toBe('/bot newsbot');
  });

  test('does not let a bot name trigger the bot-list matcher', () => {
    const resolveBotsbot = (word: string): string | null => word.toLowerCase() === 'botsbot' ? 'botsbot' : null;
    expect(matchBotsIntent('botsbot 화면 보여줘')).toBeNull();
    expect(matchBotIntent('botsbot 화면 보여줘', resolveBotsbot)).toBeNull();
  });

  test('rejects multiple bot candidates, including aliases for one bot', () => {
    const resolveAliasedBot = (word: string): string | null =>
      ({ newsbot: 'newsbot', status: 'newsbot' } as Record<string, string>)[word.toLowerCase()] ?? null;
    expect(matchBotIntent('newsbot status 상태', resolveAliasedBot)).toBeNull();
  });

  test('leaves explicit slash input for the existing slash parser', () => {
    expect(matchBotsIntent('/bots')).toBeNull();
    expect(matchRoutinesIntent('/routines')).toBeNull();
    expect(matchBotIntent('/bot newsbot 상태', resolveBot)).toBeNull();
  });
});

describe('matchScreenIntent', () => {
  test('translates a screen request with a resolvable bot', () => {
    expect(matchScreenIntent('newsbot 화면 보여줘', resolveBot)).toBe('/screen newsbot');
  });

  test('adds --shot only when the person explicitly asks for a photo', () => {
    expect(matchScreenIntent('investor 화면 사진 찍어줘', resolveBot)).toBe('/screen investor --shot');
  });

  test('does not translate a screen-pattern sentence without a bot', () => {
    expect(matchScreenIntent('화면 공유 어떻게 해?', resolveBot)).toBeNull();
  });

  test('does not translate a bot mention without a screen-pattern word', () => {
    expect(matchScreenIntent('newsbot 잘 도나?', resolveBot)).toBeNull();
  });

  test('leaves explicit slash input for the existing slash parser', () => {
    expect(matchScreenIntent('/screen newsbot --shot', resolveBot)).toBeNull();
  });
});

/**
 * 🩸⛔⭐⭐ **「요청 없이 사진을 보내지 않는다」를 «반증»으로 문다** (2026-09-02 · 자기 리뷰 must-fix)
 *
 * 🚨 첫 판은 사진 낱말을 `said` «전체»에서 부분 문자열로 찾았다 — 그런데 ***봇 이름이 그 안에 있다***.
 *    ⇒ 봇 이름이 `shotbot` 이면 「shotbot 화면 보여줘」가 「--shot」 이 됐다.
 *    ⛔ 사람이 사진을 «말하지 않았는데» 폰으로 사진이 간다 — 이 판의 수용 기준을 정면으로 어긴다.
 * 🔑 이 축은 ***되돌릴 수 없다***(보낸 메시지). 그래서 반례를 «시험으로» 걸어 둔다.
 */
describe('⛔ 사진은 «요청이 있을 때만» — 봇 이름이 그 낱말을 품어도 안 붙인다', () => {
  test('🚨 봇 이름이 `shotbot` 이어도 사진을 «안» 보낸다', () => {
    expect(matchScreenIntent('shotbot 화면 보여줘', resolveBot)).toBe('/screen shotbot');
  });

  test('그 봇에게 «사진을 말하면» 붙는다 — 잃은 것이 없다', () => {
    expect(matchScreenIntent('shotbot 화면 사진', resolveBot)).toBe('/screen shotbot --shot');
  });

  test('영문 `shot` 은 «낱말»일 때만 — `screenshot` 은 따로 센다', () => {
    expect(saysPhoto('give me a shot', '')).toBe(true);
    expect(saysPhoto('screenshot please', '')).toBe(true);
    expect(saysPhoto('hotshot bot', '')).toBe(false);   // ⛔ 낱말이 아니다
  });
});

/**
 * 🩸⛔⭐⭐ **자기 «이름»이 트리거가 되면 안 된다 — 두 낱말 축 «둘 다»** (자기 리뷰 2차 must-fix)
 * 그리고 ⛔ ***모호하면 안 잡는다*** — 사진이 «틀린 봇»에게 가는 것을 막는다.
 */
describe('⛔ 이름이 트리거가 되지 않는다 ⊕ 모호하면 «안 잡는다»', () => {
  test('🚨 `screenbot 사진 보내` — 화면 요청이 «없다» ⇒ null', () => {
    expect(matchScreenIntent('screenbot 사진 보내', resolveBot)).toBeNull();
  });

  test('그 봇에게 «화면»을 말하면 잡힌다 — 잃은 것이 없다', () => {
    expect(matchScreenIntent('screenbot 화면 보여줘', resolveBot)).toBe('/screen screenbot');
  });

  test('🚨 봇 이름이 «둘» 나오면 — ⛔ 틀린 봇에게 사진을 보내느니 «안 잡는다»', () => {
    expect(matchScreenIntent('newsbot 말고 investor 화면 사진', resolveBot)).toBeNull();
  });

  test('같은 봇을 «두 번» 말한 것은 모호하지 «않다»', () => {
    expect(matchScreenIntent('newsbot 화면, newsbot 지금', resolveBot)).toBe('/screen newsbot');
  });

  test('영문 사진 낱말은 «식별자 안»에서 안 잡힌다 — 숫자·밑줄도 경계가 아니다', () => {
    expect(saysPhoto('shot_bot 화면', '')).toBe(false);
    expect(saysPhoto('shot2 화면', '')).toBe(false);
    expect(saysPhoto('take a shot now', '')).toBe(true);
  });
});
