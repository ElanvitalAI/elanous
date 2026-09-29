import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { setResolveDaemonEndpointForTest } from '../nexus/daemon-endpoint.js';
import { runMcpReload } from './mcp-reload.js';

const recorder = () => {
  const lines: string[] = [];
  const errs: string[] = [];
  return { out: { log: (s: string) => { lines.push(s); }, error: (s: string) => { errs.push(s); } }, lines, errs };
};

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const withConfigDir = (token?: string | null) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-reload-acp-'));
  setElanousConfigDir(dir);
  if (typeof token === 'string') writeFileSync(join(dir, 'acp-token'), token, { mode: 0o600 });
  return dir;
};

let isolatedDir: string | undefined;

beforeEach(() => {
  isolatedDir = mkdtempSync(join(tmpdir(), 'mcp-reload-iso-'));
  setElanousConfigDir(isolatedDir);
  setResolveDaemonEndpointForTest(() => ({
    baseUrl: 'http://127.0.0.1:31420',
    healthUrl: 'http://127.0.0.1:31420/v1/health',
    pwaUrl: 'http://127.0.0.1:31420/',
    source: 'registry',
  }));
});

afterEach(() => {
  setResolveDaemonEndpointForTest(null);
  resetElanousConfigDir();
  if (isolatedDir) {
    rmSync(isolatedDir, { recursive: true, force: true });
    isolatedDir = undefined;
  }
});

