// ── Presentation track P1.7 · plugin-host ↔ store.plugins bridge ──
//
// Wires plugin activate/deactivate lifecycle to the P1 state store's
// `plugins` slice via `installPluginSlice` / `uninstallPluginSlice`
// (helpers already provided by P1 · src/state/store.ts).
//
// Scope per HANDOFF §2:
//   - Additive only — zero call-site changes to PluginHost.
//   - Pure type import from plugin-host · no static dependency on
//     installable plugins.
//   - Install is opt-in · caller owns dispose (dashboard wiring lands
//     in a subsequent PR · P1.7a).
//
// Implementation = **Option A (method wrap)**: PluginHost exposes
// public `activate(name)`, `deactivate()`, and `deactivateAll()` methods
// but no lifecycle subscribe API. We monkey-patch those instance methods
// (own-property shadows) and synchronize the full active set after each
// operation settles, including internal legacy transitions in activate().
// On dispose we `delete` the own-properties so the prototype methods take
// over — plugin-host is left exactly as we found it.
//
// Loop prevention is unnecessary here: activate/deactivate are
// discrete, caller-driven events. Plugins mutating their own slice
// via `store.setState({ plugins: { [id]: ... } })` is independent and
// non-echoing — this bridge doesn't subscribe to `store.plugins`.
//
// Debug junctions (CLAUDE.md 규율):
//   - state.bridge.plugin-host.attach     · initial sync
//   - state.bridge.plugin-host.activate   · active slices synchronized
//   - state.bridge.plugin-host.deactivate · active slices synchronized
//   - state.bridge.plugin-host.dispose    · wrappers detached

import { debug } from '../../debug/log.js';
import type { PluginHost } from '../../plugins/core/host.js';
import { installPluginSlice, uninstallPluginSlice } from '../store.js';
import type { ElanousState, Store } from '../types.js';

/** Attach plugin-lifecycle sync between a PluginHost and a ElanousState
 *  store's `plugins` slice.
 *
 *  Semantics:
 *    - On attach, the currently active plugin's slice is installed into
 *      the store (host is authoritative).
 *    - After activate, deactivate, or deactivateAll settles, install
 *      newly active slices and uninstall removed slices from the host's
 *      actual active set. Existing active store slices remain untouched.
 *    - On dispose, the monkey-patches are removed. The currently
 *      installed slice is NOT uninstalled (the active plugin is still
 *      running; its slice remains authoritative until the caller
 *      deactivates).
 *    - Disposer is idempotent · calling twice is a no-op.
 *
 *  The bridge does NOT subscribe to `store.plugins`. Plugins that want
 *  reactive state mirrored into the store should call `store.setState`
 *  inside their ctx — their slice is already isolated under
 *  `plugins[pluginId]` per P1's installPluginSlice contract. */
export function bridgePluginHostToStore(
  store: Store<ElanousState>,
  pluginHost: PluginHost,
): () => void {
  // Capture originals via the prototype chain so `this`-binding is
  // preserved when we re-invoke them inside the wrappers.
  const origActivate = pluginHost.activate.bind(pluginHost);
  const origDeactivate = pluginHost.deactivate.bind(pluginHost);
  const origDeactivateAll = pluginHost.deactivateAll.bind(pluginHost);
  // Structural test hosts can provide the original single-active API.
  const livePlugins = () => typeof pluginHost.activePlugins === 'function'
    ? pluginHost.activePlugins()
    : pluginHost.active() ? [pluginHost.active()!] : [];
  const syncedPluginNames = new Set<string>();
  const syncFromHost = () => {
    const active = livePlugins();
    const activeNames = new Set(active.map(plugin => plugin.name));
    for (const name of syncedPluginNames) {
      if (!activeNames.has(name)) uninstallPluginSlice(store, name);
    }
    for (const plugin of active) {
      if (!syncedPluginNames.has(plugin.name)) installPluginSlice(store, plugin.name, plugin.state);
    }
    syncedPluginNames.clear();
    for (const name of activeNames) syncedPluginNames.add(name);
  };

  // ── Initial sync (host → store, one-shot) ──────────────────────
  {
    for (const active of livePlugins()) {
      installPluginSlice(store, active.name, active.state);
      syncedPluginNames.add(active.name);
    }
    if (debug.enabled) {
      debug.log('state.bridge.plugin-host.attach', 'init-sync', {
        active: pluginHost.active()?.name ?? null,
      });
    }
  }

  // ── Wrap activate · install slice after successful activation ──
  const wrappedActivate = async function (name: string): Promise<void> {
    try {
      await origActivate(name);
    } finally {
      syncFromHost();
      if (debug.enabled) {
        debug.log('state.bridge.plugin-host.activate', 'slices-synced', {
          active: livePlugins().map(active => active.name),
        });
      }
    }
  };

  // ── Wrap deactivate · remove slice after successful deactivation ──
  const wrappedDeactivate = async function (name?: string): Promise<void> {
    try {
      await origDeactivate(name);
    } finally {
      syncFromHost();
      if (debug.enabled) {
        debug.log('state.bridge.plugin-host.deactivate', 'slices-synced', {
          active: livePlugins().map(active => active.name),
        });
      }
    }
  };

  const wrappedDeactivateAll = async function (): Promise<void> {
    try {
      await origDeactivateAll();
    } finally {
      syncFromHost();
      if (debug.enabled) {
        debug.log('state.bridge.plugin-host.deactivate', 'all-slices-synced', {
          active: livePlugins().map(active => active.name),
        });
      }
    }
  };

  // Install as own-properties · shadows prototype methods. Internal
  // `this.deactivate()` calls inside `activate()` now route through our
  // wrapper, which correctly uninstalls the previous plugin's slice
  // before the new activation runs.
  (pluginHost as unknown as { activate: typeof wrappedActivate }).activate = wrappedActivate;
  (pluginHost as unknown as { deactivate: typeof wrappedDeactivate }).deactivate = wrappedDeactivate;
  (pluginHost as unknown as { deactivateAll: typeof wrappedDeactivateAll }).deactivateAll = wrappedDeactivateAll;

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    // Remove own-property shadows · prototype methods take over again.
    // If a plugin is still active, its slice stays in the store (caller's
    // responsibility to uninstall if desired).
    delete (pluginHost as unknown as { activate?: unknown }).activate;
    delete (pluginHost as unknown as { deactivate?: unknown }).deactivate;
    delete (pluginHost as unknown as { deactivateAll?: unknown }).deactivateAll;
    if (debug.enabled) {
      debug.log('state.bridge.plugin-host.dispose', 'detached', {});
    }
  };
}
