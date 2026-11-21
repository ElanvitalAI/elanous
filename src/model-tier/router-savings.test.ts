// SMART-ROUTER-DEMO-SAVINGS — 데모 영수 요약 순수모듈 시험.
// 계약: 실측 원장(llm.usage 이벤트)의 호출 행만 받아 ① 호출별 모델·길목(role/phase)·등급 표
//   ② 고급 호출 수/전체 ③ «강 단독» 대비 절감 비율을 낸다. ⛔ 가격(USD 단가·금액)은 영수에
//   비공개 — 렌더 출력에 usd/$/단가 문자열이 있으면 결함. 절감 계산에 쓰는 단가는 주입(priceOf)이고
//   토큰이 없는 호출은 «합성으로 못 채운다» — 비교 집합에서 빼고 unpricedCalls 로만 센다.

import { describe, expect, test } from 'bun:test';
import { renderSavingsReceiptMd, summarizeRouterSavings, type SavingsCallRow } from './router-savings.js';

const PREMIUM_MODEL = 'strong-model';

/** 시험용 단가(주입) — strong 은 cheap 의 10배. */
const priceOf = (model: string, tokens: { inputTokens: number; outputTokens: number }): number | null => {
  const perM = model === PREMIUM_MODEL ? { input: 10, output: 30 } : { input: 1, output: 3 };
  return (tokens.inputTokens * perM.input + tokens.outputTokens * perM.output) / 1_000_000;
};

const calls: SavingsCallRow[] = [
  { at: 1, role: 'planning', phase: 'turn', model: PREMIUM_MODEL, provider: 'openai-codex', billing: 'subscription', tier: 'strong', inputTokens: 1_000, outputTokens: 2_000, apiEquivalentUsd: 0.07 },
  { at: 2, role: 'implement', phase: 'turn', model: 'cheap-model', provider: 'openrouter', billing: 'credit', tier: 'mid', inputTokens: 1_000, outputTokens: 2_000, costUsd: 0.004 },
  { at: 3, role: 'classify', model: 'mini-model', provider: 'openrouter', billing: 'credit', tier: 'weak', inputTokens: 500, outputTokens: 500, costUsd: 0.001 },
  { at: 4, role: 'review', model: 'cheap-model', provider: 'openai-codex', billing: 'subscription', tier: 'mid', inputTokens: 800, outputTokens: 900, apiEquivalentUsd: 0.0107 },
];

describe('summarizeRouterSavings', () => {
  test('고급 호출 수/전체 · 호출별 모델·길목 표', () => {
    const r = summarizeRouterSavings({ calls, premiumModel: PREMIUM_MODEL, priceOf });
    expect(r.totalCalls).toBe(4);
    expect(r.premiumCalls).toBe(1);
    expect(r.rows.map((x) => x.model)).toEqual([PREMIUM_MODEL, 'cheap-model', 'mini-model', 'cheap-model']);
    expect(r.rows[0]).toMatchObject({ role: 'planning', phase: 'turn', tier: 'strong', premium: true });
    expect(r.rows[1]).toMatchObject({ role: 'implement', tier: 'mid', premium: false });
  });

  test('강 단독 대비 절감(실측 환산 vs 전부 strong 단가)', () => {
    const r = summarizeRouterSavings({ calls, premiumModel: PREMIUM_MODEL, priceOf });
    // actual = 0.07 + 0.004 + 0.001 + 0.0107 = 0.0857
    // premiumOnly = 0.07 + 0.07 + 0.02 + 0.035 = 0.195
    expect(r.savingsPct).not.toBeNull();
    expect(r.savingsPct!).toBeCloseTo(1 - 0.0857 / 0.195, 5);
    expect(r.unpricedCalls).toBe(0);
  });

  test('토큰 없는 호출은 비교 집합에서 빠지고 unpricedCalls 로만 센다', () => {
    const withBlind: SavingsCallRow[] = [...calls, { at: 5, role: 'research', model: 'cheap-model', billing: 'unknown', tier: 'mid', costUsd: 0.002 }];
    const r = summarizeRouterSavings({ calls: withBlind, premiumModel: PREMIUM_MODEL, priceOf });
    expect(r.totalCalls).toBe(5);
    expect(r.unpricedCalls).toBe(1);
    // 절감 비율은 원래 4건과 동일(비교 집합 불변).
    expect(r.savingsPct!).toBeCloseTo(1 - 0.0857 / 0.195, 5);
  });

  test('가격을 못 매기는 호출이 전부면 savingsPct = null(합성 0 금지)', () => {
    const r = summarizeRouterSavings({ calls: [calls[4] ?? calls[0]], premiumModel: PREMIUM_MODEL, priceOf });
    expect(calls[4]).toBeUndefined();
    const blind = summarizeRouterSavings({
      calls: [{ at: 9, role: 'research', model: 'cheap-model', tier: 'mid', costUsd: 0.002 }],
      premiumModel: PREMIUM_MODEL, priceOf,
    });
    expect(blind.savingsPct).toBeNull();
    expect(r.totalCalls).toBe(1);
  });

  test('렌더 영수에 가격(usd/$) 문자열이 없다 — 비공개 계약', () => {
    const r = summarizeRouterSavings({ calls, premiumModel: PREMIUM_MODEL, priceOf });
    const md = renderSavingsReceiptMd(r, { title: 'SMART-ROUTER-DEMO-SAVINGS', at: '2026-11-21T09:00:00+09:00' });
    expect(md).toContain('SMART-ROUTER-DEMO-SAVINGS');
    expect(md).toContain('1/4');
    expect(md).toMatch(/planning|implement/);
    expect(md).not.toMatch(/usd|USD|\$/);
    expect(md).toContain('절감');
  });

  test('렌더 방어 — 시각을 못 매긴 행(at 비유한)도 영수가 나온다(데모 비정지)', () => {
    const r = summarizeRouterSavings({ calls: [{ at: Number.NaN, model: 'cheap-model', tier: 'mid' }], premiumModel: PREMIUM_MODEL, priceOf: () => null });
    const md = renderSavingsReceiptMd(r, { title: 'T', at: 'x' });
    expect(md).toContain('시각 미측정');
    expect(md).toContain('cheap-model');
  });
});
