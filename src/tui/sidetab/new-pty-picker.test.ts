import { expect, test } from 'bun:test';
import { NEW_PTY_CHOICES, newPtyPickerKey } from './new-pty-picker.js';

test('only a plain choice letter spawns; Esc closes; every other key passes through to the composer', () => {
  for (const [letter, character] of Object.entries(NEW_PTY_CHOICES)) expect(newPtyPickerKey({ name: letter })).toEqual({ kind: 'spawn', character });
  expect(newPtyPickerKey({ name: 'escape' })).toEqual({ kind: 'close' });
  // The friction from HERDR-REPLACE-AUDIT: «/side send …» typed right after «/side new».
  for (const name of ['/', 'x', 'enter', 'up', 'space', 'backspace']) expect(newPtyPickerKey({ name })).toEqual({ kind: 'pass' });
  // A choice letter with a modifier is a shortcut, not a pick.
  expect(newPtyPickerKey({ name: 's', ctrl: true })).toEqual({ kind: 'pass' });
  expect(newPtyPickerKey({ name: 'c', alt: true })).toEqual({ kind: 'pass' });
});
