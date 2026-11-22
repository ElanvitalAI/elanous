// CHAT-GOAL-LOOP-DEFAULT-OFF (0.3.33) — the goal loop is armed only by an explicit caller (`runTurn({ goalLoop: true })`).
// A plain TUI chat turn in a seat dir, a notice (task-notification) turn, and an old config that still carries
// `llm.goalLoop.enabled: true` never reach runGoalLoop. Expected values are literals, independent of the product code.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider } from '../llm.js';
import * as actualLlm from '../llm.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import * as actualMemory from '../memory.js';
import * as actualSurfaceEvents from '../domains/surface-events.js';
import * as actualUserIntent from '../user-intent/index.js';
import { buildUserConfig } from '../user-config.js';
import { createSession } from './index.js';

let streamCount = 0;
const spies = [
  spyOn(actualMemory, 'buildMemoryInjection').mockReturnValue({ block: '', tokens: 0, injectedIds: [] }),
  spyOn(actualMemory, 'buildMemoryInjectionLLM').mockResolvedValue({ block: '', tokens: 0, injectedIds: [] }),
  spyOn(actualSurfaceEvents, 'openSurfaceEventsDb').mockImplementation(() => ({ close() {} } as never)),
  spyOn(actualSurfaceEvents, 'recallEvents').mockReturnValue([]),
  spyOn(actualUserIntent, 'userIntentLogger').mockImplementation(() => ({ emit: () => null } as never)),
  spyOn(actualLlm, 'isAuthRejectionError').mockReturnValue(false),
  spyOn(actualLlm, 'getToolLoopPhaseRejectedTools').mockReturnValue(null),
  spyOn(actualLlm, 'streamLLMWithTools').mockImplementation(async () => { streamCount += 1; return 'single turn reply'; }),
];

const { runTurn } = await import('./chat.js');
const goalLoopModule = await import('../core-turn/run-goal-loop.js');
const coreTurnModule = await import('../core-turn/run-core-turn.js');

let goalLoopCalls = 0;
const goalLoopSpy = spyOn(goalLoopModule, 'runGoalLoop').mockImplementation(async () => {
  goalLoopCalls += 1;
  return { finalText: 'goal loop reply', goalComplete: true, stopReason: 'complete', iterations: 1 } as never;
});
const coreTurnSpy = spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async () => {
  streamCount += 1;
  return { finalText: 'core turn reply', stopReason: 'end_turn' } as never;
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
  goalLoopSpy.mockRestore();
  coreTurnSpy.mockRestore();
});

const provider: LLMProvider = {
  name: 'test-provider',
  defaultModel: 'test-model',
  available: () => true,
  async *chat() { yield 'plain'; },
  async *streamChat() { yield { type: 'text', delta: 'plain' } as const; },
};

const readTool: LLMToolSpec = { name: 'Read', description: 'Read test tool', parameters: { type: 'object', properties: {} } };

function config(goalLoop: Record<string, unknown> | undefined): never {
  return {
    chat: {},
    llm: {
      provider: 'test-provider', model: 'test-model',
      memoryJudge: { enabled: false, crossRecall: false },
      ...(goalLoop ? { goalLoop } : {}),
    },
  } as never;
}

let root = '';
let savedCwd = '';
let savedSessionRoot: string | undefined;
let savedCoordId: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-goal-loop-default-off-'));
  savedCwd = process.cwd();
  savedSessionRoot = process.env.ELANOUS_SESSION_ROOT;
  savedCoordId = process.env.COORD_ID;
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
  goalLoopCalls = 0;
  streamCount = 0;
});

afterEach(() => {
  process.chdir(savedCwd);
  if (savedSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
  else process.env.ELANOUS_SESSION_ROOT = savedSessionRoot;
  if (savedCoordId === undefined) delete process.env.COORD_ID;
  else process.env.COORD_ID = savedCoordId;
  rmSync(root, { recursive: true, force: true });
});

function enterSeatDir(seat: string): void {
  const dir = join(root, 'elanous-hq', 'seats', seat);
  mkdirSync(dir, { recursive: true });
  process.chdir(dir);
  process.env.COORD_ID = seat;
}

async function turn(userText: string, cfg: never, extra: { goalLoop?: boolean } = {}): Promise<void> {
  const session = createSession({ provider: 'test-provider', model: 'test-model', source: 'tui' });
  await runTurn({
    userConfig: cfg,
    sessionId: session.id,
    userText,
    utteranceSurface: 'tui',
    systemPrompt: 'seat prompt',
    skipMemoryInjection: true,
    tools: [readTool],
    dispatchTool: async () => ({ ok: true }),
    provider,
    ...(extra.goalLoop === true ? { goalLoop: true, goalLoopMaxIterations: 1 } : {}),
  });
}

describe('CHAT-GOAL-LOOP-DEFAULT-OFF', () => {
  test('(a) a plain TUI chat turn in a seat dir does not call runGoalLoop, even with old config goalLoop.enabled=true', async () => {
    enterSeatDir('UX');
    // 출처: #39618 — CHAT-GOAL-LOOP-DEFAULT-OFF 옛 config 의 maxIterations 리터럴(상한이 아니라 키 보존 시험값)
    await turn('OP 13:14: 계속 — draft 다음 행.', config({ enabled: true, maxIterations: 4 }));
    await turn('src/session/chat.ts 버그 고쳐줘', config({ enabled: true }));
    await turn('지금 상태 설명해줘', config(undefined));
    expect(goalLoopCalls).toBe(0);
    expect(streamCount).toBe(3);
  });

  test('(b) the explicit goalLoop:true caller (harness / dev --implement / chat --goal-loop) still calls runGoalLoop', async () => {
    await turn('Create sum.ts and run its test before declaring the goal complete.', config(undefined), { goalLoop: true });
    expect(goalLoopCalls).toBe(1);
    enterSeatDir('TC');
    await turn('목표: 칸 하나 끝내기', config(undefined), { goalLoop: true });
    expect(goalLoopCalls).toBe(2);
  });

  test('(c) a notice (task-notification) turn in a seat does not call runGoalLoop', async () => {
    enterSeatDir('OP');
    const notice = '<task-notification>\n  <task id="shell-mw01" status="completed">\n    <summary>Background command finished</summary>\n  </task>\n</task-notification>';
    await turn(notice, config({ enabled: true }));
    await turn('[seat-mail #91234 from OPC] ✅ PR #39001 착지', config(undefined));
    expect(goalLoopCalls).toBe(0);
    expect(streamCount).toBe(2);
  });

  test('an old config file with llm.goalLoop.enabled loads; the key is dropped and maxIterations kept', () => {
    const cfgPath = join(root, 'config.json');
    // 출처: #39618 — CHAT-GOAL-LOOP-DEFAULT-OFF 옛 config 의 maxIterations 리터럴(상한이 아니라 키 보존 시험값)
    writeFileSync(cfgPath, JSON.stringify({ llm: { goalLoop: { enabled: true, maxIterations: 5 } } }));
    const cfg = buildUserConfig(cfgPath);
    // 출처: #39618 — CHAT-GOAL-LOOP-DEFAULT-OFF 옛 config 의 maxIterations 리터럴(상한이 아니라 키 보존 시험값)
    expect(cfg.llm.goalLoop).toEqual({ maxIterations: 5 });
    writeFileSync(cfgPath, JSON.stringify({ llm: { goalLoop: { enabled: false } } }));
    expect(buildUserConfig(cfgPath).llm.goalLoop).toBeUndefined();
  });
});
