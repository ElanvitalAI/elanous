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
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import {
  _resetDefaultControlSignalObserverForTesting,
  defaultControlSignalObserver,
} from '../input/control-signal-observer.js';
import {
  _resetDefaultControlSignalBusForTesting,
  defaultControlSignalBus,
  type ControlSignal,
} from '../input/control-signal.js';
import { removePtyManifest, updatePtyManifestSession, upsertPtyManifest } from '../pty-shell/pty-manifest.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { setResolveDaemonEndpointForTest } from '../nexus/daemon-endpoint.js';
import { appendSimWorldWatchEvents } from '../ux-sim/world-watch.js';
import * as uxSimWorldOriginal from '../ux-sim/world.js';
import { clearSessionTierOverride } from '../model-tier/session-override.js';
import { resolveLlmTier } from '../model-tier/tier-resolver.js';
import { NEXT_TUI_ROUTE_REGISTRY, type NextTuiRoute } from './core/registry.js';
import type { NextSidetabHandler } from './sidetab/nl-tool.js';
import type { MessageBlock } from '../conv-substrate/message-block.js';

// mock.module 복구용 원본 스냅샷 — 정적 import 가 먼저 실행되므로 mock 치환 전 실물이 담긴다.
const restoreTui = { ...tuiOriginal };
const restoreLocalChatTurn = { ...localChatTurnOriginal };
const restoreComposer = { ...composerOriginal };
const restoreBackgroundJobStatus = { ...backgroundJobStatusOriginal };
const restoreUxSimWorld = { ...uxSimWorldOriginal };

// readKey 가 내보낼 키 열 — 제출 한 턴 뒤 Ctrl+Q 로 TUI 를 닫는다.
const keys: Key[] = [];
let keysAfterTurn: Key[] = [];
const submittedInputs: string[] = [];
const readKeyTicks: number[] = [];
let pendingReadKeyResolver: ((key: Key) => void) | null = null;
type FakeInterval = { callback: () => void; delayMs: number; active: boolean };
const fakeIntervals: FakeInterval[] = [];
const timerSnapshots: boolean[][] = [];
let beforeFakeTimerTick: (() => void) | null = null;
const loopEvents: Array<{ event: string; data: unknown }> = [];
// 위임한 턴이 실행된 세션 키 — runLocalChatTurn 목격.
const turnsSeen: string[] = [];
const turnTiersSeen: Array<{ tier: string; source: string }> = [];
const transcript: string[] = [];
function replayPaintWrites(writes: readonly string[]): string[] {
  const rows: string[] = [];
  const snapshots: string[] = [];
  for (const write of writes) {
    if (write.includes('\x1b[H\x1b[2J')) rows.length = 0;
    let cursorRow = 0;
    const tokens = write.split(/(\x1b\[[0-9;?]*[A-Za-z])/g);
    for (const token of tokens) {
      const cursor = token.match(/^\x1b\[(\d+);1H$/);
      if (cursor) {
        cursorRow = Math.max(0, Number(cursor[1]) - 1);
      } else if (token === '\x1b[2K') {
        rows[cursorRow] = '';
      } else if (!token.startsWith('\x1b[') && token.length > 0) {
        rows[cursorRow] = `${rows[cursorRow] ?? ''}${token}`;
      }
    }
    snapshots.push(rows.join('\n'));
  }
  return snapshots;
}
const turnAbortSignals: AbortSignal[] = [];
let duringTurnHook: ((signal: AbortSignal) => void | Promise<void>) | null = null;
type ShellActivityEvent =
  | { phase: 'start'; id: string; name: 'Bash' | 'RunShell'; startedAtMonotonicMs: number }
  | { phase: 'finish'; id: string; name: 'Bash' | 'RunShell' }
  | { phase: 'snapshot'; calls: Array<{ id: string; name: 'Bash' | 'RunShell'; startedAtMonotonicMs: number }> };
let shellActivityHandler: ((event: ShellActivityEvent) => void) | null = null;
let toolActivityHandler: ((event: import('../tui-client/local-chat-turn.js').LocalChatToolActivity) => void) | null = null;
let pushNowResultHandler: ((event: import('../tui-client/local-chat-turn.js').LocalChatPushNowResult) => void) | null = null;
let agentEventHandler: ((event: import('./core/agents.js').AgentDisplayEvent) => void) | null = null;
let backgroundStatusHandler: ((frame: string | null) => void) | null = null;
let delayedPushNowProbe = false;
let pendingPushNowRequestId: string | null = null;
const committedPushNowIds: string[] = [];
const requestedPushNowIds: string[] = [];
let mockToolSnapshot: Array<{ id: string; name: string }> = [];
let mockLocalChatTurnResult: { goalComplete?: boolean; goalStopReason?: string } | undefined;
let mockBackgroundLine: string | null = null;
let messageBlocksForTurn: MessageBlock[] = [];
let selfHealthListener: ((snapshot: import('../tui/chat/self-health-status.js').NextTuiSelfHealthSnapshot | null) => void) | null = null;
let nextSidetabHandler: NextSidetabHandler | null = null;
let shellApprovalHandler: ((command: string, callId: string) => Promise<boolean>) | null = null;
let shellApprovalCancelHandler: ((callId: string, reason: 'timeout' | 'turn-cancelled' | 'host-cancelled') => void) | null = null;
const cliStderrEvents: Array<{ data: { source: string; exitCode: number; text: string; rawBase64: string; byteLength: number } }> = [];
let isolatedTestStateRoot: string | undefined;
let priorTestStateRoot: string | undefined;
let priorStateDir: string | undefined;
let priorSimWorldId: string | undefined;

function enqueueReadKey(key: Key): void {
  const resolve = pendingReadKeyResolver;
  if (!resolve) { keys.push(key); return; }
  pendingReadKeyResolver = null;
  resolve(key);
}

beforeEach(() => {
  priorTestStateRoot = getTestStateRoot();
  priorStateDir = process.env.ELANOUS_STATE_DIR;
  priorSimWorldId = process.env.ELANOUS_SIM_WORLD_ID;
  isolatedTestStateRoot = mkdtempSync(join(tmpdir(), 'tui-entry-test-'));
  mkdirSync(join(isolatedTestStateRoot, 'sim'), { recursive: true });
  setTestStateRoot(isolatedTestStateRoot);
  process.env.ELANOUS_STATE_DIR = isolatedTestStateRoot;
  delete process.env.ELANOUS_SIM_WORLD_ID;
});

mock.module('../tui.js', () => ({
  initTui: () => {},
  closeTui: () => {},
  injectKey: () => {},
  readKey: () => {
    const key = keys.shift();
    // 실물 readKey 처럼 키가 오기 전까지는 기다린다(빈 대기열이면 영원히 — 시간초과가 잡는다).
    if (!key) return new Promise<Key>((resolve) => { pendingReadKeyResolver = resolve; });
    if (key.ctrl && key.name === 'q') return Bun.sleep(10).then(() => key);
    const ticks = readKeyTicks.shift() ?? 0;
    for (let i = 0; i < ticks; i += 1) {
      for (const timer of fakeIntervals) if (timer.active) {
        beforeFakeTimerTick?.();
        beforeFakeTimerTick = null;
        timer.callback();
      }
    }
    timerSnapshots.push(fakeIntervals.filter((timer) => timer.delayMs === 1_000).map((timer) => timer.active));
    return Promise.resolve(key);
  },
}));

mock.module('../tui-client/local-chat-turn.js', () => ({
  setNextSidetabHandler: (handler: NextSidetabHandler | null) => { nextSidetabHandler = handler; },
  setNextTuiShellApprovalHandler: (handler: ((command: string, callId: string) => Promise<boolean>) | null) => { shellApprovalHandler = handler; },
  setNextTuiShellApprovalCancelHandler: (handler: typeof shellApprovalCancelHandler) => { shellApprovalCancelHandler = handler; },
  runLocalChatTurn: async (
    sessionId: string,
    _text: string,
    signal: AbortSignal,
    _cli: unknown,
    _writePrompt: unknown,
    onDelta?: (delta: string) => void,
    _onCompact?: { onMessageBlock?: (block: MessageBlock) => void },
    _attachments?: unknown,
    _onStatus?: unknown,
    _onAgent?: (event: import('./core/agents.js').AgentDisplayEvent) => void,
    onShellActivity?: (event: ShellActivityEvent) => void,
    onToolActivity?: (event: import('../tui-client/local-chat-turn.js').LocalChatToolActivity) => void,
    onPushNowResult?: (event: import('../tui-client/local-chat-turn.js').LocalChatPushNowResult) => void,
  ) => {
    turnAbortSignals.push(signal);
    shellActivityHandler = onShellActivity ?? null;
    toolActivityHandler = onToolActivity ?? null;
    pushNowResultHandler = onPushNowResult ?? null;
    agentEventHandler = _onAgent ?? null;
    turnsSeen.push(sessionId);
    const tier = resolveLlmTier(undefined, 'openai-codex', { sessionId });
    turnTiersSeen.push({ tier: tier.tier, source: tier.source });
    onDelta?.('첫 응답 델타');
    for (const block of messageBlocksForTurn) _onCompact?.onMessageBlock?.(block);
    messageBlocksForTurn = [];
    await duringTurnHook?.(signal);
    const afterTurn = keysAfterTurn;
    keysAfterTurn = [];
    if (afterTurn.length) setTimeout(() => afterTurn.forEach(enqueueReadKey), 25);
    return mockLocalChatTurnResult;
  },
  requestLocalChatShellActivitySnapshot: () => {
    shellActivityHandler?.({ phase: 'snapshot', calls: [] });
    queueMicrotask(() => toolActivityHandler?.({ phase: 'snapshot', calls: [...mockToolSnapshot] }));
    return true;
  },
  requestLocalChatPushNow: (_sessionId: string, requestId: string) => {
    requestedPushNowIds.push(requestId);
    if (delayedPushNowProbe) pendingPushNowRequestId = requestId;
    else queueMicrotask(() => pushNowResultHandler?.({ requestId, outcome: mockToolSnapshot.length ? 'deferred' : 'ready', activeTools: mockToolSnapshot.map((call) => call.name) }));
    return true;
  },
  commitLocalChatPushNow: (_sessionId: string, requestId: string) => {
    committedPushNowIds.push(requestId);
    queueMicrotask(() => pushNowResultHandler?.({ requestId, outcome: mockToolSnapshot.length ? 'deferred' : 'interrupted', activeTools: mockToolSnapshot.map((call) => call.name) }));
    return true;
  },
  closeLocalChatSession: async () => {},
  // 실물은 구독 정지 함수를 반환한다 — entry 가 backgroundSubscription.stop ??= 로 싣는 값이다.
  onLocalChatBackgroundStatus: (_sessionId: string, onFrame: (frame: string | null) => void) => {
    backgroundStatusHandler = onFrame;
    return () => { backgroundStatusHandler = null; };
  },
  onLocalChatSelfHealthStatus: (
    _sessionId: string,
    listener: (snapshot: import('../tui/chat/self-health-status.js').NextTuiSelfHealthSnapshot | null) => void,
  ) => {
    selfHealthListener = listener;
    return () => { selfHealthListener = null; };
  },
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
      return mockBackgroundLine;
    }
    setSessionId(): void {}
    clear(): void {}
  },
}));

