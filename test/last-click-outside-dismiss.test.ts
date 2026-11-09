// IDX-5 Phase 3 — lastClickHitKind + outside-click picker dismiss.
//
// Covers:
//   1. `lastClickHitKind` ContextKey updates on click / double-click /
//      right-click events. Drag / release / scroll / motion don't
//      touch the key.
//   2. Pill popup dismisses on any discrete outside click (click /
//      double-click / right-click). Drag / release / scroll must
//      NOT dismiss.

import { describe, expect, test } from 'bun:test';
import { createDashboardMouseWiring } from '../src/dashboard/input/mouse-wiring.js';
import { createContextKeyService } from '../src/input-core/context-keys.js';
import type { RotationEntry } from '../src/user-config/types.js';
import type { ActiveProviderInfo } from '../src/provider-summary.js';
import type { ModalSurface } from '../src/display/modal-stack.js';
import type { DisplayMouseEvent } from '../src/display/types.js';

const PROVIDER: ActiveProviderInfo = { provider: 'anthropic', model: 'Opus 4.7' };

function buildHarness() {
  const rotation: RotationEntry[] = [
    { label: 'Opus 4.7', provider: 'anthropic', model: 'claude-opus-4-7' },
    { label: 'Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6' },
  ];
  const pushed: ModalSurface[] = [];
  const ctx = createContextKeyService();
  const wiring = createDashboardMouseWiring({
    termSize: () => ({ rows: 24, cols: 120 }),
    getRotation: () => rotation,
    setActiveModel: () => {},
    // 2026-05-05 — outside-click tests in this suite moved from the
    // model pill (which now cycles directly) to the workingDir pill
    // (still picker-on-click). Provide at least one recent so the
    // wd picker has a row to render.
    getRecentWds: () => ['/Users/test/recent-a'],
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
    ctx,
  });
  wiring.buildStatusLine({ swd: '/Users/test/project', providerInfo: PROVIDER });
  wiring.setStatusRow(23);
  return { wiring, pushed, ctx };
}

function mouse(type: DisplayMouseEvent['type'], row: number, col: number): DisplayMouseEvent {
  return { type, row, col };
}

describe('lastClickHitKind', () => {
  test('click on a pill sets lastClickHitKind="status-bar-pill"', () => {
    const { wiring, ctx } = buildHarness();
    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    wiring.handleMouse(mouse('click', 23, pill.startCol + 2));
    expect(ctx.keys.lastClickHitKind).toBe('status-bar-pill');
  });

  test('double-click on a pill also sets lastClickHitKind', () => {
    const { wiring, ctx } = buildHarness();
    const pill = wiring._snapshot().pills.find(p => p.name === 'model')!;
    wiring.handleMouse(mouse('double-click', 23, pill.startCol + 2));
    expect(ctx.keys.lastClickHitKind).toBe('status-bar-pill');
  });

  test('right-click on a pill sets lastClickHitKind', () => {
    const { wiring, ctx } = buildHarness();
    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    wiring.handleMouse(mouse('right-click', 23, pill.startCol + 2));
    expect(ctx.keys.lastClickHitKind).toBe('status-bar-pill');
  });

  test('click off any pill clears lastClickHitKind to null', () => {
    const { wiring, ctx } = buildHarness();
    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    wiring.handleMouse(mouse('click', 23, pill.startCol + 2));
    expect(ctx.keys.lastClickHitKind).toBe('status-bar-pill');
    wiring.handleMouse(mouse('click', 23, 200));   // off-pill row=status, col=200 far right
    expect(ctx.keys.lastClickHitKind).toBeNull();
  });

  test('click on a non-status row always resolves to null', () => {
    const { wiring, ctx } = buildHarness();
    wiring.handleMouse(mouse('click', 10, 50));    // mid-terminal
    expect(ctx.keys.lastClickHitKind).toBeNull();
  });

  test('drag / release / scroll / motion do NOT update the key', () => {
    const { wiring, ctx } = buildHarness();
    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    // Seed a known value
    wiring.handleMouse(mouse('click', 23, pill.startCol + 2));
    expect(ctx.keys.lastClickHitKind).toBe('status-bar-pill');
    // Non-click events must not touch the key
    wiring.handleMouse(mouse('drag', 10, 50));
    wiring.handleMouse(mouse('release', 10, 50));
    wiring.handleMouse(mouse('scroll-up', 10, 50));
    wiring.handleMouse(mouse('scroll-down', 10, 50));
    wiring.handleMouse(mouse('motion', 10, 50));
    expect(ctx.keys.lastClickHitKind).toBe('status-bar-pill');   // unchanged
  });
});

