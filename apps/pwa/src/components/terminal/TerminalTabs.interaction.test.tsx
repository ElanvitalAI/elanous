import { afterAll, describe, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';

import { createReactHookHarness } from '@/lib/testing/react-hook-harness';
import { restoreModuleMocksAfterAll } from '@/lib/testing/restore-module-mocks';

import { initialTerminalNotice } from './initial-terminal-notice';

const require = createRequire(import.meta.url);
const react = require('react') as {
  createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown;
  useState: <T>(initial: T) => [T, (next: T) => void];
  useCallback: <T>(fn: T, deps: unknown[]) => T;
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { H: unknown };
};
const harness = createReactHookHarness(react);
let Subject: ((props: Record<string, unknown>) => unknown) | undefined;

let stateListener: ((state: string) => void) | undefined;
let spawnCalls = 0;
let destroyCalls = 0;
let controlCalls: Array<{ id: string; action: 'takeover' | 'release' }> = [];
let listCalls = 0;
let listEntries: Array<{
  terminalId: string;
  isAlive: boolean;
  ownerRunUsage?: string;
  terminalOriginCategory?: string;
  terminalOriginReason?: string;
  externalToolName?: string;
  controller?: string;
}> = [];
let destroyMode: 'ok' | 'throw' | 'pending' = 'ok';
let controlMode: 'success' | 'unknown-pty' | 'denied' | 'failed' | 'owner-unreachable' | 'throw' | 'pending' = 'success';
type ControlResult = { status: 'success' | 'unknown-pty' | 'denied' | 'failed' | 'owner-unreachable' };
const pendingControlResolvers = new Map<string, (result: ControlResult) => void>();
let resolvePendingDestroy: (() => void) | undefined;
let confirmResult = true;
const confirmMessages: string[] = [];
let issued = 0;
/** 발급 경로의 «세 갈래» — 정상 · 예외 · terminalId 없는 응답. 실패도 «주입해서» 태운다. */
let spawnMode: 'ok' | 'throw' | 'no-id' = 'ok';
const connection = {
  state: 'CONNECTING',
  close: () => {},
  on: () => () => {},
  onState: (listener: (state: string) => void) => {
    stateListener = listener;
    return () => { stateListener = undefined; };
  },
  send: async (method: string) => {
    if (method === 'terminal/list') {
      listCalls += 1;
      return { terminals: listEntries };
    }
    if (method === 'terminal/destroy') {
      destroyCalls += 1;
      if (destroyMode === 'throw') throw new Error('daemon refused terminal/destroy');
      if (destroyMode === 'pending') return new Promise((resolve) => {
        resolvePendingDestroy = () => resolve({});
      });
      return {};
    }
    if (method === 'terminal/spawn') {
      spawnCalls += 1;
      if (spawnMode === 'throw') throw new Error('daemon refused terminal/spawn');
      if (spawnMode === 'no-id') return { sessionId: 'session-test', status: 'spawned' };
      issued += 1;
      return { terminalId: `daemon-${issued}` };
    }
    return {};
  },
};
const client = {
  connectAcp: () => connection,
  controlTerminal: async (id: string, action: 'takeover' | 'release') => {
    controlCalls.push({ id, action });
    if (controlMode === 'throw') throw new Error('network down');
    if (controlMode === 'pending') return new Promise<ControlResult>((resolve) => {
      pendingControlResolvers.set(id, resolve);
    });
    return { status: controlMode };
  },
};
// R-TST23 — process-global module mocks: snapshot and restore after this file.
await restoreModuleMocksAfterAll(['@/components/providers/DaemonProvider', '@/lib/debug'], (specifier) => import(specifier));
const actualDaemonProvider = { ...(await import('@/components/providers/DaemonProvider')) };
mock.module('@/components/providers/DaemonProvider', () => ({
  ...actualDaemonProvider,
  useDaemon: () => ({ client, sessionId: 'session-test' }),
}));
/** ⛔ no-op stub 이면 「관측에 남는다」를 원리상 못 잰다(무인 리뷰 must-fix · #10105). 잡아 둔다. */
const debugCalls: { event: string; data: Record<string, unknown> }[] = [];
mock.module('@/lib/debug', () => ({
  debugLog: (event: string, data?: Record<string, unknown>) => { debugCalls.push({ event, data: data ?? {} }); },
}));

const storage = new Map<string, string>();
const priorWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  },
  confirm: (message: string) => {
    confirmMessages.push(message);
    return confirmResult;
  },
};

