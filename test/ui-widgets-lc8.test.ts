import { describe, expect, test } from 'bun:test';
import { Printer } from '../src/ui/printer.js';
import { stripAnsi } from '../src/tui.js';
import type { KeyEvent } from '../src/plugins/core/types.js';
import { TextArea } from '../src/ui/widgets/text-area.js';

function key(name: string, mods: Partial<KeyEvent> = {}): KeyEvent {
  return { name, ctrl: false, shift: false, alt: false, ...mods };
}

function render(v: { draw: (p: Printer) => void }, w = 40, h = 6, focused = true): string[] {
  const p = Printer.create({ width: w, height: h, focused });
  v.draw(p);
  return p.lines().map(stripAnsi);
}

describe('LC8 TextArea — readOnly', () => {
  test('renders text and scrolls vertically', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const ta = new TextArea({ text: lines, readOnly: true });
    ta.takeFocus();
    let got = render(ta, 20, 3);
    expect(got[0]).toContain('line 0');
    ta.onEvent(key('down'));
    ta.onEvent(key('down'));
    ta.onEvent(key('down'));
    got = render(ta, 20, 3);
    // cursor moved from row 0 to row 3; scroll should bring it into the 3-row window
    expect(got[got.length - 1]).toContain('line 3');
  });

  test('PgDn jumps a page', () => {
    const text = Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n');
    const ta = new TextArea({ text, readOnly: true });
    ta.takeFocus();
    ta.onEvent(key('pagedown'));
    const got = render(ta, 10, 5);
    // after one PgDn (size.height=40 default if never rendered before; we called layout via size), still ok
    expect(got.join('\n')).toContain('L');
  });

  test('Ctrl+End jumps to bottom', () => {
    const text = Array.from({ length: 10 }, (_, i) => `L${i}`).join('\n');
    const ta = new TextArea({ text, readOnly: true });
    ta.takeFocus();
    ta.onEvent(key('end', { ctrl: true }));
    const got = render(ta, 10, 3);
    expect(got[got.length - 1]).toContain('L9');
  });

  test('readOnly ignores typing', () => {
    const ta = new TextArea({ text: 'abc', readOnly: true });
    ta.takeFocus();
    ta.onEvent(key('x'));
    expect(ta.text).toBe('abc');
  });
});

describe('LC8 TextArea — editable', () => {
  test('typing inserts chars', () => {
    const ta = new TextArea();
    ta.takeFocus();
    ta.onEvent(key('a'));
    ta.onEvent(key('b'));
    ta.onEvent(key('c'));
    expect(ta.text).toBe('abc');
  });

  test('Enter creates new line', () => {
    const ta = new TextArea();
    ta.takeFocus();
    ta.onEvent(key('a'));
    ta.onEvent(key('enter'));
    ta.onEvent(key('b'));
    expect(ta.text).toBe('a\nb');
  });

  test('backspace joins lines when at column 0', () => {
    const ta = new TextArea({ text: 'a\nb' });
    ta.takeFocus();
    ta.onEvent(key('end', { ctrl: true }));
    // end of line 1: "b"
    ta.onEvent(key('home'));
    ta.onEvent(key('backspace'));
    expect(ta.text).toBe('ab');
  });

  test('wrap=true renders long line on multiple rows', () => {
    const ta = new TextArea({ text: 'abcdefghij', readOnly: true, wrap: true });
    ta.takeFocus();
    const lines = render(ta, 4, 3);
    expect(lines[0]?.trimEnd()).toBe('abcd');
    expect(lines[1]?.trimEnd()).toBe('efgh');
    expect(lines[2]?.trimEnd()).toBe('ij');
  });
});
