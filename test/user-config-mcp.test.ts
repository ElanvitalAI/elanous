// ── user-config: mcp.servers sparse parse ──
//
// Validates that the `mcp` sub-tree in `~/.elanous/config.json`
// parses correctly using the same sparse pattern as `notifications.apns`.
// Goal: invalid entries are silently dropped (graceful boot) and the
// whole `mcp` field disappears when no valid server survives.
//
// Intentional exception: a URL with no transport is named in a diagnostic
// (entry id + `http`) instead of vanishing silently.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildUserConfig,
  formatMcpUrlWithoutTransportDiagnostic,
  resetUserConfig,
} from '../src/user-config';
import type { McpServerSpec } from '../src/user-config';

function expectStdio(spec: McpServerSpec | undefined): Extract<McpServerSpec, { transport: 'stdio' }> {
  expect(spec?.transport).toBe('stdio');
  if (spec?.transport !== 'stdio') throw new Error('expected stdio');
  return spec;
}

function expectHttp(spec: McpServerSpec | undefined): Extract<McpServerSpec, { transport: 'http' }> {
  expect(spec?.transport).toBe('http');
  if (spec?.transport !== 'http') throw new Error('expected http');
  return spec;
}

let root: string;
let cfgPath: string;

function write(json: unknown): void {
  writeFileSync(
    cfgPath,
    typeof json === 'string' ? json : JSON.stringify(json),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'user-config-mcp-'));
  cfgPath = join(root, 'config.json');
  resetUserConfig();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetUserConfig();
});

