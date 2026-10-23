// ⛔ 이 파일이 있는 이유 — 「프록시가 맞나」가 아니라 **«생산 진입점이 그 프록시를 켜나»**.
//
// classic TUI 는 `registerAllDefaultToolRuntimes()` 하나로 부팅한다(`src/dashboard/index.ts`).
// CLASSIC-IDLE-MCP-LAZY(0.2.35)는 그 진입점의 인자(`mcpLazyBoot`)로만 켜지므로, 검증도
// 프록시 내부가 아니라 **이 진입점을 지나서** 재야 한다 — 아니면 「심은 뚫려 있고 꽂는
// 사람이 없다」(F38)를 시험이 못 문다.

import { afterEach, describe, expect, test } from 'bun:test';
import type { McpServerSpec } from '../user-config.js';
import { registerAllDefaultToolRuntimes, type RegisterAllDefaultToolRuntimesOpts } from './index.js';
import type { McpToolIndex } from '../nexus/boot/register-mcp-clients.js';
import {
  getMcpProxyBootstrapHandle,
  setMcpProxyBootstrapOptsForTest,
  _resetMcpProxyBootstrapForTest,
} from './mcp-proxy-bootstrap.js';
import { _resetToolRuntimeRegistryForTest, dispatchToolByName, listToolRuntimes } from './registry.js';

const ctx = { surface: 'tui' as const };

afterEach(() => {
  setMcpProxyBootstrapOptsForTest(null);
  _resetMcpProxyBootstrapForTest();
  _resetToolRuntimeRegistryForTest();
});

function stdioServer(id: string, tools: string[]): McpServerSpec {
  return { id, transport: 'stdio', command: ['fake'], authorizedTools: tools };
}

function fakeClient(tools: Array<{ name: string; description?: string }>, calls?: string[], start?: () => Promise<void>) {
  return {
    start: start ?? (async () => {}),
    listTools: async () => tools,
    callTool: async (name: string) => {
      calls?.push(name);
      return { content: [{ type: 'text' as const, text: `ran:${name}` }] };
    },
    dispose: async () => {},
  };
}

describe('registerAllDefaultToolRuntimes — 생산 진입점 배선', () => {
  test('기본 부팅이 bootstrap 에 닿아 설정된 툴이 tui 에 뜨고 호출된다', async () => {
    const calls: string[] = [];
    setMcpProxyBootstrapOptsForTest({
      servers: [stdioServer('aside', ['repl'])],
      handshakeTimeoutMs: 0,
      createClient: () => fakeClient([{ name: 'repl' }], calls),
    });
    registerAllDefaultToolRuntimes();
    const handle = getMcpProxyBootstrapHandle();
    expect(handle).toBeDefined();
    await handle!.ready;
    expect(listToolRuntimes('tui').map((rt) => rt.id)).toContain('aside.repl');
    const result = await dispatchToolByName('aside.repl', {}, ctx);
    expect(result).toMatchObject({ output: 'ran:repl' });
    expect(calls).toEqual(['repl']);
  });

  test('⛔ 기본 호출(인자 없음)은 «즉시 기동» 그대로다 — 데몬·mcp serve 무변경', async () => {
    const starts: string[] = [];
    setMcpProxyBootstrapOptsForTest({
      servers: [stdioServer('aside', ['repl'])],
      handshakeTimeoutMs: 0,
      createClient: (spec) =>
        fakeClient([{ name: 'repl' }], undefined, async () => {
          starts.push(spec.id);
        }),
      toolIndexStore: {
        read: () => ({ aside: [{ name: 'repl' }] }),
        write: () => {
          /* 인덱스는 지연 기동에서만 쓰인다 */
        },
      },
    });
    registerAllDefaultToolRuntimes();
    const handle = getMcpProxyBootstrapHandle()!;
    await handle.ready;
    expect(starts).toEqual(['aside']);
    expect(handle.snapshot().perServer['aside']).toEqual({ status: 'ready', toolCount: 1 });
  });

  test('classic TUI(mcpLazyBoot)는 기동 때 자식 0 · 첫 도구 호출에 1회만 뜬다', async () => {
    const starts: string[] = [];
    const calls: string[] = [];
    const written: McpToolIndex[] = [];
    const lazy: RegisterAllDefaultToolRuntimesOpts = { mcpLazyBoot: true };
    setMcpProxyBootstrapOptsForTest({
      servers: [stdioServer('aside', ['repl'])],
      handshakeTimeoutMs: 0,
      createClient: (spec) =>
        fakeClient([{ name: 'repl' }], calls, async () => {
          starts.push(spec.id);
        }),
      toolIndexStore: {
        read: () => ({ aside: [{ name: 'repl', description: 'previous boot' }] }),
        write: (index) => {
          written.push(index);
        },
      },
    });
    registerAllDefaultToolRuntimes(lazy);
    const handle = getMcpProxyBootstrapHandle();
    await handle!.ready;
    // 기동 직후: 자식 0 · 목록은 지난 부팅이 남긴 인덱스 그대로.
    expect(starts).toEqual([]);
    expect(handle!.snapshot().perServer['aside']).toEqual({ status: 'ready', toolCount: 1, deferred: true });
    expect(listToolRuntimes('tui').map((rt) => rt.id)).toContain('aside.repl');
    // 첫 도구 호출: 그때 한 번만 뜬다.
    const first = await dispatchToolByName('aside.repl', {}, ctx);
    expect(first).toMatchObject({ output: 'ran:repl' });
    expect(starts).toEqual(['aside']);
    expect(calls).toEqual(['repl']);
    expect(written).toEqual([{ aside: [{ name: 'repl' }] }]);
    // 두 번째 호출은 이미 뜬 자식을 쓴다 — 재기동 없음.
    await dispatchToolByName('aside.repl', {}, ctx);
    expect(starts).toEqual(['aside']);
  });

  test('두 번째 호출도 같은 부팅 핸들을 재사용한다 (자식 중복 기동 0)', async () => {
    const starts: string[] = [];
    setMcpProxyBootstrapOptsForTest({
      servers: [stdioServer('aside', ['repl'])],
      handshakeTimeoutMs: 0,
      createClient: (spec) =>
        fakeClient([{ name: 'repl' }], undefined, async () => {
          starts.push(spec.id);
        }),
      toolIndexStore: {
        read: () => ({ aside: [{ name: 'repl' }] }),
        write: () => {},
      },
    });
    registerAllDefaultToolRuntimes({ mcpLazyBoot: true });
    const first = getMcpProxyBootstrapHandle();
    registerAllDefaultToolRuntimes({ mcpLazyBoot: true });
    expect(getMcpProxyBootstrapHandle()).toBe(first);
    await first!.ready;
    expect(starts).toEqual([]);
    expect(listToolRuntimes('tui').map((rt) => rt.id)).toContain('aside.repl');
  });
});
