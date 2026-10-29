// SHADOW-MODEL-ARMS(0.2.44 칸) — 명시 실행하는 저작 단계 그림자 «1팔» probe 시험.
//
// 무대: shadow-authoring-probe 생산 저작 경로 고정 입력 — planShadowArms 실제 호출 ⊕
//       goal-author 관측 seam(가짜 관측자). 소스 문자열 검사가 아니라 생산 호출 경로를 그대로 지난다.
// 경계: 골·PR·착지 쓰기 0 · Claude 구독(LLM) 호출 0 — probe 는 계획만 한다.
//       자동 런 훅과 다른 단계(implement·review·judge)는 후속 조각이다.

import { describe, expect, test } from 'bun:test';
import { estimateLlmCost } from '../src/budget/llm-cost.js';
import { formatShadowArmProbeRecord, probeShadowArm } from '../src/budget/shadow-arms.js';
import {
  SHADOW_AUTHORING_ARM_DIFFICULTY,
  SHADOW_AUTHORING_ARM_INPUT_TOKENS,
  SHADOW_AUTHORING_ARM_MODEL,
  SHADOW_AUTHORING_ARM_OUTPUT_TOKENS,
  SHADOW_AUTHORING_DAILY_CAP_USD,
  SHADOW_AUTHORING_SPENT_TODAY_USD,
  _setShadowArmProbeObserverForTesting,
  probeAuthoringShadowArm,
  type AuthoringShadowArmProbe,
} from '../src/self-implement/goal-author.js';
import { runShadowAuthoringProbe } from './shadow-authoring-probe.js';

