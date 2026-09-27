import { describe, expect, mock, test } from 'bun:test';

import { createMouseModalSurfaceRuntime } from '../src/dashboard/input/mouse-modal-surface-runtime.js';

describe('createMouseModalSurfaceRuntime', () => {
  test('resolves top modal from focus stack and forwards modal mouse routing', () => {
    const modal = {
      id: 'm1',
      kind: 'modal',
      bounds: { row: 1, col: 1, width: 10, height: 5 },
      backgroundInteractionPolicy: 'block',
      paint: () => '',
    } as never;
    const routeModalMouse = mock((_surface: unknown, _ev: unknown) => true);
    const runtime = createMouseModalSurfaceRuntime({
      getFocusStack: () => ['pane-1', 'm1'],
      surfaceAt: (id) => (id === 'm1' ? modal : null),
      getTopBlockingModalSurface: () => modal,
      routeModalMouse,
    });

    expect(runtime.getTopModalSurface?.()).toBe(modal);
    expect(runtime.getTopBlockingModalSurface?.()).toBe(modal);
    const event = { row: 2, col: 3 } as never;
    expect(runtime.routeModalMouse?.(modal, event)).toBe(true);
    expect(routeModalMouse).toHaveBeenCalledWith(modal, event);
  });
});
