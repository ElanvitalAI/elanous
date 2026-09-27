import { topModalSurface } from '../../display/modal-stack.js';
import type { ModalSurface } from '../../display/modal-stack.js';
import type { DisplayMouseEvent } from '../../display/types.js';
import type { DashboardMouseWiringDeps } from './mouse-wiring.js';

export interface MouseModalSurfaceRuntimeDeps {
  getFocusStack: () => readonly string[];
  surfaceAt: (id: string) => ModalSurface | null | undefined;
  getTopBlockingModalSurface: () => ModalSurface | null;
  routeModalMouse: (surface: ModalSurface, ev: DisplayMouseEvent) => boolean;
}

export interface MouseModalSurfaceRuntime
  extends Pick<
    DashboardMouseWiringDeps,
    'getTopModalSurface' | 'getTopBlockingModalSurface' | 'routeModalMouse'
  > {}

export function createMouseModalSurfaceRuntime(
  deps: MouseModalSurfaceRuntimeDeps,
): MouseModalSurfaceRuntime {
  return {
    getTopModalSurface: () =>
      topModalSurface({
        focusStack: deps.getFocusStack(),
        surfaceAt: (id) => deps.surfaceAt(id),
      }),
    getTopBlockingModalSurface: deps.getTopBlockingModalSurface,
    routeModalMouse: deps.routeModalMouse,
  };
}
