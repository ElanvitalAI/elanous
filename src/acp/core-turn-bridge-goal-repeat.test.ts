// TUI-GOAL-REPEAT-ANSWER(0.2.32) 칸 판정 시험 — goal loop 반복에서 모델이 같은 답을
// 다시 말할 때 화면(스트림 push)에 최종 답이 정확히 한 번만 그려지는가.
//
// 왜 이 파일이 판정선인가: 칸 대상 경로는 src/acp/core-turn-bridge.ts(화면 push 의
// 소유자·runGoalLoop 의 호출자)와 src/core-turn/run-goal-loop.ts(중복 렌더의 소유자)다.
// 이 파일은 브리지의 실물 실행 경로(bridgeCoreTurnToAcp → runGoalLoop → runCoreTurn →
// llm.streamChatWithTools)를 가짜 provider 로 두 iteration 돌아 화면 push 를 관측한다 —
// 골 루프만의 고립 단위가 아니라 칸 문면의 판정선(화면 중복)을 실제 호출 경로로 증명한다.
// 골 문서: 내부 문서 `ASK-TUI-GOAL-REPEAT-ANSWER-2026-10-14`(가지 opc/tui-turn-end-followups
// 02a7af2) · 선행 #27520(턴 마감 화면 수리)은 이 칸의 선행이지 이 칸의 구현이 아니다.
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as llm from '../llm.js';
import type { LLMMessage, LLMProvider, LLMStreamEvent } from '../llm.js';
import * as config from '../user-config.js';
import type { AcpTurnContext } from './server.js';
import { bridgeCoreTurnToAcp, extractLastAssistantText } from './core-turn-bridge.js';

afterEach(() => mock.restore());

// 골 루프 시나리오: iteration 1 은 update_goal(complete, evidence 비어)로 반려되고
// (GOAL_EVIDENCE_REQUIRED_PROMPT 재주입), iteration 2 는 증거를 채워 완료한다. 두 iteration
// 모두 마지막 라운드에서 같은 최종 답을 스트림한다 — 이 칸이 금하는 «화면 2회»의 재현 조건.
const ANSWER = '고쳤습니다: 중복 렌더를 제거했습니다. 판정: bun test → 0 fail';
const EVIDENCE = 'bun test src/acp/core-turn-bridge-goal-repeat.test.ts → 0 fail';
const ADDENDUM = '추가로 회귀 묶음도 통과했습니다.';

// iteration 라운드 1: 완료 선언(update_goal 은 골 루프 dispatchTool 가로채기로 실 dispatch 없이 ack).
function goalUpdate(evidence: string): LLMStreamEvent[] {
  return [{ type: 'tool_call', id: `u-${evidence.length}`, name: 'update_goal', args: { status: 'complete', evidence } }];
}

// 라운드별 이벤트를 순서대로 뱉는 가짜 provider — 실물 llm·골 루프 경로를 그대로 돌게 하는 싱크 관문.
function goalRepeatProvider(rounds: LLMStreamEvent[][]): LLMProvider {
  let call = 0;
  return {
    name: 'goal-repeat-provider', defaultModel: 'gpt-5.6', available: () => true,
    chat: async function* () {},
    streamChat: async function* () { for (const ev of rounds[call++] ?? []) yield ev; },
  };
}

function setup() {
  const pushes: string[] = [];
  const persisted: LLMMessage[][] = [];
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base,
    llm: { ...base.llm, provider: 'openai', model: 'gpt-5.6', fallbackChain: [], goalLoop: { enabled: true } },
    chat: { ...base.chat, autoCompact: { ...base.chat.autoCompact, enabled: false } },
    tools: { ...base.tools, deferred: { ...base.tools.deferred, mode: 'off' } },
  });
  const runTurn = bridgeCoreTurnToAcp({
    getMessages: () => [{ role: 'user', content: 'fix it' }],
    getTools: () => [],
    dispatchTool: async () => ({ output: 'ok' }),
    onTurnComplete: ({ newMessages }) => { persisted.push(newMessages); },
  });
  const turn = {
    sessionId: 'goal-repeat', cwd: '/tmp', userText: 'fix it', promptBlocks: [{ type: 'text', text: 'fix it' }],
    isAborted: () => false,
    push: async (delta: string) => { pushes.push(delta); },
    pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
    pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
    requestApproval: async () => 'allow-once' as const,
  } as unknown as AcpTurnContext;
  return { run: () => runTurn(turn), pushes, persisted };
}

