// ── McpProxyRuntime unit tests ──
//
// Validates the McpTool → ToolRuntime wrap factory + the result
// conversion (`McpToolCallResult` → `ToolRunResult`). The remote
// client is faked — we only check that the factory forwards the
// `tools/call` and that the conversion preserves text · image ·
// structured · isError fields per the contract in proxy-runtime.ts.

import { describe, test, expect, spyOn } from 'bun:test';
import {
  createMcpProxyRuntime,
  createMcpToolAuthorizer,
  capMcpOutput,
  DEFAULT_MCP_OUTPUT_LIMIT,
  normalizeMcpOutputLimit,
  mcpResultToRunResult,
} from '../src/mcp/proxy-runtime';
import { McpServerError } from '../src/mcp/client';
import type {
  McpTool,
  McpToolCallResult,
} from '../src/mcp/client';
import { registerMcpClients } from '../src/nexus/boot/register-mcp-clients';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig, resetUserConfig } from '../src/user-config';
import {
  _resetToolRuntimeRegistryForTest,
  listToolRuntimes,
  registerToolRuntime,
} from '../src/tool-runtime/registry';
import type { ToolRuntime } from '../src/tool-runtime/types';

// ─── Tests ───────────────────────────────────────────────────────

const alwaysAuthorized = {
  isGranted: () => true,
};

