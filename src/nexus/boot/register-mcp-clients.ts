// NEXUS · MCP-client substrate boot (B 트랙 Phase 2 · RFC #2474)
//
// Spawns each enabled external MCP server (xcrun mcpbridge ·
// xcodebuildmcp · …), performs the JSON-RPC `initialize` +
// `tools/list` handshake, and registers every remote tool as a proxy
// ToolRuntime under `<server-id>.<tool-name>`. Once registered the
// tool flows through all five elanous surfaces (TUI · PWA `/chat` ·
// webterm `:agent` · NEXUS HTTP · MCP server relay) automatically —
// see RFC §5.
//
// Graceful boot policy:
//   • A failed spawn / handshake / listTools NEVER blocks NEXUS boot.
//     We log, skip the offender, continue with the next server.
//   • Each `start()` + `listTools()` is bounded by `handshakeTimeoutMs`
//     (default 8000ms). A misbehaving server that accepts the spawn
//     but never replies to JSON-RPC initialize used to block daemon
//     boot indefinitely (line ~1601 startNexusHttpServer never runs);
//     the timeout converts that into a logged 'failed' so the rest of
//     the daemon comes up.
//   • `enabled: false` rows are skipped silently (config kept for
//     muscle memory).
//   • Empty `servers[]` → returns a no-op handle.
//
// Shutdown:
//   • `handle.shutdown()` calls `dispose()` on every client. NEXUS's
//     `wrappedRelease` (`src/nexus/index.ts:1725`) invokes this so the
//     child processes get SIGTERM (+ SIGKILL fallback) before
//     daemon exit.

import type { McpServerSpec } from '../../user-config.js';
import { McpClient, McpConnectionError, type McpTool, type McpToolCallResult } from '../../mcp/client.js';
import {
  createMcpProxyRuntime,
  createMcpToolAuthorizer,
} from '../../mcp/proxy-runtime.js';
import { registerToolRuntime, unregisterToolRuntime } from '../../tool-runtime/registry.js';
import { debug, redactSecretText } from '../../debug/log.js';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { listNodeKinds } from '../../graph-kinds/registry.js';
import { syncInstalledPluginNodes } from '../../graph-kinds/installed-plugin-nodes.js';
import { listInstalledPlugins } from '../../plugins/install/plugin-install.js';
import { pluginEnv, credentialStatus } from '../../plugins/install/plugin-credentials.js';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export interface McpClientsHandle {
  /** Live clients (one per successfully started server). */
  clients: McpClient[];
  /** Total tools registered across all servers. */
  registered: number;
  /** Per-server diagnostic. Indexed by `spec.id`. */
  perServer: Record<string, McpServerBootResult>;
  // ⛔ 초판은 여기에 `authorizer` 를 노출했다. ***테스트 밖 읽는 자가 «하나도» 없었다*** —
  //    리뷰가 4라운드 연속 그것을 DEAD 표면으로 지적했고 그것이 이 골이 죽은 직접 원인이다.
  //    ⇒ 노출하지 않는다. 허가 상태는 「등록된 런타임이 거부하나」로 «행동»으로 관측한다.
  /** Stop all clients gracefully and revoke this handle's grants. Safe to call multiple times. */
  shutdown(): Promise<void>;
  /** 동기 마지막 수단 — 프로세스 exit 훅은 `await` 할 수 없다. 살아 있는 자식에
   *  SIGTERM 만 «즉시» 쏘고 신호를 보낸 수를 돌려준다(유예·SIGKILL 은 `shutdown` 몫). */
  terminateChildrenSync?(): number;
}

export interface McpServerBootResult {
  /** 'ready' = handshake + listTools succeeded, tools registered.
   *  'disabled' = enabled:false in user-config.
   *  'failed' = spawn/handshake/listTools threw; client never registered. */
  status: 'ready' | 'disabled' | 'failed';
  /** Number of tools registered from this server. 0 unless status=='ready'. */
  toolCount: number;
  /** When status=='ready' under `lazy`: the tools above were announced from the
   *  cached tool index and the child has NOT been spawned yet — the first
   *  `callTool` on one of them spawns it (once). Absent = spawned eagerly. */
  deferred?: boolean;
  /** When status=='failed', the error message captured (string only —
   *  callers should not depend on Error identity). */
  reason?: string;
  /** When status=='failed', the classified cause. Same vocabulary as the
   *  `mcp.client.boot` / `connect-failed` log row's `reason`. */
  reasonClass?: McpConnectFailureClass;
}

