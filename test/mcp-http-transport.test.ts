// ── NEXUS POST /v1/mcp HTTP transport tests (B 트랙 closure) ──

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAdminToken, mintScopedToken, revokeScopedToken, clearTokenStore } from '../src/auth/token-store';
import { handleMcpHttpPost } from '../src/nexus/api/mcp-http';
import { registerToolRuntime, _resetToolRuntimeRegistryForTest } from '../src/tool-runtime/registry';
import { registerAllDefaultToolRuntimes } from '../src/tool-runtime/index';
import type { ToolRuntime } from '../src/tool-runtime/types';

let tokenHome: string;

function makeProxyRuntime(id: string, output = 'ok', onRun?: () => void): ToolRuntime {
  return {
    id,
    spec: { name: id, description: `proxy ${id}`, parameters: { type: 'object' } },
    surfaces: ['mcp'],
    async run() {
      onRun?.();
      return { output };
    },
  };
}

function jsonRpcReq(body: Record<string, unknown>, authorization?: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request('http://test.local/v1/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders, ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(body),
  });
}

function loopbackContext() {
  return { peerAddress: '127.0.0.1' };
}

function remoteContext() {
  return { peerAddress: '100.64.0.1', tokenStorePaths: { homedirOverride: tokenHome } };
}

async function asJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  _resetToolRuntimeRegistryForTest();
  tokenHome = mkdtempSync(join(tmpdir(), 'mcp-http-token-'));
});

afterEach(() => {
  clearTokenStore({ homedirOverride: tokenHome });
  rmSync(tokenHome, { recursive: true, force: true });
});

describe('handleMcpHttpPost — protocol handshake', () => {
  test('loopback initialize without credentials → 200 + capabilities + serverInfo', async () => {
    const res = await handleMcpHttpPost(jsonRpcReq({ jsonrpc: '2.0', id: 1, method: 'initialize' }), loopbackContext());
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body.id).toBe(1);
    expect((body.result as { capabilities: { tools: object }; serverInfo: { name: string } }).capabilities.tools).toBeDefined();
  });

  test('notifications/initialized (no id) → 202 Accepted, empty body', async () => {
    const res = await handleMcpHttpPost(jsonRpcReq({ jsonrpc: '2.0', method: 'notifications/initialized' }), loopbackContext());
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  test('IPv6 and IPv4-mapped loopback peers remain credential-free', async () => {
    for (const peerAddress of ['::1', '::ffff:127.0.0.1']) {
      const res = await handleMcpHttpPost(jsonRpcReq({ jsonrpc: '2.0', id: 1, method: 'initialize' }), { peerAddress });
      expect(res.status).toBe(200);
    }
  });

  test('browser-originated loopback tools/call is denied before the runtime dispatches', async () => {
    let executions = 0;
    registerToolRuntime(makeProxyRuntime('xcode.build', 'build ok', () => { executions += 1; }));
    const res = await handleMcpHttpPost(
      jsonRpcReq(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'xcode.build', arguments: {} } },
        undefined,
        { origin: 'https://attacker.example' },
      ),
      loopbackContext(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    expect(executions).toBe(0);
  });
});

describe('handleMcpHttpPost — remote access control', () => {
  test('remote or unknown peer without a token is denied with a Bearer challenge despite forwarded headers', async () => {
    for (const context of [remoteContext(), { tokenStorePaths: remoteContext().tokenStorePaths }]) {
      const res = await handleMcpHttpPost(
        jsonRpcReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, undefined, { 'x-forwarded-for': '127.0.0.1' }),
        context,
      );
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Bearer');
    }
  });

  test('remote or unknown peer with a valid admin token is allowed', async () => {
    const token = ensureAdminToken(remoteContext().tokenStorePaths);
    registerToolRuntime(makeProxyRuntime('xcode.build_target'));
    for (const context of [remoteContext(), { tokenStorePaths: remoteContext().tokenStorePaths }]) {
      const res = await handleMcpHttpPost(
        jsonRpcReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, `Bearer ${token}`),
        context,
      );
      expect(res.status).toBe(200);
      expect(((await asJson(res)).result as { tools: Array<{ name: string }> }).tools.map(({ name }) => name)).toContain('xcode.build_target');
    }
  });

  test('accepts case-insensitive Bearer schemes with one credential and rejects malformed credentials', async () => {
    const token = ensureAdminToken(remoteContext().tokenStorePaths);
    for (const authorization of [`Bearer ${token}`, `bearer ${token}`, `BeArEr ${token}`]) {
      const res = await handleMcpHttpPost(
        jsonRpcReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, authorization),
        remoteContext(),
      );
      expect(res.status).toBe(200);
    }
    for (const authorization of [`Bearer ${token} trailing`, `Basic ${token}`, 'Bearer ']) {
      const res = await handleMcpHttpPost(
        jsonRpcReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, authorization),
        remoteContext(),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Bearer');
    }
  });

  test('invalid, revoked, and insufficient-scope credentials are denied', async () => {
    const paths = remoteContext().tokenStorePaths;
    ensureAdminToken(paths);
    const readOnly = mintScopedToken({ scope: 'read-only' }, paths);
    const revoked = mintScopedToken({ scope: 'read-only' }, paths);
    expect(revokeScopedToken(revoked, paths)).toBe(true);
    for (const credential of ['not-a-token', revoked, readOnly]) {
      const res = await handleMcpHttpPost(
        jsonRpcReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, `Bearer ${credential}`),
        remoteContext(),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Bearer');
    }
  });

  test('remote denied tools/call never dispatches the runtime', async () => {
    let executions = 0;
    registerToolRuntime(makeProxyRuntime('xcode.build', 'build ok', () => { executions += 1; }));
    const res = await handleMcpHttpPost(
      jsonRpcReq({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'xcode.build', arguments: {} } }),
      remoteContext(),
    );
    expect(res.status).toBe(401);
    expect(executions).toBe(0);
  });
});

