// NEXUS N-1.5 PR c — shared WS bridge factory.
//
// Hosts the `/v1/acp` (ACP JSON-RPC) and `/v1/voice/ws` (PWA voice)
// upgrade-and-dispatch logic that previously lived inline in
// `daemon-public-server.ts`. Extracted so the NEXUS HTTP server can
// mount the same WS surface natively (decision #18 · v6 hard
// landing). Behaviour is preserved 1:1 — daemon-public uses the
// factory output via the same call shape, and NEXUS plugs in the
// same opts when ready.
//
// Why a factory (vs free helpers): WS state lives in a per-server
// WeakMap (`states`), and `wireAcpForSocket` / `wireVoiceForSocket`
// close over `opts` (`acpOnConnection`, `voiceAdapter`,
// `wsAuthVerifier`, hostname/port for peerId). Capturing those once
// at construction keeps the per-message hot path branch-free.

import type {
  AcpAuthVerifier,
} from '../acp/transport/auth.js';
import type {
  AcpConnectionHandler,
  AcpTransportConnection,
} from '../acp/transport/types.js';
import type {
  PwaVoiceAdapter,
  PwaVoiceSession,
} from '../voice/channel-adapters/pwa-voice-adapter.js';
import { PWA_VOICE_FRAME_KIND } from '../voice/channel-adapters/pwa-voice-adapter.js';
import { isSameOriginRequest } from './check-same-origin.js';
import {
  buildDevProxyWsUrl,
  closeDevProxyUpstream,
  pathMatchesDevProxyWs,
  relayDevProxyClientMessage,
  wireDevProxyWebSocket,
  type DevProxyWsState,
  type DevProxyWsWireOpts,
} from '../nexus/api/dev-proxy.js';

export const WS_ACP_PATH = '/v1/acp';
export const WS_VOICE_PATH = '/v1/voice/ws';

export type WsLike = {
  send: (data: string | Uint8Array) => void;
  close: (code?: number, reason?: string) => void;
  data?: unknown;
};

export type BunServerLike = {
  upgrade: (req: Request, opts?: { data?: unknown; headers?: HeadersInit }) => boolean;
  /** Bun's transport peer — used only for the same-origin exemption (HTTP 과 같은 규칙). */
  requestIP?: (req: Request) => { address: string } | null;
};

export type WsHandlers = {
  open?: (ws: WsLike) => void;
  message?: (ws: WsLike, msg: string | Uint8Array) => void;
  close?: (ws: WsLike, code: number, reason: string) => void;
};

interface AcpPerSocketState {
  kind: 'acp';
  authed: boolean;
  controller?: ReadableStreamDefaultController<Uint8Array>;
}

interface VoicePerSocketState {
  kind: 'voice';
  authed: boolean;
  session?: PwaVoiceSession;
  unsubDownstream?: () => void;
}

interface DevProxyPerSocketState extends DevProxyWsState {
  kind: 'dev-proxy';
}

type PerSocketState = AcpPerSocketState | VoicePerSocketState | DevProxyPerSocketState;

export interface WsBridgeOpts {
  /** ACP transport handler. When omitted, /v1/acp returns 404. */
  acpOnConnection?: AcpConnectionHandler;
  /** Optional WS auth verifier (Bearer-shape handshake). When omitted,
   *  ACP/voice paths are open. Presence of this verifier is the ACP
   *  auth gate — callers pass it only when a bearer token is configured. */
  wsAuthVerifier?: AcpAuthVerifier;
  /** PWA voice adapter. When omitted or `available=false`, /v1/voice/ws
   *  returns 404. */
  voiceAdapter?: PwaVoiceAdapter;
  /** Hostname for peerId (informational). */
  hostname: string;
  /** Port for peerId (informational). */
  port: number;
  /** Optional emitter for the [voice-ws-trace] forensic logs that
   *  daemon-public-server already produces. NEXUS callers can pass
   *  a noop or a different sink. Defaults to console.log. */
  trace?: (event: string, detail: Record<string, unknown>) => void;
  /** P-2B.2 — when set, WS upgrades on Next.js HMR paths
   *  (`/_next/webpack-hmr` etc.) are forwarded to this upstream
   *  origin. Static value — present mainly for tests; production
   *  hosts pass `devProxyUpstreamFn` so the upgrade follows the
   *  live admin-mutated ref. */
  devProxyUpstream?: string;
  /** P-2D.2 — read the upstream live on each upgrade so admin POST/
   *  DELETE flips take effect on the next HMR reconnect (HMR sockets
   *  reconnect aggressively when the patch socket dies). Returns
   *  `undefined` to disable forwarding for that upgrade. */
  devProxyUpstreamFn?: () => string | undefined;
  /** Test seam — replace the WebSocket constructor used to dial the
   *  dev-proxy upstream. */
  devProxyWsCtor?: DevProxyWsWireOpts['webSocketCtor'];
}

