import { describe, expect, test } from 'bun:test';
import type { TokenScope } from '../../auth/scope.js';
import { findNativeTool } from '../../native-tool-catalog.js';
import { filterToolsForScope, isToolAllowedForScope, MCP_PUBLIC_TOOLS } from './mcp-public-allowlist.js';
import { handleMcpRequest } from '../../mcp/server.js';
import { registerAllDefaultToolRuntimes } from '../../tool-runtime/index.js';

// MCP 가 실제로 내는 이름(표시명 · id 가 섞여 있다)
const PUBLIC_MCP_NAMES = ['elanous_task_submit', 'TaskList', 'TaskGet', 'self_recall', 'memory_recall', 'elanous_obsidian_search', 'AgentList', 'AgentOutput'];

const tools = [
  { name: 'Bash', description: 'shell' },
  ...PUBLIC_MCP_NAMES.map((name) => ({ name, description: `public ${name}` })),
  { name: 'PtyControl', description: 'pty input' },
  { name: 'AgentStop', description: 'cancel agent' },
];

describe('mcp-public tool allowlist', () => {
  test('여덟 id 가 전부 카탈로그에 있다(없는 이름을 적으면 여기서 빨강)', () => {
    expect(MCP_PUBLIC_TOOLS.size).toBe(8);
    for (const id of MCP_PUBLIC_TOOLS) expect(findNativeTool(id)?.id).toBe(id);
  });

  test('표시명·id·별칭 어느 쪽으로 와도 같은 판정 · 목록 밖은 거부', () => {
    expect(filterToolsForScope(tools, 'mcp-public').map((t) => t.name)).toEqual(PUBLIC_MCP_NAMES);
    for (const name of [...PUBLIC_MCP_NAMES, 'task_list', 'agent_output']) expect(isToolAllowedForScope(name, 'mcp-public')).toBe(true);
    for (const name of ['Bash', 'PtyControl', 'pty_control', 'AgentStop', 'monad_obsidian_search', 'elanous_task_status', '']) {
      expect(isToolAllowedForScope(name, 'mcp-public')).toBe(false);
    }
  });

  test.each(['admin', 'session', 'read-only'] as const)('%s scope keeps all tools unchanged', (scope: TokenScope) => {
    expect(filterToolsForScope(tools, scope)).toBe(tools);
    expect(isToolAllowedForScope('Bash', scope)).toBe(true);
  });

  test('실제 MCP tools/list 를 공개 범위로 거르면 정확히 여덟 중 등록된 것만 — 기본 런타임에서 최소 다섯', async () => {
    registerAllDefaultToolRuntimes();
    const r = (await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' } as never, { surface: 'mcp', tokenScope: 'mcp-public' } as never)) as { result: { tools: { name: string }[] } };
    const names = r.result.tools.map((t) => t.name);
    for (const n of names) expect(MCP_PUBLIC_TOOLS.has(findNativeTool(n)!.id)).toBe(true);
    expect(names).toEqual(expect.arrayContaining(['TaskList', 'TaskGet', 'elanous_obsidian_search', 'AgentList', 'AgentOutput']));
  });
});
