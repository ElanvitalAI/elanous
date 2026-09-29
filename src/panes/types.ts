// ── VW-term-infra Phase 1 — Pane contract ──
//
// "Pane" is the substrate-level abstraction for anything that owns a
// rectangular region inside a Virtual Window (VW) and receives user
// input / LLM tool calls / capture taps through a unified contract.
// Every existing pane kind (terminal · external-terminal · widget ·
// placeholder) ends up behind this contract so capture, layout,
// visibility, and symmetry-bridge logic can treat them uniformly.
//
// Phase 1 status — CONTRACT ONLY:
// This file defines the types and interfaces; concrete implementations
// land in `terminal-pane.ts`, `external-terminal-pane.ts`, `widget-pane.ts`,
// `placeholder-pane.ts`. Dashboard-side polymorphic dispatch (replacing
// the dashboard case-kind switch) arrives in a
// later commit — this module is additive, behavior-preserving, and
// compiles alone.
//
// See: 내부 문서 `PLAN-session-vw-term-infra` §4 Layer A/B
//      내부 문서 `PLAN-session-vw-term-infra-p0-p2` §3
//      내부 문서 `ROADMAP-vw-term-infra` §7 "아름다움 원칙"

import type { Rect } from '../display/rect.js';
import type { PaneSnapshot, SnapshotOpts } from './snapshot.js';
import type { TapCallback, TapKind, Unsubscribe } from './tap.js';

// ── Pane addressing ─────────────────────────────────────────────

/** Canonical address for a pane. Stable across placement moves —
 *  that is the point. Phase 4's PaneVisualState subscribes per ref.
 *
 *  `runnerLabel` is populated only for external-terminal panes whose
 *  content comes from the Shell Runner registry. Null for native
 *  terminal / widget / placeholder panes. */
export interface PaneRef {
  readonly windowId: string;
  readonly paneId: string;
  readonly runnerLabel?: string;
}

/** Pane kind — discriminated union. The four kinds today exactly
 *  correspond to the slot-kind case-branches in VW rendering. Phase 1
 *  funnels them through a single Pane interface instead.
 *
 *  WT-S-3 added `web-terminal` as the 5th kind so PWA-spawned PreviewTerminals
 *  participate in the same Pane contract — capture engine, ObserveSurface,
 *  ComparePanes / WatchPane, snapshot etc. all auto-apply once a webterm
 *  is resolved through the factory. The `terminalId` here is the
 *  preview-tap-registry key (sessionId is implied by the registry lookup
 *  done at resolve time). */
export type PaneKind =
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'external-terminal'; shellHandleId: string }
  | { kind: 'widget'; widgetId: string; widgetClass: string }
  | { kind: 'web-terminal'; sessionId: string; terminalId: string }
  | { kind: 'placeholder'; reason: 'empty' | 'error' | 'loading' };

// ── Pane description & introspection ────────────────────────────

/** What a pane advertises about itself. Consumed by:
 *   • `DescribePane` LLM tool (Phase 5 · §7 symmetry bridge)
 *   • Capture `InspectPane` tool (Capture Phase 2)
 *   • CaptureController widget (future floating status)
 *   • `Ctrl+?` user help overlay (future)
 *
 *  Phase 1 populates ref/kind/title/summary; Phase 2a fills supportedTaps;
 *  Phase 5 populates chords/tools. Until then those arrays are `[]`. */
export interface PaneDescription {
  readonly ref: PaneRef;
  readonly kind: PaneKind;
  readonly title: string;
  /** Human-readable summary shown in tooltips + tool responses. */
  readonly summary: string;
  /** Tap kinds this pane actually emits. `[]` until Phase 2a lands. */
  readonly supportedTaps: readonly TapKind[];
  /** User chords that target this pane. `[]` until Phase 5. */
  readonly chords: readonly ChordHint[];
  /** LLM tools that target this pane. `[]` until Phase 5. */
  readonly tools: readonly ToolHint[];
}

/** One entry in `PaneDescription.chords` — describes a user-facing
 *  keyboard interaction. Phase 5 syncs this with `mirrorTool`. */
export interface ChordHint {
  readonly chord: string;          // e.g. 'Ctrl+B s'
  readonly label: string;          // e.g. 'capture screenshot'
  readonly mirrorTool?: string;    // e.g. 'Screenshot'
}

/** One entry in `PaneDescription.tools` — describes an LLM-facing
 *  tool call that targets this pane. Phase 5 syncs with `mirrorChord`. */
export interface ToolHint {
  readonly tool: string;           // e.g. 'Screenshot'
  readonly label: string;
  readonly mirrorChord?: string;
}

