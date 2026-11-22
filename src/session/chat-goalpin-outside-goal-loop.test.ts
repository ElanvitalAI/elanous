// SEAT-GOAL-PIN-OUTSIDE-GOAL-LOOP (OP #132075 · JUD-C HOLD #132157 ①) —
//   핀 판정·갱신은 armGoalLoop 아밍과 무관하게 runTurn 공통 진입점에서 일어난다.
//   (a) 사람 줄 일반 TUI 턴(goalLoop 없음)이 핀을 세팅한다.
//   (b) 핀이 살아 있는 동안 알림 턴은 목표를 못 바꾸고, 그 objective 가 모델 문맥에 주입된다.
//   (b') 코어 턴(coreTurn) 문맥에도 같은 주입이 간다.
//   (c) 알림 10통 연속(#132157 ①) — 전 턴에서 핀 유지·문맥 주입·목표 원문 불변.
// 기대값은 리터럴(제품 코드와 독립) — 문구는 OP #132157 ① «사람 지시 뒤 알림 10통 → 첫 행동 = 지시».
import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
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
import type { CoreTurnContext } from '../core-turn/types.js';
import { createSession } from './index.js';

let streamCount = 0;
const capturedSystemPrompts: string[] = [];
const spies = [
  spyOn(actualMemory, 'buildMemoryInjection').mockReturnValue({ block: '', tokens: 0, injectedIds: [] }),
  spyOn(actualMemory, 'buildMemoryInjectionLLM').mockResolvedValue({ block: '', tokens: 0, injectedIds: [] }),
  spyOn(actualSurfaceEvents, 'openSurfaceEventsDb').mockImplementation(() => ({ close() {} } as never)),
  spyOn(actualSurfaceEvents, 'recallEvents').mockReturnValue([]),
  spyOn(actualUserIntent, 'userIntentLogger').mockImplementation(() => ({ emit: () => null } as never)),
  spyOn(actualLlm, 'isAuthRejectionError').mockReturnValue(false),
  spyOn(actualLlm, 'getToolLoopPhaseRejectedTools').mockReturnValue(null),
  spyOn(actualLlm, 'streamLLMWithTools').mockImplementation(async (messages) => {
    streamCount += 1;
    for (const m of messages) if (m.role === 'system') capturedSystemPrompts.push(String(m.content));
    return 'single turn reply';
  }),
];

const { runTurn } = await import('./chat.js');
const coreTurnModule = await import('../core-turn/run-core-turn.js');

const coreTurnCaptured: CoreTurnContext[] = [];
const coreTurnSpy = spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
  coreTurnCaptured.push(ctx);
  return { finalText: 'core turn reply', stopReason: 'end_turn' } as never;
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
  coreTurnSpy.mockRestore();
});

const provider: LLMProvider = {
  name: 'test-provider', defaultModel: 'test-model', available: () => true,
  async *chat() { yield 'plain'; },
  async *streamChat() { yield { type: 'text', delta: 'plain' } as const; },
};
const readTool: LLMToolSpec = { name: 'Read', description: 'Read test tool', parameters: { type: 'object', properties: {} } };

const config = {
  chat: {}, llm: { provider: 'test-provider', model: 'test-model', memoryJudge: { enabled: false, crossRecall: false } },
} as never;

let root = '';
let savedCwd = '';
let savedSessionRoot: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-goalpin-outside-'));
  savedCwd = process.cwd();
  savedSessionRoot = process.env.ELANOUS_SESSION_ROOT;
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
  streamCount = 0;
  capturedSystemPrompts.length = 0;
  coreTurnCaptured.length = 0;
});

