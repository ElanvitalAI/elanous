// ── 통합 세션 fan-out (PLAN §P1 · 2026-07-16) ──────────────────────────────────
//
// P0 구독자 모델(1세션=N 구독자) 위의 **단일 출력 fan-out 경로**. 현재 세션 출력은 ACP
// sessionPeers broadcast(TUI/PWA/iOS 소켓) + onAppend 미러(그 외)로 이원화돼 있다. 이 계층은
// "구독자 집합 → 서피스별 sink 로 한 번에 배달"을 1급으로 모델링해 P2(presence)·P4(표현법)가
// 얹힐 단일 지점을 만든다.
//
// ⚠️ 라이브 배달 cutover 는 dogfood-gated(후속) — 여기선 **메커니즘 + 관측 + fail-soft** 를
// 세우고, 실제 tg/dc/ACP sink 등록은 데몬 배선에서 점증한다(실기기 dogfood 필요·PWA/voice
// 파리티 선례 동형). 즉 이 모듈은 sink 레지스트리 + fanOutSessionOutput 오케스트레이션이 본분.
//
// 제1원칙(§P1 heal): fan-out 실패(한 서피스)는 **1회 재시도 → 해당 구독자만 degraded**(다른
// 구독자 무중단·fail-soft). 전 배달은 recordSessionObservation('session.fanout')로 관측.

import { listSubscribers, type SessionSurface, subscriberKey } from './index.js';
import { recordSessionObservation, type SessionObservationSinks } from './session-observation.js';
import { renderForSurface, DEFAULT_RENDER_POLICY, type RenderPolicy, type SurfaceRenderer } from './session-render.js';

/** 한 세션 출력 이벤트 — 서피스별 sink 가 자기 표현으로 렌더(P4 가 정교화). */
export interface SessionOutputEvent {
  kind: 'message' | 'chunk' | 'status';
  role?: 'assistant' | 'user' | 'system';
  text?: string;
  ts?: string;
  refs?: Record<string, unknown>;
}

/** 배달 컨텍스트 — endpoint(배달주소) 밖의 라우팅 정보. pwa sink(C4)는 sessionId 로 session.output
 *  SSE 를 태깅한다. endpoint 는 순수 배달주소(tg chatId·dc channelId)로 유지. */
export interface DeliverContext { sessionId: string }

/** 서피스 배달 어댑터 — endpoint(구독자 엔드포인트)로 이벤트 1건 배달. 실패 시 throw(→재시도→degraded).
 *  ctx.sessionId 는 endpoint 로 세션을 알 수 없는 sink(pwa)용(tg/dc 는 무시). */
export interface SurfaceSink {
  deliver: (endpoint: string, event: SessionOutputEvent, ctx: DeliverContext) => Promise<void>;
  /** 이 endpoint 를 «내가» 배달하나 — 한 서피스에 sink 가 여럿(텔레그램 봇 둘)일 때 고르는 기준. 없으면 전부 받는다. */
  accepts?: (endpoint: string) => boolean;
}

/**
 * 🩸 2026-09-25 텔레그램 분리 운영 전환 실측: 한 프로세스에 봇 둘(main·conatus)이 «같은 서피스 이름»으로 sink 를 등록하면
 *   종전 Map 은 «나중 것이 앞의 것을 교체»했다 — conatus sink 가 main 을 덮었고, 그 sink 의 봇 가드가 main 봇 endpoint 를 조용히
 *   건너뛰어 main 봇의 답이 «어디에도» 안 갔다(스트리밍이 대상을 잡아 옛 발송 경로도 꺼졌다).
 * ⇒ 서피스마다 «멤버 목록»을 두고, 합성 sink 가 endpoint 를 «받아들이는 첫 멤버 하나»에만 넘긴다.
 *   봇 스코프 endpoint = 그 봇 · 옛 bare chatId = 먼저 등록된 멤버(봇 하나이던 때와 같은 뜻 · 중복 배달 없음).
 */
function pickMember<T extends { accepts?: (endpoint: string) => boolean }>(members: readonly T[], endpoint: string): T | undefined {
  return members.find((m) => !m.accepts || m.accepts(endpoint));
}

