import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveFreshGrokCredential,
  isGrokSubscriptionExpiring,
  grokSubscriptionExpiryState,
  GROK_EXPIRY_SOON_WINDOW_MS,
  _resetGrokRefreshCooldownForTesting,
} from './credential.js';

/** auth.json 을 «조건을 만들어» 세운다 — 실측한 실제 구조(최상위 키가 issuer::uuid). */
function writeAuth(expiresAt: string): string {
  const home = mkdtempSync(join(tmpdir(), 'grok-cred-'));
  const dir = join(home, '.grok');
  require('node:fs').mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    'https://auth.x.ai::test-uuid': { key: 'eyJ-fake-jwt', expires_at: expiresAt, user_id: 'u1', auth_mode: 'oidc' },
  }));
  return home;
}

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const SOON = new Date(Date.now() + 10_000).toISOString();   // 버퍼(120s) 안 — 만료 임박
const FAR = new Date(Date.now() + 3 * 3_600_000).toISOString();  // 2시간 창 «밖» — 여유

describe('만료 판정 — ⛔ 모르면 「만료」로 단정하지 않는다', () => {
  beforeEach(() => _resetGrokRefreshCooldownForTesting());

  test('여유가 있으면 임박이 아니다', () => {
    expect(isGrokSubscriptionExpiring({ home: writeAuth(FUTURE) })).toBe(false);
  });

  test('버퍼 안이면 임박이다', () => {
    expect(isGrokSubscriptionExpiring({ home: writeAuth(SOON) })).toBe(true);
  });

  test('파일이 없으면 «임박 아님» — 없는 것을 「죽었다」로 읽지 않는다', () => {
    expect(isGrokSubscriptionExpiring({ home: mkdtempSync(join(tmpdir(), 'grok-none-')) })).toBe(false);
  });

  test('expires_at 이 못 읽는 값이면 임박으로 «단정하지 않는다»', () => {
    expect(isGrokSubscriptionExpiring({ home: writeAuth('not-a-date') })).toBe(false);
  });
});

// ⭐ 자기 리뷰의 「약한 고리 ⓓ」를 검증하다 «실질 버그»를 찾아 고친 자리 — 반증으로 못 박는다.
describe('만료 판정이 «어느 항목»을 보나 — key 없는 항목에 속으면 안 된다', () => {
  beforeEach(() => _resetGrokRefreshCooldownForTesting());

  test('key 없는 항목이 «더 늦은» 만료를 가져도 «실제 쓸 토큰»의 만료로 판정한다', () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-mixed-'));
    const dir = join(home, '.grok');
    require('node:fs').mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({
      // ⛔ key 가 «없다» — 자격으로 못 쓰는데 만료만 «아주 멀다»
      'https://auth.x.ai::stale-no-key': { expires_at: new Date(Date.now() + 86_400_000).toISOString() },
      // ✅ 실제로 쓰이는 항목 — 만료 «임박»
      'https://auth.x.ai::real': { key: 'eyJ-real', expires_at: new Date(Date.now() + 10_000).toISOString(), user_id: 'u1' },
    }));
    // 예전 판(readExpiresAt)은 +24h 를 보고 false 를 냈다 — 그러면 죽은 토큰으로 요청이 나간다.
    expect(isGrokSubscriptionExpiring({ home })).toBe(true);
  });
});