afterAll(() => {
  harness.unmount();
  if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = priorWindow;
});

function closeButton(id = 'daemon-1') {
  return harness.find((element) => element.type === 'button' && element.props['aria-label'] === `remove ${id} locally`);
}

function terminateButton(id = 'daemon-1') {
  return harness.find((element) => element.type === 'button' && element.props['aria-label'] === `terminate ${id}`);
}

function controlButton(action: 'takeover' | 'release', id = 'daemon-1') {
  return harness.find((element) => element.type === 'button' && element.props['aria-label'] === `${action} ${id}`);
}

function statusMessage(): string {
  return String(harness.find((element) => element.props.role === 'status').props.children);
}

function switchButton(id: string) {
  return harness.find((element) => element.type === 'button' && element.props['aria-label'] === `switch to ${id}`);
}

interface ClickEvent {
  stopPropagation: ReturnType<typeof mock>;
}

function clickWithPropagationGuard(element: { props: Record<string, unknown> }): void {
  const clickEvent: ClickEvent = { stopPropagation: mock(() => {}) };
  harness.act(() => (element.props.onClick as (event: ClickEvent) => void)(clickEvent));
  expect(clickEvent.stopPropagation).toHaveBeenCalledTimes(1);
}

async function renderTabs(
  active: string[],
  states: unknown[],
  initialActiveId: string | null = null,
  initialTabs: string[] = [],
  initialListEntries: typeof listEntries = [],
): Promise<void> {
  const { TerminalTabs } = await import('./TerminalTabs');
  Subject = ({ states: initialStates }: Record<string, unknown>) => {
    const [activeId, setActiveId] = react.useState<string | null>(initialActiveId);
    const onActiveChange = react.useCallback((id: string) => { active.push(id); setActiveId(id); }, []);
    const onInitialTerminalState = react.useCallback((state: unknown) => (initialStates as unknown[]).push(state), [initialStates]);
    return TerminalTabs({ activeId, onActiveChange, onInitialTerminalState });
  };
  harness.unmount();
  storage.clear();
  if (initialTabs.length > 0) storage.set('elanous.webterm.tabs', JSON.stringify(initialTabs));
  connection.state = 'CONNECTING';
  stateListener = undefined;
  spawnCalls = 0;
  destroyCalls = 0;
  controlCalls = [];
  listCalls = 0;
  listEntries = initialListEntries;
  destroyMode = 'ok';
  controlMode = 'success';
  pendingControlResolvers.clear();
  resolvePendingDestroy = undefined;
  confirmResult = true;
  confirmMessages.length = 0;
  issued = 0;
  debugCalls.length = 0;
  harness.render(Subject as never, { states });
  await harness.settle();
}

