// TUI-GOAL-LOOP-FRICTION(#46·#63) — 종결 신호 도구(`LLMOpts.terminalToolNames`).
//
// ① 도구 예산이 다 된 «합성 단계»에서도 종결 신호(update_goal)는 «TOOL CALL REJECTED» 를 받지 않는다
//    (거부되면 모델이 둘째 답 ⊕ 사과를 쓴다 — #46).
// ② 답 ⊕ 종결 신호뿐인 턴이면 다음 모델 턴을 열지 않는다 — 빈 턴 반복 → `[NO FINAL SYNTHESIS]`(#63) 차단.
// ③ 종결 신호 뒤 빈 턴이면 이미 쓴 답으로 끝낸다(내부 문구 0).
// 반증: 같은 대본을 terminalToolNames 없이 돌리면 종전 결함(빈 턴 → [NO FINAL SYNTHESIS] · 거부 스텁)이 그대로 난다.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCoreTurn } from '../src/core-turn/run-core-turn.js';
import { runGoalLoop } from '../src/core-turn/run-goal-loop.js';
import { testFakeLlmProvider, TEST_FAKE_LLM_CAPTURE_ENV, TEST_FAKE_LLM_ENV, TEST_FAKE_LLM_TOOL_CALL_ENV } from '../src/ux-sim/fake-llm.js';
import { streamLLMWithTools } from '../src/llm';
import type { LLMMessage, LLMProvider, LLMStreamEvent } from '../src/llm';

function scriptedProvider(turns: LLMStreamEvent[][]): { provider: LLMProvider; callsSeen: () => number } {
  let call = 0;
  const p: LLMProvider = {
    name: 'scripted',
    defaultModel: 'd',
    available: () => true,
    async *streamChat() {
      const events = turns[call++] ?? [];
      for (const ev of events) yield ev;
    },
    async *chat() {},
  };
  return { provider: p, callsSeen: () => call };
}

const TOOLS = [
  { name: 'X', description: 'd', parameters: { type: 'object' } },
  { name: 'update_goal', description: 'terminal', parameters: { type: 'object' } },
];
const ANSWER = '대조 완료 — 남은 조치 0건입니다.';
const COMPLETE = { status: 'complete', evidence: 'eln msg list 출력 확인' };

function toolResults(messages: LLMMessage[], name: string): string[] {
  const ids = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.name === name) ids.add(b.id);
      if (b.type === 'tool_result' && ids.has(b.tool_use_id)) {
        out.push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
      }
    }
  }
  return out;
}

async function run(turns: LLMStreamEvent[][], terminal: boolean, maxTurns = 10, priorAnswerVisible = false) {
  const { provider, callsSeen } = scriptedProvider(turns);
  const dispatched: string[] = [];
  const shown: string[] = [];
  let newMessages: LLMMessage[] = [];
  const result = await streamLLMWithTools(
    [{ role: 'user', content: '우편 확인하고 대조해' }],
    {
      onText: (delta: string, full: string) => { shown.push(`${delta}|${full}`); },
      dispatchTool: async (name: string) => { dispatched.push(name); return name === 'update_goal' ? { ok: true } : 'tool-out'; },
      onTurnComplete: (msgs: LLMMessage[]) => { newMessages = msgs; },
    },
    {
      provider, tools: TOOLS, maxTurns,
      ...(terminal ? { terminalToolNames: ['update_goal'] } : {}),
      ...(priorAnswerVisible ? { terminalPriorAnswerVisible: true } : {}),
    },
  );
  return { result, calls: callsSeen(), dispatched, newMessages, shown };
}

