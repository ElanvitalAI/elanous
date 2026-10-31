// ── ACP 스트리밍 sink (C5d · 2026-07-16) ──────────────────────────────────────────
//
// 설계 §3.3·§4-C5d. ACP `broadcast`(server.ts)를 통합 청크 fan-out 의 sink 로 흡수. 이 sink 를
// registerStreamingSink('acp', …) 하면 ACP 가 tg/dc 와 대칭인 1급 fabric 서피스가 된다.
//
// broadcast 는 **세션 스코프**(sessionPeers 순회·peerId dedup·caps 게이트가 내부)라, 청크 이벤트를
// ACP sessionUpdate 로 번역해 broadcast(ctx.sessionId, update) 1회 호출만 하면 된다(dedup/caps 는
// broadcast 가 유지 → §3.3 재현이 공짜). fan-out 이 sink 를 **구독자당 1회** 호출하므로 세션당
// **정확히 1개의 'acp' 구독자**가 있어야 N× 중복 broadcast 를 피한다(subscriber bridge 가 보장).
//
// push(chunk) → broadcast(agent_message_chunk) 와 **byte-identical**(§8 parity). tool 은
// tool_call / tool_call_update 로. onFinal 은 no-op — ACP 는 델타 누적 모델(최종 메시지 없음·
// history/onAppend 가 별도 커버). 순수 — broadcast 주입 → 실 ACP 없이 유닛테스트.

import { parseAcpEndpoint, isOwnInstanceEndpoint } from '../session-endpoint-key.js';
import type { StreamingSurfaceSink, SessionChunkEvent, SessionStreamFinal, DeliverContext } from '../session-fanout.js';

/** ACP 브로드캐스터(주입) — server.ts getActiveAcpBroadcaster(). 세션 스코프·peerId dedup·caps 내장. */
export type AcpBroadcast = (sessionId: string, update: unknown) => Promise<{ delivered: number }>;

/** endpoint(acp 완전스코프 키) → sessionId. 인스턴스 가드. bare(비-키)면 그대로 sessionId 로 폴백. */
function resolveSessionId(endpoint: string, ctxSessionId: string): string | null {
  const parsed = parseAcpEndpoint(endpoint);
  if (parsed) {
    if (!isOwnInstanceEndpoint(parsed.instance)) return null; // 크로스 인스턴스 차단
    return parsed.sessionId || ctxSessionId;
  }
  // 폴백 — ctx.sessionId(broadcast 는 어차피 세션 스코프).
  return ctxSessionId;
}

export function createAcpStreamSink(broadcast: AcpBroadcast): StreamingSurfaceSink {
  return {
    onChunk(endpoint: string, ev: SessionChunkEvent, ctx: DeliverContext): void {
      const sessionId = resolveSessionId(endpoint, ctx.sessionId);
      if (!sessionId) return;
      if (ev.delta) {
        // push(chunk) 등가 — agent_message_chunk(byte-identical).
        void broadcast(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ev.delta },
          ...(ev.textOperation === 'replace' ? { _meta: { elanous: { textOperation: 'replace' } } } : {}) });
      }
      if (ev.reasoning) {
        // 🧠 추론 — agent_thought_chunk(ACP 의 thought 채널).
        void broadcast(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ev.reasoning } });
      }
      if (ev.tool) {
        if (ev.tool.phase === 'call') {
          void broadcast(sessionId, { sessionUpdate: 'tool_call', toolCallId: ev.tool.id, title: ev.tool.name, status: 'pending' });
        } else {
          // ⭐ 결과를 ACP 표준 칸 `rawOutput` 으로 실어 보낸다.
          //    ⛔ **새 이름을 짓지 않는다** — 이 이름은 SDK 스키마에 있고
          //    (`@agentclientprotocol/sdk/schema/schema.json`), 이 저장소의 대시보드가
          //    «이미» 그 이름으로 읽는다(`src/tui-client/dashboard-session.ts:539·567`).
          //    ⇒ 채우면 PWA 뿐 아니라 TUI 도 «코드 변경 없이» 같은 값을 받는다.
          //    ⛔ 값이 없으면 «사유를 지어내지 않는다** — 이 층은 「왜 없는지」를 모른다.
          const result = (ev.tool as { result?: unknown }).result;
          void broadcast(sessionId, {
            sessionUpdate: 'tool_call_update', toolCallId: ev.tool.id,
            status: ev.tool.ok === false ? 'failed' : 'completed',
            ...(result !== undefined ? { rawOutput: result } : {}),
          });
        }
      }
    },

    // ACP 는 델타 누적 모델 — 최종 메시지 별도 방출 없음(history/onAppend 커버). no-op.
    onFinal(_endpoint: string, _ev: SessionStreamFinal): void { /* no-op */ },

    // 중단 — ACP 는 stopReason 으로 별도 신호(broadcast 아님). no-op.
    onAbort(_endpoint: string, _streamId: string): void { /* no-op */ },
  };
}