describe('elanous mcp reload', () => {
  test('현재 우주의 데몬 주소로 실제 HTTP 재장전 요청을 보낸다', async () => {
    const requests: Array<{ path: string; method: string }> = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        requests.push({ path: new URL(req.url).pathname, method: req.method });
        return Response.json({ reloaded: true, registered: 1, perServer: { krea: { status: 'ready', toolCount: 1 } } });
      },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      setResolveDaemonEndpointForTest(() => ({
        baseUrl,
        healthUrl: `${baseUrl}/v1/health`,
        pwaUrl: `${baseUrl}/`,
        source: 'registry',
      }));
      const r = recorder();
      const res = await runMcpReload({ out: r.out });
      expect(requests).toEqual([{ path: '/v1/nexus/admin/mcp-reload', method: 'POST' }]);
      expect(res).toEqual({ exitCode: 0, registered: 1 });
      expect(r.lines[0]).toBe('✓ MCP 재장전 완료 — 서버 1개 · 도구 1개 등록');
    } finally {
      server.stop(true);
    }
  });

  test('해석기가 null 이면 요청 없이 nexus show 안내와 exit 1 을 낸다', async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        requests.push(new URL(req.url).pathname);
        return Response.json({ reloaded: true, registered: 0, perServer: {} });
      },
    });
    try {
      setResolveDaemonEndpointForTest(() => null);
      const r = recorder();
      const res = await runMcpReload({
        out: r.out,
        fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}/v1/nexus/admin/mcp-reload`, init)) as typeof fetch,
      });
      expect(requests).toEqual([]);
      expect(res.exitCode).toBe(1);
      expect(r.errs).toHaveLength(1);
      expect(r.errs[0]).toContain('elanous nexus show');
    } finally {
      server.stop(true);
    }
  });

  test('--nexus-url 이 주어지면 해석기가 null 이어도 명시 주소를 먼저 쓴다', async () => {
    setResolveDaemonEndpointForTest(() => null);
    const r = recorder();
    const res = await runMcpReload({
      nexusBaseUrl: 'http://127.0.0.1:31420',
      out: r.out,
      fetchFn: (async (url: string | URL | Request) => {
        expect(String(url)).toBe('http://127.0.0.1:31420/v1/nexus/admin/mcp-reload');
        return jsonRes({ reloaded: true, registered: 0, perServer: {} });
      }) as unknown as typeof fetch,
    });
    expect(res.exitCode).toBe(0);
  });

  test('데몬 admin 경로로 POST 한다', async () => {
    const seen: { url?: string; method?: string } = {};
    const r = recorder();
    await runMcpReload({
      out: r.out,
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.url = String(url);
        seen.method = init?.method;
        return jsonRes({ reloaded: true, registered: 1, perServer: { krea: { status: 'ready', toolCount: 1 } } });
      }) as unknown as typeof fetch,
    });
    expect(seen.url).toBe('http://127.0.0.1:31420/v1/nexus/admin/mcp-reload');
    expect(seen.method).toBe('POST');
  });

  // ⭐ 「하나가 실패해도 나머지는 붙었다」를 exit 로 «가르는지». 총 수만 보면
  //    krea 만 죽은 판이 초록으로 통과한다.
  test('서버 하나가 failed 면 exit 1 이고 그 이름·사유를 화면에 낸다', async () => {
    const r = recorder();
    const res = await runMcpReload({
      out: r.out,
      fetchFn: (async () => jsonRes({
        reloaded: true,
        registered: 8,
        perServer: {
          higgsfield: { status: 'ready', toolCount: 8 },
          krea: { status: 'failed', toolCount: 0, reason: 'oauth token missing' },
        },
      })) as unknown as typeof fetch,
    });
    expect(res.exitCode).toBe(1);
    expect(res.registered).toBe(8);
    const screen = r.lines.join('\n');
    expect(screen).toContain('krea');
    expect(screen).toContain('oauth token missing');
  });

  test('실패가 하나라도 있으면 첫 줄이 끊긴 서버와 분류를 말한다', async () => {
    const r = recorder();
    await runMcpReload({
      out: r.out,
      fetchFn: (async () => jsonRes({
        reloaded: true,
        registered: 2,
        perServer: {
          higgsfield: { status: 'failed', toolCount: 0, reason: 'authentication required', reasonClass: 'auth-required' },
          krea: { status: 'ready', toolCount: 1 },
          bridge: { status: 'ready', toolCount: 1 },
        },
      })) as unknown as typeof fetch,
    });
    const first = r.lines[0] ?? '';
    expect(first.startsWith('⚠ 끊긴 서버 1개')).toBe(true);
    expect(first).toContain('higgsfield');
    expect(first).toContain('auth-required');
  });

  test('전부 붙었으면 첫 줄은 완료 문면 그대로다', async () => {
    const r = recorder();
    await runMcpReload({
      out: r.out,
      fetchFn: (async () => jsonRes({
        reloaded: true,
        registered: 2,
        perServer: {
          krea: { status: 'ready', toolCount: 1 },
          bridge: { status: 'ready', toolCount: 1 },
        },
      })) as unknown as typeof fetch,
    });
    expect(r.lines[0]).toBe('✓ MCP 재장전 완료 — 서버 2개 · 도구 2개 등록');
  });

  test('전부 ready 면 exit 0', async () => {
    const r = recorder();
    const res = await runMcpReload({
      out: r.out,
      fetchFn: (async () => jsonRes({ reloaded: true, registered: 42, perServer: { krea: { status: 'ready', toolCount: 34 }, higgsfield: { status: 'ready', toolCount: 8 } } })) as unknown as typeof fetch,
    });
    expect(res.exitCode).toBe(0);
    expect(res.registered).toBe(42);
  });

  test('데몬이 없으면 exit 1 이고 「다음에 무엇을」을 말한다', async () => {
    const r = recorder();
    const res = await runMcpReload({
      out: r.out,
      fetchFn: (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch,
    });
    expect(res.exitCode).toBe(1);
    expect(r.errs.join('\n')).toContain('nexus run');
    expect(r.errs.join('\n')).toContain('데몬이 없으면 재장전할 대상도 없습니다');
  });

  test('JSON 파싱 실패면 exit 1 이고 그 문면을 낸다', async () => {
    const r = recorder();
    const res = await runMcpReload({
      out: r.out,
      fetchFn: (async () => new Response('not-json', { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch,
    });
    expect(res.exitCode).toBe(1);
    expect(r.errs.join('\n')).toContain('JSON 으로 못 읽었습니다');
  });

  test('503 not-wired 는 hint 를 그대로 내보인다', async () => {
    const r = recorder();
    const res = await runMcpReload({
      out: r.out,
      fetchFn: (async () => jsonRes({ error: 'mcp-reload-not-wired', hint: 'Restart NEXUS to pick up the wiring.' }, 503)) as unknown as typeof fetch,
    });
    expect(res.exitCode).toBe(1);
    expect(r.errs.join('\n')).toContain('Restart NEXUS');
  });

  test('토큰이 있으면 Authorization: Bearer 를 붙인다', async () => {
    const token = 'mcp-reload-secret-token-value';
    const dir = withConfigDir(token);
    try {
      const seen: { headers?: HeadersInit } = {};
      const r = recorder();
      const res = await runMcpReload({
        out: r.out,
        fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
          seen.headers = init?.headers;
          return jsonRes({ reloaded: true, registered: 2, perServer: { krea: { status: 'ready', toolCount: 2 } } });
        }) as unknown as typeof fetch,
      });
      expect(res.exitCode).toBe(0);
      const headers = new Headers(seen.headers);
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('Authorization')).toBe(`Bearer ${token}`);
      const screen = `${r.lines.join('\n')}\n${r.errs.join('\n')}`;
      expect(screen).not.toContain(token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('토큰을 못 읽어도 죽지 않고 헤더 없이 보낸다', async () => {
    const dir = withConfigDir(null);
    try {
      const seen: { headers?: HeadersInit } = {};
      const r = recorder();
      const res = await runMcpReload({
        out: r.out,
        fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
          seen.headers = init?.headers;
          return jsonRes({ reloaded: true, registered: 1, perServer: { krea: { status: 'ready', toolCount: 1 } } });
        }) as unknown as typeof fetch,
      });
      expect(res.exitCode).toBe(0);
      const headers = new Headers(seen.headers);
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('Authorization')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('토큰을 못 읽고 401 이면 「토큰을 못 읽었다」를 사유로 말한다', async () => {
    const dir = withConfigDir(null);
    try {
      const r = recorder();
      const res = await runMcpReload({
        out: r.out,
        fetchFn: (async () => jsonRes({ error: 'unauthorized' }, 401)) as unknown as typeof fetch,
      });
      expect(res.exitCode).toBe(1);
      const err = r.errs.join('\n');
      expect(err).toContain('unauthorized');
      expect(err).toContain('토큰을 못 읽었다');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('토큰이 있는데 401 이어도 토큰 문자열은 출력하지 않는다', async () => {
    const token = 'must-not-leak-this-acp-token';
    const dir = withConfigDir(token);
    try {
      const r = recorder();
      const res = await runMcpReload({
        out: r.out,
        fetchFn: (async () => jsonRes({ error: 'unauthorized' }, 401)) as unknown as typeof fetch,
      });
      expect(res.exitCode).toBe(1);
      const screen = `${r.lines.join('\n')}\n${r.errs.join('\n')}`;
      expect(screen).toContain('unauthorized');
      expect(screen).toContain('토큰은 있다');
      expect(screen).not.toContain(token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('오류 응답에 토큰이 실려도 stdout/stderr 에 토큰 문자열이 없고 Authorization 은 그대로다', async () => {
    const token = 'leak-me-from-error-body-token';
    const dir = withConfigDir(token);
    try {
      const seen: { headers?: HeadersInit } = {};
      const r = recorder();
      const res = await runMcpReload({
        out: r.out,
        fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
          seen.headers = init?.headers;
          return jsonRes({
            error: `unauthorized token=${token}`,
            hint: `retry with ${token}`,
            message: `bearer ${token} rejected`,
          }, 401);
        }) as unknown as typeof fetch,
      });
      expect(res.exitCode).toBe(1);
      const headers = new Headers(seen.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${token}`);
      const stdout = r.lines.join('\n');
      const stderr = r.errs.join('\n');
      expect(stdout).not.toContain(token);
      expect(stderr).not.toContain(token);
      expect(stderr).toContain('토큰은 있다');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fetch 예외에 토큰이 실려도 stdout/stderr 에 토큰 문자열이 없다', async () => {
    const token = 'leak-me-from-fetch-exception-token';
    const dir = withConfigDir(token);
    try {
      const r = recorder();
      const res = await runMcpReload({
        out: r.out,
        fetchFn: (async () => {
          throw new Error(`connect failed while using ${token}`);
        }) as unknown as typeof fetch,
      });
      expect(res.exitCode).toBe(1);
      const stdout = r.lines.join('\n');
      const stderr = r.errs.join('\n');
      expect(stdout).not.toContain(token);
      expect(stderr).not.toContain(token);
      expect(stderr).toContain('데몬이 없으면 재장전할 대상도 없습니다');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('토큰 파일이 안 열려도 죽지 않고 헤더 없이 보낸다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-reload-unreadable-'));
    setElanousConfigDir(dir);
    mkdirSync(join(dir, 'acp-token'));
    try {
      const seen: { headers?: HeadersInit } = {};
      const r = recorder();
      const res = await runMcpReload({
        out: r.out,
        fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
          seen.headers = init?.headers;
          return jsonRes({ error: 'unauthorized' }, 401);
        }) as unknown as typeof fetch,
      });
      expect(res.exitCode).toBe(1);
      const headers = new Headers(seen.headers);
      expect(headers.get('Authorization')).toBeNull();
      const screen = `${r.lines.join('\n')}\n${r.errs.join('\n')}`;
      expect(screen).toContain('토큰을 못 읽었다');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('옛 데몬 (배선 전)', () => {
  // 📏 실측 2026-09-10: 이 라우트 전에 뜬 데몬은 404 가 «아니라» 405 를 낸다.
  //    그 문면만 보면 사람이 메서드를 의심하므로 도구가 처방을 같이 낸다.
  test('405 면 「한 번만 재부팅」 처방을 낸다', async () => {
    const lines: string[] = [];
    const errs: string[] = [];
    const res = await runMcpReload({
      out: { log: (s) => { lines.push(s); }, error: (s) => { errs.push(s); } },
      fetchFn: (async () => new Response(JSON.stringify({ error: 'method-not-allowed' }), { status: 405, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('kickstart');
  });
});
