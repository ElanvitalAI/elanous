// ── Retry-policy consumer for provider API calls (Coding Pipeline P3 followup) ──
//
// `decideRetry` (src/session-runtime/retry-policy.ts) shipped as a
// pure verdict primitive — caller decides whether to sleep+retry or
// abort. This module is the single consumer that wraps an HTTP fetch
// to a provider (Anthropic / OpenAI / Grok / Codex) with that policy.
//
// What gets retried: the fetch + initial response check (status code
// landed before any SSE data was streamed). Once SSE deltas start
// flowing, mid-stream errors do NOT retry — that would require
// re-prompting the model from scratch and risk double-billing /
// double-rendering of partial responses.
//
// Why a structured error: the `decideRetry` policy keys off the
// error's `.code` and `.message`. Native `fetch` Response failures
// give us only the response object; we synthesise an `ApiHttpError`
// that carries `code` (the HTTP status as string) so the policy can
// fingerprint 429 / 503 / etc. without scraping the message text.
//
// Compatibility: callers that don't care about retry can keep using
// raw `fetch`. This module is opt-in per call site.

import { debug } from '../debug/log.js';
import {
  decideRetry,
  DoomLoopTracker,
  fingerprintError,
  llmCallOutcomeKind,
  type LlmCallOutcomeKind,
  type RetryAction,
} from './retry-policy.js';

/** Structured HTTP error produced by `fetchApiWithRetry`. Exposes
 *  `code` so `decideRetry` (which looks at `err.code`) can recognise
 *  429 / 503 / 4xx / 5xx without parsing the message string. */
export class ApiHttpError extends Error {
  readonly status: number;
  readonly bodyText: string;
  readonly retryAfter?: string;
  readonly provider: string;
  readonly bodyTimedOut: boolean;
  readonly bodyReadFailed: boolean;
  /** `decideRetry.extractErrorCode` falls back to `.code` then
   *  `.errno` then `.status`. We expose all three to keep the contract
   *  defensive against future refactors. */
  readonly code: string;
  readonly errno: string;

  constructor(opts: {
    status: number;
    bodyText: string;
    provider: string;
    errorPrefix: string;
    retryAfter?: string;
    bodyTimedOut?: boolean;
    bodyReadFailed?: boolean;
  }) {
    const trimmed = opts.bodyText.replace(/\s+/g, ' ').slice(0, 500);
    super(`${opts.errorPrefix} ${opts.status}: ${trimmed}`);
    this.name = 'ApiHttpError';
    this.status = opts.status;
    this.bodyText = opts.bodyText;
    this.provider = opts.provider;
    this.bodyTimedOut = opts.bodyTimedOut === true;
    this.bodyReadFailed = opts.bodyReadFailed === true;
    this.retryAfter = opts.retryAfter;
    this.code = String(opts.status);
    this.errno = String(opts.status);
  }
}

export interface FetchApiWithRetryOpts {
  /** Provider name for telemetry — anthropic / openai / grok / codex. */
  provider: string;
  /** Maximum wait for response headers on each attempt. */
  headerTimeoutMs?: number;
  /** Prefix for the error message when the API returns non-2xx. Same
   *  shape the existing `throw new Error(...)` sites use so log
   *  archaeology stays meaningful. */
  errorPrefix: string;
  /** Hard cap on attempts. Default 4 (1 initial + 3 retries). */
  maxAttempts?: number;
  /** Optional shared doom-loop tracker. When omitted, a per-call
   *  tracker is used — enough to catch the "same 503 three times in a
   *  row" pattern within a single request. Pass a session-scoped
   *  tracker if you want cross-request doom detection. */
  doomTracker?: DoomLoopTracker;
  /** Fallbacks still unused. When > 0, k consecutive overload-class
   *  failures throw OverloadFailoverError before another retry sleep. */
  remainingFallbacks?: number;
  /** BEDROCK-PROVIDER — 재시도 «직전»마다 요청을 다시 만든다(SigV4 서명은 `x-amz-date` 기준 수 분만 유효 —
   *  `retry-after` 대기가 길면 옛 서명은 403). 없으면 종전처럼 같은 `init` 을 다시 쓴다(다른 provider 불변). */
  refreshInit?: () => Promise<RequestInit>;
}

/** Raised when overload repeats k times and a fallback is still unused.
 *  The caller switches provider; this is not a retry exhaustion. */
