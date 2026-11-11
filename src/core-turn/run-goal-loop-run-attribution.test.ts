import { afterEach, describe, expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import type { CoreTurnContext, CoreTurnResult } from './types.js';
import { runGoalLoop } from './run-goal-loop.js';

const RUN_ID_ENV = 'ELANOUS_RUN_ID';
const originalRunId = process.env[RUN_ID_ENV];

afterEach(() => {
  if (originalRunId === undefined) delete process.env[RUN_ID_ENV];
  else process.env[RUN_ID_ENV] = originalRunId;
});

function baseCtx(): CoreTurnContext {
  return {
    sessionId: 'goal-loop-run-attribution',
    messages: [{ role: 'user', content: 'continue the goal' }],
    tools: [],
    dispatchTool: async () => null,
    signal: new AbortController().signal,
  } as CoreTurnContext;
}

function toolRunTurn(): (ctx: CoreTurnContext) => Promise<CoreTurnResult> {
  return async (ctx) => {
    ctx.callbacks?.onTurnComplete?.([{ role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: {} }] }]);
    return { stopReason: 'end_turn', finalText: 'done' };
  };
}

async function collectGoalLoopObservations(runId: string | undefined): Promise<Record<string, unknown>[]> {
  if (runId === undefined) delete process.env[RUN_ID_ENV];
  else process.env[RUN_ID_ENV] = runId;

  const observations: Record<string, unknown>[] = [];
  const originalLog = debug.log;
  debug.log = ((category: string, _event: string, data: Record<string, unknown>) => {
    if (category === 'goal.loop') observations.push(data);
  }) as typeof debug.log;
  try {
    await runGoalLoop(baseCtx(), { maxIterations: 1, runTurn: toolRunTurn() });
  } finally {
    debug.log = originalLog;
  }
  return observations;
}

function sessionObservationCount(observations: readonly Record<string, unknown>[]): number {
  return observations.filter(({ sessionId }) => sessionId === 'goal-loop-run-attribution').length;
}

function runObservationCount(observations: readonly Record<string, unknown>[]): number {
  return observations.filter(({ runId }) => runId === 'run-attribution-20260814').length;
}

type GoalLoopObservation = { event: string; data: Record<string, unknown> };

async function runCompletionScenario(runTestOk: boolean | undefined): Promise<{
  result: Awaited<ReturnType<typeof runGoalLoop>>;
  observations: GoalLoopObservation[];
  turns: number;
}> {
  const observations: GoalLoopObservation[] = [];
  const originalLog = debug.log;
  let turns = 0;
  debug.log = ((category: string, event: string, data: Record<string, unknown>) => {
    if (category === 'goal.loop') observations.push({ event, data });
  }) as typeof debug.log;
  try {
    const result = await runGoalLoop(baseCtx(), {
      maxIterations: 2,
      runTurn: async (ctx) => {
        turns += 1;
        if (runTestOk !== undefined) {
          ctx.callbacks?.onToolResult?.({
            id: `run-tests-${turns}`,
            name: 'run_tests',
            result: { ok: runTestOk, fail: runTestOk ? 0 : 1, pass: runTestOk ? 1 : 0 },
          });
        }
        ctx.callbacks?.onTurnComplete?.([{
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: `complete-${turns}`,
            name: 'update_goal',
            input: { status: 'complete', evidence: 'focused completion evidence' },
          }],
        }]);
        return { stopReason: 'end_turn', finalText: 'done' };
      },
    });
    return { result, observations, turns };
  } finally {
    debug.log = originalLog;
  }
}

function completeObservation(observations: readonly GoalLoopObservation[]): GoalLoopObservation {
  const observation = observations.find(({ event }) => event === 'complete');
  expect(observation).toBeDefined();
  return observation!;
}

describe('runGoalLoop — goal.loop run attribution', () => {
  test('run ID exists면 모든 sessionId-bearing goal.loop observation이 같은 runId를 싣고, 없으면 필드를 생략한다', async () => {
    const withRunId = await collectGoalLoopObservations('run-attribution-20260814');
    const withoutRunId = await collectGoalLoopObservations(undefined);

    const sessionsWithRunId = sessionObservationCount(withRunId);
    const sessionsWithoutRunId = sessionObservationCount(withoutRunId);
    expect(sessionsWithRunId).toBeGreaterThan(0);
    expect(runObservationCount(withRunId)).toBe(sessionsWithRunId);
    expect(runObservationCount(withoutRunId)).toBe(0);
    expect(sessionsWithoutRunId).toBe(sessionsWithRunId);
    expect(withoutRunId.every((observation) => !Object.hasOwn(observation, 'runId'))).toBe(true);
  });

  test('complete observation distinguishes matched, fail-open mismatch, and skipped test evidence without changing acceptance flow', async () => {
    process.env[RUN_ID_ENV] = 'run-attribution-20260814';
    const matched = await runCompletionScenario(true);
    expect(matched.result).toMatchObject({ goalComplete: true, stopReason: 'goal_complete', iterations: 1 });
    expect(matched.turns).toBe(1);
    expect(completeObservation(matched.observations).data).toMatchObject({ via: 'update_goal', evidenceCheck: 'matched' });
    expect(matched.observations.some(({ event }) => event === 'complete-rejected-evidence-mismatch')).toBe(false);

    const skipped = await runCompletionScenario(undefined);
    expect(skipped.result).toMatchObject({ goalComplete: true, stopReason: 'goal_complete', iterations: 1 });
    expect(skipped.turns).toBe(1);
    expect(completeObservation(skipped.observations).data).toMatchObject({ via: 'update_goal', evidenceCheck: 'skipped-no-current-turn-run-tests' });
    expect(skipped.observations.some(({ event }) => event === 'complete-rejected-evidence-mismatch')).toBe(false);

    const failOpen = await runCompletionScenario(false);
    expect(failOpen.result).toMatchObject({ goalComplete: true, stopReason: 'goal_complete', iterations: 2 });
    expect(failOpen.turns).toBe(2);
    expect(completeObservation(failOpen.observations).data).toMatchObject({ via: 'update_goal', evidenceCheck: 'mismatch-failopen' });
    expect(failOpen.observations.filter(({ event }) => event === 'complete-rejected-evidence-mismatch')).toHaveLength(1);
    expect(failOpen.observations.filter(({ event }) => event === 'complete-evidence-mismatch-failopen')).toHaveLength(1);

    for (const scenario of [matched, skipped, failOpen]) {
      const sessionEvents = scenario.observations.filter(({ data }) => data.sessionId === 'goal-loop-run-attribution');
      expect(sessionEvents).not.toHaveLength(0);
      expect(sessionEvents.every(({ data }) => data.runId === 'run-attribution-20260814')).toBe(true);
      expect(sessionEvents.some(({ event }) => event === 'start')).toBe(true);
      expect(sessionEvents.some(({ event }) => event === 'complete')).toBe(true);
    }
    expect(failOpen.observations.filter(({ event }) => event.includes('mismatch')).every(({ data }) => data.runId === 'run-attribution-20260814')).toBe(true);
  });
});
