import { describe, expect, test } from 'bun:test';
import type { PromptFrame } from '../src/display/prompt-frame.js';
import { runDashboardChatMainEntry } from '../src/dashboard/input/chat-main-entry-runtime.js';

const escapeKey = async () => ({ name: 'escape', ctrl: false, shift: false });

describe('dashboard chat-main entry runtime', () => {
  test('paints the frame before stdout renders the initial text', async () => {
    const order: string[] = [];
    const debugEvents: Array<{ event: string; label: string; payload: Record<string, unknown> }> = [];
    const originalWrite = process.stdout.write.bind(process.stdout);

    (process.stdout.write as unknown as (chunk: string | Uint8Array) => boolean) = ((chunk: string | Uint8Array) => {
      order.push(`stdout:${String(chunk)}`);
      return true;
    }) as any;

    try {
      const pending = runDashboardChatMainEntry({
        promptFrame: { promptBottomRow: 12 } as PromptFrame,
        inputCols: 40,
        surfaceRegistry: { register() {}, unregister() {} } as any,
        invalidateRenderCacheRow: () => {},
        buildPromptFrameDividerRows: () => [],
        shouldPaint: () => true,
        promptCtl: { repaint: () => {} },
        setInputLines: () => false,
        redraw: () => {},
        dispatchGlobalAction: async () => {},
        initialText: 'zzz',
        paintFrameNow: () => { order.push('paint-frame-now'); },
        debugLog: (event, label, payload) => { debugEvents.push({ event, label, payload }); },
        history: [],
        placeholder: 'placeholder',
        textInputOpts: { onEscape: () => false, readKey: escapeKey },
      });

      await pending;

      expect(order.indexOf('paint-frame-now')).toBeGreaterThanOrEqual(0);
      const initialTextAt = order.findIndex((entry) => entry.includes('zzz'));
      expect(initialTextAt).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('paint-frame-now')).toBeLessThan(initialTextAt);
      expect(debugEvents).toContainEqual({
        event: 'chat-main.entry-runtime',
        label: 'frame-painted-before-input',
        payload: { initialTextLength: 3 },
      });
    } finally {
      (process.stdout.write as any) = originalWrite;
    }
  });

  test('preserves the omitted frame-paint path without reporting a paint', async () => {
    const debugEvents: Array<{ event: string; label: string; payload: Record<string, unknown> }> = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (chunk: string | Uint8Array) => boolean) = (() => true) as any;

    try {
      const pending = runDashboardChatMainEntry({
        promptFrame: { promptBottomRow: 12 } as PromptFrame,
        inputCols: 40,
        surfaceRegistry: { register() {}, unregister() {} } as any,
        invalidateRenderCacheRow: () => {},
        buildPromptFrameDividerRows: () => [],
        shouldPaint: () => false,
        promptCtl: { repaint: () => {} },
        setInputLines: () => false,
        redraw: () => {},
        dispatchGlobalAction: async () => {},
        debugLog: (event, label, payload) => { debugEvents.push({ event, label, payload }); },
        history: [],
        placeholder: 'placeholder',
        textInputOpts: { onEscape: () => false, readKey: escapeKey },
      });

      await pending;

      expect(debugEvents.map(({ label }) => label)).not.toContain('frame-painted-before-input');
    } finally {
      (process.stdout.write as any) = originalWrite;
    }
  });

  test('disarms the prompt repaint hook once textInput returns', async () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (chunk: string | Uint8Array) => boolean) = (() => true) as any;
    const promptCtl: { repaint: () => void } = { repaint: () => {} };
    let armedDuringInput = false;
    const initialRepaint = promptCtl.repaint;
    try {
      const pending = runDashboardChatMainEntry({
        promptFrame: { promptBottomRow: 12 } as PromptFrame,
        inputCols: 40,
        surfaceRegistry: { register() {}, unregister() {} } as any,
        invalidateRenderCacheRow: () => {},
        buildPromptFrameDividerRows: () => [],
        shouldPaint: () => false,
        promptCtl,
        setInputLines: () => false,
        redraw: () => {},
        dispatchGlobalAction: async () => {},
        history: [],
        placeholder: 'placeholder',
        textInputOpts: { onEscape: () => false, readKey: escapeKey },
      });
      await Promise.resolve();
      armedDuringInput = promptCtl.repaint !== initialRepaint;
      const armed = promptCtl.repaint;
      await pending;
      expect(armedDuringInput).toBe(true);
      expect(promptCtl.repaint).not.toBe(armed);
      let painted = 0;
      const writes: string[] = [];
      (process.stdout.write as unknown as (chunk: string | Uint8Array) => boolean) = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); painted++; return true; }) as any;
      promptCtl.repaint();
      expect(painted).toBe(0);
    } finally {
      (process.stdout.write as any) = originalWrite;
    }
  });

  test('registers/unregisters the chat-main surface around a short input turn', async () => {
    const registered: string[] = [];
    const unregistered: string[] = [];
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);

    (process.stdout.write as unknown as (chunk: string | Uint8Array) => boolean) = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as any;

    try {
      const pending = runDashboardChatMainEntry({
        promptFrame: { promptBottomRow: 12 } as PromptFrame,
        inputCols: 40,
        surfaceRegistry: {
          register(entry: any) { registered.push(entry.title); },
          unregister(addr: any) { unregistered.push(addr.inputId); },
        } as any,
        invalidateRenderCacheRow: () => {},
        buildPromptFrameDividerRows: () => [],
        shouldPaint: () => false,
        promptCtl: { repaint: () => {} },
        setInputLines: () => false,
        redraw: () => {},
        dispatchGlobalAction: async () => {},
        history: [],
        placeholder: 'placeholder',
        textInputOpts: {
          onEscape: () => false,
          readKey: escapeKey,
        },
      });

      const result = await pending;

      expect(typeof result.submitted).toBe('boolean');
      expect(registered).toEqual(['chat-main']);
      expect(unregistered).toEqual(['chat-main']);
      expect(writes.length).toBeGreaterThan(0);
    } finally {
      (process.stdout.write as any) = originalWrite;
    }
  });

  test('auto-clears the input band on submit — invalidates prompt rows + redraws', async () => {
    const invalidated: number[] = [];
    let redraws = 0;
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (chunk: string | Uint8Array) => boolean) = (() => true) as any;

    try {
      const pending = runDashboardChatMainEntry({
        // promptTopRow=10, promptBottomRow=12 → 3 input rows (0-based 9,10,11).
        promptFrame: { promptTopRow: 10, promptBottomRow: 12, inputHeight: 3 } as PromptFrame,
        inputCols: 40,
        surfaceRegistry: {
          register() {},
          unregister() {},
        } as any,
        invalidateRenderCacheRow: (row0: number) => { invalidated.push(row0); },
        buildPromptFrameDividerRows: () => [],
        shouldPaint: () => false,
        promptCtl: { repaint: () => {} },
        setInputLines: () => false,
        redraw: () => { redraws++; },
        dispatchGlobalAction: async () => {},
        history: [],
        placeholder: 'placeholder',
        textInputOpts: {
          onEscape: () => false,
          readKey: async () => ({ name: 'enter', ctrl: false, shift: false }),
        },
        initialText: 'hi',
      });

      const result = await pending;

      expect(result.submitted).toBe(true);
      // Prompt rows promptTopRow..promptBottomRow (1-based) → 0-based 9,10,11.
      expect(invalidated).toEqual([9, 10, 11]);
      expect(redraws).toBeGreaterThan(0);
    } finally {
      (process.stdout.write as any) = originalWrite;
    }
  });
});
