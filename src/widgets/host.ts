// ── Widget host — discovery + instance lifecycle ──
// Loads widget types from `<repo>/widgets/<name>/widget.ts` (built-in)
// and `~/.claude/widgets/<name>/widget.ts` (user). Same pattern as
// plugin-host. User-scope overrides built-in with a warning log.

import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import type { WidgetDef, WidgetInstance, WidgetContext, WidgetRegistryEntry, WidgetTypeInfo, TelemetrySink, TelemetryEvent, AnimationHandle, CanvasFactoryHandle } from './types.js';
import { mintWidgetUri } from '../mss/uri/builder.js';
import type { DisplayHandle } from '../display/types.js';
import { AnimationController } from '../animation/index.js';
import { canvasFactory } from '../canvas/index.js';
import { debug } from '../debug/log.js';
import {
  materializeWidgetSpecs,
  type MaterializedWidgetRecord,
} from '../ui/declarative/materialize.js';
import type { DeclarativeWidgetNode } from '../ui/declarative/builder.js';
import { harvestWidgetSchema } from '../ui/declarative/schema.js';

// Built-in widget defs live at repo-root `widgets/`, while this host now
// lives under `src/widgets/`. Walk two levels up so discovery still lands on
// the canonical built-in registry after the src-domain restructure.
const BUILTIN_DIR = resolve(import.meta.dir, '..', '..', 'widgets');
const USER_DIR = join(homedir(), '.claude', 'widgets');

export interface WidgetHostHooks {
  log(line: string): void;
  requestRender(): void;
  display?: DisplayHandle;
  /** Phase 4a telemetry sink — buffered or real-time inspector. Host
   *  wraps emitted events with the originating widgetId + ts when the
   *  widget didn't set them. Omit for no-op (events are discarded). */
  telemetry?: TelemetrySink;
  /** Arc F — animation frame tickler. The host calls this when a tween
   *  starts (or tail-recurses while animations are active) so the draw
   *  loop can re-render after ~16 ms without requiring a user keystroke.
   *  Implementors dedup concurrent calls (a single `framePending` flag)
   *  and invoke `widgetHost.scheduleNextFrameIfAnimating()` after the
   *  render to keep the loop alive until `anyActiveAnimation()` is false.
   *  Omit → animation progress only advances on explicit render. */
  scheduleFrame?: (delayMs: number) => void;
  /** WR-3 (Bundle 6W · IUL Phase Z consumer) — per-instance z-order
   *  lookup. Dashboard wires this to `getSurfaceRegistry().get({kind:
   *  'widget',widgetId:id})` so `ctx.zTier` + `ctx.zIndex` populate
   *  from the live Phase Z rollup. Omit → fields are `undefined` in
   *  the ctx (test harnesses + pre-wired hosts run unchanged). */
  zInfoFor?: (id: string) => { tier?: string; zIndex?: number } | undefined;
}

export interface WidgetLifecycleEvent {
  readonly instanceId: string;
  readonly type: string;
  readonly character: string;
  readonly source: 'builtin' | 'user' | 'plugin';
  readonly timestamp: number;
}

export type WidgetLifecycleSubscriber = (event: WidgetLifecycleEvent) => void;

/** WR-1 (2026-04-20) — widget state change event. Fires synchronously
 *  from `ctx.setState` after the instance state has been updated. Phase
 *  W timeline recorder + debug dashboards subscribe via
 *  `WidgetHost.onInstanceStateChange`. */
export interface WidgetStateChangeEvent {
  readonly instanceId: string;
  readonly type: string;
  readonly prev: unknown;
  readonly next: unknown;
  readonly timestamp: number;
}

export type WidgetStateChangeSubscriber = (event: WidgetStateChangeEvent) => void;

/** U-1 · focus-change event fired by the WidgetHost when the focused
 *  instance transitions. `next === null` on blur (no widget focused);
 *  `prev === null` on first focus (from the idle state). Reason is a
 *  short tag for debug telemetry — e.g. `'dashboard-bell-open'`,
 *  `'log-area-click'`, `'widget-dispose-cascade'`. */
