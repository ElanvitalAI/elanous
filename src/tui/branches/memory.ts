import { buildMemorySlashCommand } from '../../context-display/memory-slash.js';

const memoryCommand = buildMemorySlashCommand();

/** Keep the classic dashboard's `/memory` and `/mem` list/show/reload behavior. */
export function runNextTuiMemoryBranchRoute(input: string): string {
  const args = input.trim().replace(/^\/(?:memory|mem)(?:\s+|$)/u, '').trim().split(/\s+/u).filter(Boolean);
  return memoryCommand.render({ sub: args[0]?.toLowerCase(), arg: args[1] });
}
