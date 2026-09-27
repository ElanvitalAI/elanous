import { afterAll, describe, expect, mock, test } from 'bun:test';
import { restoreModuleMocksAfterAll } from '@/lib/testing/restore-module-mocks';
import { createRequire } from 'node:module';

import { createReactHookHarness } from '@/lib/testing/react-hook-harness';
import { sendToTerminal } from './terminal-input-registry';

type StateListener = (state: 'CONNECTING' | 'OPEN' | 'FAILED' | 'CLOSED', error?: Error) => void;
type IntervalCallback = () => void;

const require = createRequire(import.meta.url);
const react = require('react') as {
  createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown;
  Fragment: unknown;
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { H: unknown };
};
const harness = createReactHookHarness(react);
const listeners = new Set<StateListener>();
let now = 0;
let nextIntervalId = 1;
const intervals = new Map<number, IntervalCallback>();
let onTerminalData: ((data: string) => void) | undefined;
let sendInput: (data: string, sessionId: string) => Promise<unknown> = async () => ({});
let onAcpSession: ((sessionId: string) => void) | undefined;
let capabilityResponse = '';
const terminals: Terminal[] = [];
const logs: Array<{ event: string; details: unknown }> = [];
let sends: string[] = [];

// R-TST23 — 이 파일은 전역 `window`·`Date.now` 와 모듈 여럿(React JSX 런타임 포함)을 바꾼다. mock.module 은
// 프로세스 전역이라, 안 되돌리면 뒤에 도는 파일이 가짜를 받는다(2026-09-27 전 스위트: `IntakeFrontDoor.test.tsx`
// 6건이 `instanceof window.HTMLElement` 로 깨졌다 · 이 파일과 짝으로 돌리면 재현). 원본을 잡아 두고 끝에 되돌린다.
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDateNow = Date.now;
const MOCKED_MODULES = [
  'react/jsx-dev-runtime', 'react/jsx-runtime',
  '@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links', '@xterm/addon-unicode11', '@xterm/addon-serialize',
  '@/lib/debug', '@/lib/elanous-term-envelope', '@/lib/peer-id', '@/lib/snapshot',
  '@/lib/xterm-resize-controller', '@/lib/xterm-capability-filter',
] as const;
await restoreModuleMocksAfterAll(MOCKED_MODULES, (specifier) => import(specifier));
afterAll(() => {
  if (originalWindowDescriptor) Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  else delete (globalThis as { window?: unknown }).window;
  Date.now = originalDateNow;
  mock.module('@/components/providers/DaemonProvider', () => actualDaemonProvider);
});

Object.defineProperty(globalThis, 'window', {
  value: {
    setInterval: (callback: IntervalCallback) => {
      const id = nextIntervalId++;
      intervals.set(id, callback);
      return id;
    },
    clearInterval: (id: number) => intervals.delete(id),
  },
  configurable: true,
});

Date.now = () => now;

const element = (type: unknown, props?: Record<string, unknown>) => {
  const ref = props?.ref as { current: unknown } | undefined;
  if (ref) ref.current = {};
  return react.createElement(type, props);
};

mock.module('react/jsx-dev-runtime', () => ({ jsxDEV: element, Fragment: react.Fragment }));
mock.module('react/jsx-runtime', () => ({ jsx: element, jsxs: element, Fragment: react.Fragment }));

class Terminal {
  constructor() { terminals.push(this); }
  clearCount = 0;
  clear(): void { this.clearCount += 1; }
  cols = 80;
  rows = 24;
  unicode = { activeVersion: '' };
  loadAddon(): void {}
  open(): void {}
  write(): void {}
  onData(callback: (data: string) => void): { dispose(): void } {
    onTerminalData = callback;
    return { dispose() { onTerminalData = undefined; } };
  }
  onResize(): { dispose(): void } { return { dispose() {} }; }
  dispose(): void {}
}