export interface WidgetFocusChangeEvent {
  readonly next: string | null;
  readonly prev: string | null;
  readonly reason: string;
  readonly timestamp: number;
}
export type WidgetFocusChangeSubscriber = (event: WidgetFocusChangeEvent) => void;

export class WidgetHost {
  private registry = new Map<string, WidgetRegistryEntry>();
  private schemaDisposers = new Map<string, () => void>();
  private instances = new Map<string, WidgetInstance>();
  private nextInstanceSeq = 0;
  private hooks: WidgetHostHooks;
  /** Per-instance animation controllers — Phase 4b. Lazily created on
   *  first buildContext for that id so widgets that never animate don't
   *  pay a construction cost. */
  private animators = new Map<string, AnimationController>();
  /** IUL Phase S·b — instance lifecycle subscribers. Fired synchronously
   *  inside spawn() / dispose() so consumers (SurfaceRegistry adapter,
   *  Phase W timeline recorder) observe lifecycle in the same tick. */
  private mountSubs = new Set<WidgetLifecycleSubscriber>();
  private disposeSubs = new Set<WidgetLifecycleSubscriber>();
  /** WR-1 — widget state change subscribers. Fired synchronously from
   *  `ctx.setState`. Subscribers that throw are isolated. */
  private stateSubs = new Set<WidgetStateChangeSubscriber>();
  /** U-1 · currently-focused widget instance id (or `null` when no
   *  widget owns focus · the common default, since most dashboard
   *  focus axes are pane slots owned by `workingDir.focus`). */
  private focusedId: string | null = null;
  /** U-1 · focus-change subscribers. Fired synchronously inside
   *  `focus(id)` / `blur(id)` / cascade on `dispose(id)`. */
  private focusSubs = new Set<WidgetFocusChangeSubscriber>();
  /** Re-entry guard so `ctx.setState` called inside `widget.onStateChange`
   *  doesn't recurse into `fireStateChange`. The outer setState frame
   *  completes its fan-out first; inner setState still mutates state
   *  + requests render but skips the event fanout. */
  private inFireStateChange = new Set<string>();

  constructor(hooks: WidgetHostHooks) {
    this.hooks = hooks;
  }

  /** Phase 4b — sample the controller for a widget id, if any. Lets
   *  the draw loop check `hasActive()` across all widgets and schedule
   *  a subsequent re-render when tweens are still running. */
  getAnimator(id: string): AnimationController | null {
    return this.animators.get(id) ?? null;
  }

  /** Any widget still animating? Draw loop uses this to decide whether
   *  to schedule another frame tickler. */
  anyActiveAnimation(): boolean {
    for (const ctrl of this.animators.values()) {
      if (ctrl.hasActive()) return true;
    }
    return false;
  }

  /** Arc F — ask the host to schedule one more draw frame if anything is
   *  still tweening. Called on every tween start (via the animate handle)
   *  and tail-recursed by the dashboard after each tick. No-op when the
   *  host didn't wire `scheduleFrame` (tests, headless runs) or when no
   *  animation is active. */
  scheduleNextFrameIfAnimating(delayMs = 16): void {
    if (!this.hooks.scheduleFrame) return;
    const active = this.anyActiveAnimation();
    if (debug.enabled) {
      debug.log('animation.frame.schedule', active ? 'arm' : 'skip', {
        delayMs,
        active,
        animators: this.animators.size,
      });
    }
    if (!active) return;
    this.hooks.scheduleFrame(delayMs);
  }

  /** Scan both built-in and user directories, importing every widget.ts. */
  async discover(): Promise<void> {
    this.clearRegistry();
    await this.scanDir(BUILTIN_DIR, 'builtin');
    await this.scanDir(USER_DIR, 'user');
  }

  private async scanDir(dir: string, source: 'builtin' | 'user'): Promise<void> {
    if (!existsSync(dir)) return;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const widgetDir = join(dir, name);
      let isDir = false;
      try { isDir = statSync(widgetDir).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      const entry = join(widgetDir, 'widget.ts');
      if (!existsSync(entry)) continue;
      try {
        await this.registerFromFile(entry, source, widgetDir);
      } catch (err: any) {
        this.hooks.log(`⚠ failed to load widget ${name}: ${err?.message || err}`);
      }
    }
  }

