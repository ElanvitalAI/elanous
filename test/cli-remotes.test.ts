// T4.B — RemotesStore + cli action tests.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import {
  RemotesStore,
  isValidName,
  deriveNameFromHost,
  normalizeHost,
} from '../src/cli/remotes.js';
import {
  connectRemote,
  listRemotesCmd,
  switchRemote,
  removeRemoteCmd,
} from '../src/cli/remotes-cli.js';

function mkStore(): { store: RemotesStore; remotesFilePath: string; tokensDir: string; cleanup: () => void } {
  const root = mkdtempSync(joinPath(tmpdir(), 'elanous-remotes-'));
  const remotesFilePath = joinPath(root, 'remotes.json');
  const tokensDir = joinPath(root, 'remotes');
  const store = new RemotesStore({ remotesFilePath, tokensDir });
  return { store, remotesFilePath, tokensDir, cleanup: () => rmSync(root, { recursive: true }) };
}

function captureOut(): { out: { log: (s: string) => void; error: (s: string) => void }; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
    logs,
    errors,
  };
}

function makeFetchOk(connectInfo: Record<string, unknown> | null = null): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith('/v1/health')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.endsWith('/v1/nexus/connect-info')) {
      if (connectInfo === null) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(connectInfo), { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

describe('T4.B · isValidName / deriveNameFromHost / normalizeHost', () => {
  test('isValidName allows alnum + _ + - up to 64', () => {
    expect(isValidName('mbp')).toBe(true);
    expect(isValidName('mbp_home-1')).toBe(true);
    expect(isValidName('a'.repeat(64))).toBe(true);
    expect(isValidName('a'.repeat(65))).toBe(false);
    expect(isValidName('')).toBe(false);
    expect(isValidName('has space')).toBe(false);
    expect(isValidName('dot.in.middle')).toBe(false);
  });

  test('deriveNameFromHost strips port + sanitizes', () => {
    expect(deriveNameFromHost('mbp.tailnet')).toBe('mbp-tailnet');
    expect(deriveNameFromHost('http://mbp.tailnet:31415')).toBe('mbp-tailnet');
    expect(deriveNameFromHost('192.168.1.10')).toBe('192-168-1-10');
  });

  test('normalizeHost adds scheme + default port', () => {
    expect(normalizeHost('mbp.tailnet')).toEqual({
      url: 'http://mbp.tailnet:31415',
      host: 'mbp.tailnet',
      port: 31415,
    });
    expect(normalizeHost('http://x:9999')).toEqual({
      url: 'http://x:9999',
      host: 'x',
      port: 9999,
    });
  });
});

describe('T4.B · RemotesStore', () => {
  test('add → load round-trip; first add becomes default', () => {
    const { store, remotesFilePath, cleanup } = mkStore();
    store.addRemote('mbp', {
      host: 'mbp.tailnet',
      acp_url: 'ws://mbp.tailnet:31415/v1/acp',
      token_file: '/tmp/x',
      addedAt: '2026-05-07T00:00:00Z',
    });
    const file = JSON.parse(readFileSync(remotesFilePath, 'utf-8'));
    expect(file.version).toBe(1);
    expect(file.default).toBe('mbp');
    expect(file.remotes.mbp.host).toBe('mbp.tailnet');
    cleanup();
  });

  test('file mode = 0o600 after save', () => {
    const { store, remotesFilePath, cleanup } = mkStore();
    store.addRemote('a', {
      host: 'a',
      acp_url: 'ws://a:31415/v1/acp',
      token_file: '/tmp/x',
      addedAt: 'now',
    });
    const mode = statSync(remotesFilePath).mode & 0o777;
    expect(mode).toBe(0o600);
    cleanup();
  });

  test('removeRemote deletes token file + falls back to first remaining as default', () => {
    const { store, cleanup } = mkStore();
    const tokenA = store.saveToken('a', 'tokA');
    store.addRemote('a', {
      host: 'a', acp_url: 'ws://a:31415/v1/acp', token_file: tokenA, addedAt: 'now',
    });
    const tokenB = store.saveToken('b', 'tokB');
    store.addRemote('b', {
      host: 'b', acp_url: 'ws://b:31415/v1/acp', token_file: tokenB, addedAt: 'now',
    });
    expect(store.load().default).toBe('a');
    store.removeRemote('a');
    expect(existsSync(tokenA)).toBe(false);
    expect(existsSync(tokenB)).toBe(true);
    expect(store.load().default).toBe('b');
    cleanup();
  });

  test('saveToken persists 0o600', () => {
    const { store, cleanup } = mkStore();
    const path = store.saveToken('foo', 'mySecret');
    expect(readFileSync(path, 'utf-8')).toBe('mySecret');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    cleanup();
  });

  test('readToken returns saved token; undefined when missing', () => {
    const { store, cleanup } = mkStore();
    const path = store.saveToken('foo', 'value\n');
    const entry = { host: 'x', acp_url: 'x', token_file: path, addedAt: 'now' };
    expect(store.readToken(entry)).toBe('value');
    expect(store.readToken({ ...entry, token_file: '/no' })).toBeUndefined();
    cleanup();
  });
});

describe('T4.B · connectRemote action', () => {
  test('happy path: ping ok + connect-info with auto_token → bookmark + default', async () => {
    const { store, cleanup } = mkStore();
    const { out, logs, errors } = captureOut();
    const code = await connectRemote({
      host: 'mbp.tailnet',
      ping: true,
      setDefault: true,
      fetchImpl: makeFetchOk({
        acp_url: 'ws://mbp.tailnet:31415/v1/acp',
        voice_url: 'ws://mbp.tailnet:31415/v1/voice/ws',
        token_required: false,
        server_label: 'mbp.tailnet (NEXUS 0.17.0)',
        auto_token: 'autoTokenAB',
      }),
      store,
      stdout: out,
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    const file = store.load();
    expect(file.default).toBe('mbp-tailnet');
    expect(file.remotes['mbp-tailnet']?.acp_url).toBe('ws://mbp.tailnet:31415/v1/acp');
    expect(logs.some((l) => l.includes('auto_token loaded'))).toBe(true);
    cleanup();
  });

  // 🔐 2026-09-26: 새 서버는 auto_token 을 늘 null 로 준다 — 같은 기계(루프백)면 CLI 가 토큰 파일을 직접 읽는다.
  test('loopback host + server auto_token null → reads the same-host token file', async () => {
    const { store, cleanup } = mkStore();
    const { out, logs } = captureOut();
    const dir = mkdtempSync(joinPath(tmpdir(), 'elanous-acp-token-'));
    const tokenPath = joinPath(dir, 'acp-token');
    writeFileSync(tokenPath, 'localBearer\n', { mode: 0o600 });
    const code = await connectRemote({
      host: '127.0.0.1', ping: true, setDefault: true, localTokenPath: tokenPath,
      fetchImpl: makeFetchOk({ acp_url: 'ws://127.0.0.1:31415/v1/acp', token_required: true, server_label: 'local', auto_token: null }),
      store, stdout: out,
    });
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('same-host bootstrap'))).toBe(true);
    rmSync(dir, { recursive: true }); cleanup();
  });

  test('non-loopback host + server auto_token null → does not read the local token file (token required)', async () => {
    const { store, cleanup } = mkStore();
    const { out, errors } = captureOut();
    const dir = mkdtempSync(joinPath(tmpdir(), 'elanous-acp-token-'));
    const tokenPath = joinPath(dir, 'acp-token');
    writeFileSync(tokenPath, 'localBearer\n', { mode: 0o600 });
    const code = await connectRemote({
      host: 'mbp.tailnet', ping: true, setDefault: true, localTokenPath: tokenPath,
      fetchImpl: makeFetchOk({ acp_url: 'ws://mbp.tailnet:31415/v1/acp', token_required: true, server_label: 'x', auto_token: null }),
      store, stdout: out,
    });
    expect(code).toBe(1);
    expect(errors.some((l) => l.includes('token required'))).toBe(true);
    rmSync(dir, { recursive: true }); cleanup();
  });

  test('--token-file overrides auto_token', async () => {
    const { store, cleanup } = mkStore();
    const tokenFile = joinPath(mkdtempSync(joinPath(tmpdir(), 'elanous-tok-')), 'tok');
    Bun.write(tokenFile, 'manualTok\n');
    await new Promise((r) => setTimeout(r, 5));
    const { out } = captureOut();
    const code = await connectRemote({
      host: 'host',
      tokenFile,
      ping: false,
      fetchImpl: makeFetchOk({
        acp_url: 'ws://host:31415/v1/acp',
        voice_url: null,
        token_required: false,
        server_label: 'x',
        auto_token: 'shouldNotBeUsed',
      }),
      store,
      stdout: out,
    });
    expect(code).toBe(0);
    const entry = store.load().remotes.host!;
    const fs = await import('node:fs');
    expect(fs.readFileSync(entry.token_file, 'utf-8').trim()).toBe('manualTok');
    cleanup();
  });

  test('no token + auto_token=null → exit 1 with error', async () => {
    const { store, cleanup } = mkStore();
    const { out, errors } = captureOut();
    const code = await connectRemote({
      host: 'host',
      ping: false,
      fetchImpl: makeFetchOk({
        acp_url: 'ws://host:31415/v1/acp',
        voice_url: null,
        token_required: true,
        server_label: 'x',
        auto_token: null,
      }),
      store,
      stdout: out,
    });
    expect(code).toBe(1);
    expect(errors.some((e) => e.includes('token required'))).toBe(true);
    cleanup();
  });

  test('--no-ping skips health probe', async () => {
    const { store, cleanup } = mkStore();
    let healthHit = false;
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/v1/health')) {
        healthHit = true;
        return new Response(null, { status: 500 });
      }
      if (u.endsWith('/v1/nexus/connect-info')) {
        return new Response(JSON.stringify({
          acp_url: 'ws://x:31415/v1/acp', voice_url: null, token_required: false,
          server_label: 'x', auto_token: 'abc',
        }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const { out } = captureOut();
    const code = await connectRemote({
      host: 'x',
      ping: false,
      fetchImpl,
      store,
      stdout: out,
    });
    expect(code).toBe(0);
    expect(healthHit).toBe(false);
    cleanup();
  });
});

describe('T4.B · list/switch/remove actions', () => {
  test('list (empty) prints helpful hint', async () => {
    const { store, cleanup } = mkStore();
    const { out, logs } = captureOut();
    await listRemotesCmd({ ping: false, store, stdout: out });
    expect(logs[0]).toContain('no remotes bookmarked');
    cleanup();
  });

  test('switch unknown name → exit 1', async () => {
    const { store, cleanup } = mkStore();
    const { out, errors } = captureOut();
    const code = await switchRemote({ name: 'nope', store, stdout: out });
    expect(code).toBe(1);
    expect(errors[0]).toContain('unknown remote');
    cleanup();
  });

  test('remove unknown name → exit 1', async () => {
    const { store, cleanup } = mkStore();
    const { out, errors } = captureOut();
    const code = await removeRemoteCmd({ name: 'nope', store, stdout: out });
    expect(code).toBe(1);
    expect(errors[0]).toContain('unknown remote');
    cleanup();
  });
});
