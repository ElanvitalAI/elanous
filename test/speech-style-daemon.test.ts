// TUI-SPEECH-STYLE-DAEMON — 완료 경계 «실물» 시험(신설 경로).
// 앞선 조각 실패: pod-job-failed — childStage=aborted · reason=수렴 못 함(단계 aborted).
// 고정 입력(fake 하위 단계 실행기 ⊕ fake clock ⊕ abortPollMs 1)으로 bridgeCoreTurnToAcp 가
// 강제 첫 단계 abort 후 «정확히 1회» 재시도하고 원래 완료 경계(턴 완료·최종 답 surfacing)를
// 보존함을 확인한다. 실물 CLI 를 spawn 하지 않는다(가짜 단계 실행기 경계).
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as core from '../src/core-turn/index.js';
import * as config from '../src/user-config.js';
import { debug } from '../src/debug/log.js';
import { bridgeCoreTurnToAcp } from '../src/acp/core-turn-bridge.js';
import type { CoreTurnContext } from '../src/core-turn/index.js';
import type { LLMMessage } from '../src/llm.js';
import type { AcpTurnContext } from '../src/acp/server.js';

const search = { name: 'WebSearch', description: '', parameters: { type: 'object' as const } };
const fixedInput = '수렴 실패 시나리오 고정 입력';

function turnCtx(sessionId: string, isAborted: () => boolean, pushes: string[]): AcpTurnContext {
  return {
    sessionId, cwd: '/tmp', userText: fixedInput,
    promptBlocks: [{ type: 'text', text: fixedInput }], isAborted,
    push: async (delta: string) => { pushes.push(delta); },
    pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
    pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
  } as unknown as AcpTurnContext;
}

function fixedConfig() {
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base, llm: { ...base.llm, model: 'gpt-4o-mini', goalLoop: { enabled: false } },
  });
}

afterEach(() => mock.restore());

test('강제 첫 단계 abort → 자동 수복 1회 → 원래 완료 경계 보존', async () => {
  fixedConfig();
  const log = spyOn(debug, 'log');
  let ticks = 0;
  const now = () => { ticks += 1; return 1_000_000 + ticks; };
  const stageStarts: number[] = [];
  const attempts: CoreTurnContext[] = [];
  const completed: LLMMessage[][] = [];
  const pushes: string[] = [];
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx) => {
    stageStarts.push(now());
    attempts.push(ctx);
    if (attempts.length === 1) return { stopReason: 'aborted', finalText: '' };
    await ctx.callbacks?.onTurnComplete?.([{ role: 'assistant', content: '재시도 후 최종 답' }]);
    return { stopReason: 'end_turn', finalText: '재시도 후 최종 답' };
  });
  await bridgeCoreTurnToAcp({
    abortPollMs: 1,
    getMessages: () => [{ role: 'user', content: fixedInput }],
    getTools: () => [search],
    dispatchTool: async () => ({}),
    onTurnComplete: ({ newMessages }) => { completed.push(newMessages); },
  })(turnCtx('speech-style-1', () => false, pushes));
  // 정확히 1회 재시도(총 2단계) — 0회·2회 재시도는 모두 여기서 실패한다.
  expect(attempts).toHaveLength(2);
  expect(stageStarts).toHaveLength(2);
  // 완료 경계 보존 — 턴 완료는 복구된 시도에서 «한 번»만 지속되고 최종 답이 표면화된다.
  expect(completed).toEqual([[{ role: 'assistant', content: '재시도 후 최종 답' }]]);
  expect(pushes).toEqual(['', '재시도 후 최종 답']);
  expect(log).toHaveBeenCalledWith('acp.turn', 'autoheal-retry', expect.objectContaining({ sessionId: 'speech-style-1', attempt: 2 }));
}, 10_000);

test('사용자 중단(isAborted)은 자동 수복 대상이 아니다 — 재시도 0회', async () => {
  fixedConfig();
  const attempts: CoreTurnContext[] = [];
  const pushes: string[] = [];
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx) => {
    attempts.push(ctx);
    return { stopReason: 'aborted', finalText: '' };
  });
  await bridgeCoreTurnToAcp({
    abortPollMs: 1,
    getMessages: () => [{ role: 'user', content: fixedInput }],
    getTools: () => [search],
    dispatchTool: async () => ({}),
  })(turnCtx('speech-style-cancel', () => true, pushes));
  expect(attempts).toHaveLength(1);
  expect(pushes).toEqual([]);
}, 10_000);
