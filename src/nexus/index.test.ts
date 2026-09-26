// Nexus wsBridgeOpts wiring: pass wsAuthVerifier only when bearerToken
// is present. Executes buildNexusWsBridgeAuth — the unit runNexus uses
// when assembling wsBridgeOpts (same shape as src/boot/acp-server.ts).

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildNexusWsBridgeAuth, readAcpToken, runNexus } from './index.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { setTestStateRoot } from './paths.js';
import type { PwaShareDeps, PwaShareResult } from '../cli/pwa-share.js';
import type { ShareMountResult } from '../cli/share-auto-mount.js';

const CONFIGURED_TOKEN = 'configured-token-xxxxxxxxxxxxxxxxxxxx';

/** ⛔ 이 파일이 만든 임시 디렉토리를 걷는다 — 반복 실행에서 /tmp 가 샌다. */
const tempDirs: string[] = [];
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

describe('Nexus wsBridgeOpts auth wiring', () => {
  test('configured-auth: bearerToken present → createAuthVerifier is passed as wsAuthVerifier', () => {
    // ⛔ `configDir` 를 «반드시» 준다 — 안 주면 이 시험이 사람 홈의 «실제» 봉투를 읽어
    //    개발자 기계마다 다른 답이 나온다(2026-09-01 실측: 실제 봉투의 active 가 이 토큰이 아니라 빨강).
    //    ⭐ 빈 디렉토리 = 「봉투 없음」 ⇒ 부팅 토큰 하나로 오늘과 똑같이 동작한다(가용성 보존 경로).
    const noEnvelope = mkdtempSync(join(tmpdir(), 'nexus-auth-no-envelope-'));
    tempDirs.push(noEnvelope);
    const opts = buildNexusWsBridgeAuth(CONFIGURED_TOKEN, { configDir: noEnvelope });
    expect(opts.wsAuthVerifier).toBeDefined();
    expect(opts.wsAuthVerifier!.verify({ kind: 'auth', token: CONFIGURED_TOKEN }))
      .toEqual({ ok: true });
    expect(opts.wsAuthVerifier!.verify({ kind: 'auth', token: 'wrong-token-yyyyyyyyyyyyyyyyyyyy' }))
      .toEqual({ ok: false, reason: 'bad-token' });
    expect('noAuth' in opts).toBe(false);
  });

  test('no-token startup: verifier omitted; dead noAuth is not assigned on wsBridgeOpts', () => {
    const opts = buildNexusWsBridgeAuth(undefined);
    expect(opts.wsAuthVerifier).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(opts, 'wsAuthVerifier')).toBe(false);
    expect('noAuth' in opts).toBe(false);
    expect(opts).toEqual({});
  });
});

describe('readAcpToken instance root', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    resetElanousConfigDir();
  });
  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  test('returns the isolated config-dir token verbatim', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'nexus-acp-isolated-'));
    tempDirs.push(isolated);
    writeFileSync(join(isolated, 'acp-token'), 'isolated-token-obs-t413\n');
    setElanousConfigDir(isolated);
    expect(readAcpToken()).toBe('isolated-token-obs-t413');
  });

  test('swallows a read failure and returns undefined', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'nexus-acp-unreadable-'));
    tempDirs.push(isolated);
    mkdirSync(join(isolated, 'acp-token'));
    setElanousConfigDir(isolated);
    expect(readAcpToken()).toBeUndefined();
  });

  test('returns undefined when the isolated token file is absent', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'nexus-acp-absent-'));
    tempDirs.push(isolated);
    setElanousConfigDir(isolated);
    expect(readAcpToken()).toBeUndefined();
  });

  test('does not read HOME/.elanous/acp-token when config-dir is isolated', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'nexus-acp-no-home-'));
    const decoyHome = mkdtempSync(join(tmpdir(), 'nexus-acp-decoy-home-'));
    tempDirs.push(isolated, decoyHome);
    mkdirSync(join(decoyHome, '.elanous'));
    writeFileSync(join(decoyHome, '.elanous', 'acp-token'), 'prod-decoy-token');
    writeFileSync(join(isolated, 'acp-token'), 'isolated-token-obs-t413');
    const prevHome = process.env.HOME;
    process.env.HOME = decoyHome;
    setElanousConfigDir(isolated);
    try {
      expect(readAcpToken()).toBe('isolated-token-obs-t413');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  test('empty isolated config-dir does not fall back to HOME token', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'nexus-acp-empty-iso-'));
    const decoyHome = mkdtempSync(join(tmpdir(), 'nexus-acp-decoy-empty-'));
    tempDirs.push(isolated, decoyHome);
    mkdirSync(join(decoyHome, '.elanous'));
    writeFileSync(join(decoyHome, '.elanous', 'acp-token'), 'prod-decoy-token');
    const prevHome = process.env.HOME;
    process.env.HOME = decoyHome;
    setElanousConfigDir(isolated);
    try {
      expect(readAcpToken()).toBeUndefined();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});

