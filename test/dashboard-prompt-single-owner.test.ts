// TUI-PROMPT-SINGLE-OWNER — the idle prompt band has one writer: the
// frame renderer. textInput publishes rows/hint/caret to a
// PromptRowOwner and writes nothing to the prompt rows itself, so an
// idle redraw (2Hz status tick) re-emits neither the prompt nor the
// rows below it.

import { describe, expect, test } from 'bun:test';
import { textInput } from '../src/chat/index.js';
import { DisplayCoordinator } from '../src/display/coordinator.js';
import { paintCursor, type CursorState } from '../src/display/cursor-state.js';
import {
  createPromptBandRenderObserver,
  createPromptRowOwner,
  renderPromptOwnerHintRow,
  renderPromptOwnerRows,
  withPromptRowOwner,
  type PromptRowOwner,
} from '../src/display/prompt-row-owner.js';
import type { LayoutZone } from '../src/layout/composer.js';
import { render, resetRenderCache, stripAnsi } from '../src/tui.js';
import { dashboardSourceText, readDashboardSources } from './helpers/dashboard-source.js';

const ROWS = 24;
const COLS = 60;
const PROMPT_ROW = 20;

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const realWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  return { writes, restore: () => { process.stdout.write = realWrite; } };
}

const key = (name: string) => ({ name, ctrl: false, shift: false });
const directPromptWrite = new RegExp(`\\x1b\\[${PROMPT_ROW};1H\\x1b\\[2K`);

async function typeAbThenIdle(promptRowOwner?: PromptRowOwner, frameCount: () => number = () => 0) {
  const control = { repaint: () => {} };
  const keys = [key('a'), key('b'), key('enter')];
  const out = captureStdout();
  let idleWrites: string[] = [];
  const seen: { published: string[] | null } = { published: null };
  let idleFrameRequests = -1;
  try {
    const result = await textInput({
      row: PROMPT_ROW,
      col: 1,
      width: COLS,
      cursorSink: { setCursor: () => {} },
      host: { control },
      ...(promptRowOwner ? { promptRowOwner } : {}),
      readKey: async () => {
        const next = keys.shift()!;
        if (next.name === 'enter') {
          // Idle: the host's external repaint fires three times (old
          // afterRender cadence). A frame-owned band must stay silent.
          const before = out.writes.length;
          const framesBefore = frameCount();
          control.repaint();
          control.repaint();
          control.repaint();
          idleWrites = out.writes.slice(before);
          idleFrameRequests = frameCount() - framesBefore;
          seen.published = promptRowOwner?.current()?.rows.map((row) => stripAnsi(row).trimEnd()) ?? null;
        }
        return next;
      },
    });
    return { result, writes: out.writes, idleWrites, idleFrameRequests, publishedBeforeEnter: seen.published };
  } finally {
    out.restore();
  }
}

describe('textInput with a frame-owned prompt band', () => {
  test('publishes rows instead of writing the prompt row, and idle repaint is a no-op', async () => {
    let frames = 0;
    const owner = createPromptRowOwner({ requestFrame: () => { frames++; }, isDebugEnabled: () => false });
    const run = await typeAbThenIdle(owner, () => frames);

    expect(run.result).toEqual({ text: 'ab', submitted: true });
    expect(run.writes.join('')).not.toMatch(directPromptWrite);
    expect(run.idleWrites).toEqual([]);
    expect(run.publishedBeforeEnter).toEqual(['❯ ab']);
    expect(run.idleFrameRequests).toBe(0);
    expect(owner.current()).toBeNull();
  });

  test('contrast: without an owner the legacy path writes the prompt row directly on every repaint', async () => {
    const run = await typeAbThenIdle();
    expect(run.writes.join('')).toMatch(directPromptWrite);
    expect(run.idleWrites.join('')).toMatch(directPromptWrite);
  });
});

