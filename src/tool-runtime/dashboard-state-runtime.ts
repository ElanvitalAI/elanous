// ── GetDashboardState ToolRuntime ──
//
// Read-only — no approver, no sandbox, no signal forwarding needed.
// Optional deps slot carries the terminalSessions getter so the
// snapshot reflects coding-agent modals too without pulling a heavy
// dep into the snapshot module itself.

import { createHash } from 'node:crypto';

import {
  buildGetDashboardStateTool,
  dispatchGetDashboardState,
  type DashboardStateResult,
} from '../skills/tools/dashboard-state.js';
import type { ToolRuntime } from './types.js';

type GetTerminalSessions = () => Array<{ id: string; title: string; state: string }>;
type GetTerminalMouseIntents = () => import('../dashboard/runtime/state-snapshot.js').SnapshotTerminalMouseIntent[];

let terminalSessionsGetter: GetTerminalSessions | null = null;
let terminalMouseIntentsGetter: GetTerminalMouseIntents | null = null;
let dashboardToolsGetter: (() => string[]) | null = null;
let lastStateHash: string | null = null;
let lastStateAt = 0;

const DEDUP_WINDOW_MS = 5000;

/** Dashboard boot wires this so the snapshot shows active terminal
 *  modals. When unset the snapshot's terminalSessions array is empty. */
export function setTerminalSessionsGetter(fn: GetTerminalSessions | null): void {
  terminalSessionsGetter = fn;
}

/** Dashboard boot wires this so the snapshot exposes the recent
 *  host-side terminal mouse intent seam. */
export function setTerminalMouseIntentsGetter(fn: GetTerminalMouseIntents | null): void {
  terminalMouseIntentsGetter = fn;
}

/** Dashboard boot wires this so the snapshot reflects which tool
 *  specs the dashboard chat loop is exposing this turn. */
export function setDashboardToolsGetter(fn: (() => string[]) | null): void {
  dashboardToolsGetter = fn;
}

/** Tests reset the runtime-level duplicate guard between cases so
 *  one invocation never bleeds into the next test's expectations. */
export function _resetDashboardStateDedupForTest(): void {
  lastStateHash = null;
  lastStateAt = 0;
}

export const dashboardStateRuntime: ToolRuntime<Record<string, unknown>, DashboardStateResult> = {
  id: 'dashboard_state',
  spec: buildGetDashboardStateTool(),
  async run(req) {
    const terminalSessions = (() => {
      try { return terminalSessionsGetter?.() ?? []; } catch { return []; }
    })();
    const dashboardToolNames = (() => {
      try { return dashboardToolsGetter?.() ?? []; } catch { return []; }
    })();
    const recentTerminalMouseIntents = (() => {
      try { return terminalMouseIntentsGetter?.() ?? []; } catch { return []; }
    })();
    const result = await dispatchGetDashboardState(req, {
      terminalSessions,
      dashboardToolNames,
      recentTerminalMouseIntents,
    });
    const stableStateHash = createHash('sha1')
      .update(JSON.stringify({
        workspace: result.snapshot.workspace,
        ptys: result.snapshot.ptys,
        tools: result.snapshot.tools,
        terminalSessions: result.snapshot.terminalSessions,
        recentTerminalMouseIntents: result.snapshot.recentTerminalMouseIntents,
      }))
      .digest('hex');
    const now = Date.now();

    if (lastStateHash === stableStateHash && now - lastStateAt <= DEDUP_WINDOW_MS) {
      const secondsAgo = Math.max(1, Math.round((now - lastStateAt) / 1000));
      return {
        ...result,
        output:
          `[DUPLICATE CALL — state unchanged]\n` +
          `GetDashboardState\n` +
          `Dashboard state is unchanged from ${secondsAgo}s ago. ` +
          `Use the previous tool_result already in history unless an intervening action changed sessions, cwd, or tool exposure.`,
      };
    }

    lastStateHash = stableStateHash;
    lastStateAt = now;
    return result;
  },
};