  /** Registry introspection. */
  available(): WidgetRegistryEntry[] {
    return [...this.registry.values()].sort((a, b) => a.def.type.localeCompare(b.def.type));
  }

  hasType(type: string): boolean {
    return this.registry.has(type);
  }

  /** PC-INTRO — list every registered widget type with metadata.
   *  Drives `PluginContext.listWidgetTypes()` introspection (bridges
   *  to IUL Phase L `MaterializeFromIntent` and IUL-Scenarios catalog
   *  lookup so plugins like iul-canvas no longer need a hardcoded
   *  catalog of 9 widgets). Returns a snapshot — caller may freely
   *  mutate the array without affecting the registry. */
  listTypes(): WidgetTypeInfo[] {
    const out: WidgetTypeInfo[] = [];
    for (const entry of this.registry.values()) {
      out.push({
        type: entry.def.type,
        description: entry.def.description,
        ...(entry.def.defaultCharacter !== undefined ? { defaultCharacter: entry.def.defaultCharacter } : {}),
        source: entry.source,
      });
    }
    return out;
  }

  /** Manually register a widget type — used by tests. Falls back to
   *  directory discovery in production. */
  register(def: WidgetDef, source: 'builtin' | 'user' | 'plugin' = 'builtin', path = ''): void {
    const existing = this.registry.get(def.type);
    if (existing && existing.source === 'builtin' && source === 'user') {
      this.hooks.log(`⚠ user widget "${def.type}" overrides built-in`);
    }
    this.disposeSchema(def.type);
    this.registry.set(def.type, { def, source, path });
    const schemaDispose = harvestWidgetSchema(def);
    if (schemaDispose) this.schemaDisposers.set(def.type, schemaDispose);
  }

  async registerFromFile(entry: string, source: 'builtin' | 'user' | 'plugin' = 'plugin', widgetDir = dirname(entry)): Promise<WidgetDef> {
    if (!existsSync(entry)) throw new Error(`widget entry not found: ${entry}`);
    const mod = await import(`${entry}?t=${Date.now()}`);
    const def: WidgetDef | undefined = mod.default ?? mod.widget;
    if (!def || !def.type) throw new Error(`widget at ${entry} has no default export`);
    this.register(def, source, widgetDir);
    return def;
  }

  unregisterType(type: string): void {
    this.registry.delete(type);
    this.disposeSchema(type);
  }

  /** Declarative builder/runtime convergence seam. Lets callers hand
   *  the host a builder-authored tree directly instead of first
   *  mapping it through a separate materialize helper. */
  spawnDeclarative(
    widgets: readonly DeclarativeWidgetNode[],
  ): readonly MaterializedWidgetRecord[] {
    return materializeWidgetSpecs({
      spawn: (opts) => this.spawn({
        ...opts,
        meta: opts.meta as unknown as Record<string, unknown>,
      }),
    }, widgets);
  }

  private clearRegistry(): void {
    this.registry.clear();
    for (const dispose of this.schemaDisposers.values()) {
      try { dispose(); } catch { /* isolate schema disposer failures */ }
    }
    this.schemaDisposers.clear();
  }

  private disposeSchema(type: string): void {
    const dispose = this.schemaDisposers.get(type);
    if (!dispose) return;
    this.schemaDisposers.delete(type);
    try { dispose(); } catch { /* isolate schema disposer failures */ }
  }

  /** Spawn a new instance. Returns the instance id. Throws on unknown
   *  type or id collision. */
  spawn(opts: {
    type: string;
    character?: string;
    config?: Record<string, unknown>;
    id?: string;
    meta?: Record<string, unknown>;
  }): WidgetInstance {
    const entry = this.registry.get(opts.type);
    if (!entry) throw new Error(`widget type "${opts.type}" not registered`);
    const id = opts.id ?? `${opts.type}-${++this.nextInstanceSeq}`;
    if (this.instances.has(id)) throw new Error(`widget instance id "${id}" already exists`);
    const character = opts.character ?? entry.def.defaultCharacter ?? opts.type;
    const instance: WidgetInstance = {
      id,
      type: opts.type,
      character,
      state: entry.def.initialState(opts.config as any),
      config: opts.config,
      ...(opts.meta ? { meta: opts.meta } : {}),
      // MSS M1.2: brand each spawn with a fresh URI alongside the
      // layout-host slug. Disposed instances drop their URI naturally;
      // re-spawning the same slug mints a new URI (each lifetime is a
      // distinct observable identity).
      widgetUri: mintWidgetUri(),
    };
    this.instances.set(id, instance);
    this.fireLifecycle(this.mountSubs, {
      instanceId: id,
      type: opts.type,
      character,
      source: entry.source,
      timestamp: Date.now(),
    });
    return instance;
  }

