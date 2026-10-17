// Doom-loop self-heal — unit tests (대표 10-17: doom-loop is not a user-facing
// notice, so the loop never asks; TUI-DOOM-ASK-TIMEOUT-STALE-MODAL #79).
//
// Verifies that:
//   - a doom trip never reaches AskUserQuestion (no modal, no resolver call),
//   - the first trip injects «change approach» guidance and the turn goes on,
//   - a second trip in the same turn stops quietly (no `[ASK USER]` text),
//   - every decision lands on `llm.tool-loop.retry doom-loop-self-heal`.

import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { debug } from '../src/debug/log.js';
import { clearSnapshots } from '../src/undo-turn/index.js';
import { undoTurnRuntime } from '../src/tool-runtime/undo-turn-runtime.js';
import {
  setAskUserQuestionDeps,
  setAskUserQuestionResolver,
  _clearQuestionResultListenersForTesting,
} from '../src/ask-user-question/index.js';
import { approvalModalRouter } from '../src/approval-modal.js';
import {
  DOOM_LOOP_SELF_HEAL_STOP_TEXT,
  classifyDoomLoopIntervention,
  decideDoomLoopSelfHeal,
  normalizeDoomLoopInterventionClass,
  streamLLMWithTools,
  type LLMMessage,
  type LLMProvider,
  type LLMStreamEvent,
} from '../src/llm.js';

let askCalls = 0;

afterEach(() => {
  setAskUserQuestionResolver(null);
  setAskUserQuestionDeps(null);
  approvalModalRouter._resetForTesting();
  _clearQuestionResultListenersForTesting();
  debug.clear();
  debug.disable();
});

/** Any AskUser dispatch with a sessionId goes through the resolver first — count it. */
function countAskUser(): void {
  askCalls = 0;
  setAskUserQuestionResolver(async () => {
    askCalls += 1;
    return { answers: { doom_loop_next_step: 'Stop here' } };
  });
}

function scriptedProvider(turns: LLMStreamEvent[][]): { provider: LLMProvider; seen: LLMMessage[][] } {
  let call = 0;
  const seen: LLMMessage[][] = [];
  return {
    seen,
    provider: {
      name: 'scripted', defaultModel: 'd', available: () => true,
      async *streamChat(messages) {
        seen.push(messages.map((m) => ({ ...m })));
        for (const event of turns[call++] ?? []) yield event;
      },
      async *chat() {},
    },
  };
}

const failing = (n: number, args: Record<string, unknown> = { query: 'same' }): LLMStreamEvent[][] =>
  Array.from({ length: n }, (_, i) => [{ type: 'tool_call' as const, id: String(i + 1), name: 'Search', args }]);

const TOOLS = [{ name: 'Search', description: 'd', parameters: { type: 'object' } }];

function selfHealEvents(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.filter((call) => call[0] === 'llm.tool-loop.retry' && call[1] === 'doom-loop-self-heal')
    .map((call) => call[2] as Record<string, unknown>);
}

describe('classifyDoomLoopIntervention', () => {
  test.each([
    ['missing credentials for the provider', 'credentials'],
    ['irreversible external action: publish to production', 'irreversible-external-action'],
    ['consequential product decision cannot be safely inferred because it is high-impact', 'consequential-product-decision'],
    ['no credentials, no irreversible external action, and no consequential product decision', 'credentials'],
    ['credentials are not required; irreversible external action is not required; consequential product decision is not required', 'none'],
    ['empty directory search found no files', 'unknown'],
    ['failed to start subagent', 'unknown'],
    ['API key is valid', 'unknown'],
    ['external action is pending', 'unknown'],
    ['irreversible local cache cleanup', 'unknown'],
    ['opaque tool failure', 'unknown'],
  ] as const)('classifies %s as %s', (detail, expected) => {
    expect(classifyDoomLoopIntervention({ detail, doomWindow: [] })).toBe(expected);
  });

  test('preserves only valid explicit classes and keeps absent evidence unknown', () => {
    expect(normalizeDoomLoopInterventionClass('none')).toBe('none');
    expect(normalizeDoomLoopInterventionClass(undefined)).toBe('unknown');
    expect(normalizeDoomLoopInterventionClass('empty-directory-search-failure')).toBe('unknown');
  });
});

