// NEXUS · POST /v1/registry/discovery + GET /v1/registry/discovery
// (RFC #2161 Phase 6).
//
// POST triggers an on-demand discovery run; GET returns the most
// recent persisted snapshot from the local cache. The PWA's
// LlmCatalogCard (Phase 7) calls POST to refresh the catalog after
// a user action and reads GET on first paint.
//
// Cron-triggered scheduled runs land in a Phase 6 follow-up (NEXUS
// subsystem boot hook).

import { debug } from '../../debug/log.js';
import { setEventLoopActivity } from '../../debug/event-loop-watchdog.js';
import { jsonResponse } from './json-response.js';
import {
  BUILTIN_SOURCES,
  buildDiscoverySnapshot,
  readDiscoveryCache,
  runDiscovery,
  type DiscoverySnapshot,
  type RunDiscoveryOpts,
} from '../../registry/discovery/runner.js';
import type {
  DiscoverySource,
  DiscoverySourceId,
  DiscoverySourceResult,
} from '../../registry/discovery/types.js';

export interface DiscoveryGetResponse {
  cached: DiscoverySnapshot | null;
}

export interface DiscoveryRunResponse extends DiscoverySnapshot {
  ok: true;
}

/**
 * Route-level overall wait cap. REST sources default to 4s; firecrawl-crawl
 * is 120s and grok-crawl is 60s. This cap is the HTTP handler's wait, not a
 * per-source limit — callers who need the crawlers can raise it via
 * `HandleDiscoveryRunOpts.timeoutMs`.
 */
export const DEFAULT_DISCOVERY_OVERALL_TIMEOUT_MS = 15_000;

const OVERALL_TIMEOUT = Symbol('discovery-overall-timeout');
/** 밖에서 끊었다. ⛔ 상한과 «다른 값»이다 — 상한은 「우리가 오래 걸려 잘랐다」이고
 *  이쪽은 「부르는 쪽이 이미 갔다」다. 접으면 산출이 이유를 잘못 말한다. */
const OVERALL_ABORTED = Symbol('discovery-overall-aborted');

interface DiscoveryRunTimeoutResponse {
  ok: false;
  /** 우리가 «상한»에 걸려 잘랐다. */
  timedOut: boolean;
  /** 부르는 쪽이 «먼저 갔다»(외부 signal). ⛔ `timedOut` 과 다른 값이다. */
  aborted: boolean;
  timeoutMs: number;
  /** 상한에 걸려 «정산되지 못한» 소스 id 들.
   *  ⛔ 이것이 없으면 느린 소스가 `sources` 목록에서 «조용히 사라진다» —
   *  「그 소스가 0건을 냈다」와 「그 소스를 기다리다 잘랐다」가 같아 보인다.
   *  ⇒ 두 뜻을 한 산출로 접지 않기 위해 «이름»을 댄다. */
  unsettledSourceIds: DiscoverySourceId[];
  version: number;
  generatedAt: string;
  sources: DiscoverySnapshot['sources'];
  models: DiscoverySnapshot['models'];
}

/**
 * Internal/test seam for the HTTP handler.  The public endpoint always uses
 * the default discovery sources; callers can inject deterministic sources in
 * process-level tests so they never inherit a developer's live credentials.
 */
