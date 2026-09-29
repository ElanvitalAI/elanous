import { describe, expect, test } from 'bun:test';
import { makePodAccountBroker, planPodAccounts, planPodProvider } from './pod-account-broker.js';

const c = (name: string, usedPercent?: number, reached?: boolean) => ({ name, storeKey: `openai-codex:${name}`, home: `/h/${name}`, reached, ...(usedPercent !== undefined ? { usedPercent } : {}) });

describe('pod account broker — 병렬 Pod 가 한 계정에 몰리지 않게', () => {
  test('📏 09-26 실제 잔량(default 100% · team 74% · third 47%) → third · team 순, default 는 뺀다', () => {
    const plan = planPodAccounts([c('default', 100, true), c('team', 74), c('third', 47)]);
    expect(plan.usable).toEqual(['third', 'team']);
    expect(plan.excluded.map((e) => e.name)).toEqual(['default']);
  });
  test('Job 마다 돌려 준다 — 넷이면 third · team · third · team', () => {
    const next = makePodAccountBroker(planPodAccounts([c('team', 74), c('third', 47)]));
    expect([next(), next(), next(), next()]).toEqual(['third', 'team', 'third', 'team']);
  });
  test('문턱(95%) 이상은 빼고, 신호 없는 계정은 뒤로(빼지 않음)', () => {
    expect(planPodAccounts([c('a', 96), c('b'), c('c', 10)]).usable).toEqual(['c', 'b']);
  });
  test('계정별 기본·명시 임계와 유효하지 않은 override fallback 을 eligibility 및 사유에 같이 적용한다', () => {
    const plan = planPodAccounts([
      c('default', 60), c('team', 74), c('third', 95), c('unknown'), c('reached', 5, true),
    ], {
      excludeAt: 90,
      thresholdPercentByAccount: { default: 80, team: 70, third: 101 },
    });
    expect(plan.usable).toEqual(['default', 'unknown']);
    expect(plan.excluded).toEqual([
      { name: 'team', why: 'used 74% ≥ 70%' },
      { name: 'third', why: 'used 95% ≥ 90%' },
      { name: 'reached', why: 'quota reached' },
    ]);
    expect(planPodAccounts([c('default', 60), c('team', 74)], { excludeAt: 90 }).excluded).toEqual([
      { name: 'default', why: 'used 60% ≥ 60%' },
    ]);
  });
  test('숫자 excludeAt 인자를 받는 기존 호출의 임계와 제외 사유를 유지한다', () => {
    const plan = planPodAccounts([c('default', 70), c('team', 90), c('third', 89), c('unknown'), c('full', 1, true)], 90);
    expect(plan).toEqual({
      usable: ['default', 'third', 'unknown'],
      excluded: [
        { name: 'team', why: 'used 90% ≥ 90%' },
        { name: 'full', why: 'quota reached' },
      ],
    });
    expect(planPodAccounts([c('default', 90)], 90).excluded).toEqual([
      { name: 'default', why: 'used 90% ≥ 90%' },
    ]);
  });
  test('쓸 계정이 없으면 이유와 명시 방법을 대고 던진다', () => {
    expect(() => makePodAccountBroker(planPodAccounts([c('default', 100, true)]))).toThrow('--pod-account');
  });
});

describe('💳 크레딧 허가(09-28 · 9·10월 출시 특별 기간)', () => {
  test('구독 잔량 계정이 하나도 없으면 찬 계정을 사용률 낮은 순으로 크레딧으로 쓴다', () => {
    const plan = planPodAccounts([c('default', 98), c('team', 100, true), c('third', 100)], { thresholdPercentByAccount: { default: 97 }, creditsAllowed: true });
    expect(plan.usable).toEqual(['default', 'team', 'third']);
    expect(plan.creditAccounts).toEqual(['default', 'team', 'third']);
    expect(plan.excluded).toEqual([]);
  });

  test('잔량 계정이 있으면 크레딧 계정은 쓰지 않는다 · 허가가 꺼지면 종전대로 제외', () => {
    const some = planPodAccounts([c('default', 40), c('team', 100, true)], { creditsAllowed: true });
    expect(some.usable).toEqual(['default']);
    expect(some.creditAccounts).toBeUndefined();
    const off = planPodAccounts([c('default', 98), c('team', 100, true)], { thresholdPercentByAccount: { default: 97 } });
    expect(off.usable).toEqual([]);
  });

  test('planPodProvider 는 크레딧 허가면 grok 으로 가지 않고 codex 에 머문다', () => {
    const plan = planPodProvider({ codexCandidates: [c('default', 99), c('third', 100, true)], thresholdPercentByAccount: { default: 97 }, creditsAllowed: true, grokSubscription: true, grokApiKey: false, grokApiKeyOptIn: false });
    expect(plan.provider).toBe('openai-codex');
  });
});

