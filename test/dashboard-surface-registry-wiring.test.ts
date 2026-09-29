import { describe, expect, test } from 'bun:test';

import { wireDashboardSurfaceRegistry } from '../src/dashboard/surface-registry-wiring.js';
import { wireModalSurfaceAdapter } from '../src/surface/adapters/modal-surface-adapter.js';
import { createSurfaceRegistry } from '../src/surface/registry.js';

describe('dashboard surface registry wiring', () => {
  test('registers a modal and a widget, but no window surface', () => {
    const surfaceRegistry = createSurfaceRegistry();
    let pushModal!: (event: { identity: { kind: string; modalId: string }; surfaceId: string; tier?: string }) => void;
    let mountWidget!: (event: { type: string; instanceId: string }) => void;
    const identity = {
      onPush: (cb: typeof pushModal) => { pushModal = cb; return () => {}; },
      onPop: () => () => {},
    };
    const widgetHost = {
      onMount: (cb: typeof mountWidget) => { mountWidget = cb; return () => {}; },
      onDispose: () => () => {},
    };

    expect(wireDashboardSurfaceRegistry({
      surfaceRegistry,
      widgetHost: widgetHost as never,
      wireModal: (opts) => wireModalSurfaceAdapter({ ...opts, identity: identity as never }),
    })).toBeUndefined();

    pushModal({ identity: { kind: 'dialog', modalId: 'modal-1' }, surfaceId: 'dialog-1' });
    mountWidget({ type: 'status', instanceId: 'widget-1' });

    expect(surfaceRegistry.listByKind('modal')).toEqual([
      expect.objectContaining({ addr: { kind: 'modal', modalId: 'modal-1' }, surfaceId: 'dialog-1', kindTag: 'dialog', visible: true }),
    ]);
    expect(surfaceRegistry.listByKind('widget')).toEqual([
      expect.objectContaining({ addr: { kind: 'widget', widgetId: 'widget-1' }, surfaceId: 'widget-1', kindTag: 'status', visible: true }),
    ]);
    expect(surfaceRegistry.listByKind('window')).toHaveLength(0);
    expect(surfaceRegistry.list()).toHaveLength(2);
  });
});
