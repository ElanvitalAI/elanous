import { describe, expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import type { CoreTurnContext, CoreTurnResult } from './types.js';
import { runGoalLoop } from './run-goal-loop.js';

type IterationObservation = Record<string, unknown>;

function baseCtx(): CoreTurnContext {
  return {
    sessionId: 'goal-loop-usage',
    messages: [{ role: 'user', content: 'implement usage observation' }],
    tools: [],
    dispatchTool: async () => null,
    signal: new AbortController().signal,
  } as CoreTurnContext;
}

async function collectObservations(
  runTurn: (ctx: CoreTurnContext) => Promise<CoreTurnResult>,
  maxIterations: number,
): Promise<IterationObservation[]> {
  const observations: IterationObservation[] = [];
  const originalLog = debug.log;
  debug.log = ((category: string, event: string, data: Record<string, unknown>) => {
    if (category === 'goal.loop' && event === 'iteration') observations.push(data);
  }) as typeof debug.log;
  try {
    await runGoalLoop(baseCtx(), { maxIterations, runTurn });
  } finally {
    debug.log = originalLog;
  }
  return observations;
}

describe('runGoalLoop iteration usage observation', () => {
  test('forwards the resolved provider from a real goal-loop turn', async () => {
    const resolved: string[] = [];
    const ctx = baseCtx();
    ctx.callbacks = { onResolvedProvider: (provider, model) => resolved.push(`${provider}/${model}`) };

    await runGoalLoop(ctx, { maxIterations: 1, runTurn: async (turnCtx) => {
      turnCtx.callbacks?.onResolvedProvider?.('openrouter', 'openrouter/z-ai/glm-5.3');
      return { stopReason: 'end_turn', finalText: 'done' };
    } });

    expect(resolved).toEqual(['openrouter/openrouter/z-ai/glm-5.3']);
  });

  test('accumulates usage per iteration while preserving input occupancy and existing fields', async () => {
    const observations = await collectObservations(async (ctx) => {
      ctx.callbacks?.onUsage?.({ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 1 });
      ctx.callbacks?.onUsage?.({ inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 2 });
      ctx.callbacks?.onUsage?.({ inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 3 });
      ctx.callbacks?.onTurnComplete?.([{ role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: {} }] }]);
      return { stopReason: 'end_turn', finalText: 'done' };
    }, 1);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      iteration: 1,
      iterInputTokens: 350,
      iterOutputTokens: 35,
      iterCacheReadTokens: 6,
      iterUsageCalls: 3,
      iterUsageMissing: 0,
      lastInputTokens: 200,
      dispatchCount: 0,
      markerComplete: false,
      finalChars: 4,
    });
  });

  test('resets iteration usage and records partial usage as missing without estimating it', async () => {
    let turn = 0;
    const observations = await collectObservations(async (ctx) => {
      turn += 1;
      if (turn === 1) {
        ctx.callbacks?.onUsage?.({ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 4 });
        ctx.callbacks?.onTurnComplete?.([{ role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: {} }] }]);
      } else {
        ctx.callbacks?.onUsage?.({ inputTokens: 50, cacheReadInputTokens: 2 });
        ctx.callbacks?.onTurnComplete?.([{ role: 'assistant', content: [{ type: 'tool_use', id: 'call-2', name: 'read_file', input: {} }] }]);
      }
      return { stopReason: 'end_turn', finalText: 'done' };
    }, 2);

    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      iterInputTokens: 100,
      iterOutputTokens: 10,
      iterCacheReadTokens: 4,
      iterUsageCalls: 1,
      iterUsageMissing: 0,
      lastInputTokens: 100,
    });
    expect(observations[1]).toMatchObject({
      iterInputTokens: 50,
      iterOutputTokens: 0,
      iterCacheReadTokens: 2,
      iterUsageCalls: 1,
      iterUsageMissing: 1,
      lastInputTokens: 100,
    });
  });

  test('records non-numeric usage fields as missing without adding a substitute value', async () => {
    const observations = await collectObservations(async (ctx) => {
      ctx.callbacks?.onUsage?.({
        inputTokens: 25,
        outputTokens: 'unknown' as unknown as number,
        cacheReadInputTokens: 1,
      });
      ctx.callbacks?.onTurnComplete?.([{ role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: {} }] }]);
      return { stopReason: 'end_turn', finalText: 'done' };
    }, 1);

    expect(observations[0]).toMatchObject({
      iterInputTokens: 25,
      iterOutputTokens: 0,
      iterCacheReadTokens: 1,
      iterUsageCalls: 1,
      iterUsageMissing: 1,
    });
  });
});