describe('runNexus · headless auto-mount share unmount on exit', () => {
  let stateRoot: string;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-share-unmount-'));
    setTestStateRoot(stateRoot);
  });

  afterEach(() => {
    setTestStateRoot(null);
    rmSync(stateRoot, { recursive: true, force: true });
  });

  async function runHeadlessShareLifecycle(args: {
    mount: ShareMountResult;
    disable?: (deps: PwaShareDeps) => Promise<PwaShareResult>;
  }): Promise<{ disableCalls: PwaShareDeps[]; mountedPort?: number }> {
    const disableCalls: PwaShareDeps[] = [];
    let finish!: () => void;
    let mountedPort: number | undefined;
    let observed!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const mounted = new Promise<void>((resolve) => { observed = resolve; });
    const boot = runNexus({
      headless: true,
      skipHeadlessSetupCheckForTesting: true,
      headlessDoneForTesting: done,
      autoMountShare: true,
      skipHttpServer: false,
      skipSupervisor: true,
      skipRuntimeApi: true,
      skipPushcutChannel: true,
      skipPwaChannel: true,
      skipTelegramChannel: true,
      skipTerminalChannel: true,
      skipDiscordChannel: true,
      skipIntentPrediction: true,
      mountShareIfEnabledFn: async ({ httpPort }) => {
        mountedPort = httpPort;
        observed();
        return args.mount;
      },
      pwaShareDisableFn: async (deps: PwaShareDeps = {}) => {
        disableCalls.push(deps);
        if (args.disable) return args.disable(deps);
        return { exitCode: 0 };
      },
    });
    await mounted;
    finish();
    await boot;
    return { disableCalls, ...(mountedPort !== undefined ? { mountedPort } : {}) };
  }

  test('serving auto-mount is revisited after 60 seconds by the default coordinator, then walked on clean exit', async () => {
    let now = 0;
    const intervals = new Map<ReturnType<typeof setInterval>, { callback: () => void; ms: number; next: number }>();
    const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number) => {
      const timer = { unref: () => timer } as unknown as ReturnType<typeof setInterval>;
      intervals.set(timer, { callback, ms, next: now + ms });
      return timer;
    }) as typeof setInterval);
    const clearSpy = spyOn(globalThis, 'clearInterval').mockImplementation(((timer: ReturnType<typeof setInterval>) => {
      intervals.delete(timer);
    }) as typeof clearInterval);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const mountPorts: number[] = [];
    const disablePorts: number[] = [];
    let shareTimer: ReturnType<typeof setInterval> | undefined;
    const boot = runNexus({
      headless: true,
      skipHeadlessSetupCheckForTesting: true,
      headlessDoneForTesting: done,
      skipHttpServer: false,
      skipSupervisor: true,
      skipRuntimeApi: true,
      autoMountShare: true,
      mountShareIfEnabledFn: async ({ httpPort }) => {
        mountPorts.push(httpPort);
        return { outcome: 'serving', url: `https://host.tailnet.ts.net:${httpPort}/app/` };
      },
      pwaShareDisableFn: async ({ port } = {}) => {
        if (port !== undefined) disablePorts.push(port);
        return { exitCode: 0 };
      },
    });
    try {
      const deadline = Date.now() + 8_000;
      while (!process.listeners('SIGINT').some((listener) => listener.name === 'onSigint') && Date.now() < deadline) {
        await Bun.sleep(5);
      }
      expect(process.listeners('SIGINT').some((listener) => listener.name === 'onSigint')).toBe(true);
      expect(mountPorts).toHaveLength(1);
      expect(mountPorts[0]).toBeGreaterThan(0);
      // Advance a virtual interval clock, not just a spy on an unrelated 60s timer.
      const advance = async (ms: number): Promise<void> => {
        const end = now + ms;
        while (true) {
          const next = Math.min(...[...intervals.values()].map((interval) => interval.next));
          if (next > end) break;
          now = next;
          for (const [timer, interval] of intervals) {
            if (interval.next !== now) continue;
            interval.next += interval.ms;
            const callsBefore = mountPorts.length;
            interval.callback();
            if (mountPorts.length > callsBefore) shareTimer = timer;
          }
          await Promise.resolve();
        }
        now = end;
        await Promise.resolve();
      };
      await advance(59_999);
      expect(mountPorts).toHaveLength(1);
      await advance(1);
      expect(mountPorts).toEqual([mountPorts[0], mountPorts[0]]);
    } finally {
      finish();
      await boot;
      clearSpy.mockRestore();
      intervalSpy.mockRestore();
    }
    expect(disablePorts).toEqual([mountPorts[0]]);
    expect(shareTimer).toBeDefined();
    expect(intervals.has(shareTimer!)).toBe(false);
  });

  test('skipped auto-mount does not call pwaShareDisable on exit', async () => {
    const { disableCalls } = await runHeadlessShareLifecycle({
      mount: { outcome: 'skipped', reason: 'switch-disabled' },
    });
    expect(disableCalls).toHaveLength(0);
  });

  test('failed auto-mount does not call pwaShareDisable on exit', async () => {
    const { disableCalls } = await runHeadlessShareLifecycle({
      mount: { outcome: 'failed', reason: 'serve-error', serveExitCode: 1 },
    });
    expect(disableCalls).toHaveLength(0);
  });

  test('a later reconciliation mounts the live port after boot was skipped', async () => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const mountPorts: number[] = [];
    const disablePorts: number[] = [];
    const boot = runNexus({
      headless: true,
      skipHeadlessSetupCheckForTesting: true,
      headlessDoneForTesting: done,
      skipSupervisor: true,
      skipRuntimeApi: true,
      skipHttpServer: false,
      autoMountShare: true,
      shareCoordinatorIntervalMsForTesting: 15,
      mountShareIfEnabledFn: async ({ httpPort }) => {
        mountPorts.push(httpPort);
        return mountPorts.length === 1
          ? { outcome: 'skipped', reason: 'tailscale-down' }
          : { outcome: 'serving', url: `https://host.tailnet.ts.net:${httpPort}/app/` };
      },
      pwaShareDisableFn: async ({ port } = {}) => {
        if (port !== undefined) disablePorts.push(port);
        return { exitCode: 0 };
      },
    });
    try {
      const deadline = Date.now() + 8_000;
      while (mountPorts.length < 2 && Date.now() < deadline) await Bun.sleep(5);
      expect(mountPorts.length).toBeGreaterThanOrEqual(2);
    } finally {
      finish();
      await boot;
    }
    expect(disablePorts).toEqual([mountPorts[0]!]);
  }, 15_000);

  test('in-flight reconciliation completes before port unmount', async () => {
    let finish!: () => void;
    let mountStarted!: () => void;
    let finishMount!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const started = new Promise<void>((resolve) => { mountStarted = resolve; });
    const mountFinished = new Promise<void>((resolve) => { finishMount = resolve; });
    const mountPorts: number[] = [];
    const disablePorts: number[] = [];
    const boot = runNexus({
      headless: true,
      skipHeadlessSetupCheckForTesting: true,
      skipSupervisor: true,
      skipRuntimeApi: true,
      autoMountShare: true,
      shareCoordinatorIntervalMsForTesting: 15,
      mountShareIfEnabledFn: async ({ httpPort }) => {
        mountPorts.push(httpPort);
        if (mountPorts.length === 2) {
          mountStarted();
          await mountFinished;
        }
        return { outcome: 'serving', url: 'https://host.tailnet.ts.net/app/' };
      },
      pwaShareDisableFn: async ({ port } = {}) => {
        if (port !== undefined) disablePorts.push(port);
        return { exitCode: 0 };
      },
      headlessDoneForTesting: done,
      skipHttpServer: false,
    });
    try {
      await started;
      finish();
      await Bun.sleep(20);
      expect(disablePorts).toHaveLength(0);
      finishMount();
      await boot;
      expect(disablePorts).toEqual([mountPorts[0]!]);
    } finally {
      finishMount();
      finish();
      await boot;
    }
  });

  test('boot-mounted share is reconciled on the configured cadence, and shutdown clears the timer without changing per-port unmount', async () => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const mountPorts: number[] = [];
    const disablePorts: number[] = [];
    const intervalSpy = spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = spyOn(globalThis, 'clearInterval');
    const boot = runNexus({
      headless: true,
      skipHeadlessSetupCheckForTesting: true,
      headlessDoneForTesting: done,
      skipHttpServer: false,
      skipSupervisor: true,
      skipRuntimeApi: true,
      autoMountShare: true,
      shareCoordinatorIntervalMsForTesting: 15,
      mountShareIfEnabledFn: async ({ httpPort }) => {
        mountPorts.push(httpPort);
        return { outcome: 'serving', url: `https://host.tailnet.ts.net:${httpPort}/app/` };
      },
      pwaShareDisableFn: async ({ port } = {}) => {
        if (port !== undefined) disablePorts.push(port);
        return { exitCode: 0 };
      },
    });
    try {
      const deadline = Date.now() + 8_000;
      while (mountPorts.length < 2 && Date.now() < deadline) await Bun.sleep(5);
      expect(mountPorts.length).toBeGreaterThanOrEqual(2);
    } finally {
      finish();
      await boot;
    }
    try {
      const shareTimer = intervalSpy.mock.results.find((_result, index) =>
        intervalSpy.mock.calls[index]?.[1] === 15)?.value;
      expect(shareTimer).toBeDefined();
      expect(clearIntervalSpy.mock.calls.some(([timer]) => timer === shareTimer)).toBe(true);
    } finally {
      clearIntervalSpy.mockRestore();
      intervalSpy.mockRestore();
    }
    expect(disablePorts).toEqual([mountPorts[0]!]);
    const callsAfterExit = mountPorts.length;
    await Bun.sleep(50);
    expect(mountPorts).toHaveLength(callsAfterExit);
  }, 15_000);

  test('pwaShareDisable failure is announced and does not block clean exit', async () => {
    const { disableCalls } = await runHeadlessShareLifecycle({
      mount: { outcome: 'serving', url: 'https://mbp.tailnet.ts.net:31415/app/' },
      disable: async () => {
        throw new Error('tailscale serve unmount exploded');
      },
    });
    expect(disableCalls).toHaveLength(1);
  });
});

