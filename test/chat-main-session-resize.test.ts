import { describe, expect, spyOn, test } from 'bun:test';

import { textInput } from '../src/chat/index.js';
import { createChatPickerModalRuntime } from '../src/chat/pickers/modal-runtime.js';
import type { PickerState } from '../src/chat/pickers/state.js';
import { runDashboardChatMainEntry } from '../src/dashboard/input/chat-main-entry-runtime.js';
import { createChatMainInputSession } from '../src/dashboard/input/chat-main-session.js';
import { buildChatMainTextInputRequest } from '../src/dashboard/input/chat-main-turn.js';
import { installResizeListener } from '../src/display/resize-listener.js';
import type { PromptFrame } from '../src/display/prompt-frame.js';
import { hLine, invalidateRenderCacheRow, render, stripAnsi, termSize, visibleWidth, type Key } from '../src/tui.js';

const frame: PromptFrame = {
  inputHeight: 1,
  promptTopRow: 10,
  promptBottomRow: 10,
  topDividerRow: 9,
  bottomDividerRow: 11,
};

const escapeKey = { name: 'escape', ctrl: false, shift: false } as Key;

/** Ends a pending input turn even when an assertion threw mid-test, so a
 *  failing case cannot leave a live readKey loop behind for later tests. */
async function settleTurn(
  pending: Promise<unknown> | undefined,
  release: () => ((key: Key) => void) | undefined,
): Promise<void> {
  if (!pending) return;
  let settled = false;
  const watched = pending.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 4 && !settled; i++) {
    release()?.(escapeKey);
    await Promise.race([watched, new Promise((resolve) => setTimeout(resolve, 5))]);
  }
}

