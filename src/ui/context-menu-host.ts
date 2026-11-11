// MX6 — ContextMenu host helpers.
//
// R1.3 policy lock: context-menu family uses the modal-surface
// authority path (`tier: 'menu'`). Its lifecycle still belongs to the
// broader overlay family, but its paint ownership stays with the
// coordinator-owned modal stack.
//
// When a right-click lands on a view that declares `contextActions`,
// the modal-adapter emits a ContextMenuRequest. This module consumes
// that request and produces a ready-to-mount ViewSurfaceHandle
// positioned near the click anchor (respecting terminal edges so
// the menu never spills off-screen).
//
// The resulting popup is just a ContextMenu widget (LC9) mounted
// via mountViewAsModalSurface, so the whole mouse UX track sits on
// one consistent foundation.

import { ContextMenu, computePlacement } from './widgets/context-menu.js';
import {
  mountViewAsModalSurface,
  type ContextMenuRequest,
  type ModalShadowSpec,
  type ViewSurfaceHandle,
} from './modal-adapter.js';
import type { ModalBounds } from '../display/modal-stack.js';
import type { ContextMenuActionItem } from './view.js';
import { cellWidth } from './printer.js';
import type { ThemeTokens } from '../theme/tokens.js';
import { attachSurfaceToWorkspace } from '../display/workspace-affinity.js';

export interface ContextMenuHostOpts {
  /** Total terminal columns — used to clip horizontal placement. */
  termCols: number;
  /** Total terminal rows — used to clip vertical placement. */
  termRows: number;
  /** Surface id prefix. The suffix comes from the request anchor so
   *  multiple menus can coexist if the caller really wants that. */
  idPrefix?: string;
  /** Exact surface id override. Used by higher-level lifecycle
   *  policy when menus should replace each other instead of stack. */
  surfaceId?: string;
  /** IDX-6 Phase 5 adoption — drop-shadow for the menu popup. Pass
   *  `{ theme: currentThemeTokens() }` to enable; omit to render the
   *  menu without shadow (pre-adoption behaviour). */
  shadow?: ModalShadowSpec;
  /** U2 Bundle B — optional widget theme forwarded into the
   *  ContextMenu -> SelectView family so menu rows share the same
   *  token rail as other popup widgets. */
  theme?: ThemeTokens;
  /** Workspace affinity for the mounted menu surface. */
  ownerWorkspaceId?: string;
}

/** Transform a ContextMenuRequest into a mounted ViewSurfaceHandle
 *  anchored near the click. Callers register `handle.surface` with
 *  their modal stack and route keys/mouse back through the handle
 *  until `handle.isDisposed()` or the caller disposes explicitly. */
export function buildContextMenuPopup(
  req: ContextMenuRequest,
  onPick: (value: string) => void,
  onCancel: (() => void) | undefined,
  opts: ContextMenuHostOpts,
): ViewSurfaceHandle {
  // 2026-05-05 — title 폭도 산출에 포함. 이전엔 widestLabel(items) 만
  // 봐서 짧은 라벨 (`Switch` · `Remove`) 시 제목 (`Model · claude/sonnet
  // -4-5`) 이 잘렸다. title 라벨의 cell width 만큼 desiredWidth 를
  // 보장해 title 이 잘리지 않게 한다.
  const titleCellWidth = req.title ? cellWidth(req.title) : 0;
  const widestEntry = Math.max(widestLabel(req.items), titleCellWidth);
  const desiredWidth = Math.max(
    16,
    Math.min(60, widestEntry + 6),
  );
  // Budget: 2 border rows + 1 footer hint row + N option rows.
  const desiredHeight = Math.min(req.items.length + 3, 14);

  // computePlacement uses 0-indexed anchor coords. Terminal coords
  // coming from DisplayMouseEvent are 1-indexed, so we subtract 1.
  const placement = computePlacement(
    { x: req.anchorCol - 1, y: req.anchorRow - 1 },
    { width: desiredWidth, height: desiredHeight },
    { width: opts.termCols, height: opts.termRows },
  );

  const bounds: ModalBounds = {
    row: placement.y + 1,                 // back to 1-indexed
    col: placement.x + 1,
    width: placement.width,
    height: placement.height,
  };

  const view = new ContextMenu<string>({
    items: req.items.map(i => ({
      value: i.value,
      label: i.label,
      shortcut: i.shortcut,
      disabled: i.disabled,
      onRun: i.onRun,
    })),
    title: req.title,
    onPick: value => onPick(value),
    onCancel,
    theme: opts.theme,
  });

  const handle = mountViewAsModalSurface({
    id: opts.surfaceId ?? `${opts.idPrefix ?? 'context-menu'}:${req.anchorRow}:${req.anchorCol}`,
    bounds,
    view,
    priority: 270,             // above pill popups (260) and regular modals (250)
    shadow: opts.shadow,
    tier: 'menu',
    // 2026-05-06 — `backgroundInteractionPolicy: 'block'` 제거. 직전
    // PR 에선 ESC 1회 close 위해 'block' 으로 했지만 부수 효과로
    // host-chrome-policy 가 status/prompt 영역을 suppress → 검은 영역
    // 으로 보임. 사용자 피드백: "오른쪽 컨택스트 메뉴 띄울때 너무 넓은
    // 영역 검은색으로 커버함". 미지정 = blocksHostInput=false → host
    // chrome 정상 paint. 단점: ownsPrimaryKeyRoute=false 라 첫 ESC 가
    // EscAbortGate 에 잡혀 두 번 눌러야 close. 시각이 더 critical 이라
    // 우선. ESC 1회 fix 는 별도 path (예: surface 자체 setFocus 강제 +
    // active-surface routing) 로 추후 wire.
    chromeControls: onCancel
      ? {
          closeButton: true,
          onClose: onCancel,
        }
      : undefined,
  });
  attachSurfaceToWorkspace(handle.surface, req.ownerWorkspaceId ?? opts.ownerWorkspaceId);
  return handle;
}

function widestLabel(items: readonly ContextMenuActionItem[]): number {
  let w = 0;
  for (const it of items) {
    const text = `${it.shortcut ? `(${it.shortcut}) ` : ''}${it.label}`;
    const c = cellWidth(text);
    if (c > w) w = c;
  }
  return w;
}
