// ── Widget type system ──
// Widgets are reusable, renderable units that dashboards compose into a
// grid layout. A widget TYPE (Widget / WidgetDef) is the module — one
// per kind of thing that can render (list, markdown, chart, …). A
// widget INSTANCE (WidgetInstance) is a placed copy with its own state,
// config, and user-visible character (title/role).
//
// Phase 1 of widget-arch refactor (2026-04-19): Widget<S> extends the
// legacy WidgetDef<S> contract with lifecycle hooks, behavior mixins,
// children composition, and presentation stubs (theme / style). See
// 내부 문서 `PLAN-session-widget-arch-refactor` §4 Layer 1-2 + §6 Phase 1.
//
// WidgetDef<S, Config> stays as a type alias to Widget<S, Config> so
// every existing call site compiles unchanged. New widgets should
// import Widget; existing widgets can migrate incrementally.
//
// Mirrors the plugin-types.ts contract: types only, no runtime code.
// Runtime lives in widget-host.ts.

import type { KeyEvent, Action, RenderCtx } from '../plugins/core/types.js';
import type { DisplayHandle, WidgetHitDescriptor } from '../display/types.js';
import type { WidgetBehavior } from '../widget-behaviors/types.js';

export type { KeyEvent, Action, RenderCtx, WidgetHitDescriptor };

/** IDX-F5d Phase 2 (2026-04-22) — widget hover event payload. One of
 *  four lifecycle kinds; each carries the `WidgetHitDescriptor`
 *  matching the pointer's current position. `hover-over` additionally
 *  carries pointer coordinates for tooltip positioning.
 *
 *  Parallel to the modal-rail hover events in src/ui/hover-tracker.ts
 *  (`HoverEvent`) — different shape because widgets don't have modal
 *  surface ids and the `hit` discriminator is wider. */
export type WidgetHoverEvent =
  | { kind: 'hover-enter'; hit: WidgetHitDescriptor }
  | { kind: 'hover-leave'; hit: WidgetHitDescriptor }
  | { kind: 'hover-over'; hit: WidgetHitDescriptor; row: number; col: number }
  | { kind: 'hover-stable'; hit: WidgetHitDescriptor };

// ════════════════════════════════════════════════════════════════════
// Presentation types — Phase 1 stubs (implementations land in Phase 2).
// Research basis: 내부 문서 `RESEARCH-tui-presentation-patterns` §2-4.
// ════════════════════════════════════════════════════════════════════

/** 25 semantic color tokens — Zellij + Flutter ColorScheme M3 hybrid.
 *  Phase 2 (ColorScheme.resolve) maps tokens → PaletteColor per theme. */
export type ColorToken =
  // Surface (background surfaces)
  | 'surface' | 'surface.raised' | 'surface.overlay' | 'surface.sunken'
  // Text
  | 'text' | 'text.muted' | 'text.disabled' | 'text.placeholder' | 'text.accent'
  // Border
  | 'border' | 'border.focused' | 'border.accent' | 'border.disabled'
  // Semantic status
  | 'success' | 'warning' | 'error' | 'info'
  // Diff
  | 'diff.add.fg' | 'diff.add.bg' | 'diff.del.fg' | 'diff.del.bg'
  // Interactive
  | 'highlight.fg' | 'highlight.bg' | 'pressed.fg' | 'pressed.bg';

/** 4-tier accent emphasis. Zellij's 'emphasis_0..3' pattern — each
 *  semantic token can return a dimmer/brighter variant. */
export type ColorEmphasis = 0 | 1 | 2 | 3;

/** Widget interaction state — AppCUI-rs 5-state pattern + 'selected'. */
export type WidgetState =
  | 'default' | 'hovered' | 'focused' | 'pressed' | 'disabled' | 'selected';

/** State-driven value map. `default` is required as fallback. */
export type StateMap<T> = { default: T } & Partial<Record<Exclude<WidgetState, 'default'>, T>>;

