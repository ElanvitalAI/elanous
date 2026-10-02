/**
 * Unified daemon client — REST + WS multiplex.
 *
 * REST  : POST /v1/prompt/stream (SSE fallback) · GET /v1/health
 * WS    : /v1/acp (ACP multiplex) · /v1/voice/ws (voice frame protocol)
 *
 * The WS surfaces are wrapped behind connectAcp() / connectVoice() so callers
 * never touch raw WebSocket lifecycle. Reconnect / backoff is the connection's
 * job, not the consumer's.
 *
 * Chat turns prefer ACP session/prompt; REST streaming is the fallback.
 * Voice connection is a thin wrapper around the existing voice-websocket.ts
 * frame protocol so the / page keeps working unchanged.
 */

import { reportAuthRequired } from './auth-required';
import { buildAcpWsUrl, buildVoiceWsUrl, type DaemonConfig } from './daemon-config';
import { debugLog } from './debug';
import {
  isFeedbackEnvelopeWire,
  type FeedbackEnvelopeWire,
} from './feedback-envelope';

/** P-3 §6.9 (2026-05-07) — multi-part user content. Mirrors the
 *  daemon's `DaemonPromptBody.userContent` (see
 *  `src/boot/daemon-prompt-request.ts`). When present and non-empty, the
 *  daemon routes through `appendUserPromptBlocksAndBuildMessages` so
 *  image / resource blocks reach the LLM intact. PWA composer uses this
 *  to wire `pendingAttachments[]` into the active turn instead of the
 *  legacy "[attached] <path>" text injection.
 *
 *  Shape mirrors @agentclientprotocol/sdk's `ContentBlock` union — we
 *  type it loosely here so the PWA wire layer doesn't need to import
 *  the SDK on the client. The daemon validates that each block has a
 *  `type` string before dispatching. */
export type PromptUserContentBlock = { type: string; [key: string]: unknown };

/** §3.6 (2026-05-10) — multi-host LLM resolver shape (FU.A1 / FU.A3).
 *  Mirrors `LlmHostConfig` in `src/nexus/api/llm-hosts.ts` so the PWA
 *  Settings card can render + edit the same JSON the daemon stores in
 *  its in-memory override slot. `apiKey` is plaintext on the wire (PUT)
 *  and `[redacted]` on the wire (GET) — the redacted marker is a
 *  daemon-side guard against accidental exposure in the browser
 *  DevTools / shared screenshots. */
// RFC #2161 Phase 4 (2026-05-11) — `'anthropic'` kind renamed to
// `'anthropic-openai-wrap'`. The daemon still accepts the legacy alias
// for one release; this client type now reflects only the canonical id.
export type LlmHostKind = 'lm-studio' | 'vllm' | 'ollama' | 'anthropic-openai-wrap';

export interface LlmHostConfig {
  name: string;
  kind: LlmHostKind;
  endpoint: string;
  apiKey?: string;
}

export interface LlmHostsResponse {
  ok: boolean;
  source: 'override' | 'env' | 'legacy';
  count: number;
  hosts: LlmHostConfig[];
  /** RFC #2161 Phase 4 — server-side deprecation warnings (e.g. legacy
   *  `'anthropic'` kind alias). Card surfaces these as a yellow banner
   *  so the user knows to migrate before the alias is removed in the
   *  next release. */
  deprecations?: string[];
  parseError?: string;
}

export interface ConsultRequest {
  name: string;
  org?: string;
  kind: 'company' | 'personal';
  interest: 'A' | 'B';
  contact: string;
  consent: true;
}

export type ConsultRequestResult =
  | { receiptId: string; receivedAt: string }
  | { error: 'bad_request'; field: string };

export interface SeatSummary { id: string; title: string }
export interface SeatRequestItem {
  receiptId: string;
  seat: string;
  text: string;
  queuedAt: string;
  status: 'queued';
}
export interface SeatRequestsResponse {
  items: SeatRequestItem[];
  seats: SeatSummary[];
}
export interface SeatRequestReceipt { receiptId: string; seat: string; queuedAt: string }

export interface FieldUploadResult {
  event: string;
  count: number;
}

export interface FieldReelStatus {
  event: string;
  state: string;
  items: number;
  url?: string;
}

export type ExecRequestStatus = 'planning' | 'running' | 'done' | 'failed';
export type ExecSeatStatus = 'waiting' | 'running' | 'done' | 'failed';
export interface ExecRequestSeat {
  seat: string;
  title: string;
  status: ExecSeatStatus;
  graphId?: string;
  runId?: string;
  reason?: string;
}
export interface ExecRequestItem {
  id: string;
  text: string;
  createdAt: string;
  status: ExecRequestStatus;
  seats: ExecRequestSeat[];
  resultCount: number;
}
export interface ExecRequestDetail extends Omit<ExecRequestItem, 'resultCount'> {
  summary: string;
  results: Array<{
    seat: string;
    kind: 'report' | 'pdf' | 'video' | 'image' | 'text' | 'link';
    title: string;
    url: string;
    sources?: Array<{ title: string; url: string }>;
  }>;
  approvals: Array<{ graphId: string; runId: string; message: string }>;
}

export class SeatRequestError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly seats: SeatSummary[] = []) {
    super(code);
  }
}

export interface PromptRequest {
  sessionId?: string;
  userText: string;
  /** P-3 §6.9 (2026-05-07) — see {@link PromptUserContentBlock}. */
  userContent?: PromptUserContentBlock[];
  provider?: string;
}

export interface PromptResponse {
  sessionId: string;
  text: string;
  stopReason: string;
  /** 실제 답한 LLM(백엔드 활성 provider+model) — PWA 메시지 태깅용. */
  provider?: string;
  model?: string;
}

/** One row returned by GET /v1/terminals. A PTY registry row may contain
 * only its id; `hasPty: false` identifies an agent execution which shares
 * the endpoint but has no terminal PTY. */
export interface DaemonTerminalSummary {
  id: string;
  alive: boolean;
  correlationId: string;
  hasPty?: boolean;
  instance: string;
  name?: string;
  sessionId: string;
  sourceRoot?: { name: string; dbPath: string };
  startedAt: number;
  status?: string;
  /** PTY metadata already serialized by GET /v1/terminals. */
  kind?: string;
  /** 실행 명령. 데몬이 보유한 웹 셸은 `'web-terminal'` — 터미널 탭(XtermView)이 «붙을 수 있는» 유일한 종류다. */
  cmd?: string;
  nickname?: string;
  /** Terminal creation requester serialized by current daemons; absent from legacy responses. */
  origin?: 'human' | 'system' | 'unknown';
  /** Canonical manifest/CLI provenance, optional so legacy daemon responses remain compatible. */
  terminalOriginCategory?: 'direct-human' | 'elanous' | 'external-tool' | 'unknown';
  terminalOriginReason?: string;
  externalToolName?: string;
  /** Omitted when no controller was recorded; an empty string is preserved when explicitly sent. */
  controller?: string;
  /** Epoch-millisecond time of the most recent terminal control, absent when the daemon did not provide it. */
  lastControlAt?: number;
  /** `null` means this manifest-only row cannot know the owner-process access mode. */
  accessMode: 'read' | 'write' | 'auto' | null;
  workdir?: string;
  treeName?: string;
  worktreeName?: string;
  runId?: string;
  /** Owner run usage state serialized by GET /v1/terminals; absent from legacy responses. */
  ownerRunUsage?: 'running' | 'terminated-live-owner' | 'no-run-id' | 'unknown';
  exitCode?: number | null;
  /** Direct parent screen identifier already serialized by GET /v1/terminals. */
  parentPtyId?: string;
}

/** Scope metadata returned alongside terminal rows. The daemon may add fields
 * without requiring the PWA to know them in advance. */
export interface DaemonTerminalsScope {
  roots?: number;
  federated?: boolean;
  hiddenDead?: number;
  domain?: string;
  [field: string]: unknown;
}

export interface DaemonTerminalsResponse {
  terminals: DaemonTerminalSummary[];
  scope?: DaemonTerminalsScope;
}

export interface DaemonTerminalListOptions {
  all?: true;
  includeTest?: true;
}

export interface DaemonTerminalDetailOptions {
  sourceRoot?: string;
}

/** One screen in a daemon-provided terminal lineage group. */
export interface DaemonTerminalLineageRow {
  ptyId: string;
  kind: string;
  instance: string;
  alive: boolean;
  startedAt: number;
  closed?: boolean;
  closedAt?: number;
}

/** Terminal lineage returned by GET /v1/terminals/lineage. `joinedBy` remains
 * open so a new daemon grouping strategy reaches the PWA without a release. */
export interface DaemonTerminalLineageGroup {
  joinedBy: string;
  key: string;
  rows: DaemonTerminalLineageRow[];
}

export interface DaemonTerminalLineageResponse {
  key: string;
  groups: DaemonTerminalLineageGroup[];
  unreadablePayloads?: number;
}

/** One serialized row returned from GET /v1/logs. */
export interface DaemonLogEntry {
  id: number;
  ts: string;
  level: string;
  surface: string;
  category: string;
  event: string;
  sessionId?: string;
  data?: unknown;
}

export interface DaemonLogsResponse {
  ok: boolean;
  logs: DaemonLogEntry[];
  count: number;
  ts: string;
}

/** Phase B-1 (PWA chat streaming · 2026-05-06) — handler set passed to
 *  `DaemonClient.promptStream`. All callbacks are optional; the
 *  returned `PromptResponse` includes the final result even when callers ignore deltas. */
export interface PromptStreamErrorPayload {
  error: string;
  message?: string;
  holder?: string;
  [field: string]: unknown;
}

export interface PromptStreamHandlers {
  /** Fires once at stream start with the daemon-assigned sessionId
   *  (PWA may have submitted with no sessionId — the daemon mints one
   *  before any LLM call). */
  onTurnBegin?: (info: { sessionId: string }) => void;
  /** Fires per LLM text delta. `delta` is the new fragment; `full` is
   *  the cumulative assistant text up to and including it. */
  onTextDelta?: (info: { delta: string; full: string }) => void;
  /** Phase B-2 (2026-05-06) — fires when the daemon emits an
   *  `image-block` event (e.g. tool_result with image content). `src`
   *  is a renderable URL — typically a `data:` URI in the current
   *  daemon implementation but the type allows remote URLs so future
   *  attachment-store-backed flows can reuse the same wire. */
  onImageBlock?: (info: { src: string; mediaType: string; alt?: string }) => void;
  /** Phase B-3 (2026-05-06) — tool lifecycle hooks. `onToolCall` fires
   *  pre-dispatch (status pill flips to running); `onToolResult`
   *  fires once the dispatcher returns (status flips to done/error +
   *  optional summary line). `id` ties the two events together — PWA
   *  consumers find the matching block by id. */
  onToolCall?: (info: {
    id: string;
    name: string;
    args: Record<string, unknown>;
  }) => void;
  onToolResult?: (info: {
    id: string;
    name: string;
    ok: boolean;
    summary?: string;
    /** 툴 결과 «원본» — 발신 쪽 이름은 `result` 이고 여기서는 `rawOutput` 으로 준다. */
    rawOutput?: unknown;
    /** 결과가 화면을 가진다면 그 주소(MCP Apps · `_meta.ui.resourceUri`). */
    resourceUri?: string;
    /** 원본이 «빠진» 이유 — 발신 쪽이 아는 사실만. 없으면 그 칸도 없다. */
    resultOmittedReason?: 'too_large' | 'unserializable';
  }) => void;
  /** M1 PR 2 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) —
   *  carrier-agnostic `feedback` envelope channel. Daemon emits an SSE
   *  `feedback` event per envelope (search-hit / diff / agent.status /
   *  agent.thinking / debug.line / etc — see `FeedbackKind` for the
   *  full 8-way union). Wire validation (`isFeedbackEnvelopeWire`)
   *  runs before dispatch — malformed envelopes are silently dropped
   *  to keep the chat tab resilient to daemon-side schema drift.
   *
   *  Per-kind renderer wiring (collapsible diff · search-hit jump-to-
   *  file · thinking pill · debug drawer) lands in M3/M4/M5; this PR
   *  only defines the transport so handlers can opt-in early. */
  onFeedback?: (env: FeedbackEnvelopeWire) => void;
  /** Fires once on terminal `turn-end` event. The promise also
   *  resolves with the same payload. */
  onTurnEnd?: (info: PromptResponse) => void;
  /** Fires on terminal `error` event (e.g. `turn_preempted` /
   *  `turn_failed`). The promise rejects with the same message. */
  onError?: (info: PromptStreamErrorPayload) => void;
  /** Optional fetch abort signal — same semantics as `fetch(input,
   *  { signal })`. */
  signal?: AbortSignal;
  /** M6 PR 2 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) —
   *  opt-in debug-tap. When true the request URL gains a `?debug-tap=
   *  on` query so daemon's debug-bridge activates and mirrors
   *  `debug.log` events back as `debug.line` envelopes. Default false
   *  keeps the wire identical to the legacy chat client. */
  debugTap?: boolean;
}

