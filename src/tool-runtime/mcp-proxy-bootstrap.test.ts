import { afterEach, describe, expect, test } from 'bun:test';
import {
  createMcpProxyRuntime,
  createMcpToolAuthorizer,
} from '../mcp/proxy-runtime.js';
import type { McpServerSpec } from '../user-config.js';
import { registerAllDefaultToolRuntimes } from './index.js';
import {
  bootstrapMcpProxyRuntimes,
  getMcpProxyBootstrapDiagnostics,
  setMcpProxyBootstrapOptsForTest,
  _resetMcpProxyBootstrapForTest,
} from './mcp-proxy-bootstrap.js';
import {
  _resetToolRuntimeRegistryForTest,
  dispatchToolByName,
  listToolRuntimes,
} from './registry.js';

const ctx = { surface: 'tui' as const };

afterEach(() => {
  setMcpProxyBootstrapOptsForTest(null);
  _resetMcpProxyBootstrapForTest();
  _resetToolRuntimeRegistryForTest();
});

function stdioServer(id: string, tools: string[]): McpServerSpec {
  return { id, transport: 'stdio', command: ['fake'], authorizedTools: tools };
}

function fakeClient(
  tools: Array<{ name: string; description?: string }>,
  calls?: string[],
  start: () => Promise<void> = async () => {},
) {
  return {
    start,
    listTools: async () => tools,
    callTool: async (name: string) => {
      calls?.push(name);
      return { content: [{ type: 'text' as const, text: `ran:${name}` }] };
    },
    dispose: async () => {},
  };
}

