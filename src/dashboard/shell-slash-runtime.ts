export interface DashboardShellSlashListEntry {
  idTail: string;
  chip: string;
  mode: string;
  label: string | null;
}

export interface DashboardShellAmbiguousEntry {
  id: string;
}

export interface DashboardShellSlashRuntimeDeps {
  accent: (text: string) => string;
  muted: (text: string) => string;
  bold: (text: string) => string;
  warning: (text: string) => string;
  error: (text: string) => string;
}

export interface DashboardShellSlashRuntime {
  helpLines(): string[];
  emptyListLine(showSettled: boolean): string;
  listHeaderLine(count: number, showSettled: boolean): string;
  listEntryLine(entry: DashboardShellSlashListEntry): string;
  killUsageLine(): string;
  attachUsageLine(): string;
  noHandleMatchesLine(needle: string): string;
  ambiguousHeaderLine(needle: string): string;
  ambiguousEntryLine(entry: DashboardShellAmbiguousEntry): string;
  killedLine(id: string): string;
  killFailedLine(message: string): string;
  attachedLine(windowId: number, label: string, mode: string): string;
  bgAttachWarningLine(status: string): string;
  bgAttachHintLine(): string;
  noWindowAttachWarningLine(reason: string): string;
  noWindowAttachHintLine(): string;
  genericAttachWarningLine(reason: string): string;
  unknownSubcommandLine(sub: string): string;
}

export function createDashboardShellSlashRuntime(
  deps: DashboardShellSlashRuntimeDeps,
): DashboardShellSlashRuntime {
  return {
    helpLines: () => [
      '',
      deps.accent('\u276f 🐚 /shell'),
      deps.muted('Usage:'),
      deps.muted('  /shell list [all]         List handles (default hides settled 30s+; "all" shows everything).'),
      deps.muted('  /shell kill <id>          Kill a handle (prefix match on id OK).'),
      deps.muted('  /shell attach <id>        Focus the runner VW hosting a vw/modal-mode handle.'),
      deps.muted(''),
      deps.muted('  Handles are created by RunShell — see /term for legacy session mgmt.'),
    ],
    emptyListLine: (showSettled) => deps.muted(
      showSettled
        ? '  (no shell-runner handles)'
        : '  (no live shell-runner handles — try /shell list all)',
    ),
    listHeaderLine: (count, showSettled) => {
      const suffix = showSettled ? ' (incl. settled)' : '';
      return deps.bold(`  🐚 shell — ${count} handle${count > 1 ? 's' : ''}${suffix}`);
    },
    listEntryLine: (entry) => {
      const labelPart = entry.label ? ` label=${entry.label}` : '';
      return `  ${entry.chip}  ${entry.idTail}  mode=${entry.mode}${labelPart}`;
    },
    killUsageLine: () => deps.warning('  /shell kill <id>  — handle id required'),
    attachUsageLine: () => deps.warning('  /shell attach <id>  — handle id required'),
    noHandleMatchesLine: (needle) => deps.warning(`  no handle matches "${needle}"`),
    ambiguousHeaderLine: (needle) => deps.warning(`  "${needle}" is ambiguous:`),
    ambiguousEntryLine: (entry) => deps.muted(`    ${entry.id}`),
    killedLine: (id) => deps.muted(`  killed ${id}`),
    killFailedLine: (message) => deps.error(`  kill failed: ${message}`),
    attachedLine: (windowId, label, mode) => (
      deps.muted(`  attached — VW ${windowId} (${label}, mode=${mode})`)
    ),
    bgAttachWarningLine: (status) => (
      deps.warning(`  bg-mode handle has no attachable surface (${status}).`)
    ),
    bgAttachHintLine: () => (
      deps.muted('  Output captured by file engine — re-run with RunShell(mode:"vw") for a live pane.')
    ),
    noWindowAttachWarningLine: (reason) => deps.warning(`  ${reason}`),
    noWindowAttachHintLine: () => deps.muted('  Re-run the command to respawn the pane.'),
    genericAttachWarningLine: (reason) => deps.warning(`  ${reason}`),
    unknownSubcommandLine: (sub) => deps.warning(`  unknown subcommand "${sub}" — try /shell help`),
  };
}
