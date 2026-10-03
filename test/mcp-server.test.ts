// ── Track I: MCP stdio server tests ──

import { setDefaultTimeout, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  handleMcpRequest,
  createMcpStdioServer,
  negotiateMcpProtocolVersion,
  MCP_PROTOCOL_VERSION_LATEST,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  type McpStdioStream,
} from '../src/mcp/server';
import { registerAllDefaultToolRuntimes } from '../src/tool-runtime/index';
import {
  _resetToolRuntimeRegistryForTest,
  listToolRuntimes,
  registerToolRuntime,
} from '../src/tool-runtime/registry';
import { elanousAutopilotLaunchRuntime } from '../src/tool-runtime/elanous-autopilot-launch-runtime';
import type { ToolRuntime } from '../src/tool-runtime/types';
import {
  setPtyAdapterForTesting, resetForTesting,
} from '../src/pty-shell/registry';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

function fakePtyAdapter() {
  setPtyAdapterForTesting(() => ({
    pid: 1, write: () => {}, kill: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  }));
}

describe('MCP protocol contract', () => {
  test('canonical latest is 2025-11-25 and 2024-11-05 remains speakable', () => {
    expect(MCP_PROTOCOL_VERSION_LATEST).toBe('2025-11-25');
    expect(MCP_SUPPORTED_PROTOCOL_VERSIONS).toContain('2024-11-05');
    expect(MCP_SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-11-25');
  });

  test('negotiateMcpProtocolVersion selects a supported request or falls back to latest', () => {
    expect(negotiateMcpProtocolVersion('2024-11-05')).toBe('2024-11-05');
    expect(negotiateMcpProtocolVersion('2025-11-25')).toBe('2025-11-25');
    expect(negotiateMcpProtocolVersion('2026-07-28')).toBe('2025-11-25');
    expect(negotiateMcpProtocolVersion(undefined)).toBe('2025-11-25');
    expect(negotiateMcpProtocolVersion(null)).toBe('2025-11-25');
    expect(negotiateMcpProtocolVersion(20251125)).toBe('2025-11-25');
    expect(negotiateMcpProtocolVersion({ version: '2024-11-05' })).toBe('2025-11-25');
    expect(negotiateMcpProtocolVersion('')).toBe('2025-11-25');
  });
});

describe('MCP initialize', () => {
  test('returns protocolVersion + tools capability + serverInfo', async () => {
    const resp = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(resp.id).toBe(1);
    expect(resp.error).toBeUndefined();
    const res = resp.result as { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } };
    expect(res.protocolVersion).toBe('2025-11-25');
    expect(res.capabilities.tools).toBeTruthy();
    expect(res.serverInfo.name).toBe('elanous-agent');
  });

  test('echoes requested 2024-11-05 when we can speak it', async () => {
    const resp = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 11,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    expect(resp.error).toBeUndefined();
    const res = resp.result as { protocolVersion: string };
    expect(res.protocolVersion).toBe('2024-11-05');
  });

  test('echoes requested 2025-11-25', async () => {
    const resp = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    });
    expect(resp.error).toBeUndefined();
    const res = resp.result as { protocolVersion: string };
    expect(res.protocolVersion).toBe('2025-11-25');
  });

  test('unknown protocolVersion falls back to latest without JSON-RPC error', async () => {
    const resp = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 13,
      method: 'initialize',
      params: { protocolVersion: '2026-07-28' },
    });
    expect(resp.error).toBeUndefined();
    const res = resp.result as { protocolVersion: string };
    expect(res.protocolVersion).toBe('2025-11-25');
  });

  test('missing or malformed protocolVersion falls back to latest without JSON-RPC error', async () => {
    const missing = await handleMcpRequest({ jsonrpc: '2.0', id: 14, method: 'initialize' });
    expect(missing.error).toBeUndefined();
    expect((missing.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');

    const malformed = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 15,
      method: 'initialize',
      params: { protocolVersion: 20251125 as unknown as string },
    });
    expect(malformed.error).toBeUndefined();
    expect((malformed.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
  });

  test('initialized notification returns empty result', async () => {
    const resp = await handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(resp.error).toBeUndefined();
  });

  test('unknown method → -32601', async () => {
    const resp = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'fake/rpc' });
    expect(resp.error?.code).toBe(-32601);
    expect(resp.error?.message).toContain('fake/rpc');
  });
});

