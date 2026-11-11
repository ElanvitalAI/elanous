import { describe, expect, test } from 'bun:test';
import { mountViewAsModalSurface, type ContextMenuRequest } from '../src/ui/modal-adapter.js';
import { buildContextMenuPopup } from '../src/ui/context-menu-host.js';
import { Consumed, Ignored } from '../src/ui/view.js';
import type { View, EventResult, Size, FocusSource, ContextMenuActionItem } from '../src/ui/view.js';
import type { Printer } from '../src/ui/printer.js';
import type { KeyEvent } from '../src/plugins/core/types.js';
import type { MouseEvent } from '../src/ui/mouse-events.js';
import type { DisplayMouseEvent } from '../src/display/types.js';

class RightClickableView implements View {
  calls: MouseEvent[] = [];
  constructor(private actions: ContextMenuActionItem[] | null = []) {}
  draw(p: Printer): void {
    p.clickable({ x: 0, y: 0, width: 20, height: 3 }, this);
  }
  onEvent(_: KeyEvent): EventResult { return Ignored; }
  onMouse(ev: MouseEvent): EventResult {
    this.calls.push(ev);
    return ev.type === 'right-click' ? Consumed() : Ignored;
  }
  contextActions(_ev: MouseEvent): ContextMenuActionItem[] | null { return this.actions; }
  layout(_: Size): void {}
  requiredSize(c: Size): Size { return c; }
  takeFocus(_?: FocusSource): boolean { return true; }
}

function mouse(type: DisplayMouseEvent['type'], row: number, col: number): DisplayMouseEvent {
  return { type, row, col };
}

describe('MX6 adapter onContextMenu', () => {
  test('right-click on a view with contextActions fires onContextMenu', () => {
    const v = new RightClickableView([
      { value: 'copy',  label: 'Copy' },
      { value: 'paste', label: 'Paste' },
    ]);
    const requests: ContextMenuRequest[] = [];
    const h = mountViewAsModalSurface({
      id: 'r1', bounds: { row: 2, col: 2, width: 30, height: 5 },
      view: v,
      onContextMenu: r => requests.push(r),
    });
    h.surface.paint();
    h.handleMouse(mouse('right-click', 3, 5));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.items.map(i => i.value)).toEqual(['copy', 'paste']);
    expect(requests[0]?.anchorRow).toBe(3);
    expect(requests[0]?.anchorCol).toBe(5);
    expect(requests[0]?.ownerWorkspaceId).toBeUndefined();
    expect(requests[0]?.origin).toBe(v);
  });

  test('workspace-class surface context menu request carries owner workspace id', () => {
    const v = new RightClickableView([{ value: 'copy', label: 'Copy' }]);
    const requests: ContextMenuRequest[] = [];
    const h = mountViewAsModalSurface({
      id: 'r1-workspace',
      bounds: { row: 2, col: 2, width: 30, height: 5 },
      view: v,
      tier: 'vw',
      onContextMenu: r => requests.push(r),
    });
    h.surface.paint();
    h.handleMouse(mouse('right-click', 3, 5));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.ownerWorkspaceId).toBe('r1-workspace');
  });

  test('right-click on a view returning [] does NOT fire onContextMenu', () => {
    const v = new RightClickableView([]);
    const requests: ContextMenuRequest[] = [];
    const h = mountViewAsModalSurface({
      id: 'r2', bounds: { row: 2, col: 2, width: 30, height: 5 },
      view: v,
      onContextMenu: r => requests.push(r),
    });
    h.surface.paint();
    h.handleMouse(mouse('right-click', 3, 5));
    expect(requests).toHaveLength(0);
  });

  test('right-click on a view returning null does NOT fire onContextMenu', () => {
    const v = new RightClickableView(null);
    const requests: ContextMenuRequest[] = [];
    const h = mountViewAsModalSurface({
      id: 'r3', bounds: { row: 2, col: 2, width: 30, height: 5 },
      view: v,
      onContextMenu: r => requests.push(r),
    });
    h.surface.paint();
    h.handleMouse(mouse('right-click', 3, 5));
    expect(requests).toHaveLength(0);
  });

  test('onContextMenu throw does not break handleMouse', () => {
    const v = new RightClickableView([{ value: 'x', label: 'X' }]);
    const h = mountViewAsModalSurface({
      id: 'r4', bounds: { row: 2, col: 2, width: 30, height: 5 },
      view: v,
      onContextMenu: () => { throw new Error('boom'); },
    });
    h.surface.paint();
    expect(() => h.handleMouse(mouse('right-click', 3, 5))).not.toThrow();
  });
});

