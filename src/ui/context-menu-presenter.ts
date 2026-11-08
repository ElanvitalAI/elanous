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
// are rendered with a trailing `›` affordance and opened recursively
// by the presenter.

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
import { computePopupBounds } from '../status/popups.js';
import { createActionPickerView, type ActionItem } from '../mouse-action-recipes.js';
import { MenuTreeController } from './widgets/menu-tree-controller.js';
import type { View } from './view.js';
import { mountSubmenuPopupPairSurface } from './submenu-popup-pair.js';
import { createSubmenuPopupMenuView } from './submenu-popup-menu-contract.js';
import { deriveSubmenuPopupRoleTheme } from './submenu-popup-theme.js';
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

      const rootHasSubmenu = flatRows.some((row) => row.source.kind === 'command' && !!row.source.submenu);
      if (rootHasSubmenu) {
        const handle = buildContextMenuTreePopup({
          menu,
          flatRows,
          anchorRow,
          anchorCol,
          rows,
          cols,
          theme: resolveThemeForPresenter(deps),
          shadow: resolveShadowForPresenter(deps),
          surfaceId: opts?.singleInstance
            ? (deps.singleInstanceSurfaceId ?? 'context-menu')
            : undefined,
          idPrefix: deps.idPrefix ?? 'context-menu',
          onCancel: () => {
            if (settled) return;
            settled = true;
            resolve({ value: picked, reason: 'escape' });
            handle.dispose();
            surfaceDispose?.dispose();
            deps.redraw?.();
          },
          onResolveLeaf: (row) => {
            picked = row.item.value;
            resolveRow(row);
            handle.dispose();
            surfaceDispose?.dispose();
            deps.redraw?.();
          },
          onResolveNested: (submenu, pos2) => {
            handle.dispose();
            surfaceDispose?.dispose();
            deps.redraw?.();
            settled = true;
            void present(submenu, pos2, opts).then(resolve);
          },
        });
        surfaceDispose = deps.pushSurface(handle.surface);
        handle.surface.onKey = handle.handleKey;
        handle.surface.onMouse = (ev) => {
          return handle.handleMouse(ev) === 'consumed'
            ? { type: 'refresh' }
            : { type: 'none' };
        };
        deps.redraw?.();
        return;
      }

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
          if (src?.kind === 'command' && src.submenu) {
            const bounds = handle.surface.bounds;
            const rowIndex = Math.max(0, flatRows.findIndex(entry => entry.item.value === value));
            handle.dispose();
            surfaceDispose?.dispose();
            deps.redraw?.();
            settled = true;
            void present(src.submenu, {
              x: Math.max(0, bounds.col + bounds.width - 2),
              y: Math.max(0, bounds.row + rowIndex + 1),
            }, opts).then(resolve);
            return;
          }
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

