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
  liveFetchRemoteWorktrees,
  parseOrphanedSessionsField,
  parseRemoteWorktreesBody,
  renderRemoteWorktreesView,
  runHarnessWorktreesRemote,
} from './harness-worktrees-remote.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'harness-worktrees-remote-'));
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

function worktreesJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

async function startOutOfProcessWorktreeServer(
  home: string,
  payload: unknown,
  status = 200,
): Promise<{ port: string; hits: string; stop(): void }> {
  const hits = join(home, 'hits.jsonl');
  const portFile = join(home, 'port');
  const serverJs = join(home, 'server.mjs');
  writeFileSync(serverJs, `
    import { writeFileSync, appendFileSync } from 'node:fs';
    const srv = Bun.serve({ port: 0, fetch(req) {
      const u = new URL(req.url);
      appendFileSync(${JSON.stringify(hits)}, JSON.stringify({ path: u.pathname, auth: req.headers.get('authorization'), method: req.method }) + '\\n');
      return new Response(${JSON.stringify(JSON.stringify(payload))}, {
        status: ${status},
        headers: { 'content-type': 'application/json' },
      });
    }});
    writeFileSync(${JSON.stringify(portFile)}, String(srv.port));
  `);
  const child = spawn(process.execPath, [serverJs], { stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 30_000;
  while (!existsSync(portFile) && Date.now() < deadline) await Bun.sleep(50);
  if (!existsSync(portFile)) { child.kill('SIGKILL'); throw new Error('mock worktrees server never reported a port'); }
  return { port: readFileSync(portFile, 'utf8').trim(), hits, stop: () => { try { child.kill('SIGKILL'); } catch { /* already dead */ } } };
}

function writeBookmark(cfg: string, name: string, port: string, token: string): void {
  mkdirSync(join(cfg, 'remotes'), { recursive: true });
  writeFileSync(join(cfg, 'remotes', `${name}.token`), token);
  writeFileSync(join(cfg, 'remotes.json'), JSON.stringify({
    version: 1,
    default: name,
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

function readHits(hitsPath: string): Array<{ path: string; auth: string | null }> {
  if (!existsSync(hitsPath)) return [];
  return readFileSync(hitsPath, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { path: string; auth: string | null });
}

function initIsolatedGitRepo(root: string): void {
  const init = spawnSync('git', ['init', '-q', '-b', 'main', root], { encoding: 'utf8' });
  expect({ status: init.status, stderr: (init.stderr ?? '').slice(0, 200) }).toEqual({ status: 0, stderr: '' });
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  expect(spawnSync('git', ['-C', root, 'add', 'README.md'], { encoding: 'utf8' }).status).toBe(0);
  const commit = spawnSync('git', [
    '-C', root,
    '-c', 'user.email=fixture@example.test',
    '-c', 'user.name=fixture',
    'commit', '-q', '-m', 'init',
  ], { encoding: 'utf8' });
  expect({ status: commit.status, stderr: (commit.stderr ?? '').slice(0, 200) }).toEqual({ status: 0, stderr: '' });
}

describe('runHarnessWorktreesRemote', () => {
  test('named remote GETs /v1/worktrees with bearer token and renders the remote path', async () => {
    const { requests, server } = startMock(() => worktreesJson({
      repoRoot: '/remote/repo',
      worktrees: [{
        path: '/remote/repo/wt-alpha',
        branch: 'feat/alpha',
        sha: 'abc123',
        isMain: false,
        isLocked: false,
        isDetached: false,
        session: null,
        orphan: false,
      }],
      orphanedSessions: [],
    }));
    const { store, dir } = isolatedStore();
    store.addRemote('box', entry(dir, 'box', `ws://127.0.0.1:${server.port}/v1/acp`, 'remote-token'));
    const io = sink();
    const result = await runHarnessWorktreesRemote({
      remote: 'box',
      remotesStore: () => store,
      out: io.out,
    });
    expect(result.exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe('/v1/worktrees');
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.auth).toBe('Bearer remote-token');
    expect(result.message).toContain('/remote/repo/wt-alpha');
    expect(result.message).toContain('REMOTE');
    expect(result.message).toContain('box');
    expect(io.logs.join('\n')).toContain('/remote/repo/wt-alpha');
  });

  test('HTTP 401 names the bookmark and does not fall back to a local listing', async () => {
    const { server } = startMock(() => new Response('nope', { status: 401 }));
    const { store, dir } = isolatedStore();
    store.addRemote('box', entry(dir, 'box', `ws://127.0.0.1:${server.port}/v1/acp`, 'tok'));
    const io = sink();
    const result = await runHarnessWorktreesRemote({
      remote: 'box',
      remotesStore: () => store,
      out: io.out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('http-error');
    expect(result.message).toContain('box');
    expect(result.message).toContain('HTTP 401');
    expect(result.message).not.toContain('━━ harness worktrees (READ-ONLY) ━━');
    expect(io.logs.join('\n')).toBe('');
  });

  test('-r with --remove names the flag, the default bookmark, and does not fetch', async () => {
    let fetched = 0;
    const { store, dir } = isolatedStore();
    store.addRemote('home-box', entry(dir, 'home-box', 'ws://127.0.0.1:1/v1/acp', 'tok'), { setDefault: true });
    const result = await runHarnessWorktreesRemote({
      remote: true,
      remove: true,
      fetchFn: async () => {
        fetched += 1;
        return worktreesJson({ worktrees: [] });
      },
      remotesStore: () => store,
      out: sink().out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('usage-error');
    expect(result.message).toContain('--remove');
    expect(result.message).toContain('-r');
    expect(result.message).toContain('--remote');
    expect(result.message).toContain('home-box');
    expect(fetched).toBe(0);
  });

  test('named --remote with --remove names both the flag and the bookmark', async () => {
    const result = await runHarnessWorktreesRemote({
      remote: 'box',
      remove: true,
      out: sink().out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain('--remove');
    expect(result.message).toContain('box');
  });

  test('unknown remote bookmark names the bookmark and does not fetch', async () => {
    const { store } = isolatedStore();
    let fetched = 0;
    const result = await runHarnessWorktreesRemote({
      remote: 'ghost',
      remotesStore: () => store,
      fetchFn: async () => {
        fetched += 1;
        return worktreesJson({ worktrees: [] });
      },
      out: sink().out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('remote-error');
    expect(result.message).toContain('ghost');
    expect(fetched).toBe(0);
  });

  test('missing fields stay unknown; null stays absent; process liveness is not inferred', () => {
    const view = parseRemoteWorktreesBody({
      repoRoot: null,
      worktrees: [{
        path: '/remote/wt',
        branch: 'feat/x',
        // sha omitted → unknown
        isMain: false,
        session: { sessionId: '42' },
        // orphan omitted → unknown; alive omitted inside session → unknown
      }],
      orphanedSessions: [{ sessionId: '99', worktreePath: null }],
    }, 'box', 'http://127.0.0.1/v1/worktrees');
    expect(view.repoRoot).toEqual({ status: 'absent' });
    expect(view.worktrees[0]!.sha).toEqual({ status: 'unknown' });
    expect(view.worktrees[0]!.orphan).toEqual({ status: 'unknown' });
    expect(view.worktrees[0]!.session.status).toBe('value');
    if (view.worktrees[0]!.session.status === 'value') {
      expect(view.worktrees[0]!.session.value.alive).toEqual({ status: 'unknown' });
    }
    expect(view.orphanedSessions.status).toBe('value');
    if (view.orphanedSessions.status === 'value') {
      expect(view.orphanedSessions.value[0]!.worktreePath).toEqual({ status: 'absent' });
      expect(view.orphanedSessions.value[0]!.alive).toEqual({ status: 'unknown' });
    }
    const rendered = renderRemoteWorktreesView(view).join('\n');
    expect(rendered).toContain('alive=unknown');
    expect(rendered).toContain('orphan=unknown');
    expect(rendered).not.toContain('alive=true');
    expect(rendered).not.toContain('alive=false');
    expect(rendered).toContain('REMOTE');
  });

  test('omitted orphanedSessions stays unknown, not an empty list', () => {
    expect(parseOrphanedSessionsField(undefined)).toEqual({ status: 'unknown' });
    const view = parseRemoteWorktreesBody({
      repoRoot: '/remote/repo',
      worktrees: [],
    }, 'box', 'http://127.0.0.1/v1/worktrees');
    expect(view.orphanedSessions).toEqual({ status: 'unknown' });
    const rendered = renderRemoteWorktreesView(view).join('\n');
    expect(rendered).toContain('(no remote worktrees)');
    expect(rendered).toContain('orphanedSessions=unknown');
    expect(rendered).not.toContain('orphanedSessions=none');
    const json = JSON.stringify({ orphanedSessions: view.orphanedSessions });
    expect(json).toContain('"status":"unknown"');
    expect(json).not.toContain('"orphanedSessions":[]');
  });

  test('empty orphanedSessions array is present-empty, not unknown or absent', () => {
    const view = parseRemoteWorktreesBody({
      repoRoot: '/remote/repo',
      worktrees: [],
      orphanedSessions: [],
    }, 'box', 'http://127.0.0.1/v1/worktrees');
    expect(view.orphanedSessions).toEqual({ status: 'value', value: [] });
    const rendered = renderRemoteWorktreesView(view).join('\n');
    expect(rendered).toContain('(no remote worktrees)');
    expect(rendered).not.toContain('orphanedSessions=unknown');
    expect(rendered).not.toContain('orphanedSessions=none');
  });

  test('null orphanedSessions is absent, not an empty list', () => {
    const view = parseRemoteWorktreesBody({
      repoRoot: '/remote/repo',
      worktrees: [],
      orphanedSessions: null,
    }, 'box', 'http://127.0.0.1/v1/worktrees');
    expect(view.orphanedSessions).toEqual({ status: 'absent' });
    expect(renderRemoteWorktreesView(view).join('\n')).toContain('orphanedSessions=none');
  });

  test('invalid worktree rows fail as a protocol error instead of an empty listing', () => {
    expect(() => parseRemoteWorktreesBody({
      worktrees: [{ branch: 'feat/x' }],
    }, 'box', 'http://127.0.0.1/v1/worktrees')).toThrow(/worktrees\[0\].*path/);
    expect(() => parseRemoteWorktreesBody({
      worktrees: ['nope'],
    }, 'box', 'http://127.0.0.1/v1/worktrees')).toThrow(/worktrees\[0\] is not an object/);
    expect(() => parseRemoteWorktreesBody({
      worktrees: [],
    }, 'box', 'http://127.0.0.1/v1/worktrees')).not.toThrow();
  });

  test('all-invalid worktrees fail the remote lookup instead of rendering no remote worktrees', async () => {
    const { store, dir } = isolatedStore();
    store.addRemote('box', entry(dir, 'box', 'ws://127.0.0.1:1/v1/acp', 'tok'));
    const io = sink();
    const result = await runHarnessWorktreesRemote({
      remote: 'box',
      remotesStore: () => store,
      fetchFn: async () => worktreesJson({ worktrees: [{ branch: 'feat/x' }] }),
      out: io.out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain('box');
    expect(result.message).toContain('worktrees[0]');
    expect(result.message).not.toContain('(no remote worktrees)');
    expect(io.logs.join('\n')).toBe('');
  });

  test('a hanging server is aborted by the timeout wiring with a distinct time-failure wording', async () => {
    const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => { /* never answers */ }) });
    servers.push(hang);
    const started = Date.now();
    try {
      await liveFetchRemoteWorktrees(`http://127.0.0.1:${hang.port}/v1/worktrees`, 'tok', 120);
      throw new Error('expected timeout');
    } catch (err) {
      const elapsed = Date.now() - started;
      expect((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError').toBe(true);
      expect(elapsed).toBeLessThan(5_000);
    }
    const { store, dir } = isolatedStore();
    store.addRemote('slow', entry(dir, 'slow', `ws://127.0.0.1:${hang.port}/v1/acp`, 'tok'));
    const io = sink();
    const startedCli = Date.now();
    const result = await runHarnessWorktreesRemote({
      remote: 'slow',
      remotesStore: () => store,
      timeoutMs: 150,
      out: io.out,
    });
    const elapsedCli = Date.now() - startedCli;
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('timeout');
    expect(result.message).toContain('slow');
    expect(result.message).toContain('no response within');
    expect(result.message).not.toContain('HTTP 401');
    expect(elapsedCli).toBeLessThan(5_000);
  });

  test('headers-then-hung-body timeout stays timeout, not transport-error/non-JSON', async () => {
    const hangBody = Bun.serve({
      port: 0,
      fetch() {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"worktrees":['));
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    servers.push(hangBody);
    const { store, dir } = isolatedStore();
    store.addRemote('slow-body', entry(dir, 'slow-body', `ws://127.0.0.1:${hangBody.port}/v1/acp`, 'tok'));
    const io = sink();
    const started = Date.now();
    const result = await runHarnessWorktreesRemote({
      remote: 'slow-body',
      remotesStore: () => store,
      timeoutMs: 150,
      out: io.out,
    });
    const elapsed = Date.now() - started;
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('timeout');
    expect(result.message).toContain('slow-body');
    expect(result.message).toContain('no response within');
    expect(result.message).not.toContain('non-JSON response');
    expect(result.message).not.toContain('HTTP 401');
    expect(io.logs.join('\n')).toBe('');
    expect(elapsed).toBeLessThan(5_000);
  });

  test('AbortError from body read is timeout with no-response-within wording', async () => {
    const { store, dir } = isolatedStore();
    store.addRemote('box', entry(dir, 'box', 'ws://127.0.0.1:1/v1/acp', 'tok'));
    const io = sink();
    const result = await runHarnessWorktreesRemote({
      remote: 'box',
      remotesStore: () => store,
      timeoutMs: 150,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => {
          throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
        },
      } as unknown as Response),
      out: io.out,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.classification).toBe('timeout');
    expect(result.message).toContain('box');
    expect(result.message).toContain('no response within');
    expect(result.message).not.toContain('non-JSON response');
    expect(result.message).not.toContain('transport-error');
    expect(io.logs.join('\n')).toBe('');
  });
});

describe('harness worktrees CLI wiring', () => {
  test('-r without a value uses the default bookmark through program.parseAsync', async () => {
    const { requests, server } = startMock(() => worktreesJson({
      repoRoot: '/remote/repo',
      worktrees: [{ path: '/remote/via-r', branch: 'main', sha: '1', isMain: true, isLocked: false, isDetached: false, session: null, orphan: false }],
      orphanedSessions: [],
    }));
    const dir = mkdtempSync(join(tmpdir(), 'harness-worktrees-r-'));
    dirs.push(dir);
    const prevConfigDir = getElanousConfigDirOverride();
    setElanousConfigDir(dir);
    const store = new RemotesStore();
    store.addRemote('home', entry(dir, 'home', `ws://127.0.0.1:${server.port}/v1/acp`, 'tok'), { setDefault: true });
    store.addRemote('other', entry(dir, 'other', 'ws://127.0.0.1:1/v1/acp', 'other-tok'));

    const stdout: string[] = [];
    const originalOut = process.stdout.write;
    const originalExit = process.exit;
    const originalExitCode = process.exitCode;
    let exitCalls = 0;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    process.exit = ((code?: number) => {
      exitCalls += 1;
      process.exitCode = code ?? 0;
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;
    process.exitCode = 0;
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'worktrees', '-r']);
    } finally {
      process.stdout.write = originalOut;
      process.exit = originalExit;
      if (prevConfigDir === undefined) resetElanousConfigDir();
      else setElanousConfigDir(prevConfigDir);
    }
    expect(exitCalls).toBe(0);
    expect(process.exitCode).toBe(0);
    process.exitCode = originalExitCode ?? 0;
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe('/v1/worktrees');
    expect(requests[0]!.auth).toBe('Bearer tok');
    expect(stdout.join('')).toContain('/remote/via-r');
  });

  test('without -r the local entrypoint exits 0 and the out-of-process server records 0 hits', async () => {
    const home = mkdtempSync(join(tmpdir(), 'harness-worktrees-no-r-'));
    dirs.push(home);
    const repo = join(home, 'repo');
    mkdirSync(repo);
    initIsolatedGitRepo(repo);
    const binDir = join(home, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    let server: Awaited<ReturnType<typeof startOutOfProcessWorktreeServer>> | undefined;
    try {
      server = await startOutOfProcessWorktreeServer(home, { worktrees: [{ path: '/should-not-appear' }] });
      const cfg = join(home, '.elanous');
      writeBookmark(cfg, 'home', server.port, 'tok');
      const res = spawnSync(process.execPath, [BIN, '--test', '--config-dir', cfg, 'harness', 'worktrees', '--json'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          ELANOUS_DEBUG_LEVEL: 'off',
          HOME: home,
          ELANOUS_STATE_DIR: cfg,
          ELANOUS_CONFIG_DIR: cfg,
        },
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
      });
      expect(res.status).toBe(0);
      expect(`${res.stdout ?? ''}${res.stderr ?? ''}`).toContain(repo);
      expect(`${res.stdout ?? ''}${res.stderr ?? ''}`).not.toContain('/should-not-appear');
      expect(readHits(server.hits)).toHaveLength(0);
    } finally {
      server?.stop();
    }
  }, SPAWN_TIMEOUT_MS);
});

describe('bin/elanous.mjs harness worktrees -r', () => {
  test('LIVE CLI: harness worktrees --remote box hits /v1/worktrees with the bookmark token', async () => {
    const home = mkdtempSync(join(tmpdir(), 'harness-worktrees-live-'));
    dirs.push(home);
    let server: Awaited<ReturnType<typeof startOutOfProcessWorktreeServer>> | undefined;
    try {
      server = await startOutOfProcessWorktreeServer(home, {
        repoRoot: '/remote/repo',
        worktrees: [{ path: '/remote/repo/live-wt', branch: 'feat/live', sha: 'deadbeef', isMain: false, isLocked: false, isDetached: false, session: null, orphan: false }],
        orphanedSessions: [],
      });
      const cfg = join(home, '.elanous');
      writeBookmark(cfg, 'box', server.port, 'remote-token');
      const proc = Bun.spawn({
        cmd: ['bun', BIN, '--test', '--config-dir', cfg, 'harness', 'worktrees', '--remote', 'box'],
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
      expect(exitCode).toBe(0);
      const hits = readHits(server.hits);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.path).toBe('/v1/worktrees');
      expect(hits[0]!.auth).toBe('Bearer remote-token');
      expect(`${stdout}${stderr}`).toContain('/remote/repo/live-wt');
      expect(`${stdout}${stderr}`).toContain('REMOTE');
    } finally {
      server?.stop();
    }
  }, SPAWN_TIMEOUT_MS);

  test('LIVE CLI: 401 names the bookmark and does not print a local listing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'harness-worktrees-401-'));
    dirs.push(home);
    let server: Awaited<ReturnType<typeof startOutOfProcessWorktreeServer>> | undefined;
    try {
      server = await startOutOfProcessWorktreeServer(home, { error: 'unauthorized' }, 401);
      const cfg = join(home, '.elanous');
      writeBookmark(cfg, 'box', server.port, 'remote-token');
      const res = spawnSync(process.execPath, [BIN, '--test', '--config-dir', cfg, 'harness', 'worktrees', '--remote', 'box'], {
        cwd: REPO_ROOT,
        env: { ...process.env, ELANOUS_DEBUG_LEVEL: 'off', HOME: home, ELANOUS_STATE_DIR: cfg, ELANOUS_CONFIG_DIR: cfg },
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
      });
      expect(res.status).not.toBe(0);
      const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;
      expect(combined).toContain('box');
      expect(combined).toContain('401');
      expect(combined).not.toContain('━━ harness worktrees (READ-ONLY) ━━');
    } finally {
      server?.stop();
    }
  }, SPAWN_TIMEOUT_MS);

  test('LIVE CLI: -r --remove names --remove, -r, and the default bookmark', () => {
    const home = mkdtempSync(join(tmpdir(), 'harness-worktrees-remove-'));
    dirs.push(home);
    const cfg = join(home, '.elanous');
    writeBookmark(cfg, 'home-box', '1', 'tok');
    const res = spawnSync(process.execPath, [BIN, '--test', '--config-dir', cfg, 'harness', 'worktrees', '-r', '--remove'], {
      cwd: REPO_ROOT,
      env: { ...process.env, ELANOUS_DEBUG_LEVEL: 'off', HOME: home, ELANOUS_STATE_DIR: cfg, ELANOUS_CONFIG_DIR: cfg },
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    expect(res.status).not.toBe(0);
    const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    expect(combined).toContain('--remove');
    expect(combined).toContain('-r');
    expect(combined).toContain('--remote');
    expect(combined).toContain('home-box');
  });

  test('LIVE CLI: piped --json remote output is fully flushed before exit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'harness-worktrees-flush-'));
    dirs.push(home);
    const marker = `wt-flush-${'x'.repeat(64)}`;
    const worktrees = Array.from({ length: 80 }, (_, i) => ({
      path: `/remote/repo/${marker}-${i}`,
      branch: `feat/${i}`,
      sha: `deadbeef${i}`,
      isMain: false,
      isLocked: false,
      isDetached: false,
      session: null,
      orphan: false,
    }));
    let server: Awaited<ReturnType<typeof startOutOfProcessWorktreeServer>> | undefined;
    try {
      server = await startOutOfProcessWorktreeServer(home, {
        repoRoot: '/remote/repo',
        worktrees,
        orphanedSessions: [],
      });
      const cfg = join(home, '.elanous');
      writeBookmark(cfg, 'box', server.port, 'remote-token');
      const proc = Bun.spawn({
        cmd: ['bun', BIN, '--test', '--config-dir', cfg, 'harness', 'worktrees', '--remote', 'box', '--json'],
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
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain('non-JSON');
      const piped = stdout;
      expect(piped.trim().length).toBeGreaterThan(0);
      const lastLine = piped.replace(/\s+$/, '').split('\n').at(-1) ?? '';
      expect(lastLine.length).toBeGreaterThan(0);
      expect(piped).toContain(`${marker}-0`);
      expect(piped).toContain(`${marker}-79`);
      expect(piped.trim().endsWith('}')).toBe(true);
      const jsonStart = piped.indexOf('{');
      expect(jsonStart).toBeGreaterThanOrEqual(0);
      const parsed = JSON.parse(piped.slice(jsonStart)) as {
        worktrees: Array<{ path: string }>;
        orphanedSessions: { status: string; value?: unknown[] };
      };
      expect(parsed.worktrees).toHaveLength(80);
      expect(parsed.worktrees[0]!.path).toContain(`${marker}-0`);
      expect(parsed.worktrees[79]!.path).toContain(`${marker}-79`);
      expect(parsed.orphanedSessions.status).toBe('value');
      expect(parsed.orphanedSessions.value).toEqual([]);
    } finally {
      server?.stop();
    }
  }, SPAWN_TIMEOUT_MS);

  test('LIVE CLI: a hanging server fails by timeout with a distinct wording', async () => {
    const home = mkdtempSync(join(tmpdir(), 'harness-worktrees-hang-'));
    dirs.push(home);
    const portFile = join(home, 'port');
    const serverJs = join(home, 'hang.mjs');
    writeFileSync(serverJs, `
      import { writeFileSync } from 'node:fs';
      const srv = Bun.serve({ port: 0, fetch() { return new Promise(() => {}); } });
      writeFileSync(${JSON.stringify(portFile)}, String(srv.port));
    `);
    const child = spawn(process.execPath, [serverJs], { stdio: ['ignore', 'pipe', 'pipe'] });
    const deadline = Date.now() + 30_000;
    while (!existsSync(portFile) && Date.now() < deadline) await Bun.sleep(50);
    if (!existsSync(portFile)) { child.kill('SIGKILL'); throw new Error('hang server never reported a port'); }
    try {
      const cfg = join(home, '.elanous');
      writeBookmark(cfg, 'slow', readFileSync(portFile, 'utf8').trim(), 'tok');
      const started = Date.now();
      const res = spawnSync(process.execPath, [BIN, '--test', '--config-dir', cfg, 'harness', 'worktrees', '--remote', 'slow'], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ELANOUS_DEBUG_LEVEL: 'off',
          HOME: home,
          ELANOUS_STATE_DIR: cfg,
          ELANOUS_CONFIG_DIR: cfg,
          ELANOUS_HARNESS_WORKTREES_REMOTE_TIMEOUT_MS: '200',
        },
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
      });
      const elapsed = Date.now() - started;
      expect(res.status).not.toBe(0);
      const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;
      expect(combined).toContain('slow');
      expect(combined).toContain('no response within');
      expect(combined).not.toContain('HTTP 401');
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }
  }, SPAWN_TIMEOUT_MS);
});