mock.module('@xterm/xterm', () => ({ Terminal }));
mock.module('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));
mock.module('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
mock.module('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
mock.module('@xterm/addon-serialize', () => ({ SerializeAddon: class { serialize(): string { return ''; } } }));
mock.module('@/lib/debug', () => ({ debugLog: (event: string, details: unknown) => { logs.push({ event, details }); } }));
mock.module('@/lib/elanous-term-envelope', () => ({ parseElanousTermEnvelope: () => null }));
mock.module('@/lib/peer-id', () => ({ getPeerId: () => 'peer' }));
mock.module('@/lib/snapshot', () => ({ loadSnapshot: () => null, saveSnapshot: () => {}, snapshotKey: () => 'snapshot' }));
mock.module('@/lib/xterm-resize-controller', () => ({ createXtermResizeController: () => ({ dispose: () => {} }) }));
mock.module('@/lib/xterm-capability-filter', () => ({ isXtermCapabilityResponse: (data: string) => data === capabilityResponse }));

const acp = {
  ready: Promise.resolve('s1'),
  on: () => () => {},
  onState: (listener: StateListener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  send: (method: string, params: unknown) => {
    sends.push(method);
    if (method !== 'terminal/input') return Promise.resolve({});
    const { data, sessionId } = params as { data: string; sessionId: string };
    return sendInput(data, sessionId);
  },
  close: () => {},
};

const daemon = {
  client: { connectAcp: (options: { onSession: (sessionId: string) => void }) => {
    onAcpSession = options.onSession;
    return acp;
  } },
  config: { baseUrl: 'http://127.0.0.1:4242' },
  setSessionId: () => {},
};

const actualDaemonProvider = { ...(await import('@/components/providers/DaemonProvider')) };
mock.module('@/components/providers/DaemonProvider', () => ({ ...actualDaemonProvider, useDaemon: () => daemon }));

const { XtermView } = await import('./XtermView');

type Element = { props?: { children?: unknown[]; className?: string; 'aria-live'?: string } };

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const children = (value as Element).props?.children ?? [];
  return children.map(textOf).join('');
}

function statusClassOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const elementValue = value as Element;
  if (typeof elementValue.props?.className === 'string' && elementValue.props.className.includes('absolute right-2 top-2')) {
    return elementValue.props.className;
  }
  const children = elementValue.props?.children ?? [];
  return children.map(statusClassOf).find(Boolean) ?? '';
}

function liveTextOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const elementValue = value as Element;
  if (elementValue.props?.['aria-live'] === 'polite') return textOf(elementValue);
  const children = elementValue.props?.children ?? [];
  return children.map(liveTextOf).find(Boolean) ?? '';
}

function render(terminalId = 't1', clearRequest = 0, readOnly = false): unknown {
  harness.render(() => XtermView({ sessionId: 's1', terminalId, clearRequest, readOnly }));
  return harness.find((element) => element.type === 'div' && element.props.className === 'relative h-full w-full bg-[#0d0c08]');
}

function mount(terminalId = 't1'): () => void {
  render(terminalId);
  return () => harness.unmount();
}

function resetState(): void {
  harness.unmount();
  listeners.clear();
  intervals.clear();
  now = 0;
  onTerminalData = undefined;
  onAcpSession = undefined;
  sendInput = async () => ({});
  acp.ready = Promise.resolve('s1');
  capabilityResponse = '';
  terminals.length = 0;
  logs.length = 0;
  sends = [];
}

describe('XtermView terminal input routing', () => {
  test('routes external and keyboard input through the same sender for its terminalId', async () => {
    resetState();
    const sent: Array<{ data: string; sessionId: string }> = [];
    sendInput = async (data, sessionId) => { sent.push({ data, sessionId }); return {}; };
    render('terminal-a');
    await harness.settle();
    expect(sendToTerminal('terminal-b', 'wrong')).toBe(false);
    expect(sendToTerminal('terminal-a', 'external')).toBe(true);
    onTerminalData?.('keyboard');
    await harness.settle();
    expect(sent).toEqual([
      { data: 'external', sessionId: 's1' },
      { data: 'keyboard', sessionId: 's1' },
    ]);
    harness.unmount();
  });

  test('queues routed input before ACP connects and drains it in order', async () => {
    resetState();
    let connect!: (sessionId: string) => void;
    acp.ready = new Promise<string>((resolve) => { connect = resolve; });
    const sent: Array<{ data: string; sessionId: string }> = [];
    sendInput = async (data, sessionId) => { sent.push({ data, sessionId }); return {}; };
    render('terminal-a');
    expect(sendToTerminal('terminal-a', 'first')).toBe(true);
    onTerminalData?.('second');
    expect(sendToTerminal('terminal-a', 'third')).toBe(true);
    expect(sent).toEqual([]);
    connect('connected-session');
    await harness.settle();
    expect(sent).toEqual([
      { data: 'first', sessionId: 'connected-session' },
      { data: 'second', sessionId: 'connected-session' },
      { data: 'third', sessionId: 'connected-session' },
    ]);
    harness.unmount();
  });

  test('does not register readOnly and removes routed input on readOnly toggle and unmount', async () => {
    resetState();
    const sent: string[] = [];
    sendInput = async (data) => { sent.push(data); return {}; };
    render('terminal-a', 0, true);
    expect(sendToTerminal('terminal-a', 'readonly')).toBe(false);
    expect(onTerminalData).toBeUndefined();
    render('terminal-a', 0, false);
    await harness.settle();
    expect(sendToTerminal('terminal-a', 'writable')).toBe(true);
    await harness.settle();
    render('terminal-a', 0, true);
    expect(sendToTerminal('terminal-a', 'readonly-again')).toBe(false);
    render('terminal-a', 0, false);
    expect(sendToTerminal('terminal-a', 'pending-unmount')).toBe(true);
    harness.unmount();
    expect(sendToTerminal('terminal-a', 'after-unmount')).toBe(false);
    await Promise.resolve();
    expect(sent).toEqual(['writable']);
  });
});

describe('XtermView local clear', () => {
  test('clears only its xterm once per changed request and never sends shell input', async () => {
    if (!process.env.ELANOUS_XTERM_CLEAR_ISOLATED) {
      const run = Bun.spawnSync(['bun', 'test', import.meta.path, '-t', 'clears only its xterm once per changed request and never sends shell input'], {
        cwd: process.cwd(),
        env: { ...process.env, ELANOUS_XTERM_CLEAR_ISOLATED: '1' },
        stdout: 'pipe', stderr: 'pipe',
      });
      expect(new TextDecoder().decode(run.stderr)).toContain('1 pass');
      expect(run.exitCode).toBe(0);
      return;
    }
    resetState();
    render('terminal-a', 0);
    await harness.settle();
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.clearCount).toBe(0);
    sends = [];
    render('terminal-a', 1);
    expect(terminals[0]!.clearCount).toBe(1);
    expect(logs.filter(({ event }) => event === 'webterm.controls.clear.applied')).toEqual([
      { event: 'webterm.controls.clear.applied', details: { terminalId: 'terminal-a' } },
    ]);
    render('terminal-a', 1);
    expect(terminals[0]!.clearCount).toBe(1);
    expect(sends).toEqual([]);
    harness.unmount();
  });
});