  /** Remove an instance from the registry. Layout-host is responsible
   *  for also removing it from the active layout. Phase 4b also drops
   *  the per-instance AnimationController so dangling tweens don't keep
   *  `anyActiveAnimation()` true after the widget is gone. */
  dispose(id: string): void {
    const instance = this.instances.get(id);
    // U-1 · blur-cascade · if the disposed instance is the focused
    // one, clear focus first so subscribers see a clean transition
    // before the lifecycle event fires. `disposeById(id, reason)` is
    // the preferred caller since it threads a `reason` string through;
    // this branch is the compatibility shim for legacy direct callers.
    if (this.focusedId === id) {
      const prev = this.focusedId;
      this.focusedId = null;
      this.fireFocusChange(null, prev, 'dispose-cascade');
    }
    this.instances.delete(id);
    this.animators.delete(id);
    if (instance) {
      const entry = this.registry.get(instance.type);
      this.fireLifecycle(this.disposeSubs, {
        instanceId: id,
        type: instance.type,
        character: instance.character,
        source: entry?.source ?? 'builtin',
        timestamp: Date.now(),
      });
    }
  }

  /** IUL Phase S·b — subscribe to instance mount events. Fires
   *  synchronously inside `spawn()` so consumers observe lifecycle
   *  in the same tick. Returns a disposer; subscribers that throw
   *  are isolated (broken sub never breaks fanout). */
  onMount(cb: WidgetLifecycleSubscriber): () => void {
    this.mountSubs.add(cb);
    return () => { this.mountSubs.delete(cb); };
  }

  /** IUL Phase S·b — subscribe to instance dispose events. Fires
   *  synchronously inside `dispose()` after the instance is removed
   *  from the host's internal map. */
  onDispose(cb: WidgetLifecycleSubscriber): () => void {
    this.disposeSubs.add(cb);
    return () => { this.disposeSubs.delete(cb); };
  }

  /** WR-1 (2026-04-20 · IUL Phase W prereq) — subscribe to instance
   *  state-change events. Fires synchronously from `ctx.setState` after
   *  the mutation, so subscribers see the final `next` state on read.
   *  Returns a disposer. Throwing subscribers are isolated (a broken
   *  one never breaks the fanout). */
  onInstanceStateChange(cb: WidgetStateChangeSubscriber): () => void {
    this.stateSubs.add(cb);
    return () => { this.stateSubs.delete(cb); };
  }

  // ── U-1 · focus / dispose API ────────────────────────────────────

  /** Mark the given instance as the currently-focused widget. Returns
   *  true when the focus was applied (instance exists and wasn't
   *  already focused); false when the id is unknown or the instance
   *  is already focused (idempotent).
   *
   *  Fires `onFocusChange` subscribers when the focus actually moves.
   *  Does NOT influence pane-slot focus owned by `workingDir.focus`
   *  — widget focus is an orthogonal axis. */
  focus(id: string, reason: string): boolean {
    if (!this.instances.has(id)) return false;
    if (this.focusedId === id) return true;
    const prev = this.focusedId;
    this.focusedId = id;
    this.fireFocusChange(id, prev, reason);
    return true;
  }

  /** Clear focus if the given instance is currently focused. Returns
   *  true when focus was cleared; false when the instance wasn't the
   *  focused one (no-op). Useful for widgets that want to relinquish
   *  focus on a specific event (Esc / modal close). */
  blur(id: string, reason: string): boolean {
    if (this.focusedId !== id) return false;
    const prev = this.focusedId;
    this.focusedId = null;
    this.fireFocusChange(null, prev, reason);
    return true;
  }

