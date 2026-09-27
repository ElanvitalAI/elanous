import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleMcpRequest, type McpServerContext } from '../mcp/server.js';
import { isExternalProvider } from '../task-orchestrator/external-policy.js';
import { setElanousTaskSubmitDepsForTest, submitElanousTask } from './elanous-task-submit-runtime.js';

type Sent = { url: string; auth?: string; body: Record<string, unknown> };

function fakeDaemon(status: number, reply: Record<string, unknown>) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    sent.push({ url, auth: headers.authorization, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { sent, deps: { baseUrl: () => 'http://127.0.0.1:31499', token: () => 'tok', fetchImpl } };
}

afterEach(() => setElanousTaskSubmitDepsForTest(undefined));

describe('elanous_task_submit', () => {
  test('posts an agent-plugin external task with the client name in the ref', async () => {
    const { sent, deps } = fakeDaemon(201, { taskId: 'task:aaa', deduplicated: false });
    const out = await submitElanousTask(
      { title: 'Refresh the release notes', description: 'see docs/x.md', priority: 'high', ref: 'PR-12', url: 'https://example.test/12' },
      { mcpClient: 'claude-code' }, deps,
    );
    expect(out).toMatchObject({ taskId: 'task:aaa', deduplicated: false });
    expect(out.output).toContain('waits for the owner');
    expect(sent).toEqual([{
      url: 'http://127.0.0.1:31499/v1/tasks',
      auth: 'Bearer tok',
      body: {
        title: 'Refresh the release notes', description: 'see docs/x.md', priority: 'high',
        external: { provider: 'agent-plugin', ref: 'claude-code:PR-12', url: 'https://example.test/12' },
      },
    }]);
    expect(isExternalProvider('agent-plugin')).toBe(true);
  });

  test('without a ref the same title/description maps to the same stable ref', async () => {
    const { sent, deps } = fakeDaemon(200, { taskId: 'task:aaa', deduplicated: true });
    await submitElanousTask({ title: 'T', description: 'D' }, {}, deps);
    await submitElanousTask({ title: 'T', description: 'D' }, {}, deps);
    const refs = sent.map(s => (s.body.external as { ref: string }).ref);
    expect(refs[0]).toMatch(/^agent:[0-9a-f]{12}$/);
    expect(refs[1]).toBe(refs[0]);
  });

  test('refuses bad arguments and a missing daemon without sending anything', async () => {
    const { sent, deps } = fakeDaemon(201, { taskId: 'x' });
    expect((await submitElanousTask({}, {}, deps)).error).toBe('invalid-args');
    expect((await submitElanousTask({ title: 't', priority: 'urgent' }, {}, deps)).error).toBe('invalid-args');
    expect((await submitElanousTask({ title: 't' }, {}, { ...deps, baseUrl: () => null })).error).toBe('no-daemon');
    expect(sent).toHaveLength(0);
  });

  test('a daemon refusal is reported, not thrown', async () => {
    const { deps } = fakeDaemon(401, { error: 'unauthorized' });
    const out = await submitElanousTask({ title: 't' }, {}, deps);
    expect(out.error).toBe('refused');
    expect(out.output).toContain('401');
  });
});

describe('MCP stdio wiring', () => {
  test('tools/list shows the tool and tools/call carries initialize clientInfo.name into the ref', async () => {
    // The CLI has this module loaded before any MCP request; a bare test must load it
    // first or the registry's synchronous require of it throws (same on main).
    await import('../domains/core-tools.js');
    const { sent, deps } = fakeDaemon(201, { taskId: 'task:bbb', deduplicated: false });
    setElanousTaskSubmitDepsForTest(deps);
    const ctx: McpServerContext = { origin: 'mcp-stdio' };
    await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'codex-mcp-client', version: '1' } } }, ctx);
    const list = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map(t => t.name)).toContain('elanous_task_submit');
    const call = await handleMcpRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'elanous_task_submit', arguments: { title: 'From codex', ref: 'ELA-9' } } }, ctx);
    expect(JSON.stringify(call)).toContain('task:bbb');
    expect((sent[0]!.body.external as { ref: string }).ref).toBe('codex-mcp-client:ELA-9');
  });
});

describe('plugin bundle', () => {
  const root = join(import.meta.dir, '..', '..', 'integrations', 'elanous-agent');
  test('both manifests name the same plugin and the MCP server runs elanous mcp serve', () => {
    const claude = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    const codex = JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(codex.name).toBe(claude.name);
    expect(codex.version).toBe(claude.version);
    expect(codex.mcpServers).toBe('./.mcp.json');
    expect(mcp.mcpServers.elanous).toEqual({ command: 'elanous', args: ['mcp', 'serve'] });
    expect(readFileSync(join(root, 'skills', 'elanous-handoff', 'SKILL.md'), 'utf8')).toContain('elanous_task_submit');
  });
});
