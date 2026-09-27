import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { handleMcpRequest } from './server.js';
import { buildCliAgentTools } from '../cli/agent-cli.js';
import { getUserConfig } from '../user-config.js';
import { debug } from '../debug/log.js';
import { globalAgentRegistry } from '../agent/registry.js';
import { _resetToolRuntimeRegistryForTest } from '../tool-runtime/registry.js';
import { agentRuntime } from '../tool-runtime/agent-runtime.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import { buildAgentTool } from '../skills/tools/agent.js';
import * as llm from '../llm.js';

afterEach(() => {
  _resetToolRuntimeRegistryForTest();
});
type SpawnedTask = ReturnType<typeof globalAgentRegistry.spawn>['task'];

describe('MCP Agent spawn and retrieval', () => {
  test('lists Agent, spawns with CLI child tools in background, and retrieves final text', async () => {
    const expectedNames = buildCliAgentTools(getUserConfig(), undefined, process.cwd()).specs.map(s => s.name).sort();
    const observations: Array<{ category: string; event: string; data?: unknown }> = [];
    const off = debug.registerSink({ name: 'mcp-agent-test', emit: r => observations.push(r) });
    let modelToolNames: string[] = [];
    const model = spyOn(llm, 'streamLLMWithTools').mockImplementation(async (_messages, callbacks, options) => {
      modelToolNames = options?.tools?.map(t => t.name).sort() ?? [];
      callbacks.onText('child final text', 'child final text');
      return 'child final text';
    });
    try {
      const ctx = {};
      await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex' } } }, ctx);
      const listed = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx);
      const names = (listed.result as { tools: Array<{ name: string }> }).tools.map(t => t.name);
      expect(names).toContain('Agent');
      expect(names).toContain('AgentOutput');
      expect(names).not.toContain('Bash');
      expect(names).toContain('AgentList');
      expect(names).toContain('AgentStop');
      const agentTool = (listed.result as { tools: Array<{ name: string; description: string }> }).tools.find(t => t.name === 'Agent')!;
      expect(agentTool.description).toContain('AgentOutput(taskId, block: true)');
      expect(agentTool.description).toContain('run_in_background defaults to true');

      const launched = await handleMcpRequest({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'agent', arguments: { description: 'MCP worker', prompt: 'Answer this' } },
      }, ctx);
      expect(launched.error).toBeUndefined();
      const handle = (launched.result as { structuredContent: { taskId: string; background: boolean } }).structuredContent;
      expect(handle.taskId).toMatch(/^[0-9a-f-]{36}$/);
      expect(handle.background).toBe(true);
      const child = globalAgentRegistry.get(handle.taskId);
      expect(child?.cwd).toBe(process.cwd());
      expect(child?.state === 'pending' || child?.state === 'running' || child?.state === 'done').toBe(true);
      expect(observations).toContainEqual(expect.objectContaining({
        category: 'mcp.agent', event: 'spawned',
        data: expect.objectContaining({ taskId: handle.taskId, client: 'codex', background: true }),
      }));

      const collected = await handleMcpRequest({
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'AgentOutput', arguments: { taskId: handle.taskId, block: true } },
      }, ctx);
      expect(collected.error).toBeUndefined();
      expect((collected.result as { structuredContent: { text: string; retrievalStatus: string } }).structuredContent)
        .toMatchObject({ text: 'child final text', retrievalStatus: 'success' });
      const dispatched = observations.find(r => r.category === 'agent.spawn' && r.event === 'dispatch');
      expect(((dispatched?.data as { tools?: string[] } | undefined)?.tools ?? []).sort())
        .toEqual(expectedNames.filter(n => n !== 'Agent'));
      expect(modelToolNames).toEqual(expectedNames.filter(n => ['Bash', 'Read', 'Edit', 'Grep', 'WebFetch'].includes(n)));
      expect(modelToolNames.length).toBeGreaterThan(0);
    } finally {
      model.mockRestore();
      off();
    }
  });

  test('a supplied cwd is pinned to the spawned child and its CLI tool catalog', async () => {
    const cwd = '/tmp';
    let childCwd: string | undefined;
    let childNames: string[] = [];
    const spawn = spyOn(globalAgentRegistry, 'spawn').mockImplementation(opts => {
      childCwd = opts.cwd;
      childNames = opts.tools?.map(s => s.name).sort() ?? [];
      return {
        task: { id: 'cwd-agent-id', state: 'pending' } as SpawnedTask,
        events: (async function* () { yield { type: 'done' as const, text: 'done' }; })(),
      };
    });
    try {
      const listed = await handleMcpRequest({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
      const agentSchema = (listed.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> })
        .tools.find(t => t.name === 'Agent')?.inputSchema;
      const clientArgs = { description: 'Cwd worker', prompt: 'Respond', cwd };
      expect(agentSchema?.properties).toHaveProperty('cwd');
      for (const surface of ['skill', 'tui'] as const) {
        const hostList = await handleMcpRequest({ jsonrpc: '2.0', id: 8, method: 'tools/list' }, { surface });
        const hostSchema = (hostList.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> })
          .tools.find(t => t.name === 'Agent')?.inputSchema;
        expect(hostSchema).toBeDefined();
        expect(hostSchema?.properties).not.toHaveProperty('cwd');
      }
      const result = await handleMcpRequest({
        jsonrpc: '2.0', id: 6, method: 'tools/call',
        params: { name: 'Agent', arguments: clientArgs },
      });
      expect(result.error).toBeUndefined();
      expect(childCwd).toBe(cwd);
      expect(clientArgs.cwd).toBe(cwd);
      expect(childNames).toEqual(buildCliAgentTools(getUserConfig(), undefined, cwd).specs.map(s => s.name).filter(n => n !== 'Agent').sort());
    } finally {
      spawn.mockRestore();
    }
  });

  test('Agent runtime forwards the host cwd and child catalog through ToolRuntimeContext', async () => {
    const cwd = '/tmp';
    const catalog = buildCliAgentTools(getUserConfig(), undefined, cwd);
    const runtimeContext: ToolRuntimeContext = {
      surface: 'mcp', agentCwd: cwd, agentHostTools: catalog.specs,
      agentDispatchTool: catalog.dispatch,
      buildChildToolCatalog: childCwd => buildCliAgentTools(getUserConfig(), undefined, childCwd),
    };
    const spawn = spyOn(globalAgentRegistry, 'spawn').mockImplementation(opts => ({
      task: { id: 'runtime-cwd-id', state: 'pending' } as SpawnedTask,
      events: (async function* () { yield { type: 'done' as const, text: 'done' }; })(),
    }));
    try {
      expect(buildAgentTool().parameters.properties).not.toHaveProperty('cwd');
      const result = await agentRuntime.run({ description: 'Runtime worker', prompt: 'Respond', run_in_background: true }, runtimeContext);
      expect('taskId' in result && result.taskId).toBe('runtime-cwd-id');
      expect(spawn.mock.calls[0]?.[0].cwd).toBe(cwd);
      expect(spawn.mock.calls[0]?.[0].tools?.map(s => s.name).sort())
        .toEqual(catalog.specs.map(s => s.name).filter(n => n !== 'Agent').sort());
      expect(typeof spawn.mock.calls[0]?.[0].dispatchTool).toBe('function');
    } finally {
      spawn.mockRestore();
    }
  });

  test('explicit run_in_background:false remains synchronous', async () => {
    const task = { id: 'sync-agent-id', state: 'pending' as 'pending' | 'done', controller: new AbortController() };
    const spawn = spyOn(globalAgentRegistry, 'spawn').mockImplementation(() => ({
      task: task as SpawnedTask,
      events: (async function* () {
        task.state = 'done';
        yield { type: 'done' as const, text: 'synchronous text' };
      })(),
    }));
    try {
      const result = await handleMcpRequest({
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'Agent', arguments: {
          description: 'Synchronous worker', prompt: 'Respond', run_in_background: false,
        } },
      });
      expect(result.error).toBeUndefined();
      expect((result.result as { structuredContent: { output: string; background?: boolean } }).structuredContent)
        .toMatchObject({ output: 'synchronous text' });
      expect((result.result as { structuredContent: { background?: boolean } }).structuredContent.background).toBeUndefined();
    } finally {
      spawn.mockRestore();
    }
  });
});
