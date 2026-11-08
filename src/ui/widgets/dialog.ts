// LC7 — Dialog widget.
//
// A bordered modal container with a title, an optional body view,
// and a row of buttons along the bottom. Focus cycles body ↔ buttons
// via Tab; Left/Right moves between buttons; Enter on the focused
// button fires its value through onSubmit. Esc calls onCancel.
//
// Structurally this is:
//   BoxView(border, title)
//     LinearLayout.vertical(
//       body,                      // flex
//       ButtonBar (horizontal),    // size: 1
//     )
//
// Buttons can declare shortcut letters that trigger them directly
// regardless of focus (modal key capture), matching the
// claude-code-fork PermissionPrompt ergonomics.
//
// IDX-6 Phase 4 (2026-04-19): optional ThemeTokens propagate to the
// Button children and to the BoxView border via ansiForPair. When
// absent, the legacy un-themed rendering is preserved.

import type { KeyEvent } from '../../plugins/core/types.js';
import {
  ansiForPair,
  DEFAULT_WIDGET_TOKENS,
  resolveWidgetTokens,
  type ThemeTokens,
} from '../../theme/tokens.js';
import { DEFAULT_CLOSE_GLYPH } from '../chrome/control-glyphs.js';
import type { WidgetChromeSpec } from '../declarative/spec.js';
import { resolveWidgetChromeBoxViewOptions } from '../declarative/presentation.js';
import { resolveModalChromeBoxOptions } from '../chrome/modal-chrome-box.js';
import { BoxView, TextView, Consumed, Ignored, type EventResult, type FocusSource, type Size, type View } from '../view.js';
import type { Printer } from '../printer.js';
import { LinearLayout } from '../layout/linear.js';
import { Button, type ButtonStyle } from './button.js';
import { cycleCursor } from './selection-cursor.js';

export interface DialogButtonSpec<T> {
  label: string;
  value: T;
  shortcut?: string;
  style?: ButtonStyle;
}

export interface DialogSpec<T> {
  title?: string;
  /** Optional body view; a plain string wraps into TextView. */
  body?: View | string;
  buttons: DialogButtonSpec<T>[];
  onSubmit: (value: T) => void;
  onCancel?: () => void;
  /** IDX-6 Phase 4 — optional theme tokens. Propagates to the
   *  button bar children + decorates the BoxView border. */
  theme?: ThemeTokens;
  /** U3 Bundle B — opt into the static window-chrome rail for the
   *  outer frame. Default keeps the legacy dialog frame so existing
   *  consumers and tests stay byte-stable. */
  chrome?: 'legacy' | 'static';
  /** Declarative chrome override from the YAML/widget-spec track. */
  chromeSpec?: WidgetChromeSpec;
}

export class Dialog<T> implements View {
  private root: View;
  private inner: LinearLayout;
  private buttonBar: ButtonBar<T>;
  private bodyView: View | null;

  constructor(private spec: DialogSpec<T>) {
    const dialogTokens = spec.theme
      ? resolveWidgetTokens(spec.theme, 'dialog')
      : null;
    const chromeTokens = spec.theme && spec.chrome === 'static'
      ? (spec.theme.widgetTokens?.modalChrome ?? DEFAULT_WIDGET_TOKENS.modalChrome ?? null)
      : null;
    const borderStyle = dialogTokens ? ansiForPair(dialogTokens.border) : '';
    const titleStyle = dialogTokens ? ansiForPair(dialogTokens.title) : '';

    this.bodyView = spec.body
      ? (typeof spec.body === 'string'
          ? new TextView(dialogTokens
            ? `${ansiForPair(dialogTokens.body)}${spec.body}\x1b[0m`
            : spec.body)
          : spec.body)
      : null;

    this.buttonBar = new ButtonBar(
      spec.buttons.map(b => new Button({
        label: b.label,
        shortcut: b.shortcut,
        style: b.style,
        onClick: () => spec.onSubmit(b.value),
        theme: spec.theme,
        // IDX-F5c — emit `{kind:'button', buttonId}` payload so the
        // modal-adapter refines ev.hitTarget to `{kind:'modal-button',
        // modalId, buttonId}`. buttonId derives from the dialog's
        // own `value`, falling back to the label when value isn't a
        // string — keeps the id stable across re-renders.
        buttonId: typeof b.value === 'string' ? b.value : b.label,
      })),
    );

    if (this.bodyView) {
      this.inner = LinearLayout.vertical(
        { view: this.bodyView },                   // flex
        { view: this.buttonBar, size: 1 },
      );
    } else {
      this.inner = LinearLayout.vertical(
        { view: this.buttonBar, size: 1 },
      );
    }

    // IDX-6 Phase 4 — when a theme is supplied, the BoxView border
    // + title use the dialog token's border pair. Legacy callers
    // (no theme) render with the terminal default styling.
    this.root = new BoxView(
      this.inner,
      spec.chromeSpec
        ? resolveWidgetChromeBoxViewOptions(spec.theme, spec.chromeSpec, spec.title ?? '')
        : chromeTokens
          ? resolveModalChromeBoxOptions(chromeTokens, {
              title: spec.title ?? '',
              titleRight: DEFAULT_CLOSE_GLYPH,
            })
          : {
              border: true,
              title: spec.title,
              titleStyle,
              style: borderStyle,
            },
    );
  }