// ── B-4: pane-region classification ───────────────────────────────
// When the host supplies a `getPaneRegionKind` delegate, clicks that
// miss every status-bar pill fall through to that classifier so
// lastClickHitKind can carry broader values ('pane-body' /
// 'pane-title' / 'pane-nav') instead of collapsing to null.

describe('lastClickHitKind · pane-region delegate (B-4)', () => {
  function paneHarness(
    paneRegion: (row: number, col: number) => 'pane-body' | 'pane-title' | 'pane-nav' | null,
  ) {
    const rotation: RotationEntry[] = [
      { label: 'Opus 4.7', provider: 'anthropic', model: 'claude-opus-4-7' },
    ];
    const pushed: ModalSurface[] = [];
    const ctx = createContextKeyService();
    const wiring = createDashboardMouseWiring({
      termSize: () => ({ rows: 24, cols: 120 }),
      getRotation: () => rotation,
      setActiveModel: () => {},
      getRecentWds: () => [],
      setSessionWd: () => {},
      pushModalSurface: surface => {
        pushed.push(surface);
        return { dispose: () => { const i = pushed.indexOf(surface); if (i >= 0) pushed.splice(i, 1); } };
      },
      redraw: () => {},
      ctx,
      getPaneRegionKind: paneRegion,
    });
    wiring.buildStatusLine({ swd: '/Users/test/project', providerInfo: PROVIDER });
    wiring.setStatusRow(23);
    return { wiring, ctx };
  }

  test('pane-body click routes through delegate', () => {
    const { wiring, ctx } = paneHarness(() => 'pane-body');
    wiring.handleMouse(mouse('click', 10, 50));
    expect(ctx.keys.lastClickHitKind).toBe('pane-body');
  });

  test('pane-title click routes through delegate', () => {
    const { wiring, ctx } = paneHarness(() => 'pane-title');
    wiring.handleMouse(mouse('click', 5, 20));
    expect(ctx.keys.lastClickHitKind).toBe('pane-title');
  });

  test('pane-nav click routes through delegate', () => {
    const { wiring, ctx } = paneHarness(() => 'pane-nav');
    wiring.handleMouse(mouse('click', 4, 15));
    expect(ctx.keys.lastClickHitKind).toBe('pane-nav');
  });

  test('pill click wins over pane delegate', () => {
    // Delegate always reports pane-body, but clicking on a pill must
    // still resolve to 'status-bar-pill'.
    const { wiring, ctx } = paneHarness(() => 'pane-body');
    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    wiring.handleMouse(mouse('click', 23, pill.startCol + 2));
    expect(ctx.keys.lastClickHitKind).toBe('status-bar-pill');
  });

  test('delegate returning null leaves key at null (unclassified whitespace)', () => {
    const { wiring, ctx } = paneHarness(() => null);
    wiring.handleMouse(mouse('click', 10, 50));
    expect(ctx.keys.lastClickHitKind).toBeNull();
  });

  test('delegate throwing does not crash wiring — key settles to null', () => {
    const { wiring, ctx } = paneHarness(() => { throw new Error('boom'); });
    expect(() => wiring.handleMouse(mouse('click', 10, 50))).not.toThrow();
    expect(ctx.keys.lastClickHitKind).toBeNull();
  });

  test('right-click on pane body also updates the key', () => {
    const { wiring, ctx } = paneHarness(() => 'pane-body');
    wiring.handleMouse(mouse('right-click', 10, 50));
    expect(ctx.keys.lastClickHitKind).toBe('pane-body');
  });
});