describe('createMcpProxyRuntime', () => {
  test('id is "<server>.<tool>" (RFC Q2)', () => {
    const tool: McpTool = { name: 'build_target', description: 'Build it' };
    const rt = createMcpProxyRuntime({
      serverId: 'xcode',
      mcpTool: tool,
      client: { callTool: async () => ({ content: [] }) },
      authorizer: alwaysAuthorized,
    });
    expect(rt.id).toBe('xcode.build_target');
    expect(rt.spec.name).toBe('xcode.build_target');
    expect(rt.spec.description).toBe('Build it');
  });

  test('forwards inputSchema verbatim when it is an object', () => {
    const schema = {
      type: 'object',
      properties: { scheme: { type: 'string' } },
      required: ['scheme'],
    };
    const rt = createMcpProxyRuntime({
      serverId: 'xcode',
      mcpTool: { name: 'x', inputSchema: schema },
      client: { callTool: async () => ({ content: [] }) },
      authorizer: alwaysAuthorized,
    });
    expect(rt.spec.parameters).toEqual(schema);
  });

  test('falls back to empty object schema when inputSchema is missing or invalid', () => {
    const rt = createMcpProxyRuntime({
      serverId: 'xcode',
      mcpTool: { name: 'x' },
      client: { callTool: async () => ({ content: [] }) },
      authorizer: alwaysAuthorized,
    });
    expect(rt.spec.parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });

  test('description falls back to a sensible default when missing', () => {
    const rt = createMcpProxyRuntime({
      serverId: 'xcode',
      mcpTool: { name: 'noop' },
      client: { callTool: async () => ({ content: [] }) },
      authorizer: alwaysAuthorized,
    });
    expect(rt.spec.description).toBe('MCP tool xcode.noop');
  });

  test('declares mcp and tui surfaces for relay and conversation discovery', () => {
    const rt = createMcpProxyRuntime({
      serverId: 'xcode',
      mcpTool: { name: 'build' },
      client: { callTool: async () => ({ content: [] }) },
      authorizer: alwaysAuthorized,
    });
    expect(rt.surfaces).toEqual(['mcp', 'tui']);
  });

  test('sends run correlation metadata only to the Aside MCP server', async () => {
    const received: Array<{ serverId: string; runId?: string }> = [];
    for (const serverId of ['aside', 'elanous', 'third-party']) {
      const rt = createMcpProxyRuntime({
        serverId,
        mcpTool: { name: 'exec' },
        client: {
          callTool: async (_name: string, _args: Record<string, unknown>, meta?: { elanousRunId?: string }) => {
            received.push({ serverId, runId: meta?.elanousRunId });
            return { content: [] };
          },
        },
        authorizer: alwaysAuthorized,
      });
      await rt.run({}, { surface: 'mcp', runId: 'run-aside-context' });
    }
    expect(received).toEqual([
      { serverId: 'aside', runId: 'run-aside-context' },
      { serverId: 'elanous', runId: undefined },
      { serverId: 'third-party', runId: undefined },
    ]);
  });

  test('is discoverable from both tui and mcp surfaces without changing native tui tools', () => {
    const proxy = createMcpProxyRuntime({
      serverId: 'remote',
      mcpTool: { name: 'inspect' },
      client: { callTool: async () => ({ content: [] }) },
      authorizer: alwaysAuthorized,
    });
    const nativeTuiTool: ToolRuntime = {
      id: 'existing-chat-tool',
      spec: { name: 'existing-chat-tool', description: 'existing', parameters: { type: 'object' } },
      surfaces: ['tui'],
      run: async () => ({ output: 'ok' }),
    };
    _resetToolRuntimeRegistryForTest();
    try {
      registerToolRuntime(proxy);
      registerToolRuntime(nativeTuiTool);
      expect(listToolRuntimes('tui').map(rt => rt.id)).toEqual(['remote.inspect', 'existing-chat-tool']);
      expect(listToolRuntimes('mcp').map(rt => rt.id)).toEqual(['remote.inspect']);
    } finally {
      _resetToolRuntimeRegistryForTest();
    }
  });

  test('run() forwards args to client.callTool with the REMOTE tool name', async () => {
    let captured: { name?: string; args?: Record<string, unknown> } = {};
    const rt = createMcpProxyRuntime({
      serverId: 'xcode',
      mcpTool: { name: 'build_target' },
      client: {
        callTool: async (name, args) => {
          captured = { name, args };
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      },
      authorizer: alwaysAuthorized,
    });
    const result = await rt.run(
      { scheme: 'elanous' },
      { surface: 'mcp' },
    );
    expect(captured.name).toBe('build_target'); // remote tool name, NOT the proxy id
    expect(captured.args).toEqual({ scheme: 'elanous' });
    expect((result as { output: string }).output).toBe('ok');
  });

  test('authorization lifetime denies, grants, and bulk-revokes a server without calling the client', async () => {
    const authorizer = createMcpToolAuthorizer();
    let calls = 0;
    const client = {
      callTool: async () => {
        calls += 1;
        return { content: [{ type: 'text', text: 'allowed' }] };
      },
    };
    const makeRuntime = (toolName: string) => createMcpProxyRuntime({
      serverId: 'remote',
      mcpTool: { name: toolName },
      client,
      authorizer,
    });
    const first = makeRuntime('first');
    const second = makeRuntime('second');

    const denied = await first.run({}, { surface: 'tui' });
    expect((denied as { classification: string }).classification).toBe('mcp-authorization-denied');
    expect(calls).toBe(0);

    authorizer.grant({ serverId: 'remote', toolName: 'first' });
    const allowed = await first.run({}, { surface: 'tui' });
    expect((allowed as { output: string }).output).toBe('allowed');
    expect(calls).toBe(1);

    // 폐기 → 다시 거부. ⛔ 「허가되면 그만」이 아니라 «되돌릴 수 있다»가 이 축의 요구다.
    expect(authorizer.revokeServer('remote')).toBe(1);
    expect((await first.run({}, { surface: 'mcp' }) as { classification: string }).classification)
      .toBe('mcp-authorization-denied');
    expect(calls).toBe(1);

    authorizer.grant({ serverId: 'remote', toolName: 'first' });
    authorizer.grant({ serverId: 'remote', toolName: 'second' });
    expect(authorizer.revokeServer('remote')).toBe(2);
    expect((await first.run({}, { surface: 'mcp' }) as { classification: string }).classification)
      .toBe('mcp-authorization-denied');
    expect((await second.run({}, { surface: 'mcp' }) as { classification: string }).classification)
      .toBe('mcp-authorization-denied');
    expect(calls).toBe(1);
  });

  test('denial observations accumulate counts per server without changing the proxy denial result', async () => {
    const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const debugLog = spyOn((await import('../src/debug/log')).debug, 'log').mockImplementation((category, event, data) => {
      logs.push({ category, event, data: data as Record<string, unknown> });
    });
    try {
      const authorizer = createMcpToolAuthorizer();
      let calls = 0;
      const runtime = (serverId: string, toolName: string) => createMcpProxyRuntime({
        serverId,
        mcpTool: { name: toolName },
        client: { callTool: async () => { calls += 1; return { content: [] }; } },
        authorizer,
      });

      const alphaFirst = runtime('alpha', 'first');
      const alphaSecond = runtime('alpha', 'second');
      const betaFirst = runtime('beta', 'first');
      const neverDenied = runtime('never-denied', 'allowed');
      authorizer.grant({ serverId: 'never-denied', toolName: 'allowed' });

      for (const denied of [alphaFirst, alphaSecond, alphaFirst, betaFirst]) {
        const result = await denied.run({}, { surface: 'mcp' }) as Record<string, unknown>;
        expect(result).toEqual({
          ok: false,
          classification: 'mcp-authorization-denied',
          output: 'mcp authorization denied: ' + denied.id,
        });
      }
      expect(calls).toBe(0);
      await neverDenied.run({}, { surface: 'mcp' });
      expect(calls).toBe(1);

      const denials = logs.filter(({ category, event }) => category === 'mcp.authorization' && event === 'denied');
      expect(denials.map(({ data }) => data)).toEqual([
        { serverId: 'alpha', toolName: 'first', deniedCount: 1, deniedToolCount: 1 },
        { serverId: 'alpha', toolName: 'second', deniedCount: 2, deniedToolCount: 2 },
        { serverId: 'alpha', toolName: 'first', deniedCount: 3, deniedToolCount: 2 },
        { serverId: 'beta', toolName: 'first', deniedCount: 1, deniedToolCount: 1 },
      ]);
      expect(denials.some(({ data }) => data.serverId === 'never-denied')).toBe(false);
    } finally {
      debugLog.mockRestore();
    }
  });

  test('invalid expiry is rejected and cannot create a fail-open grant', () => {
    const authorizer = createMcpToolAuthorizer();
    expect(() => authorizer.grant({
      serverId: 'remote',
      toolName: 'pay',
      expiresAt: 'Invalid Date',
    })).toThrow('invalid MCP grant expiry');
    expect(authorizer.isGranted('remote', 'pay')).toBe(false);
  });

  test('authorization denial, transport failure, and server error have distinct classifications', async () => {
    const authorizer = createMcpToolAuthorizer();
    const denied = createMcpProxyRuntime({
      serverId: 'remote',
      mcpTool: { name: 'denied' },
      client: { callTool: async () => ({ content: [] }) },
      authorizer,
    });
    const transport = createMcpProxyRuntime({
      serverId: 'remote',
      mcpTool: { name: 'transport' },
      client: { callTool: async () => { throw new Error('gone'); } },
      authorizer,
    });
    const server = createMcpProxyRuntime({
      serverId: 'remote',
      mcpTool: { name: 'server' },
      client: { callTool: async () => ({ content: [], isError: true }) },
      authorizer,
    });
    authorizer.grant({ serverId: 'remote', toolName: 'transport' });
    authorizer.grant({ serverId: 'remote', toolName: 'server' });

    expect((await denied.run({}, { surface: 'mcp' }) as { classification: string }).classification)
      .toBe('mcp-authorization-denied');
    expect((await transport.run({}, { surface: 'mcp' }) as { classification: string }).classification)
      .toBe('mcp-transport-error');
    expect((await server.run({}, { surface: 'mcp' }) as { classification: string }).classification)
      .toBe('mcp-server-error');
  });

  test('approved calls copy the tool definition output template while preserving text, image, structured, and error fields', async () => {
    const template = 'ui://widgets/build-result.html?theme=dark';
    const rt = createMcpProxyRuntime({
      serverId: 'remote',
      mcpTool: {
        name: 'build',
        _meta: { ui: { resourceUri: template } },
      },
      client: {
        callTool: async () => ({
          content: [
            { type: 'text', text: 'build failed' },
            { type: 'image', data: 'BASE64DATA', mimeType: 'image/png' },
          ],
          structuredContent: { buildId: 'b-1' },
          isError: true,
        }),
      },
      authorizer: alwaysAuthorized,
    });

    const result = await rt.run({}, { surface: 'mcp' }) as Record<string, unknown>;
    expect(result).toMatchObject({
      output: 'build failed',
      mediaType: 'image/png',
      dataB64: 'BASE64DATA',
      structured: { buildId: 'b-1' },
      ok: false,
      classification: 'mcp-server-error',
      _meta: { ui: { resourceUri: template } },
    });
  });

  test('approved calls omit output template when tool metadata or its output-template key is absent', async () => {
    for (const mcpTool of [
      { name: 'without-meta' },
      { name: 'without-template', _meta: { unrelated: 'value' } },
    ]) {
      const rt = createMcpProxyRuntime({
        serverId: 'remote',
        mcpTool,
        client: { callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
        authorizer: alwaysAuthorized,
      });
      const result = await rt.run({}, { surface: 'mcp' }) as Record<string, unknown>;
      expect(result).not.toHaveProperty('_meta');
    }
  });

  test('approved calls preserve an explicitly present empty output template', async () => {
    const rt = createMcpProxyRuntime({
      serverId: 'remote',
      mcpTool: { name: 'empty-template', _meta: { ui: { resourceUri: '' } } },
      client: { callTool: async () => ({ content: [] }) },
      authorizer: alwaysAuthorized,
    });

    const result = await rt.run({}, { surface: 'mcp' }) as Record<string, unknown>;
    expect(result).toHaveProperty('_meta', { ui: { resourceUri: '' } });
  });

  // ── 규범 열쇠 회귀 (2026-08-20 · 사람이 인수해 메움) ──
  //
  // ⛔ 초판은 `openai/outputTemplate`(OpenAI Apps SDK 관례)«만» 봤다.
  //    📏 실측(mcp.higgsfield.ai · 툴 73개): 그 열쇠 **0개** · `_meta.ui.resourceUri` **40개**
  //    ⇒ 우리가 붙은 서버에서 ***한 번도 안 걸렸다***. 「만들었는데 안 닿는다」의 한 판본.
  test('⭐ MCP Apps 규범 열쇠(_meta.ui.resourceUri)를 «먼저» 본다', async () => {
    const rt = createMcpProxyRuntime({
      serverId: 'remote',
      mcpTool: { name: 'w', _meta: { ui: { resourceUri: 'ui://spec/normative.html' } } },
      client: { callTool: async () => ({ content: [] }) },
      authorizer: alwaysAuthorized,
    });
    const out = await rt.run({}, { surface: 'mcp' }) as Record<string, unknown>;
    expect(out).toHaveProperty('_meta', { ui: { resourceUri: 'ui://spec/normative.html' } });
  });

  test('⭐ 납작한 ui/resourceUri 도 받는다 — 상대가 «둘 다» 보낸다', async () => {
    const rt = createMcpProxyRuntime({
      serverId: 'remote',
      mcpTool: { name: 'w', _meta: { 'ui/resourceUri': 'ui://spec/flat.html' } },
      client: { callTool: async () => ({ content: [] }) },
      authorizer: alwaysAuthorized,
    });
    const out = await rt.run({}, { surface: 'mcp' }) as Record<string, unknown>;
    expect(out).toHaveProperty('_meta', { ui: { resourceUri: 'ui://spec/flat.html' } });
  });

  test('⭐ 규범 열쇠와 OpenAI 열쇠가 «같이» 오면 규범이 이긴다', async () => {
    const rt = createMcpProxyRuntime({
      serverId: 'remote',
      mcpTool: { name: 'w', _meta: {
        ui: { resourceUri: 'ui://spec/win.html' },
        'openai/outputTemplate': 'ui://other/lose.html',
      } },
      client: { callTool: async () => ({ content: [] }) },
      authorizer: alwaysAuthorized,
    });
    const out = await rt.run({}, { surface: 'mcp' }) as Record<string, unknown>;
    expect(out).toHaveProperty('_meta', { ui: { resourceUri: 'ui://spec/win.html' } });
  });

  test('registerMcpClients carries a listed tool output template into the registered runtime result', async () => {
    const registered: Array<{ run: (args: Record<string, unknown>, ctx: { surface: 'mcp' }) => Promise<unknown> }> = [];
    const handle = await registerMcpClients({
      servers: [{ id: 'remote', transport: 'stdio' as const, command: ['fake'], authorizedTools: ['templated'] }],
      handshakeTimeoutMs: 0,
      logger: { info: () => {}, warn: () => {} },
      createClient: () => ({
        start: async () => {},
        listTools: async () => [{ name: 'templated', _meta: { ui: { resourceUri: 'ui://widgets/registered.html' } } }],
        callTool: async () => ({ content: [] }),
        dispose: async () => {},
      }),
      registerRuntime: (runtime) => { registered.push(runtime as never); },
    });
    try {
      const result = await registered[0]!.run({}, { surface: 'mcp' });
      expect(result).toHaveProperty('_meta', { ui: { resourceUri: 'ui://widgets/registered.html' } });
    } finally {
      await handle.shutdown();
    }
  });

  test('authorization denial omits output template before any remote call', async () => {
    let calls = 0;
    const rt = createMcpProxyRuntime({
      serverId: 'remote',
      mcpTool: { name: 'denied-template', _meta: { ui: { resourceUri: 'ui://widgets/private.html' } } },
      client: {
        callTool: async () => {
          calls += 1;
          return { content: [] };
        },
      },
      authorizer: createMcpToolAuthorizer(),
    });

    const result = await rt.run({}, { surface: 'mcp' }) as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: false,
      classification: 'mcp-authorization-denied',
    });
    expect(result).not.toHaveProperty('_meta');
    expect(calls).toBe(0);
  });

  test('approved thrown server errors copy the output template, while missing metadata omits it', async () => {
    for (const [name, _meta, expectedTemplate] of [
      ['templated-refusal', { ui: { resourceUri: 'ui://widgets/refusal.html' } }, 'ui://widgets/refusal.html'],
      ['untemplated-refusal', undefined, undefined],
    ] as const) {
      const rt = createMcpProxyRuntime({
        serverId: 'remote',
        mcpTool: { name, _meta },
        client: {
          callTool: async () => { throw new McpServerError(-32602, 'invalid params'); },
        },
        authorizer: alwaysAuthorized,
      });
      const out = await rt.run({}, { surface: 'mcp' }) as Record<string, unknown>;
      expect(out.classification).toBe('mcp-server-error');
      expect(out.output).toContain('MCP error -32602: invalid params');
      if (expectedTemplate === undefined) {
        expect(out).not.toHaveProperty('_meta');
      } else {
        expect(out).toHaveProperty('_meta', { ui: { resourceUri: expectedTemplate } });
      }
    }
  });

  test('run() surfaces transport error as { ok:false, output:"mcp-proxy error: ..." }', async () => {
    const rt = createMcpProxyRuntime({
      serverId: 'xcode',
      mcpTool: { name: 'broken' },
      client: {
        callTool: async () => {
          throw new Error('child gone');
        },
      },
      authorizer: alwaysAuthorized,
    });
    const result = (await rt.run({}, { surface: 'mcp' })) as {
      ok: boolean;
      output: string;
    };
    expect(result.ok).toBe(false);
    expect(result.output).toContain('mcp-proxy error');
    expect(result.output).toContain('child gone');
  });
});

describe('registerMcpClients authorization wiring', () => {
  test('configured authorization grants a registered proxy and shutdown revokes its stable server id', async () => {
    let calls = 0;
    const registered: Array<{ id: string; run: (args: Record<string, unknown>, ctx: { surface: 'mcp' }) => Promise<unknown> }> = [];
    const createClient = () => ({
      start: async () => {},
      listTools: async () => [{ name: 'pay' }],
      callTool: async () => {
        calls += 1;
        return { content: [{ type: 'text', text: 'paid' }] };
      },
      dispose: async () => {},
    });
    const first = await registerMcpClients({
      servers: [{ id: 'remote', transport: 'stdio' as const, command: ['fake'], authorizedTools: ['pay'] }],
      handshakeTimeoutMs: 0,
      logger: { info: () => {}, warn: () => {} },
      createClient,
      registerRuntime: (runtime) => { registered.push(runtime as never); },
    });
    const firstRuntime = registered[0]!;
    expect((await firstRuntime.run({}, { surface: 'mcp' }) as { output: string }).output).toBe('paid');
    expect(calls).toBe(1);

    // ⛔ 허가 상태를 handle 에서 «읽지» 않는다 — 등록된 런타임이 「거부하나」로 관측한다.
    //    그것이 실제로 소비되는 유일한 표면이다.
    await first.shutdown();
    expect((await firstRuntime.run({}, { surface: 'mcp' }) as { classification: string }).classification)
      .toBe('mcp-authorization-denied');
    expect(calls).toBe(1);

    const second = await registerMcpClients({
      servers: [{ id: 'remote', transport: 'stdio' as const, command: ['fake'] }],
      handshakeTimeoutMs: 0,
      logger: { info: () => {}, warn: () => {} },
      createClient,
      registerRuntime: (runtime) => { registered.push(runtime as never); },
    });
    const rereregisteredRuntime = registered[1]!;
    expect((await rereregisteredRuntime.run({}, { surface: 'mcp' }) as { classification: string }).classification)
      .toBe('mcp-authorization-denied');
    expect(calls).toBe(1);
    await second.shutdown();
  });

  test('same server id: one boot shutdown does NOT revoke the other boot grants (per-handle ownership)', async () => {
    let calls = 0;
    const registered: Array<{ run: (args: Record<string, unknown>, ctx: { surface: 'mcp' }) => Promise<unknown> }> = [];
    const createClient = () => ({
      start: async () => {},
      listTools: async () => [{ name: 'pay' }],
      callTool: async () => {
        calls += 1;
        return { content: [{ type: 'text', text: 'paid' }] };
      },
      dispose: async () => {},
    });
    // ⭐ 두 부팅이 «같은 serverId» 로 각각 허가를 받는다. 한쪽을 내려도 다른 쪽이 살아 있어야
    //    「원장을 부팅이 소유한다」가 참이다. ⛔ 전역 원장이면 첫 shutdown 이 둘 다 끊는다.
    const boot = () => registerMcpClients({
      servers: [{ id: 'same-server', transport: 'stdio' as const, command: ['fake'], authorizedTools: ['pay'] }],
      handshakeTimeoutMs: 0,
      logger: { info: () => {}, warn: () => {} },
      createClient,
      registerRuntime: (runtime) => { registered.push(runtime as never); },
    });
    const first = await boot();
    const second = await boot();
    const firstRuntime = registered[0]!;
    const secondRuntime = registered[1]!;

    expect((await firstRuntime.run({}, { surface: 'mcp' }) as { output: string }).output).toBe('paid');
    expect((await secondRuntime.run({}, { surface: 'mcp' }) as { output: string }).output).toBe('paid');
    expect(calls).toBe(2);

    await first.shutdown();
    // 내린 쪽은 거부되고 —
    expect((await firstRuntime.run({}, { surface: 'mcp' }) as { classification: string }).classification)
      .toBe('mcp-authorization-denied');
    // — 같은 id 를 쓰는 «다른 부팅»은 그대로 산다.
    expect((await secondRuntime.run({}, { surface: 'mcp' }) as { output: string }).output).toBe('paid');
    expect(calls).toBe(3);
    await second.shutdown();
    expect((await secondRuntime.run({}, { surface: 'mcp' }) as { classification: string }).classification)
      .toBe('mcp-authorization-denied');
    expect(calls).toBe(3);
  });

  test('registration failing MID-LOOP revokes the already-registered tools of that server', async () => {
    // ⛔⭐ 초판의 이 시험은 Goodhart 였다 — 재시도 때 «별도» authorizer 가 생기므로
    //    catch 의 `revokeServer()` 를 «삭제해도» 통과했다(리뷰 must-fix).
    //    🩹 그 줄이 «실제로 무는» 경우는 하나뿐이다: try 블록이 등록 루프까지 감싸므로
    //    ***일부 툴이 이미 등록된 뒤*** 다음 등록이 던질 때. 그때 grant 를 안 걷으면
    //    「실패한 서버의 툴이 허가된 채 레지스트리에 남는다」.
    //    ⇒ 그 «남은 런타임»을 직접 불러서 거부되는지 본다. catch 의 revoke 를 지우면 이 시험은 깨진다.
    let calls = 0;
    const registered: Array<{ run: (args: Record<string, unknown>, ctx: { surface: 'mcp' }) => Promise<unknown> }> = [];
    const createClient = () => ({
      start: async () => {},
      listTools: async () => [{ name: 'first' }, { name: 'second' }],
      callTool: async () => { calls += 1; return { content: [{ type: 'text', text: 'paid' }] }; },
      dispose: async () => {},
    });
    let seen = 0;
    const failed = await registerMcpClients({
      servers: [{ id: 'half-remote', transport: 'stdio' as const, command: ['fake'], authorizedTools: ['first', 'second'] }],
      handshakeTimeoutMs: 0,
      logger: { info: () => {}, warn: () => {} },
      createClient,
      registerRuntime: (runtime) => {
        seen += 1;
        if (seen === 2) throw new Error('registry unavailable');  // 첫 툴은 «이미 등록됐다»
        registered.push(runtime as never);
      },
    });
    expect(failed.perServer['half-remote']!.status).toBe('failed');
    expect(registered).toHaveLength(1);            // ⇒ 모집단이 0 이 아니다

    expect((await registered[0]!.run({}, { surface: 'mcp' }) as { classification: string }).classification)
      .toBe('mcp-authorization-denied');
    expect(calls).toBe(0);                          // upstream 으로 «나가지 않았다»
    await failed.shutdown();
  });
});

describe('mcpResultToRunResult', () => {
  test('concatenates text content blocks', () => {
    const result: McpToolCallResult = {
      content: [
        { type: 'text', text: 'line1' },
        { type: 'text', text: 'line2' },
      ],
    };
    const out = mcpResultToRunResult(result);
    expect((out as { output: string }).output).toBe('line1\nline2');
  });

  test('surfaces first image block as mediaType + dataB64 (image-content pipeline contract)', () => {
    const result: McpToolCallResult = {
      content: [
        { type: 'text', text: 'sim screenshot' },
        { type: 'image', data: 'BASE64DATA', mimeType: 'image/png' },
      ],
    };
    const out = mcpResultToRunResult(result) as {
      output: string;
      mediaType: string;
      dataB64: string;
    };
    expect(out.mediaType).toBe('image/png');
    expect(out.dataB64).toBe('BASE64DATA');
    expect(out.output).toBe('sim screenshot');
  });

  test('image-content block with media_type alias is also accepted', () => {
    const result: McpToolCallResult = {
      content: [{ type: 'image', data: 'ABC', media_type: 'image/jpeg' }],
    };
    const out = mcpResultToRunResult(result) as { mediaType: string };
    expect(out.mediaType).toBe('image/jpeg');
  });

  test('multiple image blocks → only the FIRST surfaces (single-image contract)', () => {
    const result: McpToolCallResult = {
      content: [
        { type: 'image', data: 'FIRST', mimeType: 'image/png' },
        { type: 'image', data: 'SECOND', mimeType: 'image/png' },
      ],
    };
    const out = mcpResultToRunResult(result) as { dataB64: string };
    expect(out.dataB64).toBe('FIRST');
  });

  test('preserves structuredContent under `structured`', () => {
    const result: McpToolCallResult = {
      content: [],
      structuredContent: { duration_ms: 1234, scheme: 'elanous' },
    };
    const out = mcpResultToRunResult(result) as {
      structured: { duration_ms: number };
    };
    expect(out.structured.duration_ms).toBe(1234);
  });

  test('isError:true surfaces as ok:false', () => {
    const result: McpToolCallResult = {
      content: [{ type: 'text', text: 'build failed' }],
      isError: true,
    };
    const out = mcpResultToRunResult(result) as {
      ok: boolean;
      output: string;
    };
    expect(out.ok).toBe(false);
    expect(out.output).toBe('build failed');
  });

  test('empty content + no structured + no error → output:""', () => {
    const out = mcpResultToRunResult({}) as { output: string };
    expect(out.output).toBe('');
  });

  test('non-text/non-image content blocks are ignored', () => {
    const result: McpToolCallResult = {
      content: [
        { type: 'mystery', extra: 'whatever' } as never,
        { type: 'text', text: 'kept' },
      ],
    };
    const out = mcpResultToRunResult(result) as { output: string };
    expect(out.output).toBe('kept');
  });
});

// ── config → 부팅 왕복 (사후 리뷰가 잡은 회귀의 «재발 방지») ────────
//
// 🔴 **왜 이 시험이 필요했나**: 위 배선 시험들은 `servers: [{...}]` 를 «손으로» 넘겨
//    ***파서를 건너뛴다***. 그래서 `parseMcpServerSpec` 이 `authorizedTools` 를 안 읽어
//    버리는 회귀를 «하나도» 못 잡았고, 실제 config 로는 모든 프록시 툴이 영구 거부됐다.
//    ⇒ 이 시험은 «진짜 config 파일»에서 출발한다.
describe('config → registerMcpClients 왕복 — 허가가 실제로 도달한다', () => {
  test('config 에 적은 authorizedTools 가 등록된 런타임을 «허용»한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-roundtrip-'));
    const cfgPath = join(root, 'config.json');
    try {
      writeFileSync(cfgPath, JSON.stringify({
        mcp: { servers: [{ id: 'remote', transport: 'stdio', command: ['fake'], authorizedTools: ['pay'] }] },
      }));
      resetUserConfig();
      const servers = buildUserConfig(cfgPath).mcp!.servers;
      // ⛔ 여기서 끊기면 아래는 전부 무의미하다 — 회귀의 «진짜» 자리가 이 줄이었다.
      expect(servers[0]!.authorizedTools).toEqual(['pay']);

      let calls = 0;
      const registered: Array<{ run: (a: Record<string, unknown>, c: { surface: 'mcp' }) => Promise<unknown> }> = [];
      const handle = await registerMcpClients({
        servers,
        handshakeTimeoutMs: 0,
        logger: { info: () => {}, warn: () => {} },
        createClient: () => ({
          start: async () => {},
          listTools: async () => [{ name: 'pay' }, { name: 'refund' }],
          callTool: async () => { calls += 1; return { content: [{ type: 'text', text: 'paid' }] }; },
          dispose: async () => {},
        }),
        registerRuntime: (rt) => { registered.push(rt as never); },
      });
      expect(registered).toHaveLength(2);                     // 모집단이 0 이 아니다

      // 허가된 툴은 «실제로» 서버까지 간다
      expect((await registered[0]!.run({}, { surface: 'mcp' }) as { output: string }).output).toBe('paid');
      expect(calls).toBe(1);
      // 같은 서버라도 config 에 «안 적은» 툴은 거부된다 — 허가가 툴 단위인 것도 같이 문다
      expect((await registered[1]!.run({}, { surface: 'mcp' }) as { classification: string }).classification)
        .toBe('mcp-authorization-denied');
      expect(calls).toBe(1);

      await handle.shutdown();
    } finally {
      rmSync(root, { recursive: true, force: true });
      resetUserConfig();
    }
  });
});