export interface AcpFrame {
  jsonrpc?: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  // elanous-specific notification kinds.
  kind?: 'output' | 'exit' | 'snapshot' | 'sessionUpdate' | 'error';
}

export type AcpFrameHandler = (frame: AcpFrame) => void;
export type AcpConnectionState = 'CONNECTING' | 'OPEN' | 'FAILED' | 'CLOSED';
export type AcpStateHandler = (state: AcpConnectionState, error?: Error) => void;

/** M4 of PLAN-ask-user-question-cross-surface-2026-05-13 — inbound
 *  JSON-RPC request handler. Returning the result resolves the server's
 *  `sendRequest` Promise via a JSON-RPC `result` frame; throwing falls
 *  through to a `-32603 internal error` response (handler-side guard
 *  · wire error already covers decode failures upstream). */
export type AcpRequestHandler = (params: unknown) => Promise<unknown> | unknown;

export interface AcpConnection {
  send(method: string, params: unknown): Promise<unknown>;
  on(kind: NonNullable<AcpFrame['kind']>, cb: AcpFrameHandler): () => void;
  onAny(cb: AcpFrameHandler): () => void;
  /** M4 — register an inbound request handler for a specific method
   *  (e.g. `elanous/ask/request`). Each lease keeps an independent binding.
   *  The latest active binding owns the one JSON-RPC response; disposing it
   *  restores the preceding binding. Returns a disposer that removes only
   *  this binding. Notifications (method without id) still flow via `on()` /
   *  `onAny()`. */
  onRequest(method: string, handler: AcpRequestHandler): () => void;
  onState(cb: AcpStateHandler): () => void;
  readonly state: AcpConnectionState;
  /** Releases this consumer lease; shared transport closes after the last lease. */
  close(): void;
  readonly readyState: number; // mirrors WebSocket.readyState
  /** WT-S-1.5 — resolves to the daemon-issued sessionId after the auto
   *  handshake completes (`initialize` + `session/new`). PWA peers
   *  attach to this id so daemon broadcasts reach them. */
  readonly ready: Promise<string>;
}

export type DaemonTerminalControlResult = {
  status: 'success' | 'unknown-pty' | 'denied' | 'failed' | 'owner-unreachable';
  reason?: string;
};

export type DaemonTerminalSnapshotResult = DaemonTerminalControlResult & { screen?: string };

export type DaemonTerminalRenameResult =
  | { status: 'success'; id: string; name: string }
  | { status: 'invalid-name' | 'unknown-pty' | 'denied' | 'failed' | 'owner-unreachable' };

export class DaemonClient {
  private readonly acpConnections = new Map<string, AcpConnectionImpl>();

  constructor(private cfg: DaemonConfig) {}

  updateConfig(cfg: DaemonConfig): void {
    const previousIdentity = `${buildAcpWsUrl(this.cfg)}\u0000${this.cfg.token}`;
    const nextIdentity = `${buildAcpWsUrl(cfg)}\u0000${cfg.token}`;
    this.cfg = cfg;
    if (previousIdentity === nextIdentity) return;

    // A session key alone cannot identify a daemon transport after its URL or
    // bearer credential changes. Retire every old core so future leases use
    // only the new configuration; existing consumers observe CLOSED.
    this.acpConnections.forEach((connection) => connection.dispose());
    this.acpConnections.clear();
  }

  // --- REST -----------------------------------------------------------

  /** Generic authenticated fetch wrapper — used by intake/control surfaces
   *  that hit many small endpoints. JSON-decoded by default; pass
   *  rawResponse:true to get the Response object. */
  /** ⛔⭐ 응답을 «그대로» 준다 — 본문만 필요한 곳은 `fetchJson` 을 쓴다.
   *
   *  📏 2026-08-21: 위젯 리소스 응답이 CSP 허용 출처를 «머리»로 나르는데, 본문만 돌려주는
   *  helper 밖에 없어서 그 목록이 통째로 버려졌고 위젯이 죽은 껍데기가 됐다.
   *  ⇒ URL 조립과 인증은 여전히 «이 한 집»에 있고, 머리를 읽어야 하는 쪽만 이 문으로 온다. */
  async fetchResponse(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(this.url(path), {
      ...init,
      headers: { ...this.authHeaders(), ...(init?.headers ?? {}) },
    });
    if (res.status === 401) reportAuthRequired(path);
    return res;
  }

  /** TERM1 · 10-02 — concurrent GETs of the terminal list share one request (several panels ask at once). */
  private readonly inflightTerminals = new Map<string, Promise<unknown>>();

