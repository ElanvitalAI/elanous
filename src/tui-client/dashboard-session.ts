// UI-Core arc Phase U3b Step 3 — DashboardSession.
//
// Couples `runAcpServer` + `bridgeCoreTurnToAcp` + an in-process
// transport so the dashboard can send prompts to "its own" ACP
// server without opening a socket. Phase 5c-2 (2026-04-25) retired
// the previous `ELANOUS_TUI_VIA_ACP` flag: every dashboard turn now
// routes through this scaffold.
//
// Scope of this scaffold:
//   - Boot a server + client pair, tied together via
//     createInProcessTransportPair.
//   - Wait for the client to complete the `initialize` +
//     `newSession` handshake on construction.
//   - Expose a single `send(userText)` method that awaits the
//     prompt's stopReason and streams text deltas back via a
//     caller-supplied `onText` callback.
//   - Offer a `close()` that tears down both sides cleanly.
//
// What this intentionally does NOT do (yet):
//   - Touch dashboard/index.ts call sites. U3b Step 3 is a
//     separate-PR effort that starts with ~15 sites under the
//     flag OFF, then flips the default in a follow-up. This
//     scaffold lets that refactor be a substitution rather than
//     a simultaneous design.
//   - Expose tool events / onTurnComplete history. Those land
//     as the call-site substitution needs them. The scaffold
//     carries forward only the event set all prompts share.
//
// Production boot wires `deps.getMessages` / `getTools` /
// `dispatchTool` to the dashboard's existing history + tool
// catalog + resolver. Tests pass stubs.

import {
  ClientSideConnection,
  ndJsonStream,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk';

import { runAcpServer, type AcpServerOptions } from '../acp/server.js';
import {
  bridgeCoreTurnToAcp,
  type CoreTurnBridgeDeps,
} from '../acp/core-turn-bridge.js';
import {
  parseElanousUiEnvelope,
  type ElanousUiUsagePayload,
} from '../acp/elanous-extensions.js';
import {
  buildAcpPrompt,
  type NormalizedAttachment,
} from '../acp/content-blocks.js';
import type { AcpTransportConnection } from '../acp/transport/index.js';
import { createInProcessTransportPair } from './in-process-transport.js';
import { writeOriginSessionMeta } from '../acp/origin-session-meta.js';

/** F1 — Phase 3 · handler for inbound ACP `requestPermission` calls.
 *  Boot-time registrable; fires whenever the server-side bridge (or
 *  any other ACP agent path) issues a permission request. Return the
 *  selected option (or `'cancelled'`) wrapped in an ACP-shaped
 *  response. */
export type DashboardRequestPermissionHandler = (
  req: RequestPermissionRequest,
) => Promise<RequestPermissionResponse> | RequestPermissionResponse;

export interface DashboardSessionOptions extends CoreTurnBridgeDeps {
  /** Working directory reported in `newSession(cwd)`. */
  cwd: string;
  /** Agent name + version piped through AcpServerOptions. */
  agentName?: string;
  agentVersion?: string;
  /** Test seam: override server options. Production callers don't set this. */
  serverOptions?: Partial<AcpServerOptions>;
  /** F1 — long-lived handler for ACP `requestPermission`. When set,
   *  incoming permission requests fire this callback; leave unset to
   *  auto-cancel (same behavior as the pre-Phase-3 scaffold). */
  onRequestPermission?: DashboardRequestPermissionHandler;
}

export type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse, ToolCallUpdate };

export interface DashboardSessionToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface DashboardSessionToolResult {
  id: string;
  name: string;
  result: unknown;
}

export type DashboardSessionUsage = Omit<ElanousUiUsagePayload, 'id'>;