describe('SHADOW-MODEL-ARMS: 저작 단계 그림자 1팔 probe', () => {
  test('그림자 1팔 후보 모델은 가격표가 아는 모델이다(전제 — 아니면 fire 기록 자체가 불가능하다)', () => {
    const estimate = estimateLlmCost({
      model: SHADOW_AUTHORING_ARM_MODEL,
      inputTokens: SHADOW_AUTHORING_ARM_INPUT_TOKENS,
      outputTokens: SHADOW_AUTHORING_ARM_OUTPUT_TOKENS,
    });
    expect(estimate.kind).toBe('known');
  });

  test('planShadowArms 일일 상한 안에서 실제 호출되어 난이도·모델·예상/실제 비용·결과를 기록한다', () => {
    const record = probeShadowArm({
      stage: 'authoring',
      difficulty: 'small',
      inputTokens: SHADOW_AUTHORING_ARM_INPUT_TOKENS,
      expectedOutputTokens: SHADOW_AUTHORING_ARM_OUTPUT_TOKENS,
      candidates: [SHADOW_AUTHORING_ARM_MODEL],
      spentTodayUsd: SHADOW_AUTHORING_SPENT_TODAY_USD,
      dailyCapUsd: SHADOW_AUTHORING_DAILY_CAP_USD,
    });
    const estimate = estimateLlmCost({
      model: SHADOW_AUTHORING_ARM_MODEL,
      inputTokens: SHADOW_AUTHORING_ARM_INPUT_TOKENS,
      outputTokens: SHADOW_AUTHORING_ARM_OUTPUT_TOKENS,
    });
    expect(estimate.kind).toBe('known');
    if (estimate.kind !== 'known') return;
    expect(record.stage).toBe('authoring');
    expect(record.difficulty).toBe('small');
    expect(record.model).toBe(SHADOW_AUTHORING_ARM_MODEL);
    expect(record.result).toBe('fire');
    expect(record.skipReason).toBeNull();
    expect(record.expectedUsd).toBe(estimate.usd);
    expect(record.actualUsd).toBe(0);
    expect(record.remainingUsd).toBeCloseTo(SHADOW_AUTHORING_DAILY_CAP_USD - SHADOW_AUTHORING_SPENT_TODAY_USD - estimate.usd, 12);
    const line = formatShadowArmProbeRecord(record);
    expect(line).not.toContain('\n');
    expect(line).toContain('shadow-arm stage=authoring');
    expect(line).toContain('difficulty=small');
    expect(line).toContain(`model=${SHADOW_AUTHORING_ARM_MODEL}`);
    expect(line).toContain('result=fire');
    expect(line).toContain(`expectedUsd=${estimate.usd}`);
    expect(line).toContain('actualUsd=0');
  });

  test('후보가 여러 개여도 그림자 «1팔»만 계획한다 — 첫 팔의 기록만 낸다', () => {
    const record = probeShadowArm({
      stage: 'authoring',
      difficulty: 'medium',
      inputTokens: 1000,
      expectedOutputTokens: 1000,
      candidates: [SHADOW_AUTHORING_ARM_MODEL, 'second-candidate-model'],
      spentTodayUsd: 0,
      dailyCapUsd: SHADOW_AUTHORING_DAILY_CAP_USD,
    });
    expect(record.model).toBe(SHADOW_AUTHORING_ARM_MODEL);
  });

  test('일일 상한을 넘으면 skipped · over-daily-cap · 예상 비용 없음으로 기록한다', () => {
    const record = probeShadowArm({
      stage: 'authoring',
      difficulty: 'small',
      inputTokens: SHADOW_AUTHORING_ARM_INPUT_TOKENS,
      expectedOutputTokens: SHADOW_AUTHORING_ARM_OUTPUT_TOKENS,
      candidates: [SHADOW_AUTHORING_ARM_MODEL],
      spentTodayUsd: 0,
      dailyCapUsd: 0.000001,
    });
    expect(record.result).toBe('skipped');
    expect(record.skipReason).toBe('over-daily-cap');
    expect(record.expectedUsd).toBeNull();
    expect(record.actualUsd).toBe(0);
    expect(record.remainingUsd).toBe(0.000001);
    expect(formatShadowArmProbeRecord(record)).toContain('reason=over-daily-cap');
  });

  test('가격표가 모르는 모델은 skipped · unknown-price 로 기록한다', () => {
    const record = probeShadowArm({
      stage: 'authoring',
      difficulty: 'small',
      inputTokens: 1000,
      expectedOutputTokens: 1000,
      candidates: ['elanous-shadow-arm-unknown-price-model'],
      spentTodayUsd: 0,
      dailyCapUsd: 1,
    });
    expect(record.result).toBe('skipped');
    expect(record.skipReason).toBe('unknown-price');
    expect(formatShadowArmProbeRecord(record)).toContain('expectedUsd=unknown');
  });

  test('저작(goal-author) 단계 probe 가 관측 원장으로 기록된다(생산 probe 경로 ⊕ 가짜 관측자)', () => {
    const seen: Array<{ probe: AuthoringShadowArmProbe; authorRunId: string }> = [];
    _setShadowArmProbeObserverForTesting((probe, authorRunId) => seen.push({ probe, authorRunId }));
    try {
      const probe = probeAuthoringShadowArm('run-probe-observation-test');
      expect(seen).toHaveLength(1);
      expect(seen[0].authorRunId).toBe('run-probe-observation-test');
      expect(seen[0].probe).toBe(probe);
      expect(probe.record.stage).toBe('authoring');
      expect(probe.record.difficulty).toBe(SHADOW_AUTHORING_ARM_DIFFICULTY);
      expect(probe.record.model).toBe(SHADOW_AUTHORING_ARM_MODEL);
      expect(probe.record.actualUsd).toBe(0);
      expect(probe.line).toContain('shadow-arm stage=authoring');
      expect(probe.line).toContain(`model=${SHADOW_AUTHORING_ARM_MODEL}`);
    } finally {
      _setShadowArmProbeObserverForTesting();
    }
  });

  test('명시 실행 스크립트가 생산 probe 경로를 지나 한 줄 기록을 출력한다', () => {
    const line = runShadowAuthoringProbe();
    expect(line.startsWith('shadow-arm stage=authoring')).toBe(true);
    expect(line).toContain(`model=${SHADOW_AUTHORING_ARM_MODEL}`);
    expect(line).toMatch(/result=(fire|skipped)/);
    expect(line).toContain('actualUsd=0');
    expect(line).not.toContain('\n');
  });
});