  async fetchJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    if (path.startsWith('/v1/terminals') && !path.startsWith('/v1/terminals/') && (!init || ((init.method ?? 'GET') === 'GET' && init.body === undefined))) {
      const shared = this.inflightTerminals.get(path);
      if (shared) return shared as Promise<T>;
      const request = this.fetchJsonOnce<T>(path, init).finally(() => { this.inflightTerminals.delete(path); });
      this.inflightTerminals.set(path, request);
      return request;
    }
    return this.fetchJsonOnce<T>(path, init);
  }

  private async fetchJsonOnce<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchResponse(path, init);
    const ctype = res.headers.get('content-type') ?? '';
    const body = ctype.includes('application/json')
      ? await res.json()
      : await res.text();
    if (!res.ok) {
      const msg =
        typeof body === 'string'
          ? body
          : (body?.reason ?? body?.error ?? `${res.status}`);
      throw new Error(String(msg));
    }
    return body as T;
  }

  async health(): Promise<{ ok: boolean }> {
    return this.fetchJson<{ ok: boolean }>('/v1/health');
  }

  async fieldDefaultEvent(): Promise<{ defaultEvent: string }> {
    return this.fetchJson('/v1/field/uploads');
  }

  async fieldReelStatus(event: string): Promise<FieldReelStatus> {
    return this.fetchJson(`/v1/field/reel?event=${encodeURIComponent(event)}`);
  }

  /** Browser upload progress needs XHR; the same daemon URL and bearer are used as fetchJson. */
  uploadField(event: string, files: File[], caption: string, onProgress: (percent: number) => void): Promise<FieldUploadResult> {
    const form = new FormData();
    files.forEach((file) => form.append('file', file, file.name));
    files.forEach(() => form.append('capturedAt', ''));
    const query = new URLSearchParams({ event, device: 'pwa' });
    if (caption.trim()) {
      query.set('caption', caption.trim());
      form.append('caption', caption.trim());
    }
    const path = `/v1/field/uploads?${query}`;
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', this.url(path));
      if (this.cfg.token) xhr.setRequestHeader('authorization', `Bearer ${this.cfg.token}`);
      xhr.upload.onprogress = (progress) => {
        if (progress.lengthComputable && progress.total > 0) {
          onProgress(Math.min(100, Math.round(progress.loaded * 100 / progress.total)));
        }
      };
      xhr.onerror = () => reject(new Error('field upload: network error'));
      xhr.onload = () => {
        if (xhr.status === 401) reportAuthRequired(path);
        let body: { ok?: boolean; error?: string; reason?: string; event?: string; count?: number };
        try { body = JSON.parse(xhr.responseText); }
        catch { reject(new Error(`field upload ${xhr.status}: invalid response`)); return; }
        if (typeof body !== 'object' || body === null) {
          reject(new Error(`field upload ${xhr.status}: invalid response`));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300 || body.ok !== true) {
          reject(new Error(body.reason ?? body.error ?? `field upload ${xhr.status}`));
          return;
        }
        if (typeof body.event !== 'string' || typeof body.count !== 'number') {
          reject(new Error(`field upload ${xhr.status}: invalid response`));
          return;
        }
        resolve({ event: body.event, count: body.count });
      };
      xhr.send(form);
    });
  }

  async submitConsultRequest(request: ConsultRequest): Promise<ConsultRequestResult> {
    const path = '/v1/consult-requests';
    const res = await this.fetchResponse(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (res.status === 202) return (await res.json()) as { receiptId: string; receivedAt: string };
    if (res.status === 400) return (await res.json()) as { error: 'bad_request'; field: string };
    throw new Error(`consult-requests ${res.status}`);
  }

  async listExecRequests(): Promise<{ items: ExecRequestItem[] }> {
    return this.fetchJson('/v1/exec-requests');
  }

  async getExecRequest(id: string): Promise<ExecRequestDetail> {
    return this.fetchJson(`/v1/exec-requests/${encodeURIComponent(id)}`);
  }

  async submitExecRequest(text: string): Promise<{ id: string; status: 'planning' }> {
    const path = '/v1/exec-requests';
    const res = await this.fetchResponse(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.status !== 202) throw new Error(`exec-requests ${res.status}`);
    return (await res.json()) as { id: string; status: 'planning' };
  }

  async listSeatRequests(options: { seat?: string; limit?: number } = {}): Promise<SeatRequestsResponse> {
    const query = new URLSearchParams();
    if (options.seat !== undefined) query.set('seat', options.seat);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    const suffix = query.size ? `?${query}` : '';
    return this.fetchJson<SeatRequestsResponse>(`/v1/seat-requests${suffix}`);
  }

  async submitSeatRequest(request: { seat?: string; text: string }, idempotencyKey: string): Promise<SeatRequestReceipt> {
    const path = '/v1/seat-requests';
    const response = await this.fetchResponse(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(request),
    });
    const body = await response.json() as SeatRequestReceipt | { error?: string; seats?: SeatSummary[] };
    if (!response.ok) {
      const error = body as { error?: string; seats?: SeatSummary[] };
      throw new SeatRequestError(response.status, error.error ?? `http-${response.status}`, error.seats ?? []);
    }
    return body as SeatRequestReceipt;
  }

  /** Phase B-4 follow-up (2026-05-06) — long-lived observer SSE for a
   *  given `sessionId`. Re-emits the same wire shape `promptStream`
   *  consumes, fanned out from the in-process chat-event bus on the
   *  daemon side (see `src/nexus/api/chat-event-bus.ts`). Returns a
   *  disposer the caller MUST invoke on unmount / sessionId change to
   *  release the daemon-side listener slot. The disposer aborts the
   *  underlying fetch, which Bun.serve translates into the bus
   *  unsubscribe via the ReadableStream `cancel` callback.
   *
   *  Differences from `promptStream`:
   *    - never resolves on `turn-end` (multi-turn lifetime)
   *    - never rejects on `error` event (re-emitted to onError; the
   *      stream stays open for the next turn)
   *    - emits a synthetic `subscribed` log on the first event the
   *      daemon ships (signals the bus subscription is live)
   *
   *  Consumers (ChatLayout.useEffect) should treat each `turn-begin`
   *  as a remote turn boundary and synthesize a fresh assistant
   *  placeholder, just as `promptStream` callers do for the local
   *  turn — the same placeholder semantics extend across tabs. */
  subscribeChatEvents(
    sessionId: string,
    handlers: PromptStreamHandlers = {},
  ): () => void {
    const ac = new AbortController();
    const init: RequestInit = {
      method: 'GET',
      headers: { accept: 'text/event-stream', ...this.authHeaders() },
      signal: ac.signal,
    };
    const url = `${this.url('/v1/chat/events')}?sessionId=${encodeURIComponent(sessionId)}`;
    debugLog('webterm.chat.observer.subscribe', { sessionId });
    // Fire-and-forget: the lifetime is owned by the disposer the
    // caller stores. Errors from the long-lived fetch (network drop,
    // daemon restart) surface via handlers.onError but do NOT throw
    // synchronously — same shape as ACP WS reconnect would have.
    void (async () => {
      try {
        const res = await fetch(url, init);
        if (res.status === 401) reportAuthRequired('/v1/chat/events');
        if (!res.ok || !res.body) {
          handlers.onError?.({
            error: 'observer_failed',
            message: `${res.status}: ${await res.text()}`,
          });
          return;
        }
        await consumeObserverSse(res.body, handlers);
      } catch (err) {
        // Aborted via disposer is the expected exit path on unmount /
        // sessionId change — don't re-emit as an error.
        if (ac.signal.aborted) return;
        handlers.onError?.({
          error: 'observer_disconnected',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      debugLog('webterm.chat.observer.end', { sessionId });
    })();
    return () => {
      debugLog('webterm.chat.observer.dispose', { sessionId });
      try { ac.abort(); } catch { /* swallow */ }
    };
  }

  /** Rich-dev-feedback opportunistic followup §6.2 #3 (2026-05-13) —
   *  subscribe to daemon `agent.status` NexusEvents on `/v1/events`
   *  and synthesize FeedbackEnvelope shapes so the existing
   *  accumulator + `<StatusChip>` renderer (M3 PR #2483) hydrates
   *  without ad-hoc per-renderer plumbing.
   *
   *  Why synthesize on the client (not server)? `/v1/events` carries
   *  the broad NexusEvent contract and a single SSE serves many
   *  surfaces; envelope-shape data only matters to chat consumers.
   *  Keeping the translation here keeps the bus generic.
   *
   *  Status enum mapping (AgentStatusStore `SessionStatus` →
   *  FeedbackEnvelope `AgentStatusPayload.status`):
   *    working  → running
   *    awaiting → queued
   *    done     → done
   *    err      → error
   *    idle     → skipped (no envelope emitted)
   *
   *  Caller passes the chat session id; the synthesized envelope's
   *  `sessionId` adopts it so the accumulator merges the
   *  `<StatusChip>` block into the current chat — same surface as
   *  the M2 ThinkingBridge envelopes.
   *
   *  Returns a disposer the caller MUST invoke on unmount / session
   *  change so the long-lived fetch aborts and the daemon-side bus
   *  subscriber releases. */
  subscribeAgentStatusEvents(
    sessionId: string,
    handlers: AgentStatusEventHandlers,
  ): () => void {
    const ac = new AbortController();
    const url = `${this.url('/v1/events')}?topics=agent.status`;
    debugLog('webterm.agent-status.subscribe', { sessionId });
    void (async () => {
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { accept: 'text/event-stream', ...this.authHeaders() },
          signal: ac.signal,
        });
        if (res.status === 401) reportAuthRequired('/v1/events');
        if (!res.ok || !res.body) {
          handlers.onError?.({
            error: 'agent_status_failed',
            message: `${res.status}: ${await res.text()}`,
          });
          return;
        }
        await consumeAgentStatusSse(res.body, sessionId, handlers);
      } catch (err) {
        if (ac.signal.aborted) return;
        handlers.onError?.({
          error: 'agent_status_disconnected',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      debugLog('webterm.agent-status.end', { sessionId });
    })();
    return () => {
      debugLog('webterm.agent-status.dispose', { sessionId });
      try { ac.abort(); } catch { /* swallow */ }
    };
  }

  /** PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M4 — long-lived
   *  SSE subscriber for `/v1/events?topics=hud.segment`. Mirrors
   *  subscribeAgentStatusEvents 1:1; each `hud.segment` NexusEvent
   *  becomes a synthesized FeedbackEnvelopeWire that flows through
   *  the M1 `applyHudSegmentEnvelope` accumulator (routed via the
   *  chat-runtime onFeedback path).
   *
   *  Disposer aborts the long-lived fetch. */
  subscribeHudSegmentEvents(
    sessionId: string,
    handlers: HudSegmentEventHandlers,
  ): () => void {
    const ac = new AbortController();
    const url = `${this.url('/v1/events')}?topics=hud.segment`;
    debugLog('webterm.hud-segment.subscribe', { sessionId });
    void (async () => {
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { accept: 'text/event-stream', ...this.authHeaders() },
          signal: ac.signal,
        });
        if (res.status === 401) reportAuthRequired('/v1/events');
        if (!res.ok || !res.body) {
          handlers.onError?.({
            error: 'hud_segment_failed',
            message: `${res.status}: ${await res.text()}`,
          });
          return;
        }
        await consumeHudSegmentSse(res.body, sessionId, handlers);
      } catch (err) {
        if (ac.signal.aborted) return;
        handlers.onError?.({
          error: 'hud_segment_disconnected',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      debugLog('webterm.hud-segment.end', { sessionId });
    })();
    return () => {
      debugLog('webterm.hud-segment.dispose', { sessionId });
      try { ac.abort(); } catch { /* swallow */ }
    };
  }

  /** ⛔⭐⭐⭐⭐ **두 구독을 «한 연결»로 합친다** — 19차 `[F]` · 2026-08-22.
   *
   *  📏 왜: `subscribeAgentStatusEvents` 와 `subscribeHudSegmentEvents` 는 각각
   *  ***끝나지 않는 fetch 를 하나씩*** 연다. 채팅 탭 한 장이 그런 연결을 여럿 열면
   *  ***브라우저의 HTTP/1.1 호스트당 한도(6)***에 닿고, 그 순간 죽는 것은 SSE 가 아니라
   *  ***「나머지 전부」***다 — 관측 업로드 · 위젯 데이터 · 심지어 문서 요청.
   *  (실측: 그 상태에서 PWA 로그 8분 0건 · 탭 리로드 불가.)
   *
   *  ⭐ 서버는 이미 `?topics=a,b` **콤마 다중 토픽**을 지원한다(`nexus/api/events.ts`).
   *  ⇒ 한 번만 열고 **`ReadableStream.tee()`** 로 갈라 두 소비자에게 준다.
   *    ⭐⭐ 소비자는 «자기 이벤트 이름이 아니면 무시»하도록 이미 짜여 있어 **수정이 필요 없다**
   *      (`parsed.event !== 'agent.status'` / `!== 'hud.segment'` continue).
   *
   *  ⚠️ `tee()` 는 한쪽이 느리면 다른 쪽 버퍼가 는다 — 둘 다 프레임당 상수 시간이라 문제 없다.
   *  ⚠️ 기존 두 메서드는 «남겨 둔다» — 다른 화면이 하나만 쓸 수 있고, 그때는 합칠 것이 없다. */
  subscribeChatFeedbackEvents(
    sessionId: string,
    handlers: {
      agentStatus: AgentStatusEventHandlers;
      hudSegment: HudSegmentEventHandlers;
    },
  ): () => void {
    const ac = new AbortController();
    const topics = ['agent.status', 'hud.segment'];
    const url = `${this.url('/v1/events')}?topics=${topics.join(',')}`;
    debugLog('webterm.chat-feedback.subscribe', { sessionId, topics });
    void (async () => {
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { accept: 'text/event-stream', ...this.authHeaders() },
          signal: ac.signal,
        });
        if (res.status === 401) reportAuthRequired('/v1/events');
        if (!res.ok || !res.body) {
          const message = `${res.status}: ${await res.text()}`;
          handlers.agentStatus.onError?.({ error: 'agent_status_failed', message });
          handlers.hudSegment.onError?.({ error: 'hud_segment_failed', message });
          return;
        }
        const [forStatus, forHud] = res.body.tee();
        await Promise.all([
          consumeAgentStatusSse(forStatus, sessionId, handlers.agentStatus),
          consumeHudSegmentSse(forHud, sessionId, handlers.hudSegment),
        ]);
      } catch (err) {
        if (ac.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        handlers.agentStatus.onError?.({ error: 'agent_status_disconnected', message });
        handlers.hudSegment.onError?.({ error: 'hud_segment_disconnected', message });
      }
      debugLog('webterm.chat-feedback.end', { sessionId });
    })();
    return () => {
      debugLog('webterm.chat-feedback.dispose', { sessionId });
      try { ac.abort(); } catch { /* swallow */ }
    };
  }

  /** Phase B-1 (PWA chat streaming) — SSE fallback consumes `text/event-stream` from
   *  `/v1/prompt/stream` and dispatches per-event into `handlers`.
   *  Resolves with the final `turn-end` payload or rejects on `error`
   *  event / non-200 status. */
  async promptStream(
    req: PromptRequest,
    handlers: PromptStreamHandlers = {},
  ): Promise<PromptResponse> {
    debugLog('webterm.rest.prompt.stream', {
      sessionId: req.sessionId,
      len: req.userText.length,
    });
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...this.authHeaders(),
      },
      body: JSON.stringify({
        ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
        userText: req.userText,
        ...(req.userContent !== undefined ? { userContent: req.userContent } : {}),
        ...(req.provider !== undefined ? { provider: req.provider } : {}),
      }),
    };
    if (handlers.signal) init.signal = handlers.signal;
    const path = handlers.debugTap === true
      ? '/v1/prompt/stream?debug-tap=on'
      : '/v1/prompt/stream';
    const res = await fetch(this.url(path), init);
    if (res.status === 401) reportAuthRequired(path);
    if (!res.ok || !res.body) {
      throw new Error(`prompt/stream ${res.status}: ${await res.text()}`);
    }
    return parsePromptSseStream(res.body, handlers);
  }

  // --- WS -------------------------------------------------------------

  connectAcp(opts: { sessionId?: string; onSession?: (id: string) => void } = {}): AcpConnection {
    const url = buildAcpWsUrl(this.cfg);
    if (!url) throw new Error('daemon baseUrl not configured');

    // Only an explicit daemon session is a stable identity suitable for
    // transport sharing. Calls that ask the daemon to mint a new session
    // must remain independent rather than being merged by a synthetic key.
    if (!opts.sessionId) {
      return new AcpConnectionImpl(url, this.cfg.token).acquire(opts.onSession);
    }

    const key = opts.sessionId;
    const existing = this.acpConnections.get(key);
    if (existing && !existing.isTerminal) return existing.acquire(opts.onSession);

    let connection: AcpConnectionImpl;
    connection = new AcpConnectionImpl(url, this.cfg.token, opts.sessionId, () => {
      // A delayed close event from an old failed connection must not erase a
      // newer connection that has already claimed this session key.
      if (this.acpConnections.get(key) === connection) this.acpConnections.delete(key);
    });
    this.acpConnections.set(key, connection);
    return connection.acquire(opts.onSession);
  }

  voiceWsUrl(): string {
    return buildVoiceWsUrl(this.cfg);
  }

  /** Voice 일원화 FU PP-V-2 (2026-05-07) — month-to-date STT/TTS cost
   *  summary. PWA 헤더의 VoiceCostPill 가 1분 polling 으로 호출. 응답은
   *  daemon `voice-rest-handler.handleCost()` 의 shape (monthYYYYMM,
   *  sttUsd, ttsUsd, totalUsd, sttDurationSec, ttsCharCount). */
  async voiceCost(): Promise<{
    monthYYYYMM: string;
    sttUsd: number;
    ttsUsd: number;
    totalUsd: number;
    sttDurationSec: number;
    ttsCharCount: number;
  }> {
    return this.fetchJson('/v1/voice/cost');
  }

  /** CV-3 P4.2 — list active PTY terminals registered in the daemon's
   *  pty-shell registry. Backs the Showroom "pin from terminal" picker
   *  (replaces pure paste minimum from P4.1). Returns terminals sorted
   *  by startedAt asc. Empty list = no PTY currently registered. */
  async listTerminals(options: DaemonTerminalListOptions = {}): Promise<DaemonTerminalsResponse> {
    // The endpoint's current rows are registry/agent summaries; legacy
    // cmd, exitCode, and outputBytes fields are absent from this response.
    const query = options.all === true && options.includeTest === true
      ? '?all=true&includeTest=true'
      : '';
    return this.fetchJson<DaemonTerminalsResponse>(`/v1/terminals${query}`);
  }

  /** Fetch the daemon's lineage groups for one selected PTY. */
  async fetchTerminalLineage(key: string): Promise<DaemonTerminalLineageResponse> {
    return this.fetchJson<DaemonTerminalLineageResponse>(`/v1/terminals/lineage?key=${encodeURIComponent(key)}`);
  }

  /** CV-3 P4.2 — fetch trailing N lines of a PTY's scrollback. Default
   *  lines = 50 (matches Showroom RFC v4 D14 frozen-snapshot default).
   *  Returns the raw concatenated text (last N lines joined by `\n`)
   *  along with metadata so callers can detect truncation. Throws when
   *  the id is unknown or `lines` is invalid (server-side 400/404). */
  async fetchTerminalScrollback(
    id: string,
    lines: number = 50,
    options: DaemonTerminalDetailOptions = {},
  ): Promise<{
    id: string;
    lines: number;
    totalLines: number;
    scrollback: string;
  }> {
    const safe = encodeURIComponent(id);
    const query = new URLSearchParams({ lines: String(lines) });
    if (options.sourceRoot) query.set('sourceRoot', options.sourceRoot);
    return this.fetchJson(`/v1/terminals/${safe}/scrollback?${query}`);
  }

  /** 웹 터미널 실시간(`GET /v1/terminals/:id/stream` · SSE). 데몬이 가진 PTY 는 바이트, 남의 PTY 는 바뀐 화면만 온다.
   *  연결이 안 되면(옛 데몬 404 · 네트워크) `onFail` — 호출자는 800ms 폴링으로 돌아간다. 반환값 = 끊기. */
  streamTerminal(
    id: string,
    options: { sourceRoot?: string },
    onEvent: (ev: import('./terminal-stream').TerminalStreamEvent) => void,
    onFail: (reason: string) => void,
  ): () => void {
    const ac = new AbortController();
    const q = options.sourceRoot ? `?sourceRoot=${encodeURIComponent(options.sourceRoot)}` : '';
    const url = this.url(`/v1/terminals/${encodeURIComponent(id)}/stream${q}`);
    void (async () => {
      try {
        const res = await fetch(url, { method: 'GET', headers: { accept: 'text/event-stream', ...this.authHeaders() }, signal: ac.signal });
        if (res.status === 401) reportAuthRequired('/v1/terminals/stream');
        if (!res.ok || !res.body) { onFail(`stream ${res.status}`); return; }
        const { parseTerminalSse } = await import('./terminal-stream');
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          buf += dec.decode(r.value, { stream: true });
          const parsed = parseTerminalSse(buf);
          buf = parsed.rest;
          for (const ev of parsed.events) onEvent(ev);
        }
      } catch (err) {
        if (ac.signal.aborted) return;
        onFail(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { try { ac.abort(); } catch { /* swallow */ } };
  }

  async snapshotTerminal(id: string, options: { ansi: boolean; sourceRoot?: string }): Promise<DaemonTerminalSnapshotResult> {
    return this.requestTerminalControl(id, { action: 'snapshot', ansi: options.ansi }, options);
  }

  async sendTerminalText(id: string, text: string, options: DaemonTerminalDetailOptions = {}): Promise<DaemonTerminalControlResult> {
    return this.requestTerminalControl(id, { action: 'input-text', chars: text }, options);
  }

  async sendTerminalKey(id: string, key: string, options: DaemonTerminalDetailOptions = {}): Promise<DaemonTerminalControlResult> {
    return this.requestTerminalControl(id, { action: 'input-key', chars: key }, options);
  }

  /** 사람이 takeover 한 PTY 에 마우스(1 기반 셀 · 서버가 SGR 로 인코딩 · 앱이 마우스 모드가 아니면 거절 — 🅢 #21609). */
  async sendTerminalMouse(id: string, mouse: { x: number; y: number; kind: 'click' | 'scroll-up' | 'scroll-down'; button?: 'left' | 'middle' | 'right' }, options: DaemonTerminalDetailOptions = {}): Promise<DaemonTerminalControlResult> {
    return this.requestTerminalControl(id, { action: 'input-mouse', ...mouse }, options);
  }

  /** Request ownership control for a PTY. The daemon's five outcomes remain
   * distinct so callers can choose a different recovery path for each one. */
  async controlTerminal(
    id: string,
    action: 'takeover' | 'release',
    options: DaemonTerminalDetailOptions = {},
  ): Promise<DaemonTerminalControlResult> {
    return this.requestTerminalControl(id, { action }, options);
  }

  private async requestTerminalControl(
    id: string,
    request: { action: 'takeover' | 'release' | 'snapshot' | 'input-text' | 'input-key' | 'input-mouse'; ansi?: boolean; chars?: string; x?: number; y?: number; kind?: string; button?: string },
    options: DaemonTerminalDetailOptions = {},
  ): Promise<DaemonTerminalSnapshotResult> {
    const expectedStatus: Record<DaemonTerminalControlResult['status'], number> = {
      success: 200,
      'unknown-pty': 404,
      denied: 409,
      failed: 502,
      'owner-unreachable': 504,
    };
    const safe = encodeURIComponent(id);
    const query = options.sourceRoot ? `?sourceRoot=${encodeURIComponent(options.sourceRoot)}` : '';
    const res = await fetch(this.url(`/v1/terminals/${safe}/control${query}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(request),
    });
    if (res.status === 401) reportAuthRequired(`/v1/terminals/${safe}/control`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`terminal control ${res.status}: invalid JSON response`);
    }
    const status = body && typeof body === 'object'
      ? (body as { status?: unknown }).status
      : undefined;
    const normalized = status === 'write-failed' ? 'failed' : status;
    if (
      (normalized !== 'success' && normalized !== 'unknown-pty' && normalized !== 'denied'
        && normalized !== 'failed' && normalized !== 'owner-unreachable')
      || res.status !== expectedStatus[normalized]
    ) {
      const detail = body && typeof body === 'object'
        ? ((body as { reason?: unknown; error?: unknown }).reason ?? (body as { error?: unknown }).error)
        : undefined;
      throw new Error(`terminal control ${res.status}: ${String(detail ?? 'unexpected response')}`);
    }
    const payload = body as { screen?: unknown; reason?: unknown };
    if (request.action === 'snapshot' && normalized === 'success' && typeof payload.screen !== 'string') {
      throw new Error(`terminal control ${res.status}: missing screen`);
    }
    return {
      status: normalized,
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
      ...(request.action === 'snapshot' && typeof payload.screen === 'string' ? { screen: payload.screen } : {}),
    };
  }

  /** Rename a PTY while preserving the daemon's caller-visible outcome distinctions. */
  async renameTerminal(id: string, name: string): Promise<DaemonTerminalRenameResult> {
    const expectedStatus: Record<DaemonTerminalRenameResult['status'], number> = {
      success: 200,
      'invalid-name': 400,
      'unknown-pty': 404,
      denied: 409,
      failed: 502,
      'owner-unreachable': 504,
    };
    const safe = encodeURIComponent(id);
    const res = await fetch(this.url(`/v1/terminals/${safe}/rename`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ name }),
    });
    if (res.status === 401) reportAuthRequired(`/v1/terminals/${safe}/rename`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`terminal rename ${res.status}: invalid JSON response`);
    }
    const result = body && typeof body === 'object' ? body as {
      status?: unknown;
      error?: unknown;
      id?: unknown;
      name?: unknown;
      reason?: unknown;
    } : {};
    const status = result.status === 'write-failed' ? 'failed'
      : result.status === 'unknown-pty' || result.status === 'denied'
        || result.status === 'failed' || result.status === 'owner-unreachable'
        ? result.status
        : result.status === 'success'
          ? 'success'
          : result.error === 'invalid-name'
            ? 'invalid-name'
            : undefined;
    if (
      status === undefined
      || res.status !== expectedStatus[status]
      || (status === 'success' && (typeof result.id !== 'string' || typeof result.name !== 'string'))
    ) {
      throw new Error(`terminal rename ${res.status}: ${String(result.reason ?? result.error ?? 'unexpected response')}`);
    }
    return status === 'success'
      ? { status, id: result.id as string, name: result.name as string }
      : { status };
  }

  /** Fetch a rendered terminal grid snapshot. `frameSource` stays open because
   * the daemon can introduce sources without a client release. */
  async fetchTerminalFrame(id: string, options: DaemonTerminalDetailOptions = {}): Promise<{
    id: string;
    frame: string;
    frameAt: number;
    frameSource: string;
  }> {
    const safe = encodeURIComponent(id);
    const query = options.sourceRoot ? `?sourceRoot=${encodeURIComponent(options.sourceRoot)}` : '';
    const response = await this.fetchJson<{
      id: string;
      frame: string;
      frameAt: number;
      frameSource: string;
      kind: string;
      instance: string;
      remote: boolean;
    }>(`/v1/terminals/${safe}/frame${query}`);
    return {
      id: response.id,
      frame: response.frame,
      frameAt: response.frameAt,
      frameSource: response.frameSource,
    };
  }

  /** CV-3 P5.x — create a new agent CLI session backed by a real
   *  codex/claude/gemini sub-process via globalDualRoleManager.
   *  Returns the namespaced sessionId Showroom uses for subsequent
   *  prompt + cancel + close calls. cwd default = daemon's
   *  process.cwd() (typically the monad-agent repo). */
  async createAgentCliSession(
    backend: 'codex-app-server' | 'claude' | 'gemini',
    cwd?: string,
    opts?: {
      /** Round 3 PR2 (β-2) — when 'off', append ?hitl=off so the
       *  daemon skips wiring the global HITL approver chain for this
       *  session. The Showroom toggle reads `localStorage` and the
       *  caller forwards the flag. Default 'on' (legacy behaviour). */
      hitl?: 'on' | 'off';
    },
  ): Promise<{
    sessionId: string;
    backendId: string;
    backendSessionId: string;
    cwd: string;
    createdAt: number;
  }> {
    const path = opts?.hitl === 'off'
      ? '/v1/agent-cli/sessions?hitl=off'
      : '/v1/agent-cli/sessions';
    return this.fetchJson(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        backend,
        ...(cwd ? { cwd } : {}),
      }),
    });
  }

  /** CV-3 P5.x — stream agent CLI prompt response via SSE. Mirrors
   *  promptStream's handler shape (onTextDelta · onStop · onError) so
   *  callers can compose the same UI rendering pipeline.
   *
   *  P5.x.+ (#1982) — `userContent` 으로 image/file 첨부 forward.
   *  daemon 이 ContentBlock[] 으로 받아 CLI sub-process 에 ACP 형태
   *  로 전달. plain `message` 와 같이 사용 시 daemon 가 message 를
   *  trailing text block 으로 append. */
  async agentCliPromptStream(
    req: {
      sessionId: string;
      message: string;
      userContent?: PromptUserContentBlock[];
    },
    handlers: {
      onTextDelta?: (evt: { delta: string; full: string }) => void;
      onStop?: (evt: { stopReason: string; sessionId: string }) => void;
      onError?: (evt: { error: string }) => void;
      /** P5.x.+ tool call viz (#1985) — fires for each tool_call /
       *  tool_call_update SSE event. UI can collapse by toolCallId
       *  for status lifecycle visualization (codex bash · file edit ·
       *  MCP tool calls). */
      onToolCall?: (evt: {
        kind: 'tool_call' | 'tool_call_update';
        toolCallId?: string;
        title?: string;
        toolKind?: string;
        status?: string;
        contentText?: string;
        rawOutput?: unknown;
        resourceUri?: string;
      }) => void;
      /** P5.x.+ activity pill (#1985) — turn-level metrics emitted at
       *  end of stream (turnDurationMs · toolCallCount · textBytes).
       *  CLI cost is external to elanous so we surface activity rather
       *  than $ — useful for "which agent is doing more work". */
      onUsage?: (evt: {
        turnDurationMs: number;
        toolCallCount: number;
        textBytes: number;
      }) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ sessionId: string; text: string; stopReason: string }> {
    const initHeaders: Record<string, string> = {
      'content-type': 'application/json',
      ...this.authHeaders(),
    };
    const init: RequestInit = {
      method: 'POST',
      headers: initHeaders,
      body: JSON.stringify(req),
    };
    if (handlers.signal) init.signal = handlers.signal;
    const res = await fetch(this.url('/v1/agent-cli/prompt'), init);
    if (res.status === 401) reportAuthRequired('/v1/agent-cli/prompt');
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`agent-cli/prompt ${res.status}: ${detail}`);
    }
    if (!res.body) throw new Error('agent-cli/prompt: no body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    let stopReason = 'end_turn';
    let sessionId = req.sessionId;
    let errored: string | null = null;
    // SSE parser — mirrors promptStream's logic but inlined here so
    // P5.x can ship without modifying the existing chat path.
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Split events on `\n\n` boundary (one event = N `name: value\n` lines).
      let sepIdx = buf.indexOf('\n\n');
      while (sepIdx !== -1) {
        const eventBlock = buf.slice(0, sepIdx);
        buf = buf.slice(sepIdx + 2);
        const lines = eventBlock.split('\n');
        let event = 'message';
        const dataParts: string[] = [];
        for (const line of lines) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) dataParts.push(line.slice(6));
        }
        const dataStr = dataParts.join('\n');
        if (event === 'chunk') {
          try {
            const parsed = JSON.parse(dataStr) as { text?: string };
            if (typeof parsed.text === 'string') {
              full += parsed.text;
              handlers.onTextDelta?.({ delta: parsed.text, full });
            }
          } catch { /* skip malformed */ }
        } else if (event === 'stop') {
          try {
            const parsed = JSON.parse(dataStr) as {
              sessionId?: string;
              stopReason?: string;
            };
            if (parsed.stopReason) stopReason = parsed.stopReason;
            if (parsed.sessionId) sessionId = parsed.sessionId;
            handlers.onStop?.({ stopReason, sessionId });
          } catch { /* skip */ }
        } else if (event === 'tool_call' || event === 'tool_call_update') {
          try {
            const parsed = JSON.parse(dataStr) as {
              toolCallId?: string;
              title?: string;
              kind?: string;
              status?: string;
              contentText?: string;
              rawOutput?: unknown;
            };
            const rawOutput = parsed.rawOutput;
            const rawOutputObject = rawOutput !== null
              && typeof rawOutput === 'object'
              && !Array.isArray(rawOutput)
              ? rawOutput as Record<string, unknown>
              : undefined;
            const meta = rawOutputObject?._meta;
            const metaUi = meta !== null && typeof meta === 'object' && !Array.isArray(meta)
              ? (meta as Record<string, unknown>).ui
              : undefined;
            const nestedResourceUri = metaUi !== null && typeof metaUi === 'object' && !Array.isArray(metaUi)
              ? (metaUi as Record<string, unknown>).resourceUri
              : undefined;
            const flatResourceUri = rawOutputObject?.['ui/resourceUri'];
            const resourceUri = typeof nestedResourceUri === 'string'
              ? nestedResourceUri
              : typeof flatResourceUri === 'string'
                ? flatResourceUri
                : undefined;
            handlers.onToolCall?.({
              kind: event,
              ...(parsed.toolCallId ? { toolCallId: parsed.toolCallId } : {}),
              ...(parsed.title ? { title: parsed.title } : {}),
              ...(parsed.kind ? { toolKind: parsed.kind } : {}),
              ...(parsed.status ? { status: parsed.status } : {}),
              ...(parsed.contentText ? { contentText: parsed.contentText } : {}),
              ...(rawOutput !== undefined ? { rawOutput } : {}),
              ...(resourceUri !== undefined ? { resourceUri } : {}),
            });
          } catch { /* skip malformed */ }
        } else if (event === 'usage') {
          try {
            const parsed = JSON.parse(dataStr) as {
              turnDurationMs?: number;
              toolCallCount?: number;
              textBytes?: number;
            };
            if (
              typeof parsed.turnDurationMs === 'number'
              && typeof parsed.toolCallCount === 'number'
              && typeof parsed.textBytes === 'number'
            ) {
              handlers.onUsage?.({
                turnDurationMs: parsed.turnDurationMs,
                toolCallCount: parsed.toolCallCount,
                textBytes: parsed.textBytes,
              });
            }
          } catch { /* skip */ }
        } else if (event === 'error') {
          try {
            const parsed = JSON.parse(dataStr) as { error?: string };
            errored = parsed.error ?? 'unknown';
            handlers.onError?.({ error: errored });
          } catch { errored = 'parse-error'; }
        }
        sepIdx = buf.indexOf('\n\n');
      }
    }
    if (errored) throw new Error(errored);
    return { sessionId, text: full, stopReason };
  }

  /** CV-3 P5.x — cancel an in-flight agent CLI prompt. Best-effort —
   *  underlying AcpAgent.cancel signals the sub-process; per-brand
   *  semantics vary (codex SIGINT · claude/gemini may take a beat). */
  async cancelAgentCliSession(sessionId: string): Promise<{ ok: boolean }> {
    return this.fetchJson('/v1/agent-cli/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  }

  /** CV-3 P5.x — close an agent CLI session. Releases the per-session
   *  record · sub-process stays alive (managed by globalAcpAgentManager
   *  for re-use). */
  async closeAgentCliSession(sessionId: string): Promise<{ ok: boolean }> {
    const safe = encodeURIComponent(sessionId);
    return this.fetchJson(`/v1/agent-cli/sessions/${safe}`, { method: 'DELETE' });
  }

  /** CV-3 FP-B — Showroom named layout daemon-side store (cross-device
   *  sync · ~/.elanous/showroom-layouts.json). vision Q3: auto-migrate
   *  on first daemon save · localStorage stays as cache fallback. */
  async listShowroomLayouts(): Promise<{
    layouts: Array<{
      name: string;
      savedAt: number;
      panels: Array<{
        id: string;
        kind: 'chat' | 'agent';
        provider: string;
        agentBrand?: 'codex' | 'claude' | 'gemini';
        state: 'live' | 'mute' | 'freeze';
      }>;
      layoutMode?: 'horizontal' | 'vertical';
    }>;
  }> {
    return this.fetchJson('/v1/showroom/layouts');
  }

  async getShowroomLayout(name: string): Promise<{
    layout: {
      name: string;
      savedAt: number;
      panels: Array<{
        id: string;
        kind: 'chat' | 'agent';
        provider: string;
        agentBrand?: 'codex' | 'claude' | 'gemini';
        state: 'live' | 'mute' | 'freeze';
      }>;
      layoutMode?: 'horizontal' | 'vertical';
    };
  }> {
    const safe = encodeURIComponent(name);
    return this.fetchJson(`/v1/showroom/layouts/${safe}`);
  }

  async saveShowroomLayout(
    name: string,
    layout: {
      savedAt?: number;
      panels: Array<{
        id: string;
        kind: 'chat' | 'agent';
        provider: string;
        agentBrand?: 'codex' | 'claude' | 'gemini';
        state: 'live' | 'mute' | 'freeze';
      }>;
      layoutMode?: 'horizontal' | 'vertical';
    },
  ): Promise<{ ok: boolean; layout: unknown }> {
    const safe = encodeURIComponent(name);
    return this.fetchJson(`/v1/showroom/layouts/${safe}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(layout),
    });
  }

  async deleteShowroomLayout(name: string): Promise<{ ok: boolean; name: string }> {
    const safe = encodeURIComponent(name);
    return this.fetchJson(`/v1/showroom/layouts/${safe}`, { method: 'DELETE' });
  }

  /** §6.3 — fetch URL → text body via daemon (HTML strip · 50KB cap). */
  async fetchUrlContext(url: string): Promise<{
    ok: true;
    url: string;
    title?: string;
    text: string;
    bytes: number;
  }> {
    return this.fetchJson('/v1/context/fetch-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  }

  /** micro.3 (2026-05-09) — list deployed LLM models.
   *  FU.A1 (2026-05-09 night) — multi-host fan-out (LM Studio · vLLM ·
   *  Ollama). Each model carries `host` + `hostKind` so the dropdown
   *  can group by host. The PWA Showroom header dropdown calls this so
   *  users can pick a non-default model without DevTools editing.
   *  Returns an empty array on transport failure (caller surfaces
   *  the error state in the dropdown). */
  async listLlmModels(): Promise<{
    ok?: boolean;
    endpoint?: string;
    count?: number;
    models: Array<{ id: string; ownedBy?: string; host?: string; hostKind?: string }>;
    hosts?: Array<{
      name: string;
      kind: string;
      endpoint: string;
      count: number;
      error?: string;
    }>;
    error?: string;
    detail?: string;
    configWarning?: string;
  }> {
    const res = await fetch(this.url('/v1/llm/models'), {
      method: 'GET',
      headers: { ...this.authHeaders() },
    });
    if (res.status === 401) reportAuthRequired('/v1/llm/models');
    if (!res.ok) {
      return { models: [], error: `http-${res.status}` };
    }
    return (await res.json()) as Awaited<ReturnType<DaemonClient['listLlmModels']>>;
  }

  /** §3.6 (2026-05-10) — multi-host hot-reload GUI consumer for FU.A3
   *  endpoint (#2118). The Settings · LlmHostsCard renders the result,
   *  letting users add/remove Anthropic/Gemini/vLLM/Ollama hosts at
   *  runtime without editing `ELANOUS_LLM_HOSTS` JSON or restarting the
   *  daemon. Override is in-memory only — env/legacy reverts on
   *  restart (intentional · permanent change still goes via .zshrc). */
  async getLlmHosts(): Promise<LlmHostsResponse> {
    return this.fetchJson<LlmHostsResponse>('/v1/llm/hosts');
  }

  async setLlmHosts(hosts: LlmHostConfig[]): Promise<LlmHostsResponse> {
    return this.fetchJson<LlmHostsResponse>('/v1/llm/hosts', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(hosts),
    });
  }

  async clearLlmHosts(): Promise<LlmHostsResponse & { cleared: boolean }> {
    return this.fetchJson<LlmHostsResponse & { cleared: boolean }>(
      '/v1/llm/hosts',
      { method: 'DELETE' },
    );
  }

  /** R6 FU.2 · §6.3 audio bridge — POST audio file to daemon
   *  `/v1/audio/stt` for transcription. Daemon picks the configured
   *  STT provider (default OpenAI Whisper · same as elanous TUI). The
   *  PWA's audio context source uses this to auto-fill the
   *  transcript field on file pick.
   *
   *  Throws on non-2xx; the caller (showroom/audio-stt-extract)
   *  catches and falls back to the manual transcript prompt so the
   *  flow is still usable when daemon STT is unavailable / unconfigured. */
  async transcribeAudio(file: File, language?: string): Promise<{
    text: string;
    language?: string;
    durationMs?: number;
    providerId?: string;
  }> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (language) form.append('language', language);
    const res = await fetch(this.url('/v1/audio/stt'), {
      method: 'POST',
      headers: { ...this.authHeaders() },
      body: form,
    });
    if (res.status === 401) reportAuthRequired('/v1/audio/stt');
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch { /* ignore */ }
      throw new Error(`audio-stt http ${res.status}: ${detail.slice(0, 200)}`);
    }
    return (await res.json()) as Awaited<ReturnType<DaemonClient['transcribeAudio']>>;
  }

  /** R6 Task 5 · §6.1 LLM-judge — call the daemon's hybrid classifier.
   *  PWA only invokes this when its own local keyword classifier
   *  returned null AND the user has opted in to the local-llm
   *  backend (default = keyword-only). Returns the role label or null
   *  on judge fallback. The caller treats null as "broadcast". */
  async judgeRole(
    prompt: string,
    opts: { backend?: 'keyword' | 'local-llm'; model?: string } = {},
  ): Promise<{
    role: 'plan' | 'exec' | 'review' | 'reflect' | null;
    source: 'keyword' | 'local-llm' | 'fallback';
    backend?: string;
    model?: string;
    llm?: { ok: boolean; latencyMs: number; reason?: string; detail?: string };
  }> {
    const body: { prompt: string; backend?: string; model?: string } = { prompt };
    if (opts.backend) body.backend = opts.backend;
    if (opts.model) body.model = opts.model;
    const res = await fetch(this.url('/v1/showroom/role-judge'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (res.status === 401) reportAuthRequired('/v1/showroom/role-judge');
    if (!res.ok) {
      throw new Error(`role-judge http ${res.status}`);
    }
    return (await res.json()) as Awaited<ReturnType<DaemonClient['judgeRole']>>;
  }

  /** R6 FU.3 (§6.5 sidebar SSE) — return the EventSource URL for the
   *  showroom layouts change stream. Sidebar widget subscribes here
   *  to refresh its list on cross-device save/delete. Null when the
   *  daemon base URL hasn't been configured. */
  showroomLayoutsEventsUrl(): string | null {
    if (!this.cfg.baseUrl) return null;
    return this.url('/v1/showroom/layouts/events');
  }

  /** R6 Task 3 (§6.4 SSE) — return the EventSource URL for the persona
   *  registry's reload-event stream. Caller (`use-personas` hook)
   *  passes this to `new EventSource(...)` to subscribe; null when the
   *  daemon base URL hasn't been configured yet. */
  personasEventsUrl(): string | null {
    if (!this.cfg.baseUrl) return null;
    return this.url('/v1/personas/events');
  }

  /** 라이브 세션 SSE(S3a) — on-disk 세션 생성/갱신 push. topics=session. 로
   *  session.created / session.updated 만 수신(session-decision 은 제외). */
  sessionStoreEventsUrl(): string | null {
    if (!this.cfg.baseUrl) return null;
    return `${this.url('/v1/events')}?topics=session.`;
  }

  /** Fetch a bounded page of unified-log rows, optionally filtered by event. */
  async listLogs(params: Record<string, string> = {}): Promise<DaemonLogsResponse> {
    const qs = new URLSearchParams(params).toString();
    return this.fetchJson<DaemonLogsResponse>(`/v1/logs${qs ? `?${qs}` : ''}`);
  }

  /** Fetch the progress frames emitted by a headless self-implement PTY. */
  async listProgressFrames(limit: number = 200): Promise<DaemonLogsResponse> {
    return this.listLogs({ event: 'headless.progress-frame', limit: String(limit) });
  }

  /** 통합 로그 패브릭 SSE tail (LF4) — /v1/logs/stream 에 서버측 필터를
   *  쿼리로 실어 연결. EventSource 는 헤더 불가 → same-origin auth 통과
   *  (sessionStoreEventsUrl 동형). */
  logsStreamUrl(params: Record<string, string> = {}): string | null {
    if (!this.cfg.baseUrl) return null;
    const qs = new URLSearchParams(params).toString();
    return `${this.url('/v1/logs/stream')}${qs ? `?${qs}` : ''}`;
  }

  /** §6.4 — list loaded personas (read-only · disk yaml authoritative).
   *  Mirrors `src/nexus/api/personas.ts` PersonaWire shape. PWA Showroom
   *  consumes for the per-panel persona picker. */
  async listPersonas(): Promise<{
    personas: Array<{
      personaId: string;
      displayName: string;
      description?: string;
      brand?: string;
      primaryModel?: string;
      systemPrompt?: string;
      avatarUrl?: string;
      brandColor?: string;
      mentionPatterns?: readonly string[];
    }>;
    count: number;
  }> {
    return this.fetchJson('/v1/personas');
  }

  /** RFC #2161 Phase 3 — Layer A static catalog snapshot. Used by the
   *  Showroom dropdown to drive provider options off the registry
   *  source-of-truth. Phase 5 sibling endpoint `/v1/registry/resolved`
   *  layers live (apiKey + health) state on top. */
  async getRegistryCatalog(): Promise<{
    catalogVersion: number;
    providers: Array<{
      id: string;
      displayName: string;
      aliases: string[];
      modelPrefixes: string[];
      apiKeyEnv: string;
      endpointPattern: string;
      defaultStreaming: 'sse' | 'ws' | 'polling';
      toolCallingFormat:
        | 'native-anthropic'
        | 'native-openai'
        | 'native-gemini'
        | 'none';
      capabilities: Record<string, boolean>;
      builtIn: boolean;
    }>;
    models: Array<{
      id: string;
      provider: string;
      displayName: string;
      family?: string;
      familyShortcut?: string;
      contextSize?: number;
      outputMaxTokens?: number;
      vision?: 'images' | 'video' | 'pdf' | null;
      reasoning?: 'off' | 'low' | 'medium' | 'high' | null;
      toolCalling?:
        | 'native-anthropic'
        | 'native-openai'
        | 'native-gemini'
        | 'none';
      pricing?: {
        inputPerMTok: number;
        outputPerMTok: number;
        cachedInputPerMTok?: number;
      };
      deprecated?: string | null;
      releaseDate?: string;
      kind?: 'chat' | 'embedding' | 'image' | 'audio';
    }>;
    patterns: Array<{
      provider: string;
      prefixes: Array<{ prefix: string; fallback: Record<string, unknown> }>;
    }>;
    manifest: {
      builtinSource: string;
      globalSource: string;
      fileCount: number;
      loadedAt: string;
    };
  }> {
    return this.fetchJson('/v1/registry/catalog');
  }

  // --- internals ------------------------------------------------------

  private url(path: string): string {
    const base = this.cfg.baseUrl.replace(/\/$/, '');
    return `${base}${path}`;
  }

  private authHeaders(): Record<string, string> {
    return this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {};
  }
}

/** WebSocket error 의 사람 말 — 사유가 없는 이벤트에서 «언제·어디»만 적는다(토큰은 서브프로토콜이라 URL 에 없다). */
export function describeSocketError(readyState: number, url: string): string {
  let host = 'unknown-host';
  try { host = new URL(url).host; } catch { /* 모르면 모른다 */ }
  return readyState === 0
    ? `socket error before open — daemon unreachable or refused (${host})`
    : `socket error while open — connection dropped (${host})`;
}

class AcpConnectionImpl implements AcpConnection {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private kindHandlers = new Map<string, Set<AcpFrameHandler>>();
  private anyHandlers = new Set<AcpFrameHandler>();
  /** Inbound JSON-RPC request handlers keyed by method and registration
   *  token. A shared core serves many consumer leases, so a lease disposer
   *  must remove only the handler it registered. */
  private requestHandlers = new Map<string, Map<symbol, AcpRequestHandler>>();
  private readyPromise: Promise<string>;
  private readonly sessionHandlers = new Set<(id: string) => void>();
  private readonly stateHandlers = new Set<AcpStateHandler>();
  private leases = 0;
  private stateValue: AcpConnectionState = 'CONNECTING';
  private stateError?: Error;
  /** True only after initialize plus session/load or session/new succeeds. */
  private handshakeComplete = false;
  private terminalNotified = false;
  private readonly onTerminal?: () => void;

  get ready(): Promise<string> {
    return this.readyPromise;
  }

  constructor(url: string, token: string, sessionId?: string, onTerminal?: () => void) {
    const wsUrl = sessionId ? `${url}?session=${encodeURIComponent(sessionId)}` : url;
    debugLog('webterm.acp.connect', { url: wsUrl, hasToken: !!token, sessionId });
    // Browser WebSocket can't send custom headers — bearer goes via subprotocol.
    this.ws = token
      ? new WebSocket(wsUrl, [`bearer.${token}`])
      : new WebSocket(wsUrl);
    this.onTerminal = onTerminal;
    // daemon-public-server's wireAcpForSocket sends Uint8Array via
    // ws.send — PWA must request ArrayBuffer (default is Blob, which
    // is async-only and would silently drop synchronous JSON.parse).
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('message', (ev) => this.onMessage(ev));
    this.ws.addEventListener('error', () => {
      // 브라우저 WebSocket 의 error 이벤트는 사유를 싣지 않는다 — `String(ev)` 는 늘 «[object Event]» 였다(09-28 · 3시간 36줄).
      // ⇒ 무엇을 가를 수 있는지만 적는다: «열기 전»(데몬에 못 닿음·거절) ↔ «연 뒤»(도중 끊김) ⊕ 어느 호스트.
      const error = new Error(describeSocketError(this.ws.readyState, wsUrl));
      this.fail(error);
      // An error need not be followed promptly by close. Request transport
      // shutdown after rejecting readiness and all in-flight RPCs now.
      if (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      debugLog('webterm.acp.error', { reason: error.message });
    });
    this.ws.addEventListener('close', (ev) => {
      const closeDetail = ev.reason ? `: ${ev.reason}` : '';
      const error = this.stateError ?? new Error(`socket closed: ${ev.code}${closeDetail}`);
      this.terminate(error, this.handshakeComplete ? 'CLOSED' : 'FAILED');
      debugLog('webterm.acp.close', { code: ev.code, reason: ev.reason, handshakeComplete: this.handshakeComplete });
    });
    // WT-S-1.5 — auto ACP handshake on open. Sends `initialize` then
    // `session/new` with elanous term/ui caps declared, so daemon
    // broadcasts (terminalOutput envelope etc.) reach this peer.
    this.readyPromise = (async () => {
      await this.waitOpen();
      const initRes = await this.sendRaw('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: {
            elanous: {
              ui: { showModal: true, showToast: true, updateStatusPill: true, usage: false },
              term: { terminalOutput: true, terminalExit: true, terminalFrame: true },
              // M4 of PLAN-ask-user-question-cross-surface-2026-05-13 —
              // PWA renders the native AskUserQuestion modal (shadcn
              // Dialog). Daemon's `dispatchAskUserQuestion` resolver
              // path will push via SDK `extMethod('elanous/ask/request',
              // …)` to peers that advertise this cap.
              ask: { askUserQuestion: true },
            },
          },
        },
      });
      debugLog('webterm.acp.initialize.done', { res: initRes });
      // Multi-surface entry (CV-1 Phase E follow-up · 2026-05-07) —
      // if the caller passed a hint sessionId (URL ?session= /
      // localStorage), try `session/load` first so this peer joins
      // the existing fan-out set on the server. `session/new` always
      // mints a fresh id, which forks every new tab into its own
      // session — the symptom that hid cross-surface streaming. On
      // "unknown session" we transparently fall back so a stale hint
      // (server restart cleared the session) still bootstraps.
      let sid = '';
      if (sessionId) {
        try {
          await this.sendRaw('session/load', {
            sessionId,
            cwd: '/',
            mcpServers: [],
          });
          sid = sessionId;
          debugLog('webterm.acp.session-load.done', { sessionId: sid });
        } catch (e) {
          debugLog('webterm.acp.session-load.miss', {
            sessionId,
            reason: String(e),
          });
        }
      }
      if (!sid) {
        const newRes = await this.sendRaw('session/new', {
          cwd: '/',
          mcpServers: [],
        });
        sid = (newRes as { sessionId?: string } | null)?.sessionId ?? '';
        debugLog('webterm.acp.session-new.done', { sessionId: sid });
      }
      if (sid) this.sessionHandlers.forEach((handler) => { try { handler(sid); } catch { /* consumer callback isolation */ } });
      this.handshakeComplete = true;
      return sid;
    })().catch((cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.fail(error);
      debugLog('webterm.acp.handshake-failed', { reason: error.message });
      // `ready` stays safe for existing fire-and-forget consumers; `state`
      // and the send gate retain the failure instead of silently continuing.
      return '';
    });
  }

  private sendRaw(method: string, params: unknown): Promise<unknown> {
    if (this.stateValue === 'FAILED' || this.stateValue === 'CLOSED' || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(this.stateError ?? new Error(`socket is ${this.stateValue}`));
    }
    const id = this.nextId++;
    const frame: AcpFrame = { jsonrpc: '2.0', id, method, params };
    debugLog('webterm.acp.send', { method, id });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // ndjson framing — daemon-side ndJsonStream parses by '\n'.
      // Without the terminator, the server-side parser holds the frame
      // in its buffer indefinitely (no handler dispatch, no response).
      try { this.ws.send(JSON.stringify(frame) + '\n'); } catch (e) {
        this.pending.delete(id);
        reject(e);
        this.closeIfUnused();
      }
    });
  }

  get readyState(): number {
    return this.ws.readyState;
  }

  get state(): AcpConnectionState {
    return this.stateValue;
  }

  get isTerminal(): boolean {
    return this.stateValue === 'FAILED' || this.stateValue === 'CLOSED';
  }

  acquire(onSession?: (id: string) => void): AcpConnection {
    this.leases += 1;
    return new AcpConnectionLease(this, onSession);
  }

  subscribeSession(handler: (id: string) => void): () => void {
    this.sessionHandlers.add(handler);
    return () => this.sessionHandlers.delete(handler);
  }

  release(): void {
    this.leases = Math.max(0, this.leases - 1);
    if (this.leases !== 0) return;
    if (this.pending.size > 0) {
      debugLog('webterm.acp.release-deferred', { pending: this.pending.size });
      return;
    }
    this.closeIfUnused();
  }

  private closeIfUnused(): void {
    if (this.leases === 0 && this.pending.size === 0 && !this.isTerminal) {
      this.dispose(new Error('ACP transport released'));
    }
  }

  dispose(error: Error = new Error('ACP transport disposed')): void {
    // Remove this exact core before close enters the browser's asynchronous
    // CLOSING state. A StrictMode remount must acquire a fresh transport,
    // while a late close from this core cannot erase that replacement.
    if (this.stateValue !== 'CLOSED') this.transition('CLOSED', error);
    this.rejectPending(error);
    this.notifyTerminal();
    if (this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) {
      this.ws.close();
    }
  }

  onState(cb: AcpStateHandler): () => void {
    this.stateHandlers.add(cb);
    this.notifyStateHandler(cb, this.stateValue, this.stateError);
    return () => this.stateHandlers.delete(cb);
  }

  private transition(state: AcpConnectionState, error?: Error): void {
    if (this.stateValue === state && this.stateError === error) return;
    this.stateValue = state;
    if (error) this.stateError = error;
    // A display subscriber is untrusted consumer code. Its failure must not
    // interrupt the core's terminal cleanup or prevent other leases learning
    // that their shared transport ended.
    this.stateHandlers.forEach((handler) => this.notifyStateHandler(handler, state, error));
    debugLog('webterm.acp.state', { state, reason: error?.message });
  }

  private notifyStateHandler(handler: AcpStateHandler, state: AcpConnectionState, error?: Error): void {
    try {
      handler(state, error);
    } catch (cause) {
      debugLog('webterm.acp.state-handler.error', { state, reason: String(cause) });
    }
  }

  private rejectPending(error: Error): void {
    this.pending.forEach((pending) => pending.reject(error));
    this.pending.clear();
  }

  private notifyTerminal(): void {
    if (this.terminalNotified) return;
    this.terminalNotified = true;
    this.onTerminal?.();
  }

  private terminate(error: Error, state: 'FAILED' | 'CLOSED'): void {
    // The first terminal transition wins. Before handshake completion, any
    // WebSocket close is a connection failure; after it, close is observable
    // as a normal ended connection. This prevents close/error ordering from
    // changing the UI outcome.
    if (!this.isTerminal) this.transition(state, error);
    this.rejectPending(error);
    this.notifyTerminal();
  }

  private fail(error: Error): void {
    this.terminate(error, 'FAILED');
    // JSON-RPC handshake rejections do not necessarily emit a browser error
    // or close event. Close the live transport here so a FAILED core cannot
    // remain cached forever after its final lease is released.
    if (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  async send(method: string, params: unknown): Promise<unknown> {
    // WT-S-1.5 — public sends wait for handshake. Internal handshake
    // sends use sendRaw to avoid recursion.
    await this.readyPromise.catch(() => undefined);
    return this.sendRaw(method, params);
  }

  on(kind: NonNullable<AcpFrame['kind']>, cb: AcpFrameHandler): () => void {
    let set = this.kindHandlers.get(kind);
    if (!set) {
      set = new Set();
      this.kindHandlers.set(kind, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  onAny(cb: AcpFrameHandler): () => void {
    this.anyHandlers.add(cb);
    return () => this.anyHandlers.delete(cb);
  }

  onRequest(method: string, handler: AcpRequestHandler): () => void {
    const token = Symbol(method);
    let handlers = this.requestHandlers.get(method);
    if (!handlers) {
      handlers = new Map();
      this.requestHandlers.set(method, handlers);
    }
    handlers.set(token, handler);
    return () => {
      const current = this.requestHandlers.get(method);
      if (!current) return;
      current.delete(token);
      if (current.size === 0) this.requestHandlers.delete(method);
    };
  }

  close(): void {
    this.release();
  }

  /** Invoke the latest active lease-local handler for an inbound request.
   *  ACP permits one response per request, so this preserves the prior
   *  last-write-wins handler contract without duplicating user side effects. */
  private async handleInboundRequest(
    id: string | number,
    method: string,
    params: unknown,
    handler: AcpRequestHandler,
  ): Promise<void> {
    debugLog('webterm.acp.request.in', { method, id });
    try {
      const result = await handler(params);
      this.sendResponse({ jsonrpc: '2.0', id, result }, method);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sendResponse({ jsonrpc: '2.0', id, error: { code: -32603, message: `internal error: ${msg}` } }, method);
    }
  }

  private sendErrorResponse(id: string | number, code: number, message: string): void {
    this.sendResponse({ jsonrpc: '2.0', id, error: { code, message } }, 'error-response');
  }

  /** Inbound RPC replies bypass `sendRaw`, but use the same final OPEN gate:
   * responder work may settle after an error/close event changed the core. */
  private sendResponse(frame: AcpFrame, method: string): void {
    if (this.stateValue !== 'OPEN' || this.ws.readyState !== WebSocket.OPEN) {
      debugLog('webterm.acp.request.response.drop', { method, id: frame.id, state: this.stateValue });
      return;
    }
    try {
      this.ws.send(JSON.stringify(frame) + '\n');
    } catch (err) {
      debugLog('webterm.acp.request.response.fail', { method, id: frame.id, reason: String(err) });
    }
  }

  private async waitOpen(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    if (this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      throw new Error('socket already closed');
    }
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        this.transition('OPEN');
        resolve();
      };
      const onErr = (): void => {
        cleanup();
        reject(new Error('socket open failed'));
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error('socket closed before open'));
      };
      const cleanup = (): void => {
        this.ws.removeEventListener('open', onOpen);
        this.ws.removeEventListener('error', onErr);
        this.ws.removeEventListener('close', onClose);
      };
      this.ws.addEventListener('open', onOpen);
      this.ws.addEventListener('error', onErr);
      this.ws.addEventListener('close', onClose);
    });
  }

  private onMessage(ev: MessageEvent): void {
    // Decode regardless of whether the server sent string or binary —
    // daemon-public-server pushes Uint8Array via ws.send, while a
    // legacy string-mode path may exist on other transports. Without
    // this, binary frames silently fall through to an empty-object
    // parse, dropping every JSON-RPC response and hanging the
    // handshake.
    let text: string;
    const data: unknown = ev.data;
    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(new Uint8Array(data));
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
      // Async Blob path — schedule decode then re-enter onMessage. This
      // happens only when binaryType wasn't set to 'arraybuffer' in
      // time (defensive fallback).
      void data.text().then((t) =>
        this.onMessage({ ...ev, data: t } as unknown as MessageEvent),
      );
      return;
    } else {
      text = '';
    }
    let frame: AcpFrame;
    try {
      frame = JSON.parse(text) as AcpFrame;
    } catch (err) {
      debugLog('webterm.acp.parse-error', { err: String(err), len: text.length });
      return;
    }
    // WT-S-1 — ACP standard JSON-RPC notifications carry `method` on the
    // wire, not `kind`. Map the canonical methods to our kind aliases so
    // consumers can `acp.on('sessionUpdate', cb)` regardless of which
    // path daemon-side emit took. Backward-compat: explicit `kind`
    // already on the frame wins.
    if (!frame.kind && frame.method) {
      if (frame.method === 'session/update') frame.kind = 'sessionUpdate';
    }
    debugLog('webterm.acp.frame.in', {
      method: frame.method ?? '(notif)',
      kind: frame.kind,
      id: frame.id,
    });
    // Resolve pending RPC
    if (frame.id !== undefined && this.pending.has(frame.id)) {
      const p = this.pending.get(frame.id)!;
      this.pending.delete(frame.id);
      if (frame.error) p.reject(new Error(frame.error.message));
      else p.resolve(frame.result);
      // A reply may itself trigger another send in the caller's microtask.
      // Defer retirement until that continuation has had a chance to run.
      queueMicrotask(() => this.closeIfUnused());
    } else if (
      // M4 of PLAN-ask-user-question-cross-surface-2026-05-13 — inbound
      // JSON-RPC request from the server (id present + method present +
      // NOT in our outbound pending map). Dispatch via the registered
      // handler and send a `{ jsonrpc, id, result | error }` response.
      frame.id !== undefined
      && frame.method
      && this.requestHandlers.has(frame.method)
    ) {
      const handlers = this.requestHandlers.get(frame.method)!;
      const handler = [...handlers.values()].at(-1);
      if (handler) void this.handleInboundRequest(frame.id, frame.method, frame.params, handler);
    } else if (
      // Inbound request for an unknown method — respond with
      // methodNotFound so the server's sendRequest Promise doesn't hang.
      frame.id !== undefined
      && frame.method
    ) {
      void this.sendErrorResponse(frame.id, -32601, `method not found: ${frame.method}`);
    }
    // Notification dispatch
    if (frame.kind) {
      const set = this.kindHandlers.get(frame.kind);
      set?.forEach((h) => h(frame));
    }
    this.anyHandlers.forEach((h) => h(frame));
  }
}

