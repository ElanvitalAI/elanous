// ── Plugin system core types ──
// Phase 2: full plugin contract. Plugins are plain TS modules whose
// default export implements ElanousPlugin. The plugin-host loads them
// from built-in plugins/* and ~/.claude/plugins/*.

import type {
  DisplayDisposable,
  DisplayHandle,
  DisplayKeyBinding,
  DisplayEvent,
  ExecutionSurfaceHandle,
  ExecutionSurfaceSpec,
  FocusScope,
  SurfaceId,
  SurfaceOwner,
} from '../../display/index.js';
import type { ThemeTokens } from '../../theme/tokens.js';
import type {
  CreatePromptFragmentInput,
  PromptFragment,
  PromptInjection,
  PromptRuntimeState,
  PromptScope,
  PromptSearchQuery,
} from '../../prompt-bank/types.js';

export type PaneSlot = 'skills' | 'files' | 'preview' | 'log' | 'hud';

/** Requirements declared by a plugin.json `requires` block. This is metadata, not an install request. */
export interface PluginDependency {
  elanous?: string;
  tools?: string[];
  optionalTools?: string[];
  optionalPython?: string[];
  knowledgePacks?: string[];
}

export interface DashboardPaneSummary {
  pane: string;
  visible: boolean;
  closed: boolean;
  closeable: boolean;
  omittedReason: string | null;
}

export interface DashboardPaneState {
  activeViewId: string;
  viewLabel: string;
  baseView: number;
  focused: string;
  compactLevel: string;
  primary: string;
  panes: DashboardPaneSummary[];
}

export interface KeyEvent {
  name: string;              // 'Enter', 'j', 'tab', 'escape', ...
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  sequence?: string;         // raw bytes for unknown keys
}

export type Action =
  | { type: 'none' }
  | { type: 'refresh'; pane?: PaneSlot }
  | { type: 'focus'; pane: PaneSlot }
  | { type: 'submit'; text: string }
  | { type: 'deactivate' };

export interface RenderCtx {
  width: number;             // columns available for this pane
  height: number;            // rows available
  focused: boolean;          // is this pane currently focused
  /** 1-based absolute terminal row where this pane's content starts.
   *  Set by renderLayout when known. Producers that need to translate
   *  absolute mouse coordinates into pane-relative ones (preview
   *  terminal mouse passthrough) read it through here. Optional —
   *  plain renderers that don't care can ignore. */
  originRow?: number;
  /** 1-based absolute terminal column where the pane starts. */
  originCol?: number;
  /** Current semantic theme tokens. Widgets should prefer these over
   *  hard-coded hex colors so plugin panes stay coherent with the TUI. */
  theme?: ThemeTokens;

  // ── Widget-host render hooks (2026-04-20 · layout-render ctx fix) ──
  // Populated by `layout-render` when the widget is rendered through
  // `widgetHost` so pure-render widgets (sparkline · heatmap · fader)
  // can access canvas / animation / telemetry without threading those
  // handles through state. Absent for non-host render paths (tests that
  // call `def.render` directly, legacy pane shims); widgets MUST guard
  // with `ctx.canvas?.` / `ctx.animate?.` per WidgetContext contract.

  /** High-density pixel buffer factory. Same handle as
   *  `WidgetContext.canvas` — layout-render forwards from the host's
   *  `buildContext(id)`. Used by sparkline (braille), heatmap (dithered),
   *  and custom canvas-based widgets. */
  canvas?: import('../../widgets/types.js').CanvasFactoryHandle;
  /** Per-instance animation controller. Same handle as
   *  `WidgetContext.animate`. Fader + sparkline start tweens in onMount;
   *  render reads progress to paint the current frame. */
  animate?: import('../../widgets/types.js').AnimationHandle;
  /** Telemetry emit hook. Widgets emit structured events for observers
   *  (Lab Inspector, widget-recorder). Same handle as
   *  `WidgetContext.telemetry`. */
  telemetry?: import('../../widgets/types.js').TelemetrySink;
  /** Z-order hints (WR-3) forwarded from the host's zInfoFor callback. */
  zTier?: string;
  zIndex?: number;
}

// PaneSpec<S> — a pane is a pure render function over a typed state
// plus optional key/selection handlers. Host owns the state object; the
// pane reads it during render and returns Actions the host applies.
export interface PaneSpec<S = unknown> {
  title: string;
  render(state: S, ctx: RenderCtx): string[];
  onKey?(ev: KeyEvent, state: S): Action;
  onSelect?(item: unknown, state: S): { previewTo?: PaneSlot; preview: string[] } | void;
  canFocus?: boolean;        // default: true
}

