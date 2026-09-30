// MVP M2.4 — WebSocket ACP **client** transport.
//
// Mirror of `src/boot/daemon-public-server.ts`'s WS handshake on the
// client side. Lets a TUI on a different machine attach to a daemon
// over Tailscale tailnet (or any network reachable WebSocket).
//
// Pairs with the WS endpoint at `/v1/acp` exposed by
// `startDaemonPublicServer` (see daemon-public-server.ts:250). Auth
// handshake matches `src/acp/transport/auth.ts` `AcpAuthHandshake`:
//   client → server: {kind:'auth', token, label?} as one JSON line
//   server → client: {ok:true}  or  {ok:false, reason}
// After `{ok:true}` the channel forwards raw ACP NDJSON bytes both
// ways, identical to the unix-socket transport.
//
// noAuth mode (`token` omitted): no handshake — client just sends
// ACP bytes immediately on open. Server's noAuth code path
// (daemon-public-server.ts:312–321) marks the socket authed at open
// time, so this matches one-to-one.
//
// Used by:
//   - `elanous attach --host <tailnet>:<port>` (R2)
//   - `monad-agent` default dashboard, when ELANOUS_REMOTE is set (R3)

import {
  AcpTransportError,
  type AcpTransportConnection,
} from '../acp/transport/index.js';
import { debug } from '../debug/log.js';

export interface ConnectWebSocketClientOpts {
  /** Full WebSocket URL — e.g. `ws://mbp.tailnet:31415/v1/acp`. */
  url: string;
  /** Bearer token. Omit for `--no-http-auth` daemons (Tailscale-only). */
  token?: string;
  /** Best-effort tag for server-side debug log; defaults to host. */
  label?: string;
  /** Best-effort tag for client-side `peerId`. Defaults to `ws:<url>`. */
  peerLabel?: string;
  /** Abort the in-flight connect attempt. After connect, use the
   *  returned `close()` instead. */
  signal?: AbortSignal;
  /** ⏱️ 연결이 «어느 단계에서» 멎어도 반드시 끝나게 하는 상한(ms).
   *  ⛔ 없으면 서버가 핸드셰이크에 답하지 않을 때 이 Promise 가 «영원히» 안 풀린다 —
   *     그러면 호출자는 산출도 종료 코드도 못 얻는다(2026-08-31 실측: 100초 상한을 걸 때까지 매달렸다). */
  connectTimeoutMs?: number;
  onDisconnect?(info: { reason: 'close' | 'error'; code?: number; afterMs: number; at: string; lastEventId?: string }): void;
}

/** ⏱️ 기본 연결 상한. 테일넷 왕복은 보통 수백 ms 라 넉넉하다. */
export const DEFAULT_WS_CONNECT_TIMEOUT_MS = 10_000;

/** Maximum NDJSON line inspected for an event id; ACP stream delivery is not limited. */
const MAX_EVENT_ID_LINE_LENGTH = 64 * 1024;

/** Connect to a Elanous daemon over its public WebSocket endpoint.
 *  Resolves with the bidirectional stream pair once the (optional)
 *  auth handshake has completed; rejects with `AcpTransportError` on
 *  any failure (network, auth-rejected, abort). */