// ── 「허가가 하나도 없다」를 «말한다» (금지에는 길을 붙인다) ────────
//
// ⛔ fail-closed 는 «의도»지만, 조용하면 사용자는 「어제 되던 툴이 오늘 안 된다」만 겪고
//    이유도 고치는 법도 모른다. 실제로 운영 config 의 기존 서버들은 authorizedTools 가
//    «없어서» 재시작하는 순간 전 툴이 거부된다.
describe('부팅 — 허가 0 인 서버는 «이름을 대고» 무엇을 적을지까지 말한다', () => {
  const bootWith = async (authorizedTools?: string[]) => {
    const warns: string[] = [];
    const infos: string[] = [];
    const handle = await registerMcpClients({
      servers: [{
        id: 'xcodebuild', transport: 'stdio' as const, command: ['fake'],
        ...(authorizedTools ? { authorizedTools } : {}),
      }],
      handshakeTimeoutMs: 0,
      logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m) },
      createClient: () => ({
        start: async () => {},
        listTools: async () => [{ name: 'build' }, { name: 'test' }],
        callTool: async () => ({ content: [] }),
        dispose: async () => {},
      }),
      registerRuntime: () => {},
    });
    await handle.shutdown();
    return { warns, infos };
  };

  test('허가 0 → 서버 이름 · 툴 수 · 고치는 법을 «전부» 담은 경고', async () => {
    const { warns } = await bootWith();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('xcodebuild');            // 어느 서버인가
    expect(warns[0]).toContain('2 tool(s)');             // 몇 개가 막히나
    expect(warns[0]).toContain('authorizedTools');       // ⭐ 무엇을 적어야 하나
    expect(warns[0]).toContain('"build"');               // ⭐ 실제 이름까지 예시로
    // ⛔ 「복사해 붙일 수 있게」가 참이려면 «붙일 수 있는 것»이어야 한다 —
    //    준 조각이 그 자체로 유효한 JSON 필드여야 하고 `...` 같은 자리표가 없어야 한다.
    expect(warns[0]).not.toContain('...');
    const snippet = warns[0]!.slice(warns[0]!.indexOf('"authorizedTools"'));
    expect(() => JSON.parse(`{${snippet}}`)).not.toThrow();
    expect(JSON.parse(`{${snippet}}`)).toEqual({ authorizedTools: ['build', 'test'] });
  });

  test('일부만 허가되면 차단될 호출 수를 경고하고 연결 요약은 보존한다', async () => {
    const { warns, infos } = await bootWith(['build']);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('1 authorized');
    // ⊕ 연결 요약이 「몇 개가 허가됐나」를 같이 말한다
    expect(infos.some((m) => m.includes('1 authorized'))).toBe(true);
  });

  test('전부 허가되면 요약에 군더더기를 안 붙인다', async () => {
    const { warns, infos } = await bootWith(['build', 'test']);
    expect(warns).toHaveLength(0);
    expect(infos.some((m) => m.includes('authorized'))).toBe(false);
  });

  test('⛔ 서버 id 는 «남의 문자열»이라 이스케이프해서 넣는다 (로그 주입 방어)', async () => {
    const warns: string[] = [];
    const handle = await registerMcpClients({
      // 따옴표·개행이 든 id — 그대로 보간하면 예시 JSON 이 깨지고 로그 줄이 위조된다.
      servers: [{ id: 'ev"il\nINJECTED', transport: 'stdio' as const, command: ['fake'] }],
      handshakeTimeoutMs: 0,
      logger: { info: () => {}, warn: (m) => warns.push(m) },
      createClient: () => ({
        start: async () => {}, listTools: async () => [{ name: 'build' }],
        callTool: async () => ({ content: [] }), dispose: async () => {},
      }),
      registerRuntime: () => {},
    });
    await handle.shutdown();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(JSON.stringify('ev"il\nINJECTED'));   // 이스케이프된 형태로
    // ⛔ 접두 라벨에도 생 개행이 «안» 들어간다 — 본문만 막으면 라벨로 샌다.
    expect(warns[0]).not.toContain('\nINJECTED');
    expect(warns[0].split('\n')).toHaveLength(1);                     // 경고는 «한 줄»이다
  });

  test('관측 boot-summary 가 serverId·toolCount·grantedCount 를 싣는다', async () => {
    const { debug } = await import('../src/debug/log.js');
    const seen: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const spy = spyOn(debug, 'log').mockImplementation(((c: string, e: string, d?: Record<string, unknown>) => {
      seen.push({ category: c, event: e, data: d });
    }) as never);
    try {
      const handle = await registerMcpClients({
        servers: [{ id: 'xcodebuild', transport: 'stdio' as const, command: ['fake'], authorizedTools: ['build'] }],
        handshakeTimeoutMs: 0,
        logger: { info: () => {}, warn: () => {} },
        createClient: () => ({
          start: async () => {}, listTools: async () => [{ name: 'build' }, { name: 'test' }],
          callTool: async () => ({ content: [] }), dispose: async () => {},
        }),
        registerRuntime: () => {},
      });
      await handle.shutdown();
      const hit = seen.find((e) => e.category === 'mcp.authorization' && e.event === 'boot-summary');
      expect(hit).toBeDefined();
      expect(hit!.data).toMatchObject({ serverId: 'xcodebuild', toolCount: 2, grantedCount: 1 });
    } finally {
      spy.mockRestore();
    }
  });
});

