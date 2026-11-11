// IDX-5 Phase 2 — default MenuPresenter for context-menu-registry.
//
// Registry provides the *data* side (registerMenu / showMenu). This
// module provides the *rendering* side: turns a Menu + anchor into a
// mounted ContextMenu widget ModalSurface, and returns a promise that
// resolves when the user picks / cancels.
//
// Kept separate from context-menu-registry.ts so the registry itself
// stays headless + trivially testable; and so hosts that want a
// different rendering backend (ASCII, curses, etc.) can plug in their
// own presenter without touching registry code.
//
// The presenter flattens the Menu data model into the older
// ContextMenuActionItem shape that `buildContextMenuPopup` already
// consumes. `separator` rows are dropped (ContextMenu widget doesn't
// paint them); `checkbox` / `single-choice` items surface with a
// check glyph prefix so the user sees their state. Command submenus
// are not rendered by the classic presenter.

import type { ModalSurface } from '../display/modal-stack.js';
import { buildContextMenuPopup } from './context-menu-host.js';
import type {
  Menu,
  MenuEvalContext,
  MenuItem,
  MenuItemDisabled,
  MenuPresenter,
  MenuResult,
} from './context-menu-registry.js';
import type { ContextMenuActionItem } from './view.js';
import type { ThemeTokens } from '../theme/tokens.js';
import { debug } from '../debug/log.js';

/** CMX-3 (2026-04-22) — evaluate a `disabled` field (static bool or
 *  predicate). Returns the resolved boolean; a predicate that throws
 *  is treated as disabled (fail-safe) + the error is swallowed so
 *  menus stay usable even if a consumer's predicate is buggy. */
function resolveDisabled(
  disabled: MenuItemDisabled | undefined,
  ctx: MenuEvalContext,
): boolean {
  if (disabled === undefined) return false;
  if (typeof disabled === 'boolean') return disabled;
  try { return disabled(ctx); }
  catch { return true; }
}

export interface DefaultMenuPresenterDeps {
  /** Live terminal geometry so placement clamps correctly. */
  termSize: () => { rows: number; cols: number };
  /** Mount a modal surface and return its dispose handle. */
  pushSurface: (surface: ModalSurface) => { dispose: () => void };
  /** Request a redraw after the menu opens or closes. Omit in tests. */
  redraw?: () => void;
  /** Surface id prefix — defaults to 'context-menu'. */
  idPrefix?: string;
  /** Stable surface id used when `showMenu(..., {singleInstance:true})`
   *  opts into the R7 menu replacement policy. */
  singleInstanceSurfaceId?: string;
  /** IDX-6 Phase 5 adoption — live theme accessor. When provided,
   *  every opened menu paints with a drop-shadow using
   *  `theme.modal.shadow`. Evaluated per-open so `/theme switch`
   *  mid-session reflows on the next menu. */
  getTheme?: () => ThemeTokens | null | undefined;
}

/** Build a MenuPresenter that mounts a ContextMenu widget. */
export function createDefaultMenuPresenter(
  deps: DefaultMenuPresenterDeps,
): MenuPresenter {
  const present: MenuPresenter = (menu, pos, opts) =>
    new Promise<MenuResult>((resolve) => {
      const { rows, cols } = deps.termSize();
      if (rows <= 0 || cols <= 0) {
        resolve({ value: null, reason: 'disposed' });
        return;
      }

      // CMX-3 · pass eval context through so predicate-based disabled
      // fields resolve against current app state at show time.
      const flatRows = flattenMenuRows(menu, opts?.context);
      const items = flatRows.map(row => row.item);
      if (items.length === 0) {
        // Nothing to show — behave like an outside-click dismiss.
        resolve({ value: null, reason: 'outside-click' });
        return;
      }

      // anchor pos is 0-indexed (x, y) from the registry caller's
      // perspective; buildContextMenuPopup expects 1-indexed row/col
      // because it matches DisplayMouseEvent conventions. Add 1.
      const anchorRow = pos.y + 1;
      const anchorCol = pos.x + 1;

      // Capture which item was picked vs. cancelled. The handle's
      // dispose() path is shared between both, so we track separately.
      let picked: string | null = null;
      let groupId: string | undefined;
      let settled = false;
      let surfaceDispose: { dispose: () => void } | null = null;

      const resolveRow = (row: FlatMenuRow): void => {
        let groupId: string | undefined;
        let payload: unknown = undefined;
        const src = row.source;
        if (src.kind === 'single-choice') groupId = src.groupId;
        if ('payload' in src) payload = src.payload;
        if (!settled) {
          settled = true;
          resolve({
            value: row.item.value,
            reason: 'selected',
            ...(groupId !== undefined ? { groupId } : {}),
            ...(payload !== undefined ? { payload } : {}),
          });
        }
      };

      const handle = buildContextMenuPopup(
        {
          items,
          title: menu.title,
          anchorRow,
          anchorCol,
          // origin is only used by the registry host for diagnostic —
          // we have a menu object, not a View, so pass a stub that
          // implements the minimal View shape. ContextMenu widget does
          // not read this back.
          origin: { draw() {}, onEvent: () => null, layout() {}, requiredSize: () => ({ width: 0, height: 0 }), takeFocus: () => true } as never,
        },
        (value) => {
          picked = value;
          const row = flatRows.find(entry => entry.item.value === value);
          const src = row?.source;
          // Find the picked item to extract groupId (single-choice) and
          // payload (CMX-0 · any non-separator kind). Item id match uses
          // `.id === value`; single-choice + command + checkbox all share
          // the id string space.
          if (src) resolveRow(row!);
          // Dispose happens via the widget's onSubmit → buildContextMenuPopup's
          // onPick chain, but we trigger explicitly to also pop the surface
          // off the modal stack.
          handle.dispose();
          surfaceDispose?.dispose();
          deps.redraw?.();
        },
        () => {
          if (settled) return;
          if (!settled) {
            settled = true;
            resolve({ value: picked, reason: 'escape' });
          }
          handle.dispose();
          surfaceDispose?.dispose();
          deps.redraw?.();
        },
        {
          termRows: rows,
          termCols: cols,
          idPrefix: deps.idPrefix ?? 'context-menu',
          surfaceId: opts?.singleInstance
            ? (deps.singleInstanceSurfaceId ?? 'context-menu')
            : undefined,
          ownerWorkspaceId: opts?.ownerWorkspaceId,
          shadow: resolveShadowForPresenter(deps),
          theme: resolveThemeForPresenter(deps),
        },
      );

      surfaceDispose = deps.pushSurface(handle.surface);
      // Wire key routing so the coordinator can deliver keys to the
      // menu view. The handle already has a handleKey API.
      // 2026-05-05 — wrap onKey 으로 디버그 trail 기록. 사용자가
      // ↑/↓/ESC 가 메뉴까지 도달하는지 / SelectView 가 consume 하는지
      // log/latest 에서 확인 가능.
      handle.surface.onKey = (ev) => {
        const result = handle.handleKey(ev);
        if (debug.enabled) {
          debug.log('context-menu.presenter', 'onKey', {
            key: ev.name,
            ctrl: !!ev.ctrl,
            shift: !!ev.shift,
            alt: !!ev.alt,
            result,
            surfaceId: handle.surface.id,
          });
        }
        return result;
      };
      handle.surface.onMouse = (ev) => {
        return handle.handleMouse(ev) === 'consumed'
          ? { type: 'refresh' }
          : { type: 'none' };
      };
      deps.redraw?.();
    });
  return present;
}

