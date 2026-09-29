// ── IUL Phase S·a — SurfaceAddress (canonical surface identity) ──
//
// One discriminated union over every surface kind the IUL has to
// observe. Existing addressing schemes (PaneRef, ModalIdentity.modalId,
// WidgetInstance.id, …) are wrapped — never replaced — so legacy code
// keeps working unchanged.
//
// Why discriminated rather than a single string:
//   - capture / describe / observe tools branch on `kind` to dispatch
//     into the correct Layer A query path; structural narrowing
//     beats a string-prefix discipline that anyone could break by
//     mis-typing
//   - the union is **closed** — adding a kind requires a code change,
//     which catches missing dispatch arms at compile time
//
// Tiers (Phase Z) are intentionally NOT encoded here — `kind` is what
// you address, `tier` is where the surface lives in z-order. Two
// orthogonal axes.
//
// R5.3 family lock:
//   `SurfaceAddress.kind` is the canonical surface-family vocabulary.
//   It does NOT mean every kind has its own dedicated z-band or mount
//   substrate. Example:
//   - `window` still lives in the `vw` band
//   - `input` usually falls back to `inline`, but modal/popup-hosted
//     inputs must pass an explicit host tier
//   - `overlay` is a z-family concept today, not a `SurfaceAddress.kind`
// See `src/surface/z-tier.ts::SURFACE_KIND_FAMILY_POLICY`.

import type { PaneRef } from '../panes/types.js';

export type SurfaceKind =
  | 'pane'
  | 'modal'
  | 'widget'
  | 'popover'
  | 'inline'
  | 'bg'
  | 'window'
  | 'input';

export type SurfaceAddress =
  | { readonly kind: 'pane';     readonly ref: PaneRef }
  | { readonly kind: 'modal';    readonly modalId: string }
  | { readonly kind: 'widget';   readonly widgetId: string }
  | { readonly kind: 'popover';  readonly popoverId: string }
  | { readonly kind: 'inline';   readonly inlineId: string }
  | { readonly kind: 'bg';       readonly bgId: string }
  // Addresses a Virtual Window as a whole (layout container).
  // The address remains accepted by surface tools, but dashboard wiring
  // no longer registers Virtual Windows as surfaces.
  //
  // Widget-team ack for shared-union extension: SYNC #245
  // (내부 문서 `SYNC-widget-to-term-b13-surface-address-coord`).
  | { readonly kind: 'window';   readonly windowId: number }
  // F4-P1 (2026-04-21) — addresses a live text-input instance (chat
  // main, modal prompt, pane-hosted, popup, …). Phase 1 only registers
  // the existing `textInput()` as `inputId='chat-main'` — focus
  // semantics unchanged. Later phases use this address to disambiguate
  // multi-input routing. See 내부 문서 `CAPABILITIES-multi-input-surface`
  // and 내부 문서 `PLAN-vw-startup-bundle-2026-04-21` §F4.
  | { readonly kind: 'input';    readonly inputId: string };

export function surfaceKey(addr: SurfaceAddress): string {
  switch (addr.kind) {
    case 'pane':
      return `pane::${addr.ref.windowId}::${addr.ref.paneId}::${addr.ref.runnerLabel ?? ''}`;
    case 'modal':    return `modal::${addr.modalId}`;
    case 'widget':   return `widget::${addr.widgetId}`;
    case 'popover':  return `popover::${addr.popoverId}`;
    case 'inline':   return `inline::${addr.inlineId}`;
    case 'bg':       return `bg::${addr.bgId}`;
    case 'window':   return `window::${addr.windowId}`;
    case 'input':    return `input::${addr.inputId}`;
  }
}

export function isSurfaceKind(value: unknown): value is SurfaceKind {
  return value === 'pane' || value === 'modal' || value === 'widget'
    || value === 'popover' || value === 'inline' || value === 'bg'
    || value === 'window' || value === 'input';
}

export function sameSurface(a: SurfaceAddress, b: SurfaceAddress): boolean {
  return surfaceKey(a) === surfaceKey(b);
}