export class OverloadFailoverError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly kind: LlmCallOutcomeKind;
  readonly streak: number;
  readonly cause: unknown;

  constructor(opts: {
    provider: string;
    status: number;
    kind: LlmCallOutcomeKind;
    streak: number;
    cause: unknown;
  }) {
    super(`overload failover after ${opts.streak} ${opts.kind} from ${opts.provider} (status ${opts.status})`);
    this.name = 'OverloadFailoverError';
    this.provider = opts.provider;
    this.status = opts.status;
    this.kind = opts.kind;
    this.streak = opts.streak;
    this.cause = opts.cause;
  }
}

/** POST a fetch with the standard retry policy. On 2xx returns the
 *  Response (caller consumes the SSE body). On 4xx/5xx retries per
 *  `decideRetry` until either it succeeds, the policy says abort, or
 *  `maxAttempts` is exhausted — in which case the last error throws.
 *
 *  AbortError always propagates immediately (user pressed Esc).
 */
export async function fetchApiWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchApiWithRetryOpts,
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const tracker = opts.doomTracker ?? new DoomLoopTracker();
  const remainingFallbacks = opts.remainingFallbacks ?? 0;
  let attempt = 0;
  let overloadStreak = 0;
  let reasoningFormatRetried = false;
  let lastErr: unknown;
  while (attempt < maxAttempts) {
    let response: Response | null = null;
    // ⛔ try «밖» — 재서명 실패(자격 부재 등)는 재시도할 네트워크 오류가 아니다. 그대로 던진다.
    if (attempt > 0 && opts.refreshInit) init = await opts.refreshInit();
    try {
      response = await fetchWithHeaderTimeout(url, init, opts.headerTimeoutMs ?? 120_000);
      if (response.ok) {
        recordLlmCallOutcome(opts.provider, response.status, 'ok');
        overloadStreak = 0;
        return response;
      }
      // Drain body so the error can carry the API's explanation. We
      // don't reuse the response after this point, so consuming the
      // body is safe.
      const body = await readErrorBody(response, 4_096, opts.headerTimeoutMs ?? 120_000);
      const text = body.text;
      debug.log('llm.provider-error', 'http', {
        provider: opts.provider,
        status: response.status,
        body: text.slice(0, 500),
        reason: body.timedOut ? 'error-body-timeout'
          : body.failed ? 'error-body-read-failed'
          : response.status === 429 ? 'rate-limit'
          : response.status === 503 ? 'provider-unavailable'
          : response.status === 400 ? 'format-error'
          : response.status === 401 || response.status === 403 ? 'auth-error'
          : response.status >= 500 ? 'server-error' : 'http-error',
      }, { level: 'error' });
      // Wave 7 (2026-05-04) — `retry-after-ms` takes priority over
      // `retry-after`. Anthropic emits `retry-after-ms` (ms-precision)
      // alongside the standard `retry-after` (seconds) on rate-limit
      // responses; the ms variant gives sub-second back-off accuracy
      // on bursty quota windows. ref/opencode `session/retry.ts:23-53`
      // pattern. parseRetryAfter already handles both numeric and
      // HTTP-date forms — we just feed it the most precise header
      // available. Falls back to `retry-after` when the ms variant is
      // absent (most providers).
      const retryAfterMs = response.headers.get('retry-after-ms');
      const retryAfterSec = response.headers.get('retry-after');
      // Format the ms value with the `ms` suffix so parseRetryAfter
      // routes it through its ms branch (rather than misreading as
      // seconds).
      const retryAfterRaw = retryAfterMs !== null
        ? `${retryAfterMs}ms`
        : retryAfterSec ?? undefined;
      throw new ApiHttpError({
        status: response.status,
        bodyText: text,
        provider: opts.provider,
        errorPrefix: opts.errorPrefix,
        retryAfter: retryAfterRaw,
        bodyTimedOut: body.timedOut,
        bodyReadFailed: body.failed,
      });
    } catch (err: unknown) {
      lastErr = err;
      // User abort — never retry. Match both standard `AbortError` and
      // `(err as any).code === 'ABORT_ERR'` (some runtimes use the
      // latter). We don't try to introspect the AbortSignal here; that
      // would couple the helper to the caller's signal.
      if (isAbortLike(err)) throw err;
      const status = err instanceof ApiHttpError ? err.status : 0;
      const kind = llmCallOutcomeKind(status, err instanceof Error ? err.message : String(err));
      recordLlmCallOutcome(opts.provider, status, kind);

      // A few OpenRouter reasoning models reject an explicit reasoning field.
      // Rebuild only that request once, and only when the provider says the
      // field caused the 400. Other 400s keep the original terminal error.
      if (!reasoningFormatRetried && !opts.refreshInit && err instanceof ApiHttpError && err.status === 400
        && rejectsReasoningField(err.bodyText)
        && typeof init.body === 'string') {
        try {
          const body = JSON.parse(init.body) as Record<string, unknown>;
          if (Object.hasOwn(body, 'reasoning')) {
            delete body.reasoning;
            init = { ...init, body: JSON.stringify(body) };
            reasoningFormatRetried = true;
            // Reference: openai/codex@ee344ca codex-rs/codex-client/src/retry.rs:16-39,84-114.
            // Its transport policy counts 429/5xx/transport attempts; this one-off format repair
            // is separate and must not spend that budget.
            debug.log('llm.retry', 'reasoning-format-retry', { provider: opts.provider, status: 400, attempt, reason: 'reasoning-field-rejected' }, { level: 'warn' });
            continue;
          }
        } catch { /* malformed request body is not recoverable */ }
      }
      if (err instanceof ApiHttpError && err.status === 400) {
        debug.log('llm.retry', 'abort', { provider: opts.provider, status: 400, reason: 'non-retryable-format-error' });
        throw err;
      }

      if (kind === 'overloaded' || kind === '5xx' || kind === 'rate-limit') overloadStreak += 1;
      else overloadStreak = 0;
      const fp = fingerprintError(err, `api:${opts.provider}`);
      const doomStatus = tracker.record(fp);
      const retryAfter = err instanceof ApiHttpError ? err.retryAfter : undefined;
      // OpenRouter may report an upstream transient as a non-5xx HTTP status.
      // Keep the original status/error for callers, but classify this specific body as retryable.
      const policyError = opts.provider === 'openrouter' && err instanceof ApiHttpError
        && /Provider returned error/i.test(err.bodyText)
        ? Object.assign(new Error(err.message), { code: '503' }) : err;
      const decision = decideRetry(policyError, {
        attempt,
        doomStatus,
        retryAfter,
        remainingFallbacks,
        overloadStreak,
      });
      debug.log('llm.retry', decisionEvent(decision.action), {
        provider: opts.provider,
        attempt,
        category: decision.category,
        reason: decision.reason,
        delayMs: decision.delayMs,
        status: err instanceof ApiHttpError ? err.status : undefined,
        kind,
        overloadStreak,
        remainingFallbacks,
      });
      if (decision.action === 'switch-provider') {
        throw new OverloadFailoverError({
          provider: opts.provider,
          status,
          kind,
          streak: overloadStreak,
          cause: err,
        });
      }
      if (decision.action !== 'retry') {
        throw err;
      }
      attempt++;
      if (attempt >= maxAttempts) {
        debug.log('llm.retry', 'max-attempts-exhausted', {
          provider: opts.provider,
          attempt,
        });
        throw err;
      }
      const sleepMs = decision.delayMs ?? 500;
      await sleep(sleepMs);
    }
  }
  // Unreachable — the loop always either returns or throws — but
  // satisfies the type checker.
  throw lastErr ?? new Error(`${opts.errorPrefix}: retry loop terminated unexpectedly`);
}