describe('user-config mcp.servers', () => {
  test('missing mcp → undefined (sparse · zero-config default)', () => {
    write({});
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.mcp).toBeUndefined();
  });

  test('valid pair (xcode + xcodebuild) parses fully', () => {
    write({
      mcp: {
        servers: [
          { id: 'xcode', command: ['xcrun', 'mcpbridge'] },
          {
            id: 'xcodebuild',
            command: ['xcodebuildmcp', 'mcp'],
            enabled: true,
          },
        ],
      },
    });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.mcp?.servers.length).toBe(2);
    expect(cfg.mcp?.servers[0]).toEqual({
      id: 'xcode',
      transport: 'stdio',
      command: ['xcrun', 'mcpbridge'],
    });
    expect(cfg.mcp?.servers[1]).toEqual({
      id: 'xcodebuild',
      transport: 'stdio',
      command: ['xcodebuildmcp', 'mcp'],
      enabled: true,
    });
  });

  test('legacy command-only entry normalizes to stdio (one item, child-process transport)', () => {
    write({
      mcp: {
        servers: [{ id: 'xcode', command: ['xcrun', 'mcpbridge'] }],
      },
    });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.mcp?.servers.length).toBe(1);
    expect(expectStdio(cfg.mcp?.servers[0]).command).toEqual(['xcrun', 'mcpbridge']);
  });

  test('explicit http transport keeps the url character-for-character', () => {
    const url = 'https://mcp.example.com/v1?token=a%2Fb';
    write({
      mcp: {
        servers: [{ id: 'remote', transport: 'http', url }],
      },
    });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.mcp?.servers.length).toBe(1);
    const remote = expectHttp(cfg.mcp?.servers[0]);
    expect(remote.url).toBe(url);
    expect('command' in remote).toBe(false);
  });

  test('streamable-http is an alias of http', () => {
    write({
      mcp: {
        servers: [{
          id: 'remote',
          transport: 'streamable-http',
          url: 'https://mcp.example.com',
        }],
      },
    });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.mcp?.servers.length).toBe(1);
    expect(expectHttp(cfg.mcp?.servers[0]).url).toBe('https://mcp.example.com');
  });

  test('raw HTTP OAuth fields are trimmed into the parsed HTTP spec', () => {
    write({
      mcp: {
        servers: [{
          id: 'remote',
          transport: 'http',
          url: 'https://mcp.example.com',
          oauthIssuer: ' https://issuer.example.com ',
          oauthTokenEndpoint: ' https://issuer.example.com/token ',
        }],
      },
    });
    const remote = expectHttp(buildUserConfig(cfgPath).mcp?.servers[0]);
    expect(remote.oauthIssuer).toBe('https://issuer.example.com');
    expect(remote.oauthTokenEndpoint).toBe('https://issuer.example.com/token');
  });

  test('blank raw HTTP OAuth fields normalize to absent', () => {
    write({
      mcp: {
        servers: [{
          id: 'remote',
          transport: 'http',
          url: 'https://mcp.example.com',
          oauthIssuer: '   ',
          oauthTokenEndpoint: '',
        }],
      },
    });
    const remote = expectHttp(buildUserConfig(cfgPath).mcp?.servers[0]);
    expect(remote.oauthIssuer).toBeUndefined();
    expect(remote.oauthTokenEndpoint).toBeUndefined();
    expect('oauthIssuer' in remote).toBe(false);
    expect('oauthTokenEndpoint' in remote).toBe(false);
  });

  test('HTTP bearer token environment-variable name is trimmed and blank values are omitted', () => {
    write({
      mcp: {
        servers: [{
          id: 'remote',
          transport: 'http',
          url: 'https://mcp.example.com',
          bearerTokenEnv: ' ELANOUS_MCP_BEARER ',
        }],
      },
    });
    expect(expectHttp(buildUserConfig(cfgPath).mcp?.servers[0]).bearerTokenEnv).toBe('ELANOUS_MCP_BEARER');

    write({
      mcp: {
        servers: [{
          id: 'remote',
          transport: 'http',
          url: 'https://mcp.example.com',
          bearerTokenEnv: '   ',
        }],
      },
    });
    const remote = expectHttp(buildUserConfig(cfgPath).mcp?.servers[0]);
    expect(remote.bearerTokenEnv).toBeUndefined();
    expect('bearerTokenEnv' in remote).toBe(false);
  });

  test('url without transport emits a named diagnostic containing the id and http', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(String(args[0] ?? '')); };
    try {
      write({
        mcp: {
          servers: [{ id: 'copied', url: 'https://mcp.example.com' }],
        },
      });
      const cfg = buildUserConfig(cfgPath);
      expect(cfg.mcp).toBeUndefined();
      const expected = formatMcpUrlWithoutTransportDiagnostic('copied');
      expect(expected).toContain('copied');
      expect(expected).toContain('http');
      expect(warns.some((w) => w.includes('copied') && w.includes('http'))).toBe(true);
      expect(warns).toContain(expected);
    } finally {
      console.warn = orig;
    }
  });

  test('explicit invalid transport with a url is dropped silently (not the url-without-transport warning)', () => {
    const invalidTransports = [null, 42, '', '   '] as const;
    for (const transport of invalidTransports) {
      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (...args: unknown[]) => { warns.push(String(args[0] ?? '')); };
      try {
        write({
          mcp: {
            servers: [{
              id: `bad-${String(transport)}`,
              transport,
              url: 'https://mcp.example.com',
            }],
          },
        });
        const cfg = buildUserConfig(cfgPath);
        expect(cfg.mcp).toBeUndefined();
        expect(warns).toEqual([]);
      } finally {
        console.warn = orig;
      }
    }
  });

  test('malformed entries stay silent — diagnostic is not the url-without-transport message', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(String(args[0] ?? '')); };
    try {
      write({
        mcp: {
          servers: [
            { command: ['lonely'] },
            { id: 'lone' },
            { id: 'bad', transport: 'sse', url: 'https://x' },
            { id: 'http-no-url', transport: 'http' },
          ],
        },
      });
      const cfg = buildUserConfig(cfgPath);
      expect(cfg.mcp).toBeUndefined();
      const trap = formatMcpUrlWithoutTransportDiagnostic('lone');
      expect(warns.some((w) => w.includes('http') && w.includes('lone'))).toBe(false);
      expect(warns).not.toContain(trap);
    } finally {
      console.warn = orig;
    }
  });

  test('explicit stdio + url is a malformed mix and is dropped silently', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(String(args[0] ?? '')); };
    try {
      write({
        mcp: {
          servers: [{
            id: 'mixed-stdio',
            transport: 'stdio',
            command: ['x'],
            url: 'https://mcp.example.com',
          }],
        },
      });
      const cfg = buildUserConfig(cfgPath);
      expect(cfg.mcp).toBeUndefined();
      expect(warns).toEqual([]);
    } finally {
      console.warn = orig;
    }
  });

  test('omitted-transport {id, command, url} is mixed malformed: dropped with no warning', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(String(args[0] ?? '')); };
    try {
      write({
        mcp: {
          servers: [
            { id: 'mixed-legacy', command: ['x'], url: 'https://mcp.example.com' },
            { id: 'ok-command', command: ['x'] },
            { id: 'ok-http', transport: 'http', url: 'https://mcp.example.com' },
            { id: 'copied', url: 'https://mcp.example.com' },
          ],
        },
      });
      const cfg = buildUserConfig(cfgPath);
      expect(cfg.mcp?.servers.length).toBe(2);
      expect(cfg.mcp?.servers.map((s) => s.id)).toEqual(['ok-command', 'ok-http']);
      expect(expectStdio(cfg.mcp?.servers[0]).command).toEqual(['x']);
      expect(expectHttp(cfg.mcp?.servers[1]).url).toBe('https://mcp.example.com');
      expect(warns.some((w) => w.includes('mixed-legacy'))).toBe(false);
      expect(warns).not.toContain(formatMcpUrlWithoutTransportDiagnostic('mixed-legacy'));
      expect(warns.some((w) => w.includes('copied') && w.includes('http'))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  test('explicit http + command is a malformed mix and is dropped silently', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(String(args[0] ?? '')); };
    try {
      write({
        mcp: {
          servers: [{
            id: 'mixed-http',
            transport: 'http',
            url: 'https://mcp.example.com',
            command: ['x'],
          }],
        },
      });
      const cfg = buildUserConfig(cfgPath);
      expect(cfg.mcp).toBeUndefined();
      expect(warns).toEqual([]);
    } finally {
      console.warn = orig;
    }
  });

  test('mixed opposite-field entries next to a valid entry: only the valid entry survives', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(String(args[0] ?? '')); };
    try {
      write({
        mcp: {
          servers: [
            {
              id: 'mixed-stdio',
              transport: 'stdio',
              command: ['x'],
              url: 'https://mcp.example.com',
            },
            {
              id: 'mixed-http',
              transport: 'http',
              url: 'https://mcp.example.com',
              command: ['x'],
            },
            { id: 'ok', command: ['x'] },
          ],
        },
      });
      const cfg = buildUserConfig(cfgPath);
      expect(cfg.mcp?.servers.length).toBe(1);
      expect(cfg.mcp?.servers[0]?.id).toBe('ok');
      expect(expectStdio(cfg.mcp?.servers[0]).command).toEqual(['x']);
      expect(warns).toEqual([]);
    } finally {
      console.warn = orig;
    }
  });

  test('url-without-transport next to a valid entry: only the valid entry survives', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(String(args[0] ?? '')); };
    try {
      write({
        mcp: {
          servers: [
            { id: 'copied', url: 'https://mcp.example.com' },
            { id: 'ok', command: ['x'] },
          ],
        },
      });
      const cfg = buildUserConfig(cfgPath);
      expect(cfg.mcp?.servers.length).toBe(1);
      expect(cfg.mcp?.servers[0]?.id).toBe('ok');
      expect(expectStdio(cfg.mcp?.servers[0]).command).toEqual(['x']);
      expect(warns.some((w) => w.includes('copied') && w.includes('http'))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  test('http enabled:false is preserved (config kept · spawn suppressed)', () => {
    write({
      mcp: {
        servers: [{
          id: 'remote',
          transport: 'http',
          url: 'https://mcp.example.com',
          enabled: false,
        }],
      },
    });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.mcp?.servers[0]?.enabled).toBe(false);
    expect(cfg.mcp?.servers[0]?.transport).toBe('http');
  });

  test('enabled:false is preserved (config kept · spawn suppressed)', () => {
    write({
      mcp: {
        servers: [
          { id: 'staging', command: ['fake'], enabled: false },
        ],
      },
    });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.mcp?.servers[0]?.enabled).toBe(false);
  });

  test('entry missing id is dropped silently', () => {
    write({
      mcp: {
        servers: [
          { command: ['lonely'] },
          { id: 'ok', command: ['x'] },
        ],
      },
    });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.mcp?.servers.length).toBe(1);
    expect(cfg.mcp?.servers[0]?.id).toBe('ok');
  });

  test('entry with non-array command is dropped', () => {
    write({
      mcp: {
        servers: [
          { id: 'bad', command: 'should-be-array' },
          { id: 'ok', command: ['x'] },
        ],
      },
    });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.mcp?.servers.length).toBe(1);
    expect(cfg.mcp?.servers[0]?.id).toBe('ok');
  });

  test('entry with empty-string command part is dropped (no degenerate argv)', () => {
    write({
      mcp: {
        servers: [
          { id: 'bad', command: ['ok', ''] },
          { id: 'fine', command: ['x'] },
        ],
      },
    });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.mcp?.servers.length).toBe(1);
    expect(cfg.mcp?.servers[0]?.id).toBe('fine');
  });

  test('all entries invalid → mcp disappears entirely', () => {
    write({
      mcp: {
        servers: [
          { command: [] },
          { id: 'lone' },
        ],
      },
    });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.mcp).toBeUndefined();
  });

  test('servers field not an array → mcp undefined', () => {
    write({ mcp: { servers: 'oops' } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.mcp).toBeUndefined();
  });

  test('mcp itself an array → undefined (graceful)', () => {
    write({ mcp: [] });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.mcp).toBeUndefined();
  });

  test('global and per-server handshakeTimeoutMs values parse as finite millisecond integers', () => {
    write({
      mcp: {
        handshakeTimeoutMs: 8_000.9,
        servers: [
          // ⛔ 0 은 «유효한 마감»이 아니다 — 아래 [주] 참고
          { id: 'legacy', command: ['legacy'], handshakeTimeoutMs: 0 },
          { id: 'stdio', transport: 'stdio', command: ['stdio'], handshakeTimeoutMs: 1_234.9 },
          { id: 'http', transport: 'http', url: 'https://mcp.example.com', handshakeTimeoutMs: 5_678 },
        ],
      },
    });
    const mcp = buildUserConfig(cfgPath).mcp!;
    expect(mcp.handshakeTimeoutMs).toBe(8_000);
    // [주] 0 은 «즉시 초과»라 그 서버가 부팅에서 «항상» 배제된다
    //      (register-mcp-clients.ts:164 의 `?? DEFAULT` 는 0 을 통과시킨다).
    //      그래서 파서가 0 을 버리고 기본 마감이 살아남게 한다 — #17155 가 세운 계약이다.
    //      ⛔ 이 파일은 #17119 의 옛 계약(0 보존)을 들고 있어 그때부터 빨강이었다.
    expect(mcp.servers.map((server) => server.handshakeTimeoutMs)).toEqual([undefined, 1_234, 5_678]);
    expect('handshakeTimeoutMs' in mcp.servers[0]!).toBe(false);
  });

  test('omitted or invalid handshakeTimeoutMs stays undefined without dropping valid MCP configuration', () => {
    write({
      mcp: {
        handshakeTimeoutMs: Number.POSITIVE_INFINITY,
        servers: [
          { id: 'omitted', command: ['omitted'] },
          { id: 'string', command: ['string'], handshakeTimeoutMs: '8000' },
          { id: 'negative', transport: 'http', url: 'https://mcp.example.com', handshakeTimeoutMs: -1 },
          { id: 'too-large', command: ['large'], handshakeTimeoutMs: 2_147_483_648 },
        ],
      },
    });
    const mcp = buildUserConfig(cfgPath).mcp!;
    expect(mcp.handshakeTimeoutMs).toBeUndefined();
    expect('handshakeTimeoutMs' in mcp).toBe(false);
    expect(mcp.servers.map((server) => server.handshakeTimeoutMs)).toEqual([undefined, undefined, undefined, undefined]);
    expect(mcp.servers.every((server) => !('handshakeTimeoutMs' in server))).toBe(true);
  });

  test('a zero global handshakeTimeoutMs is dropped, leaving no MCP section to boot from', () => {
    // ⛔ 0 만 있는 mcp 절은 «아무것도 말하지 않는다» — 0 이 버려지면 남는 키가 없다.
    //    빈 절을 남기면 「설정했다」와 「설정이 없다」가 한 값으로 접힌다.
    write({ mcp: { handshakeTimeoutMs: 0 } });
    expect(buildUserConfig(cfgPath).mcp).toBeUndefined();
  });

  test('a zero global handshakeTimeoutMs does not drop the servers configured beside it', () => {
    // ⭐ 0 을 버리는 것이 «다른 설정»까지 버리는 것이면 그건 다른 버그다 — 갈라서 못 박는다.
    write({ mcp: { handshakeTimeoutMs: 0, servers: [{ id: 'kept', command: ['kept'] }] } });
    const mcp = buildUserConfig(cfgPath).mcp!;
    expect(mcp.servers.map((s) => s.id)).toEqual(['kept']);
    expect('handshakeTimeoutMs' in mcp).toBe(false);
  });
});