describe('TerminalTabs initial daemon issuance interaction', () => {
  test('direct PTY links defer shell issuance until the live view is closed', async () => {
    const { TerminalTabs } = await import('./TerminalTabs');
    const active: string[] = [];
    let suspended = true;
    const PanelTabs = () => TerminalTabs({
      activeId: active.at(-1) ?? null,
      onActiveChange: (id) => active.push(id),
      suspendInitialSpawn: suspended,
    });
    harness.unmount();
    storage.clear();
    connection.state = 'CONNECTING';
    spawnCalls = 0;
    issued = 0;
    harness.render(PanelTabs as never);
    await harness.settle();
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();
    expect(spawnCalls).toBe(0);
    expect(active).toEqual([]);
    suspended = false;
    harness.render(PanelTabs as never);
    await harness.settle();
    expect(spawnCalls).toBe(1);
    expect(active).toContain('daemon-1');
    expect(storage.get('elanous.webterm.tabs')).toBe('["daemon-1"]');
  });

  test('does not fall back before ACP opens, then adopts the daemon response and reports its provenance', async () => {
    const active: string[] = [];
    const states: unknown[] = [];
    await renderTabs(active, states);

    expect(spawnCalls).toBe(0);
    expect(states).toContainEqual({ status: 'pending' });

    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();

    expect(spawnCalls).toBe(1);
    expect(active).toContain('daemon-1');
    expect(states).toContainEqual({ status: 'ready', issuedBy: 'daemon' });
    expect(storage.get('elanous.webterm.tabs')).toBe('["daemon-1"]');
  });

  test('closing a daemon-known tab keeps it hidden after the immediate daemon refresh without destroying it', async () => {
    const active: string[] = [];
    const states: unknown[] = [];
    await renderTabs(active, states);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();
    listEntries = [{ terminalId: 'daemon-1', isAlive: true }];

    clickWithPropagationGuard(closeButton());
    await harness.settle();

    expect(destroyCalls).toBe(0);
    expect(listCalls).toBeGreaterThanOrEqual(1);
    expect(storage.get('elanous.webterm.tabs')).not.toContain('daemon-1');
    expect(storage.get('elanous.webterm.hidden-tabs')).toBe('["daemon-1"]');
  });

  test('closing the only committed tab returns to pending and reuses the OPEN-gated daemon issuance path', async () => {
    const active: string[] = [];
    const states: unknown[] = [];
    await renderTabs(active, states);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();

    clickWithPropagationGuard(closeButton());
    await harness.settle();

    expect(destroyCalls).toBe(0);
    expect(spawnCalls).toBe(2);
    expect(active).toContain('daemon-2');
    expect(states).toContainEqual({ status: 'pending' });
    expect(states).toContainEqual({ status: 'ready', issuedBy: 'daemon' });
    expect(storage.get('elanous.webterm.tabs')).toBe('["daemon-2"]');
  });
});