describe('XtermView ACP status surface', () => {
  test('shows deterministic connecting duration, target, and daemon address, then hides them after opening', () => {
    resetState();
    const cleanup = mount('terminal-a');
    listeners.forEach((listener) => listener('CONNECTING'));
    const connecting = render('terminal-a');
    expect(textOf(connecting)).toContain('ACP: 연결 중 · 0초 · terminal-a · http://127.0.0.1:4242');
    expect(liveTextOf(connecting)).toBe('ACP: 연결 중');

    now = 65_000;
    intervals.forEach((callback) => callback());
    const waiting = render('terminal-a');
    expect(textOf(waiting)).toContain('ACP: 연결 중 · 65초 · terminal-a · http://127.0.0.1:4242');
    expect(liveTextOf(waiting)).toBe('ACP: 연결 중');
    expect(statusClassOf(waiting)).toContain('text-amber-300');

    listeners.forEach((listener) => listener('OPEN'));
    const opened = render('terminal-a');
    expect(textOf(opened)).toContain('ACP: 연결됨');
    expect(textOf(opened)).not.toContain('65초');
    expect(textOf(opened)).not.toContain('terminal-a');
    expect(textOf(opened)).not.toContain('http://127.0.0.1:4242');
    expect(statusClassOf(opened)).toContain('text-emerald-300');
    cleanup();
  });

  test('uses a target fallback, preserves failure and closed labels and tones, and clears timers on unmount', () => {
    resetState();
    const cleanup = mount('   ');
    expect(textOf(render('   '))).toContain('ACP: 연결 중 · 0초 · 대상 미지정 · http://127.0.0.1:4242');
    expect(statusClassOf(render('   '))).toContain('text-amber-300');

    listeners.forEach((listener) => listener('FAILED', new Error('offline')));
    const failed = render('   ');
    expect(textOf(failed)).toContain('ACP: 연결 실패');
    expect(statusClassOf(failed)).toContain('text-red-300');

    listeners.forEach((listener) => listener('CLOSED'));
    const closed = render('   ');
    expect(textOf(closed)).toContain('ACP: 연결 종료');
    expect(statusClassOf(closed)).toContain('text-red-300');

    cleanup();
    expect(listeners.size).toBe(0);
    expect(intervals.size).toBe(0);
  });

  test('swallows capability responses but forwards ordinary input', async () => {
    resetState();
    const sent: string[] = [];
    capabilityResponse = 'capability-response';
    sendInput = async (data) => { sent.push(data); return {}; };
    const cleanup = mount('terminal-a');
    await harness.settle();
    onTerminalData?.(capabilityResponse);
    onTerminalData?.('ordinary');
    await harness.settle();
    expect(sent).toEqual(['ordinary']);
    cleanup();
  });

  test('forwards later input with the session announced by ACP onSession', async () => {
    resetState();
    const sent: Array<{ data: string; sessionId: string }> = [];
    sendInput = async (data, sessionId) => { sent.push({ data, sessionId }); return {}; };
    const cleanup = mount('terminal-a');
    await harness.settle();
    onAcpSession?.('new-session');
    onTerminalData?.('after-session');
    await harness.settle();
    onAcpSession?.('s1');
    onTerminalData?.('back-to-initial');
    await harness.settle();
    expect(sent).toEqual([
      { data: 'after-session', sessionId: 'new-session' },
      { data: 'back-to-initial', sessionId: 's1' },
    ]);
    cleanup();
  });

  test('shows discarded input as an alert and accepts later input', async () => {
    resetState();
    const sent: string[] = [];
    sendInput = async (data) => {
      sent.push(data);
      if (data === 'lost') throw new Error('offline');
      return {};
    };
    const cleanup = mount('terminal-a');
    await harness.settle();
    onTerminalData?.('lost');
    await harness.settle();
    const alert = harness.find((element) => element.props.role === 'alert');
    expect(harness.textOf(alert)).toContain('4바이트가 버려졌습니다');
    onTerminalData?.('later');
    await harness.settle();
    expect(sent).toEqual(['lost', 'later']);
    expect(harness.textOf(harness.find((element) => element.props.role === 'alert'))).toContain('버려졌습니다');
    cleanup();
  });

  test('renders a replacement terminal as connecting before its replacement effects run', () => {
    resetState();
    const firstCleanup = mount('terminal-a');
    listeners.forEach((listener) => listener('OPEN'));
    expect(textOf(render('terminal-a'))).toContain('ACP: 연결됨');

    now = 42_000;
    const replacementBeforeEffects = render('terminal-b');
    expect(textOf(replacementBeforeEffects)).toContain('ACP: 연결 중 · 0초 · terminal-b · http://127.0.0.1:4242');
    expect(textOf(replacementBeforeEffects)).not.toContain('연결됨');
    expect(statusClassOf(replacementBeforeEffects)).toContain('text-amber-300');

    firstCleanup();
    const secondCleanup = mount('terminal-b');
    expect(textOf(render('terminal-b'))).toContain('ACP: 연결 중 · 0초 · terminal-b · http://127.0.0.1:4242');
    secondCleanup();
  });
});
