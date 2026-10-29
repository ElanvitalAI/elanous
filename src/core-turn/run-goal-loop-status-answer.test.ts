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
import { CORE_TOOL_SPECS } from '../domains/core-tools.js';
import type { CoreTurnContext } from './types.js';

const realStream = llmModule.streamLLMWithTools;
const S5_QUESTION = 'S5 상태 값이 3 맞아?';
const S5_ANSWER = '네, S5 상태 값은 3입니다.';
const INTERIM = '아직 확인하지 못했습니다.';
const WORK_DIRECTIVE = '우편 확인하고 대조해';
const WORK_ANSWER = '대조 완료 — 남은 조치 0건입니다.';
const S5_FAIL_ANSWER = 'S5 상태 조회가 실패했습니다(릴리스 API 타임아웃) — 상태 값을 확정할 수 없습니다.';

const shellTool: LLMToolSpec = { name: 'RunShell', description: 'run a shell command', parameters: { type: 'object', properties: {} } };
const statusTool: LLMToolSpec = { name: 'release_status', description: 'read release status', parameters: { type: 'object', properties: {} } };
const readTool: LLMToolSpec = { name: 'Read', description: 'read a file', parameters: { type: 'object', properties: {} } };
const editTool: LLMToolSpec = { name: 'Edit', description: 'write a file', parameters: { type: 'object', properties: {} } };
type ScriptedTurnResponder = (messages: LLMMessage[], call: number) => LLMStreamEvent[];
type ScriptedTurns = LLMStreamEvent[][] | ScriptedTurnResponder;

