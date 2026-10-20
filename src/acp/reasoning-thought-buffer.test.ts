import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as core from '../core-turn/index.js';
import * as config from '../user-config.js';
import type { AcpTurnContext } from './server.js';
import { bridgeCoreTurnToAcp } from './core-turn-bridge.js';
import { createReasoningThoughtBuffer } from './reasoning-thought-buffer.js';

afterEach(() => mock.restore());

test('델타를 문단 단위로 모아 낸다 — 다음 문단·flush 에서만 한 줄', () => {
  const out: string[] = [];
  const buf = createReasoningThoughtBuffer((t) => out.push(t));
  buf.onEvent({ kind: 'summary_part_added', summaryIndex: 0 });
  buf.onEvent({ kind: 'summary_delta', delta: '**Inspecting ', summaryIndex: 0 });
  buf.onEvent({ kind: 'summary_delta', delta: 'files**', summaryIndex: 0 });
  expect(out).toEqual([]);
  buf.onEvent({ kind: 'summary_part_added', summaryIndex: 1 });
  expect(out).toEqual(['**Inspecting files**']);
  buf.onEvent({ kind: 'summary_delta', delta: '  ', summaryIndex: 1 });
  buf.flush();
  expect(out).toEqual(['**Inspecting files**']); // 공백뿐인 문단은 내지 않는다
});

test('폭주 방어 — 400자를 넘으면 자른다', () => {
  const out: string[] = [];
  const buf = createReasoningThoughtBuffer((t) => out.push(t));
  buf.onEvent({ kind: 'summary_delta', delta: 'x'.repeat(1000) });
  buf.flush();
  expect(out[0]!.length).toBe(401);
  expect(out[0]!.endsWith('…')).toBe(true);
});

test('모으는 단계에서도 상한 — 델타가 수천 번 와도 낸 줄은 401자', () => {
  const out: string[] = [];
  const buf = createReasoningThoughtBuffer((t) => out.push(t));
  for (let i = 0; i < 5000; i++) buf.onEvent({ kind: 'summary_delta', delta: 'abcdefghij' });
  buf.flush();
  expect(out).toHaveLength(1);
  expect(out[0]!.length).toBe(401);
});

test('다리 배선 — 추론 요약이 도구 호출 «전»에 agent_thought_chunk(_meta.reasoning) 로 나간다', async () => {
  const events: string[] = [];
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base, llm: { ...base.llm, model: 'gpt-4o-mini', goalLoop: { enabled: false } },
  });
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx) => {
    const cb = ctx.callbacks!;
    cb.onReasoning?.({ kind: 'summary_part_added', summaryIndex: 0 });
    cb.onReasoning?.({ kind: 'summary_delta', delta: 'Checking the folder', summaryIndex: 0 });
    cb.onToolCall?.({ id: 't1', name: 'ListDir', args: {} });
    cb.onReasoning?.({ kind: 'summary_delta', delta: 'Summarizing', summaryIndex: 1 });
    cb.onText?.('답', '답');
    return { stopReason: 'end_turn', finalText: '답' };
  });
  const runTurn = bridgeCoreTurnToAcp({
    getMessages: () => [{ role: 'system', content: 'base' }, { role: 'user', content: '폴더 봐 줘' }],
    getTools: () => [],
    dispatchTool: async () => ({}),
  });
  const turn = {
    sessionId: 'thought-test', cwd: '/tmp', userText: '폴더 봐 줘',
    promptBlocks: [{ type: 'text', text: '폴더 봐 줘' }], isAborted: () => false,
    push: async (d: string) => { events.push(`text:${d}`); },
    pushWithMeta: async () => {},
    pushSessionUpdate: async (u: Record<string, unknown>, meta?: Record<string, unknown>) => {
      const c = u.content as { text?: string } | undefined;
      events.push(`${String(u.sessionUpdate)}:${c?.text ?? ''}:${meta?.reasoning === true ? 'R' : '-'}`);
    },
    pushToolCall: async (c: { name: string }) => { events.push(`tool:${c.name}`); },
    pushToolResult: async () => {}, pushUsage: async () => {},
    requestApproval: async () => 'deny-once' as const,
  } as unknown as AcpTurnContext;
  await runTurn(turn);
  const thoughtThenTool = events.indexOf('agent_thought_chunk:Checking the folder:R');
  expect(thoughtThenTool).toBeGreaterThanOrEqual(0);
  expect(thoughtThenTool).toBeLessThan(events.indexOf('tool:ListDir'));
  const second = events.indexOf('agent_thought_chunk:Summarizing:R');
  expect(second).toBeGreaterThanOrEqual(0);
  expect(second).toBeLessThan(events.indexOf('text:답'));
});