const { nextTuiShellEscDecision, shellApprovalCommandViewport, showNextTui } = await import('./entry.js');
const { LONG_SHELL_ESC_CONFIRMATION_MS } = await import('../esc-abort-gate.js');
const { appendMessage, createSession, getActiveSessionId, loadSession, setActiveSessionId } = await import('../session/index.js');

// 턴 경계 줄을 debug.log 진입에서 캡처한다 — 싱크 등록 여부와 무관하게 recorder 가 남긴 줄이 여기를 지난다.
const rawDebugLog = debug.log;
const captured: Array<{ data: TurnStartSegments }> = [];
const captureDebugLog = ((category: string, event: string, data?: unknown) => {
  if (category === TURN_START_CATEGORY && event === TURN_START_SEGMENTS_EVENT) {
    captured.push({ data: data as TurnStartSegments });
  }
  if (category === 'dashboard.loop') loopEvents.push({ event, data });
  return rawDebugLog.call(debug, category, event, data);
}) as typeof debug.log;
debug.log = captureDebugLog;

afterEach(() => {
  debug.log = rawDebugLog;
  setTurnStartSegments(null);
  keys.length = 0;
  keysAfterTurn = [];
  pendingReadKeyResolver = null;
  submittedInputs.length = 0;
  readKeyTicks.length = 0;
  fakeIntervals.length = 0;
  beforeFakeTimerTick = null;
  timerSnapshots.length = 0;
  loopEvents.length = 0;
  for (const sessionId of turnsSeen) clearSessionTierOverride(sessionId);
  turnsSeen.length = 0;
  turnTiersSeen.length = 0;
  transcript.length = 0;
  turnAbortSignals.length = 0;
  shellActivityHandler = null;
  toolActivityHandler = null;
  mockToolSnapshot = [];
  pushNowResultHandler = null;
  agentEventHandler = null;
  backgroundStatusHandler = null;
  delayedPushNowProbe = false;
  pendingPushNowRequestId = null;
  committedPushNowIds.length = 0;
  requestedPushNowIds.length = 0;
  duringTurnHook = null;
  mockLocalChatTurnResult = undefined;
  mockBackgroundLine = null;
  messageBlocksForTurn = [];
  selfHealthListener = null;
  nextSidetabHandler = null;
  shellApprovalHandler = null;
  shellApprovalCancelHandler = null;
  mockBackgroundLine = null;
  selfHealthListener = null;
  cliStderrEvents.length = 0;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: undefined, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: undefined, configurable: true });
  const testRoot = isolatedTestStateRoot;
  if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = priorStateDir;
  if (priorSimWorldId === undefined) delete process.env.ELANOUS_SIM_WORLD_ID;
  else process.env.ELANOUS_SIM_WORLD_ID = priorSimWorldId;
  setTestStateRoot(priorTestStateRoot ?? null);
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
  expect(process.env.ELANOUS_STATE_DIR).toBe(priorStateDir);
  expect(process.env.ELANOUS_SIM_WORLD_ID).toBe(priorSimWorldId);
  expect(getTestStateRoot()).toBe(priorTestStateRoot);
  expect(testRoot === undefined || existsSync(testRoot)).toBe(false);
  isolatedTestStateRoot = undefined;
  mock.module('../ux-sim/world.js', () => restoreUxSimWorld);
});