// ── 응답 상한 (RFC 계단 ④ · 원격을 열기 «전») ──────────────────────
//
// ⛔⭐ 남의 서버가 얼마를 뱉을지 우리가 모른다. 로컬 stdio 만 붙일 땐 우리가 고른
//    바이너리였지만, 원격은 «남이 운영하는» 응답이 그대로 LLM 맥락으로 들어간다.
describe('capMcpOutput — 상한 · 경고 예산 · structured 취급', () => {
  const limit = { warnTokens: 10, maxTokens: 20 };   // 토큰 추정 = 문자수/4
  const text = (tokens: number) => 'x'.repeat(tokens * 4);

  test('상한 아래면 손대지 않는다 — 경고도 없다', () => {
    let warned = 0;
    const out = capMcpOutput({ output: text(5) }, { limit, onWarn: () => { warned += 1; } });
    expect(out.truncated).toBeUndefined();
    expect(out.output).toHaveLength(20);
    expect(warned).toBe(0);
  });

  test('경고 임계와 상한 «사이»면 경고만 하고 «안 자른다»', () => {
    let warned = 0;
    const out = capMcpOutput({ output: text(15) }, { limit, onWarn: () => { warned += 1; } });
    expect(warned).toBe(1);
    expect(out.truncated).toBeUndefined();      // ⛔ 경고 ≠ 절단
    expect(out.output).toHaveLength(60);
  });

  test('상한을 넘으면 «머리를 남기고» 자르고, 잘렸다는 사실을 «구조»로 남긴다', () => {
    const infos: unknown[] = [];
    const out = capMcpOutput({ output: 'HEAD' + text(100) }, { limit, onTruncate: (i) => infos.push(i) });
    expect(out.truncated).toBe(true);            // 문면이 아니라 «구조»로
    expect(out.output as string).toStartWith('HEAD');   // 꼬리가 아니라 머리를 남긴다
    expect((out.output as string).length).toBe(80);     // maxTokens * 4
    expect(out.originalTokensEstimated).toBeGreaterThan(20);
    expect(infos).toHaveLength(1);
  });

  test('⛔ structured 는 «자르지» 않고 «뺀다» — 잘린 JSON 은 없는 것보다 나쁘다', () => {
    const out = capMcpOutput(
      { output: 'ok', structured: { rows: Array.from({ length: 200 }, (_, i) => ({ i })) } },
      { limit },
    );
    expect(out.structured).toBeUndefined();
    expect(out.structuredDropped).toBe(true);    // ⭐ 「없다」와 「빼앗겼다」를 가른다
    expect(out.truncated).toBe(true);
  });

  test('structured 만으로 상한을 넘어도 텍스트는 온전히 남는다', () => {
    const out = capMcpOutput(
      { output: 'small', structured: { blob: 'y'.repeat(400) } },
      { limit },
    );
    expect(out.output).toBe('small');            // 텍스트는 상한 아래라 안 잘린다
    expect(out.structuredDropped).toBe(true);
  });

  test('⛔ 경고 예산 — 같은 런타임이 매 호출마다 짖지 않는다', async () => {
    const seen: string[] = [];
    const rt = createMcpProxyRuntime({
      serverId: 'remote', mcpTool: { name: 'chatty' },
      client: { callTool: async () => ({ content: [{ type: 'text', text: 'z'.repeat(60) }] }) },
      authorizer: alwaysAuthorized,
      _outputLimitForTest: { warnTokens: 10, maxTokens: 1000 },
    });
    const { debug } = await import('../src/debug/log.js');
    const spy = spyOn(debug, 'log').mockImplementation(((c: string, e: string) => {
      if (c === 'mcp.output') seen.push(e);
    }) as never);
    try {
      await rt.run({}, { surface: 'mcp' });
      await rt.run({}, { surface: 'mcp' });
      await rt.run({}, { surface: 'mcp' });
      expect(seen.filter((e) => e === 'over-warn-threshold')).toHaveLength(1);   // 3번 불렀는데 1번
    } finally {
      spy.mockRestore();
    }
  });
});