// ── authorizedTools 파싱 (사후 리뷰가 잡은 회귀 · 2026-08-20) ──────
//
// 🔴 **회귀였다**: `authorizedTools` 가 `McpServerSpec` 타입에는 있는데 파서가 안 읽어
//    config 에 적은 값이 «조용히» 버려졌다. `registerMcpClients` 는
//    `for (const t of spec.authorizedTools ?? [])` 로 부팅 grant 를 주므로 그 배열이 항상
//    비었고 ⇒ ***모든 MCP 프록시 툴이 영구히 `mcp-authorization-denied`*** 였다.
//    ⛔ 타입에 필드를 더하는 것과 파서가 그것을 «읽는» 것은 다른 일이다.
describe('user-config mcp.servers[].authorizedTools', () => {
  test('네 갈래 전부에 실린다 — 하나만 빠져도 그 조합에서 허가가 죽는다', () => {
    write({ mcp: { servers: [
      { id: 'a', transport: 'stdio', command: ['e'], authorizedTools: ['pay'] },   // 명시 stdio
      { id: 'b', command: ['e'], authorizedTools: ['ship'] },                       // legacy 추론
      { id: 'c', transport: 'http', url: 'https://x/mcp', authorizedTools: ['run'] },
      { id: 'd', transport: 'streamable-http', url: 'https://y/mcp', authorizedTools: ['go'] },
    ] } });
    const servers = buildUserConfig(cfgPath).mcp!.servers;
    expect(servers.map((s) => s.authorizedTools)).toEqual([['pay'], ['ship'], ['run'], ['go']]);
  });

  test('중복은 접고 순서는 유지한다 (결정론)', () => {
    write({ mcp: { servers: [{ id: 'a', transport: 'stdio', command: ['e'], authorizedTools: ['b', 'a', 'b'] }] } });
    expect(buildUserConfig(cfgPath).mcp!.servers[0]!.authorizedTools).toEqual(['b', 'a']);
  });

  test('⛔ 권한 필드는 항목 단위 fail-closed — 오염 항목은 «허가되지 않는다»', () => {
    write({ mcp: { servers: [{
      id: 'a', transport: 'stdio', command: ['e'],
      authorizedTools: ['ok', 42, '', '   ', null, { x: 1 }],
    }] } });
    // ⛔ 살아남은 것이 정확히 하나 — 오타·타입 오류가 «허가를 늘리는» 방향으로 못 간다.
    expect(buildUserConfig(cfgPath).mcp!.servers[0]!.authorizedTools).toEqual(['ok']);
  });

  test('⛔ 배열이 아니면 아무것도 허가하지 않는다 (서버는 살린다)', () => {
    write({ mcp: { servers: [{ id: 'a', transport: 'stdio', command: ['e'], authorizedTools: 'pay' }] } });
    const spec = buildUserConfig(cfgPath).mcp!.servers[0]!;
    expect(spec.authorizedTools).toBeUndefined();   // 허가 0
    expect(spec.id).toBe('a');                       // ⊕ 오타 하나로 서버가 사라지지는 않는다
  });

  test('안 적으면 없다 — 기본은 fail-closed 그대로', () => {
    write({ mcp: { servers: [{ id: 'a', transport: 'stdio', command: ['e'] }] } });
    expect(buildUserConfig(cfgPath).mcp!.servers[0]!.authorizedTools).toBeUndefined();
  });
});
