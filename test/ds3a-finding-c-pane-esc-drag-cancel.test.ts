// DS-3a-follow (Finding C · 2026-04-22) · regression guard.
//
// PR #343 Session B post-merge review identified a gap: the pane
// key loop's shared ESC handler at `src/dashboard.ts` fires
// `setWorkingFocus('input', 'pane-escape')` even when a DragSession
// is active — orphaning the drag in idle mode.
//
// A-5b.3 (2026-04-22) replaced the initial direct-cancel fix with a
// dispatcher-first route: pane-ESC goes through `routeInputEventAsync`
// whose A-8 guard consumes drag-active ESC. This test locks the
// NEW structural invariant — pane-escape handler must be preceded by
// a `routeInputEventAsync` call that wires `dragManager`. A future
// refactor that drops the route (or wires an empty dragManager) fails
// this test loudly.
//
// 2026-07-07 · dashboard decomposition: the pane common-key handler
// moved out of the dashboard entry (index) into
// `src/dashboard/input/pane-common-key-route.ts`. The pane-escape
// transition is now `deps.enterInput({ ... reason: 'pane-escape' })`
// preceded by `await deps.tryConsumeEscape?.()`, and the dispatcher
// route + dragManager wire live at the `routePaneCommonKey` call site
// in the TUI source bundle (tryConsumeEscape body). The invariant
// is unchanged — pane-ESC must hit routeInputEventAsync (A-8 guard)
// with a live dragManager BEFORE the escape transition — it is just
// asserted across the two files the decomposition split it into.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { tuiSourceText } from './helpers/dashboard-source.js';

const PANE_COMMON_KEY_ROUTE_TS = join(
  import.meta.dir, '..', 'src', 'dashboard', 'input', 'pane-common-key-route.ts',
);

describe('DS-3a-follow · pane-ESC drag-cancel guard (Finding C · A-5b.3)', () => {
  test('pane-escape transition is preceded by the tryConsumeEscape dispatcher hook', () => {
    const src = readFileSync(PANE_COMMON_KEY_ROUTE_TS, 'utf8');
    // Find the 'pane-escape' reason string — anchor for the handler
    // body (the enterInput transition the drag guard must precede).
    const paneEscapeIdx = src.indexOf(`reason: 'pane-escape'`);
    expect(paneEscapeIdx).toBeGreaterThan(-1);
    // The window immediately BEFORE this site must await the
    // dispatcher hook so a drag-active ESC is consumed before the
    // focus transition fires. 800 is generous; the current shape
    // places it within ~5 lines.
    const windowStart = Math.max(0, paneEscapeIdx - 800);
    const preamble = src.slice(windowStart, paneEscapeIdx);
    expect(preamble).toContain('await deps.tryConsumeEscape?.()');
  });

  test('dashboard wires tryConsumeEscape with routeInputEventAsync + dragManager', () => {
    const src = tuiSourceText();
    // Anchor on the routePaneCommonKey call site — its deps literal
    // must wire tryConsumeEscape through the input-core dispatcher
    // with a live dragManager (A-8 guard).
    const callSiteIdx = src.indexOf('routePaneCommonKey(key, {');
    expect(callSiteIdx).toBeGreaterThan(-1);
    const window = src.slice(callSiteIdx, Math.min(src.length, callSiteIdx + 1200));
    expect(window).toContain('tryConsumeEscape: async () =>');
    expect(window).toContain('inputCoreRouteInputEventAsync');
    expect(window).toContain('dragManager: display.dragManagerAPI()');
  });
});