const surfaceMembers = new Map<SessionSurface, SurfaceSink[]>();
const surfaceSinks = new Map<SessionSurface, SurfaceSink>();

function rebuildSurface(surface: SessionSurface): void {
  const members = surfaceMembers.get(surface) ?? [];
  if (members.length === 0) { surfaceSinks.delete(surface); surfaceMembers.delete(surface); return; }
  surfaceSinks.set(surface, members.length === 1 ? members[0]! : {
    accepts: (endpoint) => pickMember(members, endpoint) !== undefined,
    deliver: async (endpoint, event, ctx) => { await pickMember(members, endpoint)?.deliver(endpoint, event, ctx); },
  });
}

/** 서피스 sink 등록(데몬 배선이 호출). 반환값=해제 함수. 같은 서피스에 여럿이면 «합성»(위 주석). */
export function registerSurfaceSink(surface: SessionSurface, sink: SurfaceSink): () => void {
  surfaceMembers.set(surface, [...(surfaceMembers.get(surface) ?? []), sink]);
  rebuildSurface(surface);
  return () => {
    surfaceMembers.set(surface, (surfaceMembers.get(surface) ?? []).filter((m) => m !== sink));
    rebuildSurface(surface);
  };
}

/** 테스트 seam — sink 레지스트리 초기화. */
export function _clearSurfaceSinksForTest(): void {
  surfaceSinks.clear();
  surfaceMembers.clear();
}

export interface FanoutResult {
  /** 배달 대상(active/grace 구독자 중 sink 있는 것). */
  targeted: number;
  delivered: number;
  /** 배달 실패(재시도 후에도) — 해당 구독자만 degraded. */
  failed: number;
  /** sink 미등록으로 스킵(서피스 배선 전). */
  skipped: number;
  /** 하나라도 실패 = degraded(정직성). */
  degraded: boolean;
  /** 실패한 구독자 키(호출자가 presence 유예 등 후속 판단). */
  failedKeys: string[];
}

export interface FanoutOpts {
  /** 배달 sink 오버라이드(테스트/커스텀 라우팅). 미주입 시 등록 레지스트리. */
  sinks?: Map<SessionSurface, SurfaceSink>;
  /** 세션 루트(테스트). */
  root?: string;
  /** 재시도 횟수(기본 1 — §P1 "재시도"). */
  retries?: number;
  /** 표현법 정책(§P4·기본 Stage A=원본 방출). */
  policy?: RenderPolicy;
  /** Stage C 서피스별 렌더러(기본 없음=원본). */
  renderers?: Map<SessionSurface, SurfaceRenderer>;
  /** 배달 제외 구독자 키(`<surface>:<endpoint>`) — 기존 배달 경로(바인딩)가 이미 커버하는
   *  endpoint 중복배달 방지(shadow 모드). */
  excludeKeys?: string[];
  /** ⚠️ **테스트 전용 seam** — 관측 sink 주입구. 프로덕션 호출자는 **주지 않는다**(생략 시
   *  기본 sink 로 `recordSessionObservation` 이 정상 발화한다). 공개 `FanoutOpts` 에 있는 것은
   *  이 파일 밖에서 fan-out 을 호출하는 테스트가 관측 레코드를 잡기 위해서고, **런타임 동작을
   *  바꾸는 노브가 아니다.**
   *  ⛔ 프로덕션 경로에서 이걸 넘기는 호출자가 생기면 관측이 조용히 다른 데로 새므로,
   *     그때는 **주입이 아니라 별도 sink 등록**으로 풀어야 한다(무인 리뷰 should-fix · 2026-07-28).
   *  확인(실측 2026-07-28: **0건**): `rg -n "observationSinks:" src/ -g '!*.test.ts'` 에서
   *     **선언(`?:`)과 이 파일을 뺀 나머지** — 즉 실제로 **넘기는** 호출자가 있는가.
   *  ⚠️ 타입명(`SessionObservationSinks`)이나 필드명만으로 찾으면 **동명의 다른 타입**
   *     (`src/autopilot/mission-decomp-critique.ts`)과 **형제 선언**(`session-fanout-parity.ts`)이
   *     함께 걸려 거짓 양성이 난다. */
  observationSinks?: SessionObservationSinks;
}