export interface WsBridge {
  /** Bun WS handlers — pass directly to `Bun.serve({ websocket })`. */
  websocket: WsHandlers;
  /** Try to upgrade the request to an ACP/voice WS. Returns the response
   *  to send, or `undefined` when the path didn't match a WS endpoint
   *  (caller continues HTTP routing). */
  tryUpgrade(req: Request, server: BunServerLike): Response | undefined;
}

const NOT_FOUND_BODY = JSON.stringify({ error: 'not_found' });

function encodeVoiceFrame(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, kind);
  view.setUint8(1, 0);
  view.setUint16(2, 0, false);
  out.set(payload, 4);
  return out;
}

function defaultTrace(event: string, detail: Record<string, unknown>): void {
  console.log(event, JSON.stringify(detail));
}

const BEARER_PREFIX = 'bearer ';
const BEARER_SUBPROTOCOL_PREFIX = 'bearer.';

/** Extract an offered ACP token from the upgrade request.
 *  Priority: Authorization: Bearer, then a `bearer.` entry in
 *  Sec-WebSocket-Protocol. Returns `undefined` when none is offered
 *  so the socket can upgrade unauthenticated and complete auth on
 *  the first `{kind:'auth', token}` JSON line. */
export function offeredAcpTokenFromUpgrade(req: Request): string | undefined {
  const authorization = req.headers.get('authorization');
  if (authorization) {
    const trimmed = authorization.trim();
    if (trimmed.length >= BEARER_PREFIX.length
      && trimmed.slice(0, BEARER_PREFIX.length).toLowerCase() === BEARER_PREFIX) {
      const token = trimmed.slice(BEARER_PREFIX.length).trim();
      if (token.length > 0) return token;
    }
  }
  const protocolHeader = req.headers.get('sec-websocket-protocol');
  if (!protocolHeader) return undefined;
  for (const raw of protocolHeader.split(',')) {
    const entry = raw.trim();
    if (entry.length > BEARER_SUBPROTOCOL_PREFIX.length
      && entry.slice(0, BEARER_SUBPROTOCOL_PREFIX.length).toLowerCase() === BEARER_SUBPROTOCOL_PREFIX) {
      const token = entry.slice(BEARER_SUBPROTOCOL_PREFIX.length);
      if (token.length > 0) return token;
    }
  }
  return undefined;
}

