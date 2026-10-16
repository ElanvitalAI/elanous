// ── A-5b.3 · direct-cancel cleanup regression guard ──
//
// A-5b.3 replaced the DS-3a-follow direct-cancel pattern with a
// dispatcher-first route · A-8 ESC guard becomes the single source
// of truth for drag-ESC cancel across:
//   1. `src/dashboard.ts` streaming ESC handler
//   2. `src/dashboard.ts` pane-ESC handler (Finding C site)
//   3. `src/dashboard.ts` textInput `opts.onEscape` — fully removed
//      (A-5b.2's `opts.onKey` supersedes · the branch became dead
//      code)
//
// These structural tests pin the new shape so a future refactor that
// restores the direct-cancel (or removes the dispatcher route)
// triggers a loud failure rather than silent regression.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { tuiSourceText } from './helpers/dashboard-source.js';


describe('A-5b.3 · textInput opts.onEscape removed', () => {
  test('dashboard textInput call site no longer wires drag-aware opts.onEscape', () => {
    const src = tuiSourceText();
    // Before A-5b.3 there was exactly one `onEscape: () => {` in
    // dashboard.ts (inside the textInput opts literal). A-5b.3
    // removed it · A-5b.2's `opts.onKey` handles the drag path via
    // `routeInputEventAsync`.
    const hits = src.match(/onEscape:\s*\(\)\s*=>\s*{/g) ?? [];
    expect(hits.length).toBe(0);
  });

  test('dashboard textInput call site wires opts.onKey with dragManager', () => {
    // 2026-07-07 · dashboard decomposition: the textInput opts literal
    // moved into `src/dashboard/input/chat-main-interaction-opts.ts`
    // whose `onKey: async (key) =>` delegates to `deps.routeInputKey`.
    // The dispatcher route body (routeInputEventAsync + dragManager)
    // now lives at the `routeInputKey: async (key) =>` wire in
    // the TUI source bundle (dashboard entry). Same invariant, asserted across both halves
    // of the seam so neither side can silently drop the drag guard.
    const optsSrc = readFileSync(
      join(import.meta.dir, '..', 'src', 'dashboard', 'input', 'chat-main-interaction-opts.ts'),
      'utf8',
    );
    const onKeyIdx = optsSrc.indexOf('onKey: async (key) =>');
    expect(onKeyIdx).toBeGreaterThan(-1);
    const onKeyWindow = optsSrc.slice(onKeyIdx, Math.min(optsSrc.length, onKeyIdx + 700));
    expect(onKeyWindow).toContain('deps.routeInputKey(key)');

    const src = tuiSourceText();
    const routeKeyIdx = src.indexOf('routeInputKey: async (key) =>');
    expect(routeKeyIdx).toBeGreaterThan(-1);
    // Window widened 700 → 1500: the route body carries a long
    // provenance comment (A-5b.2/A-5b.3 history) before the dispatch.
    const routeKeyWindow = src.slice(routeKeyIdx, Math.min(src.length, routeKeyIdx + 1500));
    expect(routeKeyWindow).toContain('inputCoreRouteInputEventAsync');
    expect(routeKeyWindow).toContain('dragManager: display.dragManagerAPI()');
  });
});

describe('A-5b.3 · all three ESC call sites now dispatcher-first', () => {
  test('no `dm.cancelAll(\\\'escape\\\')` literal remains in dashboard.ts', () => {
    const src = tuiSourceText();
    // The A-8 guard in `src/input-core/dispatcher.ts` owns the one
    // `cancelAll('escape')` call in the codebase now. Dashboard sites
    // delegate via routeInputEventAsync · no direct literal remains.
    expect(src).not.toContain("dm.cancelAll('escape')");
  });

  test('three `inputCoreRouteInputEventAsync` call sites (streaming key + streaming ESC + pane ESC + textInput onKey)', () => {
    // Expected call sites (4):
    //   1. runStreamingKeyUnifiedDispatch body (A-5b.1)
    //   2. streaming ESC handler (A-5b.3)
    //   3. pane-ESC handler (A-5b.3 · Finding C replacement)
    //   4. textInput opts.onKey (A-5b.2)
    const src = tuiSourceText();
    const hits = src.match(/inputCoreRouteInputEventAsync/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(4);
  });
});
