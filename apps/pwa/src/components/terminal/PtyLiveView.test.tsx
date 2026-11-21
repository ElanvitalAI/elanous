import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const react = require('react');
const { create } = require('react-test-renderer') as typeof import('react-test-renderer');
const { act } = react as typeof import('react');
const inputHandlers: Array<(data: string) => void> = [];
const writes: string[] = [];
const options: Array<Record<string, unknown>> = [];
const snapshotCalls: unknown[] = [];
const textCalls: string[] = [];
const keyCalls: string[] = [];
const routed: unknown[] = [];
let finishText: (() => void) | null = null;
let holdText = false;
let spawnCalls = 0;
let focusCalls = 0;
let trackingMode = 'none';
let resizeCalls = 0;

// R-TST23 — 아래 mock.module 은 프로세스 전역이다. 원본을 잡아 두고 파일 끝에 되돌린다.
const originalXterm = require('@xterm/xterm');
const originalWebLinks = require('@xterm/addon-web-links');
const originalUnicode11 = require('@xterm/addon-unicode11');
afterAll(() => {
  mock.module('@xterm/xterm', () => originalXterm);
  mock.module('@xterm/addon-web-links', () => originalWebLinks);
  mock.module('@xterm/addon-unicode11', () => originalUnicode11);
});

