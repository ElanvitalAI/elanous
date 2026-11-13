// Conditional tool-loop budget grant (2026-07-12). opts.budgetGrant lets a
// surface keep the tight per-family maxTurns cap for ordinary turns while
// granting extra rounds ONLY when a designated multi-round tool (e.g. driving
// a headless coding-agent terminal) is actually dispatched, bounded by a
// ceiling. Verified here against the real streamLLMWithTools loop.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { streamLLMWithTools } from '../src/llm';
import type { LLMProvider, LLMStreamEvent } from '../src/llm';
import { __resetSnapshotStore, __resetTurnState } from '../src/undo-turn/index.js';
import { resetPlanModeState } from '../src/plan-mode/index.js';

// Gate baseline ELANOUS_TEST_FAKE_LLM=1 makes streamLLMWithTools
// (src/llm.ts forcedFake) select test-fake-llm ahead of this file's
// injected driveProvider. testFakeLlmDefaultSelected returns false when
// ELANOUS_LLM_MODE=real (src/ux-sim/fake-llm.ts), so the fixture owns the
// turn. #36949 and #37477 keep that fence for an explicit fake switch.
let savedLlmMode: string | undefined;

beforeEach(() => {
  savedLlmMode = process.env.ELANOUS_LLM_MODE;
  process.env.ELANOUS_LLM_MODE = 'real';
});

afterEach(() => {
  if (savedLlmMode === undefined) delete process.env.ELANOUS_LLM_MODE;
  else process.env.ELANOUS_LLM_MODE = savedLlmMode;
  __resetSnapshotStore();
  __resetTurnState();
  resetPlanModeState();
});

/** Emits the given tool on every turn (with a varying arg so the same-args
 *  dedup guard never fires), forever, so only the maxTurns bound stops it. */
function driveProvider(toolName: string): LLMProvider {
  let call = 0;
  return {
    name: 'scripted', defaultModel: 'd', available: () => true,
    async *streamChat() {
      yield { type: 'tool_call', id: `t${call}`, name: toolName, args: { n: call } } as LLMStreamEvent;
      call++;
    },
    async *chat() {},
  };
}

async function countDispatches(opts: { budgetGrant?: { tools: string[]; perCall: number; ceiling: number }; toolName?: string }): Promise<number> {
  const toolName = opts.toolName ?? 'DriveTool';
  let dispatched = 0;
  await streamLLMWithTools(
    [{ role: 'user', content: 'q' }],
    {
      onText: () => {},
      onToolResult: () => {},
      dispatchTool: async () => { dispatched++; return 'ok'; },
    },
    {
      provider: driveProvider(toolName),
      model: 'gpt-5.4', // codex family — tight cap context
      tools: [{ name: toolName, description: 'd', parameters: { type: 'object' } }],
      maxTurns: 3,
      ...(opts.budgetGrant ? { budgetGrant: opts.budgetGrant } : {}),
    },
  );
  return dispatched;
}

describe('streamLLMWithTools — conditional budgetGrant', () => {
  test('without budgetGrant, the cap is hard (3 dispatches then stop)', async () => {
    expect(await countDispatches({})).toBe(3);
  });

  test('budgetGrant extends the cap as the designated tool is called, bounded by ceiling', async () => {
    // maxTurns 3 → +2 (turn0) → 5 → +2 (turn1) → 7 (ceiling). Dispatches: 7.
    expect(await countDispatches({ budgetGrant: { tools: ['DriveTool'], perCall: 2, ceiling: 7 } })).toBe(7);
  });

  test('a budgetGrant whose tools do not match the called tool does NOT extend', async () => {
    expect(await countDispatches({ budgetGrant: { tools: ['SomethingElse'], perCall: 2, ceiling: 7 } })).toBe(3);
  });
});
