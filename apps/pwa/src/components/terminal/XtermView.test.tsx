import { setDefaultTimeout, afterAll, describe, expect, mock, test } from 'bun:test';
import { restoreModuleMocksAfterAll } from '@/lib/testing/restore-module-mocks';
import { createRequire } from 'node:module';

import { createReactHookHarness } from '@/lib/testing/react-hook-harness';
import { sendToTerminal, setStickyModifiers, takeStickyModifiers } from './terminal-input-registry';
import { COMPACT_MAX_WIDTH } from '@/lib/compact-mode';
import { publishTermFontSize, subscribeTermFontSize, TERM_FOCUS_DISABLED_KEY } from '@/lib/term-focus';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

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
let onSessionUpdate: ((frame: { params?: unknown }) => void) | undefined;
let spawnResponse: { status: string; snapshot?: string } = { status: 'attached', snapshot: 'ready' };
let capabilityResponse = '';
const terminals: Terminal[] = [];
const logs: Array<{ event: string; details: unknown }> = [];
let sends: string[] = [];
let width = COMPACT_MAX_WIDTH + 1;
let coarse = false;
const storage = new Map<string, string>();
const windowListeners = new Map<string, Set<() => void>>();

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
    get innerWidth() { return width; },
    matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' && coarse }),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
    addEventListener: (kind: string, listener: () => void) => { (windowListeners.get(kind) ?? windowListeners.set(kind, new Set()).get(kind)!).add(listener); },
    removeEventListener: (kind: string, listener: () => void) => { windowListeners.get(kind)?.delete(listener); },
  },
  configurable: true,
});

Date.now = () => now;

const touchListeners = new Map<string, (event: any) => void>();
const documentTouchListeners = new Set<(event: any) => void>();
const fakeTouchDocument = {
  addEventListener: (name: string, listener: (event: any) => void) => { if (name === 'touchstart') documentTouchListeners.add(listener); },
  removeEventListener: (name: string, listener: (event: any) => void) => { if (name === 'touchstart') documentTouchListeners.delete(listener); },
};
const element = (type: unknown, props?: Record<string, unknown>) => {
  const ref = props?.ref as { current: unknown } | undefined;
  if (ref) ref.current = {
    ownerDocument: fakeTouchDocument,
    contains: (target: unknown) => target === 'own-pane',
    addEventListener: (name: string, listener: (event: any) => void) => touchListeners.set(name, listener),
    removeEventListener: (name: string) => touchListeners.delete(name),
  };
  return react.createElement(type, props);
};

mock.module('react/jsx-dev-runtime', () => ({ jsxDEV: element, Fragment: react.Fragment }));
mock.module('react/jsx-runtime', () => ({ jsx: element, jsxs: element, Fragment: react.Fragment }));