function rejectsReasoningField(bodyText: string): boolean {
  let message = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: unknown; param?: unknown; parameter?: unknown; field?: unknown }; message?: unknown };
    const error = parsed.error;
    const param = error?.param ?? error?.parameter ?? error?.field;
    if (typeof param === 'string') return /^reasoning(?:\.|$)/i.test(param);
    if (typeof error?.message === 'string') message = error.message;
    else if (typeof parsed.message === 'string') message = parsed.message;
  } catch { /* plain-text provider error */ }
  return /\b(?:unsupported|unknown|unrecognized|invalid)\s+(?:parameter|field|property)\s*[:'" ]*reasoning(?:\.[a-z_]+)?\b/i.test(message)
    || /\breasoning(?:\.[a-z_]+)?\s+(?:(?:field|parameter)\s+)?(?:is\s+)?(?:unsupported|unknown|invalid|not supported|not allowed)\b/i.test(message)
    || /\b(?:cannot|can't)\s+disable\s+reasoning\b/i.test(message)
    || /\breasoning\s+disable(?:d)?\s+(?:is\s+)?(?:unsupported|not supported|not allowed)\b/i.test(message);
}

async function fetchWithHeaderTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) onAbort();
  else init.signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timeoutError = new Error(`provider response header timeout after ${timeoutMs}ms`);
  timeoutError.name = 'ProviderHeaderTimeoutError';
  Object.assign(timeoutError, { code: 'ETIMEDOUT' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let handedOff = false;
  const releaseAbort = () => init.signal?.removeEventListener('abort', onAbort);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([fetch(url, { ...init, signal: controller.signal }), deadline]);
    if (!init.signal || !response.body) {
      releaseAbort();
      return response;
    }
    const reader = response.body.getReader();
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      releaseAbort();
      reader.releaseLock();
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(sink) {
        try {
          const next = await reader.read();
          if (next.done) { finish(); sink.close(); }
          else sink.enqueue(next.value);
        } catch (error) {
          finish();
          sink.error(error);
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); } finally { finish(); }
      },
    });
    handedOff = true;
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    // Rewrapping only the body must not erase fetch metadata callers may inspect.
    Object.defineProperties(wrapped, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    return wrapped;
  } catch (error) {
    if (timedOut && !init.signal?.aborted) {
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (!handedOff) releaseAbort();
  }
}

