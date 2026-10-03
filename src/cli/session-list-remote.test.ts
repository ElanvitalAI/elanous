import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { program } from '../index.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { RemotesStore, type RemoteEntry } from './remotes.js';
import {
  formatRemoteSessionLine,
  liveFetchRemoteSessions,
  REMOTE_SESSIONS_STORE_PATH,
  resolveSessionListRemoteFlag,
  runSessionListRemote,
} from './session-list-remote.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

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
  const dir = mkdtempSync(join(tmpdir(), 'session-list-remote-'));
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

function startMock(handler: (req: Request) => Response | Promise<Response>) {
  const requests: Array<{ path: string; auth: string | null; method: string }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      requests.push({ path: url.pathname, auth: req.headers.get('authorization'), method: req.method });
      return handler(req);
    },
  });
  servers.push(server);
  return { server, requests, origin: `http://127.0.0.1:${server.port}` };
}

describe('runSessionListRemote', () => {
  test('GETs /v1/sessions/store with the bookmark bearer token and prints the returned session id', async () => {
    const { requests, server } = startMock(() => Response.json({
      ok: true,
      sessions: [{
        id: 'sess-from-mock',
        title: 't',
        source: 'cli',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        messageCount: 3,
        preview: 'hello',
      }],
    }));
    const { store, dir } = isolatedStore();
    store.addRemote('box', entry(dir, 'box', `ws://127.0.0.1:${server.port}/v1/acp`, 'remote-token'), { setDefault: true });
    const io = sink();
    const result = await runSessionListRemote({ remote: true, remotesStore: () => store, out: io.out });
    expect(result.exitCode).toBe(0);
    expect(requests).toEqual([{ path: '/v1/sessions/store', auth: 'Bearer remote-token', method: 'GET' }]);
    expect(requests[0]?.path).not.toBe('/v1/sessions');
    expect(result.message).toContain('sess-from-mock');
    expect(result.message).toContain('⟨remote:box⟩');
    expect(result.message).toContain('GET /v1/sessions/store');
    expect(io.logs.join('\n')).toContain('sess-from-mock');
  });

  test('named --remote uses THAT bookmark, not the default', async () => {
    const { requests, server } = startMock(() => Response.json({
      ok: true,
      sessions: [{ id: 'named-session' }],
    }));
    const { store, dir } = isolatedStore();
    store.addRemote('other', entry(dir, 'other', 'ws://127.0.0.1:1/v1/acp', 'other-token'), { setDefault: true });
    store.addRemote('named', entry(dir, 'named', `ws://127.0.0.1:${server.port}/v1/acp`, 'named-token'));
    const result = await runSessionListRemote({
      remote: 'named',
      remotesStore: () => store,
      out: sink().out,
    });
    expect(result.exitCode).toBe(0);
    expect(requests).toEqual([{ path: '/v1/sessions/store', auth: 'Bearer named-token', method: 'GET' }]);
    expect(result.message).toContain('named-session');
    expect(result.message).toContain('⟨remote:named⟩');
  });

  test('401 names the bookmark, is nonzero, and does not fall back to a local list', async () => {
    const { server } = startMock(() => Response.json({ error: 'unauthorized' }, { status: 401 }));
    const { store, dir } = isolatedStore();
    store.addRemote('iso', entry(dir, 'iso', `http://127.0.0.1:${server.port}/v1/acp`, 'bad-token'));
    let localHits = 0;
    const io = sink();
    const result = await runSessionListRemote({
      remote: 'iso',
      remotesStore: () => {
        localHits += 1;
        return store;
      },
      out: io.out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('session-list-http-error');
    expect(result.message).toContain('iso');
    expect(result.message).toMatch(/HTTP 401|unauthorized/i);
    expect(io.logs.join('')).toBe('');
    expect(io.errors.join('\n')).toContain('iso');
    expect(io.errors.join('\n')).not.toContain('No sessions yet');
    expect(localHits).toBe(1);
  });

  test('-r with --all-instances names the flag and does not fetch', async () => {
    let fetched = 0;
    const { store, dir } = isolatedStore();
    store.addRemote('box', entry(dir, 'box', 'ws://127.0.0.1:31415/v1/acp', 'tok'), { setDefault: true });
    const io = sink();
    const result = await runSessionListRemote({
      remote: true,
      allInstances: true,
      remotesStore: () => store,
      fetchRemoteSessions: async () => {
        fetched += 1;
        return { ok: true, sessions: [] };
      },
      out: io.out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('session-list-usage-error');
    expect(result.message).toContain('--all-instances');
    expect(fetched).toBe(0);
    expect(io.logs.join('')).toBe('');
  });

  test('unknown bookmark names the bookmark and does not fetch', async () => {
    const { store } = isolatedStore();
    let fetched = 0;
    const result = await runSessionListRemote({
      remote: 'ghost',
      remotesStore: () => store,
      fetchRemoteSessions: async () => {
        fetched += 1;
        return { ok: true, sessions: [] };
      },
      out: sink().out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('session-list-remote-error');
    expect(result.message).toContain('ghost');
    expect(fetched).toBe(0);
  });

  test('missing token names the bookmark and does not fetch', async () => {
    const { store, dir } = isolatedStore();
    store.addRemote('box', {
      host: 'box',
      acp_url: 'ws://127.0.0.1:31415/v1/acp',
      token_file: join(dir, 'missing.token'),
      addedAt: new Date().toISOString(),
    });
    const result = await runSessionListRemote({
      remote: 'box',
      remotesStore: () => store,
      out: sink().out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain('box');
    expect(result.classification).toBe('session-list-remote-error');
  });

  test('transport error names the bookmark and is not an HTTP failure', async () => {
    const { store, dir } = isolatedStore();
    store.addRemote('box', entry(dir, 'box', 'ws://127.0.0.1:1/v1/acp', 'tok'));
    const result = await runSessionListRemote({
      remote: 'box',
      remotesStore: () => store,
      fetchRemoteSessions: async () => { throw new Error('connect ECONNREFUSED'); },
      out: sink().out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('session-list-transport-error');
    expect(result.message).toContain('box');
    expect(result.message).toContain('connect ECONNREFUSED');
    expect(result.classification).not.toBe('session-list-timeout-error');
  });

  test('timeout failure is classified and worded distinctly from HTTP/transport', async () => {
    const { store, dir } = isolatedStore();
    store.addRemote('slow', entry(dir, 'slow', 'ws://127.0.0.1:9/v1/acp', 'tok'), { setDefault: true });
    const io = sink();
    const result = await runSessionListRemote({
      remote: true,
      remotesStore: () => store,
      fetchRemoteSessions: async () => ({
        ok: false as const,
        status: 0,
        timeout: true,
        reason: 'no response within 120ms (remote daemon unreachable or hung)',
      }),
      out: io.out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('session-list-timeout-error');
    expect(result.message).toContain('slow');
    expect(result.message).toContain('no response within');
    expect(result.classification).not.toBe('session-list-http-error');
    expect(result.classification).not.toBe('session-list-transport-error');
    expect(io.logs.join('')).toBe('');
  });

  test('LIVE: a hanging server is aborted BY THE TIMEOUT WIRING', async () => {
    const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => { /* never */ }) });
    servers.push(hang);
    const started = Date.now();
    const result = await liveFetchRemoteSessions(`http://127.0.0.1:${hang.port}${REMOTE_SESSIONS_STORE_PATH}`, 'tok', 120);
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('no response within 120ms');
    expect((result as { timeout?: boolean }).timeout).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);

  test('missing store-card fields stay unknown; present empty stays empty', () => {
    const missing = formatRemoteSessionLine({ id: 'only-id' }, 'iso');
    expect(missing).toContain('only-id');
    expect(missing).toContain('unknown');
    expect(missing).toContain('⟨remote:iso⟩');
    expect(missing).not.toContain('msg');
    const empty = formatRemoteSessionLine({
      id: 'with-empty',
      title: '',
      source: '',
      createdAt: '',
      updatedAt: '',
      preview: '',
      messageCount: 0,
    }, 'iso');
    expect(empty).toContain('with-empty');
    expect(empty).toContain('0msg');
    expect(empty).not.toMatch(/unknown/);
  });

  test('missing preview is labeled unknown, not omitted', () => {
    const line = formatRemoteSessionLine({
      id: 'no-preview',
      title: 't',
      source: 'cli',
      updatedAt: '2026-09-01T00:00:00.000Z',
      messageCount: 1,
    }, 'iso');
    expect(line).toContain('no-preview');
    expect(line).toMatch(/unknown$/);
    expect(line.endsWith(' ')).toBe(false);
    expect(line).not.toContain('(empty)');
  });

  test('present empty preview is labeled (empty), not a trailing space', () => {
    const line = formatRemoteSessionLine({
      id: 'empty-preview',
      title: 't',
      source: 'cli',
      updatedAt: '2026-09-01T00:00:00.000Z',
      messageCount: 1,
      preview: '',
    }, 'iso');
    expect(line).toContain('empty-preview');
    expect(line).toContain('(empty)');
    expect(line).not.toMatch(/unknown/);
    expect(line.endsWith(' ')).toBe(false);
    expect(line.endsWith('(empty)')).toBe(true);
  });

  test('wrong-type preview is rejected as a malformed store card, not guessed', async () => {
    const { requests, server } = startMock(() => Response.json({
      ok: true,
      sessions: [{ id: 'bad-preview', title: 't', messageCount: 1, preview: 12 }],
    }));
    const { store, dir } = isolatedStore();
    store.addRemote('box', entry(dir, 'box', `ws://127.0.0.1:${server.port}/v1/acp`, 'tok'), { setDefault: true });
    const io = sink();
    const result = await runSessionListRemote({ remote: true, remotesStore: () => store, out: io.out });
    expect(requests).toEqual([{ path: '/v1/sessions/store', auth: 'Bearer tok', method: 'GET' }]);
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('session-list-server-error');
    expect(result.message).toMatch(/malformed/);
    expect(io.logs.join('')).toBe('');
    expect(io.logs.join('')).not.toContain('unknown');
    expect(io.logs.join('')).not.toContain('(empty)');
  });

  test('does not invent fields the remote did not send', async () => {
    const { server } = startMock(() => Response.json({
      ok: true,
      sessions: [{ id: 'bare-id' }],
    }));
    const { store, dir } = isolatedStore();
    store.addRemote('box', entry(dir, 'box', `ws://127.0.0.1:${server.port}/v1/acp`, 'tok'), { setDefault: true });
    const result = await runSessionListRemote({ remote: true, remotesStore: () => store, json: true, out: sink().out });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.message) as { sessions: Array<Record<string, unknown>> };
    expect(parsed.sessions).toEqual([{ id: 'bare-id' }]);
    expect(parsed.sessions[0]).not.toHaveProperty('title');
    expect(parsed.sessions[0]).not.toHaveProperty('messageCount');
    expect(parsed.sessions[0]).not.toHaveProperty('updatedAt');
    expect(parsed.sessions[0]).not.toHaveProperty('source');
    expect(parsed.sessions[0]).not.toHaveProperty('preview');
    expect(parsed.sessions[0]).not.toHaveProperty('createdAt');
  });

  test('store-card payload prints the session id and message count', async () => {
    const { requests, server } = startMock(() => Response.json({
      ok: true,
      sessions: [{ id: 's1', title: 't', messageCount: 5 }],
    }));
    const { store, dir } = isolatedStore();
    store.addRemote('box', entry(dir, 'box', `ws://127.0.0.1:${server.port}/v1/acp`, 'tok'), { setDefault: true });
    const result = await runSessionListRemote({ remote: true, remotesStore: () => store, out: sink().out });
    expect(result.exitCode).toBe(0);
    expect(requests).toEqual([{ path: '/v1/sessions/store', auth: 'Bearer tok', method: 'GET' }]);
    expect(result.message).toContain('s1');
    expect(result.message).toContain('5msg');
    expect(result.message).toContain('GET /v1/sessions/store');
  });

  test('successful empty store list still names GET /v1/sessions/store', async () => {
    const { requests, server } = startMock(() => Response.json({ ok: true, sessions: [] }));
    const { store, dir } = isolatedStore();
    store.addRemote('mac', entry(dir, 'mac', `ws://127.0.0.1:${server.port}/v1/acp`, 'tok'), { setDefault: true });
    const io = sink();
    const result = await runSessionListRemote({ remote: true, remotesStore: () => store, out: io.out });
    expect(result.exitCode).toBe(0);
    expect(result.classification).toBe('ok');
    expect(requests).toEqual([{ path: '/v1/sessions/store', auth: 'Bearer tok', method: 'GET' }]);
    expect(result.message).toContain('0건');
    expect(result.message).toContain('GET /v1/sessions/store');
    expect(result.message).toContain('(세션 없음)');
    expect(result.message).not.toContain('GET /v1/sessions\n');
    expect(io.errors.join('')).toBe('');
  });

  test('in-memory history shape on the old route is not a store list', async () => {
    const { requests, server } = startMock((req) => {
      const path = new URL(req.url).pathname;
      if (path === '/v1/sessions') return Response.json({ sessions: [] });
      return new Response('not-found', { status: 404 });
    });
    const { store, dir } = isolatedStore();
    store.addRemote('box', entry(dir, 'box', `ws://127.0.0.1:${server.port}/v1/acp`, 'tok'), { setDefault: true });
    const result = await runSessionListRemote({ remote: true, remotesStore: () => store, out: sink().out });
    expect(requests.map((row) => row.path)).toEqual(['/v1/sessions/store']);
    expect(requests.map((row) => row.path)).not.toContain('/v1/sessions');
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('session-list-http-error');
    expect(result.message).toMatch(/HTTP 404/);
  });

  test('in-memory empty list body is not a successful 0-session store list', async () => {
    const { requests, server } = startMock(() => Response.json({ sessions: [] }));
    const { store, dir } = isolatedStore();
    store.addRemote('box', entry(dir, 'box', `ws://127.0.0.1:${server.port}/v1/acp`, 'tok'), { setDefault: true });
    const io = sink();
    const result = await runSessionListRemote({ remote: true, remotesStore: () => store, out: io.out });
    expect(requests).toEqual([{ path: '/v1/sessions/store', auth: 'Bearer tok', method: 'GET' }]);
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('session-list-server-error');
    expect(result.message).toContain('/v1/sessions/store');
    expect(io.logs.join('')).not.toContain('0건');
  });
});

describe('session list CLI wiring', () => {
  test('CLI registers value-less -r and named --remote', () => {
    const session = program.commands.find((c) => c.name() === 'session');
    const list = session?.commands.find((c) => c.name() === 'list');
    expect(list).toBeDefined();
    const flags = list!.options.map((o) => ({ short: o.short, long: o.long, required: o.required, optional: o.optional }));
    expect(flags).toContainEqual({ short: '-r', long: undefined, required: false, optional: false });
    expect(flags).toContainEqual({ short: undefined, long: '--remote', required: true, optional: false });
    expect(resolveSessionListRemoteFlag({ r: true })).toBe(true);
    expect(resolveSessionListRemoteFlag({ remote: 'iso' })).toBe('iso');
    expect(resolveSessionListRemoteFlag({})).toBeUndefined();
  });

  test('without -r the remote helper is not invoked (local list path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-list-local-'));
    dirs.push(dir);
    const prev = getElanousConfigDirOverride();
    setElanousConfigDir(dir);
    const stdout: string[] = [];
    const originalOut = process.stdout.write;
    const originalLog = console.log;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    console.log = ((...args: unknown[]) => { stdout.push(`${args.map(String).join(' ')}\n`); }) as typeof console.log;
    try {
      await program.parseAsync(['node', 'elanous', 'session', 'list']);
    } finally {
      process.stdout.write = originalOut;
      console.log = originalLog;
      if (prev === undefined) resetElanousConfigDir();
      else setElanousConfigDir(prev);
    }
    const out = stdout.join('');
    expect(out).not.toContain('/v1/sessions/store');
    expect(out).not.toContain('⟨remote:');
  });

  test('remote list sets process.exitCode and returns without process.exit so stdout can drain', async () => {
    const { requests, server } = startMock(() => Response.json({
      ok: true,
      sessions: [{ id: 'drain-session' }],
    }));
    const dir = mkdtempSync(join(tmpdir(), 'session-list-exitcode-'));
    dirs.push(dir);
    const prev = getElanousConfigDirOverride();
    setElanousConfigDir(dir);
    const store = new RemotesStore();
    store.addRemote('box', entry(dir, 'box', `ws://127.0.0.1:${server.port}/v1/acp`, 'tok'), { setDefault: true });
    const stdout: string[] = [];
    const originalOut = process.stdout.write;
    const originalExit = process.exit;
    const previousExitCode = process.exitCode;
    let exitCalls = 0;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    process.exit = ((code?: number) => {
      exitCalls += 1;
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;
    process.exitCode = 0;
    try {
      await program.parseAsync(['node', 'elanous', 'session', 'list', '-r']);
    } finally {
      process.stdout.write = originalOut;
      process.exit = originalExit;
      if (prev === undefined) resetElanousConfigDir();
      else setElanousConfigDir(prev);
    }
    expect(exitCalls).toBe(0);
    expect(process.exitCode).toBe(0);
    process.exitCode = previousExitCode ?? 0;
    expect(requests).toEqual([{ path: '/v1/sessions/store', auth: 'Bearer tok', method: 'GET' }]);
    expect(stdout.join('')).toContain('drain-session');
    expect(stdout.join('')).toContain('⟨remote:box⟩');
    expect(stdout.join('')).toContain('GET /v1/sessions/store');
  });

  test('remote 401 sets nonzero process.exitCode without process.exit or a local list', async () => {
    const { server } = startMock(() => Response.json({ error: 'unauthorized' }, { status: 401 }));
    const dir = mkdtempSync(join(tmpdir(), 'session-list-exitcode-401-'));
    dirs.push(dir);
    const prev = getElanousConfigDirOverride();
    setElanousConfigDir(dir);
    const store = new RemotesStore();
    store.addRemote('iso', entry(dir, 'iso', `ws://127.0.0.1:${server.port}/v1/acp`, 'bad-token'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    const originalExit = process.exit;
    const previousExitCode = process.exitCode;
    let exitCalls = 0;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number) => {
      exitCalls += 1;
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;
    process.exitCode = 0;
    try {
      await program.parseAsync(['node', 'elanous', 'session', 'list', '--remote', 'iso']);
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      process.exit = originalExit;
      if (prev === undefined) resetElanousConfigDir();
      else setElanousConfigDir(prev);
    }
    expect(exitCalls).toBe(0);
    expect(process.exitCode).not.toBe(0);
    const code = process.exitCode;
    process.exitCode = previousExitCode ?? 0;
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('iso');
    expect(stderr.join('')).toMatch(/HTTP 401|unauthorized/i);
    expect(stdout.join('')).not.toContain('No sessions yet');
    expect(stdout.join('')).not.toContain('Sessions (');
  });
});

describe('bin/elanous.mjs session list -r', () => {
  async function startOutOfProcessSessionServer(
    home: string,
    sessionId: string,
    status = 200,
  ): Promise<{ port: string; hits: string; stop(): void }> {
    const hits = join(home, `hits-${sessionId}.jsonl`);
    const portFile = join(home, `port-${sessionId}`);
    const serverJs = join(home, `server-${sessionId}.mjs`);
    writeFileSync(serverJs, `
      import { writeFileSync, appendFileSync } from 'node:fs';
      const srv = Bun.serve({ port: 0, fetch(req) {
        const u = new URL(req.url);
        appendFileSync(${JSON.stringify(hits)}, JSON.stringify({ path: u.pathname, auth: req.headers.get('authorization'), method: req.method }) + '\\n');
        if (u.pathname !== '/v1/sessions/store') return new Response('not-found', { status: 404 });
        return Response.json({ ok: true, sessions: [{ id: ${JSON.stringify(sessionId)}, title: 'live', source: 'cli', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', messageCount: 2, preview: 'hi' }] }, { status: ${status} });
      }});
      writeFileSync(${JSON.stringify(portFile)}, String(srv.port));
    `);
    const child = spawn(process.execPath, [serverJs], { stdio: ['ignore', 'pipe', 'pipe'] });
    const deadline = Date.now() + 30_000;
    while (!existsSync(portFile) && Date.now() < deadline) await Bun.sleep(50);
    if (!existsSync(portFile)) { child.kill('SIGKILL'); throw new Error('mock session server never reported a port'); }
    return { port: readFileSync(portFile, 'utf8').trim(), hits, stop: () => { try { child.kill('SIGKILL'); } catch { /* already dead */ } } };
  }

  function writeBookmark(cfg: string, name: string, port: string, token: string, setDefault = true): void {
    mkdirSync(join(cfg, 'remotes'), { recursive: true });
    writeFileSync(join(cfg, 'remotes', `${name}.token`), token);
    writeFileSync(join(cfg, 'remotes.json'), JSON.stringify({
      version: 1,
      ...(setDefault ? { default: name } : {}),
      remotes: {
        [name]: {
          host: `127.0.0.1:${port}`,
          acp_url: `ws://127.0.0.1:${port}/v1/acp`,
          token_file: join(cfg, 'remotes', `${name}.token`),
          addedAt: '2026-09-01T00:00:00Z',
        },
      },
    }));
  }

  test('LIVE CLI: session list -r GETs /v1/sessions/store with the bookmark token and prints the id', async () => {
    const home = mkdtempSync(join(tmpdir(), 'session-list-live-r-'));
    dirs.push(home);
    let server: Awaited<ReturnType<typeof startOutOfProcessSessionServer>> | undefined;
    try {
      server = await startOutOfProcessSessionServer(home, 'via-bare-r');
      const cfg = join(home, '.elanous');
      writeBookmark(cfg, 'named', server.port, 'named-token');
      const proc = Bun.spawn({
        cmd: ['bun', BIN, '--test', '--config-dir', cfg, 'session', 'list', '-r'],
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ELANOUS_DEBUG_LEVEL: 'off', HOME: home, ELANOUS_STATE_DIR: cfg, ELANOUS_CONFIG_DIR: cfg },
      });
      const killer = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(killer);
      const out = `${stdout}${stderr}`;
      expect(existsSync(server.hits)).toBe(true);
      const received = readFileSync(server.hits, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(received).toEqual([{ path: '/v1/sessions/store', auth: 'Bearer named-token', method: 'GET' }]);
      expect(out).toContain('via-bare-r');
      expect(out).toContain('⟨remote:named⟩');
      expect(out).toContain('GET /v1/sessions/store');
      expect(exitCode).toBe(0);
    } finally {
      server?.stop();
    }
  }, SPAWN_TIMEOUT_MS);

  test('LIVE CLI: named-bookmark 401 is nonzero, names the bookmark, and does not print a local list', async () => {
    const home = mkdtempSync(join(tmpdir(), 'session-list-live-401-'));
    dirs.push(home);
    const hits = join(home, 'hits.jsonl');
    const portFile = join(home, 'port');
    const serverJs = join(home, 'server.mjs');
    writeFileSync(serverJs, `
      import { writeFileSync, appendFileSync } from 'node:fs';
      const srv = Bun.serve({ port: 0, fetch(req) {
        const u = new URL(req.url);
        appendFileSync(${JSON.stringify(hits)}, JSON.stringify({ path: u.pathname, auth: req.headers.get('authorization') }) + '\\n');
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }});
      writeFileSync(${JSON.stringify(portFile)}, String(srv.port));
    `);
    const child = spawn(process.execPath, [serverJs], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const deadline = Date.now() + 30_000;
      while (!existsSync(portFile) && Date.now() < deadline) await Bun.sleep(50);
      expect(existsSync(portFile)).toBe(true);
      const port = readFileSync(portFile, 'utf8').trim();
      const cfg = join(home, '.elanous');
      writeBookmark(cfg, 'iso', port, 'bad-token', false);
      const proc = Bun.spawn({
        cmd: ['bun', BIN, '--test', '--config-dir', cfg, 'session', 'list', '--remote', 'iso'],
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ELANOUS_DEBUG_LEVEL: 'off', HOME: home, ELANOUS_STATE_DIR: cfg, ELANOUS_CONFIG_DIR: cfg },
      });
      const killer = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(killer);
      const out = `${stdout}${stderr}`;
      expect(exitCode).not.toBe(0);
      expect(out).toContain('iso');
      expect(out).toMatch(/HTTP 401|unauthorized/i);
      expect(stdout).not.toContain('No sessions yet');
      expect(stdout).not.toContain('Sessions (');
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }
  }, SPAWN_TIMEOUT_MS);

  test('LIVE CLI: -r with --all-instances is nonzero and names the flag', () => {
    const home = mkdtempSync(join(tmpdir(), 'session-list-flag-conflict-'));
    dirs.push(home);
    const cfg = join(home, '.elanous');
    writeBookmark(cfg, 'box', '9', 'tok');
    const res = spawnSync(process.execPath, [BIN, '--test', '--config-dir', cfg, 'session', 'list', '-r', '--all-instances'], {
      cwd: REPO_ROOT,
      env: { ...process.env, ELANOUS_DEBUG_LEVEL: 'off', HOME: home, ELANOUS_STATE_DIR: cfg, ELANOUS_CONFIG_DIR: cfg },
      encoding: 'utf8',
      timeout: 30_000,
    });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    expect(res.status).not.toBe(0);
    expect(out).toContain('--all-instances');
    expect(out).not.toContain('No sessions yet');
  });

  test('LIVE CLI: without -r the remote is not queried', () => {
    const home = mkdtempSync(join(tmpdir(), 'session-list-no-r-'));
    dirs.push(home);
    const cfg = join(home, '.elanous');
    writeBookmark(cfg, 'box', '1', 'tok');
    const res = spawnSync(process.execPath, [BIN, '--test', '--config-dir', cfg, 'session', 'list'], {
      cwd: REPO_ROOT,
      env: { ...process.env, ELANOUS_DEBUG_LEVEL: 'off', HOME: home, ELANOUS_STATE_DIR: cfg, ELANOUS_CONFIG_DIR: cfg },
      encoding: 'utf8',
      timeout: 30_000,
    });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    expect(out).not.toContain('/v1/sessions/store');
    expect(out).not.toContain('⟨remote:');
    expect(out).not.toContain('lookup failed');
  });

  test('LIVE CLI: hanging remote with a short timeout fails as time, not HTTP', async () => {
    const home = mkdtempSync(join(tmpdir(), 'session-list-timeout-'));
    dirs.push(home);
    const portFile = join(home, 'port');
    const serverJs = join(home, 'hang.mjs');
    writeFileSync(serverJs, `
      import { writeFileSync } from 'node:fs';
      const srv = Bun.serve({ port: 0, fetch() { return new Promise(() => {}); } });
      writeFileSync(${JSON.stringify(portFile)}, String(srv.port));
    `);
    const child = spawn(process.execPath, [serverJs], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const deadline = Date.now() + 30_000;
      while (!existsSync(portFile) && Date.now() < deadline) await Bun.sleep(50);
      expect(existsSync(portFile)).toBe(true);
      const port = readFileSync(portFile, 'utf8').trim();
      const cfg = join(home, '.elanous');
      writeBookmark(cfg, 'slow', port, 'tok');
      const started = Date.now();
      const proc = Bun.spawn({
        cmd: ['bun', BIN, '--test', '--config-dir', cfg, 'session', 'list', '-r', '--timeout', '200'],
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ELANOUS_DEBUG_LEVEL: 'off', HOME: home, ELANOUS_STATE_DIR: cfg, ELANOUS_CONFIG_DIR: cfg },
      });
      const killer = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(killer);
      const elapsed = Date.now() - started;
      const out = `${stdout}${stderr}`;
      expect(exitCode).not.toBe(0);
      expect(out).toContain('slow');
      expect(out).toContain('no response within');
      expect(out).not.toMatch(/HTTP 401|HTTP 500/);
      expect(elapsed).toBeLessThan(8_000);
      expect(stdout).not.toContain('No sessions yet');
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }
  }, SPAWN_TIMEOUT_MS);
});