  /** Dispose an instance by id, with a reason tag threaded through the
   *  subscriber event. Wrapper around the existing `dispose(id)` — the
   *  difference is that `disposeById` cascades a blur when the
   *  disposed instance is the focused one, and the `reason` string
   *  shows up in debug logs so post-hoc triage can correlate focus
   *  cascades with their trigger.
   *
   *  Returns true when the instance existed and was disposed; false
   *  when the id was unknown. */
  disposeById(id: string, reason: string): boolean {
    if (!this.instances.has(id)) return false;
    if (this.focusedId === id) {
      const prev = this.focusedId;
      this.focusedId = null;
      this.fireFocusChange(null, prev, `${reason}::dispose-cascade`);
    }
    this.dispose(id);
    return true;
  }

  /** Return the currently-focused WidgetInstance, or `null` when no
   *  widget owns focus. */
  getFocused(): WidgetInstance | null {
    return this.focusedId ? this.instances.get(this.focusedId) ?? null : null;
  }

  /** Return just the focused id without a lookup — cheap enough to
   *  call per frame. */
  getFocusedId(): string | null {
    return this.focusedId;
  }

  /** Subscribe to focus-change events. Fires synchronously inside
   *  `focus()` / `blur()` / `disposeById()` cascade. Returns a
   *  disposer. Throwing subscribers are isolated (same contract as
   *  onMount/onDispose/onInstanceStateChange). */
  onFocusChange(cb: WidgetFocusChangeSubscriber): () => void {
    this.focusSubs.add(cb);
    return () => { this.focusSubs.delete(cb); };
  }

  private fireFocusChange(
    next: string | null,
    prev: string | null,
    reason: string,
  ): void {
    const event: WidgetFocusChangeEvent = {
      next,
      prev,
      reason,
      timestamp: Date.now(),
    };
    for (const cb of [...this.focusSubs]) {
      try { cb(event); }
      catch (err) {
        if (debug.enabled) {
          debug.log('widget.focus.subscriber.error', `${prev ?? 'null'}→${next ?? 'null'}`, {
            err: (err as Error)?.message ?? String(err),
            reason,
          }, { level: 'error' });
        }
      }
    }
    if (debug.enabled) {
      debug.log('widget.focus.change', `${prev ?? 'null'}→${next ?? 'null'}`, {
        reason,
        subscribers: this.focusSubs.size,
      });
    }
  }

  private fireLifecycle(
    subs: Set<WidgetLifecycleSubscriber>,
    event: WidgetLifecycleEvent,
  ): void {
    for (const cb of [...subs]) {
      try { cb(event); }
      catch (err) {
        if (debug.enabled) {
          debug.log('widget.lifecycle.subscriber.error', event.instanceId, {
            err: (err as Error)?.message ?? String(err),
          }, { level: 'error' });
        }
      }
    }
  }

  /** Fire a state-change event to the widget's own hook + all host
   *  subscribers. Guarded against re-entry so `ctx.setState` inside
   *  `widget.onStateChange` doesn't recurse. Called only from the
   *  setState closure inside `buildContext`. */
  private fireStateChange<S>(
    instanceId: string,
    prev: S,
    next: S,
    ctx: WidgetContext<S>,
  ): void {
    if (this.inFireStateChange.has(instanceId)) return;
    this.inFireStateChange.add(instanceId);
    try {
      const instance = this.instances.get(instanceId);
      if (!instance) return;
      const def = this.registry.get(instance.type)?.def;
      if (def?.onStateChange) {
        try {
          (def.onStateChange as (p: S, n: S, c: WidgetContext<S>) => void)(
            prev, next, ctx,
          );
        } catch (err) {
          if (debug.enabled) {
            debug.log('widget.state-change.hook.error', instanceId, {
              err: (err as Error)?.message ?? String(err),
            }, { level: 'error' });
          }
        }
      }
      const event: WidgetStateChangeEvent = {
        instanceId,
        type: instance.type,
        prev,
        next,
        timestamp: Date.now(),
      };
      for (const cb of [...this.stateSubs]) {
        try { cb(event); }
        catch (err) {
          if (debug.enabled) {
            debug.log('widget.state-change.subscriber.error', instanceId, {
              err: (err as Error)?.message ?? String(err),
            }, { level: 'error' });
          }
        }
      }
    } finally {
      this.inFireStateChange.delete(instanceId);
    }
  }