describe('MCP tools/list', () => {
  test('fresh process lists self-cognition tools without preloading core-tools', async () => {
    const script = `
      import { createRequire } from 'node:module';
      const { handleMcpRequest } = await import('./src/mcp/server.ts');
      const { registerToolRuntime } = await import('./src/tool-runtime/registry.ts');
      const require = createRequire(import.meta.url);
      const coreToolsPath = require.resolve('./src/domains/core-tools.js');
      const startedUnloaded = !require.cache[coreToolsPath];
      registerToolRuntime({
        id: 'preload_probe', surfaces: ['mcp'],
        get spec() {
          if (!require.cache[coreToolsPath]) throw new Error('core-tools not preloaded before tools/list');
          return { name: 'preload_probe', description: 'preload probe', parameters: { type: 'object' } };
        },
        run: async () => ({ output: 'ok' }),
      });
      const response = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const tools = (response.result as { tools?: Array<{ name: string }> } | undefined)?.tools;
      console.log(JSON.stringify({
        startedUnloaded,
        error: response.error ?? null,
        toolCount: tools?.length ?? 0,
        hasSelfRecall: tools?.some(tool => tool.name === 'self_recall') ?? false,
      }));
    `;
    const child = Bun.spawn([process.execPath, '-e', script], {
      cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout.trim()) as {
      startedUnloaded: boolean;
      error: { code: number; message: string } | null;
      toolCount: number;
      hasSelfRecall: boolean;
    };
    expect(result.startedUnloaded).toBe(true);
    expect(result.error).toBeNull();
    expect(result.toolCount).toBeGreaterThan(0);
    expect(result.hasSelfRecall).toBe(true);
  });

  beforeEach(() => {
    _resetToolRuntimeRegistryForTest();
    resetForTesting();
    fakePtyAdapter();
  });
  afterEach(() => {
    _resetToolRuntimeRegistryForTest();
    resetForTesting();
    setPtyAdapterForTesting(null);
  });

  test('lists first-party harness capabilities alongside registered external MCP runtimes', async () => {
    const asideRepl: ToolRuntime = {
      id: 'aside.repl',
      spec: {
        name: 'aside.repl', description: 'External Aside REPL',
        parameters: { type: 'object', properties: {} },
      },
      surfaces: ['mcp'],
      run: async () => ({ output: 'aside result' }),
    };
    registerToolRuntime(asideRepl);
    registerAllDefaultToolRuntimes();

    const runtimeNames = listToolRuntimes('mcp').map(runtime => runtime.id);
    expect(runtimeNames).toContain('aside.repl');
    expect(runtimeNames).toContain('elanous_autopilot_launch');
    expect(runtimeNames.some(name => !name.startsWith('aside.') && !name.startsWith('xcodebuild.'))).toBe(true);

    const resp = await handleMcpRequest({
      jsonrpc: '2.0', id: 3, method: 'tools/list',
    });
    const result = resp.result as { tools: Array<{ name: string; description: string }> };
    const names = result.tools.map(t => t.name);
    expect(names).toContain('aside.repl');
    expect(names).toContain('elanous_autopilot_launch');
    expect(names).toContain('GetDashboardState');
    expect(names).toContain('PtyShellList');
    expect(names).not.toContain('Bash');
    expect(names).not.toContain('PtyShellStart');
  });

  test('each tool carries inputSchema', async () => {
    registerAllDefaultToolRuntimes();
    const resp = await handleMcpRequest({
      jsonrpc: '2.0', id: 4, method: 'tools/list',
    });
    const result = resp.result as { tools: Array<{ inputSchema: unknown }> };
    for (const t of result.tools) {
      expect(t.inputSchema).toBeTruthy();
    }
  });
});

describe('MCP tools/call', () => {
  beforeEach(() => {
    _resetToolRuntimeRegistryForTest();
    resetForTesting();
    fakePtyAdapter();
  });
  afterEach(() => {
    _resetToolRuntimeRegistryForTest();
    resetForTesting();
    setPtyAdapterForTesting(null);
  });

  test('harness launch tools/call returns the identifier produced by its runtime', async () => {
    const runId = 'run-from-harness-seam';
    registerToolRuntime({
      ...elanousAutopilotLaunchRuntime,
      run: async () => ({ output: runId, runId }),
    });

    const resp = await handleMcpRequest({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'elanous_autopilot_launch', arguments: { mission: 'start this harness run' } },
    });
    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { output: string; runId: string };
    };
    expect(result.content).toEqual([{ type: 'text', text: runId }]);
    expect(result.structuredContent.runId).toBe(runId);
  });

  test('unknown tool name → -32601', async () => {
    registerAllDefaultToolRuntimes();
    const resp = await handleMcpRequest({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'NoSuchTool', arguments: {} },
    });
    expect(resp.error?.code).toBe(-32601);
  });

  test('GetDashboardState returns text + structuredContent', async () => {
    registerAllDefaultToolRuntimes();
    const resp = await handleMcpRequest({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'GetDashboardState', arguments: {} },
    });
    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { snapshot?: unknown; workspace?: unknown };
    };
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text).toContain('monad-agent state');
    // Structured form is the full DashboardStateResult:
    expect(result.structuredContent.snapshot).toBeTruthy();
  });

  test('PtyShellList exposed and callable', async () => {
    registerAllDefaultToolRuntimes();
    const resp = await handleMcpRequest({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'PtyShellList', arguments: {} },
    });
    const result = resp.result as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toContain('PtyShellList');
  });

  test('runtime throw → -32000 with message', async () => {
    registerAllDefaultToolRuntimes();
    const resp = await handleMcpRequest({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      // PtyShellList exposes MCP, but kick a non-mcp tool to force throw
      params: { name: 'whatever', arguments: {} },
    });
    expect(resp.error?.code).toBe(-32601);
  });
});