/** Classified cause of a boot-time MCP attach failure.
 *  `McpConnectionError.reason` plus the message shapes the boot catch sees. */
export type McpConnectFailureClass =
  | 'auth-required'
  | 'invalid-token'
  | 'unreachable'
  | 'not-mcp'
  | 'handshake-timeout'
  | 'spawn-failed'
  | 'other';

const SPAWN_FAILURE = /\b(?:ENOENT|EACCES|EPERM|ENOTDIR)\b|spawn \S+ ENOENT/i;

/** Map a thrown attach error onto the boot failure vocabulary.
 *  `invalid_token` wins over `McpConnectionError.reason` — a 401 whose
 *  body says the token itself was rejected is a different next action
 *  from "authentication required". */
export function classifyMcpConnectFailure(err: unknown): McpConnectFailureClass {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('invalid_token')) return 'invalid-token';
  if (err instanceof McpConnectionError) return err.reason;
  if (msg.includes('-timeout after ')) return 'handshake-timeout';
  if (SPAWN_FAILURE.test(msg)) return 'spawn-failed';
  return 'other';
}

export interface RegisterMcpClientsOpts {
  servers: McpServerSpec[];
  /** Defaults to `console.warn` for failures + `console.info` for the
   *  one-line success summary. Tests inject a recorder. */
  logger?: McpBootLogger;
  /** Defaults to `registerToolRuntime` from `tool-runtime/registry`. */
  registerRuntime?: typeof registerToolRuntime;
  /** 등록을 되돌리는 자리. 기본은 `unregisterToolRuntime`.
   *  ⛔ 이 심이 «없으면» 재장전이 원리상 불가능하다 — 자세한 이유는 그 함수의 주석. */
  unregisterRuntime?: typeof unregisterToolRuntime;
  /** McpClient factory — defaults to `new McpClient({...})`. Tests
   *  inject a fake to assert spawn args + emit fake responses.
   *  HTTP specs reach this factory with `url` (no child spawn). */
  createClient?: (
    spec: McpServerSpec,
  ) => Pick<McpClient, 'start' | 'listTools' | 'callTool' | 'dispose'>;
  /** Per-server `start()` + `listTools()` deadline (ms). A misbehaving
   *  child that accepts the spawn but never answers JSON-RPC initialize
   *  used to block NEXUS boot indefinitely — daemon main path awaited
   *  this call and never reached `startNexusHttpServer`. The default
   *  bounds each attempt so the rest of the daemon comes up. Default
   *  8000ms; set 0/negative to disable (tests). */
  handshakeTimeoutMs?: number;
  /** Test seam — replaces `setTimeout` so tests don't wait real ms. */
  setTimeoutFn?: (cb: () => void, ms: number) => { unref?(): void };
  /** Test seam — replaces `clearTimeout`. */
  clearTimeoutFn?: (handle: { unref?(): void }) => void;
  /** CLASSIC-IDLE-MCP-LAZY (0.2.35) — classic TUI 백그라운드 경량화.
   *  true 면 자식은 «기동 때»가 아니라 «첫 도구 호출» 때 한 번 뜬다.
   *  그 전까지 알리는 툴 «목록»은 지난 부팅이 적어 둔 인덱스
   *  (`MCP_TOOL_INDEX_FILENAME`) 그대로다 — 목록·권한은 무변경.
   *  인덱스가 없는 서버(콜드 스타트)는 종전대로 즉시 기동하고 인덱스를 적는다. */
  lazy?: boolean;
  /** `lazy` 가 읽고 쓰는 툴 인덱스. 기본은 상태 루트의 `mcp-tool-index.json`. */
  toolIndexStore?: McpToolIndexStore;
  /** `lazy` 자식의 SIGTERM→SIGKILL 유예(ms). 기본 2500 — 종료 3초 계약 안쪽. */
  lazyShutdownGraceMs?: number;
}

