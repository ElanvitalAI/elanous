// H6 P1 Bundle 1 · Codex usage fetcher.
//
// Uses the official `codex app-server` JSON-RPC protocol (now documented
// at developers.openai.com/codex/app-server · omni-crawl 2026-04-22).
// Elanous already ships `CodexAppServerClient` + `spawnCodexAppServer`
// for H4 P3.B · we reuse that plumbing rather than respawning a fresh
// SDK child on every refresh.
//
// Response shape — ⭐ **실측 2026-08-05** (⛔ 문서가 아니라 응답이 계약이다 · `R-LLM1`).
// canonical = 내부 문서 `MANUAL-llm-provider-operations-2026-08-05` §1
//   {
//     "rateLimits": {
//       "limitId": "codex", "limitName": null,
//       "primary":   { "usedPercent": 100, "windowDurationMins": 10080, "resetsAt": 1786163948 },
//       "secondary": null,
//       "credits": { "hasCredits": true, "unlimited": false, "balance": "3772.79" },
//       "planType": "pro", "rateLimitReachedType": "rate_limit_reached"
//     },
//     "rateLimitsByLimitId": { "codex": {…}, "codex_bengalfox": { "limitName": "GPT-5.3-Codex-Spark", … } },
//     "rateLimitResetCredits": { … }        ← 별도 모듈: src/budget/codex-reset-credits.ts
//   }
//
// ⛔⛔ **옛 주석은 「primary = session(5h) · secondary = weekly」라 «자리»로 못 박았는데 틀렸다** —
//   실물 primary 는 **주간(10080분)** 이었고 secondary 는 null 이었다. 그래서 지금은 «창 길이»로
//   종류를 유도한다(`windowKindOf`). ⊕ 주석에 아예 없던 필드가 여덟이었다.
//
// Fetcher lifecycle: spawn → initialize → call → close. Each refresh
// is a fresh spawn (~200ms) · CodexBar's long-lived app-server actor
// pattern is Bundle 2 — the cost of spawn is negligible compared to
// the 15m default refresh cadence.

import { spawnCodexAppServer, type SpawnCodexAppServerOpts } from '../../acp/codex-app-server-client.js';
import { resolveBundledCodexPath } from '../../acp/codex-auth.js';
import { debug } from '../../debug/log.js';
import { writeQuotaSignal, type QuotaSignalStorageOpts } from '../codex-reset-credit-state.js';
import type { ProviderFetcher } from '../usage-store.js';
import type { RateWindow, UsageProvider, UsageSnapshot, WindowKind } from '../types.js';

// ─── Raw JSON-RPC shapes ─────────────────────────────────────────────

interface RateLimitsRead {
  rateLimits?: RateLimitsBucket;
  /** ⭐ 모델별 서브리밋 — 브랜드 총량과 «따로» 찬다(실측 2026-08-05). */
  rateLimitsByLimitId?: Record<string, RateLimitsBucket | null>;
  // Lenient · OpenAI has been known to add fields mid-series (e.g.
  // `plan_type: "prolite"` per CodexBar Issue #709).
  [k: string]: unknown;
}

interface RateLimitsBucket {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitsWindow | null;
  secondary?: RateLimitsWindow | null;
  credits?: RateLimitsCredits | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
  [k: string]: unknown;
}

interface RateLimitsCredits {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: string | number;
  [k: string]: unknown;
}

interface RateLimitsWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
  [k: string]: unknown;
}

interface InitializeResult {
  // We don't need any fields from initialize — we just need to wait
  // for the server to ack before issuing the real request.
  [k: string]: unknown;
}

// ─── Public API ──────────────────────────────────────────────────────