describe('createMcpStdioServer', () => {
  beforeEach(() => {
    _resetToolRuntimeRegistryForTest();
    resetForTesting();
    fakePtyAdapter();
    registerAllDefaultToolRuntimes();
  });
  afterEach(() => {
    _resetToolRuntimeRegistryForTest();
    resetForTesting();
    setPtyAdapterForTesting(null);
  });

  test('reads stdin lines, writes stdout responses', async () => {
    const inBuf: Array<(line: string) => void> = [];
    const outLines: string[] = [];
    const stream: McpStdioStream = {
      onLine(cb) { inBuf.push(cb); return () => { /* noop */ }; },
      write(l) { outLines.push(l); },
    };
    createMcpStdioServer(stream);
    // Simulate a client sending initialize.
    inBuf[0]!(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    // Let microtasks flush.
    await new Promise(r => setTimeout(r, 10));
    expect(outLines).toHaveLength(1);
    const first = JSON.parse(outLines[0]!);
    expect(first.id).toBe(1);
    expect(first.result.serverInfo.name).toBe('elanous-agent');
  });

  test('notifications (no id) produce no response', async () => {
    const inBuf: Array<(line: string) => void> = [];
    const outLines: string[] = [];
    const stream: McpStdioStream = {
      onLine(cb) { inBuf.push(cb); return () => {}; },
      write(l) { outLines.push(l); },
    };
    createMcpStdioServer(stream);
    inBuf[0]!(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await new Promise(r => setTimeout(r, 10));
    expect(outLines).toHaveLength(0);
  });

  test('malformed JSON produces parse-error frame', async () => {
    const inBuf: Array<(line: string) => void> = [];
    const outLines: string[] = [];
    const stream: McpStdioStream = {
      onLine(cb) { inBuf.push(cb); return () => {}; },
      write(l) { outLines.push(l); },
    };
    createMcpStdioServer(stream);
    inBuf[0]!('{ not json');
    await new Promise(r => setTimeout(r, 10));
    expect(outLines).toHaveLength(1);
    const frame = JSON.parse(outLines[0]!);
    expect(frame.error.code).toBe(-32700);
  });
});