/** 한 서버가 지난 부팅에서 알린 툴 목록. `mcp-tool-index.json` 의 값. */
export type McpToolIndex = Record<string, McpTool[]>;

/** 툴 목록 캐시의 읽기/쓰기 자리 — 테스트가 임시 저장소로 갈아 끼운다. */
export interface McpToolIndexStore {
  read(): McpToolIndex;
  write(index: McpToolIndex): void;
}

export const MCP_TOOL_INDEX_FILENAME = 'mcp-tool-index.json';

/** 지연 기동 자식의 정리 유예. `McpClient` 기본 5000ms 는 「SIGTERM 3초 안에
 *  안 끝남」이던 classic 종료 계약을 넘긴다 — 2500ms 면 SIGKILL 까지 3초 안쪽. */
const DEFAULT_LAZY_SHUTDOWN_GRACE_MS = 2500;

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 8000;

/** Race `op` against a timeout. Resolves to `op` on success; rejects
 *  with `handshake-timeout` on miss. Cleared timer never lingers. */
function withTimeout<T>(
  label: string,
  op: () => Promise<T>,
  ms: number,
  setTimeoutFn: NonNullable<RegisterMcpClientsOpts['setTimeoutFn']>,
  clearTimeoutFn: NonNullable<RegisterMcpClientsOpts['clearTimeoutFn']>,
): Promise<T> {
  if (ms <= 0) return op();
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeoutFn(() => {
      reject(new Error(`${label}-timeout after ${ms}ms`));
    }, ms);
    op().then(
      (v) => { clearTimeoutFn(handle); resolve(v); },
      (e) => { clearTimeoutFn(handle); reject(e); },
    );
  });
}

type DeferredInner = Pick<McpClient, 'start' | 'listTools' | 'callTool' | 'dispose'>;

/** 첫 도구 호출까지 자식을 띄우지 않는 MCP 클라이언트 프록시.
 *  - `callTool` 이 «한 번» 기동하고 동시 호출은 같은 기동을 기다린다.
 *  - 기동 실패는 캐시하지 않는다 — 자식이 늦게 뜨면 다음 호출이 다시 시도한다.
 *  - `dispose()` 는 진행 중 기동을 먼저 기다린다 — 자식이 새지 않는다. */
class DeferredMcpClient implements DeferredInner {
  private pending: Promise<void> | null = null;
  private started = false;
  private disposed = false;

  constructor(
    private readonly inner: DeferredInner,
    private readonly boot: () => Promise<void>,
    private readonly serverId: string,
  ) {}

  get spawned(): boolean { return this.started; }

  async start(): Promise<void> { await this.ensureStarted(); }

  async listTools(): Promise<McpTool[]> {
    await this.ensureStarted();
    return this.inner.listTools();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    await this.ensureStarted();
    // ⚠️ 기동 «뒤»의 inner.callTool 을 부른다 — 자격증명 마스킹 래퍼가
    //    createClient 직후 client.callTool 에 씌워지므로 그 래퍼를 탄다.
    return this.inner.callTool(name, args);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.pending) {
      try { await this.pending; } catch { /* 기동 실패는 정리를 막지 않는다 */ }
    }
    try { await this.inner.dispose(); } catch { /* dispose() is best-effort */ }
  }

  private async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new Error(`mcp.${this.serverId}: lazy client was disposed before its first tool call`);
    }
    if (this.started) return;
    if (!this.pending) {
      this.pending = this.boot().then(() => { this.started = true; });
      this.pending.catch(() => { this.pending = null; });
    }
    await this.pending;
  }
}

export interface McpBootLogger {
  info(line: string): void;
  warn(line: string): void;
}

/** Boot the configured MCP-client substrate. Idempotent at the
 *  granularity of "called once per NEXUS boot" — calling twice would
 *  spawn the children twice + double-register tool ids (id collision
 *  throws in registry), so callers should hold the returned handle
 *  for the daemon lifetime and call `shutdown()` on tear-down. */