class AcpConnectionLease implements AcpConnection {
  private closed = false;
  private readonly disposers = new Set<() => void>();

  constructor(private readonly core: AcpConnectionImpl, onSession?: (id: string) => void) {
    if (onSession) this.disposers.add(core.subscribeSession(onSession));
  }

  private track(disposer: () => void): () => void {
    if (this.closed) {
      disposer();
      return () => {};
    }
    this.disposers.add(disposer);
    return () => { this.disposers.delete(disposer); disposer(); };
  }

  get ready(): Promise<string> { return this.core.ready; }
  get readyState(): number { return this.core.readyState; }
  get state(): AcpConnectionState { return this.core.state; }
  send(method: string, params: unknown): Promise<unknown> {
    return this.closed ? Promise.reject(new Error('ACP lease released')) : this.core.send(method, params);
  }
  on(kind: NonNullable<AcpFrame['kind']>, cb: AcpFrameHandler): () => void {
    return this.closed ? () => {} : this.track(this.core.on(kind, cb));
  }
  onAny(cb: AcpFrameHandler): () => void {
    return this.closed ? () => {} : this.track(this.core.onAny(cb));
  }
  onRequest(method: string, handler: AcpRequestHandler): () => void {
    return this.closed ? () => {} : this.track(this.core.onRequest(method, handler));
  }
  onState(cb: AcpStateHandler): () => void {
    return this.closed ? () => {} : this.track(this.core.onState(cb));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disposers.forEach((dispose) => dispose());
    this.disposers.clear();
    this.core.release();
  }
}