function buildContextMenuTreePopup(spec: {
  menu: Menu;
  flatRows: FlatMenuRow[];
  anchorRow: number;
  anchorCol: number;
  rows: number;
  cols: number;
  idPrefix: string;
  surfaceId?: string;
  theme?: ThemeTokens;
  shadow?: import('./modal-adapter.js').ModalShadowSpec;
  onCancel: () => void;
  onResolveLeaf: (row: FlatMenuRow) => void;
  onResolveNested: (submenu: Menu, pos: { x: number; y: number }) => void;
}) {
  const parentTheme = deriveSubmenuPopupRoleTheme(spec.theme, 'parent');
  const childTheme = deriveSubmenuPopupRoleTheme(spec.theme, 'child');
  const parentItems: ActionItem<string>[] = spec.flatRows.map((row) => ({
    value: row.item.value,
    label: row.item.label,
    shortcut: row.item.shortcut,
    heading: false,
    description: undefined,
  }));
  const tree = new MenuTreeController({
    launcherCount: 1,
    hasChildMenu: ({ parentIndex }) => {
      const src = spec.flatRows[parentIndex]?.source;
      return src?.kind === 'command' && !!src.submenu && flattenMenuRows(src.submenu).length > 0;
    },
  });
  tree.openParent();

  const childRows = (): FlatMenuRow[] => {
    const src = spec.flatRows[tree.getParentCursor()]?.source;
    if (!src || src.kind !== 'command' || !src.submenu) return [];
    return flattenMenuRows(src.submenu);
  };
  const childItems = (): ActionItem<string>[] => childRows().map((row) => ({
    value: row.item.value,
    label: row.item.label,
    shortcut: row.item.shortcut,
  }));
  const childTitle = (): string => {
    const first = childRows()[0]?.source;
    if (first?.kind === 'command' && first.submenu?.title) return first.submenu.title;
    return 'More';
  };

  const sizeOf = (title: string, items: readonly ActionItem<string>[]) => ({
    width: Math.max(24, Math.min(60, Math.max(title.length, ...items.map((i) => i.label.length + (i.shortcut ? i.shortcut.length + 3 : 0))) + 8)),
    height: Math.min(Math.max(items.length, 1), 10) + 5,
  });
  const parentSize = sizeOf(spec.menu.title ?? 'Actions', parentItems);
  const initialChildSize = sizeOf('More', childItems().length > 0 ? childItems() : [{ value: '__empty__', label: '(empty)' }]);
  const parentBounds = computePopupBounds({
    anchorStartCol: Math.max(0, spec.anchorCol - 1),
    anchorEndCol: Math.max(0, spec.anchorCol - 1 + parentSize.width + initialChildSize.width + 1),
    statusRow: spec.anchorRow,
    termCols: spec.cols,
    termRows: spec.rows,
  }, {
    width: parentSize.width,
    height: parentSize.height,
  });
  const expandedBounds = computePopupBounds({
    anchorStartCol: Math.max(0, spec.anchorCol - 1),
    anchorEndCol: Math.max(0, spec.anchorCol - 1 + parentSize.width + initialChildSize.width + 1),
    statusRow: spec.anchorRow,
    termCols: spec.cols,
    termRows: spec.rows,
  }, {
    width: parentSize.width + 1 + initialChildSize.width,
    height: Math.max(parentSize.height, initialChildSize.height),
  });

  const childRect = (currentSize: { width: number; height: number }) => {
    const items = childItems();
    const desired = sizeOf('More', items.length > 0 ? items : [{ value: '__empty__', label: '(empty)' }]);
    return {
      x: parentSize.width + 1,
      y: 0,
      width: desired.width,
      height: Math.min(currentSize.height, desired.height),
    };
  };

  const parentView = (): View => createSubmenuPopupMenuView({
    id: 'context-menu-tree:parent',
    title: spec.menu.title ?? 'Actions',
    items: parentItems,
    contract: 'single-click-activate',
    initialIndex: tree.getParentCursor(),
    onSelectionChange: (index) => tree.setParentCursor(index),
    onPick: (value) => {
      const row = spec.flatRows.find((entry) => entry.item.value === value);
      if (!row) return;
      if (row.source.kind === 'command' && row.source.submenu) {
        const nested = flattenMenuRows(row.source.submenu);
        if (nested.length > 0) {
          tree.openChild();
          return;
        }
      }
      spec.onResolveLeaf(row);
    },
    onCancel: spec.onCancel,
    theme: parentTheme,
    shadow: spec.shadow,
  }, createActionPickerView);
  const childView = (): View => createSubmenuPopupMenuView({
    id: 'context-menu-tree:child',
    title: childTitle(),
    items: childItems(),
    contract: 'single-click-activate',
    initialIndex: tree.getChildCursor(),
    onSelectionChange: (index) => tree.setChildCursor(index),
    onPick: (value) => {
      const row = childRows().find((entry) => entry.item.value === value);
      if (!row) return;
      if (row.source.kind === 'command' && row.source.submenu) {
        spec.onResolveNested(row.source.submenu, {
          x: expandedBounds.col + childRect(expandedBounds).x + childRect(expandedBounds).width - 2,
          y: expandedBounds.row + tree.getChildCursor() + 1,
        });
        return;
      }
      spec.onResolveLeaf(row);
    },
    onCancel: spec.onCancel,
    theme: childTheme,
    shadow: spec.shadow,
  }, createActionPickerView);

  return mountSubmenuPopupPairSurface({
    id: spec.surfaceId ?? `${spec.idPrefix}:${spec.anchorRow}:${spec.anchorCol}`,
    parentBounds,
    expandedBounds,
    parentRect: (currentSize) => ({
      x: 0,
      y: 0,
      width: parentSize.width,
      height: Math.min(currentSize.height, parentSize.height),
    }),
    childRect: childRect,
    createParentView: parentView,
    createChildView: childView,
    isChildVisible: () => tree.isChildOpen,
    isChildFocused: () => tree.activeRole === 'child',
    onHandleKey: (name) => tree.handleKey(name),
    onStateMayHaveChanged: () => {},
    priority: 270,
    shadow: spec.shadow,
    theme: parentTheme,
    tier: 'menu',
    onClose: spec.onCancel,
  });
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
      out.push({
        source: item,
        item: {
          value: item.id,
          label: `${item.label}${item.submenu ? ' ›' : ''}`,
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
