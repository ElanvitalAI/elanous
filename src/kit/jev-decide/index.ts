// KIT jev-decide — the ONE way elanous asks Jev (Typesafe System One, the decision model) a closed question
// (JEV-DECIDE-KIT · 0.3.39 P0 · 대표 11-27 22:4x «jev 다른 데도» · 체질 기둥 «공용화 루틴 · 사본 금지»).
//
// S: three sites carried their own copy of the plumbing (decide/boundary-shadow · memory-triage/jev-adapter ·
//    kit/mail-route/hand-classifier): access resolution, timeout + abort, redaction, egress rule, usage row. Each folded a
//    402 into null and asked again on the next call; most Jev calls logged no site.
// A: a site = a row in graphs/policies/jev-sites.yaml (questions · threshold · timeout · audience · usage site); a caller
//    hands the kit its state and gets the response or a named fallback reason. Built in for every site:
//      · state redaction before send ({@link maskJevState} — structured secret keys ⊕ free-text credentials)
//      · egress: `member` state goes only to a loopback endpoint (IP literal · checked before the key file is opened ·
//        redirects refused)
//      · 402 circuit breaker: N min of fallback for every site/process ⊕ ONE OP card per outage · 429 short backoff
//      · one `jev.decide` line with `usageSite` on EVERY call (ok or not) ⊕ an `llm.usage` row (providerName typesafe)
//
// 세 얼굴: 관측 = `jev.decide call {usageSite, ok, reason?, status?, ms, model?}` ⊕ `llm.usage` ⊕ the breaker card ·
// 판단 근거 = Jev probabilities (the caller reads them against the site's YAML threshold) · 수복과 인계 = `{ok:false, reason}`
// → the caller's own fallback (rules · keyword · old rung); never throws, never blocks.
import { isIP } from 'node:net';
import { debug, redactSecretText } from '../../debug/log.js';
import { JEV_ENDPOINT, callJev, type JevAccess, type JevQuestion, type JevRequest, type JevResponse } from '../../decide/jev.js';
import { liveJevBreaker, memoryJevBreaker, type JevBreaker } from './breaker.js';
import { jevSite, readJevSites, type JevAudience, type JevSite, type JevSitesTable } from './sites.js';

export * from './sites.js';
export * from './breaker.js';

// ── redaction ──────────────────────────────────────────────────────────────────────────────────────────────────────

const MASK = '[REDACTED]';
const SECRET_KEY = /(?:authorization|api[-_]?key|password|passwd|secret|private[-_]?key|(?:access|refresh|session|bot)[-_]?token|token|cookie|credentials)/i;

/** Remove credentials from structured fields (secret-named keys) and free text (bearer · key=value · URL creds · shell
 *  flags · cookies) — recursively, without touching the input. Every Jev state passes through this before send. */