class Terminal {
  options: { fontSize?: number };
  constructor(options: { fontSize?: number }) { this.options = options; terminals.push(this); }
  focusCount = 0;
  focus(): void { this.focusCount++; }
  clearCount = 0;
  clear(): void { this.clearCount += 1; }
  cols = 80;
  rows = 24;
  unicode = { activeVersion: '' };
  buffer = { active: { viewportY: 0, type: 'normal' } };
  loadAddon(): void {}
  open(): void {}
  writes: string[] = [];
  write(data: string): void { this.writes.push(data); }
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
const actualTermEnvelope = await import('@/lib/elanous-term-envelope');
mock.module('@/lib/elanous-term-envelope', () => actualTermEnvelope);
mock.module('@/lib/peer-id', () => ({ getPeerId: () => 'peer' }));
mock.module('@/lib/snapshot', () => ({ loadSnapshot: () => null, saveSnapshot: () => {}, snapshotKey: () => 'snapshot' }));
mock.module('@/lib/xterm-resize-controller', () => ({ createXtermResizeController: () => ({ dispose: () => {} }) }));
mock.module('@/lib/xterm-capability-filter', () => ({ isXtermCapabilityResponse: (data: string) => data === capabilityResponse }));

const acp = {
  ready: Promise.resolve('s1'),
  on: (_kind: string, callback: (frame: { params?: unknown }) => void) => {
    onSessionUpdate = callback;
    return () => { if (onSessionUpdate === callback) onSessionUpdate = undefined; };
  },
  onState: (listener: StateListener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  send: (method: string, params: unknown) => {
    sends.push(method);
    if (method === 'terminal/spawn') return Promise.resolve(spawnResponse);
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

type Element = { props?: { children?: unknown[]; className?: string; 'aria-live'?: string; 'data-acp-status'?: boolean } };

/** 자식이 하나면 React 는 배열이 아니라 그 값 하나를 준다 — 둘 다 받는다. */
function childList(value: Element): unknown[] {
  const raw = value.props?.children;
  return Array.isArray(raw) ? raw : raw == null ? [] : [raw];
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const children = childList(value as Element);
  return children.map(textOf).join('');
}

function statusClassOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const elementValue = value as Element;
  if (elementValue.props?.['data-acp-status'] === true && typeof elementValue.props.className === 'string') {
    return elementValue.props.className;
  }
  const children = childList(elementValue);
  return children.map(statusClassOf).find(Boolean) ?? '';
}

function liveTextOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const elementValue = value as Element;
  if (elementValue.props?.['aria-live'] === 'polite') return textOf(elementValue);
  const children = childList(elementValue);
  return children.map(liveTextOf).find(Boolean) ?? '';
}

function render(terminalId = 't1', clearRequest = 0, readOnly = false): unknown {
  harness.render(() => XtermView({ sessionId: 's1', terminalId, clearRequest, readOnly }));
  return harness.find((element) => element.props['data-xterm-host'] === true);
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
  onSessionUpdate = undefined;
  spawnResponse = { status: 'attached', snapshot: 'ready' };
  sendInput = async () => ({});
  acp.ready = Promise.resolve('s1');
  capabilityResponse = '';
  terminals.length = 0;
  logs.length = 0;
  sends = [];
  width = COMPACT_MAX_WIDTH + 1;
  coarse = false;
  storage.clear();
  windowListeners.clear();
}

describe('XtermView pinch events', () => {
  test('suppresses remaining pinch contact until release, then permits a fresh scroll', () => {
    resetState();
    const originalWheelEvent = globalThis.WheelEvent;
    const wheels: unknown[] = [];
    (globalThis as any).WheelEvent = class { constructor(public type: string, public options: unknown) {} };
    try {
      harness.render(() => XtermView({ sessionId: 's1', terminalId: 't1' }));
      const term = terminals.at(-1)!;
      term.buffer.active.type = 'alternate';
      Object.assign(term, { modes: { mouseTrackingMode: 'none' }, element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ height: 240 }) }),
        dispatchEvent: (event: unknown) => { wheels.push(event); return true; },
      } });
      const a = { identifier: 1, clientX: 0, clientY: 0 };
      const b = { identifier: 2, clientX: 100, clientY: 0 };
      const fire = (type: string, touches: unknown[], changedTouches: unknown[]) => touchListeners.get(type)!({ type, touches, changedTouches, cancelable: true, preventDefault() {} });
      fire('touchstart', [a], [a]);
      fire('touchstart', [a, b], [b]);
      fire('touchmove', [a, { ...b, clientX: 150 }], [{ ...b, clientX: 150 }]);
      fire('touchend', [a], [b]);
      fire('touchmove', [{ ...a, clientY: 30 }], [{ ...a, clientY: 30 }]);
      expect(wheels).toHaveLength(0);
      fire('touchend', [], [a]);
      fire('touchstart', [a], [a]);
      fire('touchmove', [{ ...a, clientY: 30 }], [{ ...a, clientY: 30 }]);
      // 출처: #39399 한 손가락 스크롤 복구 계약은 최소 한 번의 wheel 전달을 요구한다.
      expect(wheels.length).toBeGreaterThan(0);
      expect(sends).toEqual([]);
    } finally {
      harness.unmount();
      (globalThis as any).WheelEvent = originalWheelEvent;
    }
  });
  for (const ending of ['touchend', 'touchcancel', 'extra'] as const) {
    test(`prevents browser movement through ${ending} until all pane contacts leave`, () => {
      resetState();
      render();
      const term = terminals.at(-1)!;
      const scrolled: number[] = [];
      Object.assign(term, { modes: { mouseTrackingMode: 'none' }, scrollLines: (lines: number) => scrolled.push(lines), element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ height: 240 }) }),
      } });
      const a = { identifier: 1, clientX: 0, clientY: 0 };
      const b = { identifier: 2, clientX: 100, clientY: 0 };
      const c = { identifier: 3, clientX: 200, clientY: 0 };
      const fire = (type: string, touches: unknown[], changedTouches: unknown[], cancelable = true) => {
        let prevented = 0;
        touchListeners.get(type)!({ type, touches, changedTouches, cancelable, preventDefault() { prevented++; } });
        return prevented;
      };
      try {
        fire('touchstart', [a], [a]);
        fire('touchstart', [a, b], [b]);
        expect(fire('touchmove', [a, b], [b])).toBe(1);
        if (ending === 'extra') {
          fire('touchstart', [a, b, c], [c]);
          expect(fire('touchmove', [a, b, c], [c])).toBe(1);
          fire('touchend', [a, b], [c]);
          expect(fire('touchmove', [a, b], [b])).toBe(1);
          fire('touchend', [a], [b]);
        } else {
          fire(ending, [a], [b]);
        }
        expect(fire('touchmove', [{ ...a, clientY: 30 }], [a])).toBe(1);
        expect(fire('touchmove', [a], [a], false)).toBe(0);
        expect(scrolled).toEqual([]);
        fire('touchend', [], [a]);
        fire('touchstart', [a], [a]);
        expect(fire('touchmove', [{ ...a, clientY: 30 }], [a])).toBe(0);
        // 출처: #39399 한 손가락 스크롤 복구 계약은 최소 한 번의 스크롤을 요구한다.
        expect(scrolled.length).toBeGreaterThan(0);
      } finally { harness.unmount(); }
    });
  }
  test('never emits wheel for a contact while another pane is touched, even after the other contact ends', () => {
    resetState();
    const originalWheelEvent = globalThis.WheelEvent;
    const wheels: unknown[] = [];
    (globalThis as any).WheelEvent = class { constructor(public type: string, public options: unknown) {} };
    try {
      render();
      const term = terminals.at(-1)!;
      term.buffer.active.type = 'alternate';
      Object.assign(term, { modes: { mouseTrackingMode: 'none' }, element: {
        querySelector: () => ({ getBoundingClientRect: () => ({ height: 240 }) }),
        dispatchEvent: (event: unknown) => { wheels.push(event); return true; },
      } });
      const a = { identifier: 1, clientX: 0, clientY: 0 };
      const other = { identifier: 2, clientX: 100, clientY: 0 };
      const fire = (type: string, touches: unknown[], changedTouches: unknown[]) => touchListeners.get(type)!({ type, touches, changedTouches, cancelable: true, preventDefault() {} });
      fire('touchstart', [a], [a]);
      fire('touchmove', [{ ...a, clientY: 30 }, other], [{ ...a, clientY: 30 }]);
      fire('touchmove', [{ ...a, clientY: 50 }], [{ ...a, clientY: 50 }]);
      expect(wheels).toHaveLength(0);
      fire('touchend', [], [a]);
      fire('touchstart', [a], [a]);
      fire('touchmove', [{ ...a, clientY: 30 }], [{ ...a, clientY: 30 }]);
      // 출처: #39399 한 손가락 스크롤 복구 계약은 최소 한 번의 wheel 전달을 요구한다.
      expect(wheels.length).toBeGreaterThan(0);
    } finally {
      harness.unmount();
      (globalThis as any).WheelEvent = originalWheelEvent;
    }
  });
  test('invalidates normal scroll when a foreign contact starts and ends without a local move', () => {
    resetState();
    render();
    const term = terminals.at(-1)!;
    const scrolled: number[] = [];
    Object.assign(term, { modes: { mouseTrackingMode: 'none' }, scrollLines: (lines: number) => scrolled.push(lines), element: {
      querySelector: () => ({ getBoundingClientRect: () => ({ height: 240 }) }),
    } });
    const a = { identifier: 1, clientX: 0, clientY: 0, target: 'own-pane' };
    const other = { identifier: 2, clientX: 100, clientY: 0, target: 'other-pane' };
    const fire = (type: string, touches: unknown[], changedTouches: unknown[]) => touchListeners.get(type)!({ type, touches, changedTouches, cancelable: true, preventDefault() {} });
    fire('touchstart', [a], [a]);
    for (const listener of documentTouchListeners) listener({ touches: [a, other], changedTouches: [other] });
    fire('touchmove', [{ ...a, clientY: 30 }], [{ ...a, clientY: 30 }]);
    expect(scrolled).toEqual([]);
    fire('touchend', [], [a]);
    fire('touchstart', [a], [a]);
    fire('touchmove', [{ ...a, clientY: 30 }], [{ ...a, clientY: 30 }]);
    // 출처: #39399 한 손가락 스크롤 복구 계약은 최소 한 번의 스크롤을 요구한다.
    expect(scrolled.length).toBeGreaterThan(0);
    harness.unmount();
    expect(documentTouchListeners.size).toBe(0);
  });
  test('ignores touches on another pane and recovers after cancel', () => {
    resetState();
    const changes: number[] = [];
    harness.render(() => XtermView({ sessionId: 's1', terminalId: 't1', onFontSizeChange: (size) => changes.push(size) }));
    const a = { identifier: 1, clientX: 0, clientY: 0 };
    const b = { identifier: 2, clientX: 100, clientY: 0 };
    const other = { identifier: 3, clientX: 200, clientY: 0 };
    const fire = (name: string, touches: unknown[], changedTouches: unknown[]) => touchListeners.get(name)!({ type: name, touches, changedTouches, cancelable: true, preventDefault() {} });
    fire('touchstart', [a], [a]);
    fire('touchmove', [a, other], [a]);
    expect(changes).toEqual([]);
    fire('touchcancel', [other], [a]);
    fire('touchstart', [a, other], [a]);
    fire('touchstart', [a, b, other], [b]);
    fire('touchmove', [a, { ...b, clientX: 150 }, other], [b]);
    expect(changes).toEqual([14]);
    harness.unmount();
  });
  test('claims two-finger movement before the threshold and notifies once per gesture', () => {
    resetState();
    const changes: number[] = [];
    harness.render(() => XtermView({ sessionId: 's1', terminalId: 't1', onFontSizeChange: (size) => changes.push(size) }));
    const points = (distance: number) => [{ clientX: 0, clientY: 0 }, { clientX: distance, clientY: 0 }];
    touchListeners.get('touchstart')!({ touches: points(100) });
    let prevented = 0;
    const move = (distance: number) => touchListeners.get('touchmove')!({ touches: points(distance), cancelable: true, preventDefault: () => { prevented++; } });
    move(103);
    move(120);
    move(150);
    expect(prevented).toBe(3);
    expect(changes).toEqual([14]);
    const third = [...points(150), { clientX: 0, clientY: 1 }];
    touchListeners.get('touchstart')!({ touches: third });
    touchListeners.get('touchend')!({ touches: points(100) });
    move(150);
    touchListeners.get('touchstart')!({ touches: third });
    touchListeners.get('touchend')!({ touches: points(100) });
    move(150);
    expect(changes).toEqual([14]);
    touchListeners.get('touchend')!({ touches: [] });
    touchListeners.get('touchstart')!({ touches: points(100) });
    move(150);
    expect(changes).toEqual([14, 15]);
    harness.unmount();
    expect(touchListeners.has('touchmove')).toBe(false);
  });

  test('font size buttons change and persist the client font without terminal input', () => {
    resetState();
    const changes: number[] = [];
    harness.render(() => XtermView({ sessionId: 's1', terminalId: 't1', onFontSizeChange: (size) => changes.push(size) }));
    const plus = harness.find((element) => element.props['aria-label'] === '터미널 글자 크게');
    const minus = harness.find((element) => element.props['aria-label'] === '터미널 글자 작게');
    let prevented = 0;
    for (const button of [plus, minus]) (button.props.onMouseDown as (event: { preventDefault(): void }) => void)({ preventDefault: () => { prevented++; } });
    expect(prevented).toBe(2);
    const zoomClass = harness.find((element) => element.props['data-zoom-controls'] === true).props.className as string;
    expect(zoomClass).not.toContain('absolute');
    expect(zoomClass).toContain('self-start');
    (plus.props.onClick as (event: { detail: number }) => void)({ detail: 1 });
    (minus.props.onClick as (event: { detail: number }) => void)({ detail: 0 });
    expect(terminals[0]?.focusCount).toBe(1);
    expect(changes).toEqual([14, 13]);
    expect(storage.get('elanous.pwa.termFontSize')).toBe('13');
    expect(sends).toEqual([]);
    harness.unmount();
  });

  test('ctrl-wheel zooms while ordinary wheel is not intercepted', () => {
    resetState();
    const changes: number[] = [];
    harness.render(() => XtermView({ sessionId: 's1', terminalId: 't1', onFontSizeChange: (size) => changes.push(size) }));
    let prevented = 0;
    let stopped = 0;
    const wheel = (ctrlKey: boolean, deltaY: number) => touchListeners.get('wheel')!({ ctrlKey, deltaY, preventDefault: () => { prevented++; }, stopPropagation: () => { stopped++; } });
    wheel(false, -1);
    expect(changes).toEqual([]);
    expect(prevented).toBe(0);
    wheel(true, -100);
    now = 149;
    wheel(true, 1);
    expect(changes).toEqual([14]);
    now = 150;
    wheel(true, 100);
    now = 300;
    touchListeners.get('wheel')!({ ctrlKey: false, metaKey: true, deltaY: -1, preventDefault: () => { prevented++; }, stopPropagation: () => { stopped++; } });
    expect(changes).toEqual([14, 13, 14]);
    expect(prevented).toBe(4);
    expect(stopped).toBe(4);
    harness.unmount();
    expect(touchListeners.has('wheel')).toBe(false);
  });
});

