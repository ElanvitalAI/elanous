// TUI-process MCP proxy bootstrap.
//
// External MCP proxy runtimes already declare surfaces `['mcp','tui']`, but
// the TUI process never called the existing registrar (`registerMcpClients`).
// This module reuses that registrar so configured `mcp.servers` tools appear
// in `listToolRuntimes('tui')` without per-tool wiring.
//
// Contract:
//   • Non-blocking — the caller gets a handle immediately; attach runs in
//     the background. TUI startup does not wait on MCP handshake.
//   • Fail-soft — spawn/handshake failure never throws to the caller.
//   • Queryable — `getMcpProxyBootstrapDiagnostics()` keeps the reason a
//     tool is missing (empty config, disabled, per-server failure).
//   • Injectable — tests replace `createClient` / `servers` so no real MCP
//     child process is spawned.

import { debug } from '../debug/log.js';
import {
  registerMcpClients,
  type McpBootLogger,
  type McpClientsHandle,
  type McpServerBootResult,
  type RegisterMcpClientsOpts,
} from '../nexus/boot/register-mcp-clients.js';
import { getUserConfig, type McpServerSpec, type UserConfig } from '../user-config.js';
import { registerToolRuntime } from './registry.js';

export type McpProxyBootstrapStatus = 'idle' | 'pending' | 'ready' | 'skipped' | 'failed';

export interface McpProxyBootstrapSnapshot {
  status: McpProxyBootstrapStatus;
  registered: number;
  perServer: Record<string, McpServerBootResult>;
  reason?: string;
  /** Attach never blocks the caller. Always false. */
  blocking: false;
}

export interface McpProxyBootstrapHandle {
  /** Settles when attach finishes (or immediately when skipped). Never rejects. */
  ready: Promise<McpProxyBootstrapSnapshot>;
  snapshot(): McpProxyBootstrapSnapshot;
}

export interface BootstrapMcpProxyRuntimesOpts {
  servers?: McpServerSpec[];
  enabled?: boolean;
  getConfig?: () => Pick<UserConfig, 'mcp'>;
  registerClients?: (opts: RegisterMcpClientsOpts) => Promise<McpClientsHandle>;
  createClient?: RegisterMcpClientsOpts['createClient'];
  registerRuntime?: typeof registerToolRuntime;
  logger?: McpBootLogger;
  handshakeTimeoutMs?: number;
  /** CLASSIC-IDLE-MCP-LAZY — classic TUI 만 켠다. MCP 자식을 «첫 도구 호출»
   *  때 띄우고, 그 전엔 지난 부팅의 툴 인덱스로 목록만 알린다. */
  lazy?: boolean;
  toolIndexStore?: RegisterMcpClientsOpts['toolIndexStore'];
}

const IDLE: McpProxyBootstrapSnapshot = {
  status: 'idle',
  registered: 0,
  perServer: {},
  blocking: false,
};

let testOpts: BootstrapMcpProxyRuntimesOpts | null = null;
let activeHandle: McpProxyBootstrapHandle | undefined;
let activeClients: McpClientsHandle | undefined;
let exitHookInstalled = false;
let lastSnapshot: McpProxyBootstrapSnapshot = IDLE;
let bootGeneration = 0;

/** Test seam — next `bootstrapMcpProxyRuntimes()` / default-runtime boot picks these up. */
export function setMcpProxyBootstrapOptsForTest(opts: BootstrapMcpProxyRuntimesOpts | null): void {
  testOpts = opts;
  _resetMcpProxyBootstrapForTest();
}

/** Test seam — drop the in-flight boot so a later call is not a no-op. */
export function _resetMcpProxyBootstrapForTest(): void {
  bootGeneration += 1;
  activeHandle = undefined;
  activeClients = undefined;
  lastSnapshot = IDLE;
}

export function getMcpProxyBootstrapDiagnostics(): McpProxyBootstrapSnapshot {
  return activeHandle ? activeHandle.snapshot() : lastSnapshot;
}

export function getMcpProxyBootstrapHandle(): McpProxyBootstrapHandle | undefined {
  return activeHandle;
}

/** 프로세스가 «그냥» 죽는 경로(exit 훅)에서도 MCP 자식이 고아로 남지 않게 마지막
 *  SIGTERM 을 건다. `process.on('exit')` 은 await 할 수 없으므로 동기 kill 만 쓴다. */
function installMcpExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    const clients = activeClients;
    activeClients = undefined;
    if (!clients) return;
    try {
      const terminated = clients.terminateChildrenSync?.() ?? 0;
      if (terminated > 0) log('exit-terminate', { terminated });
    } catch {
      /* dying process — never throw from an exit hook */
    }
  });
}

