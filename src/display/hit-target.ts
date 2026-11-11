// IDX-F5 — HitTarget classification helpers.
//
// `display/types.ts` declares the `HitTarget` discriminated union
// itself (kept there because `DisplayMouseEvent.hitTarget?` references
// it and types.ts is import-root for the coordinator). This module
// holds the synthesis + inspection helpers that would otherwise bloat
// types.ts and pull in app-level imports.
//
// F5a scope (this landing):
//   • `classifyStatusBarHit(pills, statusRow, row, col)` — returns a
//     `pill` HitTarget when the click lands inside a known pill span,
//     a bare `status-bar` HitTarget for status-row clicks outside
//     every pill, or null for rows that aren't the status row. Used
//     by `dashboard-mouse-wiring` before routing.
//   • Type-guards (`isPillHit`, `isModalHit`, `isPaneHit`, `isVwHit`)
//     so downstream consumers can narrow without repeating the
//     `kind === ...` string literals.
//   • `hitTargetLabel(t)` — short diagnostic string for debug.log
//     categories (`'pill:model'`, `'pane-body:chat'`, `'modal-body'`
//     etc.). Keep keys stable; debug-log filters rely on them.
//
// F5b adds pane / modal / vw synthesis; F5c wires
// `View.describeHit(row, col)` for fine-grained `modal-body`
// `itemIndex` + `modal-button` `buttonId` reporting.

import type { HitTarget, HitPillName, SurfaceId, WidgetHitDescriptor } from './types.js';
import { pillAtColumn, type PillBound, type PillName } from '../status/pills.js';

// Compile-time compat check — if status-bar-pills.ts or
// display/types.ts drift, tsc will reject one of these lines.
type _PillNameCompat1 = HitPillName extends PillName ? true : never;
type _PillNameCompat2 = PillName extends HitPillName ? true : never;
const _pillNameCompat: _PillNameCompat1 & _PillNameCompat2 = true;
void _pillNameCompat;

/** IDX-F5a — status-bar hit classification. Returns:
 *   • `{kind:'pill', name}` when `(row, col)` lands inside a pill
 *   • `{kind:'status-bar'}` when the row matches the status row (or
 *     the visual one-above tolerance) but no pill is hit
 *   • `null` when the row isn't the status row at all
 *
 *  `statusRow` and `row` are 1-indexed (matches `DisplayMouseEvent`);
 *  `col` is 1-indexed too. `statusRow === null` means the status zone
 *  wasn't composed this frame — every event is a miss. The one-above
 *  tolerance (row === statusRow - 1) matches the existing
 *  status-bar hit tolerance: terminals occasionally report the
 *  pixel top-edge of a pill cell as row−1, and we want that to still
 *  classify as a pill hit. */
export function classifyStatusBarHit(
  pills: readonly PillBound[],
  statusRow: number | null,
  row: number,
  col: number,
): HitTarget | null {
  if (statusRow === null) return null;
  if (row !== statusRow && row !== statusRow - 1) return null;
  const col0 = col - 1;
  const hit = pillAtColumn(pills, col0);
  if (hit) {
    return { kind: 'pill', name: hit.name };
  }
  return { kind: 'status-bar' };
}

export function isPillHit(t: HitTarget | undefined | null): t is Extract<HitTarget, { kind: 'pill' }> {
  return !!t && t.kind === 'pill';
}

export function isModalHit(
  t: HitTarget | undefined | null,
): t is Extract<HitTarget, { kind: 'modal-body' | 'modal-title' | 'modal-button' }> {
  return !!t && (t.kind === 'modal-body' || t.kind === 'modal-title' || t.kind === 'modal-button');
}

export function isPaneHit(
  t: HitTarget | undefined | null,
): t is Extract<HitTarget, { kind: 'pane-nav-tab' | 'pane-title' | 'pane-body' }> {
  return !!t && (t.kind === 'pane-nav-tab' || t.kind === 'pane-title' || t.kind === 'pane-body');
}

export function isVwHit(
  t: HitTarget | undefined | null,
): t is Extract<HitTarget, { kind: 'vw-pane-title' | 'vw-pane-body' }> {
  return !!t && (t.kind === 'vw-pane-title' || t.kind === 'vw-pane-body');
}

export function isInputHit(
  t: HitTarget | undefined | null,
): t is Extract<HitTarget, { kind: 'input' }> {
  return !!t && t.kind === 'input';
}

/** Short, stable diagnostic label for debug.log categories. Avoid
 *  embedding user-supplied strings (paneId / modalId) when they'd
 *  blow up log cardinality — keep the label kind-level plus a small
 *  disambiguator for pill name. Callers that need full detail should
 *  log the full `HitTarget` as a snapshot object alongside. */
