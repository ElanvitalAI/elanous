// ACP 브리지의 «턴 마감» 표면 — #22 401 조용한 완료 · #25 최종 답 2회 렌더 ⊕ goal loop 내부 판정 노출.
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as core from '../core-turn/index.js';
import * as llm from '../llm.js';
import type { LLMMessage, LLMProvider, LLMStreamEvent } from '../llm.js';
import * as config from '../user-config.js';
import { debug } from '../debug/log.js';
import type { CoreTurnContext } from '../core-turn/index.js';
import type { AcpTurnContext } from './server.js';
import { bridgeCoreTurnToAcp, extractLastAssistantText } from './core-turn-bridge.js';
import { AUTH_REJECTED_NOTICE, CoreTurnAuthRejectedError } from '../core-turn/auth-rejected-notice.js';

afterEach(() => mock.restore());

const SUPPLEMENT = '변경 파일: /tmp/a.ts\n검증 최신성 상태: 미지 — 재검증이 필요합니다.\n루프 마감 상태: 최근 수정 이후 재검증이 아직 필요하므로 close-out보다 검증 재실행이 맞습니다.';

function setup(opts: { goalLoop?: boolean } = {}) {
  const pushes: string[] = [];
  const persisted: LLMMessage[][] = [];
  const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  // 호출을 엿보되 실제 log 경로(저장 전 다듬기·ring)는 그대로 돈다.
  const realLog = debug.log.bind(debug);
  spyOn(debug, 'log').mockImplementation((category, event, data, opts) => {
    events.push({ category, event, data: (data ?? {}) as Record<string, unknown> });
    realLog(category, event, data, opts);
  });
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base,
    llm: { ...base.llm, provider: 'openai', model: 'gpt-5.6', fallbackChain: [], goalLoop: { enabled: opts.goalLoop === true } },
    chat: { ...base.chat, autoCompact: { ...base.chat.autoCompact, enabled: false } },
    tools: { ...base.tools, deferred: { ...base.tools.deferred, mode: 'off' } },
  });
  const runTurn = bridgeCoreTurnToAcp({
    getMessages: () => [{ role: 'user', content: 'fix it' }],
    getTools: () => [
      { name: 'Edit', description: 'd', parameters: { type: 'object' } },
      { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
    ],
    dispatchTool: async (name) => name === 'RunShell'
      ? { output: 'PASS test/a.test.ts', stdout: 'PASS test/a.test.ts', exitCode: 0, outcome: 'exit' }
      : { output: 'edited /tmp/a.ts' },
    onTurnComplete: ({ newMessages }) => { persisted.push(newMessages); },
  });
  const turn = {
    sessionId: 'turn-end', cwd: '/tmp', userText: 'fix it', promptBlocks: [{ type: 'text', text: 'fix it' }],
    isAborted: () => false,
    push: async (delta: string) => { pushes.push(delta); },
    pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
    pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
    requestApproval: async () => 'allow-once' as const,
  } as unknown as AcpTurnContext;
  return { run: () => runTurn(turn), pushes, persisted, events };
}

function assistant(text: string): LLMMessage[] {
  return [{ role: 'assistant', content: [{ type: 'text', text }] }];
}

test('#25 스트리밍된 답 ⊕ 검증 보충 — 답은 한 번만, 보충은 화면 0 · 로그 1 · 이력엔 남는다', async () => {
  const f = setup();
  const finalText = `답 단락입니다.\n\n${SUPPLEMENT}`;
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx: CoreTurnContext) => {
    ctx.callbacks?.onText?.('답 단락', '답 단락');
    ctx.callbacks?.onText?.('입니다.', '답 단락입니다.');
    ctx.callbacks?.onFinalAnswerSupplement?.({ answer: '답 단락입니다.', supplement: SUPPLEMENT, finalText });
    ctx.callbacks?.onText?.('', finalText);
    await ctx.callbacks?.onTurnComplete?.(assistant(finalText));
    return { stopReason: 'end_turn', finalText };
  });
  await f.run();
  expect(f.pushes).toEqual(['답 단락', '입니다.']);
  expect(f.pushes.join('')).not.toContain('루프 마감 상태');
  expect(extractLastAssistantText(f.persisted[0]!)).toBe(finalText);
  const withheld = f.events.filter((e) => e.event === 'final-supplement-withheld');
  expect(withheld).toHaveLength(1);
  expect(withheld[0]!.data).toMatchObject({ answerStreamed: true, supplementChars: SUPPLEMENT.length, part: 1, parts: 1, supplement: SUPPLEMENT });
});

