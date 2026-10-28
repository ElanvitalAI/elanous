// TUI-FINAL-ANSWER-COMPLETION(S5 · 10-12 S5-01 실측 재현) — 골 루프 업무 턴을 «유효한 최종 답»으로
// 끝내는 계약의 회귀. 생산 경로 그대로 구동한다: runGoalLoop → runCoreTurn → streamLLMWithTools
// (llm-terminal-signal-tools 와 같은 fake-llm 무대).
//   · 단순 상태·상황 질문 턴: 이미 완결한 최종 답(상태 값 3) 뒤에는 추가 골 도구 0 — 불필요한
//     update_goal 재촉·빈 evidence 반려로 빈 턴이 [NO FINAL SYNTHESIS] 로 떨어지지 않는다.
//   · 실제 골 턴: 필요한 작업 도구와 update_goal 을 같은 턴에 그대로 쓴다(경계 보존).
//   · 0.2.28 TUI-NO-SYNTH-FALLBACK은 «실패 때 사람 말 안내»일 뿐 — 이 계약은 실패 없이 답으로 끝낸다.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as llmModule from '../llm.js';
import type { LLMMessage, LLMProvider, LLMStreamEvent, LLMToolSpec } from '../llm.js';
import * as surfaceModule from '../session-runtime/index.js';
import * as deferredModule from '../session-runtime/tier-flip.js';
import { runGoalLoop } from './run-goal-loop.js';
import type { CoreTurnContext } from './types.js';

const realStream = llmModule.streamLLMWithTools;
const S5_QUESTION = 'S5 상태 값이 3 맞아?';
const S5_ANSWER = '네, S5 상태 값은 3입니다.';
const INTERIM = '아직 확인하지 못했습니다.';
const WORK_DIRECTIVE = '우편 확인하고 대조해';
const WORK_ANSWER = '대조 완료 — 남은 조치 0건입니다.';

const shellTool: LLMToolSpec = { name: 'RunShell', description: 'run a shell command', parameters: { type: 'object', properties: {} } };
const statusTool: LLMToolSpec = { name: 'release_status', description: 'read release status', parameters: { type: 'object', properties: {} } };