export interface DashboardSendRequest {
  userText: string;
  /** Optional ACP `_meta` blob forwarded with the prompt. Used by
   *  source-aware submitters (telegram/discord/voice) to preserve
   *  provenance across daemon boundaries. */
  meta?: Record<string, unknown>;
  /** Step 2 of platform-evolution arc — channel-side normalized
   *  attachments (photos / voice / documents). When provided, the
   *  bridge folds them into the ACP PromptRequest's ContentBlock[]
   *  via buildAcpPrompt. ContentBlock-aware backends (Claude vision,
   *  GPT-4o, Gemini) get the image data inline; vision-incapable
   *  models still see the placeholder text summary
   *  (D15 fallback — content-blocks.ts:42-54). Empty / omitted = a
   *  text-only turn (the prior behavior). */
  attachments?: NormalizedAttachment[];
  /** U3c Phase 5b — abort signal from the hosting dashboard. When it
   *  fires (e.g. user presses ESC during a streaming turn), the session
   *  forwards a `session/cancel` notification to the ACP server so the
   *  in-flight turn rolls back with `stopReason: 'cancelled'`. Matches
   *  the direct-path's `abortCtrl.signal` semantics one-to-one. */
  signal?: AbortSignal;
  /** Streaming text chunks delivered as the server runs the turn. */
  onText?(chunk: string): void;
  /** P2-bridge-ext — fires when the server emits `tool_call` before
   *  the tool runs. Mirrors `StreamWithToolsHandlers.onToolCall` for
   *  dashboard substitution sites. */
  onToolCall?(call: DashboardSessionToolCall): void;
  /** P2-bridge-ext — fires when the server emits `tool_call_update`
   *  with `status: 'completed'`. Carries the same `rawOutput` the
   *  direct dispatchTool caller returned. */
  onToolResult?(call: DashboardSessionToolResult): void;
  /** P2-bridge-ext — fires on each `elanous/ui/usage` envelope (one or
   *  more per turn, provider-dependent). Shape matches
   *  `StreamWithToolsHandlers.onUsage` modulo the correlation id. */
  onUsage?(usage: DashboardSessionUsage): void;
}

export interface DashboardSendResult {
  stopReason: string;
}

type SessionUpdateInterceptor = (update: unknown) => void;

/** Tier 1 telegram fan-out arc — long-lived sessionUpdate observer.
 *  Unlike `interceptor` (which is set/cleared per-prompt to drive the
 *  active turn's onText/onToolCall callbacks), the ambient handler
 *  stays installed across turn boundaries so a multi-surface client
 *  (telegram bridge, future Discord) can render fan-out chunks pushed
 *  by other peers attached to the same sessionId.
 *
 *  Suppress rule (D3 — RESEARCH §3.1 channel observer contract):
 *  while send() owns the active turn, ambient routing is suppressed
 *  to avoid duplicate delivery — the per-prompt interceptor already
 *  drives onText. As soon as send()'s finally clears the per-prompt
 *  hook, ambient resumes for fan-out from other peers. */
export type DashboardSessionAmbientHandler = (update: unknown) => void;

export class DashboardSession {
  private interceptor: SessionUpdateInterceptor | null = null;
  private ambientHandler: DashboardSessionAmbientHandler | null = null;
  private permissionHandler: DashboardRequestPermissionHandler | null = null;

  // BACKLOG #2 — `sessionId` is mutable so `/resume <daemon-id>` can
  // swap the active session id mid-flight. `client` and `shutdown`
  // remain stable across a swap (same connection, same lifecycle —
  // only the id the server routes against changes).
  private sessionId: string;
  /** ⭐ `B3`(2026-08-19) — 도는 턴에 발화를 끼워 넣으려면 «어느 세션의 턴인가»를 알아야 한다.
   *  ⛔ 읽기 전용으로만 연다 — 세션 교체(`swapTo`)는 여전히 이 클래스가 소유한다. */
  get currentSessionId(): string { return this.sessionId; }
  /** ⭐ 이 턴을 **연 쪽**(TUI 채팅 세션)을 읽는 seam. 기본은 활성 채팅 세션.
   *  ⛔ 주입 가능하게 두는 이유: 테스트가 전역 세션 상태에 기대지 않게(이 저장소가 반복해서 다친 자리). */
  private originSessionId: (() => string | null) | undefined;
  private constructor(
    private readonly client: ClientSideConnection,
    initialSessionId: string,
    private readonly shutdown: () => Promise<void>,
    originSessionId?: () => string | null,
  ) {
    this.sessionId = initialSessionId;
    this.originSessionId = originSessionId ?? (() => {
      try {
        const mod = require('../session/index.js') as typeof import('../session/index.js');
        return mod.getActiveSessionId?.() ?? null;
      } catch { return null; }
    });
  }

