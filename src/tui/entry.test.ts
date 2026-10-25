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
import { writeCliStderr } from '../git-fs/cli-stderr.js';
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
import * as missionToolOriginal from '../autopilot/mission-tool.js';
import * as intentGateOriginal from '../intent-gate/gate.js';
import * as missionWatchOriginal from '../autopilot/mission-tui-watch.js';
import {
  _resetDefaultControlSignalObserverForTesting,
  defaultControlSignalObserver,
} from '../input/control-signal-observer.js';
import {
  _resetDefaultControlSignalBusForTesting,
  defaultControlSignalBus,
  type ControlSignal,
} from '../input/control-signal.js';

// mock.module 복구용 원본 스냅샷 — 정적 import 가 먼저 실행되므로 mock 치환 전 실물이 담긴다.
const restoreTui = { ...tuiOriginal };
const restoreLocalChatTurn = { ...localChatTurnOriginal };
const restoreComposer = { ...composerOriginal };
const restoreBackgroundJobStatus = { ...backgroundJobStatusOriginal };
const restoreMissionTool = { ...missionToolOriginal };
const restoreIntentGate = { ...intentGateOriginal };
const restoreMissionWatch = { ...missionWatchOriginal };

// readKey 가 내보낼 키 열 — 제출 한 턴 뒤 Ctrl+Q 로 TUI 를 닫는다.
const keys: Key[] = [];
const submittedInputs: string[] = [];
const readKeyTicks: number[] = [];
type FakeInterval = { callback: () => void; delayMs: number; active: boolean };
const fakeIntervals: FakeInterval[] = [];
const readySnapshots: unknown[] = [];
const runSnapshots: unknown[] = [];
const timerSnapshots: boolean[][] = [];
const loopEvents: Array<{ event: string; data: unknown }> = [];
// 위임한 턴이 실행된 세션 키 — runLocalChatTurn 목격.
const turnsSeen: string[] = [];
const missionCalls: unknown[] = [];
const transcript: string[] = [];
let duringTurnHook: (() => void) | null = null;
const cliStderrEvents: Array<{ data: { source: string; exitCode: number; text: string; rawBase64: string; byteLength: number } }> = [];

mock.module('../intent-gate/gate.js', () => ({
  submitIntent: async () => ({ route: 'mission', goal: '관찰 테스트', executionModel: 'immediate', tier: 'light', heavy: false, missionId: 'apm_ready' }),
}));

mock.module('../autopilot/mission-tui-watch.js', () => ({
  takeMissionReadySnapshot: (id: string) => { readySnapshots.push(id); return { exists: true, goal: '관찰 테스트', status: 'proposed', description: '', phases: [], executionModel: 'immediate', tier: 'light' }; },
  createMissionWatchState: () => ({}),
  advanceMissionWatch: (state: unknown) => ({ state, events: [{ kind: 'phases', count: 2 }], done: false }),
  MISSION_WATCH_INTERVAL_MS: 3_000,
  takeMissionRunSnapshot: (id: string) => { runSnapshots.push(id); return { exists: true, goal: '관찰 테스트', phases: [], runLockActive: false }; },
  createMissionRunWatchState: () => ({}),
  advanceMissionRunWatch: (state: unknown) => ({ state, events: [{ kind: 'progress', phase: { index: 0 }, total: 1, note: '실제 관찰 tick' }], done: false }),
  MISSION_RUN_WATCH_INTERVAL_MS: 5_000,
  renderMissionRunPhaseLine: () => 'phase',
  renderMissionRunReportLines: () => ['report'],
  renderMissionRunFooter: () => 'footer',
  missionDescriptionDigest: () => [],
  renderMissionPhaseBoardLines: () => [],
}));

mock.module('../autopilot/mission-tool.js', () => ({
  dispatchAutopilotMissions: async (input: unknown) => {
    missionCalls.push(input);
    const request = input as { action?: string };
    const missions = request.action === 'list'
      ? Array.from({ length: 16 }, (_, index) => ({ id: `apm_list_${index}`, status: 'proposed', source: 'test', goal: `미션 ${index}` }))
      : [];
    return { count: missions.length, missions, note: missions.length ? undefined : '미션 없음' };
  },
}));

