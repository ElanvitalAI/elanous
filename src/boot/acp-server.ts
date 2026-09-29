// UI-Core arc Phase U4b Step 3 — ACP server boot entry.
//
// Handles the `elanous --acp-server` CLI flag: parses transport-
// selection args and wires the matching listener from
// `src/acp/transport/*` into `runAcpServer`. Stdio remains the
// default so the pre-U4b smoke paths keep working; unix-socket
// and websocket are opt-in via `--transport=X`.
//
// Flag shapes (all accept `--flag value` or `--flag=value`):
//   --transport=stdio|unix-socket|websocket   default: stdio
//   --socket-path=<path>                       unix-socket only
//   --port=<n>                                 websocket only
//   --host=<host>                              websocket only
//   --tool-cwd=<path>                          overrides ELANOUS_TOOL_CWD
//   --no-auth                                  websocket: skip token
//
// The boot wraps `runAcpServer` with a SIGINT/SIGTERM-aware shutdown
// signal so the process exits cleanly when the daemon is stopped by
// launchd / systemd / Ctrl-C.
//
// NOTE: the boot module deliberately lives outside `src/acp/` so
// it can import from `../acp/` without risking a circular import
// with the server itself. It also stays headless-guard-compliant —
// no dashboard, no tui-client — verified by the expanded guard
// test.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { dirname, join as joinPath } from 'node:path';

import {
  listenUnixSocket,
  listenWebSocket,
  generateAuthToken,
  createAuthVerifier,
} from '../acp/transport/index.js';
import { runAcpServer, type AcpServerOptions } from '../acp/server.js';
import type { LlmBrand } from '../llm-vision-capability.js';
import { DEFAULT_NEXUS_HTTP_PORT } from '../nexus/default-port.js';

export type AcpBootTransport = 'stdio' | 'unix-socket' | 'websocket';

export interface AcpBootOptions {
  transport: AcpBootTransport;
  /** For `unix-socket`: override the default path. */
  socketPath?: string;
  /** For `websocket`: bind port. */
  port?: number;
  /** For `websocket`: bind host. Defaults to `127.0.0.1`. */
  host?: string;
  /** For `websocket`: disable token auth (for Tailscale mesh or
   *  other pre-auth'd private transports). Default `false` →
   *  token check ON. */
  noAuth?: boolean;
  /** Optional ACP tool cwd fallback; overrides ELANOUS_TOOL_CWD when set. */
  toolCwd?: string;
}

/** Default socket path — XDG-ish; `~/.elanous/elanous.sock`. */
export function defaultUnixSocketPath(): string {
  return joinPath(getElanousConfigDir(), 'elanous.sock');
}

/** Default websocket bind port. Mnemonic: π × 10⁴. */
export const DEFAULT_WEBSOCKET_PORT = DEFAULT_NEXUS_HTTP_PORT;

/** Parse --flag / --flag=value / --flag value out of argv. Returns
 *  the value string or undefined. Exported for tests; the boot
 *  function below composes these into `AcpBootOptions`. */
