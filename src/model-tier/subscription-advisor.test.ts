// SUBSCRIPTION-ADVISOR-PROACTIVE — 시험.
// numeric 임계 출처: subscription-advisor.ts 머리 주석(WINDOW_LOW_REMAINING 0.05 — codex-rotation
// usedPercent>=95 선례 · WEEKLY_EXHAUSTION_ADD_THRESHOLD 2 — 교훈 원장 «같은 오류 2회» 계약 ·
// MONTHLY_CALLS_IDLE_THRESHOLD 10). 시험 단언은 그 상수를 직접 인용(하드코딩 아님).
import { describe, expect, test } from 'bun:test';
import {
  MONTHLY_CALLS_IDLE_THRESHOLD,
  WEEKLY_EXHAUSTION_ADD_THRESHOLD,
  WINDOW_LOW_REMAINING,
  adviseSubscriptions,
  type SubscriptionUsage,
  type SubscriptionWindow,
} from './subscription-advisor.js';

const FIXED_NOW = () => new Date('2026-11-22T06:00:00Z').getTime();

describe('SUBSCRIPTION-ADVISOR-PROACTIVE — 창 소진 패턴 → 구독 제안', () => {
  test('주 2회+ 창 소진 + 남은 창 ≤5% = 추가(add) 제안', () => {
    const windows: SubscriptionWindow[] = [{ provider: 'openai-codex', account: 'a1', remaining: 0.02, resetsAtMs: FIXED_NOW() + 3_600_000 }];
    const usage: SubscriptionUsage[] = [{ provider: 'openai-codex', account: 'a1', weeklyWindowExhaustions: 3, monthlyWindowExhaustions: 9, monthlyPriceUsd: 20, monthlyCalls: 400 }];
    const report = adviseSubscriptions({ windows, usage, now: FIXED_NOW });
    expect(report.recommendations.length).toBe(1);
    const r = report.recommendations[0]!;
    expect(r.action).toBe('add');
    expect(r.evidence.weeklyWindowExhaustions).toBe(3);
    expect(r.reason).toContain('주 3회 창 소진');
  });

  test('월 4회+ 소진(주 미달) = 상향(upgrade) 제안', () => {
    const windows: SubscriptionWindow[] = [{ provider: 'openai-codex', account: 'a2', remaining: 0.4 }];
    const usage: SubscriptionUsage[] = [{ provider: 'openai-codex', account: 'a2', weeklyWindowExhaustions: 0, monthlyWindowExhaustions: 5, monthlyPriceUsd: 20, monthlyCalls: 350 }];
    const report = adviseSubscriptions({ windows, usage, now: FIXED_NOW });
    expect(report.recommendations[0]!.action).toBe('upgrade');
  });

  test('월 호출 ≤10·소진 0 = 하향(downgrade) 제안 · 30일 호출 0 + 창 부재 = 해지(cancel)', () => {
    const windows: SubscriptionWindow[] = [{ provider: 'grok', account: null, remaining: 0.8 }];
    const usage: SubscriptionUsage[] = [
      { provider: 'grok', account: null, weeklyWindowExhaustions: 0, monthlyWindowExhaustions: 0, monthlyPriceUsd: 30, monthlyCalls: 3 },
      { provider: 'glm', account: null, weeklyWindowExhaustions: 0, monthlyWindowExhaustions: 0, monthlyPriceUsd: 15, monthlyCalls: 0 },
    ];
    const report = adviseSubscriptions({ windows, usage, now: FIXED_NOW });
    const actions = report.recommendations.map(r => `${r.provider}:${r.action}`);
    expect(actions).toContain('grok:downgrade');
    expect(actions).toContain('glm:cancel');
  });

  test('⛔ 창 «모름» = 제안 제외 + unknownWindowSubscriptions 카운트(합성 금지 계약)', () => {
    const windows: SubscriptionWindow[] = [{ provider: 'claude', account: null }];
    const usage: SubscriptionUsage[] = [{ provider: 'claude', account: null, weeklyWindowExhaustions: 9, monthlyWindowExhaustions: 40, monthlyPriceUsd: 100, monthlyCalls: 900 }];
    const report = adviseSubscriptions({ windows, usage, now: FIXED_NOW });
    expect(report.recommendations.length).toBe(0);
    expect(report.unknownWindowSubscriptions).toBe(1);
  });

  test('패턴 임계 미충족 = 제안 0 + 요약에 유지 행', () => {
    const windows: SubscriptionWindow[] = [{ provider: 'grok', account: null, remaining: 0.5 }];
    const usage: SubscriptionUsage[] = [{ provider: 'grok', account: null, weeklyWindowExhaustions: 0, monthlyWindowExhaustions: 0, monthlyPriceUsd: 30, monthlyCalls: 200 }];
    const report = adviseSubscriptions({ windows, usage, now: FIXED_NOW });
    expect(report.recommendations.length).toBe(0);
    expect(report.weeklySummaryMd).toContain('제안 없음');
  });

  test('주간 요약 마크다운 — 표 헤더·금액 비공개 계약·임계 출처 상수 정합', () => {
    const windows: SubscriptionWindow[] = [{ provider: 'openai-codex', account: 'a1', remaining: 0.02 }];
    const usage: SubscriptionUsage[] = [{ provider: 'openai-codex', account: 'a1', weeklyWindowExhaustions: WEEKLY_EXHAUSTION_ADD_THRESHOLD, monthlyWindowExhaustions: 9, monthlyPriceUsd: 20, monthlyCalls: 400 }];
    const md = adviseSubscriptions({ windows, usage, now: FIXED_NOW }).weeklySummaryMd;
    expect(md).toContain('# 구독 조언자 — 주간 요약');
    expect(md).toContain('| openai-codex:a1 | 추가 |');
    expect(md).toContain('금액·단가 비공개');
    expect(md).not.toMatch(/\$\s?\d/); // 가격 비공개 — 금액 문자열 금지
    expect(WINDOW_LOW_REMAINING).toBe(0.05);          // 출처: codex-rotation usedPercent>=95 선례
    expect(WEEKLY_EXHAUSTION_ADD_THRESHOLD).toBe(2);  // 출처: «같은 오류 2회» 계약
    expect(MONTHLY_CALLS_IDLE_THRESHOLD).toBe(10);    // 출처: 모듈 머리 주석
  });
});
