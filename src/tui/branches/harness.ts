import { runLocalHarnessCommand } from '../../tui-client/local-harness-command.js';

export type NextTuiHarnessCommand = { readonly command: 'ask'; readonly goal: string }
  | { readonly command: 'runs'; readonly goal: '' };

export type NextTuiHarnessRunner = typeof runLocalHarnessCommand;

export const NEXT_TUI_HARNESS_USAGE = '사용법: /harness ask <목표> · /harness runs';

/** Parse only the two supported Next TUI harness commands. */
export function parseNextTuiHarnessCommand(input: string): NextTuiHarnessCommand | null {
  const rest = input.trim().replace(/^\/harness(?:\s+|$)/u, '').trim();
  if (rest === 'runs') return { command: 'runs', goal: '' };
  if (!rest.startsWith('ask ')) return null;
  const goal = rest.slice(4).trim();
  if (!goal || goal === '--dry-run') return null;
  return { command: 'ask', goal };
}

export function nextTuiHarnessStartLine(request: NextTuiHarnessCommand): string {
  return `하니스 ${request.command === 'ask' ? '시작' : '진행 조회'}: ${request.goal || 'runs'}`;
}

/** The registry-loaded branch reuses the established local harness CLI adapter. */
export function runNextTuiHarnessBranchRoute(
  request: NextTuiHarnessCommand,
  signal: AbortSignal,
  onLine: (line: string) => void,
  run: NextTuiHarnessRunner = runLocalHarnessCommand,
): Promise<void> {
  return run(request.command, request.goal, signal, onLine);
}
