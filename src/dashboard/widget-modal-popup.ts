// Wave P4b-1 (presentation) · A4-1 + A3-2 follow-up — open a
// widget-host instance as an interactive modal popup.
//
// Pattern lifted from `src/plan-mode/exit-modal.ts` —
// `mountViewAsModalSurface` accepts an arbitrary `View`; we adapt
// the widget's `def.render(state, ctx, character) → string[]` plus
// `def.onKey(ev, state, ctx) → Action` into the `View` contract
// (`draw(p)` / `onEvent(ev)` / `layout` / `requiredSize` /
// `takeFocus`). The widget itself stays presentation-only; this
// adapter is the bridge between widget-host (asset) and modal-stack
// (popup tier).
//
// Used by the `/bg` slash command so the operator can
// pop up the unified background-tasks list
// without having to reach into the widget-host's layout slot.

import type { ModalSurface, ModalBounds } from '../display/modal-stack.js';
import type {
  Printer,
} from '../ui/printer.js';
import type {
  EventResult,
  FocusSource,
  Size,
  View,
} from '../ui/view.js';
import { Consumed, Ignored } from '../ui/view.js';
import { mountViewAsModalSurface } from '../ui/modal-adapter.js';
import type { WidgetDef, WidgetContext } from '../widgets/types.js';
import type { WidgetHost } from '../widgets/host.js';
import type { KeyEvent } from '../display/types.js';

export interface WidgetModalPopupSpec {
  id: string;
  bounds: ModalBounds;
  /** Widget instance id previously spawned via `widgetHost.spawn`.
   *  The adapter looks up `widgetHost.get(widgetInstanceId)` lazily
   *  on every draw so state mutations are picked up live. */
  widgetInstanceId: string;
  title: string;
}

export interface WidgetModalPopupHandle {
  surface: ModalSurface;
  handleKey(ev: KeyEvent): 'consumed' | 'passthrough';
  /** Tear-down — drops the modal and clears any registered subs. */
  dispose(): void;
}

/** Build a minimal `View` that delegates render + onKey to the live
 *  widget-host instance. Returns null if the widget instance can't
 *  be resolved (caller should treat as no-op). */
export function createWidgetView(
  widgetHost: WidgetHost,
  widgetInstanceId: string,
): View | null {
  const inst = widgetHost.get(widgetInstanceId) as
    | { def: WidgetDef<unknown, unknown>; state: unknown; type: string; character?: string }
    | null;
  if (!inst) return null;
  // Minimum WidgetContext implementation. Widgets that read theme /
  // canvas / animation handles should still work — those are
  // optional; absent fields fall through to `undefined`.
  const ctx: WidgetContext<unknown> = {
    widgetId: widgetInstanceId,
    widgetType: inst.type,
    character: inst.character ?? '',
    state: inst.state,
    setState(patch) {
      const merged = (inst.state && typeof inst.state === 'object')
        ? { ...(inst.state as Record<string, unknown>), ...(patch as Record<string, unknown>) }
        : patch;
      inst.state = merged;
      ctx.state = merged;
    },
    requestRender() { /* no-op — modal redraws on the next coord cycle */ },
    dismiss() { /* no-op — caller controls the modal lifecycle */ },
    log() { /* no-op */ },
  };
  let lastSize: Size = { width: 0, height: 0 };
  return {
    draw(p: Printer): void {
      lastSize = { width: p.width, height: p.height };
      const lines = inst.def.render(
        inst.state,
        { width: p.width, height: p.height, focused: p.focused },
        inst.character ?? '',
      );
      const cap = Math.min(lines.length, p.height);
      for (let i = 0; i < cap; i++) {
        p.text(0, i, lines[i] ?? '');
      }
    },
    onEvent(ev: KeyEvent): EventResult {
      const action = inst.def.onKey?.(ev, inst.state, ctx);
      if (!action) return Ignored;
      // Widget Action union — accept the common 'refresh' / 'submit' /
      // 'none' shapes. 'submit' implies the widget wants to leave;
      // we still return Consumed so the modal-stack stops bubbling.
      const t = (action as { type?: string } | null)?.type;
      if (t === 'refresh' || t === 'submit') return Consumed();
      return Ignored;
    },
    layout(size: Size): void { lastSize = size; },
    requiredSize(c: Size): Size {
      // Honor caller's constraint — widgets size to whatever the
      // modal-stack hands them.
      void lastSize;
      return c;
    },
    takeFocus(_src?: FocusSource): boolean { return true; },
  };
}

/** Mount a widget-host instance as a modal-stack popup. Returns the
 *  caller-facing handle; the caller owns disposal (typically tied
 *  to a slash-command lifecycle or an ephemeral subscriber). */
export function openWidgetModalPopup(
  widgetHost: WidgetHost,
  spec: WidgetModalPopupSpec,
): WidgetModalPopupHandle | null {
  const view = createWidgetView(widgetHost, spec.widgetInstanceId);
  if (!view) return null;
  const mounted = mountViewAsModalSurface({
    id: spec.id,
    bounds: spec.bounds,
    view,
    priority: 200,
    tier: 'popup',
  });
  return {
    surface: mounted.surface,
    handleKey: mounted.handleKey,
    dispose: () => { mounted.dispose(); },
  };
}