describe('TerminalTabs explicit termination interaction', () => {
  test('local close, cancelled termination, and successful termination of an inactive tab preserve the active tab', async () => {
    const active: string[] = [];
    const states: unknown[] = [];
    await renderTabs(active, states, 'daemon-1', ['daemon-1', 'daemon-2']);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();
    listEntries = [
      { terminalId: 'daemon-1', isAlive: true },
      { terminalId: 'daemon-2', isAlive: true, ownerRunUsage: 'unknown' },
    ];

    clickWithPropagationGuard(closeButton('daemon-2'));
    await harness.settle();

    expect(destroyCalls).toBe(0);
    expect(active).toEqual([]);
    expect(storage.get('elanous.webterm.tabs')).toBe('["daemon-1"]');

    await renderTabs(active, states, 'daemon-1', ['daemon-1', 'daemon-2']);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();
    confirmResult = false;
    clickWithPropagationGuard(terminateButton('daemon-2'));
    await harness.settle();

    expect(destroyCalls).toBe(0);
    expect(active).toEqual([]);
    expect(storage.get('elanous.webterm.tabs')).toBe('["daemon-1","daemon-2"]');

    confirmResult = true;
    clickWithPropagationGuard(terminateButton('daemon-2'));
    await harness.settle();

    expect(destroyCalls).toBe(1);
    expect(active).toEqual([]);
    expect(storage.get('elanous.webterm.tabs')).toBe('["daemon-1"]');
    expect(storage.get('elanous.webterm.tabs')).not.toContain('daemon-2');
  });

  test('cancelling termination changes neither daemon nor local tabs', async () => {
    const active: string[] = [];
    const states: unknown[] = [];
    await renderTabs(active, states);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();

    confirmResult = false;
    clickWithPropagationGuard(terminateButton());
    await harness.settle();

    expect(destroyCalls).toBe(0);
    expect(storage.get('elanous.webterm.tabs')).toBe('["daemon-1"]');
    expect(confirmMessages.at(-1)).toContain('사용 상태를 확인할 수 없습니다');
  });

  test('confirmed termination sends destroy once and removes the tab only after success', async () => {
    const active: string[] = [];
    const states: unknown[] = [];
    await renderTabs(active, states);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();

    clickWithPropagationGuard(terminateButton());
    await harness.settle();

    expect(destroyCalls).toBe(1);
    expect(storage.get('elanous.webterm.tabs')).not.toContain('daemon-1');
  });

  test('preserves the latest active tab during a delayed termination in both switch directions', async () => {
    const active: string[] = [];
    const states: unknown[] = [];
    await renderTabs(active, states, 'daemon-1', ['daemon-1', 'daemon-2']);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();
    listEntries = [
      { terminalId: 'daemon-1', isAlive: true },
      { terminalId: 'daemon-2', isAlive: true },
    ];

    destroyMode = 'pending';
    clickWithPropagationGuard(terminateButton('daemon-1'));
    expect(destroyCalls).toBe(1);
    harness.act(() => (switchButton('daemon-2').props.onClick as () => void)());
    await harness.settle();
    expect(active.at(-1)).toBe('daemon-2');
    resolvePendingDestroy?.();
    await harness.settle();
    expect(active.at(-1)).toBe('daemon-2');
    expect(storage.get('elanous.webterm.tabs')).toBe('["daemon-2"]');

    await renderTabs(active, states, 'daemon-1', ['daemon-1', 'daemon-2']);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();
    destroyMode = 'pending';
    clickWithPropagationGuard(terminateButton('daemon-1'));
    harness.act(() => (switchButton('daemon-2').props.onClick as () => void)());
    await harness.settle();
    harness.act(() => (switchButton('daemon-1').props.onClick as () => void)());
    await harness.settle();
    expect(active.at(-1)).toBe('daemon-1');
    resolvePendingDestroy?.();
    await harness.settle();
    expect(active.at(-1)).toBe('daemon-2');
    expect(storage.get('elanous.webterm.tabs')).toBe('["daemon-2"]');
    expect(harness.findAll((element) => element.props['aria-label'] === 'switch to daemon-1')).toHaveLength(0);
  });

  test('a failed termination leaves the tab in local storage', async () => {
    const active: string[] = [];
    const states: unknown[] = [];
    await renderTabs(active, states);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();

    destroyMode = 'throw';
    clickWithPropagationGuard(terminateButton());
    await harness.settle();

    expect(destroyCalls).toBe(1);
    expect(storage.get('elanous.webterm.tabs')).toBe('["daemon-1"]');
  });
});