type FlatMenuRow = {
  source: Exclude<MenuItem, { kind: 'separator' }>;
  item: ContextMenuActionItem;
};

function flattenMenuRows(
  menu: Menu,
  ctx: MenuEvalContext = {},
): FlatMenuRow[] {
  const out: FlatMenuRow[] = [];
  for (const item of menu.items) {
    if (item.hidden) continue;
    if (item.kind === 'separator') continue;
    if (item.kind === 'command') {
      if (item.submenu) continue;
      out.push({
        source: item,
        item: {
          value: item.id,
          label: item.label,
          shortcut: item.shortcut,
          disabled: resolveDisabled(item.disabled, ctx),
        },
      });
      continue;
    }
    if (item.kind === 'checkbox') {
      out.push({
        source: item,
        item: {
          value: item.id,
          label: `${item.checked ? '[x]' : '[ ]'} ${item.label}`,
          disabled: resolveDisabled(item.disabled, ctx),
        },
      });
      continue;
    }
    out.push({
      source: item,
      item: {
        value: item.id,
        label: `${item.selected ? '●' : '○'} ${item.label}`,
        disabled: resolveDisabled(item.disabled, ctx),
      },
    });
  }
  return out;
}

/** IDX-6 Phase 5 — translate the presenter's theme getter into a
 *  ModalShadowSpec for buildContextMenuPopup. Returns undefined when
 *  the getter is missing OR throws OR returns null; callers then
 *  render without shadow (backward compat). */
function resolveShadowForPresenter(
  deps: DefaultMenuPresenterDeps,
): import('./modal-adapter.js').ModalShadowSpec | undefined {
  const theme = resolveThemeForPresenter(deps);
  if (!theme) return undefined;
  return { theme };
}

function resolveThemeForPresenter(
  deps: DefaultMenuPresenterDeps,
): ThemeTokens | undefined {
  if (!deps.getTheme) return undefined;
  let theme: ThemeTokens | null | undefined;
  try { theme = deps.getTheme(); } catch { return undefined; }
  return theme ?? undefined;
}

/** Convert Menu items to the flat ContextMenuActionItem list the
 *  LC9 ContextMenu widget consumes. Separators drop; checkboxes
 *  prefix `[x] ` / `[ ] `; single-choice items prefix `● ` when
 *  selected and `○ ` otherwise.
 *
 *  CMX-0 (2026-04-22) · `hidden: true` items are skipped entirely
 *  (not rendered, not keyboard-reachable). Distinct from `disabled`
 *  which keeps the row visible but grayed. When a non-separator
 *  row is hidden, surrounding separators are NOT collapsed here —
 *  the ContextMenu widget already skips separator rows so duplicate
 *  adjacent separators render as one divider.
 *
 *  CMX-3 (2026-04-22) · `disabled` field may be a predicate
 *  `(ctx) => boolean`. When `ctx` is provided, predicates evaluate;
 *  otherwise they default to enabled (disabled=false). A predicate
 *  that throws is treated as disabled (fail-safe) — the menu stays
 *  usable even if a consumer's predicate has a bug. */
export function flattenMenuItems(
  menu: Menu,
  ctx: MenuEvalContext = {},
): ContextMenuActionItem[] {
  return flattenMenuRows(menu, ctx).map(row => row.item);
}