describe('outside-click picker dismiss', () => {
  // 2026-05-05 — model pill click was changed from "open picker" to
  // "cycle next entry directly" (faster UX). Popup-lifecycle tests
  // here moved to the workingDir pill (which still opens a picker on
  // click) so the dismiss/passthrough behaviour stays under test
  // without regressing what the suite was actually validating.
  test('click on pill opens popup, click outside dismisses it', () => {
    const { wiring, pushed } = buildHarness();
    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    wiring.handleMouse(mouse('click', 23, pill.startCol + 2));
    expect(pushed.length).toBeGreaterThan(0);
    wiring.handleMouse(mouse('click', 5, 5));
    expect(wiring.hasActivePopup()).toBe(false);
  });

  test('double-click outside also dismisses', () => {
    const { wiring, pushed } = buildHarness();
    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    wiring.handleMouse(mouse('click', 23, pill.startCol + 2));
    expect(pushed.length).toBeGreaterThan(0);
    wiring.handleMouse(mouse('double-click', 5, 5));
    expect(wiring.hasActivePopup()).toBe(false);
  });

  test('right-click outside also dismisses', () => {
    const { wiring, pushed } = buildHarness();
    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    wiring.handleMouse(mouse('click', 23, pill.startCol + 2));
    expect(pushed.length).toBeGreaterThan(0);
    wiring.handleMouse(mouse('right-click', 5, 5));
    expect(wiring.hasActivePopup()).toBe(false);
  });

  test('right-click outside can continue into context-menu dispatch after dismiss', () => {
    const calls: Array<{ row: number; col: number }> = [];
    const rotation: RotationEntry[] = [
      { label: 'Opus 4.7', provider: 'anthropic', model: 'claude-opus-4-7' },
      { label: 'Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6' },
    ];
    const wiring = createDashboardMouseWiring({
      termSize: () => ({ rows: 24, cols: 120 }),
      getRotation: () => rotation,
      setActiveModel: () => {},
      getRecentWds: () => ['/home/x'],
      setSessionWd: () => {},
      pushModalSurface: () => ({ dispose: () => {} }),
      redraw: () => {},
      contextMenuDispatch: (ev) => {
        calls.push({ row: ev.row, col: ev.col });
        return true;
      },
    });
    wiring.buildStatusLine({ swd: '/Users/test/project', providerInfo: PROVIDER });
    wiring.setStatusRow(23);
    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    wiring.handleMouse(mouse('click', 23, pill.startCol + 2));

    const consumed = wiring.handleMouse(mouse('right-click', 5, 5));
    expect(consumed).toBe(true);
    expect(wiring.hasActivePopup()).toBe(false);
    expect(calls).toEqual([{ row: 5, col: 5 }]);
  });

  test('drag through passthrough does NOT dismiss (gesture completion)', () => {
    const { wiring, pushed } = buildHarness();
    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    wiring.handleMouse(mouse('click', 23, pill.startCol + 2));
    const popupBefore = pushed.length;
    wiring.handleMouse(mouse('drag', 5, 5));
    expect(wiring.hasActivePopup()).toBe(true);   // still mounted
    expect(pushed.length).toBe(popupBefore);
  });

  test('scroll outside popup does NOT dismiss', () => {
    const { wiring, pushed } = buildHarness();
    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    wiring.handleMouse(mouse('click', 23, pill.startCol + 2));
    const popupBefore = pushed.length;
    wiring.handleMouse(mouse('scroll-up', 5, 5));
    wiring.handleMouse(mouse('scroll-down', 5, 5));
    expect(wiring.hasActivePopup()).toBe(true);
    expect(pushed.length).toBe(popupBefore);
  });
});
