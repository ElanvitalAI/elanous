// ── Retry policy + doom-loop gate (Coding Pipeline P3) ──
//
// Three primitives that the llm.ts tool loop uses to decide what to do
// when a tool call fails or when the same failure keeps repeating:
//
//   1. fingerprintError(err, toolName?) — a stable, low-cardinality
//      string identifying "this is the same error". Used to detect
//      repetition; NOT used for anything else (e.g. don't log the raw
//      error string — it may contain secrets that were already
//      redacted upstream).
//
//   2. DoomLoopTracker — remembers the last N fingerprints in a
//      sliding window. When all N slots match, .record() returns
//      'doom'. Default N=3 (matches opencode
//      packages/opencode/src/session/processor.ts:25
//      DOOM_LOOP_THRESHOLD).
//
//   3. decideRetry(err, ctx) — pure function returning a RetryDecision.
//      Policy categories modelled on codex's
//      response-debug-context (ContextWindowExceeded / QuotaExceeded /
//      RateLimit / RetryLimit) and opencode's SessionRetry
//      (retry-after parse, exponential backoff).
//
// Scope: MVP. This module does NOT:
//   - Call undo-turn to auto-revert (that integration is a follow-up
//     decision — most policies just want to abort + ask, not revert).
//   - Actually execute the retry; the caller does that with its own
//     sleep/dispatch loop. We just return the verdict as data.
//   - Intercept provider-level API errors; the llm.ts layer already
//     handles SSE reconnect. P3 focuses on the tool-loop failure
//     pattern, which is where doom loops actually originate in
//     observed traces.
//
// No dependencies on llm.ts internals — purely string + Error.

const DEFAULT_WINDOW_SIZE = 3;

/** One sliding-window slot. We keep the tool name alongside the
 *  fingerprint so a doom-loop across DIFFERENT tools (three distinct
 *  operations all throwing the same "ENOENT: /missing") counts. The
 *  fingerprint alone already incorporates tool name; this type is
 *  just documentation. */
export interface RecordedFingerprint {
  fingerprint: string;
  at: number;
}

export type DoomStatus = 'normal' | 'doom';

/** Minimal tracker: remember the last N fingerprints; emit 'doom'
 *  when all N slots are equal. Reset() empties the window (used on
 *  turn boundary or on successful tool call of the same tool). */
export class DoomLoopTracker {
  private window: RecordedFingerprint[] = [];

  constructor(private readonly windowSize: number = DEFAULT_WINDOW_SIZE) {
    if (windowSize < 2) throw new Error('DoomLoopTracker windowSize must be >= 2');
  }

  /** Append fingerprint; return 'doom' when the whole window matches. */
  record(fingerprint: string, at: number = Date.now()): DoomStatus {
    this.window.push({ fingerprint, at });
    if (this.window.length > this.windowSize) {
      this.window.shift();
    }
    if (this.window.length < this.windowSize) return 'normal';
    const allSame = this.window.every((slot) => slot.fingerprint === fingerprint);
    return allSame ? 'doom' : 'normal';
  }

  /** Empty the window — call on successful tool call of the same tool,
   *  or on turn boundary, to prevent doom-loop false positives that
   *  span unrelated failures. */
  reset(): void {
    this.window = [];
  }

  /** Inspect current window — for debug logging / assertions. */
  snapshot(): ReadonlyArray<RecordedFingerprint> {
    return [...this.window];
  }
}

/** Produce a low-cardinality, stable identifier for "same error". Uses:
 *   - tool name (if provided) to disambiguate same message from
 *     different tools
 *   - error class name (Error / TypeError / …)
 *   - normalised first-line message (collapse whitespace, lowercase,
 *     truncate to 200 chars)
 *   - specific error-code suffix when the error object exposes one
 *     (errno / code / status)
 *
 *  Never includes stack frames or variable content like file paths
 *  past the first ENOENT-style token — the goal is 'same category of
 *  problem', not 'exact bytes'. */