test('fake-llm production path: goal completion ends the CoreTurn provider loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-complete-fake-llm-'));
  const capture = join(dir, 'provider-requests.jsonl');
  const env = [TEST_FAKE_LLM_ENV, TEST_FAKE_LLM_TOOL_CALL_ENV, TEST_FAKE_LLM_CAPTURE_ENV,
    'ELANOUS_TEST_FAKE_LLM_RESPONSE', 'ELANOUS_TEST_FAKE_LLM_AS_PROVIDER'] as const;
  const prior = env.map((key) => process.env[key]);
  try {
    process.env[TEST_FAKE_LLM_ENV] = '1';
    process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE = ANSWER;
    process.env.ELANOUS_TEST_FAKE_LLM_AS_PROVIDER = '1';
    process.env[TEST_FAKE_LLM_CAPTURE_ENV] = capture;
    process.env[TEST_FAKE_LLM_TOOL_CALL_ENV] = JSON.stringify({
      when: 'finish fixture', name: 'update_goal',
      args: { status: 'complete', evidence: 'fixture checked' },
    });
    const result = await runGoalLoop({
      sessionId: `goal-complete-fixture-${Date.now()}`,
      messages: [{ role: 'user', content: 'finish fixture' }],
      tools: [], dispatchTool: async () => { throw new Error('update_goal must be handled by goal loop'); },
      signal: new AbortController().signal,
      initialProvider: testFakeLlmProvider,
    }, { maxIterations: 2, runTurn: runCoreTurn, changedFiles: () => [] });
    const requests = readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(result.stopReason).toBe('goal_complete');
    expect(result.goalComplete).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.finalText).toBe(ANSWER);
    // The first request emits update_goal; its acknowledged tool result is
    // visible in the second request, whose answer becomes finalText. No third
    // provider call is needed after completion is accepted.
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0]?.messages)).not.toContain('tool_result');
    expect(JSON.stringify(requests[1]?.messages)).toContain('tool_result');
    expect(JSON.stringify(requests[1]?.messages)).toContain('update_goal');
  } finally {
    for (let index = 0; index < env.length; index++) {
      const value = prior[index];
      if (value === undefined) delete process.env[env[index]];
      else process.env[env[index]] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('streamLLMWithTools — terminal signal tools (TUI-GOAL-LOOP-FRICTION)', () => {
  test('answer ⊕ update_goal in one turn ends the stream — no extra model turn, no [NO FINAL SYNTHESIS]', async () => {
    const script: LLMStreamEvent[][] = [
      [
        { type: 'text', delta: ANSWER },
        { type: 'tool_call', id: 'g1', name: 'update_goal', args: COMPLETE },
      ],
      [], [], [],
    ];
    const r = await run(script, true);
    expect(r.calls).toBe(1);
    expect(r.result).toBe(ANSWER);
    expect(r.result).not.toContain('[NO FINAL SYNTHESIS]');
    expect(r.dispatched).toEqual(['update_goal']);
    // 원장(이력)에 신호 호출 ⊕ 결과 ⊕ 답이 남는다 — goal loop 가 완료 신호를 읽는다.
    expect(toolResults(r.newMessages, 'update_goal')).toHaveLength(1);
    const last = r.newMessages[r.newMessages.length - 1]!;
    expect(last.role).toBe('assistant');
  });

  test('반증 — without terminalToolNames the same script opens empty turns and appends [NO FINAL SYNTHESIS]', async () => {
    const script: LLMStreamEvent[][] = [
      [
        { type: 'text', delta: ANSWER },
        { type: 'tool_call', id: 'g1', name: 'update_goal', args: COMPLETE },
      ],
      [], [], [],
    ];
    const r = await run(script, false);
    expect(r.calls).toBeGreaterThan(1);
    expect(r.result).toContain('[NO FINAL SYNTHESIS]');
  });

  test('budget exhausted (synthesis phase) — update_goal is dispatched, not rejected, and the answer stands', async () => {
    // maxTurns 10 ⇒ turn 8·9 = 합성 단계(도구 통째 거부). turn 8 에 답 ⊕ 완료 신호.
    const work = Array.from({ length: 8 }, (_, i): LLMStreamEvent[] => [{ type: 'tool_call', id: `x${i}`, name: 'X', args: { i } }]);
    const script: LLMStreamEvent[][] = [
      ...work,
      [
        { type: 'text', delta: ANSWER },
        { type: 'tool_call', id: 'g1', name: 'update_goal', args: COMPLETE },
      ],
      [{ type: 'text', delta: '앞선 완료 주장이 거부됐습니다. 죄송합니다. ' + ANSWER }],
    ];
    const r = await run(script, true);
    expect(r.calls).toBe(9);
    expect(r.result).toBe(ANSWER);
    expect(r.result).not.toContain('죄송');
    expect(r.dispatched.filter((n) => n === 'update_goal')).toHaveLength(1);
    const results = toolResults(r.newMessages, 'update_goal');
    expect(results).toHaveLength(1);
    expect(results[0]).not.toContain('TOOL CALL REJECTED');
  });

  test('반증 — without terminalToolNames the budget phase rejects update_goal and a second (apology) answer follows', async () => {
    const work = Array.from({ length: 8 }, (_, i): LLMStreamEvent[] => [{ type: 'tool_call', id: `x${i}`, name: 'X', args: { i } }]);
    const script: LLMStreamEvent[][] = [
      ...work,
      [
        { type: 'text', delta: ANSWER },
        { type: 'tool_call', id: 'g1', name: 'update_goal', args: COMPLETE },
      ],
      [{ type: 'text', delta: '앞선 완료 주장이 거부됐습니다. 죄송합니다. ' + ANSWER }],
    ];
    const r = await run(script, false);
    expect(r.dispatched).not.toContain('update_goal');
    expect(toolResults(r.newMessages, 'update_goal')[0]).toContain('TOOL CALL REJECTED');
    expect(r.result).toContain('죄송');
  });

  test('mixed batch in the budget phase — other tools are rejected, update_goal gets an ack (not a rejection)', async () => {
    const work = Array.from({ length: 8 }, (_, i): LLMStreamEvent[] => [{ type: 'tool_call', id: `x${i}`, name: 'X', args: { i } }]);
    const script: LLMStreamEvent[][] = [
      ...work,
      [
        { type: 'tool_call', id: 'x9', name: 'X', args: { more: true } },
        { type: 'tool_call', id: 'g1', name: 'update_goal', args: COMPLETE },
      ],
      [{ type: 'text', delta: ANSWER }],
    ];
    const r = await run(script, true);
    expect(r.result).toBe(ANSWER);
    const x9Use = r.newMessages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((block) => block.type === 'tool_use' && block.id === 'x9');
    const x9Result = r.newMessages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((block) => block.type === 'tool_result' && block.tool_use_id === 'x9');
    expect(x9Use).toBeDefined();
    expect(x9Result).toBeDefined();
    expect(x9Result?.type === 'tool_result' ? x9Result.content : '').toContain('TOOL CALL REJECTED');
    const ack = toolResults(r.newMessages, 'update_goal');
    expect(ack).toHaveLength(1);
    expect(ack[0]).not.toContain('TOOL CALL REJECTED');
    expect(ack[0]).toContain('terminalSignal');
  });

  test('same-round failed tool result and accepted completion acknowledgment are both preserved', async () => {
    const { provider, callsSeen } = scriptedProvider([
      [
        { type: 'text', delta: ANSWER },
        { type: 'tool_call', id: 'x1', name: 'X', args: {} },
        { type: 'tool_call', id: 'g1', name: 'update_goal', args: COMPLETE },
      ],
      [{ type: 'text', delta: '도구 실패를 확인하고 최종 답변을 이어갑니다.' }],
    ]);
    let messages: LLMMessage[] = [];
    const result = await streamLLMWithTools([{ role: 'user', content: 'finish' }], {
      onText: () => {},
      dispatchTool: async (name) => name === 'X' ? { ok: false, error: 'denied' } : { ok: true },
      onTurnComplete: (value) => { messages = value; },
    }, {
      provider, tools: TOOLS, terminalToolNames: ['update_goal'],
      terminalCompletionAccepted: (name, args) => name === 'update_goal'
        && args.status === 'complete' && typeof args.evidence === 'string',
    });
    // A dispatched tool error is fail-closed; the accepted completion cannot
    // mask it or trigger another provider turn.
    expect(callsSeen()).toBe(1);
    expect(result).not.toContain('최종 답변');
    expect(result).toBe(ANSWER);
    expect(toolResults(messages, 'X')).toHaveLength(1);
    expect(toolResults(messages, 'X')[0]).toContain('denied');
    expect(toolResults(messages, 'update_goal')).toEqual(['{"ok":true}']);
  });

  test('accepted completion after a visible prior answer still streams new text', async () => {
    const { provider, callsSeen } = scriptedProvider([[
      { type: 'tool_call', id: 'g1', name: 'update_goal', args: COMPLETE },
      { type: 'text', delta: 'Additional verified detail.' },
    ]]);
    const shown: Array<{ delta: string; full: string }> = [];
    let messages: LLMMessage[] = [];
    const result = await streamLLMWithTools([{ role: 'user', content: 'finish' }], {
      onText: (delta, full) => shown.push({ delta, full }),
      dispatchTool: async () => ({ ok: true }),
      onTurnComplete: (value) => { messages = value; },
    }, {
      provider, tools: TOOLS, maxTurns: 10, terminalToolNames: ['update_goal'],
      terminalPriorAnswerVisible: true,
      terminalCompletionAccepted: (name, args) => name === 'update_goal'
        && args.status === 'complete' && typeof args.evidence === 'string' && args.evidence.trim().length > 0,
    });
    expect(callsSeen()).toBe(1);
    expect(result).toBe('Additional verified detail.');
    expect(shown.some(({ delta }) => delta === 'Additional verified detail.')).toBe(true);
    expect(toolResults(messages, 'update_goal')).toHaveLength(1);
  });

  test('accepted completion after a visible prior answer stops without re-emitting that answer', async () => {
    const { provider, callsSeen } = scriptedProvider([
      [{ type: 'tool_call', id: 'g1', name: 'update_goal', args: COMPLETE }],
      [{ type: 'text', delta: 'unexpected extra answer' }],
    ]);
    const shown: Array<{ delta: string; full: string }> = [];
    let messages: LLMMessage[] = [];
    const priorMessages: LLMMessage[] = [
      { role: 'user', content: 'finish' },
      { role: 'assistant', content: [{ type: 'text', text: ANSWER }] },
    ];
    const result = await streamLLMWithTools(priorMessages, {
      onText: (delta, full) => shown.push({ delta, full }),
      dispatchTool: async () => ({ ok: true }),
      onTurnComplete: (value) => { messages = value; },
    }, {
      provider, tools: TOOLS, maxTurns: 10,
      terminalToolNames: ['update_goal'],
      terminalPriorAnswerVisible: true,
      terminalCompletionAccepted: (name, args) => name === 'update_goal'
        && args.status === 'complete' && typeof args.evidence === 'string' && args.evidence.trim().length > 0,
    });
    expect(callsSeen()).toBe(1);
    expect(result).toBe('');
    expect(shown).toEqual([]);
    expect(toolResults(messages, 'update_goal')).toHaveLength(1);
    expect(messages.at(-1)?.role).toBe('user');
    // The visible answer is caller-owned history and must remain there exactly
    // once; the tool-result-only completion must not invent a second answer.
    // Prior assistant answer is still represented exactly once across the
    // caller-owned input history and the newly completed tool-result history.
    const combinedHistory = [...priorMessages, ...messages];
    expect(combinedHistory.filter((message) => message.role === 'assistant'
      && Array.isArray(message.content)
      && message.content.some((block) => block.type === 'text' && block.text === ANSWER))).toHaveLength(1);
    expect(messages.filter((message) => message.role === 'assistant'
      && Array.isArray(message.content)
      && message.content.some((block) => block.type === 'text' && block.text === ANSWER))).toHaveLength(0);
  });

  test('accepted completion-only call without a visible answer requests a final answer and preserves tool results', async () => {
    const { provider, callsSeen } = scriptedProvider([
      [{ type: 'tool_call', id: 'g1', name: 'update_goal', args: COMPLETE }],
      [{ type: 'text', delta: ANSWER }],
    ]);
    let messages: LLMMessage[] = [];
    const result = await streamLLMWithTools([{ role: 'user', content: 'finish' }], {
      onText: () => {},
      dispatchTool: async () => ({ ok: true }),
      onTurnComplete: (value) => { messages = value; },
    }, {
      provider, tools: TOOLS, maxTurns: 10,
      terminalToolNames: ['update_goal'],
      terminalCompletionAccepted: (name, args) => name === 'update_goal'
        && args.status === 'complete' && typeof args.evidence === 'string' && args.evidence.trim().length > 0,
    });
    expect(callsSeen()).toBe(2);
    expect(result).toBe(ANSWER);
    expect(toolResults(messages, 'update_goal')).toHaveLength(1);
    expect(messages.at(-1)?.role).toBe('assistant');
    expect(messages.at(-1)?.content).toEqual([{ type: 'text', text: ANSWER }]);
  });

  test('signal-only turn without text opens the next turn so the model can write the answer', async () => {
    const script: LLMStreamEvent[][] = [
      [{ type: 'tool_call', id: 'x0', name: 'X', args: {} }],
      [{ type: 'tool_call', id: 'g1', name: 'update_goal', args: COMPLETE }],
      [{ type: 'text', delta: ANSWER }],
    ];
    const r = await run(script, true);
    expect(r.calls).toBe(3);
    expect(r.result).toBe(ANSWER);
  });

  test('evidence-less completion keeps the answer turn instead of short-circuiting', async () => {
    const { provider, callsSeen } = scriptedProvider([
      [{ type: 'tool_call', id: 'g1', name: 'update_goal', args: { status: 'complete', evidence: '   ' } }],
      [{ type: 'text', delta: ANSWER }],
    ]);
    const result = await streamLLMWithTools([{ role: 'user', content: 'finish' }], {
      onText: () => {}, dispatchTool: async () => ({ ok: true }),
    }, {
      provider, tools: TOOLS, maxTurns: 10, terminalToolNames: ['update_goal'],
      terminalCompletionAccepted: (_name, args) => args.status === 'complete'
        && typeof args.evidence === 'string' && args.evidence.trim().length > 0,
    });
    expect(callsSeen()).toBe(2);
    expect(result).toBe(ANSWER);
  });

  test('empty turns after the signal end with the answer already written — no retries, no internal notice', async () => {
    const script: LLMStreamEvent[][] = [
      [
        { type: 'text', delta: ANSWER },
        { type: 'tool_call', id: 'x0', name: 'X', args: {} },
      ],
      [{ type: 'tool_call', id: 'g1', name: 'update_goal', args: COMPLETE }],
      [], [], [],
    ];
    const r = await run(script, true);
    expect(r.calls).toBe(3);
    expect(r.result).toBe(ANSWER);
    expect(r.result).not.toContain('[NO FINAL SYNTHESIS]');
  });

  test('mixed turn (answer ⊕ work tool ⊕ update_goal, normal dispatch) then empty turns → ends with that answer', async () => {
    const script: LLMStreamEvent[][] = [
      [
        { type: 'text', delta: ANSWER },
        { type: 'tool_call', id: 'x0', name: 'X', args: {} },
        { type: 'tool_call', id: 'g1', name: 'update_goal', args: COMPLETE },
      ],
      [], [], [],
    ];
    const r = await run(script, true);
    expect(r.dispatched).toEqual(['X', 'update_goal']);
    expect(r.calls).toBe(2);
    expect(r.result).toBe(ANSWER);
    expect(r.result).not.toContain('[NO FINAL SYNTHESIS]');
  });

  test('without any written answer the empty-turn guard is unchanged (real no-synthesis still surfaces)', async () => {
    const script: LLMStreamEvent[][] = [
      [{ type: 'tool_call', id: 'g1', name: 'update_goal', args: COMPLETE }],
      [], [], [],
    ];
    const r = await run(script, true);
    expect(r.result).toContain('[NO FINAL SYNTHESIS]');
  });

  // TUI-H1-GOALLOOP-EMPTY-TAIL — 답이 이 스트림 «앞»(goal loop 앞 iteration)에 이미 보였으면 신호뿐인 턴 뒤 빈 턴은
  //   재촉·경고 없이 빈 답으로 끝난다 — 화면도 건드리지 않는다(빈 onText 0). 반증 = 위 시험(앞 답이 없으면 경고 유지).
  test('signal-only turn after an answer the caller already showed → empty result, no retry, no notice, no screen write', async () => {
    const script: LLMStreamEvent[][] = [
      [{ type: 'tool_call', id: 'g1', name: 'update_goal', args: COMPLETE }],
      [], [], [],
    ];
    const r = await run(script, true, 10, true);
    expect(r.calls).toBe(2);
    expect(r.result).toBe('');
    expect(r.shown).toEqual([]);
    expect(r.dispatched).toEqual(['update_goal']);
    // 이력에 신호 호출은 남고(goal loop 가 complete 를 읽는다) 빈 답 메시지는 안 실린다.
    expect(toolResults(r.newMessages, 'update_goal')).toHaveLength(1);
    expect(r.newMessages.at(-1)?.role).not.toBe('assistant');
  });

  test('prior-answer hint alone does not silence a real empty stall without a terminal signal', async () => {
    const script: LLMStreamEvent[][] = [
      [{ type: 'tool_call', id: 'x1', name: 'X', args: {} }],
      [], [], [],
    ];
    const r = await run(script, true, 10, true);
    expect(r.result).toContain('[NO FINAL SYNTHESIS]');
  });
});
