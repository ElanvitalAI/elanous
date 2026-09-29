import { describe, expect, test } from 'bun:test';
import { stripAnsi } from '../src/tui.js';
import { Printer } from '../src/ui/printer.js';
import { createIulSidebarShellView } from '../src/iul/sidebar-shell.js';
import type { MouseEvent } from '../src/ui/mouse-events.js';

function mouse(type: MouseEvent['type'], x: number, y: number): MouseEvent {
  return { type, x, y, absX: x, absY: y };
}

describe('IUL sidebar shell', () => {
  test('shared view renders IUL title and first rail item', () => {
    const view = createIulSidebarShellView();
    view.layout({ width: 60, height: 14 });
    const printer = Printer.create({ width: 60, height: 14, focused: true });
    view.draw(printer);
    const out = printer.lines().map(stripAnsi).join('\n');
    expect(out).toContain('IUL UX Lab');
    expect(out).toContain('Test Lab');
    expect(out).toContain('YAML Editor');
    expect(out).toContain('Switch');
    expect(out).toContain('Theme:');
  });

  test('test lab theme picker opens on click in the theme strip', () => {
    const view = createIulSidebarShellView();
    view.layout({ width: 92, height: 20 });
    const res = view.onMouse(mouse('click', 70, 2));
    expect(res.kind).toBe('consumed');
  });

  test('test lab theme strip ignores mouse-down as a raw capture signal', () => {
    const view = createIulSidebarShellView();
    view.layout({ width: 92, height: 20 });
    const res = view.onMouse(mouse('mouse-down', 70, 2));
    expect(res.kind).toBe('consumed');
  });
});