export function hitTargetLabel(t: HitTarget | undefined | null): string {
  if (!t) return 'none';
  switch (t.kind) {
    case 'pill':
      return `pill:${t.name}`;
    case 'pane-nav-tab':
      return 'pane-nav-tab';
    case 'pane-title':
      return 'pane-title';
    case 'pane-body':
      return 'pane-body';
    case 'modal-body':
      return 'modal-body';
    case 'modal-title':
      return 'modal-title';
    case 'modal-button':
      return 'modal-button';
    case 'vw-pane-title':
      return 'vw-pane-title';
    case 'vw-pane-body':
      return 'vw-pane-body';
    case 'status-bar':
      return 'status-bar';
    case 'input':
      // Cardinality rule (file header §hitTargetLabel) — do NOT embed
      // user-supplied `inputId`. Callers that need inputId should log
      // the full HitTarget alongside the label.
      return 'input';
  }
}

/** Convenience constructor — keeps `modalId` typing honest at call
 *  sites that already hold the surface id as a string. Used by F5b/c
 *  adopters. */
export function modalBodyHit(modalId: SurfaceId, itemIndex?: number): HitTarget {
  return itemIndex === undefined
    ? { kind: 'modal-body', modalId }
    : { kind: 'modal-body', modalId, itemIndex };
}

export function modalButtonHit(modalId: SurfaceId, buttonId: string): HitTarget {
  return { kind: 'modal-button', modalId, buttonId };
}

/** IDX-F5c — refinement reader for `p.clickable(... payload)` values
 *  registered by widgets. Recognized conventions:
 *
 *    • `{kind:'row', filtIdx: number}`   — SelectView / ListView row
 *    • `{kind:'button', buttonId: string}` — Dialog button bar
 *
 *  Anything else returns null, signaling modal-adapter should leave
 *  the coarse `{kind:'modal-body', modalId}` HitTarget unchanged.
 *  Kept deliberately narrow — widgets that need richer refinement
 *  should implement `View.describeHit` instead of bolting new payload
 *  shapes onto this reader. */
export function refineHitFromPayload(payload: unknown):
  | { kind: 'modal-body'; itemIndex: number }
  | { kind: 'modal-button'; buttonId: string }
  | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { kind?: unknown; filtIdx?: unknown; buttonId?: unknown };
  if (p.kind === 'row' && typeof p.filtIdx === 'number') {
    return { kind: 'modal-body', itemIndex: p.filtIdx };
  }
  if (p.kind === 'button' && typeof p.buttonId === 'string') {
    return { kind: 'modal-button', buttonId: p.buttonId };
  }
  return null;
}

/** IDX-F5d — compose a `pane-body` HitTarget from the wiring-layer
 *  classification + a `Widget.describeHit` refinement. Pure helper
 *  so the call-site in `getPaneHitTarget` stays readable and the
 *  composition is unit-testable without a live dashboard.
 *
 *  `refinement === null` → returned HitTarget omits the `hit` field
 *  (widget had no meaningful refinement for (bodyRow, bodyCol) —
 *  click on title row, empty area, non-implementing widget).
 *
 *  Mirrors `applyModalIdToRefinement` (above) but for the pane rail.
 *  Kept separate rather than a shared helper because the two sides
 *  carry different HitTarget shapes (modalId vs paneId + widgetId +
 *  body coords). */
export function applyPaneIdToRefinement(
  paneId: string,
  widgetInstanceId: string | undefined,
  bodyRow: number | undefined,
  bodyCol: number | undefined,
  refinement: WidgetHitDescriptor | null,
): Extract<HitTarget, { kind: 'pane-body' }> {
  const out: Extract<HitTarget, { kind: 'pane-body' }> = {
    kind: 'pane-body',
    paneId,
  };
  if (widgetInstanceId !== undefined) out.widgetInstanceId = widgetInstanceId;
  if (bodyRow !== undefined) out.bodyRow = bodyRow;
  if (bodyCol !== undefined) out.bodyCol = bodyCol;
  if (refinement !== null) out.hit = refinement;
  return out;
}

/** IDX-F5c — attach modalId to a View.describeHit / payload-reader
 *  refinement, returning the full HitTarget to write back to
 *  `ev.hitTarget`. Kept pure for unit-testability. */
export function applyModalIdToRefinement(
  modalId: SurfaceId,
  refinement:
    | { kind: 'modal-body'; itemIndex?: number }
    | { kind: 'modal-button'; buttonId: string }
    | null,
): HitTarget | null {
  if (!refinement) return null;
  if (refinement.kind === 'modal-body') {
    return refinement.itemIndex === undefined
      ? { kind: 'modal-body', modalId }
      : { kind: 'modal-body', modalId, itemIndex: refinement.itemIndex };
  }
  return { kind: 'modal-button', modalId, buttonId: refinement.buttonId };
}
