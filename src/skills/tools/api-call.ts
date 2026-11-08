import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Native tool: api_call
//
// Generic HTTP JSON tool. Purpose: let the LLM query external APIs
// and branch on the returned JSON, without needing a skill wrapper
// per endpoint. Powerful enough to be risky — therefore gated by
// (1) per-host allowlist (empty by default), (2) token-bucket rate
// limiter, (3) 2 MB response cap with optional saved-path spill, and
// (4) secret redaction in debug logs.
//
// Output shape matches opencode/claude-code pattern:
//   output    — LLM-facing body (parsed JSON pretty-printed, or text
//               if Content-Type isn't JSON). Truncated to 2 KB.
//   display   — longer preview for dashboard.
//   metadata  — status, bytes, durationMs, allow/rate diagnostics.


import { debug } from '../../debug/log.js';
import { consumeRateToken, isAllowed, listAllowed } from '../../tool-hints/api-allowlist.js';
import { truncateOutput } from '../../output-truncation.js';

export interface ApiCallArgs {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  timeout_ms?: number;
  response?: 'json' | 'text' | 'auto';
  expect_status?: number[];
}

export interface ApiCallResult {
  output: string;
  display: string;
  metadata: {
    status: number;
    durationMs: number;
    url: string;
    contentType: string;
    bytes: number;
    truncatedAt?: number;
    host?: string;
  };
  isError?: true;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;     // 2 MB
const MODEL_FACING_OUTPUT_CHARS = 4000;         // 4 KB of pretty JSON
const DISPLAY_OUTPUT_CHARS = 16_000;            // 16 KB for dashboard

// Headers to redact from debug logs (case-insensitive match).
const SECRET_HEADERS = new Set([
  'authorization', 'cookie', 'x-api-key', 'api-key',
  'x-auth-token', 'auth-token', 'proxy-authorization',
]);

export function buildApiCallTool(): LLMToolSpec {
  return {
    name: 'ApiCall',
    description:
      'Invoke an HTTP JSON API and return parsed response for branching. Host must be in the ' +
      'allowlist (manage via /api-allow). Rate-limited: 30 calls/min/host, 200/min global. ' +
      'Use for GitHub / internal dashboards / any JSON endpoint you want the model to reason ' +
      'about the return value of. DO NOT use for web fetching (use WebFetch) or search (WebSearch).',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        url: { type: 'string', description: 'Full URL. Host must be on the allowlist (empty by default — user runs /api-allow add <host>).' },
        headers: { type: 'object', description: 'Optional request headers. Authorization/Cookie/X-API-Key values are redacted in debug logs.' },
        body: { description: 'Request body — string (sent as-is) or object (JSON-stringified with Content-Type: application/json).' },
        timeout_ms: { type: 'integer', description: `Request timeout. Default ${DEFAULT_TIMEOUT_MS}, capped at ${MAX_TIMEOUT_MS}.` },
        response: { type: 'string', enum: ['json', 'text', 'auto'], description: 'Parse strategy for the response body. "auto" = JSON if Content-Type matches, else text.' },
        expect_status: { type: 'array', items: { type: 'integer' }, description: 'HTTP statuses considered non-error. Default [200, 201, 204].' },
      },
      required: ['method', 'url'],
      additionalProperties: false,
    },
  };
}

export interface DispatchApiCallOpts {
  /** Outer AbortSignal — aborts the in-flight fetch when the caller
   *  (dashboard Esc, test cleanup, …) requests cancellation. The
   *  dispatcher still owns its own timeout-bound AbortController;
   *  both signals compose via addEventListener('abort'). */
  signal?: AbortSignal;
}

