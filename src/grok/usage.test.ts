// grok/usage.ts — 파싱·병합·문면. ⛔ 네트워크를 «타지 않는다»(fetch 를 주입).
//
// 실측 응답 형태(2026-08-13)를 픽스처로 굳혔다:
//   credits 뷰 → config 중첩 · currentPeriod · isUnifiedBillingUser
//   default 뷰 → monthlyLimit · used · billingPeriod*

import { describe, expect, it } from 'bun:test';
import type { GrokCredential } from './credential.js';
import { describeGrokUsage, mergeGrokUsage, parseGrokBilling, parseMoney, fetchGrokUsage, grokUsageToSubscriptionAxis, grokUsageToCreditAxis } from './usage.js';

// ── 실측 픽스처 ──────────────────────────────────────────────────────────────
const CREDITS_VIEW = {
  config: {
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-08-07T13:07:00Z', end: '2026-08-14T13:07:00Z' },
    onDemandCap: 0, onDemandUsed: 0, prepaidBalance: 0, isUnifiedBillingUser: true,
    billingPeriodStart: '2026-08-07T13:07:00Z', billingPeriodEnd: '2026-08-14T13:07:00Z',
  },
};
const DEFAULT_VIEW = {
  config: { monthlyLimit: 0, used: 0, onDemandCap: 0, billingPeriodStart: '2026-08-01T00:00:00Z', billingPeriodEnd: '2026-09-01T00:00:00Z' },
};

describe('parseMoney — xAI 는 «수»로도 `{val}` 로도 준다', () => {
  it('수·문자열·{val} 셋 다 받는다', () => {
    expect(parseMoney(12.5)).toBe(12.5);
    expect(parseMoney('12.5')).toBe(12.5);
    expect(parseMoney({ val: '3' })).toBe(3);
    expect(parseMoney({ val: 4 })).toBe(4);
  });

  it('⛔ 「모른다」는 null — 0 이 아니다', () => {
    for (const bad of [undefined, null, 'abc', {}, { val: 'x' }, NaN, Infinity]) {
      expect(parseMoney(bad)).toBeNull();
    }
  });
});

describe('parseGrokBilling — 형태가 «둘»이다 (최상위 / config 중첩)', () => {
  it('credits 뷰(중첩)에서 창·등급·unified 를 뽑는다', () => {
    const u = parseGrokBilling(CREDITS_VIEW)!;
    expect(u.periodType).toBe('USAGE_PERIOD_TYPE_WEEKLY');
    expect(u.periodStart).toBe('2026-08-07T13:07:00Z');
    expect(u.unifiedBilling).toBe(true);
    expect(u.monthlyLimit).toBeNull();     // 이 뷰엔 없다
  });

  it('최상위 평면 형태도 받는다', () => {
    const u = parseGrokBilling({ creditUsagePercent: 42, subscriptionTier: 'pro' })!;
    expect(u.usedPercent).toBe(42);
    expect(u.tier).toBe('pro');
  });

  it('period 가 없으면 billingPeriod* 로 떨어진다', () => {
    const u = parseGrokBilling(DEFAULT_VIEW)!;
    expect(u.periodStart).toBe('2026-08-01T00:00:00Z');
    expect(u.monthlyLimit).toBe(0);
  });

  it('⛔ 「사용률 모름」과 「0%」를 다른 값으로', () => {
    expect(parseGrokBilling({ config: {} })!.usedPercent).toBeNull();
    expect(parseGrokBilling({ creditUsagePercent: 0 })!.usedPercent).toBe(0);
  });

  it('비-객체는 null', () => {
    for (const bad of [null, undefined, 'x', 3, []]) {
      const r = parseGrokBilling(bad);
      if (Array.isArray(bad)) expect(r).not.toBeNull();   // 배열도 object — 필드가 없어 전부 null 이 된다
      else expect(r).toBeNull();
    }
  });
});

describe('mergeGrokUsage — 두 뷰가 서로를 «메운다»', () => {
  it('credits 의 창 + default 의 월한도가 합쳐진다', () => {
    const m = mergeGrokUsage(parseGrokBilling(CREDITS_VIEW), parseGrokBilling(DEFAULT_VIEW))!;
    expect(m.periodType).toBe('USAGE_PERIOD_TYPE_WEEKLY');   // credits 쪽
    expect(m.monthlyLimit).toBe(0);                           // default 쪽
    expect(m.unifiedBilling).toBe(true);
  });

  it('한쪽이 null 이면 다른 쪽을 그대로', () => {
    const a = parseGrokBilling(CREDITS_VIEW);
    expect(mergeGrokUsage(a, null)).toBe(a);
    expect(mergeGrokUsage(null, a)).toBe(a);
    expect(mergeGrokUsage(null, null)).toBeNull();
  });

  it('primary 값이 있으면 primary 가 이긴다', () => {
    const p = parseGrokBilling({ creditUsagePercent: 10 });
    const s = parseGrokBilling({ creditUsagePercent: 90 });
    expect(mergeGrokUsage(p, s)!.usedPercent).toBe(10);
  });
});

