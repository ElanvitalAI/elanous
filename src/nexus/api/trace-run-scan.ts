import { statSync } from 'node:fs';
import type { LogInstanceView } from '../../mss/logging/instance-registry.js';
import type { LogStore } from '../../mss/logging/log-store.js';

/** Bounded, read-only fallback when a run's ledger is not on this host. */
export function scanStoresForRun(
  runId: string,
  views: readonly LogInstanceView[],
  open: (view: LogInstanceView) => Pick<LogStore, 'queryTraceRun' | 'close'> | null,
  opts: { sinceMs?: number; untilMs?: number; maxStores?: number; deadlineMs?: number; now?: () => number } = {},
): { universe?: string; checked: number; truncated: boolean; unresolved?: boolean } {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.deadlineMs ?? 3000);
  const maxStores = opts.maxStores ?? 200;
  const mtime = (view: LogInstanceView): number => {
    try { return statSync(view.dbPath).mtimeMs; } catch { return -Infinity; }
  };
  const candidates = views.map((view) => ({ view, at: view.dbExists ? mtime(view) : -Infinity }))
    .sort((a, b) => (b.at === a.at ? a.view.name.localeCompare(b.view.name) : b.at - a.at));
  let checked = 0;
  let unresolved = false;
  for (const { view } of candidates) {
    if (checked >= maxStores || now() >= deadline) return { checked, truncated: true };
    checked++;
    let store: ReturnType<typeof open> = null;
    try {
      if (!view.dbExists) continue;
      store = open(view);
      if (!store) { unresolved = true; continue; }
      if (store.queryTraceRun(runId, { sinceMs: opts.sinceMs, untilMs: opts.untilMs, limit: 1 }).length) {
        return { universe: view.name, checked, truncated: false };
      }
    } catch { unresolved = true; }
    finally { try { store?.close(); } catch { /* read-only handle cleanup is best effort */ } }
  }
  return { checked, truncated: false, ...(unresolved ? { unresolved } : {}) };
}
