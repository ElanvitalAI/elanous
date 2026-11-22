// ROUTER-STEP-UP-DOWN r1(OP #127661) — «상시 하향 계기»: 성공 N턴 + 쉬운 일 분류 → 한 단계만 내림.
// 칸 본문(0.3.33): 고급(terra/sol)은 checkpoint(계획·최종 검토·보안)와 «실패 신호» 때 1턴만 올렸다가 바로 내림 —
// 그러므로 하향 계기는 checkpoint 순간과 살아 있는 올림 계기에서는 금지다. 올림(escalateOnce)은 이 PR 에서 건드리지 않는다.
// 측정(OP 판단 ③): #39502 원장 축(router-savings)으로 하향 계기 전/후 premiumCalls·savingsPct 를 이 시험 하나로 잰다.
// −75%/95% 전체 증명은 CC-1(ROUTER-QUALITY-GUARD-95)과 묶어 FU — 이 PR 범위 밖. #39504 선택기 확장도 범위 밖.
// 숫자는 모듈 상수에서 유도한다(NUMGUARD) · 시계·네트워크·LLM 0.
import { describe, expect, it } from 'bun:test';
import { summarizeRouterSavings, type SavingsCallRow, type SavingsPriceOf } from './router-savings.js';
import {
  RED_ROUNDS_ESCALATE_AT,
  SAME_ERROR_ESCALATE_AT,
  STEPDOWN_CHECKPOINT_MOMENTS,
  WORK_STEPDOWN_SUCCESS_TURNS,
  WORK_TIER_CLASSES,
  stepDownOnce,
  type WorkTierClass,
} from './work-tier-policy.js';

describe('stepDownOnce — 상시 하향 계기: 성공 N턴 + 쉬운 일 분류 → 한 단계만 내림', () => {
  const easy = { successTurns: WORK_STEPDOWN_SUCCESS_TURNS, easyTask: true } as const;

  it('mid→weak · strong→mid 한 단계씩, weak 은 더 밑이 없어 null, 계기 이름은 advisor 어휘', () => {
    const fromMid = stepDownOnce('mid', easy)!;
    expect(fromMid).toEqual({ from: 'mid', to: 'weak', trigger: 'advisor:step-down' });
    const fromStrong = stepDownOnce('strong', easy)!;
    expect(fromStrong).toEqual({ from: 'strong', to: 'mid', trigger: 'advisor:step-down' });
    expect(WORK_TIER_CLASSES.indexOf(fromStrong.to) - WORK_TIER_CLASSES.indexOf(fromStrong.from)).toBe(-1);
    expect(stepDownOnce('weak', easy)).toBeNull();
  });

  it('계기가 덜 충족되면 내리지 않는다: 성공 턴 부족 · 쉬운 일 아님 · 신호 없음', () => {
    expect(stepDownOnce('strong', { successTurns: WORK_STEPDOWN_SUCCESS_TURNS - 1, easyTask: true })).toBeNull();
    expect(stepDownOnce('strong', { successTurns: WORK_STEPDOWN_SUCCESS_TURNS, easyTask: false })).toBeNull();
    expect(stepDownOnce('strong', {})).toBeNull();
  });

  it('terra r1 mustFix 경계: NaN·Infinity 성공 턴은 «확인된 3턴»이 아니다 — 유한한 턴 수만 허용', () => {
    // 결함: NaN < N 은 거짓이라 기존 가드((successTurns ?? 0) < N)를 통과해 내려갔다 — 유한 검사로 막는다.
    expect(stepDownOnce('strong', { successTurns: Number.NaN, easyTask: true })).toBeNull();
    expect(stepDownOnce('strong', { successTurns: Number.POSITIVE_INFINITY, easyTask: true })).toBeNull();
    // 유한 경계 회귀 결속: N-1 은 내리지 않는다·N 은 내린다(기존 계약 불변).
    expect(stepDownOnce('strong', { successTurns: WORK_STEPDOWN_SUCCESS_TURNS - 1, easyTask: true })).toBeNull();
    expect(stepDownOnce('strong', { successTurns: WORK_STEPDOWN_SUCCESS_TURNS, easyTask: true }))
      .toEqual({ from: 'strong', to: 'mid', trigger: 'advisor:step-down' });
  });

  it('checkpoint(계획·최종 검토·보안) 순간이면 내리지 않는다 — 그 순간엔 고급이 필요하다', () => {
    // 칸 본문 checkpoint 어휘: 계획(plan) · 최종 검토(pre-complete) · 보안(security).
    expect([...STEPDOWN_CHECKPOINT_MOMENTS]).toEqual(['plan', 'pre-complete', 'security']);
    for (const checkpointMoment of STEPDOWN_CHECKPOINT_MOMENTS) {
      expect(stepDownOnce('strong', { ...easy, checkpointMoment })).toBeNull();
    }
    // checkpoint 아닌 순간(예: 통상 턴)은 계기가 살아 있으면 내린다.
    expect(stepDownOnce('strong', { ...easy, checkpointMoment: 'mid-turn' })).toEqual({ from: 'strong', to: 'mid', trigger: 'advisor:step-down' });
  });

  it('올림 계기(실패 신호)가 살아 있으면 올림이 우선 — 내리지 않는다, 꺼지면 다시 내린다', () => {
    const failing = [{ sameErrorCount: SAME_ERROR_ESCALATE_AT }, { redRounds: RED_ROUNDS_ESCALATE_AT }, { riskyFirstDesign: true }] as const;
    for (const escalating of failing) {
      expect(stepDownOnce('strong', { ...easy, escalating })).toBeNull();
    }
    expect(stepDownOnce('strong', { ...easy, escalating: { sameErrorCount: SAME_ERROR_ESCALATE_AT - 1 } }))
      .toEqual({ from: 'strong', to: 'mid', trigger: 'advisor:step-down' });
  });
});