// ── 상한이 «런타임 경로»에서 실제로 무나 (리뷰 should-fix ⊕ must-fix ①) ──
//
// ⛔ 위 단위시험은 `capMcpOutput` 을 «직접» 부른다 — 런타임이 그것을 «안 부르고»
//    원본을 그대로 흘려도 통과한다. ⇒ 실제 run() 을 태워서 결과와 관측을 함께 본다.
describe('런타임 경로 상한 — 성공·실패 «둘 다» 같은 상한을 지난다', () => {
  const runWith = async (client: { callTool: () => Promise<never> | Promise<unknown> }) => {
    const { debug } = await import('../src/debug/log.js');
    const seen: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const spy = spyOn(debug, 'log').mockImplementation(((c: string, e: string, d?: Record<string, unknown>) => {
      if (c === 'mcp.output') seen.push({ event: e, data: d });
    }) as never);
    try {
      const rt = createMcpProxyRuntime({
        serverId: 'remote', mcpTool: { name: 'huge' },
        client: client as never, authorizer: alwaysAuthorized,
        _outputLimitForTest: { warnTokens: 10, maxTokens: 20 },
      });
      const out = await rt.run({}, { surface: 'mcp' }) as Record<string, unknown>;
      return { out, seen };
    } finally { spy.mockRestore(); }
  };

  test('성공 응답이 상한을 넘으면 잘리고, 관측과 구조가 «함께» 남는다', async () => {
    const { out, seen } = await runWith({
      callTool: async () => ({ content: [{ type: 'text', text: 'A'.repeat(400) }] }),
    });
    expect(out.truncated).toBe(true);
    expect((out.output as string).length).toBe(80);
    expect(seen.map((s) => s.event)).toContain('truncated');
    expect(seen.find((s) => s.event === 'truncated')!.data).toMatchObject({
      serverId: 'remote', toolName: 'huge',
    });
  });

  test('⛔ «실패» 응답도 같은 상한을 지난다 — 오류 문면도 남의 서버가 뱉은 것이다', async () => {
    // McpServerError.message 는 상대가 준 JSON-RPC error message 를 그대로 나른다.
    // 성공만 막고 실패를 열어 두면 «실패 응답으로» 맥락이 탄다(리뷰 must-fix).
    const { out, seen } = await runWith({
      callTool: async () => { throw new McpServerError(-32000, 'B'.repeat(400)); },
    });
    expect(out.classification).toBe('mcp-server-error');
    expect(out.truncated).toBe(true);
    expect((out.output as string).length).toBe(80);
    expect(seen.map((s) => s.event)).toContain('truncated');
  });

  test('전송 오류 문면도 마찬가지다', async () => {
    const { out } = await runWith({
      callTool: async () => { throw new Error('C'.repeat(400)); },
    });
    expect(out.classification).toBe('mcp-transport-error');
    expect(out.truncated).toBe(true);
  });
});