describe('MX6 buildContextMenuPopup', () => {
  const OPTS = { termCols: 80, termRows: 24 };

  test('returns a mounted ViewSurfaceHandle positioned near the anchor', () => {
    const req: ContextMenuRequest = {
      items: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
      anchorRow: 10,
      anchorCol: 20,
      origin: new RightClickableView(),
    };
    let picked: string | null = null;
    const h = buildContextMenuPopup(req, v => { picked = v; }, undefined, OPTS);
    expect(h.surface.kind).toBe('modal');
    expect(h.surface.bounds.col).toBeGreaterThanOrEqual(1);
    expect(h.surface.bounds.row).toBeGreaterThanOrEqual(1);
    expect(h.surface.priority).toBe(270);
    // Click activates Beta immediately; double-click remains valid.
    h.surface.paint();
    const itemRow = h.surface.bounds.row + 2;
    const clickCol = h.surface.bounds.col + 2;
    h.handleMouse(mouse('click', itemRow, clickCol));
    expect(picked).toBe('b');
    picked = null;
    h.handleMouse(mouse('double-click', itemRow, clickCol));
    expect(picked).toBe('b');
  });

  test('respects terminal bounds when anchor is near the edge', () => {
    const req: ContextMenuRequest = {
      items: Array.from({ length: 8 }, (_, i) => ({ value: `v${i}`, label: `Item ${i}` })),
      anchorRow: 20,
      anchorCol: 78,
      origin: new RightClickableView(),
    };
    const h = buildContextMenuPopup(req, () => {}, undefined, OPTS);
    // Bounds should stay inside 80x24 terminal.
    expect(h.surface.bounds.col + h.surface.bounds.width - 1).toBeLessThanOrEqual(OPTS.termCols);
    expect(h.surface.bounds.row + h.surface.bounds.height - 1).toBeLessThanOrEqual(OPTS.termRows);
  });

  test('assigns ownerWorkspaceId when provided', () => {
    const req: ContextMenuRequest = {
      items: [{ value: 'x', label: 'X' }],
      anchorRow: 5,
      anchorCol: 10,
      origin: new RightClickableView(),
    };
    const h = buildContextMenuPopup(req, () => {}, undefined, {
      ...OPTS,
      ownerWorkspaceId: 'virtual-window:9',
    });
    expect(h.surface.ownerWorkspaceId).toBe('virtual-window:9');
  });

  test('request ownerWorkspaceId wins over host opts ownerWorkspaceId', () => {
    const req: ContextMenuRequest = {
      items: [{ value: 'x', label: 'X' }],
      anchorRow: 5,
      anchorCol: 10,
      ownerWorkspaceId: 'virtual-window:11',
      origin: new RightClickableView(),
    };
    const h = buildContextMenuPopup(req, () => {}, undefined, {
      ...OPTS,
      ownerWorkspaceId: 'dashboard-main',
    });
    expect(h.surface.ownerWorkspaceId).toBe('virtual-window:11');
  });

  test('Esc calls onCancel and disposes cleanly', () => {
    const req: ContextMenuRequest = {
      items: [{ value: 'x', label: 'X' }],
      anchorRow: 5,
      anchorCol: 10,
      origin: new RightClickableView(),
    };
    let cancels = 0;
    const h = buildContextMenuPopup(req, () => {}, () => cancels++, OPTS);
    h.handleKey({ name: 'escape' } as never);
    expect(cancels).toBe(1);
  });
});