/** Border line style. 'none' renders no border. */
export type BorderLineStyle =
  | 'none' | 'single' | 'double' | 'heavy' | 'rounded' | 'dashed';

/** Which sides of the widget to draw. Omit = all four. */
export type BorderSide = 'top' | 'right' | 'bottom' | 'left';

export interface BorderSpec {
  style: BorderLineStyle;
  color?: ColorToken;
  emphasis?: ColorEmphasis;
  /** Default = all four sides. */
  sides?: readonly BorderSide[];
}

export interface PaddingSpec {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

/** Shadow via half-block + dim color. TUI approximation of Flutter
 *  BoxShadow — no blur, 1-2 layer max (VTM pattern). */
export interface ShadowSpec {
  /** Cell offset — 1 cell down/right is the typical default. */
  offsetX: number;
  offsetY: number;
  color?: ColorToken;
  /** 0-1.0 — how much to dim. Phase 4 animation can tween this. */
  opacity?: number;
}

/** Modern terminal text attributes — superset of legacy bold/italic.
 *  AppCUI-rs CharFlags pattern. */
export interface TextAttrFlags {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** CSI 21m — supported in modern terminals. */
  doubleUnderline?: boolean;
  /** CSI 4:3 — curly underline (iTerm, kitty, wezterm). */
  curlyUnderline?: boolean;
  /** CSI 4:4 — dotted underline. */
  dottedUnderline?: boolean;
  /** CSI 9m — strikethrough. */
  strikethrough?: boolean;
  /** CSI 53m — overline. */
  overline?: boolean;
  /** CSI 7m — reverse video. */
  reverse?: boolean;
  /** CSI 5m — slow blink. Use sparingly. */
  blink?: boolean;
}

/** A single style spec — Flutter BoxDecoration-inspired layered model.
 *  Phase 2 Themable behavior applies this to the widget frame. */
export interface StyleSpec {
  bg?: ColorToken;
  bgEmphasis?: ColorEmphasis;
  fg?: ColorToken;
  fgEmphasis?: ColorEmphasis;
  border?: BorderSpec;
  padding?: PaddingSpec;
  shadow?: ShadowSpec;
  textAttrs?: TextAttrFlags;
}

/** Base class for plugin-contributed theme tokens. Flutter pattern —
 *  lerp() lets future animation arc interpolate between themes. */
export abstract class ThemeExtension<T extends ThemeExtension<T>> {
  abstract copyWith(): T;
  abstract lerp(other: T | null, t: number): T;
}

/** Raw palette color — Phase 2 implementation maps ColorToken → this. */
export type PaletteColor =
  | { kind: 'ansi'; index: number }          // 0-255 palette lookup
  | { kind: 'rgb'; r: number; g: number; b: number }  // 24-bit
  | { kind: 'default' };                       // terminal default fg/bg

/** Inherited theme reference passed through WidgetContext. Phase 1
 *  widgets see a stub whose resolve() returns sensible defaults;
 *  Phase 2's Themable behavior and ColorScheme.fromSeed fill this in
 *  for real. React-style O(1) stack cursor (not Flutter ancestor walk).
 */
export interface ThemeRef {
  /** Resolve a semantic token to a concrete palette color. */
  resolve(token: ColorToken, emphasis?: ColorEmphasis): PaletteColor;
  /** 'dark' or 'light' or plugin-contributed name. */
  readonly schemeName: string;
  readonly brightness: 'dark' | 'light';
  /** ThemeExtension<T> getter — plugin tokens lookup. */
  getExtension<T extends ThemeExtension<T>>(
    type: abstract new (...args: never[]) => T,
  ): T | null;
}

/** Style resolution context. Phase 1 stub returns state='default';
 *  Phase 2 StateStyleable behavior wires state transitions. */
export interface StyleContext<S = unknown> {
  readonly state: WidgetState;
  /** Pick the right StyleSpec for current state, falling back to
   *  StateMap.default when a state-specific entry is absent. */
  resolve(styleMap: StateMap<StyleSpec>): StyleSpec;
  /** Temporarily override style fields inside `fn` — useful for
   *  "one-shot pressed visual" without mutating the persistent map. */
  withOverride(override: Partial<StyleSpec>, fn: () => void): void;
}

// ════════════════════════════════════════════════════════════════════
// Widget context (Phase 1 adds theme + style — optional on init to
// preserve backward compat for widgets that don't render frames).
// ════════════════════════════════════════════════════════════════════

/** Context passed to a widget's handlers — mirrors PluginContext but
 *  scoped to a single instance. The widget never imports the dashboard
 *  directly; anything it needs goes through this ctx. */
export interface WidgetContext<S = unknown> {
  widgetId: string;        // instance id in the current layout
  widgetType: string;      // the def.type this instance was spawned from
  character: string;       // user-visible title / role
  state: S;
  /** Optional scoped display command handle. Widgets should use this
   *  for future surface/focus/render requests instead of direct
   *  dashboard coupling. */
  display?: DisplayHandle;
  /** Merge a partial state patch and trigger re-render. */
  setState(patch: Partial<S>): void;
  /** Request a re-render without mutating state (e.g. config-driven). */
  requestRender(): void;
  /** Dispose this widget — the host removes its layout entry. */
  dismiss(): void;
  /** Append a log line (goes to the fixed log pane). */
  log(line: string): void;