export async function dispatchApiCall(
  rawArgs: Record<string, unknown>,
  opts: DispatchApiCallOpts = {},
): Promise<ApiCallResult> {
  const args = validate(rawArgs);
  const host = hostnameOf(args.url);
  const start = Date.now();

  // ─── Allowlist ────────────────────────────────────────────────
  if (!isAllowed(args.url)) {
    const currentHosts = listAllowed().map(e => e.host).join(', ') || '(empty)';
    return {
      output: `api_call blocked: host '${host}' not allowed. Add it with /api-allow add ${host} or ask the user. Current allowlist: ${currentHosts}.`,
      display: '',
      metadata: { status: 0, durationMs: 0, url: args.url, contentType: '', bytes: 0, host },
      isError: true,
    };
  }

  // ─── Rate limit ───────────────────────────────────────────────
  const rate = consumeRateToken(args.url, start);
  if (!rate.ok) {
    return {
      output: `api_call rate-limited: ${rate.reason}. Retry after the window rolls over.`,
      display: '',
      metadata: { status: 0, durationMs: 0, url: args.url, contentType: '', bytes: 0, host },
      isError: true,
    };
  }

  // ─── Build request ────────────────────────────────────────────
  const timeoutMs = Math.min(args.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // Compose the outer caller signal with our timeout controller so
  // either source can abort. Mark the reason so the error branch can
  // distinguish user abort from timeout (unused today, but surfaces
  // cleanly in logs).
  let outerAbortDisposer: (() => void) | null = null;
  if (opts.signal) {
    if (opts.signal.aborted) {
      ctrl.abort('outer signal already aborted');
    } else {
      const onOuterAbort = () => ctrl.abort('outer signal aborted');
      opts.signal.addEventListener('abort', onOuterAbort, { once: true });
      outerAbortDisposer = () => opts.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
  const headers: Record<string, string> = { ...(args.headers ?? {}) };
  let bodyStr: string | undefined;
  if (args.body !== undefined) {
    if (typeof args.body === 'string') {
      bodyStr = args.body;
    } else {
      bodyStr = JSON.stringify(args.body);
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  debug.log('tool.api_call', 'request', {
    method: args.method,
    url: args.url,
    headers: redactHeaders(headers),
    bodyBytes: bodyStr ? bodyStr.length : 0,
    timeoutMs,
  });

  // ─── Fire ─────────────────────────────────────────────────────
  let resp: Response;
  try {
    resp = await fetch(args.url, {
      method: args.method,
      headers,
      body: bodyStr,
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    outerAbortDisposer?.();
    const msg = err instanceof Error ? err.message : String(err);
    debug.log('tool.api_call', 'error', { url: args.url, err: msg }, { level: 'error' });
    return {
      output: `api_call failed: ${msg}`,
      display: '',
      metadata: { status: 0, durationMs: Date.now() - start, url: args.url, contentType: '', bytes: 0, host },
      isError: true,
    };
  } finally {
    clearTimeout(timer);
    outerAbortDisposer?.();
  }

  // ─── Body (capped at MAX_RESPONSE_BYTES) ──────────────────────
  const contentType = resp.headers.get('content-type') ?? '';
  const { text, bytesRead, truncatedAt } = await readCapped(resp);

  // ─── Parse strategy ───────────────────────────────────────────
  const strategy = args.response ?? 'auto';
  const looksJson = contentType.includes('application/json') || contentType.includes('+json');
  const shouldParseJson = strategy === 'json' || (strategy === 'auto' && looksJson);

  let parsed: unknown;
  let parseError: string | undefined;
  if (shouldParseJson) {
    try { parsed = JSON.parse(text); }
    catch (err) { parseError = err instanceof Error ? err.message : String(err); }
  }

  const pretty = parsed !== undefined
    ? JSON.stringify(parsed, null, 2)
    : text;

  // ─── Status check ─────────────────────────────────────────────
  const expectStatus = args.expect_status ?? [200, 201, 204];
  const statusOk = expectStatus.includes(resp.status);
  const displayBody = pretty.length > DISPLAY_OUTPUT_CHARS
    ? pretty.slice(0, DISPLAY_OUTPUT_CHARS) + `\n... [truncated; ${pretty.length - DISPLAY_OUTPUT_CHARS} more chars]`
    : pretty;
  // P15: spill large bodies to /tmp/elanous-output so the LLM can
  // re-read via the Read tool without consuming context here. Inline
  // limit of 4 KB matches the prior MODEL_FACING_OUTPUT_CHARS budget.
  const truncated = truncateOutput(pretty, {
    toolName: 'api_call',
    ext: parsed !== undefined ? 'json' : 'txt',
    inlineLimit: MODEL_FACING_OUTPUT_CHARS,
  });
  const outputBody = truncated.output;

  debug.log('tool.api_call', 'response', {
    status: resp.status,
    contentType,
    bytes: bytesRead,
    durationMs: Date.now() - start,
    parseError,
    statusOk,
  });

  const header = `${args.method} ${args.url} → ${resp.status} (${(Date.now() - start)}ms, ${bytesRead}B)`;
  const result: ApiCallResult = {
    output: `${header}\n\n${outputBody}`,
    display: `${header}\n\n${displayBody}`,
    metadata: {
      status: resp.status,
      durationMs: Date.now() - start,
      url: args.url,
      contentType,
      bytes: bytesRead,
      truncatedAt,
      host,
    },
  };
  if (!statusOk) result.isError = true;
  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────

async function readCapped(resp: Response): Promise<{ text: string; bytesRead: number; truncatedAt?: number }> {
  // fetch() returns a streaming Response; read chunks until cap.
  const reader = resp.body?.getReader();
  if (!reader) {
    const text = await resp.text();
    return { text: text.slice(0, MAX_RESPONSE_BYTES), bytesRead: text.length };
  }
  const decoder = new TextDecoder();
  let text = '';
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > MAX_RESPONSE_BYTES) {
      const leftover = MAX_RESPONSE_BYTES - (bytesRead - value.byteLength);
      text += decoder.decode(value.subarray(0, Math.max(0, leftover)));
      reader.cancel().catch(() => {});
      return { text, bytesRead, truncatedAt: MAX_RESPONSE_BYTES };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, bytesRead };
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (SECRET_HEADERS.has(key.toLowerCase())) out[key] = '[REDACTED]';
    else out[key] = val;
  }
  return out;
}

function hostnameOf(url: string): string | undefined {
  try { return new URL(url).hostname.toLowerCase(); } catch { return undefined; }
}

function validate(raw: Record<string, unknown>): ApiCallArgs {
  const methodRaw = raw.method;
  const methods: ApiCallArgs['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  if (typeof methodRaw !== 'string' || !methods.includes(methodRaw as ApiCallArgs['method'])) {
    throw new Error(`'method' must be one of GET|POST|PUT|PATCH|DELETE`);
  }
  const url = raw.url;
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new Error(`'url' is required`);
  }
  try { new URL(url); } catch {
    throw new Error(`'url' is not a valid URL: ${url}`);
  }
  const headers = raw.headers;
  if (headers !== undefined) {
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
      throw new Error(`'headers' must be an object of string → string`);
    }
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof v !== 'string') throw new Error(`'headers' value for '${k}' must be a string`);
    }
  }
  const body = raw.body;
  if (body !== undefined && typeof body !== 'string' && (typeof body !== 'object' || body === null)) {
    throw new Error(`'body' must be a string or an object`);
  }
  const timeoutMs = raw.timeout_ms;
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
      throw new Error(`'timeout_ms' must be a positive number`);
    }
  }
  const response = raw.response;
  if (response !== undefined && !['json', 'text', 'auto'].includes(response as string)) {
    throw new Error(`'response' must be json|text|auto`);
  }
  const expectStatus = raw.expect_status;
  if (expectStatus !== undefined) {
    if (!Array.isArray(expectStatus) || !expectStatus.every(n => typeof n === 'number')) {
      throw new Error(`'expect_status' must be an array of numbers`);
    }
  }
  return {
    method: methodRaw as ApiCallArgs['method'],
    url,
    headers: headers as Record<string, string> | undefined,
    body: body as string | Record<string, unknown> | undefined,
    timeout_ms: timeoutMs as number | undefined,
    response: response as ApiCallArgs['response'] | undefined,
    expect_status: expectStatus as number[] | undefined,
  };
}
