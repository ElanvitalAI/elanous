// ── NEXUS HTTP transport for MCP (B 트랙 closure piece · 2026-05-13) ──
//
// `POST /v1/mcp` — Streamable HTTP transport per MCP spec 2025-11-25.
// External MCP clients reach the NEXUS daemon's ToolRuntime registry directly.
//
// Default response is a single JSON envelope (or 202 for notifications).
// Opt-in progress streaming is SSE, and ONLY when the caller is explicit:
//   • header `MCP-Progress: stream`, and/or
//   • JSON-RPC top-level field `_mcpProgress: "stream"`
// `Accept: text/event-stream` is NOT an opt-in — live MCP clients already send
// it and must keep receiving the original JSON body.
// Tool-call `params._mcpProgress` is NOT an opt-in — tool arguments must not
// change the HTTP response mode.

import { AsyncLocalStorage } from 'node:async_hooks';
import { resolveToken, type TokenStorePaths } from '../../auth/token-store.js';
import { tokenScopeAllows, type TokenScope } from '../../auth/scope.js';
import { hasProxyMarker } from '../../boot/check-same-origin.js';
import { debug } from '../../debug/log.js';
import type { FeedbackEnvelope } from '../../feedback/envelope.js';
import { handleMcpRequest } from '../../mcp/server.js';
import { listNativeToolsForHost, type NativeToolCatalogEntry } from '../../native-tool-catalog.js';
import { getToolRuntime, listToolRuntimes } from '../../tool-runtime/registry.js';
import type { ToolRuntime } from '../../tool-runtime/types.js';

const mcpHttpProgressSink = new AsyncLocalStorage<(env: FeedbackEnvelope) => void>();
const patchedRuntimes = new WeakSet<ToolRuntime>();

const MCP_WWW_AUTHENTICATE = 'Bearer realm="elanous-mcp"';

/** Header name for explicit progress-stream opt-in. Case-insensitive on read. */
export const MCP_PROGRESS_HEADER = 'MCP-Progress';
/** Header / body value that selects SSE progress streaming. */
export const MCP_PROGRESS_STREAM = 'stream';
/** JSON-RPC request field that selects SSE progress streaming. */
export const MCP_PROGRESS_FIELD = '_mcpProgress';

type McpHttpResponseMode = 'json' | 'sse';

interface McpHttpRequestContext {
  /** Direct TCP peer as reported by Bun's server context; never forwarded headers. */
  peerAddress?: string;
  binding?: { hostname: string; port: number };
  /** Test-only override for the existing token store's home directory. */
  tokenStorePaths?: TokenStorePaths;
  /** Enables catalog-derived SSE for long-running MCP tools. Default true. */
  automaticProgressDetection?: boolean;
  /** Test-only catalog injection; production reads the MCP host catalog. */
  mcpToolCatalog?: readonly NativeToolCatalogEntry[];
}

type McpHttpAccessDecision =
  | { allowed: true; scope: TokenScope }
  | { allowed: false; reason: 'browser_origin' | 'missing_peer' | 'missing_bearer' | 'invalid_token' | 'insufficient_scope' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function isLoopbackPeer(peerAddress: string | undefined): boolean {
  if (!peerAddress) return false;
  const address = peerAddress.toLowerCase();
  if (address === '::1') return true;
  const ipv4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  const octets = ipv4.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.slice(1).every((octet) => /^\d{1,3}$/.test(octet));
}

function extractBearerCredential(authorization: string | null): string | null {
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization ?? '');
  return match?.[1] ?? null;
}

/** Authorize an MCP HTTP request before consuming its body or dispatching JSON-RPC. */
function authorizeMcpHttpRequest(
  req: Request,
  context: McpHttpRequestContext,
): McpHttpAccessDecision {
  // MCP clients do not send Origin. Reject browser-originated posts before
  // the loopback exception so another website cannot invoke local tools.
  if (req.headers.has('origin')) return { allowed: false, reason: 'browser_origin' };
  // ⛔ 루프백 «이고» 프록시 표식이 없을 때만 믿는다(RFC 공개 MCP 인증 M0 · #21073 A′ 와 같은 규칙).
  //    `tailscale serve`·Caddy 뒤에선 상대가 늘 루프백으로 보인다 — 표식 없이 믿으면 프록시 너머 누구나 전 도구를 쓴다.
  if (isLoopbackPeer(context.peerAddress) && !hasProxyMarker(req) && !req.headers.has('authorization')) {
    return { allowed: true, scope: 'admin' };
  }

  const credential = extractBearerCredential(req.headers.get('authorization'));
  if (!credential) {
    return { allowed: false, reason: context.peerAddress ? 'missing_bearer' : 'missing_peer' };
  }
  const token = resolveToken(credential, context.tokenStorePaths);
  if (!token) return { allowed: false, reason: 'invalid_token' };
  const scope = tokenScopeAllows(token, { method: 'POST', pathname: '/v1/mcp' });
  return scope.ok ? { allowed: true, scope: token.scope } : { allowed: false, reason: 'insufficient_scope' };
}

function unauthorizedMcpResponse(): Response {
  return new Response(null, {
    status: 401,
    headers: { 'www-authenticate': MCP_WWW_AUTHENTICATE },
  });
}

function logMcpAccess(event: 'allow' | 'deny', context: McpHttpRequestContext, reason?: string): void {
  debug.log(`mcp.http.access.${event}`, 'POST /v1/mcp', {
    peerAddress: context.peerAddress ?? null,
    binding: context.binding ?? null,
    ...(reason ? { reason } : {}),
  });
}

