// Widget key dispatcher — behavior chain + widget onKey fallback.
//
// Phase 1 helper that encapsulates "walk widget.behaviors in order,
// first handlesKey→true claims the key, widget's own onKey runs only
// for keys no behavior consumed". This is the canonical way a pane
// handler delegates to a widget via dispatchKeyToWidget and
// Phase 3's widget migrations will use the same helper.
//
// Lives in src/widget-routing/ alongside the PaneKeyRouter so the
// "one module owns all key routing" property holds. Pure function —
// takes widgetHost + widgetId + key, returns the Action or null.
//
// Phase 1 widgets don't yet declare `behaviors`, so the chain walk is
// a no-op for now. Phase 2 (Scrollable/Cursorable/...) makes it
// load-bearing without touching this dispatcher.

import type { Key } from '../tui.js';
import type { Action, Widget, WidgetContext } from '../widgets/types.js';
import type { WidgetBehavior } from '../widget-behaviors/types.js';
import { debug } from '../debug/log.js';

/** Minimal host contract this helper needs. Keeps the helper decoupled
 *  from the full WidgetHost surface so tests can inject virtual hosts.
 *  Return types accept both `null` (real WidgetHost convention) and
 *  `undefined` (Map-based test fakes). */
export interface WidgetHostLike {
  get(id: string): { state: unknown } | null | undefined;
  defFor(id: string): Widget<unknown, unknown> | null | undefined;
  buildContext(id: string): WidgetContext<unknown> | null | undefined;
}

/**
 * Dispatch `key` to the widget at `widgetId`. Walks the widget's
 * behavior chain in declared order; the first behavior whose
 * `handlesKey(key, state)` returns true receives `onKey` and its
 * Action wins. If no behavior claims the key, the widget's own
 * optional `onKey` runs.
 *
 * Returns the resulting Action (or null if the widget isn't registered
 * and no code path ran). The Action type is the existing widget
 * contract's return — caller (pane handler closure) is responsible
 * for translating it to the PaneKeyRouter's KeyRouterResult.
 */
export function dispatchKeyToWidget(
  host: WidgetHostLike,
  widgetId: string,
  key: Key,
): Action | null {
  const inst = host.get(widgetId);
  const def = host.defFor(widgetId);
  if (!inst || !def) {
    if (debug.enabled) {
      debug.log('widget-routing.dispatchKeyToWidget.missing', widgetId, {
        key: key.name || '(empty)',
        hasInst: !!inst,
        hasDef: !!def,
      });
    }
    return null;
  }

  const ctx = host.buildContext(widgetId);
  if (!ctx) {
    // Host recognized the id for `get`/`defFor` but couldn't build a
    // context — shouldn't happen in production but handle defensively.
    return null;
  }
  const state = inst.state;

  // 1. Behavior chain — first claim wins.
  const behaviors: readonly WidgetBehavior<unknown>[] = def.behaviors ?? [];
  for (const behavior of behaviors) {
    if (behavior.handlesKey?.(key as never, state)) {
      const result = behavior.onKey?.(key as never, state, ctx);
      if (debug.enabled) {
        debug.log('widget-routing.dispatchKeyToWidget.behavior', widgetId, {
          key: key.name || '(empty)',
          behavior: behavior.name,
          action: (result as { type?: string })?.type ?? 'undefined',
        });
      }
      if (result) return result;
    }
  }

  // 2. Widget's own onKey fallback.
  if (def.onKey) {
    const result = def.onKey(key as never, state, ctx);
    if (debug.enabled) {
      debug.log('widget-routing.dispatchKeyToWidget.onKey', widgetId, {
        key: key.name || '(empty)',
        action: (result as { type?: string })?.type ?? 'undefined',
      });
    }
    return result;
  }

  // 3. No behavior claimed, no widget onKey — widget has nothing to
  //    say about this key.
  if (debug.enabled) {
    debug.log('widget-routing.dispatchKeyToWidget.passthrough', widgetId, {
      key: key.name || '(empty)',
      behaviorsChecked: behaviors.length,
    });
  }
  return null;
}