function scriptedProvider(turns: LLMStreamEvent[][], name = 'scripted'): { provider: LLMProvider; callsSeen: () => number } {
  let call = 0;
  const p: LLMProvider = {
    name,
    defaultModel: 'd',
    available: () => true,
    async *streamChat(_messages, _opts) {
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

async function drive(turns: LLMStreamEvent[][], userText: string, tools: LLMToolSpec[]) {
  const { provider, callsSeen } = scriptedProvider(turns);
  const seenTerminal: Array<readonly string[] | undefined> = [];
  const dispatchedTools: string[] = [];
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers, opts = {}) => {
    seenTerminal.push(opts.terminalToolNames);
    const { terminalToolNames, ...rest } = opts;
    return realStream(messages, handlers, {
      ...rest,
      ...(terminalToolNames !== undefined ? { terminalToolNames } : {}),
      provider,
      maxTurns: 10,
    });
  });
  const shown: string[] = [];
  const ctx: CoreTurnContext = {
    sessionId: 's5-status-answer',
    messages: [{ role: 'user', content: userText } as LLMMessage],
    userText,
    tools,
    dispatchTool: async (name: string) => { dispatchedTools.push(name); return 'ok'; },
    signal: new AbortController().signal,
    callbacks: { onText: (delta: string) => { if (delta) shown.push(delta); } },
  };
  const result = await runGoalLoop(ctx, {
    controlSpaceId: null,
    intentStallProvider: null,
    changedFiles: () => [],
    attachLifecycleBridge: () => () => {},
    startLivenessHeartbeat: () => () => {},
  });
  return {
    result,
    calls: callsSeen(),
    shown: shown.join(''),
    seenTerminal,
    updateGoalDispatches: dispatchedTools.filter((n) => n === 'update_goal').length,
    dispatchedTools,
  };
}

describe('goal loop status-question final answer (TUI-FINAL-ANSWER-COMPLETION · S5-01 실측 재현)', () => {
  test('상태 질문 턴 — 조회 도구 뒤 완결 답이 추가 골 도구 0으로 그 턴을 종결한다', async () => {
    const r = await drive([
      [{ type: 'tool_call', id: 'q1', name: 'release_status', args: { topic: 'status' } }],
      [{ type: 'text', delta: S5_ANSWER }],
      [{ type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: '' } }],
      [], [], [], [], [], [], [],
    ], S5_QUESTION, [statusTool, shellTool]);
    expect(r.result.goalComplete).toBe(true);
    expect(r.result.stopReason).toBe('goal_complete');
    expect(r.result.iterations).toBe(1);
    expect(r.calls).toBe(2);
    expect(r.updateGoalDispatches).toBe(0);
    expect(r.result.finalText).toBe(S5_ANSWER);
    expect(r.shown).toBe(S5_ANSWER);
    expect(r.result.finalText).not.toContain('[NO FINAL SYNTHESIS]');
    expect(r.seenTerminal[0]).toContain('update_goal');
  });

  test('상태 질문 턴 — 도구 없이 바로 완결 답이면 모델 호출 1회로 종결한다(update_goal 0)', async () => {
    const r = await drive([
      [{ type: 'text', delta: S5_ANSWER }],
      [{ type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: '' } }],
      [], [], [], [], [], [], [],
    ], S5_QUESTION, [statusTool, shellTool]);
    expect(r.result.goalComplete).toBe(true);
    expect(r.result.stopReason).toBe('goal_complete');
    expect(r.result.iterations).toBe(1);
    expect(r.calls).toBe(1);
    expect(r.updateGoalDispatches).toBe(0);
    expect(r.result.finalText).toBe(S5_ANSWER);
    expect(r.shown).toBe(S5_ANSWER);
    expect(r.result.finalText).not.toContain('[NO FINAL SYNTHESIS]');
  });

  test('상태 질문 턴 — 미완 보고형 중간 답은 종결하지 않고, 조회 뒤 완결 답으로 끝난다', async () => {
    const r = await drive([
      [{ type: 'text', delta: INTERIM }],
      [{ type: 'tool_call', id: 'q1', name: 'release_status', args: { topic: 'status' } }],
      [{ type: 'text', delta: S5_ANSWER }],
      [{ type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: '' } }],
      [], [], [], [], [], [], [],
    ], S5_QUESTION, [statusTool, shellTool]);
    expect(r.result.goalComplete).toBe(true);
    expect(r.result.stopReason).toBe('goal_complete');
    expect(r.updateGoalDispatches).toBe(0);
    expect(r.result.finalText).toBe(S5_ANSWER);
    expect(r.shown).toContain(S5_ANSWER);
    expect(r.result.finalText).not.toContain('[NO FINAL SYNTHESIS]');
  });

  test('상태 질문 턴 — 답 ⊕ update_goal(complete, 빈 evidence) 한 턴은 반려 재주입 없이 그 답으로 완료된다', async () => {
    const r = await drive([
      [
        { type: 'text', delta: S5_ANSWER },
        { type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: '' } },
      ],
      [], [], [], [], [], [], [], [],
    ], S5_QUESTION, [statusTool, shellTool]);
    expect(r.result.goalComplete).toBe(true);
    expect(r.result.stopReason).toBe('goal_complete');
    expect(r.result.iterations).toBe(1);
    expect(r.calls).toBe(1);
    // terminalToolNames 흐름에서 update_goal 은 «종결 신호»로 잡히고 dispatchTool 로는 오지 않는다.
    expect(r.updateGoalDispatches).toBe(0);
    expect(r.result.finalText).toBe(S5_ANSWER);
    expect(r.result.finalText).not.toContain('[NO FINAL SYNTHESIS]');
  });

  test('(경계 보존) 실제 골 턴 — 필요 작업 도구 ⊕ update_goal(complete) 같은 턴 사용은 그대로다', async () => {
    const r = await drive([
      [
        { type: 'text', delta: WORK_ANSWER },
        { type: 'tool_call', id: 'w1', name: 'RunShell', args: { command: 'eln msg list' } },
        { type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: 'eln msg list 출력 확인' } },
      ],
      [], [], [], [], [], [], [], [],
    ], WORK_DIRECTIVE, [shellTool, statusTool]);
    expect(r.result.goalComplete).toBe(true);
    expect(r.result.stopReason).toBe('goal_complete');
    expect(r.result.iterations).toBe(1);
    expect(r.calls).toBe(1);
    expect(r.dispatchedTools).toContain('RunShell');
    // 같은 턴의 update_goal 종결 신호는 dispatchTool 없이 골 루프로 흘러 goalComplete 로 증명된다.
    expect(r.updateGoalDispatches).toBe(0);
    expect(r.result.finalText).toBe(WORK_ANSWER);
    expect(r.seenTerminal[0]).toContain('update_goal');
  });
});
