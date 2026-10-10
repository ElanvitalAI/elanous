import { describe, expect, spyOn, test } from 'bun:test';

import { createTextInputRenderActions } from '../src/chat/index.js';

describe('createTextInputRenderActions', () => {
  test('host repaint paints without scheduling modal render', () => {
    let paints = 0;
    let chromePaints = 0;
    let renders = 0;
    const actions = createTextInputRenderActions({
      paintChrome: () => { chromePaints++; },
      paint: () => { paints++; },
      modalSink: {
        pushModal: () => ({ id: 'x', dispose: () => {} }),
        requestRender: () => { renders++; },
      },
    });

    actions.repaintHost();
    expect(chromePaints).toBe(1);
    expect(paints).toBe(1);
    expect(renders).toBe(0);
  });

  test('chrome paints before input body', () => {
    const order: string[] = [];
    const actions = createTextInputRenderActions({
      paintChrome: () => { order.push('chrome'); },
      paint: () => { order.push('body'); },
    });

    actions.repaintHost();
    expect(order).toEqual(['chrome', 'body']);
  });

  test('beforePaint hook runs before chrome and body', () => {
    const order: string[] = [];
    const actions = createTextInputRenderActions({
      beforePaint: () => { order.push('before'); },
      paintChrome: () => { order.push('chrome'); },
      paint: () => { order.push('body'); },
    });

    actions.repaintHost();
    expect(order).toEqual(['before', 'chrome', 'body']);
  });

  test('user-mutation repaint wraps its frame in synchronized output escapes', () => {
    const writes: string[] = [];
    const stdoutWrite = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const actions = createTextInputRenderActions({
      paintChrome: () => { process.stdout.write('chrome'); },
      paint: () => { process.stdout.write('body'); },
    });

    try {
      actions.repaintUserMutation();
      expect(writes).toEqual(['\x1b[?2026h', 'chrome', 'body', '\x1b[?2026l']);
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  test('user-mutation repaint paints and requests a NON-forced modal render (TUI-SLASH-FLICKER)', () => {
    let paints = 0;
    const renders: Array<{ force?: boolean }> = [];
    const actions = createTextInputRenderActions({
      paint: () => { paints++; },
      modalSink: {
        pushModal: () => ({ id: 'x', dispose: () => {} }),
        requestRender: (opts) => { renders.push(opts ?? {}); },
      },
    });

    actions.repaintUserMutation();
    expect(paints).toBe(1);
    // force:true reached tui.render as a full-screen erase on every picker keystroke.
    expect(renders).toEqual([{}]);
    expect(renders.some((r) => r.force === true)).toBe(false);
  });

  test('user-mutation repaint skips modal render when predicate says no picker is visible', () => {
    let paints = 0;
    let renders = 0;
    const actions = createTextInputRenderActions({
      paint: () => { paints++; },
      modalSink: {
        pushModal: () => ({ id: 'x', dispose: () => {} }),
        requestRender: () => { renders++; },
      },
      shouldRequestModalRender: () => false,
    });

    actions.repaintUserMutation();
    expect(paints).toBe(1);
    expect(renders).toBe(0);
  });

  test('user-mutation repaint requests modal render when predicate says picker is visible', () => {
    let paints = 0;
    let renders = 0;
    const actions = createTextInputRenderActions({
      paint: () => { paints++; },
      modalSink: {
        pushModal: () => ({ id: 'x', dispose: () => {} }),
        requestRender: () => { renders++; },
      },
      shouldRequestModalRender: () => true,
    });

    actions.repaintUserMutation();
    expect(paints).toBe(1);
    expect(renders).toBe(1);
  });

  test('user-mutation repaint tolerates missing modal sink', () => {
    let paints = 0;
    const actions = createTextInputRenderActions({
      paint: () => { paints++; },
    });

    actions.repaintUserMutation();
    expect(paints).toBe(1);
  });

  test('host repaint suppresses chrome and body when shouldPaint is false', () => {
    const order: string[] = [];
    const actions = createTextInputRenderActions({
      shouldPaint: () => false,
      beforePaint: () => { order.push('before'); },
      paintChrome: () => { order.push('chrome'); },
      paint: () => { order.push('body'); },
    });

    actions.repaintHost();
    expect(order).toEqual([]);
  });

  test('user-mutation repaint suppresses direct paint but still requests modal render when shouldPaint is false', () => {
    let paints = 0;
    let renders = 0;
    const actions = createTextInputRenderActions({
      shouldPaint: () => false,
      paint: () => { paints++; },
      modalSink: {
        pushModal: () => ({ id: 'x', dispose: () => {} }),
        requestRender: () => { renders++; },
      },
    });

    actions.repaintUserMutation();
    expect(paints).toBe(0);
    expect(renders).toBe(1);
  });
});