describe("OP119481 pinch shared font race", () => {
  test('a new controlled pinch cannot publish a stale size before its parent updates', () => {
    resetState();
    publishTermFontSize(18);
    try {
      harness.render(() => XtermView({ sessionId: 's1', terminalId: 'controlled', sharedFontSize: 18, onFontSizeChange: publishTermFontSize }));
      publishTermFontSize(21);
      const points = (distance: number) => [{ clientX: 0, clientY: 0 }, { clientX: distance, clientY: 0 }];
      touchListeners.get('touchstart')!({ touches: points(100) });
      touchListeners.get('touchmove')!({ touches: points(150), cancelable: true, preventDefault() {} });
      expect(storage.get('elanous.pwa.termFontSize')).toBe('22');
    } finally { harness.unmount(); }
  });
  test("a pinch started before another view changes size must not restore the stale starting size", () => {
    resetState();
    publishTermFontSize(13);
    const second = createReactHookHarness(react);
    try {
      harness.render(() => XtermView({ sessionId: "s1", terminalId: "first" }));
      const first = terminals[0]!;
      const start = touchListeners.get("touchstart")!;
      const move = touchListeners.get("touchmove")!;
      const points = (distance: number) => [{ clientX: 0, clientY: 0 }, { clientX: distance, clientY: 0 }];
      start({ touches: points(100) });
      second.render(() => XtermView({ sessionId: "s1", terminalId: "second" }));
      const plus = second.find((item) => item.props["aria-label"] === "터미널 글자 크게");
      for (let i = 0; i < 7; i++) (plus.props.onClick as (event: { detail: number }) => void)({ detail: 0 });
      expect(first.options.fontSize).toBe(20);
      expect(terminals[1]?.options.fontSize).toBe(20);
      expect(storage.get("elanous.pwa.termFontSize")).toBe("20");
      move({ touches: points(150), cancelable: true, preventDefault() {} });
      expect(first.options.fontSize).toBe(20);
      expect(terminals[1]?.options.fontSize).toBe(20);
      expect(storage.get("elanous.pwa.termFontSize")).toBe("20");
    } finally { second.unmount(); harness.unmount(); }
  });
});

