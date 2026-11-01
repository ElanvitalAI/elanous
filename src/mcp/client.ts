// ── Minimal MCP client (Track NEXUS · B-track Phase 1 + HTTP) ──
//
// Counterpart of `src/mcp/server.ts`. Speaks the narrow JSON-RPC 2.0
// subset that proxy ToolRuntimes need:
//
//   initialize           → handshake (we are the client)
//   tools/list           → enumerate remote tools
//   tools/call           → dispatch one tool
//   notifications/*      → fire-and-forget
//
// Transports:
//   • stdio — spawn a child, line-delimited JSON-RPC (one object per
//     line). Matches the framing the server speaks in `server.ts`.
//   • http  — POST the same JSON-RPC objects to a URL (Streamable HTTP).
//     Hand-rolled rather than `@modelcontextprotocol/sdk`: this file
//     already speaks the subset, and the SDK would only duplicate
//     initialize / tools/list / tools/call to add POST.
//
// Design notes:
//   • spawn is injected (DI) so tests can supply a fake ChildProcess
//     without forking real binaries.
//   • request id → pending promise map for correlation. The server
//     side is single-threaded JSON-RPC so we never see id reuse.
//   • Reconnect backoff is data-driven (`reconnectBackoffMs: number[]`)
//     and halts cleanly once exhausted — surfaces via `logger` hook
//     so the boot wire (Phase 2) can emit a single user-visible
//     notification on halt without this layer caring about UI.
//   • dispose() is graceful: SIGTERM, wait `shutdownGraceMs`, then
//     SIGKILL. NEXUS shutdown hooks call this; the worst case is
//     that the child wedged and we kill it after the grace window.

import { spawn as nodeSpawn } from 'node:child_process';
import { MCP_PROTOCOL_VERSION_LATEST } from './server.js';
import { MCP_APP_HTML_MIME } from '../tool-runtime/mcp-app-mime.js';
import {
  recoverAccessToken,
  getValidAccessToken,
  McpOAuthError,
  type AuthorizeHandler,
  type McpOAuthFetch,
} from './mcp-oauth.js';

// ─── Public types ────────────────────────────────────────────────

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  /** Server-supplied metadata, including tool-to-resource links. */
  _meta?: Record<string, unknown>;
  /** Preserve extension fields supplied by the MCP server. */
  [key: string]: unknown;
}

/** A server-advertised MCP resource. Extension fields, including `_meta`, are preserved. */
export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One text or base64-encoded binary resource content entry. */
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Raw `resources/list` page shape; `nextCursor` is consumed by `listResources()`. */
export interface McpResourceListPage {
  resources: McpResource[];
  nextCursor?: string;
  [key: string]: unknown;
}

/** `resources/read` result, retaining every returned content entry. */
export interface McpResourceReadResult {
  contents: McpResourceContent[];
  [key: string]: unknown;
}

export interface McpToolCallContent {
  type: string;
  text?: string;
  [k: string]: unknown;
}

/** Per-call MCP metadata. `elanousRunId` is only a correlation key. */
export interface McpCallMeta extends Record<string, unknown> {
  elanousRunId?: string;
}

/** The remote server answered with a JSON-RPC `error` envelope.
 *
 *  ⛔⭐ **「서버가 안 된다고 했다」와 「서버에 못 닿았다」는 다른 값이다.**
 *  `callTool()` 은 둘 다 «던져서» 알리는데, 던진 것만 보면 구분이 안 된다 —
 *  그래서 호출자가 전부 전송 오류로 뭉갠다(실제로 그런 회귀가 났다).
 *  ⇒ 이 타입이 그 갈림을 «문면 매칭이 아니라 타입»으로 준다.
 *
 *  ⚠️ `message` 문면은 종전 그대로다(`MCP error <code>: <msg>`) — 그 문자열을
 *  보고 있던 자리가 안 깨진다. */
export class McpServerError extends Error {
  /** JSON-RPC error code the server sent. */
  readonly code: number;
  constructor(code: number, message: string) {
    super(`MCP error ${code}: ${message}`);
    this.name = 'McpServerError';
    this.code = code;
  }
}

/** Why an address-based MCP attach failed. Three values, three next actions. */
export type McpConnectionFailureReason = 'auth-required' | 'unreachable' | 'not-mcp';

export interface McpConnectionErrorInit {
  wwwAuthenticate?: string;
  resourceMetadata?: string;
  scope?: string;
  detail?: string;
}

/** Structured attach failure — not a JSON-RPC `error` envelope.
 *
 *  ⓐ auth-required — the peer answered 401; retrying will not help.
 *  ⓑ unreachable  — no HTTP response (network / timeout / TLS).
 *  ⓒ not-mcp      — something answered, but it is not MCP JSON-RPC. */
export class McpConnectionError extends Error {
  readonly reason: McpConnectionFailureReason;
  readonly wwwAuthenticate?: string;
  readonly resourceMetadata?: string;
  readonly scope?: string;
  readonly detail?: string;
  constructor(
    reason: McpConnectionFailureReason,
    message: string,
    init: McpConnectionErrorInit = {},
  ) {
    super(message);
    this.name = 'McpConnectionError';
    this.reason = reason;
    this.wwwAuthenticate = init.wwwAuthenticate;
    this.resourceMetadata = init.resourceMetadata;
    this.scope = init.scope;
    this.detail = init.detail;
  }
}

const MAX_RETRY_AFTER_MS = 60_000;
const HTTP_DATE = /^(?:[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Z][a-z]{2} [A-Z][a-z]{2} (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4})$/;
const retryAfterDelays = new WeakMap<McpConnectionError, number>();

function parseRetryAfterMs(header: string | null, now = Date.now()): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  const delay = /^\d+$/.test(value)
    ? Number(value) * 1000
    : HTTP_DATE.test(value)
      ? Date.parse(value) - now
      : Number.NaN;
  if (!Number.isFinite(delay) || delay > MAX_RETRY_AFTER_MS) return undefined;
  return Math.max(0, delay);
}

/** ⛔⭐ **다시 걸어도 «부수효과가 없는» 메서드.** `tools/call` 은 여기 «없다» —
 *  5xx 가 「받고 못 처리」인지 「못 받음」인지 우리가 못 가르므로, 다시 걸면
 *  돈을 쓰는 툴을 두 번 부를 수 있다. */
export const IDEMPOTENT_MCP_METHODS: ReadonlySet<string> = new Set([
  'initialize', 'tools/list', 'resources/list', 'resources/read', 'ping',
]);

export function isRetryableMcpConnectionFailure(err: unknown): boolean {
  return err instanceof McpConnectionError && err.reason === 'unreachable';
}

/** Pull resource_metadata / scope out of a WWW-Authenticate challenge
 *  without throwing on malformed input. The raw header is preserved
 *  separately so guidance can show what the server actually sent. */
export function parseWwwAuthenticate(header: string): {
  resourceMetadata?: string;
  scope?: string;
} {
  const out: { resourceMetadata?: string; scope?: string } = {};
  const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header))) {
    const key = m[1]!.toLowerCase();
    const val = m[2] ?? m[3];
    if (!val) continue;
    if (key === 'resource_metadata') out.resourceMetadata = val;
    else if (key === 'scope') out.scope = val;
  }
  return out;
}

