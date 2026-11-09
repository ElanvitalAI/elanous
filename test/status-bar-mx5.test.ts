import { describe, expect, test } from 'bun:test';
import { computePrimaryStatusPills, pillAtColumn } from '../src/status/pills.js';
import { computePopupBounds, createModelPickerPopup, createWdPickerPopup } from '../src/status/popups.js';
import type { StatusBarState } from '../src/status/bar.js';
import type { ActiveProviderInfo } from '../src/provider-summary.js';
import type { RotationEntry } from '../src/user-config/types.js';
import type { DisplayMouseEvent } from '../src/display/types.js';

const PROVIDER: ActiveProviderInfo = { provider: 'anthropic', model: 'Opus 4.7' };

function mouse(type: DisplayMouseEvent['type'], row: number, col: number): DisplayMouseEvent {
  return { type, row, col };
}

describe('MX5 status-bar pill geometry', () => {
  test('finds both anchor pills in a primary status', () => {
    const state: StatusBarState = {
      cwd: '/Users/me/source/test/monad-agent',
      providerInfo: PROVIDER,
      gitBranch: 'main',
    };
    const { text, pills } = computePrimaryStatusPills(state);
    expect(text).toContain('Opus 4.7');
    // 2 anchor pills — workingDir + model.
    expect(pills.map(p => p.name)).toEqual(['workingDir', 'model']);
    // model pill sits AFTER workingDir pill.
    expect(pills[1]!.startCol).toBeGreaterThan(pills[0]!.endCol);
  });

  test('pills have non-zero width', () => {
    const state: StatusBarState = { cwd: '/', providerInfo: PROVIDER };
    const { pills } = computePrimaryStatusPills(state);
    for (const p of pills) {
      expect(p.endCol).toBeGreaterThan(p.startCol);
    }
  });

  test('pillAtColumn resolves hits and misses', () => {
    const pills = [
      { name: 'workingDir' as const, startCol: 1,  endCol: 12 },
      { name: 'model'      as const, startCol: 18, endCol: 40 },
    ];
    expect(pillAtColumn(pills, 0)).toBeNull();     // before first
    expect(pillAtColumn(pills, 5)?.name).toBe('workingDir');
    expect(pillAtColumn(pills, 11)?.name).toBe('workingDir');
    expect(pillAtColumn(pills, 12)).toBeNull();    // between
    expect(pillAtColumn(pills, 18)?.name).toBe('model');
    expect(pillAtColumn(pills, 39)?.name).toBe('model');
    expect(pillAtColumn(pills, 40)).toBeNull();    // past end
    expect(pillAtColumn(pills, 80)).toBeNull();
  });
});

describe('MX5 popup placement', () => {
  test('opens above status bar when room above', () => {
    const bounds = computePopupBounds({
      anchorStartCol: 10,
      anchorEndCol: 30,
      statusRow: 20,
      termCols: 80,
      termRows: 24,
    }, { width: 30, height: 6 });
    expect(bounds.col).toBe(11);
    // Row should be 20 - 6 = 14 (opens upward)
    expect(bounds.row).toBe(14);
    expect(bounds.width).toBe(30);
    expect(bounds.height).toBe(6);
  });

  test('opens below when status row is near top', () => {
    const bounds = computePopupBounds({
      anchorStartCol: 0,
      anchorEndCol: 10,
      statusRow: 2,
      termCols: 80,
      termRows: 24,
    }, { width: 20, height: 8 });
    expect(bounds.row).toBeGreaterThan(2);
  });

  test('clips popup width to terminal width', () => {
    const bounds = computePopupBounds({
      anchorStartCol: 70,
      anchorEndCol: 80,
      statusRow: 20,
      termCols: 80,
      termRows: 24,
    }, { width: 50, height: 5 });
    // desired width 50, clamped so it doesn't overflow.
    expect(bounds.col + bounds.width - 1).toBeLessThanOrEqual(80);
  });

  test('uses anchor col as left edge when it fits', () => {
    const bounds = computePopupBounds({
      anchorStartCol: 5,
      anchorEndCol: 20,
      statusRow: 20,
      termCols: 80,
      termRows: 24,
    }, { width: 30, height: 5 });
    expect(bounds.col).toBe(6);           // 1-indexed (anchorStartCol+1)
  });
});