describe('TerminalTabs ownership control interaction', () => {
  test('uses ownership metadata to show takeover or release, invokes control without confirmation, and refreshes after success', async () => {
    const active: string[] = [];
    const states: unknown[] = [];
    await renderTabs(active, states, 'daemon-1', ['daemon-1'], [
      { terminalId: 'daemon-1', isAlive: true, terminalOriginCategory: 'elanous', controller: 'agent' },
      { terminalId: 'daemon-2', isAlive: true, terminalOriginCategory: 'direct-human', controller: 'human' },
      { terminalId: 'unknown', isAlive: true, terminalOriginCategory: 'unknown' },
    ]);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();

    expect(controlButton('takeover', 'daemon-1')).toBeDefined();
    expect(controlButton('release', 'daemon-2')).toBeDefined();
    expect(harness.findAll((element) => element.props['aria-label'] === 'takeover unknown')).toHaveLength(0);
    expect(confirmMessages).toHaveLength(0);

    listEntries = [
      { terminalId: 'daemon-1', isAlive: true, terminalOriginCategory: 'direct-human', controller: 'human' },
      { terminalId: 'daemon-2', isAlive: true, terminalOriginCategory: 'direct-human', controller: 'human' },
      { terminalId: 'unknown', isAlive: true, terminalOriginCategory: 'unknown' },
    ];
    clickWithPropagationGuard(controlButton('takeover', 'daemon-1'));
    await harness.settle();

    expect(controlCalls).toEqual([{ id: 'daemon-1', action: 'takeover' }]);
    expect(confirmMessages).toHaveLength(0);
    expect(statusMessage()).toBe('터미널을 넘겨받았습니다.');
    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(controlButton('release', 'daemon-1')).toBeDefined();
  });

  test('shows a distinct message for every control result and transport exception', async () => {
    const expected: Array<[typeof controlMode, string]> = [
      ['success', '터미널을 넘겨받았습니다.'],
      ['unknown-pty', '이 PTY를 찾을 수 없습니다. 목록을 새로고침해 주세요.'],
      ['denied', '이 PTY의 제어를 바꿀 권한이 없습니다.'],
      ['failed', 'PTY 제어 전환에 실패했습니다. 잠시 후 다시 시도해 주세요.'],
      ['owner-unreachable', 'PTY 소유 프로세스에 연결할 수 없어 제어를 전환하지 못했습니다.'],
      ['throw', 'PTY 제어 요청을 전송하지 못했습니다. 네트워크 연결을 확인해 주세요.'],
    ];
    const messages = new Set<string>();
    for (const [mode, expectedMessage] of expected) {
      const active: string[] = [];
      const states: unknown[] = [];
      await renderTabs(active, states, 'daemon-1', ['daemon-1'], [
        { terminalId: 'daemon-1', isAlive: true, terminalOriginCategory: 'elanous', controller: 'agent' },
      ]);
      connection.state = 'OPEN';
      harness.act(() => stateListener?.('OPEN'));
      await harness.settle();
      controlMode = mode;
      clickWithPropagationGuard(controlButton('takeover'));
      await harness.settle();
      expect(statusMessage()).toBe(expectedMessage);
      messages.add(statusMessage());
    }
    expect(messages).toHaveLength(6);
  });

  test('suppresses duplicate requests while pending and discards a response after the tab is removed', async () => {
    const active: string[] = [];
    const states: unknown[] = [];
    await renderTabs(active, states, 'daemon-1', ['daemon-1'], [
      { terminalId: 'daemon-1', isAlive: true, terminalOriginCategory: 'elanous', controller: 'agent' },
    ]);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();

    controlMode = 'pending';
    clickWithPropagationGuard(controlButton('takeover'));
    clickWithPropagationGuard(controlButton('takeover'));
    expect(controlCalls).toEqual([{ id: 'daemon-1', action: 'takeover' }]);

    clickWithPropagationGuard(closeButton());
    pendingControlResolvers.get('daemon-1')?.({ status: 'success' });
    await harness.settle();
    expect(harness.findAll((element) => element.props.role === 'status')).toHaveLength(0);
  });

  test('keeps A control active when B closes, then applies A response', async () => {
    const active: string[] = [];
    const states: unknown[] = [];
    await renderTabs(active, states, 'daemon-1', ['daemon-1', 'daemon-2'], [
      { terminalId: 'daemon-1', isAlive: true, terminalOriginCategory: 'elanous', controller: 'agent' },
      { terminalId: 'daemon-2', isAlive: true, terminalOriginCategory: 'elanous', controller: 'agent' },
    ]);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();

    controlMode = 'pending';
    clickWithPropagationGuard(controlButton('takeover', 'daemon-1'));
    clickWithPropagationGuard(closeButton('daemon-2'));
    expect(String(controlButton('takeover', 'daemon-1').props.children)).toBe('전환 중…');

    pendingControlResolvers.get('daemon-1')?.({ status: 'success' });
    await harness.settle();
    expect(statusMessage()).toBe('터미널을 넘겨받았습니다.');
    expect(String(controlButton('takeover', 'daemon-1').props.children)).toBe('넘겨받기');
  });

  test('applies independent A and B successes in reverse completion order and refreshes once per success', async () => {
    const active: string[] = [];
    const states: unknown[] = [];
    await renderTabs(active, states, 'daemon-1', ['daemon-1', 'daemon-2'], [
      { terminalId: 'daemon-1', isAlive: true, terminalOriginCategory: 'elanous', controller: 'agent' },
      { terminalId: 'daemon-2', isAlive: true, terminalOriginCategory: 'elanous', controller: 'agent' },
    ]);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();
    const initialListCalls = listCalls;

    controlMode = 'pending';
    clickWithPropagationGuard(controlButton('takeover', 'daemon-1'));
    clickWithPropagationGuard(controlButton('takeover', 'daemon-2'));
    expect(controlCalls).toEqual([
      { id: 'daemon-1', action: 'takeover' },
      { id: 'daemon-2', action: 'takeover' },
    ]);
    expect(String(controlButton('takeover', 'daemon-1').props.children)).toBe('전환 중…');
    expect(String(controlButton('takeover', 'daemon-2').props.children)).toBe('전환 중…');

    listEntries = [
      { terminalId: 'daemon-1', isAlive: true, terminalOriginCategory: 'direct-human', controller: 'human' },
      { terminalId: 'daemon-2', isAlive: true, terminalOriginCategory: 'direct-human', controller: 'human' },
    ];
    pendingControlResolvers.get('daemon-2')?.({ status: 'success' });
    await harness.settle();
    expect(statusMessage()).toBe('터미널을 넘겨받았습니다.');
    // B의 새 목록은 이미 사람 제어로 바꾸지만, A의 요청 상태를 끝내면 안 된다.
    // 두 버튼을 terminalId로 각각 잡아 목록 파생 라벨과 요청 상태를 분리해 문다.
    expect(String(controlButton('release', 'daemon-1').props.children)).toBe('전환 중…');
    expect(String(controlButton('release', 'daemon-2').props.children)).toBe('놓기');
    expect(listCalls).toBe(initialListCalls + 1);

    pendingControlResolvers.get('daemon-1')?.({ status: 'success' });
    await harness.settle();

    expect(harness.findAll((element) => element.props.role === 'status').map((element) => String(element.props.children)))
      .toEqual(expect.arrayContaining([
        '터미널을 넘겨받았습니다.',
        '터미널을 넘겨받았습니다.',
      ]));
    expect(listCalls).toBe(initialListCalls + 2);
    expect(String(controlButton('release', 'daemon-1').props.children)).toBe('놓기');
    expect(String(controlButton('release', 'daemon-2').props.children)).toBe('놓기');
    expect(String(controlButton('release', 'daemon-1').props.children)).not.toBe('전환 중…');
    expect(String(controlButton('release', 'daemon-2').props.children)).not.toBe('전환 중…');
  });
});

