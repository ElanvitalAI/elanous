// IDX-2c follow-up — Budget → ContextKeys bridge.
//
// Subscribes to the cost-meter observer and publishes
// `budgetWarningActive` whenever either the weekly OR monthly cap
// enters `warning` / `tripped` state. Primary consumer: when-clauses
// like `when: '!budgetWarningActive'` gating paid-model bindings
// so the user can't accidentally burn through the last of the
// budget after a warning.
//
// Mirrors the pattern of `wireAutoModeContextBridge` /
// `wireAndonContextBridge` — factory returns disposer, immediate
// seed on start, single cost-meter listener. `startAutoModeContextBridge`
// in this same directory has the same logic embedded in a larger
// 3-source bridge; this extraction lets callers opt in to just the
// budget piece without pulling auto-mode + andon along.

import {
  loadCostConfig,
  monthlyCapStatus,
  snapshotCost,
  subscribeCostMeter,
  weeklyCapStatus,
} from './cost-meter.js';
import type { ContextKeyService } from '../input-core/context-keys.js';
import { getRuntimeContextKeyService } from '../input-core/context-key-runtime.js';

export interface WireBudgetContextBridgeOpts {
  /** Override the ContextKeyService (tests). Production uses the
   *  dashboard singleton when omitted. */
  service?: ContextKeyService;
  /** Test seam — inject a cost-config loader so fixtures don't
   *  depend on `~/.elanous/cost-config.json`. */
  loadConfig?: () => ReturnType<typeof loadCostConfig>;
  /** Test seam — inject a cost snapshot builder. */
  snapshot?: () => ReturnType<typeof snapshotCost>;
}

export function wireBudgetContextBridge(
  opts: WireBudgetContextBridgeOpts = {},
): () => void {
  const svc = opts.service ?? getRuntimeContextKeyService();
  const load = opts.loadConfig ?? loadCostConfig;
  const snap = opts.snapshot ?? snapshotCost;

  const publish = (): void => {
    try {
      const cfg = load();
      const s = snap();
      const week = weeklyCapStatus(s, cfg);
      const month = monthlyCapStatus(s, cfg);
      const warning =
        week === 'warning' || week === 'tripped'
        || month === 'warning' || month === 'tripped';
      svc.update({ budgetWarningActive: warning });
    } catch {
      // Budget read failures (missing config, corrupt log, etc.)
      // must not break the session. Leave the key untouched so the
      // last good value persists.
    }
  };

  // Seed immediately so when-clauses see truth on first resolve.
  publish();
  return subscribeCostMeter(() => { publish(); });
}