test('Next TUI confirms only shell calls at the long-execution threshold', () => {
  const wallClock = spyOn(Date, 'now').mockReturnValue(Number.MIN_SAFE_INTEGER);
  const startedAtMonotonicMs = performance.now();
  const active = new Map([['call', { name: 'RunShell' as const, startedAtMonotonicMs }]]);
  try {
    expect(nextTuiShellEscDecision(active, startedAtMonotonicMs + LONG_SHELL_ESC_CONFIRMATION_MS - (LONG_SHELL_ESC_CONFIRMATION_MS / LONG_SHELL_ESC_CONFIRMATION_MS))).toBe('abort');
    expect(nextTuiShellEscDecision(active, startedAtMonotonicMs + LONG_SHELL_ESC_CONFIRMATION_MS)).toBe('confirm');
    // Source: delayed cross-process events retain monotonic execution time despite the wall-clock jump simulated above.
    expect(nextTuiShellEscDecision(active, startedAtMonotonicMs + LONG_SHELL_ESC_CONFIRMATION_MS + 1_000)).toBe('confirm');
    expect(nextTuiShellEscDecision(new Map(), startedAtMonotonicMs)).toBeNull();
  } finally { wallClock.mockRestore(); }
});

test('Bash approval viewport uses the reduced composer width when a sidetab is open', () => {
  const command = `rm -rf /tmp/demo && printf '${'x'.repeat(2_000)}' && echo NT_SW1_END`;
  const viewport = shellApprovalCommandViewport(command, 100, 35, 30, Number.MAX_SAFE_INTEGER);
  expect(viewport.lines.slice(viewport.scroll, viewport.scroll + viewport.pageSize).join('').replace(/\s/g, '')).toContain('NT_SW1_END');
});

test('risky Bash approval is an inline prompt and only a human y dispatch decision is accepted', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
  const session = createSession({ source: 'tui' });
  setActiveSessionId(session.id);
  const riskyCommand = `rm -rf /tmp/demo && printf '${'x'.repeat(2_000)}' && echo NT_SW1_END`;
  const decisions: boolean[] = [];
  duringTurnHook = async () => {
    const pending = shellApprovalHandler?.(riskyCommand, 'pty-approval-1') ?? Promise.resolve(false);
    await Promise.resolve();
    for (let index = 0; index < 30; index++) enqueueReadKey({ name: 'down', ctrl: false, shift: false, raw: '\x1b[B' });
    enqueueReadKey({ name: 'y', ctrl: false, shift: false, raw: 'y' });
    decisions.push(await pending);
    enqueueReadKey({ name: 'q', ctrl: true, shift: false, raw: '\x11' });
  };
  keys.push({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
  submittedInputs.push('run the requested command');
  const output = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await showNextTui({ resumeSessionId: session.id, sidetabMode: 'off' });
    const frame = transcript.join('');
    expect(frame).toContain('Bash 실행 승인');
    expect(frame).toContain('rm -rf /tmp/demo');
    expect(frame).toContain('NT_SW1_END');
    expect(frame).toContain('Enter 기본 N');
    expect(decisions).toEqual([true]);
  } finally {
    process.stdout.write = output;
  }
}, 20_000);

test('Bash approval timeout closes the prompt and resolves as denied', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
  const session = createSession({ source: 'tui' });
  setActiveSessionId(session.id);
  const decisions: boolean[] = [];
  duringTurnHook = async () => {
    decisions.push(await (shellApprovalHandler?.('rm -rf /tmp/timeout', 'pty-timeout-1') ?? Promise.resolve(false)));
    enqueueReadKey({ name: 'q', ctrl: true, shift: false, raw: '\x11' });
  };
  keys.push({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
  submittedInputs.push('run the requested command');
  const output = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await showNextTui({ resumeSessionId: session.id, sidetabMode: 'off', shellApprovalTimeoutMs: 5 });
    const frame = transcript.join('');
    expect(decisions).toEqual([false]);
    expect(frame).toContain('Bash 승인 시간 초과 · 거부됨');
    expect(frame.lastIndexOf('Bash 승인 시간 초과 · 거부됨')).toBeGreaterThan(frame.lastIndexOf('Bash 실행 승인 · 전체 명령'));
  } finally {
    process.stdout.write = output;
  }
});

test('child timeout cancels its request id and overrides a delayed host approval display', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
  const session = createSession({ source: 'tui' });
  setActiveSessionId(session.id);
  const decisions: boolean[] = [];
  duringTurnHook = async () => {
    const pending = shellApprovalHandler?.('rm -rf /tmp/late-reply', 'pty-race-1') ?? Promise.resolve(false);
    await Promise.resolve();
    enqueueReadKey({ name: 'y', ctrl: false, shift: false, raw: 'y' });
    decisions.push(await pending);
    shellApprovalCancelHandler?.('pty-race-1', 'timeout');
    enqueueReadKey({ name: 'q', ctrl: true, shift: false, raw: '\x11' });
  };
  keys.push({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
  submittedInputs.push('run the requested command');
  const output = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await showNextTui({ resumeSessionId: session.id, sidetabMode: 'off' });
    const frame = transcript.join('');
    expect(decisions).toEqual([true]);
    expect(frame).toContain('Bash 승인 시간 초과 · 거부됨');
    expect(frame.lastIndexOf('Bash 승인 시간 초과 · 거부됨')).toBeGreaterThan(frame.lastIndexOf('Bash 명령 승인됨'));
  } finally {
    process.stdout.write = output;
  }
});

test('execution-side shell snapshot overrides a stale short-only event set', () => {
  const now = performance.now();
  const staleEvents = new Map([['short', { name: 'Bash' as const, startedAtMonotonicMs: now - (LONG_SHELL_ESC_CONFIRMATION_MS / LONG_SHELL_ESC_CONFIRMATION_MS) }]]);
  expect(nextTuiShellEscDecision(staleEvents, now)).toBe('abort');
  // Source: execution-side snapshot includes a concurrent RunShell whose start frame was delayed in transit.
  const snapshot = new Map<string, { name: 'Bash' | 'RunShell'; startedAtMonotonicMs: number }>(staleEvents);
  snapshot.set('long', { name: 'RunShell', startedAtMonotonicMs: now - LONG_SHELL_ESC_CONFIRMATION_MS });
  expect(nextTuiShellEscDecision(snapshot, now)).toBe('confirm');
});

test('an empty execution-side shell snapshot preserves immediate Esc cancellation', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  const session = createSession({ source: 'tui' });
  setActiveSessionId(session.id);
  duringTurnHook = (signal) => {
    enqueueReadKey({ name: 'escape', ctrl: false, shift: false, raw: '\x1b' });
    enqueueReadKey({ name: 'q', ctrl: true, shift: false, raw: '\x11' });
    return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  };
  keys.push({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
  submittedInputs.push('ordinary response without a shell');
  const output = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await showNextTui({ resumeSessionId: session.id, sidetabMode: 'off' });
    const abortedTurn = turnAbortSignals.at(-1);
    expect(abortedTurn).toBeDefined();
    expect(abortedTurn?.aborted).toBe(true);
    expect(transcript.join('')).not.toContain('응답 중단 확인 · 기본 N');
  } finally {
    process.stdout.write = output;
  }
});

