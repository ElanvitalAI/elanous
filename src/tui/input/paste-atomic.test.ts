import { expect, test } from 'bun:test';
import type { Key } from '../../tui.js';
import { createNextTuiCoreInput } from '../core/input.js';
import { PASTE_FOLD_MIN_LINES } from '../../chat/paste-fold.js';
import { applyComposerKey, pasteTokenRanges } from './composer.js';

const key = (name: string, extra: Partial<Key> = {}): Key => ({ name, ctrl: false, shift: false, ...extra } as Key);
const paste = (text: string): Key => ({ name: 'paste', ctrl: false, shift: false, paste: text } as Key);
// A paste folds from PASTE_FOLD_MIN_LINES lines; the token names its line count.
const PASTED = Array.from({ length: PASTE_FOLD_MIN_LINES }, (_, index) => `line ${index + 1}`).join('\n');
const TOKEN = `[Paste #1 · +${PASTE_FOLD_MIN_LINES} lines · full text]`;

function composerWithPaste(before: string, after: string) {
  const input = createNextTuiCoreInput();
  for (const ch of before) input.applyKey(key(ch));
  input.applyKey(input.foldKey(paste(PASTED)));
  for (const ch of after) input.applyKey(key(ch));
  return input;
}

test('the folded paste is one token in the composer', () => {
  const input = composerWithPaste('a ', '');
  expect(input.editor.text).toBe(`a ${TOKEN}`);
  expect(pasteTokenRanges(input.editor.text)).toEqual([[2, 2 + TOKEN.length]]);
});

test('Backspace right after the token removes all of it at once, and the held paste is released', () => {
  const input = composerWithPaste('a ', '');
  expect(input.heldPasteCount).toBe(1);
  input.applyKey(key('backspace'));
  expect(input.editor).toEqual({ text: 'a ', cursor: 2 });
  expect(input.heldPasteCount).toBe(0);
});

test('Delete right before the token removes all of it; ordinary characters still delete one by one', () => {
  const input = composerWithPaste('ab', 'cd');
  input.setEditor({ text: input.editor.text, cursor: 2 });
  input.applyKey(key('delete'));
  expect(input.editor).toEqual({ text: 'abcd', cursor: 2 });
  input.applyKey(key('delete'));
  expect(input.editor).toEqual({ text: 'abd', cursor: 2 });
});

test('←/→ step over the token; the cursor never lands inside it', () => {
  const text = `x${TOKEN}y`;
  const end = 1 + TOKEN.length;
  expect(applyComposerKey({ text, cursor: end }, key('left')).state.cursor).toBe(1);
  expect(applyComposerKey({ text, cursor: 1 }, key('right')).state.cursor).toBe(end);
  // Outside the token the arrows move one character as before.
  expect(applyComposerKey({ text, cursor: 1 }, key('left')).state.cursor).toBe(0);
  expect(applyComposerKey({ text, cursor: end }, key('right')).state.cursor).toBe(end + 1);
  // A cursor somehow inside snaps out whole: Backspace/Delete remove the token, arrows go to its edges.
  expect(applyComposerKey({ text, cursor: 5 }, key('backspace')).state).toEqual({ text: 'xy', cursor: 1 });
  expect(applyComposerKey({ text, cursor: 5 }, key('delete')).state).toEqual({ text: 'xy', cursor: 1 });
  // Ctrl+← keeps its word jump.
  expect(applyComposerKey({ text, cursor: end }, key('left', { ctrl: true })).state.cursor).not.toBe(1);
});

test('typed text that merely looks like a token is not folded text and still edits per character', () => {
  const look = '[Paste #9 · 2 lines · ful text]';
  expect(pasteTokenRanges(look)).toEqual([]);
  expect(applyComposerKey({ text: look, cursor: look.length }, key('backspace')).state.text).toBe(look.slice(0, -1));
});
