import { describe, expect, test } from 'bun:test';
import { Printer } from '../src/ui/printer.js';
import type { MouseEvent } from '../src/ui/mouse-events.js';
import { stripAnsi } from '../src/tui.js';
import type { KeyEvent } from '../src/plugins/core/types.js';
import { TextView, Ignored, type EventResult, type FocusSource, type Size, type View } from '../src/ui/view.js';
import { SidebarTabSurface } from '../src/ui/widgets/sidebar-tab-surface.js';

function key(name: string, mods: Partial<KeyEvent> = {}): KeyEvent {
  return { name, ctrl: false, shift: false, alt: false, ...mods };
}

function render(view: View, width = 56, height = 12, focused = true): string[] {
  view.layout({ width, height });
  const p = Printer.create({ width, height, focused });
  view.draw(p);
  return p.lines().map(stripAnsi);
}

class SpyDetailView implements View {
  public lastMouse: MouseEvent | null = null;
  public lastFocus: FocusSource | undefined;

  draw(p: Printer): void {
    p.text(0, 0, 'detail-body');
  }

  onEvent(): EventResult {
    return Ignored;
  }

  onMouse(ev: MouseEvent): EventResult {
    this.lastMouse = ev;
    return { kind: 'consumed' };
  }

  layout(_size: Size): void {}
  requiredSize(c: Size): Size { return { width: Math.min(c.width, 20), height: Math.min(c.height, 4) }; }
  takeFocus(source?: FocusSource): boolean {
    this.lastFocus = source;
    return true;
  }
}

class PassiveDetailView implements View {
  draw(p: Printer): void {
    p.text(0, 0, 'passive-detail');
  }

  onEvent(): EventResult {
    return Ignored;
  }

  layout(_size: Size): void {}
  requiredSize(c: Size): Size { return { width: Math.min(c.width, 20), height: Math.min(c.height, 4) }; }
  takeFocus(_source?: FocusSource): boolean {
    return true;
  }
}

