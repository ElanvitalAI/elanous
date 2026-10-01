// agent-loop-substrate 조각2 — context 전략 검증 (2026-07-19)
import { test, expect, describe } from 'bun:test';
import { createDefaultContextStrategy, type ContextStrategy } from './context-strategy.js';
import { shouldAutoCompact } from '../compact/auto.js';
import type { LLMMessage } from '../llm.js';

describe('context-strategy (조각2·pluggable context 전략)', () => {
  test('임계 미달(작은 history)이면 fired=false·원본 그대로(무비용)', async () => {
    const strat = createDefaultContextStrategy();
    const msgs: LLMMessage[] = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }];
    const r = await strat.compact(msgs, { model: 'gpt-5.6-terra', config: { enabled: true, triggerRatio: 0.85, preserveLastN: 4 } });
    expect(r.fired).toBe(false);
    expect(r.reduced).toBe(false);
    expect(r.messages).toBe(msgs);     // 원본 참조 그대로(splice 안 함)
  });

  test('계약 필드 완비(fired/messages/reduced/escalated/ratio/usedTokens/beforeTokens/afterTokens)', async () => {
    const strat = createDefaultContextStrategy();
    const r = await strat.compact([{ role: 'user', content: 'x' }], { model: 'gpt-5.6-terra', config: { enabled: true, triggerRatio: 0.85, preserveLastN: 4 } });
    expect(typeof r.fired).toBe('boolean');
    expect(Array.isArray(r.messages)).toBe(true);
    expect(typeof r.reduced).toBe('boolean');
    expect(typeof r.escalated).toBe('boolean');
    expect(typeof r.ratio).toBe('number');
    expect(typeof r.usedTokens).toBe('number');
    expect(typeof r.beforeTokens).toBe('number');
    expect(typeof r.afterTokens).toBe('number');
  });

  test('reduced 는 개수 아닌 토큰 감소로 판정 — 내용만 줄어도(개수 동일) reduced=true', async () => {
    // ★ no-reduce 오판 회귀 가드 — L1/L2/L5 는 tool_result **내용**을 잘라 개수는 유지.
    //   과거 개수 판정이면 reduced=false(오판) → breaker failure 누적. 토큰 판정이어야 true.
    const strat = createDefaultContextStrategy();
    // 큰 tool_result 로 임계를 넘겨 압축이 발동하게(개수는 그대로, 내용만 축소되는 경로).
    // huge 는 preserveLastN(기본 6) 밖(앞쪽)에 둬야 L1(tool-output-budget)이 잘라낸다.
    const huge = 'x'.repeat(600_000); // ~150K estimated tokens; 128K working budget fires independently of the model catalog window.
    const msgs: LLMMessage[] = [
      { role: 'user', content: 'task anchor' },
      { role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1', content: huge }] },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'tail-a' },
      { role: 'assistant', content: 'tail-b' },
    ];
    const config = { enabled: true, triggerRatio: 0.85, preserveLastN: 4, preserveFirstN: 1, partial: false, workingBudgetTokens: 128_000 };
    expect(shouldAutoCompact(msgs, 'gpt-5.6-terra', config).reason).toBe('threshold-exceeded');
    const r = await strat.compact(msgs, { model: 'gpt-5.6-terra', config });
    expect(r.fired).toBe(true);
    expect(r.afterTokens).toBeLessThan(r.beforeTokens); // 실제 크기 감소
    expect(r.reduced).toBe(true);                        // 개수 동일해도 토큰 감소면 reduced
    expect(r.messages.length).toBe(msgs.length);          // ★ 개수는 그대로(내용만 축소) — 오판 회귀 가드
  });

  test('주입 가능 — 커스텀 전략(read-time projection 등)으로 교체', async () => {
    // substrate 계약을 만족하는 커스텀 전략 주입 가능성 검증(loop/orchestrator 가 다른 전략 소비).
    const custom: ContextStrategy = {
      async compact(messages) {
        return { fired: true, messages: messages.slice(-1), reduced: messages.length > 1, escalated: false, ratio: 0.9, usedTokens: 999, beforeTokens: 999, afterTokens: 1 };
      },
    };
    const r = await custom.compact([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], { model: 'm', config: {} });
    expect(r.fired).toBe(true);
    expect(r.reduced).toBe(true);
    expect(r.messages.length).toBe(1);    // 마지막 1개 view(projection)
  });
});
