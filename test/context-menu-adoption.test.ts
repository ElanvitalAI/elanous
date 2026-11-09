// IDX-5 Phase 2 — context-menu adoption tests.
//
// Covers:
//   1. createDefaultMenuPresenter — Menu → ContextMenu widget mount;
//      onPick / onCancel resolve the returned promise with the right
//      reason + value; separators drop; checkbox / single-choice
//      prefix glyphs survive the flatten step.
//   2. dashboard-context-menu-registry singleton — init registers 5
//      pill menus, handleForPill returns stable handles, ctx bridge
//      updates contextMenuOpen, reset helper tears everything down.
//   3. dashboard-mouse-wiring right-click → onPillRightClick callback
//      fires with the right (name, pos) and the handler's promise
//      can drive registry.showMenu without breaking other mouse paths.

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createContextMenuRegistry,
  buildPillMenu,
  type Menu,
} from '../src/ui/context-menu-registry.js';
import {
  createDefaultMenuPresenter,
  flattenMenuItems,
} from '../src/ui/context-menu-presenter.js';
import {
  initDashboardContextMenuRegistry,
  getDashboardContextMenuRegistry,
  handleForPill,
  __resetDashboardContextMenuRegistryForTests,
} from '../src/dashboard/context-menu/registry.js';
import { __resetDashboardContextKeysForTests, getDashboardContextKeys } from '../src/dashboard/context/keys.js';
import { createDashboardMouseWiring } from '../src/dashboard/input/mouse-wiring.js';
import type { ActiveProviderInfo } from '../src/provider-summary.js';
import type { ModalSurface } from '../src/display/modal-stack.js';
import type { RotationEntry } from '../src/user-config/types.js';
import type { PillName } from '../src/status/pills.js';

const PROVIDER: ActiveProviderInfo = { provider: 'anthropic', model: 'Opus 4.7' };

describe('flattenMenuItems', () => {
  test('drops separators + prefixes checkbox + single-choice', () => {
    const menu: Menu = {
      items: [
        { kind: 'command', id: 'run', label: 'Run' },
        { kind: 'separator' },
        { kind: 'checkbox', id: 'wrap', label: 'Wrap', checked: true },
        { kind: 'checkbox', id: 'trim', label: 'Trim', checked: false },
        { kind: 'single-choice', groupId: 'sz', id: 'sm', label: 'Small', selected: false },
        { kind: 'single-choice', groupId: 'sz', id: 'lg', label: 'Large', selected: true },
      ],
    };
    const flat = flattenMenuItems(menu);
    expect(flat.map(i => i.label)).toEqual([
      'Run',
      '[x] Wrap',
      '[ ] Trim',
      '○ Small',
      '● Large',
    ]);
    expect(flat.map(i => i.value)).toEqual(['run', 'wrap', 'trim', 'sm', 'lg']);
  });
});