function scriptedProvider(turns: ScriptedTurns, name = 'scripted'): { provider: LLMProvider; callsSeen: () => number } {
  let call = 0;
  const p: LLMProvider = {
    name,
    defaultModel: 'd',
    available: () => true,
    async *streamChat(messages, _opts) {
      const current = call++;
      const events = typeof turns === 'function' ? turns(messages, current) : turns[current] ?? [];
      for (const ev of events) yield ev;
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

// TUI-FACT-TOOL-REPEAT — 실제 실행만 잡는 dispatch 추적 무대: 억제된 호출은 ctx.dispatchTool 까지
//   내려오지 않으므로 dispatchedCalls 가 곧 «실제 실행» 기록이다. onToolResult 로 모델에게 간 결과도 모은다.
async function driveTracked(
  turns: ScriptedTurns,
  userText: string,
  tools: LLMToolSpec[],
  dispatch: (name: string, args: Record<string, unknown>) => unknown,
  maxTurns = 10,
) {
  const { provider, callsSeen } = scriptedProvider(turns);
  const seenTerminal: Array<readonly string[] | undefined> = [];
  const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const toolResults: Array<{ name: string; result: unknown }> = [];
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers, opts = {}) => {
    seenTerminal.push(opts.terminalToolNames);
    const { terminalToolNames, ...rest } = opts;
    return realStream(messages, handlers, {
      ...rest,
      ...(terminalToolNames !== undefined ? { terminalToolNames } : {}),
      provider,
      maxTurns,
    });
  });
  const ctx: CoreTurnContext = {
    sessionId: 's5-tool-repeat',
    messages: [{ role: 'user', content: userText } as LLMMessage],
    userText,
    tools,
    dispatchTool: async (name: string, args: Record<string, unknown>) => {
      dispatchedCalls.push({ name, args });
      return dispatch(name, args);
    },
    signal: new AbortController().signal,
    callbacks: {
      onText: () => {},
      onToolResult: (call) => { toolResults.push({ name: call.name, result: call.result }); },
    },
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
    seenTerminal,
    dispatchedCalls,
    toolResults,
    updateGoalDispatches: dispatchedCalls.filter((c) => c.name === 'update_goal').length,
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

// TUI-FACT-TOOL-REPEAT — 동일 read-only tool+args 는 턴당 실제 실행 1회 이하(성공 결과 재사용),
//   다른 인자·도구는 정상 실행, 쓰기·외부 효과 도구는 억제하지 않고, 오류 뒤 재시도는 억제되어
//   실패 근거를 설명하는 최종 답으로 종결한다. 캐시는 현재 턴 밖으로 유지하지 않는다.
describe('TUI-FACT-TOOL-REPEAT — read-only 중복 억제(동일 tool+args 턴당 실제 실행 1회)', () => {
  test('TUI-FACT-TOOL-REPEAT: 동일 read-only 조회 3회는 실제 실행 1회·성공 결과 재사용·최종 답 3으로 종결', async () => {
    let exec = 0;
    const r = await driveTracked([
      [{ type: 'tool_call', id: 'q1', name: 'release_status', args: { topic: 'status' } }],
      [{ type: 'tool_call', id: 'q2', name: 'release_status', args: { topic: 'status' } }],
      [{ type: 'tool_call', id: 'q3', name: 'release_status', args: { topic: 'status' } }],
      [{ type: 'text', delta: S5_ANSWER }],
      [], [], [], [], [], [],
    ], S5_QUESTION, [statusTool, shellTool], (name) => {
      exec += 1;
      return { value: 3, exec };
    });
    // 동일 read-only tool+args → 턴당 실제 실행 1회 이하(동일 호출 반복 0).
    expect(r.dispatchedCalls.filter((c) => c.name === 'release_status')).toHaveLength(1);
    expect(exec).toBe(1);
    // S5 질문 3회 각각 같은 값('3') — 실제 실행은 첫째뿐, 나머지 둘은 성공 결과 재사용.
    const statusResults = r.toolResults.filter((t) => t.name === 'release_status');
    expect(statusResults).toHaveLength(3);
    for (const seen of statusResults) expect(seen.result).toEqual({ value: 3, exec: 1 });
    expect(r.result.goalComplete).toBe(true);
    expect(r.result.stopReason).toBe('goal_complete');
    expect(r.result.finalText).toBe(S5_ANSWER);
    expect(r.updateGoalDispatches).toBe(0);
  });



  test('TUI-FACT-TOOL-REPEAT: every allowlisted core read name uses its production spec and suppresses an identical repeat', async () => {
    const stableCoreReadNames = ['release_status', 'self_recall', 'ops_seats', 'decisions_pending', 'proact_meter'];
    const tools = stableCoreReadNames.map((name) => {
      const productionSpec = CORE_TOOL_SPECS.find((spec) => spec.name === name);
      expect(productionSpec).toBeDefined();
      return productionSpec!;
    });
    const events: LLMStreamEvent[][] = [];
    for (const [index, name] of stableCoreReadNames.entries()) {
      const args = { probe: name };
      events.push([{ type: 'tool_call', id: `core-${index}-first`, name, args }]);
      events.push([{ type: 'tool_call', id: `core-${index}-repeat`, name, args }]);
    }
    events.push([{ type: 'text', delta: '안정된 조회 결과를 확인했습니다.' }]);
    const r = await driveTracked(events, S5_QUESTION, tools, (name) => ({ name, value: 3 }), 20);
    for (const name of stableCoreReadNames) {
      expect(r.dispatchedCalls.filter((call) => call.name === name)).toHaveLength(1);
      expect(r.toolResults.filter((call) => call.name === name)).toHaveLength(2);
    }
  });

  test('TUI-FACT-TOOL-REPEAT: 실제 Read 도구 호출을 반복하고 첫 결과에 반응한 최종 답을 낸다', async () => {
    let sawReadResult = false;
    const r = await driveTracked((messages, call) => {
      const transcript = JSON.stringify(messages);
      if (call === 0) return [{ type: 'tool_call', id: 'read-1', name: 'Read', args: { file_path: '/tmp/status.txt' } }];
      if (call === 1) {
        sawReadResult = transcript.includes('status=3');
        return sawReadResult
          ? [{ type: 'tool_call', id: 'read-2', name: 'Read', args: { file_path: '/tmp/status.txt' } }]
          : [{ type: 'text', delta: '파일 결과를 받지 못했습니다.' }];
      }
      return [{ type: 'text', delta: sawReadResult && transcript.includes('status=3') ? '파일 상태는 3입니다.' : '파일 결과가 없습니다.' }];
    }, S5_QUESTION, [readTool], () => 'status=3');
    expect(sawReadResult).toBe(true);
    expect(r.dispatchedCalls.filter((c) => c.name === 'Read')).toHaveLength(1);
    expect(r.result.finalText).toBe('파일 상태는 3입니다.');
  });

  test('TUI-FACT-TOOL-REPEAT: 쓰기 뒤 같은 Read 인자는 다시 실행해 변경된 결과를 읽는다', async () => {
    let readCalls = 0;
    const r = await driveTracked([
      [{ type: 'tool_call', id: 'read-before', name: 'Read', args: { file_path: '/tmp/status.txt' } }],
      [{ type: 'tool_call', id: 'edit', name: 'Edit', args: { file_path: '/tmp/status.txt', content: 'status=4' } }],
      [{ type: 'tool_call', id: 'read-after', name: 'Read', args: { file_path: '/tmp/status.txt' } }],
      [{ type: 'text', delta: '파일 상태는 4입니다.' }],
      [], [], [], [], [], [],
    ], S5_QUESTION, [readTool, editTool], (name) => {
      if (name === 'Read') return ++readCalls === 1 ? 'status=3' : 'status=4';
      return { ok: true };
    });
    expect(readCalls).toBe(2);
    expect(r.dispatchedCalls.filter((c) => c.name === 'Edit')).toHaveLength(1);
    expect(r.toolResults.filter((t) => t.name === 'Read').map((t) => t.result)).toEqual(['status=3', 'status=4']);
    expect(r.result.finalText).toContain('파일 상태는 4입니다.');
  });

  test('TUI-FACT-TOOL-REPEAT: S5 질문 3회 각각 "3" 최종 답·update_goal 0·동일 호출 반복 0', async () => {
    for (let run = 1; run <= 3; run += 1) {
      let firstResultSeen = false;
      let repeatedResultSeen = false;
      const r = await driveTracked((messages, call) => {
        const results = messages.flatMap((message) => {
          const content = (message as unknown as { content?: unknown }).content;
          return Array.isArray(content) ? content : [];
        }) as Array<{ type?: string; tool_use_id?: string; content?: string }>;
        if (call === 0) return [{ type: 'tool_call', id: `q1-${run}`, name: 'release_status', args: { topic: 'status' } }];
        if (call === 1) {
          firstResultSeen = results.some((part) => part.type === 'tool_result'
            && part.tool_use_id === `q1-${run}` && part.content?.includes('"value":3'));
          return firstResultSeen
            ? [{ type: 'tool_call', id: `q2-${run}`, name: 'release_status', args: { topic: 'status' } }]
            : [{ type: 'text', delta: '첫 조회 결과를 받지 못했습니다.' }];
        }
        repeatedResultSeen = results.some((part) => part.type === 'tool_result'
          && part.tool_use_id === `q2-${run}` && part.content?.includes('"value":3'));
        return [{ type: 'text', delta: repeatedResultSeen ? S5_ANSWER : '반복 조회 결과를 받지 못했습니다.' }];
      }, S5_QUESTION, [statusTool, shellTool], () => ({ value: 3 }));
      expect(firstResultSeen).toBe(true);
      expect(repeatedResultSeen).toBe(true);
      expect(r.result.goalComplete).toBe(true);
      expect(r.result.finalText).toBe(S5_ANSWER);
      expect(r.updateGoalDispatches).toBe(0);
      expect(r.dispatchedCalls.filter((call) => call.name === 'release_status')).toHaveLength(1);
      expect(r.toolResults.filter((call) => call.name === 'release_status')).toHaveLength(2);
    }
  });

  test('update_goal 진행 선언은 dispatcher 대신 ack 결과를 반환한다', async () => {
    const r = await driveTracked([
      [{ type: 'tool_call', id: 'g-progress', name: 'update_goal', args: { status: 'in_progress', evidence: '검증 중' } }],
      [{ type: 'text', delta: WORK_ANSWER }],
    ], WORK_DIRECTIVE, [shellTool], (name) => `unexpected:${name}`);

    expect(r.dispatchedCalls).toEqual([]);
    expect(r.toolResults.filter((call) => call.name === 'update_goal').map((call) => call.result)).toEqual([
      { ok: true, recorded: 'in_progress' },
    ]);
  });

  test('TUI-FACT-TOOL-REPEAT: 다른 인자·다른 도구는 정상 실행, 쓰기·외부 효과 도구(RunShell)는 억제하지 않는다', async () => {
    const r = await driveTracked([
      [{ type: 'tool_call', id: 'q1', name: 'release_status', args: { topic: 'status' } }],
      [{ type: 'tool_call', id: 'q2', name: 'release_status', args: { topic: 'rollout' } }],
      [{ type: 'tool_call', id: 'q3', name: 'release_status', args: { topic: 'status' } }],
      [{ type: 'tool_call', id: 'w1', name: 'RunShell', args: { command: 'eln msg list' } }],
      [{ type: 'tool_call', id: 'w2', name: 'RunShell', args: { command: 'eln msg list' } }],
      [
        { type: 'text', delta: WORK_ANSWER },
        { type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: '조회·대조 완료' } },
      ],
      [], [], [], [],
    ], WORK_DIRECTIVE, [statusTool, shellTool], (name) => `ok:${name}`);
    // 다른 인자는 캐시에 적중하지 않는다(키가 달라야 한다) — 정상 실행.
    expect(r.dispatchedCalls.filter((c) => c.name === 'release_status' && c.args.topic === 'status')).toHaveLength(1);
    expect(r.dispatchedCalls.filter((c) => c.name === 'release_status' && c.args.topic === 'rollout')).toHaveLength(1);
    // (경계 보존) 쓰기·외부 효과 도구는 중복 억제 대상이 아니다 — 동일 호출도 매번 실제 실행.
    expect(r.dispatchedCalls.filter((c) => c.name === 'RunShell')).toHaveLength(2);
    expect(r.result.goalComplete).toBe(true);
    expect(r.updateGoalDispatches).toBe(0);
  });

  test('TUI-FACT-TOOL-REPEAT: 반복 조회 오류 주입 — 모델이 억제 안내를 읽고 실패 근거를 최종 답에 반영', async () => {
    let exec = 0;
    let modelSawSuppressedFailure = false;
    const r = await driveTracked((messages, call) => {
      const transcript = JSON.stringify(messages);
      if (call === 0) return [{ type: 'tool_call', id: 'q1', name: 'release_status', args: { topic: 'status' } }];
      if (call === 1) return [{ type: 'tool_call', id: 'q2', name: 'release_status', args: { topic: 'status' } }];
      modelSawSuppressedFailure = transcript.includes('[tool repeat suppressed]') && transcript.includes('릴리스 API 타임아웃');
      return [{ type: 'text', delta: modelSawSuppressedFailure ? S5_FAIL_ANSWER : '오류 근거를 받지 못했습니다.' }];
    }, S5_QUESTION, [statusTool, shellTool], (name) => {
      exec += 1;
      throw new Error('릴리스 API 타임아웃');
    });
    // 오류 뒤 동일 호출 재시도는 억제된다 — 실제 실행 1회(재호출 0).
    expect(exec).toBe(1);
    expect(modelSawSuppressedFailure).toBe(true);
    expect(r.calls).toBe(3);
    expect(r.dispatchedCalls.filter((c) => c.name === 'release_status')).toHaveLength(1);
    // 억제된 재시도는 재호출 없이 실패 근거를 담은 안내를 결과로 받았다.
    const suppressedNotice = r.toolResults
      .filter((t) => t.name === 'release_status')
      .find((t) => typeof t.result === 'string' && t.result.includes('재시도는 억제'));
    expect(suppressedNotice).toBeDefined();
    expect(String(suppressedNotice?.result)).toContain('릴리스 API 타임아웃');
    // 실패 근거를 설명하는 최종 답으로 종결한다(update_goal 0).
    expect(r.result.finalText).toBe(S5_FAIL_ANSWER);
    expect(r.result.goalComplete).toBe(true);
    expect(r.updateGoalDispatches).toBe(0);
  });

  test('TUI-FACT-TOOL-REPEAT: 캐시는 현재 턴 밖으로 유지하지 않는다 — 다음 반복에서 같은 조회도 다시 실행된다', async () => {
    const r = await driveTracked([
      // 턴 1 — 동일 조회 2회(실제 실행 1회·억제 1회) 뒤 미완 보고형 중간 답 → continuation 재주입.
      [{ type: 'tool_call', id: 'a1', name: 'release_status', args: { topic: 'status' } }],
      [{ type: 'tool_call', id: 'a2', name: 'release_status', args: { topic: 'status' } }],
      [{ type: 'text', delta: INTERIM }],
      // 턴 2 — 캐시가 턴 시작 시 초기화됐으므로 같은 조회가 다시 실제 실행된다.
      [{ type: 'tool_call', id: 'b1', name: 'release_status', args: { topic: 'status' } }],
      [{ type: 'tool_call', id: 'b2', name: 'release_status', args: { topic: 'status' } }],
      [{ type: 'text', delta: S5_ANSWER }],
      [], [], [], [],
    ], S5_QUESTION, [statusTool, shellTool], (name) => 'ok');
    expect(r.result.iterations).toBe(2);
    // 턴당 실제 실행 1회씩 총 2회 — 캐시가 턴을 넘어 유지되지 않는다(억제 없으면 4회).
    expect(r.dispatchedCalls.filter((c) => c.name === 'release_status')).toHaveLength(2);
    expect(r.result.goalComplete).toBe(true);
    expect(r.result.finalText).toBe(S5_ANSWER);
  });
});
