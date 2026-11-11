// IDX-2c follow-up — Input-core mode → ContextKeys bridge.
//
// Subscribes to input-core ModeManager transitions (general / control)
// and mirrors `controlModeActive` onto the context-keys snapshot.
//
// Pattern matches wireAutoModeContextBridge.
//
// Plan mode is orthogonal — handled by `wirePlanModeContextBridge`
// in src/plan-mode/context-bridge.ts.
//
// Arc A (harness-engineering meta-track) — `syncModeActive` is now
// always published as `false`. Sync was retired from ModeManager and
// is owned by PluginHost (`pluginHost.activate('sync')` →
// `plugins/sync/plugin.ts`). The key is kept on the ContextKeys
// interface as a deprecated compatibility alias; downstream
// when-clauses gating on it will remain inert (matching the live
// truth that no `'sync'` ModeId exists). New consumers should use
// `pluginHost.isActive('sync')` for the live state.

import { activeMode, subscribeMode, type ModeId } from './mode.js';
import type { ContextKeyService } from './context-keys.js';
import { getRuntimeContextKeyService } from './context-key-runtime.js';

export function wireInputModeContextBridge(
  service?: ContextKeyService,
): () => void {
  const svc = service ?? getRuntimeContextKeyService();
  const publish = (mode: ModeId): void => {
    svc.update({
      // Always false — sync was retired from ModeManager (Arc A).
      // Kept on the interface for compatibility with existing
      // when-clauses; new code should consult pluginHost.isActive('sync').
      syncModeActive:    false,
      controlModeActive: mode === 'control',
    });
  };
  // Seed from the current mode so startup state is reflected before
  // any transition. A fresh session sits in 'general'.
  publish(activeMode());
  return subscribeMode((next) => publish(next));
}
