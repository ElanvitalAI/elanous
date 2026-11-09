import { describe, expect, test } from 'bun:test';
import {
  createViewPickerRecipeView,
  createDockLauncherRecipe,
  createDockMenuTreeRecipe,
  createModelPickerRecipe,
  createWdPickerRecipe,
  createSessionPickerRecipe,
  createSurfaceCatalogRecipe,
  createViewPickerRecipe,
  createUndoPickerRecipe,
  createWorkspaceDesktopShellRecipe,
  createWorkspaceRestoreRecipe,
} from '../src/mouse-action-recipes.js';
import { DEFAULT_THEME_TOKENS } from '../src/theme/tokens.js';
import { ToastStack } from '../src/ui/widgets/toast-stack.js';
import { Printer } from '../src/ui/printer.js';
import type { PopupPlacement } from '../src/status/popups.js';
import type { RotationEntry } from '../src/user-config/types.js';
import type { DisplayMouseEvent } from '../src/display/types.js';
import { stripAnsi } from '../src/tui.js';

const PLACEMENT: PopupPlacement = {
  anchorStartCol: 30,
  anchorEndCol: 45,
  statusRow: 20,
  termCols: 80,
  termRows: 24,
};

function mouse(type: DisplayMouseEvent['type'], row: number, col: number): DisplayMouseEvent {
  return { type, row, col };
}

async function tick(): Promise<void> { await new Promise(r => setTimeout(r, 5)); }

describe('MX11 model picker recipe', () => {
  function mkRotation(): RotationEntry[] {
    return [
      { label: 'Opus 4.7',    provider: 'anthropic', model: 'claude-opus-4-7' },
      { label: 'Sonnet 4.6',  provider: 'anthropic', model: 'claude-sonnet-4-6' },
    ];
  }

  test('double-click a row fires onSwitch + Toast', async () => {
    const toasts = new ToastStack({ nowMs: () => 0 });
    const calls: RotationEntry[] = [];
    const h = createModelPickerRecipe({
      entries: mkRotation(),
      placement: PLACEMENT,
      onSwitch: e => { calls.push(e); },
      toasts,
    });
    h.surface.paint();
    // First option at bounds.row + 1 (title) + ... we scan.
    const bounds = h.surface.bounds;
    for (let r = bounds.row + 1; r < bounds.row + bounds.height - 1 && calls.length === 0; r++) {
      h.handleMouse(mouse('click', r, bounds.col + 2));
      h.handleMouse(mouse('double-click', r, bounds.col + 2));
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.label).toBe('Opus 4.7');
    toasts.pruneExpired();
    await tick();
    const snap = toasts.snapshot();
    expect(snap.some(t => t.text.includes('Opus'))).toBe(true);
  });

  test('async onSwitch → toast pushed after promise resolves', async () => {
    const toasts = new ToastStack({ nowMs: () => 0 });
    let resolved = false;
    const h = createModelPickerRecipe({
      entries: mkRotation(),
      placement: PLACEMENT,
      onSwitch: () => new Promise<void>(res => { setTimeout(() => { resolved = true; res(); }, 5); }),
      toasts,
    });
    h.surface.paint();
    const bounds = h.surface.bounds;
    for (let r = bounds.row + 1; r < bounds.row + bounds.height - 1; r++) {
      h.handleMouse(mouse('click', r, bounds.col + 2));
      if (h.handleMouse(mouse('double-click', r, bounds.col + 2)) === 'consumed') break;
    }
    // Before the promise resolves, toast should not be pushed yet.
    expect(toasts.snapshot()).toHaveLength(0);
    await new Promise(r => setTimeout(r, 20));
    expect(resolved).toBe(true);
    expect(toasts.snapshot()).toHaveLength(1);
  });

  test('theme-aware frame paints static chrome close glyph', () => {
    const themed = createModelPickerRecipe({
      entries: mkRotation(),
      placement: PLACEMENT,
      onSwitch: () => {},
      theme: DEFAULT_THEME_TOKENS,
    });
    const plain = createModelPickerRecipe({
      entries: mkRotation(),
      placement: PLACEMENT,
      onSwitch: () => {},
    });

    const themedOut = themed.surface.paint();
    const plainOut = plain.surface.paint();

    expect(stripAnsi(themedOut)).toContain('✕');
    expect(themedOut).not.toBe(plainOut);
  });
});

