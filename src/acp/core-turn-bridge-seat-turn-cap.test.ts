// TUI-SEAT-TURN-CAP — 브리지가 «자리 판정으로 goal loop 에 온 턴» 에만 seatTurnCap 을 넘기는가(사람 TUI·하니스 자식 0).
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as coreTurn from '../core-turn/run-core-turn.js';
import * as coreGoalLoop from '../core-turn/run-goal-loop.js';
import * as config from '../user-config.js';
import type { GoalLoopOptions } from '../core-turn/run-goal-loop.js';
import type { AcpTurnContext } from './server.js';
import { bridgeCoreTurnToAcp } from './core-turn-bridge.js';
import { SEAT_TURN_CAP_DEFAULTS } from '../core-turn/seat-turn-cap.js';
import { HARNESS_ROLE_ENV } from '../harness/harness-space.js';

afterEach(() => mock.restore());

const text = 'OP 13:14: 계속 — draft 다음 행.';
const specs = ['Read', 'RunShell'].map((name) => ({ name, description: '', parameters: { type: 'object' as const } }));

async function run(seat: string | null, chatConfigOverride?: Record<string, unknown>) {
  const seen: GoalLoopOptions[] = [];
  spyOn(coreGoalLoop, 'runGoalLoop').mockImplementation(async (_ctx, opts) => {
    seen.push(opts ?? {});
    return { finalText: '', iterations: 1, stopReason: 'goal_complete', goalComplete: true };
  });
  spyOn(coreTurn, 'runCoreTurn').mockImplementation(async () => ({ stopReason: 'end_turn', finalText: '' }));
  const base = config.getUserConfig();
  spyOn(config, 'getUserConfig').mockReturnValue({
    ...base,
    llm: { ...base.llm, model: 'gpt-4o-mini', goalLoop: { enabled: true } },
    chat: { ...base.chat, ...(chatConfigOverride ?? {}) },
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

test('자리 TUI 운영 지시 → goal loop 에 seatTurnCap(기본 60 도구·45분·빈 우편 2연속)', async () => {
  const seen = await run('OPT');
  expect(seen).toHaveLength(1);
  expect(seen[0]!.seatTurnCap).toEqual({ seat: 'OPT', ...SEAT_TURN_CAP_DEFAULTS });
  expect(SEAT_TURN_CAP_DEFAULTS.maxWallMs).toBe(45 * 60_000); // 자리 턴 기본 상한은 45분
});

test('반증(SEAT-TURN-CAP-DEFAULT-15M) — config chat.seatTurnCap 은 더 이상 칸이 없다(설정해도 무시)', async () => {
  const seen = await run('OPT', { seatTurnCap: { maxTools: 30, maxWallMs: 0 } }); // 출처: #38786 — SEAT-TURN-CAP-DEFAULT-15M 칸 삭제 반증용 리터럴(무시됨을 증명)
  expect(seen[0]!.seatTurnCap).toEqual({ seat: 'OPT', ...SEAT_TURN_CAP_DEFAULTS }); // 덮기 없음 — 기본값 그대로
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
