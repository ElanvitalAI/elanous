// OP-LONG-SESSION-COMPACT (O4) — the L3 re-check counts the same non-history overhead as the first decision.
// Live 24h (11-18): 1972 midloop no-reduce rows, every one escalated=false; the breaker opened at p50 ≈ 25k tokens and the
// turn went on 19–159 more rounds with no compaction. Shape reproduced: 32k window · triggerRatio 0.85 (≈27.2k) · history
// estimated ≈16k · provider-observed input 30k (system prompt + tool schemas the compactor cannot remove).
import { describe, expect, test } from 'bun:test';
import type { LLMMessage } from '../llm.js';
import { estimateMessagesTokens } from '../tokens.js';
import { createDefaultContextStrategy } from './context-strategy.js';

const MODEL = 'local:o4-fixture'; // family table → 32k window, independent of the catalog
const CONFIG = { enabled: true, triggerRatio: 0.85, preserveLastN: 4, preserveFirstN: 1, partial: false };

function history(): LLMMessage[] {
  const rows: LLMMessage[] = [{ role: 'user', content: 'task anchor: finish C3 and report to TC' }];
  for (let i = 0; i < 16; i += 1) {
    rows.push({ role: 'user', content: `step ${i} ${'detail '.repeat(480)}` });
    rows.push({ role: 'assistant', content: `done ${i} ${'note '.repeat(480)}` });
  }
  return rows;
}

function fakes() {
  const calls: string[] = [];
  const summary: LLMMessage = { role: 'user', content: '[summary] steps 0–13 done; open: finish C3, report to TC' };
  return {
    calls,
    deps: {
      // cheap pass: nothing to trim (no tool output) — same messages back
      runCompactPipeline: (async (messages: LLMMessage[], opts: { provider?: unknown }) => {
        calls.push(opts.provider ? 'deep' : 'cheap');
        return { messages: opts.provider ? [messages[0]!, summary, ...messages.slice(-4)] : messages };
      }) as never,
      getDefaultCompactProvider: (() => ({ summarize: async () => null })) as never,
    },
  };
}

describe('O4 — mid-loop compaction escalates when the provider-observed input is over the trigger', () => {
  test('history alone is under the trigger, observed input is over it: the cheap pass cannot help, L3 runs and reduces', async () => {
    const msgs = history();
    const estimated = estimateMessagesTokens(msgs);
    // 출처: #38156 — trigger = triggerRatio 0.85 × the 32k family window = 27_200 (history alone stays under it)
    expect(estimated).toBeLessThan(27_200);
    const { calls, deps } = fakes();
    const r = await createDefaultContextStrategy(deps).compact(msgs, { model: MODEL, config: CONFIG, observedInputTokens: 30_000 });
    expect(calls).toEqual(['cheap', 'deep']);
    expect(r.fired).toBe(true);
    expect(r.escalated).toBe(true);
    expect(r.reduced).toBe(true);
    expect(r.messages[0]).toEqual(msgs[0]!); // the anchor stays first
  });

  test('without observed usage the decision is the estimate alone: under the trigger, nothing fires (no LLM cost)', async () => {
    const { calls, deps } = fakes();
    const r = await createDefaultContextStrategy(deps).compact(history(), { model: MODEL, config: CONFIG });
    expect(r.fired).toBe(false);
    expect(calls).toEqual([]);
  });

  test('observed input under the trigger: no fire, no escalation', async () => {
    const { calls, deps } = fakes();
    const r = await createDefaultContextStrategy(deps).compact(history(), { model: MODEL, config: CONFIG, observedInputTokens: 20_000 });
    expect(r.fired).toBe(false);
    expect(calls).toEqual([]);
  });
});