describe('fetchGrokUsage — ⛔ 던지지 않는다 · 실패는 «값»으로', () => {
  const subscription = (token: string): GrokCredential => ({
    kind: 'subscription', baseUrl: 'https://grok.test/v1', token, headers: {}, source: 'auth.json',
  });
  const apiKey = (): GrokCredential => ({
    kind: 'api_key', baseUrl: 'https://api.x.ai/v1', token: 'api-key', headers: {}, source: 'XAI_API_KEY',
  });

  it.each([401, 403])('구독 %i 뒤 갱신된 토큰으로 한 번 재조회해 사용량을 반환한다', async (status) => {
    let resolves = 0;
    let refreshes = 0;
    const tokens: string[] = [];
    const r = await fetchGrokUsage({
      resolveCredential: () => (++resolves === 1 ? subscription('expired-token') : subscription('renewed-token')),
      refreshSubscriptionToken: () => { refreshes++; return 'refreshed'; },
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        tokens.push((init?.headers as Record<string, string>).Authorization);
        return tokens.length === 1
          ? new Response('nope', { status })
          : new Response(JSON.stringify({ creditUsagePercent: 42, monthlyLimit: 100 }));
      }) as unknown as typeof fetch,
    });

    expect(r).toMatchObject({ status: 'ok', usage: { usedPercent: 42, monthlyLimit: 100 } });
    expect(refreshes).toBe(1);
    expect(resolves).toBe(2);
    expect(tokens).toEqual(['Bearer expired-token', 'Bearer renewed-token']);
  });

  it('갱신 실패면 재조회 없이 unauthorized 를 반환한다', async () => {
    let refreshes = 0;
    let fetches = 0;
    const r = await fetchGrokUsage({
      resolveCredential: () => subscription('expired-token'),
      refreshSubscriptionToken: () => { refreshes++; return 'failed'; },
      fetchImpl: (async () => { fetches++; return new Response('nope', { status: 401 }); }) as unknown as typeof fetch,
    });

    expect(r).toEqual({ status: 'unauthorized' });
    expect(refreshes).toBe(1);
    expect(fetches).toBe(1);
  });

  it.each([401, 403])('재조회도 %i 이면 추가 갱신·재시도 없이 unauthorized 를 반환한다', async (status) => {
    let resolves = 0;
    let refreshes = 0;
    let fetches = 0;
    const r = await fetchGrokUsage({
      resolveCredential: () => (++resolves === 1 ? subscription('expired-token') : subscription('renewed-token')),
      refreshSubscriptionToken: () => { refreshes++; return 'refreshed'; },
      fetchImpl: (async () => { fetches++; return new Response('nope', { status }); }) as unknown as typeof fetch,
    });

    expect(r).toEqual({ status: 'unauthorized' });
    expect(refreshes).toBe(1);
    expect(fetches).toBe(2);
    expect(resolves).toBe(2);
  });

  it.each([401, 403])('API 키 %i 는 갱신·재시도 없이 no-subscription 을 반환한다', async (status) => {
    let refreshes = 0;
    let fetches = 0;
    const r = await fetchGrokUsage({
      resolveCredential: apiKey,
      refreshSubscriptionToken: () => { refreshes++; return 'refreshed'; },
      fetchImpl: (async () => { fetches++; return new Response('nope', { status }); }) as unknown as typeof fetch,
    });

    expect(r).toEqual({ status: 'no-subscription' });
    expect(refreshes).toBe(0);
    expect(fetches).toBe(0);
  });

  it('네트워크가 던져도 error 로 접는다', async () => {
    const r = await fetchGrokUsage({
      resolveCredential: () => subscription('token'),
      fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ status: 'error', detail: 'ECONNREFUSED' });
  });
});

