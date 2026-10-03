// Nexus wsBridgeOpts wiring: pass wsAuthVerifier only when bearerToken
// is present. Executes buildNexusWsBridgeAuth — the unit runNexus uses
// when assembling wsBridgeOpts (same shape as src/boot/acp-server.ts).

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildNexusWsBridgeAuth, runNexus } from './index.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { ProjectStore } from '../project/project-store.js';
import { createSession } from '../session/index.js';
import { handleCreateTab } from './api/tabs-mutations.js';
import { createRegistryBackend } from './webterm/pty.js';
import type { StartOpts } from '../pty-shell/registry.js';
import { setTestStateRoot } from './paths.js';
import type { PwaShareDeps, PwaShareResult } from '../cli/pwa-share.js';
import type { ShareMountResult } from '../cli/share-auto-mount.js';

const CONFIGURED_TOKEN = 'configured-token-xxxxxxxxxxxxxxxxxxxx';

/** ⛔ 이 파일이 만든 임시 디렉토리를 걷는다 — 반복 실행에서 /tmp 가 샌다. */
const tempDirs: string[] = [];
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

test('NEXUS boot starts a webterm tab in the associated conversation project folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-webterm-project-'));
  const previous = process.env.ELANOUS_SESSION_ROOT;
  let nexus: Awaited<ReturnType<typeof runNexus>>;
  try {
    setElanousConfigDir(root);
    setTestStateRoot(root);
    process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    const folder = join(root, 'project');
    mkdirSync(folder);
    const project = new ProjectStore(root).create({ name: 'sample', primaryFolder: folder });
    const assigned = createSession({ projectId: project.id });
    const plain = createSession();
    const observed: StartOpts[] = [];
    nexus = await runNexus({ detachForTesting: true, skipHttpServer: true, skipRuntimeApi: true,
      skipSupervisor: true, mcpEnabled: false, skipRestoreFromPending: true, toolCwd: root,
      cleanGhostTailscaleServeFn: async () => {}, webtermSpawn: (opts) => createRegistryBackend(opts, {
        startPty: (spawn) => {
          observed.push(spawn);
          return { id: `pty-${observed.length}` } as ReturnType<typeof import('../pty-shell/registry.js').startPty>;
        },
        onPtyEvent: () => () => {},
      }),
    });
    if (!nexus) throw new Error('NEXUS failed to start');
    const supervisor = { startTab: async () => {} } as unknown as import('./supervisor/index.js').Supervisor;
    const create = async (id: string, sessionId: string, cwd?: string) => {
      const response = await handleCreateTab(new Request('http://localhost/v1/nexus/tabs', {
        method: 'POST', body: JSON.stringify({ kind: 'webterm', id, sessionId, kindOpts: cwd ? { cwd } : {} }),
      }), { state: nexus!.state, registry: nexus!.registry, supervisor });
      expect(response.status).toBe(201);
    };
    await create('webterm:project', assigned.id);
    await create('webterm:plain', plain.id);
    await create('webterm:explicit', assigned.id, root);
    expect(observed.map(spawn => spawn.workdir)).toEqual([folder, root, root]);
  } finally {
    nexus?.release();
    resetElanousConfigDir();
    setTestStateRoot(null);
    if (previous === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

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

describe('Nexus startup bearer token', () => {
  let isolated: string;
  let previousNoAuth: string | undefined;
  beforeEach(() => {
    isolated = mkdtempSync(join(tmpdir(), 'nexus-auth-boot-'));
    setElanousConfigDir(isolated);
    setTestStateRoot(isolated);
    previousNoAuth = process.env.ELANOUS_NEXUS_NO_AUTH;
    delete process.env.ELANOUS_NEXUS_NO_AUTH;
  });
  afterEach(() => {
    resetElanousConfigDir();
    setTestStateRoot(null);
    if (previousNoAuth === undefined) delete process.env.ELANOUS_NEXUS_NO_AUTH;
    else process.env.ELANOUS_NEXUS_NO_AUTH = previousNoAuth;
    rmSync(isolated, { recursive: true, force: true });
  });

  async function boot(noAuth?: boolean, realServer = false) {
    let captured: import('./api/http-server.js').NexusHttpServerOpts | undefined;
    const nexus = await runNexus({
      detachForTesting: true, skipHttpServer: false, skipRuntimeApi: false,
      toolCwd: isolated, skipSupervisor: true, mcpEnabled: false, cleanGhostTailscaleServeFn: async () => {},
      skipPushcutChannel: true, skipPwaChannel: true, skipTelegramChannel: true,
      skipDiscordChannel: true, skipTerminalChannel: true, skipIntentPrediction: true,
      ...(noAuth === undefined ? {} : { noAuth }),
      ...(realServer ? { httpStartPort: 49000 + Math.floor(Math.random() * 2000) } : {
        startNexusHttpServerFn: ((opts: import('./api/http-server.js').NexusHttpServerOpts) => {
          captured = opts;
          return { port: 31415, hostname: '127.0.0.1', url: 'http://127.0.0.1:31415', stop: () => {} };
        }) as typeof import('./api/http-server.js').startNexusHttpServer,
      }),
    });
    if (!nexus || (!realServer && !captured) || !nexus.httpServer) throw new Error('Nexus did not bind');
    return { nexus, captured: captured! };
  }

  test('live Nexus rejects a headerless REST mutation and unauthenticated ACP websocket', async () => {
    const { nexus } = await boot(undefined, true);
    const base = nexus.httpServer!.url;
    try {
      const rest = await fetch(`${base}/v1/nexus/tabs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'chat', id: 'unauthorized' }),
      });
      expect(rest.status).toBe(401);
      expect(await rest.json()).toEqual({ error: 'unauthorized' });

      const ws = new WebSocket(base.replace(/^http:/, 'ws:') + '/v1/acp');
      try {
        const opened = new Promise<void>((resolve, reject) => {
          ws.addEventListener('open', () => resolve(), { once: true });
          ws.addEventListener('error', () => reject(new Error('ACP websocket upgrade failed')), { once: true });
        });
        await Promise.race([opened, Bun.sleep(3_000).then(() => { throw new Error('ACP websocket open timed out'); })]);
        const rejected = new Promise<{ code: number; reason: string }>((resolve, reject) => {
          ws.addEventListener('close', event => resolve({ code: event.code, reason: event.reason }), { once: true });
          ws.addEventListener('error', () => reject(new Error('ACP websocket failed before auth rejection')), { once: true });
        });
        ws.send(JSON.stringify({ kind: 'auth' }));
        expect(await Promise.race([rejected, Bun.sleep(3_000).then(() => { throw new Error('ACP websocket auth rejection timed out'); })]))
          .toEqual({ code: 1008, reason: 'auth_failed' });
      } finally { ws.close(); }
    } finally { nexus.release(); }
  }, 20_000);

  test('missing token is created with mode 0600 and gates both REST and websocket', async () => {
    const { nexus, captured } = await boot();
    try {
      const path = join(isolated, 'acp-token');
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const token = readFileSync(path, 'utf8');
      expect(token.length).toBeGreaterThan(0);
      expect(captured.metaApi?.noAuth).toBe(false);
      expect(captured.metaApi?.bearerToken).toBe(token);
      expect(captured.wsBridge?.wsAuthVerifier?.verify({ kind: 'auth', token } as Parameters<NonNullable<NonNullable<typeof captured.wsBridge>['wsAuthVerifier']>['verify']>[0])).toEqual({ ok: true });
      expect(nexus.runtime.httpAuth).toBe('on');
    } finally { nexus.release(); }
  });

  test('existing token is reused without modifying its file contents', async () => {
    const path = join(isolated, 'acp-token');
    writeFileSync(path, `${CONFIGURED_TOKEN}\n`);
    const { nexus, captured } = await boot();
    try {
      expect(readFileSync(path, 'utf8')).toBe(`${CONFIGURED_TOKEN}\n`);
      expect(captured.metaApi?.bearerToken).toBe(CONFIGURED_TOKEN);
    } finally { nexus.release(); }
  });

  test('explicit --no-auth and env=1 bypass both gates without creating a token', async () => {
    for (const viaEnv of [false, true]) {
      if (viaEnv) process.env.ELANOUS_NEXUS_NO_AUTH = '1';
      const { nexus, captured } = await boot(viaEnv ? undefined : true);
      try {
        expect(captured.metaApi?.noAuth).toBe(true);
        expect(captured.metaApi?.bearerToken).toBeUndefined();
        expect(captured.wsBridge?.wsAuthVerifier).toBeUndefined();
        expect(existsSync(join(isolated, 'acp-token'))).toBe(false);
        expect(nexus.runtime.httpAuth).toBe('off');
      } finally { nexus.release(); }
    }
  });

  test('both explicit opt-outs print a banner warning and emit nexus.auth with source', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const { debug } = await import('../debug/log.js');
    const log = spyOn(debug, 'log');
    try {
      for (const viaEnv of [false, true]) {
        warn.mockClear();
        log.mockClear();
        if (viaEnv) process.env.ELANOUS_NEXUS_NO_AUTH = '1';
        let finish!: () => void;
        const done = new Promise<void>(resolve => { finish = resolve; });
        const boot = runNexus({
          ...(viaEnv ? {} : { noAuth: true }), headless: true, headlessDoneForTesting: done,
          skipHeadlessSetupCheckForTesting: true, autoMountShare: false,
          skipHttpServer: false, skipRuntimeApi: false, skipSupervisor: true,
          skipPushcutChannel: true, skipPwaChannel: true, skipTelegramChannel: true,
          skipDiscordChannel: true, skipTerminalChannel: true, skipIntentPrediction: true,
          toolCwd: isolated, mcpEnabled: false, cleanGhostTailscaleServeFn: async () => {},
          startNexusHttpServerFn: (() => ({ port: 31415, hostname: '127.0.0.1', url: 'http://127.0.0.1:31415', stop: () => {} })) as typeof import('./api/http-server.js').startNexusHttpServer,
        });
        try {
          const deadline = Date.now() + 8_000;
          while (!warn.mock.calls.some(([message]) => String(message).includes('AUTH DISABLED')) && Date.now() < deadline) await Bun.sleep(5);
          expect(warn.mock.calls.some(([message]) => String(message).includes('AUTH DISABLED'))).toBe(true);
          expect(log.mock.calls.some(([category, event, data]) => category === 'nexus.auth'
            && event === 'explicit-opt-out'
            && (data as { source?: string }).source === (viaEnv ? 'ELANOUS_NEXUS_NO_AUTH' : '--no-auth'))).toBe(true);
        } finally {
          finish();
          await boot;
        }
      }
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test('other env values are not opt-outs', async () => {
    process.env.ELANOUS_NEXUS_NO_AUTH = 'true';
    const { nexus, captured } = await boot();
    try {
      expect(captured.metaApi?.noAuth).toBe(false);
      expect(captured.metaApi?.bearerToken).toBeDefined();
    } finally { nexus.release(); }
  });

  test('empty existing token fails closed before the HTTP listener binds', async () => {
    writeFileSync(join(isolated, 'acp-token'), '  \n');
    let bound = false;
    await expect(runNexus({
      detachForTesting: true, skipHttpServer: false, skipRuntimeApi: false,
      toolCwd: isolated, skipSupervisor: true, mcpEnabled: false,
      startNexusHttpServerFn: ((() => { bound = true; throw new Error('bound unexpectedly'); }) as unknown) as typeof import('./api/http-server.js').startNexusHttpServer,
    })).rejects.toThrow('Nexus auth token is empty');
    expect(bound).toBe(false);
    expect(existsSync(join(isolated, 'nexus', '.lock'))).toBe(false);
  });

  test('token creation failure aborts before the HTTP listener binds', async () => {
    const invalidConfigDir = join(isolated, 'config-file');
    writeFileSync(invalidConfigDir, 'not a directory');
    setElanousConfigDir(invalidConfigDir);
    let bound = false;
    await expect(runNexus({
      detachForTesting: true, skipHttpServer: false, skipRuntimeApi: false,
      toolCwd: isolated, skipSupervisor: true, mcpEnabled: false,
      startNexusHttpServerFn: ((() => { bound = true; throw new Error('bound unexpectedly'); }) as unknown) as typeof import('./api/http-server.js').startNexusHttpServer,
    })).rejects.toThrow();
    expect(bound).toBe(false);
    expect(existsSync(join(isolated, 'nexus', '.lock'))).toBe(false);
  });

  test('token read failure aborts before the HTTP listener binds', async () => {
    mkdirSync(join(isolated, 'acp-token'));
    let bound = false;
    await expect(runNexus({
      detachForTesting: true, skipHttpServer: false, skipRuntimeApi: false,
      toolCwd: isolated, skipSupervisor: true, mcpEnabled: false,
      startNexusHttpServerFn: ((() => { bound = true; throw new Error('bound unexpectedly'); }) as unknown) as typeof import('./api/http-server.js').startNexusHttpServer,
    })).rejects.toThrow();
    expect(bound).toBe(false);
    expect(existsSync(join(isolated, 'nexus', '.lock'))).toBe(false);
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
