import type { LLMToolSpec } from '../src/llm/tool-spec.js';
// ── `#7333` — 팬아웃(Agent 배치)이 «어느 진입점에서 돌든» 기록에 남는다 ──
//
// 왜 이 파일이 있나 (2026-08-24 전수):
//
//   onAgentBatchStart / Tick / End 를 «등록»하는 곳   src/skills/runner.ts  ***하나뿐***
//   streamLLMWithTools 를 «부르는» 진입점             ***10개 파일***
//     (session/chat.ts · core-turn · daemon-prompt-turn · agent/runner · acp-boot …)
//
// ⇒ 스킬 러너 «밖»에서 팬아웃하면 배치가 ***아무 기록도 안 남겼다***.
//   `agent.batch` 가 전 기간 0행이었던 이유의 절반이 이것이다.
//
// 그래서 관측을 «렌더러가 등록한 자리»에서 «사건이 일어나는 자리»(llm.ts)로 옮겼다.
// 이 시험은 그 계약을 문다: ***핸들러를 하나도 안 넘겨도 기록이 남는다.***

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { streamLLMWithTools } from '../src/llm';
import { debug } from '../src/debug/log';
import type { LLMProvider, LLMStreamEvent } from '../src/llm';

/** 한 턴에 Agent 를 N 번 부르는 provider. 두 번째 턴은 텍스트로 끝낸다. */
function fanoutProvider(n: number): LLMProvider {
  let turn = 0;
  const p = {
    name: 'fake',
    defaultModel: 'fake-model',
    available: () => true,
    async *streamChat(): AsyncGenerator<LLMStreamEvent> {
      if (turn++ === 0) {
        for (let i = 0; i < n; i += 1) {
          yield {
            type: 'tool_call',
            id: `call-${i}`,
            name: 'Agent',
            args: { description: `probe ${i}`, prompt: 'p', subagent_type: 'general-purpose' },
          } as LLMStreamEvent;
        }
        return;
      }
      yield { type: 'text', delta: 'done' } as LLMStreamEvent;
    },
  } as unknown as LLMProvider;
  return p;
}

const agentSpec: LLMToolSpec = {
  name: 'Agent',
  description: 'stub',
  parameters: { type: 'object', properties: {} },
};

beforeEach(() => { debug.enable(); debug.clear(); });
afterEach(() => { debug.disable(); });

/** `streamLLMWithTools(messages, handlers, opts)` — Promise<string> 를 돌려준다.
 *  ⛔ 제너레이터가 아니다(첫 판에 그렇게 짰다가 즉시 죽었다 — 시그니처를 «먼저» 읽었어야 했다). */
async function runTurn(n: number, handlers: Record<string, unknown> = {}): Promise<void> {
  await streamLLMWithTools(
    [{ role: 'user', content: 'go' }] as never,
    { onText: () => {}, dispatchTool: async () => 'ok', ...handlers } as never,
    { provider: fanoutProvider(n), tools: [agentSpec] } as never,
  );
}

describe('#7333 — Agent 배치가 «핸들러 없이도» 관측된다', () => {
  test('배치 둘이면 agent.batch start/end 가 남는다 — 핸들러를 «하나도» 안 넘겼는데', async () => {
    // ⛔ onAgentBatch* 를 «일부러» 안 넘긴다. 그것이 이 시험의 전부다 —
    //    종전 구현이라면 이 경로에서 배치가 통째로 안 보였다.
    await runTurn(2);
    const text = debug.tail(80).join('\n');
    expect(text).toContain('[agent.batch]');
    expect(text).toContain('start');
    expect(text).toContain('end');
  });

  test('시작 기록이 «몇 개를 · 어떤 타입으로» 띄웠는지 담는다', async () => {
    await runTurn(3);
    const start = debug.tail(80).find(l => l.includes('[agent.batch]') && l.includes('start'));
    expect(start).toBeDefined();
    // 「셋을 띄웠다」가 기록에 있어야 `A2` 의 「몇 개까지 병렬이 이득인가」를 잴 수 있다.
    expect(start!).toContain('"total":3');
    expect(start!).toContain('general-purpose');
    expect(start!).toContain('probe 0');
  });

  test('끝 기록이 «걸린 시간»을 담는다 — 그것이 이득을 재는 최소 재료다', async () => {
    await runTurn(2);
    const end = debug.tail(80).find(l => l.includes('[agent.batch]') && l.includes('end'));
    expect(end).toBeDefined();
    expect(end!).toContain('batchElapsedMs');
  });

  test('⛔ Agent 가 «하나»면 배치가 아니다 — 기록도 없다', async () => {
    // `isParallelBatch` 는 `agentIndices.length >= 2` 다. 하나짜리를 배치로 세면
    // 「팬아웃했다」는 수가 조용히 부풀고, 그 수로 이득을 재면 결론이 틀린다.
    await runTurn(1);
    expect(debug.tail(80).join('\n')).not.toContain('[agent.batch]');
  });
});
