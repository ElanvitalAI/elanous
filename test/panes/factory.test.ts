// PaneFactory resolver and cache behavior without the retired PaneContent adapter.

import { describe, expect, test } from 'bun:test';

import {
  PaneFactory,
  PlaceholderPane,
  TerminalPane,
  ExternalTerminalPane,
  WidgetPane,
  type PaneRef,
} from '../../src/panes/index.js';
import type { PreviewTerminal } from '../../src/preview/terminal.js';
import type { ShellHandle } from '../../src/shell-runner/types.js';
import type { TerminalInstance } from '../../src/terminal-matrix/types.js';
import type { Widget, WidgetInstance } from '../../src/widgets/types.js';

// ── Fakes ──────────────────────────────────────────────────────

function makeFakePreview(): PreviewTerminal {
  return {
    start: () => {}, stop: () => {}, write: () => {}, resize: () => {},
    render: () => 'x', cursorPosition: () => ({ row: 0, col: 0 }),
    addRawOutputTap: () => () => {},
    get isAlive() { return true; },
    get cols() { return 80; }, get rows() { return 24; }, get pid() { return 1; },
  } as unknown as PreviewTerminal;
}

function makeFakeTerminal(id: string): TerminalInstance {
  return {
    id,
    title: `t-${id}`,
    character: { kind: 'shell' },
    transport: { kind: 'local' },
    pty: makeFakePreview(),
    placement: { kind: 'modal', modalId: 'x' },
    readOnly: false,
    visibility: 'both',
    broadcastGroups: new Set(),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    exitCode: null,
    attentionLevel: 0,
    metadata: {},
  } as unknown as TerminalInstance;
}

function makeFakeHandle(id: string): ShellHandle {
  return {
    id,
    terminalId: 'x',
    mode: 'vw',
    get status() { return 'running' as const; },
    bookmark: { row: 0, col: 0, ts: 0, bytes: 0 },
    kill: () => {}, background: () => false, promote: () => false,
    write: () => {}, resize: () => {},
    onChunk: () => () => {}, onBoundary: () => () => {}, onStatus: () => () => {},
    result: new Promise(() => {}),
  } as unknown as ShellHandle;
}

function makeFakeWidget(): { instance: WidgetInstance; def: Widget } {
  return {
    instance: { id: 'w1', type: 'x', character: 'F', state: {} },
    def: {
      type: 'x',
      description: 'x',
      initialState: () => ({}),
      render: () => [''],
    } as unknown as Widget,
  };
}

function makeRef(id: string): PaneRef {
  return { windowId: 'w', paneId: id };
}

// ── PaneFactory ────────────────────────────────────────────────

describe('W1 · PaneFactory resolve paths', () => {
  test('resolveFromTerminal returns TerminalPane', () => {
    const f = new PaneFactory();
    const pane = f.resolveFromTerminal(makeRef('t1'), makeFakeTerminal('term:1'));
    expect(pane).toBeInstanceOf(TerminalPane);
  });

  test('resolveFromHandle returns ExternalTerminalPane', () => {
    const f = new PaneFactory();
    const pane = f.resolveFromHandle(makeRef('e1'), makeFakeHandle('sh:1'));
    expect(pane).toBeInstanceOf(ExternalTerminalPane);
  });

  test('resolveFromWidget returns WidgetPane', () => {
    const f = new PaneFactory();
    const fw = makeFakeWidget();
    const pane = f.resolveFromWidget(makeRef('w1'), fw.instance, fw.def);
    expect(pane).toBeInstanceOf(WidgetPane);
  });

  test('resolvePlaceholder returns PlaceholderPane', () => {
    const f = new PaneFactory();
    const pane = f.resolvePlaceholder(makeRef('p1'), 'loading');
    expect(pane).toBeInstanceOf(PlaceholderPane);
  });
});

describe('W1 · PaneFactory cache', () => {
  test('cache size tracks unique refs', () => {
    const f = new PaneFactory();
    f.resolveFromTerminal(makeRef('a'), makeFakeTerminal('term:a'));
    f.resolveFromTerminal(makeRef('b'), makeFakeTerminal('term:b'));
    expect(f.cacheSize).toBe(2);
  });

  test('peek returns cached pane without creating', () => {
    const f = new PaneFactory();
    const ref = makeRef('peeky');
    expect(f.peek(ref)).toBeUndefined();
    const pane = f.resolveFromTerminal(ref, makeFakeTerminal('term:peek'));
    expect(f.peek(ref)).toBe(pane);
  });

  test('invalidate drops the cached pane', () => {
    const f = new PaneFactory();
    const ref = makeRef('gone');
    f.resolveFromTerminal(ref, makeFakeTerminal('term:peek'));
    expect(f.peek(ref)).toBeDefined();
    f.invalidate(ref);
    expect(f.peek(ref)).toBeUndefined();
  });

  test('reset clears the whole cache', () => {
    const f = new PaneFactory();
    f.resolveFromTerminal(makeRef('a'), makeFakeTerminal('term:a'));
    f.resolveFromTerminal(makeRef('b'), makeFakeTerminal('term:b'));
    f.reset();
    expect(f.cacheSize).toBe(0);
  });
});
