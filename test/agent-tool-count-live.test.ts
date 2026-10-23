// 재현 — SUBAGENT-NO-NARROWING ③ 사고(10-22 · n8n 특강 세션 elanous-session-bif5y7):
// 서브에이전트 패널이 실제로 도구를 부른 자식에 «0 tools» 를 보였다.
// 기전: 패널은 task.messages 의 tool_use 만 셌고, messages 는 tool loop 가 «끝날 때»만
// 자란다(llm.ts emitTurnComplete) — 도는 동안·중단·오류로 끝난 자식은 내내 0 이었다.
import { describe, expect, test } from 'bun:test';
import { AgentRegistry } from '../src/agent/registry.js';
import { agentTaskToSurfaceState } from '../src/display/index.js';
import type { LLMProvider, LLMStreamEvent } from '../src/llm.js';

/** Turns 1..n are scripted; the turn after the script hangs until abort. */
function scriptedThenHang(turns: LLMStreamEvent[][]): LLMProvider {
  let call = 0;
  const hang = (signal?: AbortSignal) => new Promise<never>((_r, reject) => {
    const err = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (signal?.aborted) { reject(err()); return; }
    signal?.addEventListener('abort', () => reject(err()), { once: true });
  });
  const p: LLMProvider = {
    name: 'fake',
    defaultModel: 'fake-model',
    available: () => true,
    async *streamChat(_m, opts) {
      const events = turns[call++];
      if (!events) await hang(opts?.signal);
      for (const ev of events ?? []) yield ev;
    },
    async *chat(_m, opts) { await hang(opts?.signal); },
  };
  return p;
}

const historyToolUses = (messages: readonly { role: string; content: unknown }[]): number =>
  messages.filter(m => m.role === 'assistant' && Array.isArray(m.content))
    .flatMap(m => m.content as Array<{ type: string }>)
    .filter(b => b.type === 'tool_use').length;

describe('SUBAGENT-NO-NARROWING ③ incident 10-22 — panel showed «0 tools» for a child that made tool calls', () => {
  test('a running child that has made 2 tool calls shows 2, and keeps 2 after it is aborted', async () => {
    const registry = new AgentRegistry();
    const provider = scriptedThenHang([
      [{ type: 'tool_call', id: 'c1', name: 'Read', args: { path: 'a.md' } }],
      [{ type: 'tool_call', id: 'c2', name: 'ListDir', args: { path: '.' } }],
    ]);
    const { task, events } = registry.spawn({
      definition: { name: 'n8n-helper', systemPrompt: 'help', tools: ['Read', 'ListDir'] },
      prompt: 'inspect',
      tools: [
        { name: 'Read', description: '', parameters: {} },
        { name: 'ListDir', description: '', parameters: {} },
      ],
      dispatchTool: async () => ({ ok: true }),
      provider,
    });

    let results = 0;
    let midRun: { history: number; panel: number } | null = null;
    for await (const ev of events) {
      if (ev.type === 'tool_result' && ++results === 2) {
        // The incident state: history still has no tool_use (the loop has not completed).
        midRun = { history: historyToolUses(task.messages), panel: agentTaskToSurfaceState(task).toolCount };
        registry.abort(task.id);
      }
    }

    expect(midRun).toEqual({ history: 0, panel: 2 });
    expect(task.state).toBe('aborted');
    expect(historyToolUses(task.messages)).toBe(0);           // aborted → history never caught up
    expect(agentTaskToSurfaceState(task).toolCount).toBe(2);  // panel still tells the truth
  });

  test('a completed child counts each call once (live counter and history agree)', async () => {
    const registry = new AgentRegistry();
    let call = 0;
    const turns: LLMStreamEvent[][] = [
      [{ type: 'tool_call', id: 'c1', name: 'Read', args: {} }],
      [{ type: 'text', delta: 'done' }],
    ];
    const provider: LLMProvider = {
      name: 'fake', defaultModel: 'fake-model', available: () => true,
      async *streamChat() { for (const ev of turns[call++] ?? []) yield ev; },
      async *chat() { yield 'done'; },
    };
    const { task, events } = registry.spawn({
      definition: { name: 'n8n-helper', systemPrompt: 'help', tools: ['Read'] },
      prompt: 'inspect',
      tools: [{ name: 'Read', description: '', parameters: {} }],
      dispatchTool: async () => ({ ok: true }),
      provider,
    });
    for await (const _ of events) { /* drain */ }
    expect(task.state).toBe('done');
    expect(historyToolUses(task.messages)).toBe(1);
    expect(agentTaskToSurfaceState(task).toolCount).toBe(1);
  });
});
