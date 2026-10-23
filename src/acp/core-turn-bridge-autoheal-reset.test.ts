// TUI-400-AUTOHEAL-FALLBACK ② r3 리뷰 — «마지막에 실제로 답한 공급자» 기억은 «그 턴» 의 것이어야 한다.
// 앞 턴이 폴백으로 grok 이 답했어도, 다음 «새» 턴의 ② 제외 목록에 grok 이 남아 있으면
// 쓸 수 있는 대체 공급자를 빼 버려 «대체 공급자 없음» 으로 끝난다.
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as core from '../core-turn/index.js';
import * as llm from '../llm.js';
import * as config from '../user-config.js';
import type { CoreTurnContext } from '../core-turn/index.js';
import type { AcpTurnContext } from './server.js';
import { bridgeCoreTurnToAcp } from './core-turn-bridge.js';
import { autohealProviderFallbackMeta } from '../self-health/autoheal.js';

afterEach(() => mock.restore());

function turn(meta?: Record<string, unknown>): AcpTurnContext {
  return {
    sessionId: 'autoheal-reset', cwd: '/tmp', userText: '이 버그를 고쳐줘',
    promptBlocks: [{ type: 'text', text: '이 버그를 고쳐줘' }], promptMeta: meta, isAborted: () => false,
    push: async () => {}, pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
    pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
    requestApproval: async () => 'deny-once' as const,
  } as unknown as AcpTurnContext;
}

test('a fresh turn forgets the previous turn\'s resolved provider before ② picks the next one', async () => {
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base, llm: { ...base.llm, provider: 'openai-codex', model: 'gpt-cfg', goalLoop: { enabled: false } },
  });
  // 새 턴의 시도들은 공급자 해석 신호를 내기 «전에» 400 으로 끝난다(null = 신호 없음).
  const answered: Array<string | null> = ['grok', null, null];
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx: CoreTurnContext) => {
    const provider = answered.shift() ?? null;
    if (provider) ctx.callbacks?.onResolvedProvider?.(provider, 'm');
    return { stopReason: 'end_turn', finalText: '' };
  });
  // 환경 독립: gate 는 ELANOUS_TEST_FAKE_LLM=1 이라 기본 공급자가 fake 로 풀린다 — 이 시험이 보는 것은 «기억» 이지 해석이 아니다.
  spyOn(llm, 'resolveDefaultProvider').mockReturnValue({ name: 'openai-codex' } as ReturnType<typeof llm.resolveDefaultProvider>);
  const skipped: string[][] = [];
  spyOn(llm, 'nextTurnFallbackProvider').mockImplementation((failed: readonly string[]) => {
    skipped.push([...failed]);
    return undefined;
  });
  const runTurn = bridgeCoreTurnToAcp({
    getMessages: () => [{ role: 'user', content: '이 버그를 고쳐줘' }],
    getTools: () => [], dispatchTool: async () => ({}), onTurnComplete: () => {},
    resolveModel: () => 'gpt-6-sol', tuiRouting: true,
  });
  await runTurn(turn());                                   // 앞 턴: 폴백으로 grok 이 답했다
  await runTurn(turn());                                   // 새 턴: 신호 전 400 (TUI 쪽 ① 재시도)
  await runTurn(turn(autohealProviderFallbackMeta()));     // 같은 턴의 ② — 다음 공급자 요청
  expect(skipped).toHaveLength(1);
  expect(skipped[0]).not.toContain('grok');
  expect(skipped[0]).toContain('openai-codex');
});