describe('mcp proxy bootstrap — TUI discovery', () => {
  test('one configured server appears in listToolRuntimes(tui) and is callable', async () => {
    const calls: string[] = [];
    const handle = bootstrapMcpProxyRuntimes({
      servers: [stdioServer('aside', ['repl'])],
      handshakeTimeoutMs: 0,
      createClient: () => fakeClient([{ name: 'repl', description: 'Aside REPL' }], calls),
    });
    expect(handle.snapshot().blocking).toBe(false);
    await handle.ready;

    const ids = listToolRuntimes('tui').map((rt) => rt.id);
    expect(ids).toContain('aside.repl');

    const result = await dispatchToolByName('aside.repl', {}, ctx);
    expect(result).toMatchObject({ output: 'ran:repl' });
    expect(calls).toEqual(['repl']);
  });

  test('two configured servers both appear without per-tool wiring', async () => {
    const handle = bootstrapMcpProxyRuntimes({
      servers: [
        stdioServer('aside', ['repl']),
        stdioServer('browser', ['browse']),
      ],
      handshakeTimeoutMs: 0,
      createClient: (spec) =>
        spec.id === 'aside'
          ? fakeClient([{ name: 'repl' }])
          : fakeClient([{ name: 'browse' }]),
    });
    await handle.ready;

    const ids = listToolRuntimes('tui').map((rt) => rt.id);
    expect(ids).toContain('aside.repl');
    expect(ids).toContain('browser.browse');
    const sources = new Set(
      ids.filter((id) => id === 'aside.repl' || id === 'browser.browse').map((id) => id.split('.')[0]),
    );
    expect(sources.size).toBe(2);
  });

  test('attach failure does not throw and leaves a queryable reason', async () => {
    const handle = bootstrapMcpProxyRuntimes({
      servers: [stdioServer('aside', ['repl'])],
      handshakeTimeoutMs: 0,
      createClient: () => ({
        start: async () => { throw new Error('handshake refused'); },
        listTools: async () => [],
        callTool: async () => ({ content: [] }),
        dispose: async () => {},
      }),
    });
    const snap = await handle.ready;
    expect(snap.status).not.toBe('failed');
    expect(snap.perServer['aside']?.status).toBe('failed');
    expect(snap.perServer['aside']?.reason).toContain('handshake refused');
    expect(getMcpProxyBootstrapDiagnostics().perServer['aside']?.reason).toContain('handshake refused');
    expect(listToolRuntimes('tui').map((rt) => rt.id)).not.toContain('aside.repl');
  });

  test('boot lines go to observability, never to the terminal (they painted over the TUI frame)', async () => {
    const consoleCalls: string[] = [];
    const origInfo = console.info;
    const origWarn = console.warn;
    const { debug } = await import('../debug/log.js');
    const origLog = debug.log.bind(debug);
    const events: Array<{ event: string; data: unknown }> = [];
    console.info = ((...args: unknown[]) => { consoleCalls.push(String(args[0])); }) as typeof console.info;
    console.warn = ((...args: unknown[]) => { consoleCalls.push(String(args[0])); }) as typeof console.warn;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown, opts?: unknown) => {
      if (category === 'tool-runtime.mcp-proxy-bootstrap') events.push({ event, data });
      return origLog(category, event, data, opts as never);
    }) as typeof debug.log;
    try {
      const handle = bootstrapMcpProxyRuntimes({
        servers: [stdioServer('aside', ['repl']), stdioServer('krea', ['gen'])],
        handshakeTimeoutMs: 0,
        createClient: (spec) => spec.id === 'krea'
          ? {
            start: async () => { throw new Error('authentication required'); },
            listTools: async () => [],
            callTool: async () => ({ content: [] }),
            dispose: async () => {},
          }
          : fakeClient([{ name: 'repl' }]),
      });
      await handle.ready;
    } finally {
      console.info = origInfo;
      console.warn = origWarn;
      (debug as { log: typeof debug.log }).log = origLog;
    }
    expect(consoleCalls).toEqual([]);
    expect(events.some((e) => e.event === 'client-warn' && JSON.stringify(e.data).includes('krea'))).toBe(true);
    expect(events.some((e) => e.event === 'client-info' && JSON.stringify(e.data).includes('aside'))).toBe(true);
    const ready = events.find((e) => e.event === 'ready');
    expect((ready?.data as { failedServers?: string[] } | undefined)?.failedServers).toEqual(['krea']);
  });

  test('an explicit logger still wins over the observability default', async () => {
    const lines: string[] = [];
    const handle = bootstrapMcpProxyRuntimes({
      servers: [stdioServer('aside', ['repl'])],
      handshakeTimeoutMs: 0,
      createClient: () => fakeClient([{ name: 'repl' }]),
      logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    });
    await handle.ready;
    expect(lines.some((line) => line.includes('aside'))).toBe(true);
  });

  test('zero configured servers does not invent TUI runtimes', async () => {
    const before = listToolRuntimes('tui').length;
    const handle = bootstrapMcpProxyRuntimes({
      servers: [],
      createClient: () => fakeClient([{ name: 'should-not-register' }]),
    });
    await handle.ready;
    expect(handle.snapshot().status).toBe('skipped');
    expect(handle.snapshot().reason).toBe('no-servers');
    expect(listToolRuntimes('tui').length).toBe(before);
    expect(listToolRuntimes('tui').map((rt) => rt.id)).not.toContain('aside.repl');
  });

  test('attach is non-blocking: caller returns while handshake is still in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handle = bootstrapMcpProxyRuntimes({
      servers: [stdioServer('aside', ['repl'])],
      handshakeTimeoutMs: 0,
      createClient: () => fakeClient([{ name: 'repl' }], undefined, () => gate),
    });
    expect(handle.snapshot().status).toBe('pending');
    expect(handle.snapshot().blocking).toBe(false);
    expect(listToolRuntimes('tui').map((rt) => rt.id)).not.toContain('aside.repl');
    release();
    await handle.ready;
    expect(listToolRuntimes('tui').map((rt) => rt.id)).toContain('aside.repl');
  });
});

describe('mcp proxy bootstrap — invariants', () => {
  test('proxy runtime surfaces stay mcp+tui', () => {
    const runtime = createMcpProxyRuntime({
      serverId: 'aside',
      mcpTool: { name: 'repl' },
      client: { callTool: async () => ({ content: [] }) },
      authorizer: createMcpToolAuthorizer(),
    });
    expect(runtime.surfaces).toEqual(['mcp', 'tui']);
  });

  test('default MCP runtimes still include self_implement and elanous_skills_list', () => {
    registerAllDefaultToolRuntimes();
    const ids = listToolRuntimes('mcp').map((rt) => rt.id);
    expect(ids).toContain('self_implement');
    expect(ids).toContain('elanous_skills_list');
  });
});