test('#25 긴 보충도 로그에 «전체»가 남는다 — 저장된 기록(ring)을 조각 순서로 다시 이어 끝까지', async () => {
  const f = setup();
  // 실제 저장 경로를 태운다(문자열 상한 다듬기 포함) — 싱크 관문만 연다.
  spyOn(debug, 'isAnySinkEnabled').mockReturnValue(true);
  const since = new Date().toISOString();
  const long = `${'검증 흐름 '.repeat(300)}끝-표지`;
  const finalText = `답.\n\n${long}`;
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx: CoreTurnContext) => {
    ctx.callbacks?.onText?.('답.', '답.');
    ctx.callbacks?.onFinalAnswerSupplement?.({ answer: '답.', supplement: long, finalText });
    ctx.callbacks?.onText?.('', finalText);
    await ctx.callbacks?.onTurnComplete?.(assistant(finalText));
    return { stopReason: 'end_turn', finalText };
  });
  await f.run();
  expect(f.pushes).toEqual(['답.']);
  const stored = debug.events(10_000)
    .filter((e) => e.category === 'acp.turn' && e.event === 'final-supplement-withheld' && e.ts >= since)
    .map((e) => e.data as { part: number; parts: number; supplement: string; supplementChars: number })
    .filter((d) => d.supplementChars === long.length);
  expect(stored.length).toBeGreaterThan(2);
  expect(stored.every((d) => d.parts === stored.length)).toBe(true);
  const rebuilt = [...stored].sort((a, b) => a.part - b.part).map((d) => d.supplement).join('');
  expect(rebuilt).toBe(long);
  expect(rebuilt).toEndWith('끝-표지');
});

test('#25 답이 실시간으로 안 흘렀으면 답만 한 번 다시 낸다(보충 0)', async () => {
  const f = setup();
  const finalText = `답.\n\n${SUPPLEMENT}`;
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx: CoreTurnContext) => {
    ctx.callbacks?.onFinalAnswerSupplement?.({ answer: '답.', supplement: SUPPLEMENT, finalText });
    ctx.callbacks?.onText?.('', finalText);
    await ctx.callbacks?.onTurnComplete?.(assistant(finalText));
    return { stopReason: 'end_turn', finalText };
  });
  await f.run();
  expect(f.pushes).toEqual(['', '답.']);
});

test('#25 보충이 없는 강제 종합 교체는 종전대로 다시 낸다', async () => {
  const f = setup();
  spyOn(core, 'runCoreTurn').mockImplementation(async (ctx: CoreTurnContext) => {
    ctx.callbacks?.onText?.('탐색 중…', '탐색 중…');
    ctx.callbacks?.onText?.('', '종합 답');
    await ctx.callbacks?.onTurnComplete?.(assistant('종합 답'));
    return { stopReason: 'end_turn', finalText: '종합 답' };
  });
  await f.run();
  expect(f.pushes).toEqual(['탐색 중…', '', '', '종합 답']);
});

