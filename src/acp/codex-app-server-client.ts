// Phase 3.B.1 foundation · `codex app-server` JSON-RPC v2 client.
//
// Minimal client that owns:
//   - newline-delimited JSON framing on a bidirectional stream
//   - pending-request map keyed by RequestId
//   - notification dispatch (server → client, no id)
//   - server-originated request handling (server → client with id)
//   - lifecycle (close · exit)
//
// The stream interface is abstract so tests can drive the client with
// synthetic Duplex streams. `spawnCodexAppServer()` is the production
// factory that shells out to `codex app-server`; an explicit remoteSocketPath
// opts the ACP agent into the shadow side-tab socket without changing stdio defaults.

import { spawn as spawnChild, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createConnection } from 'node:net';
import { PassThrough } from 'node:stream';
import { resolvePreferredCodexBinary } from './codex-auth.js';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { debug } from '../debug/log.js';
import {
  CodexAppServerError,
  type IncomingMessage,
  type JsonRpcErrorBody,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RequestId,
  isNotification,
  isRequest,
  isResponse,
} from './codex-app-server-proto.js';

// ─── Public surface ─────────────────────────────────────────────────

/** Options for constructing a client from an existing stream pair.
 *  Tests drive this directly with a mock Duplex; production code uses
 *  the `spawnCodexAppServer()` factory which hands us the child's
 *  stdio streams. */
export interface CodexAppServerClientOpts {
  stdin: Writable;
  stdout: Readable;
  /** Optional — observed for log forwarding but not parsed. */
  stderr?: Readable;
  /** Request timeout · default 60s · null disables. */
  requestTimeoutMs?: number | null;
  /** Called when the stream emits an error or parse fails. Default: debug log. */
  onParseError?: (err: Error, raw: string) => void;
  /** Stdin drain timeout · default 5s · 0 / negative disables.
   *
   *  M5 (2026-04-28) — when a stdin.write returns false (kernel/process
   *  buffer full) we await the next 'drain' event before emitting the
   *  next message. Without this, large agent_message_chunk streams can
   *  pile up in user-space memory because Node never blocks the JS
   *  thread on a full pipe. The timeout protects against a wedged
   *  child that never drains. */
  drainTimeoutMs?: number;
}

export type NotificationListener = (params: unknown) => void;
export type ServerRequestHandler = (params: unknown) => Promise<unknown>;
export type ErrorListener = (err: Error) => void;
export type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

// ─── Client ────────────────────────────────────────────────────────

export class CodexAppServerClient {
  private readonly stdin: Writable;
  private readonly stdout: Readable;
  private readonly stderr?: Readable;
  private readonly rl: ReadlineInterface;
  private readonly requestTimeoutMs: number | null;
  private readonly onParseError: (err: Error, raw: string) => void;

