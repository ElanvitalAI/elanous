import { describe, expect, test } from 'bun:test';
import { buildLlmBudgetAlert, type LlmBudgetSnapshot } from './llm-budget-alert.js';

// 2026-09-30 22:3x 대표 가 받은 알림의 상태를 그대로 옮긴 표본(계정 3개 · 크레딧 199,287 · 시간당 0 · codex 1/3 한도).
function snap(over: Partial<LlmBudgetSnapshot> = {}): LlmBudgetSnapshot {
  return {
    at: '2026-09-30T13:30:00Z', // 서울 22:30
    credits: { total: 199_287, usedToday: 0, paceTarget: 2_200, expiresAt: '2026-12-31T00:00:00+09:00', useFirst: true },
    accounts: [
      { name: 'third', subscriptionRemainingPct: 10, credits: 0, resetInHours: 20 },
      { name: 'team', subscriptionRemainingPct: 0, credits: 65_833, resetInHours: 76 },
      { name: 'default', subscriptionRemainingPct: 8, credits: 0, resetInHours: 30 },
    ],
    selected: { account: 'third', reason: 'subscription' },
    ...over,
  };
}

const INTERNAL = /자는|판정|third|team|default|한도 참/;

describe('NT1 LLM budget alert', () => {
  test('the 09-30 case: credits-first policy but subscription picked → one decision, pace line, no internal words', () => {
    const a = buildLlmBudgetAlert(snap());
    expect(a.send).toBe(true);
    expect(a.key).toBe('pace-behind:2026-09-30');
    const lines = a.text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('구독 계정이 먼저');
    expect(lines[1]).toBe('오늘 0 / 목표 2,200 · 남은 크레딧 199,287 · 12-31 만료');
    expect(lines[2]!.startsWith('할 일:')).toBe(true);
    expect(a.text).not.toMatch(INTERNAL);
    // 모순 금지: 크레딧 진행 중이라는 말과 한도 문구가 같이 나오지 않는다.
    expect(a.text.includes('크레딧으로 진행 중')).toBe(false);
  });

  test('same state again is silent; a new day speaks once more', () => {
    const first = buildLlmBudgetAlert(snap());
    expect(buildLlmBudgetAlert(snap(), first.key).send).toBe(false);
    const nextDay = buildLlmBudgetAlert(snap({ at: '2026-10-01T10:00:00Z' }), first.key);
    expect(nextDay.key).toBe('pace-behind:2026-10-01');
    expect(nextDay.send).toBe(true);
  });

  test('morning zero is normal — no pace alert before 18:00 Seoul', () => {
    const morning = buildLlmBudgetAlert(snap({ at: '2026-10-01T00:30:00Z' })); // 09:30
    expect(morning.send).toBe(false);
    expect(morning.key).toBe('ok');
  });

  test('on pace is silent', () => {
    expect(buildLlmBudgetAlert(snap({ credits: { total: 190_000, usedToday: 2_300, paceTarget: 2_200, expiresAt: '2026-12-31', useFirst: true }, selected: { reason: 'credits', account: 'team' } })).send).toBe(false);
  });

  test('fallback to another provider says when codex returns and that nothing is needed', () => {
    const a = buildLlmBudgetAlert(snap({ selected: { reason: 'fallback' }, fallback: { provider: 'grok', remainingPct: 37 } }));
    expect(a.key).toBe('fallback:grok');
    expect(a.text).toContain('grok 로 일하고 있습니다(남은 37%)');
    expect(a.text).toContain('20시간 뒤 돌아옵니다');
    expect(a.text).toContain('할 일: 없음');
    expect(a.text).not.toMatch(INTERNAL);
  });

  test('nothing usable is the one alert that asks for action', () => {
    const a = buildLlmBudgetAlert(snap({ selected: { reason: 'none' } }));
    expect(a.key).toBe('blocked');
    expect(a.text.split('\n')[0]).toContain('작업이 멈췄습니다');
    expect(a.text).toContain('구독 계정 3개');
  });

  test('credits about to expire outrank the pace line', () => {
    const a = buildLlmBudgetAlert(snap({ at: '2026-12-27T13:00:00Z' }));
    expect(a.key).toBe('expiry:4');
    expect(a.text.split('\n')[0]).toBe('💳 크레딧 199,287 이 4일 뒤 사라집니다.');
  });
});