async function deliverWithRetry(
  sink: SurfaceSink, endpoint: string, event: SessionOutputEvent, ctx: DeliverContext, retries: number,
): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { await sink.deliver(endpoint, event, ctx); return true; }
    catch { if (attempt === retries) return false; }
  }
  return false;
}

/**
 * 세션 출력을 전 구독자에 fan-out(단일 경로). active/grace 구독자만 대상(left 제외), 서피스별
 * sink 로 배달. 실패는 1회 재시도 후 해당 구독자만 degraded(다른 구독자 무중단). 전 결과 관측.
 * READ 구독(ro)도 출력은 받는다 — role 은 입력(턴 소유권·P3)만 게이트.
 */
export async function fanOutSessionOutput(
  sessionId: string,
  event: SessionOutputEvent,
  opts: FanoutOpts = {},
): Promise<FanoutResult> {
  const sinks = opts.sinks ?? surfaceSinks;
  const retries = opts.retries ?? 1;
  const policy = opts.policy ?? DEFAULT_RENDER_POLICY;
  const exclude = new Set(opts.excludeKeys ?? []);
  const activeSubscribers = listSubscribers(sessionId, {}, opts.root)
    .filter((s) => s.presence !== 'left'); // 이탈은 배달 제외
  const subs = activeSubscribers
    .filter((s) => !exclude.has(subscriberKey(s.surface, s.endpoint))); // 바인딩 중복 제외
  const excluded = activeSubscribers.length - subs.length;

  let delivered = 0, failed = 0, skipped = 0;
  const failedKeys: string[] = [];

  await Promise.allSettled(subs.map(async (s) => {
    const sink = sinks.get(s.surface);
    if (!sink) { skipped++; return; }
    // §P4 표현법 — 서버 스냅샷을 서피스별 렌더(Stage A=원본·변환실패→원본 폴백).
    const rendered = renderForSurface(s.surface, event, policy, opts.renderers, sessionId);
    const surfaceEvent = rendered.text === (event.text ?? '') ? event : { ...event, text: rendered.text };
    const ok = await deliverWithRetry(sink, s.endpoint, surfaceEvent, { sessionId }, retries);
    if (ok) { delivered++; }
    else { failed++; failedKeys.push(subscriberKey(s.surface, s.endpoint)); }
  }));

  const degraded = failed > 0;
  // 관측은 결과 0을 한 덩어리로 뭉개지 않는다. no-target=구독자 없음,
  // no-routable-target=shadow 제외/미배선, delivered/degraded=실제 sink 호출 결과.
  const outcome = degraded
    ? 'degraded'
    : activeSubscribers.length === 0
      ? 'no-target'
      : subs.length === 0 || delivered === 0
        ? 'no-routable-target'
        : 'delivered';
  recordSessionObservation({
    sessionId,
    subsystem: 'fanout',
    event: outcome,
    rationale: `fan-out eligible ${activeSubscribers.length} · excluded ${excluded} · routable ${subs.length - skipped} · delivered ${delivered} · failed ${failed} · sinkless ${skipped}`,
    refs: {
      eligible: activeSubscribers.length,
      excluded,
      routable: subs.length - skipped,
      delivered,
      failed,
      sinkless: skipped,
      registeredSurfaces: [...sinks.keys()].sort(),
      ...(failedKeys.length ? { failedKeys } : {}),
    },
    ...(degraded ? { importance: 5 } : {}),
  }, opts.observationSinks);

  return { targeted: subs.length - skipped, delivered, failed, skipped, degraded, failedKeys };
}

/** 현재 등록된 서피스 sink 목록(진단·배선 확인용). */
export function registeredSinkSurfaces(): SessionSurface[] {
  return [...surfaceSinks.keys()];
}