describe('XtermView shared font size', () => {
  test('new stale controlled view cannot overwrite existing views or storage', () => {
    resetState();
    const second = createReactHookHarness(react);
    try {
      harness.render(() => XtermView({ sessionId: 's1', terminalId: 'first' }));
      publishTermFontSize(21);
      expect(terminals[0]?.options.fontSize).toBe(21);
      expect(storage.get('elanous.pwa.termFontSize')).toBe('21');
      second.render(() => XtermView({ sessionId: 's1', terminalId: 'second', sharedFontSize: 18, onFontSizeChange: () => {} }));
      expect(terminals[1]?.options.fontSize).toBe(18); // controlled parent wins locally
      expect(terminals[0]?.options.fontSize).toBe(21);
      expect(storage.get('elanous.pwa.termFontSize')).toBe('21');
    } finally { second.unmount(); harness.unmount(); }
  });

  test('prop without callback follows later shared publications', () => {
    resetState();
    try {
      harness.render(() => XtermView({ sessionId: 's1', terminalId: 't1', sharedFontSize: 18 }));
      expect(terminals[0]?.options.fontSize).toBe(18);
      publishTermFontSize(21);
      expect(terminals[0]?.options.fontSize).toBe(21);
    } finally { harness.unmount(); }
  });
  test('recreation does not republish an unchanged stale prop over another screen', () => {
    resetState();
    const observed: number[] = [];
    const unsubscribe = subscribeTermFontSize((size) => observed.push(size));
    let readOnly = false;
    const draw = () => harness.render(() => XtermView({ sessionId: 's1', terminalId: 't1', sharedFontSize: 18, onFontSizeChange: () => {}, readOnly }));
    try {
      draw();
      publishTermFontSize(21);
      readOnly = true;
      draw();
      expect(terminals.at(-1)?.options.fontSize).toBe(18);
      expect(observed.at(-1)).toBe(21);
      expect(storage.get('elanous.pwa.termFontSize')).toBe('21');
    } finally { harness.unmount(); unsubscribe(); }
  });
  test('controlled requests wait for the parent before changing terminal or storage', () => {
    resetState();
    const requests: number[] = [];
    let shared = 18;
    const draw = () => harness.render(() => XtermView({ sessionId: 's1', terminalId: 't1', sharedFontSize: shared, onFontSizeChange: (size) => requests.push(size) }));
    try {
      draw();
      const before = storage.get('elanous.pwa.termFontSize');
      const click = () => (harness.find((item) => item.props['aria-label'] === '터미널 글자 크게').props.onClick as (event: { detail: number }) => void)({ detail: 0 });
      click();
      expect(requests).toEqual([19]);
      expect(terminals[0]?.options.fontSize).toBe(18);
      expect(storage.get('elanous.pwa.termFontSize')).toBe(before);
      draw(); // parent rejected the request
      expect(terminals[0]?.options.fontSize).toBe(18);
      shared = 19;
      draw(); // parent accepts it later
      expect(terminals[0]?.options.fontSize).toBe(19);
      expect(storage.get('elanous.pwa.termFontSize')).toBe('19');
    } finally { harness.unmount(); }
  });
  test('standalone follows published sizes, controlled size wins, and unmount unsubscribes', () => {
    resetState();
    let shared: number | null = null;
    const draw = () => harness.render(() => XtermView({ sessionId: 's1', terminalId: 't1', sharedFontSize: shared, onFontSizeChange: () => {} }));
    try {
      draw();
      const term = terminals[0]!;
      expect(term.options.fontSize).toBe(13);
      // Compact mode and the shared font subscription each listen for storage changes.
      expect(windowListeners.get('storage')?.size).toBe(2);
      publishTermFontSize(19);
      expect(term.options.fontSize).toBe(19);
      shared = 22;
      draw();
      expect(term.options.fontSize).toBe(22);
      publishTermFontSize(16);
      expect(term.options.fontSize).toBe(22);
      shared = null;
      draw();
      expect(term.options.fontSize).toBe(16);
      harness.unmount();
      expect(windowListeners.get('storage')?.size ?? 0).toBe(0);
      publishTermFontSize(20);
      expect(term.options.fontSize).toBe(16);
    } finally { harness.unmount(); }
  });
  test('uncontrolled callback notifies and publishes to other subscribers', () => {
    resetState();
    const observed: number[] = [];
    const changes: number[] = [];
    const unsubscribe = subscribeTermFontSize((size) => observed.push(size));
    try {
      harness.render(() => XtermView({ sessionId: 's1', terminalId: 't1', onFontSizeChange: (size) => changes.push(size) }));
      (harness.find((item) => item.props['aria-label'] === '터미널 글자 크게').props.onClick as (event: { detail: number }) => void)({ detail: 0 });
      expect(terminals[0]?.options.fontSize).toBe(14);
      expect(changes).toEqual([14]);
      expect(observed).toEqual([13, 14]);
      expect(storage.get('elanous.pwa.termFontSize')).toBe('14');
      expect(sends).toEqual([]);
    } finally { unsubscribe(); harness.unmount(); }
  });
  test('uncontrolled publisher callback emits only once during panel initialization', () => {
    resetState();
    const observed: number[] = [];
    const unsubscribe = subscribeTermFontSize((size) => observed.push(size));
    try {
      harness.render(() => XtermView({ sessionId: 's1', terminalId: 't1', sharedFontSize: null, onFontSizeChange: publishTermFontSize }));
      (harness.find((item) => item.props['aria-label'] === '터미널 글자 크게').props.onClick as (event: { detail: number }) => void)({ detail: 0 });
      expect(observed).toEqual([13, 14]);
    } finally { unsubscribe(); harness.unmount(); }
  });
  test('publishes zoom synchronously to subscribers without a parent callback', () => {
    resetState();
    const observed: number[] = [];
    const unsubscribe = subscribeTermFontSize((size) => observed.push(size));
    try {
      render();
      expect(observed).toEqual([13]);
      (harness.find((item) => item.props['aria-label'] === '터미널 글자 크게').props.onClick as (event: { detail: number }) => void)({ detail: 0 });
      expect(terminals[0]?.options.fontSize).toBe(14);
      expect(observed).toEqual([13, 14]);
      expect(sends).toEqual([]);
    } finally {
      unsubscribe();
      harness.unmount();
    }
  });
  test('prop updates publish to independent same-document subscribers', () => {
    resetState();
    const observed: number[] = [];
    const unsubscribe = subscribeTermFontSize((size) => observed.push(size));
    let shared = 18;
    const draw = () => harness.render(() => XtermView({ sessionId: 's1', terminalId: 't1', sharedFontSize: shared, onFontSizeChange: () => {} }));
    try {
      draw();
      shared = 21;
      draw();
      expect(terminals[0]?.options.fontSize).toBe(21);
      expect(observed.at(-1)).toBe(21);
    } finally { harness.unmount(); unsubscribe(); }
  });
  test('prop without callback retains local zoom behavior', () => {
    resetState();
    try {
      harness.render(() => XtermView({ sessionId: 's1', terminalId: 't1', sharedFontSize: 18 }));
      (harness.find((item) => item.props['aria-label'] === '터미널 글자 크게').props.onClick as (event: { detail: number }) => void)({ detail: 0 });
      expect(terminals[0]?.options.fontSize).toBe(19);
    } finally { harness.unmount(); }
  });
  test('blocked storage preserves uncontrolled zoom on terminal recreation', () => {
    resetState();
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
    try {
      render('t1', 0, false);
      (harness.find((item) => item.props['aria-label'] === '터미널 글자 크게').props.onClick as (event: { detail: number }) => void)({ detail: 0 });
      expect(terminals.at(-1)?.options.fontSize).toBe(14);
      render('t1', 0, true);
      expect(terminals.at(-1)?.options.fontSize).toBe(14);
    } finally {
      harness.unmount();
      Object.defineProperty(window, 'localStorage', descriptor);
    }
  });
  test('preserves the shared size when read-only changes recreate the terminal', () => {
    resetState();
    harness.render(() => XtermView({ sessionId: 's1', terminalId: 't1', sharedFontSize: 18, readOnly: false }));
    expect(terminals.at(-1)?.options.fontSize).toBe(18);
    storage.set('elanous.pwa.termFontSize', '14'); // another screen changed its saved size
    harness.render(() => XtermView({ sessionId: 's1', terminalId: 't1', sharedFontSize: 18, readOnly: true }));
    expect(terminals.at(-1)?.options.fontSize).toBe(18);
    harness.unmount();
  });
});