// ── ⛔ 「못 잰다」를 「작다」로 읽지 않는다 (2R must-fix) ────────────
describe('capMcpOutput — 직렬화 못 하는 structured 는 fail-closed 로 «뺀다»', () => {
  const limit = { warnTokens: 10, maxTokens: 20 };

  test('순환 참조 — 0토큰으로 통과하지 «않고» 빠진다', () => {
    const circular: Record<string, unknown> = { name: 'x' };
    circular.self = circular;                       // JSON.stringify 가 던진다
    const out = capMcpOutput({ output: 'small', structured: circular }, { limit });
    expect(out.structured).toBeUndefined();
    expect(out.structuredDropped).toBe(true);
    expect(out.structuredUnmeasurable).toBe(true);  // ⭐ 「넘쳐서」와 「못 재서」를 가른다
    expect(out.output).toBe('small');               // 텍스트는 온전하다
  });

  test('던지는 toJSON 도 같다', () => {
    const hostile = { toJSON() { throw new Error('nope'); } };
    const out = capMcpOutput({ output: 'small', structured: hostile }, { limit });
    expect(out.structuredDropped).toBe(true);
    expect(out.structuredUnmeasurable).toBe(true);
  });

  test('직렬화가 undefined 를 내는 값(함수 등)도 «못 잰 것»으로 다룬다', () => {
    const out = capMcpOutput({ output: 'small', structured: () => 1 }, { limit });
    expect(out.structuredDropped).toBe(true);
    expect(out.structuredUnmeasurable).toBe(true);
  });

  test('⛔ 정상 structured 는 이 경로로 안 빠진다 — 과잉 차단이 아니다', () => {
    const out = capMcpOutput({ output: 'small', structured: { a: 1 } }, { limit });
    expect(out.structured).toEqual({ a: 1 });
    expect(out.structuredDropped).toBeUndefined();
    expect(out.structuredUnmeasurable).toBeUndefined();
  });

  test('⛔ 기본 상한은 «얼려» 둔다 — import 가 프로덕션 상한을 못 바꾼다', () => {
    expect(Object.isFrozen(DEFAULT_MCP_OUTPUT_LIMIT)).toBe(true);
    expect(() => {
      (DEFAULT_MCP_OUTPUT_LIMIT as unknown as { maxTokens: number }).maxTokens = 1;
    }).toThrow();
    expect(DEFAULT_MCP_OUTPUT_LIMIT.maxTokens).toBe(25_000);
  });
});

