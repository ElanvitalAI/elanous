// RESEARCH-tui-bottom-flicker-2026-10-14 §4(f) — turn entry used to call
// resetRenderCache(), so the draw already queued for the turn boundary took
// the force path: a whole-screen `\x1b[J` outside synchronized output, once
// per finished reply.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { createChatMainInputSession } from '../src/dashboard/input/chat-main-session.js';
import { beginChatMainInputTurnPaint } from '../src/dashboard/input/chat-main-turn.js';
import { ansi, invalidateRenderCacheRow, render, renderCacheRowIs, resetRenderCache } from '../src/tui.js';

describe('chat-main turn entry keeps the frame cache', () => {
  const FRAME = ['log 1', 'log 2', '───', '❯ ', '───', '', 'status ✓'];
  const writes: string[] = [];
  let stdoutWrite: ReturnType<typeof spyOn>;
  let prevRows: number | undefined;
  let prevCols: number | undefined;

  beforeEach(() => {
    writes.length = 0;
    prevRows = process.stdout.rows;
    prevCols = process.stdout.columns;
    // defineProperty, not assignment: other suites redefine these as
    // non-writable data properties and a plain write would silently no-op.
    Object.defineProperty(process.stdout, 'rows', { value: FRAME.length, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    stdoutWrite = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    resetRenderCache();
    render(FRAME);
    writes.length = 0;
  });
  afterEach(() => {
    stdoutWrite.mockRestore();
    Object.defineProperty(process.stdout, 'rows', { value: prevRows, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: prevCols, configurable: true });
    resetRenderCache();
  });

  const rewrittenRows = (): number[] => {
    const out = writes.join('');
    return [...out.matchAll(/\x1b\[(\d+);1H\x1b\[2K/g)].map((m) => Number(m[1]));
  };

  test('erases the prompt row and invalidates only that row', () => {
    const chunk = beginChatMainInputTurnPaint(4);
    expect(chunk).toBe(`${ansi.moveTo(4, 1)}\x1b[2K`);
    expect(renderCacheRowIs(3, '❯ ')).toBe(false);
    expect(renderCacheRowIs(6, 'status ✓')).toBe(true);
  });

  test('the next draw repaints the prompt row only — no full-screen erase', () => {
    beginChatMainInputTurnPaint(4);
    render(FRAME);
    const out = writes.join('');
    expect(out).not.toContain(ansi.eraseDown);
    expect(rewrittenRows()).toEqual([4]);
  });
  test('paintChrome against the real render cache: settled divider skipped, dirty one repainted', () => {
    const session = createChatMainInputSession({
      promptFrame: { inputHeight: 1, promptTopRow: 4, promptBottomRow: 4, topDividerRow: 3, bottomDividerRow: 5 },
      inputCols: 40,
      surfaceRegistry: { register: () => {}, unregister: () => {} } as never,
      invalidateRenderCacheRow,
      // The frame draws '───' on both divider rows (FRAME rows 3 and 5).
      buildPromptFrameDividerRows: (f) => [
        { row: f.topDividerRow, text: '───' },
        { row: f.bottomDividerRow, text: '───' },
      ],
      shouldPaint: () => true,
    });
    invalidateRenderCacheRow(4); // lower divider (1-based 5) is dirty
    session.paintChrome();
    expect(rewrittenRows()).toEqual([5]);
    expect(renderCacheRowIs(2, '───')).toBe(true);
  });
});
