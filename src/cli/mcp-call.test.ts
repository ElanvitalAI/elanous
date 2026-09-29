import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { program } from '../index.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { RemotesStore, type RemoteEntry } from './remotes.js';
import { runMcpCall, runMcpList } from './mcp-call.js';
import { setResolveDaemonEndpointForTest } from '../nexus/daemon-endpoint.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = resolve(REPO_ROOT, 'bin/elanous.mjs');
const SPAWN_TIMEOUT_MS = 60_000;

const dirs: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.stop(true);
});

function isolatedStore(): { store: RemotesStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-call-'));
  dirs.push(dir);
  return { store: new RemotesStore({ remotesFilePath: join(dir, 'remotes.json'), tokensDir: dir }), dir };
}

function entry(dir: string, host: string, acpUrl: string, token: string): RemoteEntry {
  const tokenFile = join(dir, `${host}.token`);
  writeFileSync(tokenFile, token, { mode: 0o600 });
  return { host, acp_url: acpUrl, token_file: tokenFile, addedAt: new Date().toISOString() };
}

function sink() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    out: { log: (line: string) => logs.push(line), error: (line: string) => errors.push(line) },
  };
}

function jsonRpc(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonRpcError(error: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function startMock(handler: (body: Record<string, unknown>, req: Request) => Response | Promise<Response>) {
  const requests: Array<{ body: Record<string, unknown>; auth: string | null; url: string }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      requests.push({ body, auth: req.headers.get('authorization'), url: req.url });
      const resp = await handler(body, req);
      const contentType = resp.headers.get('content-type') ?? '';
      if (!contentType.includes('json')) return resp;
      const text = await resp.text();
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          && (parsed as { jsonrpc?: unknown }).jsonrpc === '2.0') {
          (parsed as { id: unknown }).id = body.id;
          return new Response(JSON.stringify(parsed), {
            status: resp.status,
            headers: { 'content-type': 'application/json' },
          });
        }
      } catch {
        /* leave the original body */
      }
      return new Response(text, { status: resp.status, headers: { 'content-type': contentType } });
    },
  });
  servers.push(server);
  return { server, requests, url: `http://127.0.0.1:${server.port}/v1/mcp` };
}

