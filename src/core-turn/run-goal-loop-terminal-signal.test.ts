// TUI-GOAL-LOOP-FRICTION(#25·#46·#63) — goal loop → runCoreTurn → streamLLMWithTools 배선.
// goal loop 가 update_goal 을 «종결 신호»로 넘기고(runCoreTurn 이 그대로 전달), 그래서
//   · 답 ⊕ update_goal(complete) 한 턴이면 모델 호출 1회로 끝난다(빈 턴 0 · [NO FINAL SYNTHESIS] 0)
//   · 같은 답이 두 번 나오지 않는다.
// 반증: runCoreTurn 이 terminalToolNames 를 떨구면(종전) 빈 턴 반복 → [NO FINAL SYNTHESIS] 가 붙는다.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as debugModule from '../debug/log.js';
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

const ANSWER_THEN_SIGNAL: LLMStreamEvent[][] = [
  [
    { type: 'text', delta: ANSWER },
    { type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: 'eln msg list 출력 확인' } },
  ],
  [], [], [], [], [], [], [],
];

async function drive(dropTerminal: boolean, turns: LLMStreamEvent[][] = ANSWER_THEN_SIGNAL) {
  const { provider, callsSeen } = scriptedProvider(turns);
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

// TUI-H1-GOALLOOP-EMPTY-TAIL — 자리 TUI 재점검 표본(10-17 00:12Z · 3턴 중 3): Bash → «끝»(신호 없음) → 재주입 →
//   update_goal(complete) «만» → 빈 턴 → 빈 턴 재촉 둘 → «I could not finish… [NO FINAL SYNTHESIS]» 가 답 뒤에 붙었다.
//   답은 앞 iteration 에 이미 화면에 있다 — 종결 신호 뒤 빈 턴은 재촉·경고 없이 끝나고 골 루프가 앞 답으로 마감한다.
describe('goal loop empty tail after a signal-only iteration (TUI-H1-GOALLOOP-EMPTY-TAIL)', () => {
  const SHORT = '끝';
  const BASH_THEN_ANSWER_THEN_SIGNAL: LLMStreamEvent[][] = [
    [{ type: 'tool_call', id: 'b1', name: 'RunShell', args: { command: 'sleep 3' } }],
    [{ type: 'text', delta: SHORT }],
    [{ type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: 'sleep 3 exitCode=0' } }],
    [], [], [], [], [], [], [],
  ];

  function captureVerdicts() {
    const verdicts: Array<Record<string, unknown>> = [];
    const realLog = debugModule.debug.log.bind(debugModule.debug);
    spyOn(debugModule.debug, 'log').mockImplementation(((category: string, event: string, data?: unknown, ...rest: unknown[]) => {
      if (category === 'goal.loop' && event === 'completion-verdict') verdicts.push(data as Record<string, unknown>);
      return (realLog as (...args: unknown[]) => unknown)(category, event, data, ...rest);
    }) as typeof debugModule.debug.log);
    return verdicts;
  }

  test('complete 뒤 빈 응답 → 경고 문면 0 · 앞 답으로 정상 완료 · 빈 턴 재촉 0', async () => {
    const verdicts = captureVerdicts();
    const r = await drive(false, BASH_THEN_ANSWER_THEN_SIGNAL);
    expect(r.result).toMatchObject({ stopReason: 'goal_complete', goalComplete: true, iterations: 2 });
    expect(r.result.finalText).toBe(SHORT);
    expect(r.result.finalText).not.toContain('[NO FINAL SYNTHESIS]');
    expect(r.shown).toBe(SHORT);
    expect(r.shown).not.toContain('could not finish');
    // iteration 1 = RunShell 턴 ⊕ 답 턴 · iteration 2 = 신호 턴 ⊕ 빈 턴 하나(재촉 없이 끝).
    expect(r.calls).toBe(4);
    expect(verdicts).toEqual([expect.objectContaining({ reason: 'goal-complete', stopReason: 'goal_complete' })]);
  });

  test('신호 없는 진짜 빈 응답 → 기존 경고 유지 · 완료 판정 none', async () => {
    const verdicts = captureVerdicts();
    const r = await drive(false, [
      [{ type: 'tool_call', id: 'b1', name: 'RunShell', args: { command: 'sleep 3' } }],
      [], [], [], [], [], [], [], [], [], [], [], [], [],
    ]);
    expect(r.result.goalComplete).toBe(false);
    expect(r.result.finalText).toContain('[NO FINAL SYNTHESIS]');
    expect(verdicts).toEqual([expect.objectContaining({ reason: 'none' })]);
  });
});
