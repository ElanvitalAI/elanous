import { expect, test } from 'bun:test';
import { MOUSE_RESIDUE_WINDOW_MS, MouseResidueGuard, applyComposerKey, composerViewport, emptyComposer, wheelDirection } from './composer.js';
import { createInlineEditorState } from '../../input-core/inline-editor.js';
import { KeyStreamParser, ansi, type Key } from '../../tui.js';

const typed = (text: string): Key[] => [...text].map((ch) => ({ name: ch, ctrl: false, shift: false, raw: ch }));

test('an SGR wheel event, even split across stdin chunks, is one wheel key and zero composer bytes', () => {
  const parser = new KeyStreamParser();
  const up = parser.push('\x1b[<64;10;5M');
  expect(up).toHaveLength(1);
  expect(wheelDirection(up[0]!)).toBe('up');
  // Partial receive: the CSI is held until its final byte arrives.
  expect(parser.push('\x1b[<6')).toEqual([]);
  const down = [...parser.push('5;10;5M')];
  expect(down).toHaveLength(1);
  expect(wheelDirection(down[0]!)).toBe('down');
  const draft = createInlineEditorState('abc');
  for (const key of [...up, ...down]) {
    const result = applyComposerKey(draft, key);
    expect(result.action).toBe('none');
    expect(result.state).toBe(draft);
  }
  expect(wheelDirection({ name: 'up', ctrl: false, shift: false })).toBeNull();
  expect(wheelDirection({ name: 'mouse', ctrl: false, shift: false, mouse: { row: 1, col: 1, type: 'click' } })).toBeNull();
});

test('mouse residue after a timed-out ESC is swallowed and reported as the wheel it was', () => {
  const guard = new MouseResidueGuard();
  expect(guard.accept(typed('x')[0]!, 0)).toEqual({ kind: 'pass' });
  guard.arm(1_000);
  const keys = typed('[<65;10;5M');
  for (const key of keys.slice(0, -1)) expect(guard.accept(key, 1_010)).toEqual({ kind: 'hold' });
  expect(guard.accept(keys.at(-1)!, 1_010)).toEqual({ kind: 'mouse', wheel: 'down' });
  // Disarmed after the sequence: ordinary typing passes straight through.
  expect(guard.accept(typed('[')[0]!, 1_020)).toEqual({ kind: 'pass' });

  guard.arm(2_000);
  const up = typed('[<64;3;4M');
  for (const key of up.slice(0, -1)) guard.accept(key, 2_005);
  expect(guard.accept(up.at(-1)!, 2_005)).toEqual({ kind: 'mouse', wheel: 'up' });

  // The tail may trail its ESC by far more than the pause limit (slow link): still swallowed.
  guard.arm(10_000);
  const late = typed('[<65;10;5M');
  for (const key of late.slice(0, -1)) expect(guard.accept(key, 10_000 + 5 * MOUSE_RESIDUE_WINDOW_MS)).toEqual({ kind: 'hold' });
  expect(guard.accept(late.at(-1)!, 10_000 + 5 * MOUSE_RESIDUE_WINDOW_MS)).toEqual({ kind: 'mouse', wheel: 'down' });

  guard.arm(3_000);
  const click = typed('[<0;3;4m');
  for (const key of click.slice(0, -1)) guard.accept(key, 3_005);
  expect(guard.accept(click.at(-1)!, 3_005)).toEqual({ kind: 'mouse', wheel: null });
});

test('text after ESC that is not mouse residue is released in order, nothing lost', () => {
  const guard = new MouseResidueGuard();
  guard.arm(0);
  const [bracket, a] = typed('[a');
  expect(guard.accept(bracket!, 5)).toEqual({ kind: 'hold' });
  expect(guard.accept(a!, 6)).toEqual({ kind: 'release', keys: [bracket, a] });
  // A pause longer than the limit *inside* a held tail releases it as typing.
  guard.arm(0);
  const [b2, lt] = typed('[<');
  expect(guard.accept(b2!, 10)).toEqual({ kind: 'hold' });
  expect(guard.accept(lt!, 10 + MOUSE_RESIDUE_WINDOW_MS + 1)).toEqual({ kind: 'release', keys: [b2, lt] });
  // A wake key (no text) releases a held character instead of keeping it until the next keystroke.
  guard.arm(0);
  const wake: Key = { name: '', ctrl: false, shift: false, raw: '' };
  expect(guard.accept(bracket!, 1)).toEqual({ kind: 'hold' });
  expect(guard.accept(wake, MOUSE_RESIDUE_WINDOW_MS)).toEqual({ kind: 'release', keys: [bracket, wake] });
  // Control keys are never residue.
  guard.arm(0);
  expect(guard.accept({ name: 'q', ctrl: true, shift: false }, 1)).toEqual({ kind: 'pass' });
});

test('turning the TUI off disables every mouse mode it turned on', () => {
  const modes = (sequence: string, flag: 'h' | 'l') => [...sequence.matchAll(new RegExp(`\\x1b\\[\\?(\\d+)${flag}`, 'g'))].map((m) => m[1]).sort();
  const previous = process.env.ELANOUS_MOUSE_HOVER;
  try {
    for (const hover of [undefined, '1']) {
      if (hover === undefined) delete process.env.ELANOUS_MOUSE_HOVER;
      else process.env.ELANOUS_MOUSE_HOVER = hover;
      const on = modes(ansi.mouseOn, 'h');
      expect(on).toContain('1000');
      expect(on).toContain('1006');
      expect(modes(ansi.mouseOff, 'l')).toEqual(on);
    }
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_MOUSE_HOVER;
    else process.env.ELANOUS_MOUSE_HOVER = previous;
  }
});

test('Korean input can be edited, cancelled, and submitted without quitting', () => {
  let state = emptyComposer();
  state = applyComposerKey(state, { name: '안', ctrl: false, shift: false }).state;
  state = applyComposerKey(state, { name: '녕', ctrl: false, shift: false }).state;
  expect(state.text).toBe('안녕');
  expect(applyComposerKey(state, { name: 'escape', ctrl: false, shift: false }).action).toBe('cancel');
  state = applyComposerKey(state, { name: 'backspace', ctrl: false, shift: false }).state;
  expect(applyComposerKey(state, { name: 'enter', ctrl: false, shift: false })).toMatchObject({
    action: 'submit', submitted: '안', state: { text: '' },
  });
  expect(applyComposerKey(emptyComposer(), { name: 'c', ctrl: true, shift: false }).action).toBe('quit');
  expect(applyComposerKey(emptyComposer(), { name: 'escape', ctrl: false, shift: false }).action).toBe('none');
});

test('long input and backspace keep the current edit position visible at 20 columns', () => {
  const full = createInlineEditorState('abcdefghijklmnopqrstuvwxy');
  const before = composerViewport(full, 20);
  expect(Bun.stringWidth(before.line)).toBeLessThanOrEqual(20);
  expect(before.line).toContain('y');
  expect(before.cursorCol).toBeLessThanOrEqual(20);
  const after = composerViewport(applyComposerKey(full, { name: 'backspace', ctrl: false, shift: false }).state, 20);
  expect(after.line).not.toContain('y');
  expect(after.line).toContain('x');
});