// ── Phase B-1 (PWA chat streaming) — SSE parser ────────────────────
//
// Parses the wire shape `event: <name>\ndata: <json>\n\n` produced by
// daemon `/v1/prompt/stream`. Exported standalone so the test suite
// can lock the parser independent of fetch + WebSocket plumbing.

interface SseBlock {
  event: string;
  data: unknown;
}

/** Parse one `\n\n`-delimited SSE event block into `{event, data}`.
 *  Returns `null` for blocks without a JSON-decodable `data:` line so
 *  comment lines / partial blocks are dropped without breaking the
 *  stream loop. Exported for unit testing. */
/** ⛔⭐⭐⭐ `tool-result` 전선 한 줄 → 핸들러 인자. **두 파서가 «한 집»에서 이것을 만든다.**
 *
 *  📏 2026-08-22 실측(16차 `[F]`): 이 계약이 **두 곳에 베껴져 있었고 하나만 자랐다.**
 *  - `parsePromptSseStream`(POST 턴) — `result` 를 읽고 `_meta.ui.resourceUri` 까지 «뽑았다».
 *  - `consumeObserverSse`(다른 탭 관측) — `ev.data` 를 **그대로 넘기며 타입만 네 필드로 좁혔다.**
 *    ⇒ `resourceUri` 는 «파생 값»이라 아무도 계산하지 않았고, 그래서 그 경로에서는
 *      ***`mcp_app` 블록이 영영 만들어지지 않는다*** — 위젯이 아예 안 뜬다.
 *
 *  ⛔ 이 저장소가 오늘 아침에 이름 붙인 그 부류다(`#11050` — 「같은 계약이 네 자리에 각자」).
 *  ⇒ 값을 만드는 자리를 «하나»로 둔다. 다음에 필드가 늘어도 두 경로가 «같이» 움직인다. */