describe('MX11 wd picker recipe', () => {
  test('double-click fires onSwitch', () => {
    const switched: string[] = [];
    const h = createWdPickerRecipe({
      recentPaths: ['/alpha', '/beta', '/gamma'],
      placement: PLACEMENT,
      onSwitch: p => { switched.push(p); },
    });
    h.surface.paint();
    const bounds = h.surface.bounds;
    for (let r = bounds.row + 1; r < bounds.row + bounds.height - 1 && switched.length === 0; r++) {
      h.handleMouse(mouse('click', r, bounds.col + 2));
      h.handleMouse(mouse('double-click', r, bounds.col + 2));
    }
    expect(switched).toHaveLength(1);
    expect(['/alpha', '/beta', '/gamma']).toContain(switched[0]!);
  });
});

describe('MX11 session picker recipe', () => {
  test('double-click fires onResume with session id', () => {
    const resumed: string[] = [];
    const h = createSessionPickerRecipe({
      sessions: [
        { id: 'abc123', label: 'Session abc', ageHint: '5 min ago' },
        { id: 'def456', label: 'Session def', ageHint: '1 hour ago' },
      ],
      placement: PLACEMENT,
      onResume: id => { resumed.push(id); },
    });
    const out = h.surface.paint();
    expect(out).toContain('Resume session');
    expect(out).toContain('Session abc');
    const bounds = h.surface.bounds;
    for (let r = bounds.row + 1; r < bounds.row + bounds.height - 1 && resumed.length === 0; r++) {
      h.handleMouse(mouse('click', r, bounds.col + 2));
      h.handleMouse(mouse('double-click', r, bounds.col + 2));
    }
    expect(['abc123', 'def456']).toContain(resumed[0]!);
  });
});

describe('MX11 view picker recipe', () => {
  test('double-click fires onApply with preset id', () => {
    const applied: string[] = [];
    const h = createViewPickerRecipe({
      presets: [
        { id: 'compact', label: 'Compact' },
        { id: 'wide',    label: 'Wide' },
      ],
      placement: PLACEMENT,
      onApply: id => { applied.push(id); },
    });
    const out = h.surface.paint();
    expect(out).toContain('Change layout');
    expect(out).toContain('Compact');
    expect(out).not.toContain('Starter:');
    const bounds = h.surface.bounds;
    for (let r = bounds.row + 1; r < bounds.row + bounds.height - 1 && applied.length === 0; r++) {
      h.handleMouse(mouse('click', r, bounds.col + 2));
      h.handleMouse(mouse('double-click', r, bounds.col + 2));
    }
    expect(['compact', 'wide']).toContain(applied[0]!);
  });

  test('preview view reuses the same chooser substrate without inline explainer text', () => {
    const view = createViewPickerRecipeView({
      presets: [
        { id: 'normal', label: '● Normal' },
        { id: 'obsidian', label: '○ Obsidian' },
        { id: 'skill', label: '○ Skill' },
      ],
      onApply: () => {},
      onCancel: () => {},
    });
    view.layout({ width: 42, height: 10 });
    const printer = Printer.create({ width: 42, height: 10, focused: true });
    view.draw(printer);
    const out = printer.lines().map(stripAnsi).join('\n');
    expect(out).toContain('Change layout');
    expect(out).toContain('● Normal');
    expect(out).toContain('○ Obsidian');
    expect(out).toContain('Switch');
    expect(out).toContain('Cancel');
    expect(out).not.toContain('Starter:');
  });
});

