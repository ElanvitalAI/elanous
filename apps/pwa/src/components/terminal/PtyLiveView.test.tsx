import { afterAll, describe, expect, mock, test } from 'bun:test';
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
    constructor(opts: Record<string, unknown>) { this.options = opts; options.push(opts); }
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

describe('PtyLiveView live read/takeover', () => {
  test('starts read-only, snapshots without spawn, then sends typed text and a key after takeover', async () => {
    const { PtyLiveView } = await import('./PtyLiveView');
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
    const { PtyLiveView } = await import('./PtyLiveView');
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
    const { PtyLiveView } = await import('./PtyLiveView');
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
    const { PtyLiveView } = await import('./PtyLiveView');
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
    const { PtyLiveView } = await import('./PtyLiveView');
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
});
