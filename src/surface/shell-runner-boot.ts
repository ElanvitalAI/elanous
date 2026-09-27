import type { PaneContent } from '../virtual-windows/pane-content.js';
import type { ExternalTerminalPaneOpts } from '../shell-runner/external-terminal-pane.js';
interface ShellRegistryLike<Handle> {}

interface BackgroundSurfaceLike<Handle> {
  track(handle: Handle): void;
  forget(id: string): void;
}

interface RunnerHostsLike<Request, Host> {
  factory(req: Request): Host | null;
  evict(label: string): boolean;
}

export interface DashboardShellRunnerBootDeps<Request, Handle, Host> {
  createBackgroundSurface: (deps: {
    onUpdate: (rollup: { running: number; backgrounded: number }) => void;
  }) => BackgroundSurfaceLike<Handle>;
  initShellRegistry: (deps: {
    onRegister: (handle: Handle) => void;
    onUnregister: (id: string) => void;
  }) => ShellRegistryLike<Handle>;
  wireShellRunnerSurface?: (deps: { shellRegistry: ShellRegistryLike<Handle> }) => void;
  // A pane-content factory returns a PaneContent, not `unknown` — the
  // registry (registerPaneContentKind) requires that concrete return.
  registerPaneContentKind: (kind: string, factory: (spec: unknown) => PaneContent) => void;
  // Mirror the real external-terminal-pane contract exactly: `preview`
  // is a PreviewTerminal, `focusPolicy` a FocusPolicy, and the mouse
  // intent callback the two-arg (ev, meta) form. Reusing the owning
  // type keeps this seam from drifting again.
  createExternalTerminalPaneContent: (spec: ExternalTerminalPaneOpts) => PaneContent;
  createRunnerHostFactory: (deps: {
    getSessionCwd: () => string;
    initialSize: () => { cols: number; rows: number };
    onSpawnError: (label: string, err: unknown) => void;
    onSpawn: (label: string, host: Host) => void;
  }) => RunnerHostsLike<Request, Host>;
  createFileCaptureEngine: () => unknown;
  // DI setter — method syntax gives bivariant parameter checking so the
  // concrete ShellRunnerDeps (a real ShellRegistry, with fileEngine and
  // ptyHostFactory both optional) is assignable through this structural
  // seam. fileEngine/ptyHostFactory are optional to match that contract.
  setShellRunnerDeps(deps: {
    registry: ShellRegistryLike<Handle>;
    fileEngine?: unknown;
    ptyHostFactory?: (req: Request) => Host | null;
  }): void;
  getSessionCwd: () => string;
  termSize: () => { cols: number; rows: number };
  setLatestShellRollup: (rollup: { running: number; backgrounded: number }) => void;
  onSpawnError: (label: string, err: unknown) => void;
  subscribeVirtualWindowClose: (cb: (ev: { type: string; spawnTitle?: string | null }) => void) => void;
}

export function bootDashboardShellRunner<Request, Handle, Host>(
  deps: DashboardShellRunnerBootDeps<Request, Handle, Host>,
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
  try {
    deps.registerPaneContentKind('external-terminal', (spec: any) =>
      deps.createExternalTerminalPaneContent({
        preview: spec.preview,
        title: spec.title,
        label: spec.label,
        focusPolicy: spec.focusPolicy,
        onTerminalMouseIntent: spec.onTerminalMouseIntent,
      }));
  } catch { /* already registered */ }
  const runnerHosts = deps.createRunnerHostFactory({
    getSessionCwd: deps.getSessionCwd,
    initialSize: deps.termSize,
    onSpawnError: deps.onSpawnError,
    onSpawn: () => {},
  });
  deps.setShellRunnerDeps({
    registry,
    fileEngine: deps.createFileCaptureEngine(),
    ptyHostFactory: (req) => runnerHosts.factory(req),
  });
  try {
    deps.subscribeVirtualWindowClose((ev) => {
      if (ev.type !== 'window:close') return;
      const label = ev.spawnTitle;
      if (!label) return;
      try { runnerHosts.evict(label); } catch { /* isolate */ }
    });
  } catch { /* virtual-windows not ready in early boot — skip */ }
}