export function toolResultHandlerPayload(data: unknown): {
  id: string;
  name: string;
  ok: boolean;
  summary?: string;
  rawOutput?: unknown;
  resourceUri?: string;
  resultOmittedReason?: 'too_large' | 'unserializable';
} | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const parsed = data as {
    id: string;
    name: string;
    ok: boolean;
    summary?: string;
    /** ⛔⭐ 이 갈래의 이름은 `result` 다 — `rawOutput` 이 «아니다».
     *  `rawOutput` 은 ACP 갈래(`tool_call_update`)의 이름이고,
     *  이 `tool-result` 갈래는 `src/nexus/api/meta-api.ts` 의
     *  `projectPwaToolResult()` 가 `result` 로 싣는다.
     *  ⛔ 두 갈래는 «다른 경로»다 — 이름을 섞으면 값이 영영 안 온다
     *  (2026-08-20 실측: 실제로 그렇게 어긋나 있었다). */
    result?: unknown;
    /** 값이 «빠진» 이유 — 발신 쪽이 «아는» 사실만 온다(추측이 아니다). */
    resultOmittedReason?: 'too_large' | 'unserializable';
  };
  const rawOutput = parsed.result;
  const rawOutputObject = rawOutput !== null
    && typeof rawOutput === 'object'
    && !Array.isArray(rawOutput)
    ? rawOutput as Record<string, unknown>
    : undefined;
  const meta = rawOutputObject?._meta;
  const metaUi = meta !== null && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).ui
    : undefined;
  const nestedResourceUri = metaUi !== null && typeof metaUi === 'object' && !Array.isArray(metaUi)
    ? (metaUi as Record<string, unknown>).resourceUri
    : undefined;
  const flatResourceUri = rawOutputObject?.['ui/resourceUri'];
  const resourceUri = typeof nestedResourceUri === 'string'
    ? nestedResourceUri
    : typeof flatResourceUri === 'string'
      ? flatResourceUri
      : undefined;
  return {
    id: parsed.id,
    name: parsed.name,
    ok: parsed.ok,
    ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
    ...(rawOutput !== undefined ? { rawOutput } : {}),
    ...(resourceUri !== undefined ? { resourceUri } : {}),
    // ⭐ 「왜 빠졌나」는 «발신 쪽이 아는» 사실이다(추측이 아니다) — 그대로 나른다.
    ...(parsed.resultOmittedReason !== undefined
      ? { resultOmittedReason: parsed.resultOmittedReason }
      : {}),
  };
}