describe('MX11 dock launcher recipe', () => {
  test('includes Chat Only action and dispatches it on double-click', () => {
    const picks: string[] = [];
    const h = createDockLauncherRecipe({
      placement: PLACEMENT,
      onPick: (action) => { picks.push(action); },
    });
    const out = h.surface.paint();
    expect(out).toContain('Pop out pane');
    expect(out).toContain('Add surface');
    expect(out).toContain('Chat only');
    const bounds = h.surface.bounds;
    for (let r = bounds.row + 1; r < bounds.row + bounds.height - 1 && picks.length === 0; r++) {
      h.handleMouse(mouse('click', r, bounds.col + 2));
      h.handleMouse(mouse('double-click', r, bounds.col + 2));
    }
    expect(picks.some(p => p === 'add-window' || p === 'chat-only')).toBe(true);
  });

  test('supports custom launcher item sets for compact workflows', () => {
    const h = createDockLauncherRecipe({
      placement: PLACEMENT,
      items: [
        { value: 'add-surface', label: 'Add Surface', description: 'catalog first' },
        { value: 'add-window', label: 'Add Window', description: 'window second' },
      ],
      onPick: () => {},
    });
    const out = h.surface.paint();
    expect(out).toContain('Add Surface');
    expect(out).toContain('Add Window');
    expect(out).not.toContain('Chat Only');
    expect(out).not.toContain('Switch');
    expect(out).not.toContain('Cancel');
  });
});

describe('MX11 dock menu tree recipe', () => {
  test('single popup keeps parent menu alive while child selection opens from Add Surface', () => {
    const picks: string[] = [];
    const h = createDockMenuTreeRecipe({
      placement: PLACEMENT,
      windowPanes: [
        { id: 'pane:browser', label: 'Browser pane' },
      ],
      surfaces: [
        { id: 'surface:preview', label: 'Preview surface', group: 'Panes' },
        { id: 'surface:memo', label: 'Memo surface', group: 'Companions' },
      ],
      onOpenWindow: (paneId) => { picks.push(`window:${paneId}`); },
      onOpenSurface: (surfaceId) => { picks.push(`surface:${surfaceId}`); },
      onCancel: () => {},
    });
    const initialHeight = h.surface.bounds.height;
    const initialWidth = h.surface.bounds.width;
    const initialCol = h.surface.bounds.col;
    const out = h.surface.paint();
    expect(out).toContain('Pop out pane');
    expect(out).toContain('Add surface');
    expect(initialHeight).toBeLessThan(15);

    expect(h.handleKey({ name: 'down' } as never)).toBe('consumed');
    expect(h.handleKey({ name: 'enter' } as never)).toBe('consumed');
    expect(h.surface.bounds.width).toBeGreaterThan(initialWidth);
    expect(h.surface.bounds.col).toBeLessThanOrEqual(initialCol);
    expect(h.surface.bounds.height).toBeGreaterThanOrEqual(initialHeight);
    expect(h.handleKey({ name: 'down' } as never)).toBe('consumed');
    expect(h.handleKey({ name: 'enter' } as never)).toBe('consumed');
    expect(picks.some((value) => value.startsWith('surface:'))).toBe(true);
  });

  test('only tall child menus expand upward; pop out pane stays at the parent anchor', () => {
    const surfaces = Array.from({ length: 18 }, (_, idx) => ({
      id: `surface:${idx}`,
      label: `Surface ${idx + 1}`,
      group: idx < 9 ? 'Panes' : 'Companions',
    }));
    const h = createDockMenuTreeRecipe({
      placement: PLACEMENT,
      windowPanes: [
        { id: 'pane:browser', label: 'Browser pane' },
        { id: 'pane:preview', label: 'Preview pane' },
      ],
      surfaces,
      onOpenWindow: () => {},
      onOpenSurface: () => {},
      onCancel: () => {},
    });
    const parentRow = h.surface.bounds.row;
    expect(h.handleKey({ name: 'enter' } as never)).toBe('consumed');
    expect(h.surface.bounds.row).toBe(parentRow);
    expect(h.handleKey({ name: 'left' } as never)).toBe('consumed');
    expect(h.handleKey({ name: 'down' } as never)).toBe('consumed');
    expect(h.handleKey({ name: 'enter' } as never)).toBe('consumed');
    expect(h.surface.bounds.row).toBeLessThan(parentRow);
  });

  test('parent menu exposes exit-program action without opening a child submenu', async () => {
    const picks: string[] = [];
    const h = createDockMenuTreeRecipe({
      placement: PLACEMENT,
      windowPanes: [
        { id: 'pane:browser', label: 'Browser pane' },
      ],
      surfaces: [
        { id: 'surface:preview', label: 'Preview surface', group: 'Panes' },
      ],
      onOpenWindow: (paneId) => { picks.push(`window:${paneId}`); },
      onOpenSurface: (surfaceId) => { picks.push(`surface:${surfaceId}`); },
      onExitProgram: () => { picks.push('exit'); },
      onCancel: () => {},
    });
    const out = h.surface.paint();
    expect(out).toContain('Exit program');
    expect(h.handleKey({ name: 'down' } as never)).toBe('consumed');
    expect(h.handleKey({ name: 'down' } as never)).toBe('consumed');
    expect(h.handleKey({ name: 'down' } as never)).toBe('consumed');
    expect(h.handleKey({ name: 'enter' } as never)).toBe('consumed');
    await tick();
    expect(picks).toContain('exit');
  });

  test('escape dismisses the whole dock menu popup even when a child submenu is open', () => {
    let cancels = 0;
    const h = createDockMenuTreeRecipe({
      placement: PLACEMENT,
      windowPanes: [
        { id: 'pane:browser', label: 'Browser pane' },
      ],
      surfaces: Array.from({ length: 18 }, (_, idx) => ({
        id: `surface:${idx}`,
        label: `Surface ${idx + 1}`,
        group: idx < 9 ? 'Panes' : 'Companions',
      })),
      onOpenWindow: () => {},
      onOpenSurface: () => {},
      onCancel: () => { cancels += 1; },
    });
    expect(h.handleKey({ name: 'down' } as never)).toBe('consumed');
    expect(h.handleKey({ name: 'enter' } as never)).toBe('consumed');
    expect(h.handleKey({ name: 'escape' } as never)).toBe('consumed');
    expect(cancels).toBe(1);
  });

  test('runtime dock menu uses the soft cursor background tone when themed', () => {
    const h = createDockMenuTreeRecipe({
      placement: PLACEMENT,
      windowPanes: [
        { id: 'pane:browser', label: 'Browser pane' },
      ],
      surfaces: [
        { id: 'surface:preview', label: 'Preview surface', group: 'Panes' },
      ],
      onOpenWindow: () => {},
      onOpenSurface: () => {},
      onCancel: () => {},
      theme: DEFAULT_THEME_TOKENS,
    });
    const out = h.surface.paint();
    expect(out).toContain('48;2;245;194;231');
  });

  test('runtime dock menu opts out of bottom-area freeze', () => {
    const h = createDockMenuTreeRecipe({
      placement: PLACEMENT,
      windowPanes: [
        { id: 'pane:browser', label: 'Browser pane' },
      ],
      surfaces: [
        { id: 'surface:preview', label: 'Preview surface', group: 'Panes' },
      ],
      onOpenWindow: () => {},
      onOpenSurface: () => {},
      onCancel: () => {},
    });
    expect(h.surface.freezeBottomArea).toBe(false);
  });
});