  draw(p: Printer): void { this.root.draw(p); }

  onEvent(ev: KeyEvent): EventResult {
    // Shortcut letters capture first (regardless of focus).
    if (!ev.ctrl && !ev.alt && ev.name.length === 1) {
      for (const b of this.spec.buttons) {
        if (b.shortcut && b.shortcut.toLowerCase() === ev.name.toLowerCase()) {
          this.spec.onSubmit(b.value);
          return Consumed();
        }
      }
    }
    if (ev.name === 'escape') {
      this.spec.onCancel?.();
      return Consumed();
    }
    return this.root.onEvent(ev);
  }

  layout(size: Size): void { this.root.layout(size); }
  requiredSize(c: Size): Size { return this.root.requiredSize(c); }
  takeFocus(src?: FocusSource): boolean { return this.root.takeFocus(src); }
}

// ── ButtonBar ────────────────────────────────────────────────────
// Horizontal layout that right-aligns its buttons with single-cell
// separators. Left/Right arrows move focus; unfocused buttons render
// dim. We build this as a plain View (not LinearLayout.horizontal)
// so we fully control the right-alignment and separator rendering.

class ButtonBar<T> implements View {
  private focusIdx = 0;

  constructor(private buttons: Button[]) {
    if (buttons.length > 0) buttons[0]!.takeFocus('front');
  }

  draw(p: Printer): void {
    if (this.buttons.length === 0) return;
    const widths = this.buttons.map(b => b.requiredSize({ width: p.width, height: 1 }).width);
    const sepWidth = 1;
    const total = widths.reduce((a, b) => a + b, 0) + sepWidth * (this.buttons.length - 1);
    let x = Math.max(0, p.width - total);
    for (let i = 0; i < this.buttons.length; i++) {
      const w = widths[i]!;
      this.buttons[i]!.draw(p.sub(x, 0, w, 1, { focused: p.focused }));
      x += w + sepWidth;
    }
  }

  onEvent(ev: KeyEvent): EventResult {
    if (this.buttons.length === 0) return Ignored;
    const focused = this.buttons[this.focusIdx]!;
    const r = focused.onEvent(ev);
    if (r.kind === 'consumed') return r;

    if (ev.name === 'left')  { if (this.moveFocus(-1)) return Consumed(); }
    if (ev.name === 'right') { if (this.moveFocus(+1)) return Consumed(); }
    if (ev.name === 'tab')   { if (this.moveFocus(ev.shift ? -1 : +1)) return Consumed(); }
    return Ignored;
  }

  private moveFocus(delta: number): boolean {
    const n = this.buttons.length;
    if (n <= 1) return false;
    const next = cycleCursor(this.focusIdx, n, delta);
    if (next === this.focusIdx) return false;
    this.buttons[this.focusIdx]!.blur();
    this.focusIdx = next;
    this.buttons[next]!.takeFocus(delta > 0 ? 'front' : 'back');
    return true;
  }

  layout(_size: Size): void { /* buttons use requiredSize at draw time */ }

  requiredSize(constraint: Size): Size {
    let w = 0;
    for (const b of this.buttons) {
      w += b.requiredSize(constraint).width + 1;
    }
    return {
      width: Math.min(constraint.width, Math.max(0, w - 1)),
      height: Math.min(constraint.height, 1),
    };
  }

  takeFocus(src?: FocusSource): boolean {
    if (this.buttons.length === 0) return false;
    this.buttons[this.focusIdx]!.blur();
    this.focusIdx = src === 'back' ? this.buttons.length - 1 : 0;
    this.buttons[this.focusIdx]!.takeFocus(src);
    return true;
  }
}