export function parseSseBlock(block: string): SseBlock | null {
  let event = 'message';
  let dataStr = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      // SSE allows leading space after `data:`; strip exactly one if
      // present to match the daemon's writer (which emits `data: <json>`).
      const rest = line.slice(5);
      dataStr += rest.startsWith(' ') ? rest.slice(1) : rest;
    }
  }
  if (!dataStr) return null;
  try {
    return { event, data: JSON.parse(dataStr) as unknown };
  } catch {
    return null;
  }
}

/** Consume an SSE response body, dispatch events into `handlers`, and
 *  resolve with the `turn-end` payload. Rejects on `error` event or
 *  if the stream closes without a terminal event. Exported for the
 *  contract test that locks the wire shape. */
export async function parsePromptSseStream(
  body: ReadableStream<Uint8Array>,
  handlers: PromptStreamHandlers,
): Promise<PromptResponse> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  let final: PromptResponse | null = null;
  let errorPayload: PromptStreamErrorPayload | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = parseSseBlock(block);
      if (!ev) continue;
      if (ev.event === 'turn-begin') {
        handlers.onTurnBegin?.(ev.data as { sessionId: string });
      } else if (ev.event === 'text-delta') {
        handlers.onTextDelta?.(ev.data as { delta: string; full: string });
      } else if (ev.event === 'image-block') {
        handlers.onImageBlock?.(ev.data as {
          src: string;
          mediaType: string;
          alt?: string;
        });
      } else if (ev.event === 'tool-call') {
        handlers.onToolCall?.(ev.data as {
          id: string;
          name: string;
          args: Record<string, unknown>;
        });
      } else if (ev.event === 'tool-result') {
        const payload = toolResultHandlerPayload(ev.data);
        if (payload) handlers.onToolResult?.(payload);
      } else if (ev.event === 'feedback') {
        // M1 PR 2 — validate before dispatch · drop silently on schema
        // mismatch so a daemon-side regression can't crash the chat.
        if (isFeedbackEnvelopeWire(ev.data)) {
          handlers.onFeedback?.(ev.data);
        } else {
          debugLog('webterm.sse.feedback.drop', { reason: 'schema-mismatch' });
        }
      } else if (ev.event === 'turn-end') {
        final = ev.data as PromptResponse;
        handlers.onTurnEnd?.(final);
      } else if (ev.event === 'error') {
        errorPayload = ev.data as PromptStreamErrorPayload;
        handlers.onError?.(errorPayload);
      }
    }
  }
  if (errorPayload) {
    const detail = errorPayload.message ? `: ${errorPayload.message}` : '';
    throw new Error(`${errorPayload.error}${detail}`);
  }
  if (!final) throw new Error('prompt/stream closed without turn-end');
  return final;
}

