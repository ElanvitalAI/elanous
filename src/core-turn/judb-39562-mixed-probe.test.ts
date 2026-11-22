import type { LLMToolSpec } from '../llm/tool-spec.js';
// ELN-WAIT-NOT-POLL (OP 진단 seat-state/OP/DIAG-ELN-OP-COORDINATOR-1122 · 칸 HAND-ELN-ELS-API) —
//   «도착했는지 확인하겠습니다» 반복·AgentOutput 80회 폴링의 구조 원인:
//   ① 목표 계약 «멈추지 말고 실행»(run-goal-loop.ts:260,267) ↔ 도구 설명 «턴을 끝내라»(a5-wording.ts:16-20) 충돌
//   ② 목표 루프에 «자식 대기 중» 상태 없음
//   ③ «할 일 0» 판정이 MsgList 만 봄(:993-1001)
//   처방(이 파일이 RED 로 먼저 굳는다 — 구현 전 실패 시험):
//   ①' 계약·continuation·update_goal 스펙이 대기 문면을 공유
//   ②' update_goal status="waiting" + 대기형 반복만 남은 iteration 의 waiting 자동 종료
//   ③' 같은 읽기 도구 같은 인자 2회째 억제 · 3회째 강제 종료
//   ④' AgentOutput not_ready 도 «할 일 0» 스트릭에 셈 — 폴링 턴을 닫는다
//   완료선: 대기 중 반복 조회 턴 0 · 완료 이벤트(캡슐 노크·우편·깨움)가 다음 턴을 연다.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as llmModule from '../llm.js';
import type { LLMMessage, LLMProvider, LLMStreamEvent } from '../llm.js';
import * as surfaceModule from '../session-runtime/index.js';
import * as deferredModule from '../session-runtime/tier-flip.js';
import { runGoalLoop, GOAL_SYSTEM_PREAMBLE, GOAL_CONTINUATION_PROMPT, buildUpdateGoalToolSpec } from './run-goal-loop.js';
import type { CoreTurnContext } from './types.js';
import type { SeatTurnCapConfig } from './seat-turn-cap.js';

const realStream = llmModule.streamLLMWithTools;

function specOf(name: string): LLMToolSpec {
  return { name, description: name, parameters: { type: 'object', properties: {} } };
}
const TOOLS: LLMToolSpec[] = [specOf('RunShell'), specOf('Agent'), specOf('AgentOutput'), specOf('Read'), specOf('MsgList')];

function scriptedProvider(turns: LLMStreamEvent[][]): { provider: LLMProvider; callsSeen: () => number } {
  let call = 0;
  const p: LLMProvider = {
    name: 'scripted',
    defaultModel: 'd',
    available: () => true,
    async *streamChat(_messages, _opts) { for (const ev of turns[call++] ?? []) yield ev; },
    async *chat() {},
  };
  return { provider: p, callsSeen: () => call };
}

beforeEach(() => {
  spyOn(surfaceModule, 'resolveSessionSurfaceProfile').mockImplementation(() => ({
    id: 'default', selectionReason: 'test', baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
  }) as unknown as ReturnType<typeof surfaceModule.resolveSessionSurfaceProfile>);
  spyOn(deferredModule, 'applyDeferredTools').mockImplementation((messages, tools) => ({
    messages: [...messages],
    tools: [...tools],
    stats: {
      activeCount: tools.length, deferredCount: 0, warmPreloaded: [], injected: false,
      deferredNames: [], unhydratableNames: [], unhydratableCount: 0,
    },
  }) as unknown as ReturnType<typeof deferredModule.applyDeferredTools>);
});
afterEach(() => mock.restore());

interface DriveOpts {
  dispatchTool?: CoreTurnContext['dispatchTool'];
  seatTurnCap?: SeatTurnCapConfig;
}

async function drive(turns: LLMStreamEvent[][], opts: DriveOpts = {}) {
  const { provider, callsSeen } = scriptedProvider(turns);
  spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (messages, handlers, o = {}) => {
    const { terminalToolNames, ...rest } = o;
    return realStream(messages, handlers, { ...rest, ...(terminalToolNames !== undefined ? { terminalToolNames } : {}), provider, maxTurns: 10 }); // 출처: #39562 — scripted drive 상한(시험 주행 최대 턴)
  });
  const ctx: CoreTurnContext = {
    sessionId: 'eln-wait-not-poll',
    messages: [{ role: 'user', content: '자식 에이전트 결과를 기다려' } as LLMMessage],
    userText: '자식 에이전트 결과를 기다려',
    tools: TOOLS,
    dispatchTool: opts.dispatchTool ?? (async () => 'ok'),
    signal: new AbortController().signal,
  };
  const result = await runGoalLoop(ctx, {
    controlSpaceId: null,
    intentStallProvider: null,
    changedFiles: () => [],
    attachLifecycleBridge: () => () => {},
    startLivenessHeartbeat: () => () => {},
    ...(opts.seatTurnCap ? { seatTurnCap: { ...opts.seatTurnCap, seat: 'probe-seat' } } : {}),
  });
  return { result, calls: callsSeen() };
}


// 출처(수치 그대로 · 변경 없음): JUD-B 독립 probe 원문 node-b:/tmp/judb-39562-independent-1122/head/src/core-turn/judb-39562-mixed-probe.test.ts (#128953/#128955 회귀 흡수)
const cap = { maxTools: 60, maxWallMs: 2700000, idleEmptyMsgListLimit: 2 }; // 출처: #39562 — JUD-B 독립 probe 원문 수치 그대로(node-b:/tmp/judb-39562-independent-1122 · #128953/#128955 회귀 흡수)
const p = (id: string) => [{type:'tool_call', id, name:'AgentOutput', args:{taskId:'t1',block:false}}] as LLMStreamEvent[];
const sleep = [{type:'tool_call',id:'s1',name:'RunShell',args:{command:'sleep 1'}}] as LLMStreamEvent[];
const mail = [{type:'tool_call',id:'m1',name:'MsgList',args:{}}] as LLMStreamEvent[];
const text = [{type:'text',delta:'waiting'}] as LLMStreamEvent[];
const dispatch = (async (name: string) => name === 'AgentOutput' ? {retrievalStatus:'not_ready',state:'running'} : name === 'MsgList' ? {count:0,messages:[]} : 'ok') as CoreTurnContext['dispatchTool'];
for (const [label, turns] of [
 ['control', [p('p1'),p('p2'),text]],
 ['not-ready-then-empty-mail', [p('p1'),mail,text]],
 ['not-ready-sleep-not-ready', [p('p1'),sleep,p('p2'),text]],
] as [string, LLMStreamEvent[][]][]) {
 test(label, async () => {
  const r = await drive(turns, {seatTurnCap: cap,dispatchTool:dispatch});
  console.log('PROBE',label,JSON.stringify(r));
  expect(r.result.goalComplete).toBe(false);
  expect(r.result.stopReason).toBe('waiting');
 });
}
