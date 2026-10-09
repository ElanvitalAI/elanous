// ReasoningLevel 에 `xhigh` 가 «들어왔고», 못 받는 모델에서는 «깎인다».
//
// 🩸 왜 — 2026-09-23 실측: Codex API 가 400 으로 지원값을 직접 답했다 —
//   `none·minimal·low·medium·high·xhigh·max` (일곱). 실호출로 gpt-6-sol 의 xhigh·max 수용도 확인했다.
//   그런데 provider 공통 축 `ReasoningLevel` 은 `off|low|medium|high` 넷이라 ***high 가 천장***이었고,
//   사다리·`/reasoning`·HUD 어디서도 xhigh 를 가리킬 수 없었다(대표: 「sol effort 를 세분화」).
// ⛔ 이 축은 «공통»이다 — xhigh 를 못 받는 모델에 그대로 보내면 400 이다. 그래서 이 자는
//    「넣었나」보다 ***「상한이 낮으면 깎이나」***를 먼저 문다.
import { describe, expect, it } from 'bun:test';
import {
  _claudeSupportsThinkingForContractTest, REASONING_CYCLE, effectiveReasoningLevel,
  mapReasoningLevelToCodex, modelSupportsReasoning, nextReasoningLevel, reasoningLevelLabel,
} from './llm.js';
import { reasoningEffortCeiling } from './intelligence-map/model-catalog.js';
import { parseReasoningLevel } from './user-config.js';

/** 상한이 «정확히 high» 인 모델 하나를 SSOT 에서 고른다 — 이름을 손으로 박지 않는다. */
const HIGH_CEILING_MODEL = ['claude-opus-5', 'gemini-3.1-pro-preview', 'grok-4.7', 'gpt-5.5']
  .find((m) => reasoningEffortCeiling(m) === 'high');

describe('Claude extended-thinking capability', () => {
  it('uses numeric Claude generations from 3.7 onward for both capability and default reasoning', () => {
    for (const model of [
      'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5',
      'claude-sonnet-4-5-20250929', 'claude-3-7-sonnet', 'claude-opus-6',
    ]) {
      expect(_claudeSupportsThinkingForContractTest(model)).toBe(true);
      expect(modelSupportsReasoning('anthropic', model)).toBe(true);
      expect(effectiveReasoningLevel({}, 'anthropic', model)).toBe('high');
    }
    expect(_claudeSupportsThinkingForContractTest('claude-3-5-haiku')).toBe(false);
    expect(modelSupportsReasoning('anthropic', 'claude-3-5-haiku')).toBe(false);
  });
});

describe('ReasoningLevel ⊕ xhigh', () => {
  it('⭐ config 파서가 xhigh 를 «받는다» — 지어낸 값은 «안 받는다»', () => {
    // ⚠️ `getUserConfig()` 경로로 물면 시험 러너가 config 를 격리해 «언제나 undefined» 가 나온다(실측).
    //   그 경로는 러너 밖에서 확인했다: env=xhigh → xhigh · env=bogus → undefined.
    expect(parseReasoningLevel('xhigh')).toBe('xhigh');
    expect(parseReasoningLevel('high')).toBe('high');
    expect(parseReasoningLevel('ultra-bogus')).toBeUndefined();
    expect(parseReasoningLevel('max')).toBeUndefined();          // ⛔ max 는 «일부러» 안 받는다
  });

  it('⭐ 상한이 max 인 모델(gpt-6-sol)에는 xhigh 를 «그대로» 싣는다', () => {
    expect(reasoningEffortCeiling('gpt-6-sol')).toBe('max');   // 전제 — 무너지면 아래는 뜻이 없다
    expect(mapReasoningLevelToCodex('xhigh', 'gpt-6-sol')?.effort).toBe('xhigh');
  });

  it('⛔ 상한이 high 인 모델에는 xhigh 를 «high 로 깎는다» — 넘기면 API 400', () => {
    expect(HIGH_CEILING_MODEL).toBeDefined();                  // 자가 무는지 — 후보가 없으면 공허하게 참
    expect(mapReasoningLevelToCodex('xhigh', HIGH_CEILING_MODEL)?.effort).toBe('high');
  });

  it('⛔ 모델을 «모르면» 깎는다 — 모르는 모델에 xhigh 를 보내지 않는다', () => {
    expect(mapReasoningLevelToCodex('xhigh')?.effort).toBe('high');
  });

  it('✅ 기존 단계는 «그대로»다 (회귀 방어)', () => {
    expect(mapReasoningLevelToCodex('off', 'gpt-6-sol')).toBeUndefined();
    expect(mapReasoningLevelToCodex('low', 'gpt-6-sol')?.effort).toBe('low');
    expect(mapReasoningLevelToCodex('medium', 'gpt-6-sol')?.effort).toBe('medium');
    expect(mapReasoningLevelToCodex('high', 'gpt-6-sol')?.effort).toBe('high');
  });

  it('⭐ 순환은 high 다음이 xhigh, 그 다음은 off 로 감긴다', () => {
    expect(REASONING_CYCLE).toContain('xhigh');
    expect(nextReasoningLevel('high')).toBe('xhigh');
    expect(nextReasoningLevel('xhigh')).toBe('off');
  });

  it('⭐ 라벨이 있다 — HUD·/reasoning 이 «undefined» 를 그리지 않는다', () => {
    expect(reasoningLevelLabel('xhigh')).toContain('xhigh');
  });

  it('⭐ codexReasoning.effort=xhigh 가 HUD 에서 «흘러내리지» 않는다 (종전엔 매핑이 없었다)', () => {
    const lvl = effectiveReasoningLevel({ reasoningLevel: 'low', codexReasoning: { effort: 'xhigh' } }, 'openai-codex', 'gpt-6-sol');
    expect(lvl).toBe('xhigh');
  });
});