describe('TerminalTabs terminal provenance rendering', () => {
  test('renders distinct human, external-tool, and unknown labels and only renders a supplied controller', async () => {
    const active: string[] = [];
    const states: unknown[] = [];
    await renderTabs(active, states, 'human', ['human', 'external', 'unknown'], [
      { terminalId: 'human', isAlive: true, terminalOriginCategory: 'direct-human', controller: 'operator' },
      { terminalId: 'external', isAlive: true, terminalOriginCategory: 'external-tool', externalToolName: 'codex' },
      { terminalId: 'unknown', isAlive: true, terminalOriginCategory: 'unknown', terminalOriginReason: 'legacy daemon' },
    ]);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();

    const labels = ['human', 'external', 'unknown'].map((id) => String(switchButton(id).props.children));
    expect(labels[0]).toContain('사람');
    expect(labels[0]).toContain('통제: operator');
    expect(labels[1]).toContain('외부 도구: codex');
    expect(labels[1]).not.toContain('통제:');
    // #20967 — 출처를 모르면 탭 «글자»에는 안 붙이고 툴팁(title)에만 둔다.
    expect(labels[2]).not.toContain('이 행에서는 알 수 없음');
    expect(String(switchButton('unknown').props.title)).toContain('이 행에서는 알 수 없음: legacy daemon');
    expect(labels[2]).not.toContain('사람');
    expect(new Set(labels)).toHaveLength(3);
  });
});

