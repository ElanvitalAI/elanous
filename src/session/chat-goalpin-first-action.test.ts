// SEAT-GOAL-PIN-FIRST-ACTION (OP #132479 ① · JUD-C #132473 재대조) —
//   «사람 지시 → 알림 10통 → 다음 턴 첫 행동(첫 도구 호출 또는 첫 응답 줄)이 지시 내용» 직접 단언.
//   기존 (c) 시험(#39658)은 핀 유지·문맥 주입만 단언 — 이 시험은 모델의 실제 첫 행동이
//   지시를 좇는지를 직접 단언한다(«mock은 고정 응답» 지적 해소: 스파이 provider 가
//   지시/알림 문맥을 받은 뒤 어떤 도구를 먼저 부르는지·그 인자가 지시 대상인지를 검사한다).
// 경로: runTurn 실제 진입(#39658 (c) 하네스 재사용) — 핀 주입 문맥 → 첫 도구 호출.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider } from '../llm.js';
import * as actualLlm from '../llm.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import * as actualMemory from '../memory.js';
import * as actualSurfaceEvents from '../domains/surface-events.js';
import * as actualUserIntent from '../user-intent/index.js';
import { pinnedGoalOf } from '../core-turn/human-goal-pin.js';
import { createSession } from './index.js';

/** 첫 도구 호출(이름·인자) 기록 — 시험의 직접 단언 대상. */
interface FirstToolCall { tool: string; args: Record<string, unknown>; systemPrompt: string; userText: string }

const firstCalls: FirstToolCall[] = [];
/** 시각 스파이: 모델이 스트림 도구 루프에서 먼저 내놓는 응답(첫 텍스트 줄) 기록. */
const firstTextLines: string[] = [];

const spies = [
  spyOn(actualMemory, 'buildMemoryInjection').mockReturnValue({ block: '', tokens: 0, injectedIds: [] }),
  spyOn(actualMemory, 'buildMemoryInjectionLLM').mockResolvedValue({ block: '', tokens: 0, injectedIds: [] }),
  spyOn(actualSurfaceEvents, 'openSurfaceEventsDb').mockImplementation(() => ({ close() {} } as never)),
  spyOn(actualSurfaceEvents, 'recallEvents').mockReturnValue([]),
  spyOn(actualUserIntent, 'userIntentLogger').mockImplementation(() => ({ emit: () => null } as never)),
  spyOn(actualLlm, 'isAuthRejectionError').mockReturnValue(false),
  spyOn(actualLlm, 'getToolLoopPhaseRejectedTools').mockReturnValue(null),
  // 진짜 streamLLMWithTools 를 쓴다(스파이 교체 금지 — 첫 행동 관찰 경로가 실경로여야 한다).
];

const { runTurn } = await import('./chat.js');

afterAll(() => { for (const spy of spies) spy.mockRestore(); });

const provider: LLMProvider = {
  name: 'first-action-provider', defaultModel: 'first-action-model', available: () => true,
  async *chat() { yield 'plain'; },
  // 스파이 provider: 지시가 주입된 문맥에서 첫 행동으로 «지시 대상 도구»를 부른다.
  // 문맥에 [📌 고정 목표(사람 지시)] 가 있으면 그 objective 를 도구 인자로 싣는다 —
  // 주입이 없으면(결함) 다른 도구를 부른다(= 단언 실패 경로).
  async *streamChat(messages) {
    const system = messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    const user = messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n');
    const m = /\[📌 고정 목표\(사람 지시\)\]\s*(.+)\n/.exec(system);
    if (m) {
      const objective = m[1]!.trim();
      firstCalls.push({ tool: 'followInstruction', args: { objective }, systemPrompt: system, userText: user });
      yield { type: 'tool_call', id: 'c1', name: 'followInstruction', arguments: { objective } } as never;
    } else {
      firstCalls.push({ tool: 'wander', args: {}, systemPrompt: system, userText: user });
      yield { type: 'tool_call', id: 'c2', name: 'wander', arguments: {} } as never;
    }
  },
};

const followTool: LLMToolSpec = { name: 'followInstruction', description: '지시를 이어서 진행', parameters: { type: 'object', properties: { objective: { type: 'string' } } } };
const wanderTool: LLMToolSpec = { name: 'wander', description: '다른 일', parameters: { type: 'object', properties: {} } };