async function readErrorBody(response: Response, maxBytes: number, timeoutMs: number): Promise<{ text: string; timedOut: boolean; failed: boolean }> {
  if (!response.body) return { text: '', timedOut: false, failed: false };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); }
  catch { return { text: '', timedOut: false, failed: true }; }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timedOut = false;
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const timeout = new Error(`provider error body timeout after ${timeoutMs}ms`);
      timeout.name = 'ProviderBodyTimeoutError';
      Object.assign(timeout, { code: 'ETIMEDOUT' });
      reject(timeout);
    }, timeoutMs);
  });
  try {
    while (bytes < maxBytes) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await Promise.race([reader.read(), deadline]);
      } catch (error) {
        if (error instanceof Error && error.name === 'ProviderBodyTimeoutError') {
          timedOut = true;
          break;
        }
        if (isAbortLike(error)) throw error;
        failed = true;
        break;
      }
      if (next.done) break;
      const take = Math.min(next.value.byteLength, maxBytes - bytes);
      chunks.push(next.value.subarray(0, take));
      bytes += take;
      if (take < next.value.byteLength) break;
    }
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), timedOut, failed };
}

type OutcomeWriter = (row: { provider: string; status: number; kind: LlmCallOutcomeKind }) => void;

let outcomeWriterForTesting: OutcomeWriter | undefined;

/** Test seam. Production uses the log store. `undefined` restores it. */
export function setLlmCallOutcomeWriterForTesting(writer: OutcomeWriter | undefined): void {
  outcomeWriterForTesting = writer;
}

/** The one event launch failover is allowed to read.
 *  Category `llm.call`, event `outcome`, payload {provider,status,kind}.
 *  Written straight to the log store — `debug.log` drops the row when no
 *  sink is armed, which is the normal launch path. */
export function recordLlmCallOutcome(provider: string, status: number, kind: LlmCallOutcomeKind): void {
  const data = { provider, status, kind };
  // Trace only — a store sink would otherwise write a second `llm.call`/`outcome` row and halve the streak threshold.
  debug.log('llm.call', 'outcome-trace', data);
  if (outcomeWriterForTesting) {
    outcomeWriterForTesting(data);
    return;
  }
  if (process.env.NODE_ENV === 'test') return;
  try {
    const { getDefaultLogStore } = require('../mss/logging/log-store.js') as typeof import('../mss/logging/log-store.js');
    getDefaultLogStore()?.insertBatch([{
      rec: { ts: new Date().toISOString(), category: 'llm.call', event: 'outcome', data },
      surface: 'llm',
    }]);
  } catch {
    // A failed observation must not fail the call. Launch then sees no sample.
  }
}

function decisionEvent(action: RetryAction): string {
  // Stable category names for log filtering. The action is the most
  // useful axis ("how many turns hit retry vs abort"); the category
  // and reason ride in the snapshot.
  return action;
}

function isAbortLike(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown };
  if (e.name === 'AbortError') return true;
  if (e.code === 'ABORT_ERR' || e.code === 20) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