  get(id: string): WidgetInstance | null {
    return this.instances.get(id) ?? null;
  }

  /** Return the def for an instance (so render pipeline can call render). */
  defFor(id: string): WidgetDef | null {
    const inst = this.instances.get(id);
    if (!inst) return null;
    return this.registry.get(inst.type)?.def ?? null;
  }

  instanceCount(): number {
    return this.instances.size;
  }

  /** T6-K2 — list every live instance id. Used by the dashboard
   *  control manual to tell the LLM which widgets exist on the
   *  current view. */
  listInstanceIds(): string[] {
    return [...this.instances.keys()];
  }

  /** WR-2 (2026-04-20 · Bundle 5W · IUL Phase W prereq) — stable
   *  per-instance hash of current state. Uses `widget.snapshotHash` when
   *  the widget overrides it; otherwise falls back to
   *  `JSON.stringify(state) + FNV-1a`. Circular / unserializable state
   *  → returns a stable placeholder `"<unhashable:<type>>"` so callers
   *  can tell apart "no hash" from "equal hashes".
   *
   *  Phase W timeline recorder checks this before persisting a snapshot
   *  to skip unchanged widgets. Contract: same state ref ⇒ same string;
   *  structurally-equal states should yield equal hashes when the widget
   *  implements its own override. */
  snapshotHashFor(id: string): string | null {
    const inst = this.instances.get(id);
    if (!inst) return null;
    const def = this.registry.get(inst.type)?.def;
    if (def?.snapshotHash) {
      try { return def.snapshotHash(inst.state); }
      catch (err) {
        if (debug.enabled) {
          debug.log('widget.snapshot-hash.override.error', id, {
            err: (err as Error)?.message ?? String(err),
          }, { level: 'error' });
        }
        // fall through to default
      }
    }
    return defaultSnapshotHash(inst.state, inst.type);
  }

  /** WR-2 — widget-surface-wide human description. Consumed by the
   *  Phase L `DescribeSurface({kind:'widget',widgetId})` LLM tool. Uses
   *  `widget.describeSurface` when overridden; otherwise synthesizes
   *  a generic fallback from instance metadata. Throws are swallowed
   *  so a broken describeSurface never breaks DescribeSurface tool
   *  dispatch. */
  describeSurfaceFor(id: string): string | null {
    const inst = this.instances.get(id);
    if (!inst) return null;
    const def = this.registry.get(inst.type)?.def;
    if (def?.describeSurface) {
      try {
        const ctx = this.buildContext(id);
        if (ctx) {
          const out = (def.describeSurface as (
            s: unknown,
            c: WidgetContext<unknown>,
          ) => string)(inst.state, ctx);
          if (typeof out === 'string' && out.length > 0) return out;
        }
      } catch (err) {
        if (debug.enabled) {
          debug.log('widget.describe-surface.override.error', id, {
            err: (err as Error)?.message ?? String(err),
          }, { level: 'error' });
        }
        // fall through to default
      }
    }
    return `${inst.type}(${inst.id}) · ${inst.character}`;
  }

  /** IDX-F5d (2026-04-22) — invoke `Widget.describeHit` for an instance.
   *
   *  Given pane-local `(localRow, localCol)`, return the widget's
   *  refinement descriptor or null (widget declines, coordinates
   *  resolve to title row / past-end, widget doesn't implement
   *  describeHit, or the method threw).
   *
   *  Used by `getPaneHitTarget` (dashboard.ts) to compose the full
   *  `HitTarget.pane-body.hit` field via `applyPaneIdToRefinement`.
   *  Swallowing throws keeps one buggy widget from breaking the entire
   *  mouse pipeline — the coarse pane-body HitTarget still flows. */
  describeHitFor(
    id: string,
    localRow: number,
    localCol: number,
  ): import('../display/types.js').WidgetHitDescriptor | null {
    const inst = this.instances.get(id);
    if (!inst) return null;
    const def = this.registry.get(inst.type)?.def;
    if (!def?.describeHit) return null;
    try {
      const ctx = this.buildContext(id);
      if (!ctx) return null;
      const out = (def.describeHit as (
        s: unknown,
        c: WidgetContext<unknown>,
        row: number,
        col: number,
      ) => import('../display/types.js').WidgetHitDescriptor | null)(
        inst.state, ctx, localRow, localCol,
      );
      return out ?? null;
    } catch (err) {
      if (debug.enabled) {
        debug.log('widget.describe-hit.override.error', id, {
          err: (err as Error)?.message ?? String(err),
        }, { level: 'error' });
      }
      return null;
    }
  }

