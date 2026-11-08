// Tier 1 · inspect-budget 면제 계약 유닛 테스트 (2026-07-19 goal-exec → 아크4 전-family).
// getInspectBudgetThreshold 를 순수 함수로 직접 검증 — flaky 한
// llm-exploration-synthesis-phase.test.ts(mock.module 오염) 를 건드리지 않는다.
//
// 계약(아크4 전-family): 아밍(codexInspectExempt=true) → **family 무관** INSPECT_BUDGET_CODEX(∞·면제).
//       미아밍 → 기존 2/3(implementation/structural). goal-loop 전-family 개방과 정합.

import { describe, it, expect } from 'bun:test';
import { getInspectBudgetThreshold, INSPECT_BUDGET_CODEX, INSPECT_BUDGET_DEFAULT, INSPECT_BUDGET_STRUCTURAL_ANALYSIS } from '../src/llm.js';
import type { LLMMessage } from '../src/llm.js';

const impl = (): LLMMessage[] => [{ role: 'user', content: '이 버그를 수정해줘' }];
const structural = (): LLMMessage[] => [{ role: 'user', content: '이 프로젝트 구조를 분석해줘' }];

describe('getInspectBudgetThreshold — 전-family inspect 면제 계약', () => {
  it('아밍(true) → INSPECT_BUDGET_CODEX(면제·∞) · family 무관', () => {
    for (const fam of ['codex', 'claude', 'gemini', 'grok', 'local', undefined]) {
      expect(getInspectBudgetThreshold(impl(), fam, true)).toBe(INSPECT_BUDGET_CODEX);
      expect(getInspectBudgetThreshold(structural(), fam, true)).toBe(INSPECT_BUDGET_CODEX);
    }
    expect(INSPECT_BUDGET_CODEX).toBe(Number.POSITIVE_INFINITY);
  });

  it('미아밍(false/undefined) → 옛 2/3 폴백 · family 무관(회귀 불변)', () => {
    for (const fam of ['codex', 'claude', 'gemini', 'local']) {
      expect(getInspectBudgetThreshold(impl(), fam, false)).toBe(INSPECT_BUDGET_DEFAULT);
      expect(getInspectBudgetThreshold(impl(), fam)).toBe(INSPECT_BUDGET_DEFAULT);
      expect(getInspectBudgetThreshold(structural(), fam, false)).toBe(INSPECT_BUDGET_STRUCTURAL_ANALYSIS);
    }
  });

  it('구현 태스크는 2, 구조분석은 3 (미아밍 baseline)', () => {
    expect(getInspectBudgetThreshold(impl(), 'claude')).toBe(2);
    expect(getInspectBudgetThreshold(structural(), 'claude')).toBe(3);
  });
});