describe('XtermView font zoom resize isolation', () => {
  test('recomputes the local grid and sends standard resize without PTY input on font zoom', async () => {
    resetState();
    // Clear the shared in-memory fallback left by the blocked-storage test.
    publishTermFontSize(13);
    const FitAddon = (require('@xterm/addon-fit') as { FitAddon: { prototype: { fit: () => void } } }).FitAddon;
    const oldFit = FitAddon.prototype.fit;
    const oldResize = Terminal.prototype.onResize;
    let resize: ((size: { cols: number; rows: number }) => void) | undefined;
    let fits = 0;
    FitAddon.prototype.fit = function () {
      fits++;
      const term = terminals.at(-1)!;
      const cols = term.options.fontSize === 14 ? 74 : 80;
      const rows = term.options.fontSize === 14 ? 22 : 24;
      if (cols !== term.cols || rows !== term.rows) {
        term.cols = cols; term.rows = rows;
        resize?.({ cols, rows });
      }
    };
    Terminal.prototype.onResize = function (callback?: (size: { cols: number; rows: number }) => void) {
      resize = callback;
      return { dispose() { resize = undefined; } };
    };
    try {
      render('terminal-a');
      await harness.settle(); // Exclude the legitimate attach size sync.
      sends = [];
      const beforeFits = fits;
      (harness.find((item) => item.props['aria-label'] === '터미널 글자 크게').props.onClick as (event: { detail: number }) => void)({ detail: 0 });
      await harness.settle();
      expect(fits).toBe(beforeFits + 1);
      expect([terminals[0]!.cols, terminals[0]!.rows]).toEqual([74, 22]);
      expect(sends.filter((method) => method === 'terminal/resize')).toEqual(['terminal/resize']);
      expect(sends.filter((method) => method === 'terminal/input')).toEqual([]);
    } finally {
      harness.unmount();
      FitAddon.prototype.fit = oldFit;
      Terminal.prototype.onResize = oldResize;
    }
  });
});

