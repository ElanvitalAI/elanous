// LLM-AUTO-FALLBACK-ON-QUOTA(OP #135034) — 할당량 소진(429·quota) 시 다음 공급자 자동 폴백 판정.
// 우주 합성 시험(실제 호출 0): 판정기 입력만 주입한다. 시험 seam = src/session-runtime/retry-policy.ts
// `decideProviderFallback` — llm.ts streamLLM(L5272)·streamLLMWithTools(L9844) 오류 경로가
// 공급자 전환을 묻는 그 판정기다(원문: `const verdict = decideProviderFallback({ err, failedProvider,
// remainingProviders: fallbackPlan.candidates, attempted: blockedProviders })`).
// ⛔ 새 경로 0 — 기존 라우터(decideProviderFallback)·후보 순서(explainFallbackCandidates: llm.fallbackChain
//   ⊕ auto 후보)를 그대로 재사용한다. 이 시험은 «그 판정기가 429를 다음 칸으로 넘기는가»만 묻는다.
import { describe, expect, test } from 'bun:test';
import { decideProviderFallback, ProviderFallbackError, type ProviderFallbackAttempt } from './retry-policy.js';

/** 앞선 시도 한 칸 — decideProviderFallback 의 attempted 는 공급자 문자열이 아니라 시도 기록(provider·category·reason)이다. */
const priorAttempt = (provider: string): ProviderFallbackAttempt => ({ provider, category: 'quota-exceeded', reason: '429 usage_limit_reached' });

/** 429 소진 오류 합성 — llm-call-gate.ts llmSignalFromError(L159)가 읽는 것과 같은 모양(status·message). */
// provider 원문은 공급자 텍스트 그대로 실린다 — 이 시험은 제품이 쓰는 종단 문구만 영어인지 본다(합성 원문도 영어).
function quotaExhausted429(): Error & { status: number } {
  const err = new Error('429 usage_limit_reached: usage limit for the current window reached.');
  return Object.assign(err, { status: 429 }); // 출처: #135034 — HTTP 429(usage_limit_reached) 소진 신호
}

describe('LLM-AUTO-FALLBACK-ON-QUOTA — 429 소진 시 다음 공급자 자동 폴백 (decideProviderFallback)', () => {
  test('공급자 A가 429 소진을 내면 체인의 다음 공급자(B)로 넘긴다 — action=advance', () => {
    const verdict = decideProviderFallback({
      err: quotaExhausted429(),
      failedProvider: 'openai-codex',
      remainingProviders: ['grok'],
      attempted: [],
    });
    expect(verdict.action).toBe('advance');
    if (verdict.action !== 'advance') throw new Error(`expected advance, got ${verdict.action}`);
    expect(verdict.nextProvider).toBe('grok');
  });

  test('429 소진은 카테고리로 구분 가능하다(관측·집계용 문자열)', () => {
    const verdict = decideProviderFallback({
      err: quotaExhausted429(),
      failedProvider: 'openai-codex',
      remainingProviders: ['grok'],
      attempted: [],
    });
    expect(typeof (verdict as { category?: unknown }).category).toBe('string');
  });

  test('후보가 전부 소진되면 영어 오류로 끝난다 — action=exhaust + 영문 reason(한국어 아님)', () => {
    const verdict = decideProviderFallback({
      err: quotaExhausted429(),
      failedProvider: 'grok',
      remainingProviders: [],
      attempted: [priorAttempt('openai-codex')],
    });
    expect(verdict.action).toBe('exhaust');
    const reason: string = (verdict as { reason: unknown }).reason as string;
    expect(typeof reason).toBe('string');
    expect(reason.length).toBeGreaterThan(0); // 출처: #135034 — reason 길이 하한(빈 문자열 아님)
    // ⛔ 영어 오류 —(/[가-힣]/ 없음). 사람이 다른 자리(런·PR)에서 이 오류를 읽을 때 공급자 폴백 종단임을
    //   영문 그대로 알 수 있어야 한다(OP #135034 «전부 소진 = 영어 오류»).
    expect(reason).not.toMatch(/[가-힣]/);
    // 종단 포장 오류(ProviderFallbackError)도 영문 reason 을 그대로 싣는다(llm.ts L9905 throw 경로).
    if (verdict.action === 'advance') throw new Error('expected a terminal verdict');
    const wrapped = new ProviderFallbackError(verdict, quotaExhausted429());
    expect(wrapped.message).not.toMatch(/[가-힣]/);
  });
});
