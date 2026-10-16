// TUI-GOAL-LOOP-FRICTION(#25·#46·#63) — goal loop → runCoreTurn → streamLLMWithTools 배선.
// goal loop 가 update_goal 을 «종결 신호»로 넘기고(runCoreTurn 이 그대로 전달), 그래서
//   · 답 ⊕ update_goal(complete) 한 턴이면 모델 호출 1회로 끝난다(빈 턴 0 · [NO FINAL SYNTHESIS] 0)
//   · 같은 답이 두 번 나오지 않는다.
// 반증: runCoreTurn 이 terminalToolNames 를 떨구면(종전) 빈 턴 반복 → [NO FINAL SYNTHESIS] 가 붙는다.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as llmModule from '../llm.js';
import type { LLMMessage, LLMProvider, LLMStreamEvent, LLMToolSpec } from '../llm.js';
import * as surfaceModule from '../session-runtime/index.js';
import * as deferredModule from '../session-runtime/tier-flip.js';
import { runGoalLoop } from './run-goal-loop.js';
import type { CoreTurnContext } from './types.js';

const realStream = llmModule.streamLLMWithTools;
const ANSWER = '대조 완료 — 남은 조치 0건입니다.';
const tool: LLMToolSpec = { name: 'RunShell', description: 'run', parameters: { type: 'object', properties: {} } };

function scriptedProvider(turns: LLMStreamEvent[][]): { provider: LLMProvider; callsSeen: () => number } {
  let call = 0;
  const p: LLMProvider = {
    name: 'scripted',
    defaultModel: 'd',
    available: () => true,
    async *streamChat() {
      for (const ev of turns[call++] ?? []) yield ev;
    },
    async *chat() {},
  };
  return { provider: p, callsSeen: () => call };
}

beforeEach(() => {
  spyOn(surfaceModule, 'resolveSessionSurfaceProfile').mockImplementation(() => ({
    id: 'default', selectionReason: 'test', baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
  }) as unknown as ReturnType<typeof surfaceModule.resolveSessionSurfaceProfile>);
  spyOn(deferredModule, 'applyDeferredTools').mockImplementation((messages, tools) => ({
    messages: [...messages],
    tools: [...tools],
    stats: {
      activeCount: tools.length, deferredCount: 0, warmPreloaded: [], injected: false,
      deferredNames: [], unhydratableNames: [], unhydratableCount: 0,
    },
  }) as unknown as ReturnType<typeof deferredModule.applyDeferredTools>);
});

afterEach(() => mock.restore());

async function drive(dropTerminal: boolean) {
  const { provider, callsSeen } = scriptedProvider([
    [
      { type: 'text', delta: ANSWER },
      { type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: 'eln msg list 출력 확인' } },
    ],
    [], [], [], [], [], [], [],
  ]);
  const seenTerminal: Array<readonly string[] | undefined> = [];
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers, opts = {}) => {
    seenTerminal.push(opts.terminalToolNames);
    const { terminalToolNames, ...rest } = opts;
    return realStream(messages, handlers, {
      ...rest,
      ...(dropTerminal ? {} : terminalToolNames !== undefined ? { terminalToolNames } : {}),
      provider,
      maxTurns: 10,
    });
  });
  const shown: string[] = [];
  const ctx: CoreTurnContext = {
    sessionId: 'goal-friction',
    messages: [{ role: 'user', content: '우편 확인하고 대조해' } as LLMMessage],
    tools: [tool],
    dispatchTool: async () => 'ok',
    signal: new AbortController().signal,
    callbacks: { onText: (delta) => { if (delta) shown.push(delta); } },
  };
  const result = await runGoalLoop(ctx, {
    controlSpaceId: null,
    intentStallProvider: null,
    changedFiles: () => [],
    attachLifecycleBridge: () => () => {},
    startLivenessHeartbeat: () => () => {},
  });
  return { result, calls: callsSeen(), seenTerminal, shown: shown.join('') };
}

describe('goal loop terminal signal wiring (TUI-GOAL-LOOP-FRICTION)', () => {
  test('answer ⊕ update_goal(complete) → one model call, goal complete, the answer once, no internal notice', async () => {
    const r = await drive(false);
    expect(r.seenTerminal[0]).toContain('update_goal');
    expect(r.calls).toBe(1);
    expect(r.result).toMatchObject({ stopReason: 'goal_complete', goalComplete: true, iterations: 1 });
    expect(r.result.finalText).toBe(ANSWER);
    expect(r.result.finalText).not.toContain('[NO FINAL SYNTHESIS]');
    expect(r.shown).toBe(ANSWER);
  });

  test('반증 — dropping terminalToolNames reopens empty turns and the internal notice leaks into the answer', async () => {
    const r = await drive(true);
    expect(r.calls).toBeGreaterThan(1);
    expect(r.result.finalText).toContain('[NO FINAL SYNTHESIS]');
  });
});