  private nextRequestId = 1;
  private readonly pending = new Map<
    RequestId,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timeoutHandle?: ReturnType<typeof setTimeout>;
    }
  >();

  private readonly notificationListeners = new Map<string, Set<NotificationListener>>();
  private readonly serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly exitListeners = new Set<ExitListener>();

  private closed = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;

  // M5 (2026-04-28) — serialized stdin write chain. Each `writeMessage`
  // appends to `writeChain`; the chain awaits drain when the underlying
  // stream signals backpressure. The chain catches its own rejections so
  // it never gets poisoned — individual writers still see their own
  // success/failure result.
  private writeChain: Promise<void> = Promise.resolve();
  private readonly drainTimeoutMs: number;

  // M6 (2026-04-28) — daemon idle hibernate observability. Bumped on
  // every outbound write + every inbound message. The agent owns the
  // hibernate policy (poll via `getIdleAgeMs()` from a setInterval); the
  // client only exposes the activity timestamp so different lifecycle
  // managers can plug different policies on top of the same primitive.
  private lastUsedAt: number = Date.now();

  constructor(opts: CodexAppServerClientOpts) {
    this.stdin = opts.stdin;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.requestTimeoutMs =
      opts.requestTimeoutMs === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : opts.requestTimeoutMs;
    this.drainTimeoutMs =
      opts.drainTimeoutMs === undefined ? DEFAULT_DRAIN_TIMEOUT_MS : opts.drainTimeoutMs;
    this.onParseError =
      opts.onParseError ??
      ((err, raw) => debug.log('acp.cxn.appserver', 'parse-error', { message: err.message, raw }, { level: 'error' }));

    this.rl = createInterface({ input: this.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.handleLine(line));
    this.stdout.on('error', (err) => this.emitError(err));
    this.stdin.on('error', (err) => this.emitError(err));
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  /** Reject all pending · clear listeners · release stdin. Safe to call
   *  more than once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rl.close();
    for (const entry of this.pending.values()) {
      if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
      entry.reject(new Error('codex app-server client closed'));
    }
    this.pending.clear();
    this.notificationListeners.clear();
    this.serverRequestHandlers.clear();
    try {
      this.stdin.end();
    } catch {
      /* ignore */
    }
  }

  // ─── Outbound request · typed ────────────────────────────────────

  /** Send a JSON-RPC request and await the response. Rejects with
   *  `CodexAppServerError` on server error, `Error('timeout')` if
   *  `requestTimeoutMs` elapses, `Error('client closed')` on shutdown. */
  async request<TParams, TResult>(method: string, params: TParams): Promise<TResult> {
    if (this.closed) {
      throw new Error('codex app-server client closed');
    }
    const id = this.allocateRequestId();
    const payload: JsonRpcRequest<TParams> = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };
    return new Promise<TResult>((resolve, reject) => {
      const timeoutHandle =
        this.requestTimeoutMs !== null
          ? setTimeout(() => {
              if (this.pending.delete(id)) {
                reject(new Error(`codex app-server request "${method}" timed out`));
              }
            }, this.requestTimeoutMs)
          : undefined;
      this.pending.set(id, {
        resolve: (v) => resolve(v as TResult),
        reject,
        timeoutHandle,
      });
      // M5 — writeMessage is async (drain-aware). Failures bubble up
      // via the returned promise; we cancel the pending entry and
      // reject the request promise on write failure.
      this.writeMessage(payload).catch((err) => {
        if (this.pending.delete(id) && timeoutHandle) clearTimeout(timeoutHandle);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** Fire-and-forget notification (client → server). M5 — write
   *  failures (drain timeout / closed stream) surface through the
   *  error listener rather than throwing synchronously. */
  notify<TParams>(method: string, params: TParams): void {
    if (this.closed) return;
    const payload: JsonRpcNotification<TParams> = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.writeMessage(payload).catch((err) => {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  // ─── Inbound listeners ───────────────────────────────────────────

  /** Subscribe to a notification by method. Returns unsubscribe. */
  onNotification(method: string, cb: NotificationListener): () => void {
    let set = this.notificationListeners.get(method);
    if (!set) {
      set = new Set();
      this.notificationListeners.set(method, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
      if (set && set.size === 0) this.notificationListeners.delete(method);
    };
  }

  /** Register a handler for a server-originated request method. Only
   *  one handler per method; subsequent registration replaces the
   *  previous and the returned disposer only removes this one. */
  setServerRequestHandler(method: string, handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.set(method, handler);
    return () => {
      if (this.serverRequestHandlers.get(method) === handler) {
        this.serverRequestHandlers.delete(method);
      }
    };
  }

  onError(cb: ErrorListener): () => void {
    this.errorListeners.add(cb);
    return () => void this.errorListeners.delete(cb);
  }

  onExit(cb: ExitListener): () => void {
    this.exitListeners.add(cb);
    // If the child already exited before subscription, fire once.
    if (this.closed && (this.exitCode !== null || this.exitSignal !== null)) {
      queueMicrotask(() => cb(this.exitCode, this.exitSignal));
    }
    return () => void this.exitListeners.delete(cb);
  }

  // ─── M6 · idle observability ─────────────────────────────────────

  /** Milliseconds since the last outbound write OR inbound message.
   *  The agent polls this from a setInterval to enforce the configured
   *  idle hibernate timeout. We expose just the age (not a "should I
   *  hibernate?" decision) so different lifecycle managers can layer
   *  different policies (e.g. memory-pressure, restart-on-update) on
   *  top of the same primitive. */
  getIdleAgeMs(): number {
    return Math.max(0, Date.now() - this.lastUsedAt);
  }

  /** Most recent activity timestamp. Useful for tests + diagnostics. */
  getLastUsedAt(): number {
    return this.lastUsedAt;
  }

  // ─── Internal · framing + dispatch ───────────────────────────────

  /** Serialise stdin writes through `writeChain` so concurrent callers
   *  never interleave on a single newline-delimited stream and any
   *  caller's `false` return from `stdin.write` parks the chain on the
   *  next `'drain'` event before the next message goes out.
   *
   *  The chain catches its own errors so a failed write doesn't poison
   *  subsequent writes — each caller still sees their own success or
   *  failure via the returned promise. M5 (2026-04-28). */
  private writeMessage(msg: unknown): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('codex app-server client closed'));
    }
    const myWrite = this.writeChain
      .catch(() => undefined)
      .then(() => this.doWrite(msg));
    // Shared chain swallows errors so the next writer always proceeds.
    this.writeChain = myWrite.catch(() => undefined);
    return myWrite;
  }

  private async doWrite(msg: unknown): Promise<void> {
    this.lastUsedAt = Date.now();
    const line = JSON.stringify(msg) + '\n';
    const ok = this.stdin.write(line, 'utf8');
    if (!ok) {
      debug.log('acp.cxn.appserver', 'stdin-backpressure', { phase: 'await-drain' });
      await this.waitForDrain();
    }
  }

  /** Park until the writable signals 'drain'. Reject after
   *  `drainTimeoutMs` to surface a wedged child rather than letting
   *  the write chain hang forever. */
  private waitForDrain(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onDrain = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer =
        this.drainTimeoutMs > 0
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              this.stdin.off('drain', onDrain);
              reject(
                new Error(
                  `codex app-server stdin drain timeout after ${this.drainTimeoutMs}ms`,
                ),
              );
            }, this.drainTimeoutMs)
          : (undefined as unknown as ReturnType<typeof setTimeout>);
      this.stdin.once('drain', onDrain);
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: IncomingMessage;
    try {
      parsed = JSON.parse(line) as IncomingMessage;
    } catch (err) {
      this.onParseError(err as Error, line);
      return;
    }
    // M6 — bump activity stamp on every inbound message so idle
    // hibernate doesn't fire while the server is actively streaming.
    this.lastUsedAt = Date.now();
    if (isResponse(parsed)) {
      this.routeResponse(parsed);
    } else if (isRequest(parsed)) {
      void this.routeServerRequest(parsed);
    } else if (isNotification(parsed)) {
      this.routeNotification(parsed);
    } else {
      debug.log('acp.cxn.appserver', 'unknown-message', { type: typeof parsed, raw: line });
    }
  }

  private routeResponse(resp: JsonRpcResponse): void {
    const entry = this.pending.get(resp.id);
    if (!entry) {
      debug.log('acp.cxn.appserver', 'orphan-response', { id: resp.id });
      return;
    }
    this.pending.delete(resp.id);
    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
    if (resp.error) {
      entry.reject(new CodexAppServerError(resp.error));
    } else {
      entry.resolve(resp.result);
    }
  }

  private async routeServerRequest(req: JsonRpcRequest): Promise<void> {
    const handler = this.serverRequestHandlers.get(req.method);
    if (!handler) {
      this.replyError(req.id, {
        code: -32601,
        message: `Method not found: ${req.method}`,
      });
      return;
    }
    try {
      const result = await handler(req.params);
      this.replyResult(req.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.replyError(req.id, {
        code: -32603,
        message,
      });
    }
  }

  private routeNotification(notif: JsonRpcNotification): void {
    const listeners = this.notificationListeners.get(notif.method);
    if (!listeners || listeners.size === 0) return;
    for (const cb of listeners) {
      try {
        cb(notif.params);
      } catch (err) {
        debug.log('acp.cxn.appserver', 'notification-listener-throw', {
          method: notif.method,
          message: (err as Error).message,
        });
      }
    }
  }

  private replyResult(id: RequestId, result: unknown): void {
    this.writeMessage({ jsonrpc: '2.0', id, result }).catch((err) => {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private replyError(id: RequestId, error: JsonRpcErrorBody): void {
    this.writeMessage({ jsonrpc: '2.0', id, error }).catch((err) => {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private allocateRequestId(): RequestId {
    return `m-${this.nextRequestId++}`;
  }

  private emitError(err: Error): void {
    for (const cb of this.errorListeners) {
      try {
        cb(err);
      } catch {
        /* swallow · error listener throws are not re-entrant */
      }
    }
  }

  /** Test + factory seam · fires the exit pipeline. */
  _markExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.exitSignal = signal;
    for (const entry of this.pending.values()) {
      if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
      entry.reject(new Error(`codex app-server exited (code=${code} signal=${signal})`));
    }
    this.pending.clear();
    for (const cb of this.exitListeners) {
      try {
        cb(code, signal);
      } catch {
        /* swallow */
      }
    }
    this.closed = true;
  }

  /** Reject only requests sent over a disconnected transport; the socket
   *  factory may reconnect, so the client itself remains usable. */
  _markDisconnected(error: Error): void {
    for (const entry of this.pending.values()) {
      if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

// ─── Factory · spawn real codex binary ──────────────────────────────

export interface SpawnCodexAppServerOpts {
  /** Binary path · default `codex` (resolved on PATH). */
  codexBinary?: string;
  /** Subcommand args · default `['app-server']`. */
  codexArgs?: readonly string[];
  /** Explicit opt-in endpoint for Codex remote side-tab mode. */
  remoteSocketPath?: string;
  /** Env vars merged onto current env · e.g. `CODEX_API_KEY`.
   *  ⛔⭐ 계약: 넘긴 값이 «이기고» 나머지 부모 env 는 «보존»된다. 그리고 이 병합은
   *  `process.env` 를 «안 바꾼다» — 계정별 쿼터 측정(`usage --account`)이 여기에 걸려 있다. */
  env?: Record<string, string>;
  /** ⛔ 테스트 심 — 위 env 병합 계약을 무는 유일한 방법이다. 프로덕션은 항상 기본값. */
  spawnImpl?: typeof spawnChild;
  /** Working directory for the child · default current. */
  cwd?: string;
  /** Forwarded to `CodexAppServerClientOpts`. */
  requestTimeoutMs?: number | null;
}

export interface SpawnedCodexAppServer {
  readonly client: CodexAppServerClient;
  readonly child: ChildProcessWithoutNullStreams;
}

function createUnixSocketStreams(socketPath: string, onDisconnect: (error: Error) => void): {
  stdin: PassThrough;
  stdout: PassThrough;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let closed = false;
  let activeSocket: ReturnType<typeof createConnection> | undefined;
  let activeSocketError: ((error: Error) => void) | undefined;
  let activeSocketClose: (() => void) | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connect: () => void = () => {};
  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, 100);
    reconnectTimer.unref();
  };
  const retireSocket = (
    socket: ReturnType<typeof createConnection>,
    error: Error | undefined,
    notifyClient: boolean,
  ): void => {
    if (activeSocket !== socket) return;
    activeSocket = undefined;
    // A destroyed destination stays registered with PassThrough.pipe unless
    // explicitly detached. Leaving it there makes the next request write to
    // the dead socket as well as the replacement socket.
    stdin.unpipe(socket);
    socket.unpipe(stdout);
    if (activeSocketError) socket.removeListener('error', activeSocketError);
    if (activeSocketClose) socket.removeListener('close', activeSocketClose);
    activeSocketError = undefined;
    activeSocketClose = undefined;
    socket.destroy();
    if (notifyClient) onDisconnect(error ?? new Error('codex app-server socket disconnected'));
    else scheduleReconnect(); // Initial late startup retries; reconnect after a live transport is deferred.
  };
  connect = (): void => {
    if (closed) return;
    const socket = createConnection(socketPath);
    let didConnect = false;
    activeSocket = socket;
    const onSocketError = (error: Error): void => retireSocket(socket, error, didConnect);
    const onSocketClose = (): void => retireSocket(socket, undefined, didConnect);
    activeSocketError = onSocketError;
    activeSocketClose = onSocketClose;
    socket.on('error', onSocketError);
    socket.once('close', onSocketClose);
    socket.once('connect', () => {
      if (closed || activeSocket !== socket) {
        socket.destroy();
        return;
      }
      didConnect = true;
      stdin.pipe(socket);
      // Keep the client-facing readable open across reconnects.
      socket.pipe(stdout, { end: false });
    });
  };
  stdin.once('close', () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    if (activeSocket) retireSocket(activeSocket, undefined, false);
    stdout.end();
  });
  connect();
  return { stdin, stdout };
}


/** Build the argv for `codex app-server`, always FORCING codex's
 *  `code_mode_host` feature OFF.
 *
 *  Why non-optional: codex 0.144.0's tool router spawns a separate
 *  `codex-code-mode-host` binary (looked up next to the codex binary /
 *  `CODEX_CODE_MODE_HOST_PATH`), but the single-binary Homebrew cask does
 *  NOT ship that host — so every file/shell tool fails with
 *  `failed to spawn code-mode host … No such file or directory`. Disabling
 *  the `code_mode_host` feature makes the router fall back to standard,
 *  host-less tool execution (verified: `-c features.code_mode_host=false`
 *  passes `--strict-config` AND actually creates files, whereas the broader
 *  `features.code_mode=false` is a valid key that does NOT stop the host
 *  spawn). Injected for EVERY elanous-driven spawn so `/cdx` never depends on
 *  the user's `~/.codex/config.toml`. */
export function buildCodexAppServerArgs(codexArgs?: readonly string[]): string[] {
  const supplied = codexArgs ?? [];
  const args = supplied[0] === 'app-server'
    ? [...supplied]
    : ['app-server', ...supplied];
  args.push('-c', 'features.code_mode_host=false');
  return args;
}

/** Build both command lines for the opt-in Codex remote shadow surface.
 *  The default app-server factory remains stdio-backed; callers must
 *  explicitly select these arguments to expose a Unix-domain endpoint. */
export function buildCodexRemoteSideTabArgs(socketPath: string): {
  appServerArgs: string[];
  remoteTuiArgs: string[];
} {
  if (!socketPath.trim()) throw new Error('socket path is required');
  const endpoint = `unix://${socketPath}`;
  return {
    appServerArgs: ['app-server', '--listen', endpoint, '-c', 'features.code_mode_host=false'],
    remoteTuiArgs: ['--remote', endpoint],
  };
}

/** Spawn options for the shadow mode; absent socketPath preserves stdio. */
export function buildCodexAppServerSpawnArgs(opts: {
  codexArgs?: readonly string[];
  remoteSocketPath?: string;
}): string[] {
  const args = buildCodexAppServerArgs(opts.codexArgs);
  if (!opts.remoteSocketPath) return args;
  if (args.some((arg) => arg === '--listen' || arg.startsWith('--listen='))) {
    throw new Error('remote socket path conflicts with codexArgs --listen');
  }
  const endpoint = `unix://${opts.remoteSocketPath}`;
  return [...args.slice(0, -2), '--listen', endpoint, ...args.slice(-2)];
}

export function spawnCodexRemoteTui(opts: {
  codexBinary: string;
  socketPath: string;
  cwd?: string;
  env?: Record<string, string>;
  spawnImpl?: typeof spawnChild;
}): ChildProcess {
  const spawnFn = opts.spawnImpl ?? spawnChild;
  return spawnFn(opts.codexBinary, buildCodexRemoteSideTabArgs(opts.socketPath).remoteTuiArgs, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: 'inherit',
  });
}

/** Spawn the `codex app-server` binary and wrap its stdio or explicit
 *  Unix-socket connection in a client. The ACP agent manager selects the
 *  socket form only when the Codex remote side-tab opt-in is configured. */
export function spawnCodexAppServer(
  opts: SpawnCodexAppServerOpts = {},
): SpawnedCodexAppServer {
  // Default to the NEWEST codex binary, not bare `codex` — the daemon's
  // PATH prepends node_modules/.bin where a stale bundled copy can shadow
  // the user's upgraded system install, making the backend reject newer
  // models ("requires a newer version of Codex"). See
  // resolvePreferredCodexBinary.
  const binary = opts.codexBinary ?? resolvePreferredCodexBinary();
  const args = buildCodexAppServerSpawnArgs({
    codexArgs: opts.codexArgs,
    remoteSocketPath: opts.remoteSocketPath,
  });
  // ⛔⭐ 테스트 심 — env 병합 «계약»(넘긴 값이 이기고 나머지 부모 env 는 보존)을 무는 유일한 방법이다.
  //   계정별 쿼터 측정이 이 병합에 걸려 있고, 여기가 틀리면 「B 를 재려다 A 를 잰다」가 된다.
  const spawnFn = opts.spawnImpl ?? spawnChild;
  const child = spawnFn(binary, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Remote mode speaks over the Unix socket, leaving the app-server child's
  // stdout disconnected. Drain it so a verbose child cannot fill the pipe.
  if (opts.remoteSocketPath) child.stdout.resume();
  let client: CodexAppServerClient | undefined;
  const socketStreams = opts.remoteSocketPath
    ? createUnixSocketStreams(opts.remoteSocketPath, (error) => client?._markDisconnected(error))
    : undefined;
  client = new CodexAppServerClient({
    stdin: socketStreams?.stdin ?? child.stdin,
    stdout: socketStreams?.stdout ?? child.stdout,
    stderr: child.stderr,
    requestTimeoutMs: opts.requestTimeoutMs,
  });
  child.on('exit', (code, signal) => {
    client._markExit(code, signal);
  });
  child.on('error', (err) => {
    // Spawn error (binary not found etc.) — surface via error listeners.
    // We rely on onError; markExit follows via 'exit' if emitted.
    for (const cb of (client as unknown as { errorListeners: Set<ErrorListener> })
      .errorListeners) {
      try {
        cb(err);
      } catch {
        /* ignore */
      }
    }
  });
  return { client: client!, child };
}