export function maskJevState(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return redactSecretText(value)
      .replace(/\bBearer\s+[^\s"']+/gi, `Bearer ${MASK}`)
      .replace(/("(?:api[-_]?key|password|secret|token|authorization)"\s*:\s*")[^"]*(")/gi, `$1${MASK}$2`)
      .replace(/\b((?:api[-_]?key|password|secret|token|authorization)\s*[:=]\s*)[^\s,"'}]+/gi, `$1${MASK}`)
      .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, MASK)
      // shell-argument shapes (2026-09-28 leak probe): URL credentials · -u user:secret · --token value (space or =) · cookies.
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@'"]+:[^/\s@'"]+@/gi, `$1${MASK}@`)
      .replace(/(\s(?:-u|--user)(?:\s+|=))(['"]?)[^\s'"]+\2/g, `$1${MASK}`)
      .replace(/(\s--?(?:[a-z0-9]+-)*(?:token|api-?key|apikey|password|passwd|secret|auth|cookie|credentials?)(?:\s+|=))(['"]?)[^\s'"]+\2/gi, `$1${MASK}`)
      .replace(/(\s(?:-b|--cookie)\s+)(['"]?)[^'"]*\2/g, `$1${MASK}`);
  }
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '<circular>';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => maskJevState(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const sensitiveKey = SECRET_KEY.test(key);
    return [sensitiveKey ? MASK : maskJevState(key), sensitiveKey ? MASK : maskJevState(item, seen)];
  }));
}

// ── egress ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Is the endpoint this machine? IP literals only (127.0.0.0/8 · ::1) — a name (even `localhost`) can resolve elsewhere. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
    const family = isIP(host);
    if (family === 6) return host === '::1';
    if (family === 4) return host.split('.')[0] === '127';
    return false;
  } catch { return false; }
}

/** May this audience's state go to `endpoint`? HQ seat state: yes · member state: loopback only. */
export function jevEgressAllowed(audience: JevAudience, endpoint: string): boolean {
  return audience === 'hq-seat' || isLoopbackEndpoint(endpoint);
}

// ── access ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `decide.endpoint` / `decide.keyFile` / `decide.model` — user config, or a caller's own config (boundary shadow). */
export interface JevAccessConfig { endpoint?: unknown; keyFile?: unknown; model?: unknown }

function readDecideConfig(): JevAccessConfig | undefined {
  try {
    const { getUserConfig } = require('../../user-config.js') as typeof import('../../user-config.js');
    const raw = getUserConfig().raw.decide;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as JevAccessConfig : undefined;
  } catch { return undefined; }
}

/** Where a call would go, without opening any key file (egress is judged before credentials are read). */
export function peekJevEndpoint(config: JevAccessConfig | undefined = readDecideConfig()): string {
  const configured = config?.endpoint;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  return process.env.ELANOUS_JEV_ENDPOINT?.trim() || JEV_ENDPOINT;
}

/** Endpoint ⊕ key ⊕ model as `elanous decide` resolves them (decide.* > ELANOUS_JEV_* > Typesafe ⊕ TYPESAFE_API_KEY / cache). */
export function resolveLiveJevAccess(config: JevAccessConfig | undefined = readDecideConfig()): { ok: true; access: JevAccess } | { ok: false } {
  const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
  const { homedir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  const { resolveJevAccess } = require('../../decide/jev.js') as typeof import('../../decide/jev.js');
  const expand = (path: string): string => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
  const resolved = resolveJevAccess({
    ...(config ? { config } : {}),
    env: process.env,
    readFile: (path) => { const file = expand(path); try { return existsSync(file) ? readFileSync(file, 'utf8') : undefined; } catch { return undefined; } },
    typesafeCachePath: join(homedir(), '.cache', 'typesafe_api_key'),
  });
  return resolved.ok ? { ok: true, access: resolved.access } : { ok: false };
}

// ── the call ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type JevDecideFailure =
  | 'egress-not-allowed' | 'endpoint-unavailable' | 'no-key' | 'no-question'
  | 'breaker-open' | 'credit-exhausted' | 'rate-limited'
  | 'timeout' | 'request-failed' | 'no-live-in-test';

export type JevDecideResult =
  | { readonly ok: true; readonly response: JevResponse; readonly model: string; readonly ms: number; readonly site: JevSite }
  | { readonly ok: false; readonly reason: JevDecideFailure; readonly status?: number; readonly ms: number; readonly site: JevSite };

/** The OP card the breaker raises once per 402 outage. Returns the card id (or null when it could not be written). */
export interface JevBreakerCard { readonly to: string; readonly body: string; readonly refs: readonly string[]; readonly provenanceKey: string }

export interface JevDecideDeps {
  /** Endpoint without credentials (egress check). Default = {@link peekJevEndpoint}. */
  peekEndpoint?: () => string;
  /** Endpoint ⊕ key ⊕ model. Default = {@link resolveLiveJevAccess}. */
  resolveAccess?: () => { ok: true; access: JevAccess } | { ok: false };
  /** The HTTP client (default `callJev` of src/decide/jev.ts). */
  callJev?: (request: JevRequest, key: string | undefined, fetchImpl: typeof fetch, endpoint: string) => Promise<JevResponse>;
  fetch?: typeof fetch;
  /** A whole transport (tests · sims): skips endpoint, credentials and egress (the transport owns where it goes). */
  transport?: (request: JevRequest, signal: AbortSignal) => Promise<JevResponse>;
  /** Usage row writer. Default = llm.ts logAgentTurnUsage(providerName typesafe · role classify · site usageSite). */
  logUsage?: (model: string, usage: { inputTokens?: number; outputTokens?: number }, usageSite: string) => void;
  /** The per-call `jev.decide` line. Default = debug.log. */
  log?: (event: string, data: Record<string, unknown>) => void;
  breaker?: JevBreaker;
  /** Card writer. Default (live only) = the msg ledger, idempotent by provenance key. */
  postCard?: (card: JevBreakerCard) => number | null;
  now?: () => number;
  /** Site table (default = {@link readJevSites}). */
  table?: JevSitesTable;
}

export interface JevDecideInput {
  /** Site id (a jev-sites.yaml row) or a resolved row. */
  readonly site: string | JevSite;
  readonly state: unknown;
  readonly questions: Record<string, JevQuestion>;
  /** Override the site's audience for this call (e.g. a memory write whose session is a member's). */
  readonly audience?: JevAudience;
  /** Override the site's timeout (a routing table that owns its own timeout · tests). */
  readonly timeoutMs?: number;
  /** A caller's own access config (decide.* shape) instead of the user config — the boundary shadow's config block. */
  readonly accessConfig?: JevAccessConfig;
  readonly signal?: AbortSignal;
}

const underTest = (): boolean => process.env.BUN_TEST !== undefined || process.env.NODE_ENV === 'test';

/** HTTP status of a callJev failure (JevHttpError.status, or the «Jev HTTP <n>» message prefix). */
export function jevErrorStatus(error: unknown): number | undefined {
  const s = (error as { status?: unknown } | null)?.status;
  if (typeof s === 'number') return s;
  const m = /^Jev HTTP (\d{3})\b/u.exec(error instanceof Error ? error.message : String(error));
  return m ? Number(m[1]) : undefined;
}

function defaultLogUsage(model: string, usage: { inputTokens?: number; outputTokens?: number }, usageSite: string): void {
  void import('../../llm.js').then(({ logAgentTurnUsage }) => {
    try { logAgentTurnUsage(model, usage, { providerName: 'typesafe', site: usageSite, role: 'classify' }); } catch { /* observation only */ }
  }).catch(() => { /* observation only */ });
}

/** A card writer over the msg ledger at `path` (default = the instance ledger). Idempotent by the card's provenance key:
 *  a second process carding the same outage episode gets the same row. Returns null when the write failed. */
export function msgLedgerCardPoster(path?: string): (card: JevBreakerCard) => number | null {
  return (card) => {
    try {
      const { openMsgStore, defaultMsgStorePath } = require('../../msg/msg-store.js') as typeof import('../../msg/msg-store.js');
      const store = openMsgStore(path ?? defaultMsgStorePath());
      try {
        return store.appendWithProvenance({ from: 'JEV-DECIDE', to: card.to, kind: 'request', intent: 'decision', priority: 1, refs: [...card.refs], body: card.body }, card.provenanceKey).id;
      } finally { store.close(); }
    } catch { return null; }
  };
}

/** The card text — what happened, what each site does meanwhile, what fixes it. */
export function jevCreditCardBody(input: { endpoint: string; usageSite: string; cooldownMs: number; openUntil: number }): string {
  const minutes = Math.round(input.cooldownMs / 60_000);
  let host = input.endpoint;
  try { host = new URL(input.endpoint).host; } catch { /* keep raw */ }
  return `[Jev · 402 크레딧 소진] ${host} 가 402(크레딧 없음)를 돌려줬다 — 키 문제가 아니다. `
    + `${minutes}분 동안 모든 Jev 사이트가 호출을 멈추고 각자 폴백으로 간다(처음 맞은 사이트: ${input.usageSite} · 재시도 ${new Date(input.openUntil).toISOString()}). `
    + '충전: console.typesafe.ai/settings/billing (auto-reload 는 돈 결정 → 👑). 충전 뒤엔 차단이 끝나는 첫 호출이 시험 호출이 되어 저절로 다시 열린다. '
    + '같은 장애가 이어지는 동안 이 카드는 다시 오지 않는다.';
}

/**
 * Ask Jev one request for a site. Never throws: `{ok:false, reason}` = take your fallback.
 * Order: site row → egress (before the key file) → breaker → credentials → redact → call (timeout + abort · no redirects)
 * → breaker bookkeeping (402 card once · 429 backoff · success closes) → usage row → one `jev.decide` line.
 */
export async function jevDecide(input: JevDecideInput, deps: JevDecideDeps = {}): Promise<JevDecideResult> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  let site: JevSite;
  try { site = typeof input.site === 'string' ? jevSite(input.site, deps.table ?? readJevSites()) : input.site; }
  catch { site = { id: String(input.site), usageSite: String(input.site), audience: 'member', timeoutMs: 5_000, threshold: 0.9, questions: {}, params: {}, declared: false }; }
  const audience = input.audience ?? site.audience;
  const injected = Boolean(deps.transport || deps.callJev || deps.fetch);
  const breaker = deps.breaker ?? (injected ? memoryJevBreaker() : liveJevBreaker());
  const note = (data: Record<string, unknown>): void => {
    try { (deps.log ?? ((event, d) => debug.log('jev.decide', event, d)))('call', { usageSite: site.usageSite, site: site.id, audience, ...data }); } catch { /* observation is fail-open */ }
  };
  const fail = (reason: JevDecideFailure, extra: { status?: number; endpoint?: string } = {}): JevDecideResult => {
    const ms = now() - t0;
    note({ ok: false, reason, ms, ...(extra.status !== undefined ? { status: extra.status } : {}) });
    return { ok: false, reason, ms, site, ...(extra.status !== undefined ? { status: extra.status } : {}) };
  };

  if (Object.keys(input.questions).length === 0) return fail('no-question');
  if (!injected && underTest()) return fail('no-live-in-test');

  // Where it goes (transport = the caller's own seam: no endpoint, no key, no egress judgement here).
  let endpoint = 'transport';
  let access: JevAccess | undefined;
  if (!deps.transport) {
    try { endpoint = (deps.peekEndpoint ?? (() => peekJevEndpoint(input.accessConfig ?? readDecideConfig())))(); }
    catch { return fail('endpoint-unavailable'); }
    if (!jevEgressAllowed(audience, endpoint)) return fail('egress-not-allowed');
  }
  try { if (breaker.check(endpoint, now())) return fail('breaker-open'); } catch { /* a broken breaker never blocks */ }
  if (!deps.transport) {
    try {
      const resolved = (deps.resolveAccess ?? (() => resolveLiveJevAccess(input.accessConfig ?? readDecideConfig())))();
      if (!resolved.ok) return fail('no-key');
      access = resolved.access;
    } catch { return fail('no-key'); }
    // The key read can see a different endpoint (config race) — judge egress again on the real target.
    if (!jevEgressAllowed(audience, access.endpoint)) return fail('egress-not-allowed');
    endpoint = access.endpoint;
  }

  const request: JevRequest = { state: maskJevState(input.state), questions: input.questions, ...(access?.model ? { model: access.model } : {}) };
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  input.signal?.addEventListener('abort', onOuterAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMEOUT = 'jev-decide-timeout';
  // ⛔ no redirects — the egress judgement is about ONE target (a loopback server must not forward member state).
  const fetchWithAbort = ((url: RequestInfo | URL, init?: RequestInit) => (deps.fetch ?? fetch)(url, { ...init, signal: controller.signal, redirect: 'error' })) as typeof fetch;
  try {
    const response = await Promise.race([
      deps.transport ? deps.transport(request, controller.signal)
        : (deps.callJev ?? callJev)(request, access?.key, fetchWithAbort, endpoint),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error(TIMEOUT)); controller.abort(); }, input.timeoutMs ?? site.timeoutMs);
      }),
    ]);
    try { breaker.reset(endpoint); } catch { /* fail-open */ }
    const model = typeof response?.model === 'string' && response.model ? response.model : 'jev-unknown';
    if (response?.usage) {
      try { (deps.logUsage ?? defaultLogUsage)(model, { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }, site.usageSite); }
      catch { /* usage observation never changes a decision */ }
    }
    const ms = now() - t0;
    note({ ok: true, ms, model, inputTokens: response?.usage?.input_tokens ?? null });
    return { ok: true, response, model, ms, site };
  } catch (error) {
    if (error instanceof Error && error.message === TIMEOUT) return fail('timeout');
    const status = jevErrorStatus(error);
    if (status === 402 || status === 429) {
      const table = deps.table ?? readJevSites();
      const cooldownMs = status === 402 ? table.breaker.creditCooldownMs : table.breaker.rateLimitCooldownMs;
      try {
        const trip = breaker.trip(endpoint, status === 402 ? 'credit' : 'rate-limit', now(), cooldownMs);
        if (status === 402 && trip.firstInEpisode) {
          const card: JevBreakerCard = {
            to: table.breaker.cardTo,
            body: jevCreditCardBody({ endpoint, usageSite: site.usageSite, cooldownMs, openUntil: trip.openUntil }),
            refs: ['jev-credit-402', `jev-breaker:${trip.episode}`],
            provenanceKey: `jev-credit-402:${trip.episode}`,
          };
          let cardId: number | null = null;
          try { cardId = (deps.postCard ?? (injected ? () => null : msgLedgerCardPoster()))(card); } catch { cardId = null; }
          note({ ok: false, reason: 'credit-exhausted', event: 'breaker-open', episode: trip.episode, cooldownMs, cardId });
        }
      } catch { /* a broken breaker never blocks */ }
      return fail(status === 402 ? 'credit-exhausted' : 'rate-limited', { status });
    }
    return fail('request-failed', status !== undefined ? { status } : {});
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** The top choice of a choice answer (max probability; a bare `choice` counts as 1). Pure. */
export function jevTopChoice(answer: { probabilities?: Record<string, number>; choice?: string } | undefined): { word: string | null; p: number } {
  const probs = answer?.probabilities ?? (answer?.choice ? { [answer.choice]: 1 } : {});
  let word: string | null = null; let p = 0;
  for (const [w, v] of Object.entries(probs)) if (typeof v === 'number' && Number.isFinite(v) && v > p) { word = w; p = v; }
  return { word, p };
}