function logMcpResponseMode(
  mode: McpHttpResponseMode,
  progress?: McpProgressStreamDecision,
): void {
  debug.log('mcp.http.response', 'mode', {
    mode,
    ...(progress?.automatic ? { automatic: true, reason: progress.reason, toolName: progress.toolName } : {}),
  });
}

interface JsonRpcRequestShape {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  _mcpProgress?: unknown;
}

export type McpAutomaticProgressReason = 'delegate' | 'process' | 'agent';

export interface McpProgressStreamDecision {
  stream: boolean;
  automatic: boolean;
  reason?: McpAutomaticProgressReason;
  toolName?: string;
}

function automaticProgressReason(
  rpc: JsonRpcRequestShape,
  catalog: readonly NativeToolCatalogEntry[],
): { reason: McpAutomaticProgressReason; toolName: string } | undefined {
  if (rpc.method !== 'tools/call' || typeof rpc.params?.name !== 'string') return undefined;
  const tool = catalog.find((entry) => entry.id === rpc.params!.name || entry.aliases.includes(rpc.params!.name as string));
  if (!tool) return undefined;
  if (tool.kind === 'delegate') return { reason: 'delegate', toolName: rpc.params.name };
  if (tool.safety.includes('process')) return { reason: 'process', toolName: rpc.params.name };
  if (tool.safety.includes('agent')) return { reason: 'agent', toolName: rpc.params.name };
  return undefined;
}

export function isProgressStreamOptIn(
  req: Request,
  rpc: JsonRpcRequestShape,
  options: Pick<McpHttpRequestContext, 'automaticProgressDetection' | 'mcpToolCatalog'> = {},
): McpProgressStreamDecision {
  const header = req.headers.get(MCP_PROGRESS_HEADER);
  if (typeof header === 'string' && header.trim().toLowerCase() === MCP_PROGRESS_STREAM) {
    return { stream: true, automatic: false };
  }
  if (rpc[MCP_PROGRESS_FIELD] === MCP_PROGRESS_STREAM) return { stream: true, automatic: false };
  if (options.automaticProgressDetection === false) return { stream: false, automatic: false };
  const automatic = automaticProgressReason(rpc, options.mcpToolCatalog ?? listNativeToolsForHost('mcp'));
  return automatic ? { stream: true, automatic: true, ...automatic } : { stream: false, automatic: false };
}

function patchRuntimeForMcpProgress(runtime: ToolRuntime): void {
  if (patchedRuntimes.has(runtime)) return;
  patchedRuntimes.add(runtime);
  const original = runtime.run.bind(runtime);
  runtime.run = (req, ctx) => {
    const sink = mcpHttpProgressSink.getStore();
    if (!sink) return original(req, ctx);
    return original(req, {
      ...ctx,
      emitFeedback: (env) => {
        sink(env);
        ctx.emitFeedback?.(env);
      },
    });
  };
}

function withMcpProgressSink<T>(
  emit: (env: FeedbackEnvelope) => void,
  rpc: JsonRpcRequestShape,
  fn: () => Promise<T>,
): Promise<T> {
  for (const runtime of listToolRuntimes()) patchRuntimeForMcpProgress(runtime);
  const toolName = typeof rpc.params?.name === 'string' ? rpc.params.name : '';
  if (rpc.method === 'tools/call' && toolName) {
    const named = getToolRuntime(toolName);
    if (named) patchRuntimeForMcpProgress(named);
  }
  return mcpHttpProgressSink.run(emit, fn);
}

function sseProgressResponse(
  work: (send: (event: string, data: unknown) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* client disconnected — server-side work keeps running */
        }
      };
      try {
        await work(send);
      } catch (err) {
        send('error', {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
        });
      } finally {
        try { controller.close(); } catch { /* ignore double-close */ }
      }
    },
    cancel() {
      // Contrast with handleAutopilotRun: MCP disconnect must NOT abort
      // in-flight tool work. The enqueue path already fail-softs.
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

/** POST /v1/mcp — Streamable HTTP MCP endpoint. Returns a JSON
 *  envelope by default, SSE progress+result when explicitly opted in,
 *  or 202 for notifications. */
export async function handleMcpHttpPost(
  req: Request,
  context: McpHttpRequestContext = {},
): Promise<Response> {
  const access = authorizeMcpHttpRequest(req, context);
  if (!access.allowed) {
    logMcpAccess('deny', context, access.reason);
    return unauthorizedMcpResponse();
  }
  logMcpAccess('allow', context);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
      400,
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return jsonResponse(
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: expected object' } },
      400,
    );
  }
  const rpc = raw as JsonRpcRequestShape;
  if (typeof rpc.method !== 'string' || rpc.method.length === 0) {
    return jsonResponse(
      { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32600, message: 'invalid request: method missing' } },
      400,
    );
  }
  const isNotification = rpc.id === undefined || rpc.id === null;
  const mcpRequest = {
    jsonrpc: '2.0' as const,
    id: rpc.id ?? null,
    method: rpc.method,
    ...(rpc.params ? { params: rpc.params } : {}),
  };

  const progress = isProgressStreamOptIn(req, rpc, context);
  const mcpContext = { surface: 'mcp' as const, origin: 'mcp-http' as const, tokenScope: access.scope };
  if (!isNotification && progress.stream) {
    logMcpResponseMode('sse', progress);
    return sseProgressResponse(async (send) => {
      const resp = await withMcpProgressSink(
        (env) => send('progress', env),
        rpc,
        () => handleMcpRequest(mcpRequest, mcpContext),
      );
      if (resp.error) send('error', resp);
      else send('result', resp);
    });
  }

  const resp = await handleMcpRequest(mcpRequest, mcpContext);
  if (isNotification) return new Response(null, { status: 202 });
  logMcpResponseMode('json');
  return jsonResponse(resp, 200);
}