describe('handleMcpHttpPost — mcp-public token tools', () => {
  test('public token lists only allowed tools while admin and direct loopback still list all tools', async () => {
    const paths = remoteContext().tokenStorePaths;
    const admin = ensureAdminToken(paths);
    const publicToken = mintScopedToken({ scope: 'mcp-public' }, paths);
    registerAllDefaultToolRuntimes();
    registerToolRuntime(makeProxyRuntime('xcode.build'));
    const request = (token?: string) => jsonRpcReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, token ? `Bearer ${token}` : undefined);
    const names = async (res: Response) => ((await asJson(res)).result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name);

    const publicResponse = await handleMcpHttpPost(request(publicToken), remoteContext());
    expect(publicResponse.status).toBe(200);
    const publicNames = await names(publicResponse);
    expect(publicNames).toContain('self_recall');
    expect(publicNames).not.toContain('xcode.build');
    expect(publicNames).not.toContain('AgentStop');
    const adminNames = await names(await handleMcpHttpPost(request(admin), remoteContext()));
    const loopbackNames = await names(await handleMcpHttpPost(request(), loopbackContext()));
    expect(adminNames).toContain('xcode.build');
    expect(loopbackNames).toContain('xcode.build');
    const loopbackScopedNames = await names(await handleMcpHttpPost(request(publicToken), {
      ...loopbackContext(), tokenStorePaths: paths,
    }));
    expect(loopbackScopedNames).not.toContain('xcode.build');
  });

  test('public token calls an allowed tool but cannot execute a disallowed tool in JSON or SSE', async () => {
    const paths = remoteContext().tokenStorePaths;
    const admin = ensureAdminToken(paths);
    const publicToken = mintScopedToken({ scope: 'mcp-public' }, paths);
    let deniedExecutions = 0;
    registerAllDefaultToolRuntimes();
    registerToolRuntime(makeProxyRuntime('xcode.build', 'private ok', () => { deniedExecutions += 1; }));
    const call = (name: string, token: string, extraHeaders: Record<string, string> = {}, args: Record<string, unknown> = {}) =>
      jsonRpcReq({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, `Bearer ${token}`, extraHeaders);

    const allowed = await handleMcpHttpPost(
      call('self_recall', publicToken, {}, { query: 'mcp-public-test', sinceHours: 1, limit: 1 }),
      remoteContext(),
    );
    expect(allowed.status).toBe(200);
    const allowedBody = await asJson(allowed);
    expect(allowedBody.error).toBeUndefined();
    const allowedResult = allowedBody.result as { isError?: boolean; structuredContent?: { isError?: boolean }; content: Array<{ type: string; text: string }> };
    expect(allowedResult.isError).not.toBe(true);
    expect(allowedResult.structuredContent?.isError).not.toBe(true);
    expect(allowedResult.content[0]?.type).toBe('text');
    const recall = JSON.parse(allowedResult.content[0]!.text) as { events: unknown[]; count: number; note: string };
    expect(Array.isArray(recall.events)).toBe(true);
    expect(recall.count).toBe(recall.events.length);
    expect(recall.note).toContain('자기 구현·자율행동 이력 회상');

    const denied = await handleMcpHttpPost(call('xcode.build', publicToken), remoteContext());
    expect(denied.status).toBe(200);
    expect((await asJson(denied)).error).toEqual({ code: -32601, message: 'unknown tool: xcode.build' });
    const streamed = await handleMcpHttpPost(call('xcode.build', publicToken, { 'MCP-Progress': 'stream' }), remoteContext());
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('content-type')).toBe('text/event-stream');
    expect(await streamed.text()).toContain('"code":-32601');
    expect(deniedExecutions).toBe(0);

    const adminCall = await handleMcpHttpPost(call('xcode.build', admin), remoteContext());
    expect(((await asJson(adminCall)).result as { content: Array<{ text: string }> }).content[0]!.text).toBe('private ok');
    expect(deniedExecutions).toBe(1);
  });
});

describe('handleMcpHttpPost — tools/call dispatches through registry', () => {
  test('successful loopback call returns the tool output in MCP content shape', async () => {
    registerToolRuntime(makeProxyRuntime('xcode.build', 'build ok'));
    const res = await handleMcpHttpPost(
      jsonRpcReq({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'xcode.build', arguments: { scheme: 'MyApp' } } }),
      loopbackContext(),
    );
    expect(res.status).toBe(200);
    expect(((await asJson(res)).result as { content: Array<{ text?: string }> }).content[0]!.text).toContain('build ok');
  });
});

describe('handleMcpHttpPost — input validation', () => {
  test('loopback non-JSON body → 400 + parse error envelope', async () => {
    const req = new Request('http://test.local/v1/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json {{' });
    const res = await handleMcpHttpPost(req, loopbackContext());
    expect(res.status).toBe(400);
    expect(((await asJson(res)).error as { code: number }).code).toBe(-32700);
  });

  test('loopback malformed request shapes → 400', async () => {
    for (const body of [JSON.stringify([1, 2, 3]), JSON.stringify({ jsonrpc: '2.0', id: 5 }), 'null']) {
      const req = new Request('http://test.local/v1/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      expect((await handleMcpHttpPost(req, loopbackContext())).status).toBe(400);
    }
  });
});

describe('handleMcpHttpPost — content-type + headers', () => {
  test('200 responses set content-type: application/json', async () => {
    const res = await handleMcpHttpPost(jsonRpcReq({ jsonrpc: '2.0', id: 1, method: 'initialize' }), loopbackContext());
    expect(res.headers.get('content-type')).toBe('application/json');
  });
});