describe('pod provider selection', () => {
  const candidates = (third: number) => [c('default', 100), c('team', 95), c('third', third)];
  const available = { grokSubscription: true, grokApiKey: false, grokApiKeyOptIn: false };
  test('every usable codex account is exposed in remaining-usage order, including unknown usage last', () => {
    const plan = planPodProvider({ codexCandidates: [c('unknown'), c('team', 74), c('default', 100, true), c('third', 47)], ...available });
    expect(plan).toEqual({ provider: 'openai-codex', accounts: ['third', 'team', 'unknown'], excluded: [{ name: 'default', why: 'quota reached' }], grokSubscriptionEligible: true });
    if (plan.provider !== 'openai-codex') throw new Error('expected codex provider');
    const next = makePodAccountBroker({ usable: plan.accounts, excluded: plan.excluded });
    const allocated = next();
    expect([allocated, ...plan.accounts.filter((name) => name !== allocated)]).toEqual(['third', 'team', 'unknown']);
    const secondAllocated = next();
    expect([secondAllocated, ...plan.accounts.filter((name) => name !== secondAllocated)]).toEqual(['team', 'third', 'unknown']);
  });
  test('100 · 95 · 85 → codex third, original account order', () => {
    expect(planPodProvider({ codexCandidates: candidates(85), ...available })).toMatchObject({ provider: 'openai-codex', accounts: ['third'], grokSubscriptionEligible: true });
  });
  test('provider selection forwards account overrides and reports each effective exclusion threshold', () => {
    const plan = planPodProvider({
      codexCandidates: [c('default', 70), c('team', 75), c('third', 85)],
      grokSubscription: false, grokApiKey: false, grokApiKeyOptIn: false,
      excludeAt: 90, thresholdPercentByAccount: { team: 70, third: 80 },
    });
    expect(plan).toEqual({
      provider: null,
      grokSubscriptionEligible: false,
      reasons: [
        'codex: default(used 70% ≥ 60%) · team(used 75% ≥ 70%) · third(used 85% ≥ 80%)',
        'grok: 구독 자격 없음 · API 키 없음',
      ],
    });
    expect(planPodProvider({
      codexCandidates: [c('default', 70), c('team', 75)], ...available,
      excludeAt: 90, thresholdPercentByAccount: { default: 80 },
    })).toEqual({ provider: 'openai-codex', accounts: ['default', 'team'], excluded: [], grokSubscriptionEligible: true });
    expect(planPodProvider({
      codexCandidates: [c('default', 70)], ...available, excludeAt: 90,
    })).toEqual({ provider: 'grok', excluded: [{ name: 'default', why: 'used 70% ≥ 60%' }], grokSubscriptionEligible: true });
  });
  test('100 · 95 · 96 → grok subscription', () => {
    expect(planPodProvider({ codexCandidates: candidates(96), ...available }).provider).toBe('grok');
  });
  test('all codex excluded, API key without opt-in → full-chain reasons', () => {
    const plan = planPodProvider({ codexCandidates: candidates(96), grokSubscription: false, grokApiKey: true, grokApiKeyOptIn: false });
    expect(plan.provider).toBeNull();
    if (plan.provider !== null) throw new Error('expected no provider');
    expect(plan.reasons.join(' · ')).toMatch(/default.*100%.*team.*95%.*third.*96%.*grok.*opt-in 꺼짐/);
  });
  test('all codex excluded, API key with opt-in → grok, without subscription eligibility', () => {
    expect(planPodProvider({ codexCandidates: candidates(96), grokSubscription: false, grokApiKey: true, grokApiKeyOptIn: true })).toMatchObject({ provider: 'grok', grokSubscriptionEligible: false });
  });
  test('subscription eligibility is independent of API-key opt-in even when codex is usable', () => {
    const plan = planPodProvider({ codexCandidates: [c('third', 47)], grokSubscription: true, grokApiKey: true, grokApiKeyOptIn: false });
    expect(plan).toMatchObject({ provider: 'openai-codex', accounts: ['third'], grokSubscriptionEligible: true });
    const withoutSubscription = planPodProvider({ codexCandidates: [c('third', 47)], grokSubscription: false, grokApiKey: true, grokApiKeyOptIn: true });
    expect(withoutSubscription).toMatchObject({ provider: 'openai-codex', accounts: ['third'], grokSubscriptionEligible: false });
  });
});