  /** 테스트 주입용 — 활성 채팅 세션 조회를 갈아끼운다. */
  setOriginSessionIdReader(reader: (() => string | null) | undefined): void {
    if (reader) this.originSessionId = reader;
  }

  /** Boot an in-process server + client, complete the ACP
   *  handshake, and return a DashboardSession bound to a fresh
   *  session id. */
  static async create(opts: DashboardSessionOptions): Promise<DashboardSession> {
    const pair = createInProcessTransportPair();
    const shutdownCtrl = new AbortController();
    const runTurn = bridgeCoreTurnToAcp({
      tuiRouting: true,
      getMessages: opts.getMessages,
      getTools: opts.getTools,
      dispatchTool: opts.dispatchTool,
      ...(opts.onTurnComplete ? { onTurnComplete: opts.onTurnComplete } : {}),
      ...(opts.resolveModel ? { resolveModel: opts.resolveModel } : {}),
      ...(opts.resolveMaxToolTurns
        ? { resolveMaxToolTurns: opts.resolveMaxToolTurns }
        : {}),
      ...(opts.abortPollMs !== undefined ? { abortPollMs: opts.abortPollMs } : {}),
    });

    const serverPromise = runAcpServer({
      transportFactory: pair.transportFactory,
      shutdownSignal: shutdownCtrl.signal,
      runTurn,
      // PCH-2b — the in-process TUI dispatcher carries its own approval modals.
      toolApproval: 'off',
      ...(opts.agentName ? { agentName: opts.agentName } : {}),
      ...(opts.agentVersion ? { agentVersion: opts.agentVersion } : {}),
      ...(opts.serverOptions ?? {}),
    });

    // Wait for the server to register its onConnection handler.
    await (pair.transportFactory as unknown as { __handlerFired: Promise<void> })
      .__handlerFired;

    const clientStream = ndJsonStream(
      pair.clientStreams.writable,
      pair.clientStreams.readable,
    );

    // `session` closure is populated after `new DashboardSession(...)`
    // below; the ClientSideConnection factory only needs a reference
    // to forward `sessionUpdate` notifications into the current
    // per-prompt interceptor.
    let session: DashboardSession | null = null;
    const client = new ClientSideConnection(() => ({
      async sessionUpdate(notification) {
        session?.routeSessionUpdate(notification);
      },
      async requestPermission(permissionReq) {
        const handler = session?.permissionHandler;
        if (!handler) return { outcome: { outcome: 'cancelled' as const } };
        return handler(permissionReq);
      },
      async writeTextFile() { throw new Error('fs not supported'); },
      async readTextFile() { throw new Error('fs not supported'); },
    }), clientStream);

    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        // P2-bridge-ext — advertise `elanous.ui.usage` so the server's
        // `pushUsage` gate passes. showModal/showToast/updateStatusPill
        // stay off because the scaffold doesn't render them yet; they
        // light up in U3c Phase 4.
        _meta: { elanous: { ui: { usage: true } } },
      },
    });
    const { sessionId } = await client.newSession({ cwd: opts.cwd, mcpServers: [] });

    const shutdown = async (): Promise<void> => {
      shutdownCtrl.abort();
      try { await serverPromise; } catch { /* server may throw on close; ignore */ }
    };

    session = new DashboardSession(client, sessionId, shutdown);
    if (opts.onRequestPermission) {
      session.permissionHandler = opts.onRequestPermission;
    }
    return session;
  }

  /** MVP M1.3 — attach to a remote ACP server over a pre-connected
   *  transport (typically a Unix socket from `connectUnixSocket`).
   *  Unlike `create()` this does NOT boot a local server — the
   *  daemon already runs one. The returned session's `close()` just
   *  tears down the client-side connection; the daemon survives.
   *
   *  `cwd` is reported in `newSession(cwd)`. The daemon may use it
   *  to scope tool fs access (currently unused — daemon-runtime is
   *  text-only in MVP). */
  static async attach(opts: {
    /** Pre-connected transport, e.g. from `connectUnixSocket(...)`.
     *  Ownership transfers to the returned session — `close()` will
     *  invoke `conn.close()`. */
    conn: AcpTransportConnection;
    cwd: string;
    /** Optional permission handler — same contract as `create()`. */
    onRequestPermission?: DashboardRequestPermissionHandler;
  }): Promise<DashboardSession> {
    const clientStream = ndJsonStream(opts.conn.writable, opts.conn.readable);
    let session: DashboardSession | null = null;
    const client = new ClientSideConnection(() => ({
      async sessionUpdate(notification) {
        session?.routeSessionUpdate(notification);
      },
      async requestPermission(permissionReq) {
        const handler = session?.permissionHandler;
        if (!handler) return { outcome: { outcome: 'cancelled' as const } };
        return handler(permissionReq);
      },
      async writeTextFile() { throw new Error('fs not supported'); },
      async readTextFile() { throw new Error('fs not supported'); },
    }), clientStream);

    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        _meta: { elanous: { ui: { usage: true } } },
      },
    });
    const { sessionId } = await client.newSession({ cwd: opts.cwd, mcpServers: [] });

    const shutdown = async (): Promise<void> => {
      // Detach side: drop the connection. Daemon stays up and the
      // session continues running — that's the whole point of
      // process-split MVP.
      try { await opts.conn.close(); } catch { /* already closed */ }
    };

    session = new DashboardSession(client, sessionId, shutdown);
    if (opts.onRequestPermission) {
      session.permissionHandler = opts.onRequestPermission;
    }
    return session;
  }

  /** M2.3 — attach to an EXISTING session id minted by another
   *  client / earlier daemon run. Mirrors `attach()` but issues
   *  `session/load` instead of `session/new` so the daemon's
   *  history is reused (same prompts behave as if continuing a
   *  conversation). The peer must advertise
   *  `AgentCapabilities.loadSession: true` (elanous daemons do, post
   *  M2.3); otherwise the SDK throws "method not implemented".
   *
   *  Throws when the daemon's `hasSession` check returns false —
   *  surfaces as "unknown session: <id>" which the caller renders
   *  to the user. */
  static async attachExisting(opts: {
    sessionId: string;
    conn: AcpTransportConnection;
    cwd: string;
    onRequestPermission?: DashboardRequestPermissionHandler;
  }): Promise<DashboardSession> {
    const clientStream = ndJsonStream(opts.conn.writable, opts.conn.readable);
    let session: DashboardSession | null = null;
    const client = new ClientSideConnection(() => ({
      async sessionUpdate(notification) {
        session?.routeSessionUpdate(notification);
      },
      async requestPermission(permissionReq) {
        const handler = session?.permissionHandler;
        if (!handler) return { outcome: { outcome: 'cancelled' as const } };
        return handler(permissionReq);
      },
      async writeTextFile() { throw new Error('fs not supported'); },
      async readTextFile() { throw new Error('fs not supported'); },
    }), clientStream);

    try {
      await client.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          _meta: { elanous: { ui: { usage: true } } },
        },
      });
      // ACP `session/load` returns LoadSessionResponse (no sessionId
      // field — the client supplies + reuses the requested id). On
      // success the session is registered on the daemon's connection
      // ledger and ready for `session/prompt`.
      await client.loadSession({
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        mcpServers: [],
      });
    } catch (err) {
      // Critical: close the connection on init/load failure so the
      // caller's afterEach + bun-test runtime don't hang waiting on
      // an open ndJsonStream. Server-side error (e.g. unknown
      // sessionId) propagates up as the rejection.
      try { await opts.conn.close(); } catch { /* already */ }
      throw err;
    }

    const shutdown = async (): Promise<void> => {
      try { await opts.conn.close(); } catch { /* already closed */ }
    };

    session = new DashboardSession(client, opts.sessionId, shutdown);
    if (opts.onRequestPermission) {
      session.permissionHandler = opts.onRequestPermission;
    }
    return session;
  }

  /** F1 — Phase 3 · replace the long-lived permission handler. Useful
   *  when the caller wants to rewire after boot (e.g. when the
   *  dashboard's theme or approver factory changes). */
  setRequestPermissionHandler(handler: DashboardRequestPermissionHandler | null): void {
    this.permissionHandler = handler;
  }

  /** Tier 1 telegram fan-out arc — install a long-lived sessionUpdate
   *  observer. Fires on every notification EXCEPT while a `send()`
   *  call owns the active turn (per-prompt interceptor handles those
   *  to keep onText/onToolCall delivery exclusive — D3 dedup). The
   *  ambient handler resumes routing as soon as send()'s finally
   *  releases the per-prompt hook, so fan-out from other peers
   *  (PR #831 broadcast) reaches the registered observer.
   *
   *  Pass `null` to detach. The bridge (PR 2) installs at attach
   *  time and detaches in close().
   *
   *  Note: a future Discord/Slack ambient consumer reuses this same
   *  hook — no telegram-specific shape leaks into DashboardSession
   *  (RESEARCH §3.1 channel-agnostic primitive). */
  setAmbientInterceptor(handler: DashboardSessionAmbientHandler | null): void {
    this.ambientHandler = handler;
  }

  /** Test seam — route a sessionUpdate notification through the
   *  per-prompt interceptor first (active turn) and the ambient
   *  handler when no turn is active. Production code reaches this
   *  through the ClientSideConnection's sessionUpdate hook. */
  routeSessionUpdate(notification: unknown): void {
    if (this.interceptor) {
      // Active turn — per-prompt interceptor owns delivery. Ambient
      // is suppressed to avoid duplicate render in the surface that
      // initiated the turn (D3).
      this.interceptor(notification);
      return;
    }
    if (this.ambientHandler) {
      try { this.ambientHandler(notification); }
      catch { /* observer must not break routing */ }
    }
  }

  /** The session id the ACP server minted for this DashboardSession. */
  get id(): string {
    return this.sessionId;
  }

  /** BACKLOG #2 — swap the active session id without tearing down the
   *  underlying connection. Issues `session/load` for the new id over
   *  the existing `ClientSideConnection`; on success the dashboard's
   *  next `send()` targets the new id. The previous id remains
   *  registered server-side (peer registry from BACKLOG #2.5 keeps
   *  this connection's peer entry under both ids until close), so
   *  parallel surfaces watching either id keep streaming.
   *
   *  Throws when the daemon rejects the new id (e.g. `unknown session`),
   *  leaving `this.sessionId` unchanged so the caller can render an
   *  error and continue using the original session. */
  async swapTo(newSessionId: string, cwd: string): Promise<void> {
    if (typeof newSessionId !== 'string' || newSessionId.length === 0) {
      throw new Error('swapTo requires a non-empty sessionId');
    }
    if (newSessionId === this.sessionId) return;
    await this.client.loadSession({
      sessionId: newSessionId,
      cwd,
      mcpServers: [],
    });
    this.sessionId = newSessionId;
  }

  /** Send a single user prompt and await the turn's stopReason.
   *  Streaming text deltas and tool / usage events are delivered via
   *  the optional callbacks on `req`. */
  async send(req: DashboardSendRequest): Promise<DashboardSendResult> {
    this.interceptor = buildSendInterceptor(req);
    // U3c Phase 5b — bridge an optional AbortSignal to
    // `client.cancel()`. The dashboard's turn-loop creates an
    // `abortCtrl` on entry and flips it on ESC / Ctrl+C; forwarding
    // that into a `session/cancel` notification matches the ACP
    // protocol's cancellation contract (see acp.d.ts L373-386).
    let abortListener: (() => void) | null = null;
    const signal = req.signal;
    if (signal) {
      abortListener = () => {
        void this.client.cancel({ sessionId: this.sessionId });
      };
      if (signal.aborted) abortListener();
      else signal.addEventListener('abort', abortListener, { once: true });
    }
    try {
      const promptBlocks = req.attachments && req.attachments.length > 0
        ? buildAcpPrompt(req.userText, req.attachments)
        : [{ type: 'text' as const, text: req.userText }];
      // ⭐⭐⭐ 이 턴을 **연 쪽**(TUI 채팅 세션)을 함께 보낸다 — ACP 경계를 넘는 유일한 길이다.
      //   ⛔ 안 보내면 서버의 `runCoreTurn` 이 자기 세션으로 스코프를 열고, 그 턴의 툴 로그가
      //      **채팅 세션 조회에서 통째로 사라진다**(원장 `MEAS-S14` · 계측으로 확인).
      //   ⚠️ 값을 바꾸지 않는다 — 서버는 간선(`session.link`)에만 쓴다. 같으면 안 싣는다(자기 링크 방지).
      const originSessionId = this.originSessionId?.();
      const originMeta = originSessionId && originSessionId !== this.sessionId
        ? writeOriginSessionMeta(originSessionId)
        : undefined;
      const mergedMeta = req.meta !== undefined || originMeta !== undefined
        ? { ...(req.meta ?? {}), ...(originMeta ?? {}) }
        : undefined;
      const resp = await this.client.prompt({
        sessionId: this.sessionId,
        prompt: promptBlocks,
        ...(mergedMeta !== undefined ? { _meta: mergedMeta } : {}),
      });
      return { stopReason: resp.stopReason };
    } finally {
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
      this.interceptor = null;
    }
  }

  /** Tear down the in-process server + client pair. */
  async close(): Promise<void> {
    await this.shutdown();
  }
}