  // ── Phase 1 presentation stubs ────────────────────────────────────
  // Optional because the dashboard's WidgetHost currently builds ctxs
  // without theme/style wiring. Phase 2 makes them required once
  // Themable/StateStyleable land and every host call site injects
  // them. Until then, a widget that needs a frame style must check
  // for presence and fall back to its own defaults.
  readonly theme?: ThemeRef;
  readonly style?: StyleContext<S>;

  // ── Phase 4 telemetry hook (2026-04-20) ───────────────────────────
  // Widget lifecycle / interaction events flow to the host's sink
  // (e.g. the P8 Lab Inspector). Default sink = no-op when the host
  // doesn't wire one. Widgets call ctx.telemetry?.emit({...}) at
  // interesting moments (selection change, error, external effect).
  readonly telemetry?: TelemetrySink;

  // ── Phase 4b animation hook (2026-04-20) ──────────────────────────
  // Per-instance AnimationController. Widget uses it to start tweens
  // (scroll, opacity, color) and sample progress during render. Host
  // optionally wires requestRender to tick while any tween is active.
  readonly animate?: AnimationHandle;

  // ── Phase 4c canvas hook (2026-04-20) ─────────────────────────────
  // High-density pixel buffer. Widget calls `ctx.canvas?.create(w, h, mode)`
  // to get a Canvas sized for the subcells the mode provides (braille
  // 2×4, quadrant 2×2, ascii 1×1) — paint pixels, then `canvas.render()`
  // returns string[] lines ready to splice into the widget's render
  // output. Host-level factory so later sessions can swap default mode
  // via config without widget changes.
  readonly canvas?: CanvasFactoryHandle;

  // ── WR-3 (2026-04-20 · Bundle 6W · IUL Phase Z consumer) ──────────
  // Read-only z-order hints the host injects from SurfaceRegistry after
  // Phase Z (PR #188). `undefined` when the host-level zInfo callback
  // isn't wired (test harnesses, headless runs) — widgets that use
  // these fields must handle absence.
  //
  // Widgets read these to optimize rendering (e.g. modal-tier widget
  // draws inner shadow; vw-tier widget draws flat) or to include
  // z-semantics in `describeSurface` ("modal widget · 3rd in stack").

  /** The widget's z-tier as rolled up by Phase Z's ZTier enum. Typed
   *  as `string` so widgets don't need to import the ZTier type; use
   *  the module `coerceZTier` helper to narrow if needed. Canonical
   *  values: `'bg'` · `'inline'` · `'vw'` · `'modal'` · `'popover'` ·
   *  `'overlay'`. */
  readonly zTier?: string;

  /** Widget's z-index within its tier. Higher = above. When the host
   *  has no explicit hint, this is 0 (default). */
  readonly zIndex?: number;