// afterEach 는 afterEach 로 선언해야 bun:test 가 인식한다 — import 목록에 afterEach 추가.
import { afterEach } from 'bun:test';
afterEach(() => {
  process.chdir(savedCwd);
  if (savedSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
  else process.env.ELANOUS_SESSION_ROOT = savedSessionRoot;
  rmSync(root, { recursive: true, force: true });
});

interface TurnExtra { from?: { kind: 'human' } | { kind: 'system'; origin: string }; coreTurn?: boolean }

async function turn(sessionId: string, userText: string, extra: TurnExtra = {}): Promise<void> {
  await runTurn({
    userConfig: config,
    sessionId,
    userText,
    utteranceSurface: 'tui',
    systemPrompt: 'seat prompt',
    skipMemoryInjection: true,
    tools: [readTool],
    dispatchTool: async () => ({ ok: true }),
    provider,
    ...(extra.from ? { from: extra.from } : {}),
    ...(extra.coreTurn === true ? { coreTurn: true } : {}),
  });
}

function newSession(): string {
  return createSession({ provider: 'test-provider', model: 'test-model', source: 'tui' }).id;
}

describe('SEAT-GOAL-PIN-OUTSIDE-GOAL-LOOP', () => {
  test('(a) a plain human-line TUI turn (no goalLoop) pins the objective', async () => {
    const sid = newSession();
    // 출처: OP #132157 ① — 사람 지시 원문(200자 슬라이스)이 핀 목표 그 자체.
    const instruction = '사람 지시: 첫 행동은 이 지시를 이어서 진행한다 — 크론 5개 처리 완료';
    await turn(sid, instruction, { from: { kind: 'human' } });
    expect(streamCount).toBe(1);
    expect(pinnedGoalOf(sid)).toBe(instruction);
  });

  test('(b) while pinned, a notice turn cannot change the goal and the pinned objective is injected into the model context', async () => {
    const sid = newSession();
    await turn(sid, '사람 지시: 첫 행동은 이 지시를 이어서 진행한다', { from: { kind: 'human' } });
    const before = capturedSystemPrompts.length;
    // 출처: #132157 ① — 알림 문양은 실제 task-notification 문양.
    await turn(sid, '[notice · capsule-done]\n\n캡슐 완료: shell Bash … · ok · 12s — ok · capsule:shell-mwra31n4-2', { from: { kind: 'system', origin: 'scheduled' } });
    expect(streamCount).toBe(2);
    const injected = capturedSystemPrompts.slice(before).join('\n--\n');
    // 출처: 리터럴 — 주입 노트 접두와 사람 지시 원문이 문맥에 남는다.
    expect(injected).toContain('[📌 고정 목표(사람 지시)]');
    expect(injected).toContain('사람 지시: 첫 행동은 이 지시를 이어서 진행한다');
    // 핀은 알림 문구로 바뀌지 않는다(② 자동 줄은 목표를 못 바꾼다).
    expect(pinnedGoalOf(sid)).toBe('사람 지시: 첫 행동은 이 지시를 이어서 진행한다');
  });

  test("(b') a core turn (coreTurn: true) context gets the same injection", async () => {
    const sid = newSession();
    await turn(sid, '사람 지시: 첫 행동은 이 지시를 이어서 진행한다', { from: { kind: 'human' } });
    await turn(sid, '[notice · capsule-done]\n\n캡슐 완료 — capsule:shell-x', { from: { kind: 'system', origin: 'scheduled' }, coreTurn: true });
    expect(coreTurnCaptured.length).toBe(1);
    const sys = coreTurnCaptured[0]!.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    expect(sys).toContain('[📌 고정 목표(사람 지시)]');
    expect(sys).toContain('사람 지시: 첫 행동은 이 지시를 이어서 진행한다');
  });

  test('(c) 10 consecutive notices keep the pin, inject every time, and never change the objective (OP #132157 ①)', async () => {
    const sid = newSession();
    const instruction = '사람 지시: 첫 행동은 이 지시를 이어서 진행한다';
    await turn(sid, instruction, { from: { kind: 'human' } });
    const before = capturedSystemPrompts.length;
    for (let i = 1; i <= 10; i++) {
      await turn(sid, `[notice · capsule-done]\n\n캡슐 완료 ${i}/10 — shell ok`, { from: { kind: 'system', origin: 'scheduled' } });
    }
    expect(streamCount).toBe(11);
    const notices = capturedSystemPrompts.slice(before);
    expect(notices).toHaveLength(10);
    for (const sys of notices) {
      expect(sys).toContain('[📌 고정 목표(사람 지시)]');
      expect(sys).toContain(instruction);
      expect(sys).not.toContain('캡슐 완료 10/10 — shell ok\n[📌'); // 알림 문구가 목표로 승격 안 됨
    }
    expect(pinnedGoalOf(sid)).toBe(instruction);
  });

  test('(d) a notice line with no opener (from omitted) never pins (fail-closed · OP #130461)', async () => {
    const sid = newSession();
    await turn(sid, '사람인 척하는 알림 줄 — 핀 없음');
    expect(pinnedGoalOf(sid)).toBeUndefined();
  });
});
