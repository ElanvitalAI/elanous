// Live-through-the-loop verification of the runaway-discipline fixes (A/B/D):
// drive the REAL streamLLMWithTools loop with a scripted provider that forces
// each trigger condition, rather than hoping a stochastic drive hits it.
// (RESEARCH-autonomous-runaway-discipline — A/B/D were merged but never fired
// live because iv6 never met the conditions.)

import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import { streamLLMWithTools } from '../src/llm';
import type { LLMProvider, LLMStreamEvent } from '../src/llm';
import { debug } from '../src/debug/log.js';
import { __resetSnapshotStore, __resetTurnState } from '../src/undo-turn/index.js';
import { resetPlanModeState } from '../src/plan-mode/index.js';
import { setAskUserQuestionResolver } from '../src/ask-user-question/index.js';

afterEach(() => {
  __resetSnapshotStore();
  __resetTurnState();
  resetPlanModeState();
  setAskUserQuestionResolver(null);
});

function scriptedProvider(turns: LLMStreamEvent[][]): LLMProvider {
  let call = 0;
  return {
    name: 'scripted', defaultModel: 'd', available: () => true,
    async *streamChat() { for (const ev of turns[call++] ?? []) yield ev; },
    async *chat() {},
  };
}

describe('A — identical successful-call repeat detector fires in the real loop', () => {
  test('5 identical successful Ping calls trigger llm.tool-loop.repeat', async () => {
    const spy = spyOn(debug, 'log');
    try {
      const same = { x: 1 };
      const provider = scriptedProvider([
        [{ type: 'tool_call', id: '1', name: 'Ping', args: same }],
        [{ type: 'tool_call', id: '2', name: 'Ping', args: same }],
        [{ type: 'tool_call', id: '3', name: 'Ping', args: same }],
        [{ type: 'tool_call', id: '4', name: 'Ping', args: same }],
        [{ type: 'tool_call', id: '5', name: 'Ping', args: same }],
        [{ type: 'tool_call', id: '6', name: 'Ping', args: same }],
        [{ type: 'text', delta: 'done' }],
      ]);
      await streamLLMWithTools(
        [{ role: 'user', content: 'q' }],
        { onText: () => {}, onToolResult: () => {}, dispatchTool: async () => 'ok' },
        { provider, model: 'claude-sonnet-5', tools: [{ name: 'Ping', description: 'd', parameters: { type: 'object' } }], maxTurns: 10 },
      );
      const hits = spy.mock.calls.filter((c) => c[0] === 'llm.tool-loop.repeat' && c[1] === 'identical-success-detected');
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect((hits[0]![2] as any).tool).toBe('Ping');
    } finally { spy.mockRestore(); }
  });
});

describe('D — doom loop self-heals in the real loop without asking (대표 10-17)', () => {
  test('3 identical failing Edits never reach the AskUser resolver', async () => {
    let resolverCalled = 0;
    setAskUserQuestionResolver(async () => { resolverCalled += 1; return { answers: { doom_loop_next_step: 'Stop here' } }; });
    const spy = spyOn(debug, 'log');
    const badEdit = { file_path: '/tmp/x.ts', old_string: 'NOPE', new_string: 'Y' };
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: '1', name: 'Edit', args: badEdit }],
      [{ type: 'tool_call', id: '2', name: 'Edit', args: badEdit }],
      [{ type: 'tool_call', id: '3', name: 'Edit', args: badEdit }],
      [{ type: 'text', delta: 'giving up' }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {}, onToolResult: () => {},
        dispatchTool: async () => { throw new Error('Edit: old_string not found'); },
      },
      { provider, model: 'claude-sonnet-5', sessionId: 'sess-doom-live', tools: [{ name: 'Edit', description: 'd', parameters: { type: 'object' } }], maxTurns: 8 },
    );
    const heal = spy.mock.calls.find((c) => c[0] === 'llm.tool-loop.retry' && c[1] === 'doom-loop-self-heal');
    spy.mockRestore();
    expect(resolverCalled).toBe(0);
    expect(heal?.[2]).toMatchObject({ tool: 'Edit', attempt: 1, action: 'guidance' });
  });
});

describe('B — mid-loop compaction TRIGGER fires when context exceeds threshold', () => {
  // NOTE: the full `tool-loop.midloop-compact` EVENT only logs when compaction
  // reduces message COUNT, and the cheap Layer1+2 pass (no provider) trims
  // tool-output CONTENT but not count — only the Layer3 escalation (this arc's
  // B generalization, LLM summarize) reduces count. So the loop event needs a
  // real summarizer + over-threshold context (a real drive). Here we verify the
  // deterministic half the loop depends on: the TRIGGER (shouldAutoCompact) fires.
  test('shouldAutoCompact fires once context passes the token ratio', async () => {
    const { shouldAutoCompact } = await import('../src/compact/auto.js');
    const { getUserConfig } = await import('../src/user-config.js');
    const ac = getUserConfig().chat?.autoCompact;
    expect(ac?.enabled).toBe(true);  // backstop is armed by default
    const big: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (let i = 0; i < 40; i++) big.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'lorem ipsum dolor sit amet '.repeat(120) });
    const d = shouldAutoCompact(big as never, 'local:small', ac!);
    expect(d.fire).toBe(true);
    expect(d.ratio).toBeGreaterThan(0.85);
    // under threshold → does not fire (no needless compaction)
    const small = shouldAutoCompact([{ role: 'user', content: 'hi' }] as never, 'local:small', ac!);
    expect(small.fire).toBe(false);
  });
});