  /** Layout width in columns; optional because hosts may not yet inject it. */
  readonly width?: number;
  /** Layout height in rows; optional because hosts may not yet inject it. */
  readonly height?: number;
}

/** Phase 4c — canvas factory interface a widget sees. Concrete impl
 *  lives in src/canvas/index.ts (canvasFactory). Typed as a minimal
 *  interface so tests can inject fakes. */
export interface CanvasFactoryHandle {
  create(
    cellWidth: number,
    cellHeight: number,
    mode?: 'braille' | 'quadrant' | 'ascii' | 'dithered',
  ): {
    readonly width: number;
    readonly height: number;
    readonly cellWidth: number;
    readonly cellHeight: number;
    readonly mode: 'braille' | 'quadrant' | 'ascii' | 'dithered';
    set(x: number, y: number, on?: boolean): void;
    toggle(x: number, y: number): void;
    get(x: number, y: number): boolean;
    clear(): void;
    line(x0: number, y0: number, x1: number, y1: number): void;
    rect(x: number, y: number, w: number, h: number): void;
    render(): string[];
  };
}

/** Phase 4b — animation interface a widget sees. Concrete impl lives
 *  in src/animation/animation-context.ts (AnimationController).
 *  Exposed as an interface so tests can inject a fake controller. */
export interface AnimationHandle {
  tween(spec: {
    readonly key: string;
    readonly durationMs: number;
    readonly curve?: unknown;
    readonly startAt?: number;
    readonly onDone?: () => void;
  }): void;
  progress(key: string): number;
  isDone(key: string): boolean;
  hasActive(): boolean;
  cancel(key: string): void;
}

/** Phase 4 telemetry event — widgets emit structured records at
 *  interesting lifecycle points. Consumer (Lab Inspector, debug
 *  dashboard) decides what to do with them. */
export interface TelemetryEvent {
  /** Dot-separated category, e.g. 'selection.change' or 'error.render'. */
  readonly kind: string;
  /** Widget instance id — auto-filled by the host if omitted. */
  widgetId?: string;
  /** Arbitrary structured payload. Keep it JSON-serializable. */
  readonly data?: Readonly<Record<string, unknown>>;
  /** Wall-clock ms — auto-filled by the host if omitted. */
  ts?: number;
}

export interface TelemetrySink {
  emit(event: TelemetryEvent): void;
}

// ════════════════════════════════════════════════════════════════════
// Widget definition — Widget<S> is the Phase 1 canonical form.
// ════════════════════════════════════════════════════════════════════

/** A widget type — one registered module, spawned many times.
 *
 *  Phase 1 contract (2026-04-19):
 *  - Legacy fields (type/description/initialState/render/onKey/onMouse)
 *    unchanged — existing widgets compile as-is.
 *  - New optional fields: lifecycle hooks, behaviors chain, children
 *    slot. A widget opts in incrementally. */
export interface Widget<S = unknown, Config = Record<string, unknown>> {
  /** Stable identifier shared across instances (e.g. 'list'). */
  type: string;
  /** One-line description shown in `/widget list` + widget market. */
  description: string;
  /** Optional default character for instances that don't supply one. */
  defaultCharacter?: string;
  /** Build the initial state for a new instance. Called once per spawn. */
  initialState(config?: Config): S;
  /** Pure render — same state+ctx must produce same lines. Host handles
   *  ANSI cursor positioning; the widget just returns up to `ctx.height`
   *  lines each padded/truncated to `ctx.width`. */
  render(state: S, ctx: RenderCtx, character: string): string[];
  /** Optional keystroke handler — runs only when this widget has focus.
   *  Phase 1+: router walks `behaviors` first; this onKey is the widget-
   *  specific fallback for keys no behavior consumed. */
  onKey?(ev: KeyEvent, state: S, ctx: WidgetContext<S>): Action;
  /** Optional mouse handler (click / double-click / scroll / drag /
   *  release / motion). MD2 — `double-click` is synthesized by the
   *  SGR parser when a 2nd same-cell primary press arrives within
   *  `ELANOUS_DOUBLE_CLICK_MS`.
   *
   *  Bundle 1 P2 (2026-04-20) added `drag` / `release` for sketch-
   *  style widgets that need the full press → drag → release
   *  lifecycle (IUL Canvas). The press event is `click`; the widget
   *  treats it as "down" and waits for `release` to finalize.
   *
   *  IDX-F5d (2026-04-22) added `motion` so widgets can observe
   *  pointer hover passively without opting into the full
   *  `onHover` protocol. Hover-driven tint / tooltip / preview
   *  should prefer `onHover` (dedicated lifecycle); `motion` is a
   *  lower-level escape hatch for widgets that need every move.
   *
   *  Existing widgets that only handle `click` / `double-click` /
   *  `scroll-*` keep working — the new event types simply pass
   *  through their default `none` return. */
  onMouse?(ev: { type: 'click' | 'double-click' | 'scroll-up' | 'scroll-down' | 'drag' | 'release' | 'motion'; row: number; col: number }, state: S, ctx: WidgetContext<S>): Action;

