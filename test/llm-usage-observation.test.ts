import { describe, expect, it, spyOn } from 'bun:test';
import { debug } from '../src/debug/log.js';
import { logAgentTurnUsage, streamLLM, streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from '../src/llm.js';

// 주 에이전트 턴(streamLLMWithTools)의 사용량이 `debug.enabled` 와 무관하게 `llm.usage` 로 남는가.
// 2026-09-24 실측: 이 줄이 없어 3시간 `llm.usage` 18행이 전부 곁가지 두 자리였다.

function provider(model: string, events: LLMStreamEvent[]): LLMProvider {
  return {
    name: 'probe-provider',
    defaultModel: model,
    available: () => true,
    async *streamChat() {
      yield* events;
    },
    async *chat() {
      for (const event of events) if (event.type === 'text') yield event.delta;
    },
  };
}

async function usageRows(model: string): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  // 전제: 시험 환경은 debug 가 꺼져 있다 — 그래야 「게이트 없이 남긴다」를 잰다(기존 `chat.cache.turn` 은 이 게이트에 막힌다).
  expect(debug.enabled).toBe(false);
  const logSpy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'llm.usage' && event === 'llm-usage') rows.push((data ?? {}) as Record<string, unknown>);
  });
  try {
    await streamLLMWithTools(
      [{ role: 'user', content: 'measure this turn' }],
      { onText: () => {}, dispatchTool: async () => ({}) },
      {
        provider: provider(model, [
          { type: 'usage', usage: { inputTokens: 1200, outputTokens: 300 } },
          { type: 'text', delta: 'done' },
        ]),
        model,
        tools: [{ name: 'probe', description: 'keeps the tool loop active', parameters: {} }],
        maxTurns: 1,
      },
    );
  } finally {
    logSpy.mockRestore();
  }
  return rows;
}

describe('agent-turn usage observation', () => {
  it('preserves the default site and omits role for legacy provider-name and omitted arguments', () => {
    const rows: Array<Record<string, unknown>> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'llm.usage' && event === 'llm-usage') rows.push((data ?? {}) as Record<string, unknown>);
    });
    try {
      logAgentTurnUsage('no-such-model-for-pricing', { inputTokens: 7 }, 'probe-provider');
      logAgentTurnUsage('no-such-model-for-pricing', { outputTokens: 3 });
      logAgentTurnUsage('no-such-model-for-pricing', { inputTokens: 2 }, { providerName: 'probe-provider' });
    } finally {
      logSpy.mockRestore();
    }
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.site).toBe('agent-turn');
      expect(row).not.toHaveProperty('role');
    }
    expect(rows[0]).toMatchObject({ inputTokens: 7, billingProvider: 'probe-provider' });
    expect(rows[1]).toMatchObject({ outputTokens: 3 });
    expect(rows[1]).not.toHaveProperty('billingProvider');
    expect(rows[2]).toMatchObject({ inputTokens: 2, billingProvider: 'probe-provider' });
  });

  it('uses optional site and role metadata without changing the usage or billing fields', () => {
    const rows: Array<Record<string, unknown>> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'llm.usage' && event === 'llm-usage') rows.push((data ?? {}) as Record<string, unknown>);
    });
    try {
      const usage = { inputTokens: 11, outputTokens: 4, cacheReadInputTokens: 2 };
      logAgentTurnUsage('no-such-model-for-pricing', usage, { providerName: 'probe-provider', site: 'stream-llm', role: 'classify' });
      logAgentTurnUsage('no-such-model-for-pricing', usage, { role: 'review' });
      logAgentTurnUsage('no-such-model-for-pricing', usage, { site: 'stream-llm' });
    } finally {
      logSpy.mockRestore();
    }
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ site: 'stream-llm', role: 'classify', inputTokens: 11, outputTokens: 4, cacheReadInputTokens: 2, billingProvider: 'probe-provider' });
    expect(rows[1]).toMatchObject({ site: 'agent-turn', role: 'review', inputTokens: 11, outputTokens: 4, cacheReadInputTokens: 2 });
    expect(rows[2]).toMatchObject({ site: 'stream-llm', inputTokens: 11, outputTokens: 4, cacheReadInputTokens: 2 });
    expect(rows[2]).not.toHaveProperty('role');
  });

  it('records one llm.usage row per usage event with the turn model and a cost, even with debug disabled', async () => {
    const rows = await usageRows('gpt-6-sol');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ site: 'agent-turn', model: 'gpt-6-sol', inputTokens: 1200, outputTokens: 300 });
    expect(rows[0]!.cost).toMatchObject({ kind: 'known' });
    expect(rows[0]).not.toHaveProperty('cacheReadInputTokens');
    expect(rows[0]).not.toHaveProperty('role');
  });

  it('marks an unpriced model as unknown instead of folding it to zero dollars', async () => {
    const rows = await usageRows('no-such-model-for-pricing');
    expect(rows).toHaveLength(1);
    expect((rows[0]!.cost as { kind: string }).kind).toBe('unknown');
    expect(rows[0]!.cost).not.toHaveProperty('usd');
  });

  it('forwards the role on the active tool-loop path without changing its site', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'llm.usage' && event === 'llm-usage') rows.push((data ?? {}) as Record<string, unknown>);
    });
    try {
      expect(await streamLLMWithTools(
        [{ role: 'user', content: 'classify' }],
        { onText: () => {}, dispatchTool: async () => ({}) },
        {
          provider: provider('gpt-6-sol', [{ type: 'usage', usage: { inputTokens: 9 } }, { type: 'text', delta: 'yes' }]),
          usageRole: 'classify',
          tools: [{ name: 'probe', description: 'keeps the tool loop active', parameters: {} }],
          maxTurns: 1,
        },
      )).toBe('yes');
    } finally {
      logSpy.mockRestore();
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ site: 'agent-turn', role: 'classify', inputTokens: 9 });
  });
});