test('턴이 오류로 끝나도 마지막 추론 문단은 나간다 (FU-1)', async () => {
  const thoughts: string[] = [];
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base, llm: { ...base.llm, model: 'gpt-4o-mini', goalLoop: { enabled: false } },
  });
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx) => {
    ctx.callbacks!.onReasoning?.({ kind: 'summary_delta', delta: 'Half-finished thought', summaryIndex: 0 });
    throw new Error('stream aborted');
  });
  const runTurn = bridgeCoreTurnToAcp({
    getMessages: () => [{ role: 'system', content: 'base' }, { role: 'user', content: 'x' }],
    getTools: () => [],
    dispatchTool: async () => ({}),
  });
  const turn = {
    sessionId: 'thought-err', cwd: '/tmp', userText: 'x',
    promptBlocks: [{ type: 'text', text: 'x' }], isAborted: () => false,
    push: async () => {}, pushWithMeta: async () => {},
    pushSessionUpdate: async (u: Record<string, unknown>, meta?: Record<string, unknown>) => {
      if (u.sessionUpdate === 'agent_thought_chunk' && meta?.reasoning === true) {
        thoughts.push((u.content as { text: string }).text);
      }
    },
    pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
    requestApproval: async () => 'deny-once' as const,
  } as unknown as AcpTurnContext;
  // FU-4(#28966 리뷰): flush 가 오류를 삼키지 않는다 — 오류는 그대로 위로 간다.
  await expect(runTurn(turn)).rejects.toThrow('stream aborted');
  expect(thoughts).toEqual(['Half-finished thought']);
});

test('정상 종료는 문단을 «한 번만» 낸다 — onTurnComplete flush 뒤 finally flush 는 빈 버퍼 (FU-4)', async () => {
  const thoughts: string[] = [];
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base, llm: { ...base.llm, model: 'gpt-4o-mini', goalLoop: { enabled: false } },
  });
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx) => {
    ctx.callbacks!.onReasoning?.({ kind: 'summary_delta', delta: 'Only once', summaryIndex: 0 });
    await ctx.callbacks!.onTurnComplete?.([{ role: 'assistant', content: '답' }]);
    return { stopReason: 'end_turn', finalText: '답' };
  });
  const runTurn = bridgeCoreTurnToAcp({
    getMessages: () => [{ role: 'system', content: 'base' }, { role: 'user', content: 'x' }],
    getTools: () => [],
    dispatchTool: async () => ({}),
  });
  const turn = {
    sessionId: 'thought-once', cwd: '/tmp', userText: 'x',
    promptBlocks: [{ type: 'text', text: 'x' }], isAborted: () => false,
    push: async () => {}, pushWithMeta: async () => {},
    pushSessionUpdate: async (u: Record<string, unknown>, meta?: Record<string, unknown>) => {
      if (u.sessionUpdate === 'agent_thought_chunk' && meta?.reasoning === true) {
        thoughts.push((u.content as { text: string }).text);
      }
    },
    pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
    requestApproval: async () => 'deny-once' as const,
  } as unknown as AcpTurnContext;
  await runTurn(turn);
  expect(thoughts).toEqual(['Only once']);
});