export function fingerprintError(err: unknown, toolName?: string): string {
  const name = errorClassName(err);
  const code = extractErrorCode(err);
  const message = normaliseMessage(extractMessage(err));
  const toolSeg = toolName ? `tool=${toolName}|` : '';
  const codeSeg = code ? `|code=${code}` : '';
  return `${toolSeg}class=${name}|msg=${message}${codeSeg}`;
}

function errorClassName(err: unknown): string {
  if (err && typeof err === 'object') {
    const ctor = (err as { constructor?: { name?: string } }).constructor;
    if (ctor?.name && ctor.name !== 'Object') return ctor.name;
  }
  return typeof err;
}

function extractMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    try {
      const m = (err as { message?: unknown }).message;
      if (typeof m === 'string' && m.length > 0) return m;
    } catch {
      // Preserve the original failure's enumerable structure when its
      // accessor-backed message cannot be read.
    }
    return serialiseFailureValue(err);
  }
  if (typeof err === 'string') return err;
  try {
    return String(err);
  } catch {
    return 'unknown';
  }
}

function serialiseFailureValue(value: object): string {
  const seen = new WeakSet<object>();
  const normalise = (entry: unknown): unknown => {
    if (typeof entry === 'bigint') return `${entry}n`;
    if (entry === null || typeof entry !== 'object') return entry;
    if (seen.has(entry)) return '[Circular]';
    seen.add(entry);
    if (Array.isArray(entry)) return entry.map(normalise);
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(entry).sort()) {
      try {
        record[key] = normalise((entry as Record<string, unknown>)[key]);
      } catch {
        record[key] = '[Unreadable]';
      }
    }
    return record;
  };
  try {
    return JSON.stringify(normalise(value));
  } catch {
    return 'unknown';
  }
}

function extractErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { code?: unknown; errno?: unknown; status?: unknown };
  if (typeof e.code === 'string' || typeof e.code === 'number') return String(e.code);
  if (typeof e.errno === 'string' || typeof e.errno === 'number') return String(e.errno);
  if (typeof e.status === 'string' || typeof e.status === 'number') return String(e.status);
  return null;
}

function normaliseMessage(msg: string): string {
  const firstLine = msg.split('\n', 1)[0] ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim().toLowerCase();
  return collapsed.slice(0, 200);
}

const NETWORK_TRANSIENT_CODES = new Set([
  'econnreset',
  'etimedout',
  'enotfound',
  'econnrefused',
  'eai_again',
]);

/** `<프로바이더> unavailable: <설정 지시>` 꼴만 문다.
 *
 *  ⛔ 첫 판은 `/\bunavailable:\s/` 였고, 그것은 프로바이더 «API 가» 내는
 *  `model unavailable: try another model` 같은 본문 오류까지 물어 과분류한다
 *  (#16667 재심 should-fix). ⇒ 콜론 뒤 «설정을 시키는 동사»까지 요구한다.
 *
 *  📏 이 세 낱말은 지어낸 것이 아니라 `src/llm.ts` 의 실제 발생원을 «세어» 나온 전수다:
 *    `unavailable: set …`(7) · `unavailable: run …`(2) · `unavailable: configure …`(2) = 11.
 *    재는 명령: `grep -o "unavailable: [a-z]*" src/llm.ts | sort | uniq -c`
 *    ⛔ 이 수는 늙는다 — 새 프로바이더가 다른 동사를 쓰면 그 낱말을 «여기» 더한다. */
function isProviderUnavailableFailure(msg: string): boolean {
  return /\bunavailable:\s+(set|run|configure)\b/.test(msg);
}

function isNetworkTransientFailure(msg: string, code: string | null): boolean {
  const codeLower = (code ?? '').toLowerCase();
  if (NETWORK_TRANSIENT_CODES.has(codeLower)) return true;
  return (
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    msg.includes('eai_again') ||
    msg.includes('fetch failed') ||
    msg.includes('socket hang up') ||
    msg.includes('unable to connect') ||
    msg.includes('is the computer able to access the url')
  );
}