export async function connectWebSocketClient(
  opts: ConnectWebSocketClientOpts,
): Promise<AcpTransportConnection> {
  const peerId = opts.peerLabel ?? `ws:${opts.url}`;
  if (opts.signal?.aborted) {
    throw new AcpTransportError('websocket-client', 'aborted');
  }

  return new Promise<AcpTransportConnection>((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(opts.url);
    } catch (err) {
      reject(new AcpTransportError('websocket-client', `bad url: ${(err as Error).message}`));
      return;
    }
    // Bun + browsers default to 'blob' for binary frames; 'arraybuffer'
    // gives us Uint8Array semantics that match the unix client.
    ws.binaryType = 'arraybuffer';

    let settled = false;
    let connectedAt: number | null = null;
    let disconnected = false;
    let lastEventId: string | undefined;
    let incomingLine = '';
    let oversizedLine = false;
    const lineDecoder = new TextDecoder();
    const recordEventId = (line: string): void => {
      try {
        const message: unknown = JSON.parse(line);
        if (message !== null && typeof message === 'object' && 'id' in message
          && typeof message.id === 'string') lastEventId = message.id;
      } catch { /* Non-JSON or incomplete ACP payload. */ }
    };
    const trackEventIds = (text: string): void => {
      let start = 0;
      while (start < text.length) {
        const newline = text.indexOf('\n', start);
        const end = newline < 0 ? text.length : newline;
        const length = end - start;
        if (!oversizedLine) {
          if (incomingLine.length + length <= MAX_EVENT_ID_LINE_LENGTH) {
            incomingLine += text.slice(start, end);
          } else {
            incomingLine = '';
            oversizedLine = true;
          }
        }
        if (newline < 0) break;
        if (!oversizedLine) recordEventId(incomingLine);
        incomingLine = '';
        oversizedLine = false;
        start = newline + 1;
      }
    };
    const recordConnected = (): void => {
      connectedAt = Date.now();
      try {
        const host = new URL(opts.url).hostname;
        debug.log('tui-client.ws', 'connected', {
          hostKind: host === 'localhost' || host === '127.0.0.1' || host === '::1' ? 'local' : 'remote',
        });
      } catch { /* observation must not prevent connection */ }
    };
    const disconnect = (reason: 'close' | 'error', code?: number): void => {
      finishReadable();
      if (connectedAt === null || disconnected) return;
      disconnected = true;
      trackEventIds(lineDecoder.decode());
      if (incomingLine && !oversizedLine) recordEventId(incomingLine);
      const info = {
        reason,
        ...(code !== undefined ? { code } : {}),
        afterMs: Math.max(0, Date.now() - connectedAt),
        at: new Date().toISOString(),
        ...(lastEventId !== undefined ? { lastEventId } : {}),
      };
      try { debug.log('tui-client.ws', 'disconnect', info); } catch { /* observation must not prevent notification */ }
      opts.onDisconnect?.(info);
    };
    let authed = !opts.token; // noAuth mode = no handshake needed
    // ⛔ 「안 됐다」를 한 값으로 접지 않는다 — «어느 단계»에서 멎었는지 이름을 붙인다.
    //    소켓조차 안 열린 것과, 열렸는데 서버가 인증에 «답을 안 한» 것은 다른 결함이다.
    let stage: 'opening' | 'awaiting-auth-response' = 'opening';
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    const clearConnectTimer = (): void => {
      if (connectTimer !== null) { clearTimeout(connectTimer); connectTimer = null; }
    };
    let readableController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let serverClosedReadable = false;

    const finishReadable = (): void => {
      if (serverClosedReadable) return;
      serverClosedReadable = true;
      if (readableController) {
        try { readableController.close(); } catch { /* already closed */ }
      }
    };

    const failConnect = (reason: string): void => {
      if (settled) {
        finishReadable();
        return;
      }
      settled = true;
      clearConnectTimer();
      opts.signal?.removeEventListener('abort', onAbort);
      try { ws.close(); } catch { /* best-effort */ }
      reject(new AcpTransportError('websocket-client', reason));
    };

    const onAbort = (): void => {
      failConnect('aborted');
    };
    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const buildConnection = (): AcpTransportConnection => {
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          readableController = controller;
          if (serverClosedReadable) {
            // ws closed before the stream consumer subscribed.
            try { controller.close(); } catch { /* already */ }
          }
        },
      });
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          // WebSocket.send accepts ArrayBufferView. The server's
          // message handler decodes via TextDecoder either way, so
          // sending the underlying buffer keeps frame parity with
          // the unix transport.
          ws.send(chunk);
        },
        close() {
          try { ws.close(1000); } catch { /* already */ }
        },
        abort() {
          try { ws.close(1011); } catch { /* already */ }
        },
      });
      return {
        readable,
        writable,
        peerId,
        async close() {
          try { ws.close(1000); } catch { /* already */ }
        },
      };
    };

    ws.addEventListener('open', () => {
      if (settled) return;
      if (!opts.token) {
        // noAuth: server is ready to accept ACP bytes immediately.
        settled = true;
        clearConnectTimer();
        opts.signal?.removeEventListener('abort', onAbort);
        recordConnected();
        resolve(buildConnection());
        return;
      }
      stage = 'awaiting-auth-response';
      const handshake = JSON.stringify({
        kind: 'auth',
        token: opts.token,
        ...(opts.label ? { label: opts.label } : {}),
      });
      try {
        ws.send(handshake);
      } catch (err) {
        failConnect(`auth send failed: ${(err as Error).message}`);
      }
    });

    ws.addEventListener('message', (ev: MessageEvent<unknown>) => {
      if (!authed) {
        // First server message after connect = handshake response.
        const text = typeof ev.data === 'string'
          ? ev.data
          : new TextDecoder().decode(ev.data as ArrayBuffer);
        let resp: { ok?: boolean; reason?: string };
        try { resp = JSON.parse(text) as { ok?: boolean; reason?: string }; }
        catch { failConnect('malformed auth response'); return; }
        if (resp.ok === true) {
          authed = true;
          if (!settled) {
            settled = true;
            clearConnectTimer();
            opts.signal?.removeEventListener('abort', onAbort);
            recordConnected();
            resolve(buildConnection());
          }
        } else {
          failConnect(`auth rejected: ${resp.reason ?? 'unknown'}`);
        }
        return;
      }
      // Authed: forward bytes to the consumer's ReadableStream.
      const bytes = typeof ev.data === 'string'
        ? new TextEncoder().encode(ev.data)
        : new Uint8Array(ev.data as ArrayBuffer);
      trackEventIds(lineDecoder.decode(bytes, { stream: true }));
      if (!readableController) return;
      try { readableController.enqueue(bytes); }
      catch { /* stream already closed */ }
    });

    // ⏱️ 어느 단계에서 멎든 이 Promise 는 «반드시» 끝난다. 산출에 단계 이름을 담는다.
    // ⛔ 0·음수·NaN 을 «상한 없음»으로 읽지 않는다 — 그러면 이 판이 고친 무한 대기가 그대로 돌아온다.
    //    「안 줬다」와 「못 읽었다」를 둘 다 «기본값»으로 접는다. 상한이 없는 길은 두지 않는다.
    const requested = opts.connectTimeoutMs;
    const timeoutMs = (typeof requested === 'number' && Number.isFinite(requested) && requested > 0)
      ? requested
      : DEFAULT_WS_CONNECT_TIMEOUT_MS;
    {
      connectTimer = setTimeout(() => {
        failConnect(stage === 'opening'
          ? `connect timed out after ${timeoutMs}ms: socket never opened (${opts.url})`
          : `connect timed out after ${timeoutMs}ms: server accepted the socket but never answered the auth handshake (${opts.url})`);
      }, timeoutMs);
      // ⛔ unref() 를 «걸지 않는다» — 걸면 다른 핸들이 없을 때 프로세스가 상한 «전»에 조용히
      //    끝나 버려, 이 판이 세운 「반드시 끝나고 «이유»를 말한다」 보장이 무효가 된다.
      //    ⇒ 연결을 시도하는 «동안»에는 타이머가 루프를 붙잡고, settle 되면 반드시 clear 한다
      //      (resolve 세 자리 · failConnect 한 자리 모두 clearConnectTimer 를 부른다).
    }

    ws.addEventListener('error', () => {
      // Bun/browser WebSocket fires error then close; only treat the
      // pre-settled error as a connect failure. Post-settled errors
      // close the readable stream and notify the dashboard once.
      if (!settled) {
        // ⛔ 「연결 오류」 한 값으로 접지 않는다 — open «전»이면 소켓이 안 열린 것이고,
        //    open «뒤»면 서버가 붙여 놓고 인증에 답하지 않은 것이다. 다른 결함이다.
        failConnect(stage === 'opening'
          ? `socket never opened: connection error (${opts.url})`
          : `server accepted the socket but never answered the auth handshake: connection error (${opts.url})`);
      } else {
        disconnect('error');
      }
    });

    ws.addEventListener('close', (ev: CloseEvent) => {
      if (!settled) {
        failConnect(stage === 'opening'
          ? `socket never opened: closed before ready (${opts.url})`
          : `server accepted the socket but never answered the auth handshake: closed before ready (${opts.url})`);
      } else {
        disconnect('close', ev.code);
      }
    });
  });
}

/** Probe whether a daemon's WS endpoint is reachable + accepting our
 *  auth (if `token` set). Returns `true` on a clean handshake, `false`
 *  on any failure. Useful for CLI status hints. */
export async function isWebSocketReachable(
  opts: ConnectWebSocketClientOpts,
): Promise<boolean> {
  try {
    const conn = await connectWebSocketClient(opts);
    await conn.close();
    return true;
  } catch {
    return false;
  }
}