describe('streamLLM usage observation', () => {
  it('records one aggregated row with site, role and the resolved model; preserves router.done', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const done: Array<Record<string, unknown>> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'llm.usage' && event === 'llm-usage') rows.push((data ?? {}) as Record<string, unknown>);
      if (category === 'llm.router.done') done.push((data ?? {}) as Record<string, unknown>);
    });
    try {
      const full = await streamLLM([{ role: 'user', content: 'measure' }], () => {}, {
        provider: provider('gpt-6-sol', [
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
          { type: 'text', delta: 'done' },
          { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } },
        ]),
        usageRole: 'classify',
      });
      expect(full).toBe('done');
    } finally {
      logSpy.mockRestore();
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ site: 'stream-llm', role: 'classify', model: 'gpt-6-sol', inputTokens: 13, outputTokens: 3 });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ textChars: 4, usage: { inputTokens: 13, outputTokens: 3 } });
  });

  it('does not record unmeasured or failed streams', async () => {
    const rows: unknown[] = [];
    const logSpy = spyOn(debug, 'log').mockImplementation((category) => {
      if (category === 'llm.usage') rows.push(category);
    });
    try {
      expect(await streamLLM([{ role: 'user', content: 'plain' }], () => {}, {
        provider: provider('gpt-6-sol', [{ type: 'text', delta: 'plain' }]),
      })).toBe('plain');
      const failing: LLMProvider = {
        ...provider('gpt-6-sol', []),
        async *streamChat() {
          yield { type: 'usage', usage: { inputTokens: 8 } } as LLMStreamEvent;
          throw new Error('provider failed');
        },
      };
      await expect(streamLLM([{ role: 'user', content: 'fail' }], () => {}, { provider: failing })).rejects.toThrow('provider failed');
    } finally {
      logSpy.mockRestore();
    }
    expect(rows).toHaveLength(0);
  });

  it('keeps successful text and router.done when usage observation throws', async () => {
    const done: unknown[] = [];
    const logSpy = spyOn(debug, 'log').mockImplementation((category) => {
      if (category === 'llm.usage') throw new Error('observer failed');
      if (category === 'llm.router.done') done.push(category);
    });
    try {
      expect(await streamLLM([{ role: 'user', content: 'measure' }], () => {}, {
        provider: provider('gpt-6-sol', [{ type: 'usage', usage: { inputTokens: 8 } }, { type: 'text', delta: 'ok' }]),
      })).toBe('ok');
    } finally {
      logSpy.mockRestore();
    }
    expect(done).toHaveLength(1);
  });

  it('passes usageRole through the no-tools fallback exactly once', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'llm.usage' && event === 'llm-usage') rows.push((data ?? {}) as Record<string, unknown>);
    });
    try {
      expect(await streamLLMWithTools(
        [{ role: 'user', content: 'classify' }],
        { onText: () => {}, dispatchTool: async () => ({}) },
        { provider: provider('gpt-6-sol', [{ type: 'usage', usage: { inputTokens: 9 } }, { type: 'text', delta: 'yes' }]), usageRole: 'classify' },
      )).toBe('yes');
    } finally {
      logSpy.mockRestore();
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ site: 'stream-llm', role: 'classify', inputTokens: 9 });
  });
});
