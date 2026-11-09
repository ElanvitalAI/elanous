// IDX-5 Phase 1 — hover wiring tests.
//
// Covers:
//   1. pillHoverTarget — pure hit-region mapping. Row / off-pill
//      branches return null; a hit returns {id, kind, tooltipText}.
//   2. createDashboardMouseWiring wiring — motion events feed the
//      tracker; hover-stable updates ContextKeys (hoverTargetKind
//      / hoverTooltip); Tooltip surface is pushed on stable + popped
//      on leave; injected tracker + timers let us exercise every
//      path deterministically.
//   3. createHoverPresenter — standalone presenter lifecycle, so the
//      auto-show contract is testable without a full dashboard.

import { describe, expect, test } from 'bun:test';
import {
  createDashboardMouseWiring,
} from '../src/dashboard/input/mouse-wiring.js';
import { createHoverTracker } from '../src/ui/hover-tracker.js';
import { createHoverPresenter } from '../src/ui/hover-presenter.js';
import { createContextKeyService } from '../src/input-core/context-keys.js';
import { stripAnsi } from '../src/tui.js';
import type { PillBound } from '../src/status/pills.js';
import type { RotationEntry } from '../src/user-config/types.js';
import type { ActiveProviderInfo } from '../src/provider-summary.js';
import type { ModalSurface } from '../src/display/modal-stack.js';

const PROVIDER: ActiveProviderInfo = { provider: 'anthropic', model: 'Opus 4.7' };

/** Pushes scheduled timers into a queue so tests can run them on demand. */
function fakeScheduler() {
  const queue: Array<{ id: number; fn: () => void }> = [];
  let next = 1;
  return {
    setTimer: (fn: () => void) => {
      const id = next++;
      queue.push({ id, fn });
      return id;
    },
    clearTimer: (h: unknown) => {
      const idx = queue.findIndex(x => x.id === h);
      if (idx >= 0) queue.splice(idx, 1);
    },
    flush: () => {
      while (queue.length > 0) {
        const t = queue.shift()!;
        t.fn();
      }
    },
    size: () => queue.length,
  };
}

describe('dashboard-mouse-wiring hover integration', () => {
  function buildHarness() {
    const rotation: RotationEntry[] = [
      { label: 'Opus 4.7', provider: 'anthropic', model: 'claude-opus-4-7' },
    ];
    const pushed: ModalSurface[] = [];
    const sched = fakeScheduler();
    const ctx = createContextKeyService();
    const tracker = createHoverTracker({
      stableDelayMs: 100,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });
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
      ctx,
      hoverTracker: tracker,
    });
    // Prime pills + statusRow.
    wiring.buildStatusLine({
      swd: '/Users/test/project',
      providerInfo: PROVIDER,
    });
    wiring.setStatusRow(23);
    return { wiring, pushed, sched, ctx, tracker };
  }

  test('motion over a pill fires stable-hover → tooltip surface mounts + context keys update', () => {
    const { wiring, pushed, sched, ctx } = buildHarness();
    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;

    // Motion event over the pill row + col (terminal is 1-indexed).
    wiring.handleMouse({ type: 'motion', row: 23, col: pill.startCol + 2 });

    // Hover-enter fired; stable debounce is scheduled.
    expect(sched.size()).toBe(1);
    // No tooltip yet — stable hasn't fired.
    expect(pushed.length).toBe(0);
    expect(ctx.keys.hoverTargetKind).toBeNull();

    // Fire the debounce.
    sched.flush();

    // Stable hover has landed: context keys updated, tooltip mounted.
    expect(ctx.keys.hoverTargetKind).toBe('status-bar-pill');
    expect(ctx.keys.hoverTooltip).toContain('Working directory');
    expect(pushed.length).toBe(1);
    expect(pushed[0]!.id).toContain('idx5-tooltip');
    expect(pushed[0]!.focus).toBe('none');
    expect(stripAnsi(pushed[0]!.paint())).toContain('Hint');
    // Tooltip row is placed below the anchor (status-bar row is near the
    // bottom, so placement may flip above to stay in bounds — either
    // way, bounds must be inside the terminal rect).
    const b = pushed[0]!.bounds;
    expect(b.row).toBeGreaterThan(0);
    expect(b.row + b.height - 1).toBeLessThanOrEqual(24);
  });

  test('motion off the pill fires hover-leave → tooltip unmounts + context keys clear', () => {
    const { wiring, pushed, sched, ctx } = buildHarness();
    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;

    // Enter + stable.
    wiring.handleMouse({ type: 'motion', row: 23, col: pill.startCol + 2 });
    sched.flush();
    expect(pushed.length).toBe(1);
    expect(ctx.keys.hoverTargetKind).toBe('status-bar-pill');

    // Move the pointer off every pill.
    wiring.handleMouse({ type: 'motion', row: 23, col: 200 });

    expect(pushed.length).toBe(0);
    expect(ctx.keys.hoverTargetKind).toBeNull();
    expect(ctx.keys.hoverTooltip).toBeNull();
  });

  test('motion returns false from handleMouse — never consumes the event', () => {
    const { wiring } = buildHarness();
    const consumed = wiring.handleMouse({ type: 'motion', row: 23, col: 5 });
    expect(consumed).toBe(false);
  });

  test('dispose tears down tracker + presenter + tooltip surface', () => {
    const { wiring, pushed, sched } = buildHarness();
    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    wiring.handleMouse({ type: 'motion', row: 23, col: pill.startCol + 2 });
    sched.flush();
    expect(pushed.length).toBe(1);

    wiring.dispose();

    expect(pushed.length).toBe(0);
    // Further motion events post-dispose must not push more surfaces.
    wiring.handleMouse({ type: 'motion', row: 23, col: pill.startCol + 2 });
    expect(pushed.length).toBe(0);
  });

  test('pillTooltipText override can disable tooltip for one pill', () => {
    const rotation: RotationEntry[] = [
      { label: 'Opus 4.7', provider: 'anthropic', model: 'claude-opus-4-7' },
    ];
    const pushed: ModalSurface[] = [];
    const sched = fakeScheduler();
    const ctx = createContextKeyService();
    const tracker = createHoverTracker({
      stableDelayMs: 100,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });
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
      ctx,
      hoverTracker: tracker,
      pillTooltipText: (n) => (n === 'workingDir' ? null : 'overridden'),
    });
    wiring.buildStatusLine({ swd: '/x', providerInfo: PROVIDER });
    wiring.setStatusRow(23);

    const pill = wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    wiring.handleMouse({ type: 'motion', row: 23, col: pill.startCol + 1 });
    sched.flush();

    // Context keys update (hoverTargetKind = 'status-bar-pill'), but
    // tooltipText is absent so no tooltip surface was mounted.
    expect(ctx.keys.hoverTargetKind).toBe('status-bar-pill');
    expect(ctx.keys.hoverTooltip).toBeNull();
    expect(pushed.length).toBe(0);
  });
});

