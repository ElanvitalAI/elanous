// UI-Core arc Phase U4b Step 3 — boot entry test.
//
// Covers the boot module's responsibilities: arg parsing, default
// resolution, and the dispatch to runAcpServer for each transport.
// The transport-mode integration test (`test/acp-server-transport-
// mode.test.ts`) already exercises the runAcpServer side; here we
// just verify the boot translates flags → calls correctly.

import { describe, expect, test, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as acpServerModule from '../src/acp/server.js';
import * as acpTransportModule from '../src/acp/transport/index.js';
import { getElanousConfigDir, resetElanousConfigDir, setElanousConfigDir } from '../src/elanous-config-dir.js';

type RunAcpServerOpts = Record<string, unknown>;
const runCalls: RunAcpServerOpts[] = [];

type TokenCleanup = { path: string; existedBefore: boolean };

function acpTokenPath(): string {
  return join(getElanousConfigDir(), 'acp-token');
}

function beginTokenLifecycle(): TokenCleanup {
  const path = acpTokenPath();
  return { path, existedBefore: existsSync(path) };
}

function endTokenLifecycle(state: TokenCleanup | undefined): void {
  if (!state) return;
  if (!state.existedBefore && existsSync(state.path)) {
    unlinkSync(state.path);
  }
}

let isolatedConfigDir: string | undefined;
let tokenCleanup: TokenCleanup | undefined;

const {
  parseAcpBootArgs,
  readFlagValue,
  bootAcpServer,
  defaultUnixSocketPath,
  DEFAULT_WEBSOCKET_PORT,
} = await import('../src/boot/acp-server.js');

beforeEach(() => {
  runCalls.length = 0;
  isolatedConfigDir = mkdtempSync(join(tmpdir(), 'boot-acp-config-'));
  setElanousConfigDir(isolatedConfigDir);
  tokenCleanup = beginTokenLifecycle();
  // BACKLOG #5 — spyOn replaces named exports for this test file
  // only. Pre-cleanup version used `mock.module()` which leaked
  // process-wide.
  spyOn(acpServerModule, 'runAcpServer').mockImplementation(
    (async (opts: RunAcpServerOpts): Promise<void> => {
      runCalls.push(opts);
    }) as typeof acpServerModule.runAcpServer,
  );
  spyOn(acpTransportModule, 'listenUnixSocket').mockImplementation(
    (async () => ({
      kind: 'unix-socket' as const,
      address: 'stub-unix',
      close: async () => {},
    })) as typeof acpTransportModule.listenUnixSocket,
  );
  spyOn(acpTransportModule, 'listenWebSocket').mockImplementation(
    (async () => ({
      kind: 'websocket' as const,
      address: 'stub-ws',
      close: async () => {},
    })) as typeof acpTransportModule.listenWebSocket,
  );
  spyOn(acpTransportModule, 'generateAuthToken').mockImplementation(
    (() => 'stub-token-xyz') as typeof acpTransportModule.generateAuthToken,
  );
  spyOn(acpTransportModule, 'createAuthVerifier').mockImplementation(
    (() => ({ verify: () => ({ ok: true as const }) })) as typeof acpTransportModule.createAuthVerifier,
  );
});

afterEach(() => {
  runCalls.length = 0;
  mock.restore();
  endTokenLifecycle(tokenCleanup);
  tokenCleanup = undefined;
  if (isolatedConfigDir) {
    rmSync(isolatedConfigDir, { recursive: true, force: true });
    isolatedConfigDir = undefined;
  }
  resetElanousConfigDir();
});

describe('readFlagValue', () => {
  test('handles --flag=value form', () => {
    expect(readFlagValue(['--transport=unix-socket'], '--transport')).toBe('unix-socket');
  });
  test('handles --flag value form', () => {
    expect(readFlagValue(['--port', '8080'], '--port')).toBe('8080');
  });
  test('returns undefined when flag absent', () => {
    expect(readFlagValue(['--other'], '--transport')).toBeUndefined();
  });
});

describe('parseAcpBootArgs', () => {
  test('defaults to stdio', () => {
    expect(parseAcpBootArgs([])).toEqual({ transport: 'stdio' });
  });
  test('unix-socket with default path', () => {
    expect(parseAcpBootArgs(['--transport=unix-socket'])).toEqual({
      transport: 'unix-socket',
    });
  });
  test('unix-socket with custom path', () => {
    expect(
      parseAcpBootArgs(['--transport', 'unix-socket', '--socket-path=/tmp/x.sock']),
    ).toEqual({ transport: 'unix-socket', socketPath: '/tmp/x.sock' });
  });
  test('websocket with port + host', () => {
    expect(
      parseAcpBootArgs(['--transport=websocket', '--port=9090', '--host=0.0.0.0']),
    ).toEqual({ transport: 'websocket', port: 9090, host: '0.0.0.0' });
  });
  test('websocket with --no-auth', () => {
    expect(parseAcpBootArgs(['--transport=websocket', '--no-auth'])).toEqual({
      transport: 'websocket',
      noAuth: true,
    });
  });
  test('rejects unknown transport', () => {
    expect(() => parseAcpBootArgs(['--transport=rest'])).toThrow(/unknown --transport/);
  });
  test('rejects invalid port', () => {
    expect(() => parseAcpBootArgs(['--transport=websocket', '--port=abc'])).toThrow(/invalid --port/);
    expect(() => parseAcpBootArgs(['--transport=websocket', '--port=0'])).toThrow(/invalid --port/);
    expect(() => parseAcpBootArgs(['--transport=websocket', '--port=70000'])).toThrow(/invalid --port/);
  });
});

describe('bootAcpServer dispatch', () => {
  function makePreAbortedSignal(): AbortSignal {
    const ctrl = new AbortController();
    ctrl.abort();
    return ctrl.signal;
  }

  test('stdio → runAcpServer with no transportFactory', async () => {
    const stderr = { writes: [] as string[], write: (s: string) => { stderr.writes.push(s); } };
    await bootAcpServer({ transport: 'stdio' }, {
      stderr,
      shutdownSignal: makePreAbortedSignal(),
    });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.transportFactory).toBeUndefined();
    expect(runCalls[0]!.shutdownSignal).toBeDefined();
  });

  test('unix-socket → transportFactory invokes listenUnixSocket', async () => {
    const stderr = { writes: [] as string[], write: (s: string) => { stderr.writes.push(s); } };
    await bootAcpServer(
      { transport: 'unix-socket', socketPath: '/tmp/boot-test.sock' },
      { stderr, shutdownSignal: makePreAbortedSignal() },
    );
    expect(runCalls).toHaveLength(1);
    expect(typeof runCalls[0]!.transportFactory).toBe('function');
    expect(stderr.writes.some((w) => w.includes('/tmp/boot-test.sock'))).toBe(true);
  });

  test('websocket with auth → banner includes token', async () => {
    const stderr = { writes: [] as string[], write: (s: string) => { stderr.writes.push(s); } };
    await bootAcpServer(
      { transport: 'websocket', port: 4242, host: '127.0.0.1' },
      { stderr, shutdownSignal: makePreAbortedSignal() },
    );
    expect(runCalls).toHaveLength(1);
    expect(stderr.writes.some((w) => w.includes('ws://127.0.0.1:4242/acp'))).toBe(true);
    expect(stderr.writes.some((w) => w.includes('auth token'))).toBe(true);
    const tokenPath = acpTokenPath();
    expect(existsSync(tokenPath)).toBe(true);
    expect(readFileSync(tokenPath, 'utf8')).toBe('stub-token-xyz');
    expect(tokenPath.startsWith(isolatedConfigDir ?? '')).toBe(true);
  });

  test('websocket token creation failure aborts boot without exposing a token', async () => {
    const tokenPath = acpTokenPath();
    symlinkSync(join(isolatedConfigDir!, 'missing', 'token'), tokenPath);
    const stderr = { writes: [] as string[], write: (s: string) => { stderr.writes.push(s); } };

    try {
      await expect(bootAcpServer(
        { transport: 'websocket', port: 4242 },
        { stderr, shutdownSignal: makePreAbortedSignal() },
      )).rejects.toHaveProperty('code', 'ENOENT');
      expect(runCalls).toHaveLength(0);
      expect(stderr.writes.join('')).not.toContain('stub-token-xyz');
    } finally {
      unlinkSync(tokenPath);
    }
  });

  test('websocket with --no-auth → banner says AUTH DISABLED', async () => {
    const stderr = { writes: [] as string[], write: (s: string) => { stderr.writes.push(s); } };
    await bootAcpServer(
      { transport: 'websocket', port: 4242, noAuth: true },
      { stderr, shutdownSignal: makePreAbortedSignal() },
    );
    expect(stderr.writes.some((w) => w.includes('AUTH DISABLED'))).toBe(true);
  });

  // MT5b — runTurn / hasSession deps must be forwarded to runAcpServer
  // for every transport. Without this, `elanous --acp-server` falls
  // through to the echo skeleton (server.ts:660) and external IDEs
  // get back `"elanous-acp echo: " + input` instead of a real LLM turn.
  // index.ts:3169 wires createDaemonRuntime + passes the runtime
  // through to bootAcpServer; this test pins the contract that any
  // such handoff propagates intact.
  test.each([
    { transport: 'stdio' as const },
    { transport: 'unix-socket' as const, socketPath: '/tmp/boot-identity.sock' },
    { transport: 'websocket' as const, port: 4242, noAuth: true },
  ])('$transport forwards the selected provider/model to initialize', async (opts) => {
    const stderr = { writes: [] as string[], write: (s: string) => { stderr.writes.push(s); } };
    await bootAcpServer(opts, {
      stderr,
      shutdownSignal: makePreAbortedSignal(),
      agentBrand: 'gemini',
      agentModel: 'gemini-3.1-pro',
    });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.agentBrand).toBe('gemini');
    expect(runCalls[0]!.agentModel).toBe('gemini-3.1-pro');
  });

  describe('runTurn / hasSession passthrough (MT5b)', () => {
    const stubRunTurn = async (): Promise<void> => { /* test stub */ };
    const stubHasSession = (_id: string): boolean => false;

    test('stdio forwards runTurn + hasSession', async () => {
      const stderr = { writes: [] as string[], write: (s: string) => { stderr.writes.push(s); } };
      await bootAcpServer({ transport: 'stdio' }, {
        stderr,
        runTurn: stubRunTurn,
        hasSession: stubHasSession,
        shutdownSignal: makePreAbortedSignal(),
      });
      expect(runCalls).toHaveLength(1);
      expect(runCalls[0]!.runTurn).toBe(stubRunTurn);
      expect(runCalls[0]!.hasSession).toBe(stubHasSession);
    });

    test('unix-socket forwards runTurn + hasSession', async () => {
      const stderr = { writes: [] as string[], write: (s: string) => { stderr.writes.push(s); } };
      await bootAcpServer(
        { transport: 'unix-socket', socketPath: '/tmp/boot-mt5b.sock' },
        {
          stderr,
          runTurn: stubRunTurn,
          hasSession: stubHasSession,
          shutdownSignal: makePreAbortedSignal(),
        },
      );
      expect(runCalls).toHaveLength(1);
      expect(runCalls[0]!.runTurn).toBe(stubRunTurn);
      expect(runCalls[0]!.hasSession).toBe(stubHasSession);
    });

    test('omitting runTurn keeps the echo skeleton (no opt set)', async () => {
      const stderr = { writes: [] as string[], write: (s: string) => { stderr.writes.push(s); } };
      await bootAcpServer({ transport: 'stdio' }, {
        stderr,
        shutdownSignal: makePreAbortedSignal(),
      });
      expect(runCalls).toHaveLength(1);
      expect(runCalls[0]!.runTurn).toBeUndefined();
      expect(runCalls[0]!.hasSession).toBeUndefined();
    });
  });

  // MT5b polish — startup banner emission. Pre-polish, stdio mode
  // wrote 0 bytes to stderr so users couldn't tell whether
  // ELANOUS_HISTORY_DIR / ELANOUS_TOOLS env vars had been picked up.
  // Now every transport emits a uniform `[elanous-acp] history: ...`
  // + `[elanous-acp] tools: ...` line (when runtimeStatus is supplied)
  // and stdio additionally emits a `starting (transport: stdio)`
  // line so the process is visibly alive.
  describe('startup banner (MT5b polish)', () => {
    test('stdio writes the "starting" line', async () => {
      const stderr = { writes: [] as string[], write: (s: string) => { stderr.writes.push(s); } };
      await bootAcpServer({ transport: 'stdio' }, {
        stderr,
        shutdownSignal: makePreAbortedSignal(),
      });
      expect(stderr.writes.some((w) => w.includes('starting (transport: stdio)'))).toBe(true);
    });

    test('stdio + runtimeStatus writes history (disk-backed) + tools (readonly) lines', async () => {
      const stderr = { writes: [] as string[], write: (s: string) => { stderr.writes.push(s); } };
      await bootAcpServer({ transport: 'stdio' }, {
        stderr,
        shutdownSignal: makePreAbortedSignal(),
        runtimeStatus: {
          historyDir: '/tmp/elanous-acp-h',
          tools: 'readonly',
          toolCwd: '/Users/dev/proj',
        },
      });
      expect(stderr.writes.some((w) => w.includes('history: disk-backed at /tmp/elanous-acp-h'))).toBe(true);
      expect(stderr.writes.some((w) => w.includes('tools: readonly'))).toBe(true);
      expect(stderr.writes.some((w) => w.includes('cwd=/Users/dev/proj'))).toBe(true);
    });

    test('stdio + runtimeStatus default values write the "in-memory" / "tools: none" hint lines', async () => {
      const stderr = { writes: [] as string[], write: (s: string) => { stderr.writes.push(s); } };
      await bootAcpServer({ transport: 'stdio' }, {
        stderr,
        shutdownSignal: makePreAbortedSignal(),
        runtimeStatus: { tools: 'none' },
      });
      expect(stderr.writes.some((w) => w.includes('history: in-memory'))).toBe(true);
      expect(stderr.writes.some((w) => w.includes('ELANOUS_HISTORY_DIR'))).toBe(true);
      expect(stderr.writes.some((w) => w.includes('tools: none'))).toBe(true);
      expect(stderr.writes.some((w) => w.includes('ELANOUS_TOOLS=readonly'))).toBe(true);
    });

    test('stdio without runtimeStatus omits history/tools lines (smoke-test mode)', async () => {
      const stderr = { writes: [] as string[], write: (s: string) => { stderr.writes.push(s); } };
      await bootAcpServer({ transport: 'stdio' }, {
        stderr,
        shutdownSignal: makePreAbortedSignal(),
      });
      // The starting line still fires, but no history/tools lines —
      // pure programmatic callers (e.g. integration smoke tests) get
      // a quieter banner.
      expect(stderr.writes.some((w) => w.includes('history:'))).toBe(false);
      expect(stderr.writes.some((w) => w.includes('tools:'))).toBe(false);
    });

    test('unix-socket also emits runtimeStatus banner after listening line', async () => {
      const stderr = { writes: [] as string[], write: (s: string) => { stderr.writes.push(s); } };
      await bootAcpServer(
        { transport: 'unix-socket', socketPath: '/tmp/boot-banner.sock' },
        {
          stderr,
          shutdownSignal: makePreAbortedSignal(),
          runtimeStatus: { historyDir: '/tmp/h', tools: 'readonly', toolCwd: '/cwd' },
        },
      );
      const writes = stderr.writes;
      const listenIdx = writes.findIndex((w) => w.includes('/tmp/boot-banner.sock'));
      const historyIdx = writes.findIndex((w) => w.includes('history: disk-backed'));
      const toolsIdx = writes.findIndex((w) => w.includes('tools: readonly'));
      expect(listenIdx).toBeGreaterThanOrEqual(0);
      expect(historyIdx).toBeGreaterThan(listenIdx);
      expect(toolsIdx).toBeGreaterThan(historyIdx);
    });

    test('websocket also emits runtimeStatus banner after auth line', async () => {
      const stderr = { writes: [] as string[], write: (s: string) => { stderr.writes.push(s); } };
      await bootAcpServer(
        { transport: 'websocket', port: 4242, noAuth: true },
        {
          stderr,
          shutdownSignal: makePreAbortedSignal(),
          runtimeStatus: { tools: 'none' },
        },
      );
      expect(stderr.writes.some((w) => w.includes('AUTH DISABLED'))).toBe(true);
      expect(stderr.writes.some((w) => w.includes('history: in-memory'))).toBe(true);
      expect(stderr.writes.some((w) => w.includes('tools: none'))).toBe(true);
    });
  });
});

describe('defaults', () => {
  test('defaultUnixSocketPath returns the instance config socket path', () => {
    const p = defaultUnixSocketPath();
    expect(p.endsWith('/elanous.sock')).toBe(true);
  });
  test('DEFAULT_WEBSOCKET_PORT = 31415', () => {
    expect(DEFAULT_WEBSOCKET_PORT).toBe(31415);
  });
});

describe('acp-token file lifecycle', () => {
  test('cleanup removes only a token file this test created', () => {
    const dir = mkdtempSync(join(tmpdir(), 'boot-acp-created-token-'));
    const path = join(dir, 'acp-token');
    writeFileSync(path, 'created-by-test');
    endTokenLifecycle({ path, existedBefore: false });
    expect(existsSync(path)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('cleanup leaves a pre-existing token file in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'boot-acp-preexisting-token-'));
    const path = join(dir, 'acp-token');
    writeFileSync(path, 'keep-me');
    endTokenLifecycle({ path, existedBefore: true });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('keep-me');
    rmSync(dir, { recursive: true, force: true });
  });
});