describe('describeGrokUsage — ⛔ 「모른다」를 0 으로 찍지 않는다', () => {
  it('사용률이 없으면 «미상» 이라고 말한다', () => {
    const line = describeGrokUsage({
      status: 'ok',
      usage: { ...parseGrokBilling(CREDITS_VIEW)! },
    });
    expect(line).toContain('사용률 미상');
    expect(line).not.toContain('사용률 0%');
    expect(line).not.toContain('월한도');
    expect(line).not.toContain('사용 0');
    expect(line).toContain('표시 수치는 종량(on-demand)·선불 축');
    expect(line).toContain('SuperGrok Heavy 주간 구독 풀 잔량·리셋은 이 응답에 없음');
    expect(line).toContain('grok.com → Settings → Usage에서 확인');
  });

  it('unified-billing 전부 0·사용률 미상은 구독 소비 부재로 특별히 경고한다', () => {
    const line = describeGrokUsage({
      status: 'ok',
      usage: mergeGrokUsage(parseGrokBilling(CREDITS_VIEW), parseGrokBilling(DEFAULT_VIEW))!,
    });
    expect(line).toContain('사용률 미상');
    expect(line).toContain('창 USAGE_PERIOD_TYPE_WEEKLY');
    expect(line).toContain('2026-08-07~2026-08-14');
    expect(line).toContain('월한도 0');
    expect(line).toContain('사용 0');
    expect(line).toContain('unified-billing');
    expect(line).toContain('표시 수치는 종량(on-demand)·선불 축');
    expect(line).toContain('SuperGrok Heavy 주간 구독 풀 잔량·리셋은 이 응답에 없음');
    expect(line).toContain('grok.com → Settings → Usage에서 확인');
    expect(line).toContain('이 응답이 구독 소비를 담지 않는 경우에 가깝다');
  });

  it('축 안내는 사람용이며 JSON 결과 객체에는 추가하지 않는다', () => {
    const result = {
      status: 'ok' as const,
      usage: mergeGrokUsage(parseGrokBilling(CREDITS_VIEW), parseGrokBilling(DEFAULT_VIEW))!,
    };
    const json = JSON.stringify(result);
    expect(JSON.parse(json)).toEqual(result);
    expect(json).not.toContain('종량(on-demand)·선불 축');
    expect(json).not.toContain('SuperGrok Heavy 주간 구독 풀');
  });

  it('0이 아닌 종량 사용 수치를 그대로 보여 준다', () => {
    const line = describeGrokUsage({
      status: 'ok',
      usage: {
        ...parseGrokBilling({ monthlyLimit: 25, used: 7.5, onDemandCap: 25, onDemandUsed: 7.5, prepaidBalance: 3 })!,
      },
    });
    expect(line).toContain('월한도 25');
    expect(line).toContain('사용 7.5');
    expect(line).toContain('표시 수치는 종량(on-demand)·선불 축');
  });

  it('0% 는 0% 라고 말한다', () => {
    expect(describeGrokUsage({ status: 'ok', usage: parseGrokBilling({ creditUsagePercent: 0 })! }))
      .toContain('사용률 0%');
  });

  it('실패 셋은 «실행 가능한» 문면을 낸다', () => {
    expect(describeGrokUsage({ status: 'no-subscription' })).toContain('grok login');
    expect(describeGrokUsage({ status: 'unauthorized' })).toContain('grok login');
    expect(describeGrokUsage({ status: 'error', detail: 'boom' })).toContain('boom');
  });
});

describe('Grok billing usage axes — weekly quota and credits remain separate', () => {
  it('usedPercent 를 크레딧 축에 그대로 두고 크레딧 객체에는 구독 필드를 넣지 않는다', () => {
    const usage = parseGrokBilling({
      creditUsagePercent: 42,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-08-07T13:07:00Z', end: '2026-08-14T13:07:00Z' },
      prepaidBalance: 3,
    })!;
    const credits = grokUsageToCreditAxis(usage);
    expect(credits.status).toBe('ok');
    expect(credits.usedPercent).toBe(42);
    expect(credits.periodType).toBe('USAGE_PERIOD_TYPE_WEEKLY');
    expect(credits.prepaidBalance).toBe(3);
    expect(JSON.stringify(credits)).not.toContain('remainingPercent');
  });

  it('weekly provider quota is read from the billing query and kept distinct from credits', () => {
    const usage = parseGrokBilling({
      creditUsagePercent: 42,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-08-07T13:07:00Z', end: '2026-08-14T13:07:00Z' },
      prepaidBalance: 3,
    })!;
    expect(grokUsageToSubscriptionAxis(usage)).toEqual({
      status: 'available', remainingPercent: 58,
      resetsAt: Date.parse('2026-08-14T13:07:00Z'), windowKind: 'weekly',
    });
    expect(grokUsageToSubscriptionAxis(parseGrokBilling({ prepaidBalance: 3 })!)).toEqual({
      status: 'unavailable', reason: 'query-does-not-supply',
    });
  });
});