export interface HandleDiscoveryRunOpts {
  discovery?: RunDiscoveryOpts;
  /** ⚠️ **시험 씨앗이다 — 운영 노브가 아니다.**
   *  📌 응답의 `timeoutMs` 는 이 값이 «아니라» ***적용된 실효 상한***이다
   *  (`resolveOverallTimeoutMs()` 가 미지정·부적합을 기본값으로 «해석한 뒤» 실린다).
   *  ⇒ 호출자가 생략해도 그 필드는 「미지의 기본값」이 아니라 「이번 판에 «실제로»
   *    적용된 값」이라 언제나 참이다. 그 계약을 시험이 문다(아래 참조). 실제 라우트는 이 값을 «주지 않으며»
   *  언제나 `DEFAULT_DISCOVERY_OVERALL_TIMEOUT_MS` 로 돈다. 시험이 40ms 같은 짧은
   *  상한으로 그 경로를 «몇 초 안에» 밟기 위해서만 있다.
   *  ⛔ 상한 값의 튜닝(설정으로 노출할지)은 «다른 판»이다 — 여기서 그것을 열지 않는다.
   *  Omitted / invalid → `DEFAULT_DISCOVERY_OVERALL_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** ⚠️ `cachePath` 는 **시험 씨앗**이다(운영 라우트는 «주지 않는다» ⇒ 기본 캐시 경로).
 *  ⛔ 지우지 마라 — 이것이 없으면 이 핸들러를 시험하려면 ***개발자의 진짜 `~/.elanous`
 *  캐시에 써야 한다.*** 그것은 `scripts/ci-isolation-hardcode-gate.ts` 가 막는 바로 그 형태다.
 *  `readDiscoveryCache` 는 원래 이 옵션을 받는다(runner.ts:185) — 여기는 «전달» 한 줄이다. */
export function handleDiscoveryGet(opts: { cachePath?: string } = {}): Response {
  const cached = readDiscoveryCache(opts);
  return jsonResponse({ cached } satisfies DiscoveryGetResponse, 200);
}

function resolveOverallTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_DISCOVERY_OVERALL_TIMEOUT_MS;
  }
  return value;
}

function wrapSourcesForCollection(
  sources: readonly DiscoverySource[],
  slots: Array<DiscoverySourceResult | undefined>,
): DiscoverySource[] {
  return sources.map((source, i) => ({
    id: source.id,
    async run(sourceOpts) {
      // ⛔ 실패에도 «진짜» 소요 시간을 싣는다 — 0 을 박으면 「빨리 실패했다」와
      //    「오래 끌다 터졌다」가 같아 보인다.
      const sourceStartedAt = Date.now();
      try {
        const result = await source.run(sourceOpts);
        slots[i] = result;
        return result;
      } catch (err) {
        // ⛔ 던진 소스를 「못 끝났다」로 이름 대면 «거짓»이다 — 끝났고, 실패로 끝났다.
        //    담지 않으면 unsettledSourceIds 가 그것을 미정산으로 부른다.
        // ⊕ 러너도 같은 정규화를 한다(runner.ts) — 그쪽은 cron 등 «모든» 호출자를
        //    위한 것이고, 여기는 `slots` 를 채우기 위해 필요하다. 둘은 겹쳐도 안전하다
        //    (안쪽이 먼저 잡으면 바깥은 안 불린다).
        const failed: DiscoverySourceResult = {
          source: source.id,
          ok: false,
          models: [],
          durationMs: Date.now() - sourceStartedAt,
          error: `source-threw: ${err instanceof Error ? err.message : String(err)}`,
        };
        slots[i] = failed;
        return failed;
      }
    },
  }));
}

function settledInSourceOrder(
  slots: readonly (DiscoverySourceResult | undefined)[],
): DiscoverySourceResult[] {
  return slots.filter((r): r is DiscoverySourceResult => r !== undefined);
}

