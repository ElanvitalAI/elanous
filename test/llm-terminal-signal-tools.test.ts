// TUI-GOAL-LOOP-FRICTION(#46·#63) — 종결 신호 도구(`LLMOpts.terminalToolNames`).
//
// ① 도구 예산이 다 된 «합성 단계»에서도 종결 신호(update_goal)는 «TOOL CALL REJECTED» 를 받지 않는다
//    (거부되면 모델이 둘째 답 ⊕ 사과를 쓴다 — #46).
// ② 답 ⊕ 종결 신호뿐인 턴이면 다음 모델 턴을 열지 않는다 — 빈 턴 반복 → `[NO FINAL SYNTHESIS]`(#63) 차단.
// ③ 종결 신호 뒤 빈 턴이면 이미 쓴 답으로 끝낸다(내부 문구 0).
// 반증: 같은 대본을 terminalToolNames 없이 돌리면 종전 결함(빈 턴 → [NO FINAL SYNTHESIS] · 거부 스텁)이 그대로 난다.

import { describe, expect, test } from 'bun:test';
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

async function run(turns: LLMStreamEvent[][], terminal: boolean, maxTurns = 10) {
  const { provider, callsSeen } = scriptedProvider(turns);
  const dispatched: string[] = [];
  let newMessages: LLMMessage[] = [];
  const result = await streamLLMWithTools(
    [{ role: 'user', content: '우편 확인하고 대조해' }],
    {
      onText: () => {},
      dispatchTool: async (name: string) => { dispatched.push(name); return name === 'update_goal' ? { ok: true } : 'tool-out'; },
      onTurnComplete: (msgs: LLMMessage[]) => { newMessages = msgs; },
    },
    { provider, tools: TOOLS, maxTurns, ...(terminal ? { terminalToolNames: ['update_goal'] } : {}) },
  );
  return { result, calls: callsSeen(), dispatched, newMessages };
}

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
    expect(toolResults(r.newMessages, 'X').at(-1)).toContain('TOOL CALL REJECTED');
    const ack = toolResults(r.newMessages, 'update_goal');
    expect(ack).toHaveLength(1);
    expect(ack[0]).not.toContain('TOOL CALL REJECTED');
    expect(ack[0]).toContain('terminalSignal');
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
});
