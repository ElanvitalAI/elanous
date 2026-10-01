import { afterEach, describe, expect, test } from 'bun:test';
import { McpConnectionError } from '../src/mcp/client.js';
import { createMcpProxyRuntime, createMcpToolAuthorizer } from '../src/mcp/proxy-runtime.js';
import {
  _resetToolRuntimeRegistryForTest,
  registerToolRuntime,
} from '../src/tool-runtime/registry.js';
import { handleMcpWidgetCall, MAX_MCP_WIDGET_CALL_BODY_BYTES } from '../src/nexus/api/mcp-widget-call-route.js';
import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';

const PATH = '/v1/mcp/widgets/call';

afterEach(() => _resetToolRuntimeRegistryForTest());

function request(body: unknown, headers?: HeadersInit): Request {
  return new Request(`http://nexus.test${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function registerProxy(options: { authorized?: boolean; failure?: Error; result?: Record<string, unknown> } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const authorizer = createMcpToolAuthorizer();
  if (options.authorized !== false) authorizer.grant({ serverId: 'trusted', toolName: 'paint' });
  registerToolRuntime(createMcpProxyRuntime({
    serverId: 'trusted',
    mcpTool: { name: 'paint', inputSchema: { type: 'object' } },
    authorizer,
    client: {
      async callTool(name, args) {
        calls.push({ name, args });
        if (options.failure) throw options.failure;
        return options.result ?? { content: [{ type: 'text', text: 'painted' }] };
      },
    },
  }) as never);
  return calls;
}

function routeOptions(overrides: Partial<Parameters<typeof handleMcpWidgetCall>[1]> = {}) {
  return {
    authorize: () => true,
    getTrustedServerId: () => 'trusted',
    ...overrides,
  };
}

function serverFixture() {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  return { state, eventBus, registry: new TabRegistry(state) };
}

describe('MCP widget call route', () => {
  test('uses only the trusted server prefix, preserves successful result, and ignores body server spoofing', async () => {
    const calls = registerProxy();
    const response = await handleMcpWidgetCall(request({
      toolName: 'paint', args: { shade: 'blue' }, server: 'other', prefix: 'other.',
    }), routeOptions());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ output: 'painted' });
    expect(calls).toEqual([{ name: 'paint', args: { shade: 'blue' } }]);
  });

  test('rejects unauthenticated, malformed local names, and oversized bodies before registry dispatch', async () => {
    const dispatched: string[] = [];
    const options = routeOptions({
      authorize: () => false,
      getRuntime: (id) => { dispatched.push(id); return {}; },
    });
    const unauthorized = await handleMcpWidgetCall(request({ toolName: 'paint', args: {} }), options);
    expect(unauthorized.status).toBe(401);
    expect(dispatched).toEqual([]);

    const malformed = await handleMcpWidgetCall(request({ toolName: 'other/paint', args: {} }), routeOptions({
      getRuntime: (id) => { dispatched.push(id); return {}; },
    }));
    expect(malformed.status).toBe(400);

    const oversized = await handleMcpWidgetCall(request(`{"toolName":"paint","args":{"payload":"${'x'.repeat(MAX_MCP_WIDGET_CALL_BODY_BYTES)}"}}`), routeOptions({
      getRuntime: (id) => { dispatched.push(id); return {}; },
    }));
    expect(oversized.status).toBe(413);
    expect(dispatched).toEqual([]);
  });

  test('maps unknown tools, proxy authorization denial without remote call, and retryable transport failure distinctly', async () => {
    const unknown = await handleMcpWidgetCall(request({ toolName: 'absent', args: {} }), routeOptions());
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'mcp-widget-tool-not-found', tool: 'absent' });

    const deniedCalls = registerProxy({ authorized: false });
    const denied = await handleMcpWidgetCall(request({ toolName: 'paint', args: {} }), routeOptions());
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'mcp-widget-authorization-denied', tool: 'paint' });
    expect(deniedCalls).toEqual([]);

    _resetToolRuntimeRegistryForTest();
    registerProxy({ failure: new McpConnectionError('unreachable', 'down') });
    const unavailable = await handleMcpWidgetCall(request({ toolName: 'paint', args: {} }), routeOptions());
    expect(unavailable.status).toBe(502);
    expect(unavailable.headers.get('retry-after')).toBe('1');
    expect(await unavailable.json()).toEqual({ error: 'mcp-widget-unavailable', retryable: true });
  });

  test('createHttpServer routing reaches the handler, derives its only server from trusted boot state, and authenticates before registry dispatch', async () => {
    const calls = registerProxy();
    const fixture = serverFixture();
    const server = startNexusHttpServer({
      ...fixture,
      metaApi: { noAuth: true },
      getMcpClients: () => ({
        clients: [], registered: 1,
        perServer: { trusted: { status: 'ready', toolCount: 1 } },
        shutdown: async () => {},
      }) as never,
      startPort: 55000 + Math.floor(Math.random() * 1000),
    });
    try {
      const response = await fetch(`${server.url}${PATH}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolName: 'paint', args: { via: 'http' }, server: 'other' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ output: 'painted' });
      expect(calls).toEqual([{ name: 'paint', args: { via: 'http' } }]);
    } finally { server.stop(); }

    _resetToolRuntimeRegistryForTest();
    const unauthorizedCalls = registerProxy();
    const unauthorizedFixture = serverFixture();
    const unauthorizedServer = startNexusHttpServer({
      ...unauthorizedFixture,
      metaApi: {},
      getMcpClients: () => ({
        clients: [], registered: 1,
        perServer: { trusted: { status: 'ready', toolCount: 1 } },
        shutdown: async () => {},
      }) as never,
      startPort: 56000 + Math.floor(Math.random() * 1000),
    });
    try {
      const response = await fetch(`${unauthorizedServer.url}${PATH}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolName: 'paint', args: {} }),
      });
      expect(response.status).toBe(401);
      expect(unauthorizedCalls).toEqual([]);
    } finally { unauthorizedServer.stop(); }
  });

  test('fails closed without an explicit binding when trusted boot state has multiple ready servers', async () => {
    const calls = registerProxy();
    const fixture = serverFixture();
    const server = startNexusHttpServer({
      ...fixture,
      metaApi: { noAuth: true },
      getMcpClients: () => ({
        clients: [], registered: 2,
        perServer: {
          trusted: { status: 'ready', toolCount: 1 },
          other: { status: 'ready', toolCount: 1 },
        },
        shutdown: async () => {},
      }) as never,
      startPort: 57000 + Math.floor(Math.random() * 1000),
    });
    try {
      const response = await fetch(`${server.url}${PATH}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolName: 'paint', args: {}, server: 'other' }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'mcp-widget-server-unavailable' });
      expect(calls).toEqual([]);
    } finally { server.stop(); }
  });
});