describe('MX11 surface catalog recipe', () => {
  test('renders grouped surface entries and dispatches selection', () => {
    const picks: string[] = [];
    const h = createSurfaceCatalogRecipe({
      placement: PLACEMENT,
      surfaces: [
        { id: 'pane:browser', label: 'Browser popup', group: 'Panes' },
        { id: 'companion:clipboard', label: 'Clipboard companion', group: 'Companions' },
        { id: 'vw:browser', label: 'Browser virtual window', group: 'Virtual Windows' },
      ],
      onPick: (surfaceId) => { picks.push(surfaceId); },
    });
    const out = h.surface.paint();
    expect(out).toContain('Add surface');
    expect(out).toContain('Panes');
    expect(out).toContain('Companions');
    expect(out).toContain('Virtual Windows');
    expect(out).toContain('Clipboard companion');
    expect(out).not.toContain('Switch');
    expect(out).not.toContain('Cancel');
    const bounds = h.surface.bounds;
    for (let r = bounds.row + 1; r < bounds.row + bounds.height - 1 && picks.length === 0; r++) {
      h.handleMouse(mouse('click', r, bounds.col + 2));
      h.handleMouse(mouse('double-click', r, bounds.col + 2));
    }
    expect(picks).toHaveLength(1);
  });
});

