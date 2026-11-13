import { rectContains, type Rect } from '../../display/rect.js';
import type { Menu } from '../../ui/context-menu-registry.js';
import type { SidetabRow } from '../../sidetab-core/model.js';
import type { Key } from '../../tui-key.js';

export interface SidetabHitRegion {
  readonly rect: Rect;
  readonly rowId: string;
}

export type SidetabPointerAction =
  | { readonly kind: 'select'; readonly rowId: string }
  | { readonly kind: 'context-menu'; readonly rowId: string; readonly row: number; readonly col: number };

/** Resolve a mouse press against rendered row rects, including their actual screen offset. */
export function sidetabPointerAction(key: Key, regions: readonly SidetabHitRegion[]): SidetabPointerAction | undefined {
  const mouse = key.mouse;
  if (key.name !== 'mouse' || !mouse || (mouse.type !== 'click' && mouse.type !== 'right-click')) return undefined;
  const hit = regions.find(({ rect }) => rectContains(rect, mouse.row, mouse.col));
  if (!hit) return undefined;
  return mouse.type === 'right-click'
    ? { kind: 'context-menu', rowId: hit.rowId, row: mouse.row, col: mouse.col }
    : { kind: 'select', rowId: hit.rowId };
}

/** Menu data only. The caller owns lifecycle, permissions, and the close/rename effects. */
export function sidetabRowMenu(row: SidetabRow): Menu {
  return {
    id: `next-tui-sidetab:${row.id}`,
    title: row.label,
    items: [
      { kind: 'command', id: 'open', label: 'Open here' },
      { kind: 'command', id: 'rename', label: 'Rename' },
      { kind: 'command', id: 'close', label: 'Close' },
    ],
  };
}
