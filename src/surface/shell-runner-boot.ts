interface ShellRegistryLike<Handle> {}

interface BackgroundSurfaceLike<Handle> {
  track(handle: Handle): void;
  forget(id: string): void;
}

export interface DashboardShellRunnerBootDeps<Handle> {
  createBackgroundSurface: (deps: {
    onUpdate: (rollup: { running: number; backgrounded: number }) => void;
  }) => BackgroundSurfaceLike<Handle>;
  initShellRegistry: (deps: {
    onRegister: (handle: Handle) => void;
    onUnregister: (id: string) => void;
  }) => ShellRegistryLike<Handle>;
  wireShellRunnerSurface?: (deps: { shellRegistry: ShellRegistryLike<Handle> }) => void;
  createFileCaptureEngine: () => unknown;
  setShellRunnerDeps(deps: {
    registry: ShellRegistryLike<Handle>;
    fileEngine?: unknown;
  }): void;
  setLatestShellRollup: (rollup: { running: number; backgrounded: number }) => void;
}

export function bootDashboardShellRunner<Handle>(
  deps: DashboardShellRunnerBootDeps<Handle>,
): void {
  const bgSurface = deps.createBackgroundSurface({
    onUpdate: (rollup) => {
      deps.setLatestShellRollup({
        running: rollup.running,
        backgrounded: rollup.backgrounded,
      });
    },
  });
  const registry = deps.initShellRegistry({
    onRegister: (handle) => {
      try { bgSurface.track(handle); } catch { /* isolate */ }
    },
    onUnregister: (id) => {
      try { bgSurface.forget(id); } catch { /* isolate */ }
    },
  });
  try {
    deps.wireShellRunnerSurface?.({ shellRegistry: registry });
  } catch { /* never break boot */ }
  deps.setShellRunnerDeps({ registry, fileEngine: deps.createFileCaptureEngine() });
}
