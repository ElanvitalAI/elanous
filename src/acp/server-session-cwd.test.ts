import { describe, expect, test } from 'bun:test';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { runAcpServer } from './server.js';
import { createInProcessAcpBridge } from '../tui-client/acp-transport-local.js';
import { debug } from '../debug/log.js';
import type { AcpTransportServer } from './transport/index.js';

async function withServer(
  bootToolCwd: string | undefined,
  check: (client: ClientSideConnection, seen: string[]) => Promise<void>,
): Promise<void> {
  const bridge = createInProcessAcpBridge();
  const controller = new AbortController();
  const seen: string[] = [];
  const server = runAcpServer({
    transportFactory: async (onConnection) => {
      void onConnection({
        readable: bridge.a.readable,
        writable: bridge.a.writable,
        peerId: 'cwd-test',
        close: async () => { await bridge.a.writable.close(); },
      });
      return { close: async () => { await bridge.a.writable.close(); } } as AcpTransportServer;
    },
    shutdownSignal: controller.signal,
    requireSessionToolCwd: true,
    ...(bootToolCwd ? { bootToolCwd } : {}),
    runTurn: async (ctx) => { seen.push(ctx.cwd); await ctx.push(ctx.cwd); },
    hasSession: () => true,
  });
  try {
    const client = new ClientSideConnection(() => ({
      async sessionUpdate() {},
      async requestPermission() { return { outcome: { outcome: 'cancelled' as const } }; },
    }), ndJsonStream(bridge.b.writable, bridge.b.readable));
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await check(client, seen);
  } finally {
    controller.abort();
    await bridge.b.writable.close();
    await server;
  }
}

describe('ACP session tool cwd', () => {
  test('two sessions use distinct cwd, missing cwd is JSON-RPC error and server stays alive', async () => {
    await withServer(undefined, async (client, seen) => {
      const a = await client.newSession({ cwd: '/tmp/a', mcpServers: [] });
      const b = await client.newSession({ cwd: '/tmp/b', mcpServers: [] });
      // The installed ACP SDK validates required cwd before calling the agent handler.
      await expect(client.newSession({ mcpServers: [] } as any)).rejects.toMatchObject({ code: -32602 });
      await expect(client.newSession({ cwd: '', mcpServers: [] })).rejects.toMatchObject({
        code: -32602,
        message: 'Invalid params: cwd required: pass session/new cwd or start with --tool-cwd',
      });
      await client.prompt({ sessionId: a.sessionId, prompt: [{ type: 'text', text: 'cwd?' }] });
      await client.prompt({ sessionId: b.sessionId, prompt: [{ type: 'text', text: 'cwd?' }] });
      expect(seen).toEqual(['/tmp/a', '/tmp/b']);
      expect(debug.events(10_000).some((e) => e.category === 'acp.session' && e.event === 'tool-cwd'
        && (e.data as { sessionId?: string; cwd?: string; source?: string }).sessionId === b.sessionId
        && (e.data as { cwd?: string; source?: string }).cwd === '/tmp/b'
        && (e.data as { source?: string }).source === 'session')).toBe(true);
    });
  });

  test('boot default is used only when session cwd is absent; load cwd is per attach', async () => {
    await withServer('/tmp/boot', async (client, seen) => {
      const explicit = await client.newSession({ cwd: '/tmp/a', mcpServers: [] });
      const fallback = await client.newSession({ cwd: '', mcpServers: [] });
      await client.prompt({ sessionId: explicit.sessionId, prompt: [{ type: 'text', text: 'cwd?' }] });
      await client.prompt({ sessionId: fallback.sessionId, prompt: [{ type: 'text', text: 'cwd?' }] });
      await client.loadSession({ sessionId: 'previous', cwd: '/tmp/b', mcpServers: [] });
      await client.prompt({ sessionId: 'previous', prompt: [{ type: 'text', text: 'cwd?' }] });
      await client.loadSession({ sessionId: explicit.sessionId, cwd: '/tmp/reopened', mcpServers: [] });
      await client.prompt({ sessionId: explicit.sessionId, prompt: [{ type: 'text', text: 'cwd?' }] });
      expect(seen).toEqual(['/tmp/a', '/tmp/boot', '/tmp/b', '/tmp/reopened']);
      expect(debug.events(10_000).some((e) => e.category === 'acp.session' && e.event === 'tool-cwd'
        && (e.data as { sessionId?: string; source?: string }).sessionId === fallback.sessionId
        && (e.data as { source?: string }).source === 'boot')).toBe(true);
    });
  });
});
