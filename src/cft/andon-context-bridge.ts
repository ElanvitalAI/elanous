// IDX-2b — Bridge between Andon escalations and the dashboard
// ContextKeyService. Mirrors `hasPendingCritical()` onto
// `escalationPending` so when-clauses can gate bindings on
// "a critical escalation is unresolved" (e.g. suppress certain
// shortcuts until the operator acknowledges).
//
// Installed once at dashboard boot via `wireAndonContextBridge()`.

import { subscribeAndon, hasPendingCritical } from './andon.js';
import type { ContextKeyService } from '../input-core/context-keys.js';
import { getRuntimeContextKeyService } from '../input-core/context-key-runtime.js';

export function wireAndonContextBridge(
  service?: ContextKeyService,
): () => void {
  const svc = service ?? getRuntimeContextKeyService();
  // Seed immediately.
  svc.update({ escalationPending: hasPendingCritical() });
  const dispose = subscribeAndon(() => {
    // Any andon event (emit or resolve) may have changed the pending
    // critical set. Re-evaluate from the source of truth — cheap and
    // avoids duplicating classification rules here.
    svc.update({ escalationPending: hasPendingCritical() });
  });
  return dispose;
}
