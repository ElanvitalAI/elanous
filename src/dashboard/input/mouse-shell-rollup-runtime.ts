import type { ShellHandle } from '../../shell-runner/types.js';
import type { DashboardMouseWiringDeps } from './mouse-wiring-types.js';

interface ShellRegistryEntry {
  id: string;
  mode: ShellHandle['mode'];
  status: ShellHandle['status'];
}

interface ShellRegistryView {
  list: () => ShellRegistryEntry[];
  get: (id: string) => ShellRegistryEntry | null;
  getVwLabel: (id: string) => string | null;
}

interface AttachOutcome {
  kind: 'switch-vw' | 'inline' | 'bg' | 'no-label' | 'no-window';
  windowId?: number;
  reason?: string;
}

export interface MouseShellRollupRuntimeDeps {
  resolveVwIdByLabel: (label: string) => number | null;
  switchToVirtualWindow: (windowId: number) => void;
  onWarning: (message: string) => void;
  loadRegistry?: () => ShellRegistryView;
  loadRenderHandleStatusChip?: () => (status: ShellHandle['status']) => string;
  loadDecideAttach?: () => Promise<
    (shell: ShellRegistryEntry, deps: {
      getVwLabel: (id: string) => string | null;
      resolveVwIdByLabel: (label: string) => number | null;
    }) => AttachOutcome
  >;
}

export interface MouseShellRollupRuntime
  extends Pick<DashboardMouseWiringDeps, 'getShellRollupEntries' | 'onShellRollupPick'> {}

export function createMouseShellRollupRuntime(
  deps: MouseShellRollupRuntimeDeps,
): MouseShellRollupRuntime {
  return {
    getShellRollupEntries: () => listMouseShellRollupEntries(deps),
    onShellRollupPick: (handleId) => {
      void handleShellRollupPick(handleId, deps);
    },
  };
}

export function listMouseShellRollupEntries(
  deps: MouseShellRollupRuntimeDeps,
): NonNullable<DashboardMouseWiringDeps['getShellRollupEntries']> extends () => infer R ? R : never {
  try {
    const registry = (deps.loadRegistry ?? loadRegistry)();
    const renderHandleStatusChip =
      (deps.loadRenderHandleStatusChip ?? loadRenderHandleStatusChip)();
    return registry.list().map((handle) => ({
      id: handle.id,
      chip: renderHandleStatusChip(handle.status),
      mode: handle.mode,
      status: handle.status,
      label: registry.getVwLabel(handle.id) ?? undefined,
    }));
  } catch {
    return [];
  }
}

async function handleShellRollupPick(
  handleId: string,
  deps: MouseShellRollupRuntimeDeps,
): Promise<void> {
  try {
    const [registry, decideAttach] = await Promise.all([
      (deps.loadRegistry ?? loadRegistry)(),
      (deps.loadDecideAttach ?? loadDecideAttach)(),
    ]);
    const handle = registry.get(handleId);
    if (!handle) return;
    const outcome = decideAttach(handle, {
      getVwLabel: (id) => registry.getVwLabel(id),
      resolveVwIdByLabel: deps.resolveVwIdByLabel,
    });
    if (outcome.kind === 'switch-vw' && outcome.windowId !== undefined) {
      deps.switchToVirtualWindow(outcome.windowId);
      return;
    }
    if (outcome.reason) deps.onWarning(outcome.reason);
  } catch {
    /* isolate */
  }
}

function loadRegistry(): ShellRegistryView {
  const { getShellRegistry } =
    require('../../shell-runner/registry.js') as typeof import('../../shell-runner/registry.js');
  return getShellRegistry();
}

function loadRenderHandleStatusChip(): (status: ShellHandle['status']) => string {
  const { renderHandleStatusChip } =
    require('../../status/chip.js') as typeof import('../../status/chip.js');
  return renderHandleStatusChip;
}

async function loadDecideAttach(): Promise<
  (shell: ShellRegistryEntry, deps: {
    getVwLabel: (id: string) => string | null;
    resolveVwIdByLabel: (label: string) => number | null;
  }) => AttachOutcome
> {
  const { decideAttach } = await import('../../shell-runner/attach-routing.js');
  return decideAttach;
}
