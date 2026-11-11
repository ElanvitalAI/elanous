import type { TurnTypeaheadState } from '../../chat/turn-typeahead.js';
import { renderTurnTypeaheadEcho } from '../../chat/turn-typeahead.js';
import type { PromptFrame } from '../../display/prompt-frame.js';
import { paintCursor, type CursorState } from '../../display/cursor-state.js';
import { buildPromptFramePlaceholderRows } from '../../display/prompt-frame-paint.js';
import { visibleWidth } from '../../tui.js';
export {
  resolveEssentialFrameCursor,
  resolveEssentialFrameCursorDecision,
  type EssentialFrameCursorDecision,
  type EssentialFrameCursorInput,
  type EssentialFrameCursorSource,
} from '../../display/essential-frame-cursor.js';

export interface TurnTypeaheadPromptRowsInput {
  frame: PromptFrame;
  height: number;
  placeholder: string;
  hint?: string;
  prompt: string;
  state: TurnTypeaheadState;
  width: number;
  onPaint?: TurnTypeaheadPromptPaintSink;
}

export interface TurnTypeaheadPromptPaint {
  source: 'typeahead-echo' | 'dashboard-draw-prompt';
  row: number;
  text: string;
  caret: CursorState;
}

export type TurnTypeaheadPromptPaintSink = (paint: TurnTypeaheadPromptPaint) => void;

/** The dashboard frame owns the durable typeahead echo; an imperative
 * paint may make keypress feedback immediate, but later draws must reproduce it. */
export function buildTurnTypeaheadPromptRows(input: TurnTypeaheadPromptRowsInput): string[] {
  if (!input.state.buffer) {
    return buildPromptFramePlaceholderRows(input.frame, `${input.placeholder}${input.hint ?? ''}`, input.height);
  }
  const echo = renderTurnTypeaheadEcho(input.state, Math.max(16, input.width - 4));
  return buildPromptFramePlaceholderRows(input.frame, `${input.prompt}${echo}`, input.height);
}

/** Production input-zone draw adapter. Its record identifies the absolute row
 * that composeVertical will repaint after a streaming chunk. */
export function drawTurnTypeaheadPromptRows(
  input: TurnTypeaheadPromptRowsInput,
  sink?: TurnTypeaheadPromptPaintSink,
): string[] {
  const rows = buildTurnTypeaheadPromptRows(input);
  const row = input.frame.promptTopRow + input.height - 1;
  const text = rows.at(-1) ?? '';
  const caretText = !input.state.buffer && input.hint ? input.placeholder : text;
  (sink ?? input.onPaint)?.({
    source: 'dashboard-draw-prompt',
    row,
    text,
    caret: { row, col: visibleWidth(caretText) + 1, visible: true },
  });
  return rows;
}

/** Production imperative echo adapter. It makes keypress feedback immediate,
 * while drawTurnTypeaheadPromptRows remains the durable frame source. */
export function paintTurnTypeaheadEchoRow(input: {
  frame: PromptFrame;
  state: TurnTypeaheadState;
  width: number;
  prompt: string;
}, sink?: TurnTypeaheadPromptPaintSink): string {
  const echo = renderTurnTypeaheadEcho(input.state, Math.max(16, input.width - 4));
  const text = `${input.prompt}${echo}`;
  const caret = { row: input.frame.promptBottomRow, col: visibleWidth(text) + 1, visible: true };
  sink?.({
    source: 'typeahead-echo',
    row: input.frame.promptBottomRow,
    text,
    caret,
  });
  return `\x1b[${input.frame.promptBottomRow};1H\x1b[2K${text}${paintCursor(caret)}`;
}