describe('runNexus · fallback signal share unmount', () => {
  let stateRoot: string;
  let previousExit: typeof process.exit;
  let previousSigterm: Array<(...args: unknown[]) => void>;
  let previousSigint: Array<(...args: unknown[]) => void>;
  let previousIsTty: PropertyDescriptor | undefined;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-fallback-unmount-'));
    setTestStateRoot(stateRoot);
    previousExit = process.exit;
    previousSigterm = process.listeners('SIGTERM').slice() as Array<(...args: unknown[]) => void>;
    previousSigint = process.listeners('SIGINT').slice() as Array<(...args: unknown[]) => void>;
    previousIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  });

  afterEach(() => {
    process.exit = previousExit;
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    for (const listener of previousSigterm) process.on('SIGTERM', listener as never);
    for (const listener of previousSigint) process.on('SIGINT', listener as never);
    if (previousIsTty) Object.defineProperty(process.stdin, 'isTTY', previousIsTty);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    setTestStateRoot(null);
    rmSync(stateRoot, { recursive: true, force: true });
  });

  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 8_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await Bun.sleep(10);
    }
  }

  async function runFallbackShareLifecycle(args: {
    signal: 'SIGTERM' | 'SIGINT';
    mount: ShareMountResult;
    disable?: (deps: PwaShareDeps) => Promise<PwaShareResult>;
  }): Promise<{ disableCalls: PwaShareDeps[]; mountedPort?: number; completed: boolean; exitCodes: number[] }> {
    const disableCalls: PwaShareDeps[] = [];
    const mountPorts: number[] = [];
    const exitCodes: number[] = [];
    let mountedPort: number | undefined;
    let observed!: () => void;
    const mounted = new Promise<void>((resolve) => { observed = resolve; });
    process.exit = ((code?: number) => {
      exitCodes.push(code ?? 0);
      return undefined as never;
    }) as typeof process.exit;
    const boot = runNexus({
      headless: false,
      autoMountShare: true,
      skipHttpServer: false,
      skipSupervisor: true,
      skipRuntimeApi: true,
      skipPushcutChannel: true,
      skipPwaChannel: true,
      skipTelegramChannel: true,
      skipTerminalChannel: true,
      skipDiscordChannel: true,
      skipIntentPrediction: true,
      skipEnvMigration: true,
      skipRestoreFromPending: true,
      registerDaemonTab: false,
      registerSettingsTab: false,
      mcpEnabled: false,
      shareCoordinatorIntervalMsForTesting: 15,
      mountShareIfEnabledFn: async ({ httpPort }) => {
        mountPorts.push(httpPort);
        mountedPort = httpPort;
        observed();
        return args.mount;
      },
      pwaShareDisableFn: async (deps: PwaShareDeps = {}) => {
        disableCalls.push(deps);
        if (args.disable) return args.disable(deps);
        return { exitCode: 0 };
      },
    });
    await mounted;
    await waitFor(
      () => process.listeners(args.signal).some((listener) => listener.name === (args.signal === 'SIGTERM' ? 'onSigterm' : 'onSigint')),
      `${args.signal} handler`,
    );
    await waitFor(() => mountPorts.length >= 2, 'share reconciliation tick');
    const nexusSignalHandler = process.listeners(args.signal).find((listener) =>
      listener.name === (args.signal === 'SIGTERM' ? 'onSigterm' : 'onSigint'));
    expect(nexusSignalHandler).toBeDefined();
    (nexusSignalHandler as () => void)();
    await boot;
    const callsAfterExit = mountPorts.length;
    await Bun.sleep(50);
    expect(mountPorts).toHaveLength(callsAfterExit);
    expect(process.listeners(args.signal)).not.toContain(nexusSignalHandler);
    return {
      disableCalls,
      completed: true,
      exitCodes,
      ...(mountedPort !== undefined ? { mountedPort } : {}),
    };
  }

  test('fallback SIGTERM walks the auto-mounted daemon port exactly once', async () => {
    const { disableCalls, mountedPort, completed, exitCodes } = await runFallbackShareLifecycle({
      signal: 'SIGTERM',
      mount: { outcome: 'serving', url: 'https://mbp.tailnet.ts.net:31415/app/' },
    });
    expect(completed).toBe(true);
    expect(disableCalls).toHaveLength(1);
    expect(disableCalls[0]?.port).toBe(mountedPort);
    expect(mountedPort).toBeGreaterThan(0);
    expect(exitCodes).toContain(75);
  });

  test('fallback SIGINT walks the auto-mounted daemon port exactly once', async () => {
    const { disableCalls, mountedPort, completed } = await runFallbackShareLifecycle({
      signal: 'SIGINT',
      mount: { outcome: 'serving', url: 'https://mbp.tailnet.ts.net:31415/app/' },
    });
    expect(completed).toBe(true);
    expect(disableCalls).toHaveLength(1);
    expect(disableCalls[0]?.port).toBe(mountedPort);
    expect(mountedPort).toBeGreaterThan(0);
  });

  test('fallback SIGTERM does not call pwaShareDisable when share was not mounted', async () => {
    const { disableCalls, completed } = await runFallbackShareLifecycle({
      signal: 'SIGTERM',
      mount: { outcome: 'skipped', reason: 'switch-disabled' },
    });
    expect(completed).toBe(true);
    expect(disableCalls).toHaveLength(0);
  });

  test('fallback SIGINT does not call pwaShareDisable when share was not mounted', async () => {
    const { disableCalls, completed } = await runFallbackShareLifecycle({
      signal: 'SIGINT',
      mount: { outcome: 'skipped', reason: 'switch-disabled' },
    });
    expect(completed).toBe(true);
    expect(disableCalls).toHaveLength(0);
  });

  test('fallback SIGTERM still completes when pwaShareDisable rejects', async () => {
    const { disableCalls, completed } = await runFallbackShareLifecycle({
      signal: 'SIGTERM',
      mount: { outcome: 'serving', url: 'https://mbp.tailnet.ts.net:31415/app/' },
      disable: async () => {
        throw new Error('tailscale serve unmount exploded');
      },
    });
    expect(completed).toBe(true);
    expect(disableCalls).toHaveLength(1);
  });

  test('fallback SIGINT still completes when pwaShareDisable rejects', async () => {
    const { disableCalls, completed } = await runFallbackShareLifecycle({
      signal: 'SIGINT',
      mount: { outcome: 'serving', url: 'https://mbp.tailnet.ts.net:31415/app/' },
      disable: async () => {
        throw new Error('tailscale serve unmount exploded');
      },
    });
    expect(completed).toBe(true);
    expect(disableCalls).toHaveLength(1);
  });
});