test('#25 실물 코어 턴(편집→검증→답) — ACP 로는 모델 답만 한 번, 내부 판정 문구 0', async () => {
  const f = setup();
  const turns: LLMStreamEvent[][] = [
    [{ type: 'tool_call', id: 'e', name: 'Edit', args: { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' } }],
    [{ type: 'tool_call', id: 'v', name: 'RunShell', args: { command: ['bun', 'test', 'test/a.test.ts'] } }],
    [{ type: 'text', delta: '대조 완료 — 고쳤고 시험도 통과했습니다.' }],
  ];
  let call = 0;
  const provider: LLMProvider = {
    name: 'turn-end-provider', defaultModel: 'gpt-5.6', available: () => true,
    chat: async function* () {},
    streamChat: async function* () { for (const ev of turns[call++] ?? []) yield ev; },
  };
  spyOn(llm, 'resolveDefaultProvider').mockReturnValue(provider);
  await f.run();
  const shown = f.pushes.join('');
  expect(shown.split('대조 완료').length - 1).toBe(1);
  for (const internal of ['루프 마감 상태', '검증 최신성 상태', '최근 검증 명령', '변경 파일:']) {
    expect(shown).not.toContain(internal);
  }
  const saved = extractLastAssistantText(f.persisted.at(-1)!) ?? '';
  expect(saved).toContain('대조 완료');
  expect(saved).toContain('변경 파일: /tmp/a.ts');
  const withheld = f.events.filter((e) => e.event === 'final-supplement-withheld');
  expect(withheld.filter((e) => e.data['part'] === 1)).toHaveLength(1);
  expect(withheld.map((e) => String(e.data['supplement'])).join('')).toContain('변경 파일: /tmp/a.ts');
}, 30_000);

test('#22 auth_rejected 결과 — 브리지가 처방 오류를 던지고 관측 1건을 남긴다', async () => {
  const f = setup();
  spyOn(core, 'runCoreTurn').mockResolvedValue({
    stopReason: 'auth_rejected', finalText: '', errorMessage: 'Codex API 401: {"detail":"Unauthorized"}',
  });
  const error = await f.run().then(() => null, (err: unknown) => err);
  expect(error).toBeInstanceOf(CoreTurnAuthRejectedError);
  expect((error as Error).message).toBe(`${AUTH_REJECTED_NOTICE} · 원문: Codex API 401: {"detail":"Unauthorized"}`);
  const observed = f.events.filter((e) => e.category === 'acp.turn' && e.event === 'auth-rejected');
  expect(observed).toHaveLength(1);
  expect(observed[0]!.data).toMatchObject({ sessionId: 'turn-end', goalLoop: false });
});

test('#22 goal loop 아밍 상태의 실물 401 도 처방 오류로 끝난다(«완료» 아님)', async () => {
  const f = setup({ goalLoop: true });
  const provider: LLMProvider = {
    name: 'auth-provider', defaultModel: 'gpt-5.6', available: () => true,
    chat: async function* () {},
    // eslint-disable-next-line require-yield
    streamChat: async function* () { throw Object.assign(new Error('LLM API 401: invalid or expired credential'), { status: 401 }); },
  };
  spyOn(llm, 'resolveDefaultProvider').mockReturnValue(provider);
  const error = await f.run().then(() => null, (err: unknown) => err);
  expect(error).toBeInstanceOf(CoreTurnAuthRejectedError);
  expect((error as Error).message).toStartWith(AUTH_REJECTED_NOTICE);
  expect((error as Error).message).not.toContain('\n');
}, 30_000);

test('정상 end_turn 은 던지지 않는다', async () => {
  const f = setup();
  spyOn(core, 'runCoreTurn').mockResolvedValue({ stopReason: 'end_turn', finalText: '' });
  await expect(f.run()).resolves.toBeUndefined();
  expect(f.events.some((e) => e.event === 'auth-rejected')).toBe(false);
});

test('#22 처방 줄은 원문의 단독 CR·ESC 제어 문자로 깨지지 않는다', () => {
  const message = new CoreTurnAuthRejectedError('LLM API 401: bad\rkey \u001b[2Jcleared\u0007 tail\nsecond line').message;
  expect(message).toStartWith(AUTH_REJECTED_NOTICE);
  expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  expect(message).toContain('원문: LLM API 401: bad');
  expect(message).not.toContain('second line');
  const esc = new CoreTurnAuthRejectedError('LLM API 401: \u001b[2Jbad\u0007 key').message;
  expect(esc).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  expect(esc).toContain('[2Jbad');
});