describe('XtermView compact touch focus start', () => {
  const host = () => harness.find((item) => item.props['data-xterm-host'] === true);

  test('compact coarse pointer starts focused, exit remembers opt-out for a new mount', () => {
    resetState();
    width = COMPACT_MAX_WIDTH;
    coarse = true;
    render();
    expect(host().props['data-focus-mode']).toBe('1');
    expect(host().props.className).toContain('fixed inset-0');
    expect(harness.find((item) => item.props['aria-pressed'] === true).props['aria-label']).toBe('집중 모드 끄기');
    (harness.find((item) => typeof item.props.onClick === 'function' && item.props['aria-pressed'] === true).props.onClick as () => void)();
    expect(host().props['data-focus-mode']).toBeUndefined();
    expect(harness.find((item) => item.props['aria-pressed'] === false).props['aria-label']).toBe('집중 모드 — 터미널만 크게');
    expect(storage.get(TERM_FOCUS_DISABLED_KEY)).toBe('1');
    harness.unmount();
    render();
    expect(host().props['data-focus-mode']).toBeUndefined();
    harness.unmount();
    width = COMPACT_MAX_WIDTH + 1;
    render();
    expect(host().props['data-focus-mode']).toBeUndefined();
    harness.unmount();
  });

  test('manual focus on mouse does not change the next start until the user exits', () => {
    resetState();
    width = COMPACT_MAX_WIDTH;
    render();
    expect(host().props['data-focus-mode']).toBeUndefined();
    (harness.find((item) => typeof item.props.onClick === 'function' && item.props['aria-pressed'] === false).props.onClick as () => void)();
    expect(host().props['data-focus-mode']).toBe('1');
    expect(storage.has(TERM_FOCUS_DISABLED_KEY)).toBe(false);
    harness.unmount();
  });

  test('keyboard focus toggle reads the latest state and remembers exit', () => {
    resetState();
    width = COMPACT_MAX_WIDTH;
    coarse = true;
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const keys = new Set<(event: KeyboardEvent) => void>();
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      activeElement: null,
      querySelector: () => (harness.find((item) => item.props['data-xterm-host'] === true).props.ref as { current: unknown }).current,
      addEventListener: (name: string, listener: (event: KeyboardEvent) => void) => { if (name === 'keydown') keys.add(listener); },
      removeEventListener: (name: string, listener: (event: KeyboardEvent) => void) => { if (name === 'keydown') keys.delete(listener); },
    } });
    try {
      render();
      expect(host().props['data-focus-mode']).toBe('1');
      const event = { key: 'f', code: 'KeyF', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, preventDefault() {}, stopPropagation() {} } as KeyboardEvent;
      for (const listener of keys) listener(event);
      expect(host().props['data-focus-mode']).toBeUndefined();
      expect(storage.get(TERM_FOCUS_DISABLED_KEY)).toBe('1');
    } finally {
      harness.unmount();
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
      else delete (globalThis as { document?: unknown }).document;
    }
  });

  test('wide touch and compact mouse retain ordinary start', () => {
    resetState();
    coarse = true;
    render();
    expect(host().props['data-focus-mode']).toBeUndefined();
    harness.unmount();
    width = COMPACT_MAX_WIDTH;
    coarse = false;
    render();
    expect(host().props['data-focus-mode']).toBeUndefined();
    harness.unmount();
  });
});

