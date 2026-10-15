import { describe, expect, test } from 'bun:test';
import { tierModel } from '../src/llm/model-defaults';
import { currentRouteDecision, formatRouteDecisionSummary, recordCurrentRouteDecision, resolveRouteDecision, sessionModelPin, setSessionModelPin } from '../src/llm/route-decision.js';

describe('RouteDecision R0 read-model', () => {
  test('explicit pin always wins over Codex policy', () => {
    const d = resolveRouteDecision({ provider: 'openai-codex', configuredModel: 'gpt-5.6-sol', explicitModel: 'gpt-5.6-luna', text: '아키텍처 계획 세워줘' });
    expect(d).toMatchObject({ model: 'gpt-5.6-luna', source: 'explicit-pin' });
  });

  // ⛔ 2026-09-23 — 종전엔 `gpt-5.6-terra`/`gpt-5.6-sol` 을 «박았다». 이 시험이 지키려던 계약은
  //   「어느 모델인가」가 아니라 ***「비-deep 은 better 티어 · deep 은 best 티어」***다.
  //   ⇒ 사다리에서 파생시킨다(`route-decision.ts` 머리말과 같은 규율).
  test('Codex build takes the «better» (coding) tier while deep plan takes «best»', () => {
    const routePolicy = { mode: 'codex-first' as const, opusEscalation: 'evidence-hitl' as const };
    const CODING = tierModel('better', 'openai-codex');
    const DEEP = tierModel('best', 'openai-codex');
    expect(resolveRouteDecision({ provider: 'openai-codex', configuredModel: 'gpt-5.6-sol', text: '함수 구현하고 테스트해줘', routePolicy }))
      .toMatchObject({ model: CODING, source: 'codex-tier-policy' });
    expect(resolveRouteDecision({ provider: 'openai-codex', configuredModel: 'gpt-5.6-terra', text: '아키텍처 설계를 깊게 계획해줘', routePolicy }))
      .toMatchObject({ model: DEEP, source: 'codex-tier-policy' });
  });

  // ⛔ 위 시험이 «같은 두 값»으로도 통과하지 않게 — effort 가 갈리는지 본다.
  test('두 레인은 «추론 강도»로 갈린다 (모델이 같아도 계약은 살아 있어야 한다)', () => {
    const routePolicy = { mode: 'codex-first' as const, opusEscalation: 'evidence-hitl' as const };
    const build = resolveRouteDecision({ provider: 'openai-codex', configuredModel: 'x', text: '함수 구현하고 테스트해줘', routePolicy });
    const plan = resolveRouteDecision({ provider: 'openai-codex', configuredModel: 'x', text: '아키텍처 설계를 깊게 계획해줘', routePolicy });
    expect(build.effort).toBeDefined();
    expect(plan.effort).toBeDefined();
    expect(build.effort).not.toBe(plan.effort);
  });

  test('absent policy keeps compatibility but exposes legacy-default; active-provider disables tier override', () => {
    expect(resolveRouteDecision({ provider: 'openai-codex', configuredModel: 'gpt-5.6-sol', text: '구현해줘' }).source).toBe('legacy-default');
    expect(resolveRouteDecision({ provider: 'openai-codex', configuredModel: 'gpt-5.6-sol', text: '구현해줘', routePolicy: { mode: 'active-provider' } })).toMatchObject({ model: 'gpt-5.6-sol', source: 'active-provider-default' });
  });

  test('non-Codex active provider is not replaced by legacy mission defaults', () => {
    const d = resolveRouteDecision({ provider: 'anthropic', configuredModel: 'claude-sonnet-4-6', text: '구현해줘' });
    expect(d).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6', source: 'active-provider-default' });
  });

  test('essential surfaces can retain and render the actual current decision', () => {
    const decision = resolveRouteDecision({
      provider: 'openai-codex', configuredModel: 'gpt-5.6-sol', text: '테스트를 추가해줘',
      routePolicy: { mode: 'codex-first' },
    });
    recordCurrentRouteDecision('test-essential', decision);
    expect(currentRouteDecision('test-essential')).toEqual(decision);
    // ⛔ 렌더 문면에 모델 이름을 «박지 않는다» — 결정이 실제로 고른 값을 그대로 댄다.
    //   (이 줄이 `gpt-5.6-terra` 를 박고 있어서 사다리가 의도대로 움직이자 빨개졌다.)
    const summary = formatRouteDecisionSummary(decision);
    expect(summary).toContain(`${decision.provider}/${decision.model}`);
    expect(summary).toContain('codex-tier-policy');
    // 렌더가 «모델만» 내고 강도를 잃지 않는지 — 두 레인이 모델을 공유할 수 있으므로 중요하다.
    if (decision.effort) expect(summary).toContain(decision.effort);
  });
});

describe('TUI-MODEL-SESSION-SCOPE — session model pin', () => {
  test('a pin sent as explicitModel beats the codex tier policy (the 10-14 OPT failure)', () => {
    const luna = tierModel('budget', 'openai-codex');
    // 전제: 핀 없이는 configuredModel=luna 여도 정책이 무시한다.
    const unpinned = resolveRouteDecision({ provider: 'openai-codex', configuredModel: luna, text: '이 설계를 계획해줘' });
    expect(unpinned.source).toBe('legacy-default');
    expect(unpinned.model).not.toBe(luna);

    setSessionModelPin('test-pin', { provider: 'openai-codex', model: luna });
    const pin = sessionModelPin('test-pin', 'openai-codex');
    const pinned = resolveRouteDecision({ provider: 'openai-codex', configuredModel: luna, text: '이 설계를 계획해줘', ...(pin ? { explicitModel: pin.model } : {}) });
    expect(pinned).toMatchObject({ model: luna, source: 'explicit-pin' });
    setSessionModelPin('test-pin', null);
    expect(sessionModelPin('test-pin')).toBeNull();
  });

  test('a pin chosen under another provider is not applied', () => {
    setSessionModelPin('test-pin-2', { provider: 'openai-codex', model: 'gpt-6-luna' });
    expect(sessionModelPin('test-pin-2', 'anthropic')).toBeNull();
    expect(sessionModelPin('test-pin-2', 'openai-codex')).toEqual({ provider: 'openai-codex', model: 'gpt-6-luna' });
    setSessionModelPin('test-pin-2', null);
  });
});
