import type { ContextDeps } from '../skills/tools/context.js';

export interface DashboardContextWindowRuntimeBootDeps {
  setContextRuntimeDeps: (deps: ContextDeps) => void;
  cwd: string;
  getTerminalSessions: () => Array<{ id: string; title: string; state: string }>;
}

export function bootDashboardContextWindowRuntime(
  deps: DashboardContextWindowRuntimeBootDeps,
): void {
  deps.setContextRuntimeDeps({
    cwd: deps.cwd,
    getTerminalSessions: deps.getTerminalSessions,
  });
}