describe('createDefaultMenuPresenter', () => {
  function mkDeps() {
    const pushed: ModalSurface[] = [];
    return {
      pushed,
      presenter: createDefaultMenuPresenter({
        termSize: () => ({ rows: 24, cols: 80 }),
        pushSurface: s => {
          pushed.push(s);
          return {
            dispose: () => {
              const i = pushed.indexOf(s);
              if (i >= 0) pushed.splice(i, 1);
            },
          };
        },
      }),
    };
  }

  test('mounts a modal surface when opening', () => {
    const { pushed, presenter } = mkDeps();
    const menu: Menu = {
      items: [
        { kind: 'command', id: 'a', label: 'Alpha' },
        { kind: 'command', id: 'b', label: 'Beta' },
      ],
    };
    // Fire and immediately read — the surface must be pushed synchronously.
    const promise = presenter(menu, { x: 5, y: 10 }, {});
    expect(pushed.length).toBe(1);
    expect(pushed[0]!.id).toContain('context-menu');
    // Satisfy the pending promise so bun test doesn't leak it.
    void promise.catch(() => {});
  });

  test('forwards ownerWorkspaceId to the mounted menu surface', () => {
    const { pushed, presenter } = mkDeps();
    const menu: Menu = {
      items: [
        { kind: 'command', id: 'a', label: 'Alpha' },
      ],
    };
    const promise = presenter(menu, { x: 5, y: 10 }, { ownerWorkspaceId: 'virtual-window:2' });
    expect(pushed.length).toBe(1);
    expect(pushed[0]!.ownerWorkspaceId).toBe('virtual-window:2');
    void promise.catch(() => {});
  });

  test('resolves with reason:outside-click when the menu has no renderable items', async () => {
    const { presenter } = mkDeps();
    const menu: Menu = { items: [{ kind: 'separator' }] };
    const result = await presenter(menu, { x: 0, y: 0 }, {});
    expect(result).toEqual({ value: null, reason: 'outside-click' });
  });

  test('command submenu opens recursively and resolves with submenu selection', async () => {
    const { pushed, presenter } = mkDeps();
    const menu: Menu = {
      title: 'Root',
      items: [
        {
          kind: 'command',
          id: 'debug.mode',
          label: 'Debug mode change',
          submenu: {
            title: 'Debug mode',
            items: [
              { kind: 'command', id: 'debug.mode.on', label: 'On' },
              { kind: 'command', id: 'debug.mode.diag', label: 'Diag' },
            ],
          },
        },
      ],
    };

    const resultP = presenter(menu, { x: 5, y: 5 }, {});
    expect(pushed).toHaveLength(1);
    const root = pushed[0]!;
    root.paint();
    expect(root.onKey?.({ name: 'enter' } as never)).toBe('consumed');

    expect(pushed).toHaveLength(1);
    const submenu = pushed[0]!;
    expect(submenu.id).toBe(root.id);
    submenu.paint();
    expect(submenu.onKey?.({ name: 'enter' } as never)).toBe('consumed');

    const result = await resultP;
    expect(result).toEqual({ value: 'debug.mode.on', reason: 'selected' });
    expect(pushed).toHaveLength(0);
  });
});

describe('dashboard-context-menu-registry singleton', () => {
  beforeEach(() => {
    __resetDashboardContextMenuRegistryForTests();
    __resetDashboardContextKeysForTests();
  });

  test('init registers 5 pill menus + ctx bridge flips contextMenuOpen', async () => {
    const pushed: ModalSurface[] = [];
    const reg = initDashboardContextMenuRegistry({
      termSize: () => ({ rows: 24, cols: 80 }),
      pushSurface: s => {
        pushed.push(s);
        return {
          dispose: () => {
            const i = pushed.indexOf(s);
            if (i >= 0) pushed.splice(i, 1);
          },
        };
      },
    });

    // All 5 pills resolve to a registered menu.
    for (const name of ['workingDir', 'model', 'mode', 'shellRollup', 'virtualWindow'] as PillName[]) {
      expect(handleForPill(name)).not.toBeNull();
      const h = handleForPill(name)!;
      const got = reg.getMenu(h);
      expect(got).not.toBeNull();
      expect(got!.items.length).toBeGreaterThan(0);
    }

    // Showing a menu flips contextMenuOpen true, then false on dismiss.
    // Inject a test presenter that resolves after we observe the open state.
    let resolveShow: (r: { value: string | null; reason: 'selected' | 'escape' | 'outside-click' | 'disposed' }) => void;
    const showPromise = new Promise<void>((outerResolve) => {
      reg.setPresenter(async () => {
        expect(getDashboardContextKeys().contextMenuOpen).toBe(true);
        outerResolve();
        return new Promise(r => { resolveShow = r; });
      });
    });

    const fireShow = reg.showMenu(handleForPill('model')!, { x: 10, y: 20 });
    await showPromise;
    // Close the menu.
    resolveShow!({ value: null, reason: 'escape' });
    await fireShow;
    expect(getDashboardContextKeys().contextMenuOpen).toBe(false);
  });

  test('reset helper tears down the singleton', () => {
    initDashboardContextMenuRegistry({
      termSize: () => ({ rows: 24, cols: 80 }),
      pushSurface: () => ({ dispose: () => {} }),
    });
    expect(handleForPill('model')).not.toBeNull();

    __resetDashboardContextMenuRegistryForTests();
    expect(handleForPill('model')).toBeNull();
  });
});