// ── #39502 원장 축 측정(OP 판단 ③): 하향 계기 전/후를 이 시험 하나로 ────────────
describe('router-savings — 하향 계기 전/후 premiumCalls·savingsPct(테스트 우주)', () => {
  /** 테스트 우주 단가(USD/토큰) — 같은 주입 단가로 행의 실측 칸(costUsd)과 강 단독 기준(counterfactual)을 계산한다. */
  const PRICE_PER_TOKEN = {
    'premium-model': { input: 5e-6, output: 2e-5 },
    'mid-model': { input: 1e-6, output: 4e-6 },
    'weak-model': { input: 5e-7, output: 2e-6 },
  } as const;
  const priceOf: SavingsPriceOf = (model, tokens) => {
    const per = PRICE_PER_TOKEN[model as keyof typeof PRICE_PER_TOKEN];
    return per ? tokens.inputTokens * per.input + tokens.outputTokens * per.output : null;
  };

  /** 테스트 우주 모델 — 등급 칸(WorkTierClass)마다 한 모델. 강 단독 기준(premiumModel) = premium-model. */
  const MODEL_OF_CLASS: Readonly<Record<WorkTierClass, string>> = { strong: 'premium-model', mid: 'mid-model', weak: 'weak-model' };
  // NUMGUARD: 토큰 축은 유도 단위 — 기존 work-tier-policy.test.ts 의 SCALE 과 같은 축.
  const SCALE = 1000;
  const INPUT_TOKENS = 3 * SCALE;
  const OUTPUT_TOKENS = 2 * SCALE;

  /** 쉬운 일 과제가 N턴 연속 성공한 뒤의 호출 스트림 — 강 4 · 중 2 · 약 2. */
  const STREAM_TIERS = ['strong', 'strong', 'strong', 'strong', 'mid', 'mid', 'weak', 'weak'] as const;
  const stream: SavingsCallRow[] = STREAM_TIERS.map((tier, i) => ({
    at: i + 1,
    role: 'turn',
    phase: 'easy-bulk',
    model: MODEL_OF_CLASS[tier],
    tier,
    inputTokens: INPUT_TOKENS,
    outputTokens: OUTPUT_TOKENS,
    costUsd: priceOf(MODEL_OF_CLASS[tier], { inputTokens: INPUT_TOKENS, outputTokens: OUTPUT_TOKENS }),
  }));
  const signals = { successTurns: WORK_STEPDOWN_SUCCESS_TURNS, easyTask: true } as const;
  const strongCalls = STREAM_TIERS.filter((tier) => tier === 'strong').length;

  it('전/후 대조: stepDownOnce 를 스트림에 적용하면 고급 호출 strongCalls→0, savingsPct 상승', () => {
    const before = summarizeRouterSavings({ calls: stream, premiumModel: MODEL_OF_CLASS.strong, priceOf });
    expect(before.totalCalls).toBe(stream.length);
    expect(before.unpricedCalls).toBe(0);
    expect(before.premiumCalls).toBe(strongCalls); // 계기 도입 전 — 강 호출이 그대로 고급으로 센다.
    const rerouted = stream.map((call): SavingsCallRow => {
      const tier = WORK_TIER_CLASSES.find((candidate) => candidate === call.tier) ?? null;
      const step = tier === null ? null : stepDownOnce(tier, signals);
      if (step === null) return call;
      // 내린 등급에서 실제로 돌았을 호출 행 — 모델과 실측 비용(costUsd)도 그 등급의 것으로 다시 잰다.
      const model = MODEL_OF_CLASS[step.to];
      const costUsd = priceOf(model, { inputTokens: call.inputTokens ?? 0, outputTokens: call.outputTokens ?? 0 });
      return { ...call, tier: step.to, model, ...(costUsd === null ? {} : { costUsd }) };
    });
    const after = summarizeRouterSavings({ calls: rerouted, premiumModel: MODEL_OF_CLASS.strong, priceOf });
    expect(after.premiumCalls).toBe(0); // 완료선 방향(고급 호출 비율 ≤10%) — 이 우주에서는 0%.
    expect(after.savingsPct).not.toBeNull();
    expect(before.savingsPct).not.toBeNull();
    expect(after.savingsPct!).toBeGreaterThan(before.savingsPct!); // 가벼운 모델로 내릴수록 강 단독 대비 절감 ↑.
    expect(rerouted.filter((call) => call.tier === 'mid' && call.model === 'mid-model')).toHaveLength(strongCalls); // strong→mid 한 단계만.
    expect(rerouted.filter((call) => call.tier === 'weak' && call.model === 'weak-model')).toHaveLength(stream.length - strongCalls); // mid→weak · 약은 그대로(최하).
  });
});