function observabilityBootLogger(): McpBootLogger {
  return {
    info: (line) => {
      try { debug.log('tool-runtime.mcp-proxy-bootstrap', 'client-info', { line }); } catch { /* never throw the boot */ }
    },
    warn: (line) => {
      try { debug.log('tool-runtime.mcp-proxy-bootstrap', 'client-warn', { line }, { level: 'warn' }); } catch { /* never throw the boot */ }
    },
  };
}

function log(event: string, data?: Record<string, unknown>): void {
  try {
    debug.log('tool-runtime.mcp-proxy-bootstrap', event, data ?? {});
  } catch {
    /* logger must never throw the boot */
  }
}

function freezeSnapshot(snap: McpProxyBootstrapSnapshot): McpProxyBootstrapSnapshot {
  lastSnapshot = snap;
  return snap;
}

function skippedHandle(reason: string): McpProxyBootstrapHandle {
  const snap = freezeSnapshot({
    status: 'skipped',
    registered: 0,
    perServer: {},
    reason,
    blocking: false,
  });
  const handle: McpProxyBootstrapHandle = {
    ready: Promise.resolve(snap),
    snapshot: () => snap,
  };
  activeHandle = handle;
  log('skipped', { reason });
  return handle;
}

function resolveOpts(opts?: BootstrapMcpProxyRuntimesOpts): BootstrapMcpProxyRuntimesOpts {
  return { ...(testOpts ?? {}), ...(opts ?? {}) };
}

/**
 * Start (or reuse) MCP proxy registration for this process.
 * Returns immediately; observe `handle.ready` / diagnostics for completion.
 */
export function bootstrapMcpProxyRuntimes(
  opts?: BootstrapMcpProxyRuntimesOpts,
): McpProxyBootstrapHandle {
  if (activeHandle) return activeHandle;

  const resolved = resolveOpts(opts);
  const cfg = (resolved.getConfig ?? getUserConfig)();
  const enabled = resolved.enabled ?? (resolved.servers ? true : cfg.mcp?.enabled);
  if (enabled === false) return skippedHandle('disabled');

  const servers = resolved.servers ?? cfg.mcp?.servers ?? [];
  if (servers.length === 0) return skippedHandle('no-servers');

  // bun test must not spawn real MCP children unless a test injected the client.
  if (!resolved.createClient && process.env.BUN_TEST) {
    return skippedHandle('uninjected-test-runtime');
  }

  const generation = bootGeneration;
  let current: McpProxyBootstrapSnapshot = freezeSnapshot({
    status: 'pending',
    registered: 0,
    perServer: {},
    blocking: false,
  });

  const handle: McpProxyBootstrapHandle = {
    ready: Promise.resolve(current),
    snapshot: () => current,
  };
  activeHandle = handle;
  log('start', { serverCount: servers.length });

  const ready = (async (): Promise<McpProxyBootstrapSnapshot> => {
    try {
      const registerClients = resolved.registerClients ?? registerMcpClients;
      const result = await registerClients({
        servers,
        // The registrar's default logger writes to console.info/console.warn.
        // In the TUI process that output lands on top of the already-painted
        // frame (status line / prompt) seconds after boot, because the
        // handshake is non-blocking. Route it to observability instead.
        logger: resolved.logger ?? observabilityBootLogger(),
        ...(resolved.createClient ? { createClient: resolved.createClient } : {}),
        ...(resolved.registerRuntime ? { registerRuntime: resolved.registerRuntime } : {}),
        ...(resolved.handshakeTimeoutMs !== undefined
          ? { handshakeTimeoutMs: resolved.handshakeTimeoutMs }
          : {}),
        ...(resolved.lazy === true ? { lazy: true } : {}),
        ...(resolved.toolIndexStore ? { toolIndexStore: resolved.toolIndexStore } : {}),
      });
      if (generation !== bootGeneration) {
        try { await result.shutdown(); } catch { /* abandoned boot */ }
        return current;
      }
      activeClients = result;
      installMcpExitHook();
      const snap = freezeSnapshot({
        status: 'ready',
        registered: result.registered,
        perServer: result.perServer,
        blocking: false,
      });
      current = snap;
      const failedServers = Object.entries(snap.perServer)
        .filter(([, entry]) => entry.status === 'failed')
        .map(([id]) => id);
      log('ready', {
        registered: snap.registered,
        servers: Object.keys(snap.perServer),
        ...(failedServers.length > 0 ? { failedServers } : {}),
      });
      return snap;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (generation !== bootGeneration) return current;
      const snap = freezeSnapshot({
        status: 'failed',
        registered: 0,
        perServer: {},
        reason,
        blocking: false,
      });
      current = snap;
      log('failed', { reason });
      return snap;
    }
  })();

  handle.ready = ready;
  return handle;
}
