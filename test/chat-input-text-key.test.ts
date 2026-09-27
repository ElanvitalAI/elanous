import { describe, expect, test } from 'bun:test';

import { resolveTextInputTextAction } from '../src/chat/input-text-key.js';

describe('chat input text-key resolver', () => {
  test('accepts regular text, space, tab, and multi-byte input', () => {
    expect(resolveTextInputTextAction({ text: 'ab', cursor: 1 }, { name: 'x', ctrl: false, shift: false })).toEqual({
      kind: 'insert',
      next: { text: 'axb', cursor: 2 },
    });

    expect(resolveTextInputTextAction({ text: 'ab', cursor: 1 }, { name: 'space', ctrl: false, shift: false })).toEqual({
      kind: 'insert',
      next: { text: 'a b', cursor: 2 },
    });

    expect(resolveTextInputTextAction({ text: 'ab', cursor: 1 }, { name: 'tab', ctrl: false, shift: false })).toEqual({
      kind: 'insert',
      next: { text: 'a  b', cursor: 3 },
    });

    expect(resolveTextInputTextAction({ text: '', cursor: 0 }, { name: '한', ctrl: false, shift: false })).toEqual({
      kind: 'insert',
      next: { text: '한', cursor: 1 },
    });
  });

  test('ignores non-text named keys', () => {
    expect(resolveTextInputTextAction({ text: 'ab', cursor: 1 }, { name: 'left', ctrl: false, shift: false })).toEqual({
      kind: 'none',
    });
    expect(resolveTextInputTextAction({ text: 'ab', cursor: 1 }, { name: 'enter', ctrl: false, shift: false })).toEqual({
      kind: 'none',
    });
    expect(resolveTextInputTextAction({ text: 'ab', cursor: 1 }, { name: 'mouse', ctrl: false, shift: false })).toEqual({
      kind: 'none',
    });
  });

  test('ignores control-only edits that belong to other resolvers', () => {
    expect(resolveTextInputTextAction({ text: 'ab', cursor: 1 }, { name: 'u', ctrl: true, shift: false })).toEqual({
      kind: 'none',
    });
  });

  test('Ctrl+Left is now an editor word-navigation key rather than an ignored control', () => {
    expect(resolveTextInputTextAction({ text: 'ab', cursor: 1 }, { name: 'left', ctrl: true, shift: false })).toEqual({
      kind: 'insert', next: { text: 'ab', cursor: 0 },
    });
  });
});
