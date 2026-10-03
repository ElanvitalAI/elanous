import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMcpDiagnose } from '../src/cli/mcp-diagnose.js';
import { McpConnectionError } from '../src/mcp/client.js';
import { mcpOAuthStorePath } from '../src/mcp/mcp-oauth.js';
import { saveTokens } from '../src/oauth/store.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const REPO_ROOT = join(import.meta.dir, '..');
const SRC_INDEX = join(REPO_ROOT, 'src', 'index.ts');

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): {
  status: number | null;
  combined: string;
} {
  const result = spawnSync('bun', ['run', SRC_INDEX, ...args], {
    encoding: 'utf-8',
    timeout: 20_000,
    cwd: REPO_ROOT,
    env: { ...env, NO_COLOR: '1' },
  });
  return {
    status: result.status,
    combined: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

interface CapturedOut {
  log: (s: string) => void;
  error: (s: string) => void;
  logs: string[];
  errors: string[];
}

function makeOut(): CapturedOut {
  const logs: string[] = [];
  const errors: string[] = [];
  return { log: (s) => logs.push(s), error: (s) => errors.push(s), logs, errors };
}

describe('runMcpDiagnose (PR3 D)', () => {
  test('healthy server → status=ready, tool count printed, exit 0', async () => {
    const out = makeOut();
    const r = await runMcpDiagnose({
      out,
      readConfigFn: () => ({ mcp: { servers: [{ id: 'fast', transport: 'stdio', command: ['ok'] }] } }),
      createClient: () => ({
        start: async () => {},
        listTools: async () => [
          { name: 'foo', description: 'd', inputSchema: { type: 'object' } },
          { name: 'bar', description: 'e', inputSchema: { type: 'object' } },
        ],
        callTool: async () => ({ content: [] }),
        dispose: async () => {},
      }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.perServer['fast']!.status).toBe('ready');
    expect(r.perServer['fast']!.toolCount).toBe(2);
    expect(out.logs.some((l) => l.includes('elanous mcp diagnose'))).toBe(true);
    expect(out.logs.some((l) => l.includes('elanous nexus mcp diagnose'))).toBe(false);
    expect(out.logs.some((l) => l.includes('▸ fast'))).toBe(true);
    expect(out.logs.some((l) => l.includes('start  ✓'))).toBe(true);
    expect(out.logs.some((l) => l.includes('list   ✓') && l.includes('2 tools'))).toBe(true);
    expect(out.logs.some((l) => l.includes('all servers responded'))).toBe(true);
  });

  test('start() rejects → status=failed + reason captured', async () => {
    const out = makeOut();
    const r = await runMcpDiagnose({
      out,
      readConfigFn: () => ({ mcp: { servers: [{ id: 'broken', transport: 'stdio', command: ['fake'] }] } }),
      createClient: () => ({
        start: async () => { throw new Error('connect-refused'); },
        listTools: async () => [],
        callTool: async () => ({ content: [] }),
        dispose: async () => {},
      }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.perServer['broken']!.status).toBe('failed');
    expect(r.perServer['broken']!.reason).toContain('connect-refused');
    expect(out.errors.some((e) => e.includes('connect-refused'))).toBe(true);
  });

  test('explicit serverId filters to a single spec; unknown id → not-found exit 1', async () => {
    const out = makeOut();
    const r = await runMcpDiagnose({
      out,
      serverId: 'ghost',
      readConfigFn: () => ({ mcp: { servers: [{ id: 'real', transport: 'stdio', command: ['ok'] }] } }),
      createClient: () => ({ start: async () => {}, listTools: async () => [], callTool: async () => ({ content: [] }), dispose: async () => {} }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.perServer['ghost']!.status).toBe('not-found');
    expect(out.errors.some((e) => e.includes("'ghost' not found"))).toBe(true);
  });

  test('listTools hang → deadline fires, status=failed with `timeout` reason', async () => {
    const out = makeOut();
    const r = await runMcpDiagnose({
      out,
      perCallTimeoutMs: 50, // synthetic short window
      readConfigFn: () => ({ mcp: { servers: [{ id: 'hung', transport: 'stdio', command: ['fake'] }] } }),
      createClient: () => ({
        start: async () => {},
        listTools: () => new Promise(() => { /* never resolves */ }),
        callTool: async () => ({ content: [] }),
        dispose: async () => {},
      }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.perServer['hung']!.status).toBe('failed');
    expect(r.perServer['hung']!.reason).toContain('timeout');
    expect(r.perServer['hung']!.reason).toContain('listTools');
  });

  test('serverId filter ignores enabled:false on the matched row (explicit ask = explicit answer)', async () => {
    const out = makeOut();
    const r = await runMcpDiagnose({
      out,
      serverId: 'disabled-one',
      readConfigFn: () => ({ mcp: { servers: [{ id: 'disabled-one', transport: 'stdio', command: ['ok'], enabled: false }] } }),
      createClient: () => ({
        start: async () => {},
        listTools: async () => [],
        callTool: async () => ({ content: [] }),
        dispose: async () => {},
      }),
    });
    // The diagnose path runs the explicit id regardless of enabled —
    // the user is asking precisely about this server.
    expect(r.perServer['disabled-one']!.status).toBe('ready');
  });

  test('http transport handshake + tools/list → ready with non-zero tool count', async () => {
    const out = makeOut();
    const r = await runMcpDiagnose({
      out,
      readConfigFn: () => ({
        mcp: { servers: [{ id: 'remote', transport: 'http', url: 'https://mcp.example.com' }] },
      }),
      createClient: () => ({
        start: async () => {},
        listTools: async () => [
          { name: 'remote-tool', description: 'd', inputSchema: { type: 'object' } },
        ],
        callTool: async () => ({ content: [] }),
        dispose: async () => {},
      }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.perServer['remote']!.status).toBe('ready');
    expect(r.perServer['remote']!.toolCount).toBe(1);
    expect(out.logs.some((l) => l.includes('▸ remote') && l.includes('https://mcp.example.com'))).toBe(true);
    expect(out.logs.some((l) => l.includes('list   ✓') && l.includes('1 tool'))).toBe(true);
  });

  test('http next to stdio: both diagnose ready; stdio status and tool count unchanged', async () => {
    const out = makeOut();
    const spawned: string[] = [];
    const r = await runMcpDiagnose({
      out,
      readConfigFn: () => ({
        mcp: {
          servers: [
            { id: 'remote', transport: 'http', url: 'https://mcp.example.com' },
            { id: 'local', transport: 'stdio', command: ['ok'] },
          ],
        },
      }),
      createClient: (spec) => {
        spawned.push(spec.id);
        return {
          start: async () => {},
          listTools: async () => [
            { name: 'foo', description: 'd', inputSchema: { type: 'object' } },
          ],
          callTool: async () => ({ content: [] }),
          dispose: async () => {},
        };
      },
    });
    expect(spawned).toEqual(['remote', 'local']);
    expect(r.perServer['remote']!.status).toBe('ready');
    expect(r.perServer['local']!.status).toBe('ready');
    expect(r.perServer['local']!.toolCount).toBe(1);
    expect(r.exitCode).toBe(0);
  });

  test('no serverId + all enabled:false → no probe, exit 0 (empty fleet is healthy)', async () => {
    const out = makeOut();
    const r = await runMcpDiagnose({
      out,
      readConfigFn: () => ({ mcp: { servers: [{ id: 'a', transport: 'stdio', command: ['ok'], enabled: false }] } }),
      createClient: () => ({ start: async () => {}, listTools: async () => [], callTool: async () => ({ content: [] }), dispose: async () => {} }),
    });
    expect(r.exitCode).toBe(0);
    expect(out.logs.some((l) => l.includes('0 servers to probe'))).toBe(true);
  });

  test('auth-required / unreachable / not-mcp render distinct messages; auth is not retried', async () => {
    const out = makeOut();
    const challenge = 'Bearer resource_metadata="https://auth.example/meta", scope="mcp:tools"';
    const counts = { auth: 0, unreach: 0, html: 0 };
    const r = await runMcpDiagnose({
      out,
      readConfigFn: () => ({
        mcp: {
          servers: [
            { id: 'auth', transport: 'http', url: 'https://mcp.example.com/auth' },
            { id: 'dead', transport: 'http', url: 'http://192.0.2.1/mcp' },
            { id: 'html', transport: 'http', url: 'https://example.com/' },
          ],
        },
      }),
      createClient: (spec) => {
        if (spec.id === 'auth') {
          return {
            start: async () => {
              counts.auth += 1;
              throw new McpConnectionError('auth-required', '', { wwwAuthenticate: challenge });
            },
            listTools: async () => [],
            callTool: async () => ({ content: [] }),
            dispose: async () => {},
            httpRequestCount: 1,
          };
        }
        if (spec.id === 'dead') {
          return {
            start: async () => {
              counts.unreach += 2;
              throw new McpConnectionError('unreachable', '', { detail: spec.transport === 'http' ? spec.url : spec.id });
            },
            listTools: async () => [],
            callTool: async () => ({ content: [] }),
            dispose: async () => {},
            httpRequestCount: 2,
          };
        }
        return {
          start: async () => {
            counts.html += 1;
            throw new McpConnectionError('not-mcp', '', { detail: 'the address responded with HTML, not MCP JSON-RPC' });
          },
          listTools: async () => [],
          callTool: async () => ({ content: [] }),
          dispose: async () => {},
          httpRequestCount: 1,
        };
      },
    });
    expect(r.perServer['auth']!.failureReason).toBe('auth-required');
    expect(r.perServer['auth']!.reason).toContain(challenge);
    expect(r.perServer['auth']!.httpRequestCount).toBe(1);
    expect(r.perServer['dead']!.failureReason).toBe('unreachable');
    expect(r.perServer['dead']!.reason).not.toBe(r.perServer['auth']!.reason);
    expect(r.perServer['dead']!.httpRequestCount).toBeGreaterThanOrEqual(2);
    expect(r.perServer['html']!.failureReason).toBe('not-mcp');
    expect(r.perServer['html']!.reason).not.toBe(r.perServer['auth']!.reason);
    expect(r.perServer['html']!.reason).not.toBe(r.perServer['dead']!.reason);
    const messages = [r.perServer['auth']!.reason!, r.perServer['dead']!.reason!, r.perServer['html']!.reason!];
    expect(new Set(messages).size).toBe(3);
    expect(counts.auth).toBe(1);
  });
});

async function listenLoopback(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no listen address');
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

describe('runMcpDiagnose HTTP loopback', () => {
  test('loopback MCP server → ready and toolCount > 0', async () => {
    const loop = await listenLoopback(async (req, res) => {
      const body = await readBody(req);
      const msg = JSON.parse(body || '{}') as { id?: number; method?: string };
      res.setHeader('content-type', 'application/json');
      if (msg.method === 'initialize') {
        res.writeHead(200);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } }));
        return;
      }
      if (msg.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      if (msg.method === 'tools/list') {
        res.writeHead(200);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping' }] } }));
        return;
      }
      res.writeHead(400);
      res.end('{}');
    });
    try {
      const out = makeOut();
      const r = await runMcpDiagnose({
        out,
        perCallTimeoutMs: 5_000,
        readConfigFn: () => ({ mcp: { servers: [{ id: 'loop', transport: 'http', url: loop.url }] } }),
      });
      expect(r.perServer['loop']!.status).toBe('ready');
      expect(r.perServer['loop']!.toolCount).toBeGreaterThan(0);
      expect(r.exitCode).toBe(0);
    } finally {
      await loop.close();
    }
  });

  test('configured static bearer environment token reaches loopback without printing it', async () => {
    const envName = 'ELANOUS_MCP_DIAGNOSE_STATIC_BEARER';
    const previous = process.env[envName];
    const token = 'diagnose-static-token';
    process.env[envName] = token;
    const authHeaders: Array<string | undefined> = [];
    const loop = await listenLoopback(async (req, res) => {
      authHeaders.push(req.headers.authorization);
      const body = await readBody(req);
      const msg = JSON.parse(body || '{}') as { id?: number; method?: string };
      res.setHeader('content-type', 'application/json');
      if (msg.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } }));
        return;
      }
      if (msg.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'credentialed' }] } }));
    });
    try {
      const out = makeOut();
      const r = await runMcpDiagnose({
        out,
        readConfigFn: () => ({ mcp: { servers: [{
          id: 'static', transport: 'http' as const, url: loop.url, bearerTokenEnv: envName,
        }] } }),
      });
      expect(r.exitCode).toBe(0);
      expect(authHeaders).toContain(`Bearer ${token}`);
      expect([...out.logs, ...out.errors].join('\n')).not.toContain(token);
    } finally {
      await loop.close();
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  test('configured OAuth issuer reuses a stored credential without printing it', async () => {
    const previousXdg = process.env.XDG_CONFIG_HOME;
    const configDir = mkdtempSync(join(tmpdir(), 'mcp-diagnose-oauth-'));
    process.env.XDG_CONFIG_HOME = configDir;
    const issuer = 'https://issuer.example.test';
    const token = 'diagnose-stored-token';
    saveTokens(
      issuer,
      { accessToken: token, refreshToken: '', expiresAt: Date.now() + 3600_000, tokenType: 'Bearer' },
      { authMode: 'mcp-oauth', mirrorCodex: false },
      mcpOAuthStorePath(),
    );
    const authHeaders: Array<string | undefined> = [];
    const loop = await listenLoopback(async (req, res) => {
      authHeaders.push(req.headers.authorization);
      const body = await readBody(req);
      const msg = JSON.parse(body || '{}') as { id?: number; method?: string };
      res.setHeader('content-type', 'application/json');
      if (msg.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } }));
        return;
      }
      if (msg.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'credentialed' }] } }));
    });
    try {
      const out = makeOut();
      const r = await runMcpDiagnose({
        out,
        readConfigFn: () => ({ mcp: { servers: [{
          id: 'oauth', transport: 'http', url: loop.url, oauthIssuer: issuer,
          oauthTokenEndpoint: 'https://issuer.example.test/token',
        }] } }),
      });
      expect(r.exitCode).toBe(0);
      expect(r.perServer.oauth!.toolCount).toBe(1);
      expect(authHeaders).toContain(`Bearer ${token}`);
      expect([...out.logs, ...out.errors].join('\n')).not.toContain(token);
    } finally {
      await loop.close();
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  test('OAuth authentication failure distinguishes missing credentials from rejected stored credentials', async () => {
    const previousXdg = process.env.XDG_CONFIG_HOME;
    const configDir = mkdtempSync(join(tmpdir(), 'mcp-diagnose-oauth-failure-'));
    process.env.XDG_CONFIG_HOME = configDir;
    const issuer = 'https://issuer.example.test';
    const loop = await listenLoopback((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    try {
      const readConfigFn = () => ({ mcp: { servers: [{
        id: 'oauth', transport: 'http' as const, url: loop.url, oauthIssuer: issuer,
      }] } });
      const missing = await runMcpDiagnose({ out: makeOut(), readConfigFn });
      expect(missing.perServer.oauth!.reason).toContain('no stored credentials');

      saveTokens(
        issuer,
        { accessToken: 'rejected-token', refreshToken: '', expiresAt: Date.now() + 3600_000, tokenType: 'Bearer' },
        { authMode: 'mcp-oauth', mirrorCodex: false },
        mcpOAuthStorePath(),
      );
      const rejected = await runMcpDiagnose({ out: makeOut(), readConfigFn });
      expect(rejected.perServer.oauth!.reason).toContain('stored credentials were rejected');
      expect(rejected.perServer.oauth!.reason).not.toContain('rejected-token');
    } finally {
      await loop.close();
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  test('401 loopback preserves WWW-Authenticate in the diagnose message and does not retry', async () => {
    const challenge = 'Bearer resource_metadata="https://auth.example/meta", scope="mcp:tools"';
    let hits = 0;
    const loop = await listenLoopback((_req, res) => {
      hits += 1;
      res.setHeader('www-authenticate', challenge);
      res.writeHead(401);
      res.end();
    });
    try {
      const out = makeOut();
      const r = await runMcpDiagnose({
        out,
        perCallTimeoutMs: 5_000,
        readConfigFn: () => ({ mcp: { servers: [{ id: 'auth', transport: 'http', url: loop.url }] } }),
      });
      expect(r.perServer['auth']!.failureReason).toBe('auth-required');
      expect(r.perServer['auth']!.reason).toContain(challenge);
      expect(r.perServer['auth']!.httpRequestCount).toBe(1);
      expect(hits).toBe(1);
    } finally {
      await loop.close();
    }
  });

  test('HTML 200 loopback classifies as not-mcp', async () => {
    const loop = await listenLoopback((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.writeHead(200);
      res.end('<html>hi</html>');
    });
    try {
      const out = makeOut();
      const r = await runMcpDiagnose({
        out,
        perCallTimeoutMs: 5_000,
        readConfigFn: () => ({ mcp: { servers: [{ id: 'html', transport: 'http', url: loop.url }] } }),
      });
      expect(r.perServer['html']!.failureReason).toBe('not-mcp');
      expect(r.perServer['html']!.reason).not.toMatch(/authentication required/);
    } finally {
      await loop.close();
    }
  });

  test('닫힌 loopback 포트 → unreachable 로 분류되고 «다시» 건다', async () => {
    // ⛔ 초판은 예약 주소 `192.0.2.1:9` 로 «진짜 네트워크»를 탔다(20초 타임아웃).
    //    CI 의 프록시·라우팅에 따라 4xx 나 긴 지연이 나 흔들린다(리뷰 should-fix).
    //    ⇒ 포트를 «열었다 닫아» 확실히 비어 있는 loopback 주소를 쓴다 —
    //      즉시 ECONNREFUSED 이고 외부 경로를 안 탄다.
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
    const closedPort = probe.port;
    probe.stop(true);

    const out = makeOut();
    const r = await runMcpDiagnose({
      out,
      perCallTimeoutMs: 2_000,
      readConfigFn: () => ({
        mcp: { servers: [{ id: 'dead', transport: 'http', url: `http://127.0.0.1:${closedPort}/mcp` }] },
      }),
    });
    expect(r.perServer['dead']!.failureReason).toBe('unreachable');
    expect(r.perServer['dead']!.reason).not.toMatch(/authentication required/);
    expect((r.perServer['dead']!.httpRequestCount ?? 0)).toBeGreaterThanOrEqual(2);
  }, 10_000);
});

// ── ⛔ 「우리가 건 마감」과 「상대가 보낸 오류」를 문면으로 가르지 않는다 (리뷰 must-fix) ──
describe('classifyDiagnoseFailure — 서버가 «응답»한 것은 unreachable 이 아니다', () => {
  test('서버가 보낸 JSON-RPC 오류에 timeout 이 있어도 원문을 유지한다', async () => {
    const { runMcpDiagnose } = await import('../src/cli/mcp-diagnose');
    const { McpServerError } = await import('../src/mcp/client');
    const lines: string[] = [];
    const res = await runMcpDiagnose({
      serverId: 'remote',
      readConfigFn: () => ({ mcp: { servers: [
        { id: 'remote', transport: 'http', url: 'https://x/mcp' } as never,
      ] } }),
      createClient: () => ({
        start: async () => {},
        // ⛔ 상대가 «정상 JSON-RPC 로» 보낸 오류다 — 문면에 timeout 이 들어 있다.
        listTools: async () => { throw new McpServerError(-32000, 'upstream timeout'); },
        callTool: async () => ({ content: [] }),
        dispose: async () => {},
      }),
      out: { log: (s) => lines.push(s), error: (s) => lines.push(s) },
    });
    const per = res.perServer['remote']!;
    // ⭐ 「닿지 못했다」로 둔갑하지 않는다 — 우리는 «닿았고» 서버가 안 된다고 한 것이다.
    expect(per.failureReason).not.toBe('unreachable');
    expect(per.reason ?? '').toContain('upstream timeout');
    expect(per.reason ?? '').not.toContain('address unreachable');
  });
});

describe('mcp diagnose CLI path', () => {
  test('`mcp diagnose --help` exits 0 with the same probe description as before the move', () => {
    const result = runCli(['mcp', 'diagnose', '--help']);
    expect(result.status).toBe(0);
    expect(result.combined).toContain('Probe one (or every enabled) MCP server');
    expect(result.combined).toContain('--timeout');
    expect(result.combined).not.toMatch(/--test\b/);
  }, 25_000);

  test('`mcp --help` lists diagnose next to unchanged serve', () => {
    const result = runCli(['mcp', '--help']);
    expect(result.status).toBe(0);
    expect(result.combined).toContain('diagnose');
    expect(result.combined).toContain('serve');
  }, 25_000);

  test('old `nexus mcp diagnose` is an unknown command with no alias', () => {
    const result = runCli(['nexus', 'mcp', 'diagnose']);
    expect(result.status).not.toBe(0);
    // Commander routes leftover tokens to the default `nexus run` (0 args),
    // so the old path is gone as either unknown-command or extra-args — never diagnose.
    expect(result.combined.toLowerCase()).toMatch(/unknown command|too many arguments/);
    expect(result.combined).not.toContain('Probe one (or every enabled) MCP server');
    const help = runCli(['nexus', '--help']);
    expect(help.combined).not.toMatch(/\bmcp diagnose\b/);
  }, 25_000);

  test('same args yield the same per-server status and tool count as runMcpDiagnose', async () => {
    const isolate = mkdtempSync(join(tmpdir(), 'mcp-diagnose-same-args-'));
    const fixture = join(isolate, 'ready-mcp-server.mjs');
    writeFileSync(fixture, [
      'import { createInterface } from "node:readline";',
      'const rl = createInterface({ input: process.stdin });',
      'rl.on("line", (line) => {',
      '  const msg = JSON.parse(line);',
      '  if (msg.method === "initialize") {',
      '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "0" } } }) + "\\n");',
      '    return;',
      '  }',
      '  if (msg.method === "tools/list") {',
      '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [',
      '      { name: "foo", description: "d", inputSchema: { type: "object" } },',
      '      { name: "bar", description: "e", inputSchema: { type: "object" } },',
      '    ] } }) + "\\n");',
      '  }',
      '});',
      '',
    ].join('\n'));
    writeFileSync(join(isolate, 'config.json'), JSON.stringify({
      mcp: { servers: [{ id: 'fast', transport: 'stdio', command: ['bun', fixture] }] },
    }));
    const out = makeOut();
    const logic = await runMcpDiagnose({
      out,
      serverId: 'fast',
      readConfigFn: () => ({ mcp: { servers: [{ id: 'fast', transport: 'stdio', command: ['bun', fixture] }] } }),
    });
    const cli = runCli(['--config-dir', isolate, 'mcp', 'diagnose', 'fast']);
    expect(logic.exitCode).toBe(0);
    expect(cli.status).toBe(0);
    expect(logic.perServer['fast']!.status).toBe('ready');
    expect(logic.perServer['fast']!.toolCount).toBe(2);
    expect(cli.combined).toContain('elanous mcp diagnose');
    expect(cli.combined).not.toContain('elanous nexus mcp diagnose');
    expect(cli.combined).toContain('▸ fast');
    expect(cli.combined).toMatch(/list\s+✓.*2 tools/);
    expect(cli.combined).toContain('all servers responded');
  }, 25_000);

  test('global --test isolates diagnose without a command-local flag', () => {
    const isolate = mkdtempSync(join(tmpdir(), 'mcp-diagnose-test-flag-'));
    mkdirSync(join(isolate, '.git'));
    const configPath = join(isolate, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      mcp: { servers: [{ id: 'iso-canary-ebf155ba', transport: 'stdio', command: ['/bin/false'] }] },
    }));
    utimesSync(configPath, 0, 0);
    const result = runCli(
      [`--test=${isolate}`, 'mcp', 'diagnose', 'iso-canary-ebf155ba'],
      { ...process.env, NODE_ENV: 'development' },
    );
    expect(result.combined).toContain('elanous mcp diagnose — 1 server to probe');
    expect(result.combined).toContain('iso-canary-ebf155ba');
    expect(result.combined).not.toContain("'iso-canary-ebf155ba' not found");
  }, 25_000);
});
