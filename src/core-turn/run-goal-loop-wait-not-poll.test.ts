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
const TOOLS: LLMToolSpec[] = [specOf('RunShell'), specOf('Agent'), specOf('AgentOutput'), specOf('Read')];

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

describe('ELN-WAIT-NOT-POLL — wait, don\'t poll (goal loop)', () => {
  test('①\' update_goal(status="waiting") — 대기 선언으로 골 루프를 닫는다(이후 provider 호출 0)', async () => {
    const r = await drive([
      [
        { type: 'text', delta: '자식 에이전트 2개가 실행 중입니다 — 완료 이벤트를 기다립니다.' },
        { type: 'tool_call', id: 'w1', name: 'update_goal', args: { status: 'waiting', evidence: '자식 agent t1·t2 실행 중 · 완료 노크가 다음 턴을 엶' } },
      ],
      [], [],
    ]);
    expect(r.calls).toBe(1);
    expect(r.result).toMatchObject({ stopReason: 'waiting', goalComplete: false, iterations: 1 });
  });

  test('②\' 살아 있는 백그라운드 자식 peek(AgentOutput not_ready)만 남은 iteration — waiting 자동 종료', async () => {
    const r = await drive([
      [{ type: 'tool_call', id: 'a1', name: 'Agent', args: { prompt: '조사', reason: 'fixture' } }],
      [{ type: 'text', delta: '자식을 띄웠습니다.' }],
      [{ type: 'tool_call', id: 'p1', name: 'AgentOutput', args: { taskId: 't1', block: false } }],
      [{ type: 'text', delta: '아직 실행 중입니다 — 완료 노크를 기다립니다.' }],
      [{ type: 'tool_call', id: 'p2', name: 'AgentOutput', args: { taskId: 't1', block: false } }],
      [{ type: 'text', delta: '아직 실행 중입니다.' }],
    ], {
      dispatchTool: (async (name: string) => {
        if (name === 'AgentOutput') return { retrievalStatus: 'not_ready', state: 'running' };
        return { ok: true, taskId: 't1' };
      }) as CoreTurnContext['dispatchTool'],
    });
    expect(r.result).toMatchObject({ stopReason: 'waiting', goalComplete: false, iterations: 2 });
    expect(r.calls).toBe(4);
  });

  test('③\' 같은 읽기 도구 같은 인자 — 2회째 억제 · 3회째 강제 종료(실제 실행 1회)', async () => {
    let realReads = 0;
    const r = await drive([
      [{ type: 'tool_call', id: 'r1', name: 'Read', args: { file_path: '/tmp/eln-wait-poll-marker.txt' } }],
      [{ type: 'text', delta: '확인했습니다.' }],
      [{ type: 'tool_call', id: 'r2', name: 'Read', args: { file_path: '/tmp/eln-wait-poll-marker.txt' } }],
      [{ type: 'text', delta: '확인했습니다.' }],
      [{ type: 'tool_call', id: 'r3', name: 'Read', args: { file_path: '/tmp/eln-wait-poll-marker.txt' } }],
      [{ type: 'text', delta: '확인했습니다.' }],
      [], [], [], [],
    ], {
      dispatchTool: (async (name: string) => {
        if (name === 'Read') { realReads += 1; return 'marker-content'; }
        return 'ok';
      }) as CoreTurnContext['dispatchTool'],
    });
    expect(realReads).toBe(1);
    expect(r.result.stopReason).toBe('no_progress');
    expect(r.result.iterations).toBe(3);
  });

  test('④\' AgentOutput not_ready 연속 2회 — «할 일 0» 판정이 폴링 턴을 닫는다(waiting · goalComplete=false · OP #128843: 대기≠완료)', async () => {
    const r = await drive([
      [{ type: 'tool_call', id: 'p1', name: 'AgentOutput', args: { taskId: 't1', block: false } }],
      [{ type: 'tool_call', id: 'p2', name: 'AgentOutput', args: { taskId: 't1', block: false } }],
      [{ type: 'text', delta: '기다립니다.' }],
      [], [], [],
    ], {
      seatTurnCap: { maxTools: 60, maxWallMs: 600_000, idleEmptyMsgListLimit: 2 }, // 출처: #39562 — 운영 기본 seat-turn-cap 값 그대로(회귀 주행 고정)
      dispatchTool: (async (name: string) => {
        if (name === 'AgentOutput') return { retrievalStatus: 'not_ready', state: 'running' };
        return 'ok';
      }) as CoreTurnContext['dispatchTool'],
    });
    expect(r.calls).toBe(3);
    expect(r.result.goalComplete).toBe(false);
    expect(r.result.stopReason).toBe('waiting');
  });

  test('④\'\' 종단(OP #128843) — 대기(waiting) → 자식 완료 알림 → 같은 목표 재개 → 실제 완료', async () => {
    // 1턴차: not_ready 2회 → waiting 으로 닫힌다(완료 아님).
    let childDone = false;
    const dispatchNotReady = (async (name: string) => {
      if (name === 'AgentOutput') return childDone
        ? { retrievalStatus: 'ready', state: 'done', output: 'ok' }
        : { retrievalStatus: 'not_ready', state: 'running' };
      return 'ok';
    }) as CoreTurnContext['dispatchTool'];
    const cap = { maxTools: 60, maxWallMs: 600_000, idleEmptyMsgListLimit: 2 }; // 출처: #39562 — 운영 기본값
    const first = await drive([
      [{ type: 'tool_call', id: 'p1', name: 'AgentOutput', args: { taskId: 't1', block: false } }],
      [{ type: 'tool_call', id: 'p2', name: 'AgentOutput', args: { taskId: 't1', block: false } }],
      [{ type: 'text', delta: '기다립니다.' }],
      [], [], [],
    ], { seatTurnCap: cap, dispatchTool: dispatchNotReady });
    expect(first.result.stopReason).toBe('waiting');
    expect(first.result.goalComplete).toBe(false);
    // 완료 이벤트(자식 완료 알림)가 도착해 같은 목표가 재개된다.
    childDone = true;
    const resumed = await drive([
      [{ type: 'tool_call', id: 'q1', name: 'AgentOutput', args: { taskId: 't1', block: false } }],
      [{ type: 'tool_call', id: 'q2', name: 'update_goal', args: { status: 'complete', evidence: 'child done' } }],
      [{ type: 'text', delta: '완료.' }],
      [], [], [],
    ], { seatTurnCap: cap, dispatchTool: dispatchNotReady });
    expect(resumed.result.stopReason).toBe('goal_complete');
    expect(resumed.result.goalComplete).toBe(true);
  });

  test('⑤\' 계약 ↔ a5-wording 통일 — preamble·continuation·update_goal 스펙이 대기 문면을 공유', () => {
    expect(GOAL_SYSTEM_PREAMBLE).toContain('기다리');
    expect(GOAL_SYSTEM_PREAMBLE).toContain('턴을 닫');
    expect(GOAL_CONTINUATION_PROMPT).toContain('기다리');
    const spec = buildUpdateGoalToolSpec();
    const properties = (spec.parameters?.properties ?? {}) as Record<string, { enum?: unknown[] }>;
    expect(properties.status?.enum).toEqual(expect.arrayContaining(['complete', 'blocked', 'waiting']));
    expect(String(spec.description)).toContain('waiting');
  });
});