export async function handleDiscoveryRun(opts: HandleDiscoveryRunOpts = {}): Promise<Response> {
  setEventLoopActivity('registry:discovery');
  const startedAt = Date.now();
  try { debug.log('registry.discovery', 'start'); } catch { /* fail-soft */ }
  const timeoutMs = resolveOverallTimeoutMs(opts.timeoutMs);
  const inputSources = opts.discovery?.sources ?? BUILTIN_SOURCES;
  // ⛔⭐ 이미 취소된 요청은 소스를 «시작조차» 하지 않는다.
  //    `Promise.race` 에 abort 를 넣는 것만으론 부족하다 — 소스가 await «전»에 동기로
  //    일하면(이 저장소에 실제로 그런 소스가 있었다 · #14925) 이벤트 루프가 막혀
  //    race 자체가 «돌 기회를 못 얻는다». 그러면 상한도 즉시취소도 보장이 깨진다.
  //    ⇒ 시작 «전»에 갈라야 한다.
  if (opts.discovery?.signal?.aborted) {
    try {
      debug.log('registry.discovery', 'done', {
        durationMs: Date.now() - startedAt,
        timedOut: false,
        aborted: true,
        unsettledCount: inputSources.length,
        startedSources: 0,
      });
    } catch { /* fail-soft */ }
    const now = opts.discovery?.now ?? Date.now;
    const empty = buildDiscoverySnapshot([], now);
    return jsonResponse({
      ok: false,
      timedOut: false,
      aborted: true,
      timeoutMs,
      unsettledSourceIds: inputSources.map((src) => src.id),
      ...empty,
    } satisfies DiscoveryRunTimeoutResponse, 200);
  }
  const slots: Array<DiscoverySourceResult | undefined> = new Array(inputSources.length);
  const sources = wrapSourcesForCollection(inputSources, slots);
  const overall = new AbortController();
  const inputSignal = opts.discovery?.signal;
  const onExternalAbort = (): void => overall.abort();
  if (inputSignal) {
    if (inputSignal.aborted) overall.abort();
    else inputSignal.addEventListener('abort', onExternalAbort);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof OVERALL_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(OVERALL_TIMEOUT), timeoutMs);
  });
  // ⛔ abort 를 «경주에 넣어야» 한다. overall.abort() 만 하고 run 을 기다리면,
  //    신호를 «무시하는» 소스가 하나라도 있으면 그 소스가 끝날 때까지 붙들린다
  //    (실측: 이미 abort 된 신호인데 2,004ms 를 기다렸다).
  const abortPromise = new Promise<typeof OVERALL_ABORTED>((resolve) => {
    if (overall.signal.aborted) { resolve(OVERALL_ABORTED); return; }
    overall.signal.addEventListener('abort', () => resolve(OVERALL_ABORTED), { once: true });
  });
  const run = runDiscovery({ ...opts.discovery, sources, signal: overall.signal });
  try {
    const outcome = await Promise.race([run, timeoutPromise, abortPromise]);
    if (outcome === OVERALL_TIMEOUT || outcome === OVERALL_ABORTED) {
      const aborted = outcome === OVERALL_ABORTED;
      overall.abort();
      void run.catch(() => { /* late settlement after abort must not reject */ });
      try {
        debug.log('registry.discovery', 'done', {
          durationMs: Date.now() - startedAt,
          timedOut: !aborted,
          aborted,
          unsettledCount: slots.filter((slot) => slot === undefined).length,
        });
      } catch { /* fail-soft */ }
      const now = opts.discovery?.now ?? Date.now;
      const partial = buildDiscoverySnapshot(settledInSourceOrder(slots), now);
      // 잘린 소스는 «이름»으로 남긴다 — 목록에서 사라지면 「0건」과 구분이 안 된다.
      const unsettledSourceIds = inputSources
        .map((src, i) => (slots[i] === undefined ? src.id : undefined))
        .filter((id): id is DiscoverySourceId => id !== undefined);
      const body: DiscoveryRunTimeoutResponse = {
        ok: false,
        // 「우리가 잘랐다」와 「부르는 쪽이 갔다」를 다른 값으로 낸다.
        timedOut: !aborted,
        aborted,
        timeoutMs,
        unsettledSourceIds,
        ...partial,
      };
      return jsonResponse(body, 200);
    }
    const { snapshot } = outcome;
    try {
      debug.log('registry.discovery', 'done', { durationMs: Date.now() - startedAt });
    } catch { /* fail-soft */ }
    return jsonResponse({ ok: true, ...snapshot } satisfies DiscoveryRunResponse, 200);
  } catch (err) {
    try {
      debug.log('registry.discovery', 'failed', {
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      }, { level: 'error' });
    } catch { /* fail-soft */ }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (inputSignal) inputSignal.removeEventListener('abort', onExternalAbort);
  }
}