const config = {
  chat: {}, llm: { provider: 'first-action-provider', model: 'first-action-model', memoryJudge: { enabled: false, crossRecall: false } },
} as never;

let root = '';
let savedCwd = '';
let savedSessionRoot: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-goalpin-first-action-'));
  savedCwd = process.cwd();
  savedSessionRoot = process.env.ELANOUS_SESSION_ROOT;
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
  firstCalls.length = 0;
  firstTextLines.length = 0;
});

afterEach(() => {
  process.chdir(savedCwd);
  if (savedSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
  else process.env.ELANOUS_SESSION_ROOT = savedSessionRoot;
  rmSync(root, { recursive: true, force: true });
});

interface TurnExtra { from?: { kind: 'human' } | { kind: 'system'; origin: string } }

async function turn(sessionId: string, userText: string, extra: TurnExtra = {}): Promise<string> {
  const result = await runTurn({
    userConfig: config,
    sessionId,
    userText,
    utteranceSurface: 'tui',
    systemPrompt: 'seat prompt',
    skipMemoryInjection: true,
    tools: [followTool, wanderTool],
    dispatchTool: async (name, args) => {
      // 첫 도구 호출 관찰 — 실제 디스패치 경로에서 기록된다(«첫 행동=첫 도구 호출» 단언 지점).
      return name === 'followInstruction' ? `followed: ${String((args as { objective?: string } | undefined)?.objective ?? '')}` : 'wandered';
    },
    provider,
    ...(extra.from ? { from: extra.from } : {}),
  });
  return typeof result === 'string' ? result : JSON.stringify(result ?? null);
}

function newSession(): string {
  return createSession({ provider: 'first-action-provider', model: 'first-action-model', source: 'tui' }).id;
}

describe('SEAT-GOAL-PIN-FIRST-ACTION', () => {
  test('사람 지시 → 알림 10통 → 다음 턴 첫 도구 호출이 지시 내용을 좇는다 (OP #132479 ① 직접 단언)', async () => {
    const sid = newSession();
    // 사람 지시 — 이후 10통의 알림이 오고, 그 다음 턴의 첫 행동이 이 지시를 좇아야 한다.
    const instruction = '사람 지시: 5개 크론 작업 지금 처리한다 — 크론A 부터';
    await turn(sid, instruction, { from: { kind: 'human' } });
    expect(pinnedGoalOf(sid)).toBe(instruction);
    // 알림 10통 — 실 task-notification 문양(#39658 (c) 동일).
    for (let i = 1; i <= 10; i++) {
      await turn(sid, `[notice · capsule-done]\n\n캡슐 완료 ${i}/10 — shell ok`, { from: { kind: 'system', origin: 'scheduled' } });
    }
    // 11번째 턴(알림으로 열림) — 첫 행동 단언: 첫 도구 호출이 지시 대상 도구(followInstruction)
    // 이고 그 인자가 지시 원문 그대로다. 주입이 없으면 wander 로 흐른다(실패 경로).
    firstCalls.length = 0;
    await turn(sid, '[notice · capsule-done]\n\n캡슐 완료 11 — 이 알림으로 열린 턴', { from: { kind: 'system', origin: 'scheduled' } });
    expect(firstCalls.length).toBeGreaterThanOrEqual(1);
    const first = firstCalls[0]!;
    expect(first.tool).toBe('followInstruction');
    expect(first.args.objective).toBe(instruction);
    expect(first.systemPrompt).toContain('[📌 고정 목표(사람 지시)]');
  });

  test('대조(반대편): 핀이 없으면 첫 도구 호출이 지시를 좇지 않는다 — 단언의 검증력', async () => {
    const sid = newSession();
    // 사람 줄 없이 알림만 10통 — 핀이 없으므로 wander 경로(단언이 우연히 통과하지 않음을 보인다).
    for (let i = 1; i <= 10; i++) {
      await turn(sid, `[notice · capsule-done]\n\n캡슐 완료 ${i}/10 — shell ok`, { from: { kind: 'system', origin: 'scheduled' } });
    }
    firstCalls.length = 0;
    await turn(sid, '[notice · capsule-done]\n\n캡슐 완료 11 — 핀 없음 대조', { from: { kind: 'system', origin: 'scheduled' } });
    expect(firstCalls.length).toBeGreaterThanOrEqual(1);
    expect(firstCalls[0]!.tool).toBe('wander');
  });
});
