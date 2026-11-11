import type { Key } from '../../tui.js';
import { applyInlineEditorKey } from '../../input-core/inline-editor-key.js';
import { createInlineEditorState, inlineEditorInsert, type InlineEditorState } from '../../input-core/inline-editor.js';
import { safeLogText } from '../chat/log-view.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export type ComposerAction = 'edit' | 'submit' | 'cancel' | 'quit' | 'none';

export interface ComposerResult {
  readonly state: InlineEditorState;
  readonly action: ComposerAction;
  readonly submitted?: string;
}

export function emptyComposer(): InlineEditorState {
  return createInlineEditorState();
}

/** Replace a slash-picker query before the cursor while retaining the draft suffix. */
export function replaceSlashPickerQuery(state: InlineEditorState, command: string): InlineEditorState {
  const cursor = Math.max(0, Math.min(state.cursor, state.text.length));
  return { text: command + state.text.slice(cursor), cursor: command.length };
}

/** Wrap the draft, grow with it, and scroll inside the bounded composer when needed. */
export function composerViewport(state: InlineEditorState, viewport: number | { columns: number; maxRows: number }): {
  line: string; lines: string[]; cursorRow: number; cursorCol: number;
} {
  const width = Math.max(1, typeof viewport === 'number' ? viewport : viewport.columns);
  const available = Math.max(1, width - 2);
  const rows = ['❯ '];
  let used = 0;
  let cursorRow = 0;
  let cursorCol = 3;
  let cursorMarked = false;
  const cursor = Math.max(0, Math.min(state.cursor, state.text.length));
  const markCursor = () => { cursorRow = rows.length - 1; cursorCol = Math.min(width, used + 3); cursorMarked = true; };
  for (const { segment, index } of segmenter.segment(state.text)) {
    const newline = segment === '\n';
    const visible = newline ? '' : safeLogText(segment);
    const cells = newline ? 0 : Bun.stringWidth(visible);
    // The next grapheme owns the new row when it would overflow this one.
    if (!newline && used > 0 && used + cells > available) {
      rows.push('  ');
      used = 0;
    }
    if (!cursorMarked && index >= cursor) markCursor();
    if (newline) {
      rows.push('  ');
      used = 0;
      continue;
    }
    if (cells <= available) {
      rows[rows.length - 1] += visible;
      used += cells;
    }
  }
  if (!cursorMarked) {
    // A full final row leaves the insertion point at the next row's start.
    if (cursor === state.text.length && used >= available) {
      rows.push('  ');
      used = 0;
    }
    markCursor();
  }
  const height = Math.max(1, typeof viewport === 'number' ? 1 : viewport.maxRows);
  const start = Math.max(0, Math.min(cursorRow - height + 1, rows.length - height));
  const lines = rows.slice(start, start + height);
  return { line: lines.at(-1) ?? '❯ ', lines, cursorRow: cursorRow - start, cursorCol };
}

export type WheelDirection = 'up' | 'down';

/** Wheel notch carried by a parsed SGR mouse key; null for every other key. */
export function wheelDirection(key: Key): WheelDirection | null {
  if (key.name !== 'mouse') return null;
  if (key.mouse?.type === 'scroll-up') return 'up';
  if (key.mouse?.type === 'scroll-down') return 'down';
  return null;
}

/**
 * Longest pause allowed *inside* a held SGR tail. The tail itself may come any
 * time after the lone ESC (the guard stays armed until the next key decides),
 * but once characters are held, a pause this long releases them as typing.
 */
export const MOUSE_RESIDUE_WINDOW_MS = 500;
const SGR_MOUSE_TAIL = /^\[<(\d+);(\d+);(\d+)([Mm])$/;
const SGR_MOUSE_TAIL_PREFIX = /^\[(?:<(?:\d+(?:;(?:\d*|\d+;\d*))?)?)?$/;

export type MouseResidueStep =
  | { readonly kind: 'pass' }
  | { readonly kind: 'hold' }
  | { readonly kind: 'release'; readonly keys: readonly Key[] }
  | { readonly kind: 'mouse'; readonly wheel: WheelDirection | null };

/**
 * When the ESC of an SGR mouse report reaches us apart from its tail (slow link,
 * split write), the key parser's quiet window turns the ESC into Escape and the
 * tail `[<65;10;5M` into typed characters. The guard is armed by that lone ESC;
 * it holds the following characters while they still spell an SGR mouse tail,
 * swallows a complete one (reporting its wheel notch), and releases anything
 * else unchanged and in order.
 */
export class MouseResidueGuard {
  private armedAt: number | null = null;
  private held: Key[] = [];
  private text = '';

  arm(now: number): void {
    this.armedAt = now;
    this.held = [];
    this.text = '';
  }

  accept(key: Key, now: number): MouseResidueStep {
    if (this.armedAt === null) return { kind: 'pass' };
    const ch = key.ctrl || key.alt || key.meta ? null : (key.raw ?? key.name);
    const inTime = this.held.length === 0 || now - this.armedAt <= MOUSE_RESIDUE_WINDOW_MS;
    const candidate = ch !== null && ch.length === 1 && inTime ? this.text + ch : null;
    if (candidate !== null) {
      const full = candidate.match(SGR_MOUSE_TAIL);
      if (full) {
        this.reset();
        const button = Number(full[1]) & ~(4 | 8 | 16);
        const pressed = full[4] === 'M';
        return { kind: 'mouse', wheel: pressed && button === 64 ? 'up' : pressed && button === 65 ? 'down' : null };
      }
      if (SGR_MOUSE_TAIL_PREFIX.test(candidate)) {
        this.held.push(key);
        this.text = candidate;
        this.armedAt = now;   // the pause limit counts from the last held character
        return { kind: 'hold' };
      }
    }
    const held = this.held;
    this.reset();
    return held.length === 0 ? { kind: 'pass' } : { kind: 'release', keys: [...held, key] };
  }

  private reset(): void {
    this.armedAt = null;
    this.held = [];
    this.text = '';
  }
}

/** Reuse the shared editor contract; only TUI submit/cancel keys live here. */
export function applyComposerKey(state: InlineEditorState, key: Key): ComposerResult {
  const name = key.name.toLowerCase();
  // Mouse reports (wheel, click, drag) never edit the prompt.
  if (name === 'mouse') return { state, action: 'none' };
  if (name === 'escape' && !state.text) return { state, action: 'none' };
  if ((key.ctrl && (name === 'd' || name === 'c')) || name === 'escape') {
    if (state.text && !(key.ctrl && name === 'd')) return { state: emptyComposer(), action: 'cancel' };
    return { state, action: 'quit' };
  }
  if ((name === 'enter' || name === 'return') && !key.shift) {
    if (key.alt || key.ctrl) return { state: inlineEditorInsert(state, '\n'), action: 'edit' };
    const submitted = state.text.trim();
    return submitted
      ? { state: emptyComposer(), action: 'submit', submitted }
      : { state, action: 'none' };
  }
  if (key.ctrl && name === 'j') return { state: inlineEditorInsert(state, '\n'), action: 'edit' };
  // One bracketed-paste envelope (terminal paste · herdr `pane run`) is one key whose body rides on `paste`.
  // Without this the shared text rule inserted the key NAME («paste») instead of the pasted text.
  if (name === 'paste') {
    return typeof key.paste === 'string' && key.paste.length > 0
      ? { state: inlineEditorInsert(state, key.paste), action: 'edit' }
      : { state, action: 'none' };
  }
  const edited = applyInlineEditorKey(state, key, { shiftEnter: 'newline', tab: null });
  return edited ? { state: edited, action: 'edit' } : { state, action: 'none' };
}