describe('runNexus · MCP handshake timeout wiring', () => {
  let stateRoot: string;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-mcp-timeout-'));
    setTestStateRoot(stateRoot);
  });

  afterEach(() => {
    setTestStateRoot(null);
    rmSync(stateRoot, { recursive: true, force: true });
  });

  test('runNexus initial boot and reload pass unset, global, and server override configuration to the registrar', async () => {
    const calls: Array<{ servers: import('../user-config.js').McpServerSpec[]; handshakeTimeoutMs?: number }> = [];
    let httpOpts: import('./api/http-server.js').NexusHttpServerOpts | undefined;
    const initial = {
      mcp: {
        handshakeTimeoutMs: 7_000,
        servers: [
          { id: 'global', transport: 'stdio', command: ['global'] },
          { id: 'override', transport: 'stdio', command: ['override'], handshakeTimeoutMs: 12_000 },
        ],
      },
    };
    const reloaded = {
      mcp: {
        servers: [{ id: 'default', transport: 'stdio', command: ['default'] }],
      },
    };
    const nexus = await runNexus({
      detachForTesting: true,
      skipHttpServer: false,
      skipSupervisor: true,
      skipRuntimeApi: true,
      skipPushcutChannel: true,
      skipPwaChannel: true,
      skipTelegramChannel: true,
      skipTerminalChannel: true,
      skipDiscordChannel: true,
      skipIntentPrediction: true,
      skipEnvMigration: true,
      skipRestoreFromPending: true,
      registerDaemonTab: false,
      registerSettingsTab: false,
      getMcpUserConfigForTesting: () => initial as never,
      reloadUserConfigForTesting: () => reloaded as never,
      registerMcpClientsFn: async (opts) => {
        calls.push({ servers: opts.servers, ...(opts.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: opts.handshakeTimeoutMs }) });
        return { clients: [], registered: 0, perServer: {}, shutdown: async () => {} };
      },
      startNexusHttpServerFn: ((opts: import('./api/http-server.js').NexusHttpServerOpts) => {
        httpOpts = opts;
        return { port: 31415, stop: () => {} } as never;
      }) as typeof import('./api/http-server.js').startNexusHttpServer,
    });
    if (!nexus) throw new Error('runNexus returned undefined');

    try {
      await Promise.resolve();
      expect(calls).toEqual([{
        handshakeTimeoutMs: 7_000,
        servers: [
          { id: 'global', transport: 'stdio', command: ['global'] },
          { id: 'override', transport: 'stdio', command: ['override'], handshakeTimeoutMs: 12_000 },
        ],
      }]);
      expect(httpOpts?.reloadMcpClients).toBeDefined();
      await httpOpts!.reloadMcpClients!();
      expect(calls[1]).toEqual({
        servers: [{ id: 'default', transport: 'stdio', command: ['default'] }],
      });
    } finally {
      await nexus.release();
    }
  }, 15_000);
});