test('empty Enter keeps the queued turn while a non-shell tool is running', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  const session = createSession({ source: 'tui' });
  setActiveSessionId(session.id);
  let interruptedDuringTool: boolean | null = null;
  duringTurnHook = async (signal) => {
    // The start event has not reached the TUI; the execution-side snapshot must still block interruption.
    mockToolSnapshot = [{ id: 'read-1', name: 'Read' }];
    enqueueReadKey({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
    enqueueReadKey({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
    for (let tries = 0; tries < 100 && !transcript.join('').includes('실행 중인 도구 Read 뒤에 대기 입력 전송'); tries++) await Bun.sleep(10);
    interruptedDuringTool = signal.aborted;
    toolActivityHandler?.({ phase: 'finish', id: 'read-1', name: 'Read' });
    enqueueReadKey({ name: 'q', ctrl: true, shift: false, raw: '\x11' });
  };
  keys.push({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
  submittedInputs.push('first turn', 'queued turn');
  const output = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await showNextTui({ resumeSessionId: session.id, sidetabMode: 'off' });
    expect(interruptedDuringTool as boolean | null).toBe(false);
    expect(transcript.join('')).toContain('실행 중인 도구 Read 뒤에 대기 입력 전송');
  } finally {
    process.stdout.write = output;
  }
});

test('Ctrl+Up recall cancels a pending empty-Enter probe before the child can abort', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  const session = createSession({ source: 'tui' });
  setActiveSessionId(session.id);
  delayedPushNowProbe = true;
  let abortedAfterRecall: boolean | null = null;
  duringTurnHook = async (signal) => {
    enqueueReadKey({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
    enqueueReadKey({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
    enqueueReadKey({ name: 'up', ctrl: true, shift: false, raw: '\x1b[1;5A' });
    for (let tries = 0; tries < 100 && (!pendingPushNowRequestId || !transcript.join('').includes('대기 1건을 입력칸으로')); tries++) await Bun.sleep(10);
    expect(pendingPushNowRequestId).not.toBeNull();
    expect(transcript.join('')).toContain('대기 1건을 입력칸으로');
    pushNowResultHandler?.({ requestId: pendingPushNowRequestId!, outcome: 'ready', activeTools: [] });
    await Bun.sleep(20);
    abortedAfterRecall = signal.aborted;
    enqueueReadKey({ name: 'q', ctrl: true, shift: false, raw: '\x11' });
  };
  keys.push({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
  submittedInputs.push('first turn', 'queued turn');
  const output = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await showNextTui({ resumeSessionId: session.id, sidetabMode: 'off' });
    expect(abortedAfterRecall as boolean | null).toBe(false);
    expect(committedPushNowIds).toEqual([]);
  } finally {
    process.stdout.write = output;
  }
});

test('empty Enter cannot reopen a probe or Ctrl+Up recall after commit until the turn settles', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  const session = createSession({ source: 'tui' });
  setActiveSessionId(session.id);
  let guardedBeforeSettle = false;
  duringTurnHook = async () => {
    enqueueReadKey({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
    enqueueReadKey({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
    for (let tries = 0; tries < 100 && !transcript.join('').includes('지금 밀어 넣기'); tries++) await Bun.sleep(10);
    enqueueReadKey({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
    enqueueReadKey({ name: 'up', ctrl: true, shift: false, raw: '\x1b[1;5A' });
    for (let tries = 0; tries < 100 && !transcript.join('').includes('지금 제출 중'); tries++) await Bun.sleep(10);
    guardedBeforeSettle = transcript.join('').includes('지금 제출 중') && !transcript.join('').includes('대기 1건을 입력칸으로');
    enqueueReadKey({ name: 'q', ctrl: true, shift: false, raw: '\x11' });
  };
  keys.push({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
  submittedInputs.push('first turn', 'queued turn');
  const output = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await showNextTui({ resumeSessionId: session.id, sidetabMode: 'off' });
    expect(committedPushNowIds).toHaveLength(1);
    expect(requestedPushNowIds).toHaveLength(1); // Source: #36612
    expect(guardedBeforeSettle).toBe(true);
  } finally {
    process.stdout.write = output;
  }
});

test('Enter and Space cycle every available MessageBlock detail tier through the real input loop', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  const session = createSession({ source: 'tui' });
  setActiveSessionId(session.id);
  appendMessage(session.id, { role: 'user', content: 'existing fold context', ts: '2026-11-10T00:00:00Z' });
  messageBlocksForTurn = [{
    id: 'entry-fold-cycle', ts: 1, source: 'agent',
    body: { kind: 'thought', text: '원문 본문' },
    detail: { level: 3, summary: 'fold cycle summary', steps: ['detail step'], rawRef: { runId: 'run-1', blockId: 'entry-fold-cycle' } },
  }];
  keys.push({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
  keysAfterTurn = [
    { name: 'pageup', ctrl: false, shift: false, raw: '\x1b[5~' },
    { name: 'enter', ctrl: false, shift: false, raw: '\r' },
    { name: 'space', ctrl: false, shift: false, raw: ' ' },
    { name: 'f', ctrl: false, shift: false, raw: 'f' },
    { name: 'enter', ctrl: false, shift: false, raw: '\r' },
    { name: 'q', ctrl: true, shift: false, raw: '\x11' },
  ];
  submittedInputs.push('show a foldable thought');
  const output = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await showNextTui({ resumeSessionId: session.id, sidetabMode: 'off' });
    const frame = transcript.join('');
    expect(frame).toContain('▸ 생각 · fold cycle summary');
    expect(frame).toContain('▾ 생각 · fold cycle summary');
    expect(frame).toContain('detail step');
    expect(frame).toContain('원문 참조 대기');
  } finally {
    process.stdout.write = output;
  }
}, 10_000);

test('late AgentOutput changes the settled child group from running to completed', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  const session = createSession({ source: 'tui' });
  setActiveSessionId(session.id);
  duringTurnHook = async () => {
    agentEventHandler?.({ phase: 'start', id: 'late-child', description: 'late child' });
    setTimeout(() => {
      appendMessage(session.id, {
        role: 'tool', content: '⚙️ AgentOutput', toolName: 'AgentOutput',
        toolResult: JSON.stringify({ taskId: 'late-child', retrievalStatus: 'success', state: 'done' }),
        ts: new Date().toISOString(),
      });
      backgroundStatusHandler?.(null);
      enqueueReadKey({ name: 'q', ctrl: true, shift: false, raw: '\x11' });
    }, 30);
  };
  keys.push({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
  submittedInputs.push('start a background child');
  const output = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await showNextTui({ resumeSessionId: session.id, sidetabMode: 'off' });
    const finalFrame = transcript.at(-1) ?? '';
    expect(finalFrame).toContain('완료 1');
    expect(finalFrame).not.toContain('실행 중 1');
  } finally {
    process.stdout.write = output;
  }
}, 10_000);

test('child-agent noise collapses to one status card without duplicate MessageBlock output', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  const session = createSession({ source: 'tui' });
  setActiveSessionId(session.id);
  messageBlocksForTurn = ['one', 'two', 'three'].map((id) => ({
    id: `agent-block-${id}`, ts: 1, source: 'tool' as const,
    body: { kind: 'tool-call' as const, toolCallId: id, title: 'Agent' },
    detail: { level: 1 as const, summary: `child answer ${id}` },
  }));
  messageBlocksForTurn.push(
    { id: 'agent-output-internal', ts: 2, source: 'tool', body: { kind: 'tool-call', toolCallId: 'poll', title: 'AgentOutput' } },
    { id: 'goal-update-internal', ts: 3, source: 'tool', body: { kind: 'tool-call', toolCallId: 'goal', title: 'update_goal' } },
  );
  duringTurnHook = async () => {
    for (const id of ['one', 'two', 'three']) {
      agentEventHandler?.({ phase: 'start', id, description: `child ${id}` });
      appendMessage(session.id, {
        role: 'tool', content: '⚙️ Agent', toolName: 'Agent', toolCallId: id,
        toolResult: JSON.stringify({ output: `child answer ${id}` }), ts: new Date().toISOString(),
      });
      appendMessage(session.id, {
        role: 'tool', content: '⚙️ AgentOutput', toolName: 'AgentOutput',
        toolResult: JSON.stringify({ taskId: id, state: 'done', output: `internal poll ${id}` }), ts: new Date().toISOString(),
      });
      agentEventHandler?.({ phase: 'finish', id, status: 'done' });
    }
    appendMessage(session.id, {
      role: 'tool', content: '⚙️ update_goal', toolName: 'update_goal',
      toolResult: JSON.stringify({ goal: 'private goal text' }), ts: new Date().toISOString(),
    });
  };
  keys.push({ name: 'enter', ctrl: false, shift: false, raw: '\r' }, { name: 'q', ctrl: true, shift: false, raw: '\x11' });
  submittedInputs.push('start three children');
  const output = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await showNextTui({ resumeSessionId: session.id, sidetabMode: 'off' });
    const frame = transcript.at(-1) ?? '';
    expect(frame.match(/하위 에이전트/g)?.length).toBe(1);
    expect(frame).toContain('완료 3');
    expect(frame.match(/child answer one/g)?.length).toBe(1);
    expect(frame).not.toContain('internal poll');
    expect(frame).not.toContain('AgentOutput');
    expect(frame).not.toContain('private goal text');
    expect(frame).not.toContain('엘라누스: \n');
  } finally {
    process.stdout.write = output;
  }
}, 10_000);

// R-TST23 — afterAll 마지막으로 원본을 반환하는 mock.module 로 네 치환을 복구한다.
afterAll(() => {
  mock.module('../tui.js', () => restoreTui);
  mock.module('../tui-client/local-chat-turn.js', () => restoreLocalChatTurn);
  mock.module('./input/composer.js', () => restoreComposer);
  mock.module('./chat/background-job-status.js', () => restoreBackgroundJobStatus);
  mock.module('../ux-sim/world.js', () => restoreUxSimWorld);
});

describe('src/tui/entry.ts — showNextTui 턴 경계 recorder 배선', () => {
  test('registry routes built-in help at the real input boundary and leaves longer help requests as chat', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const session = createSession({ source: 'tui' });
    setActiveSessionId(session.id);
    const output = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      keys.push(
        { name: 'enter', ctrl: false, shift: false, raw: '\r' },
        { name: 'q', ctrl: true, shift: false, raw: '\x11' },
      );
      submittedInputs.push('/help');
      await showNextTui({ resumeSessionId: session.id, sidetabMode: 'off' });
      expect(transcript.join('')).toContain('/side · /sidetab — 세션/PTY 목록 · /side new · /side kill');
      expect(turnsSeen).toEqual([]);

      transcript.length = 0;
      keys.push(
        { name: 'enter', ctrl: false, shift: false, raw: '\r' },
        { name: 'q', ctrl: true, shift: false, raw: '\x11' },
      );
      submittedInputs.push('도움말 문구를 작성해 줘');
      await showNextTui({ resumeSessionId: session.id, sidetabMode: 'off' });
      expect(turnsSeen).toEqual([session.id]);
    } finally {
      process.stdout.write = output;
    }
  }, 10_000);

  test('registry loads sidetab branch for /side and /sidetab through real input', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const session = createSession({ source: 'tui' });
    setActiveSessionId(session.id);
    const output = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      keys.push(
        { name: 'enter', ctrl: false, shift: false, raw: '\r' },
        { name: 'enter', ctrl: false, shift: false, raw: '\r' },
        { name: 'q', ctrl: true, shift: false, raw: '\x11' },
      );
      submittedInputs.push('/side off', '/sidetab on');
      await showNextTui({ resumeSessionId: session.id, sidetabMode: 'collapsed' });
      const rendered = transcript.join('');
      expect(rendered).toContain('사이드탭 off · /side on 으로 이 세션에서 켜기');
      expect(rendered).toContain('사이드탭 on · /side open 으로 열기');
      expect(turnsSeen).toEqual([]);
    } finally {
      process.stdout.write = output;
    }
  });

  test('registry dispatches /harness ask and runs to the lazy harness branch without starting a chat turn', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const session = createSession({ source: 'tui' });
    setActiveSessionId(session.id);
    const output = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
    const harnessCalls: Array<{ command: string; goal: string; aborted: boolean }> = [];
    try {
      keys.push(
        { name: 'enter', ctrl: false, shift: false, raw: '\r' },
        { name: 'q', ctrl: true, shift: false, raw: '\x11' },
      );
      submittedInputs.push('/harness ask fix the TUI route');
      await showNextTui({
        resumeSessionId: session.id,
        sidetabMode: 'off',
        harnessRunner: async (command, goal, signal, onLine) => {
          harnessCalls.push({ command, goal, aborted: signal.aborted });
          onLine('하니스 시작됨');
        },
      });
      expect(harnessCalls).toEqual([{ command: 'ask', goal: 'fix the TUI route', aborted: false }]);
      expect(transcript.join('')).toContain('하니스 시작됨');
      expect(turnsSeen).toEqual([]);

      transcript.length = 0;
      keys.push(
        { name: 'enter', ctrl: false, shift: false, raw: '\r' },
        { name: 'q', ctrl: true, shift: false, raw: '\x11' },
      );
      submittedInputs.push('/harness runs');
      await showNextTui({
        resumeSessionId: session.id,
        sidetabMode: 'off',
        harnessRunner: async (command, goal, signal, onLine) => {
          harnessCalls.push({ command, goal, aborted: signal.aborted });
          onLine('하니스 조회됨');
        },
      });
      expect(harnessCalls.at(-1)).toEqual({ command: 'runs', goal: '', aborted: false });
      expect(transcript.join('')).toContain('하니스 조회됨');
      expect(turnsSeen).toEqual([]);
    } finally {
      process.stdout.write = output;
    }
  }, 10_000);

  test('registry-loaded /harness rejects unsupported commands without invoking the CLI or chat', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const session = createSession({ source: 'tui' });
    setActiveSessionId(session.id);
    const output = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
    let runnerCalls = 0;
    try {
      keys.push(
        { name: 'enter', ctrl: false, shift: false, raw: '\r' },
        { name: 'q', ctrl: true, shift: false, raw: '\x11' },
      );
      submittedInputs.push('/harness implement');
      await showNextTui({
        resumeSessionId: session.id,
        sidetabMode: 'off',
        harnessRunner: async () => { runnerCalls += 1; },
      });
      expect(transcript.join('')).toContain('사용법: /harness ask <목표> · /harness runs');
      expect(runnerCalls).toBe(0);
      expect(turnsSeen).toEqual([]);
    } finally {
      process.stdout.write = output;
    }
  }, 10_000);

  test('Escape aborts a running registry-loaded /harness command', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const session = createSession({ source: 'tui' });
    setActiveSessionId(session.id);
    const output = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
    let cancelled = false;
    try {
      keys.push(
        { name: 'enter', ctrl: false, shift: false, raw: '\r' },
        { name: 'escape', ctrl: false, shift: false, raw: '\x1b' },
        { name: 'q', ctrl: true, shift: false, raw: '\x11' },
      );
      submittedInputs.push('/harness ask cancel me');
      await showNextTui({
        resumeSessionId: session.id,
        sidetabMode: 'off',
        harnessRunner: async (_command, _goal, signal) => {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => {
            cancelled = signal.aborted;
            resolve();
          }, { once: true }));
          throw new Error('하니스 호출을 취소했습니다');
        },
      });
      expect(cancelled).toBe(true);
      expect(transcript.join('')).toContain('하니스 호출 취소됨');
      expect(turnsSeen).toEqual([]);
    } finally {
      process.stdout.write = output;
    }
  }, 10_000);

  test('추가 상태 행이 있어도 그래프 진행 줄과 입력 커서가 같은 화면 행을 쓰지 않는다', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 6, configurable: true });
    const session = createSession({ source: 'tui' });
    setActiveSessionId(session.id);
    mockBackgroundLine = '[graph] triage ok · failed start';
    duringTurnHook = () => selfHealthListener?.({
      sessionId: session.id,
      capturedAt: Date.now(),
      line: '설치·자격 상태 관측',
      source: 'checkout',
      runningSha: null,
      installedSha: null,
      errorCount: 0,
      representativeError: null,
      creditSource: null,
      creditKnown: false,
    });
    keys.push(
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'q', ctrl: true, shift: false, raw: '\x11' },
    );
    submittedInputs.push('관측 행 배치');
    mockLocalChatTurnResult = { goalComplete: false, goalStopReason: 'max_turns' };
    const output = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      await showNextTui({ resumeSessionId: session.id, sidetabMode: 'collapsed' });
      const rendered = transcript.join('').split('\x1b[H\x1b[2J').at(-1) ?? '';
      const promptCursors = [...rendered.matchAll(/\x1b\[(\d+);(\d+)H\x1b\[\?25h/g)].map((match) => Number(match[1]));
      expect(rendered).toContain(mockBackgroundLine!);
      expect(promptCursors.length).toBeGreaterThan(0);
      expect(Math.max(...promptCursors)).toBeLessThanOrEqual(6);
      const screenLines = rendered.split('\n');
      const statusRow = screenLines.findIndex((line) => line.includes(mockBackgroundLine!));
      expect(statusRow).toBeGreaterThanOrEqual(0);
      expect(statusRow + 1).not.toBe(Math.max(...promptCursors));
      expect(screenLines.some((line) => line.includes('Turn cap reached'))).toBe(true);
      expect(screenLines.some((line) => line.includes('설치·자격 상태 관측'))).toBe(false);
      await Bun.sleep(450);
    } finally {
      process.stdout.write = output;
    }
  }, 10_000);

  test('/side workspaces enter toggles a workspace group without attaching its parent row', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const original = createSession({ source: 'tui' });
    const target = createSession({ source: 'tui' });
    setActiveSessionId(original.id);
    const now = Date.now();
    upsertPtyManifest({
      id: 'tui:81020', kind: 'tui', cmd: 'elanous', purpose: `next-tui-sidetab:${target.id}`,
      startedAt: now, now, ptyPid: 81020, identity: { spaceId: 'mission-space', spaceKind: 'solve-mission' },
    });
    updatePtyManifestSession('tui:81020', target.id, now);
    upsertPtyManifest({
      id: 'agent:workspace-child', kind: 'agent', cmd: 'agent', nickname: 'WORKSPACE_CHILD',
      startedAt: now, now, ptyPid: 81021,
      identity: { spaceId: 'mission-space', spaceKind: 'solve-mission', parentPtyId: 'tui:81020' },
    });
    const output = process.stdout.write;
    const originalLog = debug.log;
    const attachRequests: unknown[] = [];
    debug.log = ((category: string, event: string, data?: unknown) => {
      if (category === 'sidetab.remote' && event === 'attach-request') attachRequests.push(data);
      return originalLog.call(debug, category, event, data);
    }) as typeof debug.log;
    process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
    keys.push(
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'q', ctrl: true, shift: false, raw: '\x11' },
    );
    submittedInputs.push('/side workspaces');
    try {
      await showNextTui({ resumeSessionId: original.id });
      const workspaceFrames = replayPaintWrites(transcript).filter((frame) => frame.includes('미션 ·'));
      expect(workspaceFrames.some((frame) => !frame.includes('WORKSPACE_CHILD'))).toBe(true);
      expect(workspaceFrames.some((frame) => frame.includes('WORKSPACE_CHILD'))).toBe(true);
      expect([...workspaceFrames].reverse().find((frame) => frame.includes('미션 ·'))).not.toContain('WORKSPACE_CHILD');
      expect(attachRequests).toEqual([]);
    } finally {
      debug.log = originalLog;
      process.stdout.write = output;
      removePtyManifest('tui:81020');
      removePtyManifest('agent:workspace-child');
    }
  }, 10_000);

  test('/side workspaces에서 매니페스트 PTY 멤버를 고르면 기존 세션 전환 경로를 탄다', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const original = createSession({ source: 'tui' });
    const target = createSession({ source: 'tui' });
    setActiveSessionId(original.id);
    appendMessage(target.id, { role: 'assistant', content: 'WORKSPACE_SWITCH_TARGET_MARKER', ts: new Date().toISOString() });
    const now = Date.now();
    upsertPtyManifest({
      id: 'tui:81001', kind: 'tui', cmd: 'elanous', purpose: `next-tui-sidetab:${target.id}`,
      startedAt: now, now, ptyPid: 81001, identity: { spaceId: 'mission-space', spaceKind: 'solve-mission' },
    });
    updatePtyManifestSession('tui:81001', target.id, now);
    upsertPtyManifest({
      id: 'agent:mission-member', kind: 'agent', cmd: 'agent', nickname: 'MISSION_MEMBER',
      startedAt: now + 1, now: now + 1, ptyPid: 81002,
      identity: { spaceId: 'mission-space', spaceKind: 'solve-mission', parentPtyId: 'tui:81001' },
    });
    upsertPtyManifest({
      id: 'agent:all-only', kind: 'agent', cmd: 'agent', nickname: 'ALL_ONLY',
      startedAt: now + 2, now: now + 2, ptyPid: 81003, identity: { parentPtyId: 'tui:81001' },
    });
    const output = process.stdout.write;
    const originalLog = debug.log;
    const attachRequests: unknown[] = [];
    debug.log = ((category: string, event: string, data?: unknown) => {
      if (category === 'sidetab.remote' && event === 'attach-request') attachRequests.push(data);
      return originalLog.call(debug, category, event, data);
    }) as typeof debug.log;
    process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
    keys.push(
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'down', ctrl: false, shift: false, raw: '' },
      { name: 'down', ctrl: false, shift: false, raw: '' },
      { name: '\\', ctrl: true, shift: false, raw: '\x1c' },
      { name: 'x', ctrl: false, shift: false, raw: 'x' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'q', ctrl: true, shift: false, raw: '\x11' },
    );
    submittedInputs.push('/side workspaces', '/side all');
    try {
      await showNextTui({ resumeSessionId: original.id });
      const { getActiveSessionId } = await import('../session/index.js');
      expect(getActiveSessionId()).toBe(target.id);
      expect(attachRequests).toContainEqual({ ptyId: 'agent:mission-member', host: null });
      expect(transcript.join('')).toContain('미션 ·');
      expect(transcript.join('')).toContain('세션 전환됨');
      const workspaceFrame = transcript.find((frame) => frame.includes('미션 ·'));
      const allFrame = [...transcript].reverse().find((frame) => frame.includes('사이드탭 전체 목록'));
      expect(workspaceFrame).toBeDefined();
      expect(workspaceFrame).not.toContain('ALL_ONLY');
      expect(allFrame).toContain('ALL_ONLY');
      expect(transcript.join('')).toContain('WORKSPACE_SWITCH_TARGET_MARKER');
    } finally {
      debug.log = originalLog;
      process.stdout.write = output;
      removePtyManifest('tui:81001');
      removePtyManifest('agent:mission-member');
      removePtyManifest('agent:all-only');
    }
  }, 10_000);

  test('sidetab session switch during a turn waits for that turn before changing sessions', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const original = createSession({ source: 'tui' });
    const target = createSession({ source: 'tui' });
    setActiveSessionId(original.id);
    appendMessage(target.id, { role: 'assistant', content: 'NL_SWITCH_TARGET_MARKER', ts: new Date().toISOString() });
    const now = Date.now();
    upsertPtyManifest({
      id: 'tui:81000', kind: 'tui', cmd: 'elanous', purpose: `next-tui-sidetab:${target.id}`,
      startedAt: now, now, ptyPid: 81000,
    });
    updatePtyManifestSession('tui:81000', target.id, now);
    let duringTurnSessionId: string | null | undefined;
    let switchResult: unknown;
    duringTurnHook = async () => {
      expect(nextSidetabHandler).not.toBeNull();
      switchResult = await nextSidetabHandler!({ action: 'switch', target: 'tui:81000' });
      const { getActiveSessionId } = await import('../session/index.js');
      duringTurnSessionId = getActiveSessionId();
    };
    keys.push(
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'q', ctrl: true, shift: false, raw: '\x11' },
    );
    // Keep the sidetab available but collapsed so Enter submits the fake turn;
    // duringTurnHook exercises the host handler while that turn is active.
    submittedInputs.push('ordinary active turn');
    const output = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      transcript.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await showNextTui({ resumeSessionId: original.id, sidetabMode: 'collapsed' });
      const { getActiveSessionId } = await import('../session/index.js');
      expect(switchResult).toEqual({ ok: true, action: 'switch', target: 'tui:81000', scheduled: 'after-turn' });
      expect(duringTurnSessionId).toBe(original.id);
      expect(getActiveSessionId()).toBe(target.id);
      expect(transcript.join('')).toContain('세션 전환됨');
      expect(transcript.join('')).toContain('NL_SWITCH_TARGET_MARKER');
      // Let the recorder's delayed close emit finish before the next test installs its capture hook.
      await Bun.sleep(450);
    } finally {
      process.stdout.write = output;
      removePtyManifest('tui:81000');
    }
  }, 10_000);

  test('한 턴에 시작·첫 응답 경계가 같은 세션 키로 닫히고 다른 세션 경계는 0건', async () => {
    captured.length = 0;
    debug.log = captureDebugLog;
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
      expect(replayPaintWrites(transcript).at(-1)).toContain('❯ ');
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

  test('plugin phrase uses wizard proposal and saves only after explicit confirmation', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const output = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      transcript.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const originalFetch = globalThis.fetch;
    const requests: Array<{ path: string; body: unknown }> = [];
    let failFirstSave = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body ?? '{}')) as unknown;
      requests.push({ path, body });
      if (path === '/v1/graphs/wizard') {
        return Response.json({ ok: true, id: 'plugin-fixture', yaml: 'name: fixture', summary: 'CSV 내보내기' });
      }
      if (failFirstSave) {
        failFirstSave = false;
        return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
      }
      return new Response(JSON.stringify({ saved: true, id: 'plugin-fixture' }), { status: 201 });
    }) as typeof fetch;
    setResolveDaemonEndpointForTest(() => ({
      baseUrl: 'http://nexus.test', healthUrl: 'http://nexus.test/v1/health',
      pwaUrl: 'http://nexus.test', source: 'lifecycle',
    }));
    keys.push(
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'q', ctrl: true, shift: false, raw: '\x11' },
    );
    submittedInputs.push('CSV를 내보내는 플러그인', '생각해 볼게요', '네', '네');
    try {
      await showNextTui({ resumeSessionId: createSession().id });
      const rendered = transcript.join('');
      expect(rendered).toContain('초안: CSV 내보내기');
      expect(rendered).toContain('name: fixture');
      expect(rendered).toContain('저장 여부를 “네” 또는 “아니오”로 답해 주세요.');
      expect(rendered).toContain('초안을 보존했습니다.');
      expect(rendered).toContain('플러그인 저장 완료: plugin-fixture');
      expect(requests).toEqual([
        { path: '/v1/graphs/wizard', body: { prompt: 'CSV를 내보내는 플러그인' } },
        { path: '/v1/graphs', body: { id: 'plugin-fixture', yaml: 'name: fixture' } },
        { path: '/v1/graphs', body: { id: 'plugin-fixture', yaml: 'name: fixture' } },
      ]);
      expect(turnsSeen).toEqual([]);
    } finally {
      setResolveDaemonEndpointForTest(null);
      globalThis.fetch = originalFetch;
      process.stdout.write = output;
    }
  }, 10_000);

  test('registry commands remain available while plugin wizard confirmation is pending', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const session = createSession({ source: 'tui' });
    setActiveSessionId(session.id);
    const output = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      transcript.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      return Response.json({ ok: true, id: 'pending-plugin', yaml: 'name: pending', summary: '초안' });
    }) as typeof fetch;
    setResolveDaemonEndpointForTest(() => ({
      baseUrl: 'http://nexus.test', healthUrl: 'http://nexus.test/v1/health',
      pwaUrl: 'http://nexus.test', source: 'lifecycle',
    }));
    keys.push(
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'q', ctrl: true, shift: false, raw: '\x11' },
    );
    submittedInputs.push('CSV를 내보내는 플러그인', '/session new');
    try {
      await showNextTui({ resumeSessionId: session.id });
      expect(getActiveSessionId()).not.toBe(session.id);
      expect(requests).toEqual(['/v1/graphs/wizard']);
      expect(turnsSeen).toEqual([]);
    } finally {
      setResolveDaemonEndpointForTest(null);
      globalThis.fetch = originalFetch;
      process.stdout.write = output;
    }
  });

  test('Next /help 화면에 Commands와 사용 가능한 Keys 절을 표시한다', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const output = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      transcript.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    keys.push(
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'pagedown', ctrl: false, shift: false, raw: '\x1b[6~' },
      { name: 'q', ctrl: true, shift: false, raw: '\x11' },
    );
    submittedInputs.push('/help');
    const testRoute: NextTuiRoute = {
      id: 'test.auto-help', action: 'command', slash: ['/newly-added'], slashPrefixes: [], phrases: [],
      roles: ['human'], minimumMaturity: 'stable', requiredFlags: [], helpSummary: '새 경로',
    };
    const mutableRegistry = NEXT_TUI_ROUTE_REGISTRY as NextTuiRoute[];
    mutableRegistry.push(testRoute);
    try {
      await showNextTui({ resumeSessionId: createSession().id });
      expect(transcript.join('')).toContain('Commands');
      expect(transcript.join('')).toContain('Keys');
      expect(transcript.join('')).toContain('/signals — 신호 확인');
      expect(transcript.join('')).toContain('/help · /help next — 명령과 키 안내');
      expect(transcript.join('')).toContain('/new · /clear · /session new — 새 대화');
      expect(transcript.join('')).toContain('/model · /provider — fast|normal|deep · /provider 별칭');
      expect(transcript.join('')).toContain('/side new · /side kill');
      expect(transcript.join('')).toContain('/term help는 읽기 전용');
      expect(transcript.join('')).toContain('/newly-added — 새 경로');
      expect(transcript.join('')).toContain('PgUp/PgDn');
      expect(transcript.join('')).toContain('Ctrl+Q 종료');
      expect(transcript.join('')).toContain('빈 입력 Enter=attach');
      expect(transcript.join('')).toContain('새 PTY: s shell · e elanous · c codex 구독 · l claude code 구독');
      expect(transcript.join('')).toContain('PTY 분리: Ctrl+\\ 후 d');
    } finally {
      mutableRegistry.pop();
      process.stdout.write = output;
    }
  }, 10_000);

  test('/model choice reaches the shared resolver on the next submitted CORE turn', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    const output = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      transcript.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    keys.push(
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'enter', ctrl: false, shift: false, raw: '\r' },
      { name: 'q', ctrl: true, shift: false, raw: '\x11' },
    );
    submittedInputs.push('/model deep', '다음 턴');
    try {
      await showNextTui({ resumeSessionId: createSession().id });
      expect(transcript.join('')).toContain('모델: 깊음 · 다음 턴부터 적용');
      expect(turnTiersSeen).toEqual([{ tier: 'best', source: 'session-override' }]);
    } finally {
      process.stdout.write = output;
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

  test('SIM-TUI resumes without duplicate events and stops safely if its world disappears', async () => {
    const root = isolatedTestStateRoot;
    if (!root) throw new Error('entry test state root was not initialized');
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const timerHost = globalThis as unknown as { setInterval: typeof globalThis.setInterval; clearInterval: typeof globalThis.clearInterval };
    const output = process.stdout.write;
    try {
      timerHost.setInterval = ((callback: () => void, delayMs = 0) => {
        const timer: FakeInterval = { callback, delayMs, active: true };
        fakeIntervals.push(timer);
        return timer as unknown as ReturnType<typeof setInterval>;
      }) as typeof timerHost.setInterval;
      timerHost.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
        (handle as unknown as FakeInterval).active = false;
      }) as typeof timerHost.clearInterval;
      process.env.ELANOUS_SIM_WORLD_ID = 'watched-world';
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
      Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
      const worldRoot = join(root, 'sim', 'watched-world');
      mkdirSync(worldRoot, { recursive: true, mode: 0o700 });
      const world = {
        id: 'watched-world',
        root: worldRoot,
        spec: { world: 'watched-world', seed: 1, devices: ['fake-clock'], events: [] },
        networkEvents: [],
      };
      mock.module('../ux-sim/world.js', () => ({
        ...uxSimWorldOriginal,
        loadWorld: () => world,
      }));
      const legacyAt = '2026-11-06T16:00:00.000Z';
      writeFileSync(join(world.root, 'watch-events.jsonl'), [
        { runId: 'legacy-run', at: legacyAt, event: 'old-node', verdict: 'passed' },
        { id: 'old-run:1', runId: 'old-run', sequence: 1, at: legacyAt, event: 'duplicate-node', verdict: 'passed' },
        { id: 'old-run:1', runId: 'old-run', sequence: 1, at: legacyAt, event: 'duplicate-node', verdict: 'passed' },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
      const session = createSession({ source: 'tui', title: 'SIM-TUI watched-world' });
      appendMessage(session.id, { role: 'assistant', content: `SIM · [${legacyAt}] legacy-run · old-node · passed`, ts: legacyAt });
      appendMessage(session.id, { role: 'assistant', content: `SIM · [${legacyAt}] old-run#1 · duplicate-node · passed`, ts: legacyAt });
      appendSimWorldWatchEvents(world, 'run-sim-tui', [
        { event: 'release-node', verdict: 'passed' },
        { event: 'release-node', verdict: 'passed' },
      ]);
      process.stdout.write = ((chunk: string | Uint8Array) => { transcript.push(String(chunk)); return true; }) as typeof process.stdout.write;
      const driveOneFrame = async (deleteWorld = false): Promise<void> => {
        if (deleteWorld) beforeFakeTimerTick = () => rmSync(world.root, { recursive: true, force: true });
        keys.push({ name: 'x', ctrl: false, shift: false, raw: 'x' }, { name: 'q', ctrl: true, shift: false, raw: '\x11' });
        readKeyTicks.push(1, 0);
        await showNextTui({ resumeSessionId: session.id, sidetabMode: 'collapsed' });
      };
      await driveOneFrame();
      expect(loadSession(session.id)?.messages.filter((message) => typeof message.content === 'string' && message.content.includes('release-node · passed'))).toHaveLength(2);
      expect(loadSession(session.id)?.messages.filter((message) => typeof message.content === 'string' && message.content.includes('legacy-run · old-node · passed'))).toHaveLength(1);
      expect(loadSession(session.id)?.messages.filter((message) => typeof message.content === 'string' && message.content.includes('duplicate-node · passed'))).toHaveLength(2);
      await driveOneFrame();
      expect(loadSession(session.id)?.messages.filter((message) => typeof message.content === 'string' && message.content.includes('release-node · passed'))).toHaveLength(2);
      expect(loadSession(session.id)?.messages.filter((message) => typeof message.content === 'string' && message.content.includes('duplicate-node · passed'))).toHaveLength(2);
      await driveOneFrame(true);
      expect(transcript.join('')).toContain('SIM 관측 감시 중단');
    } finally {
      process.stdout.write = output;
      timerHost.setInterval = originalSetInterval;
      timerHost.clearInterval = originalClearInterval;
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
