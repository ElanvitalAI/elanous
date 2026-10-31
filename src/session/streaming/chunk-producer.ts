// ── 청크 producer (C5 · 2026-07-16) ──────────────────────────────────────────────
//
// 데몬 턴의 스트리밍 델타/툴을 fanOutSessionChunk 로 발화하는 per-turn 헬퍼. 서피스 핸들러
// (telegram/discord)가 자기 streamer 를 구동하면서 **동시에** 이걸 호출 → 스트리밍 서피스의
// 청크 fan-out. 설계 §4 producer tap 의 재사용 가능한 형태(핫패스 편집 최소화).
//
// ⚠️ **shadow 안전**: excludeKeys = 옛 경로 수신자(owner) → owner 는 fan-out 에서 **항상 제외**
// (핸들러 자기 streamer 가 owner 배달 유지) → 추가 스트리밍 구독자에게만 미러. 즉 이 tap 은
// 순수 additive·배달 무변경. 실 flip(owner 를 fan-out 으로 + 옛 streamer 억제)은 별도 dogfood.
// 전 호출 fail-soft(turn 무중단). 턴 종료 시 recordChunkParity(누적 vs 최종·청크 유실 감지).

import { fanOutSessionChunk, fanOutSessionFinal, shadowExcludeKeys } from '../session-fanout.js';
import { oldPathRecipientKeys, recordChunkParity } from '../session-fanout-parity.js';
import { loadSession, listSubscribers, subscriberKey, type SessionSurface } from '../index.js';
import { debug } from '../../debug/log.js';

/** ACP 청크 producer(C5d) — tg/dc producer 와 달리 **excludeKeys 를 안 쓴다**. ACP 턴은 tg/dc 처럼
 *  "옛 경로 owner"(bindings)가 없고, 오히려 tg/dc/pwa 구독자로 **미러**하는 게 목적. 그래서 전 스트리밍
 *  구독자에 fan-out(excludeKeys=[]). flip(streaming.acp) 시엔 'acp' 구독자도 포함돼 broadcast 흡수.
 *  shadow 시엔 'acp' 구독자 부재 → tg/dc/pwa 미러만. reasoning 채널 추가 지원. */
export interface AcpChunkProducer {
  delta: (text: string) => void;
  replaceText: (text: string) => void;
  /** ⭐ `result` 는 «결과 단계»에서만 뜻이 있고, 주면 ACP `rawOutput` 으로 실려 나간다.
   *
   *  ⛔⭐⭐ **「안 줬다」의 «사유»를 여기서 만들지 않는다.**
   *  선택 인자를 «생략한 것»과 «undefined 를 넘긴 것»은 이 층에서 구분할 수 «없다» —
   *  그런데도 사유를 붙이면 ***모르는 것을 단정***하게 된다(리뷰가 그 형태를 잡았다).
   *  ⇒ 값이 있으면 싣고, 없으면 «아무 말도 안 한다». 그것이 이 층이 아는 전부다. */
  tool: (id: string, name: string, phase: 'call' | 'result', ok?: boolean, result?: unknown) => void;
  reasoning: (text: string) => void;
  final: (finalText: string) => Promise<void>;
}

export function makeAcpChunkProducer(sessionId: string, opts: { streamId?: string; root?: string; excludeKeys?: string[] } = {}): AcpChunkProducer {
  const root = opts.root;
  const streamId = opts.streamId ?? `acp:${sessionId}:${listSubscribers(sessionId, {}, root).length}`;
  // ACP 자기 peer(='acp' 구독자)는 옛 direct broadcast(server.ts)가 그대로 서빙 → tap 에서 제외
  // (이중 배달 방지). 나머지(tg/dc/pwa)로만 미러. flip 이든 shadow 든 broadcast 경로 무접촉.
  const excludeKeys = opts.excludeKeys ?? [];
  let seq = 0;
  let accum = '';
  let deltas = 0, lastTargeted = -1;
  const fo = (ev: Parameters<typeof fanOutSessionChunk>[1]) => {
    try {
      const r = fanOutSessionChunk(sessionId, ev, { excludeKeys, ...(root ? { root } : {}) });
      if (r.targeted !== lastTargeted) { debug.log('acp.stream', deltas === 0 ? 'start' : 'targeted-change', { streamId, targeted: r.targeted }); lastTargeted = r.targeted; }
    } catch { /* fail-soft */ }
  };
  return {
    delta(text: string): void {
      if (!text) return;
      accum += text;
      fo({ streamId, seq: seq++, delta: text });
      deltas++;
    },
    replaceText(text: string): void {
      accum = text;
      fo({ streamId, seq: seq++, delta: text, textOperation: 'replace' });
      deltas++;
    },
    tool(id, name, phase, ok, result): void {
      fo({ streamId, seq: seq++, tool: {
        id, name, phase,
        ...(ok != null ? { ok } : {}),
        // ⛔ 결과 단계에서 «값이 있을 때»만 싣는다 — 없으면 아무 말도 안 한다.
        ...(phase === 'result' && result !== undefined ? { result } : {}),
      } });
    },
    reasoning(text: string): void {
      if (!text) return;
      fo({ streamId, seq: seq++, reasoning: text });
    },
    async final(finalText: string): Promise<void> {
      let targeted = -1;
      try { const r = await fanOutSessionFinal(sessionId, { streamId, role: 'assistant', text: finalText }, { excludeKeys, ...(root ? { root } : {}) }); targeted = r.targeted; }
      catch { /* fail-soft */ }
      try { debug.log('acp.stream', 'final', { streamId, deltas, targeted, chars: finalText.length }); } catch { /* fail-soft */ }
      try {
        const recipients = listSubscribers(sessionId, {}, root)
          .filter((s) => s.presence !== 'left')
          .map((s) => subscriberKey(s.surface, s.endpoint));
        recordChunkParity({ sessionId, streamId, surface: 'acp', streamedText: accum, finalText, newRecipients: recipients, oldRecipients: recipients });
      } catch { /* fail-soft */ }
    },
  };
}

