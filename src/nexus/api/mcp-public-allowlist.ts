import type { TokenScope } from '../../auth/scope.js';
import { findNativeTool } from '../../native-tool-catalog.js';

/** MCP tools exposed to tokens with the mcp-public scope — **catalog ids** (`src/native-tool-catalog.ts`).
 *  MCP 가 내는 이름은 표시명(`TaskList`)이거나 id(`self_recall`)라 제각각이다 ⇒ 이름을 id 로 해석해 대조한다.
 *  📏 2026-09-27: 첫 착지(#21207)가 표시명·옛 이름으로 적어 없는 이름 셋(`elanous_task_status`·`elanous_task_result`·
 *  `monad_obsidian_search`)을 담고 `TaskList`·`TaskGet` 을 빠뜨렸다 — 실제 목록에 5개만 보였다. */
export const MCP_PUBLIC_TOOLS = new Set([
  'elanous_task_submit',
  'task_list',
  'task_get',
  'self_recall',
  'memory_recall',
  'elanous_obsidian_search',
  'agent_list',
  'agent_output',
]);

function catalogId(name: string): string | undefined {
  return name ? findNativeTool(name)?.id : undefined;
}

export function isToolAllowedForScope(name: string, scope: TokenScope): boolean {
  if (scope !== 'mcp-public') return true;
  const id = catalogId(name);
  return id !== undefined && MCP_PUBLIC_TOOLS.has(id);
}

export function filterToolsForScope<T extends { name: string }>(tools: T[], scope: TokenScope): T[] {
  return scope === 'mcp-public'
    ? tools.filter((tool) => isToolAllowedForScope(tool.name, scope))
    : tools;
}