  // ── Phase 1 new surface (all optional) ────────────────────────────

  /** Called once after the instance enters the layout. Side effects
   *  (spawning ReactiveEditor, subscribing to streams) belong here. */
  onMount?(state: S, ctx: WidgetContext<S>): void;
  /** Called once before the instance is removed. Mirror of onMount —
   *  tear down anything onMount created. */
  onUnmount?(state: S, ctx: WidgetContext<S>): void;
  /** Called when the widget acquires focus (user navigated into it). */
  onFocus?(state: S, ctx: WidgetContext<S>): void;
  /** Called when the widget loses focus. */
  onBlur?(state: S, ctx: WidgetContext<S>): void;

  /** Declarative behavior mixins. The router's dispatch walks this in
   *  order; the first `behavior.handlesKey(key, state)` that returns
   *  true gets `onKey` and its result wins. Widget's own onKey runs
   *  only for keys no behavior consumed. */
  behaviors?: readonly WidgetBehavior<S>[];

  /** Composite children slot. A widget can mount sub-widgets; focus,
   *  key routing, and render bubble through this tree. Phase 1 lands
   *  the slot; actual tree rendering arrives in Phase 4+. */
  children?: readonly Widget<unknown, unknown>[];

  // ── Phase 4 LLM control surface (2026-04-20) ──────────────────────
  // Optional widget-supplied introspection overrides. When omitted,
  // the widget-inspector helper falls back to a default implementation
  // that shallow-copies primitive fields from state (snapshot) and
  // returns a generic "widget <type> at row R col C" string (describe).

  /** Return a JSON-serializable snapshot of this widget's observable
   *  state for LLM inspection. Widgets that hold rich non-serializable
   *  structures (Sets / Maps / large arrays) should override to project
   *  a bounded, inspector-friendly shape. */
  snapshot?(state: S, ctx: WidgetContext<S>): Record<string, unknown>;

  /** Return a short prose description of what sits at the given
   *  widget-local row/col — "row 12: agent 'parse-repo' (running · 3 tools)".
   *  Used by the DashboardWidgetDescribe LLM tool to ground the model
   *  on what a pointer-addressed cell actually represents. */
  describe?(state: S, ctx: WidgetContext<S>, row: number, col: number): string;

