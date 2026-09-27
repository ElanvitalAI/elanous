import { afterEach, describe, expect, test } from 'bun:test';
import { handleMcpRequest } from './server.js';
import { debug } from '../debug/log.js';
import {
  _resetToolRuntimeRegistryForTest,
  listToolRuntimes,
  registerToolRuntime,
} from '../tool-runtime/registry.js';
import {
  elanousAutopilotLaunchRuntime,
  setElanousAutopilotLaunchRuntimeDispatcherForTest,
  type ElanousAutopilotLaunchArgs,
  type ElanousAutopilotLaunchResult,
} from '../tool-runtime/elanous-autopilot-launch-runtime.js';
import {
  _setSelfImplementCliCommandForTesting,
  _setSelfImplementGoalAuthorForTesting,
} from '../self-implement/self-implement-runtime.js';
import type { ToolRuntime } from '../tool-runtime/types.js';

afterEach(() => {
  _resetToolRuntimeRegistryForTest();
  setElanousAutopilotLaunchRuntimeDispatcherForTest();
  _setSelfImplementCliCommandForTesting(null);
  _setSelfImplementGoalAuthorForTesting(null);
});

describe('MCP native runtime exposure', () => {
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
      'elanous_autopilot_launch',
    ]));
    expect(names).toContain('aside.repl');
    expect(names).toContain('SelfImplement');
    expect(names).toContain('elanous_autopilot_launch');
    expect(names.filter(name => name.startsWith('elanous_asana_'))).toEqual([
      'elanous_asana_workspaces', 'elanous_asana_list_tasks', 'elanous_asana_create_task',
      'elanous_asana_comment', 'elanous_asana_complete',
    ]);
    expect(names).toEqual(expect.arrayContaining([
      'self_recall',
      'logs_query',
      'ops_status',
      'memory_recall',
    ]));
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

  test('tools/call invokes the harness dispatcher and returns its run identifier without fabrication', async () => {
    const runId = 'run-produced-by-harness-seam';
    const received: ElanousAutopilotLaunchArgs[] = [];
    const dispatcherResult: ElanousAutopilotLaunchResult = {
      output: runId,
      runId,
      ok: true,
      termination: { kind: 'success' } as ElanousAutopilotLaunchResult['termination'],
      iterations: 1,
      text: '',
      envelopeCount: 0,
      durationMs: 1,
      diagnostics: [],
    };
    setElanousAutopilotLaunchRuntimeDispatcherForTest(async args => {
      received.push(args);
      return dispatcherResult;
    });
    registerToolRuntime(elanousAutopilotLaunchRuntime);

    const response = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'elanous_autopilot_launch',
        arguments: { mission: 'implement this request', backend: 'codex', maxIterations: 2 },
      },
    });
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { runId: string };
    };

    expect(received).toEqual([{
      mission: 'implement this request', backend: 'codex', maxIterations: 2,
    }]);
    expect(result.content).toEqual([{ type: 'text', text: runId }]);
    expect(result.structuredContent.runId).toBe(runId);
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