// ── ⛔ 못 잰 structured 가 «텍스트 상한을 건너뛰지» 않는다 (3R must-fix) ──
describe('capMcpOutput — structured 를 뺀 «뒤»에도 텍스트는 같은 상한을 지난다', () => {
  const limit = { warnTokens: 10, maxTokens: 20 };

  test('순환 structured ⊕ 거대한 텍스트 — 셋이 «함께» 남는다', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const events: string[] = [];
    const out = capMcpOutput(
      { output: 'HEAD' + 'z'.repeat(400), structured: circular },
      { limit, onTruncate: () => events.push('truncated'), onStructuredDropped: () => events.push('dropped') },
    );
    // ⛔ 초판은 여기서 «조기 반환»해 텍스트가 상한을 통째로 건너뛰었다.
    expect((out.output as string).length).toBe(80);          // maxTokens * 4
    expect(out.output as string).toStartWith('HEAD');        // 머리를 남긴다
    expect(out.structuredDropped).toBe(true);
    expect(out.structuredUnmeasurable).toBe(true);
    expect(out.truncated).toBe(true);
    // ⭐ 두 사건이 «따로» 관측된다 — 섞으면 「몇 번 잘렸나」가 오염된다
    expect(events).toEqual(['dropped', 'truncated']);
  });

  test('순환 structured ⊕ 작은 텍스트 — 텍스트는 온전하고 «절단» 이벤트는 안 난다', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const events: string[] = [];
    const out = capMcpOutput(
      { output: 'tiny', structured: circular },
      { limit, onTruncate: () => events.push('truncated'), onStructuredDropped: () => events.push('dropped') },
    );
    expect(out.output).toBe('tiny');
    expect(out.structuredUnmeasurable).toBe(true);
    expect(out.truncated).toBe(true);                        // 응답이 «줄긴» 했다
    expect(events).toEqual(['dropped']);                     // ⛔ 절단은 «안» 일어났다
  });

  test('런타임 경로에서도 같다 — 관측 둘이 각각 남는다', async () => {
    const { debug } = await import('../src/debug/log.js');
    const seen: string[] = [];
    const spy = spyOn(debug, 'log').mockImplementation(((c: string, e: string) => {
      if (c === 'mcp.output') seen.push(e);
    }) as never);
    try {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const rt = createMcpProxyRuntime({
        serverId: 'remote', mcpTool: { name: 'hostile' },
        client: { callTool: async () => ({ content: [{ type: 'text', text: 'q'.repeat(400) }], structuredContent: circular }) },
        authorizer: alwaysAuthorized,
        _outputLimitForTest: { warnTokens: 10, maxTokens: 20 },
      });
      const out = await rt.run({}, { surface: 'mcp' }) as Record<string, unknown>;
      expect((out.output as string).length).toBe(80);
      expect(seen).toContain('structured-dropped');
      expect(seen).toContain('truncated');
    } finally { spy.mockRestore(); }
  });
});