mock.module('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    unicode = { activeVersion: '' };
    get modes() { return { mouseTrackingMode: trackingMode }; }
    cols = 110; rows = 40;
    element = { querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 1100, height: 400 }) }) };
    resize() { resizeCalls++; }
    constructor(opts: Record<string, unknown>) { this.options = opts; options.push(opts); }
    focus() { focusCalls++; }
    loadAddon() {}
    open() {}
    write(data: string) { writes.push(data); }
    onData(fn: (data: string) => void) { inputHandlers.push(fn); return { dispose() {} }; }
    dispose() {}
  },
}));
mock.module('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
mock.module('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
const priorActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const priorDocument = (globalThis as { document?: unknown }).document;
(globalThis as { document?: unknown }).document = {
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
};
afterAll(() => {
  if (priorActEnvironment === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = priorActEnvironment;
  if (priorDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = priorDocument;
});

const client = {
  snapshotTerminal: async (id: string, opts: unknown) => {
    snapshotCalls.push([id, opts]);
    routed.push(['snapshot', id, opts]);
    return { status: 'success' as const, screen: '\x1b[31mHello' };
  },
  controlTerminal: async (id: string, action: string, options: unknown) => { routed.push([action, id, options]); return { status: 'success' as const }; },
  sendTerminalText: async (id: string, text: string, options: unknown) => {
    textCalls.push(text);
    routed.push(['text', id, options]);
    if (holdText) await new Promise<void>((resolve) => { finishText = resolve; });
    return { status: 'success' as const };
  },
  sendTerminalKey: async (id: string, key: string, options: unknown) => { keyCalls.push(key); routed.push(['key', id, options]); return { status: 'success' as const }; },
  connectAcp: () => { spawnCalls++; throw new Error('must not connect ACP'); },
};
const terminal = { id: 'codex_a3f2c91b', kind: 'codex', alive: true, correlationId: '', instance: 'test', sessionId: '', startedAt: 1, accessMode: 'read' as const, sourceRoot: { name: 'test', dbPath: '/other/root/manifest.db' } };

let PtyLiveView: typeof import('./PtyLiveView').PtyLiveView;
beforeAll(async () => {
  ({ PtyLiveView } = await import('./PtyLiveView'));
}, 30_000);

describe('PtyLiveView live read/takeover', () => {
  test('ordinary wheel reaches the app during takeover without intercepting tracked or read-only wheels', async () => {
    const listeners = new Map<string, (event: any) => void>();
    const host = { addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) };
    let mouseCalls = 0;
    const controlled = { ...client, sendTerminalMouse: async () => { mouseCalls++; return { status: 'success' as const }; } };
    let view!: import('react-test-renderer').ReactTestRenderer;
    textCalls.length = keyCalls.length = 0; resizeCalls = 0; trackingMode = 'none';
    try {
      await act(async () => { view = create(react.createElement(PtyLiveView, { terminal, client: controlled, onClose: () => {} }), { createNodeMock: (el) => (el.props as Record<string, unknown>)['aria-label'] === `${terminal.id} 화면` ? host : null }); });
      for (const mode of ['takeover', 'tracking', 'read']) {
        if (mode === 'takeover') {
          await act(async () => view.root.findAllByType('button').find((button) => button.props.children === 'takeover')?.props.onClick());
          const before = options.at(-1)?.fontSize as number;
          await act(async () => listeners.get('wheel')!({ ctrlKey: true, metaKey: false, deltaY: -1, preventDefault() {}, stopPropagation() {} }));
          expect(options.at(-1)?.fontSize).toBe(before + 1);
          expect(options.at(-1)?.cols).toBe(110); expect(options.at(-1)?.rows).toBe(40);
        }
        if (mode === 'tracking') trackingMode = 'sgr';
        if (mode === 'read') await act(async () => view.root.findAllByType('button').find((button) => button.props.children === 'release')?.props.onClick());
        for (const [deltaX, deltaY] of [[0, 40], [30, 0], [20, -40]]) {
          let stopped = 0; let prevented = 0;
          await act(async () => listeners.get('wheel')!({ ctrlKey: false, metaKey: false, deltaX, deltaY, clientX: 10, clientY: 10, stopPropagation: () => stopped++, preventDefault: () => prevented++ }));
          expect([stopped, prevented]).toEqual(mode === 'takeover' && deltaY !== 0 ? [1, 1] : [0, 0]);
        }
      }
      expect(mouseCalls).toBe(2); expect(textCalls).toEqual([]); expect(keyCalls).toEqual([]); expect(resizeCalls).toBe(0);
    } finally { trackingMode = 'none'; if (view) await act(async () => view.unmount()); }
  });
  test('leaves ordinary wheel to xterm when the optional mouse API is absent', async () => {
    const listeners = new Map<string, (event: any) => void>();
    const host = { addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) };
    let view!: import('react-test-renderer').ReactTestRenderer;
    trackingMode = 'none';
    try {
      await act(async () => { view = create(react.createElement(PtyLiveView, { terminal, client, onClose: () => {} }), { createNodeMock: (el) => (el.props as Record<string, unknown>)['aria-label'] === `${terminal.id} 화면` ? host : null }); });
      await act(async () => view.root.findAllByType('button').find((button) => button.props.children === 'takeover')?.props.onClick());
      for (const deltaY of [-40, 40]) {
        let prevented = 0; let stopped = 0;
        await act(async () => listeners.get('wheel')!({ ctrlKey: false, metaKey: false, deltaY, clientX: 10, clientY: 10, preventDefault: () => prevented++, stopPropagation: () => stopped++ }));
        expect([prevented, stopped]).toEqual([0, 0]);
      }
    } finally { if (view) await act(async () => view.unmount()); }
  });
  test('shares the device font, zoom controls and throttles modified wheel without forwarding it', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window;
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    const values = new Map([['elanous.pwa.termFontSize', '16']]);
    const listeners = new Map<string, (event: any) => void>();
    const host = {
      addEventListener: (name: string, fn: (event: any) => void) => { listeners.set(name, fn); },
      removeEventListener: (name: string) => { listeners.delete(name); },
    };
    (globalThis as { window?: unknown }).window = {
      localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
      matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {},
    };
    options.length = 0;
    let view!: import('react-test-renderer').ReactTestRenderer;
    try {
      await act(async () => { view = create(react.createElement(PtyLiveView, { terminal, client, onClose: () => {} }), {
        createNodeMock: (element) => (element.props as Record<string, unknown>)['aria-label'] === `${terminal.id} 화면` ? host : null,
      }); });
      expect(options[0]?.fontSize).toBe(16);
      expect(options[0]?.cols).toBe(110);
      expect(options[0]?.rows).toBe(40);
      let stopped = 0;
      let panPrevented = 0;
      listeners.get('wheel')?.({ ctrlKey: false, metaKey: false, deltaX: 30, deltaY: 40, stopPropagation: () => stopped++, preventDefault: () => panPrevented++ });
      expect(stopped).toBe(0);
      expect(panPrevented).toBe(0);
      let focusPreserved = 0;
      for (const label of ['터미널 글자 크게', '터미널 글자 작게']) {
        view.root.findByProps({ 'aria-label': label }).props.onMouseDown({ preventDefault: () => { focusPreserved++; } });
      }
      expect(focusPreserved).toBe(2);
      const zoomClass = view.root.findByProps({ 'data-zoom-controls': true }).props.className as string;
      expect(zoomClass).not.toContain('absolute');
      expect(zoomClass).toContain('self-start');
      await act(async () => view.root.findByProps({ 'aria-label': '터미널 글자 크게' }).props.onClick({ detail: 0 }));
      expect(options[0]?.fontSize).toBe(17);
      expect(values.get('elanous.pwa.termFontSize')).toBe('17');
      let prevented = 0;
      let zoomStopped = 0;
      const wheel = { ctrlKey: true, metaKey: false, deltaY: -1000, preventDefault: () => prevented++, stopPropagation: () => zoomStopped++ };
      await act(async () => { listeners.get('wheel')?.(wheel); listeners.get('wheel')?.(wheel); });
      expect(options[0]?.fontSize).toBe(18);
      expect([prevented, zoomStopped]).toEqual([2, 2]);
      now += 149;
      await act(async () => listeners.get('wheel')?.(wheel));
      expect(options[0]?.fontSize).toBe(18);
      now++;
      await act(async () => listeners.get('wheel')?.({ ...wheel, ctrlKey: false, metaKey: true, deltaY: 1000 }));
      expect(options[0]?.fontSize).toBe(17);
      expect([prevented, zoomStopped]).toEqual([4, 4]);
      const { publishTermFontSize } = await import('@/lib/term-focus');
      await act(async () => publishTermFontSize(18));
      expect(options[0]?.fontSize).toBe(18);
      const points = (x: number) => [{ clientX: 0, clientY: 0 }, { clientX: x, clientY: 0 }];
      await act(async () => {
        listeners.get('touchstart')?.({ touches: points(100) });
        listeners.get('touchmove')?.({ touches: points(120), cancelable: true, preventDefault() {} });
      });
      expect(options[0]?.fontSize).toBe(19);
      const three = [...points(100), { clientX: 0, clientY: 1 }];
      await act(async () => {
        listeners.get('touchstart')?.({ touches: three });
        listeners.get('touchend')?.({ touches: points(100) });
        listeners.get('touchmove')?.({ touches: points(150), cancelable: true, preventDefault() {} });
      });
      expect(options[0]?.fontSize).toBe(19);
      await act(async () => {
        listeners.get('touchend')?.({ touches: [] });
        listeners.get('touchstart')?.({ touches: points(100) });
        listeners.get('touchmove')?.({ touches: points(150), cancelable: true, preventDefault() {} });
      });
      expect(options[0]?.fontSize).toBe(20);
      await act(async () => view.root.findAllByType('button').find((button) => button.props.children === 'takeover')?.props.onClick());
      focusCalls = 0;
      await act(async () => view.root.findByProps({ 'aria-label': '터미널 글자 크게' }).props.onClick({ detail: 1 }));
      await act(async () => view.root.findByProps({ 'aria-label': '터미널 글자 작게' }).props.onClick({ detail: 0 }));
      expect(focusCalls).toBe(1);
    } finally {
      if (view) await act(async () => view.unmount());
      Date.now = originalNow;
      if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = previousWindow;
    }
  });
  test('starts read-only, snapshots without spawn, then sends typed text and a key after takeover', async () => {
    snapshotCalls.length = textCalls.length = keyCalls.length = writes.length = inputHandlers.length = options.length = routed.length = 0;
    holdText = false;
    let view!: import('react-test-renderer').ReactTestRenderer;
    await act(async () => {
      view = create(react.createElement(PtyLiveView, { terminal, client, onClose: () => {} }), {
        createNodeMock: (element) => (element.props as Record<string, unknown>)['aria-label'] === `${terminal.id} 화면` ? {} : null,
      });
    });
    expect(options[0]?.disableStdin).toBe(true);
    // Unicode11Addon 을 싣는 한 제안 API 를 켜야 한다(없으면 실제 xterm 이 첫 렌더에서 던진다 · 가짜 xterm 은 못 잡는다).
    expect(options[0]?.allowProposedApi).toBe(true);
    expect(snapshotCalls).toContainEqual([terminal.id, { ansi: true, sourceRoot: terminal.sourceRoot.dbPath }]);
    expect(writes.some((s) => s.includes('\x1b[H\x1b[2J\x1b[31mHello'))).toBe(true);
    expect(spawnCalls).toBe(0);
    expect(textCalls).toHaveLength(0);
    const takeover = view.root.findAllByType('button').find((button) => button.props.children === 'takeover');
    await act(async () => { takeover?.props.onClick(); });
    expect(options[0]?.disableStdin).toBe(false);
    await act(async () => { inputHandlers[0]?.('a'); inputHandlers[0]?.('\r'); });
    expect(textCalls).toEqual(['a']);
    expect(keyCalls).toEqual(['\r']);
    expect(routed).toEqual([
      ['snapshot', terminal.id, { ansi: true, sourceRoot: terminal.sourceRoot.dbPath }],
      ['takeover', terminal.id, { sourceRoot: terminal.sourceRoot.dbPath }],
      ['text', terminal.id, { sourceRoot: terminal.sourceRoot.dbPath }],
      ['key', terminal.id, { sourceRoot: terminal.sourceRoot.dbPath }],
    ]);
    expect(spawnCalls).toBe(0);
    const release = view.root.findAllByType('button').find((button) => button.props.children === 'release');
    await act(async () => { release?.props.onClick(); });
    expect(options[0]?.disableStdin).toBe(true);
    expect(routed.at(-1)).toEqual(['release', terminal.id, { sourceRoot: terminal.sourceRoot.dbPath }]);
    inputHandlers[0]?.('b');
    expect(textCalls).toEqual(['a']);
    await act(async () => view.unmount());
  });

  test('blocks new input during release and restores writing if release is denied', async () => {
    routed.length = inputHandlers.length = textCalls.length = 0;
    let finish: (() => void) | undefined;
    let failRelease = true;
    const controlled = {
      ...client,
      sendTerminalText: async (id: string, text: string, source: unknown) => {
        textCalls.push(text);
        routed.push(['text', id, source]);
        await new Promise<void>((resolve) => { finish = resolve; });
        return { status: 'success' as const };
      },
      controlTerminal: async (id: string, action: string, source: unknown) => {
        routed.push([action, id, source]);
        return action === 'release' && failRelease
          ? { status: 'denied' as const, reason: 'busy owner' }
          : { status: 'success' as const };
      },
    };
    let view!: import('react-test-renderer').ReactTestRenderer;
    await act(async () => {
      view = create(react.createElement(PtyLiveView, { terminal, client: controlled, onClose: () => {} }), {
        createNodeMock: (element) => (element.props as Record<string, unknown>)['aria-label'] === `${terminal.id} 화면` ? {} : null,
      });
    });
    await act(async () => view.root.findAllByType('button').find((button) => button.props.children === 'takeover')?.props.onClick());
    await act(async () => { inputHandlers[0]?.('a'); });
    await act(async () => view.root.findAllByType('button').find((button) => button.props.children === 'release')?.props.onClick());
    inputHandlers[0]?.('b');
    expect(textCalls).toEqual(['a']);
    expect(routed.map((entry) => (entry as string[])[0])).toEqual(['snapshot', 'takeover', 'text']);
    await act(async () => { finish?.(); await Promise.resolve(); });
    expect(routed.map((entry) => (entry as string[])[0])).toEqual(['snapshot', 'takeover', 'text', 'release']);
    expect(options.at(-1)?.disableStdin).toBe(false);
    expect(view.root.findAllByProps({ role: 'status' })[0]?.props.children).toBe('busy owner');
    await act(async () => { inputHandlers[0]?.('c'); });
    expect(textCalls).toEqual(['a', 'c']);
    await act(async () => { finish?.(); await Promise.resolve(); });
    failRelease = false;
    await act(async () => view.unmount());
    expect(routed.at(-1)).toEqual(['release', terminal.id, { sourceRoot: terminal.sourceRoot.dbPath }]);
  });

  test('unmount waits for pending input and releases ownership through its source root', async () => {
    routed.length = inputHandlers.length = 0;
    let finish: (() => void) | undefined;
    const controlled = {
      ...client,
      sendTerminalText: async (id: string, text: string, source: unknown) => {
        routed.push(['text', id, source]);
        await new Promise<void>((resolve) => { finish = resolve; });
        return { status: 'success' as const };
      },
    };
    let view!: import('react-test-renderer').ReactTestRenderer;
    await act(async () => {
      view = create(react.createElement(PtyLiveView, { terminal, client: controlled, onClose: () => {} }), {
        createNodeMock: (element) => (element.props as Record<string, unknown>)['aria-label'] === `${terminal.id} 화면` ? {} : null,
      });
    });
    await act(async () => view.root.findAllByType('button').find((button) => button.props.children === 'takeover')?.props.onClick());
    await act(async () => { inputHandlers[0]?.('a'); });
    await act(async () => view.unmount());
    inputHandlers[0]?.('b');
    expect(routed.map((entry) => (entry as string[])[0])).toEqual(['snapshot', 'takeover', 'text']);
    await act(async () => { finish?.(); await Promise.resolve(); await Promise.resolve(); });
    expect(routed.map((entry) => (entry as string[])[0])).toEqual(['snapshot', 'takeover', 'text', 'release']);
    expect(routed.at(-1)).toEqual(['release', terminal.id, { sourceRoot: terminal.sourceRoot.dbPath }]);
  });

  test('unmount during pending takeover releases only after takeover succeeds', async () => {
    routed.length = inputHandlers.length = 0;
    let finish: (() => void) | undefined;
    const controlled = {
      ...client,
      controlTerminal: async (id: string, action: string, source: unknown) => {
        routed.push([action, id, source]);
        if (action === 'takeover') await new Promise<void>((resolve) => { finish = resolve; });
        return { status: 'success' as const };
      },
    };
    let view!: import('react-test-renderer').ReactTestRenderer;
    await act(async () => {
      view = create(react.createElement(PtyLiveView, { terminal, client: controlled, onClose: () => {} }), {
        createNodeMock: (element) => (element.props as Record<string, unknown>)['aria-label'] === `${terminal.id} 화면` ? {} : null,
      });
    });
    await act(async () => view.root.findAllByType('button').find((button) => button.props.children === 'takeover')?.props.onClick());
    await act(async () => view.unmount());
    expect(routed.map((entry) => (entry as string[])[0])).toEqual(['snapshot', 'takeover']);
    await act(async () => { finish?.(); await Promise.resolve(); await Promise.resolve(); });
    expect(routed.at(-1)).toEqual(['release', terminal.id, { sourceRoot: terminal.sourceRoot.dbPath }]);
  });

  test('waits for text processing before sending Enter and release', async () => {
    routed.length = inputHandlers.length = 0;
    holdText = true;
    let view!: import('react-test-renderer').ReactTestRenderer;
    await act(async () => {
      view = create(react.createElement(PtyLiveView, { terminal, client, onClose: () => {} }), {
        createNodeMock: (element) => (element.props as Record<string, unknown>)['aria-label'] === `${terminal.id} 화면` ? {} : null,
      });
    });
    await act(async () => view.root.findAllByType('button').find((button) => button.props.children === 'takeover')?.props.onClick());
    await act(async () => { inputHandlers[0]?.('a'); inputHandlers[0]?.('\r'); });
    expect(routed.map((entry) => (entry as string[])[0])).toEqual(['snapshot', 'takeover', 'text']);
    expect(finishText).not.toBeNull();
    await act(async () => { finishText?.(); await Promise.resolve(); });
    expect(routed.map((entry) => (entry as string[])[0])).toEqual(['snapshot', 'takeover', 'text', 'key']);
    await act(async () => view.root.findAllByType('button').find((button) => button.props.children === 'release')?.props.onClick());
    expect(routed.at(-1)).toEqual(['release', terminal.id, { sourceRoot: terminal.sourceRoot.dbPath }]);
    holdText = false;
    finishText = null;
    await act(async () => view.unmount());
  });
  test('suppresses browser defaults for excess and remaining pinch contacts until all lift', async () => {
    const listeners = new Map<string, (event: any) => void>();
    const host = { addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) };
    let view!: import('react-test-renderer').ReactTestRenderer;
    resizeCalls = 0; textCalls.length = 0; keyCalls.length = 0;
    try {
      await act(async () => { view = create(react.createElement(PtyLiveView, { terminal, client, onClose: () => {} }), { createNodeMock: (el) => (el.props as Record<string, unknown>)['aria-label'] === `${terminal.id} 화면` ? host : null }); });
      const a = { identifier: 1, clientX: 0, clientY: 0 };
      const b = { identifier: 2, clientX: 100, clientY: 0 };
      const c = { identifier: 3, clientX: 200, clientY: 0 };
      const fire = (type: string, touches: unknown[], changedTouches: unknown[], cancelable = true) => {
        let prevented = 0;
        listeners.get(type)!({ type, touches, changedTouches, cancelable, preventDefault() { prevented++; } });
        return prevented;
      };
      fire('touchstart', [a], [a]);
      expect(fire('touchmove', [a], [a])).toBe(0);
      fire('touchstart', [a, b], [b]);
      expect(fire('touchmove', [a, b], [b])).toBe(1);
      fire('touchstart', [a, b, c], [c]);
      expect(fire('touchmove', [a, b, c], [c])).toBe(1);
      fire('touchend', [a, b], [c]);
      expect(fire('touchmove', [a, b], [b])).toBe(1);
      fire('touchend', [a], [b]);
      expect(fire('touchmove', [a], [a])).toBe(1);
      expect(fire('touchmove', [a], [a], false)).toBe(0);
      fire('touchend', [], [a]);
      fire('touchstart', [a], [a]);
      expect(fire('touchmove', [a], [a])).toBe(0);
      fire('touchstart', [a, b], [b]);
      fire('touchcancel', [a], [b]);
      expect(fire('touchmove', [a], [a])).toBe(1);
      fire('touchend', [], [a]);
      fire('touchstart', [a], [a]);
      expect(fire('touchmove', [a], [a])).toBe(0);
      expect(options.at(-1)?.cols).toBe(110); expect(options.at(-1)?.rows).toBe(40);
      expect(resizeCalls).toBe(0); expect(textCalls).toEqual([]); expect(keyCalls).toEqual([]);
    } finally { if (view) await act(async () => view.unmount()); }
  });
  test('blocks a replacement finger after pinch until all pane contacts lift', async () => {
    const listeners = new Map<string, (event: any) => void>();
    const host = { addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) };
    let view!: import('react-test-renderer').ReactTestRenderer;
    try {
      await act(async () => { view = create(react.createElement(PtyLiveView, { terminal, client, onClose: () => {} }), { createNodeMock: (el) => (el.props as Record<string, unknown>)['aria-label'] === `${terminal.id} 화면` ? host : null }); });
      const a = { identifier: 1, clientX: 0, clientY: 0 };
      const b = { identifier: 2, clientX: 100, clientY: 0 };
      const c = { identifier: 3, clientX: 100, clientY: 0 };
      const fire = (type: string, touches: unknown[], changedTouches: unknown[]) => listeners.get(type)!({ type, touches, changedTouches, cancelable: true, preventDefault() {} });
      const initial = options.at(-1)!.fontSize as number;
      fire('touchstart', [a], [a]); fire('touchstart', [a, b], [b]);
      fire('touchmove', [a, { ...b, clientX: 150 }], [b]);
      expect(options.at(-1)?.fontSize).toBe(initial + 1);
      fire('touchend', [a], [b]);
      fire('touchstart', [a, c], [c]);
      fire('touchmove', [a, { ...c, clientX: 150 }], [c]);
      expect(options.at(-1)?.fontSize).toBe(initial + 1);
      fire('touchend', [a], [c]); fire('touchend', [], [a]);
      fire('touchstart', [a], [a]); fire('touchstart', [a, c], [c]);
      fire('touchmove', [a, { ...c, clientX: 150 }], [c]);
      expect(options.at(-1)?.fontSize).toBe(initial + 2);
    } finally { if (view) await act(async () => view.unmount()); }
  });
  test('isolates pane contacts and recovers after cancellation without sending input', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window;
    const listeners = new Map<string, (event: any) => void>();
    const host = { addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) };
    const values = new Map<string, string>();
    (globalThis as { window?: unknown }).window = { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} };
    options.length = 0; textCalls.length = 0; keyCalls.length = 0;
    let view!: import('react-test-renderer').ReactTestRenderer;
    try {
      await act(async () => { view = create(react.createElement(PtyLiveView, { terminal, client, onClose: () => {} }), { createNodeMock: (el) => (el.props as Record<string, unknown>)['aria-label'] === `${terminal.id} 화면` ? host : null }); });
      await act(async () => view.root.findAllByType('button').find((button) => button.props.children === 'takeover')?.props.onClick());
      const a = { identifier: 1, clientX: 0, clientY: 0 };
      const b = { identifier: 2, clientX: 100, clientY: 0 };
      const other = { identifier: 3, clientX: 200, clientY: 0 };
      let prevented = 0;
      const fire = (type: string, touches: unknown[], changedTouches: unknown[]) => listeners.get(type)!({ type, touches, changedTouches, cancelable: true, preventDefault() { prevented++; } });
      fire('touchstart', [a], [a]);
      fire('touchmove', [a, other], [a]);
      expect(options[0]?.fontSize).toBe(13);
      expect(prevented).toBe(0);
      fire('touchcancel', [other], [a]);
      fire('touchstart', [a, other], [a]);
      fire('touchstart', [a, b, other], [b]);
      fire('touchmove', [a, { ...b, clientX: 150 }, other], [b]);
      expect(options[0]?.fontSize).toBe(14);
      expect(prevented).toBe(1);
      expect(textCalls).toEqual([]);
      expect(keyCalls).toEqual([]);
    } finally {
      if (view) await act(async () => view.unmount());
      if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = previousWindow;
    }
  });

});