// ── Pane interaction primitives ────────────────────────────────

/** Normalized keyboard event delivered to panes. Intentionally a
 *  minimal shape so different kinds can share; the widget-host
 *  KeyEvent, display-layer KeyEvent, and tty-level Key get adapted
 *  into this shared form by the dashboard dispatcher. */
export interface PaneKeyEvent {
  readonly key: string;
  readonly raw?: string;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
}

/** Mouse event delivered to panes. 0-indexed row/col inside the pane
 *  (dashboard dispatcher translates from absolute screen coords). */
export interface PaneMouseEvent {
  readonly kind: 'click' | 'double-click' | 'move' | 'down' | 'up' | 'scroll-up' | 'scroll-down' | 'drag';
  readonly row: number;
  readonly col: number;
  readonly button?: 'primary' | 'secondary' | 'middle';
  readonly modifiers?: { ctrl?: boolean; alt?: boolean; shift?: boolean };
}

/** Three-way dispatch result matching the widget-host convention.
 *  'consumed' = handled, skip further routing; 'passthrough' = let
 *  outer loops keep looking; 'quit' = app-level exit. */
export type PaneDispatchResult = 'consumed' | 'passthrough' | 'quit';

// ── Pane click regions (for hit-testing) ───────────────────────

/** A named region inside the pane the host can register with
 *  ClickRegistry. Phase 4 reworks this into PaneVisualState-aware
 *  HitTarget; Phase 1 keeps it minimal. */
export interface ClickRegion {
  readonly id: string;
  readonly rect: Rect;
  readonly kind?: string;
}

// ── Pane lifecycle context ─────────────────────────────────────

/** What the host provides when mounting a pane. Intentionally minimal —
 *  the host controls resize / focus / visibility; the pane only
 *  observes + reacts. */
export interface PaneContext {
  /** Absolute screen bounds — updated on every resize. */
  readonly bounds: Rect;
  /** Unsubscribe from every context-owned listener. Called by the
   *  host during unmount. Panes that register their own callbacks
   *  chain them into this. */
  readonly onUnmount: (cb: () => void) => void;
}

// ── The Pane contract ──────────────────────────────────────────

/** The canonical Pane interface. Every PaneKind implements it.
 *
 *  Phase 1 lands render/onKey/onMouse/describe + lifecycle.
 *  Phase 2a adds addTap (and populates PaneDescription.supportedTaps).
 *  Phase 2b fills snapshot() end-to-end (currently a stub on
 *  non-terminal kinds).
 *  Phase 5 populates describe().chords/tools. */
export interface Pane {
  readonly ref: PaneRef;
  readonly kind: PaneKind;

  /** Render the pane into `bounds`. Returns click regions the host
   *  should register with ClickRegistry for this frame. */
  render(bounds: Rect): readonly ClickRegion[];

  /** Keystroke delivery. Return 'passthrough' to let the outer
   *  router keep trying other handlers. */
  onKey(evt: PaneKeyEvent): PaneDispatchResult | Promise<PaneDispatchResult>;

  /** Mouse delivery. Same convention as onKey. */
  onMouse(evt: PaneMouseEvent): PaneDispatchResult | Promise<PaneDispatchResult>;

  /** Advertise state for LLM tools, hover tooltips, CaptureController. */
  describe(): PaneDescription;

  /** Point-in-time snapshot. Phase 2b fills this out per kind.
   *  Phase 1 stubs may return an "empty" snapshot with just dims
   *  + meta; the interface is stable. */
  snapshot(opts?: SnapshotOpts): Promise<PaneSnapshot>;

  /** Subscribe to raw / frame / event chunks from this pane. Phase
   *  2a populates the per-kind implementation. Phase 1 implementations
   *  may throw `PaneTapNotSupportedError` for taps they don't support
   *  yet — call `describe().supportedTaps` first to avoid. */
  addTap(kind: TapKind, cb: TapCallback, opts?: TapOptions): Unsubscribe;

  /** One-shot lifecycle hook — called after the pane is placed in a
   *  surface slot. */
  mount(ctx: PaneContext): void;

  /** One-shot lifecycle hook — called before the pane is removed. */
  unmount(): void;
}

/** Options bag for `addTap`. Phase 2a adds throttle + backpressure. */
export interface TapOptions {
  /** Min ms between callback invocations (frame / event taps only). */
  readonly throttleMs?: number;
  /** Max buffered bytes before chunks get dropped (raw tap only). */
  readonly maxBufferBytes?: number;
}
