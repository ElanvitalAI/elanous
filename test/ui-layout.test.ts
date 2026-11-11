import { describe, expect, test } from 'bun:test';
import { TextView, BoxView, Consumed, Ignored, type View } from '../src/ui/view.js';
import { LinearLayout } from '../src/ui/layout/linear.ts';
import { Printer } from '../src/ui/printer.js';
import { stripAnsi } from '../src/tui.js';

function mkFocusable(label: string, consumed: string[] = []): View {
  return {
    draw(p) { p.text(0, 0, label); },
    onEvent(ev) { if (consumed.includes(ev.name)) return Consumed(); return Ignored; },
    layout() {},
    requiredSize(c) { return { width: Math.min(c.width, label.length), height: 1 }; },
    takeFocus() { return true; },
  };
}

describe('LC5 BoxView', () => {
  test('BoxView renders focused right-side title glyph without clobbering title', () => {
    const v = new BoxView(new TextView('hi'), {
      border: true,
      title: 'Window',
      titleRight: '✕',
      style: '\x1b[38;2;88;91;112m',
      focusedStyle: '\x1b[38;2;137;180;250m',
      titleStyle: '\x1b[38;2;205;214;244m',
      focusedTitleRightStyle: '\x1b[38;2;243;139;168m',
    });
    const p = Printer.create({ width: 18, height: 3, focused: true });
    v.draw(p);
    const lines = p.lines();
    expect(stripAnsi(lines[0]!)).toContain(' Window ');
    expect(stripAnsi(lines[0]!)).toContain(' ✕ ');
    expect(lines[0]!).toContain('\x1b[38;2;243;139;168m');
  });
});

describe('LC5 LinearLayout', () => {
  test('vertical layout stacks children top-to-bottom with flex share', () => {
    const l = LinearLayout.vertical(
      new TextView('A'),
      new TextView('B'),
      new TextView('C'),
    );
    const p = Printer.create({ width: 3, height: 3 });
    l.layout({ width: 3, height: 3 });
    l.draw(p);
    const lines = p.lines().map(stripAnsi);
    expect(lines[0]).toBe('A  ');
    expect(lines[1]).toBe('B  ');
    expect(lines[2]).toBe('C  ');
  });

  test('horizontal layout places children left-to-right', () => {
    const l = LinearLayout.horizontal(
      { view: new TextView('AA'), size: 2 },
      { view: new TextView('BB'), size: 2 },
    );
    const p = Printer.create({ width: 4, height: 1 });
    l.layout({ width: 4, height: 1 });
    l.draw(p);
    expect(stripAnsi(p.lines()[0]!)).toBe('AABB');
  });

  test('fixed + flex mix: fixed consumes first, flex shares the rest', () => {
    const l = LinearLayout.vertical(
      { view: new TextView('H'), size: 1 },
      new TextView('body'),
      { view: new TextView('F'), size: 1 },
    );
    const p = Printer.create({ width: 6, height: 4 });
    l.layout({ width: 6, height: 4 });
    l.draw(p);
    const lines = p.lines().map(stripAnsi);
    expect(lines[0]).toBe('H     ');
    expect(lines[1]).toBe('body  ');
    expect(lines[2]).toBe('      ');
    expect(lines[3]).toBe('F     ');
  });

  test('takeFocus cascades to first focusable child', () => {
    const l = LinearLayout.vertical(
      new TextView('ignored'),
      mkFocusable('B'),
      mkFocusable('C'),
    );
    expect(l.takeFocus('front')).toBe(true);
    expect((l.focusedChild() as any)).toBeTruthy();
  });

  test('down/up moves focus between focusable children', () => {
    const a = mkFocusable('A');
    const b = mkFocusable('B');
    const l = LinearLayout.vertical(a, b);
    l.takeFocus('front');
    // initially on a. down → b.
    const r1 = l.onEvent({ name: 'down' });
    expect(r1.kind).toBe('consumed');
    expect(l.focusedChild()).toBe(b);
    // up → a.
    const r2 = l.onEvent({ name: 'up' });
    expect(r2.kind).toBe('consumed');
    expect(l.focusedChild()).toBe(a);
  });

  test('focused child that consumes prevents focus navigation', () => {
    const a = mkFocusable('A', ['down']);
    const b = mkFocusable('B');
    const l = LinearLayout.vertical(a, b);
    l.takeFocus('front');
    l.onEvent({ name: 'down' });
    // Focused child consumed, layout should NOT move focus.
    expect(l.focusedChild()).toBe(a);
  });
});