describe('XtermView zoom persistence and Ctrl+B routing', () => {
  test('retains zoom through connection changes and remount without intercepting Ctrl+B', async () => {
    resetState();
    publishTermFontSize(13);
    const sent: Array<{ data: string; sessionId: string }> = [];
    sendInput = async (data, sessionId) => { sent.push({ data, sessionId }); return {}; };
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const keys = new Set<(event: KeyboardEvent) => void>();
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      activeElement: null,
      querySelector: () => (harness.find((item) => item.props['data-xterm-host'] === true).props.ref as { current: unknown }).current,
      addEventListener: (name: string, listener: (event: KeyboardEvent) => void) => { if (name === 'keydown') keys.add(listener); },
      removeEventListener: (name: string, listener: (event: KeyboardEvent) => void) => { if (name === 'keydown') keys.delete(listener); },
    } });
    try {
      render('terminal-a');
      await harness.settle();
      (harness.find((item) => item.props['aria-label'] === '터미널 글자 크게').props.onClick as (event: { detail: number }) => void)({ detail: 0 });
      expect(storage.get('elanous.pwa.termFontSize')).toBe('14');
      for (const state of ['CLOSED', 'CONNECTING', 'OPEN'] as const) {
        listeners.forEach((listener) => listener(state));
        expect(terminals.at(-1)?.options.fontSize).toBe(14);
      }
      harness.unmount();
      expect(keys.size).toBe(0);
      render('terminal-a');
      await harness.settle();
      expect(terminals.at(-1)?.options.fontSize).toBe(14);
      expect(keys.size).toBeGreaterThan(0);
      let prevented = 0;
      let stopped = 0;
      const event = { key: 'b', code: 'KeyB', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, preventDefault() { prevented++; }, stopPropagation() { stopped++; } } as KeyboardEvent;
      for (const listener of keys) listener(event);
      expect([prevented, stopped]).toEqual([0, 0]);
      expect(terminals.at(-1)?.options.fontSize).toBe(14);
      expect(onTerminalData).toBeDefined();
      onTerminalData?.('\x02');
      await harness.settle();
      expect(sent).toEqual([{ data: '\x02', sessionId: 's1' }]);
    } finally {
      harness.unmount();
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
      else delete (globalThis as { document?: unknown }).document;
    }
  });
});

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

  test('onData consumes this terminal modifier once immediately before sending and leaves other terminal armed', async () => {
    resetState();
    const sent: string[] = [];
    sendInput = async (data) => { sent.push(data); return {}; };
    render('terminal-a');
    await harness.settle();
    try {
      setStickyModifiers('terminal-a', { ctrl: true, alt: false });
      setStickyModifiers('terminal-b', { ctrl: false, alt: true });
      onTerminalData?.('c');
      onTerminalData?.('d');
      await harness.settle();
      expect(sent).toEqual(['\x03', 'd']);
      expect(takeStickyModifiers('terminal-a')).toBeNull();
      expect(takeStickyModifiers('terminal-b')).toEqual({ ctrl: false, alt: true });
      expect(logs.filter(({ event }) => event === 'webterm.modbar.sticky-applied')).toEqual([
        { event: 'webterm.modbar.sticky-applied', details: { ctrl: true, alt: false, bytes: 1 } },
      ]);
    } finally {
      setStickyModifiers('terminal-a', { ctrl: false, alt: false });
      setStickyModifiers('terminal-b', { ctrl: false, alt: false });
      harness.unmount();
    }
  });

  test('a focus report or paste does not consume the armed modifier; the next typed key does', async () => {
    resetState();
    const sent: string[] = [];
    sendInput = async (data) => { sent.push(data); return {}; };
    render('terminal-a');
    await harness.settle();
    try {
      setStickyModifiers('terminal-a', { ctrl: true, alt: false });
      onTerminalData?.('\x1b[I');
      onTerminalData?.('pasted text');
      onTerminalData?.('c');
      onTerminalData?.('c');
      await harness.settle();
      expect(sent).toEqual(['\x1b[I', 'pasted text', '\x03', 'c']);
      expect(takeStickyModifiers('terminal-a')).toBeNull();
    } finally {
      setStickyModifiers('terminal-a', { ctrl: false, alt: false });
      harness.unmount();
    }
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

describe('XtermView terminal replay and output', () => {
  test('replays the attached viewport and accepts new output only from its adopted session', async () => {
    resetState();
    spawnResponse = { status: 'attached', snapshot: 'ELANOUS_T5B_OLD' };
    let finishHandshake!: (sid: string) => void;
    acp.ready = new Promise<string>((resolve) => { finishHandshake = resolve; });
    const cleanup = mount('terminal-a');
    onAcpSession?.('daemon-session');
    finishHandshake('s1');
    await harness.settle();
    const terminal = terminals[0]!;
    expect(terminal.writes.some((data) => data.includes('ELANOUS_T5B_OLD'))).toBe(true);
    const frame = (sessionId: string, data: string) => ({ params: {
      sessionId,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `[elanous/term/terminalOutput] terminal-a\n${JSON.stringify({ terminalId: 'terminal-a', data })}\n<<elanous-term-end terminal-a>>` } },
    } });
    const sent: string[] = [];
    sendInput = async (_data, sid) => { sent.push(sid); return {}; };
    onTerminalData?.('echo ELANOUS_T5B_NEW\r');
    await harness.settle();
    expect(sent).toEqual(['daemon-session']);
    onSessionUpdate?.(frame('other-session', 'wrong'));
    onSessionUpdate?.(frame('s1', 'stale-handshake'));
    onSessionUpdate?.(frame('daemon-session', 'ELANOUS_T5B_NEW'));
    expect(onSessionUpdate).toBeDefined();
    expect(logs.filter(({ event }) => event === 'webterm.acp.session.adopted')).toEqual([{
      event: 'webterm.acp.session.adopted', details: { from: 's1', to: 'daemon-session' },
    }]);
    expect(logs.filter(({ event }) => event === 'webterm.ws.frame.in')).toHaveLength(1);
    expect(terminal.writes).not.toContain('wrong');
    expect(terminal.writes).not.toContain('stale-handshake');
    expect(terminal.writes).toContain('ELANOUS_T5B_NEW');
    cleanup();
  });

  test('uses the shared ACP ready id when its handshake completed before this view subscribed', async () => {
    resetState();
    acp.ready = Promise.resolve('actual-session');
    const cleanup = mount('terminal-a');
    await harness.settle();
    const sent: string[] = [];
    sendInput = async (_data, sid) => { sent.push(sid); return {}; };
    onTerminalData?.('echo ELANOUS_T5B_FRESH\r');
    await harness.settle();
    expect(sent).toEqual(['actual-session']);
    onSessionUpdate?.({ params: { sessionId: 'actual-session', update: {
      sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '[elanous/term/terminalOutput] terminal-a\n{"terminalId":"terminal-a","data":"ELANOUS_T5B_FRESH"}\n<<elanous-term-end terminal-a>>' },
    } } });
    expect(terminals[0]?.writes).toContain('ELANOUS_T5B_FRESH');
    cleanup();
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
    expect(textOf(closed)).toContain('ACP: 연결 끊김 · 곧 다시 붙습니다');
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
    // Warnings occupy their own row instead of covering the terminal or focus control.
    expect(alert.props.className).toContain('shrink-0');
    expect(alert.props.className).not.toContain('absolute');
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