// ── 4R must-fix ⊕ should-fix — 사건 분리 ⊕ 상한 값 자체 방어 ────────
describe('capMcpOutput — 절단 사건은 «텍스트가 실제로 잘렸을 때만»', () => {
  const limit = { warnTokens: 10, maxTokens: 20 };

  test('measurable structured 만 빠지고 텍스트는 손 안 댔으면 truncated 이벤트가 «안» 난다', () => {
    const events: string[] = [];
    const out = capMcpOutput(
      { output: 'tiny', structured: { blob: 'y'.repeat(400) } },   // structured 만으로 상한 초과
      { limit, onTruncate: () => events.push('truncated'), onStructuredDropped: (i) => events.push('dropped:' + i.reason) },
    );
    expect(out.output).toBe('tiny');                 // 텍스트는 온전
    expect(out.structuredDropped).toBe(true);
    expect(events).toEqual(['dropped:over-limit']);   // ⛔ truncated 는 «안» 난다
    expect(out.truncated).toBe(true);                // 표지는 「응답이 줄었다」로 남는다
  });

  test('텍스트가 잘리면 그때만 truncated 이벤트', () => {
    const events: string[] = [];
    capMcpOutput({ output: 'z'.repeat(400) }, { limit, onTruncate: () => events.push('truncated') });
    expect(events).toEqual(['truncated']);
  });

  test('런타임 경로에서도 같다 — structured 만 빠지면 mcp.output:truncated 가 안 뜬다', async () => {
    const { debug } = await import('../src/debug/log.js');
    const seen: string[] = [];
    const spy = spyOn(debug, 'log').mockImplementation(((c: string, e: string) => {
      if (c === 'mcp.output') seen.push(e);
    }) as never);
    try {
      const rt = createMcpProxyRuntime({
        serverId: 'remote', mcpTool: { name: 'bigjson' },
        client: { callTool: async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { blob: 'y'.repeat(400) } }) },
        authorizer: alwaysAuthorized,
        _outputLimitForTest: { warnTokens: 10, maxTokens: 20 },
      });
      await rt.run({}, { surface: 'mcp' });
      expect(seen).toContain('structured-dropped');
      expect(seen).not.toContain('truncated');
    } finally { spy.mockRestore(); }
  });
});

describe('normalizeMcpOutputLimit — 상한 값이 상한을 «무력화»하지 못한다', () => {
  test('⛔ NaN 은 절단을 통째로 없앤다 — 기본값으로 되돌린다', () => {
    // 🧪 근거: `text.length > NaN * 4` 는 «항상 거짓»이라 어떤 길이도 안 잘린다.
    expect(normalizeMcpOutputLimit({ maxTokens: NaN })).toEqual(DEFAULT_MCP_OUTPUT_LIMIT);
    const out = capMcpOutput({ output: 'z'.repeat(200_000) }, { limit: { warnTokens: 10, maxTokens: NaN } });
    expect(out.truncated).toBe(true);                 // 우회되지 않는다
  });

  test('음수·비정수·Infinity 도 정규화된다', () => {
    expect(normalizeMcpOutputLimit({ maxTokens: -5 }).maxTokens).toBe(DEFAULT_MCP_OUTPUT_LIMIT.maxTokens);
    expect(normalizeMcpOutputLimit({ maxTokens: 12.7 }).maxTokens).toBe(12);
    expect(normalizeMcpOutputLimit({ maxTokens: Infinity }).maxTokens).toBe(DEFAULT_MCP_OUTPUT_LIMIT.maxTokens);
  });

  test('warnTokens 는 maxTokens 를 못 넘는다 — 넘기면 경고가 영영 안 난다', () => {
    expect(normalizeMcpOutputLimit({ warnTokens: 999, maxTokens: 20 })).toEqual({ warnTokens: 20, maxTokens: 20 });
  });

  test('안 주면 기본값', () => {
    expect(normalizeMcpOutputLimit(undefined)).toEqual(DEFAULT_MCP_OUTPUT_LIMIT);
  });
});

// ── 기본값 «배선» 회귀 방어 (5R should-fix) ────────────────────────
//
// ⛔ 위 시험들은 전부 `_outputLimitForTest` 로 상한을 낮춰서 잰다 — 이음매가 끊겨도,
//    기본값이 런타임에 «안 꽂혀도» 통과한다. ⇒ 이음매 «없이» 기본 상한이 무는지 직접 문다.
//    (오늘 이 저장소가 배운 형태: 「타입에 있다」와 「경로가 돈다」는 다른 값이다.)
describe('기본 상한이 이음매 «없이» 런타임에 꽂혀 있다', () => {
  test('_outputLimitForTest 를 안 주면 25,000 토큰 상한이 실제로 문다', async () => {
    const huge = 'w'.repeat(DEFAULT_MCP_OUTPUT_LIMIT.maxTokens * 4 + 10_000);
    const rt = createMcpProxyRuntime({
      serverId: 'remote', mcpTool: { name: 'firehose' },
      client: { callTool: async () => ({ content: [{ type: 'text', text: huge }] }) },
      authorizer: alwaysAuthorized,
      // ⛔ 이음매를 «주지 않는다» — 그것이 이 시험의 이유다.
    });
    const out = await rt.run({}, { surface: 'mcp' }) as Record<string, unknown>;
    expect(out.truncated).toBe(true);
    expect((out.output as string).length).toBe(DEFAULT_MCP_OUTPUT_LIMIT.maxTokens * 4);
    expect(out.originalTokensEstimated).toBeGreaterThan(DEFAULT_MCP_OUTPUT_LIMIT.maxTokens);
  });

  test('기본 상한 아래면 이음매 없이도 손대지 않는다 — 과잉 절단이 아니다', async () => {
    const rt = createMcpProxyRuntime({
      serverId: 'remote', mcpTool: { name: 'normal' },
      client: { callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
      authorizer: alwaysAuthorized,
    });
    const out = await rt.run({}, { surface: 'mcp' }) as Record<string, unknown>;
    expect(out.output).toBe('ok');
    expect(out.truncated).toBeUndefined();
  });
});
