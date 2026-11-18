// OP-LONG-SESSION-COMPACT (O4 PR2) — an open mid-loop compaction breaker gets one more try once history has grown.
// Live 11-18: 106 runs opened the breaker at p50 ≈ 25k tokens, then skipped compaction for 19 (p50) – 159 more rounds.
// Real streamLLMWithTools · fake provider (one tool call per round, each result adds history) · injected context strategy.
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as llm from '../llm.js';
import type { LLMMessage, LLMProvider } from '../llm.js';
import * as config from '../user-config.js';
import { debug } from '../debug/log.js';
import { estimateMessagesTokens } from '../tokens.js';
import { COMPACT_REARM_GROWTH, shouldRearmCompaction, type CompactionOutcome, type ContextStrategy } from './context-strategy.js';

afterEach(() => { mock.restore(); });

describe('shouldRearmCompaction', () => {
  test('one more try only after history grew by the growth factor since the breaker opened', () => {
    expect(COMPACT_REARM_GROWTH).toBe(1.25);
    expect(shouldRearmCompaction(24_801, 24_801)).toBe(false);
    expect(shouldRearmCompaction(24_801, 31_000)).toBe(false);
    expect(shouldRearmCompaction(24_801, 31_002)).toBe(true);
    expect(shouldRearmCompaction(0, 99_999)).toBe(false);
  });
});

describe('streamLLMWithTools — an open compaction breaker re-arms as the turn grows', () => {
  test('three no-reduce rounds open the breaker; after 25% growth the strategy runs again (rearm logged), not skipped forever', async () => {
    const base = config.getUserConfig();
    spyOn(config, 'getUserConfig').mockReturnValue({
      ...base, chat: { ...base.chat, autoCompact: { enabled: true, triggerRatio: 0.85, preserveLastN: 4, partial: false } },
    } as ReturnType<typeof config.getUserConfig>);
    const events: string[] = [];
    const original = debug.log.bind(debug);
    spyOn(debug, 'log').mockImplementation((category, event, data, options) => {
      if (category === 'llm.router' && String(event).startsWith('tool-loop.midloop-compact')) events.push(String(event));
      else original(category, event, data, options);
    });
    const strategyCalls: number[] = [];
    const strategy: ContextStrategy = {
      async compact(messages: LLMMessage[]): Promise<CompactionOutcome> {
        const tokens = estimateMessagesTokens(messages);
        strategyCalls.push(tokens);
        // fired but nothing to remove — the live no-reduce shape
        return { fired: true, messages, reduced: false, escalated: false, ratio: 0.9, usedTokens: tokens, beforeTokens: tokens, afterTokens: tokens };
      },
    };
    let round = 0;
    const ROUNDS = 12;
    const provider: LLMProvider = {
      name: 'o4-rearm', defaultModel: 'o4-model', available: () => true,
      async *chat() { yield 'ok'; },
      async *streamChat() {
        round += 1;
        if (round <= ROUNDS) yield { type: 'tool_call' as const, id: `t${round}`, name: 'O4Step', args: {} };
        else yield { type: 'text' as const, delta: 'done' };
      },
    } as unknown as LLMProvider;
    // each tool result adds ~2k tokens, so history grows past 1.25× the opening size within a few rounds
    const out = await llm.streamLLMWithTools([{ role: 'user', content: 'long task' }],
      { onText() {}, dispatchTool: async () => 'line '.repeat(1_600) },
      { provider, contextStrategy: strategy, tools: [{ name: 'O4Step', description: 'one work step', parameters: { type: 'object', properties: {} } }] });
    expect(out).toBe('done');
    const opened = events.indexOf('tool-loop.midloop-compact.breaker-open');
    // 출처: #38604 — the breaker opens after its threshold of 3 no-reduce rounds (llm.ts compactBreaker)
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(events).toContain('tool-loop.midloop-compact.breaker-rearm');
    expect(events.indexOf('tool-loop.midloop-compact.breaker-rearm')).toBeGreaterThan(opened);
    // half-open: after each re-arm exactly ONE more try, then the breaker is open again (no 3-try burst of L3 cost)
    const afterRearm = events.slice(events.indexOf('tool-loop.midloop-compact.breaker-rearm') + 1);
    expect(afterRearm.slice(0, 2)).toEqual(['tool-loop.midloop-compact.no-reduce', 'tool-loop.midloop-compact.breaker-open']);
    // 출처: #38604 — 3 calls before the breaker opened; any more means compaction ran again after it
    expect(strategyCalls.length).toBeGreaterThan(3);
  });

  test('JUD #38659 ⓑ — a half-open try that THROWS still leaves the breaker re-armable as history keeps growing', async () => {
    const base = config.getUserConfig();
    spyOn(config, 'getUserConfig').mockReturnValue({
      ...base, chat: { ...base.chat, autoCompact: { enabled: true, triggerRatio: 0.85, preserveLastN: 4, partial: false } },
    } as ReturnType<typeof config.getUserConfig>);
    const events: string[] = [];
    const original = debug.log.bind(debug);
    spyOn(debug, 'log').mockImplementation((category, event, data, options) => {
      if (category === 'llm.router' && String(event).startsWith('tool-loop.midloop-compact')) events.push(String(event));
      else original(category, event, data, options);
    });
    let calls = 0;
    const strategy: ContextStrategy = {
      async compact(messages: LLMMessage[]): Promise<CompactionOutcome> {
        calls += 1;
        // 출처: #38659 — the 4th call is the first half-open try (3 no-reduce calls open the breaker)
        if (calls === 4) throw new Error('summarizer down');
        const tokens = estimateMessagesTokens(messages);
        return { fired: true, messages, reduced: false, escalated: false, ratio: 0.9, usedTokens: tokens, beforeTokens: tokens, afterTokens: tokens };
      },
    };
    let round = 0;
    const provider: LLMProvider = {
      name: 'o4-rearm-error', defaultModel: 'o4-model', available: () => true,
      async *chat() { yield 'ok'; },
      async *streamChat() {
        round += 1;
        // 출처: #38659 — enough rounds for history to grow 1.25× twice after the error
        if (round <= 16) yield { type: 'tool_call' as const, id: `t${round}`, name: 'O4Step', args: {} };
        else yield { type: 'text' as const, delta: 'done' };
      },
    } as unknown as LLMProvider;
    await llm.streamLLMWithTools([{ role: 'user', content: 'long task' }],
      { onText() {}, dispatchTool: async () => 'line '.repeat(1_600) },
      { provider, contextStrategy: strategy, tools: [{ name: 'O4Step', description: 'one work step', parameters: { type: 'object', properties: {} } }] });
    const afterError = events.slice(events.indexOf('tool-loop.midloop-compact.error') + 1);
    expect(events).toContain('tool-loop.midloop-compact.error');
    expect(afterError).toContain('tool-loop.midloop-compact.breaker-rearm');
    // 출처: #38659 — compaction ran again after the throwing half-open try (calls beyond the 4th)
    expect(calls).toBeGreaterThan(4);
  });
});