  /** IDX-F5d (2026-04-22) — structural hit-test refinement. Mirrors
   *  `View.describeHit` (src/ui/view.ts:188) on the pane rail.
   *
   *  Given widget-local `(localRow, localCol)` — 0-indexed, title row
   *  included when the layout drew one — return a `WidgetHitDescriptor`
   *  classifying what sits at that cell. The wiring layer
   *  (`getPaneHitTarget` in dashboard.ts) composes the full
   *  `{kind:'pane-body', paneId, widgetInstanceId, bodyRow, bodyCol, hit}`
   *  HitTarget via `applyPaneIdToRefinement`.
   *
   *  Return `null` for cells that don't refine to anything (title row,
   *  empty area past the end of a list, padding between cells). The
   *  wiring layer still emits a coarse `pane-body` HitTarget in that
   *  case — just without the `hit` field.
   *
   *  Widgets that omit this method continue to work; drag / click /
   *  hover consumers that depend on `hit?.itemIndex` fall back to
   *  their pre-F5d behaviour (state.cursor read or similar).
   *
   *  Opt-in sequence (Phase 1 landed): list widget only. Phase 2
   *  expands to scheduler-task-list, agent-list, select-view — any
   *  widget with a stable `(row, col) → item` mapping. Future phases
   *  cover table-cell / text-char descriptors. */
  describeHit?(
    state: S,
    ctx: WidgetContext<S>,
    localRow: number,
    localCol: number,
  ): WidgetHitDescriptor | null;

  /** IDX-F5d Phase 2 (2026-04-22) — widget-level hover hook. Mirrors
   *  `View.onHover` (src/ui/view.ts:159) on the pane rail.
   *
   *  Dispatched when a pane-body pointer target transitions
   *  — on enter (pointer first crosses this widget), leave (pointer
   *  moves to a different widget / off-screen), over (subsequent
   *  position updates while still on this widget), and stable (the
   *  pointer has sat on the same `hit` for `ELANOUS_HOVER_DELAY_MS`).
   *
   *  The `hit` discriminator lets widgets react to row-level hover
   *  transitions ("pointer left row 3, entered row 5") without
   *  re-implementing equality themselves — the tracker already bumped
   *  `target.id` when hit changed, and the dispatcher synthesizes
   *  leave(old) + enter(new) automatically.
   *
   *  Return type is void — hover is observational. Widgets that want
   *  to consume or block should use `onMouse(type:'motion')` instead
   *  (lower-level, but synchronous/consumable).
   *
   *  Opt-in sequence (Phase 2 landed): list widget + scheduler-task-
   *  list + agent-list. Other widgets adopt incrementally. */
  onHover?(
    ev: WidgetHoverEvent,
    state: S,
    ctx: WidgetContext<S>,
  ): void;

  // ── WR-1 (2026-04-20) — widget state change hook (IUL Phase W prereq) ──

  /** Fired when widget state transitions between render frames. The host
   *  invokes this after `ctx.setState` mutates the instance state but
   *  before the next render; prev is the reference from just before the
   *  mutation, next is the new reference.
   *
   *  Opt-in. Widgets that implement this surface state changes to the
   *  host (via `WidgetHost.onInstanceStateChange`) with widget-chosen
   *  granularity — batch via own setState cadence for noisy widgets.
   *  Widgets that omit this hook still participate via the host
   *  subscribers that fire directly from setState; the render-frame
   *  ref-compare fallback is reserved for widgets that mutate state
   *  outside setState (anti-pattern).
   *
   *  Re-entry safety: calling `ctx.setState` inside `onStateChange`
   *  is a host-guarded no-op for that re-entrant path — outer frame
   *  completes first, then the widget can request a follow-up render. */
  onStateChange?(prev: S, next: S, ctx: WidgetContext<S>): void;

  // ── WR-2 (2026-04-20 · Bundle 5W) — observation extras ──

  /** Stable hash of state for fast-path diff detection. Phase W timeline
   *  recorder checks `snapshotHash(prev) === snapshotHash(next)` before
   *  persisting a full snapshot so unchanged widgets skip serialization.
   *
   *  Default (host): JSON-stringify + FNV-1a. Override when state has:
   *  - Circular references (`JSON.stringify` throws)
   *  - Large binary blobs where full serialize is expensive
   *  - A natural compact identity (scratch: `${mode}:${memoLineIdx}`)
   *
   *  Contract: pure + deterministic + cheap. Same state reference ⇒ same
   *  hash; structurally-equal state should ⇒ same hash. Collisions are
   *  tolerated (recorder does a follow-up deep compare on match) but
   *  should be rare in practice. */
  snapshotHash?(state: S): string;