/** §C2/C3 primary flip — 옛경로 수신자 키(`<surface>:<endpoint>`) 중 **primary 로 승격된
 *  서피스**는 excludeKeys 에서 제외(빼서 fan-out 이 실배달). shadow 서피스는 유지(옛 경로가
 *  배달·중복방지). 순수 함수. ⚠️ primary 서피스는 옛 배달 경로가 suppression 돼야 이중배달이
 *  없다(그 suppression 은 서피스 배달지점의 `!primary` 게이트 — 스트리밍 UX 결합 → dogfood). */
export function shadowExcludeKeys(oldRecipients: string[], primarySurfaces: SessionSurface[]): string[] {
  const primary = new Set<string>(primarySurfaces);
  return oldRecipients.filter((k) => {
    const i = k.indexOf(':');
    const surface = i < 0 ? k : k.slice(0, i);
    return !primary.has(surface);
  });
}

// ── C5 청크(스트리밍) fan-out (2026-07-16) ────────────────────────────────────────
//
// 메시지레벨 fan-out(fanOutSessionOutput)과 별개의 **청크 스트림 경로**. 데몬 턴의 델타를
// 구독자별 StreamingSurfaceSink 로 라우팅 → 서피스 sink 가 라이브핸들(placeholder+throttle·
// draft-stream-loop)로 in-place 스트리밍. 스트리밍 서피스(telegram/discord/ACP)의 진짜 cutover.
// producer 앵커 = 데몬 턴 onDelta(설계 §4·C5 후속). 여기선 타입 + 레지스트리 + 라우팅.

/** 한 턴 스트림의 청크 이벤트. streamId 로 finalize/abort 매칭, seq 로 순서/dedup. */
export interface SessionChunkEvent {
  streamId: string;
  seq: number;
  /** 텍스트 델타(누적은 sink 의 라이브핸들이). */
  delta?: string;
  /** Replace the current assistant text accumulated for this stream. */
  textOperation?: 'replace';
  /** 툴 활동(⚙️…✓ inline 렌더용). */
  tool?: { id: string; name: string; phase: 'call' | 'result'; ok?: boolean };
  /** 🧠 추론(모드 gated·선택). */
  reasoning?: string;
  role?: 'assistant';
}

/** 턴 완료 — 최종 텍스트로 라이브핸들 마감(finalize/split). onAppend(메시지레벨)와 streamId 매칭. */
export interface SessionStreamFinal { streamId: string; role: 'assistant'; text: string }

/** 스트리밍 서피스 sink — 라이브 스트림 핸들 소유(placeholder message_id·throttle). onChunk 은
 *  fire-and-forget(sink 내부 loop 이 async·throttle 처리), onFinal 은 마감(split·정리). */
export interface StreamingSurfaceSink {
  onChunk: (endpoint: string, ev: SessionChunkEvent, ctx: DeliverContext) => void;
  onFinal: (endpoint: string, ev: SessionStreamFinal, ctx: DeliverContext) => Promise<void> | void;
  onAbort?: (endpoint: string, streamId: string, ctx: DeliverContext) => void;
  /** 이 endpoint 를 «내가» 배달하나(SurfaceSink.accepts 와 같은 뜻). */
  accepts?: (endpoint: string) => boolean;
}

const streamingMembers = new Map<SessionSurface, StreamingSurfaceSink[]>();
const streamingSinks = new Map<SessionSurface, StreamingSurfaceSink>();

function rebuildStreaming(surface: SessionSurface): void {
  const members = streamingMembers.get(surface) ?? [];
  if (members.length === 0) { streamingSinks.delete(surface); streamingMembers.delete(surface); return; }
  streamingSinks.set(surface, members.length === 1 ? members[0]! : {
    accepts: (endpoint) => pickMember(members, endpoint) !== undefined,
    onChunk: (endpoint, ev, ctx) => { pickMember(members, endpoint)?.onChunk(endpoint, ev, ctx); },
    onFinal: async (endpoint, ev, ctx) => { await pickMember(members, endpoint)?.onFinal(endpoint, ev, ctx); },
    onAbort: (endpoint, streamId, ctx) => { pickMember(members, endpoint)?.onAbort?.(endpoint, streamId, ctx); },
  });
}

