import type { TerminalSession } from '../terminal/session-registry.js';

export type DashboardTerminalPopupAgentBrand = 'claude-code' | 'codex' | 'gemini' | 'grok';

export type DashboardTerminalPopupRequest =
  | { kind: 'shell'; cwd: string; command?: string; env?: Record<string, string> }
  | { kind: 'coding-agent'; brand: DashboardTerminalPopupAgentBrand; cwd: string; extraArgs?: readonly string[]; env?: Record<string, string>; id?: string };

export interface DashboardTerminalPopupRuntimeDeps {
  onMissingCwd: () => void;
  openInteractiveTerminalPopup: (req: DashboardTerminalPopupRequest) => TerminalSession | null;
}

export interface DashboardTerminalPopupBuilder {
  cwd(cwd: string): DashboardTerminalPopupBuilder;
  command(command: string): DashboardTerminalPopupBuilder;
  env(env: Record<string, string>): DashboardTerminalPopupBuilder;
  id(id: string): DashboardTerminalPopupBuilder;
  args(extraArgs: readonly string[]): DashboardTerminalPopupBuilder;
  open(): TerminalSession | null;
}

export interface DashboardTerminalPopupRuntime {
  shell(): DashboardTerminalPopupBuilder;
  agent(brand: DashboardTerminalPopupAgentBrand): DashboardTerminalPopupBuilder;
  spawnGlobalTerminalModal(cwd: string): void;
}

export function createDashboardTerminalPopupRuntime(
  deps: DashboardTerminalPopupRuntimeDeps,
): DashboardTerminalPopupRuntime {
  const makeBuilder = (
    kind: 'shell' | DashboardTerminalPopupAgentBrand,
  ): DashboardTerminalPopupBuilder => {
    let cwd: string | null = null;
    let command: string | undefined;
    let env: Record<string, string> | undefined;
    let id: string | undefined;
    let args: readonly string[] | undefined;
    return {
      cwd(next) { cwd = next; return this; },
      command(next) { command = next; return this; },
      env(next) { env = next; return this; },
      id(next) { id = next; return this; },
      args(next) { args = next; return this; },
      open() {
        if (cwd === null) {
          deps.onMissingCwd();
          return null;
        }
        const req: DashboardTerminalPopupRequest = kind === 'shell'
          ? { kind: 'shell', cwd, command, env }
          : { kind: 'coding-agent', brand: kind, cwd, ...(args ? { extraArgs: args } : {}), ...(env ? { env } : {}), ...(id ? { id } : {}) };
        return deps.openInteractiveTerminalPopup(req);
      },
    };
  };

  return {
    shell: () => makeBuilder('shell'),
    agent: (brand) => makeBuilder(brand),
    spawnGlobalTerminalModal: (cwd) => {
      makeBuilder('shell').cwd(cwd).open();
    },
  };
}