export function readFlagValue(
  argv: readonly string[],
  flag: string,
): string | undefined {
  const prefix = `${flag}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === flag) return argv[i + 1];
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return undefined;
}

export function parseAcpBootArgs(argv: readonly string[]): AcpBootOptions {
  const transportRaw = readFlagValue(argv, '--transport') ?? 'stdio';
  if (
    transportRaw !== 'stdio' &&
    transportRaw !== 'unix-socket' &&
    transportRaw !== 'websocket'
  ) {
    throw new Error(
      `unknown --transport value: ${transportRaw} (expected stdio | unix-socket | websocket)`,
    );
  }
  const opts: AcpBootOptions = { transport: transportRaw };
  const socketPath = readFlagValue(argv, '--socket-path');
  if (socketPath) opts.socketPath = socketPath;
  const portRaw = readFlagValue(argv, '--port');
  if (portRaw !== undefined) {
    const parsed = Number(portRaw);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(`invalid --port: ${portRaw}`);
    }
    opts.port = parsed;
  }
  const host = readFlagValue(argv, '--host');
  if (host) opts.host = host;
  if (argv.includes('--no-auth')) opts.noAuth = true;
  const toolCwd = readFlagValue(argv, '--tool-cwd');
  if (toolCwd !== undefined) opts.toolCwd = toolCwd;
  return opts;
}

/** Load or mint a persistent auth token for websocket boot. Stored
 *  at `~/.elanous/acp-token` with 0600 perms so the socket-holding
 *  user can bind-mount it into a parent client config. */
function ensureAuthToken(): { token: string; path: string } {
  const tokenPath = joinPath(getElanousConfigDir(), 'acp-token');
  mkdirSync(dirname(tokenPath), { recursive: true });
  if (existsSync(tokenPath)) {
    return { token: readFileSync(tokenPath, 'utf-8').trim(), path: tokenPath };
  }
  const token = generateAuthToken();
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return { token, path: tokenPath };
}

/** Resolved daemon-runtime status surfaced in the startup banner.
 *  Matches the shape returned by `createDaemonRuntime()` so callers
 *  can spread it directly. Lets every transport (stdio / unix-socket
 *  / websocket) print a uniform `[elanous-acp] history: ...` +
 *  `[elanous-acp] tools: ...` line so the env-var resolution is visible
 *  even in stdio mode (where the pre-polish banner was completely
 *  silent). */
export interface BootRuntimeStatus {
  /** Resolved disk-backed history dir, or undefined for in-memory. */
  historyDir?: string;
  /** Active tool surface kind ('none' | 'readonly'). When omitted or
   *  'none', the banner says so + hints at ELANOUS_TOOLS=readonly. */
  tools?: string;
  /** Optional boot cwd fallback; session cwd takes precedence. */
  toolCwd?: string;
}

/** Write the runtime-status portion of the startup banner. Always
 *  emits two lines (history + tools) so the user can read off the
 *  env-var resolution at a glance, including the 'in-memory' /
 *  'tools: none' default case which hints at the env vars that flip
 *  them on. No-op when `runtimeStatus` is undefined (caller didn't
 *  resolve the daemon runtime — e.g. integration smoke tests that
 *  pass `runTurn` directly). */
function writeRuntimeBanner(
  stderr: { write: (s: string) => void },
  runtimeStatus?: BootRuntimeStatus,
): void {
  if (!runtimeStatus) return;
  if (runtimeStatus.historyDir) {
    stderr.write(`[elanous-acp] history: disk-backed at ${runtimeStatus.historyDir}\n`);
  } else {
    stderr.write(`[elanous-acp] history: in-memory (set ELANOUS_HISTORY_DIR for disk-backed)\n`);
  }
  const tools = runtimeStatus.tools;
  if (tools && tools !== 'none') {
    const cwdNote = runtimeStatus.toolCwd ? ` · cwd=${runtimeStatus.toolCwd}` : '';
    stderr.write(`[elanous-acp] tools: ${tools} (Read · Grep · WebSearch${cwdNote})\n`);
  } else {
    stderr.write(`[elanous-acp] tools: none (set ELANOUS_TOOLS=readonly for Read · Grep · WebSearch)\n`);
  }
}

/** Boot the ACP server with the requested transport. Awaits the
 *  server's long-running promise — the caller typically awaits
 *  this from the top of the CLI entry and lets it never resolve
 *  (SIGINT drops the process). */
export async function bootAcpServer(
  opts: AcpBootOptions,
  deps: {
    /** Test seam: override stderr for boot banner output. */
    stderr?: { write: (s: string) => void };
    /** Test seam: override the shutdown signal (by default the
     *  boot wires SIGINT/SIGTERM). */
    shutdownSignal?: AbortSignal;
    /** MVP M1.3 — server-side LLM dispatcher. When provided, real
     *  prompts run through the daemon (caller composes via
     *  `createDaemonRuntime` from `daemon-runtime.ts`). When omitted,
     *  the server keeps the pre-MVP echo behaviour — useful for
     *  integration smoke tests that don't hit a real model. */
    runTurn?: AcpServerOptions['runTurn'];
    /** M2.3 — server-wide session ledger probe. Used by the
     *  loadSession handler to validate incoming sessionIds. When
     *  omitted, every loadSession call returns "unknown session". */
    hasSession?: AcpServerOptions['hasSession'];
    /** MT5b polish — daemon-runtime resolution surfaced in the
     *  startup banner. Lets stdio mode visibly confirm
     *  ELANOUS_HISTORY_DIR / ELANOUS_TOOLS env-var resolution (without
     *  this, stdio printed nothing and users couldn't tell whether
     *  their env vars stuck). Pass the values returned by
     *  `createDaemonRuntime()`. */
    runtimeStatus?: BootRuntimeStatus;
    /** Selected LLM identity for the declaration returned by initialize(). */
    agentBrand?: LlmBrand;
    agentModel?: string;
    /** ⭐ logs.db 싱크 초기화 seam (2026-07-26 · 관측 갭 수리).
     *  생략 시 실 `registerStandaloneLogSink('acp')`. 테스트 주입용. */
    initializeLogSink?: () => Promise<void>;
  } = {},
): Promise<void> {
  // ⭐ 관측 갭 수리(2026-07-26) — ACP 서버는 nexus 데몬의 StoreSink 를 **상속하지 않는**
  //   별도 프로세스다. 등록 안 하면 이 프로세스의 debug.log(capability.resolve·
  //   daemon-tools.self-implement·tool-hydrated 등)가 파일 트레일에만 남고 logs.db 에 안
  //   닿아 `elanous logs` 로 조회 불가 = **관측 안 한 것**(제1원칙).
  //   `elanous agent` 가 #5441 로 고친 것과 **같은 계열**이며, 여기가 마지막 사각이었다.
  //   fail-open: 등록 실패가 서버 부팅을 막지 않는다(파일 트레일이 진실원).
  try {
    const init = deps.initializeLogSink
      ?? (async () => {
        const { registerStandaloneLogSink } = await import('../domains/standalone-log-sink.js');
        await registerStandaloneLogSink('acp');
      });
    await init();
  } catch (err) {
    // fail-open — 관측 등록 실패가 서버를 막지 않는다. 다만 **조용히 삼키면 안 된다**:
    // 이유를 안 남기면 "왜 logs 가 비나"를 영원히 못 밝힌다(관측 수리 안의 관측 갭).
    // logs.db 가 바로 그 실패 대상이므로 **파일 트레일**로 남긴다.
    try {
      const { debug } = await import('../debug/log.js');
      debug.log('acp.boot', 'log-sink-failed', {
        error: err instanceof Error ? err.message : String(err),
      }, { level: 'warn' });
    } catch { /* 트레일조차 못 쓰면 포기 — 서버는 계속 뜬다 */ }
  }
  const stderr = deps.stderr ?? process.stderr;
  const runTurn = deps.runTurn;
  const hasSession = deps.hasSession;
  const runtimeStatus = deps.runtimeStatus;
  const bootToolCwd = runtimeStatus?.toolCwd || opts.toolCwd?.trim() || process.env.ELANOUS_TOOL_CWD?.trim();
  const cwdPolicy = {
    requireSessionToolCwd: true,
    ...(bootToolCwd ? { bootToolCwd } : {}),
  };
  const declarationIdentity = {
    ...(deps.agentBrand !== undefined ? { agentBrand: deps.agentBrand } : {}),
    ...(deps.agentModel !== undefined ? { agentModel: deps.agentModel } : {}),
  };
  let ownSignal: AbortSignal | undefined = deps.shutdownSignal;
  let removeSignalHandlers: (() => void) | null = null;
  if (!ownSignal) {
    const ctrl = new AbortController();
    ownSignal = ctrl.signal;
    const onSig = (): void => { ctrl.abort(); };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
    removeSignalHandlers = () => {
      process.removeListener('SIGINT', onSig);
      process.removeListener('SIGTERM', onSig);
    };
  }

  try {
    if (opts.transport === 'stdio') {
      // Match the pre-U4b behaviour: no transportFactory → stdio.
      // shutdownSignal is a no-op for stdio mode (stdin close is
      // the natural lifecycle signal).
      //
      // MT5b polish — emit a startup banner so users can confirm the
      // process is alive and that env-var resolution stuck. Without
      // this, stdio printed 0 bytes and "blinking cursor" was the
      // only signal the server had started.
      stderr.write(`[elanous-acp] starting (transport: stdio)\n`);
      writeRuntimeBanner(stderr, runtimeStatus);
      await runAcpServer({
        shutdownSignal: ownSignal,
        ...(runTurn ? { runTurn } : {}),
        ...(hasSession ? { hasSession } : {}),
        ...cwdPolicy,
        ...declarationIdentity,
      });
      return;
    }

    if (opts.transport === 'unix-socket') {
      const socketPath = opts.socketPath ?? defaultUnixSocketPath();
      mkdirSync(dirname(socketPath), { recursive: true });
      stderr.write(`[elanous-acp] listening on unix socket: ${socketPath}\n`);
      writeRuntimeBanner(stderr, runtimeStatus);
      await runAcpServer({
        transportFactory: (onConnection) =>
          listenUnixSocket({ path: socketPath, onConnection }),
        shutdownSignal: ownSignal,
        ...(runTurn ? { runTurn } : {}),
        ...(hasSession ? { hasSession } : {}),
        ...cwdPolicy,
        ...declarationIdentity,
      });
      return;
    }

    // websocket
    const port = opts.port ?? DEFAULT_WEBSOCKET_PORT;
    const host = opts.host ?? '127.0.0.1';
    const authPieces =
      opts.noAuth
        ? { authVerifier: undefined as ReturnType<typeof createAuthVerifier> | undefined, banner: 'AUTH DISABLED' }
        : (() => {
            const { token, path } = ensureAuthToken();
            const verifier = createAuthVerifier([
              { token, issuedAt: Date.now(), label: 'default' },
            ]);
            return { authVerifier: verifier, banner: `auth token: ${token} (stored at ${path})` };
          })();
    stderr.write(`[elanous-acp] listening on ws://${host}:${port}/acp\n`);
    stderr.write(`[elanous-acp] ${authPieces.banner}\n`);
    writeRuntimeBanner(stderr, runtimeStatus);
    await runAcpServer({
      transportFactory: (onConnection) =>
        listenWebSocket({
          port,
          hostname: host,
          onConnection,
          ...(authPieces.authVerifier ? { authVerifier: authPieces.authVerifier } : {}),
        }),
      shutdownSignal: ownSignal,
      ...(runTurn ? { runTurn } : {}),
      ...(hasSession ? { hasSession } : {}),
      ...cwdPolicy,
      ...declarationIdentity,
    });
  } finally {
    removeSignalHandlers?.();
  }
}