const USER_CAUSED_TERMINAL_CATEGORIES: ReadonlySet<RetryCategory> = new Set([
  'context-window-exceeded',
  'safety-blocked',
  'endpoint-policy-rejection',
]);

/** User-caused failures must abort immediately — do not spend fallbacks. */
export function isUserCausedTerminalCategory(category: RetryCategory): boolean {
  return USER_CAUSED_TERMINAL_CATEGORIES.has(category);
}

/** Map a configured fallback-chain step list to concrete provider names.
 *  Unknown steps are dropped. The chain value itself is caller-supplied —
 *  this module does not bake a default chain. */
export function providerNamesFromFallbackChain(chain: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const step of chain) {
    const name = step === 'grok' ? 'grok' : step === 'codex-rotate' ? 'openai-codex' : undefined;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Provider-level fallback eligibility. Network-transient and otherwise
 * unclassified failures may advance to a remaining configured fallback.
 * User-caused terminal categories (and tool-shape errors) stop immediately.
 * `err == null` is not a provider failure — it is not eligible.
 */
/** 프로바이더를 «바꾸면 달라질 수 있는» 범주만 담는 허용목록.
 *
 *  ⛔ 블랙리스트로 쓰지 않는다 — 첫 판본이 「사용자 탓·툴 오류만 빼고 전부」였고,
 *  그러면 우리 쪽 요청 조립 버그처럼 **어느 프로바이더로 가도 똑같이 실패할** 오류가
 *  체인 전체를 돌며 각 프로바이더의 할당량을 태운다(#16667 리뷰 must-fix).
 *
 *  📌 `unknown` 을 뺐다고 이 축의 목적이 죽지 않는다 — 그 골을 부른 실물
 *  (`ECONNREFUSED`)은 이제 `network-transient` 로 «옳게 분류»되므로 여기 걸린다.
 *  즉 넓힘은 오분류를 덮던 우회로였고, 분류를 고친 지금은 필요가 없다. */
const PROVIDER_FALLBACK_ELIGIBLE_CATEGORIES: ReadonlySet<RetryCategory> = new Set([
  'network-transient',
  'provider-unavailable',
  'rate-limit',
  'quota-exceeded',
  'overloaded',
]);

export function isProviderFallbackEligible(err: unknown, category: RetryCategory = classifyError(err)): boolean {
  if (err == null) return false;
  if (isUserCausedTerminalCategory(category)) return false;
  return PROVIDER_FALLBACK_ELIGIBLE_CATEGORIES.has(category);
}

export interface ProviderFallbackAttempt {
  readonly provider: string;
  readonly category: RetryCategory;
  readonly reason: string;
}

export type ProviderFallbackTerminalVerdict = {
  action: 'stop' | 'exhaust';
  category: RetryCategory;
  attempts: readonly ProviderFallbackAttempt[];
  reason: string;
};

export type ProviderFallbackVerdict =
  | {
      action: 'advance';
      nextProvider: string;
      category: RetryCategory;
      attempts: readonly ProviderFallbackAttempt[];
    }
  | ProviderFallbackTerminalVerdict;

/** Strip credentials/tokens from a failure reason before output or ledger. */
export function sanitizeProviderFailureReason(reason: string): string {
  const { redactSecretText } = require('../debug/log.js') as typeof import('../debug/log.js');
  return redactSecretText(String(reason ?? '')).slice(0, 500);
}

/** Render stop/exhaust.reason plus sanitized attempt history for output and ledger. */
export function formatProviderFallbackOutput(verdict: ProviderFallbackTerminalVerdict): string {
  const title = verdict.action === 'stop' ? '[LLM PROVIDER STOPPED]' : '[LLM PROVIDER BLOCKED]';
  return [
    `${title} ${verdict.reason}`,
    ...verdict.attempts.map((entry) => `- ${entry.provider}: ${entry.reason}`),
  ].join('\n');
}

/**
 * Aggregated provider-fallback failure. Does not mutate the original throw
 * (frozen Error / string / undefined stay intact). Public message/stack are
 * sanitized; the original value is kept on a non-enumerable slot.
 */
export class ProviderFallbackError extends Error {
  readonly action: 'stop' | 'exhaust';
  readonly category: RetryCategory;
  readonly attempts: readonly ProviderFallbackAttempt[];
  readonly fallbackAttempts: readonly ProviderFallbackAttempt[];
  readonly verdictReason: string;
  readonly originalCause: unknown;

  constructor(verdict: ProviderFallbackTerminalVerdict, cause?: unknown) {
    super(formatProviderFallbackOutput(verdict));
    this.name = 'ProviderFallbackError';
    this.action = verdict.action;
    this.category = verdict.category;
    this.attempts = verdict.attempts;
    this.fallbackAttempts = verdict.attempts;
    this.verdictReason = verdict.reason;
    this.originalCause = cause;
    Object.defineProperty(this, 'originalCause', { value: cause, enumerable: false });
  }
}

/**
 * Bounded provider-fallback policy. Remaining configured candidates may
 * be tried for network-transient / unclassified / quota-class failures.
 * User-caused terminals stop. Exhaustion terminates and returns the
 * sanitized attempt list — never loops.
 */
export function decideProviderFallback(input: {
  err: unknown;
  failedProvider: string;
  remainingProviders: readonly string[];
  attempted?: readonly ProviderFallbackAttempt[];
}): ProviderFallbackVerdict {
  const category = classifyError(input.err);
  const reason = sanitizeProviderFailureReason(extractMessage(input.err));
  const attempts: ProviderFallbackAttempt[] = [
    ...(input.attempted ?? []),
    { provider: input.failedProvider, category, reason },
  ];
  const seen = new Set(attempts.map((entry) => entry.provider));
  if (!isProviderFallbackEligible(input.err, category)) {
    return {
      action: 'stop',
      category,
      attempts,
      reason: 'category is not provider-dependent; do not spend remaining fallbacks',
    };
  }
  const nextProvider = input.remainingProviders.find((name) => name.length > 0 && !seen.has(name));
  if (!nextProvider) {
    return {
      action: 'exhaust',
      category,
      attempts,
      reason: 'fallback candidates exhausted',
    };
  }
  return { action: 'advance', nextProvider, category, attempts };
}

/** Consecutive overload/5xx/rate-limit outcomes that switch the child off codex
 *  before the same provider spends its remaining retries. Other errors (400)
 *  never count. Recovery is this many later non-overload outcomes. */
export const OVERLOAD_FAILOVER_STREAK = 3;

export type LlmCallOutcomeKind = 'ok' | 'overloaded' | '5xx' | 'rate-limit' | 'other';

/** One finished LLM call. Launch failover reads only this shape. */
export interface LlmCallOutcome {
  readonly provider: string;
  readonly status: number;
  readonly kind: LlmCallOutcomeKind;
}

const CODEX_CALL_PROVIDERS = new Set(['codex', 'openai-codex']);

export function llmCallOutcomeKind(status: number, message = ''): LlmCallOutcomeKind {
  if (status >= 200 && status < 300) return 'ok';
  const msg = message.toLowerCase();
  if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests')) return 'rate-limit';
  if (
    status === 500 || status === 502 || status === 503 || status === 504 ||
    msg.includes('overloaded') || msg.includes('server_busy') || msg.includes('server_error')
  ) {
    return status >= 500 ? '5xx' : 'overloaded';
  }
  if (msg.includes('overloaded')) return 'overloaded';
  return 'other';
}

export function isOverloadOutcomeKind(kind: LlmCallOutcomeKind): boolean {
  return kind === 'overloaded' || kind === '5xx' || kind === 'rate-limit';
}

/** True when the newest `limit` codex outcomes are all overload-class.
 *  A non-codex row or a non-overload row breaks the streak. Empty input is false. */
export function codexOverloadStreakReached(
  outcomes: readonly LlmCallOutcome[],
  limit = OVERLOAD_FAILOVER_STREAK,
): boolean {
  if (limit < 1 || outcomes.length < limit) return false;
  const tail = outcomes.slice(-limit);
  return tail.every((row) => CODEX_CALL_PROVIDERS.has(row.provider) && isOverloadOutcomeKind(row.kind));
}

/** True when the newest `limit` outcomes are successful (any provider). */
export function overloadRecovered(
  outcomes: readonly LlmCallOutcome[],
  limit = OVERLOAD_FAILOVER_STREAK,
): boolean {
  if (limit < 1 || outcomes.length < limit) return false;
  return outcomes.slice(-limit).every((row) => row.kind === 'ok');
}

export type RetryAction = 'retry' | 'abort' | 'ask-user' | 'auto-undo' | 'switch-provider';

export interface RetryDecision {
  action: RetryAction;
  delayMs?: number;
  reason: string;
  category: RetryCategory;
}

export type RetryCategory =
  | 'context-window-exceeded'
  | 'quota-exceeded'
  | 'rate-limit'
  | 'overloaded'
  | 'network-transient'
  | 'tool-not-found'
  | 'tool-invalid-args'
  /** Endpoint-policy rejection: backend hard-rejects a request shape
   *  that the caller asked for, regardless of payload size or rate.
   *  Mirrors ref/codex `ApiError::InvalidRequest` for the specific
   *  case where the policy delta is the response itself ("store must
   *  be set to false" on chatgpt.com/backend-api/codex when caller
   *  asked for store=true). Retrying without changing the wire shape
   *  is pointless — caller must rewrite the request or fall back. */
  | 'endpoint-policy-rejection'
  /** Safety filter blocked the response. Gemini emits finishReason
   *  `SAFETY` / `BLOCKED` / `PROHIBITED_CONTENT` (Wave 1 surfaces
   *  this as a thrown Error from streamGeminiEvents). Anthropic and
   *  others flag similarly with provider-specific phrases. Retrying
   *  the same content is pointless — the user must reword OR
   *  understand that the content is policy-blocked. Action = abort
   *  with a category surface so UX can explain the rejection rather
   *  than show a generic error. */
  | 'safety-blocked'
  | 'doom-loop'
  /** 이 프로바이더가 «구성되지 않아» 쓸 수 없다 — 자격 미설정·엔드포인트 미지정.
   *  실물 문면은 전부 `<프로바이더> unavailable: <설정법>` 꼴이다
   *  (`Anthropic unavailable: configure apiKey via \`elanous setup\``).
   *  ⭐ 이것은 「사용자 탓」도 「일시적」도 아니고 **프로바이더에 매인** 실패다 —
   *  다른 프로바이더는 자격이 있을 수 있으므로 폴백이 «말이 된다».
   *  ⛔ 401/403 자격 «거부»는 여기가 아니다(그건 자격이 있는데 거절당한 것). */
  | 'provider-unavailable'
  | 'unknown';

export interface RetryContext {
  /** Attempt number — 0 = first attempt, 1 = first retry, … */
  attempt: number;
  /** Doom-loop window verdict from DoomLoopTracker.record(). When
   *  'doom' we override any retry category with an abort / ask-user. */
  doomStatus: DoomStatus;
  /** Optional: retry-after header string from a 429 response (ms or
   *  seconds or HTTP date). decideRetry parses it. */
  retryAfter?: string;
  /** Configured fallbacks still unused. When > 0, an overload-class
   *  failure that has already repeated `overloadStreak` times switches
   *  provider instead of spending another retry on the same one.
   *  Omitted or 0 keeps the historical retry-until-exhausted behaviour. */
  remainingFallbacks?: number;
  /** Consecutive overload-class failures already seen for this call,
   *  including the one under decision. Default threshold is
   *  OVERLOAD_FAILOVER_STREAK. */
  overloadStreak?: number;
  overloadStreakLimit?: number;
}

/** Classify an error into a RetryCategory without making an action
 *  decision. Mirrors ref/codex's `ApiError` enum split: classification
 *  is a pure function of the error shape, while action policy
 *  (retry / abort / ask-user) is a separate decision that may depend
 *  on attempt number, doom-loop state, etc. Callers that just need
 *  the category for telemetry / branching call this directly; full
 *  retry policy goes through `decideRetry`.
 *
 *  Excludes 'doom-loop' — that's a multi-call verdict tracked by
 *  DoomLoopTracker, not an error class. Callers that need the doom
 *  override use `decideRetry` instead. */
export function classifyError(err: unknown): RetryCategory {
  const msg = extractMessage(err).toLowerCase();
  const code = extractErrorCode(err);

  if (
    msg.includes('context window') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('prompt is too long')
  ) return 'context-window-exceeded';

  if (
    msg.includes('quota') ||
    msg.includes('free_usage_limit') ||
    // 옛 `isSwitchableProviderBlock` 정규식이 덮던 `usage.?limit` 을 여기서 보존한다.
    // 그 자를 지우고 폴백 자격을 «범주 허용목록»으로 좁혔으므로, 이 문면이
    // 'unknown' 으로 떨어지면 예전에 되던 프로바이더 전환이 조용히 사라진다.
    msg.includes('usage limit') ||
    msg.includes('usage_limit') ||
    msg.includes('billing') ||
    msg.includes('insufficient') ||
    code === '402' ||
    code === '403'
  ) return 'quota-exceeded';

  if (
    code === '429' ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  ) return 'rate-limit';

  if (
    msg.includes('overloaded') ||
    msg.includes('server_busy') ||
    msg.includes('server_error') ||
    msg.includes('an error occurred while processing your request') ||
    code === '500' ||
    code === '502' ||
    code === '503' ||
    code === '504'
  ) {
    return 'overloaded';
  }

  if (
    isNetworkTransientFailure(msg, code) ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('fetch failed') ||
    msg.includes('socket hang up')
  ) return 'network-transient';

  // 이 프로바이더가 구성되지 않아 못 쓴다 — 다른 프로바이더는 될 수 있다.
  if (isProviderUnavailableFailure(msg)) return 'provider-unavailable';

  // Endpoint policy: backend rejected the request shape itself.
  // ChatGPT subscription endpoint hard-rejects store=true; future
  // additions (region restriction, model deprecation, feature gate)
  // belong here too. Specific over general — must come before the
  // generic invalid-args check since the message also contains
  // "must" / "invalid".
  if (
    msg.includes('store must be set') ||
    msg.includes('endpoint does not support')
  ) return 'endpoint-policy-rejection';

  // Safety filter (Gemini SAFETY/BLOCKED/PROHIBITED_CONTENT, Anthropic
  // safety filter, OpenAI moderation). Wave 1 streamGeminiEvents
  // throws with "Gemini safety filter blocked content (finishReason=
  // SAFETY; ...)" — match on multiple phrasings so other providers'
  // analogous events also classify here.
  if (
    msg.includes('safety filter blocked') ||
    msg.includes('finishreason=safety') ||
    msg.includes('finishreason=blocked') ||
    msg.includes('prohibited_content') ||
    msg.includes('content_filter') ||
    msg.includes('content blocked by safety')
  ) return 'safety-blocked';

  if (msg.includes('no toolruntime registered')) return 'tool-not-found';

  if (msg.includes('invalid argument') || msg.includes('required') || msg.includes('validation')) {
    return 'tool-invalid-args';
  }

  return 'unknown';
}

function isOverloadSwitchCandidate(msg: string, code: string | null): boolean {
  return (
    code === '429' || code === '500' || code === '502' || code === '503' || code === '504' ||
    msg.includes('rate limit') || msg.includes('too many requests') ||
    msg.includes('overloaded') || msg.includes('server_busy') || msg.includes('server_error')
  );
}

function overloadSwitchDecision(ctx: RetryContext): RetryDecision | undefined {
  const remaining = ctx.remainingFallbacks ?? 0;
  if (remaining <= 0) return undefined;
  const limit = ctx.overloadStreakLimit ?? OVERLOAD_FAILOVER_STREAK;
  const streak = ctx.overloadStreak ?? 1;
  if (streak < limit) return undefined;
  return {
    action: 'switch-provider',
    category: 'overloaded',
    reason: `overload streak ${streak} with ${remaining} fallback(s) left; switch before spending retries`,
  };
}

/** Pure verdict. Caller sleeps + retries or aborts per the returned
 *  action. Exponential backoff baseline: 500ms * 2^attempt, clamped
 *  to [500, 30_000]. */
export function decideRetry(err: unknown, ctx: RetryContext): RetryDecision {
  const msg = extractMessage(err).toLowerCase();
  const code = extractErrorCode(err);

  // Overload with a fallback still unused switches before the doom
  // window (k === 3) turns the same 503 into auto-undo. A 400 is not
  // a candidate. Doom still wins for every other repeated failure.
  if (isOverloadSwitchCandidate(msg, code)) {
    const switched = overloadSwitchDecision(ctx);
    if (switched) return switched;
  }

  // Doom-loop always wins — even a technically-retryable error
  // becomes auto-undo after N identical failures. The caller may
  // still degrade to ask-user when plan mode is active or when the
  // undo operation itself fails.
  if (ctx.doomStatus === 'doom') {
    return {
      action: 'auto-undo',
      category: 'doom-loop',
      reason: `same error fingerprint repeated ${DEFAULT_WINDOW_SIZE} times; stop retrying and auto-revert the last turn before entering repair mode`,
    };
  }

  // Context window exhausted — never retry (the next call will also
  // be over-sized). Abort and surface the error to the caller; upstream
  // can trigger compaction.
  if (
    msg.includes('context window') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('prompt is too long')
  ) {
    return {
      action: 'abort',
      category: 'context-window-exceeded',
      reason: 'context window exceeded; retrying would hit the same limit',
    };
  }

  // Quota/credit exhausted — ask user (can't self-resolve).
  if (
    msg.includes('quota') ||
    msg.includes('free_usage_limit') ||
    // 옛 `isSwitchableProviderBlock` 정규식이 덮던 `usage.?limit` 을 여기서 보존한다.
    // 그 자를 지우고 폴백 자격을 «범주 허용목록»으로 좁혔으므로, 이 문면이
    // 'unknown' 으로 떨어지면 예전에 되던 프로바이더 전환이 조용히 사라진다.
    msg.includes('usage limit') ||
    msg.includes('usage_limit') ||
    msg.includes('billing') ||
    msg.includes('insufficient') ||
    code === '402' ||
    code === '403'
  ) {
    return {
      action: 'ask-user',
      category: 'quota-exceeded',
      reason: 'quota or billing limit reached; requires user action',
    };
  }

  // Rate limit — respect retry-after, else exponential backoff.
  if (
    code === '429' ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  ) {
    const delayMs = parseRetryAfter(ctx.retryAfter) ?? backoffMs(ctx.attempt);
    return {
      action: 'retry',
      delayMs,
      category: 'rate-limit',
      reason: 'rate-limited; backing off and retrying',
    };
  }

  // Overloaded / server busy / 5xx.
  if (
    msg.includes('overloaded') ||
    msg.includes('server_busy') ||
    msg.includes('server_error') ||
    code === '500' ||
    code === '502' ||
    code === '503' ||
    code === '504'
  ) {
    return {
      action: 'retry',
      delayMs: backoffMs(ctx.attempt),
      category: 'overloaded',
      reason: 'provider overloaded; backing off and retrying',
    };
  }

  // Transient network.
  if (
    isNetworkTransientFailure(msg, code) ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('fetch failed') ||
    msg.includes('socket hang up')
  ) {
    return {
      action: 'retry',
      delayMs: backoffMs(ctx.attempt),
      category: 'network-transient',
      reason: 'transient network error; backing off and retrying',
    };
  }

  // 프로바이더 미구성 — 같은 프로바이더로 다시 걸어도 결과가 같다.
  // 재시도가 아니라 «다른 프로바이더»가 답이므로 중단하고 위로 올린다.
  if (isProviderUnavailableFailure(msg)) {
    return {
      action: 'abort',
      category: 'provider-unavailable',
      reason: 'provider is not configured; retrying the same provider cannot help',
    };
  }

  // Endpoint-policy rejection — backend hard-rejected the wire shape
  // (e.g. store=true on chatgpt.com/backend-api/codex). Retrying with
  // the same payload will hit the same rejection. Abort so upstream
  // can rewrite the request (or, in the codex provider, the
  // endpoint-aware fallback already short-circuited this — we
  // shouldn't even hit this case in normal flows; surfaces an
  // unexpected policy edge.)
  if (
    msg.includes('store must be set') ||
    msg.includes('endpoint does not support')
  ) {
    return {
      action: 'abort',
      category: 'endpoint-policy-rejection',
      reason: 'endpoint rejected the request shape; retrying without rewriting it will fail again',
    };
  }

  // Safety filter — model refused to produce output for policy
  // reasons. Retrying the same prompt will fire the same filter.
  // Abort with a clear category so the UX layer can explain "the
  // model declined to answer" instead of showing a generic error.
  if (
    msg.includes('safety filter blocked') ||
    msg.includes('finishreason=safety') ||
    msg.includes('finishreason=blocked') ||
    msg.includes('prohibited_content') ||
    msg.includes('content_filter') ||
    msg.includes('content blocked by safety')
  ) {
    return {
      action: 'abort',
      category: 'safety-blocked',
      reason: 'model declined to answer due to safety/policy filter; reword the prompt or explain the rejection',
    };
  }

  // Tool-level: wrong name — doesn't get better by retrying. Abort
  // so upstream falls back to the legacy direct-dispatch or surfaces
  // the error to the LLM.
  if (msg.includes('no toolruntime registered')) {
    return {
      action: 'abort',
      category: 'tool-not-found',
      reason: 'tool not registered; retry will not help',
    };
  }

  // Schema / argument error — retrying identical args is pointless;
  // the LLM needs to see the error to re-plan.
  if (msg.includes('invalid argument') || msg.includes('required') || msg.includes('validation')) {
    return {
      action: 'abort',
      category: 'tool-invalid-args',
      reason: 'argument validation error; surface to LLM so it re-plans',
    };
  }

  // Unknown — single retry with short backoff. If it fails again the
  // doom-loop tracker catches it at the next record().
  return {
    action: ctx.attempt === 0 ? 'retry' : 'abort',
    delayMs: ctx.attempt === 0 ? backoffMs(0) : undefined,
    category: 'unknown',
    reason:
      ctx.attempt === 0
        ? 'unclassified error; one speculative retry'
        : 'unclassified error and first retry already spent; abort',
  };
}

/** Parse a retry-after header. Accepts:
 *   - "120"                 → 120 seconds
 *   - "120000ms"            → 120_000 ms
 *   - "Wed, 21 Oct 2015 …"  → delta in ms from now
 *   Returns null when unparseable. */
export function parseRetryAfter(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // ms suffix.
  if (/^\d+ms$/i.test(trimmed)) {
    const n = Number.parseInt(trimmed.slice(0, -2), 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 0), 300_000) : null;
  }
  // Pure integer: seconds.
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n)) return null;
    return Math.min(Math.max(n * 1000, 0), 300_000);
  }
  // HTTP-date.
  const ts = Date.parse(trimmed);
  if (!Number.isFinite(ts)) return null;
  const delta = ts - Date.now();
  if (delta <= 0) return 0;
  return Math.min(delta, 300_000);
}

/** Exponential backoff with jitter — 500 * 2^attempt, clamped
 *  [500, 30_000], ±10% jitter. */
export function backoffMs(attempt: number): number {
  const base = 500 * Math.pow(2, Math.max(0, attempt));
  const clamped = Math.min(base, 30_000);
  const jitter = clamped * 0.1 * (Math.random() * 2 - 1);
  return Math.max(500, Math.round(clamped + jitter));
}