export interface CodexFetcherOpts {
  /** Override binary path (tests · or users with custom codex install). */
  readonly codexBinary?: string;
  /** Override spawn args — default `['app-server']`. */
  readonly codexArgs?: readonly string[];
  /** Per-request timeout for initialize + rateLimits/read. Default 30s. */
  readonly requestTimeoutMs?: number;
  /** Test seam — replace the spawn step with a user-supplied factory
   *  that returns a Promise<RateLimitsRead>. Production path always
   *  shells out to the real binary. */
  readonly fetchImpl?: () => Promise<RateLimitsRead>;
  /** ⭐⭐ «어느 계정»을 재나 — 그 계정의 CODEX_HOME.
   *  ⛔ 생략하면 지금 환경의 홈(종전 동작 그대로 · 기본 계정).
   *  측정은 `codex app-server` 가 «그 홈»의 auth.json 으로 하므로, 계정별로 재려면
   *  이 값을 자식 env 에 실어야 한다 — 부모 env 를 바꾸는 것이 «아니다»
   *  (전역 오염 금지 · 47차 규율). 그리고 신호도 이 홈으로 키가 갈린다. */
  readonly codexHome?: string;
  /** Explicit quota-signal storage for isolated callers; omitted production calls share the credential root. */
  readonly quotaSignalStorage?: QuotaSignalStorageOpts;
  /** Cancels the app-server child when the caller's bounded refresh expires. */
  readonly signal?: AbortSignal;
  /** ⛔ 테스트 심 — 프로덕션 경로는 «항상» 기본값이다(같은 파일의 `fetchImpl` 과 같은 규약).
   *  ⭐ 왜 `fetchImpl` 로 대신 못 무나: `fetchImpl` 은 spawn 단계를 «통째로» 건너뛰므로
   *  ***자식이 abort 때 실제로 정리되는지***를 원리상 못 문다. 이 심이 무는 것은 그 하나다.
   *  ⛔ 그 외의 용도로 넓히지 않는다 — 넓히면 테스트 표면이 장기 API 로 굳는다(리뷰 should-fix). */
  readonly spawnImpl?: typeof spawnCodexAppServer;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createCodexFetcher(opts: CodexFetcherOpts = {}): ProviderFetcher {
  return {
    async fetch(): Promise<UsageSnapshot> {
      const raw = opts.fetchImpl
        ? await opts.fetchImpl()
        : await fetchViaAppServer(opts);
      const snapshot = mapSnapshot(raw);
      // ⭐ 판정층은 이 «파일»만 읽는다 — 프로세스 안 store 는 TUI 에서만 채워지므로
      //   headless 하니스 런에서는 «영영 비어» 있다(1R 이 냄새를 맡은 자리).
      // ⛔⭐⭐ 그리고 «어느 홈을 잰 것인가»를 같이 넘긴다 — 계정이 여럿이 된 뒤로
      //   신호 하나에 뭉개면 A 의 「찼다」를 B 의 것으로 읽는다.
      const usedPercent = snapshot.windows
        .filter((window) => window.model === undefined)
        .reduce<number | undefined>((max, window) => max === undefined || window.used > max ? window.used : max, undefined);
      writeQuotaSignal(snapshot.rateLimitReached, usedPercent, opts.codexHome, opts.quotaSignalStorage,
        snapshot.credits ? { balance: snapshot.credits.balance, hasCredits: snapshot.credits.hasCredits } : undefined);
      return snapshot;
    },
  };
}

// ─── Real spawn path ─────────────────────────────────────────────────

async function fetchViaAppServer(opts: CodexFetcherOpts): Promise<RateLimitsRead> {
  // ⛔⭐⭐ 이미 끊겼으면 «띄우지도 않는다»(리뷰 should-fix). 종전엔 abort 된 signal 로도
  //   app-server 를 spawn 하고 initialize 까지 보낸 뒤 죽였다 — ***상한을 지키자는 이 변경이
  //   정작 「상한 뒤에 프로세스를 띄우는」 자리를 남겨 뒀다.*** 자식 spawn 은 공짜가 아니다.
  if (opts.signal?.aborted) throw new Error('codex usage fetch aborted before spawn');
  const binary = opts.codexBinary ?? resolveBundledCodexPath() ?? 'codex';
  const spawnOpts: SpawnCodexAppServerOpts = {
    codexBinary: binary,
    codexArgs: opts.codexArgs ?? ['app-server'],
    requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    // ⛔⭐ 계정별 측정은 «자식 env»로만 한다 — process.env 를 바꾸지 않는다.
    //   부모 env 를 만지면 같은 프로세스의 다른 경로(미러 쓰기!)가 함께 끌려간다.
    ...(opts.codexHome ? { env: { CODEX_HOME: opts.codexHome } } : {}),
  };
  const spawned = (opts.spawnImpl ?? spawnCodexAppServer)(spawnOpts);
  // ⛔⭐ 자식은 «한 번만» 죽인다(리뷰 should-fix → 실측하니 실제로 두 번이었다).
  //   abort 리스너가 한 번, 아래 finally 의 정리가 또 한 번 불렀다. 두 번째는 try/catch 라
  //   무해했지만, 계약이 흐려지면 「리스너가 두 번 붙었다」 같은 진짜 회귀를 못 잡는다.
  let killedOnce = false;
  const abort = (): void => {
    if (killedOnce) return;
    killedOnce = true;
    try { spawned.child.kill(); } catch { /* best-effort */ }
  };
  opts.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (opts.signal?.aborted) abort();
    await spawned.client.request<Record<string, unknown>, InitializeResult>(
      'initialize',
      {
        clientInfo: { name: 'elanous-budget', version: '1' },
        capabilities: {},
      },
    );
    const result = await spawned.client.request<Record<string, never>, RateLimitsRead>(
      'account/rateLimits/read',
      {},
    );
    return result;
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    try {
      await spawned.client.close();
    } catch (err) {
      if (debug.enabled) {
        debug.log('budget.fetcher.codex.close-fail', 'post-fetch', {
          message: err instanceof Error ? err.message : String(err),
        }, { level: 'error' });
      }
    }
    abort();   // ⭐ 같은 멱등 경로로 정리한다 — abort 로 이미 죽었으면 여기서 다시 안 죽인다.
  }
}

// ─── Snapshot mapping ────────────────────────────────────────────────

