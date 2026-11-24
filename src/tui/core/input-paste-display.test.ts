import { expect, test } from 'bun:test';
import { createPasteFold } from '../../chat/paste-fold.js';
import { createNextTuiCoreInput } from './input.js';

test('next prompt hides paste character count while classic keeps its existing token', () => {
  const raw = 'a\nb\nc\nd';
  const next = createNextTuiCoreInput();
  expect(next.foldPaste(raw)).toBe('[Paste #1 · +4 lines · full text]');
  expect(createPasteFold(() => {}).fold(raw)).toBe('[붙여넣음 #1 · 4줄 · 7자]');
});

test('two next pastes remain distinct and submit the original bytes in order', () => {
  const first = 'one\ntwo\nthree\nfour';
  const second = 'five\nsix\nseven\neight';
  const input = createNextTuiCoreInput();
  const firstToken = input.foldPaste(first);
  const secondToken = input.foldPaste(second);
  expect(firstToken).not.toBe(secondToken);
  input.setText(`${firstToken} ${secondToken}`);
  expect(input.expandSubmission(input.editor.text, [])).toBe(`${first} ${second}`);
  expect(input.heldPasteCount).toBe(0);
});

test('a deleted next paste cannot expand later', () => {
  const input = createNextTuiCoreInput();
  const token = input.foldPaste('a\nb\nc\nd');
  input.setText('');
  expect(input.retainLivePasteTokens([input.editor.text])).toBe(1);
  expect(input.expandSubmission(token, [])).toBe(token);
});

test('next folds at three lines or 300 characters without changing short paste', () => {
  const input = createNextTuiCoreInput();
  expect(input.foldPaste('one\ntwo')).toBe('one\ntwo');
  expect(input.foldPaste('x'.repeat(299))).toBe('x'.repeat(299));
  expect(input.foldPaste('one\ntwo\nthree')).toBe('[Paste #1 · +3 lines · full text]');
  const raw = 'x'.repeat(300);
  const token = input.foldPaste(raw);
  expect(token).toBe('[Paste #2 · +1 lines · full text]');
  expect(input.expandSubmission(token, [])).toBe(raw);
});