/** 스트리밍 sink 등록(데몬 배선). 반환=해제 함수. 같은 서피스에 여럿이면 «합성»(registerSurfaceSink 주석). */
export function registerStreamingSink(surface: SessionSurface, sink: StreamingSurfaceSink): () => void {
  streamingMembers.set(surface, [...(streamingMembers.get(surface) ?? []), sink]);
  rebuildStreaming(surface);
  return () => {
    streamingMembers.set(surface, (streamingMembers.get(surface) ?? []).filter((m) => m !== sink));
    rebuildStreaming(surface);
  };
}

/** 테스트 seam. */
export function _clearStreamingSinksForTest(): void { streamingSinks.clear(); streamingMembers.clear(); }

/** 테스트 seam — 레지스트리가 «지금» 쓰는 sink(여럿이면 합성). */
export function _streamingSinkForTest(surface: SessionSurface): StreamingSurfaceSink | undefined { return streamingSinks.get(surface); }
export function _surfaceSinkForTest(surface: SessionSurface): SurfaceSink | undefined { return surfaceSinks.get(surface); }

/** 현재 등록된 스트리밍 sink 서피스(진단). */
export function registeredStreamingSurfaces(): SessionSurface[] { return [...streamingSinks.keys()]; }

export interface ChunkFanoutOpts {
  sinks?: Map<SessionSurface, StreamingSurfaceSink>;
  root?: string;
  /** 배달 제외 구독자 키(옛 경로 커버·shadow 중복방지·shadowExcludeKeys 산출). */
  excludeKeys?: string[];
}

/** 대상 구독자 산출 — active/grace·excludeKeys 제외·스트리밍 sink 있는 서피스만. 공통 필터. */
function streamingTargets(sessionId: string, sinks: Map<SessionSurface, StreamingSurfaceSink>, opts: ChunkFanoutOpts) {
  const exclude = new Set(opts.excludeKeys ?? []);
  return listSubscribers(sessionId, {}, opts.root)
    .filter((s) => s.presence !== 'left')
    .filter((s) => !exclude.has(subscriberKey(s.surface, s.endpoint)))
    .filter((s) => sinks.has(s.surface));
}

/** 청크를 스트리밍 구독자에 fan-out(fire-and-forget·fail-soft). sink loop 이 throttle/재시도 처리. */
export function fanOutSessionChunk(sessionId: string, ev: SessionChunkEvent, opts: ChunkFanoutOpts = {}): { targeted: number } {
  const sinks = opts.sinks ?? streamingSinks;
  const subs = streamingTargets(sessionId, sinks, opts);
  for (const s of subs) {
    try { sinks.get(s.surface)!.onChunk(s.endpoint, ev, { sessionId }); }
    catch { /* 한 sink 실패가 다른 구독자 무중단(fail-soft) */ }
  }
  return { targeted: subs.length };
}

/** 턴 완료 — 스트리밍 구독자 라이브핸들 마감. 각 sink 마감 실패 fail-soft. */
export async function fanOutSessionFinal(sessionId: string, ev: SessionStreamFinal, opts: ChunkFanoutOpts = {}): Promise<{ targeted: number }> {
  const sinks = opts.sinks ?? streamingSinks;
  const subs = streamingTargets(sessionId, sinks, opts);
  await Promise.allSettled(subs.map(async (s) => {
    try { await sinks.get(s.surface)!.onFinal(s.endpoint, ev, { sessionId }); } catch { /* fail-soft */ }
  }));
  return { targeted: subs.length };
}

/** 턴 중단 — 스트리밍 구독자 라이브핸들 정리(placeholder 정리). */
export function fanOutSessionAbort(sessionId: string, streamId: string, opts: ChunkFanoutOpts = {}): void {
  const sinks = opts.sinks ?? streamingSinks;
  for (const s of streamingTargets(sessionId, sinks, opts)) {
    try { sinks.get(s.surface)!.onAbort?.(s.endpoint, streamId, { sessionId }); } catch { /* fail-soft */ }
  }
}