export function formatMcpConnectionGuidance(err: McpConnectionError): string {
  switch (err.reason) {
    case 'auth-required':
      return err.wwwAuthenticate
        ? `authentication required — server sent WWW-Authenticate: ${err.wwwAuthenticate}`
        : 'authentication required — the server asked for credentials';
    case 'unreachable':
      return err.detail
        ? `address unreachable — could not connect to ${err.detail}; check the URL and that the host is up`
        : 'address unreachable — could not connect; check the URL and that the host is up';
    case 'not-mcp':
      return err.detail
        ? `not an MCP endpoint — ${err.detail}`
        : 'not an MCP endpoint — the address responded but the body is not MCP JSON-RPC';
  }
}

export function classifyMcpNetworkError(err: unknown, detail?: string): McpConnectionError {
  if (err instanceof McpConnectionError) return err;
  return new McpConnectionError(
    'unreachable',
    formatMcpConnectionGuidance(
      new McpConnectionError('unreachable', '', { detail }),
    ),
    { detail },
  );
}

export function classifyMcpHttpResponse(opts: {
  status: number;
  contentType?: string | null;
  bodyText: string;
  wwwAuthenticate?: string | null;
  detail?: string;
  hadBearer?: boolean;
  credentialRecoveryAttempted?: boolean;
}): McpConnectionError | null {
  const { status, bodyText } = opts;
  const wwwAuthenticate = opts.wwwAuthenticate?.trim() || undefined;
  if (status === 401) {
    const parsed = wwwAuthenticate ? parseWwwAuthenticate(wwwAuthenticate) : {};
    const err = new McpConnectionError('auth-required', '', {
      wwwAuthenticate,
      resourceMetadata: parsed.resourceMetadata,
      scope: parsed.scope,
      detail: opts.detail,
    });
    return new McpConnectionError('auth-required', formatMcpConnectionGuidance(err), {
      wwwAuthenticate: err.wwwAuthenticate,
      resourceMetadata: err.resourceMetadata,
      scope: err.scope,
      detail: err.detail,
    });
  }
  if (status < 200 || status >= 300) {
    const detail = opts.detail
      ? `HTTP ${status} from ${opts.detail}`
      : `HTTP ${status}`;
    // ⛔⭐ **「응답이 왔다」와 「거긴 MCP 가 아니다」는 다른 문장이다.**
    //    5xx 는 상대가 «일시적으로» 못 받는 상태이고, 429 는 «지금은» 안 된다는 말이다.
    //    둘 다 ***다시 걸면 될 수 있다*** — 그런데 `not-mcp` 로 분류하면
    //    `isRetryableMcpConnectionFailure` 가 거짓을 내어 ***영영 재시도되지 않는다.***
    //    ⇒ 이 골의 계약(「닿지 못한 것·시간이 넘은 것은 다시 시도」)과 정면으로 어긋난다.
    //    ⚠️ 반면 다른 4xx(404 경로 오류 · 400 잘못된 요청)는 다시 걸어도 같은 답이라 `not-mcp` 다.
    const forbiddenRationale = status === 403
      ? opts.hadBearer === undefined
        ? '403 with unknown credential state; treating as transient'
        : !opts.hadBearer
          ? '403 without Bearer credentials; treating as transient'
          : opts.credentialRecoveryAttempted === undefined
            ? '403 with Bearer credentials and unknown recovery state; treating as transient'
            : opts.credentialRecoveryAttempted
              ? '403 after Bearer recovery; treating as transient'
              : '403 with Bearer credentials; attempting credential recovery'
      : undefined;
    const transient = status >= 500 || status === 429 || status === 403;
    const reason = transient ? 'unreachable' : 'not-mcp';
    const err = new McpConnectionError(reason, '', {
      detail: forbiddenRationale ? `${detail}; ${forbiddenRationale}` : detail,
    });
    return new McpConnectionError(reason, formatMcpConnectionGuidance(err), { detail: err.detail });
  }
  const ct = (opts.contentType ?? '').toLowerCase();
  if (ct.includes('text/html')) {
    const detail = 'the address responded with HTML, not MCP JSON-RPC';
    const err = new McpConnectionError('not-mcp', '', { detail });
    return new McpConnectionError('not-mcp', formatMcpConnectionGuidance(err), { detail });
  }
  if (!bodyText.trim()) return null;
  if (ct.includes('text/event-stream') || ct.includes('application/json') || ct.includes('json')) {
    return null;
  }
  // 2xx with a body that is neither JSON nor SSE — not MCP.
  const looksJson = bodyText.trimStart().startsWith('{') || bodyText.trimStart().startsWith('[');
  if (!looksJson && !bodyText.includes('data:')) {
    const detail = 'the address responded but the body is not MCP JSON-RPC';
    const err = new McpConnectionError('not-mcp', '', { detail });
    return new McpConnectionError('not-mcp', formatMcpConnectionGuidance(err), { detail });
  }
  return null;
}

function abortError(): Error {
  const err = new Error('timeout');
  err.name = 'AbortError';
  return err;
}

async function raceAbort<T>(op: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  let onAbort: (() => void) | undefined;
  const abortP = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([op, abortP]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function nextSseEvent(buf: string): { event: string; rest: string } | null {
  const lf = buf.indexOf('\n\n');
  const crlf = buf.indexOf('\r\n\r\n');
  let idx = -1;
  let sepLen = 0;
  if (lf >= 0 && (crlf < 0 || lf <= crlf)) {
    idx = lf;
    sepLen = 2;
  } else if (crlf >= 0) {
    idx = crlf;
    sepLen = 4;
  }
  if (idx < 0) return null;
  return { event: buf.slice(0, idx), rest: buf.slice(idx + sepLen) };
}

function sseDataPayload(event: string): string | undefined {
  const dataLines: string[] = [];
  for (const raw of event.split(/\r?\n/)) {
    if (!raw.startsWith('data:')) continue;
    const after = raw.slice(5);
    dataLines.push(after.startsWith(' ') ? after.slice(1) : after);
  }
  if (dataLines.length === 0) return undefined;
  const payload = dataLines.join('\n');
  if (!payload || payload === '[DONE]') return undefined;
  return payload;
}

function ssePayloadMatchesId(payload: string, expectedId: number): boolean {
  try {
    const msg = JSON.parse(payload) as { id?: unknown };
    return Boolean(msg && typeof msg === 'object' && !Array.isArray(msg) && msg.id === expectedId);
  } catch {
    return false;
  }
}

function takeMatchingSseEvent(
  buf: string,
  expectedId: number,
): { payload?: string; rest: string } {
  let rest = buf;
  for (;;) {
    const next = nextSseEvent(rest);
    if (!next) return { rest };
    rest = next.rest;
    const payload = sseDataPayload(next.event);
    if (payload && ssePayloadMatchesId(payload, expectedId)) {
      return { payload, rest };
    }
  }
}

function extractSseJsonRpcById(
  body: string,
  expectedId: number,
  notMcp: (detail: string) => Error,
): string {
  const padded =
    body.endsWith('\n\n') || body.endsWith('\r\n\r\n') ? body : `${body}\n\n`;
  const taken = takeMatchingSseEvent(padded, expectedId);
  if (!taken.payload) {
    throw notMcp('SSE body had no matching JSON-RPC response');
  }
  return taken.payload;
}

async function readSseJsonRpcFromStream(
  stream: ReadableStream<Uint8Array>,
  expectedId: number,
  signal: AbortSignal,
  notMcp: (detail: string) => Error,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const cancelReader = (): void => {
    void reader.cancel().catch(() => {});
  };
  if (signal.aborted) {
    cancelReader();
    throw abortError();
  }
  signal.addEventListener('abort', cancelReader, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw abortError();
      const { done, value } = await raceAbort(reader.read(), signal);
      if (value && value.byteLength > 0) {
        buf += decoder.decode(value, { stream: !done });
      }
      const taken = takeMatchingSseEvent(buf, expectedId);
      buf = taken.rest;
      if (taken.payload) {
        cancelReader();
        return taken.payload;
      }
      if (done) {
        buf += decoder.decode();
        const last = takeMatchingSseEvent(
          buf.endsWith('\n\n') || buf.endsWith('\r\n\r\n') ? buf : `${buf}\n\n`,
          expectedId,
        );
        if (last.payload) return last.payload;
        throw notMcp('SSE stream ended without a matching JSON-RPC response');
      }
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    try {
      reader.releaseLock();
    } catch {
      /* cancelled or already released */
    }
  }
}

export interface McpToolCallResult {
  content?: McpToolCallContent[];
  structuredContent?: unknown;
  /** Server-supplied MCP metadata retained for downstream renderers. */
  _meta?: unknown;
  isError?: boolean;
}

export interface ChildProcessLike {
  stdin: { write(line: string): void } | null;
  stdout: {
    on(event: 'data', cb: (chunk: Buffer | string) => void): void;
  } | null;
  /** 2026-05-13 — exposed for FU3 deep trace. McpClient drains stderr
   *  so a chatty child (banner / progress / warning) does not fill the
   *  64KiB OS pipe buffer and deadlock its main loop. Optional in the
   *  test seam — a fake spawn may omit it. */
  stderr?: {
    on(event: 'data', cb: (chunk: Buffer | string) => void): void;
  } | null;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): boolean;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void;
  pid?: number;
}

export type McpClientLogger = (
  event: string,
  data?: Record<string, unknown>,
) => void;

export type McpHttpFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}>;

