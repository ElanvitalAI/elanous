// TUI-RECOVER-SKIPS-CREDITS(0.2.36 · OP P0 · 10-22) — 이력·도구 결과에 섞인 잘린 이모지(짝 없는 서로게이트)가
// 공급자 본문 JSON 을 깨 매 턴 400(grok «unexpected end of hex escape» · codex Bad Request)으로 죽었다.
// 배선 시험: 실제 streamLLMWithTools 가 공급자에게 «정리된» 이력을 넘기는가(도구 결과로 루프 중 들어온 것까지).
import { afterEach, describe, expect, test } from 'bun:test';
import { streamLLMWithTools } from '../src/llm';
import type { LLMMessage, LLMProvider, LLMStreamEvent } from '../src/llm';
import { debug } from '../src/debug/log.js';
import { __resetSnapshotStore, __resetTurnState } from '../src/undo-turn/index.js';
import { resetPlanModeState } from '../src/plan-mode/index.js';

afterEach(() => { __resetSnapshotStore(); __resetTurnState(); resetPlanModeState(); });

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const half = '촬영 🎬'.slice(0, -1);

describe('streamLLMWithTools — 짝 없는 서로게이트는 공급자에게 가지 않는다', () => {
  test('사용자 이력 ⊕ 루프 중 도구 결과의 반토막 모두 U+FFFD 로 · 관측 이벤트', async () => {
    const seen: string[] = [];
    let call = 0;
    const turns: LLMStreamEvent[][] = [
      [{ type: 'tool_call', id: 'a', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'text', delta: 'done' }],
    ];
    const provider: LLMProvider = {
      name: 'scripted', defaultModel: 'd', available: () => true,
      async *streamChat(messages: LLMMessage[]) {
        seen.push(JSON.stringify(messages));
        for (const ev of turns[call++] ?? []) yield ev;
      },
      async *chat() {},
    };
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    debug.log = ((category: string, event: string, data: Record<string, unknown>) => {
      if (category === 'llm.request') events.push({ event, data });
    }) as typeof debug.log;
    try {
      await streamLLMWithTools(
        [{ role: 'user', content: `이어서 ${half}` }],
        { onText: () => {}, dispatchTool: async () => `미리보기 ${half}` },
        { provider, model: 'd', tools: [{ name: 'Bash', description: 'd', parameters: { type: 'object' } }], maxTurns: 4 },
      );
    } finally {
      debug.log = original;
    }
    expect(seen.length).toBe(2);
    for (const body of seen) {
      expect(LONE.test(JSON.parse(body).map((m: LLMMessage) => JSON.stringify(m.content)).join(''))).toBe(false);
      expect(body).not.toMatch(/\\ud83c(?!\\udf)/i);
    }
    expect(seen[0]).toContain('이어서 촬영 \uFFFD');
    expect(seen[1]).toContain('미리보기 촬영 \uFFFD');
    const fixed = events.filter((e) => e.event === 'lone-surrogate-fixed');
    expect(fixed.length).toBeGreaterThanOrEqual(2);
    expect(fixed[0]!.data).toMatchObject({ site: 'tool-loop', provider: 'scripted' });
  });
});
