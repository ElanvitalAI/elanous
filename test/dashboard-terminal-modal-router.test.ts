import { describe, expect, test } from 'bun:test';

import { createTerminalModalRouter, terminalModalRouter } from '../src/terminal/terminal-modal-router.js';
import { terminalModalRouter as dashboardTerminalModalRouter } from '../src/dashboard/input/terminal-modal-router.js';
import type { InteractiveTerminalModalHandle } from '../src/interactive-terminal-modal.js';
import type { KeyEvent } from '../src/display/types.js';

function fakeModal(): InteractiveTerminalModalHandle & {
  _disposeCount: number;
  _keyCount: number;
  _lastKey: KeyEvent | null;
} {
  let disposeCount = 0;
  let keyCount = 0;
  let lastKey: KeyEvent | null = null;
  let alive = true;
  return {
    id: 'term-modal:fake',
    surface: {
      id: 'term-modal:fake',
      owner: 'dashboard',
      kind: 'modal',
      focus: 'owns',
      priority: 500,
      bounds: { row: 1, col: 1, width: 40, height: 10 },
      render: () => [],
      paint: () => '',
      cursor: () => null,
      onKey: (ev) => {
        keyCount++;
        lastKey = ev;
        return { type: 'refresh' };
      },
    },
    preview: {} as any,
    bounds: { row: 1, col: 1, width: 40, height: 10 },
    write: () => {},
    resize: () => {},
    dispose: () => { disposeCount++; alive = false; },
    isAlive: () => alive,
    snapshot: () => '',
    get _disposeCount() { return disposeCount; },
    get _keyCount() { return keyCount; },
    get _lastKey() { return lastKey; },
  };
}

test('dashboard compatibility export resolves the shared terminal modal router', () => {
  expect(dashboardTerminalModalRouter).toBe(terminalModalRouter);
});

