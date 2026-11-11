// Pure shell timing used by the Next TUI without loading the classic abort modal.
// Source: OP #96145 sets the confirmation boundary for a long Bash/RunShell execution to about five seconds.
export const LONG_SHELL_ESC_CONFIRMATION_MS = 5_000;

export function monotonicNowMs(): number {
  // Node process.hrtime.bigint() shares the host monotonic clock across the REPL and TUI processes.
  return Number(process.hrtime.bigint() / 1_000_000n);
}

export function requiresLongShellEscConfirmation(toolName: string, elapsedMs: number): boolean {
  return (toolName === 'Bash' || toolName === 'RunShell')
    && Number.isFinite(elapsedMs)
    && elapsedMs >= LONG_SHELL_ESC_CONFIRMATION_MS;
}