// ── SlashCommand — /name contribution ──
export interface SlashCommand {
  name: string;              // 'persona-add' (no leading slash)
  aliases?: string[];
  description: string;
  /** True when the command is only meant as a keybinding target /
   *  internal helper — not for direct user typing. Help / picker /
   *  auto-completion surfaces should filter these out. Default false
   *  (public). Plugins mark their internal movement / toggle helpers
   *  hidden so the user-facing command list stays short. */
  hidden?: boolean;
  handler(args: string[], ctx: PluginContext): Promise<void> | void;
}

// ── Keybinding — plugin-contributed shortcut ──
export interface Keybinding {
  key: string;               // tui KeyEvent.name form: 'C-S-p', 'r', etc
  when?: 'global' | 'focused';   // default 'focused' (only when plugin panes have focus)
  command: string;           // SlashCommand.name or built-in verb
}

// ── LLM tool contribution ──
// Exposed to the active chat stream so the model can mutate plugin state
// via tool_use. Host batches these into the streamLLM request and
// dispatches tool_calls back to handler().
export interface LLMToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSONSchema (OpenAI / Anthropic tools compatible)
  handler(args: Record<string, unknown>, ctx: PluginContext): Promise<unknown>;
}

// ── Plugin lifecycle context ──
// Passed to onActivate/onDeactivate + every slash/tool handler. The
// state field is plugin-owned, opaque to the host. setState triggers a
// re-render of the plugin's panes.
export interface PluginContext {
  pluginName: string;
  state: unknown;
  setState(patch: Record<string, unknown>): void;
  /** Scoped display command handle. New plugins should use this for
   *  render requests and future surface/scratch/execution updates
   *  instead of writing terminal bytes or calling dashboard draw paths. */
  display?: DisplayHandle;
  /** Coordinator-backed focus helpers. Existing focusPane remains as
   *  a pane-slot adapter; new plugin surfaces should use this API. */
  focus: {
    current(): SurfaceId | null;
    set(target: SurfaceId): void;
    cycle(scope?: FocusScope | SurfaceOwner, dir?: 1 | -1): SurfaceId | null;
  };
  /** Register scoped display keybindings. The returned disposable
   *  should be retained by long-lived plugins that need manual cleanup;
   *  the host also tracks plugin-owned registrations across deactivate. */
  keymap: {
    register(binding: Omit<DisplayKeyBinding, 'id'> & { id?: string }): DisplayDisposable;
  };
  /** Subscribe to display lifecycle events. Subscriptions are disposed
   *  automatically when the active plugin deactivates. */
  events?: {
    subscribe(type: DisplayEvent['type'] | '*', listener: (event: DisplayEvent) => void): DisplayDisposable;
  };
  /** Semantic theme tokens currently applied by the dashboard. */
  theme?: {
    current(): ThemeTokens;
  };
  /** Spawn a coordinator-backed execution surface. Hosts may omit this
   *  while the execution renderer is being adopted; plugins should
   *  feature-detect before using it. */
  execution?: {
    spawn(spec: ExecutionSurfaceSpec): ExecutionSurfaceHandle | Promise<ExecutionSurfaceHandle>;
  };
  /** Capability-checked host wrappers for plugins that need controlled
   *  access to files, network, or clipboard. */
  capabilities?: {
    canReadFile(path: string): boolean;
    canWriteFile(path: string): boolean;
    canNetwork(url: string): boolean;
    canClipboard(mode: 'read' | 'write'): boolean;
    readTextFile(path: string): string;
    writeTextFile(path: string, content: string): void;
    fetch(input: string | URL, init?: RequestInit): Promise<Response>;
    clipboard: {
      readText(): Promise<string | null>;
      writeText(text: string): Promise<boolean>;
    };
  };
  /** Run plugin-contributed tasks declared in plugin.json. Tasks are
   *  rendered through execution surfaces and share capability checks
   *  with execution.spawn(). */
  tasks?: {
    list(): import('./manifest.js').PluginTaskContribution[];
    run(id: string, opts?: import('./task-service.js').PluginTaskRunOptions): Promise<ExecutionSurfaceHandle>;
  };
  /** Prompt Bank helpers scoped to the active plugin. Runtime
   *  registrations are owner-scoped and selected only while the
   *  plugin is active. */
  prompts?: {
    register(input: Omit<CreatePromptFragmentInput, 'scope' | 'owner'> & { scope?: PromptScope; owner?: string }): PromptFragment;
    search(query: PromptSearchQuery): PromptFragment[];
    injectOnce(options?: {
      intents?: string[];
      state?: PromptRuntimeState;
      budgetTokens?: number;
      limit?: number;
      includeHeaders?: boolean;
      record?: boolean;
    }): PromptInjection;
    describeForLLM(): string;
  };
  /** Open/close plugin manifest-declared widget modals. These are
   *  layout-backed modals, rendered in the same frame as the dashboard. */
  modals?: {
    open(id: string, opts?: { config?: Record<string, unknown>; character?: string }): import('../../layout/types.js').ModalPlacement;
    close(id?: string): boolean;
  };
  /** Dashboard pane visibility/control helpers. These mirror the
   *  dashboard host tools so plugins can adapt to omitted panes without
   *  depending on dashboard internals. */
  panes?: {
    state(): DashboardPaneState;
    visible(): string[];
    close(pane: string): boolean;
    open(pane: string): boolean;
    openModal(pane: string): boolean;
    setOmitOrder?(panes: string[]): DashboardPaneState;
  };
  /** Append a line to the log pane. */
  log(line: string): void;
  /** Set a HUD segment (overwrites previous value for the same key). */
  hudSet(key: string, value: string, priority?: number): void;
  /** Request a re-render (optional pane filter — default: all). */
  requestRender(pane?: PaneSlot): void;
  /** Transfer focus to a specific pane slot owned by this plugin. */
  focusPane(pane: PaneSlot): void;
  /** Access a widget instance by id. Returns null when the id is
   *  unknown or widget-host isn't attached to plugin-host. Used by
   *  slash-command and llm-tool handlers to read/mutate widget state
   *  that the plugin spawned during buildLayout. */
  getWidget(id: string): import('../../widgets/types.js').WidgetInstance | null;
  /** Replace the plugin's active layout (grid of widget cells) with a
   *  new Layout. Unlike buildLayout (which runs once at activation),
   *  this lets a plugin SWITCH its layout at runtime — e.g. pivot
   *  between a "picking mode" and a "results mode" without disposing
   *  the widget instances behind it. Widget ids inside the layout
   *  must already exist (spawned via PluginLayoutCtx.spawnWidget or
   *  PluginContext.spawnWidget). Triggers a re-render. */
  setLayout(layout: import('../../layout/types.js').Layout): void;
  /** Spawn a new widget instance at runtime — mirror of
   *  PluginLayoutCtx.spawnWidget but available outside buildLayout
   *  (slash command handlers, LLM tool dispatchers, etc.). The new
   *  instance is owner-scoped to this plugin and disposed on
   *  deactivate. Caller is responsible for placing it in a Layout via
   *  setLayout — host doesn't auto-render orphan instances. */
  spawnWidget?(opts: {
    type: string;
    character?: string;
    config?: Record<string, unknown>;
    id?: string;
    meta?: Record<string, unknown>;
  }): import('../../widgets/types.js').WidgetInstance;
  /** PC-INTRO (Bundle 3) — list every registered widget type with its
   *  metadata. Plugins use this for catalog-driven UX (LLM materialize
   *  prompts, widget pickers). Returns a snapshot — caller may mutate
   *  the array freely. Optional because older host shells without a
   *  widget-host wired return undefined. See [`CAPABILITIES-iul-canvas.md`]
   *  §3 + [`PLAN-iul-unified-observation.md`] §3 Phase L for the IUL
   *  consumers that depend on this. */
  listWidgetTypes?(): readonly import('../../widgets/types.js').WidgetTypeInfo[];
  /** Bundle 8W (2026-04-20) — read-only slice of the host's widget-host
   *  for plugins that want to build timeline recorders, debug inspectors,
   *  or anything that needs state-change subscription + snapshot hashing.
   *
   *  Structurally compatible with
   *  `import('../../capture/widget-recorder.js').WidgetRecorderHost` so a
   *  plugin can pass it straight to `createWidgetRecorder({ widgetHost })`
   *  without any glue. Declared inline to avoid pulling the `capture/`
   *  module into the plugin-types dependency closure.
   *
   *  Optional because older host shells without a widget-host wired
   *  return undefined (same pattern as `listWidgetTypes`). */
  widgetRecorderHost?: {
    onInstanceStateChange(cb: (ev: {
      readonly instanceId: string;
      readonly type: string;
      readonly prev: unknown;
      readonly next: unknown;
      readonly timestamp: number;
    }) => void): () => void;
    snapshotHashFor?(id: string): string | null;
    get(id: string): import('../../widgets/types.js').WidgetInstance | null;
  };
  /** PX-2 P4: plugin-scoped persistent + session state. persist/load
   *  are FS-backed at ~/.elanous/state/<pluginId>/<key>.json (user) or
   *  <cwd>/.elanous/state/<pluginId>/<key>.json (project — opt-in via
   *  scope:'project'). Session state is in-memory, subscribable, and
   *  namespaced to this plugin. Optional field — older plugins and
   *  hosts that didn't wire a persistence backend will see undefined. */
  persistentState?: import('../../plugin-state/api.js').PluginStateApi;
}

