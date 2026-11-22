// CHAT-GOAL-LOOP-DEFAULT-OFF — 브리지가 goal loop 를 하니스 실행 자식(명시 골)에만 켜는가 (옛 TUI-SEAT-TURN-CAP 자리 경로 삭제).
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as coreTurn from '../core-turn/run-core-turn.js';
import * as coreGoalLoop from '../core-turn/run-goal-loop.js';
import * as config from '../user-config.js';
import type { GoalLoopOptions } from '../core-turn/run-goal-loop.js';
import type { AcpTurnContext } from './server.js';
import { bridgeCoreTurnToAcp } from './core-turn-bridge.js';
import { HARNESS_ROLE_ENV } from '../harness/harness-space.js';

afterEach(() => mock.restore());

const text = 'OP 13:14: 계속 — draft 다음 행.';
const specs = ['Read', 'RunShell'].map((name) => ({ name, description: '', parameters: { type: 'object' as const } }));

async function run(seat: string | null, chatConfigOverride?: Record<string, unknown>, tuiRouting = true) {
  const seen: GoalLoopOptions[] = [];
  let cores = 0;
  spyOn(coreGoalLoop, 'runGoalLoop').mockImplementation(async (_ctx, opts) => {
    seen.push(opts ?? {});
    return { finalText: '', iterations: 1, stopReason: 'goal_complete', goalComplete: true };
  });
  spyOn(coreTurn, 'runCoreTurn').mockImplementation(async () => { cores += 1; return { stopReason: 'end_turn', finalText: '' }; });
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base,
    // An old config still carrying the deleted switch — the bridge must ignore it.
    llm: { ...base.llm, model: 'gpt-4o-mini', goalLoop: { enabled: true } as never },
    chat: { ...base.chat, ...(chatConfigOverride ?? {}) },
  });
  await bridgeCoreTurnToAcp({
    ...(tuiRouting ? { tuiRouting: true, resolveSeat: () => seat } : {}),
    getMessages: () => [{ role: 'user', content: text }], getTools: () => specs, dispatchTool: async () => ({}),
  })({
    sessionId: 'seat-cap', cwd: '/tmp', userText: text,
    promptBlocks: [{ type: 'text', text }], isAborted: () => false,
    push: async () => {}, pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
    pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
  } as unknown as AcpTurnContext);
  return { seen, coreCalls: () => cores };
}

// CHAT-GOAL-LOOP-DEFAULT-OFF(0.3.33) — 자리 TUI·사람 TUI·데몬 ACP 는 goal loop 를 타지 않는다(옛 config enabled=true 여도).
//   bridge 의 goal loop 는 하니스 실행 자식(executor · 명시 골) 하나이고, 거기엔 seatTurnCap 이 없다.
test('자리 TUI 운영 지시 → goal loop 0 · 단일 core 턴 (옛 config goalLoop.enabled=true 여도)', async () => {
  const { seen, coreCalls } = await run('OPT');
  expect(seen).toHaveLength(0);
  expect(coreCalls()).toBe(1);
});

test('사람 TUI → goal loop 0', async () => {
  const { seen } = await run(null);
  expect(seen).toHaveLength(0);
});

test('데몬 ACP(legacy · tuiRouting 없음) → goal loop 0', async () => {
  const { seen } = await run(null, undefined, false);
  expect(seen).toHaveLength(0);
});

test('하니스 구현 자식(executor) → goal loop 1 · seatTurnCap 없음', async () => {
  const prev = process.env[HARNESS_ROLE_ENV];
  process.env[HARNESS_ROLE_ENV] = 'executor';
  try {
    const { seen } = await run('OPT');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.seatTurnCap).toBeUndefined();
  } finally {
    if (prev === undefined) delete process.env[HARNESS_ROLE_ENV];
    else process.env[HARNESS_ROLE_ENV] = prev;
  }
});

test('user config(SEAT-TURN-CAP-DEFAULT-15M): chat.seatTurnCap 칸이 삭제됐다 — 설정해도 스키마에 남지 않는다', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'seat-turn-cap-'));
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ chat: { seatTurnCap: { maxTools: 40 } } })); // 출처: #38786 — SEAT-TURN-CAP-DEFAULT-15M 스키마 칸 삭제 반증용 시험값
    expect('seatTurnCap' in config.buildUserConfig(path).chat).toBe(false); // 칸 삭제 — 조용히 버린다
    writeFileSync(path, JSON.stringify({ chat: {} }));
    expect('seatTurnCap' in config.buildUserConfig(path).chat).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
