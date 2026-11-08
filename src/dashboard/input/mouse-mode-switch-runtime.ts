import type { DashboardMouseWiringDeps } from './mouse-wiring-types.js';

export type DashboardInputMode = 'general' | 'sync' | 'control';

/**
 * Modes owned by the input-core ModeManager and therefore switchable via
 * `setMode`. `sync` is intentionally excluded: Arc A moved it out of the
 * ModeManager (it is plugin-owned and entered through a mode action, not
 * `setMode`). `ModeManager.setMode` resolves to the resulting mode, so the
 * setter may return it (callers here ignore the value).
 */
export type DashboardManagedMode = 'general' | 'control';

export interface MouseModeSwitchRuntimeDeps {
  getActiveMode: () => DashboardInputMode;
  getModeAction: (
    actionId: string,
  ) => { handler: () => void | Promise<void> } | null;
  setMode: (next: DashboardManagedMode) => void | Promise<void | DashboardManagedMode>;
}

export interface MouseModeSwitchRuntime
  extends Pick<DashboardMouseWiringDeps, 'getActiveMode' | 'onModeSwitch'> {}

export function createMouseModeSwitchRuntime(
  deps: MouseModeSwitchRuntimeDeps,
): MouseModeSwitchRuntime {
  return {
    getActiveMode: deps.getActiveMode,
    onModeSwitch: async (next) => {
      const currentMode = deps.getActiveMode();
      if (next === currentMode) return;
      const action = deps.getModeAction(`mode.enter.${next}`);
      if (action) {
        try {
          await action.handler();
        } catch {
          /* isolate */
        }
        return;
      }
      if (next === 'general' || next === 'control') {
        await deps.setMode(next);
      }
    },
  };
}