// ── ElanousPlugin ──
// The default export shape every plugin.ts provides. `name` must be
// unique per host; user-level plugins may override built-ins with the
// same name (host logs a warning).
export interface ElanousPlugin<S = unknown> {
  name: string;
  version: string;
  description: string;
  initialState(): S;
  /** Slots this plugin wants to own. Unoccupied slots fall back to host defaults. */
  panes: Partial<Record<PaneSlot, PaneSpec<S>>>;
  slashCommands?: SlashCommand[];
  keybindings?: Keybinding[];
  llmTools?: LLMToolDef[];
  /** Host registers only adapters also declared in contributes.connectors;
   * registration is disposed with this plugin activation. */
  channelAdapters?: import('../../nexus/outbound/router.js').ChannelAdapter[];
  onActivate?(ctx: PluginContext): void | Promise<void>;
  onDeactivate?(ctx: PluginContext): void | Promise<void>;
  /** Plugin is executing a long-running op — host blocks input while true.
   *  Replaces the dashboard-level `mode === 'syncing'` busy flag so
   *  long-running state is plugin-owned, not a global singleton. */
  isBusy?(state: S): boolean;
  /** Global key handler — runs after keybindings miss, before pane.onKey.
   *  Return {type:'none'} to pass through. Wired by plugin-host.routeKey
   *  in Step C1. */
  onKey?(ev: KeyEvent, state: S, ctx: PluginContext): Action;
  /** Widget types this plugin needs. plugin-host rejects activation
   *  when any listed type is missing from widget-host. Callers should
   *  surface the missing type name so the user can install it. Types
   *  the plugin itself registers through `widgets` are considered
   *  satisfied. */
  requiredWidgets?: string[];
  /** Phase 5 — widget types this plugin contributes programmatically.
   *  plugin-host registers each def with source='plugin' on activate
   *  and unregisters on deactivate (owner-scoped cleanup). Unlike the
   *  manifest-file path (`contributes.widgets`), these live inside the
   *  plugin.ts itself — no extra files, no cross-dir references.
   *
   *  The F-B5b reactive YAML editor is the first consumer: it ships
   *  its own widget type (reactive-yaml-editor) and declares it here
   *  instead of scattering widget.ts files across widgets/. */
  widgets?: import('../../widgets/types.js').WidgetDef[];
  /** Build the plugin's layout + spawn its widget instances. Called
   *  after onActivate; plugin-host passes a PluginLayoutCtx with a
   *  handle to the widget host + plugin context. Any widget ids
   *  spawned through the ctx helper are tracked and disposed on
   *  deactivate.  Returning null/undefined means "no layout override"
   *  (the dashboard uses the default browse layout). */
  buildLayout?(ctx: PluginLayoutCtx<S>): import('../../layout/types.js').Layout | null;
}

/** Context passed to buildLayout. Wraps widgetHost.spawn so the
 *  plugin-host can track which instances belong to this plugin. */
export interface PluginLayoutCtx<S = unknown> {
  /** PluginContext for log / state / hud (same as onActivate). */
  plugin: PluginContext;
  /** Live plugin state, typed. Same object PluginContext.state points at. */
  state: S;
  /** Spawn a widget instance — tracked for auto-dispose on deactivate. */
  spawnWidget(opts: {
    type: string;
    character?: string;
    config?: Record<string, unknown>;
    id?: string;
  }): import('../../widgets/types.js').WidgetInstance;
  /** Mutate state + trigger re-render (mirror of PluginContext.setState). */
  setState(patch: Partial<S>): void;
}
