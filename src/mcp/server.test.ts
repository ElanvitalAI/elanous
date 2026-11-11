import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMcpRequest } from './server.js';
import { MsgStore, openMsgStoreReadOnly } from '../msg/msg-store.js';
import { debug } from '../debug/log.js';
import {
  _resetToolRuntimeRegistryForTest,
  listToolRuntimes,
  registerToolRuntime,
} from '../tool-runtime/registry.js';
import { elanousAutopilotLaunchRuntime } from '../tool-runtime/elanous-autopilot-launch-runtime.js';
import {
  _setSelfImplementCliCommandForTesting,
  _setSelfImplementGoalAuthorForTesting,
} from '../self-implement/self-implement-runtime.js';
import type { ToolRuntime } from '../tool-runtime/types.js';

afterEach(() => {
  _resetToolRuntimeRegistryForTest();
  _setSelfImplementCliCommandForTesting(null);
  _setSelfImplementGoalAuthorForTesting(null);
});

describe('MCP native runtime exposure', () => {
  test('MsgInbox and MsgAck are seat-bound on MCP and ack advances only that seat unread cursor', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mcp-msg-inbox-'));
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = stateDir;
    try {
      const store = new MsgStore(join(stateDir, 'msg', 'messages.db'));
      const tcMessage = store.post({ from: 'OP', to: 'TC', body: 'for TC' });
      store.post({ from: 'OP', to: 'MK', body: 'private for MK' });
      store.close();

      const anonymous = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const anonymousNames = (anonymous.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name);
      expect(anonymousNames).not.toContain('MsgInbox');
      expect(anonymousNames).not.toContain('MsgAck');
      const denied = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'MsgInbox', arguments: { to: 'MK' } } });
      expect(denied.error?.code).toBe(-32601);

      const ctx = { authenticatedSeat: 'TC' };
      const listed = await handleMcpRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, ctx);
      const tools = (listed.result as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> }).tools;
      const inbox = tools.find(tool => tool.name === 'MsgInbox');
      const ack = tools.find(tool => tool.name === 'MsgAck');
      expect(inbox).toBeDefined();
      expect(ack?.inputSchema.properties).toEqual({ id: expect.any(Object) });
      const result = await handleMcpRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'MsgInbox', arguments: {} } }, ctx);
      const messages = (result.result as { structuredContent: { messages: Array<{ id: number; body: string }> } }).structuredContent.messages;
      expect(messages).toEqual([expect.objectContaining({ id: tcMessage.id, body: 'for TC' })]);
      const acked = await handleMcpRequest({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'MsgAck', arguments: { id: tcMessage.id, to: 'MK' } } }, ctx);
      expect(acked.error?.code).toBe(-32000); // Source: MCP server maps thrown runtime validation errors to JSON-RPC -32000.
      const acknowledged = await handleMcpRequest({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'MsgAck', arguments: { id: tcMessage.id } } }, ctx);
      expect(acknowledged.error).toBeUndefined();
      const afterAck = await handleMcpRequest({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'MsgInbox', arguments: {} } }, ctx);
      expect((afterAck.result as { structuredContent: { count: number } }).structuredContent.count).toBe(0);
      const untouched = openMsgStoreReadOnly(join(stateDir, 'msg', 'messages.db'));
      expect(untouched.list('MK').map(message => message.body)).toEqual(['private for MK']);
      untouched.close();
    } finally {
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('Aside client name matching is case-insensitive for same-run return calls', async () => {
    const runId = 'aside-roundtrip-run';
    const received: Array<{ mcpClient?: string; runId?: string }> = [];
    registerToolRuntime({
      id: 'aside.roundtrip',
      spec: {
        name: 'aside.roundtrip',
        description: 'Mock Aside roundtrip receiver',
        parameters: { type: 'object', properties: {} },
      },
      surfaces: ['mcp'],
      run: async (_args, ctx) => {
        received.push({ mcpClient: ctx.mcpClient, runId: ctx.runId });
        return { output: 'result returned to Aside' };
      },
    });

    const ctx: Parameters<typeof handleMcpRequest>[1] = {};
    await handleMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'Aside' } },
    }, ctx);
    const response = await handleMcpRequest({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'aside.roundtrip',
        arguments: {},
        _meta: { elanousRunId: runId },
      },
    }, ctx);

    expect(response.error).toBeUndefined();
    expect(received).toEqual([{ mcpClient: 'Aside', runId }]);
  });

  test('tools/list retains external runtimes while lazily exposing first-party harness runtime', async () => {
    const asideRepl: ToolRuntime = {
      id: 'aside.repl',
      spec: {
        name: 'aside.repl',
        description: 'External Aside REPL',
        parameters: { type: 'object', properties: {} },
      },
      surfaces: ['mcp'],
      run: async () => ({ output: 'aside result' }),
    };
    registerToolRuntime(asideRepl);

    const response = await handleMcpRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });
    const names = (response.result as { tools: Array<{ name: string }> }).tools
      .map(tool => tool.name);

    const mcpRuntimeIds = listToolRuntimes('mcp').map(runtime => runtime.id);
    expect(mcpRuntimeIds).toContain('aside.repl');
    expect(mcpRuntimeIds).toContain('self_implement');
    expect(mcpRuntimeIds).toContain('elanous_ux_sim_devices');
    expect(mcpRuntimeIds).toEqual(expect.arrayContaining([
      'self_recall',
      'logs_query',
      'ops_status',
      'memory_recall',
    ]));
    expect(mcpRuntimeIds.length).toBeGreaterThanOrEqual(37);
    expect(mcpRuntimeIds).toEqual(expect.arrayContaining([
      'elanous_skills_list',
      'skill_exec',
    ]));
    expect(names).toContain('aside.repl');
    expect(names).toContain('SelfImplement');
    expect(names).toContain('elanous_ux_sim_devices');
    expect(names).not.toContain('elanous_autopilot_launch');
    expect(names.filter(name => name.startsWith('elanous_asana_'))).toEqual([
      'elanous_asana_workspaces', 'elanous_asana_list_tasks', 'elanous_asana_create_task',
      'elanous_asana_comment', 'elanous_asana_complete',
    ]);
    expect(names).toContain('elanous_linear_secretary');
    expect(names).toEqual(expect.arrayContaining([
      'self_recall',
      'logs_query',
      'ops_status',
      'memory_recall',
    ]));
  });

  test('tools/call dispatches the Nexus catalog runtime exposed by default', async () => {
    const listResponse = await handleMcpRequest({
      jsonrpc: '2.0', id: 21, method: 'tools/list',
    });
    const names = (listResponse.result as { tools: Array<{ name: string }> }).tools
      .map(tool => tool.name);
    expect(names).toContain('elanous_ux_sim_devices');

    const response = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: 'elanous_ux_sim_devices', arguments: {} },
    });

    expect(response.error).toBeUndefined();
    expect((response.result as { structuredContent?: { output?: string } }).structuredContent?.output)
      .toContain('Mock/test catalog v2:');
  });

  test('tools/call dispatches a listed self-cognition runtime through the MCP path', async () => {
    const response = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'memory_recall', arguments: {} },
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(expect.objectContaining({
      content: expect.any(Array),
      structuredContent: expect.any(Object),
    }));
  });

  test('tools/list logs separate native and proxy counts for the response', async () => {
    const records: Array<{ category: string; event: string; data?: unknown }> = [];
    const off = debug.registerSink({
      name: 'mcp-tools-list-count-test',
      emit: record => records.push({ category: record.category, event: record.event, data: record.data }),
    });
    try {
      registerToolRuntime({
        id: 'remote.search',
        spec: {
          name: 'remote.search',
          description: 'Remote MCP search proxy',
          parameters: { type: 'object', properties: {} },
        },
        surfaces: ['mcp'],
        run: async () => ({ output: 'remote result' }),
      });

      const response = await handleMcpRequest({
        jsonrpc: '2.0', id: 11, method: 'tools/list',
      }, { origin: 'mcp-http' });
      const tools = (response.result as { tools: Array<{ name: string }> }).tools;
      const log = records.find(record => record.category === 'mcp.tools-list' && record.event === 'responded');

      expect(tools.map(tool => tool.name)).toContain('remote.search');
      expect(log?.data).toMatchObject({
        surface: 'mcp',
        origin: 'mcp-http',
        totalToolCount: tools.length,
        nativeToolCount: tools.length - 1,
        proxyToolCount: 1,
      });
    } finally {
      off();
    }
  });

  test('tools/call dispatches the listed self-implement harness', async () => {
    const received: string[] = [];
    _setSelfImplementGoalAuthorForTesting(async () => ({ path: 'test-goal.md' }));
    _setSelfImplementCliCommandForTesting(async feature => {
      received.push(feature);
      return { ok: true, kind: 'observed' } as never;
    });

    const listResponse = await handleMcpRequest({
      jsonrpc: '2.0', id: 2, method: 'tools/list',
    });
    const listedHarness = (listResponse.result as { tools: Array<{ name: string }> }).tools
      .find(tool => tool.name === 'SelfImplement');
    expect(listedHarness?.name).toBe('SelfImplement');

    const response = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: listedHarness!.name, arguments: { feature: 'implement this request' } },
    });

    expect(response.error).toBeUndefined();
    expect(received).toEqual(['implement this request']);
  });

  test('retired launch is unavailable even when a runtime is registered manually', async () => {
    let invoked = false;
    registerToolRuntime({ ...elanousAutopilotLaunchRuntime, run: async () => {
      invoked = true;
      return { output: 'unexpected' };
    } });
    const response = await handleMcpRequest({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'elanous_autopilot_launch', arguments: { mission: 'implement this request' } },
    });
    expect(response.error?.code).toBe(-32601); // Source: JSON-RPC method-not-found contract in src/mcp/server.ts.
    expect(invoked).toBe(false);
  });

  test('rejects non-MCP runtimes by name without invoking them', async () => {
    let calls = 0;
    registerToolRuntime({
      id: 'Bash',
      spec: {
        name: 'Bash',
        description: 'Non-MCP command runtime',
        parameters: { type: 'object', properties: {} },
      },
      surfaces: ['tui'],
      run: async () => {
        calls += 1;
        return { output: 'must not run' };
      },
    });

    const response = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'Bash', arguments: {} },
    });

    expect(response.error?.code).toBe(-32601);
    expect(calls).toBe(0);
  });

  test('unknown tools retain JSON-RPC method-not-found response', async () => {
    const response = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'unknown.mcp.tool', arguments: {} },
    });

    expect(response.error?.code).toBe(-32601);
  });
});
