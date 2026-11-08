// LC10 — Tooltip: non-modal hint bubble.
//
// A small transient overlay that shows short help text at an anchor
// location. Unlike Dialog/SelectView, a Tooltip does NOT take focus
// and does NOT capture keys — it floats above other surfaces until
// its TTL expires or the host dismisses it. Hosts drive the TTL
// (`ttlMs`) by re-rendering and calling `isExpired()`.
//
// computeAnchor clips the tooltip to host bounds, preferring
// placement below-right of its anchor.
//
// IDX-6 round-2 (2026-04-19) — optional theme. When set, the faint
// `▕ ` prefix resolves from `semantic.muted` so the tooltip stays
// visually consistent with its sibling widgets after a /theme switch.

import type { KeyEvent } from '../../plugins/core/types.js';
import {
  paintPair,
  resolveSemantic,
  type ThemeTokens,
} from '../../theme/tokens.js';
import { C } from '../../tui.js';
import type { WidgetChromeSpec } from '../declarative/spec.js';
import { resolveWidgetChromeBoxViewOptions } from '../declarative/presentation.js';
import type { Printer } from '../printer.js';
import { cellWidth } from '../printer.js';
import { BoxView, Ignored, TextView, type EventResult, type FocusSource, type Size, type View } from '../view.js';

export interface TooltipSpec {
  text: string;
  ttlMs?: number;
  /** Optional monotonic-now supplier (for tests). Defaults to Date.now. */
  nowMs?: () => number;
  /** IDX-6 round-2 — optional theme tokens. Absent = legacy C.muted
   *  painter (backward compat). */
  theme?: ThemeTokens;
  /** Declarative overlay chrome for tooltip showcase / YAML-first path. */
  chromeSpec?: WidgetChromeSpec;
}

export class Tooltip implements View {
  private readonly bornAt: number;
  private readonly lines: string[];
  private readonly root: View | null;

  constructor(private spec: TooltipSpec) {
    this.bornAt = (spec.nowMs ?? Date.now)();
    this.lines = spec.text.split('\n');
    const bodyPaint = this.bodyPainter();
    this.root = spec.chromeSpec
      ? new BoxView(
          new TextView(this.lines.map(line => bodyPaint(line))),
          resolveWidgetChromeBoxViewOptions(spec.theme, spec.chromeSpec, spec.chromeSpec.title ?? 'Hint'),
        )
      : null;
  }

  isExpired(): boolean {
    if (!this.spec.ttlMs) return false;
    const now = (this.spec.nowMs ?? Date.now)();
    return now - this.bornAt >= this.spec.ttlMs;
  }

  draw(p: Printer): void {
    if (this.root) {
      this.root.draw(p);
      return;
    }
    if (p.width < 2 || p.height < 1) return;
    const mutedPaint = this.mutedPainter();
    const bodyPaint = this.bodyPainter();
    // Simple single-box frame — no border, just faint brackets to
    // avoid stealing focus from the real surfaces below.
    for (let i = 0; i < Math.min(p.height, this.lines.length); i++) {
      const line = this.lines[i]!;
      const trimmed = line.length > p.width - 2 ? line.slice(0, p.width - 3) + '…' : line;
      p.text(0, i, mutedPaint('▕ ') + bodyPaint(trimmed));
    }
  }

  private mutedPainter(): (s: string) => string {
    const { theme } = this.spec;
    if (!theme) return C.muted;
    return paintPair(resolveSemantic(theme, 'muted'));
  }

  private bodyPainter(): (s: string) => string {
    const { theme } = this.spec;
    if (!theme) return (s) => s;
    return paintPair({ fg: theme.colors.text });
  }

  onEvent(_ev: KeyEvent): EventResult { return Ignored; }

  layout(s: Size): void {
    this.root?.layout(s);
  }

  requiredSize(c: Size): Size {
    if (this.root) return this.root.requiredSize(c);
    let w = 0;
    for (const l of this.lines) w = Math.max(w, cellWidth(l) + 2);
    return {
      width: Math.min(c.width, w),
      height: Math.min(c.height, this.lines.length),
    };
  }

  takeFocus(_src?: FocusSource): boolean { return false; }
}

/** Place the tooltip near its anchor, clamping inside host bounds.
 *  Preference: to the right of the anchor, one row below. Falls back
 *  to above / left when clipped. Mirrors ContextMenu's placement
 *  logic but is tighter (tooltips are smaller). */
export function tooltipPlacement(
  anchor: { x: number; y: number },
  tooltip: { width: number; height: number },
  host: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const w = Math.min(tooltip.width, host.width);
  const h = Math.min(tooltip.height, host.height);
  let x = anchor.x + 1;
  if (x + w > host.width) x = Math.max(0, anchor.x - w);
  let y = anchor.y + 1;
  if (y + h > host.height) y = Math.max(0, anchor.y - h);
  x = Math.max(0, Math.min(x, host.width - w));
  y = Math.max(0, Math.min(y, host.height - h));
  return { x, y, width: w, height: h };
}