describe('runMcpCall', () => {
  test('posts tools/call with --arg k=v and prints structured content', async () => {
    const { requests, url } = startMock((body) => {
      expect(body.method).toBe('tools/call');
      return jsonRpc({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { structured: { credits: 2853.05, subscription_plan_type: 'ultra' } },
      });
    });
    const io = sink();
    const result = await runMcpCall({
      tool: 'higgsfield.balance',
      args: ['k=v'],
      localUrl: url,
      out: io.out,
      remotesStore: () => { throw new Error('bookmark lookup must not run for local calls'); },
    });
    expect(result.exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.method).toBe('tools/call');
    expect((requests[0]!.body.params as { name: string }).name).toBe('higgsfield.balance');
    expect((requests[0]!.body.params as { arguments: { k: string } }).arguments.k).toBe('v');
    expect(result.message).toContain('2853.05');
    expect(io.logs.join('\n')).toContain('2853.05');
  });

  test('merges --args-json with --arg overlays', async () => {
    const { requests, url } = startMock(() => jsonRpc({ structuredContent: { ok: true } }));
    const result = await runMcpCall({
      tool: 'demo.tool',
      argsJson: '{"a":1,"b":"keep"}',
      args: ['b=override', 'c=from-arg'],
      localUrl: url,
      out: sink().out,
    });
    expect(result.exitCode).toBe(0);
    expect((requests[0]!.body.params as { arguments: Record<string, unknown> }).arguments).toEqual({
      a: 1,
      b: 'override',
      c: 'from-arg',
    });
  });

  test('--arg-json limit=5 sends a number, not the string "5"', async () => {
    const { requests, url } = startMock(() => jsonRpc({ structuredContent: { ok: true } }));
    const result = await runMcpCall({
      tool: 'demo.tool',
      argJson: ['limit=5'],
      localUrl: url,
      out: sink().out,
    });
    expect(result.exitCode).toBe(0);
    expect((requests[0]!.body.params as { arguments: { limit: unknown } }).arguments.limit).toBe(5);
    expect(typeof (requests[0]!.body.params as { arguments: { limit: unknown } }).arguments.limit).toBe('number');
  });

  test('--arg-json flag=true sends a boolean', async () => {
    const { requests, url } = startMock(() => jsonRpc({ structuredContent: { ok: true } }));
    const result = await runMcpCall({
      tool: 'demo.tool',
      argJson: ['flag=true'],
      localUrl: url,
      out: sink().out,
    });
    expect(result.exitCode).toBe(0);
    expect((requests[0]!.body.params as { arguments: { flag: unknown } }).arguments.flag).toBe(true);
    expect(typeof (requests[0]!.body.params as { arguments: { flag: unknown } }).arguments.flag).toBe('boolean');
  });

  test('--arg limit=5 stays a string (no silent JSON parse)', async () => {
    const { requests, url } = startMock(() => jsonRpc({ structuredContent: { ok: true } }));
    const result = await runMcpCall({
      tool: 'demo.tool',
      args: ['limit=5'],
      localUrl: url,
      out: sink().out,
    });
    expect(result.exitCode).toBe(0);
    expect((requests[0]!.body.params as { arguments: { limit: unknown } }).arguments.limit).toBe('5');
    expect(typeof (requests[0]!.body.params as { arguments: { limit: unknown } }).arguments.limit).toBe('string');
  });

  test('--arg flag=true stays the string "true"', async () => {
    const { requests, url } = startMock(() => jsonRpc({ structuredContent: { ok: true } }));
    const result = await runMcpCall({
      tool: 'demo.tool',
      args: ['flag=true'],
      localUrl: url,
      out: sink().out,
    });
    expect(result.exitCode).toBe(0);
    expect((requests[0]!.body.params as { arguments: { flag: unknown } }).arguments.flag).toBe('true');
  });

  test('--arg overlays --arg-json for the same key and keeps the string', async () => {
    const { requests, url } = startMock(() => jsonRpc({ structuredContent: { ok: true } }));
    const result = await runMcpCall({
      tool: 'demo.tool',
      argsJson: '{"limit":9,"name":"keep"}',
      argJson: ['limit=5', 'flag=true'],
      args: ['limit=5'],
      localUrl: url,
      out: sink().out,
    });
    expect(result.exitCode).toBe(0);
    expect((requests[0]!.body.params as { arguments: Record<string, unknown> }).arguments).toEqual({
      limit: '5',
      name: 'keep',
      flag: true,
    });
  });

  test('malformed --arg-json names the key and exits nonzero', async () => {
    const io = sink();
    const result = await runMcpCall({
      tool: 'demo.tool',
      argJson: ['limit={'],
      localUrl: 'http://127.0.0.1:1/v1/mcp',
      fetchFn: async () => {
        throw new Error('must not fetch after malformed --arg-json');
      },
      out: io.out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('mcp-usage-error');
    expect(result.message).toContain('limit');
    expect(result.message).toMatch(/invalid --arg-json limit/);
    expect(io.errors.join('\n')).toContain('limit');
  });

  test('server type-validation error appends --arg-json/--args-json guidance', async () => {
    const { url } = startMock(() => jsonRpcError({
      code: -32602,
      message: 'Input validation error: limit: Invalid input: expected number, received string',
    }));
    const io = sink();
    const result = await runMcpCall({
      tool: 'demo.tool',
      args: ['limit=5'],
      localUrl: url,
      out: io.out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('mcp-server-error');
    expect(result.message).toContain('expected number, received string');
    expect(result.message).toContain('--arg-json');
    expect(result.message).toContain('--args-json');
    expect(io.errors.join('\n')).toContain('--arg-json');
  });

  test('tool-level type-validation error also appends typed-arg guidance', async () => {
    const { url } = startMock(() => jsonRpc({
      isError: true,
      content: [{ type: 'text', text: 'Input validation error: flag: Invalid input: expected boolean, received string' }],
    }));
    const result = await runMcpCall({
      tool: 'demo.tool',
      args: ['flag=true'],
      localUrl: url,
      out: sink().out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('mcp-tool-error');
    expect(result.message).toContain('--arg-json');
    expect(result.message).toContain('--args-json');
  });

  test('non-type server errors do not append typed-arg guidance', async () => {
    const { url } = startMock(() => jsonRpcError({ code: -32000, message: 'upstream exploded' }));
    const result = await runMcpCall({
      tool: 'demo.tool',
      localUrl: url,
      out: sink().out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('mcp-server-error');
    expect(result.message).toBe('mcp server error: upstream exploded');
    expect(result.message).not.toContain('--arg-json');
  });

  test('authorization denied is nonzero and keeps the tool name', async () => {
    const { url } = startMock(() => jsonRpc({
      content: [{ type: 'text', text: 'mcp authorization denied: higgsfield.tiktok_publish' }],
      structuredContent: {
        ok: false,
        classification: 'mcp-authorization-denied',
        output: 'mcp authorization denied: higgsfield.tiktok_publish',
      },
    }));
    const io = sink();
    const result = await runMcpCall({
      tool: 'higgsfield.tiktok_publish',
      localUrl: url,
      out: io.out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('mcp-authorization-denied');
    expect(result.message).toContain('higgsfield.tiktok_publish');
    expect(result.message).toContain('mcp authorization denied');
    expect(io.errors.join('\n')).toContain('higgsfield.tiktok_publish');
  });

  test('quoted mcp authorization denied in a success payload is not a denial', async () => {
    const { url } = startMock(() => jsonRpc({
      content: [{ type: 'text', text: 'docs: the server says mcp authorization denied when a tool is not granted' }],
      structuredContent: {
        structured: { note: 'mcp authorization denied is the quoted server phrase' },
      },
    }));
    const result = await runMcpCall({
      tool: 'docs.explain',
      localUrl: url,
      out: sink().out,
    });
    expect(result.exitCode).toBe(0);
    expect(result.classification).toBe('ok');
    expect(result.message).toContain('mcp authorization denied');
  });

  test('JSON-RPC error object with authorization classification is a denial', async () => {
    const { url } = startMock(() => jsonRpcError({
      code: -32000,
      message: 'mcp authorization denied: locked.tool',
      data: { classification: 'mcp-authorization-denied' },
    }));
    const result = await runMcpCall({
      tool: 'locked.tool',
      localUrl: url,
      out: sink().out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('mcp-authorization-denied');
    expect(result.message).toContain('locked.tool');
  });

  test('JSON-RPC error quoting mcp authorization denied without classification stays mcp-server-error', async () => {
    const { url } = startMock(() => jsonRpcError({
      code: -32000,
      message: 'mcp authorization denied: quoted.tool',
    }));
    const result = await runMcpCall({
      tool: 'quoted.tool',
      localUrl: url,
      out: sink().out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('mcp-server-error');
    expect(result.classification).not.toBe('mcp-authorization-denied');
    expect(result.message).toBe('mcp server error: mcp authorization denied: quoted.tool');
  });

  test('HTTP 500 is nonzero and not an authorization denial', async () => {
    const { url } = startMock(() => new Response('boom', { status: 500 }));
    const result = await runMcpCall({
      tool: 'higgsfield.balance',
      localUrl: url,
      out: sink().out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('mcp-http-error');
    expect(result.message).toContain('HTTP 500');
    expect(result.message).not.toContain('mcp authorization denied');
    expect(result.classification).not.toBe('mcp-authorization-denied');
  });

  test('local calls never look up remote bookmarks', async () => {
    let lookedUp = false;
    const { url } = startMock(() => jsonRpc({ structuredContent: { ok: true } }));
    const result = await runMcpCall({
      tool: 'demo.tool',
      localUrl: url,
      out: sink().out,
      remotesStore: () => {
        lookedUp = true;
        return isolatedStore().store;
      },
    });
    expect(result.exitCode).toBe(0);
    expect(lookedUp).toBe(false);
  });

  test('unknown remote bookmark names the bookmark and does not fetch', async () => {
    const { store } = isolatedStore();
    let fetched = 0;
    const result = await runMcpCall({
      tool: 'demo.tool',
      remote: 'ghost',
      remotesStore: () => store,
      fetchFn: async () => {
        fetched += 1;
        return jsonRpc({});
      },
      out: sink().out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('mcp-remote-error');
    expect(result.message).toContain('ghost');
    expect(fetched).toBe(0);
  });

  test('remote bookmark token failure names the bookmark', async () => {
    const { store, dir } = isolatedStore();
    store.addRemote('box', {
      host: 'box',
      acp_url: 'ws://127.0.0.1:31415/v1/acp',
      token_file: join(dir, 'missing.token'),
      addedAt: new Date().toISOString(),
    });
    const result = await runMcpCall({
      tool: 'demo.tool',
      remote: 'box',
      remotesStore: () => store,
      out: sink().out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain('box');
    expect(result.classification).toBe('mcp-remote-error');
  });

  test('named remote posts to the bookmarked /v1/mcp with bearer token', async () => {
    const { requests, url, server } = startMock(() => jsonRpc({ structuredContent: { ok: true } }));
    const { store, dir } = isolatedStore();
    store.addRemote('box', entry(dir, 'box', `ws://127.0.0.1:${server.port}/v1/acp`, 'remote-token'));
    const result = await runMcpCall({
      tool: 'demo.tool',
      args: ['k=v'],
      remote: 'box',
      remotesStore: () => store,
      out: sink().out,
    });
    expect(result.exitCode).toBe(0);
    expect(url.endsWith('/v1/mcp')).toBe(true);
    expect(requests[0]!.auth).toBe('Bearer remote-token');
    expect((requests[0]!.body.params as { name: string }).name).toBe('demo.tool');
  });

  test('remote transport error names the bookmark', async () => {
    const { store, dir } = isolatedStore();
    store.addRemote('box', entry(dir, 'box', 'ws://127.0.0.1:1/v1/acp', 'tok'));
    const result = await runMcpCall({
      tool: 'demo.tool',
      remote: 'box',
      remotesStore: () => store,
      fetchFn: async () => { throw new Error('connect ECONNREFUSED'); },
      out: sink().out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('mcp-transport-error');
    expect(result.message).toContain('box');
    expect(result.message).toContain('connect ECONNREFUSED');
  });

  test('remote HTTP 500 names the bookmark and is not an authorization denial', async () => {
    const { server } = startMock(() => new Response('boom', { status: 500 }));
    const { store, dir } = isolatedStore();
    store.addRemote('box', entry(dir, 'box', `ws://127.0.0.1:${server.port}/v1/acp`, 'tok'));
    const result = await runMcpCall({
      tool: 'demo.tool',
      remote: 'box',
      remotesStore: () => store,
      out: sink().out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('mcp-http-error');
    expect(result.message).toContain('box');
    expect(result.message).toContain('HTTP 500');
    expect(result.message).not.toContain('mcp authorization denied');
  });

  test('remote JSON-RPC server error names the bookmark', async () => {
    const { server } = startMock(() => jsonRpcError({ code: -32000, message: 'upstream exploded' }));
    const { store, dir } = isolatedStore();
    store.addRemote('box', entry(dir, 'box', `ws://127.0.0.1:${server.port}/v1/acp`, 'tok'));
    const result = await runMcpCall({
      tool: 'demo.tool',
      remote: 'box',
      remotesStore: () => store,
      out: sink().out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('mcp-server-error');
    expect(result.message).toContain('box');
    expect(result.message).toContain('upstream exploded');
  });

  test.each([
    {
      body: {},
      expectedClassification: 'mcp-server-error',
      expectedMessage: 'mcp server error: response is not JSON-RPC 2.0',
    },
    {
      body: { jsonrpc: '2.0', id: 1, error: 'bad' },
      expectedClassification: 'mcp-server-error',
      expectedMessage: 'mcp server error: JSON-RPC error envelope is invalid',
    },
    {
      body: { jsonrpc: '2.0', id: 1 },
      expectedClassification: 'mcp-server-error',
      expectedMessage: 'mcp server error: JSON-RPC response has neither result nor error',
    },
    {
      body: { jsonrpc: '2.0', id: 1, result: {}, error: { code: -32000, message: 'x' } },
      expectedClassification: 'mcp-server-error',
      expectedMessage: 'mcp server error: JSON-RPC response has both result and error',
    },
  ] as const)('HTTP 200 malformed JSON-RPC envelope %#', async ({ body, expectedClassification, expectedMessage }) => {
    const { url } = startMock(() => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const result = await runMcpCall({ tool: 'demo.tool', localUrl: url, out: sink().out });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe(expectedClassification);
    expect(result.message).toBe(expectedMessage);
  });

  test('transport, HTTP, and tool-level failures stay distinct', async () => {
    const http = startMock(() => new Response('nope', { status: 500 }));
    const tool = startMock(() => jsonRpc({
      isError: true,
      content: [{ type: 'text', text: 'tool failed: boom' }],
    }));
    const httpResult = await runMcpCall({ tool: 'demo.tool', localUrl: http.url, out: sink().out });
    const toolResult = await runMcpCall({ tool: 'demo.tool', localUrl: tool.url, out: sink().out });
    const transportResult = await runMcpCall({
      tool: 'demo.tool',
      localUrl: 'http://127.0.0.1:1/v1/mcp',
      fetchFn: async () => { throw new Error('connect ECONNREFUSED'); },
      out: sink().out,
    });
    expect(new Set([httpResult.classification, toolResult.classification, transportResult.classification]).size).toBe(3);
    expect(httpResult.classification).toBe('mcp-http-error');
    expect(toolResult.classification).toBe('mcp-tool-error');
    expect(transportResult.classification).toBe('mcp-transport-error');
    expect(httpResult.message).not.toBe(toolResult.message);
    expect(toolResult.message).not.toBe(transportResult.message);
    expect(httpResult.exitCode).not.toBe(0);
    expect(toolResult.exitCode).not.toBe(0);
    expect(transportResult.exitCode).not.toBe(0);
  });
});

describe('runMcpList', () => {
  test('mcp list --json posts tools/list every time (no cache)', async () => {
    const { requests, url } = startMock(() => jsonRpc({ tools: [{ name: 'higgsfield.balance' }] }));
    const first = await runMcpList({ json: true, localUrl: url, out: sink().out });
    const second = await runMcpList({ json: true, localUrl: url, out: sink().out });
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body.method).toBe('tools/list');
    expect(requests[1]!.body.method).toBe('tools/list');
    expect(first.message).toContain('higgsfield.balance');
  });

  test('value-less -r uses the default bookmark', async () => {
    const { requests, server } = startMock(() => jsonRpc({ tools: [{ name: 'listed.tool' }] }));
    const dir = mkdtempSync(join(tmpdir(), 'mcp-call-r-'));
    dirs.push(dir);
    const prevConfigDir = getElanousConfigDirOverride();
    setElanousConfigDir(dir);
    const store = new RemotesStore();
    store.addRemote('home', entry(dir, 'home', `ws://127.0.0.1:${server.port}/v1/acp`, 'tok'), { setDefault: true });
    store.addRemote('other', entry(dir, 'other', 'ws://127.0.0.1:1/v1/acp', 'other-tok'));

    const stdout: string[] = [];
    const originalOut = process.stdout.write;
    const originalExit = process.exit;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    process.exit = ((code?: number) => {
      process.exitCode = code ?? 0;
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;
    try {
      await program.parseAsync(['node', 'elanous', 'mcp', 'list', '-r']);
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith('exit:'))) throw err;
    } finally {
      process.stdout.write = originalOut;
      process.exit = originalExit;
      if (prevConfigDir === undefined) resetElanousConfigDir();
      else setElanousConfigDir(prevConfigDir);
    }
    expect(process.exitCode).toBe(0);
    process.exitCode = 0;
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.method).toBe('tools/list');
    expect(requests[0]!.auth).toBe('Bearer tok');
    expect(stdout.join('')).toContain('listed.tool');
  });
});

describe('bin/elanous.mjs mcp call', () => {
  test('spawns mcp call demo.tool --arg k=v --remote box through the registered CLI', async () => {
    const { requests, server } = startMock((body) => {
      expect(body.method).toBe('tools/call');
      return jsonRpc({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { structured: { k: (body.params as { arguments?: { k?: string } }).arguments?.k } },
      });
    });
    const dir = mkdtempSync(join(tmpdir(), 'mcp-call-bin-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'remotes'), { recursive: true });
    const store = new RemotesStore({ remotesFilePath: join(dir, 'remotes.json'), tokensDir: join(dir, 'remotes') });
    store.addRemote('box', entry(join(dir, 'remotes'), 'box', `ws://127.0.0.1:${server.port}/v1/acp`, 'remote-token'));

    const proc = Bun.spawn({
      cmd: ['bun', BIN, '--test', '--config-dir', dir, 'mcp', 'call', 'demo.tool', '--arg', 'k=v', '--remote', 'box'],
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ELANOUS_DEBUG_LEVEL: 'off' },
    });
    const killer = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(killer);

    expect(exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.method).toBe('tools/call');
    expect((requests[0]!.body.params as { name: string }).name).toBe('demo.tool');
    expect((requests[0]!.body.params as { arguments: { k: string } }).arguments.k).toBe('v');
    expect(`${stdout}${stderr}`).toContain('"k": "v"');
  }, SPAWN_TIMEOUT_MS);

  test('spawns mcp call --arg-json limit=5 as a number while --arg stays a string', async () => {
    const { requests, server } = startMock((body) => {
      expect(body.method).toBe('tools/call');
      return jsonRpc({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { structured: (body.params as { arguments?: Record<string, unknown> }).arguments },
      });
    });
    const dir = mkdtempSync(join(tmpdir(), 'mcp-call-bin-json-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'remotes'), { recursive: true });
    const store = new RemotesStore({ remotesFilePath: join(dir, 'remotes.json'), tokensDir: join(dir, 'remotes') });
    store.addRemote('box', entry(join(dir, 'remotes'), 'box', `ws://127.0.0.1:${server.port}/v1/acp`, 'remote-token'));

    const proc = Bun.spawn({
      cmd: [
        'bun', BIN, '--test', '--config-dir', dir,
        'mcp', 'call', 'demo.tool',
        '--arg', 'name=123',
        '--arg-json', 'limit=5',
        '--arg-json', 'flag=true',
        '--remote', 'box',
      ],
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ELANOUS_DEBUG_LEVEL: 'off' },
    });
    const killer = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(killer);

    expect(exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    const sent = (requests[0]!.body.params as { arguments: Record<string, unknown> }).arguments;
    expect(sent.limit).toBe(5);
    expect(typeof sent.limit).toBe('number');
    expect(sent.flag).toBe(true);
    expect(sent.name).toBe('123');
    expect(typeof sent.name).toBe('string');
    expect(`${stdout}${stderr}`).toContain('"limit": 5');
  }, SPAWN_TIMEOUT_MS);

  test('with no localUrl the call goes to the injected daemon, not a guessed port', async () => {
    const { requests, url } = startMock(() => jsonRpc({ structuredContent: { ok: true } }));
    const base = url.replace(/\/v1\/mcp$/, '');
    setResolveDaemonEndpointForTest(() => ({
      baseUrl: base, healthUrl: `${base}/v1/health`, pwaUrl: `${base}/app/`, source: 'registry',
    }));
    try {
      const io = sink();
      const result = await runMcpCall({ tool: 'demo.tool', out: io.out });
      expect(result.exitCode).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url.startsWith(base)).toBe(true);
      expect(requests[0]!.url).not.toContain('31415');
    } finally {
      setResolveDaemonEndpointForTest(null);
    }
  });

  test('a null daemon endpoint is an error and never calls a guessed port', async () => {
    setResolveDaemonEndpointForTest(() => null);
    const fetched: string[] = [];
    try {
      const io = sink();
      const result = await runMcpCall({
        tool: 'demo.tool',
        out: io.out,
        fetchFn: async (input) => { fetched.push(String(input)); return jsonRpc({}); },
      });
      expect(result.exitCode).toBe(1);
      expect(result.classification).toBe('mcp-remote-error');
      expect(fetched).toEqual([]);
      expect(io.errors.join(' ')).not.toContain('31415');
    } finally {
      setResolveDaemonEndpointForTest(null);
    }
  });
});
