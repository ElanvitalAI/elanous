import { afterEach, describe, expect, test } from 'bun:test';
import { estimateMessagesTokens, estimateTokens } from '../src/tokens.js';
import { shouldAutoCompact } from '../src/compact/auto.js';
import { createDefaultContextStrategy } from '../src/agent-substrate/context-strategy.js';
import { streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from '../src/llm.js';
import { setUserConfigOverlay } from '../src/user-config.js';
import { debug } from '../src/debug/log.js';

afterEach(() => setUserConfigOverlay(null));

describe('TUI token estimator wire payload', () => {
  test('counts array-shaped tool_result and large tool_use arguments by serialized size', () => {
    const resultText = 'tool output '.repeat(2_000);
    const argsText = 'large argument '.repeat(1_000);
    const result = estimateMessagesTokens([{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: resultText }] }],
    }]);
    const args = estimateMessagesTokens([{
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-2', name: 'search', input: { query: argsText } }],
    }]);

    expect(result).toBeGreaterThan(estimateTokens(resultText));
    expect(result).toBeGreaterThan(5_000);
    expect(args).toBeGreaterThan(3_000);
  });

  test('counts Codex reasoning items replayed outside visible message content', () => {
    const reasoning = [{ type: 'reasoning', encrypted_content: 'a'.repeat(20_000), summary: [] }];
    const total = estimateMessagesTokens([{
      role: 'assistant', content: 'short', codexReasoningItems: reasoning,
    }]);
    expect(total).toBeGreaterThan(4_000);
  });

  test('cyclic extension payloads receive a conservative floor instead of zero', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const total = estimateMessagesTokens([{
      role: 'assistant', content: [{ type: 'tool_use', id: 'cycle', input: cyclic }],
    }]);
    expect(total).toBeGreaterThanOrEqual(200);
  });

  test('small structured tool blocks keep the prior 200-token floor', () => {
    const blocks = Array.from({ length: 100 }, (_, index) => ({
      type: 'tool_use', id: `tool-${index}`, name: 'x', input: {},
    }));
    const total = estimateMessagesTokens([{ role: 'assistant', content: blocks }]);
    expect(total).toBeGreaterThanOrEqual(20_000);
  });

  test('uses the previous provider input usage to fire auto-compaction', () => {
    const config = { enabled: true, triggerRatio: 0.8, preserveLastN: 4, partial: false } as any;
    const decision = shouldAutoCompact([{ role: 'user', content: 'short' }], 'gpt-5', config, 110_000);

    expect(decision.fire).toBe(true);
    expect(decision.reason).toBe('threshold-exceeded');
    expect(decision.usedTokens).toBe(110_000);
  });

  test('passes provider usage, including cache tokens, into the next mid-loop decision', async () => {
    setUserConfigOverlay((config) => ({
      ...config,
      chat: { ...config.chat, autoCompact: { ...config.chat.autoCompact, enabled: true, triggerRatio: 0.8 } },
    }));
    const turns: LLMStreamEvent[][] = [
      [
        { type: 'codex_reasoning_item', item: { type: 'reasoning', encrypted_content: 'r'.repeat(20_000), summary: [] } },
        { type: 'usage', usage: { inputTokens: 500, cacheReadInputTokens: 100_000, cacheCreationInputTokens: 1_000 } },
        { type: 'tool_call', id: 'tool-1', name: 'inspect', args: {} },
      ],
      [{ type: 'text', delta: 'done' }],
    ];
    let turn = 0;
    const provider: LLMProvider = {
      name: 'usage-fixture', defaultModel: 'gpt-5', available: () => true,
      async *streamChat() { yield* turns[turn++] ?? []; },
      async *chat() {},
    };
    let observed: number | undefined;
    let historyHasProducedReasoning = false;
    let estimatedHistoryTokens = 0;
    const events: Array<{ category: string; event: string; data?: unknown }> = [];
    const priorLog = debug.log;
    debug.log = ((category: string, event: string, data?: unknown) => {
      events.push({ category, event, data });
    }) as typeof debug.log;
    const contextStrategy = {
      async compact(messages: any[], ctx: { model: string; sessionId?: string; config: unknown; observedInputTokens?: number }) {
        observed = ctx.observedInputTokens;
        historyHasProducedReasoning = messages.some((message) => message.codexReasoningItems?.length > 0);
        estimatedHistoryTokens = estimateMessagesTokens(messages);
        const tokens = estimateMessagesTokens(messages);
        return { fired: false, messages, reduced: false, escalated: false, ratio: 0, usedTokens: tokens, beforeTokens: tokens, afterTokens: tokens };
      },
    };
    try {
      await streamLLMWithTools(
        [{ role: 'user', content: 'compact after one tool' }],
        { onText() {}, dispatchTool: async () => 'ok' },
        { provider, model: 'gpt-5', tools: [{ name: 'inspect', description: '', parameters: { type: 'object' } }], contextStrategy },
      );
    } finally {
      debug.log = priorLog;
    }

    expect(turn).toBe(2);
    expect(observed).toBeGreaterThan(101_500);
    expect(historyHasProducedReasoning).toBe(true);
    expect(estimatedHistoryTokens).toBeGreaterThan(4_000);
    expect(events.some((event) => event.category === 'llm.usage' && event.event === 'llm-usage')).toBe(true);
  });

  test('large array-shaped tool results fire the compaction threshold', () => {
    const payload = 'tool payload '.repeat(35_000);
    const messages = [{
      role: 'assistant',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: payload }] }],
    }] as any;
    const config = { enabled: true, triggerRatio: 0.85, preserveLastN: 4, partial: false, workingBudgetTokens: 128_000 } as any;
    const decision = shouldAutoCompact(messages, 'gpt-5', config);

    expect(decision.fire).toBe(true);
    expect(decision.usedTokens).toBeGreaterThan(100_000);
  });

  test('large string tool results compact and reduce without LLM escalation', async () => {
    const payload = 'tool payload '.repeat(35_000);
    const messages = [
      { role: 'user', content: 'task anchor' },
      { role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1', content: payload }] },
      { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: 'continue' },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: 'more' },
      { role: 'user', content: 'tail-a' },
      { role: 'assistant', content: 'tail-b' },
    ] as any;
    const strategy = createDefaultContextStrategy();
    const config = { enabled: true, triggerRatio: 0.85, preserveLastN: 4, preserveFirstN: 1, partial: false, workingBudgetTokens: 128_000 };
    const result = await strategy.compact(messages, { model: 'gpt-5', config });

    expect(result.fired).toBe(true);
    expect(result.reduced).toBe(true);
    expect(result.escalated).toBe(false);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  }, 20_000);
});