export interface McpClientOpts {
  /** Stable id (e.g. 'xcode'). Used as the proxy tool prefix and in
   *  every logger event so the boot wire can route by server. */
  id: string;
  /** Argv to spawn (e.g. ['xcrun', 'mcpbridge']). Required for stdio;
   *  omit (or leave empty) when `url` is set. */
  command?: string[];
  /** Address-based Streamable HTTP endpoint. When set, stdio spawn is
   *  skipped and JSON-RPC is POSTed here. */
  url?: string;
  /** Spawn factory — defaults to `node:child_process.spawn`. Injected
   *  by tests. Unused on the HTTP path. */
  spawn?: (cmd: string, args: string[]) => ChildProcessLike;
  /** Fetch factory — defaults to global `fetch`. Injected by tests. */
  fetch?: McpHttpFetch;
  /** Boundary instrumentation hook. Defaults to no-op so a tight
   *  loop doesn't pay for absent listeners. */
  logger?: McpClientLogger;
  /** Reconnect backoff schedule in ms. Default [1000, 5000, 30000].
   *  Empty array disables reconnect (one-shot client). HTTP uses the
   *  same schedule, but only for `unreachable` — auth-required and
   *  not-mcp never retry. */
  reconnectBackoffMs?: number[];
  /** Grace window before SIGKILL on dispose(). Default 5000 ms. */
  shutdownGraceMs?: number;
  /** Per-request HTTP timeout in ms. Default 8000. */
  httpTimeoutMs?: number;
  /** Timer factory (DI for tests — fake clocks). */
  setTimer?: (cb: () => void, ms: number) => { cancel(): void };
  /** Browser-boundary callback — receives the assembled authorize URL
   *  and returns code+state. Omitted: 401 recovery can still reuse or
   *  refresh a stored issuer token, but cannot start a new login. */
  authorize?: AuthorizeHandler;
  /** Fetch used for OAuth discovery / registration / token calls.
   *  Defaults to global `fetch` so MCP transport mocks do not have to
   *  answer metadata URLs, and an open 401 body cannot stall OAuth. */
  oauthFetch?: McpOAuthFetch;
  /** Explicit oauth/store.ts path. Defaults to `<effectiveInstanceRoot()>/auth.json`. */
  oauthStorePath?: string;
  /** Redirect URI advertised during registration and authorization. */
  oauthRedirectUri?: string;
  /** Known authorization-server issuer — storage key for a reusable token. */
  oauthIssuer?: string;
  /** Token endpoint for the known issuer (refresh-before-send). */
  oauthTokenEndpoint?: string;
  /** Environment-variable name containing a static HTTP Bearer token fallback. */
  bearerTokenEnv?: string;
}

// ─── Internal shapes ─────────────────────────────────────────────

const CLIENT_INFO = { name: 'elanous-agent', version: '0.1.0' };
/** MCP Apps 확장(SEP-1865 · Final)을 «우리가 실제로 하는 만큼» 선언한다.
 *
 *  ⛔⭐ `mimeTypes` 는 스펙이 «필수»로 요구한다 — 빈 객체로 선언하면
 *  「지원한다」고 말해 놓고 «무엇을 그릴 수 있는지»를 안 말하는 셈이다.
 *  📏 실측(2026-08-20 · mcp.higgsfield.ai): 상대가 내주는 화면의 형식 표기가
 *  정확히 `text/html;profile=mcp-app` 이다.
 *  ⛔ 여기 없는 형식은 «그릴 수 없다» — 늘리려면 그리는 자를 먼저 만든다. */
const MCP_APP_CAPABILITIES = {
  extensions: {
    // ⛔⭐ 이 값을 여기 «베끼지» 않는다 — 읽는 쪽(PWA 파서)과 같은 집에서 가져온다.
    //   2026-08-21: 베낀 문자열과 읽는 쪽의 비교가 어긋나 임베드 본문이 영영 안 쓰였다.
    'io.modelcontextprotocol/ui': { mimeTypes: [MCP_APP_HTML_MIME] },
  },
};

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** ⚠️ 이름이 `Response` 지만 «들어오는 줄 전부»가 이 모양으로 파싱된다 —
 *  서버가 «자기 쪽에서 시작한 요청»(`elicitation/create` · `sampling/createMessage` ·
 *  `roots/list`)을 보내면 그것도 여기로 온다. 그래서 `method` 를 «선택»으로 둔다:
 *  ⛔ 그 칸이 없으면 「응답인지 요청인지」를 가를 수가 없고, 실제로 못 갈라서
 *  ***서버 요청이 조용히 버려지고 있었다***(그 서버는 영원히 기다린다). */
