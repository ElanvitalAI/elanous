import { describe, expect, test } from 'bun:test';

import { splitKeys } from '../src/tui.js';
import { textInput } from '../src/chat/index.js';
import { resolveTextInputTextAction } from '../src/chat/input-text-key.js';
import { applyTurnTypeaheadKey } from '../src/chat/turn-typeahead.js';

describe('D1e-2c TUI edit-key wiring', () => {
  const parsed = (sequence: string) => {
    const [key] = splitKeys(sequence);
    expect(key).toBeDefined();
    return key!;
  };

  test('decodes modified arrows and bare Delete while preserving Shift arrows', () => {
    expect(parsed('\x1b[1;5D')).toMatchObject({ name: 'left', ctrl: true, shift: false, alt: false });
    expect(parsed('\x1b[1;5A')).toMatchObject({ name: 'up', ctrl: true, shift: false, alt: false });
    expect(parsed('\x1b[3~')).toMatchObject({ name: 'delete', ctrl: false, shift: false });
    for (const [sequence, name] of [
      ['\x1b[1;2A', 'up'], ['\x1b[1;2B', 'down'],
      ['\x1b[1;2C', 'right'], ['\x1b[1;2D', 'left'],
    ] as const) {
      expect(parsed(sequence)).toMatchObject({ name, shift: true, ctrl: false, alt: false });
    }
    expect(parsed('\x1b[1;3A')).toMatchObject({ name: 'up', alt: true, ctrl: false, shift: false });
    expect(parsed('\x1b[3;5~')).toMatchObject({ name: 'delete', ctrl: true });
  });

  test('Ctrl+W removes the previous word', () => {
    expect(resolveTextInputTextAction({ text: 'abc def', cursor: 7 }, parsed('\x17'))).toEqual({
      kind: 'insert', next: { text: 'abc ', cursor: 4 },
    });
  });

  test('Ctrl+Left then text inserts at the previous word boundary; Ctrl+Right moves forward', () => {
    const moved = resolveTextInputTextAction({ text: 'abc def', cursor: 7 }, parsed('\x1b[1;5D'));
    expect(moved).toEqual({ kind: 'insert', next: { text: 'abc def', cursor: 4 } });
    if (moved.kind !== 'insert') throw new Error('Ctrl+Left was not handled');
    expect(resolveTextInputTextAction(moved.next, parsed('X'))).toEqual({
      kind: 'insert', next: { text: 'abc Xdef', cursor: 5 },
    });
    expect(resolveTextInputTextAction({ text: 'abc def', cursor: 4 }, parsed('\x1b[1;5C'))).toEqual({
      kind: 'insert', next: { text: 'abc def', cursor: 7 },
    });
  });

  test('bare Delete removes the character at the cursor', () => {
    expect(resolveTextInputTextAction({ text: 'abc', cursor: 1 }, parsed('\x1b[3~'))).toEqual({
      kind: 'insert', next: { text: 'ac', cursor: 1 },
    });
  });

  test('Ctrl+Up reaches the streaming recall key path', () => {
    expect(applyTurnTypeaheadKey(
      { buffer: 'draft ', queuedSubmissions: ['queued'] }, parsed('\x1b[1;5A'),
    )).toMatchObject({ consumed: true, changed: true, state: { buffer: 'draft queued', queuedSubmissions: [] } });
  });

  test('textInput routes Ctrl+Left to the word boundary before inserting', async () => {
    const keys = splitKeys('\x1b[1;5DX\r');
    const result = await textInput({
      row: 1, col: 1, width: 80, initialText: 'abc def',
      readKey: async () => keys.shift()!,
    });
    expect(result).toMatchObject({ text: 'abc Xdef', submitted: true });

    const rightKeys = splitKeys('\x1b[1;5D\x1b[1;5CX\r');
    expect(await textInput({
      row: 1, col: 1, width: 80, initialText: 'abc def',
      readKey: async () => rightKeys.shift()!,
    })).toMatchObject({ text: 'abc defX', submitted: true });
  });

  test('textInput handles Ctrl+W and bare Delete in the actual key loop', async () => {
    const wordKeys = splitKeys('\x17X\r');
    const wordResult = await textInput({
      row: 1, col: 1, width: 80, initialText: 'abc def',
      readKey: async () => wordKeys.shift()!,
    });
    expect(wordResult).toMatchObject({ text: 'abc X', submitted: true });

    const keys = splitKeys('\x1b[D\x1b[D\x1b[3~\r');
    expect(await textInput({
      row: 1, col: 1, width: 80, initialText: 'abc',
      readKey: async () => keys.shift()!,
    })).toMatchObject({ text: 'ac', submitted: true });
  });

  test('other Ctrl combinations do not become text edits', () => {
    const state = { text: 'abc def', cursor: 7 };
    for (const sequence of ['\x02', '\x03', '\x15', '\x1b[1;5A', '\x1b[3;5~']) {
      expect(resolveTextInputTextAction(state, parsed(sequence))).toEqual({ kind: 'none' });
    }
  });
});
