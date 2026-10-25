// TUI-PICKER-RESIZE-SHRINK (TUI 결함 #76 · 2026-10-17) — an OPEN slash
// picker keeps both borders (╭ and ╰) and stays glued to the prompt when
// the terminal is resized (80x28 → 120x34 → 80x28).
//
// Live repro before the fix: after the shrink the picker's bottom `╰`
// row was gone — the input divider painted by the resize path's prompt
// repaint sat on top of it and no coordinator flush re-emitted the
// overlay. On widen the picker stayed at its mount-time row (mid screen).
//
// Wiring under test is the real one: textInput ⊕ chat-main session
// chrome ⊕ DisplayCoordinator (modalSink) ⊕ installResizeListener, bytes
// fed into a headless VT emulator so we assert on the SCREEN, not on
// write calls.

import { afterEach, describe, expect, test } from 'bun:test';
import { Terminal as XtermHeadless } from '@xterm/headless';

import { textInput } from '../src/chat/index.js';
import { createChatMainInputSession } from '../src/dashboard/input/chat-main-session.js';
import { DisplayCoordinator } from '../src/display/coordinator.js';
import { renderModalStack } from '../src/display/modal-stack.js';
import type { PromptFrame } from '../src/display/prompt-frame.js';
import { installResizeListener } from '../src/display/resize-listener.js';
import { invalidateRenderCacheRow, render, resetRenderCache, splitKeys, type Key } from '../src/tui.js';

const commands = [
  { name: 'help', description: 'Help' },
  { name: 'resume', description: 'Resume' },
  { name: 'model', description: 'Model' },
  { name: 'clear', description: 'Clear' },
];

function keyOf(raw: string): Key {
  const [key] = splitKeys(raw);
  if (!key) throw new Error(`cannot parse key ${JSON.stringify(raw)}`);
  return key;
}

/** Layout mirrors the dashboard bottom band: divider · prompt · divider · status. */
function promptFrameFor(rows: number): PromptFrame {
  const promptRow = rows - 3;
  return {
    inputHeight: 1,
    promptTopRow: promptRow,
    promptBottomRow: promptRow,
    topDividerRow: promptRow - 1,
    bottomDividerRow: promptRow + 1,
  };
}

function screenLines(term: XtermHeadless): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < term.rows; i++) {
    out.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '');
  }
  return out;
}

