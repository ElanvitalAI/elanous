import type { RotationEntry } from '../../user-config/types.js';
import type { DashboardMouseWiringDeps } from './mouse-wiring-types.js';

export interface MousePickerRuntimeDeps {
  getRotation: () => RotationEntry[];
  getCurrentModelEntry?: () => RotationEntry | null;
  applyActiveModel: (entry: RotationEntry) => void;
  getRecentWds: () => string[];
  applySessionWd: (path: string) => void;
  reportModelSwitchError: (message: string) => void;
  reportWdSwitchError: (message: string) => void;
}

export interface MousePickerRuntime
  extends Pick<
    DashboardMouseWiringDeps,
    'getRotation' | 'getCurrentModelEntry' | 'setActiveModel' | 'getRecentWds' | 'setSessionWd'
  > {}

export function createMousePickerRuntime(
  deps: MousePickerRuntimeDeps,
): MousePickerRuntime {
  return {
    getRotation: deps.getRotation,
    getCurrentModelEntry: deps.getCurrentModelEntry,
    setActiveModel: (entry) => {
      try {
        deps.applyActiveModel(entry);
      } catch (error) {
        deps.reportModelSwitchError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    getRecentWds: deps.getRecentWds,
    setSessionWd: (path) => {
      try {
        deps.applySessionWd(path);
      } catch (error) {
        deps.reportWdSwitchError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}