describe('chat main prompt resize', () => {
  test('repaints the divider and text input to the current width', async () => {
    let cols = 120;
    const writes: string[] = [];
    const controlOut = { repaint: () => {} };
    let releaseRead: ((key: Key) => void) | undefined;
    const stdout = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const session = createChatMainInputSession({
      promptFrame: frame,
      inputCols: cols,
      getInputCols: () => cols,
      surfaceRegistry: { register: () => {}, unregister: () => {} } as never,
      invalidateRenderCacheRow: () => {},
      buildPromptFrameDividerRows: (_frame, divider) => [{ row: frame.topDividerRow, text: divider }],
      shouldPaint: () => true,
    });

    try {
      const input = textInput(buildChatMainTextInputRequest({
        session,
        history: [],
        placeholder: '',
        textInputOpts: { controlOut, readKey: () => new Promise<Key>((resolve) => { releaseRead = resolve; }) },
      }));
      cols = 80;
      writes.length = 0;
      controlOut.repaint();
      const divider = writes.find((write) => write.startsWith('\x1b[9;1H'));
      const body = writes.find((write) => write.startsWith('\x1b[10;1H'));
      expect(divider).toBeDefined();
      expect(body).toBeDefined();
      expect(visibleWidth(stripAnsi(divider ?? ''))).toBe(80);
      expect(visibleWidth(stripAnsi(body ?? ''))).toBeLessThanOrEqual(80);
      cols = 120;
      writes.length = 0;
      controlOut.repaint();
      expect(visibleWidth(stripAnsi(writes.find((write) => write.startsWith('\x1b[9;1H')) ?? ''))).toBe(120);
      expect(visibleWidth(stripAnsi(writes.find((write) => write.startsWith('\x1b[10;1H')) ?? ''))).toBeLessThanOrEqual(120);
      releaseRead?.({ name: 'escape', ctrl: false, shift: false } as Key);
      expect((await input).submitted).toBe(false);
    } finally {
      stdout.mockRestore();
    }
  });

  const driveDividerResize = async (framePaintsDivider: boolean): Promise<void> => {
    const originalColumns = process.stdout.columns;
    const writes: string[] = [];
    let releaseRead: ((key: Key) => void) | undefined;
    let pending: Promise<{ submitted: boolean }> | undefined;
    let disposeResize: (() => void) | undefined;
    let stdout: { mockRestore: () => void } | undefined;
    const promptCtl = { repaint: () => {} };
    const sessionDividers: string[] = [];
    const multilineFrame: PromptFrame = { ...frame, inputHeight: 3, promptTopRow: 10, promptBottomRow: 12 };
    // The frame renderer paints the divider at the current width too (real
    // render cache, no renderCacheRowIs stub — #27540 skip path is live).
    const draw = (opts?: { force?: boolean }): void => {
      const lines = Array.from({ length: 13 }, () => '');
      if (framePaintsDivider) lines[multilineFrame.topDividerRow - 1] = hLine(termSize().cols);
      render(lines, opts);
    };

    try {
      stdout = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
      process.stdout.columns = 120;
      draw({ force: true });
      disposeResize = installResizeListener({ draw, promptCtl });
      pending = runDashboardChatMainEntry({
        promptFrame: multilineFrame,
        inputCols: termSize().cols,
        getInputCols: () => termSize().cols,
        surfaceRegistry: { register: () => {}, unregister: () => {} } as never,
        invalidateRenderCacheRow,
        buildPromptFrameDividerRows: (_frame, divider) => {
          sessionDividers.push(divider);
          return [{ row: multilineFrame.topDividerRow, text: divider }];
        },
        shouldPaint: () => true,
        promptCtl,
        setInputLines: () => false,
        redraw: () => {},
        dispatchGlobalAction: () => {},
        initialText: `${'long input '.repeat(12)}\n${'second line '.repeat(10)}`,
        history: [],
        placeholder: '',
        textInputOpts: {
          readKey: () => new Promise<Key>((resolve) => { releaseRead = resolve; }),
        },
      });

      await Promise.resolve();
      await Promise.resolve();
      const captureWidth = (cols: number): void => {
        writes.length = 0;
        sessionDividers.length = 0;
        process.stdout.columns = cols;
        process.stdout.emit('resize');
        const output = writes.join('');
        const rows = output.split(/(?=\x1b\[\d+;1H)/);
        // Session side: the resize repaint must make paintChrome build its
        // divider at the new width. It then writes it, or skips it because
        // the frame cache already holds that exact row (#27540) — either
        // way the session's own divider is observed here, apart from draw().
        expect(sessionDividers.length).toBeGreaterThan(0);
        expect(visibleWidth(sessionDividers.at(-1) ?? '')).toBe(cols);
        // Screen side: the row's final bytes are what stays visible. The
        // forced frame draw writes first; a session still at the old width
        // would overwrite last with 120 cells.
        const dividerWrites = rows.filter((write) => write.startsWith(`\x1b[${multilineFrame.topDividerRow};1H`));
        expect(dividerWrites.length).toBeGreaterThan(0);
        expect(visibleWidth(stripAnsi(dividerWrites.at(-1) ?? ''))).toBe(cols);
        if (!framePaintsDivider) {
          // The frame draw only clears this row (blank cell, width 0), so any
          // visible bytes on it can only come from the session's paintChrome:
          // the session itself must write the divider at the new width.
          const sessionWrites = dividerWrites.filter((write) => visibleWidth(stripAnsi(write)) > 0);
          expect(sessionWrites.length).toBeGreaterThan(0);
          for (const write of sessionWrites) expect(visibleWidth(stripAnsi(write))).toBe(cols);
        }
        // Every write to the input body rows — content or blank padding —
        // must fit the new width; content rows are padded to exactly cols-1.
        const bodyRows = rows.filter((write) => [10, 11, 12].some((row) => write.startsWith(`\x1b[${row};1H`)));
        expect(bodyRows.length).toBeGreaterThan(0);
        for (const body of bodyRows) {
          expect(visibleWidth(stripAnsi(body))).toBeLessThanOrEqual(cols - 1);
        }
        const paintedLongInputRows = bodyRows.filter((write) => /long input|second line/.test(stripAnsi(write)));
        expect(paintedLongInputRows.length).toBeGreaterThan(0);
        for (const body of paintedLongInputRows) {
          expect(visibleWidth(stripAnsi(body))).toBe(cols - 1);
        }
        // Both logical lines must be on screen after the resize: the first
        // line behind the prompt and the continuation line behind its own
        // `  · ` prefix. Judge each by the final write to its row, so a
        // continuation row that vanished or kept the old width fails here.
        const lastWriteByRow = [10, 11, 12].map((row) => bodyRows.filter((write) => write.startsWith(`\x1b[${row};1H`)).at(-1));
        const finalBodyWrite = (pattern: RegExp): string | undefined =>
          lastWriteByRow.find((write) => write !== undefined && pattern.test(stripAnsi(write)));
        const firstLineWrite = finalBodyWrite(/long input/);
        const continuationWrite = finalBodyWrite(/ {2}\u00B7 .*second line/);
        expect(firstLineWrite).toBeDefined();
        expect(continuationWrite).toBeDefined();
        expect(visibleWidth(stripAnsi(firstLineWrite ?? ''))).toBe(cols - 1);
        expect(visibleWidth(stripAnsi(continuationWrite ?? ''))).toBe(cols - 1);
      };

      captureWidth(120);
      captureWidth(80);
      captureWidth(120);
      releaseRead?.(escapeKey);
      expect((await pending).submitted).toBe(false);
    } finally {
      await settleTurn(pending, () => releaseRead);
      disposeResize?.();
      stdout?.mockRestore();
      process.stdout.columns = originalColumns;
    }
  };

  test('stdout resize events repaint the entry-runtime divider and long input at current columns', async () => {
    // Frame renderer also paints the divider: real render cache, so the
    // #27540 «same row already cached → skip» path is live.
    await driveDividerResize(true);
  });

  test('stdout resize events make the session itself write the divider at the new width', async () => {
    // Frame renderer leaves the divider row blank: row-9 bytes after the
    // resize can only be the session's own paintChrome write.
    await driveDividerResize(false);
  });

  test('reverse search repaints at the resized terminal width', async () => {
    const originalColumns = process.stdout.columns;
    const writes: string[] = [];
    let releaseRead: ((key: Key) => void) | undefined;
    let pending: Promise<unknown> | undefined;
    let disposeResize: (() => void) | undefined;
    let stdout: { mockRestore: () => void } | undefined;
    const promptCtl = { repaint: () => {} };

    try {
      stdout = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
      process.stdout.columns = 120;
      disposeResize = installResizeListener({ draw: () => {}, promptCtl });
      pending = runDashboardChatMainEntry({
        promptFrame: frame,
        inputCols: termSize().cols,
        getInputCols: () => termSize().cols,
        surfaceRegistry: { register: () => {}, unregister: () => {} } as never,
        invalidateRenderCacheRow: () => {},
        buildPromptFrameDividerRows: (_frame, divider) => [{ row: frame.topDividerRow, text: divider }],
        shouldPaint: () => true,
        promptCtl,
        setInputLines: () => false,
        redraw: () => {},
        dispatchGlobalAction: () => {},
        history: ['previous entry'],
        placeholder: '',
        textInputOpts: {
          readKey: () => new Promise<Key>((resolve) => { releaseRead = resolve; }),
        },
      });
      await Promise.resolve();
      releaseRead?.({ name: 'r', ctrl: true, shift: false } as Key);
      await Promise.resolve();
      await Promise.resolve();
      const searchRowAt = (cols: number): string | undefined => {
        writes.length = 0;
        process.stdout.columns = cols;
        process.stdout.emit('resize');
        return writes.join('').split(/(?=\x1b\[\d+;1H)/).filter((write) => write.includes('reverse-i-search')).at(-1);
      };
      // The search row is padded to the input width, so its exact width
      // separates a new-width repaint from a stale old-width one.
      for (const cols of [80, 120, 80]) {
        const searchRow = searchRowAt(cols);
        expect(searchRow).toBeDefined();
        expect(visibleWidth(stripAnsi(searchRow ?? ''))).toBe(cols - 1);
      }
      releaseRead?.(escapeKey);
      await Promise.resolve();
      releaseRead?.(escapeKey);
      await pending;
    } finally {
      await settleTurn(pending, () => releaseRead);
      disposeResize?.();
      stdout?.mockRestore();
      process.stdout.columns = originalColumns;
    }
  });

  test('slash picker follows stdout resize events through the entry runtime', async () => {
    const originalColumns = process.stdout.columns;
    const writes: string[] = [];
    let releaseRead: ((key: Key) => void) | undefined;
    let pending: Promise<unknown> | undefined;
    let disposeResize: (() => void) | undefined;
    let stdout: { mockRestore: () => void } | undefined;
    const promptCtl = { repaint: () => {} };
    let pickerSurface: import('../src/display/modal-stack.js').ModalSurface | undefined;
    const draw = (): void => {
      if (!pickerSurface) return;
      pickerSurface.getBounds?.();
      const painted = pickerSurface.paint?.();
      if (typeof painted === 'string') process.stdout.write(painted);
    };

    try {
      stdout = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
      process.stdout.columns = 120;
      disposeResize = installResizeListener({ draw, promptCtl });
      pending = runDashboardChatMainEntry({
        promptFrame: frame,
        inputCols: termSize().cols,
        getInputCols: () => termSize().cols,
        surfaceRegistry: { register: () => {}, unregister: () => {} } as never,
        invalidateRenderCacheRow: () => {},
        buildPromptFrameDividerRows: (_frame, divider) => [{ row: frame.topDividerRow, text: divider }],
        shouldPaint: () => true,
        promptCtl,
        setInputLines: () => false,
        redraw: () => {},
        dispatchGlobalAction: () => {},
        history: [],
        placeholder: '',
        textInputOpts: {
          commands: [{ name: 'help', description: 'Help' }],
          modalSink: {
            pushModal: (surface) => {
              pickerSurface = surface;
              draw();
              return { id: surface.id, dispose: () => { pickerSurface = undefined; } };
            },
            requestRender: () => { draw(); },
          },
          readKey: () => new Promise<Key>((resolve) => { releaseRead = resolve; }),
        },
      });
      await Promise.resolve();
      releaseRead?.({ name: '/', ctrl: false, shift: false } as Key);
      await new Promise((resolve) => setTimeout(resolve, 10));
      releaseRead?.({ name: 'h', ctrl: false, shift: false } as Key);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(pickerSurface).toBeDefined();

      for (const cols of [80, 120, 80]) {
        process.stdout.columns = cols;
        writes.length = 0;
        process.stdout.emit('resize');
        await new Promise((resolve) => setTimeout(resolve, 0));
        const rendered = writes.join('');
        const pickerWrites = rendered.split(/(?=\u001b\[\d+;1H)/)
          .filter((write) => write.includes('\u001b[2K') && /help|Slash commands/i.test(stripAnsi(write)));
        expect(pickerWrites.length).toBeGreaterThan(0);
        // Picker rows are painted to the full picker width, so the exact
        // width separates a new-width paint from a stale old-width one.
        for (const row of pickerWrites) {
          expect(row).toMatch(/^\u001b\[\d+;1H/);
          expect(visibleWidth(stripAnsi(row))).toBe(cols);
        }
        expect(pickerSurface?.getBounds?.()?.width).toBe(cols);
      }
      releaseRead?.(escapeKey);
      await pending;
    } finally {
      await settleTurn(pending, () => releaseRead);
      disposeResize?.();
      stdout?.mockRestore();
      process.stdout.columns = originalColumns;
    }
  });

  test('an active picker recalculates its bounds when the prompt narrows', () => {
    let cols = 120;
    const runtime = createChatPickerModalRuntime({
      picker: { selectedIdx: () => 0 } as PickerState,
      getBufferView: () => ({ lines: ['/h'], lineIdx: 0, colIdx: 2 }),
      writeTerminal: () => {},
      getBounds: () => ({ row: 12, col: 1, width: cols, height: 1 }),
      getInputZoneHeight: () => 1,
      onDispatchResult: async () => true,
    });
    const family = runtime.createFamily({
      bounds: { row: 12, col: 1, width: cols, height: 1 },
      maxVisible: 5,
      sources: {
        slash: { id: 'chat:slash', getItems: () => [{ name: 'help', description: 'Help', aliases: [] }] },
        arg: { id: 'chat:arg', getItems: () => [] },
        at: { id: 'chat:at', getItems: () => [] },
        skill: { id: 'chat:skill', getItems: () => [] },
      },
    });
    const picker = family.createSurface('slash');
    expect(picker.getBounds?.()?.width).toBe(120);
    cols = 80;
    expect(picker.getBounds?.()?.width).toBe(80);
  });
});