describe('MX5 model picker popup', () => {
  function mkRotation(): RotationEntry[] {
    return [
      { label: 'Sonnet 4.6',   provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { label: 'Opus 4.7',     provider: 'anthropic', model: 'claude-opus-4-7' },
      { label: 'Grok Fast',    provider: 'grok',      model: 'grok-fast' },
    ];
  }

  const PLACEMENT = {
    anchorStartCol: 30,
    anchorEndCol: 45,
    statusRow: 20,
    termCols: 80,
    termRows: 24,
  };

  test('mounts a modal surface', () => {
    const h = createModelPickerPopup({
      entries: mkRotation(),
      placement: PLACEMENT,
      onPick: () => {},
    });
    expect(h.surface.kind).toBe('modal');
    expect(h.surface.focus).toBe('owns');
    expect(h.surface.priority).toBe(260);
    h.dispose();
  });

  test('paints title and all entries', () => {
    const h = createModelPickerPopup({
      entries: mkRotation(),
      placement: PLACEMENT,
      onPick: () => {},
    });
    const out = h.surface.paint();
    expect(out).toContain('Switch model');
    expect(out).toContain('Sonnet 4.6');
    expect(out).toContain('Opus 4.7');
    expect(out).toContain('Grok Fast');
    h.dispose();
  });

  test('double-click on a row fires onPick with the right entry', () => {
    const entries = mkRotation();
    let picked: RotationEntry | null = null;
    const h = createModelPickerPopup({
      entries,
      placement: PLACEMENT,
      onPick: e => { picked = e; },
    });
    h.surface.paint();
    const popupCol = h.surface.bounds.col + 3;
    const secondOptionRow = h.surface.bounds.row + 2;
    h.handleMouse(mouse('click', secondOptionRow, popupCol));
    const res = h.handleMouse(mouse('double-click', secondOptionRow, popupCol));
    expect(res).toBe('consumed');
    expect(picked?.label).toBe('Opus 4.7');
  });

  test('Esc cancels without picking', () => {
    let picked: RotationEntry | null = null;
    let cancels = 0;
    const h = createModelPickerPopup({
      entries: mkRotation(),
      placement: PLACEMENT,
      onPick: e => { picked = e; },
      onCancel: () => { cancels++; },
    });
    h.handleKey({ name: 'escape' } as never);
    expect(picked).toBeNull();
    expect(cancels).toBe(1);
  });
});

describe('MX5 wd picker popup', () => {
  const PLACEMENT = {
    anchorStartCol: 1,
    anchorEndCol: 12,
    statusRow: 20,
    termCols: 100,
    termRows: 24,
  };

  test('mounts and renders recent paths', () => {
    const h = createWdPickerPopup({
      recentPaths: ['/a/b', '/c/d', '/e/f'],
      placement: PLACEMENT,
      onPick: () => {},
    });
    const out = h.surface.paint();
    expect(out).toContain('Switch working directory');
    expect(out).toContain('/a/b');
    expect(out).toContain('/c/d');
    h.dispose();
  });

  test('double-click picks the path', () => {
    let picked: string | null = null;
    const h = createWdPickerPopup({
      recentPaths: ['/first', '/second', '/third'],
      placement: PLACEMENT,
      onPick: p => { picked = p; },
    });
    h.surface.paint();
    const popupCol = h.surface.bounds.col + 3;
    let res: string | null = null;
    for (let row = h.surface.bounds.row + 1; row < h.surface.bounds.row + h.surface.bounds.height - 1 && !picked; row++) {
      h.handleMouse(mouse('click', row, popupCol));
      res = h.handleMouse(mouse('double-click', row, popupCol));
    }
    expect(res).toBe('consumed');
    expect(['/first', '/second', '/third']).toContain(picked!);
  });
});