describe('runNexus · MCP widget server binding', () => {
  let stateRoot: string;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-widget-bind-'));
    setTestStateRoot(stateRoot);
  });

  afterEach(() => {
    setTestStateRoot(null);
    rmSync(stateRoot, { recursive: true, force: true });
  });

  async function boot(mcp: {
    servers: Array<{ id: string; command: string[] }>;
    widgetServerId?: string;
  }) {
    let captured: import('./api/http-server.js').NexusHttpServerOpts | undefined;
    const nexus = await runNexus({
      detachForTesting: true,
      skipHttpServer: false,
      mcpEnabled: false,
      skipSupervisor: true,
      skipRuntimeApi: true,
      skipPushcutChannel: true,
      skipPwaChannel: true,
      skipTelegramChannel: true,
      skipTerminalChannel: true,
      skipDiscordChannel: true,
      skipIntentPrediction: true,
      skipEnvMigration: true,
      skipRestoreFromPending: true,
      registerDaemonTab: false,
      registerSettingsTab: false,
      startNexusHttpServerFn: ((opts: import('./api/http-server.js').NexusHttpServerOpts) => {
        captured = opts;
        return { port: 31415, stop: () => {} } as never;
      }) as typeof import('./api/http-server.js').startNexusHttpServer,
      getMcpUserConfigForTesting: () => ({ mcp } as never),
      registerMcpClientsFn: async () => ({
        clients: [],
        registered: 0,
        perServer: {},
        shutdown: async () => {},
      }),
    });
    if (!nexus) throw new Error('runNexus returned undefined');
    return { nexus, captured };
  }

  test('passes getMcpWidgetServerId only when widgetServerId names a configured server', async () => {
    const { nexus, captured } = await boot({
      widgetServerId: 'xcodebuild',
      servers: [
        { id: 'xcode', command: ['xcrun', 'mcpbridge'] },
        { id: 'xcodebuild', command: ['xcodebuildmcp', 'mcp'] },
        { id: 'higgsfield', command: ['higgsfield'] },
      ],
    });
    try {
      expect(captured?.getMcpWidgetServerId).toBeDefined();
      expect(captured?.getMcpWidgetServerId?.(new Request('http://nexus.test/v1/mcp/widgets/call'))).toBe('xcodebuild');
    } finally {
      await nexus.release();
    }
  }, 15_000);

  test('omits getMcpWidgetServerId when widgetServerId is absent so the sole-ready fallback stays in charge', async () => {
    const { nexus, captured } = await boot({
      servers: [
        { id: 'xcodebuild', command: ['xcodebuildmcp', 'mcp'] },
        { id: 'higgsfield', command: ['higgsfield'] },
      ],
    });
    try {
      expect(captured?.getMcpWidgetServerId).toBeUndefined();
    } finally {
      await nexus.release();
    }
  }, 15_000);

  test('omits getMcpWidgetServerId when widgetServerId is not in mcp.servers', async () => {
    const { nexus, captured } = await boot({
      widgetServerId: 'ghost',
      servers: [
        { id: 'xcodebuild', command: ['xcodebuildmcp', 'mcp'] },
        { id: 'higgsfield', command: ['higgsfield'] },
      ],
    });
    try {
      expect(captured?.getMcpWidgetServerId).toBeUndefined();
    } finally {
      await nexus.release();
    }
  }, 15_000);
});