export interface ChunkProducer {
  /** 텍스트 델타 — fan-out 청크 + 누적(parity 용). */
  delta: (text: string) => void;
  /** 툴 활동 — ⚙️ call / ✓ result. `result` 는 결과 단계에서만 뜻이 있다(→ `AcpChunkProducer.tool`). */
  tool: (id: string, name: string, phase: 'call' | 'result', ok?: boolean, result?: unknown) => void;
  /** 턴 완료 — 라이브핸들 마감 + 청크 parity(누적 vs 최종). */
  final: (finalText: string) => Promise<void>;
}

export interface ChunkProducerOpts {
  streamId?: string;
  root?: string;
  /** surface 필터(진단용·부재면 전 스트리밍 서피스). */
  surface?: string;
  /** **primary flip** 서피스 — 이 서피스의 owner 는 excludeKeys 에서 빠져 fan-out 이 실배달(스트리밍
   *  flip). 부재/빈 배열 = 순수 shadow(owner 항상 제외·배달 무변경). 예: `['telegram']`. */
  primarySurfaces?: SessionSurface[];
}

/** per-turn 청크 producer. 옛 경로 수신자를 excludeKeys 로 — primarySurfaces 는 비제외(fan-out 배달). */
export function makeChunkProducer(sessionId: string, opts: ChunkProducerOpts = {}): ChunkProducer {
  const root = opts.root;
  const streamId = opts.streamId ?? `${sessionId}:${listSubscribers(sessionId, {}, root).length}`;
  let seq = 0;
  let accum = '';

  // 옛 경로 수신자(owner) — shadow 는 전부 제외, primary 서피스는 비제외(fan-out 이 owner 배달). fail-soft.
  // fullOld = parity 대조용(전체·필터 전), excludeKeys = fan-out 배달 제외(primary 서피스 비제외).
  let fullOld: string[] = [];
  let excludeKeys: string[] = [];
  try {
    const meta = loadSession(sessionId, root)?.meta;
    if (meta) { fullOld = oldPathRecipientKeys(meta); excludeKeys = shadowExcludeKeys(fullOld, opts.primarySurfaces ?? []); }
  } catch { /* fail-soft */ }

  // §관측 — 스트리밍 발화 가시화. cat=`<surface>.stream`. targeted(배달 대상 수)가 0 이면 무배달
  // (구독자/sink 부재) 즉시 진단(2026-07-16 디스코드 flip 무배달이 이 관측 부재로 진단이 길었음).
  const cat = `${opts.surface ?? 'session'}.stream`;
  let deltas = 0, tools = 0, lastTargeted = -1;

  return {
    delta(text: string): void {
      if (!text) return;
      accum += text;
      try {
        const r = fanOutSessionChunk(sessionId, { streamId, seq: seq++, delta: text }, { excludeKeys, ...(root ? { root } : {}) });
        deltas++;
        if (r.targeted !== lastTargeted) { // targeted 변화 시에만(홍수 방지)·첫 delta 포함
          debug.log(cat, deltas === 1 ? 'start' : 'targeted-change', { streamId, targeted: r.targeted, seq });
          lastTargeted = r.targeted;
        }
      } catch { /* fail-soft — tap 실패가 턴 무중단 */ }
    },
    tool(id: string, name: string, phase: 'call' | 'result', ok?: boolean, result?: unknown): void {
      try {
        const r = fanOutSessionChunk(sessionId, { streamId, seq: seq++, tool: {
          id, name, phase,
          ...(ok != null ? { ok } : {}),
          ...(phase === 'result' && result !== undefined ? { result } : {}),
        } },
          { excludeKeys, ...(root ? { root } : {}) });
        tools++;
        if (r.targeted !== lastTargeted) { debug.log(cat, 'targeted-change', { streamId, targeted: r.targeted }); lastTargeted = r.targeted; }
      } catch { /* fail-soft */ }
    },
    async final(finalText: string): Promise<void> {
      let targeted = -1;
      try {
        const r = await fanOutSessionFinal(sessionId, { streamId, role: 'assistant', text: finalText }, { excludeKeys, ...(root ? { root } : {}) });
        targeted = r.targeted;
      } catch { /* fail-soft */ }
      // §관측 — 턴 요약: 델타/툴 수·최종 배달 대상·최종 길이. targeted=0 이면 스트리밍이 아무에게도
      // 안 갔다는 결정적 신호(무배달 진단의 1차 지표).
      try { debug.log(cat, 'final', { streamId, deltas, tools, targeted, chars: finalText.length }); } catch { /* fail-soft */ }
      try {
        // 청크 parity — 누적 스트림(fan-out 이 낼 시퀀스) vs 최종 메시지(진실). 청크 유실 감지.
        const newRecipients = listSubscribers(sessionId, {}, root)
          .filter((s) => s.presence !== 'left')
          .map((s) => subscriberKey(s.surface, s.endpoint));
        recordChunkParity({
          sessionId, streamId, ...(opts.surface ? { surface: opts.surface } : {}),
          streamedText: accum, finalText, newRecipients, oldRecipients: fullOld,
        });
      } catch { /* fail-soft */ }
    },
  };
}
