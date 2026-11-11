// L8 lesson integration test (substrate Occam · 2026-05-03):
// Behavioral regression check for the dual-dispatch-path parity
// invariant codified as F11 + F12 (structural guards only). A
// surface that handles its own input via dashboard-side dispatch
// (mouseWiring.handleMouse / popupAuthority paths — see
// dashboard/index.ts:7251 `input.onMouse.foreground-modal-guard`)
// MUST NOT show stale ANSI after user input.
//
// Origin incident: PR #1406 introduced the paint cache with
// "default to 0" semantic (every surface participated implicitly).
// The dock menu (and other recipe modals routed through
// mouseWiring.handleMouse) bypassed coord's auto-bump cache
// invalidation sites — the cache returned stale ANSI on every
// click/key. PR #1407 changed the cache to opt-in (surfaces must
// declare `generation: number` to participate). This integration
// test verifies the opt-in default truly protects dashboard-routed
// surfaces against the stale-ANSI failure mode.
//
// Scope (per audit): synthetic recipe-style surface that mimics
// dock menu's mutation pattern. Tests the contract itself — does
// not require booting up popupAuthority + mouseWiring + dashboard
// infrastructure. Same regression coverage, far smaller harness.
//
// REQUIREMENTS refs:
//   §4-pre.7 — paint side-effect-free
//   §4-pre.8 — paint cache (id, bounds, generation)
//   §4-pre.9 — bumpGeneration is the ONLY way to signal output change
//   §5 F11   — cache invalidation must cover all input dispatch paths
//   §5 F12   — paint() must not mutate bounds
//
// Related: federation-guard-f11 (structural pattern guard) ·
//   federation-guard-f12 (structural paint mutation guard)

import { describe, expect, test } from 'bun:test';
import { DisplayCoordinator } from '../src/display/index.js';
import type { SurfaceId, DisplayMouseEvent, KeyEvent, Action } from '../src/display/index.js';
import type { ModalSurface } from '../src/display/modal-stack.js';

/** Synthesize a recipe-style modal surface — onKey/onMouse mutate
 *  internal state, paint() output reflects that state. Mirrors the
 *  shape of the dock launcher and other PopupAuthority-
 *  mounted recipes (mouse-action-recipes.ts:778). */
function makeRecipeSurface(opts: {
  id: string;
  generation?: number;            // omit = opt-out of paint cache (canonical recipe pattern)
  bumpOnInput?: boolean;          // when true, surface bumps generation on state change
}): ModalSurface & { state: { selectedIdx: number }; bumpFn?: () => void } {
  const state = { selectedIdx: 0 };
  let bumpFn: (() => void) | undefined = undefined;
  const ret: ModalSurface & { state: { selectedIdx: number }; bumpFn?: () => void } = {
    id: opts.id as SurfaceId,
    owner: 'dashboard',
    kind: 'modal',
    tier: 'popup',
    focus: 'owns',
    priority: 200,
    bounds: { row: 1, col: 1, width: 30, height: 5 },
    occluding: true,
    render: () => [],
    state,
    paint() {
      // Paint output reflects current selection — if cache returns
      // stale ANSI, this string lags behind state mutations.
      return `<recipe id=${opts.id} sel=${state.selectedIdx}>`;
    },
    onKey(ev: KeyEvent): 'consumed' | 'passthrough' {
      // Dashboard-side dispatch may invoke this DIRECTLY without
      // routing through coord.routeKey — that's the L8 scenario.
      if (ev.name === 'down') {
        state.selectedIdx += 1;
        // Some recipes also call coord.bumpGeneration from this path
        // when they opt in to caching. Test the both-cases matrix.
        if (opts.bumpOnInput && ret.bumpFn) ret.bumpFn();
        return 'consumed';
      }
      return 'passthrough';
    },
    onMouse(ev: DisplayMouseEvent): Action {
      if (ev.type !== 'click') return { type: 'none' };
      state.selectedIdx += 1;
      if (opts.bumpOnInput && ret.bumpFn) ret.bumpFn();
      return { type: 'refresh' };
    },
    ...(opts.generation !== undefined ? { generation: opts.generation } : {}),
  };
  return ret;
}

function buildHarness(): {
  coord: DisplayCoordinator;
  flush: () => void;
  overlayWrites: string[];
} {
  const overlayWrites: string[] = [];
  const scheduled: Array<() => void> = [];
  const coord = new DisplayCoordinator({
    frameMs: 16,
    schedule: (fn) => { scheduled.push(fn); return 0 as unknown as NodeJS.Timer; },
    onRender: () => { /* no-op */ },
    writeOverlay: (ansi) => { overlayWrites.push(ansi); },
  });
  const flush = (): void => {
    while (scheduled.length > 0) {
      const fn = scheduled.shift();
      fn?.();
    }
  };
  return { coord, flush, overlayWrites };
}

