// IDX-2b — Bridge between AutoMode session state and the dashboard
// ContextKeyService. Mirrors `active` onto `autoModeActive` so when-
// clauses can gate bindings on "is the LLM currently in autonomous
// research mode?"
//
// Installed once at dashboard boot via `wireAutoModeContextBridge()`.
// The returned dispose stops the bridge (used by tests; production
// keeps it installed for the session lifetime).

import { subscribeAutoMode, isAutoModeActive } from './session.js';
import type { ContextKeyService } from '../../input-core/context-keys.js';
import { getRuntimeContextKeyService } from '../../input-core/context-key-runtime.js';

export function wireAutoModeContextBridge(
  service?: ContextKeyService,
): () => void {
  const svc = service ?? getRuntimeContextKeyService();
  // Seed immediately so startup state is reflected without waiting
  // for the next session transition.
  svc.update({ autoModeActive: isAutoModeActive() });
  const dispose = subscribeAutoMode((state) => {
    svc.update({ autoModeActive: state.active });
  });
  return dispose;
}