function mapSnapshot(raw: RateLimitsRead): UsageSnapshot {
  const rl = raw.rateLimits ?? {};
  const windows: RateWindow[] = [];
  // ⛔⭐⭐⭐ **위치로 종류를 못 박지 않는다**(2026-08-05 실측 · MANUAL-llm-provider-operations §1a).
  //   초판은 `primary → 'session'` · `secondary → 'weekly'` 로 «자리»를 믿었는데, 실물 응답의
  //   `primary.windowDurationMins` 는 **10080(=7일 · 주간)** 이고 `secondary` 는 **null** 이었다.
  //   ⇒ 주간 창이 「session」이라는 이름으로 실려, 「얼마나 남았나」를 묻는 판단이 틀린 창을 봤다.
  //   ✅ 그래서 «창 길이»에서 종류를 유도한다 — 응답이 자리를 바꿔도 이름이 안 틀린다.
  const primary = mapWindow(rl.primary);
  if (primary) windows.push(primary);
  const secondary = mapWindow(rl.secondary);
  if (secondary) windows.push(secondary);
  // ⭐ 모델별 서브리밋(`rateLimitsByLimitId`)은 브랜드 총량과 «따로» 찬다(실측: 주간 100% 인 순간에도
  //   `codex_bengalfox` 는 0%). `RateWindow.model` 이 정확히 그 자리이므로 그것으로 싣는다.
  //   ⛔ 브랜드 총량과 같은 버킷(`limitId === rl.limitId`)은 «중복»이므로 뺀다.
  for (const [limitId, bucket] of Object.entries(raw.rateLimitsByLimitId ?? {})) {
    if (!bucket || limitId === rl.limitId) continue;
    const label = bucket.limitName ?? limitId;
    const w = mapWindow(bucket.primary, label);
    if (w) windows.push(w);
    const s = mapWindow(bucket.secondary, label);
    if (s) windows.push(s);
  }
  const credits = mapCredits(rl.credits);
  return {
    provider: 'codex' as UsageProvider,
    windows,
    ...(credits ? { credits } : {}),
    ...(mapPlan(rl.planType) ? { plan: mapPlan(rl.planType)! } : {}),
    // ⭐ provider 가 「찼다」고 «말한 사실»을 버리지 않는다 — 판정층이 그것을 읽는다(quota-exhausted).
    ...(rl.rateLimitReachedType ? { rateLimitReached: rl.rateLimitReachedType } : {}),
    fetchedAt: Date.now(),
    source: 'cli-rpc',
  };
}

/** 창 길이(분) → 종류. ⛔ 응답의 «자리»가 아니라 «값»으로 정한다.
 *  ⭐ **관측된 길이는 «명시»한다**(2026-08-05 실측: 300 · 10080). 나머지는 근사이고,
 *     ⛔ 근사를 쓴 사실을 «관측으로 드러낸다» — 조용히 틀린 이름을 붙이지 않기 위해서다(3R should-fix).
 *  ⚠️ `WindowKind` 에 「일간」이 없다 — 1440분 창이 실제로 관측되면 그때 타입을 늘린다. */
const OBSERVED_WINDOW_KINDS: ReadonlyMap<number, WindowKind> = new Map([
  [300, 'session'],      // 5시간 — CodexBar 문서와 우리 초판이 가정하던 창
  [10_080, 'weekly'],    // 7일 — 2026-08-05 실물
  [40_320, 'monthly'],   // 28일
  [43_200, 'monthly'],   // 30일
]);

function windowKindOf(windowMinutes: number): WindowKind {
  const known = OBSERVED_WINDOW_KINDS.get(windowMinutes);
  if (known) return known;
  const approximated: WindowKind = windowMinutes >= 20_160 ? 'monthly' : windowMinutes >= 5_040 ? 'weekly' : 'session';
  debug.log('budget.fetcher.codex', 'window-kind-approximated', { windowMinutes, approximated });
  return approximated;
}

function mapCredits(raw: RateLimitsCredits | null | undefined): UsageSnapshot['credits'] {
  if (!raw) return undefined;
  const balance = Number(raw.balance ?? 0);
  return {
    balance: Number.isFinite(balance) ? balance : 0,
    hasCredits: raw.hasCredits === true,
    unlimited: raw.unlimited === true,
  };
}

function mapPlan(raw: string | null | undefined): UsageSnapshot['plan'] {
  const known = ['free', 'paid', 'pro', 'team', 'enterprise', 'workspace'] as const;
  const v = (raw ?? '').toLowerCase();
  return (known as readonly string[]).includes(v) ? (v as UsageSnapshot['plan']) : undefined;
}

function mapWindow(
  raw: RateLimitsWindow | null | undefined,
  model?: string,
): RateWindow | null {
  if (!raw) return null;
  const usedPercent = clamp(Number(raw.usedPercent ?? 0), 0, 100);
  const windowMinutes = Number(raw.windowDurationMins ?? 0);
  const resetsAt = normalizeResetsAt(raw.resetsAt);
  return {
    kind: windowKindOf(windowMinutes),
    windowMinutes,
    limit: 100,
    used: usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt,
    ...(model ? { model } : {}),
  };
}

function normalizeResetsAt(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return 0;
  // Codex app-server emits Unix seconds; our RateWindow is epoch ms.
  return raw > 1e12 ? raw : raw * 1000;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