interface JsonRpcInbound {
  jsonrpc: '2.0';
  id?: number | string | null;
  /** 있으면 «서버가 시작한 요청»이다. 없으면 우리 요청에 대한 응답. */
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

export type McpClientState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'reconnecting'
  | 'disposed'
  | 'halted';

// ─── Client ──────────────────────────────────────────────────────

/** MCP client. One instance is either a stdio child or an HTTP
 *  address — never both. Construct → `await start()` → use
 *  `listTools()` / `callTool()` → `await dispose()`. */
/** How a request's bearer was obtained. ⛔ Carries no token value. */
export type McpBearerSource =
  | { kind: 'none' }
  | { kind: 'oauth'; issuer?: string }
  | { kind: 'static'; envName: string; oauthConfiguredButUnavailable: boolean };

export class McpClient {
  private readonly opts: {
    id: string;
    command: string[];
    url?: string;
    spawn: (cmd: string, args: string[]) => ChildProcessLike;
    fetch: McpHttpFetch;
    logger: McpClientLogger;
    reconnectBackoffMs: number[];
    shutdownGraceMs: number;
    httpTimeoutMs: number;
    setTimer: (cb: () => void, ms: number) => { cancel(): void };
    authorize?: AuthorizeHandler;
    oauthFetch?: McpOAuthFetch;
    oauthStorePath?: string;
    oauthRedirectUri?: string;
    bearerTokenEnv?: string;
  };
  /** Issuer learned from RFC 9728 discovery — storage key for this connection. */
  private oauthIssuer: string | null = null;
  private oauthTokenEndpoint: string | null = null;
  /** Why the last 401 recovery gave up — carried onto the surfaced error so the
   *  caller learns the cause instead of a bare `auth-required`. */
  private oauthRecoveryFailure: string | null = null;
  private child: ChildProcessLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private state: McpClientState = 'idle';
  private reconnectAttempt = 0;
  private pendingTimer: { cancel(): void } | null = null;
  /** Each HTTP retry wait owns a separate cancellation handle. */
  private readonly pendingRetrySleeps = new Map<
    { cancel(): void },
    () => void
  >();
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  /** Every in-flight HTTP POST — dispose() must abort the whole set, not a single slot. */
  private readonly httpAborts = new Set<AbortController>();
  /** HTTP start() request count — tests observe retry vs no-retry. */
  httpRequestCount = 0;

  constructor(opts: McpClientOpts) {
    const url = typeof opts.url === 'string' ? opts.url.trim() : '';
    const command = opts.command ?? [];
    if (url) {
      // HTTP path — command is unused.
    } else if (command.length === 0) {
      throw new Error(`McpClient(${opts.id}): empty command`);
    }
    this.opts = {
      id: opts.id,
      command,
      url: url || undefined,
      spawn:
        opts.spawn ??
        ((cmd, args) =>
          nodeSpawn(cmd, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
          }) as unknown as ChildProcessLike),
      fetch: opts.fetch ?? ((u, init) => fetch(u, init)),
      logger: opts.logger ?? (() => {}),
      reconnectBackoffMs: opts.reconnectBackoffMs ?? [1000, 5000, 30000],
      shutdownGraceMs: opts.shutdownGraceMs ?? 5000,
      httpTimeoutMs: opts.httpTimeoutMs ?? 8000,
      setTimer:
        opts.setTimer ??
        ((cb, ms) => {
          const t = setTimeout(cb, ms);
          // Node sometimes returns a Timeout object with .unref — call when present.
          (t as unknown as { unref?: () => void }).unref?.();
          return { cancel: () => clearTimeout(t) };
        }),
      authorize: opts.authorize,
      oauthFetch: opts.oauthFetch,
      oauthStorePath: opts.oauthStorePath,
      oauthRedirectUri: opts.oauthRedirectUri,
      bearerTokenEnv: opts.bearerTokenEnv?.trim() || undefined,
    };
    this.oauthIssuer = opts.oauthIssuer?.trim() || null;
    this.oauthTokenEndpoint = opts.oauthTokenEndpoint?.trim() || null;
  }

  // ─── Public accessors ──────────────────────────────────────────

