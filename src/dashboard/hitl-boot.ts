export interface DashboardHitlPortShiftInfo {
  wanted: number;
  actual: number;
}

export interface DashboardHitlBootDeps {
  enabled: boolean;
  initDashboardHitl: (deps: {
    onPortShift: (info: DashboardHitlPortShiftInfo) => void;
  }) => Promise<unknown>;
  stopDashboardHitl: () => Promise<unknown>;
  debugLog: (scope: string, message: string) => void;
  isPushcutConfigured: () => boolean;
  pushWarningLine: (message: string) => void;
  /** Minimal boot banner: hold the port-shift notice for `/status` instead of the transcript. */
  holdWarningLine?: (message: string) => void;
  draw: () => void;
  registerBeforeExit: (cb: () => void) => void;
  warnConsole: (message: string) => void;
}

export function bootDashboardHitl(
  deps: DashboardHitlBootDeps,
): void {
  if (!deps.enabled) return;
  void deps.initDashboardHitl({
    onPortShift: (info) => {
      deps.debugLog('hitl.port.shift', `${info.wanted} → ${info.actual}`);
      if (!deps.isPushcutConfigured()) return;
      const message = `[hitl] callback port ${info.wanted} was busy — bound ${info.actual} instead. `
        + `Update your Pushcut Shortcut URL: http://127.0.0.1:${info.actual}`;
      if (deps.holdWarningLine) {
        deps.holdWarningLine(message);
        return;
      }
      deps.pushWarningLine(message);
      try { deps.draw(); } catch { /* ignore */ }
    },
  }).catch((err) => {
    deps.warnConsole(`[hitl] init failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  deps.registerBeforeExit(() => { void deps.stopDashboardHitl(); });
}