describe('MX11 undo picker recipe', () => {
  test('click fires onRestore with snapshot id + shortcut labels', () => {
    const restored: string[] = [];
    const h = createUndoPickerRecipe({
      snapshots: Array.from({ length: 3 }, (_, i) => ({
        id: `snap-${i}`,
        description: `Turn ${i + 1}`,
        sha: '1234567abcdef',
        ageHint: `${i * 5}s ago`,
      })),
      placement: PLACEMENT,
      onRestore: id => { restored.push(id); },
    });
    const out = h.surface.paint();
    expect(out).toContain('Restore to which turn?');
    expect(out).toContain('Turn 1');
    expect(out).toContain('(1)');                  // shortcut hint
    // Press number '1' → picks Turn 1.
    h.handleKey({ name: '1' } as never);
    expect(restored).toContain('snap-0');
  });

  test('Esc cancels', () => {
    let cancels = 0;
    const h = createUndoPickerRecipe({
      snapshots: [{ id: 'x', description: 'x' }],
      placement: PLACEMENT,
      onRestore: () => {},
      onCancel: () => cancels++,
    });
    h.handleKey({ name: 'escape' } as never);
    expect(cancels).toBe(1);
  });
});

describe('MX11 workspace restore recipe', () => {
  test('double-click fires onRestore with the selected dock entry', () => {
    const restored: string[] = [];
    const h = createWorkspaceRestoreRecipe({
      entries: [
        { surfaceId: 'recipe:model', label: 'Switch model', kind: 'popup', docked: true },
        { surfaceId: 'recipe:wd', label: 'Switch working directory', kind: 'popup', docked: true },
      ],
      placement: PLACEMENT,
      onRestore: (surfaceId) => { restored.push(surfaceId); },
    });
    const out = h.surface.paint();
    expect(out).toContain('Restore window');
    expect(out).toContain('Switch model');
    const bounds = h.surface.bounds;
    for (let r = bounds.row + 1; r < bounds.row + bounds.height - 1 && restored.length === 0; r++) {
      h.handleMouse(mouse('click', r, bounds.col + 2));
      h.handleMouse(mouse('double-click', r, bounds.col + 2));
    }
    expect(restored).toHaveLength(1);
    expect(['recipe:model', 'recipe:wd']).toContain(restored[0]!);
  });
});

describe('U6 workspace desktop shell recipe', () => {
  test('renders live / docked / dormant sections and restores first actionable row', () => {
    const restored: string[] = [];
    const h = createWorkspaceDesktopShellRecipe({
      workspaceLabel: 'Dashboard',
      layoutMode: 'desktop',
      liveEntries: [
        { surfaceId: 'live:model', label: 'Model switcher', kind: 'popup', focused: true },
      ],
      dockEntries: [
        { surfaceId: 'recipe:model', label: 'Switch model', kind: 'popup' },
      ],
      dormantEntries: [
        { surfaceId: 'popup:search', label: 'Search', kind: 'popup' },
      ],
      placement: PLACEMENT,
      onRestore: (surfaceId) => { restored.push(surfaceId); },
    });
    const out = h.surface.paint();
    expect(out).toContain('Dashboard');
    expect(out).toContain('desktop');
    expect(out).toContain('2 parked');
    expect(out).toContain('1 live');
    expect(out).toContain('● Live now');
    expect(out).toContain('— Docked');
    expect(out).toContain('· Dormant');
    expect(out).toContain('Live now');
    expect(out).toContain('Docked');
    expect(out).toContain('Dormant');
    expect(out).toContain('◫');
    expect(out).toContain('● ◫');
    expect(out).toContain('— ◫');
    expect(out).toContain('· ◫');
    expect(out).not.toContain('docked · restore');
    expect(out).not.toContain('dormant · restore');
    expect(out).not.toContain('active · focused');
    expect(out).toContain('Model switcher');
    expect(out).toContain('Switch model');
    expect(out).toContain('Search');
    const bounds = h.surface.bounds;
    for (let r = bounds.row + 1; r < bounds.row + bounds.height - 1 && restored.length === 0; r++) {
      h.handleMouse(mouse('click', r, bounds.col + 2));
      h.handleMouse(mouse('double-click', r, bounds.col + 2));
    }
    expect(restored).toHaveLength(1);
    expect(['recipe:model', 'popup:search']).toContain(restored[0]!);
    expect(restored[0]).not.toBe('live:model');
  });
});