describe('접힌 해석 — 호출자가 «기억할 것»이 없다', () => {
  beforeEach(() => _resetGrokRefreshCooldownForTesting());

  test('여유가 있으면 갱신을 «유도하지 않는다»', () => {
    let called = 0;
    const cred = resolveFreshGrokCredential({
      home: writeAuth(FUTURE), env: {}, execImpl: () => { called += 1; },
    });
    expect(cred?.kind).toBe('subscription');
    expect(called).toBe(0);
  });

  test('만료 임박이면 갱신을 «유도한다» — 그리고 정확히 1회', () => {
    let called = 0;
    resolveFreshGrokCredential({ home: writeAuth(SOON), env: {}, execImpl: () => { called += 1; } });
    expect(called).toBe(1);
  });

  // ⭐ 원 구조가 「루프 가드는 호출자 몫」이라 적었던 것을 «이 층이» 접는다.
  test('쿨다운 — 연달아 불러도 갱신 유도는 «한 번»뿐', () => {
    let called = 0;
    const home = writeAuth(SOON);
    const exec = () => { called += 1; };
    resolveFreshGrokCredential({ home, env: {}, execImpl: exec });
    resolveFreshGrokCredential({ home, env: {}, execImpl: exec });
    resolveFreshGrokCredential({ home, env: {}, execImpl: exec });
    expect(called).toBe(1);
  });

  // ⭐ 무인 리뷰 must-fix [3] — 401 안전망이 «없는» 호출 지점에서 만료 구독을 그대로 주면 죽는다.
  // ⭐ 무인 리뷰 must-fix [1] — 모듈 전역 쿨다운이면 «다른 자격 파일»의 갱신까지 막힌다.
  test('쿨다운은 «자격 파일 경로별»이다 — 다른 home 은 서로 안 막는다', () => {
    let a = 0; let b = 0;
    const homeA = writeAuth(SOON);
    const homeB = writeAuth(SOON);
    resolveFreshGrokCredential({ home: homeA, env: {}, execImpl: () => { a += 1; } });
    resolveFreshGrokCredential({ home: homeA, env: {}, execImpl: () => { a += 1; } });  // 쿨다운
    resolveFreshGrokCredential({ home: homeB, env: {}, execImpl: () => { b += 1; } });  // ⛔ 막히면 안 된다
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  // ⛔⭐⭐ 대표 지시 계약 — "구독이 있는 경우 api key 는 «항상» 2순위".
  //   🪞 1라운드에 나는 「갱신 실패 → API 키 강등」을 넣었고 2라운드 리뷰가 «계약 위반»으로 잡았다.
  //   ⇒ 이 테스트는 그 되돌림을 못 박는다 — 자동 강등은 «사용자 동의 없이 지갑을 여는» 일이다.
  //   ✅ 실제로 죽었는지는 401 이 말해 주고, 강등은 그 신호를 본 호출자(llm.ts:3092~)의 몫이다.
  test('갱신 실패 ⊕ API 키가 «있어도» 구독을 유지한다 — 자동 강등 금지', () => {
    const cred = resolveFreshGrokCredential({
      home: writeAuth(SOON), env: { XAI_API_KEY: 'xai-fallback' },
      execImpl: () => { throw new Error('grok 없음'); },
    });
    expect(cred?.kind).toBe('subscription');   // ⛔ api_key 로 «안» 떨어진다
    expect(cred?.source).toBe('auth.json');
  });

  test('갱신 실패 ⊕ API 키 «없음» → 있는 자격을 준다 — 요청이 안 나가는 것이 더 나쁘다', () => {
    const cred = resolveFreshGrokCredential({
      home: writeAuth(SOON), env: {}, execImpl: () => { throw new Error('grok 없음'); },
    });
    expect(cred?.kind).toBe('subscription');   // ⛔ null 이 아니다
  });

  test('API 키 자격은 갱신을 «안» 탄다 — 만료 개념이 없다', () => {
    let called = 0;
    const cred = resolveFreshGrokCredential({
      home: mkdtempSync(join(tmpdir(), 'grok-key-')),
      env: { XAI_API_KEY: 'xai-test' },
      execImpl: () => { called += 1; },
    });
    expect(cred?.kind).toBe('api_key');
    expect(called).toBe(0);
  });

  test('자격이 아예 없으면 null 이고 갱신도 «안» 탄다', () => {
    let called = 0;
    const cred = resolveFreshGrokCredential({
      home: mkdtempSync(join(tmpdir(), 'grok-empty-')), env: {}, execImpl: () => { called += 1; },
    });
    expect(cred).toBeNull();
    expect(called).toBe(0);
  });
});

// ⭐ 칸 CRED-EXPIRY-REFRESH 첫 조각 — 실제 선택된 구독의 expires_at 을 «토큰 없이» 읽어
//   healthy·expiring(2시간 이내)·unknown 셋을 가리는 순수 판정.
//   ⛔ 기존 boolean(isGrokSubscriptionExpiring)은 모름을 false 로 접는다 — 여기서 그 둘을 가른다.
describe('만료 상태 판정 grokSubscriptionExpiryState — 셋 값이 «모름»을 «여유»와 가른다', () => {
  test('2시간 창 밖이면 healthy', () => {
    expect(grokSubscriptionExpiryState({ home: writeAuth(FAR) })).toBe('healthy');
  });

  test('2시간 이내면 expiring', () => {
    expect(grokSubscriptionExpiryState({ home: writeAuth(SOON) })).toBe('expiring');
  });

  test('경계 — 정확히 2시간이면 expiring(«이내»는 닫힌 구간)', () => {
    const fixed = Date.now();
    const atEdge = new Date(fixed + GROK_EXPIRY_SOON_WINDOW_MS).toISOString();
    expect(grokSubscriptionExpiryState({ home: writeAuth(atEdge), now: () => fixed })).toBe('expiring');
  });

  test('경계 — 2시간 + 1초 밖이면 healthy', () => {
    const fixed = Date.now();
    const pastEdge = new Date(fixed + GROK_EXPIRY_SOON_WINDOW_MS + 1_000).toISOString();
    expect(grokSubscriptionExpiryState({ home: writeAuth(pastEdge), now: () => fixed })).toBe('healthy');
  });

  test('파일이 없으면 unknown — 같은 조건에서 기존 boolean 은 false 다', () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-none-'));
    expect(grokSubscriptionExpiryState({ home })).toBe('unknown');
    expect(isGrokSubscriptionExpiring({ home })).toBe(false);
  });

  test('expires_at 이 못 읽는 값이면 unknown — 기존 boolean 의 false 와 «구별»된다', () => {
    const home = writeAuth('not-a-date');
    expect(grokSubscriptionExpiryState({ home })).toBe('unknown');
    expect(isGrokSubscriptionExpiring({ home })).toBe(false);
  });

  test('쓸 수 있는 scope 의 expires_at 이 없으면 unknown — 만료를 지어내지 않는다', () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-noexp-'));
    const dir = join(home, '.grok');
    require('node:fs').mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({
      'https://auth.x.ai::no-exp': { key: 'eyJ-no-expiry', user_id: 'u1' },
    }));
    expect(grokSubscriptionExpiryState({ home })).toBe('unknown');
  });

  // ⭐ boolean 판의 취약점(key 없는 항목에 속음)을 «같은 규칙»으로 예방 — 선택은 readSubscriptionToken.
  test('key 없는 항목의 «먼» 만료에 속하지 않는다 — 실제 항목 임박이면 expiring', () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-mixed-state-'));
    const dir = join(home, '.grok');
    require('node:fs').mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({
      'https://auth.x.ai::stale-no-key': { expires_at: new Date(Date.now() + 86_400_000).toISOString() },
      'https://auth.x.ai::real': { key: 'eyJ-real', expires_at: new Date(Date.now() + 10_000).toISOString(), user_id: 'u1' },
    }));
    expect(grokSubscriptionExpiryState({ home })).toBe('expiring');
  });

  test('토큰 없이 — 결과값에 자격 토큰이 «실리지 않는다»', () => {
    const state = grokSubscriptionExpiryState({ home: writeAuth(FAR) });
    expect(JSON.stringify(state)).not.toContain('eyJ-fake-jwt');
  });
});