  /** Widget-surface-wide human-readable description — one sentence that
   *  answers "what is this widget showing right now?". Differs from
   *  `describe(state, ctx, row, col)` which is point-wise (what's at
   *  that specific cell); `describeSurface` is scope-wide.
   *
   *  Consumed by the Phase L `DescribeSurface({kind:'widget',widgetId})`
   *  LLM tool. When the widget omits this hook, the host synthesizes a
   *  generic fallback (`${widgetType}(${widgetId}) · ${character}`).
   *
   *  Examples from built-ins:
   *    scratch · memo mode · 82 lines · cursor 45:12 · dirty
   *    table · 24 rows · cursor row 3
   *    list · 12 items · 3 selected · cursor 5 */
  describeSurface?(state: S, ctx: WidgetContext<S>): string;

  // ── WR-3 (2026-04-20 · Bundle 6W · IUL Phase W prereq for replay) ──

  /** Scenario replay hook — host calls this instead of `ctx.setState`
   *  when restoring a widget to a past state from a timeline recording.
   *
   *  Default (host): `ctx.setState(state as any)` — state transplant.
   *  Override when the widget holds side-effectful state that needs
   *  scrubbing on time-rewind:
   *    - scratch: clipboard history truncate to recorded length
   *    - mermaid (future): SVG render cache invalidate
   *    - scheduler-task-list (future): external subscription re-attach
   *
   *  Contract: `ctx.setState(state)` is a valid safe default. Widgets
   *  override only when naïve setState would leak side-effects across
   *  time boundaries.
   *
   *  Consumer: Phase W timeline player (future Bundle 7T/7W). Manual
   *  invocation via `WidgetHost.replayState(id, state)` available today
   *  for bench tests. */
  replayState?(state: S, ctx: WidgetContext<S>): void;

  // ── Presentation P3 (2026-04-20) — declarative schema ──

  /** JSONSchema for the widget's `Config` shape. Consumed by the
   *  `WidgetSchemaRegistry` (src/ui/declarative/schema.ts) for LLM
   *  tool dispatch (`GetWidgetSchema`) and `decodeWidgetTree`
   *  validation. Widgets that omit this hook fall back to a permissive
   *  generic schema (additionalProperties: true). Override when you
   *  want config to be validated — expected fields + required + enum
   *  constraints. */
  configSchema?(): Record<string, unknown>;
}

/** Backward-compat alias. Existing code that reads `WidgetDef<S, C>`
 *  keeps working; new widgets should prefer `Widget<S, C>`. */
export type WidgetDef<S = unknown, Config = Record<string, unknown>> = Widget<S, Config>;

/** A placed widget — one row of the host's instance table. */
export interface WidgetInstance<S = unknown> {
  id: string;              // unique across the current layout ('skills-1', 'chart-px')
  type: string;            // WidgetDef.type
  character: string;
  state: S;
  config?: Record<string, unknown>;
  meta?: Readonly<Record<string, unknown>>;
  /** MSS M1.2: branded URI for this live instance. The legacy `id`
   *  slug stays the layout-host bookkeeping key; `widgetUri` is the
   *  typed handle MSS bridges (M3 signal sender · M4 memory
   *  participant) reference. */
  widgetUri?: import('../mss/uri/brand.js').WidgetUri;
}

/** What the host knows about an available widget type on disk. */
export interface WidgetRegistryEntry {
  def: WidgetDef;
  source: 'builtin' | 'user' | 'plugin';
  path: string;            // directory containing widget.ts
}

/** Public-facing snapshot of a registered widget type, returned by
 *  `WidgetHost.listTypes()` and `PluginContext.listWidgetTypes()`.
 *  Plugin / LLM consumers see only the safe-to-export fields — no
 *  WidgetDef function references or filesystem paths. */
export interface WidgetTypeInfo {
  type: string;
  description: string;
  defaultCharacter?: string;
  source: 'builtin' | 'user' | 'plugin';
}
