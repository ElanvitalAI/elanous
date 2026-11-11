import { executeUsageSlash, type UsageSlashResult } from '../../skills/tools/usage-slash.js';
import type { UnifiedUsageDeps } from '../../budget/unified-usage.js';
import type { SignalsSlashContext } from '../slash/signals.js';

export interface NextTuiRemainingHost {
  addLines(...lines: string[]): void;
  width?: number;
}

type ExecuteRemaining = (
  request: { name: 'remaining'; args: string[]; width?: number },
  deps?: UnifiedUsageDeps,
) => Promise<UsageSlashResult | null>;

/** Render the shared unified usage report in Next TUI; calculations stay in the shared usage tool. */
export async function runNextTuiRemainingBranchRoute(
  input: string,
  host: NextTuiRemainingHost,
  execute: ExecuteRemaining = executeUsageSlash,
  deps?: UnifiedUsageDeps,
): Promise<void> {
  const match = /^\/remaining(?:\s+(.*))?$/u.exec(input.trim());
  if (!match) return;
  const result = await execute({
    name: 'remaining',
    args: match[1]?.trim() ? match[1].trim().split(/\s+/u) : [],
    ...(host.width === undefined ? {} : { width: host.width }),
  }, deps);
  if (!result?.ok) {
    host.addLines(result?.message ?? '남은 사용량을 읽을 수 없습니다.');
    return;
  }
  host.addLines(...(result.logLines ?? []));
}

/** Register the handler used by entry.ts so its route dispatch is testable without starting a PTY. */
export function handleNextTuiRemainingSlash(
  args: string[],
  context: SignalsSlashContext,
  execute: ExecuteRemaining = executeUsageSlash,
  deps?: UnifiedUsageDeps,
): Promise<void> {
  return runNextTuiRemainingBranchRoute(
    ['/remaining', ...args].join(' '),
    { addLines: (...lines) => context.chatLines.push(...lines), width: process.stdout.columns },
    execute,
    deps,
  );
}
