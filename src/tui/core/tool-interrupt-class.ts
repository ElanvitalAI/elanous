// ELN-INTERRUPT-CONDITIONAL — which running tools a «push now» may cut short.
// Contract (내부 문서 `ELN-STEER-AND-TOOL-WATCHDOG` §6): a new utterance may ask the main turn to stop only
// when every tool that is running is in the «interruptible» class — read-only and search tools, whose being
// abandoned loses nothing. Writes, shell, push, agents/missions and any unknown tool run to the end.
const INTERRUPTIBLE_TOOLS: ReadonlySet<string> = new Set([
  'read', 'read_file', 'grep', 'glob', 'listdir', 'list_dir', 'ls',
  'websearch', 'web_search', 'webfetch', 'web_fetch', 'memory_recall',
]);

/** Exact, case-insensitive match against the read/search class; anything else must finish. */
export function isInterruptibleTool(name: string): boolean {
  return INTERRUPTIBLE_TOOLS.has(name.trim().toLowerCase());
}

/** `interrupt` when no tool runs or every running tool is interruptible; otherwise `deferred` (finish first). */
export function pushNowToolDecision(activeToolNames: readonly string[]): 'interrupt' | 'deferred' {
  return activeToolNames.every(isInterruptibleTool) ? 'interrupt' : 'deferred';
}