describe('terminal modal router', () => {
  test('passthrough when no modal', () => {
    const r = createTerminalModalRouter();
    expect(r.handleKey({ name: 'a' })).toBe('passthrough');
    expect(r.current()).toBeNull();
  });

  // Regression: ESC must NOT close the popup terminal modal. Children
  // like claude / codex use ESC to cancel an in-progress chat or tool
  // turn — closing the wrapper made the only way to cancel kill the
  // whole popup. iTerm / ghostty don't close their own windows on ESC
  // either; the wrapper should match. Modal close is reserved for
  // Ctrl+G + Ctrl+Shift+T + the child's own `exit`.
  test('ESC forwards to child instead of closing', () => {
    const r = createTerminalModalRouter();
    const m = fakeModal();
    r.set(m);
    expect(r.handleKey({ name: 'escape' })).toBe('consumed');
    expect(m._disposeCount).toBe(0);
    expect(m._keyCount).toBe(1);
    expect(m._lastKey?.name).toBe('escape');
    expect(r.current()?.id).toBe('term-modal:fake');
  });

  test('Ctrl-G closes modal', () => {
    const r = createTerminalModalRouter();
    const m = fakeModal();
    r.set(m);
    expect(r.handleKey({ name: 'g', ctrl: true })).toBe('closed');
    expect(m._disposeCount).toBe(1);
  });

  test('forwards non-close keys to modal (incl. ESC)', () => {
    const r = createTerminalModalRouter();
    const m = fakeModal();
    r.set(m);
    expect(r.handleKey({ name: 'a' })).toBe('consumed');
    expect(r.handleKey({ name: 'enter' })).toBe('consumed');
    expect(r.handleKey({ name: 'c', ctrl: true })).toBe('consumed');
    expect(r.handleKey({ name: 'escape' })).toBe('consumed');
    expect(m._keyCount).toBe(4);
    expect(m._lastKey?.name).toBe('escape');
  });

  test('forwards Ctrl-B (no prefix semantics in P6)', () => {
    const r = createTerminalModalRouter();
    const m = fakeModal();
    r.set(m);
    // P6 keeps Ctrl-B passthrough to PTY; P10 adds prefix later.
    expect(r.handleKey({ name: 'b', ctrl: true })).toBe('consumed');
    expect(m._keyCount).toBe(1);
  });

  test('set() replaces an existing modal (disposes old)', () => {
    const r = createTerminalModalRouter();
    const a = fakeModal();
    const b = { ...fakeModal(), id: 'term-modal:b' } as unknown as ReturnType<typeof fakeModal>;
    b.id = 'term-modal:b';
    b.surface.id = 'term-modal:b';
    r.set(a);
    r.set(b);
    expect(a._disposeCount).toBe(1);
    expect(r.current()?.id).toBe('term-modal:b');
  });

  test('close() is idempotent', () => {
    const r = createTerminalModalRouter();
    const m = fakeModal();
    r.set(m);
    r.close();
    r.close();
    expect(m._disposeCount).toBe(1);
  });

  test('Ctrl-G (Korean IME equivalent ㅎ) also closes', () => {
    const r = createTerminalModalRouter();
    const m = fakeModal();
    r.set(m);
    expect(r.handleKey({ name: 'ㅎ', ctrl: true })).toBe('closed');
    expect(m._disposeCount).toBe(1);
  });

  // Regression: typing `exit` + Enter at the popup terminal closes
  // it. claude / codex don't recognize a bare `exit` (their command
  // is /exit), so the user's natural mental model would otherwise
  // leave the popup wedged open. elanous intercepts the exact streak
  // at the router so plain shell + agent popups behave the same way.
  test('typed `exit` + Enter closes the modal', () => {
    const r = createTerminalModalRouter();
    const m = fakeModal();
    r.set(m);
    expect(r.handleKey({ name: 'e' })).toBe('consumed');
    expect(r.handleKey({ name: 'x' })).toBe('consumed');
    expect(r.handleKey({ name: 'i' })).toBe('consumed');
    expect(r.handleKey({ name: 't' })).toBe('consumed');
    expect(r.handleKey({ name: 'enter' })).toBe('closed');
    expect(m._disposeCount).toBe(1);
  });

  test('typed `EXIT` + Enter (uppercase paste) also closes', () => {
    const r = createTerminalModalRouter();
    const m = fakeModal();
    r.set(m);
    // Paste of uppercase letters arrives with shift=false but the
    // name is the literal char — router lower-cases it before the
    // EXIT_CHARS check. (See terminal-modal-router toLowerCase at
    // top of handleKey.)
    expect(r.handleKey({ name: 'E' })).toBe('consumed');
    expect(r.handleKey({ name: 'X' })).toBe('consumed');
    expect(r.handleKey({ name: 'I' })).toBe('consumed');
    expect(r.handleKey({ name: 'T' })).toBe('consumed');
    expect(r.handleKey({ name: 'enter' })).toBe('closed');
    expect(m._disposeCount).toBe(1);
  });

  test('typed `exit` then backspace + something else does NOT close', () => {
    const r = createTerminalModalRouter();
    const m = fakeModal();
    r.set(m);
    r.handleKey({ name: 'e' });
    r.handleKey({ name: 'x' });
    r.handleKey({ name: 'i' });
    r.handleKey({ name: 't' });
    r.handleKey({ name: 'backspace' }); // rewind to 'exi'
    r.handleKey({ name: 's' });         // 'exis' — breaks the streak
    expect(r.handleKey({ name: 'enter' })).toBe('consumed');
    expect(m._disposeCount).toBe(0);
  });

  test('typed `exit` interleaved with another char does NOT close', () => {
    const r = createTerminalModalRouter();
    const m = fakeModal();
    r.set(m);
    r.handleKey({ name: 'e' });
    r.handleKey({ name: 'x' });
    r.handleKey({ name: 'i' });
    r.handleKey({ name: 'a' }); // not 't' — breaks the streak
    r.handleKey({ name: 't' });
    expect(r.handleKey({ name: 'enter' })).toBe('consumed');
    expect(m._disposeCount).toBe(0);
  });

  test('typed `exit` with Ctrl modifier does NOT close', () => {
    const r = createTerminalModalRouter();
    const m = fakeModal();
    r.set(m);
    // Ctrl+e is readline beginning-of-line — not a typed letter.
    r.handleKey({ name: 'e', ctrl: true });
    r.handleKey({ name: 'x' });
    r.handleKey({ name: 'i' });
    r.handleKey({ name: 't' });
    expect(r.handleKey({ name: 'enter' })).toBe('consumed');
    expect(m._disposeCount).toBe(0);
  });

  test('Enter alone does NOT close (defensive)', () => {
    const r = createTerminalModalRouter();
    const m = fakeModal();
    r.set(m);
    expect(r.handleKey({ name: 'enter' })).toBe('consumed');
    expect(m._disposeCount).toBe(0);
  });

  test('typed `exit` after a previous Enter still closes (fresh prompt)', () => {
    const r = createTerminalModalRouter();
    const m = fakeModal();
    r.set(m);
    // First line: random. Then a fresh `exit` + Enter should still trigger.
    r.handleKey({ name: 'l' });
    r.handleKey({ name: 's' });
    r.handleKey({ name: 'enter' });
    r.handleKey({ name: 'e' });
    r.handleKey({ name: 'x' });
    r.handleKey({ name: 'i' });
    r.handleKey({ name: 't' });
    expect(r.handleKey({ name: 'enter' })).toBe('closed');
    expect(m._disposeCount).toBe(1);
  });

  test('closePolicy=detach calls dispose with keepPreview:true', () => {
    const r = createTerminalModalRouter();
    let keepPreview: boolean | undefined;
    const m = {
      ...fakeModal(),
      dispose: (opts?: { keepPreview?: boolean }) => { keepPreview = opts?.keepPreview; },
    } as unknown as ReturnType<typeof fakeModal>;
    r.set(m as any, { closePolicy: 'detach' });
    // ESC no longer closes — use Ctrl+G to drive the close path.
    r.handleKey({ name: 'g', ctrl: true });
    expect(keepPreview).toBe(true);
  });

  test('onClose hook wins over closePolicy', () => {
    const r = createTerminalModalRouter();
    const m = fakeModal();
    let hookCalled = 0;
    r.set(m, { onClose: () => { hookCalled++; } });
    // ESC no longer closes — use Ctrl+G to drive the close path.
    r.handleKey({ name: 'g', ctrl: true });
    expect(hookCalled).toBe(1);
    // hook replaced dispose, so modal.dispose count stays 0.
    expect(m._disposeCount).toBe(0);
  });
});