mock.module('../tui.js', () => ({
  initTui: () => {},
  closeTui: () => {},
  injectKey: () => {},
  readKey: () => {
    const key = keys.shift();
    // 실물 readKey 처럼 키가 오기 전까지는 기다린다(빈 대기열이면 영원히 — 시간초과가 잡는다).
    if (!key) return new Promise<Key>(() => {});
    if (key.ctrl && key.name === 'q') return Bun.sleep(10).then(() => key);
    const ticks = readKeyTicks.shift() ?? 0;
    for (let i = 0; i < ticks; i += 1) {
      for (const timer of fakeIntervals) if (timer.active) timer.callback();
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
    duringTurnHook?.();
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
  composerViewport: () => ({ line: duringTurnHook ? '❯ ' : '', cursorCol: 1 }),
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
  readySnapshots.length = 0;
  runSnapshots.length = 0;
  loopEvents.length = 0;
  turnsSeen.length = 0;
  missionCalls.length = 0;
  transcript.length = 0;
  duringTurnHook = null;
  cliStderrEvents.length = 0;
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
  mock.module('../autopilot/mission-tool.js', () => restoreMissionTool);
  mock.module('../intent-gate/gate.js', () => restoreIntentGate);
  mock.module('../autopilot/mission-tui-watch.js', () => restoreMissionWatch);
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

  test('Next TUI 중 git/gh stderr는 프롬프트를 덮지 않고 화면 오류 경로와 debug.log에 보존된다', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const output = process.stdout.write;
    const errorOutput = process.stderr.write;
    const debugWrite = debug.log;
    const stderrWrites: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      transcript.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    debug.log = ((category: string, event: string, data?: unknown) => {
      if (category === 'tui.cli-stderr' && event === 'captured') {
        cliStderrEvents.push({ data: data as (typeof cliStderrEvents)[number]['data'] });
      }
      return debugWrite.call(debug, category, event, data);
    }) as typeof debug.log;
    const raw = Buffer.from('fatal: synthetic git failure\n');
    duringTurnHook = () => writeCliStderr({ source: 'git', exitCode: 128, raw });
    keys.push(
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'q', ctrl: true, shift: false, raw: '\x11' },
    );
    submittedInputs.push('stderr 격리 확인');
    try {
      await showNextTui({ resumeSessionId: createSession().id });
      const rendered = transcript.join('');
      expect(rendered).toContain('[git stderr · rc=128] fatal: synthetic git failure');
      expect(transcript.at(-1)).toContain('─'.repeat(20));
      expect(transcript.at(-1)).toContain('❯ ');
      expect(stderrWrites).toEqual([]);
      expect(cliStderrEvents).toHaveLength(1);
      expect(cliStderrEvents[0]?.data.rawBase64).toBe(raw.toString('base64'));
      expect(cliStderrEvents[0]?.data.byteLength).toBe(raw.length);

      // The Next TUI releases its temporary sink; ordinary callers still use process.stderr.
      duringTurnHook = null;
      writeCliStderr({ source: 'gh', exitCode: 0, raw: Buffer.from('outside TUI') });
      expect(stderrWrites).toEqual(['outside TUI']);
    } finally {
      debug.log = debugWrite;
      process.stdout.write = output;
      process.stderr.write = errorOutput;
    }
  }, 10_000);

  test('Next 입력 경로가 /mission help·잘못된 하위명령과 read-only list를 dispatcher에 전달한다', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const output = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      transcript.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    keys.push(
      { name: 'enter', ctrl: false, shift: false, raw: '\\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\\r' },
      { name: 'pageup', ctrl: false, shift: false, raw: '' },
      { name: 'escape', ctrl: false, shift: false, raw: '\\x1b' },
      { name: 'enter', ctrl: false, shift: false, raw: '\\r' },
      { name: 'q', ctrl: true, shift: false, raw: '\\x11' },
    );
    submittedInputs.push('/mission', '/mission not-a-command', '/mission list', '/mission list');
    try {
      await showNextTui({ resumeSessionId: createSession().id });
      const rendered = transcript.join('');
      const finalFrame = transcript.at(-1) ?? '';
      expect(rendered).toContain('usage: /mission [list [status]]');
      expect(rendered).toContain('unknown subcommand: not-a-command');
      expect(finalFrame).toContain('apm_list_15');
      expect(missionCalls.filter((call) => JSON.stringify(call) === JSON.stringify({ action: 'list' }))).toHaveLength(3);
      expect(missionCalls.some((call) => JSON.stringify(call) === JSON.stringify({ action: 'list' }))).toBe(true);
    } finally {
      process.stdout.write = output;
    }
  }, 10_000);

  test('Next /term 입력은 가짜 세션 레지스트리로 help·list·status만 읽고 mutation은 거부한다', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const output = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      transcript.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const sessions = [
      { id: 'pty_12345678', title: 'shell-a', kind: 'shell', status: 'running' as const },
      { id: 'pty_87654321', title: 'shell-b', kind: 'shell', status: 'exited' as const },
    ];
    let listCalls = 0;
    keys.push(
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'q', ctrl: true, shift: false, raw: '\x11' },
    );
    submittedInputs.push('/term help', '/term list', '/terminal status', '/terminal matrix', '/term spawn', '/term kill pty_12345678');
    try {
      await showNextTui({
        resumeSessionId: createSession().id,
        termSessions: { list: () => { listCalls += 1; return sessions; } },
      });
      const rendered = transcript.join('');
      expect(rendered).toContain('/term help');
      expect(rendered).toContain('pty_12345678'.slice(-8));
      expect(rendered).toContain('1 live · 1 exited');
      expect(rendered).toContain('pty_87654321');
      expect(rendered).toContain('unknown');
      expect(rendered).toContain('Unsupported /term command in Next TUI: spawn');
      expect(rendered).toContain('Unsupported /term command in Next TUI: kill');
      expect(listCalls).toBe(3);
      expect(turnsSeen).toEqual([]);
    } finally {
      process.stdout.write = output;
    }
  }, 10_000);

  test('Next 입력의 new/watch가 ready·run 관찰 snapshot을 실제 폴링한다', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const timerHost = globalThis as unknown as { setInterval: typeof globalThis.setInterval; clearInterval: typeof globalThis.clearInterval };
    timerHost.setInterval = ((callback: () => void, delayMs = 0) => {
      const timer: FakeInterval = { callback, delayMs, active: true };
      fakeIntervals.push(timer);
      if (delayMs === 3_000 || delayMs === 5_000) queueMicrotask(callback);
      return timer as unknown as ReturnType<typeof setInterval>;
    }) as typeof timerHost.setInterval;
    timerHost.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
      (handle as unknown as FakeInterval).active = false;
    }) as typeof timerHost.clearInterval;
    keys.push(
      { name: 'enter', ctrl: false, shift: false, raw: '\\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\\r' },
      { name: 'q', ctrl: true, shift: false, raw: '\\x11' },
    );
    submittedInputs.push('/mission new goal', '/mission watch apm_run');
    readKeyTicks.push(0, 0, 1);
    try {
      await showNextTui({ resumeSessionId: createSession().id });
      await Bun.sleep(10);
      expect(readySnapshots.filter((id) => id === 'apm_ready').length).toBeGreaterThan(1);
      expect(runSnapshots.filter((id) => id === 'apm_run').length).toBeGreaterThan(1);
      expect(fakeIntervals.some((timer) => timer.delayMs === 3_000)).toBe(true);
      expect(fakeIntervals.some((timer) => timer.delayMs === 5_000)).toBe(true);
    } finally {
      timerHost.setInterval = originalSetInterval;
      timerHost.clearInterval = originalClearInterval;
    }
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
      setInterval: typeof globalThis.setInterval;
      clearInterval: typeof globalThis.clearInterval;
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

