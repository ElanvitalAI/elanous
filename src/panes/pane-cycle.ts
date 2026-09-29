// ── VW-term Bundle B-7-δ · intra-window pane cycling ──
//
// Pure selection function: given an ordered list of pane ids, the
// current focus, a direction, and a skip predicate, pick the next
// pane to focus (or null when no cycle is possible). No state, no
// side-effects — the dashboard-side chord handler owns the actual
// `setFocus` call.
//
// Consumed by `dashboard-vw-fast-switch.ts` on `Alt+o` / `Alt+O`.
// Skip predicate is typically `isAltSkipEligible` composed with
// `paneVisualStateStore.snapshot(ref)`, mirroring the B-7-α window
// skip at pane granularity.
//
// PLAN: 내부 문서 `PLAN-vw-term-bundle-b7-delta-alt-o-pane-cycle`

type PaneId = string;

export type PaneCycleDirection = 'forward' | 'backward';

export interface SelectNextPaneArgs {
  /** Pane ids in window-order (VirtualWindow.listPanes Map insertion
   *  order). Empty or single-element arrays short-circuit to null. */
  panes: readonly PaneId[];
  /** Currently focused pane id. When not in `panes` the result is
   *  null — caller guards by reading `window.focused` after confirming
   *  the window still exists. */
  currentFocus: PaneId;
  direction: PaneCycleDirection;
  /** Returns true when the pane should be skipped by Alt+o cycling.
   *  Typically wraps the PaneVisualStateStore + `isAltSkipEligible`
   *  predicate, but testable stubs pass simple sets. */
  isSkipEligible: (paneId: PaneId) => boolean;
}

/** Pick the next focusable pane in the cycle. Returns null when:
 *   - `panes.length <= 1` (nothing to cycle to)
 *   - `currentFocus` isn't in `panes` (pathological host state)
 *   - every other pane is skip-eligible (silent no-op — caller
 *     should not call `setFocus`)
 *
 *  Complexity: O(n) worst case · n = panes.length. Wraps around the
 *  end of the list, so starting from `panes[n-1]` with direction
 *  `forward` probes `panes[0]`, `panes[1]`, ... until a non-skipped
 *  pane is found or the loop returns to `currentFocus`. */
export function selectNextFocusablePane(args: SelectNextPaneArgs): PaneId | null {
  const { panes, currentFocus, direction, isSkipEligible } = args;
  if (panes.length <= 1) return null;
  const idx = panes.indexOf(currentFocus);
  if (idx < 0) return null;
  const n = panes.length;
  const step = direction === 'forward' ? 1 : -1;
  // `(idx + step*k + n*n) % n` keeps the index non-negative for any
  // reasonable n (we use +n*n instead of +n to tolerate step*k being
  // larger than a single n — cheap guard against future callers
  // tweaking the loop bound).
  for (let k = 1; k < n; k++) {
    const cand = panes[(idx + step * k + n * n) % n]!;
    if (!isSkipEligible(cand)) return cand;
  }
  return null;
}
