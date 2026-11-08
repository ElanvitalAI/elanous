import type { DashboardMouseWiringDeps } from './mouse-wiring-types.js';

interface ModalBoundsLike {
  row: number;
  col: number;
  width: number;
  height: number;
}

interface ModalSurfaceLike {
  id: string;
  kind: string;
  bounds?: ModalBoundsLike | null;
  interactiveBounds?: ModalBoundsLike | null;
}

export interface MouseModalHitRuntimeDeps {
  getTopSurface: () => ModalSurfaceLike | null;
}

export interface MouseModalHitRuntime
  extends Pick<DashboardMouseWiringDeps, 'getModalHitTarget'> {}

export function createMouseModalHitRuntime(
  deps: MouseModalHitRuntimeDeps,
): MouseModalHitRuntime {
  return {
    getModalHitTarget: (row, col) => {
      try {
        const surface = deps.getTopSurface();
        if (!surface || surface.kind !== 'modal') return null;
        const bounds = surface.interactiveBounds ?? surface.bounds;
        if (!bounds) return null;
        if (row < bounds.row || row >= bounds.row + bounds.height) return null;
        if (col < bounds.col || col >= bounds.col + bounds.width) return null;
        return { kind: 'modal-body', modalId: surface.id };
      } catch {
        return null;
      }
    },
  };
}
