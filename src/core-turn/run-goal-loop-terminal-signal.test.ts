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

function scriptedProvider(turns: LLMStreamEvent[][], name = 'scripted'): { provider: LLMProvider; callsSeen: () => number; toolCounts: number[] } {
  let call = 0;
  const toolCounts: number[] = [];
  const p: LLMProvider = {
    name,
    defaultModel: 'd',
    available: () => true,
    async *streamChat(_messages, opts) {
      toolCounts.push(opts?.tools?.length ?? 0);
      for (const ev of turns[call++] ?? []) yield ev;
    },
    async *chat() {},
  };
  return { provider: p, callsSeen: () => call, toolCounts };
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

async function drive(dropTerminal: boolean, turns: LLMStreamEvent[][] = ANSWER_THEN_SIGNAL, providerName = 'scripted', maxTurns = 10, userText = '우편 확인하고 대조해') {
  const { provider, callsSeen, toolCounts } = scriptedProvider(turns, providerName);
  const seenTerminal: Array<readonly string[] | undefined> = [];
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers, opts = {}) => {
    seenTerminal.push(opts.terminalToolNames);
    const { terminalToolNames, ...rest } = opts;
    return realStream(messages, handlers, {
      ...rest,
      ...(dropTerminal ? {} : terminalToolNames !== undefined ? { terminalToolNames } : {}),
      provider,
      maxTurns,
    });
  });
  const shown: string[] = [];
  const ctx: CoreTurnContext = {
    sessionId: 'goal-friction',
    messages: [{ role: 'user', content: userText } as LLMMessage],
    userText,
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
  return { result, calls: callsSeen(), toolCounts, seenTerminal, shown: shown.join('') };
}