export function createWsBridge(opts: WsBridgeOpts): WsBridge {
  const states = new WeakMap<object, PerSocketState>();
  const trace = opts.trace ?? defaultTrace;

  function wireAcpForSocket(ws: WsLike, state: AcpPerSocketState): void {
    const readable = new ReadableStream<Uint8Array>({
      start(controller) { state.controller = controller; },
    });
    const writable = new WritableStream<Uint8Array>({
      write(chunk) { ws.send(chunk); },
      close() { ws.close(1000); },
      abort() { ws.close(1011); },
    });
    const conn: AcpTransportConnection = {
      readable,
      writable,
      peerId: `ws:${opts.hostname}:${opts.port}#${Math.random().toString(36).slice(2, 10)}`,
      async close() { ws.close(1000); },
    };
    Promise.resolve(opts.acpOnConnection!(conn)).catch(() => { /* swallow */ });
  }

  async function wireVoiceForSocket(ws: WsLike, state: VoicePerSocketState): Promise<void> {
    if (!opts.voiceAdapter) return;
    try {
      const session = await opts.voiceAdapter.openSession();
      state.session = session;
      state.unsubDownstream = session.onDownstream((frame) => {
        const u8 = new Uint8Array(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.byteLength);
        try { ws.send(encodeVoiceFrame(PWA_VOICE_FRAME_KIND.DOWNSTREAM_PCM, u8)); }
        catch { /* socket gone */ }
      });
      session.onStateChange((s) => {
        try {
          ws.send(encodeVoiceFrame(
            PWA_VOICE_FRAME_KIND.DOWNSTREAM_STATE,
            new TextEncoder().encode(JSON.stringify({ state: s })),
          ));
        } catch { /* socket gone */ }
      });
      session.onTranscript?.((evt) => {
        try {
          ws.send(encodeVoiceFrame(
            PWA_VOICE_FRAME_KIND.DOWNSTREAM_TRANSCRIPT,
            new TextEncoder().encode(JSON.stringify(evt)),
          ));
        } catch { /* socket gone */ }
      });
    } catch (err) {
      try {
        ws.send(encodeVoiceFrame(
          PWA_VOICE_FRAME_KIND.DOWNSTREAM_ERROR,
          new TextEncoder().encode(JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          })),
        ));
      } catch { /* swallow */ }
      ws.close(1011, 'voice session open failed');
    }
  }

  function tryUpgrade(req: Request, server: BunServerLike): Response | undefined {
    const url = new URL(req.url);
    if (url.pathname === WS_ACP_PATH) {
      if (!opts.acpOnConnection) {
        return new Response(NOT_FOUND_BODY, {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      let authed = !opts.wsAuthVerifier;
      if (opts.wsAuthVerifier) {
        const offered = offeredAcpTokenFromUpgrade(req);
        if (offered !== undefined) {
          const result = opts.wsAuthVerifier.verify({ kind: 'auth', token: offered });
          if (!result.ok) {
            return new Response(JSON.stringify(result), {
              status: 401,
              headers: { 'content-type': 'application/json' },
            });
          }
          authed = true;
        } else if (isSameOriginRequest(req, server.requestIP?.(req)?.address)) {
          // ⭐ HTTP 의 same-origin 면제(`meta-api.ts` decideAuth)와 «같은» 규칙 — 루프백 직결 ⊕ 프록시 표지 없음 ⊕
          //   Sec-Fetch-Site/Origin 이 같은 출처. 이 데몬이 내준 PWA 페이지가 토큰 없이 연 소켓이다.
          // 🩸 2026-09-30 0.2.5 회귀: #21937 이 토큰을 «늘» 만들게 되면서 WS 검증기가 늘 켜졌고, 토큰을
          //   저장하지 않은 PWA(새 설치 · 격리 넥서스)의 ACP 가 첫 `initialize` 에서 1008 auth_failed 로 닫혔다
          //   — HTTP 는 이 면제로 살아 있어 «목록은 뜨는데 채팅·터미널만 죽는» 모양이 됐다.
          authed = true;
          trace('acp.ws.same-origin', { path: url.pathname });
        }
      }
      const acpState: AcpPerSocketState = {
        kind: 'acp',
        authed,
      };
      // ⚠️ 실측(2026-09-01 · 격리 데몬 raw 101):
      //     요청  Sec-WebSocket-Protocol: bearer.<token>
      //     응답  Sec-WebSocket-Protocol: bearer.<token>   ⇐ Bun 이 «되돌려 보낸다»
      //   우리가 headers 를 «안 줘도» 그렇고, `headers: {'sec-websocket-protocol': ''}`
      //   로 억제를 시도하면 헤더가 «둘»이 되고 에코는 그대로다(더 나쁘다).
      //   ⇒ 이 자리에서는 억제할 수 없다. 그래서 여기서는 headers 를 «주지 않는다» —
      //     프로토콜을 «선택»하면 브라우저의 ws.protocol 이 바뀌기 때문이다.
      //   🔑 결과: 토큰이 101 응답 헤더에 «되비친다». 보낸 클라이언트에게만 돌아가므로
      //     제3자 노출은 아니지만, 프록시·개발자도구 로그에는 더 잘 보인다.
      //     없애려면 클라이언트가 비-비밀 서브프로토콜을 «하나 더» 제시하고 서버가
      //     그것을 고르면 된다 — apps/pwa 변경이 필요한 «다른 축»이다.
      const upgraded = server.upgrade(req, { data: { state: acpState } });
      if (!upgraded) return new Response('upgrade required', { status: 426 });
      return undefined;
    }
    if (pathMatchesDevProxyWs(url.pathname)) {
      const upstreamHost = opts.devProxyUpstreamFn
        ? opts.devProxyUpstreamFn()
        : opts.devProxyUpstream;
      if (upstreamHost) {
        const upstreamUrl = buildDevProxyWsUrl(upstreamHost, url.pathname, url.search);
        const devProxyState: DevProxyPerSocketState = {
          kind: 'dev-proxy',
          upstreamUrl,
          upstream: null,
          pending: [],
          ready: false,
        };
        const upgraded = server.upgrade(req, { data: { state: devProxyState } });
        if (!upgraded) return new Response('upgrade required', { status: 426 });
        return undefined;
      }
    }
    if (url.pathname === WS_VOICE_PATH) {
      const traceHeaders = {
        origin: req.headers.get('origin'),
        host: req.headers.get('host'),
        upgrade: req.headers.get('upgrade'),
        connection: req.headers.get('connection'),
        secWsVersion: req.headers.get('sec-websocket-version'),
        secWsProtocol: req.headers.get('sec-websocket-protocol'),
        secWsExtensions: req.headers.get('sec-websocket-extensions'),
        userAgent: req.headers.get('user-agent')?.slice(0, 80),
      };
      trace('[voice-ws-trace] upgrade-attempt', {
        method: req.method,
        path: url.pathname,
        adapterPresent: !!opts.voiceAdapter,
        adapterAvailable: opts.voiceAdapter?.available ?? false,
        headers: traceHeaders,
      });
      if (!opts.voiceAdapter || !opts.voiceAdapter.available) {
        trace('[voice-ws-trace] adapter-unavailable → 404', {});
        return new Response(NOT_FOUND_BODY, {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      const voiceState: VoicePerSocketState = {
        kind: 'voice',
        // ⛔ Voice stays OPEN even when a verifier is wired. This is a
        //    deliberate scope boundary, not an oversight — gating it here
        //    would break both shipping voice clients today:
        //      · apps/pwa/src/voice/voice-websocket.ts:70
        //        `new WebSocket(opts.url)` — no header, no subprotocol.
        //        It authenticates with an UPSTREAM_HELLO frame carrying
        //        `{token}`, which is NOT the `{kind:'auth', token}` shape
        //        `verify()` accepts ⇒ it would be rejected as `malformed`
        //        and the socket closed with 1008.
        //      · apps/ios/.../VoiceWebSocketClient.swift:139 says outright
        //        "Authorization 헤더는 우회".
        //    Voice auth needs the HELLO envelope taught to the verifier —
        //    a separate axis from this PR (which wires ACP only).
        //
        //    ⚠️ 이것은 «회귀 방어»가 아니라 ***의도적인 인증 우회 계약***이다.
        //    런타임 동작은 안 바뀌지만(이 PR 전에는 wsAuthVerifier 가 어디서도 대입되지
        //    않아 voice 는 «언제나» 열려 있었다) ***잠재 관문은 제거된다.***
        //    위협모델 — 열어 두면 무엇이 되나:
        //      · 노출되는 것: PCM 업스트림 ⊕ 전사/TTS 다운스트림. STT 할당량을 소모할 수 있다.
        //        ⛔ ACP 도구 표면·파일시스템은 «이 소켓으로 안 열린다»(그건 /v1/acp 이고 이 PR 이 잠근다).
        //      · 닿을 수 있는 자: 바인드 인터페이스에 닿는 누구나. 운영은 오늘 0.0.0.0 이라 테일넷 포함.
        //      · 그럼에도 지금 여는 이유: 오늘 잠그면 PWA·iOS 음성이 «둘 다» 끊긴다(위 실측).
        //        그리고 오늘의 대안은 「/v1/acp 도 무인증」이며 그쪽이 «훨씬» 나쁘다.
        //      · 닫는 길: verify() 에 HELLO 봉투를 가르치거나 PWA 가 {kind:'auth'} 를 보내게 한 뒤
        //        이 줄을 `!opts.wsAuthVerifier` 로 되돌린다. 그때 이 주석도 같이 지운다.
        authed: true,
      };
      const upgraded = server.upgrade(req, { data: { state: voiceState } });
      trace('[voice-ws-trace] upgrade-result', { upgraded });
      if (!upgraded) return new Response('upgrade required', { status: 426 });
      return undefined;
    }
    return undefined;
  }

  const websocket: WsHandlers = {
    open(ws) {
      const data = (ws as unknown as { data?: { state?: PerSocketState } }).data;
      const state: PerSocketState = data?.state ?? { kind: 'acp', authed: !opts.wsAuthVerifier };
      states.set(ws, state);
      if (state.kind === 'voice') {
        trace('[voice-ws-trace] socket-open', { authed: state.authed });
        void wireVoiceForSocket(ws, state);
        return;
      }
      if (state.kind === 'dev-proxy') {
        wireDevProxyWebSocket(
          {
            send: (d) => { try { ws.send(d); } catch { /* gone */ } },
            close: (code, reason) => { try { ws.close(code, reason); } catch { /* gone */ } },
          },
          state,
          opts.devProxyWsCtor ? { webSocketCtor: opts.devProxyWsCtor } : {},
        );
        return;
      }
      if (state.authed && opts.acpOnConnection) {
        wireAcpForSocket(ws, state);
      }
    },
    message(ws, raw) {
      const state = states.get(ws);
      if (!state) return;
      if (state.kind === 'dev-proxy') {
        relayDevProxyClientMessage(state, raw);
        return;
      }
      if (state.kind === 'voice') {
        if (typeof raw === 'string') return;
        const u8 = raw as Uint8Array;
        if (u8.byteLength < 4) return;
        const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        const kind = view.getUint8(0);
        const payload = u8.subarray(4);
        if (kind === PWA_VOICE_FRAME_KIND.UPSTREAM_HELLO) {
          if (!state.authed && opts.wsAuthVerifier) {
            try {
              const json = JSON.parse(new TextDecoder().decode(payload));
              const result = opts.wsAuthVerifier.verify(json);
              if (!result.ok) {
                try {
                  ws.send(encodeVoiceFrame(
                    PWA_VOICE_FRAME_KIND.DOWNSTREAM_ERROR,
                    new TextEncoder().encode(JSON.stringify(result)),
                  ));
                } catch { /* swallow */ }
                ws.close(1008, 'auth failed');
                return;
              }
              state.authed = true;
            } catch {
              ws.close(1008, 'malformed hello');
              return;
            }
          }
          return;
        }
        if (!state.authed || !state.session) return;
        if (kind === PWA_VOICE_FRAME_KIND.UPSTREAM_PCM) {
          state.session.pushUpstream({ pcm: Buffer.from(payload) });
          return;
        }
        if (kind === PWA_VOICE_FRAME_KIND.UPSTREAM_FINALIZE) {
          void state.session.finalize().catch(() => { /* swallow */ });
          return;
        }
        if (kind === PWA_VOICE_FRAME_KIND.UPSTREAM_INTERRUPT) {
          // BI-1 manual barge-in (Phase D · 2026-05-09) — drop in-flight
          // STT + signal cancellation. Sessions that don't implement
          // interrupt (stub / older adapters) silently no-op so the
          // browser doesn't get a hard 1011 close on a feature gap.
          if (typeof state.session.interrupt === 'function') {
            void state.session.interrupt().catch(() => { /* swallow */ });
          }
          return;
        }
        return;
      }
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      if (!state.authed) {
        let handshake: unknown;
        try { handshake = JSON.parse(text); } catch {
          ws.send(JSON.stringify({ ok: false, reason: 'malformed' }));
          ws.close(1008, 'malformed_handshake');
          return;
        }
        const result = opts.wsAuthVerifier!.verify(handshake);
        if (!result.ok) {
          ws.send(JSON.stringify(result));
          ws.close(1008, 'auth_failed');
          return;
        }
        state.authed = true;
        ws.send(JSON.stringify({ ok: true }));
        if (opts.acpOnConnection) wireAcpForSocket(ws, state);
        return;
      }
      if (!state.controller) return;
      state.controller.enqueue(new TextEncoder().encode(text));
    },
    close(ws, code, reason) {
      const state = states.get(ws);
      if (!state) return;
      if (state.kind === 'dev-proxy') {
        closeDevProxyUpstream(state);
        return;
      }
      if (state.kind === 'voice') {
        trace('[voice-ws-trace] socket-close', {
          code,
          reason: reason?.slice(0, 120),
          hadSession: !!state.session,
          authed: state.authed,
        });
        try { state.unsubDownstream?.(); } catch { /* ignore */ }
        if (state.session) {
          state.session.close().catch(() => { /* swallow */ });
        }
      } else if (state.controller) {
        try { state.controller.close(); } catch { /* already */ }
      }
    },
  };

  return { websocket, tryUpgrade };
}
