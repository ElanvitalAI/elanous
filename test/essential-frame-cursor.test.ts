import { describe, expect, test } from 'bun:test';

import {
  drawTurnTypeaheadPromptRows,
  resolveEssentialFrameCursorDecision,
} from '../src/dashboard/input/turn-typeahead-prompt.js';
import { renderDashboardFrame } from '../src/dashboard/index.js';
import type { CursorState } from '../src/display/cursor-state.js';
import { createTurnTypeaheadState } from '../src/chat/turn-typeahead.js';
import { resetRenderCache } from '../src/tui.js';

type EssentialFrameInput = {
  owner?: 'modal' | 'coordinator' | 'terminal' | 'suppressed' | 'none';
  claimedCursor: CursorState | null;
  promptCaret: CursorState | null;
  suppressPromptArea: boolean;
};

function renderEssentialFrame(input: EssentialFrameInput): string {
  const writes: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string) => {
    writes.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    resetRenderCache();
    renderDashboardFrame(['base'], {
      overlay: '\x1b[8;2Hoverlay',
      force: true,
      cursorOwner: input.owner ?? 'none',
      claimedCursor: input.claimedCursor,
      coordinatorCursor: null,
      promptCaret: input.promptCaret,
      suppressPromptArea: input.suppressPromptArea,
    });
  } finally {
    process.stdout.write = write;
  }
  return writes.join('');
}

describe('essential frame-final cursor', () => {
  test('decision metadata distinguishes claim, suppression, prompt fallback, and no cursor', () => {
    expect(resolveEssentialFrameCursorDecision({
      claimedCursor: { row: 4, col: 22, visible: true },
      promptCaret: { row: 11, col: 3, visible: true },
      suppressPromptArea: false,
    })).toMatchObject({ source: 'claim', reason: 'visible-claim', cursor: { row: 4, col: 22, visible: true } });
    expect(resolveEssentialFrameCursorDecision({
      claimedCursor: null,
      promptCaret: { row: 11, col: 3, visible: true },
      suppressPromptArea: true,
    })).toEqual({ source: 'suppressed', reason: 'prompt-area-suppressed', cursor: null });
    expect(resolveEssentialFrameCursorDecision({
      claimedCursor: { row: 4, col: 22, visible: false },
      promptCaret: { row: 11, col: 3, visible: true },
      suppressPromptArea: false,
    })).toMatchObject({ source: 'prompt', reason: 'prompt-caret', cursor: { row: 11, col: 3, visible: true } });
    expect(resolveEssentialFrameCursorDecision({
      claimedCursor: null,
      promptCaret: null,
      suppressPromptArea: false,
    })).toEqual({ source: 'none', reason: 'no-cursor', cursor: null });
  });

  test('claimed-path: a visible modal claim is the final ANSI bytes after the composed frame', () => {
    const claim = { row: 4, col: 22, visible: true };
    const output = renderEssentialFrame({
      owner: 'modal',
      claimedCursor: claim,
      promptCaret: { row: 18, col: 3, visible: true },
      suppressPromptArea: false,
    });

    expect(output).toContain('\x1b[8;2Hoverlay');
    expect(output).toEndWith('\x1b[4;22H\x1b[?25h');
  });

  test('prompt-path: prompt draw caret is the visible final ANSI bytes when no claim exists', () => {
    let promptCaret = null;
    drawTurnTypeaheadPromptRows({
      frame: { inputHeight: 2, promptTopRow: 10, promptBottomRow: 11, topDividerRow: 9, bottomDividerRow: 12 },
      height: 2,
      placeholder: '❯ ',
      prompt: '❯ ',
      state: createTurnTypeaheadState(),
      width: 80,
      onPaint: paint => { promptCaret = paint.caret; },
    });
    const output = renderEssentialFrame({
      owner: 'none',
      claimedCursor: null,
      promptCaret,
      suppressPromptArea: false,
    });

    expect(output).toContain('\x1b[8;2Hoverlay');
    expect(output).toEndWith('\x1b[11;3H\x1b[?25h');
  });

  test('suppressed-path: a hidden prompt area puts existing hide bytes at the frame end without a visible claim', () => {
    const output = renderEssentialFrame({
      owner: 'terminal',
      claimedCursor: null,
      promptCaret: { row: 11, col: 3, visible: true },
      suppressPromptArea: true,
    });

    expect(output).toContain('\x1b[8;2Hoverlay');
    expect(output).toEndWith('\x1b[?25l');
  });

  test('terminal without a visible claim falls back to the prompt caret', () => {
    const output = renderEssentialFrame({
      owner: 'terminal',
      claimedCursor: null,
      promptCaret: { row: 11, col: 3, visible: true },
      suppressPromptArea: false,
    });

    expect(output).toEndWith('\x1b[11;3H\x1b[?25h');
  });
});