test('골 루프 반복의 같은 답 재방출 — 최종 답은 화면에 정확히 한 번', async () => {
  const f = setup();
  const rounds: LLMStreamEvent[][] = [
    goalUpdate(''),
    [
      { type: 'text', delta: '고쳤습니다: ' },
      { type: 'text', delta: '중복 렌더를 제거했습니다. ' },
      { type: 'text', delta: '판정: bun test → 0 fail' },
    ],
    goalUpdate(EVIDENCE),
    [
      { type: 'text', delta: '고쳤습니다: 중복 ' },
      { type: 'text', delta: '렌더를 제거했습니다. 판정: ' },
      { type: 'text', delta: 'bun test → 0 fail' },
    ],
  ];
  spyOn(llm, 'resolveDefaultProvider').mockReturnValue(goalRepeatProvider(rounds));
  await f.run();
  const shown = f.pushes.join('');
  expect(shown.split(ANSWER).length - 1).toBe(1);
  expect(f.persisted.length).toBe(2);
  expect(extractLastAssistantText(f.persisted[1]!)).toBe(ANSWER);
}, 30_000);

test('완료 선언 뒤 재호출에서 새 문장이 동반되면 기존 화면 보존·새 내용 보존', async () => {
  const f = setup();
  const rounds: LLMStreamEvent[][] = [
    goalUpdate(''),
    [
      { type: 'text', delta: '고쳤습니다: ' },
      { type: 'text', delta: '중복 렌더를 제거했습니다. ' },
      { type: 'text', delta: '판정: bun test → 0 fail' },
    ],
    goalUpdate(EVIDENCE),
    [
      { type: 'text', delta: '고쳤습니다: 중복 ' },
      { type: 'text', delta: '렌더를 제거했습니다. 판정: ' },
      { type: 'text', delta: 'bun test → 0 fail' },
      { type: 'text', delta: ADDENDUM },
    ],
  ];
  spyOn(llm, 'resolveDefaultProvider').mockReturnValue(goalRepeatProvider(rounds));
  await f.run();
  const shown = f.pushes.join('');
  // ACP retains its interactive divergence contract (the prior answer is
  // re-rendered on divergence); only noninteractive callers use the shortcut.
  expect(shown.split(ANSWER).length - 1).toBe(2);
  expect(shown.split(ADDENDUM).length - 1).toBe(1);
  expect(f.persisted).toHaveLength(2);
  expect(extractLastAssistantText(f.persisted[1]!)).toContain(ADDENDUM);
}, 30_000);

test('«확인 결과» 인사를 붙인 재방출도 화면에 한 번 — 인사는 화면 밖', async () => {
  const f = setup();
  const rounds: LLMStreamEvent[][] = [
    goalUpdate(''),
    [
      { type: 'text', delta: '고쳤습니다: ' },
      { type: 'text', delta: '중복 렌더를 제거했습니다. ' },
      { type: 'text', delta: '판정: bun test → 0 fail' },
    ],
    goalUpdate(EVIDENCE),
    [
      { type: 'text', delta: '확인' },
      { type: 'text', delta: ' 결과: ' },
      { type: 'text', delta: '고쳤습니다: 중복 ' },
      { type: 'text', delta: '렌더를 제거했습니다. 판정: ' },
      { type: 'text', delta: 'bun test → 0 fail' },
    ],
  ];
  spyOn(llm, 'resolveDefaultProvider').mockReturnValue(goalRepeatProvider(rounds));
  await f.run();
  const shown = f.pushes.join('');
  expect(shown.split(ANSWER).length - 1).toBe(1);
  expect(shown).not.toContain('확인 결과');
  expect(f.persisted.length).toBe(2);
}, 30_000);

test('재방출이 새 내용으로 갈라지면 모은 걸 흘린다 — 화면 내용 손실 0(현행 렌더 보존)', async () => {
  const f = setup();
  const rounds: LLMStreamEvent[][] = [
    goalUpdate(''),
    [
      { type: 'text', delta: '고쳤습니다: ' },
      { type: 'text', delta: '중복 렌더를 제거했습니다. ' },
      { type: 'text', delta: '판정: bun test → 0 fail' },
    ],
    goalUpdate(EVIDENCE),
    [
      { type: 'text', delta: '고쳤습니다: 중복 ' },
      { type: 'text', delta: '렌더를 제거했습니다. 판정: ' },
      { type: 'text', delta: 'bun test → 0 fail' },
      { type: 'text', delta: ADDENDUM },
    ],
  ];
  spyOn(llm, 'resolveDefaultProvider').mockReturnValue(goalRepeatProvider(rounds));
  await f.run();
  const shown = f.pushes.join('');
  expect(shown.split(ANSWER).length - 1).toBe(2);
  expect(shown.split(ADDENDUM).length - 1).toBe(1);
  expect(f.persisted.length).toBe(2);
}, 30_000);
