/**
 * TURN-START-BLOCK-REST — src/tui/entry.ts 턴 경계 recorder 배선 계약.
 *
 * showNextTui → runLocalChatTurn 위임 경로에서 한 턴의 시작 경계와 첫 응답 경계
 * (endedBy=stream-open)가 같은 세션 키로 닫혀 `tui.turn-start segments` 로그 한 줄로
 * 남는지를 잰다. 다른 세션 키의 경계는 0건이어야 한다.
 *
 * 세션 스토어(../session/index.js)는 preload 격리 tmp 위에서 실물로 돈다.
 * 시차·파생 우주를 지우기 위해 TUI 가 그리는 입·출력 계층(../tui.js ·
 * ./input/composer.js · ./chat/background-job-status.js ·
 * ../tui-client/local-chat-turn.js)만 mock.module 로 갈아끼운다 — 이 넷의 소비자는
 * entry.ts 가 유일하다. 턴 경계 배선 자체(src/tui/entry.ts ·
 * src/dashboard/turn-start-segments.ts · src/tui/input-lag-probe.ts)는 실물로 돈다 —
 * 닫힌 턴의 줄은 실제 지연 emit(박동 두 번)까지 기다려 읽는다.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { debug } from '../debug/log.js';
import {
  TURN_START_CATEGORY,
  TURN_START_SEGMENTS_EVENT,
  setTurnStartSegments,
  type TurnStartSegments,
} from '../dashboard/turn-start-segments.js';
import type { Key } from '../tui.js';
import * as tuiOriginal from '../tui.js';
import * as localChatTurnOriginal from '../tui-client/local-chat-turn.js';
import * as composerOriginal from './input/composer.js';
import * as backgroundJobStatusOriginal from './chat/background-job-status.js';

// mock.module 복구용 원본 스냅샷 — 정적 import 가 먼저 실행되므로 mock 치환 전 실물이 담긴다.
const restoreTui = { ...tuiOriginal };
const restoreLocalChatTurn = { ...localChatTurnOriginal };
const restoreComposer = { ...composerOriginal };
const restoreBackgroundJobStatus = { ...backgroundJobStatusOriginal };

// readKey 가 내보낼 키 열 — 제출 한 턴 뒤 Ctrl+Q 로 TUI 를 닫는다.
const keys: Key[] = [];
const submittedInputs: string[] = [];
const readKeyTicks: number[] = [];
type FakeInterval = { callback: () => void; delayMs: number; active: boolean };
const fakeIntervals: FakeInterval[] = [];
const timerSnapshots: boolean[][] = [];
const loopEvents: Array<{ event: string; data: unknown }> = [];
// 위임한 턴이 실행된 세션 키 — runLocalChatTurn 목격.
const turnsSeen: string[] = [];

mock.module('../tui.js', () => ({
  initTui: () => {},
  closeTui: () => {},
  injectKey: () => {},
  readKey: () => {
    const key = keys.shift();
    // 실물 readKey 처럼 키가 오기 전까지는 기다린다(빈 대기열이면 영원히 — 시간초과가 잡는다).
    if (!key) return new Promise<Key>(() => {});
    const ticks = readKeyTicks.shift() ?? 0;
    for (let i = 0; i < ticks; i += 1) {
      for (const timer of fakeIntervals) if (timer.delayMs === 1_000 && timer.active) timer.callback();
    }
    timerSnapshots.push(fakeIntervals.filter((timer) => timer.delayMs === 1_000).map((timer) => timer.active));
    return Promise.resolve(key);
  },
}));

mock.module('../tui-client/local-chat-turn.js', () => ({
  runLocalChatTurn: async (
    sessionId: string,
    _text: string,
    _signal: AbortSignal,
    _cli: unknown,
    _writePrompt: unknown,
    onDelta?: (delta: string) => void,
  ) => {
    turnsSeen.push(sessionId);
    onDelta?.('첫 응답 델타');
  },
  closeLocalChatSession: async () => {},
  // 실물은 구독 정지 함수를 반환한다 — entry 가 backgroundSubscription.stop ??= 로 싣는 값이다.
  onLocalChatBackgroundStatus: (_sessionId: string, _onFrame: (frame: unknown) => void) => () => {},
  localChatModel: () => 'fake-model',
}));

mock.module('./input/composer.js', () => ({
  MOUSE_RESIDUE_WINDOW_MS: 500,
  MouseResidueGuard: class {
    arm(): void {}
    accept(): { kind: 'pass' } {
      return { kind: 'pass' };
    }
  },
  emptyComposer: () => ({ text: '' }),
  applyComposerKey: (state: unknown, key: Key) => {
    if (key.ctrl && key.name === 'q') return { state, action: 'quit' };
    if (key.name === 'enter') {
      const submitted = submittedInputs.shift();
      if (submitted) return { state, action: 'submit', submitted };
    }
    return { state, action: 'edit' };
  },
  composerViewport: () => ({ line: '', cursorCol: 1 }),
  wheelDirection: () => null,
}));

mock.module('./chat/background-job-status.js', () => ({
  BackgroundJobStatus: class {
    line(): string | null {
      return null;
    }
    setSessionId(): void {}
    clear(): void {}
  },
}));

const { showNextTui } = await import('./entry.js');
const { createSession } = await import('../session/index.js');

// 턴 경계 줄을 debug.log 진입에서 캡처한다 — 싱크 등록 여부와 무관하게 recorder 가 남긴 줄이 여기를 지난다.
const rawDebugLog = debug.log;
const captured: Array<{ data: TurnStartSegments }> = [];
debug.log = ((category: string, event: string, data?: unknown) => {
  if (category === TURN_START_CATEGORY && event === TURN_START_SEGMENTS_EVENT) {
    captured.push({ data: data as TurnStartSegments });
  }
  if (category === 'dashboard.loop') loopEvents.push({ event, data });
  return rawDebugLog.call(debug, category, event, data);
}) as typeof debug.log;

afterEach(() => {
  debug.log = rawDebugLog;
  setTurnStartSegments(null);
  keys.length = 0;
  submittedInputs.length = 0;
  readKeyTicks.length = 0;
  fakeIntervals.length = 0;
  timerSnapshots.length = 0;
  loopEvents.length = 0;
  turnsSeen.length = 0;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: undefined, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: undefined, configurable: true });
});

// R-TST23 — afterAll 마지막으로 원본을 반환하는 mock.module 로 네 치환을 복구한다.
afterAll(() => {
  mock.module('../tui.js', () => restoreTui);
  mock.module('../tui-client/local-chat-turn.js', () => restoreLocalChatTurn);
  mock.module('./input/composer.js', () => restoreComposer);
  mock.module('./chat/background-job-status.js', () => restoreBackgroundJobStatus);
});

describe('src/tui/entry.ts — showNextTui 턴 경계 recorder 배선', () => {
  test('한 턴에 시작·첫 응답 경계가 같은 세션 키로 닫히고 다른 세션 경계는 0건', async () => {
    captured.length = 0;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    keys.push(
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'q', ctrl: true, shift: false, raw: '\x11' },
    );
    submittedInputs.push('경계 관측 턴');
    const session = createSession();
    const turnSessionKey = session.id;
    await showNextTui({ resumeSessionId: turnSessionKey });
    // 닫힌 턴의 줄은 박동 두 번 뒤에 emit 된다(turn-start-segments close) — 실제 타이머만큼 기다린다.
    await Bun.sleep(400);
    expect(turnsSeen).toEqual([turnSessionKey]);
    expect(captured.length).toBe(1); // 한 줄
    const line = captured[0]!;
    expect(line.data.key).toBe(turnSessionKey); // 같은 세션 키로 닫힘
    expect(line.data.endedBy).toBe('stream-open'); // 첫 응답 경계
    expect(line.data.order.at(-1)).toBe('stream-open'); // 닫는 경계가 첫 응답 경계다
    // 시간은 recorder 가 남긴 줄 «자체» 의 칸으로 잰다(캡처 훅이 만든 시각이 아니다 — r3 GOODHART 지적).
    const streamOpenMs = line.data.segmentsMs['stream-open'];
    expect(typeof streamOpenMs).toBe('number'); // 첫 응답 경계 덩어리가 시계 값을 실었다
    expect(streamOpenMs).toBeGreaterThanOrEqual(0);
    expect(line.data.totalMs).toBeGreaterThanOrEqual(0);
    expect(line.data.totalMs).toBe(Object.values(line.data.segmentsMs).reduce((a, b) => Math.round((a + b) * 10) / 10, 0));
    expect(line.data.closedAfterMs).toBeGreaterThanOrEqual(line.data.totalMs); // stream-open 이면 같거나 크다
    expect(captured.filter((l) => l.data.key !== turnSessionKey).length).toBe(0); // 다른 세션 경계 0건
  }, 10_000);

  test('실제 입력 경로에서 /new·/resume·종료가 활성 loop 타이머를 해제한다', async () => {
    loopEvents.length = 0;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const resumeTarget = createSession({ source: 'tui' });
    const starting = createSession({ source: 'tui' });
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const originalAutoturn = process.env.ELANOUS_TUI_AUTOTURN;
    const savedLog = debug.log;
    const timerHost = globalThis as unknown as {
      setInterval: (callback: (...args: never[]) => void, delay?: number) => ReturnType<typeof setInterval>;
      clearInterval: (handle: ReturnType<typeof setInterval>) => void;
    };
    timerHost.setInterval = ((callback: () => void, delayMs = 0) => {
      const timer: FakeInterval = { callback, delayMs, active: true };
      fakeIntervals.push(timer);
      return timer as unknown as ReturnType<typeof setInterval>;
    }) as typeof timerHost.setInterval;
    timerHost.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
      (handle as unknown as FakeInterval).active = false;
    }) as typeof timerHost.clearInterval;
    process.env.ELANOUS_TUI_AUTOTURN = '0';
    debug.log = ((category: string, event: string, data?: unknown) => {
      if (category === 'dashboard.loop') loopEvents.push({ event, data });
      return savedLog.call(debug, category, event, data);
    }) as typeof debug.log;
    keys.push(
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'q', ctrl: true, shift: false, raw: '\x11' },
    );
    submittedInputs.push(
      '/loop 1s stale-before-new',
      '/new',
      '/loop 1s stale-before-resume',
      `/resume ${resumeTarget.id.slice(0, 8)}`,
      '/loop 1s stale-after-exit',
    );
    // Tick once before /new and /resume to prove each loop was armed; tick again after each
    // transition and after exit to prove the prior timer was actually unsubscribed.
    readKeyTicks.push(0, 1, 1, 1, 1, 0);
    try {
      await showNextTui({ resumeSessionId: starting.id });
      const loopTimers = fakeIntervals.filter((timer) => timer.delayMs === 1_000);
      expect(loopTimers).toHaveLength(3);
      expect(loopEvents).toHaveLength(2);
      expect(timerSnapshots[1]).toEqual([true]); // first loop active before /new
      expect(timerSnapshots[2]).toEqual([false]); // /new cleared first loop before next command
      expect(timerSnapshots[3]).toEqual([false, true]); // second loop active before /resume
      expect(timerSnapshots[4]).toEqual([false, false]); // /resume cleared second loop before next command
      expect(loopTimers.every((timer) => !timer.active)).toBe(true); // /new, /resume, and TUI exit
    } finally {
      debug.log = savedLog;
      timerHost.setInterval = originalSetInterval;
      timerHost.clearInterval = originalClearInterval;
      if (originalAutoturn === undefined) delete process.env.ELANOUS_TUI_AUTOTURN;
      else process.env.ELANOUS_TUI_AUTOTURN = originalAutoturn;
    }
  }, 10_000);
});