describe('createHoverPresenter standalone', () => {
  test('mounts tooltip on stable-hover with tooltipText; dismisses on leave', () => {
    const sched = fakeScheduler();
    const tracker = createHoverTracker({
      stableDelayMs: 100,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });
    const pushed: ModalSurface[] = [];
    const presenter = createHoverPresenter(tracker, {
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

    tracker.update(
      { x: 10, y: 20 },
      { id: 'foo:1', kind: 'foo', tooltipText: 'Hello world' },
    );
    expect(presenter._activeSurfaceId()).toBeNull();   // not stable yet

    sched.flush();
    expect(pushed.length).toBe(1);
    expect(presenter._activeSurfaceId()).toContain('idx5-tooltip');

    tracker.update(null, null);   // hover-leave
    expect(pushed.length).toBe(0);
    expect(presenter._activeSurfaceId()).toBeNull();

    presenter.dispose();
  });

  test('enabled:false gate — stable-hover 가 와도 툴팁 미표시 · true 전환 후 표시 (TUI 부활 T4)', () => {
    const sched = fakeScheduler();
    const tracker = createHoverTracker({
      stableDelayMs: 100,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });
    const pushed: ModalSurface[] = [];
    let mode: 'essential' | 'rich' = 'essential';
    const presenter = createHoverPresenter(tracker, {
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
      enabled: () => mode === 'rich',
    });

    // essential — stable-hover 무시.
    tracker.update({ x: 5, y: 5 }, { id: 'a:1', kind: 'a', tooltipText: 'nope' });
    sched.flush();
    expect(pushed.length).toBe(0);
    expect(presenter._activeSurfaceId()).toBeNull();

    // /ui rich 런타임 전환 — 다음 stable 부터 표시 (predicate 재평가).
    mode = 'rich';
    tracker.update(null, null);
    tracker.update({ x: 6, y: 6 }, { id: 'a:2', kind: 'a', tooltipText: 'yes' });
    sched.flush();
    expect(pushed.length).toBe(1);

    presenter.dispose();
  });

  test('stable-hover without tooltipText does not mount a surface', () => {
    const sched = fakeScheduler();
    const tracker = createHoverTracker({
      stableDelayMs: 100,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });
    const pushed: ModalSurface[] = [];
    const presenter = createHoverPresenter(tracker, {
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

    tracker.update({ x: 0, y: 0 }, { id: 'x:1', kind: 'x' });
    sched.flush();
    expect(pushed.length).toBe(0);
    presenter.dispose();
  });

  test('changing to a different target mounts a new tooltip', () => {
    const sched = fakeScheduler();
    const tracker = createHoverTracker({
      stableDelayMs: 100,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });
    const pushed: ModalSurface[] = [];
    const presenter = createHoverPresenter(tracker, {
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

    tracker.update({ x: 5, y: 5 }, { id: 'a:1', kind: 'a', tooltipText: 'A' });
    sched.flush();
    const firstId = presenter._activeSurfaceId();
    expect(firstId).not.toBeNull();

    // Switch to a different target — hover-enter kills the old, stable
    // after debounce mounts a new one.
    tracker.update({ x: 10, y: 5 }, { id: 'b:1', kind: 'b', tooltipText: 'B' });
    sched.flush();
    const secondId = presenter._activeSurfaceId();
    expect(secondId).not.toBeNull();
    expect(secondId).not.toBe(firstId);
    expect(pushed.length).toBe(1);   // only one active at a time

    presenter.dispose();
  });
});
