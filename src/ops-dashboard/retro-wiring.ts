// OP-CEO-ALLOCATION-LOOP — keeps the operating dashboard fresh in the OP TUI and hands the retro its lines.
// The build runs off the turn (a background timer, unref'd); the retro reads the stored snapshot synchronously.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { dashboardDir, refreshOperatingDashboard, retroDashboardLines } from './operating-dashboard.js';

export const OP_DASHBOARD_REFRESH_MS = 10 * 60_000;

export function startOpDashboardRefresh(opts: { hqRoot?: string; intervalMs?: number } = {}): { metrics: () => readonly string[]; stop: () => void } {
  const hqRoot = opts.hqRoot ?? join(homedir(), 'elanous-hq');
  let running = false;
  const refresh = (): void => {
    if (running) return;
    running = true;
    void refreshOperatingDashboard({ hqRoot, log: (event, data) => debug.log('ops.dashboard', event, data) })
      .catch((error) => debug.log('ops.dashboard', 'build-failed', { error: String(error).slice(0, 200) }))
      .finally(() => { running = false; });
  };
  refresh();
  const timer = setInterval(refresh, opts.intervalMs ?? OP_DASHBOARD_REFRESH_MS);
  (timer as { unref?: () => void }).unref?.();
  return { metrics: () => retroDashboardLines(dashboardDir(hqRoot), new Date()), stop: () => clearInterval(timer) };
}
