// TUI-ESC-ABORT-TOOLS (2026-10-15) — 턴 중단(Esc)이 걸리면 한 바퀴의 도구 «묶음» 안에서
// 남은 호출을 새로 시작하지 않는다. 시작하지 않은 호출은 «중단됨» 결과로 채워
// tool_call/tool_result 짝을 지키고, 다음 바퀴 머리의 abort 검사가 루프를 멈춘다.

import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import { streamLLMWithTools } from '../src/llm';
import type { LLMProvider, LLMStreamEvent } from '../src/llm';
import { debug } from '../src/debug/log.js';
import { __resetSnapshotStore, __resetTurnState } from '../src/undo-turn/index.js';
import { resetPlanModeState } from '../src/plan-mode/index.js';

afterEach(() => {
  __resetSnapshotStore();
  __resetTurnState();
  resetPlanModeState();
});

function scriptedProvider(turns: LLMStreamEvent[][]): LLMProvider & { calls: () => number } {
  let call = 0;
  return {
    name: 'scripted', defaultModel: 'd', available: () => true,
    async *streamChat() { for (const ev of turns[call++] ?? []) yield ev; },
    async *chat() {},
    calls: () => call,
  };
}

describe('streamLLMWithTools — abort inside a tool batch', () => {
  test('abort during the first of three sequential calls skips the rest and stops the loop', async () => {
    const spy = spyOn(debug, 'log');
    try {
      const provider = scriptedProvider([
        [
          { type: 'tool_call', id: 'a', name: 'Bash', args: { command: 'one' } },
          { type: 'tool_call', id: 'b', name: 'Bash', args: { command: 'two' } },
          { type: 'tool_call', id: 'c', name: 'Bash', args: { command: 'three' } },
        ],
        [{ type: 'text', delta: 'should not be reached' }],
      ]);
      const controller = new AbortController();
      const dispatched: string[] = [];
      const captured: Array<Array<{ role: string; content: unknown }>> = [];
      await streamLLMWithTools(
        [{ role: 'user', content: 'q' }],
        {
          onText: () => {},
          onToolResult: () => {},
          onTurnComplete: (msgs) => { captured.push(msgs as Array<{ role: string; content: unknown }>); },
          dispatchTool: async (_name, args) => {
            dispatched.push(String((args as { command?: unknown }).command));
            controller.abort();
            return 'ok';
          },
        },
        {
          provider,
          model: 'gpt-5.4',
          tools: [{ name: 'Bash', description: 'd', parameters: { type: 'object' } }],
          maxTurns: 4,
          signal: controller.signal,
        },
      );
      expect(dispatched).toEqual(['one']);
      // 다음 모델 요청을 만들지 않는다 — 바퀴 머리의 abort 검사가 멈춘다.
      expect(provider.calls()).toBe(1);
      const skipped = spy.mock.calls.filter((c) => c[0] === 'llm.tools.aborted' && c[1] === 'batch-remaining-skipped');
      expect(skipped.length).toBe(1);
      expect((skipped[0]![2] as { skipped: number }).skipped).toBe(2);
      // ⭐ 짝 유지 — 실제 LLM 경로가 쌓은 이력에서 a·b·c 의 tool_use 마다 ID 가 맞는 tool_result 가
      //    정확히 하나씩 있고, 시작하지 않은 b·c 는 «중단됨» 결과다.
      expect(captured.length).toBe(1);
      const blocks = captured[0]!.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as Array<Record<string, unknown>>;
      const toolUseIds = blocks.filter((b) => b.type === 'tool_use').map((b) => b.id);
      expect(toolUseIds).toEqual(['a', 'b', 'c']);
      const results = blocks.filter((b) => b.type === 'tool_result');
      expect(results.map((b) => b.tool_use_id)).toEqual(['a', 'b', 'c']);
      const byId = new Map(results.map((b) => [b.tool_use_id, b]));
      expect(String(byId.get('a')!.content)).toContain('ok');
      for (const id of ['b', 'c']) {
        expect(String(byId.get(id)!.content)).toContain('aborted by the user');
        expect(byId.get(id)!.isError).toBe(true);
      }
    } finally { spy.mockRestore(); }
  });
});