describe('streamLLMWithTools doom-loop self-heal', () => {
  test('first trip: no AskUser · guidance injected · the turn continues', async () => {
    clearSnapshots();
    countAskUser();
    const logSpy = spyOn(debug, 'log');
    const { provider, seen } = scriptedProvider([...failing(3), [{ type: 'text', delta: 'switched approach' }]]);
    try {
      const result = await streamLLMWithTools(
        [{ role: 'user', content: 'inspect the failure' }],
        { onText: () => {}, onToolResult: () => {}, dispatchTool: async () => { throw new Error('repeat failure'); } },
        { provider, model: 'claude-sonnet-5', sessionId: 'sess-heal-1', tools: TOOLS, maxTurns: 6 },
      );
      expect(askCalls).toBe(0);
      expect(approvalModalRouter.current()).toBeNull();
      expect(result).toContain('switched approach');
      expect(result).not.toContain('[ASK USER]');
      const fourth = JSON.stringify(seen[3] ?? []);
      expect(fourth).toContain('Do not call it again with the same arguments');
      const events = selfHealEvents(logSpy);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        tool: 'Search', attempt: 1, action: 'guidance', reason: 'no-undo-available',
        fingerprint: expect.stringContaining('repeat failure'),
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test('second trip in the same turn: quiet stop · no AskUser · no question text', async () => {
    clearSnapshots();
    countAskUser();
    const logSpy = spyOn(debug, 'log');
    const { provider } = scriptedProvider([...failing(6), [{ type: 'text', delta: 'should not be reached' }]]);
    try {
      const result = await streamLLMWithTools(
        [{ role: 'user', content: 'inspect the failure' }],
        { onText: () => {}, onToolResult: () => {}, dispatchTool: async () => { throw new Error('repeat failure'); } },
        { provider, model: 'claude-sonnet-5', sessionId: 'sess-heal-2', tools: TOOLS, maxTurns: 10 },
      );
      expect(askCalls).toBe(0);
      expect(approvalModalRouter.current()).toBeNull();
      expect(result).toContain(DOOM_LOOP_SELF_HEAL_STOP_TEXT);
      expect(result).not.toContain('[ASK USER]');
      expect(result).not.toContain('Reply with how to proceed');
      expect(result).not.toContain('should not be reached');
      expect(selfHealEvents(logSpy).map((e) => [e.attempt, e.action])).toEqual([[1, 'guidance'], [2, 'stop']]);
    } finally {
      logSpy.mockRestore();
    }
  });

  test('without a sessionId the same self-heal path runs (no legacy [ASK USER] text)', async () => {
    clearSnapshots();
    const { provider } = scriptedProvider(failing(6));
    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'inspect the failure' }],
      { onText: () => {}, onToolResult: () => {}, dispatchTool: async () => { throw new Error('repeat failure'); } },
      { provider, model: 'claude-sonnet-5', tools: TOOLS, maxTurns: 10 },
    );
    expect(result).toContain(DOOM_LOOP_SELF_HEAL_STOP_TEXT);
    expect(result).not.toContain('[ASK USER]');
  });

  test.each([
    ['missing credentials for the provider', 'credentials'],
    ['irreversible external action: publish to production', 'irreversible-external-action'],
    ['consequential product decision cannot be safely inferred because it is high-impact', 'consequential-product-decision'],
    ['no credentials, no irreversible external action, and no consequential product decision', 'credentials'],
    ['credentials are not required; irreversible external action is not required; consequential product decision is not required', 'none'],
    ['failed to start subagent', 'unknown'],
  ] as const)('records %s as intervention class %s on the self-heal line', async (detail, interventionClass) => {
    clearSnapshots();
    countAskUser();
    const logSpy = spyOn(debug, 'log');
    const { provider } = scriptedProvider(failing(3, { query: detail }));
    try {
      await streamLLMWithTools(
        [{ role: 'user', content: 'inspect the failure' }],
        { onText: () => {}, onToolResult: () => {}, dispatchTool: async () => { throw new Error(detail); } },
        { provider, model: 'claude-sonnet-5', sessionId: 'sess-doom-live', tools: TOOLS, maxTurns: 5 },
      );
      expect(askCalls).toBe(0);
      expect(selfHealEvents(logSpy)[0]).toMatchObject({ reason: 'no-undo-available', interventionClass, action: 'guidance' });
    } finally {
      logSpy.mockRestore();
    }
  });

  test('survives cyclic BigInt errors when the doom-causing failure is serialized', async () => {
    clearSnapshots();
    const logSpy = spyOn(debug, 'log');
    const { provider } = scriptedProvider(failing(3));
    const cyclic: { message: string; count: bigint; self?: unknown } = {
      message: 'missing credentials for the provider', count: 1n,
    };
    cyclic.self = cyclic;
    try {
      await streamLLMWithTools(
        [{ role: 'user', content: 'inspect failures' }],
        { onText: () => {}, onToolResult: () => {}, dispatchTool: async () => { throw cyclic; } },
        { provider, model: 'claude-sonnet-5', sessionId: 'sess-doom-source', tools: TOOLS, maxTurns: 5 },
      );
      expect(selfHealEvents(logSpy)[0]).toMatchObject({ reason: 'no-undo-available', interventionClass: 'credentials' });
    } finally {
      logSpy.mockRestore();
    }
  });

  test('processes failure and success results in call order within one turn', async () => {
    let attempts = 0;
    const { provider } = scriptedProvider([
      [
        { type: 'tool_call', id: '1', name: 'Search', args: { sequence: 1 } },
        { type: 'tool_call', id: '2', name: 'Search', args: { sequence: 2 } },
        { type: 'tool_call', id: '3', name: 'Search', args: { sequence: 3 } },
      ],
      [{ type: 'tool_call', id: '4', name: 'Search', args: { sequence: 4 } }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'ordered retry sequence' }],
      {
        onText: () => {}, onToolResult: () => {},
        dispatchTool: async () => {
          attempts += 1;
          if (attempts === 2) return 'success';
          throw new Error('intermittent failure');
        },
      },
      { provider, model: 'claude-sonnet-5', tools: TOOLS, maxTurns: 3 },
    );
    expect(debug.events().some((entry) => entry.event === 'doom-loop-detected')).toBe(false);
  });

  test('success at the end of a mixed-result turn clears preceding failures', async () => {
    let attempts = 0;
    const { provider } = scriptedProvider([
      [
        { type: 'tool_call', id: '1', name: 'Search', args: { sequence: 1 } },
        { type: 'tool_call', id: '2', name: 'Search', args: { sequence: 2 } },
      ],
      [{ type: 'tool_call', id: '3', name: 'Search', args: { sequence: 3 } }],
      [{ type: 'tool_call', id: '4', name: 'Search', args: { sequence: 4 } }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'success-separated retry sequence' }],
      {
        onText: () => {}, onToolResult: () => {},
        dispatchTool: async () => {
          attempts += 1;
          if (attempts === 2) return 'success';
          throw new Error('intermittent failure');
        },
      },
      { provider, model: 'claude-sonnet-5', tools: TOOLS, maxTurns: 4 },
    );
    expect(debug.events().some((entry) => entry.event === 'doom-loop-detected')).toBe(false);
  });

  test('logs the detected tool and window before the self-heal decision', async () => {
    clearSnapshots();
    const logSpy = spyOn(debug, 'log');
    const { provider } = scriptedProvider(failing(3, {}));
    try {
      await streamLLMWithTools(
        [{ role: 'user', content: 'detect now' }],
        { onText: () => {}, onToolResult: () => {}, dispatchTool: async () => { throw new Error('repeat failure'); } },
        { provider, model: 'claude-sonnet-5', sessionId: 'sess-detect', tools: TOOLS, maxTurns: 5 },
      );
      const detectionIndex = logSpy.mock.calls.findIndex((call) => call[1] === 'doom-loop-detected');
      const healIndex = logSpy.mock.calls.findIndex((call) => call[1] === 'doom-loop-self-heal');
      expect(detectionIndex).toBeGreaterThanOrEqual(0);
      expect(detectionIndex).toBeLessThan(healIndex);
      expect(logSpy.mock.calls[detectionIndex]?.[2]).toMatchObject({ tool: 'Search', window: expect.any(Array) });
    } finally {
      logSpy.mockRestore();
    }
  });

  test('does not invoke undo when no snapshot is available and records a distinct reason', async () => {
    clearSnapshots();
    debug.clear();
    debug.setLevel('normal');
    const runSpy = spyOn(undoTurnRuntime, 'run');
    const { provider } = scriptedProvider(failing(3, {}));
    try {
      await streamLLMWithTools(
        [{ role: 'user', content: 'no undo target' }],
        { onText: () => {}, onToolResult: () => {}, dispatchTool: async () => { throw new Error('repeat failure'); } },
        { provider, model: 'claude-sonnet-5', sessionId: 'sess-no-undo', tools: TOOLS, maxTurns: 5 },
      );
      expect(runSpy).not.toHaveBeenCalled();
      const event = debug.events().find((entry) => entry.event === 'doom-loop-self-heal');
      expect(event?.data).toMatchObject({ reason: 'no-undo-available' });
    } finally {
      runSpy.mockRestore();
    }
  });
});

describe('decideDoomLoopSelfHeal', () => {
  test('attempt 1 → guidance naming the tool and the failure, no question to the user', () => {
    const r = decideDoomLoopSelfHeal({ attempt: 1, tool: 'Read', fingerprint: 'tool=Read|msg=not found' });
    expect(r.kind).toBe('guidance');
    if (r.kind === 'guidance') {
      expect(r.userMessage).toContain('Read');
      expect(r.userMessage).toContain('tool=Read|msg=not found');
      expect(r.userMessage).toContain('Do not call it again with the same arguments');
    }
    expect(r.interventionClass).toBe('unknown');
  });

  test('attempt 2+ → stop with the plain stop text (no [ASK USER] marker)', () => {
    for (const attempt of [2, 3]) {
      const r = decideDoomLoopSelfHeal({ attempt, fingerprint: 'fp', interventionClass: 'credentials' });
      expect(r).toEqual({ kind: 'stop', hardStopText: DOOM_LOOP_SELF_HEAL_STOP_TEXT, interventionClass: 'credentials' });
      expect(DOOM_LOOP_SELF_HEAL_STOP_TEXT).not.toContain('[ASK USER]');
    }
  });
});
