// IDX-2c follow-up — PlanMode → ContextKeys bridge.
//
// Mirrors wireAutoModeContextBridge. Subscribes to plan-mode
// session transitions and updates `planModeActive` so when-clauses
// can gate plan-bypass bindings (e.g. chord shortcuts that only
// make sense in plan mode).
//
// PlanMode is orthogonal to operating mode (general / sync / control) —
// both keys can coexist (plan mode is a policy layer, operating mode
// is an interaction layer).

import { isPlanModeActive, subscribePlanMode } from './session.js';
import type { ContextKeyService } from '../input-core/context-keys.js';
import { getRuntimeContextKeyService } from '../input-core/context-key-runtime.js';

export function wirePlanModeContextBridge(
  service?: ContextKeyService,
): () => void {
  const svc = service ?? getRuntimeContextKeyService();
  // Seed immediately — startup state flows into ContextKeys before
  // the first plan enter/exit.
  svc.update({ planModeActive: isPlanModeActive() });
  return subscribePlanMode(() => {
    svc.update({ planModeActive: isPlanModeActive() });
  });
}