  /** IDX-F5d Phase 2 (2026-04-22) — dispatch a WidgetHoverEvent to an
   *  instance's `onHover` override.
   *
   *  No-ops when the instance is missing, when the widget doesn't
   *  implement onHover, or when the handler throws (isolated via
   *  try/catch so a buggy widget can't poison the hover pipeline).
   *
   *  A host may call this after resolving the pointer target. Widgets
   *  use it to drive row tinting /
   *  preview refresh / auxiliary tooltip copy — visual effects only,
   *  hence the void return. Consume-able hover goes through
   *  onMouse(type:'motion') instead. */
  dispatchHover(
    id: string,
    event: import('./types.js').WidgetHoverEvent,
  ): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    const def = this.registry.get(inst.type)?.def;
    if (!def?.onHover) return;
    try {
      const ctx = this.buildContext(id);
      if (!ctx) return;
      (def.onHover as (
        ev: import('./types.js').WidgetHoverEvent,
        s: unknown,
        c: WidgetContext<unknown>,
      ) => void)(event, inst.state, ctx);
    } catch (err) {
      if (debug.enabled) {
        debug.log('widget.on-hover.override.error', id, {
          err: (err as Error)?.message ?? String(err),
          kind: event.kind,
        }, { level: 'error' });
      }
    }
  }

  /** Build a WidgetContext bound to an instance id. Generated on-demand
   *  so `state` always reflects the latest value the host holds. */
  buildContext<S>(id: string): WidgetContext<S> | null {
    const inst = this.instances.get(id);
    if (!inst) return null;
    const host = this;
    // Phase 4a — per-instance telemetry proxy auto-fills widgetId + ts
    // so widgets can emit terse events ({ kind: 'selection.change' })
    // without boilerplate. Falls through to the host's sink when wired;
    // otherwise events are discarded.
    const telemetry: TelemetrySink | undefined = host.hooks.telemetry
      ? {
        emit: (event: TelemetryEvent) => {
          host.hooks.telemetry!.emit({
            kind: event.kind,
            widgetId: event.widgetId ?? id,
            data: event.data,
            ts: event.ts ?? Date.now(),
          });
        },
      }
      : undefined;
    // Phase 4b — per-instance AnimationController. Lazily created so
    // only widgets that actually animate pay the cost. AnimationHandle
    // wraps the controller so WidgetContext stays interface-typed.
    let animator = host.animators.get(id);
    if (!animator) {
      animator = new AnimationController();
      host.animators.set(id, animator);
    }
    const animate: AnimationHandle = {
      tween: (spec) => {
        animator!.tween(spec as Parameters<AnimationController['tween']>[0]);
        // Arc F — fresh tween means the draw loop needs at least one
        // more frame. Dedup + tail recursion live in the host hook.
        host.scheduleNextFrameIfAnimating();
      },
      progress: (key) => animator!.progress(key),
      isDone: (key) => animator!.isDone(key),
      hasActive: () => animator!.hasActive(),
      cancel: (key) => animator!.cancel(key),
    };
    // Phase 4c — canvas factory. Single process-wide instance is fine
    // (create() returns a fresh per-call buffer; no cross-instance
    // mutable state).
    const canvas: CanvasFactoryHandle = canvasFactory;
    // WR-3 — pull z-order hints from the host's zInfoFor callback (when
    // wired by dashboard). `undefined` returns are tolerated so the
    // spread below omits the fields entirely · ctx shape stays clean.
    let zTier: string | undefined;
    let zIndex: number | undefined;
    if (host.hooks.zInfoFor) {
      try {
        const info = host.hooks.zInfoFor(id);
        if (info) {
          zTier = info.tier;
          zIndex = info.zIndex;
        }
      } catch (err) {
        if (debug.enabled) {
          debug.log('widget.z-info.lookup.error', id, {
            err: (err as Error)?.message ?? String(err),
          }, { level: 'error' });
        }
      }
    }

    // WR-1 — setState captures prev/next state references so the host
    // can fire the state-change event (widget hook + host subscribers).
    // `ctx` is declared with let so setState's closure sees the fully-
    // assembled object — widget.onStateChange receives the same ctx
    // reference it would during a render callback.
    let ctx: WidgetContext<S>;
    ctx = {
      widgetId: id,
      widgetType: inst.type,
      display: host.hooks.display,
      get character() { return inst.character; },
      get state() { return inst.state as S; },
      setState(patch) {
        const cur = host.instances.get(id);
        if (!cur) return;
        const prev = cur.state as S;
        cur.state = { ...(cur.state as object), ...patch } as unknown;
        host.fireStateChange(id, prev, cur.state as S, ctx);
        host.hooks.requestRender();
      },
      requestRender: () => host.hooks.requestRender(),
      dismiss: () => host.dispose(id),
      log: (line) => host.hooks.log(line),
      telemetry,
      animate,
      canvas,
      ...(zTier !== undefined ? { zTier } : {}),
      ...(zIndex !== undefined ? { zIndex } : {}),
    };
    return ctx;
  }

  /** WR-3 (Bundle 6W · Phase W replay prereq) — restore an instance's
   *  state from a timeline snapshot. Calls the widget's `replayState`
   *  override when present; otherwise falls back to `ctx.setState(state)`
   *  which merges + fires the state-change fan-out.
   *
   *  Default (per DESIGN §1.6): `ctx.setState(state as Partial<S>)`.
   *  For most widgets whose state has no side-effectful subscriptions,
   *  setState's merge semantics equal a full transplant (every top-
   *  level key in the recorded state overrides the live value).
   *
   *  Override when the widget owns external resources that need
   *  scrubbing before the transplant: clipboard watchers, SVG render
   *  cache, external subscriptions. The override is responsible for
   *  the state application (typically via `ctx.setState`).
   *
   *  Returns true on success, false for unknown id. Throws from the
   *  widget's override are isolated (fall through to default
   *  setState). */
  replayState<S>(id: string, state: S): boolean {
    const inst = this.instances.get(id);
    if (!inst) return false;
    const def = this.registry.get(inst.type)?.def;
    const ctx = this.buildContext<S>(id);
    if (!ctx) return false;

    if (def?.replayState) {
      try {
        (def.replayState as (s: S, c: WidgetContext<S>) => void)(state, ctx);
        return true;
      } catch (err) {
        debug.log('widget.replay-state.override.error', id, {
          err: (err as Error)?.message ?? String(err),
        }, { level: 'error' });
        // fall through to default
      }
    }

    // Default: `ctx.setState(state as Partial<S>)`. Same merge + fan-out
    // semantics as a normal live mutation. Simple widgets (list, table,
    // markdown, agent-detail) use this without loss of fidelity because
    // the recorded state covers every top-level key.
    ctx.setState(state as Partial<S>);
    return true;
  }
}

// ── WR-2 default snapshot hash ─────────────────────────────────────
//
// FNV-1a 32-bit over `JSON.stringify(state)`. Used by `snapshotHashFor`
// when the widget doesn't override `snapshotHash`. Circular or otherwise
// unserializable state falls back to a stable "<unhashable:<type>>"
// placeholder — callers can still compare hashes between frames; an
// unhashable widget will look "always changed" but never crash the
// recorder.
//
// Not exported from widget-host; Phase W recorder calls it indirectly
// via `WidgetHost.snapshotHashFor(id)`.

export function defaultSnapshotHash(state: unknown, typeTag: string): string {
  let json: string;
  try { json = JSON.stringify(state) ?? 'null'; }
  catch { return `<unhashable:${typeTag}>`; }
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    // 32-bit FNV prime multiply (written without Math.imul for Bun runtime consistency)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