describe('SidebarTabSurface', () => {
  test('renders left rail and active detail content', () => {
    const surface = new SidebarTabSurface({
      title: 'ACP Channels',
      railTitle: 'Channels',
      items: [
        { id: 'general', label: 'general', badge: '8', description: 'Running · codex', content: new TextView('General detail') },
        { id: 'ops', label: 'ops', content: new TextView('Ops detail') },
      ],
    });
    surface.takeFocus();
    const lines = render(surface);
    expect(lines[0]).toContain('ACP Channels');
    expect(lines[0]).toContain('Running · codex');
    expect(lines.join('\n')).toContain('Channels');
    expect(lines.join('\n')).toContain('general');
    expect(lines.join('\n')).toContain('General detail');
  });

  test('up/down changes active sidebar item and swapped detail', () => {
    const surface = new SidebarTabSurface({
      title: 'IUL',
      items: [
        { id: 'theme', label: 'Theme', content: new TextView('Theme detail') },
        { id: 'event', label: 'Event Lab', content: new TextView('Event detail') },
      ],
    });
    surface.takeFocus();
    surface.onEvent(key('down'));
    expect(surface.activeItem?.id).toBe('event');
    const lines = render(surface);
    expect(lines.join('\n')).toContain('Event detail');
  });

  test('tab moves focus into detail and esc returns focus to rail', () => {
    const detail = new SpyDetailView();
    const surface = new SidebarTabSurface({
      title: 'IUL',
      items: [{ id: 'theme', label: 'Theme', content: detail }],
    });
    surface.takeFocus();
    surface.onEvent(key('tab'));
    expect(detail.lastFocus).toBe('front');
    surface.onEvent(key('esc'));
    const lines = render(surface);
    expect(lines[lines.length - 1]).toContain('Enter detail');
  });

  test('mouse click on rail selects row and detail click is translated locally', () => {
    const detail = new SpyDetailView();
    const surface = new SidebarTabSurface({
      title: 'ACP Channels',
      railTitle: 'Channels',
      items: [
        { id: 'general', label: 'general', content: new TextView('General') },
        { id: 'ops', label: 'ops', content: detail },
      ],
    });
    surface.layout({ width: 56, height: 12 });
    surface.takeFocus();
    surface.onMouse({ type: 'click', x: 1, y: 3, absX: 1, absY: 3 });
    expect(surface.activeItem?.id).toBe('ops');

    surface.onEvent(key('tab'));
    surface.onMouse({ type: 'click', x: 30, y: 3, absX: 30, absY: 3 });
    expect(detail.lastMouse).not.toBeNull();
    expect(detail.lastMouse?.x).toBeGreaterThanOrEqual(0);
    expect(detail.lastMouse?.y).toBeGreaterThanOrEqual(0);
  });

  test('repeated detail click without a mouse handler is ignored after focus is already in detail', () => {
    const surface = new SidebarTabSurface({
      title: 'ACP Channels',
      items: [
        { id: 'general', label: 'general', content: new PassiveDetailView() },
      ],
    });
    surface.layout({ width: 56, height: 12 });
    surface.takeFocus();
    const first = surface.onMouse({ type: 'click', x: 30, y: 3, absX: 30, absY: 3 });
    expect(first.kind).toBe('consumed');
    const second = surface.onMouse({ type: 'click', x: 30, y: 3, absX: 30, absY: 3 });
    expect(second.kind).toBe('ignored');
  });

  test('double-click on rail can activate the selected item through callback seam', () => {
    const seen: string[] = [];
    const surface = new SidebarTabSurface({
      title: 'ACP Channels',
      railTitle: 'Channels',
      onActivateItem: (item, index, via) => { seen.push(`${via}:${index}:${item.id}`); },
      items: [
        { id: 'general', label: 'general', content: new TextView('General') },
        { id: 'ops', label: 'ops', content: new TextView('Ops') },
      ],
    });
    surface.layout({ width: 56, height: 12 });
    surface.takeFocus();
    surface.onMouse({ type: 'double-click', x: 1, y: 3, absX: 1, absY: 3 });
    expect(seen).toEqual(['double-click:1:ops']);
  });

  test('dragging a rail row can emit reorder intent through callback seam', () => {
    const seen: string[] = [];
    const surface = new SidebarTabSurface({
      title: 'ACP Channels',
      railTitle: 'Channels',
      onReorderItem: (fromIndex, toIndex, item) => { seen.push(`${fromIndex}->${toIndex}:${item.id}`); },
      items: [
        { id: 'general', label: 'general', content: new TextView('General') },
        { id: 'ops', label: 'ops', content: new TextView('Ops') },
        { id: 'hist', label: 'history', content: new TextView('History') },
      ],
    });
    surface.layout({ width: 56, height: 12 });
    surface.takeFocus();
    surface.onMouse({ type: 'click', x: 1, y: 4, absX: 1, absY: 4 });
    surface.onMouse({ type: 'drag', x: 1, y: 3, absX: 1, absY: 3 });
    surface.onMouse({ type: 'release', x: 1, y: 3, absX: 1, absY: 3 });
    expect(seen).toEqual(['2->1:hist']);
  });

  test('uses compact title and footer hints on narrow widths', () => {
    const surface = new SidebarTabSurface({
      title: 'ACP Channels',
      compactTitle: 'ACP',
      footerHint: '↑↓ switch channel · Enter detail · Tab focus swap',
      compactFooterHint: '↑↓ channel · ↵ detail · Tab swap',
      badgeMaxWidth: 5,
      items: [
        { id: 'general', label: 'general', badge: 'awaiting', content: new TextView('General detail') },
      ],
    });
    surface.takeFocus();
    const lines = render(surface, 32, 8);
    expect(lines[0]).toContain('ACP');
    expect(lines[0]).not.toContain('ACP Channels');
    expect(lines[0]).toContain('awai…');
    expect(lines[lines.length - 1]).toContain('↑↓ channel');
  });
});
