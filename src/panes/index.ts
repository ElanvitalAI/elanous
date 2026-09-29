// ── VW-term-infra substrate · public API ──
//
// Consolidated re-export for the Pane substrate. Dashboard + capture
// engine + future Phase 3+ consumers import everything they need from
// here. Types + base + 4 concrete pane kinds, plus tap + snapshot
// contracts.
//
// Status (2026-04-20):
//   Phase 0 — invariant lattice (landed in prior commit)
//   Phase 1 — Pane contract + 4 pane-kind stubs (this commit · structural only)
//   Phase 2a — tap contract defined (raw supported on terminal / external-terminal)
//   Phase 2b — snapshot contract defined (terminal returns ANSI;
//              widget / external-terminal placeholder-empty for now)
//
// See: 내부 문서 `ROADMAP-vw-term-infra`
//      내부 문서 `PLAN-session-vw-term-infra-p0-p2`

export { AbstractPane } from './base.js';
export { ExternalTerminalPane } from './external-terminal-pane.js';
export { PlaceholderPane } from './placeholder-pane.js';
export type { PlaceholderReason } from './placeholder-pane.js';
export { TerminalPane } from './terminal-pane.js';
export { WidgetPane } from './widget-pane.js';

// W1 — factory
export {
  PaneFactory,
  getDefaultPaneFactory,
  __setDefaultPaneFactory,
} from './factory.js';

export {
  PaneTapNotSupportedError,
  type FrameChunk,
  type PaneEvent,
  type RawChunk,
  type TapCallback,
  type TapKind,
  type Unsubscribe,
} from './tap.js';

export {
  emptySnapshot,
  type ANSICell,
  type PaneSnapshot,
  type SnapshotOpts,
} from './snapshot.js';

export type {
  ChordHint,
  ClickRegion,
  Pane,
  PaneContext,
  PaneDescription,
  PaneDispatchResult,
  PaneKeyEvent,
  PaneKind,
  PaneMouseEvent,
  PaneRef,
  TapOptions,
  ToolHint,
} from './types.js';

// Bundle A · A3 — PaneVisualState contract + store (Phase 4 seed)
export {
  createVisualStateStore,
  isAltSkipEligible,
  DEFAULT_VISUAL_STATE,
  PANE_FOCUS,
  PANE_FOCUS_POLICY,
  PANE_PLACEMENT,
  PANE_VISIBILITY,
  type PaneFocus,
  type PaneFocusPolicy,
  type PanePlacement,
  type PaneVisibility,
  type PaneVisualState,
  type PaneVisualStateStore,
  type PaneVisualStateSubscriber,
} from './visual-state.js';