export async function registerMcpClients(
  opts: RegisterMcpClientsOpts,
): Promise<McpClientsHandle> {
  const logger = opts.logger ?? defaultLogger();
  const register = opts.registerRuntime ?? registerToolRuntime;
  const unregister = opts.unregisterRuntime ?? unregisterToolRuntime;
  // 이 부팅이 «실제로 레지스트리에 넣은» id 들. 걷을 때 이 목록만 걷는다 —
  // 남이 넣은 동명 런타임을 지우면 그 축이 조용히 죽는다.
  const registeredIds: string[] = [];
  // A boot owns its ledger: same configured ids in concurrent/restarted boots
  // cannot inherit grants or revoke one another's authorization lifetime.
  const authorizer = createMcpToolAuthorizer();
  // FU3 (2026-05-13) — pipe McpClient lifecycle events into elanous's
  // keytrace logger so `mcp.client.spawn / .ready / .exit / .parse-error
  // / .stderr` all land in the daemon's debug log. Without this hook
  // the events landed on McpClient's default no-op logger, leaving zero
  // breadcrumbs when a child (e.g. xcrun mcpbridge) deadlocked elanous's
  // boot. The trace category prefix `mcp.client.boot.*` keeps these
  // distinct from any per-call instrumentation a future PR adds.
  const injectedValuesByServer = new Map<string, string[]>();
  const redactPluginValues = (text: string): string => {
    try {
      const root = elanousStateRoot();
      const current = [...new Set(listInstalledPlugins(root).map(item => item.name))]
        .flatMap(name => Object.values(pluginEnv(name, root)));
      return redactValues(text, [...current, ...injectedValuesByServer.values()].flat());
    } catch { return '[REDACTED]'; }
  };
  const bootLogger = (id: string) => (event: string, data?: Record<string, unknown>) => {
    try {
      const safe = data ? Object.fromEntries(Object.entries(data).map(([key, value]) =>
        [key, typeof value === 'string' ? redactPluginValues(value) : value])) : {};
      debug.log('mcp.client.boot', event, { id, ...safe });
    } catch { /* logger must never throw the boot */ }
  };
  // 이 부팅이 띄운 자식들. 지연 기동이면 «첫 도구 호출» 뒤에야 채워지고,
  // 프로세스가 그냥 죽는 경로(exit 훅)에서는 여기 남은 자식에 SIGTERM 을 쏜다.
  const spawnedChildren = new Set<ChildProcess>();
  const createClient =
    opts.createClient ??
    ((spec: McpServerSpec) => {
      if (spec.transport === 'http') return new McpClient({
        id: spec.id, url: spec.url, logger: bootLogger(spec.id),
        ...(spec.oauthIssuer ? { oauthIssuer: spec.oauthIssuer } : {}),
        ...(spec.oauthTokenEndpoint ? { oauthTokenEndpoint: spec.oauthTokenEndpoint } : {}),
        ...(spec.bearerTokenEnv ? { bearerTokenEnv: spec.bearerTokenEnv } : {}),
      });
      const root = elanousStateRoot();
      const installed = listInstalledPlugins(root);
      const owners = [...new Set(listNodeKinds('workflow').filter(entry =>
        !entry.core && entry.plugin && entry.run && 'mcp' in entry.run && entry.run.mcp.server === spec.id,
      ).map(entry => entry.plugin!))];
      const commandOwners = [...new Set(installed.filter(item => {
        const dir = realpathSync(item.path);
        return spec.command.some(arg => {
          if (typeof arg !== 'string' || !existsSync(arg)) return false;
          try { return realpathSync(resolve(arg)).startsWith(`${dir}${sep}`); }
          catch { return false; }
        });
      }).map(item => item.name))];
      const selected = commandOwners.length === 1 && owners.length === 1 && owners[0] === commandOwners[0]
        ? commandOwners[0] : undefined;
      return new McpClient({ id: spec.id, command: spec.command, logger: bootLogger(spec.id),
        // 지연 기동이면 정리 유예를 좁힌다 — classic 종료는 3초 안에 끝나야 한다.
        ...(opts.lazy === true ? { shutdownGraceMs: opts.lazyShutdownGraceMs ?? DEFAULT_LAZY_SHUTDOWN_GRACE_MS } : {}),
        spawn: (cmd, args) => {
          const declaredEnv = [...new Set(listInstalledPlugins(root).map(item => item.name))]
            .flatMap(name => credentialStatus(name, root).fields.map(field => field.env));
          const childEnv = { ...process.env };
          for (const key of declaredEnv) delete childEnv[key];
          injectedValuesByServer.delete(spec.id);
          if (selected) {
            const env = pluginEnv(selected, root);
            const fields = credentialStatus(selected, root).fields.filter(field => field.set).map(field => field.name);
            debug.log('plugin.credentials', 'injected', { plugin: selected, fields, count: fields.length });
            Object.assign(childEnv, env);
            injectedValuesByServer.set(spec.id, Object.values(env));
          }
          const child = nodeSpawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
          spawnedChildren.add(child);
          child.once('exit', () => { spawnedChildren.delete(child); });
          return child;
        },
      });
    });
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const setTimeoutFn = opts.setTimeoutFn
    ?? ((cb: () => void, ms: number) => {
      const h = setTimeout(cb, ms);
      h.unref?.(); // never keep the event loop alive on the timer alone
      return h as unknown as { unref?(): void };
    });
  const clearTimeoutFn = opts.clearTimeoutFn
    ?? ((handle: { unref?(): void }) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));

  const clients: McpClient[] = [];
  const perServer: Record<string, McpServerBootResult> = {};
  let registered = 0;

  // ── CLASSIC-IDLE-MCP-LAZY ────────────────────────────────────────────────
  // classic TUI 는 MCP 서버 둘(xcodebuildmcp · aside mcp)을 «기동 때» 띄워
  // 상주시켰다 — TUI 하나당 node⊕aside 자손 RSS 약 267MB, SIGTERM 3초 안에
  // 안 끝남(0.2.35 OP 실측). ⇒ `lazy` 면 자식은 «첫 도구 호출» 때 한 번 뜨고,
  // 그 전에 알리는 툴 «목록»은 지난 부팅이 적어 둔 인덱스 그대로다.
  const lazy = opts.lazy === true;
  const toolIndexStore = lazy ? (opts.toolIndexStore ?? defaultMcpToolIndexStore()) : undefined;
  const toolIndex: McpToolIndex = toolIndexStore ? readToolIndex(toolIndexStore) : {};
  const deferredClients: DeferredMcpClient[] = [];
  const lazyToolsFor = (serverId: string): McpTool[] | undefined => {
    if (!lazy) return undefined;
    const cached = toolIndex[serverId];
    return cached && cached.length > 0 ? cached : undefined;
  };
  const recordToolIndex = (serverId: string, tools: readonly McpTool[]): void => {
    if (!toolIndexStore) return;
    toolIndex[serverId] = [...tools];
    toolIndexStore.write(toolIndex);
  };
  const logLazyBoot = (
    serverId: string,
    reason: 'deferred' | 'first-call' | 'no-index',
    toolCount?: number,
  ): void => {
    try {
      debug.log('mcp.client', 'lazy-boot', {
        server: serverId,
        reason,
        ...(toolCount === undefined ? {} : { toolCount }),
      });
    } catch { /* logger must never throw the boot */ }
  };
  /** 허가 관문 보고 — 지연·즉시 두 경로가 «같은 문면»을 낸다. */
  const reportAuthorization = (serverId: string, tools: readonly { name: string }[]): void => {
    const grantedCount = tools.filter((t) => authorizer.isGranted(serverId, t.name)).length;
    if (tools.length > 0 && grantedCount === 0) {
      logger.warn(
        // ⛔ 접두 «라벨»도 같은 문자열이다 — 본문만 이스케이프하면 개행이 여기로 샌다.
        `[nexus] mcp-client ${JSON.stringify(serverId)}: ${tools.length} tool(s) registered but NONE authorized — every call will be denied. ` +
        // ⛔ 「복사해 붙일 수 있게」라고 말하려면 «붙일 수 있는 것»을 줘야 한다.
        //    ⇒ 서버 항목 «전체»를 흉내 내지 말고 ***더할 필드 한 줄***만 준다.
        `Add this field to the ${JSON.stringify(serverId)} entry of mcp.servers in your elanous config: ` +
        `"authorizedTools": [${tools.slice(0, 3).map((t) => JSON.stringify(t.name)).join(', ')}]`,
      );
    } else if (grantedCount < tools.length) {
      logger.warn(
        `[nexus] mcp-client ${JSON.stringify(serverId)}: ${tools.length} tool(s) registered but only ${grantedCount} authorized — unlisted tool calls will be denied.`,
      );
    }
    debug.log('mcp.authorization', 'boot-summary', {
      serverId,
      toolCount: tools.length,
      grantedCount,
    });
    logger.info(
      `[nexus] mcp-client connected: ${serverId} (${tools.length} tool${tools.length === 1 ? '' : 's'}` +
      `${grantedCount === tools.length ? '' : ` · ${grantedCount} authorized`})`,
    );
  };

  if (opts.servers.some(spec => spec.transport === 'stdio') && !opts.createClient) {
    try { syncInstalledPluginNodes(elanousStateRoot()); }
    catch (error) { debug.log('graph.kinds', 'installed-sync-failed', { reason: String(error) }); }
  }

  for (const spec of opts.servers) {
    const serverHandshakeTimeoutMs = spec.handshakeTimeoutMs ?? handshakeTimeoutMs;
    if (spec.enabled === false) {
      perServer[spec.id] = { status: 'disabled', toolCount: 0 };
      continue;
    }
    let client: McpClient | undefined;
    try {
      client = createClient(spec) as McpClient;
      if (!opts.createClient && spec.transport === 'stdio') {
        const originalCallTool = client.callTool.bind(client);
        client.callTool = async (name: string, args: Record<string, unknown>): Promise<McpToolCallResult> => {
          const values = injectedValuesByServer.get(spec.id) ?? [];
          try {
            const result = await originalCallTool(name, args);
            return maskInjectedValues(result, values) as McpToolCallResult;
          } catch (err) {
            if (err instanceof Error) err.message = redactValues(err.message, values);
            else throw new Error(redactValues(String(err), values));
            throw err;
          }
        };
      }
      const announced = lazyToolsFor(spec.id);
      if (lazy && !announced) logLazyBoot(spec.id, 'no-index');
      if (announced) {
        // ⭐ 지연 기동 — 여기서 자식은 «하나도» 안 뜬다. 허가는 즉시 경로와
        //    같은 관문에 미리 넣고, 등록하는 툴은 지난 부팅이 알린 목록 그대로다.
        for (const toolName of spec.authorizedTools ?? []) {
          authorizer.grant({ serverId: spec.id, toolName });
        }
        const deferred = new DeferredMcpClient(client, async () => {
          await withTimeout(`mcp.${spec.id}.start`, () => client!.start(), serverHandshakeTimeoutMs, setTimeoutFn, clearTimeoutFn);
          const live = await withTimeout(
            `mcp.${spec.id}.listTools`,
            () => client!.listTools(),
            serverHandshakeTimeoutMs,
            setTimeoutFn,
            clearTimeoutFn,
          );
          // 이제 자식이 있다 — 리소스 경로·종료 스냅샷이 보는 clients 에 넣는다.
          clients.push(client!);
          recordToolIndex(spec.id, live);
          logLazyBoot(spec.id, 'first-call', live.length);
        }, spec.id);
        deferredClients.push(deferred);
        for (const t of announced) {
          const runtime = createMcpProxyRuntime({
            serverId: spec.id,
            mcpTool: t,
            client: deferred,
            authorizer,
          });
          register(runtime);
          registeredIds.push(runtime.id);
          registered += 1;
        }
        perServer[spec.id] = { status: 'ready', toolCount: announced.length, deferred: true };
        reportAuthorization(spec.id, announced);
        logLazyBoot(spec.id, 'deferred', announced.length);
        continue;
      }
      await withTimeout(`mcp.${spec.id}.start`, () => client!.start(), serverHandshakeTimeoutMs, setTimeoutFn, clearTimeoutFn);
      const tools = await withTimeout(
        `mcp.${spec.id}.listTools`,
        () => client!.listTools(),
        serverHandshakeTimeoutMs,
        setTimeoutFn,
        clearTimeoutFn,
      );
      for (const toolName of spec.authorizedTools ?? []) {
        authorizer.grant({ serverId: spec.id, toolName });
      }
      for (const t of tools) {
        const runtime = createMcpProxyRuntime({
          serverId: spec.id,
          mcpTool: t,
          client,
          authorizer,
        });
        register(runtime);
        registeredIds.push(runtime.id);
        registered += 1;
      }
      clients.push(client);
      perServer[spec.id] = { status: 'ready', toolCount: tools.length };
      // 콜드 스타트(인덱스 없음) 1회 뒤에는 다음 부팅이 지연 기동할 수 있게 적어 둔다.
      if (lazy) recordToolIndex(spec.id, tools);
      // ⛔⭐ **금지에는 «길»을 붙인다.** 허가 관문은 fail-closed 라 `authorizedTools` 를
      //    안 적은 서버의 툴은 «전부» 거부된다 — 그것이 의도지만, 조용하면 사용자는
      //    ***「어제 되던 툴이 오늘 안 된다」***만 겪고 이유도 고치는 법도 모른다.
      //    ⇒ 붙었는데 허가가 «하나도 없는» 서버는 이름을 대고 «무엇을 적어야 하는지»까지 말한다.
      //    ⚠️ 부팅을 막지는 않는다 — 이 배선의 계약은 「한 서버가 실패해도 계속」이다.
      reportAuthorization(spec.id, tools);
    } catch (err) {
      // ⛔⭐ **이 줄은 「방어적 no-op」이 아니다.** try 블록이 등록 «루프»까지 감싸므로,
      //    툴 3개 중 2개까지 `register()` 가 성공한 뒤 3번째가 던지면 ***이미 등록된 두 개가
      //    레지스트리에 살아 있는 채로*** 이 서버가 실패로 판정된다. 그때 grant 를 안 걷으면
      //    「실패한 서버의 툴이 여전히 허가된 채 남는다」. ⇒ 그 상태를 무는 회귀가 테스트에 있다.
      authorizer.revokeServer(spec.id);
      // ⛔⭐ 위 주석이 「이미 등록된 두 개가 레지스트리에 살아 있는 채로」라고 «스스로»
      //    적어 놓고 grant «만» 걷었다. 그 런타임들은 프로세스가 죽을 때까지 남았고,
      //    다음 재장전이 그것과 id 충돌로 죽는다(2026-09-10 실측: 서버 5개 전부).
      //    ⇒ 이 서버 몫으로 «내가» 넣은 것만 골라 같이 걷는다.
      const prefix = `${spec.id}.`;
      for (let i = registeredIds.length - 1; i >= 0; i -= 1) {
        const id = registeredIds[i];
        if (id === undefined || !id.startsWith(prefix)) continue;
        try { unregister(id); } catch { /* 걷기 실패가 다음 서버를 막지 않는다 */ }
        registeredIds.splice(i, 1);
      }
      const msg = err instanceof Error ? err.message : String(err);
      const reasonClass = classifyMcpConnectFailure(err);
      const detail = redactPluginValues(redactSecretText(msg));
      perServer[spec.id] = { status: 'failed', toolCount: 0, reason: detail, reasonClass };
      try {
        debug.log('mcp.client.boot', 'connect-failed', { id: spec.id, reason: reasonClass, detail });
      } catch { /* logger must never throw the boot */ }
      logger.warn(`[nexus] mcp-client failed to start: ${spec.id} (${detail})`);
      if (msg.includes('-timeout after ')) {
        logger.warn(
          `[nexus] mcp-client ${spec.id} was excluded after its ${serverHandshakeTimeoutMs}ms handshake timeout; raise mcp.handshakeTimeoutMs or mcp.servers[].handshakeTimeoutMs, then run elanous mcp reload.`,
        );
      }
      // Dispose any partially-spawned child so a hanging stdin pipe
      // doesn't keep the event loop alive past NEXUS shutdown.
      if (client) {
        try { await client.dispose(); } catch { /* best-effort */ }
      }
      injectedValuesByServer.delete(spec.id);
    }
  }

  return {
    clients,
    registered,
    perServer,
    async shutdown() {
      // Snapshot + clear so a re-entrant call (e.g. SIGTERM races) is a no-op.
      const snapshot = clients.splice(0);
      // 아직 «안 뜬» 지연 클라이언트도 여기서 내린다 — 기동 중이면 그 기동을
      // 기다렸다가 내리므로 자식이 새지 않는다. 이미 뜬 것은 snapshot 이 맡는다.
      const pendingDeferred = deferredClients.splice(0).filter((d) => !d.spawned);
      // ⭐ 자식에게 SIGTERM 을 «먼저» 보낸다 — 유예(지연 기동 기본 2500ms)가 지나면
      //    SIGKILL 이라 종료 전체가 3초 안에 끝난다. 등록·허가 걷기는 그 뒤.
      const teardown = [
        ...snapshot.map((c) =>
          c.dispose().catch(() => {
            /* dispose() is best-effort; swallow */
          }),
        ),
        ...pendingDeferred.map((d) => d.dispose().catch(() => { /* 아직 안 뜬 클라이언트 */ })),
      ];
      for (const spec of opts.servers) authorizer.revokeServer(spec.id);
      // ⭐ 등록도 «되돌린다». 데몬 종료 때는 어차피 프로세스가 죽으니 무해하고,
      //    재장전 때는 ***이 줄이 없으면 다음 등록이 전부 id 충돌로 죽는다***.
      //    ⛔ 「shutdown 이 클라이언트만 내린다」는 이름과 어긋난 계약이었다.
      const ids = registeredIds.splice(0);
      for (const id of ids) {
        try { unregister(id); } catch { /* best-effort */ }
      }
      await Promise.all(teardown);
      injectedValuesByServer.clear();
    },
    terminateChildrenSync(): number {
      let signalled = 0;
      for (const child of [...spawnedChildren]) {
        spawnedChildren.delete(child);
        try {
          if (child.exitCode === null && child.signalCode === null && child.kill('SIGTERM')) signalled += 1;
        } catch {
          /* 이미 죽은 자식 — 쏠 대상이 없다 */
        }
      }
      return signalled;
    },
  };
}

