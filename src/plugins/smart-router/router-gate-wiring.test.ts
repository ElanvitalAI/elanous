// SMART-ROUTER-PLUGIN-TIERS 종단 배선 시험(JUD-B #125712 HOLD 수리) —
// authorizeRouterFeature 가 실제 ModelOrchestrationCore.decide 의 등급을 바꾸는지(허용·거부 종단).
import { describe, expect, test } from 'bun:test';
import { createModelOrchestrationCore } from '../../model-tier/model-orchestration.js';
import { ADVISOR_ESCALATE_RULE } from '../../model-tier/advisor-checkpoints.js';
import type { WorkSignals } from '../../model-tier/orchestration-core.js';
import { createSmartRouterTierGate, envMembershipResolver, routerFeatureKeyForDecision } from './consumer.js';
import type { ModelTier } from '../../model-tier/types.js';

const work: WorkSignals = { level: 'L5', bloom: 'evaluate', riskCategories: ['persistence'], reasons: ['multi-file'] };
// ladder 계약 = (provider: string) => Readonly<Record<ModelTier, …>> — orchestration-core.ts:158 ·
// 전 5키(budget·balanced·better·best·loaded) 채움(advisor-checkpoints.test.ts FAKE_LADDER 패턴).
const GATE_TEST_LADDER: Readonly<Record<ModelTier, { model: string }>> = {
  budget: { model: 'weak-model' }, balanced: { model: 'balanced-model' }, better: { model: 'mid-model' },
  best: { model: 'strong-model' }, loaded: { model: 'loaded-model' },
};
const ladder = (provider: string) => (provider === 'openai-codex' ? GATE_TEST_LADDER : undefined);
const escalate = [ADVISOR_ESCALATE_RULE];
const input = (checkpoint?: 'plan' | 'same-error' | 'pre-complete') => ({
  runId: 'r1', moment: 'implement' as const, provider: 'openai-codex', work, checkpoint,
});

describe('SMART-ROUTER 등급 게이트 — 코어 종단 허용·거부(실제 decide 출력 변화)', () => {
  test('free + ADVISOR 계획 직전 올림 → strong_three_moments 거부 → 올림 되돌림(weak) · 이유에 gate-blocked', () => {
    const core = createModelOrchestrationCore({
      ladder, escalate,
      gate: createSmartRouterTierGate({ currentTier: () => 'free' }),
    });
    const d = core.decide(input('plan'));
    expect(d.tier).toBe('mid'); // 올림 되돌림 = base(L5 risky implement = mid)
    expect(d.trigger).toBe('base');
    expect(d.reason.some(r => r.startsWith('gate-blocked:smart-router-tiers'))).toBe(true);
    expect(d.reason.some(r => r.includes('router.strong_three_moments:denied'))).toBe(true);
  });

  test('pro + ADVISOR 계획 직전 올림 → strong_three_moments 허용 → strong 유지', () => {
    const core = createModelOrchestrationCore({
      ladder, escalate,
      gate: createSmartRouterTierGate({ currentTier: () => 'pro' }),
    });
    const d = core.decide(input('plan'));
    expect(d.tier).toBe('strong');
    expect(d.trigger).toBe('advisor:plan');
  });

  test('free + ADVISOR 완료 직전 → strong_final_check(무료 허용) → strong 유지', () => {
    const core = createModelOrchestrationCore({
      ladder, escalate,
      gate: createSmartRouterTierGate({ currentTier: () => 'free' }),
    });
    const d = core.decide(input('pre-complete'));
    expect(d.tier).toBe('strong');
  });

  test('계기 없는 base 결정(기본 자동 라우팅) → 게이트가 올림을 되돌리지 않는다', () => {
    const core = createModelOrchestrationCore({
      ladder,
      gate: createSmartRouterTierGate({ currentTier: () => 'free' }),
    });
    const d = core.decide(input());
    expect(d.tier).toBe('mid'); // L5 risky implement base = mid(올림 없음 → 게이트 개입 없음)
    expect(d.reason.some(r => r.startsWith('gate-blocked'))).toBe(false);
  });

  test('mustFix ① (jud-39528) free + L5 계획(risky design — base=strong) ADVISOR 상담 → 게이트가 «계기»를 심사해 되돌린다(유료 상담 차단·일반 strong 라우팅 유지)', () => {
    const core = createModelOrchestrationCore({
      ladder, escalate,
      gate: createSmartRouterTierGate({ currentTier: () => 'free' }),
    });
    const d = core.decide({ runId: 'r1', moment: 'design', provider: 'openai-codex', work, checkpoint: 'plan' });
    expect(d.tier).toBe('strong'); // base(risky design) = strong — 일반 strong 라우팅은 유지
    expect(d.trigger).toBe('base'); // 계기 되돌림 — advisor-checkpoints 가 상담을 skip(trigger 불일치)
    expect(d.reason.some(r => r.startsWith('gate-blocked:smart-router-tiers'))).toBe(true);
    expect(d.reason.some(r => r.includes('router.strong_three_moments:denied'))).toBe(true);
  });

  test('mustFix ① (jud-39528) pro + 같은 장면 → 유료 상담 계기 유지(advisor:plan)', () => {
    const core = createModelOrchestrationCore({
      ladder, escalate,
      gate: createSmartRouterTierGate({ currentTier: () => 'pro' }),
    });
    const d = core.decide({ runId: 'r1', moment: 'design', provider: 'openai-codex', work, checkpoint: 'plan' });
    expect(d.tier).toBe('strong');
    expect(d.trigger).toBe('advisor:plan');
  });

  test('envMembershipResolver — ELANOUS_ROUTER_TIER 없으면 free(fail-closed) · 있으면 그 등급', () => {
    expect(envMembershipResolver({} as NodeJS.ProcessEnv).currentTier()).toBe('free');
    expect(envMembershipResolver({ ELANOUS_ROUTER_TIER: 'pro' } as NodeJS.ProcessEnv).currentTier()).toBe('pro');
  });

  test('routerFeatureKeyForDecision — advisor:plan → 세 순간 · advisor:pre-complete → 완료직전 1회 · base → 기본 자동', () => {
    expect(routerFeatureKeyForDecision('advisor:plan')).toBe('router.strong_three_moments');
    expect(routerFeatureKeyForDecision('advisor:pre-complete', 'pre-complete')).toBe('router.strong_final_check');
    expect(routerFeatureKeyForDecision('same-error-twice')).toBe('router.basic_auto_routing');
  });
});
