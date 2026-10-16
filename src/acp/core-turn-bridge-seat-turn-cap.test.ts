// TUI-SEAT-TURN-CAP — 브리지가 «자리 판정으로 goal loop 에 온 턴» 에만 seatTurnCap 을 넘기는가(사람 TUI·하니스 자식 0).
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as core from '../core-turn/index.js';
import * as config from '../user-config.js';
import type { GoalLoopOptions } from '../core-turn/run-goal-loop.js';
import type { AcpTurnContext } from './server.js';
import { bridgeCoreTurnToAcp } from './core-turn-bridge.js';
import { SEAT_TURN_CAP_DEFAULTS } from '../core-turn/seat-turn-cap.js';
import { HARNESS_ROLE_ENV } from '../harness/harness-space.js';

afterEach(() => mock.restore());

const text = 'OP 13:14: 계속 — draft 다음 행.';
const specs = ['Read', 'RunShell'].map((name) => ({ name, description: '', parameters: { type: 'object' as const } }));

async function run(seat: string | null, seatTurnCap?: Record<string, unknown>) {
  const seen: GoalLoopOptions[] = [];
  spyOn(core, 'runGoalLoop').mockImplementation(async (_ctx, opts) => {
    seen.push(opts ?? {});
    return { finalText: '', iterations: 1, stopReason: 'goal_complete', goalComplete: true };
  });
  spyOn(core, 'runCoreTurn').mockImplementation(async () => ({ stopReason: 'end_turn', finalText: '' }));
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base,
    llm: { ...base.llm, model: 'gpt-4o-mini', goalLoop: { enabled: true } },
    chat: { ...base.chat, ...(seatTurnCap ? { seatTurnCap } : {}) },
  });
  await bridgeCoreTurnToAcp({
    tuiRouting: true, resolveSeat: () => seat,
    getMessages: () => [{ role: 'user', content: text }], getTools: () => specs, dispatchTool: async () => ({}),
  })({
    sessionId: 'seat-cap', cwd: '/tmp', userText: text,
    promptBlocks: [{ type: 'text', text }], isAborted: () => false,
    push: async () => {}, pushWithMeta: async () => {}, pushSessionUpdate: async () => {},
    pushToolCall: async () => {}, pushToolResult: async () => {}, pushUsage: async () => {},
  } as unknown as AcpTurnContext);
  return seen;
}

test('자리 TUI 운영 지시 → goal loop 에 seatTurnCap(기본 60 도구·20분·빈 우편 2연속)', async () => {
  const seen = await run('OPT');
  expect(seen).toHaveLength(1);
  expect(seen[0]!.seatTurnCap).toEqual({ seat: 'OPT', ...SEAT_TURN_CAP_DEFAULTS });
});

test('config chat.seatTurnCap 으로 덮는다(유효 칸만)', async () => {
  const seen = await run('OPT', { maxTools: 30, maxWallMs: 0 });
  expect(seen[0]!.seatTurnCap).toEqual({ seat: 'OPT', ...SEAT_TURN_CAP_DEFAULTS, maxTools: 30 });
});

test('반증 — 사람 TUI 는 goal loop 를 타지 않거나 타도 seatTurnCap 이 없다', async () => {
  const seen = await run(null);
  for (const opts of seen) expect(opts.seatTurnCap).toBeUndefined();
});

test('반증 — 하니스 구현 자식(executor)은 seatTurnCap 이 없다', async () => {
  const prev = process.env[HARNESS_ROLE_ENV];
  process.env[HARNESS_ROLE_ENV] = 'executor';
  try {
    const seen = await run('OPT');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.seatTurnCap).toBeUndefined();
  } finally {
    if (prev === undefined) delete process.env[HARNESS_ROLE_ENV];
    else process.env[HARNESS_ROLE_ENV] = prev;
  }
});

test('user config: chat.seatTurnCap 은 설정했을 때만 있고 유효 칸만 남는다', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'seat-turn-cap-'));
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ chat: { seatTurnCap: { maxTools: 40, idleEmptyMsgListLimit: 'x' } } }));
    expect(config.buildUserConfig(path).chat.seatTurnCap).toEqual({ maxTools: 40 });
    writeFileSync(path, JSON.stringify({ chat: {} }));
    expect('seatTurnCap' in config.buildUserConfig(path).chat).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
