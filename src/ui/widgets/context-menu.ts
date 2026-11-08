// LC9 — ContextMenu: floating menu at a given anchor.
//
// Triggered by chord key or mouse right-click (hosts that have
// mouse). The menu is placed near its anchor point but is clipped
// to the host printer so it never spills off-screen. Submenus are
// collapsed into SelectView options with action closures.
//
// Responsibility split: computing the anchor is the host's job.
// `computePlacement()` returns the (x, y, w, h) rectangle the host
// should feed its ModalSurface — taking into account terminal
// edges.

import type { KeyEvent } from '../../plugins/core/types.js';
import {
  type ThemeTokens,
} from '../../theme/tokens.js';
import type { WidgetChromeSpec } from '../declarative/spec.js';
import { resolveWidgetChromeBoxViewOptions } from '../declarative/presentation.js';
import { resolvePickerChromePresentation } from '../chrome/picker-chrome.js';
import type { Printer } from '../printer.js';
import { BoxView, type View, type EventResult, type FocusSource, type Size } from '../view.js';
import { SelectView, type SelectOption } from './select-view.js';

export interface ContextMenuItem<T> {
  value: T;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onRun?: () => void;
}

export interface ContextMenuSpec<T> {
  items: ContextMenuItem<T>[];
  title?: string;
  onPick: (value: T) => void;
  onCancel?: () => void;
  /** U2 Bundle B — let context menus ride the same SelectView token
   *  family as the other popup widgets. */
  theme?: ThemeTokens;
  /** Declarative chrome override from widget-spec/IUL vocabulary. */
  chromeSpec?: WidgetChromeSpec;
}

export class ContextMenu<T> implements View {
  private root: View;

  constructor(spec: ContextMenuSpec<T>) {
    const presentation = resolvePickerChromePresentation({
      title: spec.title ?? 'Actions',
      primaryAction: 'pick',
      browseMode: false,
      filterable: false,
      chromeSpec: {
        titleAlign: 'center',
        ...spec.chromeSpec,
      },
    });
    const options: SelectOption<T>[] = spec.items.map(i => ({
      value: i.value,
      label: i.label,
      shortcut: i.shortcut,
      disabled: i.disabled,
      action: i.onRun,
    }));
    const select = new SelectView<T>({
      options,
      visibleRows: Math.min(options.length, 10),
      browseMode: false,
      footerHint: presentation.footerHint,
      onSubmit: v => spec.onPick(v as T),
      onCancel: spec.onCancel,
      theme: spec.theme,
    });
    this.root = new BoxView(
      select,
      resolveWidgetChromeBoxViewOptions(
        spec.theme,
        presentation.chromeSpec,
        spec.title ?? 'Actions',
      ),
    );
  }

  draw(p: Printer): void { this.root.draw(p); }
  onEvent(ev: KeyEvent): EventResult {
    // 2026-05-05 — ev.name 이 'arrowup' / 'arrowdown' / 'arrowleft' /
    // 'arrowright' 같은 raw 변종으로 도착하는 환경 대응. SelectView
    // 는 'up'/'down'/'left'/'right' 만 처리하므로 alias 를 여기서
    // 정규화해 forward 한다 (SelectView 자체는 다른 widget 도 사용해
    // 건드리지 않는다).
    const normalized = normalizeArrowKey(ev.name);
    if (normalized !== ev.name) {
      return this.root.onEvent({ ...ev, name: normalized });
    }
    return this.root.onEvent(ev);
  }
  onMouse(ev: import('../mouse-events.js').MouseEvent): EventResult {
    return this.root.onMouse?.(ev) ?? { kind: 'ignored' };
  }
  layout(s: Size): void { this.root.layout(s); }
  requiredSize(c: Size): Size { return this.root.requiredSize(c); }
  takeFocus(src?: FocusSource): boolean { return this.root.takeFocus(src); }
}

function normalizeArrowKey(name: string): string {
  switch (name) {
    case 'arrowup':
    case 'ArrowUp':
    case 'arrow-up':
      return 'up';
    case 'arrowdown':
    case 'ArrowDown':
    case 'arrow-down':
      return 'down';
    case 'arrowleft':
    case 'ArrowLeft':
    case 'arrow-left':
      return 'left';
    case 'arrowright':
    case 'ArrowRight':
    case 'arrow-right':
      return 'right';
    default:
      return name;
  }
}

/** Given an anchor (x, y) in the host printer's coordinates plus
 *  the desired menu size, clamp the placement so the menu fits
 *  entirely inside the host's bounds. Preferred placement is
 *  below-right of the anchor; falls back to above/left when clipped. */
export function computePlacement(
  anchor: { x: number; y: number },
  menu: { width: number; height: number },
  host: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const w = Math.min(menu.width, host.width);
  const h = Math.min(menu.height, host.height);

  // Horizontal: prefer starting at anchor.x; if it would spill right, shift left.
  let x = anchor.x;
  if (x + w > host.width) x = Math.max(0, host.width - w);

  // Vertical: prefer just below anchor; if it would spill down, place above.
  let y = anchor.y + 1;
  if (y + h > host.height) {
    // try above
    y = anchor.y - h;
    if (y < 0) y = Math.max(0, host.height - h);
  }
  return { x, y, width: w, height: h };
}
