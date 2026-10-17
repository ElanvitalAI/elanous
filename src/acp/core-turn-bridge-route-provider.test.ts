// TUI-MODEL-BADGE-ACTUAL (10-16) — ACP 사용량 봉투가 «실제로 응답한» 공급자·모델을 싣는다.
// 폴백 체인이 codex → grok 으로 넘기면 streamLLMWithTools 가 onResolvedProvider 를 다시 부른다(llm.ts 스트림 재개점).
// 다리(core-turn-bridge)는 그 마지막 값을 사용량에 실어, 대시보드 완료 배지가 폴백을 «A → B» 로 보이게 한다
// (상태줄·/model 판독기 교체는 후속 TUI-MODEL-BADGE-SOURCE).
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as core from '../core-turn/index.js';
import * as config from '../user-config.js';
import type { CoreTurnContext } from '../core-turn/index.js';
import type { AcpTurnContext } from './server.js';
import { bridgeCoreTurnToAcp } from './core-turn-bridge.js';

afterEach(() => mock.restore());

async function runWith(drive: (ctx: CoreTurnContext) => void): Promise<Array<Record<string, unknown>>> {
  const usages: Array<Record<string, unknown>> = [];
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base, llm: { ...base.llm, provider: 'openai-codex', model: 'gpt-cfg', goalLoop: { enabled: false } },
  });
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx) => {
    drive(ctx);
    return { stopReason: 'end_turn', finalText: '' };
  });
  const runTurn = bridgeCoreTurnToAcp({
    getMessages: () => [{ role: 'user', content: '이 버그를 고쳐줘' }],
    getTools: () => [],
    dispatchTool: async () => ({}),
    onTurnComplete: () => {},
    resolveModel: () => 'gpt-6-sol',
  });
  await runTurn({
    sessionId: 'route-provider', cwd: '/tmp', userText: '이 버그를 고쳐줘',
    promptBlocks: [{ type: 'text', text: '이 버그를 고쳐줘' }], isAborted: () => false,
    push: async () => {}, pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
    pushToolCall: async () => {}, pushToolResult: async () => {},
    pushUsage: async (u: Record<string, unknown>) => { usages.push(u); },
    requestApproval: async () => 'deny-once' as const,
  } as unknown as AcpTurnContext);
  return usages;
}

test('폴백으로 grok 이 응답하면 사용량에 grok 공급자·모델이 실린다', async () => {
  const usages = await runWith((ctx) => {
    ctx.callbacks?.onResolvedProvider?.('openai-codex', 'gpt-6-sol');
    ctx.callbacks?.onResolvedProvider?.('grok', 'grok-4.3');
    ctx.callbacks?.onUsage?.({ inputTokens: 10, outputTokens: 2 });
  });
  expect(usages).toEqual([{ inputTokens: 10, outputTokens: 2, model: 'grok-4.3', routeProvider: 'grok' }]);
});

test('반증: 공급자 해석 신호가 없으면 종전대로 턴 모델만 싣고 routeProvider 를 꾸미지 않는다', async () => {
  const usages = await runWith((ctx) => {
    ctx.callbacks?.onUsage?.({ inputTokens: 1 });
  });
  expect(usages).toEqual([{ inputTokens: 1, model: 'gpt-6-sol' }]);
});

test('공급자가 보고한 모델이 있으면 그것이 먼저다', async () => {
  const usages = await runWith((ctx) => {
    ctx.callbacks?.onResolvedProvider?.('grok', 'grok-4.3');
    ctx.callbacks?.onUsage?.({ inputTokens: 1, model: 'grok-4.3-0910' });
  });
  expect(usages).toEqual([{ inputTokens: 1, model: 'grok-4.3-0910', routeProvider: 'grok' }]);
});