describe('L8 integration · dashboard-routed modal must not show stale ANSI', () => {
  test('recipe-style surface (no generation) — direct handler dispatch produces fresh paint output', () => {
    // Canonical pattern: dock menu, view picker, workspace shell
    // recipes. NO `generation` field declared → cache opt-out → no
    // stale-ANSI risk regardless of dispatch path.
    const { coord, flush, overlayWrites } = buildHarness();
    const surface = makeRecipeSurface({ id: 'recipe:dock-like' });
    coord.pushModal(surface);
    flush();
    const initialOverlay = overlayWrites[overlayWrites.length - 1] ?? '';
    expect(initialOverlay).toContain('sel=0');

    // Simulate dashboard-side dispatch: invoke onKey directly,
    // BYPASSING coord.routeKey. This is exactly what
    // mouseWiring.handleMouse + popupAuthority do for foreground
    // modals. State mutates without coord seeing the event.
    surface.onKey?.({ name: 'down' } as KeyEvent);

    // Force a redraw via coord's public API (callers like recipe's
    // deps.redraw() trigger this).
    coord.requestRender({ region: 'all' });
    flush();
    const afterOverlay = overlayWrites[overlayWrites.length - 1] ?? '';
    expect(afterOverlay).toContain('sel=1');           // fresh — no stale ANSI
    expect(afterOverlay).not.toContain('sel=0');
  });

  test('mouse click via direct handler dispatch — paint reflects new state', () => {
    const { coord, flush, overlayWrites } = buildHarness();
    const surface = makeRecipeSurface({ id: 'recipe:dock-like' });
    coord.pushModal(surface);
    flush();

    surface.onMouse?.({ type: 'click', row: 1, col: 1 } as DisplayMouseEvent);
    coord.requestRender({ region: 'all' });
    flush();
    const overlay = overlayWrites[overlayWrites.length - 1] ?? '';
    expect(overlay).toContain('sel=1');
  });

  test('REGRESSION GUARD · accidentally opting in (generation declared, no bump on input) leaves stale ANSI — proves the danger that #1406 caused', () => {
    // This test pins the failure mode: if a recipe author adds
    // `generation: 0` to opt in to the cache but FORGETS to bump on
    // dashboard-side input handlers, the cache returns stale ANSI.
    // This is exactly the dock-menu bug from #1406. The fact that
    // this test demonstrably FAILS to update the overlay is the
    // proof that the F11 + F12 default-safe rules matter.
    //
    // If a future developer removes the `typeof generation !== 'number'`
    // opt-in guard (the #1407 hot fix), test 1 above will start
    // exhibiting THIS same stale behavior — a true regression alarm.
    const { coord, flush, overlayWrites } = buildHarness();
    const surface = makeRecipeSurface({
      id: 'recipe:opt-in-no-bump',
      generation: 0,                // opt in
      bumpOnInput: false,           // BUT forgot to bump
    });
    coord.pushModal(surface);
    flush();
    overlayWrites.length = 0;       // clear initial paint

    surface.onKey?.({ name: 'down' } as KeyEvent);
    coord.requestRender({ region: 'all' });
    flush();
    // The overlay write should either be empty (skipped due to
    // byte-equality cache) or contain the OLD selection. Either way
    // it does NOT contain `sel=1`. This is the bug; opt-out default
    // (test 1 above) protects against it.
    const concatenated = overlayWrites.join('');
    expect(concatenated).not.toContain('sel=1');
  });

  test('correct opt-in (generation declared + bumpGeneration on input) produces fresh paint', () => {
    // This is what a recipe MUST do if it opts in to the cache.
    // Tests both halves of the contract together (F11 §4-pre.9
    // adoption guidance).
    const { coord, flush, overlayWrites } = buildHarness();
    const surface = makeRecipeSurface({
      id: 'recipe:opt-in-with-bump',
      generation: 0,
      bumpOnInput: true,
    });
    surface.bumpFn = () => { coord.bumpGeneration(surface.id); };
    coord.pushModal(surface);
    flush();
    overlayWrites.length = 0;

    surface.onKey?.({ name: 'down' } as KeyEvent);
    coord.requestRender({ region: 'all' });
    flush();
    const overlay = overlayWrites.join('');
    expect(overlay).toContain('sel=1');     // fresh — bump invalidated cache
  });

  test('repeated dashboard-side input — surfaceMountChurn stays low (not a mount loop)', () => {
    // Sanity: dispatching 10 keys to an existing surface should NOT
    // cause mount/unmount churn. Pin via the L5 counter (Phase 5).
    const { coord, flush } = buildHarness();
    const surface = makeRecipeSurface({ id: 'recipe:dock-like' });
    coord.pushModal(surface);
    flush();
    for (let i = 0; i < 10; i++) {
      surface.onKey?.({ name: 'down' } as KeyEvent);
      coord.requestRender({ region: 'all' });
      flush();
    }
    // Only 1 push event recorded (no remount). Mount churn should
    // stay at the threshold for "normal lifecycle" (1 push event).
    expect(coord.surfaceMountChurn(surface.id, 10_000)).toBe(1);
  });
});