describe('frame renderer as the single prompt-band writer', () => {
  test('idle frames re-emit nothing; one typed char rewrites one row with one hide/show pair inside the frame write', () => {
    const owner = createPromptRowOwner({ requestFrame: () => {}, isDebugEnabled: () => false });
    const placeholder: LayoutZone = { id: 'input-prompt', height: 1, render: (h) => Array.from({ length: h }, () => '❯ ') };
    const bandLog: Array<Record<string, unknown>> = [];
    let now = 0;
    const observe = createPromptBandRenderObserver({
      isDebugEnabled: () => true,
      log: (_c, _e, data) => bandLog.push(data),
      now: () => now,
      sampleMs: 10_000,
    });
    const frameCaret: { current: CursorState | null } = { current: null };
    const buildFrame = (): string[] => {
      const zone = withPromptRowOwner(placeholder, owner, {
        suppressPromptArea: false,
        onCaret: (c) => { frameCaret.current = c; },
        observe,
      });
      const lines = Array.from({ length: ROWS }, (_, i) => `log ${i}`);
      lines[PROMPT_ROW - 1] = zone.render(1, COLS)[0]!;
      lines[PROMPT_ROW] = '─'.repeat(COLS);
      lines[PROMPT_ROW + 1] = renderPromptOwnerHintRow(owner, { suppressPromptArea: false });
      lines[PROMPT_ROW + 2] = 'status';
      return lines.slice(0, ROWS);
    };

    const out = captureStdout();
    const pending: Array<() => void> = [];
    resetRenderCache();
    const display = new DisplayCoordinator({
      frameMs: 16,
      schedule: (fn) => { pending.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>; },
      termSize: () => ({ rows: ROWS, cols: COLS }),
      onRender: (request) => render(buildFrame(), { force: request.force }),
      writeCursor: (chunk) => { out.writes.push(chunk); },
    });
    const flush = (): void => {
      display.requestRender({ force: false });
      pending.shift()?.();
    };
    // The dashboard's draw() microtask path: one render() write carrying the
    // frame cursor (renderDashboardFrame), no coordinator flush.
    const drawNow = (): void => {
      const lines = buildFrame();
      render(lines, { cursor: paintCursor(frameCaret.current) });
    };
    const realRows = process.stdout.rows;
    const realCols = process.stdout.columns;
    Object.defineProperty(process.stdout, 'rows', { value: ROWS, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: COLS, configurable: true });
    try {
      owner.publish({ rows: ['❯ hello'], hint: null, caret: { row: PROMPT_ROW, col: 8, visible: true }, source: 'text-input' });
      render(buildFrame(), { force: true });
      out.writes.length = 0;

      flush();
      flush();
      flush();
      expect(out.writes.join('')).not.toContain('\x1b[2K');
      expect(out.writes.join('')).not.toContain('status');

      out.writes.length = 0;
      owner.publish({ rows: ['❯ hellox'], hint: null, caret: { row: PROMPT_ROW, col: 9, visible: true }, source: 'text-input' });
      drawNow();
      const frame = out.writes.join('');
      expect(frame.match(/\x1b\[\d+;1H\x1b\[2K/g) ?? []).toHaveLength(1);
      expect(frame).toContain(`\x1b[${PROMPT_ROW};1H\x1b[2K❯ hellox`);
      expect(frame.match(/\x1b\[\?25[hl]/g) ?? []).toEqual(['\x1b[?25l', '\x1b[?25h']);
      expect(frameCaret.current).toEqual({ row: PROMPT_ROW, col: 9, visible: true });

      // Ctrl+C hint lives in the published paint and lands on the gap row.
      out.writes.length = 0;
      owner.publish({ rows: ['❯ hellox'], hint: 'press Ctrl+C again', caret: { row: PROMPT_ROW, col: 9, visible: true }, source: 'text-input' });
      flush();
      expect(out.writes.join('')).toContain(`\x1b[${PROMPT_ROW + 2};1H\x1b[2Kpress Ctrl+C again`);

      // Turn starts: owner clears, the inner (typeahead) zone draws again.
      owner.clear();
      out.writes.length = 0;
      flush();
      expect(out.writes.join('')).toContain(`\x1b[${PROMPT_ROW};1H\x1b[2K❯ `);
    } finally {
      out.restore();
      resetRenderCache();
      Object.defineProperty(process.stdout, 'rows', { value: realRows, configurable: true });
      Object.defineProperty(process.stdout, 'columns', { value: realCols, configurable: true });
    }

    // Observation: every paint change (rows, then hint) is logged; identical idle frames are sampled.
    expect(bandLog.map((entry) => entry.owner)).toEqual(['text-input', 'text-input', 'text-input', 'turn-typeahead']);
    now = 20_000;
    observe('turn-typeahead', '❯ ');
    expect(bandLog.at(-1)).toEqual({ owner: 'turn-typeahead', changed: false, rendersSinceLast: 1 });
  });
});

describe('real textInput keystroke through the frame owner', () => {
  // Scope (TUI-PROMPT-SINGLE-OWNER): the hide/show pair is counted inside the
  // frame write only. The coordinator's immediate cursor emit on setCursor is
  // a separate cursor-ownership contract, handed to
  // ASK-TUI-PROMPT-CURSOR-SINGLE-EMIT — its bytes go to `coordinatorWrites`.
  test('one typed char reaches the screen as one frame row write with one hide/show pair inside the frame write', async () => {
    const zone: LayoutZone = { id: 'input-prompt', height: 1, render: (h) => Array.from({ length: h }, () => '❯ ') };
    const caretSeen: { current: CursorState | null } = { current: null };
    const coordinatorWrites: string[] = [];
    const claims: Array<CursorState | null> = [];
    const coordinator = new DisplayCoordinator({
      frameMs: 16,
      schedule: (fn) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; },
      termSize: () => ({ rows: ROWS, cols: COLS }),
      writeCursor: (chunk) => { coordinatorWrites.push(chunk); },
    });
    let owner: PromptRowOwner;
    // The dashboard's draw(): microtask-coalesced, one render() write with the frame cursor.
    let drawQueued = false;
    const drawNow = (): void => {
      const lines = Array.from({ length: ROWS }, (_, i) => `log ${i}`);
      lines[PROMPT_ROW - 1] = withPromptRowOwner(zone, owner, {
        suppressPromptArea: false,
        onCaret: (c) => { caretSeen.current = c; },
      }).render(1, COLS)[0]!;
      lines[PROMPT_ROW] = '─'.repeat(COLS);
      lines[PROMPT_ROW + 1] = renderPromptOwnerHintRow(owner, { suppressPromptArea: false });
      lines[PROMPT_ROW + 2] = 'status';
      render(lines, { cursor: paintCursor(caretSeen.current) });
    };
    owner = createPromptRowOwner({
      isDebugEnabled: () => false,
      requestFrame: () => {
        if (drawQueued) return;
        drawQueued = true;
        queueMicrotask(() => { drawQueued = false; drawNow(); });
      },
    });
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const keys = [key('a'), key('x'), key('enter')];
    const marks: number[] = [];
    const realRows = process.stdout.rows;
    const realCols = process.stdout.columns;
    Object.defineProperty(process.stdout, 'rows', { value: ROWS, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: COLS, configurable: true });
    const out = captureStdout();
    resetRenderCache();
    try {
      await textInput({
        row: PROMPT_ROW,
        col: 1,
        width: COLS,
        cursorSink: {
          setCursor: (state) => {
            claims.push(state ? { ...state } : null);
            coordinator.setCursor(state);
          },
        },
        promptRowOwner: owner,
        readKey: async () => {
          await settle();
          marks.push(out.writes.length);
          return keys.shift()!;
        },
      });
    } finally {
      out.restore();
      resetRenderCache();
      Object.defineProperty(process.stdout, 'rows', { value: realRows, configurable: true });
      Object.defineProperty(process.stdout, 'columns', { value: realCols, configurable: true });
    }

    // marks[1] = before 'x' is delivered, marks[2] = after its frame settled.
    const typed = out.writes.slice(marks[1], marks[2]).join('');
    expect(typed.match(/\x1b\[\d+;1H\x1b\[2K/g) ?? []).toEqual([`\x1b[${PROMPT_ROW};1H\x1b[2K`]);
    expect(stripAnsi(typed)).toContain('❯ ax');
    expect(typed.match(/\x1b\[\?25[hl]/g) ?? []).toEqual(['\x1b[?25l', '\x1b[?25h']);
    // The frame cursor and the claimed caret come from the same paint.
    expect(caretSeen.current).toEqual({ row: PROMPT_ROW, col: 5, visible: true });
    expect(claims).toContainEqual({ row: PROMPT_ROW, col: 5, visible: true });
    // The coordinator only moves the cursor; it never writes a row.
    expect(coordinatorWrites.join('')).not.toContain('\x1b[2K');
  });

  test('a suppressed prompt area renders no live hint', () => {
    const owner = createPromptRowOwner({ requestFrame: () => {}, isDebugEnabled: () => false });
    owner.publish({ rows: ['❯ '], hint: 'press Ctrl+C again', caret: null, source: 'text-input' });
    expect(renderPromptOwnerHintRow(owner, { suppressPromptArea: true })).toBe('');
    expect(renderPromptOwnerHintRow(owner, { suppressPromptArea: false })).toBe('press Ctrl+C again');
  });
});

describe('prompt-band observation', () => {
  test('a hint-only or caret-only change is logged at once, an identical idle frame is sampled', () => {
    const owner = createPromptRowOwner({ requestFrame: () => {}, isDebugEnabled: () => false });
    const zone: LayoutZone = { id: 'input-prompt', height: 1, render: (h) => Array.from({ length: h }, () => '❯ ') };
    const log: Array<Record<string, unknown>> = [];
    const observe = createPromptBandRenderObserver({ isDebugEnabled: () => true, log: (_c, _e, d) => log.push(d), now: () => 0 });
    const frame = () => withPromptRowOwner(zone, owner, { suppressPromptArea: false, observe }).render(1, COLS);
    owner.publish({ rows: ['❯ ab'], hint: null, caret: { row: PROMPT_ROW, col: 5, visible: true }, source: 'text-input' });
    frame();
    frame();
    owner.publish({ rows: ['❯ ab'], hint: 'press Ctrl+C again', caret: { row: PROMPT_ROW, col: 5, visible: true }, source: 'text-input' });
    frame();
    owner.publish({ rows: ['❯ ab'], hint: 'press Ctrl+C again', caret: { row: PROMPT_ROW, col: 4, visible: true }, source: 'text-input' });
    frame();
    expect(log).toEqual([
      { owner: 'text-input', changed: true, rendersSinceLast: 1 },
      { owner: 'text-input', changed: true, rendersSinceLast: 2 },
      { owner: 'text-input', changed: true, rendersSinceLast: 1 },
    ]);
  });
});

describe('prompt-band row fitting', () => {
  test('bottom-anchors rows and paints nothing into a zero-height zone', () => {
    const paint = { rows: ['❯ first', '  · second'], hint: null, caret: null, source: 'text-input' as const };
    expect(renderPromptOwnerRows(paint, 0)).toEqual([]);
    expect(renderPromptOwnerRows(paint, 1)).toEqual(['  · second']);
    expect(renderPromptOwnerRows(paint, 3)).toEqual(['', '❯ first', '  · second']);
  });
});

describe('dashboard wiring', () => {
  test('no afterRender prompt repaint remains and the chat-main entry receives the owner', () => {
    const source = dashboardSourceText(readDashboardSources());
    expect(source).not.toContain('repaintPromptAfterRender');
    expect(source).toContain('withPromptRowOwner(buildDashboardTurnTypeaheadPromptZone(');
    expect(source).toMatch(/runDashboardChatMainEntry\(\{[\s\S]{0,1200}promptRowOwner,/);
  });
});