describe('dashboard-mouse-wiring right-click pill dispatch', () => {
  function buildHarness(overrides: { onPillRightClick?: (name: PillName, pos: { x: number; y: number }) => void } = {}) {
    const rotation: RotationEntry[] = [
      { label: 'Opus 4.7', provider: 'anthropic', model: 'claude-opus-4-7' },
    ];
    const pushed: ModalSurface[] = [];
    const wiring = createDashboardMouseWiring({
      termSize: () => ({ rows: 24, cols: 120 }),
      getRotation: () => rotation,
      setActiveModel: () => {},
      getRecentWds: () => [],
      setSessionWd: () => {},
      pushModalSurface: surface => {
        pushed.push(surface);
        return {
          dispose: () => {
            const i = pushed.indexOf(surface);
            if (i >= 0) pushed.splice(i, 1);
          },
        };
      },
      redraw: () => {},
      ...overrides,
    });
    wiring.buildStatusLine({ swd: '/Users/test/project', providerInfo: PROVIDER });
    wiring.setStatusRow(23);
    return { wiring };
  }

  test('right-click on a pill fires the callback with (name, 0-indexed pos)', () => {
    const calls: Array<{ name: PillName; pos: { x: number; y: number } }> = [];
    const { wiring } = buildHarness({
      onPillRightClick: (name, pos) => calls.push({ name, pos }),
    });
    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;

    const consumed = wiring.handleMouse({
      type: 'right-click',
      row: 23,
      col: pill.startCol + 2,       // 1-indexed column, lands on workingDir
    });

    expect(consumed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('workingDir');
    expect(calls[0]!.pos.x).toBe(pill.startCol + 1);   // 0-indexed → col-1
    expect(calls[0]!.pos.y).toBe(22);                   // row-1
  });

  test('right-click off any pill does not fire the callback', () => {
    const calls: PillName[] = [];
    const { wiring } = buildHarness({ onPillRightClick: n => calls.push(n) });
    const consumed = wiring.handleMouse({ type: 'right-click', row: 23, col: 200 });
    expect(calls).toEqual([]);
    // And the event isn't consumed by Phase 2 — it falls through to
    // modal-forward / dropped per existing rules.
    expect(consumed).toBe(false);
  });

  test('left-click still opens the picker popup (Phase 2 only intercepts right-click)', () => {
    const calls: PillName[] = [];
    const { wiring } = buildHarness({ onPillRightClick: n => calls.push(n) });
    const pill = wiring._snapshot().pills.find(p => p.name === 'model')!;

    const consumed = wiring.handleMouse({
      type: 'click',
      row: 23,
      col: pill.startCol + 2,
    });
    expect(consumed).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('registry showMenu resilience', () => {
  test('registering a menu after dispose yields an unusable handle', () => {
    const reg = createContextMenuRegistry();
    const handle = reg.registerMenu(buildPillMenu({ pillName: 'Model' }));
    expect(reg.getMenu(handle)).not.toBeNull();
    reg.dispose();
    // After dispose, getMenu returns null; showMenu resolves with
    // 'disposed' without invoking the presenter.
    expect(reg.getMenu(handle)).toBeNull();
    return reg.showMenu(handle, { x: 0, y: 0 }).then(r => {
      expect(r.reason).toBe('disposed');
    });
  });
});