/** 기본 툴 인덱스 저장소 — `<state>/mcp-tool-index.json`.
 *  ⚠️ 읽기·쓰기 모두 «부팅을 막지 않는다»: 깨진 JSON 은 빈 인덱스(콜드 스타트)로
 *  떨어지고, 쓰기 실패는 debug 한 줄만 남긴다. */
export function defaultMcpToolIndexStore(root: string = elanousStateRoot()): McpToolIndexStore {
  const file = join(root, MCP_TOOL_INDEX_FILENAME);
  return {
    read(): McpToolIndex {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const index: McpToolIndex = {};
        for (const [serverId, tools] of Object.entries(parsed as Record<string, unknown>)) {
          if (!Array.isArray(tools)) continue;
          const kept = tools.filter((tool): tool is McpTool =>
            !!tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string');
          if (kept.length > 0) index[serverId] = kept;
        }
        return index;
      } catch { return {}; }
    },
    write(index: McpToolIndex): void {
      try {
        mkdirSync(root, { recursive: true });
        writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
      } catch (error) {
        try { debug.log('mcp.client', 'tool-index-write-failed', { reason: String(error) }); }
        catch { /* logger must never throw the boot */ }
      }
    },
  };
}

function readToolIndex(store: McpToolIndexStore): McpToolIndex {
  try { return store.read(); } catch { return {}; }
}

function defaultLogger(): McpBootLogger {
  return {
    info: (line) => console.info(line),
    warn: (line) => console.warn(line),
  };
}

function redactValues(text: string, values: readonly string[]): string {
  return values.filter(value => value.length > 0)
    .reduce((safe, value) => safe.replaceAll(value, '[REDACTED]'), text);
}

/** Mask injected credential values anywhere in an MCP result — string values **and object keys**
 *  (a server can echo a secret back as a key, e.g. `structuredContent: { [secret]: "ok" }`). */
export function maskInjectedValues(value: unknown, values: readonly string[]): unknown {
  if (typeof value === 'string') return redactValues(value, values);
  if (Array.isArray(value)) return value.map(item => maskInjectedValues(item, values));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactValues(key, values), maskInjectedValues(item, values)]));
  }
  return value;
}