interface Harness {
  resize: (cols: number, rows: number) => Promise<void>;
  screen: () => Promise<string[]>;
  promptRow: () => number;
  finish: () => Promise<void>;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function openPickerHarness(opts: { overlayFrame: boolean }): Promise<Harness> {
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  const realWrite = process.stdout.write.bind(process.stdout);
  let cols = 80;
  let rows = 28;
  process.stdout.columns = cols;
  process.stdout.rows = rows;
  const term = new XtermHeadless({ cols, rows, scrollback: 0, allowProposedApi: true });
  process.stdout.write = ((chunk: string | Uint8Array) => {
    term.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;

  const base = (): string[] => Array.from({ length: rows }, (_, i) => `log line ${i + 1}`);
  const pending: Array<() => void> = [];
  const promptCtl: { repaint: () => void } = { repaint: () => {} };
  const display = new DisplayCoordinator({
    frameMs: 16,
    schedule: (fn) => { pending.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>; },
    termSize: () => ({ rows, cols }),
    invalidateRow: (row0) => invalidateRenderCacheRow(row0),
    onRender: (request, snapshot) => {
      render(base(), {
        force: request.force,
        overlay: renderModalStack({ surfaces: snapshot.surfaces, focusStack: snapshot.focus.stack }),
      });
    },
    hooks: { afterRender: () => { promptCtl.repaint(); } },
    writeOverlay: (s) => { process.stdout.write(s); },
    writeCursor: (s) => { process.stdout.write(s); },
  });
  const drain = async (): Promise<void> => {
    for (let guard = 0; pending.length > 0 && guard < 50; guard++) pending.shift()!();
    await new Promise<void>((resolve) => term.write('', () => resolve()));
  };

  const session = createChatMainInputSession({
    promptFrame: promptFrameFor(rows),
    getPromptFrame: () => promptFrameFor(rows),
    inputCols: cols,
    getInputCols: () => cols,
    surfaceRegistry: { register: () => {}, unregister: () => {} } as never,
    invalidateRenderCacheRow,
    buildPromptFrameDividerRows: (frame, divider) => [
      { row: frame.topDividerRow, text: divider },
      { row: frame.bottomDividerRow, text: divider },
    ],
    shouldPaint: () => true,
  });

  // Dashboard `draw({force})` shape on resize: direct frame render with the
  // coordinator modal composed in — it does NOT run the coordinator flush.
  const draw = (o?: { force?: boolean }): void => {
    const snap = display.snapshot();
    render(base(), {
      force: o?.force,
      overlay: renderModalStack({ surfaces: snap.surfaces, focusStack: snap.focus.stack }),
    });
  };
  const disposeResize = installResizeListener({
    draw,
    promptCtl,
    ...(opts.overlayFrame ? { requestOverlayFrame: () => display.requestRender({ force: true }) } : {}),
  });

  resetRenderCache();
  render(base());
  const keys: Array<(k: Key) => void> = [];
  const pendingInput = textInput({
    row: session.inputRow,
    getRow: session.getInputRow,
    col: 1,
    width: cols,
    getWidth: session.getInputWidth,
    commands,
    onPaintChrome: session.paintChrome,
    modalSink: display,
    cursorSink: display,
    controlOut: promptCtl,
    readKey: () => new Promise<Key>((resolve) => { keys.push(resolve); }),
  });
  const press = async (raw: string): Promise<void> => {
    for (let i = 0; i < 20 && keys.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
    keys.shift()?.(keyOf(raw));
    await new Promise((r) => setTimeout(r, 5));
    await drain();
  };
  await press('/');

  let finished = false;
  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    for (let i = 0; i < 4; i++) {
      keys.shift()?.(keyOf('\x1b'));
      const done = await Promise.race([
        pendingInput.then(() => true, () => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 5)),
      ]);
      await drain();
      if (done) break;
    }
  };
  cleanups.push(async () => {
    await finish();
    disposeResize();
    process.stdout.write = realWrite as typeof process.stdout.write;
    process.stdout.columns = originalColumns;
    process.stdout.rows = originalRows;
    resetRenderCache();
    term.dispose();
  });

  return {
    resize: async (c, r) => {
      cols = c;
      rows = r;
      term.resize(c, r);
      process.stdout.columns = c;
      process.stdout.rows = r;
      process.stdout.emit('resize');
      await new Promise((resolve) => setTimeout(resolve, 20));
      await drain();
    },
    screen: async () => {
      await drain();
      return screenLines(term);
    },
    promptRow: () => session.getInputRow(),
    finish,
  };
}

function borders(lines: string[]): { top: number; bottom: number; bottomRow: number | null } {
  let top = 0;
  let bottom = 0;
  let bottomRow: number | null = null;
  lines.forEach((line, i) => {
    if (line.startsWith('╭')) top++;
    if (line.startsWith('╰')) {
      bottom++;
      bottomRow = i + 1;
    }
  });
  return { top, bottom, bottomRow };
}

describe('TUI-PICKER-RESIZE-SHRINK — open slash picker survives terminal resize', () => {
  test('80x28 → 120x34 → 80x28: ╭ and ╰ stay 1/1 and the picker bottom sits right above the prompt', async () => {
    const h = await openPickerHarness({ overlayFrame: true });
    const steps: Array<[number, number]> = [[80, 28], [120, 34], [80, 28]];
    for (const [c, r] of steps) {
      await h.resize(c, r);
      const lines = await h.screen();
      const b = borders(lines);
      expect({ size: `${c}x${r}`, top: b.top, bottom: b.bottom }).toEqual({ size: `${c}x${r}`, top: 1, bottom: 1 });
      // Glued to the prompt (not left at the mount-time row after widen).
      expect(b.bottomRow).toBe(h.promptRow() - 1);
      expect(lines[h.promptRow() - 1]?.startsWith('❯')).toBe(true);
    }
    await h.finish();
  });
});