describe('TerminalTabs initial issuance — 실패 갈래를 «주입해서» 태운다', () => {
  test('데몬 발급이 성공하면 관측에도 daemon 출처가 남는다', async () => {
    spawnMode = 'ok';
    const active: string[] = [];
    const states: unknown[] = [];
    await renderTabs(active, states);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();

    const initial = debugCalls.filter((call) => call.event === 'webterm.tabs.initial');
    expect(initial.length).toBeGreaterThanOrEqual(1);
    expect(initial.at(-1)!.data.issuedBy).toBe('daemon');
    expect(initial.at(-1)!.data.fallbackReason).toBeUndefined();
    // ⛔ «최종» 상태로 단언한다 — toContainEqual 은 「한 번이라도 있었나」만 보므로
    //    나중에 restored-tab 이 덮어써도 통과한다(무인 리뷰 must-fix · 2026-08-18).
    expect(states.at(-1)).toEqual({ status: 'ready', issuedBy: 'daemon' });
    // 발급한 탭을 「복원했다」로 다시 라벨하지 않는다.
    expect(states.filter((state) => (state as { fallbackReason?: string }).fallbackReason === 'restored-tab'))
      .toHaveLength(0);
  });

  test('spawn 이 «던지면» 로컬로 내려가고 그 사유가 화면 상태와 관측 «양쪽»에 남는다', async () => {
    spawnMode = 'throw';
    const active: string[] = [];
    const states: unknown[] = [];
    await renderTabs(active, states);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();

    expect(spawnCalls).toBe(1);
    // 화면 쪽 절반 — 부모가 받는 상태에 출처와 사유가 실린다
    expect(states).toContainEqual({ status: 'ready', issuedBy: 'local', fallbackReason: 'spawn-error' });
    // 관측 쪽 절반 — 같은 사유가 logs.db 로 가는 이벤트에도 실린다
    // ⛔ 렌더 «횟수»에 기대지 않는다 — 하니스 재렌더 수는 계약이 아니다. 계약은 「사유가 실렸나」다.
    const initial = debugCalls.filter((call) => call.event === 'webterm.tabs.initial');
    expect(initial.length).toBeGreaterThanOrEqual(1);
    expect(initial.at(-1)!.data.issuedBy).toBe('local');
    expect(initial.at(-1)!.data.fallbackReason).toBe('spawn-error');
    // ⛔ «최종» 상태다 — 여기서 restored-tab 이 덮이면 실패 배너가 화면에서 «사라진다»
    expect(states.at(-1)).toEqual({ status: 'ready', issuedBy: 'local', fallbackReason: 'spawn-error' });
    expect(states.filter((state) => (state as { fallbackReason?: string }).fallbackReason === 'restored-tab'))
      .toHaveLength(0);
    // 그리고 그 최종 상태가 «실제 화면 문면»으로 바뀌는지까지 본다 — 상태만 맞고 배너가 없으면 침묵이다
    expect(initialTerminalNotice(states.at(-1) as never, true).fallbackBanner).toContain('spawn-error');
    // 탭은 «그래도» 열린다 — 이름이 로컬인 것이 탭이 안 열리는 것보다 낫다
    expect(active.length).toBeGreaterThanOrEqual(1);
  });

  test('응답에 terminalId 가 «없으면» 다른 사유로 갈린다 — 두 실패가 한 칸에 안 들어간다', async () => {
    spawnMode = 'no-id';
    const active: string[] = [];
    const states: unknown[] = [];
    await renderTabs(active, states);
    connection.state = 'OPEN';
    harness.act(() => stateListener?.('OPEN'));
    await harness.settle();

    expect(states.at(-1)).toEqual({
      status: 'ready', issuedBy: 'local', fallbackReason: 'response-without-terminal-id',
    });
    expect(initialTerminalNotice(states.at(-1) as never, true).fallbackBanner)
      .toContain('response-without-terminal-id');
    const initial = debugCalls.filter((call) => call.event === 'webterm.tabs.initial');
    expect(initial.at(-1)!.data.fallbackReason).toBe('response-without-terminal-id');
    spawnMode = 'ok';
  });
});