/** Phase B-4 follow-up — observer-mode SSE consumer. Same parsing as
 *  `parsePromptSseStream` but never resolves: the caller's disposer
 *  aborts the underlying fetch when the subscription should end.
 *  `error` events fire the handler but do NOT throw — the stream
 *  stays open for the next turn. `subscribed` events (the one-shot
 *  marker the observer endpoint emits at start) and `turn-end`
 *  events both fall through to the same handlers as `promptStream`.
 *  Exported for the contract test that exercises observer parsing
 *  independent of fetch plumbing. */
export async function consumeObserverSse(
  body: ReadableStream<Uint8Array>,
  handlers: PromptStreamHandlers,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = parseSseBlock(block);
      idx = buffer.indexOf('\n\n');
      if (!ev) continue;
      if (ev.event === 'subscribed') {
        // No-op marker — bus subscription is live. Future turns
        // arrive on the same stream. (Caller may peek via debugLog
        // but observer needs no behavioral branch here.)
        continue;
      }
      if (ev.event === 'turn-begin') {
        handlers.onTurnBegin?.(ev.data as { sessionId: string });
      } else if (ev.event === 'text-delta') {
        handlers.onTextDelta?.(ev.data as { delta: string; full: string });
      } else if (ev.event === 'image-block') {
        handlers.onImageBlock?.(ev.data as {
          src: string;
          mediaType: string;
          alt?: string;
        });
      } else if (ev.event === 'tool-call') {
        handlers.onToolCall?.(ev.data as {
          id: string;
          name: string;
          args: Record<string, unknown>;
        });
      } else if (ev.event === 'tool-result') {
        // ⛔⭐⭐ 1차판은 `ev.data` 를 «그대로» 넘기며 타입만 네 필드로 좁혔다.
        //   ⇒ `resourceUri` 는 «파생 값»이라 아무도 계산하지 않았고, 그래서 이 경로에서는
        //     ***`mcp_app` 블록이 영영 안 만들어졌다*** — 다른 탭에서 보면 위젯이 아예 없다.
        //   ⇒ POST 경로와 «같은 집»에서 만든다(`toolResultHandlerPayload`).
        const payload = toolResultHandlerPayload(ev.data);
        if (payload) handlers.onToolResult?.(payload);
      } else if (ev.event === 'feedback') {
        // M1 PR 2 — observer path mirrors `parsePromptSseStream` so
        // the same envelope wire reaches multi-tab observers.
        if (isFeedbackEnvelopeWire(ev.data)) {
          handlers.onFeedback?.(ev.data);
        } else {
          debugLog('webterm.sse.feedback.observer-drop', { reason: 'schema-mismatch' });
        }
      } else if (ev.event === 'turn-end') {
        handlers.onTurnEnd?.(ev.data as PromptResponse);
      } else if (ev.event === 'error') {
        handlers.onError?.(ev.data as PromptStreamErrorPayload);
        // Observer keeps the connection open after an error so the
        // next turn (which gets its own turn-begin) flows through.
      }
    }
  }
}

// ── agent.status SSE consumer (rich-dev-feedback §6.2 #3) ───────────

/** Caller hooks for `subscribeAgentStatusEvents`. Mirrors the
 *  PromptStreamHandlers single-source contract — every received
 *  agent.status NexusEvent maps to one synthesized FeedbackEnvelope
 *  via `onFeedback`. Long-lived: never rejects, the disposer is the
 *  only exit. */
export interface AgentStatusEventHandlers {
  onFeedback: (env: FeedbackEnvelopeWire) => void;
  onError?: (info: { error: string; message?: string }) => void;
}

/** Daemon-side `AgentStatusRecord.status` enum (`SessionStatus`).
 *  Translated to the envelope's `'running' | 'queued' | 'done' |
 *  'error'` enum on the PWA side so the renderer + accumulator stay
 *  on a single status alphabet. `'idle'` has no envelope equivalent
 *  — those events are dropped (the chip's absence is the "idle"
 *  representation). */
type DaemonSessionStatus = 'idle' | 'working' | 'awaiting' | 'done' | 'err';

const STATUS_MAP: Record<DaemonSessionStatus, 'running' | 'queued' | 'done' | 'error' | null> = {
  idle: null,
  working: 'running',
  awaiting: 'queued',
  done: 'done',
  err: 'error',
};

interface AgentStatusEventDetail {
  agentId?: string;
  status?: string;
  lastEvent?: string;
  updatedAt?: number;
}

interface AgentStatusNexusEvent {
  ts: number;
  kind: string;
  detail?: AgentStatusEventDetail;
}

/** Long-lived SSE consumer for `/v1/events?topics=agent.status`.
 *  Parses each NexusEvent frame, validates the agent.status detail,
 *  translates SessionStatus → envelope status enum, and synthesizes
 *  a FeedbackEnvelopeWire (kind='agent.status', phase='update',
 *  blockId=`${sessionId}:agent-status:${agentId}` stable per agent).
 *  Maintains a per-blockId seq counter so the accumulator's monotonic
 *  invariant holds for the synthetic envelopes.
 *
 *  Exported so the contract test can exercise parsing without fetch
 *  plumbing. */
export async function consumeAgentStatusSse(
  body: ReadableStream<Uint8Array>,
  sessionId: string,
  handlers: AgentStatusEventHandlers,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  const seqByBlockId = new Map<string, number>();
  const nextSeq = (blockId: string): number => {
    const prev = seqByBlockId.get(blockId) ?? 0;
    const n = prev + 1;
    seqByBlockId.set(blockId, n);
    return n;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf('\n\n');
      const parsed = parseSseBlock(block);
      if (!parsed) continue;
      if (parsed.event !== 'agent.status') continue;
      const ev = parsed.data as AgentStatusNexusEvent | null;
      if (!ev || typeof ev !== 'object') continue;
      const detail = ev.detail;
      if (
        !detail
        || typeof detail.agentId !== 'string'
        || typeof detail.status !== 'string'
      ) continue;
      const mapped = STATUS_MAP[detail.status as DaemonSessionStatus];
      if (mapped === undefined || mapped === null) continue;
      const blockId = `${sessionId}:agent-status:${detail.agentId}`;
      const env: FeedbackEnvelopeWire = {
        envelopeVersion: 1,
        sessionId,
        blockId,
        kind: 'agent.status',
        phase: 'update',
        emittedAt: typeof detail.updatedAt === 'number' ? detail.updatedAt : ev.ts,
        seq: nextSeq(blockId),
        payload: {
          agentId: detail.agentId,
          status: mapped,
          ...(typeof detail.lastEvent === 'string' ? { lastEvent: detail.lastEvent } : {}),
        },
        asciiFallback: [
          `${detail.agentId} ${mapped}${detail.lastEvent ? ' · ' + detail.lastEvent : ''}`,
        ],
      };
      if (!isFeedbackEnvelopeWire(env)) {
        debugLog('webterm.agent-status.synthesize.drop', { agentId: detail.agentId, status: detail.status });
        continue;
      }
      handlers.onFeedback(env);
    }
  }
}

// PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M4 — hud.segment SSE
// consumer. Each event's detail is the `HudSegmentEventDetail` shape
// from the daemon-side bridge (src/nexus/api/hud-event-bridge.ts):
//   { phase: 'update'|'end', key, value?, priority?, tone?, glyph? }
// We synthesize a kind='hud.segment' envelope so the chat-runtime
// onFeedback path routes it via M1's applyHudSegmentEnvelope without
// any new branching.

export interface HudSegmentEventHandlers {
  onFeedback: (env: FeedbackEnvelopeWire) => void;
  onError?: (info: { error: string; message?: string }) => void;
}

interface HudSegmentEventDetail {
  phase?: string;
  key?: string;
  value?: string;
  priority?: number;
  tone?: string;
  glyph?: string;
}

interface HudSegmentNexusEvent {
  ts: number;
  kind: string;
  detail?: HudSegmentEventDetail;
}

/** Exported so contract tests can exercise the parse + synthesize
 *  step without fetch plumbing. Same shape contract as
 *  consumeAgentStatusSse. */
export async function consumeHudSegmentSse(
  body: ReadableStream<Uint8Array>,
  sessionId: string,
  handlers: HudSegmentEventHandlers,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  const seqByBlockId = new Map<string, number>();
  const nextSeq = (blockId: string): number => {
    const prev = seqByBlockId.get(blockId) ?? 0;
    const n = prev + 1;
    seqByBlockId.set(blockId, n);
    return n;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf('\n\n');
      const parsed = parseSseBlock(block);
      if (!parsed) continue;
      if (parsed.event !== 'hud.segment') continue;
      const ev = parsed.data as HudSegmentNexusEvent | null;
      if (!ev || typeof ev !== 'object') continue;
      const detail = ev.detail;
      if (!detail || typeof detail.key !== 'string' || !detail.key) continue;
      const phase = detail.phase === 'end' ? 'end' : 'update';
      const blockId = `${sessionId}:hud:${detail.key}`;
      const payload: Record<string, unknown> = { key: detail.key };
      if (phase === 'update') {
        if (typeof detail.value !== 'string') {
          debugLog('webterm.hud-segment.synthesize.drop', { key: detail.key, reason: 'missing-value' });
          continue;
        }
        payload.value = detail.value;
        if (typeof detail.priority === 'number') payload.priority = detail.priority;
        if (typeof detail.tone === 'string') payload.tone = detail.tone;
        if (typeof detail.glyph === 'string') payload.glyph = detail.glyph;
      } else {
        // phase=end: payload only needs key (accumulator clears the slot).
        payload.value = ''; // satisfy non-string narrowing for wire guard
      }
      const env: FeedbackEnvelopeWire = {
        envelopeVersion: 1,
        sessionId,
        blockId,
        kind: 'hud.segment',
        phase,
        emittedAt: ev.ts,
        seq: nextSeq(blockId),
        payload,
        asciiFallback: phase === 'update' && typeof detail.value === 'string'
          ? [`${detail.glyph ?? ''}${detail.glyph ? ' ' : ''}${detail.value}`]
          : [],
      };
      if (!isFeedbackEnvelopeWire(env)) {
        debugLog('webterm.hud-segment.synthesize.drop', { key: detail.key, reason: 'wire-guard' });
        continue;
      }
      handlers.onFeedback(env);
    }
  }
}
