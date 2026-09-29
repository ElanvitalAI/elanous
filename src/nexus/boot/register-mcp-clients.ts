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
import { McpClient, McpConnectionError } from '../../mcp/client.js';
import {
  createMcpProxyRuntime,
  createMcpToolAuthorizer,
} from '../../mcp/proxy-runtime.js';
import { registerToolRuntime, unregisterToolRuntime } from '../../tool-runtime/registry.js';
import { debug, redactSecretText } from '../../debug/log.js';

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
}

export interface McpServerBootResult {
  /** 'ready' = handshake + listTools succeeded, tools registered.
   *  'disabled' = enabled:false in user-config.
   *  'failed' = spawn/handshake/listTools threw; client never registered. */
  status: 'ready' | 'disabled' | 'failed';
  /** Number of tools registered from this server. 0 unless status=='ready'. */
  toolCount: number;
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
}

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
  const bootLogger = (id: string) => (event: string, data?: Record<string, unknown>) => {
    try {
      debug.log('mcp.client.boot', event, { id, ...(data ?? {}) });
    } catch { /* logger must never throw the boot */ }
  };
  const createClient =
    opts.createClient ??
    ((spec: McpServerSpec) =>
      spec.transport === 'http'
        ? new McpClient({
            id: spec.id,
            url: spec.url,
            logger: bootLogger(spec.id),
            ...(spec.oauthIssuer ? { oauthIssuer: spec.oauthIssuer } : {}),
            ...(spec.oauthTokenEndpoint ? { oauthTokenEndpoint: spec.oauthTokenEndpoint } : {}),
            ...(spec.bearerTokenEnv ? { bearerTokenEnv: spec.bearerTokenEnv } : {}),
          })
        : new McpClient({ id: spec.id, command: spec.command, logger: bootLogger(spec.id) }));
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

  for (const spec of opts.servers) {
    const serverHandshakeTimeoutMs = spec.handshakeTimeoutMs ?? handshakeTimeoutMs;
    if (spec.enabled === false) {
      perServer[spec.id] = { status: 'disabled', toolCount: 0 };
      continue;
    }
    let client: McpClient | undefined;
    try {
      client = createClient(spec) as McpClient;
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
      // ⛔⭐ **금지에는 «길»을 붙인다.** 허가 관문은 fail-closed 라 `authorizedTools` 를
      //    안 적은 서버의 툴은 «전부» 거부된다 — 그것이 의도지만, 조용하면 사용자는
      //    ***「어제 되던 툴이 오늘 안 된다」***만 겪고 이유도 고치는 법도 모른다.
      //    ⇒ 붙었는데 허가가 «하나도 없는» 서버는 이름을 대고 «무엇을 적어야 하는지»까지 말한다.
      //    ⚠️ 부팅을 막지는 않는다 — 이 배선의 계약은 「한 서버가 실패해도 계속」이다.
      const grantedCount = tools.filter((t) => authorizer.isGranted(spec.id, t.name)).length;
      if (tools.length > 0 && grantedCount === 0) {
        logger.warn(
          // ⛔ 접두 «라벨»도 같은 문자열이다 — 본문만 이스케이프하면 개행이 여기로 샌다.
          `[nexus] mcp-client ${JSON.stringify(spec.id)}: ${tools.length} tool(s) registered but NONE authorized — every call will be denied. ` +
          // ⛔ 「복사해 붙일 수 있게」라고 말하려면 «붙일 수 있는 것»을 줘야 한다.
          //    초판은 `{"id":…, ..., "authorizedTools":[…]}` 를 줬는데 그 `...` 때문에
          //    «유효한 JSON 이 아니었다» — 말과 산출이 어긋났다(리뷰가 잡음).
          //    ⇒ 서버 항목 «전체»를 흉내 내지 말고 ***더할 필드 한 줄***만 준다.
          `Add this field to the ${JSON.stringify(spec.id)} entry of mcp.servers in your elanous config: ` +
          `"authorizedTools": [${tools.slice(0, 3).map((t) => JSON.stringify(t.name)).join(', ')}]`,
        );
      } else if (grantedCount < tools.length) {
        logger.warn(
          `[nexus] mcp-client ${JSON.stringify(spec.id)}: ${tools.length} tool(s) registered but only ${grantedCount} authorized — unlisted tool calls will be denied.`,
        );
      }
      debug.log('mcp.authorization', 'boot-summary', {
        serverId: spec.id,
        toolCount: tools.length,
        grantedCount,
      });
      logger.info(
        `[nexus] mcp-client connected: ${spec.id} (${tools.length} tool${tools.length === 1 ? '' : 's'}` +
        `${grantedCount === tools.length ? '' : ` · ${grantedCount} authorized`})`,
      );
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
      const detail = redactSecretText(msg);
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
    }
  }

  return {
    clients,
    registered,
    perServer,
    async shutdown() {
      // Snapshot + clear so a re-entrant call (e.g. SIGTERM races) is a no-op.
      const snapshot = clients.splice(0);
      for (const spec of opts.servers) authorizer.revokeServer(spec.id);
      // ⭐ 등록도 «되돌린다». 데몬 종료 때는 어차피 프로세스가 죽으니 무해하고,
      //    재장전 때는 ***이 줄이 없으면 다음 등록이 전부 id 충돌로 죽는다***.
      //    ⛔ 「shutdown 이 클라이언트만 내린다」는 이름과 어긋난 계약이었다.
      const ids = registeredIds.splice(0);
      for (const id of ids) {
        try { unregister(id); } catch { /* best-effort */ }
      }
      await Promise.all(
        snapshot.map((c) =>
          c.dispose().catch(() => {
            /* dispose() is best-effort; swallow */
          }),
        ),
      );
    },
  };
}

function defaultLogger(): McpBootLogger {
  return {
    info: (line) => console.info(line),
    warn: (line) => console.warn(line),
  };
}