// GOAL d0f18e35870f4714 — /signals(관측 전용). Next 소유 handler가 실제 defaultControlSignalObserver
// 싱글턴의 읽기 API(list·latest·countsByKind)만 소비한다. 시드 신호는 아래 setup 에서만
// defaultControlSignalBus.emit 으로 발행한다 — clear·emit·observer mutation 은 생산 코드에 없다.
describe('src/tui/entry.ts — /signals 관측(읽기 전용) 슬래시', () => {
  type SeedSignal = { kind: string; urgency: ControlSignal['urgency']; sessionId: string; createdAt: string };

  // 싱글턴이 먼저 버스를 구독한 뒤에 발행해야 관측된다(구독 이전 발행은 잡히지 않는다).
  function seedSignals(seeds: SeedSignal[]): void {
    _resetDefaultControlSignalBusForTesting();
    _resetDefaultControlSignalObserverForTesting();
    defaultControlSignalObserver();
    for (const seed of seeds) {
      defaultControlSignalBus().emit({
        kind: seed.kind,
        urgency: seed.urgency,
        source: 'system',
        createdAt: seed.createdAt,
        scope: { sessionId: seed.sessionId },
      });
    }
  }

  function stageNextTuiSession(submits: string[]): () => void {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const output = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      transcript.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    for (const submit of submits) {
      keys.push({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
      submittedInputs.push(submit);
    }
    keys.push({ name: 'q', ctrl: true, shift: false, raw: '\x11' });
    return () => {
      process.stdout.write = output;
    };
  }

  afterEach(() => {
    _resetDefaultControlSignalBusForTesting();
    _resetDefaultControlSignalObserverForTesting();
  });

  test('/signals help·status·latest·list transcript가 실제 default observer를 거쳐 뜬다', async () => {
    seedSignals([
      { kind: 'user-input-failure', urgency: 'normal', sessionId: 'seed-a', createdAt: '2026-10-23T22:13:20.000Z' },
      { kind: 'provider-credential', urgency: 'normal', sessionId: 'seed-a', createdAt: '2026-10-23T22:13:21.000Z' },
    ]);
    const restore = stageNextTuiSession(['/signals help', '/signals status', '/signals latest', '/signals list']);
    try {
      await showNextTui({ resumeSessionId: createSession().id });
      const rendered = transcript.join('');
      expect(rendered).toContain('❯ /signals help');
      expect(rendered).toContain('usage: /signals [help|status|latest|list [kind]]');
      expect(rendered).toContain('신호 총 2건 · 종류 2종');
      expect(rendered).toContain('provider-credential ×1');
      expect(rendered).toContain('user-input-failure ×1');
      expect(rendered).toContain('❯ /signals latest');
      expect(rendered).toContain('[normal] provider-credential · 22:13:21 · session seed-a');
      expect(rendered).toContain('❯ /signals list (2건)');
      expect(rendered).toContain('[normal] user-input-failure · 22:13:20');
    } finally {
      restore();
    }
  }, 10_000);

  test('/signals list <kind> 필터는 해당 종류만 보여준다', async () => {
    seedSignals([
      { kind: 'user-input-failure', urgency: 'normal', sessionId: 'seed-b', createdAt: '2026-10-23T22:13:20.000Z' },
      { kind: 'provider-credential', urgency: 'normal', sessionId: 'seed-b', createdAt: '2026-10-23T22:13:21.000Z' },
    ]);
    const restore = stageNextTuiSession(['/signals list user-input-failure']);
    try {
      await showNextTui({ resumeSessionId: createSession().id });
      const rendered = transcript.join('');
      expect(rendered).toContain('❯ /signals list user-input-failure (1건)');
      expect(rendered).toContain('[normal] user-input-failure · 22:13:20');
      expect(rendered).not.toContain('provider-credential');
    } finally {
      restore();
    }
  }, 10_000);

  test('빈 observer 상태의 status·latest·list는 빈 결과를 보여준다', async () => {
    seedSignals([]);
    const restore = stageNextTuiSession(['/signals status', '/signals latest', '/signals list']);
    try {
      await showNextTui({ resumeSessionId: createSession().id });
      const rendered = transcript.join('');
      expect(rendered).toContain('관측된 신호 없음 (총 0건)');
      expect(rendered).toContain('최신 신호 없음');
      expect(rendered).toContain('❯ /signals list (0건)');
    } finally {
      restore();
    }
  }, 10_000);

  test('/signals clear·emit은 out of scope 로 거절되고 관측 기록은 불변이다', async () => {
    seedSignals([
      { kind: 'user-input-failure', urgency: 'normal', sessionId: 'seed-c', createdAt: '2026-10-23T22:13:20.000Z' },
    ]);
    const restore = stageNextTuiSession(['/signals clear', '/signals emit 안녕', '/signals bogus', '/signals list']);
    try {
      await showNextTui({ resumeSessionId: createSession().id });
      const rendered = transcript.join('');
      expect(rendered).toContain('out of scope — /signals는 관측 전용입니다');
      expect(rendered).toContain('unknown subcommand: bogus');
      expect(rendered).toContain('❯ /signals list (1건)'); // clear·emit 시도 뒤에도 관측 기록은 불변
      expect(rendered).toContain('[normal] user-input-failure · 22:13:20');
    } finally {
      restore();
    }
  }, 10_000);
});
