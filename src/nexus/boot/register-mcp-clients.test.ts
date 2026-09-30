import { afterEach, describe, expect, test } from 'bun:test';

import { debug } from '../../debug/log.js';
import { failureReason } from '../../domains/repeated-failure.js';
import { McpConnectionError } from '../../mcp/client.js';
import { maskInjectedValues, registerMcpClients } from './register-mcp-clients.js';

const stdioServer = (id: string, handshakeTimeoutMs?: number) => ({
  id,
  transport: 'stdio' as const,
  command: ['fake'],
  ...(handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs }),
});

const successfulClient = () => ({
  start: async () => {},
  listTools: async () => [],
  callTool: async () => ({ content: [] }),
  dispose: async () => {},
});

describe('registerMcpClients handshake timeout configuration', () => {
  test('uses server override, then global value, then the unchanged 8000ms default', async () => {
    const observed: number[] = [];
    const handle = await registerMcpClients({
      servers: [stdioServer('default'), stdioServer('global'), stdioServer('server', 13)],
      handshakeTimeoutMs: 7,
      createClient: successfulClient,
      logger: { info: () => {}, warn: () => {} },
      setTimeoutFn: (callback, ms) => {
        observed.push(ms);
        return setTimeout(callback, ms);
      },
      clearTimeoutFn: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });

    expect(observed).toEqual([7, 7, 7, 7, 13, 13]);
    await handle.shutdown();

    const defaults: number[] = [];
    const defaultHandle = await registerMcpClients({
      servers: [stdioServer('default')],
      createClient: successfulClient,
      logger: { info: () => {}, warn: () => {} },
      setTimeoutFn: (callback, ms) => {
        defaults.push(ms);
        return setTimeout(callback, ms);
      },
      clearTimeoutFn: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    });
    expect(defaults).toEqual([8000, 8000]);
    await defaultHandle.shutdown();
  });

  test('skips a timed-out server, registers a healthy peer, and tells the user how to recover', async () => {
    const warnings: string[] = [];
    const handle = await registerMcpClients({
      servers: [stdioServer('slow', 1), stdioServer('healthy')],
      createClient: (spec) => spec.id === 'slow'
        ? {
            start: () => new Promise<void>(() => {}),
            listTools: async () => [],
            callTool: async () => ({ content: [] }),
            dispose: async () => {},
          }
        : successfulClient(),
      logger: { info: () => {}, warn: (line) => warnings.push(line) },
    });

    expect(handle.perServer.slow).toMatchObject({ status: 'failed' });
    expect(handle.perServer.healthy).toEqual({ status: 'ready', toolCount: 0 });
    expect(warnings).toContainEqual(expect.stringContaining('slow was excluded after its 1ms handshake timeout'));
    expect(warnings).toContainEqual(expect.stringContaining('raise mcp.handshakeTimeoutMs or mcp.servers[].handshakeTimeoutMs, then run elanous mcp reload'));
    await handle.shutdown();
  });
});

describe('registerMcpClients connect-failed trace', () => {
  const captured: { category: string; event: string; data?: Record<string, unknown> }[] = [];
  const originalLog = debug.log.bind(debug) as typeof debug.log;

  afterEach(() => {
    (debug as { log: typeof debug.log }).log = originalLog;
    captured.length = 0;
  });

  const failingClient = (err: Error) => ({
    start: async () => { throw err; },
    listTools: async () => [],
    callTool: async () => ({ content: [] }),
    dispose: async () => {},
  });

  test('logs auth-required and invalid-token, leaves the ready peer ready, and is countable by failureReason', async () => {
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
      captured.push({ category, event, data });
    }) as typeof debug.log;

    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const handle = await registerMcpClients({
      servers: [stdioServer('higgsfield'), stdioServer('bridge'), stdioServer('krea')],
      handshakeTimeoutMs: 0,
      createClient: (spec) => {
        if (spec.id === 'higgsfield') {
          return failingClient(new McpConnectionError('auth-required', `authentication required token=${secret}`));
        }
        if (spec.id === 'bridge') return failingClient(new Error('invalid_token'));
        return successfulClient();
      },
      logger: { info: () => {}, warn: () => {} },
    });

    const rows = captured.filter((row) => row.category === 'mcp.client.boot' && row.event === 'connect-failed');
    const byId = Object.fromEntries(rows.map((row) => [row.data?.id, row.data?.reason]));
    expect(byId).toEqual({ higgsfield: 'auth-required', bridge: 'invalid-token' });
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(handle.perServer.higgsfield).toMatchObject({ status: 'failed', reasonClass: 'auth-required' });
    expect(handle.perServer.bridge).toMatchObject({ status: 'failed', reasonClass: 'invalid-token' });
    expect(handle.perServer.krea).toEqual({ status: 'ready', toolCount: 0 });

    for (const row of rows) {
      const reason = failureReason({
        event: row.event,
        category: row.category,
        data: JSON.stringify(row.data ?? {}),
      });
      expect(reason).not.toBeNull();
    }
    await handle.shutdown();
  });
});

test('MCP results mask injected credential values in object keys as well as values', () => {
  const secret = 'plugin-secret-value-0123456789';
  const masked = maskInjectedValues({ structuredContent: { [secret]: 'ok', nested: [{ [`x-${secret}`]: secret }] } }, [secret]);
  expect(JSON.stringify(masked)).not.toContain(secret);
});