  get serverId(): string {
    return this.opts.id;
  }
  get currentState(): McpClientState {
    return this.state;
  }
  get isReady(): boolean {
    return this.state === 'ready';
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  /** Spawn the child (or POST to the URL) + complete the initialize
   *  handshake. Throws if the peer never answers. HTTP retries
   *  unreachable/timeouts using `reconnectBackoffMs`; auth-required
   *  and not-mcp fail immediately. */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`McpClient(${this.opts.id}).start: invalid state '${this.state}'`);
    }
    this.state = 'starting';
    try {
      if (this.opts.url) {
        await this.httpStartWithRetry();
      } else {
        await this.spawnAndHandshake();
      }
    } catch (err) {
      this.state = 'idle';
      throw err;
    }
  }

  /** Send `tools/list`. Must be called after a successful start(). */
  async listTools(): Promise<McpTool[]> {
    this.requireReady('listTools');
    const result = (await this.send('tools/list', {})) as { tools?: McpTool[] };
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  /** Send `resources/list` through every cursor page. Server errors are propagated. */
  async listResources(): Promise<McpResource[]> {
    this.requireReady('listResources');
    const resources: McpResource[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.send(
        'resources/list',
        cursor === undefined ? {} : { cursor },
      )) as Partial<McpResourceListPage>;
      if (Array.isArray(result?.resources)) resources.push(...result.resources);
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined;
    } while (cursor !== undefined);
    return resources;
  }

  /** Send `resources/read`, preserving text/blob variants and all content entries. */
  async readResource(uri: string): Promise<McpResourceReadResult> {
    this.requireReady('readResource');
    const result = (await this.send('resources/read', { uri })) as Partial<McpResourceReadResult>;
    return {
      ...result,
      contents: Array.isArray(result?.contents) ? result.contents : [],
    };
  }

  /** Send `tools/call`. The remote may return an error object — that
  *  is surfaced as a rejected promise so callers can branch with
  *  try/catch the same way as transport errors. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: McpCallMeta,
  ): Promise<McpToolCallResult> {
    this.requireReady('callTool');
    const result = (await this.send('tools/call', {
      name,
      arguments: args,
      ...(meta && Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    })) as McpToolCallResult;
    return result;
  }

  /** Graceful shutdown. Stdio: SIGTERM, wait `shutdownGraceMs`, then
   *  SIGKILL. HTTP: abort in-flight POSTs. Pending requests are
   *  rejected. Idempotent — safe to call multiple times. After
   *  dispose() the client is terminal: start() will throw. */
  async dispose(): Promise<void> {
    if (this.state === 'disposed') return;
    const child = this.child;
    this.state = 'disposed';
    if (this.pendingTimer) {
      this.pendingTimer.cancel();
      this.pendingTimer = null;
    }
    for (const [timer, settle] of [...this.pendingRetrySleeps]) {
      timer.cancel();
      settle();
    }
    this.pendingRetrySleeps.clear();
    this.rejectAllPending(
      new Error(`McpClient(${this.opts.id}): disposed`),
    );
    for (const controller of this.httpAborts) {
      try {
        controller.abort();
      } catch {
        /* already aborted */
      }
    }
    this.httpAborts.clear();
    this.sessionId = null;
    this.protocolVersion = null;
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    await new Promise<void>((resolve) => {
      const timer = this.opts.setTimer(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
        resolve();
      }, this.opts.shutdownGraceMs);
      child.on('exit', () => {
        timer.cancel();
        resolve();
      });
    });
    this.child = null;
  }

  // ─── Internals ────────────────────────────────────────────────

  private requireReady(method: string): void {
    if (this.state !== 'ready') {
      throw new Error(
        `McpClient(${this.opts.id}).${method}: not ready (state=${this.state})`,
      );
    }
  }

  private async spawnAndHandshake(): Promise<void> {
    const [cmd, ...args] = this.opts.command;
    if (!cmd) {
      throw new Error(`McpClient(${this.opts.id}): empty command`);
    }
    this.opts.logger('mcp.client.spawn', {
      id: this.opts.id,
      cmd,
      args,
    });
    const child = this.opts.spawn(cmd, args);
    this.child = child;
    this.buffer = '';
    if (child.stdout) {
      child.stdout.on('data', (chunk) => this.onStdoutData(chunk));
    }
    // 2026-05-13 — drain stderr explicitly. Before this listener, a
    // child that wrote a banner/warning/progress line to stderr would
    // fill the OS pipe buffer (typ. 64KiB), causing its next
    // `stderr.write()` to block. If that write was on the main event
    // loop (which it is for most CLI binaries), the child stopped
    // servicing stdin too — the JSON-RPC `initialize` reply never
    // shipped and `McpClient.start()` waited forever. PR #2527
    // bounded the wait; this listener removes the root cause for
    // chatty children (xcrun mcpbridge / xcodebuildmcp / …).
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        // Emit one event per non-empty line so the keytrace tail
        // shows what the child is whining about. Line-buffering is
        // intentional — multi-line tracebacks remain one trace event.
        for (const raw of text.split('\n')) {
          const line = raw.trim();
          if (!line) continue;
          this.opts.logger('mcp.client.stderr', { id: this.opts.id, line: line.slice(0, 400) });
        }
      });
    }
    child.on('exit', (code, signal) => this.onExit(code, signal));
    // Handshake — initialize request.
    await this.send('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION_LATEST,
      capabilities: MCP_APP_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    });
    // Per spec, send notifications/initialized (no id, fire-and-forget).
    this.writeRaw(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    );
    this.state = 'ready';
    this.reconnectAttempt = 0;
    this.opts.logger('mcp.client.ready', { id: this.opts.id });
  }

  private async send(
    method: string,
    params: Record<string, unknown>,
    retryContext?: {
      forbiddenRecoveryAttempted: boolean;
      forbiddenRejectedAfterRecovery: boolean;
    },
  ): Promise<unknown> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    if (this.opts.url) {
      // ⛔⭐⭐ **재시도는 «멱등한» 메서드에만 붙인다.**
      //    5xx 는 「받고 못 처리했다」일 수도 「못 받았다」일 수도 있다 — 우리는 못 가른다.
      //    그래서 `tools/call` 을 다시 걸면 ***크레딧을 태우는 툴을 두 번 부를 수 있다.***
      //    ⇒ 조회 계열(initialize · tools/list · ping)만 다시 건다.
      //    ⚠️ 초판은 `initialize` 를 감싼 손 맞추기 «전체»만 재시도했고, 그 뒤의
      //       `tools/list` 는 5xx 를 만나면 «한 번 만에» 실패했다(리뷰 must-fix).
      // ⛔⭐⭐ **재시도 «소유자»는 하나여야 한다.** 손 맞추기가 이미 `httpRetry` 로 감싸져
      //    있는데 그 «안»의 `initialize` 가 또 재시도하면 백오프가 «곱해진다» —
      //    🧪 실측: 3칸 백오프 · 영구 503 에서 요청이 4회가 아니라 ***16회*** 나갔다.
      //    ⇒ 손 맞추기 «중»에는 요청 단위 재시도를 끈다.
      return IDEMPOTENT_MCP_METHODS.has(method) && !this.handshakeOwnsRetry
        ? this.httpRetry((retryContext) => this.httpRoundTrip(req, retryContext), method)
        : this.httpRoundTrip(req, retryContext);
    }
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.writeRaw(JSON.stringify(req));
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private writeRaw(line: string): void {
    if (!this.child?.stdin) {
      throw new Error(`McpClient(${this.opts.id}): no stdin`);
    }
    this.child.stdin.write(line + '\n');
  }

  private replyMethodNotFound(id: number | string | null, method: string): void {
    const reply = JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `method not found: ${method}` },
    });
    const sent = this.opts.url
      ? this.httpPost(reply, { expectResult: false })
      : Promise.resolve().then(() => this.writeRaw(reply));
    void sent.then(
      () => this.opts.logger('mcp.client.server-request-replied', {
        id: this.opts.id,
        method,
        requestId: id,
      }),
      (err) => this.opts.logger('mcp.client.server-request-reply-failed', {
        id: this.opts.id,
        method,
        requestId: id,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  /** 손 맞추기가 재시도를 «소유»하는 동안 참. 요청 단위 재시도는 이때 꺼진다. */
  private handshakeOwnsRetry = false;

  private async httpStartWithRetry(): Promise<void> {
    this.handshakeOwnsRetry = true;
    try {
      await this.httpRetry((retryContext) => this.httpHandshake(retryContext), 'handshake');
    } finally {
      this.handshakeOwnsRetry = false;
    }
  }

  /** 재시도 «가능»한 실패에만 백오프를 태운다. 같은 사다리를 손 맞추기와
   *  멱등 요청이 «공유»한다 — 한쪽만 재시도하면 그 갈림이 조용히 생긴다. */
  private async httpRetry<T>(
    run: (retryContext: {
      forbiddenRecoveryAttempted: boolean;
      forbiddenRejectedAfterRecovery: boolean;
    }) => Promise<T>,
    what: string,
  ): Promise<T> {
    const retryContext = {
      forbiddenRecoveryAttempted: false,
      forbiddenRejectedAfterRecovery: false,
    };
    const backoff = this.opts.reconnectBackoffMs;
    let attempt = 0;
    for (;;) {
      // ⛔⭐⭐ 이 칸은 «이번 시도»의 결과만 담아야 한다.
      //    안 지우면 앞선 403 의 흔적이 체인에 «영구히» 남아,
      //    `403 → 갱신 → 403 → 재시도 → 503` 의 «최종» 503 까지
      //    `auth-required` 로 뒤집는다 — 5xx·429 를 다시 걸게 두겠다는
      //    이 착지의 계약과 정면으로 어긋난다(리뷰 must-fix).
      //    ⇒ 변환은 «최종 실패가 403일 때»만 일어난다.
      retryContext.forbiddenRejectedAfterRecovery = false;
      try {
        return await run(retryContext);
      } catch (err) {
        if (!isRetryableMcpConnectionFailure(err) || attempt >= backoff.length) {
          if (retryContext.forbiddenRejectedAfterRecovery && err instanceof McpConnectionError) {
            throw this.forbiddenAfterRecoveryAuthError(err);
          }
          throw err;
        }
        const fallbackDelay = backoff[attempt] ?? 0;
        const retryAfterMs = err instanceof McpConnectionError ? retryAfterDelays.get(err) : undefined;
        const usesRetryAfter = retryAfterMs !== undefined;
        const delay = retryAfterMs ?? fallbackDelay;
        attempt += 1;
        this.opts.logger('mcp.client.reconnect-scheduled', {
          id: this.opts.id,
          attempt,
          delayMs: delay,
          delaySource: usesRetryAfter ? 'retry-after' : 'backoff',
          followedRetryAfter: usesRetryAfter,
          reason: 'unreachable',
          what,
        });
        await this.sleep(delay);
        if (this.state === 'disposed') {
          throw new Error(`McpClient(${this.opts.id}): disposed`);
        }
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      let timer: { cancel(): void };
      const settle = (): void => {
        if (settled) return;
        settled = true;
        this.pendingRetrySleeps.delete(timer);
        resolve();
      };
      timer = this.opts.setTimer(settle, ms);
      this.pendingRetrySleeps.set(timer, settle);
    });
  }

  private async httpHandshake(retryContext: {
    forbiddenRecoveryAttempted: boolean;
    forbiddenRejectedAfterRecovery: boolean;
  }): Promise<void> {
    // ⛔ 다시 거는 손 맞추기는 «새» 손 맞추기다 — 직전 시도가 남긴 세션·판을 들고 가면
    //    상대가 「이미 초기화된 세션」으로 읽는다(리뷰 should-fix).
    this.sessionId = null;
    this.protocolVersion = null;
    this.opts.logger('mcp.client.http-connect', {
      id: this.opts.id,
      url: this.opts.url,
    });
    const initResult = await this.send('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION_LATEST,
      capabilities: MCP_APP_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    }, retryContext);
    this.protocolVersion = this.requireInitializeProtocolVersion(initResult);
    await this.httpNotify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, retryContext);
    this.state = 'ready';
    this.reconnectAttempt = 0;
    this.opts.logger('mcp.client.ready', { id: this.opts.id });
  }

  private async httpNotify(
    payload: Record<string, unknown>,
    retryContext?: {
      forbiddenRecoveryAttempted: boolean;
      forbiddenRejectedAfterRecovery: boolean;
    },
  ): Promise<void> {
    try {
      await this.httpPost(JSON.stringify(payload), { expectResult: false }, retryContext);
    } catch (err) {
      // ⛔⭐ **재시도 «가능»한 실패를 삼키면 안 된다.** 초판은 `unreachable` 을 삼켜
      //    ***서버가 못 받았는데 `ready` 로 넘어갔다***(리뷰 must-fix). 손 맞추기 안에서
      //    난 5xx·429 는 위로 던져 `httpRetry` 가 «전체를 다시» 걸게 한다.
      if (err instanceof McpConnectionError) throw err;
      // Fire-and-forget: a 202 / empty body is success. 그 밖의(구조화되지 않은)
      // 실패만 기록하고 넘어간다.
      this.opts.logger('mcp.client.http-notify-failed', {
        id: this.opts.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async httpRoundTrip(
    req: JsonRpcRequest,
    retryContext?: {
      forbiddenRecoveryAttempted: boolean;
      forbiddenRejectedAfterRecovery: boolean;
    },
  ): Promise<unknown> {
    const body = await this.httpPost(JSON.stringify(req), {
      expectResult: true,
      expectedId: req.id,
    }, retryContext);
    const msg = this.parseHttpJsonRpc(body, req.id);
    if (msg.error) {
      throw new McpServerError(msg.error.code, msg.error.message);
    }
    return msg.result;
  }

  private parseHttpJsonRpc(body: string, expectedId: number): JsonRpcInbound {
    let msg: JsonRpcInbound;
    try {
      msg = JSON.parse(body) as JsonRpcInbound;
    } catch {
      throw this.notMcp(`response is not JSON`);
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      throw this.notMcp(`response is not a JSON-RPC object`);
    }
    if (msg.jsonrpc !== '2.0') {
      throw this.notMcp(`response is not JSON-RPC 2.0`);
    }
    if (msg.id !== expectedId) {
      throw this.notMcp(`JSON-RPC id mismatch (expected ${expectedId}, got ${String(msg.id)})`);
    }
    const hasResult = Object.prototype.hasOwnProperty.call(msg, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(msg, 'error');
    if (hasResult === hasError) {
      throw this.notMcp(
        hasResult
          ? 'JSON-RPC response has both result and error'
          : 'JSON-RPC response has neither result nor error',
      );
    }
    if (hasError) {
      const err = msg.error;
      if (
        !err ||
        typeof err !== 'object' ||
        typeof err.code !== 'number' ||
        typeof err.message !== 'string'
      ) {
        throw this.notMcp('JSON-RPC error envelope is invalid');
      }
    }
    return msg;
  }

  private requireInitializeProtocolVersion(result: unknown): string {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw this.notMcp('initialize result is not an object');
    }
    const protocolVersion = (result as { protocolVersion?: unknown }).protocolVersion;
    if (typeof protocolVersion !== 'string' || !protocolVersion.trim()) {
      throw this.notMcp('initialize result is missing protocolVersion');
    }
    return protocolVersion.trim();
  }

  private notMcp(detail: string): McpConnectionError {
    const err = new McpConnectionError('not-mcp', '', { detail });
    return new McpConnectionError('not-mcp', formatMcpConnectionGuidance(err), { detail });
  }

  private oauthRuntime(): {
    fetch?: McpOAuthFetch;
    storePath?: string;
    redirectUri?: string;
    resourceUrl?: string;
  } {
    return {
      ...(this.opts.oauthFetch ? { fetch: this.opts.oauthFetch } : {}),
      ...(this.opts.oauthStorePath ? { storePath: this.opts.oauthStorePath } : {}),
      ...(this.opts.oauthRedirectUri ? { redirectUri: this.opts.oauthRedirectUri } : {}),
      // ⛔⭐ 이 클라이언트가 «붙은» 주소를 같이 넘겨 자원 결속을 강제한다.
      //    안 넘기면 401 을 낸 쪽이 가리킨 «남의» 자원 문서를 그대로 믿는다.
      ...(this.opts.url ? { resourceUrl: this.opts.url } : {}),
    };
  }

  /** Which credential the last request used. ⛔ Never the token itself — the
   *  env-var NAME is safe to surface, its VALUE is not. An operator otherwise
   *  cannot tell an expired OAuth token from a deliberate static-bearer server. */
  private bearerSourceState: McpBearerSource = { kind: 'none' };

  get bearerSource(): McpBearerSource {
    return this.bearerSourceState;
  }

  private async currentBearer(): Promise<string | null> {
    const oauthBearer = this.oauthIssuer
      ? await getValidAccessToken(this.oauthIssuer, {
          ...this.oauthRuntime(),
          ...(this.oauthTokenEndpoint ? { tokenEndpoint: this.oauthTokenEndpoint } : {}),
        })
      : null;
    if (oauthBearer) {
      this.bearerSourceState = { kind: 'oauth', issuer: this.oauthIssuer ?? undefined };
      return oauthBearer;
    }
    const envName = this.opts.bearerTokenEnv;
    const staticBearer = envName ? process.env[envName]?.trim() : undefined;
    if (envName && staticBearer) {
      this.bearerSourceState = {
        kind: 'static',
        envName,
        // ⭐ OAuth 가 «설정돼 있는데» 정적 토큰으로 떨어진 경우를 구별한다 —
        //    만료·갱신 실패가 조용히 정적 인증으로 덮이는 것을 운영자가 본다.
        oauthConfiguredButUnavailable: Boolean(this.oauthIssuer),
      };
      return staticBearer;
    }
    this.bearerSourceState = { kind: 'none' };
    return null;
  }

  private forbiddenAfterRecoveryAuthError(err: McpConnectionError): McpConnectionError {
    const detail = err.detail ?? 'Bearer credentials were rejected after one recovery attempt';
    const auth = new McpConnectionError('auth-required', '', { detail });
    return new McpConnectionError(
      'auth-required',
      `${formatMcpConnectionGuidance(auth)} — ${detail}`,
      { detail },
    );
  }

  /** 401 recovery — bounded to one attempt by the caller. Unreachable never
   *  enters here because it is not `auth-required`. Failures fall through to
   *  the original `auth-required` error; credentials are not deleted. */
  private async tryRecoverAuth(err: McpConnectionError, hadBearer: boolean): Promise<boolean> {
    if (!err.resourceMetadata && !(hadBearer && this.oauthIssuer)) return false;
    // Without a browser-boundary handler, a known issuer, or an OAuth fetch
    // seam, discovery would hit the network on every 401 that merely names
    // resource_metadata — and could not complete authorization anyway.
    if (!hadBearer && !this.opts.authorize && !this.oauthIssuer && !this.opts.oauthFetch) {
      return false;
    }
    try {
      const recovered = await recoverAccessToken({
        ...this.oauthRuntime(),
        ...(err.resourceMetadata ? { resourceMetadataUrl: err.resourceMetadata } : {}),
        ...(err.scope ? { scope: err.scope } : {}),
        ...(this.oauthIssuer ? { issuer: this.oauthIssuer } : {}),
        ...(this.oauthTokenEndpoint ? { tokenEndpoint: this.oauthTokenEndpoint } : {}),
        hadBearer,
        ...(this.opts.authorize ? { authorize: this.opts.authorize } : {}),
      });
      if (!recovered) return false;
      this.oauthIssuer = recovered.issuer;
      if (recovered.tokenEndpoint) this.oauthTokenEndpoint = recovered.tokenEndpoint;
      return true;
    } catch (err) {
      // ⛔⭐⭐ 여기서 «삼키면» 호출자는 이유 없는 `auth-required` 만 받는다.
      //    골의 수용 기준은 「S256 미지원이면 «이유가 붙은» 오류」인데, 그 이유가
      //    ***정확히 이 catch 에서 사라졌다***(리뷰 must-fix). 복구는 실패로 두되
      //    «왜» 실패했는지는 남겨서 던질 오류에 싣는다.
      this.oauthRecoveryFailure = err instanceof McpOAuthError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
      return false;
    }
  }

  private async httpPost(
    body: string,
    opts: { expectResult: boolean; expectedId?: number },
    retryContext?: {
      forbiddenRecoveryAttempted: boolean;
      forbiddenRejectedAfterRecovery: boolean;
    },
  ): Promise<string> {
    const url = this.opts.url;
    if (!url) throw new Error(`McpClient(${this.opts.id}): no url`);
    let unauthRecovery = false;
    let credentialRecovery = false;
    let forbiddenRecovery = retryContext?.forbiddenRecoveryAttempted ?? false;
    for (;;) {
      this.httpRequestCount += 1;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      };
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
      if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
      const bearer = await this.currentBearer();
      if (bearer) headers.authorization = `Bearer ${bearer}`;
      const controller = new AbortController();
      this.httpAborts.add(controller);
      const timer = this.opts.setTimer(() => controller.abort(), this.opts.httpTimeoutMs);
      try {
        const res = await this.opts.fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
        const session = res.headers.get('mcp-session-id');
        if (session) this.sessionId = session;
        const contentType = res.headers.get('content-type');
        const wwwAuthenticate = res.headers.get('www-authenticate');
        const retryAfterMs = res.status === 429
          ? parseRetryAfterMs(res.headers.get('retry-after'))
          : undefined;
        // Status/headers first — a slow or open 401 body must not become
        // unreachable, and WWW-Authenticate must not wait on text().
        const headerClassified = classifyMcpHttpResponse({
          status: res.status,
          contentType,
          bodyText: '',
          wwwAuthenticate,
          detail: url,
          hadBearer: Boolean(bearer),
          credentialRecoveryAttempted: credentialRecovery || forbiddenRecovery,
        });
        if (headerClassified) {
          try {
            void res.body?.cancel();
          } catch {
            /* already closed */
          }
          if (
            headerClassified.reason === 'auth-required' ||
            (res.status === 403 && Boolean(bearer) && !forbiddenRecovery)
          ) {
            if (bearer) {
              const isForbidden = res.status === 403;
              const recoveryAttempted = isForbidden ? forbiddenRecovery : credentialRecovery;
              if (!recoveryAttempted) {
                if (isForbidden) {
                  forbiddenRecovery = true;
                  if (retryContext) retryContext.forbiddenRecoveryAttempted = true;
                } else {
                  credentialRecovery = true;
                }
                const recovered = await this.tryRecoverAuth(headerClassified, true);
                if (recovered) continue;
              }
            } else if (!unauthRecovery) {
              unauthRecovery = true;
              const recovered = await this.tryRecoverAuth(headerClassified, false);
              if (recovered) continue;
            }
            // ⭐ 복구가 «왜» 못 했는지를 실어 올린다 — 그것이 없으면 호출자는
            //    「인증이 필요하다」만 보고 S256 미지원·신원 불일치를 구분 못 한다.
            if (this.oauthRecoveryFailure) {
              const cause = this.oauthRecoveryFailure;
              this.oauthRecoveryFailure = null;
              throw new McpConnectionError(
                'auth-required',
                `${headerClassified.message} — recovery failed (${cause})`,
                {
                  ...(headerClassified.wwwAuthenticate
                    ? { wwwAuthenticate: headerClassified.wwwAuthenticate }
                    : {}),
                  ...(headerClassified.resourceMetadata
                    ? { resourceMetadata: headerClassified.resourceMetadata }
                    : {}),
                  ...(headerClassified.scope ? { scope: headerClassified.scope } : {}),
                  ...(headerClassified.detail ? { detail: headerClassified.detail } : {}),
                },
              );
            }
          }
          if (res.status === 403 && Boolean(bearer) && forbiddenRecovery) {
            if (retryContext) {
              retryContext.forbiddenRejectedAfterRecovery = true;
            } else {
              throw this.forbiddenAfterRecoveryAuthError(headerClassified);
            }
          }
          if (retryAfterMs !== undefined && headerClassified.reason === 'unreachable') {
            retryAfterDelays.set(headerClassified, retryAfterMs);
          }
          throw headerClassified;
        }
        if (this.state === 'disposed' || controller.signal.aborted) {
          throw abortError();
        }
        const ct = (contentType ?? '').toLowerCase();
        const isSse = ct.includes('text/event-stream');
        let text = '';
        if (isSse && opts.expectResult && typeof opts.expectedId === 'number' && res.body) {
          text = await readSseJsonRpcFromStream(
            res.body,
            opts.expectedId,
            controller.signal,
            (detail) => this.notMcp(detail),
          );
        } else if (isSse && opts.expectResult && typeof opts.expectedId === 'number') {
          text = extractSseJsonRpcById(
            await raceAbort(res.text(), controller.signal),
            opts.expectedId,
            (detail) => this.notMcp(detail),
          );
        } else {
          text = await raceAbort(res.text(), controller.signal);
        }
        const classified = classifyMcpHttpResponse({
          status: res.status,
          contentType,
          bodyText: text,
          wwwAuthenticate,
          detail: url,
        });
        if (classified) throw classified;
        if (!opts.expectResult) return text;
        if (isSse) return text;
        if (!text.trim()) {
          throw this.notMcp('empty HTTP body');
        }
        return text;
      } catch (err) {
        if (this.state === 'disposed') {
          throw new Error(`McpClient(${this.opts.id}): disposed`);
        }
        if (err instanceof McpConnectionError) throw err;
        throw classifyMcpNetworkError(err, url);
      } finally {
        timer.cancel();
        this.httpAborts.delete(controller);
      }
    }
  }

  private onStdoutData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: JsonRpcInbound;
    try {
      msg = JSON.parse(line) as JsonRpcInbound;
    } catch {
      this.opts.logger('mcp.client.parse-error', {
        id: this.opts.id,
        line: line.slice(0, 200),
      });
      return;
    }
    // ⛔⭐ **유효한 JSON 이 «객체»라는 보장이 없다** — 자식이 `1` 이나 `"x"` 한 줄을
    //    뱉으면 `JSON.parse` 는 통과하고 그 뒤의 `'id' in msg` 가 ***TypeError 를 던진다.***
    //    그 예외는 stdout 데이터 콜백을 타고 나가 스트림 처리를 깬다.
    //    (초판의 `typeof msg.id !== 'number'` 는 원시값에서 조용히 빠졌는데, `in` 으로
    //     바꾸면서 그 안전성을 잃었다 — 3R 리뷰가 잡은 «내가 낸 회귀»다.)
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.opts.logger('mcp.client.unaddressable-line', { id: this.opts.id });
      return;
    }
    // ⛔⭐ **여기가 조용한 자리였다.** 아래 두 `return` 이 「우리가 안 다루는 것」을
    //    «말없이» 버렸다. 그래서 ***서버가 우리에게 무엇을 물었는지 아무도 모른다*** —
    //    「아무도 안 묻는다」와 「물었는데 우리가 흘렸다」가 구분이 안 됐다.
    //    ⇒ 버리기 «전»에 무엇을 버리는지 남긴다. ⚠️ 동작은 종전과 같다(여전히 버린다) —
    //    답을 보낼지는 «이 관측이 모집단을 만든 뒤» 정할 일이다.
    // ⛔⭐ **`length > 0` 으로 재지 않는다.** 빈 문자열 method 는 «망가진 요청»이지
    //    「method 가 없는 것」이 아니다 — 그렇게 재면 `{method:"", id:1}` 이 응답 축으로
    //    떨어져 «고아 응답»으로 둔갑한다(2R must-fix). 축은 ***칸이 있고 문자열인가***다.
    const hasMethod = typeof msg.method === 'string';
    // ⛔⭐ **`method` 하나로는 못 가른다** — 알림도 `method` 를 갖는다.
    //    ⛔⭐⭐ 그리고 «id 가 null 인 것»과 «id 칸이 아예 없는 것»도 다르다.
    //    JSON-RPC 2.0 에서 «알림»은 id 칸이 «없는» 것이고, `id: null` 은 주소 있는 요청이다.
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
    if (hasMethod) {
      if (!hasId) {
        this.opts.logger('mcp.client.notification-dropped', {
          id: this.opts.id,
          method: msg.method,
        });
        return;
      }
      // 서버가 «자기 쪽에서 시작한» 요청. ⚠️ params 를 통째로 싣지 않는다 —
      // 민감정보가 섞일 수 있다(url 모드 elicitation 은 인증·결제를 나른다).
      // 「무엇을 물었나」는 키 이름만으로 충분히 갈린다.
      this.opts.logger('mcp.client.server-request', {
        id: this.opts.id,
        method: msg.method,
        requestId: msg.id,
        paramKeys: msg.params ? Object.keys(msg.params).slice(0, 12) : [],
        addressable: true,
      });
      this.replyMethodNotFound(msg.id!, msg.method!);
      return;
    }
    if (!hasId || msg.id === null) {
      // method 도 없고 쓸 수 있는 id 도 없다 — 우리가 다룰 수 없는 줄.
      this.opts.logger('mcp.client.unaddressable-line', { id: this.opts.id });
      return;
    }
    // ⛔⭐ JSON-RPC id 는 `number | string` 둘 다다. `pending` 은 number 로만 키가 잡히니
    //    ***string id 응답은 «영영» 매칭되지 않는다*** — 그것도 고아 응답이다.
    //    (초판은 이 줄을 `typeof !== 'number'` 로 걸러 「다룰 수 없는 줄」로 오분류했다.)
    const numericId = typeof msg.id === 'number' ? msg.id : undefined;
    const p = numericId === undefined ? undefined : this.pending.get(numericId);
    if (!p || numericId === undefined) {
      // 우리가 모르는 id 에 대한 응답 — 늦게 온 것이거나 중복이거나 string id.
      this.opts.logger('mcp.client.orphan-response', {
        id: this.opts.id,
        requestId: msg.id,
        pendingCount: this.pending.size,
      });
      return;
    }
    this.pending.delete(numericId);
    if (msg.error) {
      p.reject(new McpServerError(msg.error.code, msg.error.message));
    } else {
      p.resolve(msg.result);
    }
  }

  private onExit(code: number | null, signal: string | null): void {
    this.opts.logger('mcp.client.exit', {
      id: this.opts.id,
      code,
      signal,
    });
    const prevState = this.state;
    this.child = null;
    this.rejectAllPending(
      new Error(
        `MCP server '${this.opts.id}' exited (code=${code}, signal=${signal})`,
      ),
    );
    if (prevState === 'disposed') return;
    if (this.opts.reconnectBackoffMs.length === 0) {
      // One-shot — no reconnect requested.
      this.state = 'halted';
      this.opts.logger('mcp.client.halt', {
        id: this.opts.id,
        reason: 'no-reconnect-configured',
      });
      return;
    }
    this.state = 'reconnecting';
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const backoff = this.opts.reconnectBackoffMs;
    if (this.reconnectAttempt >= backoff.length) {
      this.state = 'halted';
      this.opts.logger('mcp.client.halt', {
        id: this.opts.id,
        attempts: this.reconnectAttempt,
      });
      return;
    }
    const delay = backoff[this.reconnectAttempt] ?? 0;
    this.reconnectAttempt += 1;
    this.opts.logger('mcp.client.reconnect-scheduled', {
      id: this.opts.id,
      attempt: this.reconnectAttempt,
      delayMs: delay,
    });
    this.pendingTimer = this.opts.setTimer(() => {
      this.pendingTimer = null;
      if (this.state === 'disposed') return;
      this.state = 'starting';
      this.spawnAndHandshake().catch((err) => {
        this.opts.logger('mcp.client.reconnect-failed', {
          id: this.opts.id,
          attempt: this.reconnectAttempt,
          err: err instanceof Error ? err.message : String(err),
        });
        this.state = 'reconnecting';
        this.scheduleReconnect();
      });
    }, delay);
  }

  private rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      try {
        p.reject(err);
      } catch {
        /* swallow */
      }
    }
    this.pending.clear();
  }
}
