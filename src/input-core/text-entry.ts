import type { KeyEvent } from '../plugins/core/types.js';

const NON_TEXT_KEY_NAMES = new Set([
  '',
  'backspace',
  'delete',
  'enter',
  'return',
  'escape',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'mouse',
  'paste-start',
  'paste-end',
]);

export interface KeyEventTextInsertionOpts {
  readonly tab?: string | null;
}

/** Shared mini-input text insertion rule for non-terminal-owned
 *  composers. Mirrors chat-main's semantics for space + multi-byte
 *  text while keeping control/navigation keys out of the buffer. */
export function keyEventToTextInsertion(
  ev: KeyEvent,
  opts: KeyEventTextInsertionOpts = {},
): string | null {
  const name = ev.name ?? '';
  if (ev.ctrl || ev.alt) return null;
  if (name === 'space') return ' ';
  if (name === 'tab') return opts.tab ?? null;
  if (name.startsWith('\x1b')) return null;
  if (NON_TEXT_KEY_NAMES.has(name)) return null;
  return preservePrintableText(ev, name);
}

/** Hangul Compatibility Jamo (ㄱ…ㅣ · ㅋㅋ · ㅠㅠ). The key parser maps a lone jamo keystroke to the QWERTY key
 *  on the same position so hotkeys work under the Korean IME — but as TEXT it must stay the jamo the person typed
 *  (U1 · 2026-10-02: «ㅋㅋㅋ ㅠㅠ» came out as «zzz bb» in the chat input). */
const COMPAT_JAMO = /^[\u3131-\u318E]$/;

function preservePrintableText(ev: KeyEvent, name: string): string {
  // The chat composer passes the TUI key (original bytes on `raw`); other composers pass a KeyEvent (`sequence`).
  const sequence = ev.sequence ?? (ev as { raw?: string }).raw;
  if (sequence && name.length === 1 && COMPAT_JAMO.test(sequence)) return sequence;
  if (
    sequence
    && sequence.length === 1
    && name.length === 1
    && sequence !== name
    && sequence.toLowerCase() === name.toLowerCase()
  ) {
    return sequence;
  }
  if (name.length === 1) return ev.shift ? name.toUpperCase() : name;
  return name;
}