/** Build the per-prompt sessionUpdate interceptor that routes each
 *  envelope kind to the caller-supplied callback. Exported for tests
 *  so the fanout can be exercised without a live ACP round-trip. */
export function _buildSendInterceptorForTest(
  req: DashboardSendRequest,
): SessionUpdateInterceptor {
  return buildSendInterceptor(req);
}

function buildSendInterceptor(req: DashboardSendRequest): SessionUpdateInterceptor {
  return (notification) => {
    const n = notification as {
      update?: {
        sessionUpdate?: string;
        content?: { type?: string; text?: string };
        toolCallId?: string;
        title?: string;
        rawInput?: unknown;
        rawOutput?: unknown;
        status?: string;
      };
    };
    const inner = n.update;
    if (!inner) return;
    switch (inner.sessionUpdate) {
      case 'agent_message_chunk': {
        if (req.onText && inner.content?.type === 'text') {
          req.onText(inner.content.text ?? '');
        }
        return;
      }
      case 'tool_call': {
        if (req.onToolCall && typeof inner.toolCallId === 'string') {
          req.onToolCall({
            id: inner.toolCallId,
            name: typeof inner.title === 'string' ? inner.title : '',
            args: (inner.rawInput as Record<string, unknown>) ?? {},
          });
        }
        return;
      }
      case 'tool_call_update': {
        if (req.onToolResult && typeof inner.toolCallId === 'string' && inner.status === 'completed') {
          req.onToolResult({
            id: inner.toolCallId,
            name: typeof inner.title === 'string' ? inner.title : '',
            result: inner.rawOutput,
          });
        }
        return;
      }
      case 'agent_thought_chunk': {
        if (!req.onUsage || inner.content?.type !== 'text') return;
        const text = inner.content.text ?? '';
        const env = parseElanousUiEnvelope(text);
        if (!env || env.method !== 'usage') return;
        const { id: _id, ...rest } = env.payload as unknown as ElanousUiUsagePayload;
        req.onUsage(rest);
        return;
      }
    }
  };
}