describe('goal loop terminal signal wiring (TUI-GOAL-LOOP-FRICTION)', () => {
  test('research tool round followed by an explicit structured final answer does not launch another investigation', async () => {
    const answer = '# HBM4 조사 결과\n\n## 근거\n' + '실측 자료와 출처를 대조했습니다. '.repeat(100)
      + '\n\n## 결론\n검증된 수치를 요약하고 남은 불확실성을 표시했습니다.';
    const r = await drive(false, [
      [{ type: 'tool_call', id: 'research-1', name: 'RunShell', args: {} }],
      [{ type: 'text', phase: 'final', delta: answer }, { type: 'turn_end', endTurn: true }],
      [{ type: 'tool_call', id: 'unwanted', name: 'RunShell', args: {} }],
    ], 'openai-codex', 10, 'HBM4 최신 자료를 조사하고 근거와 결론을 분석해줘');
    expect(r.calls).toBe(2);
    expect(r.result).toMatchObject({ finalText: answer, stopReason: 'goal_complete', goalComplete: true, iterations: 1 });
  });

  test('a short final-phase progress note still requires the goal completion signal', async () => {
    const r = await drive(false, [
      [{ type: 'tool_call', id: 'research-1', name: 'RunShell', args: {} }],
      [{ type: 'text', phase: 'final', delta: '자료를 확인했습니다. 이어서 분석하겠습니다.' }],
      [{ type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: '분석 완료' } }],
      [{ type: 'text', delta: ANSWER }],
    ], 'openai-codex');
    expect(r.calls).toBeGreaterThan(2);
    expect(r.result).toMatchObject({ stopReason: 'goal_complete', goalComplete: true, iterations: 2 });
  });
  test('Codex end_turn:false continues a text-only response and replays its phase', async () => {
    const seen: LLMMessage[][] = [];
    let calls = 0;
    const provider: LLMProvider = {
      name: 'openai-codex', defaultModel: 'gpt-6-sol', available: () => true,
      async *streamChat(messages) {
        seen.push([...messages]);
        if (calls++ === 0) {
          yield { type: 'text', phase: 'commentary', delta: 'I am checking.' } as LLMStreamEvent;
          yield { type: 'turn_end', endTurn: false } as LLMStreamEvent;
        } else {
          yield { type: 'text', phase: 'final', delta: ANSWER } as LLMStreamEvent;
          yield { type: 'turn_end', endTurn: true } as LLMStreamEvent;
        }
      },
      async *chat() {},
    };
    const result = await realStream([{ role: 'user', content: 'check' }], { onText: () => {}, dispatchTool: async () => ({}) }, {
      provider, tools: [], maxTurns: 1,
    });
    expect(calls).toBe(2);
    expect(result).toBe(ANSWER);
    expect(seen[1]).toContainEqual({ role: 'assistant', content: 'I am checking.', phase: 'commentary' });
  });

  test('Codex never treats a second end_turn:false response as final', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      name: 'openai-codex', defaultModel: 'gpt-6-sol', available: () => true,
      async *streamChat() {
        calls++;
        yield { type: 'text', phase: 'commentary', delta: 'Still checking.' } as LLMStreamEvent;
        yield { type: 'turn_end', endTurn: false } as LLMStreamEvent;
      },
      async *chat() {},
    };
    const result = await realStream([{ role: 'user', content: 'check' }], {
      onText: () => {}, dispatchTool: async () => ({}),
    }, { provider, tools: [], maxTurns: 1 });
    expect(calls).toBe(2);
    expect(result).toContain('[NO FINAL SYNTHESIS]');
  });

  test('answer ⊕ update_goal(complete) → one model call, goal complete, the answer once, no internal notice', async () => {
    const r = await drive(false);
    expect(r.seenTerminal[0]).toContain('update_goal');
    expect(r.calls).toBe(1);
    expect(r.result).toMatchObject({ stopReason: 'goal_complete', goalComplete: true, iterations: 1 });
    expect(r.result.finalText).toBe(ANSWER);
    expect(r.result.finalText).not.toContain('[NO FINAL SYNTHESIS]');
    expect(r.shown).toBe(ANSWER);
  });

  test('completion without current or prior visible answer gets another provider response', async () => {
    const turns: LLMStreamEvent[][] = [
      [{ type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: '실측 완료' } }],
      [{ type: 'text', delta: ANSWER }],
    ];
    const r = await drive(false, turns);
    expect(r.result).toMatchObject({ stopReason: 'goal_complete', goalComplete: true, iterations: 1 });
    expect(r.calls).toBe(2);
    expect(r.shown).toBe(ANSWER);
    expect(r.result.finalText).toBe(ANSWER);
  });

  test('Codex completion with progress text waits for a final answer turn', async () => {
    const progress = '자료를 확인했습니다. 이제 최종 답변을 작성하겠습니다.';
    const turns: LLMStreamEvent[][] = [
      [
        { type: 'text', delta: progress },
        { type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: '자료 확인 완료' } },
      ],
      [{ type: 'text', delta: ANSWER }],
    ];
    const r = await drive(false, turns, 'openai-codex');
    expect(r.calls).toBe(2);
    expect(r.toolCounts).toEqual([expect.any(Number), 0]);
    expect(r.result).toMatchObject({ stopReason: 'goal_complete', goalComplete: true, iterations: 1 });
    expect(r.result.finalText).toBe(ANSWER);
  });

  test('Opus-style final answer before completion keeps the one-call path', async () => {
    const r = await drive(false, ANSWER_THEN_SIGNAL, 'anthropic');
    expect(r.calls).toBe(1);
    expect(r.result.finalText).toBe(ANSWER);
  });

  test('commentary phase before completion needs synthesis for any provider', async () => {
    const r = await drive(false, [
      [
        { type: 'text', phase: 'commentary', delta: 'Source check complete.' },
        { type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: 'source checked' } },
      ],
      [{ type: 'text', phase: 'final', delta: ANSWER }],
    ], 'anthropic');
    expect(r.calls).toBe(2);
    expect(r.result.finalText).toBe(ANSWER);
  });

  test('explicit final phase keeps one call even when final text contains future tense', async () => {
    const final = '계약상 다음 주에 배송하겠습니다.';
    const r = await drive(false, [[
      { type: 'text', phase: 'final', delta: final },
      { type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: '계약 확인' } },
    ]], 'anthropic');
    expect(r.calls).toBe(1);
    expect(r.result.finalText).toBe(final);
  });

  test('completion progress on the last allowed turn still receives one final synthesis call', async () => {
    const r = await drive(false, [
      [
        { type: 'text', delta: '이제 답변하겠습니다.' },
        { type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: '검증 완료' } },
      ],
      [{ type: 'text', delta: ANSWER }],
    ], 'openai-codex', 1);
    expect(r.calls).toBe(2);
    expect(r.result.finalText).toBe(ANSWER);
  });

  test('Codex retries an empty response after completion instead of accepting progress', async () => {
    const progress = '이제 최종 답변을 작성하겠습니다.';
    const r = await drive(false, [
      [
        { type: 'text', delta: progress },
        { type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: '검증 완료' } },
      ],
      [],
      [{ type: 'text', delta: ANSWER }],
    ], 'openai-codex');
    expect(r.calls).toBe(3);
    expect(r.result.finalText).toBe(ANSWER);
  });

  test('prior answer ⊕ completion with readback preface and novel detail: suppress repeat, preserve suffix', async () => {
    const ADDENDUM = ' 확인된 추가 사실.';
    const READBACK = `다시 확인: ${ANSWER}${ADDENDUM}`;
    const turns: LLMStreamEvent[][] = [
      [{ type: 'tool_call', id: 'work', name: 'RunShell', args: {} }],
      [{ type: 'text', delta: ANSWER }],
      [
        { type: 'text', delta: READBACK },
        { type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: '실측 결과 확인' } },
      ],
      [{ type: 'text', delta: 'unexpected provider request' }],
    ];
    const r = await drive(false, turns);
    expect(r.result).toMatchObject({ stopReason: 'goal_complete', goalComplete: true, iterations: 2 });
    expect(r.calls).toBe(3);
    expect(r.shown).toBe(ANSWER + ADDENDUM);
    expect(r.result.finalText).toContain(ADDENDUM);
    expect(r.result.finalText).toBe(READBACK);
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
    // 이전 답은 completion transcript에 보존하면서 완료 ack 뒤 provider 재호출은 하지 않는다.
    expect(r.calls).toBe(3);
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
