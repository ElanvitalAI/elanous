// MT5 — ACP server mode for elanous.
//
// Lets a parent program (another elanous, claude-code, zed, …) drive
// this elanous instance over stdio-bound ACP JSON-RPC. The parent acts
// as an ACP client; this module wires an AgentSideConnection onto
// process.stdin/stdout and implements the minimum Agent methods.
//
// What's implemented:
//   - initialize()  — advertise protocol version + agentInfo
//   - newSession()  — assign a session id, store minimal context
//   - prompt()      — stream a text chunk echoing the user input,
//                     resolve with stopReason: 'end_turn'
//   - cancel()      — notification, sets a per-session aborted flag
//
// What's deliberately NOT implemented here:
//   - Actual LLM turn — this skeleton echoes. Wiring the real
//     streamLLMWithTools + dashboard tool catalog is a follow-up
//     (MT5b). The pipeline + session accounting is in place so the
//     follow-up can focus on the turn itself.
//   - Tool exposure to the client — default empty tool surface.
//   - File system methods — parent should fall back to its own.
//
// Usage (parent side):
//   spawn('elanous', ['--acp-server'])
//   → stdio becomes the bidirectional JSON-RPC stream.
//
// Related: src/acp/client.ts (elanous-as-client path — pre-MT5 work).

import { AgentSideConnection, ndJsonStream, RequestError } from '@agentclientprotocol/sdk';
import type {
  InitializeRequest, InitializeResponse,
  AuthenticateRequest, AuthenticateResponse,
  NewSessionRequest, NewSessionResponse,
  LoadSessionRequest, LoadSessionResponse,
  PromptRequest, PromptResponse,
  SetSessionConfigOptionRequest, SetSessionConfigOptionResponse,
  SessionConfigOption,
  CancelNotification,
  ContentBlock,
} from '@agentclientprotocol/sdk';
import { randomBytes } from 'node:crypto';
import type { NormalizedAttachment } from './content-blocks.js';
import { debug, redactSecretText } from '../debug/log.js';
import {
  globalDualRoleManager,
  type DualRoleManager,
} from './dual-role-manager.js';
import {
  buildAgentDeclaration,
  ELANOUS_PROTOCOL_VERSION,
  parseClientCapabilities,
} from './capabilities.js';
import {
  formatElanousFeedbackEnvelope,
  formatElanousUiEnvelope,
  formatElanousTermEnvelope,
  ELANOUS_UI_DISABLED,
  ELANOUS_TERM_DISABLED,
  type ElanousUiClientCapabilities,
  type ElanousUiShowModalPayload,
  type ElanousUiShowToastPayload,
  type ElanousUiUpdateStatusPillPayload,
  type ElanousUiUsagePayload,
  type ElanousTermClientCapabilities,
  type ElanousTermMethod,
  type ElanousTermPayload,
} from './elanous-extensions.js';
import { createMissionTurnEmitter } from './mission-turn-emit.js';
import { enqueuePendingUserInput } from '../session/pending-input.js';
import {
  ELANOUS_ASK_CANCEL_METHOD,
  ELANOUS_ASK_DISABLED,
  ELANOUS_ASK_REQUEST_METHOD,
  coerceAskResult,
  type ElanousAskCancelPayload,
  type ElanousAskClientCapabilities,
  type ElanousAskRequestPayload,
} from './ask-extensions.js';
import type { AskUserQuestionResult } from '../ask-user-question/types.js';
import type { FeedbackEnvelope } from '../feedback/envelope.js';
import type {
  AcpConnectionHandler,
  AcpTransportConnection,
  AcpTransportServer,
} from './transport/index.js';
import {
  type FsRootKind,
  resolveFsRoot,
  resolveObsidianRoot,
  clampToRoot,
  isHiddenForBrowser,
} from './fs-roots.js';
import { detectMime, isTextMime } from './fs-mime.js';
import { rgJsonMatchesAsync } from '../tool-runtime/ripgrep-core.js';
import { adoptSession, appendMessage, loadSession } from '../session/index.js';
// ⛔ 툴 추적은 «떼어낸» 모듈이 갖는다 — 시험이 「모양」이 아니라 「동작」을 물게 하려고(리뷰 must-fix).
import { persistAcpToolTrace } from './tool-trace.js';
import { readOriginSessionMeta } from './origin-session-meta.js';
import type { CodexPlugin } from './codex-plugins.js';
import { flattenMcpServersToCodexConfig } from './codex-approval-adapter.js';
import { runAcpTurn } from './turn-runner.js';
import { projectPwaToolResult, type ToolResultMeta } from '../nexus/api/meta-api.js';
import type { LlmBrand } from '../llm-vision-capability.js';
import {
  LLM_TIER_MAP_BY_PROVIDER,
  TIER_PROVIDERS,
  type LlmTierProvider,
  type LlmTierSpec,
} from '../model-tier/llm-tier-map.js';
import type { ModelTier } from '../model-tier/types.js';
import { setSessionTierOverride } from '../model-tier/session-override.js';

export const ACP_SERVER_SELF_PERFORMER = 'elanous:self';

// ACP SDK 1.x removed the session «model» API (`ModelInfo`·`SessionModelState`·`session/set_model`) in favour of
// session config options — the model list is now a `select` option with category `model` (#21407 bumped the SDK).
// These local shapes keep the tier catalog projection; `modelConfigOption` turns it into the 1.x wire shape.
export interface ModelInfo { modelId: string; name: string; description?: string }
export interface SessionModelState { availableModels: ModelInfo[]; currentModelId: string }
export const ACP_MODEL_CONFIG_ID = 'model';

/** Session model state as the ACP 1.x `configOptions` entry (a `select` in the `model` category). */
export function modelConfigOption(state: SessionModelState): SessionConfigOption {
  return {
    id: ACP_MODEL_CONFIG_ID,
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: state.currentModelId,
    options: state.availableModels.map((model) => ({
      value: model.modelId,
      name: model.name,
      ...(model.description ? { _meta: { description: model.description } } : {}),
    })),
  };
}

type AcpSessionModelCatalog = Readonly<Partial<Record<LlmTierProvider, Readonly<Partial<Record<ModelTier, LlmTierSpec>>>>>>;

/** Projects the static LLM tier catalog into ACP's session-model shape. */
export function deriveAcpSessionModelState(
  providers: readonly LlmTierProvider[] = TIER_PROVIDERS,
  catalog: AcpSessionModelCatalog = LLM_TIER_MAP_BY_PROVIDER,
): SessionModelState {
  const availableModels: ModelInfo[] = [];
  for (const provider of providers) {
    const tiers = catalog[provider];
    if (!tiers) continue;
    for (const [tier, spec] of Object.entries(tiers)) {
      if (!spec) continue;
      const modelId = `${provider}:${tier}:${spec.model}`;
      availableModels.push({
        modelId,
        name: spec.label,
        description: [spec.rationale, spec.status, spec.reasoningLevel].filter(Boolean).join(' · '),
      });
    }
  }
  if (availableModels.length === 0) {
    throw new Error('ACP session model catalog is empty');
  }
  return { availableModels, currentModelId: availableModels[0]!.modelId };
}

/** Persist a completed TUI-origin ACP turn under the ACP-minted id.
 * The origin marker distinguishes DashboardSession traffic from external
 * ACP clients while retaining the existing core-turn parent/child link. */
export function persistCompletedTuiAcpTurn(
  sessionId: string,
  promptMeta: Readonly<Record<string, unknown>> | undefined,
  userText: string,
  assistantText: string,
): void {
  if (!readOriginSessionMeta(promptMeta)) return;
  const existing = loadSession(sessionId);
  if (!existing) {
    adoptSession(sessionId, { source: 'tui', transport: 'acp' });
  }
  if (userText.length > 0) {
    appendMessage(sessionId, { role: 'user', content: userText, ts: new Date().toISOString() });
  }
  if (assistantText.length > 0) {
    appendMessage(sessionId, { role: 'assistant', content: assistantText, ts: new Date().toISOString() });
  }
}

export function resolveAcpServerTurnPerformer(): string {
  return ACP_SERVER_SELF_PERFORMER;
}

/** Preserves a client-chosen terminal id, or issues the daemon's web-terminal id. */
export function resolveAcpTerminalId(terminalId: unknown, now = Date.now()): string {
  return typeof terminalId === 'string' && terminalId.length > 0
    ? terminalId
    : `term-${now.toString(36)}`;
}

/** Convert session/new MCP servers into session-scoped Codex config arguments. */
export function buildAcpSessionCodexArgs(
  mcpServers: Parameters<typeof flattenMcpServersToCodexConfig>[0],
): string[] {
  const codexConfig = flattenMcpServersToCodexConfig(mcpServers);
  return Object.keys(codexConfig).length > 0
    ? ['-c', `mcp_servers=${JSON.stringify(codexConfig)}`]
    : [];
}

/** Minimum per-session record the server keeps in memory. The real
 *  elanous engine adds working dir, conversation history, tool registry
 *  scoping, etc. — this stub is just enough to route cancel() back
 *  to the right turn. Exported so F1 test helpers can construct
 *  server-state fixtures without re-declaring the shape. */
export interface AcpServerSession {
  id: string;
  cwd: string;
  createdAt: number;
  aborted: boolean;
  codexArgs: readonly string[];
}

export interface AcpServerOptions {
  /** Name reported back to the client in initialize(). Default 'elanous-agent'. */
  agentName?: string;
  /** Version string reported. Default read from package.json if present. */
  agentVersion?: string;
  /** Selected provider brand advertised to ACP clients at initialize time. */
  agentBrand?: LlmBrand;
  /** Selected provider model advertised to ACP clients at initialize time. */
  agentModel?: string;
  /** Injection point for the future MT5b LLM wire — the handler
   *  receives the user message text and a push() for streaming back
   *  assistant chunks. When omitted, the server echoes the prompt. */
  runTurn?: (ctx: AcpTurnContext) => Promise<void>;
  /** ACP standalone entry: require session cwd or an explicit boot default. */
  requireSessionToolCwd?: boolean;
  bootToolCwd?: string;
  /** Test seam for exercising stdio EOF with controlled byte streams. */
  stdioInput?: ReadableStream<Uint8Array>;
  stdioOutput?: WritableStream<Uint8Array>;
  /** Test seam for a slow session/new handler. */
  beforeNewSession?: () => Promise<void>;
  /** Stdio EOF drain deadline; defaults to 30 seconds. */
  stdioDrainTimeoutMs?: number;
  /** Session MCP path runner. Defaults to the canonical Codex ACP turn runner;
   *  tests inject it to observe the exact per-session child arguments. */
  runCodexTurn?: (opts: Parameters<typeof runAcpTurn>[0]) => Promise<unknown>;
  /** RC — callback invoked once after initialize finishes, handing
   *  the host a long-lived handle for broadcasting out-of-turn
   *  events (e.g. relaying local bell/block events to the bound
   *  client). Optional; when absent the server runs in pure
   *  request/response mode. */
  onHandle?: (handle: AcpServerHandle) => void;
  /** iOS session-list track (2026-05-14) — invoked once during
   *  `runAcpServer` setup so the host can capture an out-of-protocol
   *  cancel function bound to the server's internal sessions Map.
   *  The host (NEXUS boot) wires this into
   *  `MetaApiOpts.abortSession`, so `DELETE /v1/sessions/:id` can
   *  flip the same `session.aborted` flag the in-band
   *  `session/cancel` notification flips — without forcing the
   *  caller through the full ACP wire (REST clients · CLI · iOS
   *  swipe-delete). Calling the function returns `true` when the
   *  sessionId was known (and now flagged), `false` when unknown
   *  (already disposed / never opened). */
  onAbortHandle?: (cancel: (sessionId: string) => boolean) => void;
  /** RC — inbound prompt interception. Fires before the default
   *  echo / runTurn. Return `'consume'` to indicate the hook has
   *  fully handled the prompt (stopReason will be 'end_turn' with
   *  no additional chunk). Use this to treat specially-formatted
   *  prompts as cross-elanous notification payloads. */
  onPromptReceived?: (ctx: AcpTurnContext) => Promise<'consume' | void> | ('consume' | void);
  /** M2.3 — does the server-wide ledger know this session id? When
   *  provided, the `loadSession` handler validates incoming requests
   *  against this callback (typically `DaemonSessionHistory.has`).
   *  When omitted, `loadSession` rejects every call (the server then
   *  effectively advertises loadSession but always returns "unknown
   *  session" — same as before M2.3). The capability is still
   *  declared so well-behaved clients fall back gracefully on
   *  unknown ids. */
  hasSession?: (sessionId: string) => boolean;
  /** AXON F1 — test seam. Override the DualRoleManager instance used
   *  for server-side session registry (defaults to the module
   *  singleton). Production callers never set this. */
  dualRoleManager?: DualRoleManager;
  /** WT-A-3b — `:agent <prompt>` runner. When the sticky-REPL
   *  dispatcher returns `agentRequest`, the `terminal/repl/exec`
   *  handler routes here so the daemon's history + tool surface drive
   *  the LLM turn. Caller (daemon-public-server boot) closes over
   *  history/toolSurface/toolCwd. Returns assistant markdown + a model
   *  label the PWA renders in the AgentResponseSheet header. When
   *  omitted, `:agent` returns a "not wired" error so the dispatcher
   *  can run without daemon plumbing (CLI REPL future use). */
  runAgentTurn?: (input: {
    sessionId: string;
    terminalId: string;
    prompt: string;
    attachments?: NormalizedAttachment[];
    /** ACP streaming Phase A (PLAN-pwa-webterm-voice-control v1.2) —
     *  optional streaming callbacks. When present, the runner forwards
     *  partial deltas / tool events to these hooks so the ACP server
     *  can broadcast `session/update` notifications during the turn. */
    onTextDelta?: (delta: string, full: string) => void;
    onImageBlock?: (info: { src: string; mediaType: string; alt?: string }) => void;
    onToolCall?: (info: { id: string; name: string; args: Record<string, unknown> }) => void;
    /** ⛔ `result` 를 «반드시» 받는다 — 그것을 빼면 위젯 주소가 여기서 죽는다(2026-08-21). */
    onToolResultMeta?: (info: ToolResultMeta) => void;
  }) => Promise<{
    sessionId: string;
    markdown: string;
    modelLabel: string;
    stopReason: string;
    contextLines: number;
  }>;
  /** WT-A-3b Phase 4 — abort the in-flight `:agent` turn for the
   *  given (sessionId, terminalId). Returns `true` when a turn was
   *  matched + cancelled, `false` when there's nothing to cancel
   *  (already finished, never started, or unknown pair). The PWA
   *  TerminalRepl Esc handler / AgentResponseSheet X-button click
   *  hits the new ACP method `terminal/repl/agent/abort`, which then
   *  calls this callback. Wired by daemon-public-server boot to the
   *  abort-registry helper exported by `src/repl/agent-turn.ts`. */
  abortAgentTurn?: (input: {
    sessionId: string;
    terminalId: string;
  }) => boolean;
  /** WT-N-5 P2 — record that the PWA just uploaded a fresh live-
   *  camera frame for `sessionId`. Wired by daemon-public-server
   *  boot to `recordLiveCameraFrame()` in
   *  `src/web-terminal/live-camera-registry.ts`. The LLM tool
   *  `LiveCameraFrame` reads from the same registry to serve the
   *  most-recent frame on demand. Returns the assigned
   *  `frameIndex` so the PWA can correlate uploaded vs LLM-consumed
   *  frames in telemetry. */
  recordLiveCameraFrame?: (input: {
    sessionId: string;
    terminalId?: string;
    attachmentId: string;
    ts?: number;
  }) => { frameIndex: number };
  /** U4b — transport factory. When provided, `runAcpServer` skips
   *  the stdio wiring and instead calls this factory with an
   *  `onConnection` handler; each inbound connection the transport
   *  delivers becomes a fresh `AgentSideConnection` bound to the
   *  same server state (sessions, DualRoleManager).
   *
   *  Factory shape lets callers keep using `listenUnixSocket` /
   *  `listenWebSocket` from `transport/index.js` directly — they
   *  already accept an `onConnection` callback. The factory wraps
   *  that call so the server hands in its own handler.
   *
   *  When omitted, stdio is used (with EOF response draining). */
  transportFactory?: (onConnection: AcpConnectionHandler) => Promise<AcpTransportServer>;
  /** U4b — shutdown seam for transport mode. When the server is
   *  running over `transportFactory`, the serve loop waits on this
   *  signal and returns once it fires (after closing the transport
   *  and draining live connections). Tests drive a controlled
   *  shutdown without leaking the process; production boots hand in
   *  a signal wired to SIGINT / SIGTERM.
   *
   *  Has no effect on stdio mode — stdio ends when the peer closes
   *  stdin, which is its natural lifecycle signal. */
  shutdownSignal?: AbortSignal;
  /** FU-2 webterm wire (PLAN-pwa-webterm-voice-control v1.2 §15 · 2026-05-07) —
   *  optional server-side TTS bridge. When provided, every
   *  `agent_message_chunk` text emitted by the standard ACP
   *  `prompt` handler (line 800~947) and the webterm `:agent`
   *  branch of `terminal/repl/exec` is also pushed into
   *  `bridge.pushChunk(sessionId, delta)` so the daemon's voice WS
   *  downstream produces high-quality TTS audio for that session.
   *  Mirror of `MetaApiOpts.pwaTtsBridge` (chat REST path · PR #1908)
   *  — both paths feed the same per-session bridge instance so chat
   *  + webterm TTS converge on a single audio stream regardless of
   *  surface origin. NEXUS boot is the wire site (see
   *  `src/nexus/index.ts` line 727~). When omitted, the legacy
   *  Web Speech client-side fallback (`use-voice-tts.ts`) takes over.
   *  Errors thrown by `pushChunk` / `flush` are swallowed — bridge
   *  is best-effort by design and must never break the agent turn. */
  pwaTtsBridge?: {
    pushChunk: (sessionId: string, delta: string) => void;
    flush: (sessionId: string) => Promise<void> | void;
  };
  /** W8-A 후속 #1 (2026-05-14) — NEXUS-wide conversation aggregator.
   *  elanous-builtin ACP turn (user prompt + agent response) 을 본 store 에
   *  push 하면 agent-cli `historyMode='rebuild'` 호출 시 elanous-builtin
   *  turn 도 prefix 에 포함 → 진정한 양방향 통합 (elanous-builtin ↔ agent-
   *  cli). nexus/index.ts boot 시 globalConversationAggregator wire. test
   *  / standalone 환경은 undefined → push skip (legacy behavior). */
  conversationAggregator?: {
    append(chatId: string, turn: {
      role: 'user' | 'agent';
      backendId: string;
      text: string;
      at: number;
    }): void;
  };
  /** PLAN-codex-app-server-hermes-parity §5 Phase H2·2 (2026-05-16) —
   *  daemon-side bridge to `fetchCodexPlugins(activeCodexClient)`. The
   *  `elanous/codex/plugins` handler calls this to project the codex
   *  `plugin/list` RPC into the BackendPickerChip-ready shape. When
   *  omitted (no codex client wired), the handler returns an empty
   *  list — UI shows no sub-chips, never errors. NEXUS boot supplies
   *  the wire; tests typically leave it unset. */
  fetchCodexPlugins?: (sessionId: string) => Promise<ReadonlyArray<CodexPlugin>>;
}

export interface AcpRelayEvent {
  kind: string;
  title: string;
  body?: string;
  meta?: Readonly<Record<string, unknown>>;
}

export interface AcpRelayBlock {
  id: string;
  kind: string;
  text: string;
}

export interface AcpServerHandle {
  /** RC — broadcast a NotificationEvent-ish payload to the bound
   *  client as an `agent_thought_chunk`. The wire format is
   *  `[notify:<kind>] <title>\n<body?>` followed by a JSON meta
   *  envelope on its own line so the peer can round-trip it back
   *  into a local NotificationEvent without needing a new ACP
   *  update type. No-op when `sessionId` is unknown. */
  notify(sessionId: string, evt: AcpRelayEvent): Promise<void>;
  /** RC — broadcast a Block commit. Same wrapping as `notify`, kind
   *  fixed to `block`, body carries a capped preview of the text. */
  block(sessionId: string, blk: AcpRelayBlock): Promise<void>;
  /** UI-Core arc Phase U2 — `elanous/ui/showModal` envelope. No-op when
   *  the bound client hasn't advertised `showModal` in its
   *  ClientCapabilities._meta.elanous.ui blob. Caller supplies the id;
   *  action-click responses come back in-band via the next prompt's
   *  user-text (parsed via `parseElanousUiResponse`). */
  showModal(sessionId: string, payload: ElanousUiShowModalPayload): Promise<boolean>;
  /** UI-Core arc Phase U2 — fire-and-forget toast notification. */
  showToast(sessionId: string, payload: ElanousUiShowToastPayload): Promise<boolean>;
  /** UI-Core arc Phase U2 — update a status-bar pill (empty text clears). */
  updateStatusPill(sessionId: string, payload: ElanousUiUpdateStatusPillPayload): Promise<boolean>;
  /** UI-Core arc Phase U2 — read the bound client's negotiated UI
   *  capabilities. Falls back to `ELANOUS_UI_DISABLED` before initialize. */
  uiCapabilities(): ElanousUiClientCapabilities;
  /** WT-S-1 — broadcast a PreviewTerminal raw stdout chunk to every
   *  peer attached to this session. Read-only direction (daemon →
   *  browser). Wire: `agent_thought_chunk` + `elanous/term/terminalOutput`
   *  envelope (sibling to `pushUiEnvelope`). Caps-gated by
   *  `ElanousTermClientCapabilities.terminalOutput`. */
  terminalOutput(sessionId: string, terminalId: string, data: string): Promise<boolean>;
  /** WT-S-1 — broadcast PTY exit. Same wire as `terminalOutput`. */
  terminalExit(sessionId: string, terminalId: string, code: number): Promise<boolean>;
  /** WT-M-1 — emit a `terminalInputActivity` envelope so peers attached
   *  to the same terminal can show "another device typed" indicators.
   *  No-op on clients that didn't opt in via
   *  `ElanousTermClientCapabilities.terminalInputActivity`.
   *  - `peerId` — short opaque tag from the originating PWA (or empty
   *    when the input came from a legacy client). Receivers compare
   *    to their own tag to skip self-echo.
   *  - `bytes` — coarse hint for indicator intensity. Body itself is
   *    NOT echoed (privacy + already covered by terminalOutput PTY
   *    echo). */
  terminalInputActivity(
    sessionId: string,
    terminalId: string,
    peerId: string,
    bytes: number,
  ): Promise<boolean>;
  /** WT-S-1 — read the bound client's negotiated term capabilities.
   *  Falls back to `ELANOUS_TERM_DISABLED` before initialize. */
  termCapabilities(): ElanousTermClientCapabilities;
  /** AskUserQuestion cross-surface (2026-05-13) — push a structured
   *  question to the first cap-able peer attached to `sessionId` and
   *  await the user's answer. Wire: `connection.extMethod('elanous/ask/
   *  request', payload)`. Returns `null` immediately when no peer has
   *  advertised `_meta.elanous.ask.askUserQuestion=true` — caller (the
   *  AskUserQuestionResolver in `ask-question-bridge.ts`) falls through
   *  to TUI deps / resolver / 구조화 error.
   *
   *  v1 — first cap-able peer only. Multi-peer race (iOS + PWA 동시
   *  연결 → 어디서든 답할 수 있어야 함) 는 후속 PR. */
  pushAskRequest(
    sessionId: string,
    payload: ElanousAskRequestPayload,
  ): Promise<AskUserQuestionResult | null>;
  /** AskUserQuestion cancel propagation. Server-side turn abort 시 fan
   *  out `elanous/ask/cancel` notification to every peer attached to
   *  `sessionId` (best-effort · errors swallowed). Receivers dismiss
   *  any open sheet matching the id. Server-side pending Promise reject
   *  는 bridge (별 path) 가 책임. */
  pushAskCancel(
    sessionId: string,
    payload: ElanousAskCancelPayload,
  ): Promise<void>;
  /** Read the bound client's negotiated ask capabilities. Falls back to
   *  `ELANOUS_ASK_DISABLED` before initialize. */
  askCapabilities(): ElanousAskClientCapabilities;
  /** Active session ids the server currently knows about. Lets the
   *  host skip work when nothing is bound. */
  sessionIds(): string[];
}

/** RC — render an outgoing relay payload. Exported for tests so we
 *  can assert the exact on-wire shape without running the ACP SDK. */
// Strip ANSI control sequences so plain text reaches the chat UI
// without xterm-style escape codes leaking into the message bubble.
const ANSI_STRIP_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/** PP-9 — classify a `terminal/repl/exec` output line into a level the
 *  client can render as a chat-side system message. Returns `null`
 *  when there's nothing useful to surface (empty / agent-success
 *  header / etc.). */
function classifyReplSystemOutput(
  output: string,
  agentSucceeded: boolean,
): { level: 'note' | 'error'; text: string } | null {
  if (!output) return null;
  // Agent success path: the dispatcher writes a "head" line summarizing
  // model + chars + buffer lines, but the actual response renders as
  // markdown via the `agent` field. The head is redundant for chat-only
  // UX — drop it.
  if (agentSucceeded) return null;
  const trimmed = output.replace(ANSI_STRIP_RE, '').replace(/\r/g, '').trim();
  if (!trimmed) return null;
  const isError = output.includes('\x1b[31m');
  return { level: isError ? 'error' : 'note', text: trimmed };
}

/** 툴 인자 요약(순수) — 관측용. **원문을 통째로 싣지 않는다.**
 *
 *  계약: ①문자열 값만 프리뷰(객체는 타입만) ②값당 200자·전체 6키 상한
 *  ③`token|secret|key|password|authorization` 류 키는 **값 대신 `[redacted]`**
 *  (debug 모듈은 스크럽하지 않는다 — 호출측 책임이라 여기서 건다). */
export function summarizeToolArgs(args: unknown, maxKeys = 6, maxChars = 200): Record<string, string> {
  const out: Record<string, string> = {};
  if (!args || typeof args !== 'object') return out;
  const SECRET = /(token|secret|key|password|authorization|cookie)/i;
  let n = 0;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (n >= maxKeys) { out['…'] = `+${Object.keys(args as object).length - maxKeys} keys`; break; }
    n += 1;
    if (SECRET.test(k)) { out[k] = '[redacted]'; continue; }
    if (typeof v === 'string') {
      const preview = v.length > maxChars ? `${v.slice(0, maxChars)}…(${v.length})` : v;
      out[k] = redactSecretText(preview);   // 키 축(SECRET)만으론 값 안의 토큰이 통과한다
    } else if (v === null || v === undefined) {
      out[k] = String(v);
    } else if (Array.isArray(v)) {
      out[k] = `array(${v.length})`;
    } else if (typeof v === 'object') {
      out[k] = `object(${Object.keys(v as object).length})`;
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

/** 툴 결과 판정(순수) — **거부/실패가 성공처럼 보이지 않게** 한다.
 *  elanous 툴은 throw 대신 `{ error: string }` 을 돌려주는 경로가 있다(예: nest-cap 거부). */
export function describeToolResult(result: unknown): { ok: boolean; error?: string; shape: string } {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const err = (result as Record<string, unknown>).error;
    if (typeof err === 'string' && err.length > 0) {
      return { ok: false, error: redactSecretText(err.slice(0, 300)), shape: 'object' };
    }
    return { ok: true, shape: `object(${Object.keys(result as object).length})` };
  }
  if (Array.isArray(result)) return { ok: true, shape: `array(${result.length})` };
  if (typeof result === 'string') return { ok: true, shape: `string(${result.length})` };
  return { ok: true, shape: typeof result };
}

export function formatRelayNotify(evt: AcpRelayEvent): string {
  const head = `[notify:${evt.kind}] ${evt.title}`;
  const body = evt.body ? `\n${evt.body}` : '';
  const meta = evt.meta ? `\n<<meta ${JSON.stringify(evt.meta)}>>` : '';
  return `${head}${body}${meta}`;
}

export function formatRelayBlock(blk: AcpRelayBlock): string {
  const preview = blk.text.length > 160 ? `${blk.text.slice(0, 157)}...` : blk.text;
  return `[notify:block] ${blk.id} (${blk.kind})\n${preview}`;
}

const PROMPT_RELAY_RE = /^\[notify:([a-z]+)\]\s*(.*)$/;

// ── AXON F1 — server session lifecycle helpers ──────────────────
//
// Extracted from the runAcpServer closure so both the production
// stdio path and unit tests drive the exact same code. Each helper
// owns one transition; the server's newSession / prompt / close
// handlers compose them. Tests import these and verify the
// DualRoleManager interactions without spinning up AgentSideConnection.

/** Mint the unique suffix of an ACP session id: 6 chars of base36.
 *
 *  Was a process-local counter (`elanous-session-1`, `-2`, …) that reset to
 *  1 on every daemon restart, so unrelated conversations collided on one
 *  id — the 2026-07-09 chat and a 2026-07-23 chat both landed on
 *  `elanous-session-1`, and the on-disk mirror (`~/.elanous/sessions/<id>.jsonl`)
 *  would have merged them into a single file.
 *
 *  base36 (not hex) keeps the id 6 chars — short enough to retype for
 *  `/resume` — while giving 36^6 ≈ 2.18e9 of space. 6 hex chars would be
 *  only 1.68e7, i.e. ~24% birthday collision at 3k sessions vs ~0.2% here.
 *  Mirrors the existing `http-<ts36>-<rand36>` scheme in
 *  `boot/daemon-prompt-request.ts:63`.
 *
 *  Modular bias, knowingly accepted: the default source spans 0..2^48-1
 *  (≈2.81e14) and `% 36^6` (≈2.18e9) does not divide it evenly, so the
 *  lowest 2^48 mod 36^6 values are ~1/129297 more likely — a worst-case
 *  skew of ~0.13%. That is irrelevant for a collision-avoidance id (it is
 *  not a secret and carries no entropy guarantee); rejection sampling
 *  would buy nothing here. Callers needing uniformity inject `rand`.
 *
 *  Design: 내부 문서 `PLAN-self-cognition-observability-surgery-2026-07-24` §3 */
export function mintAcpSessionToken(
  rand: () => number = () => randomBytes(6).readUIntBE(0, 6),
): string {
  const SPACE = 36 ** 6;
  return (rand() % SPACE).toString(36).padStart(6, '0');
}

/** Allocate a fresh session id, record it in `sessions`, and register
 *  it with the shared DualRoleManager. Manager exceptions are swallowed
 *  so a registry hiccup never takes the session down. Returns the
 *  newly-created record for further bookkeeping. */
export function acpServerRegisterSession(
  sessions: Map<string, AcpServerSession>,
  dualRole: DualRoleManager,
  nextSessionToken: () => string,
  cwd: string,
  codexArgs: readonly string[] = [],
): AcpServerSession {
  let id = `elanous-session-${nextSessionToken()}`;
  // Random tokens collide only rarely, but a live collision would splice
  // two conversations onto one stream — re-mint instead of clobbering.
  const REMINT_BUDGET = 8;
  for (let i = 0; i < REMINT_BUDGET && sessions.has(id); i += 1) {
    id = `elanous-session-${nextSessionToken()}`;
  }
  if (sessions.has(id)) {
    // Re-mint budget exhausted — only reachable with a degenerate token
    // source (a stub that returns a constant, or a broken RNG). Reusing the
    // id here would drop the LIVE session's record, which is precisely the
    // class of accident this change exists to prevent, so disambiguate
    // rather than overwrite — and leave a trace, because a silent fallback
    // is just another kind of silence.
    const collided = id;
    id = `${collided}-${Date.now().toString(36)}`;
    debug.log('acp.session', 'collision-exhausted', {
      collided,
      resolved: id,
      attempts: REMINT_BUDGET,
    });
  }
  const record: AcpServerSession = {
    id,
    codexArgs: [...codexArgs],
    cwd,
    createdAt: Date.now(),
    aborted: false,
  };
  sessions.set(id, record);
  try { dualRole.serverSessionRegister(id, cwd); }
  catch { /* registry errors must not abort session creation */ }
  return record;
}

/** M2.3 — register an EXISTING session id on this connection. Used
 *  by the `loadSession` handler so the connection can answer
 *  prompts for a session minted elsewhere (a different connection,
 *  or persisted across daemon restarts). Validation that the id is
 *  known to the server-wide ledger lives in the caller (the
 *  loadSession handler invokes `opts.hasSession(id)` before this).
 *
 *  Throws if the connection has already registered the same id —
 *  catches double-attach bugs early. Returns the new record. */
export function acpServerLoadSession(
  sessions: Map<string, AcpServerSession>,
  dualRole: DualRoleManager,
  sessionId: string,
  cwd: string,
): AcpServerSession {
  if (sessions.has(sessionId)) {
    throw new Error(`session already registered on this connection: ${sessionId}`);
  }
  const record: AcpServerSession = {
    id: sessionId,
    codexArgs: [],
    cwd,
    createdAt: Date.now(),
    aborted: false,
  };
  sessions.set(sessionId, record);
  try { dualRole.serverSessionRegister(sessionId, cwd); }
  catch { /* registry hiccup must not abort load */ }
  return record;
}

/** Look up the session, reset its aborted flag (a prompt implicitly
 *  restarts the turn), and bump the DualRoleManager's `lastSeenAt`
 *  for the "Last seen by agent at" UI pattern. Returns the session
 *  record; callers use it to read cwd / wire runTurn. */
export function acpServerBeginPrompt(
  sessions: Map<string, AcpServerSession>,
  dualRole: DualRoleManager,
  sessionId: string,
): AcpServerSession {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`unknown session: ${sessionId}`);
  s.aborted = false;
  try { dualRole.markLastSeen(sessionId); }
  catch { /* ignore — best-effort */ }
  return s;
}

/** Unregister every session id from the DualRoleManager and clear
 *  the local map. Invoked from runAcpServer's finally block when the
 *  stdio connection drops — long-lived hosts that reconnect would
 *  otherwise accumulate stale records in the singleton. Returns the
 *  ids that were cleaned up so callers can log. */
export function acpServerDisposeSessions(
  sessions: Map<string, AcpServerSession>,
  dualRole: DualRoleManager,
): readonly string[] {
  const ids = [...sessions.keys()];
  for (const id of ids) {
    try { dualRole.serverSessionUnregister(id); }
    catch { /* ignore — best-effort */ }
  }
  sessions.clear();
  return ids;
}

/** RC — parse a relayed prompt. Inverse of formatRelayNotify — lets
 *  the receiving elanous's onPromptReceived hook pull a structured
 *  event out of the incoming text. Returns null when the prompt
 *  doesn't match the relay shape. */
export function parseRelayNotify(text: string): (AcpRelayEvent & { body?: string; meta?: Record<string, unknown> }) | null {
  const [firstLine, ...rest] = text.split('\n');
  const m = firstLine ? PROMPT_RELAY_RE.exec(firstLine) : null;
  if (!m) return null;
  const kind = m[1]!;
  const title = m[2]!;
  let body: string | undefined;
  let meta: Record<string, unknown> | undefined;
  if (rest.length > 0) {
    const bodyParts: string[] = [];
    for (const line of rest) {
      const metaMatch = /^<<meta (.*)>>$/.exec(line);
      if (metaMatch) {
        try { meta = JSON.parse(metaMatch[1]!) as Record<string, unknown>; } catch { /* ignore */ }
      } else {
        bodyParts.push(line);
      }
    }
    const joined = bodyParts.join('\n').trim();
    if (joined.length > 0) body = joined;
  }
  const out: AcpRelayEvent & { body?: string; meta?: Record<string, unknown> } = { kind, title };
  if (body !== undefined) out.body = body;
  if (meta !== undefined) out.meta = meta;
  return out;
}

export interface AcpTurnContext {
  sessionId: string;
  cwd: string;
  /** Session-scoped Codex app-server argv from the inbound `session/new` MCP servers. */
  codexArgs: readonly string[];
  /** Plain-text projection of the inbound prompt — non-text blocks
   *  (image, resource_link) are represented as `[<kind>]` placeholders.
   *  Backwards-compatible — pre-Step-2 runTurn handlers can keep using
   *  this; Step 2 handlers prefer `promptBlocks` for full fidelity. */
  userText: string;
  /** Step 2 of platform-evolution arc — full ContentBlock[] preserved
   *  from the inbound PromptRequest. When present, the runTurn handler
   *  can route attachments (image base64, resource_link) into the LLM
   *  message content directly without going through extractText's
   *  lossy projection. Always present (= req.prompt verbatim). */
  promptBlocks: ContentBlock[];
  /** Optional ACP `_meta` blob carried on the inbound PromptRequest.
   *  Source-aware submitters use this to preserve provenance across
   *  daemon boundaries without coupling `AcpTurnContext` to any one
   *  surface's payload vocabulary. */
  promptMeta?: Readonly<Record<string, unknown>>;
  /** Resolve-check; stop early if the parent cancelled the turn. */
  isAborted: () => boolean;
  /** Push a text chunk back to the client. The server wraps this in
   *  a session/update notification. */
  push: (chunk: string) => Promise<void>;
  /** CV-3 DM-1 — Push a text chunk with `_meta` annotation (e.g.
   *  `{ elanous: { modelId: 'panel-1', provider: 'claude' } }`).
   *  daemon multi-LLM dispatch routes N parallel streams through this
   *  method so the client can demultiplex per `modelId`. The wrap is
   *  identical to `push` except the `_meta` field is forwarded as the
   *  ACP `session/update`'s `_meta` (spec-allowed extension point —
   *  every ACP type carries optional `_meta`). When omitted, behaves
   *  exactly like `push`. */
  pushWithMeta: (
    chunk: string,
    _meta?: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
  /** P2-bridge-ext — emit an ACP-native `tool_call` sessionUpdate so
   *  extension-aware clients can render the tool block as it fires.
   *  Wire shape matches `schema.ToolCall` with `sessionUpdate:
   *  'tool_call'` (ACP spec `Agent Reports Output`). */
  pushToolCall: (call: { id: string; name: string; args: Record<string, unknown> }) => Promise<void>;
  /** P2-bridge-ext — emit an ACP-native `tool_call_update` so the
   *  client can flip the block from `pending` to `completed` and
   *  render the tool's rawOutput. */
  pushToolResult: (call: { id: string; name: string; result: unknown }) => Promise<void>;
  /** DM stage 3 FU (HANDOFF §3.2 · ShowroomPanel.tsx:244+397 TODOs) —
   *  emit a verbatim ACP SessionUpdate with optional `_meta` annotation.
   *  multi-llm-bridge uses this to forward an agent CLI sub-process's
   *  `tool_call` / `tool_call_update` events through the daemon's
   *  session/update channel with `_meta.elanous = { modelId, provider }`
   *  so the Showroom client demultiplexes per panel. Generic enough
   *  to forward any SessionUpdate variant without growing the typed
   *  push API surface. */
  pushSessionUpdate: (
    update: Readonly<Record<string, unknown>>,
    _meta?: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
  /** P2-bridge-ext — emit per-request LLM usage telemetry via the
   *  `elanous/ui/usage` envelope (ACP's `UsageUpdate` is session-level
   *  context-window info, not a per-turn token breakdown — so this
   *  piggybacks on `agent_thought_chunk`). No-op when the client
   *  didn't advertise `elanous.ui.usage` in its ClientCapabilities. */
  pushUsage: (usage: {
    provider?: 'anthropic' | 'openai';
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }) => Promise<void>;
  /** F1 — Phase 3 · request permission from the client for a
   *  mutating tool call. Wraps ACP's `client.requestPermission` with
   *  the standard 4-option set (`allow_once` / `allow_always` /
   *  `reject_once` / `reject_always`) and a timeout (default 60s per
   *  hermes — research Q#3). Resolves to `'allow-once'` /
   *  `'allow-always'` / `'deny-once'` / `'deny-always'` /
   *  `'cancelled'` / `'timeout'` so tool dispatchers can map to their
   *  own allow-session / deny-once semantics without parsing ACP
   *  outcomes. */
  requestApproval: (req: {
    toolCallId: string;
    toolName: string;
    toolArgs?: Record<string, unknown>;
    timeoutMs?: number;
  }) => Promise<AcpApprovalDecision>;
}

/** F1 — Phase 3 · resolved decision from `AcpTurnContext.requestApproval`.
 *  Mirrors hermes' `_KIND_TO_HERMES` mapping (research §4.1). */
export type AcpApprovalDecision =
  | 'allow-once'
  | 'allow-always'
  | 'deny-once'
  | 'deny-always'
  | 'cancelled'
  | 'timeout';

/** F1 — default approval timeout. 60s matches hermes'
 *  `_PERMISSION_DEFAULT_TIMEOUT_S`; overrideable per call. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;

/** ACP streaming Phase E (PLAN-pwa-webterm-voice-control v1.2 · 2026-05-07) —
 *  module-level handle to the broadcaster owned by the active runAcpServer
 *  instance. The chat REST handler (`src/nexus/api/meta-api.ts handlePromptStreamPost`)
 *  uses this to fan-out `session/update` notifications during chat turns,
 *  so cross-surface peers (webterm dock, TUI, other PWA tabs) on the same
 *  sessionId receive the same `agent_message_chunk` stream alongside the
 *  REST SSE response (dual-emit: SSE for chat client, ACP for cross-surface).
 *
 *  Set inside runAcpServer right after `ctx` is built; cleared on shutdown.
 *  Returns `null` when no daemon is up (e.g. unit tests that import
 *  meta-api without running the ACP server) — callers must null-check. */
let activeAcpBroadcaster:
  | ((sessionId: string, update: unknown) => Promise<{ delivered: number }>)
  | null = null;

// P0b(DESIGN-cross-surface-autonomy-membrane §10) — ACP ask pusher(elanous/ask → iPhone/PWA 시트)를 모듈-레벨로
// 노출. daemon-runtime 이 코어 데몬 턴(SelfImplement dispatch)에 SurfaceUx confirm/question 채널을 주입할 때
// createAcp*Channel(sessionId, getActiveAcpAskPusher()) 로 사용. sessionPeers 로 라우팅(연결 무관)·fail-soft(null=drop).
let activeAcpAskPusher: AcpServerHandle['pushAskRequest'] | null = null;
export function getActiveAcpAskPusher(): AcpServerHandle['pushAskRequest'] | null {
  return activeAcpAskPusher;
}

export function getActiveAcpBroadcaster():
  | ((sessionId: string, update: unknown) => Promise<{ delivered: number }>)
  | null {
  return activeAcpBroadcaster;
}

/** PLAN-ios-rich-dev-feedback-hydrate · M1-S (2026-05-13) — typed
 *  adapter on top of `activeAcpBroadcaster` that fans out a
 *  `FeedbackEnvelope` as a `elanous/feedback/emit` envelope packaged
 *  inside an `agent_thought_chunk` sessionUpdate.
 *
 *  Why `agent_thought_chunk` instead of a native `sessionUpdate:
 *  'feedback'`: the ACP SDK v0.14.1 schema validates the discriminant
 *  on BOTH ends, so a custom kind is dropped at the client. Sibling
 *  to `pushUiEnvelope` / `pushTermEnvelope` — same envelope-in-text
 *  pattern, different sentinel tokens.
 *
 *  Single source of truth for the wire format — iOS `FeedbackEnvelope`
 *  Codable mirror and PWA accumulator (when it switches off SSE) both
 *  parse the same shape via `parseElanousFeedbackEnvelope`. Returns
 *  `null` when no daemon is up; PWA SSE wire (`write('feedback', env)`
 *  in meta-api.ts) is unaffected and remains the legacy carrier. */
export function getActiveAcpFeedbackBroadcaster():
  | ((sessionId: string, env: FeedbackEnvelope) => Promise<{ delivered: number }>)
  | null {
  const inner = activeAcpBroadcaster;
  if (!inner) return null;
  return (sessionId, env) => {
    const text = formatElanousFeedbackEnvelope({ method: 'emit', payload: env });
    return inner(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text },
    });
  };
}

/** PLAN-ios-rich-dev-feedback-hydrate M4 (HUD) — fan-out across ALL
 *  active sessions. HUD state is process-wide (TUI / PWA / iOS share
 *  the same segments) so the per-session getActiveAcpFeedbackBroadcaster
 *  doesn't fit — there's no single "owning" session.
 *
 *  Implementation: synthesizes one envelope per active sessionId in
 *  `sessionPeers` so each peer's iOS / PWA ACP wire sees it routed to
 *  its own session (the FeedbackEnvelope.sessionId field tracks routing
 *  · payload.key is the global merge id).
 *
 *  Returns null when no daemon is up. envProto carries everything
 *  except sessionId — caller supplies a template and we re-stamp the
 *  per-session field. */
let activeAcpAllSessionsFeedbackBroadcaster:
  | ((envProto: Omit<FeedbackEnvelope, 'sessionId'> & { sessionId?: string }) => Promise<{ delivered: number; fannedTo: number }>)
  | null = null;

export function getActiveAcpAllSessionsFeedbackBroadcaster():
  | ((envProto: Omit<FeedbackEnvelope, 'sessionId'> & { sessionId?: string }) => Promise<{ delivered: number; fannedTo: number }>)
  | null {
  return activeAcpAllSessionsFeedbackBroadcaster;
}

/** ⭐P2 (capture substrate · PLAN §5) — fan-out a `terminalFrame`
 *  envelope across ALL active sessions to every term-frame-capable peer.
 *  The interactive dashboard TUI runs in a SEPARATE process with no ACP
 *  session of its own — nobody "owns" it — so, like HUD segments, its
 *  frame must reach whatever PWA/iOS peers happen to be attached. The
 *  daemon's manifest→frame poller (`tui-frame-broadcaster.ts`) calls this
 *  on a throttle. Gated per-peer on `getTermCaps().terminalFrame` so
 *  legacy peers never see the envelope text bleed. Returns null when no
 *  daemon is up. */
let activeAcpAllSessionsTermFrameBroadcaster:
  | ((payload: ElanousTermPayload<'terminalFrame'>) => Promise<{ delivered: number; fannedTo: number }>)
  | null = null;

export function getActiveAcpAllSessionsTermFrameBroadcaster():
  | ((payload: ElanousTermPayload<'terminalFrame'>) => Promise<{ delivered: number; fannedTo: number }>)
  | null {
  return activeAcpAllSessionsTermFrameBroadcaster;
}

/** Pull a stable `kind` string off a `session/update` payload for
 *  diagnostic logging. Returns the inner `sessionUpdate` discriminator
 *  when present, otherwise `'?'`. Snapshot-only — no allocation in the
 *  off-state path because callers already gate with `debug.enabled`. */
function extractUpdateKind(update: unknown): string {
  if (update && typeof update === 'object' && 'sessionUpdate' in update) {
    return String((update as { sessionUpdate: unknown }).sessionUpdate);
  }
  return '?';
}

/** Shared server state that lives across the lifetime of a
 *  `runAcpServer` invocation. Multi-connection transport mode (U4b)
 *  has every connection share these — sessions created on one peer
 *  are discoverable by handle-side broadcasts routed through any
 *  peer that happens to own the sessionId. */
interface AcpServerContext {
  sessions: Map<string, AcpServerSession>;
  /** BACKLOG #2.5 — session ↔ connection registry for broadcast.
   *  Every connection that holds a session id (via newSession or
   *  loadSession) registers its `SessionPeer` here; sessionUpdate
   *  fan-out walks the set so multi-surface clients (e.g. web PWA
   *  + TUI on the same id) all see the same stream. */
  sessionPeers: Map<string, Set<SessionPeer>>;
  dualRole: DualRoleManager;
  /** Mints the unique suffix of a new session id. Injected so tests can
   *  pin it deterministically — production wires `mintAcpSessionToken`. */
  nextSessionToken: () => string;
  agentName: string;
  agentVersion: string;
  opts: AcpServerOptions;
}

/** BACKLOG #2.5 — per-connection broadcast entry. `sessionUpdate`
 *  closes over the bound AgentSideConnection, `getUiCaps` reads the
 *  connection's negotiated `ElanousUiClientCapabilities` (lazy so
 *  caps captured at initialize time stay fresh). */
interface SessionPeer {
  sessionUpdate: (u: unknown) => Promise<void>;
  getUiCaps: () => ElanousUiClientCapabilities;
  /** WT-S-1 — same lazy pattern as `getUiCaps`. Returns the peer's
   *  negotiated `ElanousTermClientCapabilities`. */
  getTermCaps: () => ElanousTermClientCapabilities;
  /** AskUserQuestion cross-surface (2026-05-13) — same lazy pattern as
   *  `getUiCaps`. Returns the peer's negotiated `elanous/ask` caps. */
  getAskCaps: () => ElanousAskClientCapabilities;
  /** SDK-level `AgentSideConnection.extMethod` accessor — server →
   *  client JSON-RPC request for elanous-extension methods. Returns the
   *  client's response. Used by `pushAskRequest` to await user answer.
   *  Resolves to `null`-ish if connection closed before response. */
  extMethod: (method: string, params: unknown) => Promise<unknown>;
  /** SDK-level `AgentSideConnection.extNotification` accessor — one-way
   *  notification (no response). Used by `pushAskCancel`. */
  extNotification: (method: string, params: unknown) => Promise<void>;
  /** V2 (2026-05-18) — logical peer identifier from V1 ACP `_meta.elanous
   *  .origin.peerId` envelope. null until the connection's first prompt
   *  arrives (legacy peers that never set origin stay null = treated as
   *  distinct peers). `broadcast` uses this to dedupe multiple physical
   *  connections from the same logical peer (e.g. iOS app 안 다수 ACP
   *  socket 이 같은 process — agent_message_chunk 가 N번 yield 되는
   *  echo 차단). Mutated by the prompt handler. */
  peerId: string | null;
}

/** Wire a single `AgentSideConnection` onto the provided ndJsonStream.
 *  Owns all per-connection state (clientUiCaps, boundConnection ref,
 *  per-peer `AcpServerHandle`) so stdio and transport paths diverge
 *  only at the stream creation step. Returns the `AgentSideConnection`
 *  so callers can await `.closed`. */
function wireAcpConnection(
  stream: ReturnType<typeof ndJsonStream>,
  ctx: AcpServerContext,
): AgentSideConnection {
  const { sessions, sessionPeers, dualRole, opts } = ctx;
  // 2026-05-13 (M2 of AskUserQuestion cross-surface) — bound connection
  // widened to expose `extMethod` + `extNotification` (SDK's elanous
  // extension escape hatch). pushAskRequest / pushAskCancel route through
  // these instead of the legacy envelope-in-text path.
  let boundConnection:
    | {
        sessionUpdate: (u: unknown) => Promise<void>;
        extMethod: (method: string, params: unknown) => Promise<unknown>;
        extNotification: (method: string, params: unknown) => Promise<void>;
      }
    | null = null;
  let clientUiCaps: ElanousUiClientCapabilities = { ...ELANOUS_UI_DISABLED };
  let clientTermCaps: ElanousTermClientCapabilities = { ...ELANOUS_TERM_DISABLED };
  let clientAskCaps: ElanousAskClientCapabilities = { ...ELANOUS_ASK_DISABLED };

  // BACKLOG #2.5 — this connection's peer entry + the set of session
  // ids it has registered. Cleanup on `.closed` walks `ownedSessionIds`
  // and removes `peer` from each session's set in `ctx.sessionPeers`.
  const peer: SessionPeer = {
    sessionUpdate: (u) => {
      if (!boundConnection) return Promise.resolve();
      return boundConnection.sessionUpdate(u);
    },
    getUiCaps: () => clientUiCaps,
    getTermCaps: () => clientTermCaps,
    getAskCaps: () => clientAskCaps,
    extMethod: (method, params) => {
      if (!boundConnection) return Promise.resolve(null);
      return boundConnection.extMethod(method, params);
    },
    extNotification: (method, params) => {
      if (!boundConnection) return Promise.resolve();
      return boundConnection.extNotification(method, params);
    },
    peerId: null,
  };
  const ownedSessionIds = new Set<string>();
  const advertisedSessionModels = new Map<string, SessionModelState>();

  const registerPeer = (sessionId: string): void => {
    let set = sessionPeers.get(sessionId);
    if (!set) {
      set = new Set();
      sessionPeers.set(sessionId, set);
    }
    const wasNew = !set.has(peer);
    set.add(peer);
    ownedSessionIds.add(sessionId);
    if (debug.enabled) {
      debug.log('acp.peer.register', sessionId, {
        peerCount: set.size,
        wasNew,
      });
    }
    // C5d — streaming.acp flip 시 이 세션을 'acp' 구독자로 브리지(fan-out 이 ACP peer 로 도달 →
    // tg/dc 턴이 ACP 로도 스트리밍). fire-and-forget(sync registerPeer 유지)·idempotent(rejoin)·
    // fail-soft. flip OFF 면 완전 무영향(구독 미등록·bindings 무접촉).
    void (async () => {
      try {
        const { getUserConfig } = await import('../user-config.js');
        if (getUserConfig().sessionFabric?.streaming?.acp !== true) return;
        const { subscribeSession } = await import('../session/index.js');
        const { acpEndpointKey } = await import('../session/session-endpoint-key.js');
        subscribeSession(sessionId, { surface: 'acp', endpoint: acpEndpointKey({ sessionId }) });
      } catch { /* fail-soft */ }
    })();
  };

  /** BACKLOG #2.5 — broadcast a sessionUpdate to every peer that has
   *  this sessionId registered. `Promise.allSettled` so a wedged peer
   *  doesn't poison the others. `uiGate` / `termGate` let envelope
   *  payloads skip peers whose negotiated caps don't include the
   *  method. */
  const broadcast = async (
    sessionId: string,
    update: unknown,
    opts2?: {
      uiGate?: keyof ElanousUiClientCapabilities;
      termGate?: keyof ElanousTermClientCapabilities;
    },
  ): Promise<{ delivered: number }> => {
    const peers = sessionPeers.get(sessionId);
    const peerCount = peers?.size ?? 0;
    if (!peers || peers.size === 0) {
      if (debug.enabled) {
        debug.log('acp.broadcast', 'no-peers', {
          sessionId,
          kind: extractUpdateKind(update),
          scope: 'connection',
        });
      }
      return { delivered: 0 };
    }
    let delivered = 0;
    let dedupedByPeerId = 0;
    const tasks: Promise<unknown>[] = [];
    // V2 (2026-05-18) — logical peer dedupe. Same peerId 가 multiple
    // physical connection 으로 attach 됐을 때 (예: iOS app 안 socket
    // race) 첫 1개에만 send. peerId null (legacy / 식별 전) connection
    // 은 모두 distinct peer 으로 취급해 send (degraded compat).
    const seenPeerIds = new Set<string>();
    for (const p of peers) {
      if (opts2?.uiGate && !p.getUiCaps()[opts2.uiGate]) continue;
      if (opts2?.termGate && !p.getTermCaps()[opts2.termGate]) continue;
      if (p.peerId !== null) {
        if (seenPeerIds.has(p.peerId)) {
          dedupedByPeerId += 1;
          continue;
        }
        seenPeerIds.add(p.peerId);
      }
      delivered += 1;
      tasks.push(p.sessionUpdate({ sessionId, update }));
    }
    if (debug.enabled) {
      debug.log('acp.broadcast', 'fanout', {
        sessionId,
        kind: extractUpdateKind(update),
        peerCount,
        delivered,
        ...(dedupedByPeerId > 0 ? { dedupedByPeerId } : {}),
        scope: 'connection',
        ...(opts2?.uiGate ? { uiGate: opts2.uiGate } : {}),
        ...(opts2?.termGate ? { termGate: opts2.termGate } : {}),
      });
    }
    await Promise.allSettled(tasks);
    return { delivered };
  };

  const pushUiEnvelope = async (
    sessionId: string,
    method: 'showModal' | 'showToast' | 'updateStatusPill',
    payload: ElanousUiShowModalPayload | ElanousUiShowToastPayload | ElanousUiUpdateStatusPillPayload,
  ): Promise<boolean> => {
    if (!sessions.has(sessionId)) return false;
    const text = formatElanousUiEnvelope({ method, payload } as Parameters<typeof formatElanousUiEnvelope>[0]);
    const { delivered } = await broadcast(
      sessionId,
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text },
      },
      { uiGate: method },
    );
    return delivered > 0;
  };

  /** WT-S-1 — sibling helper to `pushUiEnvelope`. Wraps a
   *  `elanous/term/<method>` envelope in an `agent_thought_chunk` text
   *  payload and broadcasts to every term-capable peer attached to the
   *  session. Caps gate prevents envelope text from leaking to peers
   *  that can't render it. */
  const pushTermEnvelope = async <M extends ElanousTermMethod>(
    sessionId: string,
    method: M,
    payload: ElanousTermPayload<M>,
  ): Promise<boolean> => {
    if (!sessions.has(sessionId)) return false;
    const text = formatElanousTermEnvelope({ method, payload } as Parameters<typeof formatElanousTermEnvelope>[0]);
    if (debug.enabled) {
      debug.log('webterm.acp', 'envelope.out', {
        sessionId,
        method,
        terminalId: payload.terminalId,
        bytes: text.length,
      });
    }
    const { delivered } = await broadcast(
      sessionId,
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text },
      },
      { termGate: method },
    );
    return delivered > 0;
  };

  const handle: AcpServerHandle = {
    async notify(sessionId, evt) {
      if (!sessions.has(sessionId)) return;
      // BACKLOG #2.5 — relay notification to every peer attached to
      // this session. No UI caps gate: relay events are out-of-band
      // signals that all surfaces should observe.
      await broadcast(sessionId, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: formatRelayNotify(evt) },
      });
    },
    async block(sessionId, blk) {
      if (!sessions.has(sessionId)) return;
      await broadcast(sessionId, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: formatRelayBlock(blk) },
      });
    },
    async showModal(sessionId, payload) {
      return pushUiEnvelope(sessionId, 'showModal', payload);
    },
    async showToast(sessionId, payload) {
      return pushUiEnvelope(sessionId, 'showToast', payload);
    },
    async updateStatusPill(sessionId, payload) {
      return pushUiEnvelope(sessionId, 'updateStatusPill', payload);
    },
    async terminalOutput(sessionId, terminalId, data) {
      return pushTermEnvelope(sessionId, 'terminalOutput', { terminalId, data });
    },
    async terminalExit(sessionId, terminalId, code) {
      return pushTermEnvelope(sessionId, 'terminalExit', { terminalId, code });
    },
    async terminalInputActivity(sessionId, terminalId, peerId, bytes) {
      return pushTermEnvelope(sessionId, 'terminalInputActivity', {
        terminalId,
        peerId,
        timestamp: Date.now(),
        bytes,
      });
    },
    uiCapabilities() {
      return { ...clientUiCaps };
    },
    termCapabilities() {
      return { ...clientTermCaps };
    },
    askCapabilities() {
      return { ...clientAskCaps };
    },
    async pushAskRequest(sessionId, payload) {
      // AskUserQuestion cross-surface (2026-05-13 · M2). v1 picks the
      // first cap-able peer attached to the sessionId. Multi-peer race
      // (iOS + PWA 동시 연결 시 어디서든 답해도 OK) 는 후속 PR.
      const peers = sessionPeers.get(sessionId);
      if (!peers || peers.size === 0) {
        if (debug.enabled) debug.log('acp.ask.push', 'no-peers', { sessionId });
        return null;
      }
      let target: SessionPeer | null = null;
      for (const p of peers) {
        if (p.getAskCaps().askUserQuestion) { target = p; break; }
      }
      if (!target) {
        if (debug.enabled) debug.log('acp.ask.push', 'no-cap-peer', { sessionId, peerCount: peers.size });
        return null;
      }
      if (debug.enabled) {
        debug.log('acp.ask.push', 'request.out', {
          sessionId,
          askId: payload.id,
          qCount: payload.request.questions.length,
        });
      }
      let raw: unknown;
      try {
        raw = await target.extMethod(ELANOUS_ASK_REQUEST_METHOD, payload);
      } catch (err) {
        if (debug.enabled) {
          debug.log('acp.ask.push', 'request.error', {
            sessionId,
            askId: payload.id,
            error: redactSecretText(err instanceof Error ? err.message : String(err)),
          }, { level: 'error' });
        }
        // Treat peer error as cancellation — bridge gets a result it
        // can hand back to dispatchAskUserQuestion. Better than wedging
        // the LLM turn on a wedged peer.
        return { answers: {}, cancelled: true };
      }
      const result = coerceAskResult(raw);
      if (debug.enabled) {
        debug.log('acp.ask.push', 'response.in', {
          sessionId,
          askId: payload.id,
          cancelled: result.cancelled === true,
          answerKeys: Object.keys(result.answers),
        });
      }
      return result;
    },
    async pushAskCancel(sessionId, payload) {
      const peers = sessionPeers.get(sessionId);
      if (!peers || peers.size === 0) return;
      const tasks: Promise<void>[] = [];
      for (const p of peers) {
        if (!p.getAskCaps().askUserQuestion) continue;
        tasks.push(
          p.extNotification(ELANOUS_ASK_CANCEL_METHOD, payload).catch((err) => {
            if (debug.enabled) {
              debug.log('acp.ask.cancel', 'fanout.error', {
                sessionId,
                askId: payload.id,
                error: err instanceof Error ? err.message : String(err),
              }, { level: 'error' });
            }
          }),
        );
      }
      if (debug.enabled) {
        debug.log('acp.ask.cancel', 'fanout.out', {
          sessionId,
          askId: payload.id,
          targetCount: tasks.length,
          ...(payload.reason ? { reason: payload.reason } : {}),
        });
      }
      await Promise.allSettled(tasks);
    },
    sessionIds() {
      return [...sessions.keys()];
    },
  };

  // Server instance — toAgent is called once by the SDK to bind
  // handler methods to the newly created connection.
  const conn = new AgentSideConnection((connection) => {
    boundConnection = connection as unknown as {
      sessionUpdate: (u: unknown) => Promise<void>;
      extMethod: (method: string, params: unknown) => Promise<unknown>;
      extNotification: (method: string, params: unknown) => Promise<void>;
    };
    if (opts.onHandle) {
      try { opts.onHandle(handle); } catch { /* host error must not abort session */ }
    }
    // P0b — 이 연결의 handle.pushAskRequest 를 모듈-레벨에 노출(sessionPeers 로 라우팅·연결 무관·
    // last-writer-wins). daemon-runtime 이 코어 데몬 턴 SelfImplement dispatch 에 SurfaceUx 채널 주입 시 사용.
    activeAcpAskPusher = handle.pushAskRequest;
    return {
    async initialize(req: InitializeRequest): Promise<InitializeResponse> {
      // H2 #4 — capability declaration lives in capabilities.ts so
      // client + server + per-brand defaults stay in sync. No behavior
      // change vs. the previous hardcoded shape; single source of truth.
      //
      // UI-Core arc Phase U2 — parse client's ClientCapabilities +
      // _meta.elanous.ui extension blob so the handle gates push calls
      // correctly. Fall back to DISABLED when the client is
      // extension-unaware.
      const parsed = parseClientCapabilities(req.clientCapabilities, ELANOUS_PROTOCOL_VERSION);
      clientUiCaps = parsed.ui;
      clientTermCaps = parsed.term;
      clientAskCaps = parsed.ask;
      debug.log('acp.session', 'initialize', {
        protocolVersion: req.protocolVersion,
        clientName: req.clientInfo?.name ?? 'absent',
        clientVersion: req.clientInfo?.version ?? 'absent',
      });
      return {
        protocolVersion: ELANOUS_PROTOCOL_VERSION,
        agentInfo: { name: ctx.agentName, version: ctx.agentVersion },
        agentCapabilities: opts.agentBrand !== undefined && opts.agentModel !== undefined
          ? buildAgentDeclaration({ brand: opts.agentBrand, model: opts.agentModel })
          : buildAgentDeclaration(),
        authMethods: [],
      };
    },

    async authenticate(_req: AuthenticateRequest): Promise<AuthenticateResponse> {
      // No auth flow — we advertise authMethods: [] so the client
      // shouldn't call this, but the Agent interface requires the
      // method to be present.
      return {};
    },

    async newSession(req: NewSessionRequest): Promise<NewSessionResponse> {
      if (opts.beforeNewSession) await opts.beforeNewSession();
      const sessionCwd = typeof req.cwd === 'string' && req.cwd.trim() ? req.cwd : undefined;
      const cwd = opts.requireSessionToolCwd
        ? sessionCwd ?? opts.bootToolCwd
        : req.cwd ?? process.cwd();
      if (!cwd) {
        throw RequestError.invalidParams(undefined, 'cwd required: pass session/new cwd or start with --tool-cwd');
      }
      const mcpServers = req.mcpServers ?? [];
      const codexArgs = buildAcpSessionCodexArgs(mcpServers);
      const forwardedServerCount = codexArgs.length === 0
        ? 0
        : Object.keys(flattenMcpServersToCodexConfig(mcpServers)).length;
      const record = acpServerRegisterSession(
        sessions,
        dualRole,
        ctx.nextSessionToken,
        cwd,
        codexArgs,
      );
      debug.log('acp.codex.mcp', 'session-config', {
        sessionId: record.id,
        receivedServerCount: mcpServers.length,
        forwardedServerCount,
      });
      // BACKLOG #2.5 — register THIS connection as a broadcast peer
      // for the new session id. Self-only at this point; other peers
      // attach later via loadSession.
      registerPeer(record.id);
      // ⭐ ACP 세션 계측(2026-07-27) — 이 구간은 종전 **완전 암흑**이었다. 운영 6시간 전수에서
      //   `acp` 계열은 `acp.termframe`(프레임 팬아웃)뿐이라 "agent → L2 데몬" 왕복이 통째로
      //   관측 불가였다(제1원칙 위반). 실측 사건: `elanous attach --message` 가 4분간 무출력으로
      //   끝났는데 **연결됐는지·프롬프트가 처리됐는지조차 판정할 수 없었다.**
      //   ⚠️ `if (debug.enabled)` 로 감싸지 않는다 — 그건 핫패스 게이트라 운영에서 꺼져 있고,
      //      기존 `acp.peer-id` 가 그 뒤에 있어 안 보였다. 세션 lifecycle 은 저빈도라 항상 남긴다.
      debug.log('acp.session', 'new', { sessionId: record.id, cwd });
      if (opts.requireSessionToolCwd) {
        debug.log('acp.session', 'tool-cwd', { sessionId: record.id, cwd, source: sessionCwd ? 'session' : 'boot' });
      }
      const models = deriveAcpSessionModelState();
      advertisedSessionModels.set(record.id, models);
      return { sessionId: record.id, configOptions: [modelConfigOption(models)] };
    },

    async setSessionConfigOption(req: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
      const advertisedModels = advertisedSessionModels.get(req.sessionId);
      if (!ownedSessionIds.has(req.sessionId) || !advertisedModels) {
        throw RequestError.invalidParams(undefined, 'unknown or unadvertised session');
      }
      if (req.configId !== ACP_MODEL_CONFIG_ID) {
        throw RequestError.invalidParams(undefined, 'unknown config option');
      }
      const modelId = typeof req.value === 'string' ? req.value : undefined;
      const selected = modelId ? advertisedModels.availableModels.find((model) => model.modelId === modelId) : undefined;
      if (!modelId || !selected) {
        throw RequestError.invalidParams(undefined, 'unadvertised session model');
      }
      const [, tier] = modelId.split(':', 3);
      if (!tier) {
        throw RequestError.invalidParams(undefined, 'invalid session model');
      }
      setSessionTierOverride(req.sessionId, {
        llm: tier as ModelTier,
        rationale: `ACP client selected ${selected.name} (${modelId})`,
      });
      const next: SessionModelState = { ...advertisedModels, currentModelId: modelId };
      advertisedSessionModels.set(req.sessionId, next);
      debug.log('acp.session', 'model-selected', { sessionId: req.sessionId, modelId, tier });
      return { configOptions: [modelConfigOption(next)] };
    },

    /** M2.3 — adopt an EXISTING session id from a long-lived ledger
     *  (typically `DaemonSessionHistory`). Validation is delegated
     *  to `opts.hasSession` so the server doesn't need to know
     *  WHERE history lives. Unknown ids throw a typed error per ACP
     *  spec; the SDK turns it into a JSON-RPC error response. */
    async loadSession(req: LoadSessionRequest): Promise<LoadSessionResponse> {
      const { sessionId } = req;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('loadSession requires a sessionId');
      }
      // Multi-surface entry (CV-1 Phase E follow-up · 2026-05-07) —
      // if the session is already in-memory (created by another peer
      // via `session/new`, even before any turn was appended to
      // history), accept the load and register this connection as an
      // additional broadcast peer. Without this short-circuit, a
      // freshly-minted session can't accept a second tab until its
      // first turn flushes to `runtimeHistory` (because the
      // `opts.hasSession` check below queries history, not the live
      // sessions map). Idempotency: a re-load by the same connection
      // simply re-adds itself to the same set — no double-init.
      const sessionCwd = typeof req.cwd === 'string' && req.cwd.trim() ? req.cwd : undefined;
      const cwd = opts.requireSessionToolCwd
        ? sessionCwd ?? opts.bootToolCwd
        : req.cwd ?? process.cwd();
      if (sessions.has(sessionId)) {
        if (opts.requireSessionToolCwd && sessionCwd) {
          sessions.get(sessionId)!.cwd = sessionCwd;
          debug.log('acp.session', 'tool-cwd', { sessionId, cwd: sessionCwd, source: 'session' });
        }
        registerPeer(sessionId);
        return {};
      }
      if (!opts.hasSession || !opts.hasSession(sessionId)) {
        throw new Error(`unknown session: ${sessionId}`);
      }
      if (!cwd) {
        throw RequestError.invalidParams(undefined, 'cwd required: pass session/load cwd or start with --tool-cwd');
      }
      acpServerLoadSession(sessions, dualRole, sessionId, cwd);
      if (opts.requireSessionToolCwd) {
        debug.log('acp.session', 'tool-cwd', { sessionId, cwd, source: sessionCwd ? 'session' : 'boot' });
      }
      // BACKLOG #2.5 — broadcast peer registration.
      registerPeer(sessionId);
      return {};
    },

    async prompt(req: PromptRequest): Promise<PromptResponse> {
      const s = acpServerBeginPrompt(sessions, dualRole, req.sessionId);

      const userText = extractText(req.prompt);
      // Tier 1 Phase 3 양방향 sync — broadcast the inbound user
      // prompt to every peer attached to req.sessionId so non-active
      // surfaces (e.g. a Telegram chat watching a PWA-driven session)
      // see what the user just asked. ACP standard doesn't define
      // user_message_chunk; this is a elanous extension. Peers that
      // don't recognize the kind drop it harmlessly (their interceptor
      // switch falls through). When the prompt is empty (image-only
      // turn etc.), skip the broadcast.
      // V2 (2026-05-18) — logical peer cache. prompt 의 origin.peerId 를
      // 본 connection 의 peer 에 attach → broadcast 가 같은 peerId 의
      // multiple connection 중 1개에만 send. iOS app 안 multiple ACP socket
      // 시 agent_message_chunk N번 yield → interleave 화면 echo 차단.
      const originRaw = (((req as PromptRequest & { _meta?: Record<string, unknown> })
        ._meta?.elanous) as Record<string, unknown> | undefined)?.origin;
      if (originRaw
          && typeof (originRaw as Record<string, unknown>).peerId === 'string'
          && (originRaw as Record<string, unknown>).peerId !== '') {
        const newPeerId = (originRaw as Record<string, unknown>).peerId as string;
        if (peer.peerId !== newPeerId) {
          if (debug.enabled) {
            debug.log('acp.peer-id', 'set', {
              sessionId: req.sessionId,
              previous: peer.peerId,
              next: newPeerId,
            });
          }
          peer.peerId = newPeerId;
        }
      }

      if (userText.length > 0) {
        // V1 (2026-05-18) — multi-peer first-class substrate. 발신
        // peer 의 origin (`_meta.elanous.origin`) 을 broadcast envelope 에
        // transparent propagate → 수신 peer 가 self-broadcast filter
        // 가능 (자기 originator 면 mirror skip). multi-surface 동기화
        // (PWA + iOS + Telegram) 는 그대로 작동.
        const userUpdate: { sessionUpdate: 'user_message_chunk'; content: { type: 'text'; text: string }; _meta?: Record<string, unknown> } = {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: userText },
        };
        if (originRaw) {
          userUpdate._meta = { elanous: { origin: originRaw } };
        }
        await broadcast(req.sessionId, userUpdate);
      }
      // BACKLOG #2.5 — every sessionUpdate emitted from a turn fans
      // out to all peers attached to req.sessionId so a multi-surface
      // client (web PWA + TUI on the same id) sees the same stream.
      // FU-2 webterm wire (PLAN v1.2 §15 · 2026-05-07) — same delta
      // also pushed into the optional pwaTtsBridge so high-quality
      // server-side TTS reaches /chat + /term parity. Errors swallow
      // (bridge is best-effort · agent turn must never break).
      // W8-A 후속 #1 (2026-05-14) — agent text 누적용 (NEXUS-wide
      // conversation aggregator turn-end push). chatId 미명시 (=
      // conversationAggregator 없음) 시 무용 메모리.
      let aggregatorAgentText = '';
      const turnStartedAt = Date.now();
      // ⭐ ACP 턴 계측 — "무슨 툴을 골랐나" 가 이 라인(agent → L2 → L3)의 핵심 질문이다.
      //   턴 종료 시 한 줄로 답할 수 있게 이름을 누적한다(순서 보존·상한으로 폭주 방지).
      const turnTools: string[] = [];
      // ⚠️ 이름 배열은 상한이 있으므로 **개수는 따로 센다**(리뷰 should-fix) —
      //   상한을 개수로 쓰면 200 회 이상 호출이 전부 '200' 으로 보고돼 거짓이 된다.
      let turnToolCount = 0;
      debug.log('acp.session', 'prompt-start', {
        sessionId: req.sessionId,
        chars: userText.length,
        // ⚠️ 사용자 원문에도 토큰이 섞일 수 있다(리뷰 must-fix) — 텍스트 축 스크러버 경유.
        preview: redactSecretText(userText.slice(0, 120)),
      });
      // C5d — ACP 청크 producer tap. shadowFanout(shadow) 또는 streaming.acp(flip) 시 ACP 턴 델타를
      // 통합 fan-out 으로 tee → tg/dc/pwa 미러(ACP 자기 peer 는 제외 — 아래 direct broadcast 가 서빙).
      // 옛 broadcast 경로는 **완전 무접촉**(byte-identical). fail-soft — tap 이 턴 무중단.
      let c5dProducer: import('../session/streaming/chunk-producer.js').AcpChunkProducer | null = null;
      try {
        const { getUserConfig } = await import('../user-config.js');
        const sf = getUserConfig().sessionFabric;
        if (sf?.shadowFanout === true || sf?.streaming?.acp === true) {
          const { makeAcpChunkProducer } = await import('../session/streaming/chunk-producer.js');
          const { acpEndpointKey } = await import('../session/session-endpoint-key.js');
          const { subscriberKey } = await import('../session/index.js');
          const selfKey = subscriberKey('acp', acpEndpointKey({ sessionId: req.sessionId }));
          c5dProducer = makeAcpChunkProducer(req.sessionId, { excludeKeys: [selfKey] });
        }
      } catch { /* fail-soft */ }
      const push = async (chunk: string): Promise<void> => {
        aggregatorAgentText += chunk;
        try { c5dProducer?.delta(chunk); } catch { /* fail-soft */ }
        await broadcast(req.sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: chunk },
        });
        if (opts.pwaTtsBridge) {
          try { opts.pwaTtsBridge.pushChunk(req.sessionId, chunk); }
          catch { /* swallow — telemetric */ }
        }
      };
      // CV-3 DM-1 — `pushWithMeta` mirrors `push` but forwards a
      // elanous-namespaced `_meta` blob on the ACP session/update.
      // The chat REST surface (PR #1908) reads update._meta.elanous.modelId
      // (when present) to demultiplex parallel streams in Showroom UI.
      // TTS bridge is intentionally NOT wired here — multi-LLM N stream
      // would interleave the per-model audio; the chat REST single-LLM
      // path keeps the legacy single-stream TTS contract.
      const pushWithMeta: AcpTurnContext['pushWithMeta'] = async (chunk, _meta) => {
        const update: Record<string, unknown> = {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: chunk },
        };
        if (_meta) update._meta = _meta;
        await broadcast(
          req.sessionId,
          update as Parameters<typeof broadcast>[1],
        );
      };
      // ⛔⭐⭐⭐ 이 턴의 툴 인자를 «결과가 올 때까지» 붙잡아 둔다 — 감사 추적은 둘을 «짝지어야» 뜻이 있다.
      //
      //  📏 2026-08-22 실측(16차 `[F]`): ***PWA 세션에는 툴 추적이 «하나도» 없었다.***
      //  저장소 role 분포가 `user 201 · assistant 236 · system 12` 였고 **`tool` 이 «0»**.
      //  ⛔ 전수: `buildToolTraceMessage()` 를 부르는 곳은 `session/chat.ts`(CLI·TUI) ·
      //    discord · telegram 뿐이고, ***`src/acp/` 와 `src/nexus/` 에는 하나도 없었다.***
      //  ⇒ 🔑 ***표면마다 감사 추적이 갈렸다*** — CLI·TUI·텔레그램은 남기고 **PWA 만 안 남겼다.**
      //    그래서 「PWA 에서 어떤 도구를 호출했나」에는 «지어낸 답»밖에 나올 수 없었다
      //    (`session/chat.ts` 주석이 그 위험을 이미 적었다 — *"the REAL trace, not a confabulated one"*).
      //
      //  ⛔⭐⭐ **그리고 이 자리를 고르는 데 한 번 틀렸다.** 처음엔 아래쪽 `emitToolResult`
      //    (`path:'acp'`)에 넣었는데, ***라이브에서 그 관측이 한 줄도 안 떴다*** —
      //    실제로 도는 발신자는 «여기»(`pushToolResult` · `path:'acp-push-tool-result'`)였다.
      //    ⇒ 📌 시험만 믿었으면 **배선 없는 코드를 착지시킬 뻔했다.** 라이브가 잡았다.
      const toolCallArgs = new Map<string, unknown>();
      const pushToolCall: AcpTurnContext['pushToolCall'] = async (call) => {
        toolCallArgs.set(call.id, call.args);
        // ⭐ 자연어 → 툴선택의 유일한 관측점. 이게 없으면 "TUI NL 이 SelfImplement 를 소환했나,
        //   아니면 deferred 라 없는 툴로 보고 Bash/PtyShell 로 셸아웃했나"를 가릴 수 없다
        //   (실측된 실패 모드 · `agent/self-ambient.ts` 의 툴 소환 안내가 겨누는 바로 그것).
        turnToolCount += 1;
        if (turnTools.length < 200) turnTools.push(call.name);
        // ⭐ 인자 프리뷰까지 남긴다 — 툴 **이름만**으로는 "SelfImplement 를 불렀다"까지만 알고
        //   *"무엇을 시켰나"* 를 모른다. 골 텍스트가 원문 그대로 갔는지(재해석 drift) 여부가
        //   이 라인의 핵심 관심사라 값이 필요하다. 길이 상한으로 폭주는 막는다.
        debug.log('acp.tool', 'call', {
          sessionId: req.sessionId, tool: call.name, id: call.id,
          args: summarizeToolArgs(call.args),
        });
        try { c5dProducer?.tool(call.id, call.name, 'call'); } catch { /* fail-soft */ }
        await broadcast(req.sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: call.id,
          title: call.name,
          rawInput: call.args,
          status: 'pending',
        });
      };
      const pushToolResult: AcpTurnContext['pushToolResult'] = async (call) => {
        // ⭐ 결과도 남긴다 — 호출만 보이면 "nest-cap 으로 거부됐다"·"툴이 error 를 돌려줬다" 같은
        //   **거부/실패가 성공처럼 보인다**(SelfImplement 는 throw 대신 {error} 를 돌려주는 경로가 있다).
        debug.log('acp.tool', 'result', {
          sessionId: req.sessionId, tool: call.name, id: call.id,
          ...describeToolResult(call.result),
        });
        // ⛔⭐⭐⭐ **`call.result` 를 «반드시» 넘긴다.**
        //
        //  📏 2026-08-21 실측: 이 줄이 결과를 «빼고» 불러서, sink 이 `rawOutput` 을 실을 준비가
        //    돼 있는데도(`acp-stream-sink.ts`) 값이 영영 안 실렸다. 그래서 위젯 주소
        //    (`_meta.ui.resourceUri`)가 PWA 에 못 닿았고, 앞의 여덟 조각이 전부 통과하는데도
        //    화면엔 위젯이 «안 떴다».
        //  ⛔ 능력을 만든 PR(#10683)이 이 «호출자»를 안 고쳤다 — 이 저장소의 상시 결함 모양이다:
        //    ***받을 자리는 생겼는데 주는 자리가 안 바뀐다.***
        //  ⭐ 상한·누락 사유는 `projectPwaToolResult` 가 판정한다(규약을 두 벌로 두지 않는다).
        try {
          const projected = projectPwaToolResult({
            id: call.id, name: call.name, ok: true,
            ...(call.result !== undefined ? { result: call.result } : {}),
          });
          c5dProducer?.tool(call.id, call.name, 'result', true, projected.result);
        } catch { /* fail-soft */ }
        // ⛔⭐ 살아 있는 경로가 «여기»로 확인됐다(2026-08-21):
        //   core-turn-bridge:259 → turnCtx.pushToolResult → 이 함수.
        //   ⇒ 위젯 주소가 `call.result` 에 «있느냐»가 마지막 미지수다.
        {
          const r = call.result as unknown;
          const meta = r && typeof r === 'object' && !Array.isArray(r)
            ? (r as Record<string, unknown>)._meta : undefined;
          const ui = meta && typeof meta === 'object' && !Array.isArray(meta)
            ? (meta as Record<string, unknown>).ui : undefined;
          const uri = ui && typeof ui === 'object' && !Array.isArray(ui)
            ? (ui as Record<string, unknown>).resourceUri : undefined;
          debug.log('mcp.widget', 'tool-result-projected', {
            path: 'acp-push-tool-result',
            tool: call.name,
            resultType: r === undefined ? 'undefined' : Array.isArray(r) ? 'array' : typeof r,
            resultKeys: r && typeof r === 'object' && !Array.isArray(r)
              ? Object.keys(r as Record<string, unknown>).slice(0, 8) : [],
            hasMeta: meta !== undefined,
            resourceUri: typeof uri === 'string' ? uri : null,
          });
        }
        // ⛔⭐⭐ **감사 추적을 «세션에» 남긴다** — 위 `toolCallArgs` 주석이 이유다.
        //   ⭐ 로직은 `tool-trace.ts` 가 갖는다(주입 가능) — 무인 리뷰 must-fix:
        //     여기 인라인으로 두면 시험이 «소스 문자열»밖에 못 물고, 그것은 런타임에 죽어도 초록이다.
        persistAcpToolTrace(req.sessionId, call, toolCallArgs.get(call.id));
        // ⛔ 끝난 호출의 인자를 붙잡아 두지 않는다 — 긴 턴에서 이 맵만 자란다(리뷰 should-fix).
        toolCallArgs.delete(call.id);
        await broadcast(req.sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: call.id,
          title: call.name,
          status: 'completed',
          rawOutput: call.result as never,
        });
      };
      const pushSessionUpdate: AcpTurnContext['pushSessionUpdate'] = async (
        update,
        _meta,
      ) => {
        const out: Record<string, unknown> = { ...update };
        if (_meta) out._meta = _meta;
        await broadcast(
          req.sessionId,
          out as Parameters<typeof broadcast>[1],
        );
      };
      const requestApproval: AcpTurnContext['requestApproval'] = async (approvalReq) => {
        const timeoutMs = approvalReq.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
        const optionBase = `${approvalReq.toolCallId}-`;
        const options = [
          { optionId: `${optionBase}allow-once`, name: 'Allow once', kind: 'allow_once' as const },
          { optionId: `${optionBase}allow-always`, name: 'Allow always', kind: 'allow_always' as const },
          { optionId: `${optionBase}reject-once`, name: 'Reject', kind: 'reject_once' as const },
        ];
        const permissionPromise = connection.requestPermission({
          sessionId: req.sessionId,
          toolCall: {
            toolCallId: approvalReq.toolCallId,
            title: approvalReq.toolName,
            ...(approvalReq.toolArgs !== undefined ? { rawInput: approvalReq.toolArgs } : {}),
          },
          options,
        });
        let timer: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
          (timer as unknown as { unref?: () => void }).unref?.();
        });
        try {
          const result = await Promise.race([
            permissionPromise.then((resp) => resp),
            timeoutPromise,
          ]);
          if (result === 'timeout') return 'timeout';
          const outcome = result.outcome;
          if (outcome.outcome === 'cancelled') return 'cancelled';
          const selected = options.find((o) => o.optionId === outcome.optionId);
          switch (selected?.kind) {
            case 'allow_once': return 'allow-once';
            case 'allow_always': return 'allow-always';
            case 'reject_once': return 'deny-once';
            default: return 'cancelled';
          }
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const pushUsage: AcpTurnContext['pushUsage'] = async (usage) => {
        const payload: ElanousUiUsagePayload = {
          id: `turn:${Date.now()}`,
          ...(usage.provider !== undefined ? { provider: usage.provider } : {}),
          ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
          ...(usage.cacheReadInputTokens !== undefined
            ? { cacheReadInputTokens: usage.cacheReadInputTokens }
            : {}),
          ...(usage.cacheCreationInputTokens !== undefined
            ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
            : {}),
        };
        const text = formatElanousUiEnvelope({ method: 'usage', payload });
        // BACKLOG #2.5 — broadcast with per-peer caps gate so peers
        // that didn't advertise `elanous.ui.usage` simply get skipped.
        // Replaces the single-conn `if (!clientUiCaps.usage) return`.
        await broadcast(
          req.sessionId,
          {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text },
          },
          { uiGate: 'usage' },
        );
      };

      // U20 (§7.4 follow-up cascade · 2026-05-18) — daemon-side LLM
      // context capture. iOS popup chat (chatAutoCaptureOnSend ON) 가
      // `_meta.elanous.terminalContext: { terminalId, mode, region? }`
      // 를 보내면 daemon 이 그 PTY 의 context 를 자체 inject.
      // round-trip 절약 + PNG 가 client ↔ daemon 안 흐름 (bandwidth).
      // 기존 user-facing capture path (terminal/screenshot ACP method ·
      // 1523 line) 는 그대로 — user 가 PNG 결과를 직접 받는 용도라 separate.
      //
      // U22·a (2026-05-18) — mode 분기 wire:
      //   'image' — xterm.js render → PNG (full fidelity · vision 필요)
      //   'text'  — translateToString → plain text wrapper (token ↓)
      //   'auto'  — alt-screen 휴리스틱: TUI 면 image, 아니면 text
      //             (사용자 insight · 토큰 절약 priority).
      // iOS 측 default 는 현재 'image' hardcoded (회귀 0) · U22·b 에서
      // 'auto' 으로 swap 예정.
      const elanousMeta = (((req as PromptRequest & { _meta?: Record<string, unknown> })
        ._meta?.elanous) as Record<string, unknown> | undefined);
      const termCtx = (elanousMeta?.terminalContext as {
        terminalId?: unknown;
        mode?: unknown;
        region?: { rowStart?: unknown; rowEnd?: unknown };
        llmHint?: { brand?: unknown; model?: unknown };
        selection?: unknown;
      } | undefined);
      let promptBlocks: ContentBlock[] = req.prompt as ContentBlock[];
      if (termCtx && typeof termCtx.terminalId === 'string' && termCtx.terminalId.length > 0) {
        // U21·b (2026-05-18) — selection 우선 short-circuit. 사용자가
        // SwiftTerm native selection 으로 명시 선택한 영역이 있으면 그대로
        // text envelope inject (mode/region/llmHint 모두 무시). 가장
        // narrow 한 user intent → 토큰 최저 + LLM 시선 가장 정확.
        const selectionText = (typeof termCtx.selection === 'string' && termCtx.selection.length > 0)
          ? termCtx.selection
          : undefined;
        if (selectionText) {
          const wrapper = [
            `<terminal_context terminalId="${termCtx.terminalId}" selection="user-picked">`,
            selectionText,
            '</terminal_context>',
          ].join('\n');
          promptBlocks = [
            ...promptBlocks,
            { type: 'text', text: wrapper } as unknown as ContentBlock,
          ];
          if (debug.enabled) {
            debug.log('acp.term-context-inject', 'selection', {
              sessionId: req.sessionId,
              terminalId: termCtx.terminalId,
              selectionBytes: selectionText.length,
              selectionLines: selectionText.split('\n').length,
            });
          }
        } else { try {
          const { dispatchTerminalContext } = await import('../tool-runtime/web-terminal-screenshot.js');
          const requestedMode = (termCtx.mode === 'image' || termCtx.mode === 'text' || termCtx.mode === 'auto')
            ? termCtx.mode
            : 'auto';
          const region = (termCtx.region
              && typeof termCtx.region.rowStart === 'number'
              && typeof termCtx.region.rowEnd === 'number')
            ? { rowStart: termCtx.region.rowStart, rowEnd: termCtx.region.rowEnd }
            : undefined;
          // U22·c (2026-05-18) — caller-side LLM hint pass-through.
          // iOS popupChatBackend 의 brand 가 nil 이면 (elanousBuiltin) hint
          // 자체 미생성 → daemon 이 alt-screen 휴리스틱만으로 mode 결정.
          const llmHint = (termCtx.llmHint
              && typeof termCtx.llmHint.brand === 'string'
              && termCtx.llmHint.brand.length > 0)
            ? {
                brand: termCtx.llmHint.brand as
                  'anthropic' | 'openai' | 'openai-codex' | 'grok' | 'gemini' | 'local' | 'openrouter',
                model: typeof termCtx.llmHint.model === 'string' && termCtx.llmHint.model.length > 0
                  ? termCtx.llmHint.model
                  : undefined,
              }
            : undefined;
          const ctx = await dispatchTerminalContext({
            sessionId: req.sessionId,
            terminalId: termCtx.terminalId,
            mode: requestedMode,
            region,
            scale: 2,
            llmHint,
          });
          if (ctx.kind === 'image') {
            promptBlocks = [
              ...promptBlocks,
              {
                type: 'image',
                data: ctx.dataB64,
                mimeType: ctx.mediaType,
              } as unknown as ContentBlock,
            ];
          } else {
            // text — XML-style wrapper 로 envelope 명시 (LLM 이 terminal
            // 출력임을 파악하기 쉬움 + region/cols/rows metadata 제공).
            const wrapper = [
              `<terminal_context terminalId="${termCtx.terminalId}" cols="${ctx.cols}" rows="${ctx.rows}"${ctx.alternateScreen ? ' altScreen="true"' : ''}>`,
              ctx.text,
              '</terminal_context>',
            ].join('\n');
            promptBlocks = [
              ...promptBlocks,
              {
                type: 'text',
                text: wrapper,
              } as unknown as ContentBlock,
            ];
          }
          if (debug.enabled) {
            debug.log('acp.term-context-inject', 'ok', {
              sessionId: req.sessionId,
              terminalId: termCtx.terminalId,
              requestedMode,
              chosenKind: ctx.kind,
              autoDecided: ctx.autoDecided,
              altScreen: ctx.alternateScreen,
              region,
              llmHint,
              ...(ctx.kind === 'image' ? { b64Len: ctx.dataB64.length } : { textBytes: ctx.text.length }),
            });
          }
          } catch (e) {
            // Capture 실패 시 원래 prompt 로 진행 (regression 회피).
            if (debug.enabled) {
              debug.log('acp.term-context-inject', 'fail', {
                sessionId: req.sessionId,
                terminalId: termCtx.terminalId,
                error: String(e instanceof Error ? e.message : e),
              }, { level: 'error' });
            }
          }
        }
      }

      const turnCtx: AcpTurnContext = {
        sessionId: req.sessionId,
        cwd: s.cwd,
        codexArgs: s.codexArgs,
        userText,
        promptBlocks,
        promptMeta: (req as PromptRequest & { _meta?: Record<string, unknown> })._meta,
        isAborted: () => s.aborted,
        push,
        pushWithMeta,
        pushToolCall,
        pushToolResult,
        pushSessionUpdate,
        pushUsage,
        requestApproval,
      };

      // RC — intercept hook runs first. Lets the host treat the
      // prompt as a relayed notification (see parseRelayNotify) and
      // short-circuit the echo / runTurn path with stopReason
      // 'end_turn' by returning 'consume'.
      if (opts.onPromptReceived) {
        try {
          const result = await opts.onPromptReceived(turnCtx);
          if (result === 'consume') {
            return { stopReason: s.aborted ? 'cancelled' : 'end_turn' };
          }
        } catch { /* host error must not abort session */ }
      }

      // cascade-zyu W8-A 옵션 B (2026-05-14) — turn lifecycle → mission.update.
      // iOS-side MissionEnvelopeRouter (Phase 3) 가 envelope 흡수 → Dynamic
      // Island Live Activity 활성. emit 실패는 telemetric only · turn 영향 0.
      const missionEmitter = createMissionTurnEmitter({
        sessionId: req.sessionId,
        userText,
        broadcast: async (sid, update) => { await broadcast(sid, update); },
      });
      await missionEmitter.start();

      try {
        if (opts.runCodexTurn || s.codexArgs.length > 0) {
          await (opts.runCodexTurn ?? runAcpTurn)({
            backendId: 'codex-app-server',
            promptText: userText,
            chatId: req.sessionId,
            cwd: s.cwd,
            codexArgs: s.codexArgs,
            streamer: { edit: (text) => { void push(text); } },
          });
        } else if (opts.runTurn) {
          await opts.runTurn(turnCtx);
        } else {
          // Echo stub — demonstrates round-trip. Real engine lands in MT5b.
          if (!s.aborted) {
            await push(`elanous-acp echo: ${userText}`);
          }
        }
        // FU-2 webterm wire — flush any buffered partial sentence before
        // turn-end so the last fragment reaches TTS provider. Mirror of
        // chat REST `handlePromptStreamPost` flush at turn-end.
        if (opts.pwaTtsBridge) {
          try { await opts.pwaTtsBridge.flush(req.sessionId); }
          catch { /* swallow — telemetric */ }
        }
        await missionEmitter.end(s.aborted ? 'error' : 'done');
        // C5d — ACP 청크 producer 턴 마감(라이브핸들 finalize·청크 parity 기록). fail-soft.
        if (c5dProducer) { try { await c5dProducer.final(aggregatorAgentText); } catch { /* fail-soft */ } }
        // W8-A 후속 #1 — NEXUS-wide conversation aggregator push (elanous-
        // builtin path). agent-cli 의 turn-end 와 같은 store · 같은 chatId
        // (= req.sessionId). agent-cli `historyMode='rebuild'` 호출 시 본
        // elanous-builtin turn 도 prefix 에 포함 → 진정한 양방향. error
        // status / aborted 시 push skip (partial agent text 가치 낮음).
        if (!s.aborted) {
          try {
            persistCompletedTuiAcpTurn(req.sessionId, turnCtx.promptMeta, userText, aggregatorAgentText);
          } catch (err) {
            debug.log('acp.session', 'tui-persist-failed', {
              sessionId: req.sessionId,
              error: redactSecretText(err instanceof Error ? err.message : String(err)),
            }, { level: 'error' });
          }
        }
        if (opts.conversationAggregator && !s.aborted) {
          try {
            if (userText.length > 0) {
              opts.conversationAggregator.append(req.sessionId, {
                role: 'user',
                backendId: 'elanous-builtin',
                text: userText,
                at: turnStartedAt,
              });
            }
            if (aggregatorAgentText.length > 0) {
              opts.conversationAggregator.append(req.sessionId, {
                role: 'agent',
                backendId: 'elanous-builtin',
                text: aggregatorAgentText,
                at: Date.now(),
              });
            }
          } catch { /* telemetric */ }
        }
        debug.log('acp.session', 'prompt-end', {
          sessionId: req.sessionId,
          stopReason: s.aborted ? 'cancelled' : 'end_turn',
          durationMs: Date.now() - turnStartedAt,
          agentChars: aggregatorAgentText.length,
          toolCalls: turnToolCount,
          tools: turnTools.slice(0, 40),
          performer: resolveAcpServerTurnPerformer(),
        });
        return { stopReason: s.aborted ? 'cancelled' : 'end_turn' };
      } catch (err) {
        // ⚠️ 실패도 반드시 남긴다 — 종전엔 던지고 끝이라 "무출력으로 죽은" 턴의 사유가
        //   호출측에도 로그에도 없었다(이 트랙을 시작하게 만든 증상 그 자체).
        debug.log('acp.session', 'prompt-failed', {
          sessionId: req.sessionId,
          durationMs: Date.now() - turnStartedAt,
          toolCalls: turnToolCount,
          tools: turnTools.slice(0, 40),
          // ⚠️ 예외 메시지에도 토큰·Authorization 이 실려 온다(리뷰 must-fix — 1차 반영에서
          //   이 자리만 누락됐다). 자유 문자열은 예외 없이 텍스트 축을 경유한다.
          error: redactSecretText(err instanceof Error ? err.message : String(err)),
        }, { level: 'error' });
        try { await missionEmitter.end('error'); } catch { /* telemetric */ }
        throw err;
      }
    },

    async cancel(req: CancelNotification): Promise<void> {
      const s = sessions.get(req.sessionId);
      if (s) s.aborted = true;
    },

    /** WT-A-1 — extension methods. Routes `terminal/spawn` ·
     *  `terminal/input` · `terminal/resize` to the registered
     *  PreviewTerminal. Unknown methods throw `methodNotFound` per ACP
     *  convention.
     *
     *  `terminal/spawn`  · params: { sessionId, terminalId?, cwd?, cols?, rows?, shell? }
     *      → attaches a live shell with the same ID across sessions, or
     *        spawns and registers a new PreviewTerminal · returns terminalId
     *  `terminal/input`  · params: { sessionId, terminalId, data }
     *      → forwards UTF-8 bytes to PreviewTerminal.write()
     *  `terminal/resize` · params: { sessionId, terminalId, cols, rows }
     *      → calls PreviewTerminal.resize(cols, rows) */
    async extMethod(method, params): Promise<Record<string, unknown>> {
      if (debug.enabled) {
        debug.log('webterm.acp', 'extMethod.in', {
          method,
          terminalId: (params as { terminalId?: unknown })?.terminalId,
        });
      }
      if (method === 'elanous/session/steer') {
        const p = params as { sessionId?: unknown; text?: unknown };
        const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
        const text = typeof p.text === 'string' ? p.text : '';
        if (!sessions.has(sessionId) || text.trim().length === 0) {
          debug.log('acp.steer', 'unknown-session', { sessionId });
          return { accepted: false };
        }
        enqueuePendingUserInput(sessionId, text);
        debug.log('acp.steer', 'accepted', { sessionId });
        return { accepted: true };
      }
      if (method === 'terminal/spawn') {
        const p = params as {
          sessionId?: unknown; terminalId?: unknown;
          cwd?: unknown; cols?: unknown; rows?: unknown; shell?: unknown;
          /** P4(2026-07-12) — 재attach 시 데몬측 현재 뷰포트 스냅샷(SGR 보존
           *  ANSI) 동봉 opt-in. 끊김-중 출력이 로컬 scrollback 에 없어도 현재
           *  화면 상태는 복원되게. 기존 클라이언트는 미전송 → 응답 무변화. */
          replay?: unknown;
        };
        if (typeof p.sessionId !== 'string') {
          throw new Error('terminal/spawn: sessionId required');
        }
        const tid = resolveAcpTerminalId(p.terminalId);
        const cwd = typeof p.cwd === 'string' && p.cwd.length > 0 ? p.cwd : process.cwd();
        const cols = typeof p.cols === 'number' && p.cols > 0 ? p.cols : 80;
        const rows = typeof p.rows === 'number' && p.rows > 0 ? p.rows : 24;

        const { lookupPreviewTerminal, findPreviewTerminalsById,
          registerPreviewTerminalForWebTap, unregisterPreviewTerminalForWebTap } =
          await import('../web-terminal/preview-tap-registry.js');

        // Preserve same-session idempotency; remove dead registrations before
        // adopting a live shell or creating a replacement.
        const sameSession = lookupPreviewTerminal(p.sessionId, tid);
        const matches = findPreviewTerminalsById(tid);
        for (const match of matches) {
          if (!match.pt.isAlive) unregisterPreviewTerminalForWebTap(match.pt);
        }
        const adopted = matches.find((match) => match.pt.isAlive);
        const existing = sameSession?.isAlive ? sameSession : adopted?.pt;
        if (existing) {
          if (existing !== sameSession && adopted) {
            registerPreviewTerminalForWebTap(existing, p.sessionId, tid, handle);
            debug.log('webterm.acp', 'spawn.adopt', {
              terminalId: tid, fromSessions: adopted.sessionIds, toSession: p.sessionId,
            });
          }
          // P4 — replay opt-in: xterm-headless 가 상주 보유한 현재 화면을
          // render()(뷰포트·SGR 보존)로 동봉. 스냅샷 실패는 attach 를 막지
          // 않는다(fail-soft).
          let snapshot: string | undefined;
          if (p.replay === true) {
            try { snapshot = existing.render(); } catch { /* fail-soft */ }
          }
          if (debug.enabled) {
            debug.log('webterm.acp', 'spawn.attach', {
              sessionId: p.sessionId, terminalId: tid,
              replay: p.replay === true, snapshotBytes: snapshot?.length ?? 0,
            });
          }
          return {
            sessionId: p.sessionId, terminalId: tid, status: 'attached',
            ...(snapshot !== undefined ? { snapshot } : {}),
          };
        }

        const { PreviewTerminal } = await import('../preview/terminal.js');
        const pt = new PreviewTerminal({
          cols, rows, cwd,
          // Web-terminal child shell renders inside the PWA's xterm.js,
          // which implements the xterm-256color terminfo. When the daemon
          // is launched inside tmux/ghostty/etc, the inherited TERM
          // (tmux-256color, xterm-ghostty, …) makes prompt plugins emit
          // escape sequences that xterm.js doesn't fully emulate — most
          // visibly, transient-prompt-style cursor-up + erase-line
          // redraws don't clear the previous line, so the command echoes
          // appear duplicated. Pinning TERM to xterm-256color matches
          // the actual rendering surface and makes the redraws idempotent.
          termName: 'xterm-256color',
          // ★ P0b-2 (실행 substrate 통합·기본 off) — 이 진짜 PWA/iOS 라이브 셸을 공유 registry 버스로
          //   흡수(정체성·크로스서피스 goto·3-스택 통합). 라이브 렌더(yazi/마우스/커서/alt-screen) 검증이
          //   기기 왕복을 요하므로 per-run env 로만 켠다(대표가 별도 부팅해 수습). 미설정=기존 dup-fd(무회귀).
          useRegistry: process.env.ELANOUS_PREVIEW_TERMINAL_REGISTRY === '1',
          ...(typeof p.shell === 'string' && p.shell.length > 0 ? { shell: p.shell } : {}),
          onExit: () => {
            void import('../web-terminal/preview-tap-registry.js')
              .then(({ unregisterPreviewTerminalForWebTap }) => unregisterPreviewTerminalForWebTap(pt))
              .catch(() => { /* best-effort */ });
          },
        });
        try {
          pt.start();
        } catch (e) {
          return { error: 'spawn_failed', reason: String(e) };
        }

        // Register the PTY for ACP fan-out so terminalOutput broadcasts
        // can reach this peer (and any other PWAs sharing the
        // sessionId).
        registerPreviewTerminalForWebTap(pt, p.sessionId, tid, handle);

        if (debug.enabled) debug.log('webterm.acp', 'spawn.ok', { sessionId: p.sessionId, terminalId: tid, cwd, cols, rows });
        return { sessionId: p.sessionId, terminalId: tid, status: 'spawned' };
      }
      if (method === 'terminal/input') {
        const p = params as {
          sessionId?: unknown; terminalId?: unknown; data?: unknown;
          /** WT-M-1 — opaque short tag the originating PWA generated.
           *  Forwarded to other peers in the `terminalInputActivity`
           *  broadcast so they can filter self-echo. Optional for
           *  legacy clients. */
          peerId?: unknown;
        };
        if (typeof p.sessionId !== 'string' || typeof p.terminalId !== 'string' || typeof p.data !== 'string') {
          throw new Error('terminal/input: sessionId, terminalId, data required');
        }
        const { lookupPreviewTerminal } = await import('../web-terminal/preview-tap-registry.js');
        const pt = lookupPreviewTerminal(p.sessionId, p.terminalId);
        if (!pt) {
          if (debug.enabled) debug.log('webterm.acp', 'input.miss', { sessionId: p.sessionId, terminalId: p.terminalId });
          return { delivered: false, reason: 'unknown_terminal' };
        }
        try { pt.write(p.data); } catch (e) {
          return { delivered: false, reason: String(e) };
        }
        // WT-M-1 — emit input activity ping so peers attached to the
        // same terminal show the "another device typed" indicator.
        // Fire-and-forget; failures don't affect input delivery.
        const peerId = typeof p.peerId === 'string' ? p.peerId : '';
        void handle.terminalInputActivity(p.sessionId, p.terminalId, peerId, p.data.length).catch(() => {
          /* swallow — activity ping is best-effort */
        });
        return { delivered: true, bytes: p.data.length };
      }
      if (method === 'terminal/resize') {
        const p = params as { sessionId?: unknown; terminalId?: unknown; cols?: unknown; rows?: unknown };
        if (typeof p.sessionId !== 'string' || typeof p.terminalId !== 'string'
          || typeof p.cols !== 'number' || typeof p.rows !== 'number') {
          throw new Error('terminal/resize: sessionId, terminalId, cols, rows required');
        }
        const { lookupPreviewTerminal } = await import('../web-terminal/preview-tap-registry.js');
        const pt = lookupPreviewTerminal(p.sessionId, p.terminalId);
        if (!pt) {
          debug.log('webterm.acp', 'resize.miss', { sessionId: p.sessionId, terminalId: p.terminalId, cols: p.cols, rows: p.rows });
          return { delivered: false, reason: 'unknown_terminal' };
        }
        try { pt.resize(p.cols, p.rows); } catch (e) {
          debug.log('webterm.acp', 'resize.error', { terminalId: p.terminalId, reason: String(e) });
          return { delivered: false, reason: String(e) };
        }
        if (debug.enabled) debug.log('webterm.acp', 'resize.ok', { sessionId: p.sessionId, terminalId: p.terminalId, cols: p.cols, rows: p.rows });
        return { delivered: true, cols: p.cols, rows: p.rows };
      }
      if (method === 'terminal/list') {
        const p = params as { sessionId?: unknown };
        if (typeof p.sessionId !== 'string') {
          throw new Error('terminal/list: sessionId required');
        }
        const { listPreviewTerminals } = await import('../web-terminal/preview-tap-registry.js');
        const terminals = listPreviewTerminals(p.sessionId);
        if (debug.enabled) {
          debug.log('webterm.acp', 'list.ok', { sessionId: p.sessionId, count: terminals.length });
        }
        return { sessionId: p.sessionId, terminals };
      }
      if (method === 'terminal/screenshot') {
        // 2026-05-15 — iOS / PWA 가 daemon-side PreviewTerminal buffer 의
        // pixel-perfect PNG snapshot 을 base64 inline 으로 받음. PWA 의
        // `:capture` meta command 와 동일 source (dispatchWebTerminalScreenshot)
        // 사용 → OCR / ANSI-text 변환 없이 cell-by-cell SVG → sharp PNG.
        // iOS chat popup 의 Capture terminal attach path 가 본 method 호출.
        const p = params as { sessionId?: unknown; terminalId?: unknown; scale?: unknown };
        if (typeof p.sessionId !== 'string' || typeof p.terminalId !== 'string') {
          throw new Error('terminal/screenshot: sessionId, terminalId required');
        }
        const scale = typeof p.scale === 'number' ? p.scale : 2;
        const { dispatchWebTerminalScreenshot } = await import('../tool-runtime/web-terminal-screenshot.js');
        const shot = await dispatchWebTerminalScreenshot({
          sessionId: p.sessionId,
          terminalId: p.terminalId,
          scale,
        });
        if (debug.enabled) {
          debug.log('webterm.acp', 'screenshot.ok', {
            sessionId: p.sessionId,
            terminalId: p.terminalId,
            cols: shot.cols,
            rows: shot.rows,
            scale,
            b64Len: shot.dataB64.length,
          });
        }
        return {
          sessionId: shot.sessionId,
          terminalId: shot.terminalId,
          mediaType: shot.mediaType,
          dataB64: shot.dataB64,
          cols: shot.cols,
          rows: shot.rows,
          width: shot.width,
          height: shot.height,
        };
      }
      if (method === 'terminal/destroy') {
        const p = params as { sessionId?: unknown; terminalId?: unknown };
        if (typeof p.sessionId !== 'string' || typeof p.terminalId !== 'string') {
          throw new Error('terminal/destroy: sessionId, terminalId required');
        }
        const { lookupPreviewTerminal, unregisterPreviewTerminalForWebTap } =
          await import('../web-terminal/preview-tap-registry.js');
        const pt = lookupPreviewTerminal(p.sessionId, p.terminalId);
        if (!pt) {
          if (debug.enabled) {
            debug.log('webterm.acp', 'destroy.miss', { sessionId: p.sessionId, terminalId: p.terminalId });
          }
          return { destroyed: false, reason: 'unknown_terminal' };
        }
        // WT-C-1 — abort any active recording for this terminal so the
        // recorder doesn't outlive the PTY (would orphan the entry +
        // never produce a usable .cast). Best-effort, ignore if none.
        try {
          const { abortWebTerminalRecording } = await import('../web-terminal/recording-registry.js');
          abortWebTerminalRecording(p.sessionId, p.terminalId);
        } catch { /* ignore */ }
        // Stop first so the PTY exits and emits its onExit (which would
        // unregister), then unregister explicitly to cover the race
        // where stop returns synchronously before the kernel delivers
        // SIGCHLD. unregisterPreviewTerminalForWebTap is idempotent.
        try { pt.stop(); } catch (e) {
          if (debug.enabled) {
            debug.log('webterm.acp', 'destroy.stop-error', {
              sessionId: p.sessionId, terminalId: p.terminalId, reason: String(e),
            }, { level: 'error' });
          }
        }
        unregisterPreviewTerminalForWebTap(pt);
        if (debug.enabled) {
          debug.log('webterm.acp', 'destroy.ok', { sessionId: p.sessionId, terminalId: p.terminalId });
        }
        return { destroyed: true, sessionId: p.sessionId, terminalId: p.terminalId };
      }
      if (method === 'terminal/record/start') {
        const p = params as { sessionId?: unknown; terminalId?: unknown };
        if (typeof p.sessionId !== 'string' || typeof p.terminalId !== 'string') {
          throw new Error('terminal/record/start: sessionId, terminalId required');
        }
        const { startWebTerminalRecording } = await import('../web-terminal/recording-registry.js');
        try {
          const r = startWebTerminalRecording(p.sessionId, p.terminalId);
          return { status: 'recording', started: true, ...r };
        } catch (e) {
          const reason = String(e instanceof Error ? e.message : e);
          if (debug.enabled) {
            debug.log('webterm.acp', 'record.start.error', {
              sessionId: p.sessionId, terminalId: p.terminalId, reason,
            }, { level: 'error' });
          }
          // Soft-fail (return rather than throw) so the PWA can branch
          // on `started === false` without exception-handling boilerplate
          // around every Record-button click.
          return { status: 'rejected', started: false, reason };
        }
      }
      if (method === 'terminal/record/stop') {
        const p = params as { sessionId?: unknown; terminalId?: unknown };
        if (typeof p.sessionId !== 'string' || typeof p.terminalId !== 'string') {
          throw new Error('terminal/record/stop: sessionId, terminalId required');
        }
        const { stopWebTerminalRecording } = await import('../web-terminal/recording-registry.js');
        try {
          const r = stopWebTerminalRecording(p.sessionId, p.terminalId);
          return {
            status: 'stopped',
            stopped: true,
            recorderId: r.recorderId,
            sessionId: r.sessionId,
            terminalId: r.terminalId,
            path: r.path,
            frameCount: r.frameCount,
            elapsedSec: r.elapsedSec,
            // The PWA shouldn't read absolute paths directly; this is
            // the relative URL it should hit (resolved under daemon
            // baseUrl). The download endpoint is `GET /v1/recordings/<id>.cast`
            // (added in this slice).
            downloadUrl: `/v1/recordings/${r.recorderId}.cast`,
          };
        } catch (e) {
          const reason = String(e instanceof Error ? e.message : e);
          if (debug.enabled) {
            debug.log('webterm.acp', 'record.stop.error', {
              sessionId: p.sessionId, terminalId: p.terminalId, reason,
            }, { level: 'error' });
          }
          return { status: 'rejected', stopped: false, reason };
        }
      }
      if (method === 'terminal/record/list') {
        const p = params as { sessionId?: unknown };
        if (typeof p.sessionId !== 'string') {
          throw new Error('terminal/record/list: sessionId required');
        }
        const { listWebTerminalRecordings } = await import('../web-terminal/recording-registry.js');
        const recordings = listWebTerminalRecordings(p.sessionId);
        return { sessionId: p.sessionId, recordings };
      }
      if (method === 'terminal/repl/exec') {
        // WT-A-3 — execute a sticky REPL meta command (`:provider`,
        // `:fork`, etc.) against the daemon-resident `dispatchMetaCommand`.
        // Echoes the result back as a `terminalOutput` chunk so xterm.js
        // shows it inline with shell output, OR returns the text in the
        // response when terminalId is omitted (caller renders elsewhere).
        const p = params as {
          sessionId?: unknown;
          terminalId?: unknown;
          line?: unknown;
          attachments?: unknown;
        };
        if (typeof p.sessionId !== 'string' || typeof p.line !== 'string') {
          throw new Error('terminal/repl/exec: sessionId, line required');
        }
        const requestedAttachmentCount = Array.isArray(p.attachments) ? p.attachments.length : 0;
        const normalizedAttachments: NormalizedAttachment[] = Array.isArray(p.attachments)
          ? p.attachments.flatMap((item) => {
              if (!item || typeof item !== 'object') return [];
              const rec = item as Record<string, unknown>;
              if (typeof rec.path !== 'string' || rec.path.length === 0) return [];
              const mediaType = typeof rec.mediaType === 'string' ? rec.mediaType : undefined;
              // `video/*` intentionally falls through to `document` so
              // buildAcpPrompt emits a resource_link instead of trying
              // to inline media bytes the ACP prompt path can't render.
              const kind: NormalizedAttachment['kind'] = mediaType?.startsWith('image/')
                ? 'photo'
                : (mediaType?.startsWith('audio/') ? 'audio' : 'document');
              return [{
                name: typeof rec.filename === 'string' && rec.filename.length > 0 ? rec.filename : rec.path.split('/').pop() ?? rec.path,
                localPath: rec.path,
                kind,
                ...(mediaType ? { mimeType: mediaType } : {}),
                ...(typeof rec.size === 'number' ? { sizeBytes: rec.size } : {}),
              }];
            })
          : [];
        if (debug.enabled && requestedAttachmentCount !== normalizedAttachments.length) {
          debug.log('webterm.acp', 'repl.attachments.dropped', {
            sessionId: p.sessionId,
            terminalId: p.terminalId,
            requestedCount: requestedAttachmentCount,
            acceptedCount: normalizedAttachments.length,
            droppedCount: requestedAttachmentCount - normalizedAttachments.length,
          });
        }
        const { dispatchMetaCommand } = await import('../repl/dispatch-meta.js');
        const { getUserConfig } = await import('../user-config.js');
        const cfg = getUserConfig();
        const tidStr = typeof p.terminalId === 'string' ? p.terminalId : undefined;
        const dispatchCtx: Parameters<typeof dispatchMetaCommand>[1] = {
          cfg,
          sessionId: p.sessionId,
          surface: 'web-term',
        };
        if (tidStr) dispatchCtx.terminalId = tidStr;
        let result = dispatchMetaCommand(p.line, dispatchCtx);

        // Heavy lifts the sync dispatcher couldn't do — :peers list +
        // :capture screenshot — happen here, then the result is patched
        // before echo + return.
        const verb = p.line.trim().slice(1).split(/\s+/)[0]?.toLowerCase();
        if (result.consumed && verb === 'peers') {
          const set = sessionPeers.get(p.sessionId);
          const count = set ? set.size : 0;
          // peer ids are opaque; surface a coarse summary that's still
          // useful (count + "this device") without leaking peer details.
          const lines = [
            `\x1b[2mpeers attached to session ${p.sessionId.slice(0, 8)}: ${count}\x1b[0m`,
            count > 1
              ? `\x1b[2m  ${count - 1} other device${count - 1 === 1 ? '' : 's'} sharing this session\x1b[0m`
              : `\x1b[2m  this device only\x1b[0m`,
          ];
          result = { ...result, output: lines.join('\r\n') + '\r\n' };
        }
        // WT-A-3b — `:agent <prompt>` heavy lift. Dispatcher returned
        // a placeholder; we now run the LLM turn through the daemon's
        // history + tool surface (closure-bound by the boot path) and
        // attach the result so the PWA can render it in the
        // AgentResponseSheet panel. Returns early-ish so the result is
        // available below the screenshot/peers branches but before the
        // generic echo + return.
        let agentResult: {
          sessionId: string;
          markdown: string;
          modelLabel: string;
          stopReason: string;
          contextLines: number;
        } | null = null;
        if (result.consumed && verb === 'agent' && result.agentRequest && tidStr) {
          if (!opts.runAgentTurn) {
            result = {
              ...result,
              output: `\x1b[31m:agent — daemon not wired with runAgentTurn (start with \`--tools webterm\` and the standard daemon-public-server)\x1b[0m\r\n`,
            };
          } else {
            try {
              // ACP streaming (PLAN v1.2 Phase B) — wire runDaemonPromptTurn's
              // streaming callbacks to ACP `session/update` broadcasts so every
              // peer registered on this sessionId (PWA dock + TUI + other PWA tabs)
              // receives partial chunks live. Cross-surface mirror is automatic via
              // `broadcast()` (line 568-593) — no per-peer routing logic needed.
              const sessionId = p.sessionId;
              const emitTextChunk = (delta: string): void => {
                void broadcast(sessionId, {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: delta },
                });
                // FU-2 webterm wire (PLAN v1.2 §15 · 2026-05-07) — webterm
                // `:agent` 발 turn 의 delta 도 server-side TTS bridge 로
                // pushes so /term dock 의 TTS 가 /chat 과 동일한 high-quality
                // path 사용. errors swallow (bridge 가 best-effort).
                if (opts.pwaTtsBridge) {
                  try { opts.pwaTtsBridge.pushChunk(sessionId, delta); }
                  catch { /* swallow — telemetric */ }
                }
              };
              const emitToolCall = (info: { id: string; name: string; args: Record<string, unknown> }): void => {
                void broadcast(sessionId, {
                  sessionUpdate: 'tool_call',
                  toolCallId: info.id,
                  rawInput: info.args,
                  title: info.name,
                  status: 'in_progress',
                });
              };
              // ⛔⭐⭐⭐ **이 자리가 PWA 채팅이 «실제로» 타는 툴-결과 발신자다.**
              //
              //  📏 2026-08-21 실측: `onToolResultMeta` 를 다는 자리가 «둘»이고
              //    (`nexus/api/meta-api.ts` REST 스트림 · 여기 ACP), PWA 채팅은 «이쪽»이다.
              //    그런데 초판은 인자 타입에 `result` 가 «아예 없어» 상태와 제목만 보냈다.
              //    ⇒ 위젯 주소(`_meta.ui.resourceUri`)가 «여기서» 전부 버려졌고,
              //      그 앞의 여덟 조각이 전부 통과하는데도 화면엔 위젯이 안 떴다.
              //  ⛔ 그래서 REST 쪽만 넓히면 안 된다 — 「경로가 둘」이다.
              //  ⭐ 실을 이름은 `rawOutput`(ACP 표준 칸) — 경로②(`acp-stream-sink`)와 같고
              //    PWA 파서가 이미 그 이름에서 `_meta.ui.resourceUri` 를 판다.
              //  ⊕ 상한·누락 사유는 `projectPwaToolResult` 를 «재사용»한다(규약을 두 벌로 두지 않는다).
              const emitToolResult = (info: ToolResultMeta): void => {
                const projected = projectPwaToolResult(info);
                // ⛔⭐ REST 쪽(`meta-api.ts` `mcp.widget/tool-result-projected`)과 «같은 이름·같은 칸»으로 남긴다.
                //   📏 2026-08-21: 두 경로 중 어느 쪽이 도는지 몰라 REST 에만 계측을 심었고
                //     「관측 0」을 「배선이 안 탄다」로 읽을 뻔했다. 두 발신자에 «같은» 관측이 있어야
                //     한 번의 조회로 「어느 길로 갔나 ⊕ 거기서 살아 있었나」가 같이 나온다.
                //   ⛔ `debug.enabled` 로 감싸지 않는다 — 그 플래그는 파일 로깅과 다른 축이다.
                {
                  const r = projected.result;
                  const meta = r && typeof r === 'object' && !Array.isArray(r)
                    ? (r as Record<string, unknown>)._meta : undefined;
                  const ui = meta && typeof meta === 'object' && !Array.isArray(meta)
                    ? (meta as Record<string, unknown>).ui : undefined;
                  const uri = ui && typeof ui === 'object' && !Array.isArray(ui)
                    ? (ui as Record<string, unknown>).resourceUri : undefined;
                  debug.log('mcp.widget', 'tool-result-projected', {
                    path: 'acp',
                    tool: info.name,
                    resultPresent: projected.result !== undefined,
                    omittedReason: projected.resultOmittedReason ?? null,
                    hasMeta: meta !== undefined,
                    resourceUri: typeof uri === 'string' ? uri : null,
                  });
                }
                void broadcast(sessionId, {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: info.id,
                  status: info.ok ? 'completed' : 'failed',
                  ...(info.summary ? { title: info.summary } : {}),
                  ...(projected.result !== undefined ? { rawOutput: projected.result } : {}),
                  ...(projected.resultOmittedReason !== undefined
                    ? { resultOmittedReason: projected.resultOmittedReason }
                    : {}),
                });
              };
              const emitImageBlock = (info: { src: string; mediaType: string; alt?: string }): void => {
                void broadcast(sessionId, {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'image', data: info.src, mimeType: info.mediaType, ...(info.alt ? { uri: info.alt } : {}) },
                });
              };
              agentResult = await opts.runAgentTurn({
                sessionId,
                terminalId: tidStr,
                prompt: result.agentRequest.prompt,
                ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
                ...(result.agentRequest.scrollLines !== undefined
                  ? { scrollLines: result.agentRequest.scrollLines }
                  : {}),
                onTextDelta: emitTextChunk,
                onToolCall: emitToolCall,
                onToolResultMeta: emitToolResult,
                onImageBlock: emitImageBlock,
              });
              // FU-2 webterm wire — flush partial sentence buffer once
              // the `:agent` turn settles (mirrors chat REST `turn-end`
              // flush). bridge 가 best-effort 라 errors swallow.
              if (opts.pwaTtsBridge) {
                try { await opts.pwaTtsBridge.flush(sessionId); }
                catch { /* swallow — telemetric */ }
              }
              const head = `\x1b[2m:agent ${agentResult.modelLabel} — ${agentResult.markdown.length} chars · ${agentResult.contextLines} buffer lines (open response panel above)\x1b[0m\r\n`;
              result = { ...result, output: head };
            } catch (e) {
              result = {
                ...result,
                output: `\x1b[31m:agent error — ${String(e instanceof Error ? e.message : e)}\x1b[0m\r\n`,
              };
            }
          }
        }
        if (result.consumed && verb === 'capture' && tidStr) {
          try {
            const { dispatchWebTerminalScreenshot } = await import('../tool-runtime/web-terminal-screenshot.js');
            const shot = await dispatchWebTerminalScreenshot({
              sessionId: p.sessionId,
              terminalId: tidStr,
            });
            const { saveAttachmentBlob } = await import('../boot/attachment-store.js');
            const png = Buffer.from(shot.dataB64, 'base64');
            const blob = new Blob([new Uint8Array(png)], { type: 'image/png' });
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const saved = await saveAttachmentBlob({
              blob,
              filename: `webterm-${tidStr}-${ts}.png`,
            });
            if (saved.ok) {
              result = {
                ...result,
                output: `\x1b[2m📸 captured ${shot.cols}×${shot.rows} (${saved.entry.size} B) → ${saved.entry.path}\x1b[0m\r\n`,
                injectPath: saved.entry.path,
              };
            } else {
              result = { ...result, output: `\x1b[31m:capture failed — ${saved.reason}\x1b[0m\r\n` };
            }
          } catch (e) {
            result = { ...result, output: `\x1b[31m:capture error — ${String(e)}\x1b[0m\r\n` };
          }
        }

        // PP-9 (2026-05-07) — REPL meta-command output no longer echoes
        // back into the xterm PTY. User feedback: "REPL 활동 로그가
        // 터미널로 나타나는 것 원치 않음 — chat UI 또는 별도 디버그로".
        // Result text is now classified into `replSystem` (level + plain
        // text) and returned in the response payload; the client mirrors
        // it into the TerminalChatDock as a `system` message rendered
        // with a red badge (error) or dim italic (note). The agent
        // success path returns no replSystem because the rendered
        // markdown is already mirrored as `agentResult`.
        if (debug.enabled) {
          debug.log('webterm.acp', 'repl.exec', {
            sessionId: p.sessionId,
            terminalId: p.terminalId,
            consumed: result.consumed,
            outputLen: result.output.length,
            cfgUpdated: !!result.cfgUpdate,
            sessionIdChange: result.sessionIdChange ?? null,
            tabIntent: result.tabIntent ?? null,
            injectPath: result.injectPath ?? null,
          });
        }
        const replSystem = classifyReplSystemOutput(result.output, agentResult !== null);
        return {
          consumed: result.consumed,
          output: result.output,
          ...(replSystem ? { replSystem } : {}),
          ...(result.exitRequested ? { exitRequested: true } : {}),
          ...(result.sessionIdChange ? { sessionIdChange: result.sessionIdChange } : {}),
          ...(result.tabIntent !== undefined ? { tabIntent: result.tabIntent } : {}),
          ...(result.injectPath ? { injectPath: result.injectPath } : {}),
          ...(agentResult
            ? {
                agent: {
                  markdown: agentResult.markdown,
                  modelLabel: agentResult.modelLabel,
                  stopReason: agentResult.stopReason,
                  contextLines: agentResult.contextLines,
                },
              }
            : {}),
          ...(result.agentChatModeEnter ? { agentChatModeEnter: true } : {}),
        };
      }
      if (method === 'terminal/repl/agent/abort') {
        // WT-A-3b Phase 4 — abort the in-flight `:agent` turn for
        // (sessionId, terminalId). Returns `{ aborted }` so the PWA
        // can decide whether to surface a "no active turn" toast (the
        // race window is small but visible — Esc landing right after
        // the response arrived). When the daemon was booted without
        // `runAgentTurn` (no abortAgentTurn callback wired either),
        // we still answer with `aborted:false` so the client UX stays
        // consistent.
        const p = params as { sessionId?: unknown; terminalId?: unknown };
        if (typeof p.sessionId !== 'string' || typeof p.terminalId !== 'string') {
          throw new Error('terminal/repl/agent/abort: sessionId, terminalId required');
        }
        const aborted = opts.abortAgentTurn
          ? opts.abortAgentTurn({ sessionId: p.sessionId, terminalId: p.terminalId })
          : false;
        if (debug.enabled) {
          debug.log('webterm.acp', 'agent.abort', {
            sessionId: p.sessionId,
            terminalId: p.terminalId,
            aborted,
            wired: !!opts.abortAgentTurn,
          });
        }
        return { sessionId: p.sessionId, terminalId: p.terminalId, aborted };
      }
      if (method === 'terminal/camera/frame/notify') {
        // WT-N-5 P2 — PWA → daemon: announce that a freshly-uploaded
        // attachment is the latest live-camera frame for `sessionId`.
        // Stores into the live-camera-registry (in-memory Map) so the
        // LLM tool `LiveCameraFrame` can resolve "most recent" in O(1)
        // without scanning the attachments directory.
        const p = params as {
          sessionId?: unknown;
          terminalId?: unknown;
          attachmentId?: unknown;
          ts?: unknown;
        };
        if (typeof p.sessionId !== 'string' || typeof p.attachmentId !== 'string') {
          throw new Error('terminal/camera/frame/notify: sessionId, attachmentId required');
        }
        const input = {
          sessionId: p.sessionId,
          ...(typeof p.terminalId === 'string' ? { terminalId: p.terminalId } : {}),
          attachmentId: p.attachmentId,
          ...(typeof p.ts === 'number' ? { ts: p.ts } : {}),
        };
        const result = opts.recordLiveCameraFrame
          ? opts.recordLiveCameraFrame(input)
          : { frameIndex: 0 };
        if (debug.enabled) {
          debug.log('webterm.acp', 'live-cam.notify', {
            sessionId: p.sessionId,
            attachmentId: p.attachmentId,
            frameIndex: result.frameIndex,
            wired: !!opts.recordLiveCameraFrame,
          });
        }
        return {
          sessionId: p.sessionId,
          attachmentId: p.attachmentId,
          frameIndex: result.frameIndex,
        };
      }
      if (method === 'elanous/debug-logs/ingest') {
        // ⛔⭐⭐⭐⭐ **관측의 «대체 통로» — HTTP 가 굶어도 여기로 온다**(19차 `[F]` · 2026-08-22).
        //
        // 📏 실측: SSE 가 브라우저의 HTTP/1.1 커넥션 한도(6)를 먹으면
        //   `POST /v1/debug-logs/batch` 가 ***영영 큐에 서고 관측이 통째로 사라진다***
        //   (PWA 로그 8분간 0건 · 탭 리로드조차 불가).
        // 🔑 그런데 그때 ***채팅은 계속 돌았다*** — WebSocket 은 그 풀을 안 쓴다.
        //
        // ⭐ 이 저장소 제1원칙: ***판정 결과가 흐르는 채널은 그 판정의 대상이 쓸 수 없어야 한다.***
        //   포워더가 자기 고장을 「고장 난 그 통로」로 보고하면 영영 못 듣는다.
        //   ⇒ 그래서 «살아 있는» 채널을 하나 더 준다.
        // ⚠️ 이것은 «폴백»이다 — 정상 경로는 여전히 HTTP 다(배치 효율·백프레셔가 거기 있다).
        const p = params as { records?: unknown };
        if (!Array.isArray(p.records)) {
          throw new Error('elanous/debug-logs/ingest: records[] required');
        }
        const { ingestDebugLogRecords } = await import('../nexus/api/debug-logs.js');
        // ⛔ 적재는 REST 와 «같은 함수»를 쓴다 — 갈리면 한쪽만 redaction 을 타게 된다.
        const out = ingestDebugLogRecords(p.records);
        if (debug.enabled) {
          debug.log('webterm.acp', 'debug-logs.ingest', {
            accepted: out.accepted,
            rejected: out.rejected,
            // ⭐ 이 경로로 왔다는 것 «자체»가 신호다 — HTTP 가 막혔다는 뜻이다.
            via: 'acp-fallback',
          });
        }
        return { ok: true, accepted: out.accepted, rejected: out.rejected };
      }
      if (method === 'elanous/fs/list') {
        // Phase 2·A (RESEARCH-ios-companion-tui-parity §1.1·A · 2026-05-17) +
        // PLAN-ipad-server-side-file-browser §4.1 (F1·1, F1·6 · 2026-05-16) —
        // working directory entries for the `@` picker AND the iPad server-
        // side file browser on iOS/PWA chat surfaces. Two roots: 'cwd' (daemon
        // process.cwd, the default for back-compat) and 'obsidian' (vault
        // resolved through fs-roots resolveObsidianRoot fallback chain).
        // Every path is clamped under its root — `..` cannot escape. Caps at
        // 200 entries to bound payload.
        const p = params as {
          sessionId?: unknown; cwd?: unknown; query?: unknown; limit?: unknown; root?: unknown;
        };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/fs/list: sessionId required');
        }
        const fs = await import('node:fs/promises');
        const root: FsRootKind = p.root === 'obsidian' ? 'obsidian' : 'cwd';
        let baseRoot: string;
        try {
          baseRoot = resolveFsRoot(root);
        } catch (e) {
          // obsidian-vault-unavailable — surface to caller without throwing
          // through the JSON-RPC channel (iPad treats `error` as a soft fail
          // and hides the chip).
          return { cwd: '', entries: [], root, error: String(e instanceof Error ? e.message : e) };
        }
        const rawCwd = typeof p.cwd === 'string' && p.cwd.length > 0 ? p.cwd : baseRoot;
        const cwd = clampToRoot(baseRoot, rawCwd);
        if (cwd == null) {
          return { cwd: baseRoot, entries: [], root, error: 'cwd-escapes-root' };
        }
        const query = typeof p.query === 'string' ? p.query.toLowerCase() : '';
        const cap = typeof p.limit === 'number' && p.limit > 0 && p.limit <= 500 ? p.limit : 200;
        try {
          const dirents = await fs.readdir(cwd, { withFileTypes: true });
          let mapped = dirents
            .filter((e) => !isHiddenForBrowser(e.name))
            .map((e) => ({
              name: e.name,
              isDir: e.isDirectory(),
              relPath: e.name,
            }));
          if (query.length > 0) {
            mapped = mapped.filter((e) => e.name.toLowerCase().includes(query));
          }
          mapped.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          if (mapped.length > cap) mapped = mapped.slice(0, cap);
          return { cwd, root, entries: mapped };
        } catch (e) {
          return { cwd, root, entries: [], error: String(e instanceof Error ? e.message : e) };
        }
      }
      if (method === 'elanous/fs/read') {
        // PLAN-ipad-server-side-file-browser §4.2 (F1·2 · 2026-05-16) —
        // single-file read for the iPad preview pane. detectMime branches the
        // payload between text (`content` utf8) and binary (`bytes` base64).
        // 256KB default cap — larger files are truncated and flagged so the
        // preview can render a "first 256KB shown" banner without choking the
        // ACP wire. Path is resolved under the chosen root and clamped.
        const p = params as {
          sessionId?: unknown; path?: unknown; root?: unknown; maxBytes?: unknown;
        };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/fs/read: sessionId required');
        }
        if (typeof p.path !== 'string' || p.path.length === 0) {
          throw new Error('elanous/fs/read: path required');
        }
        const fs = await import('node:fs/promises');
        const root: FsRootKind = p.root === 'obsidian' ? 'obsidian' : 'cwd';
        let baseRoot: string;
        try {
          baseRoot = resolveFsRoot(root);
        } catch (e) {
          return { path: p.path, root, error: String(e instanceof Error ? e.message : e) };
        }
        const resolved = clampToRoot(baseRoot, p.path);
        if (resolved == null) {
          return { path: p.path, root, error: 'path-escapes-root' };
        }
        const maxBytes = typeof p.maxBytes === 'number' && p.maxBytes > 0 && p.maxBytes <= 8 * 1024 * 1024
          ? Math.floor(p.maxBytes)
          : 256 * 1024;
        try {
          const stat = await fs.stat(resolved);
          if (stat.isDirectory()) {
            return { path: resolved, root, error: 'path-is-directory' };
          }
          const mime = detectMime(resolved);
          const truncated = stat.size > maxBytes;
          // Read at most maxBytes — open + partial read keeps RAM bounded
          // when the file is huge.
          const handle = await fs.open(resolved, 'r');
          try {
            const readLen = Math.min(stat.size, maxBytes);
            const buf = Buffer.allocUnsafe(readLen);
            await handle.read(buf, 0, readLen, 0);
            if (isTextMime(mime)) {
              return {
                path: resolved, root, mime,
                content: buf.toString('utf8'),
                size: stat.size,
                truncated: truncated || undefined,
              };
            }
            return {
              path: resolved, root, mime,
              bytes: buf.toString('base64'),
              size: stat.size,
              truncated: truncated || undefined,
            };
          } finally {
            await handle.close();
          }
        } catch (e) {
          return { path: resolved, root, error: String(e instanceof Error ? e.message : e) };
        }
      }
      if (method === 'elanous/fs/stat') {
        // PLAN-ipad-server-side-file-browser §4 (F1·3 · 2026-05-16) —
        // pre-flight check used by the iPad preview before issuing fs/read.
        // Returns mime + size + mtime so the UI can decide whether to skip the
        // read (huge binary), show a confirmation, or render directly.
        const p = params as { sessionId?: unknown; path?: unknown; root?: unknown };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/fs/stat: sessionId required');
        }
        if (typeof p.path !== 'string' || p.path.length === 0) {
          throw new Error('elanous/fs/stat: path required');
        }
        const fs = await import('node:fs/promises');
        const root: FsRootKind = p.root === 'obsidian' ? 'obsidian' : 'cwd';
        let baseRoot: string;
        try {
          baseRoot = resolveFsRoot(root);
        } catch (e) {
          return { path: p.path, root, error: String(e instanceof Error ? e.message : e) };
        }
        const resolved = clampToRoot(baseRoot, p.path);
        if (resolved == null) {
          return { path: p.path, root, error: 'path-escapes-root' };
        }
        try {
          const stat = await fs.stat(resolved);
          return {
            path: resolved,
            root,
            mime: stat.isDirectory() ? 'inode/directory' : detectMime(resolved),
            size: stat.size,
            mtime: stat.mtimeMs,
            isDir: stat.isDirectory(),
          };
        } catch (e) {
          return { path: resolved, root, error: String(e instanceof Error ? e.message : e) };
        }
      }
      if (method === 'elanous/obsidian/info') {
        // PLAN-ipad-server-side-file-browser §4 (F1·4 · 2026-05-16) — vault
        // discovery for the iPad root chip. Reports the resolution `source`
        // alongside `available` so the UI can hint where the path came from
        // (config / env / backup / default / discovery / none) — useful when a
        // post-wipe restoration silently swapped the active vault.
        const p = params as { sessionId?: unknown };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/obsidian/info: sessionId required');
        }
        const r = resolveObsidianRoot();
        if (r.available) {
          return { available: true, root: r.root, source: r.source };
        }
        return { available: false, source: r.source };
      }
      if (method === 'elanous/obsidian/search') {
        // PLAN-ipad-server-side-file-browser §6 F5·1 (FU·5a · 2026-05-16) —
        // ripgrep-backed full-text search over the Obsidian vault. iPad
        // browser surfaces a search bar that fans out matches with file
        // path + line number + snippet. Caller-side limit caps the rg
        // run; rg exit code 1 (no matches) returns an empty list rather
        // than an error.
        const p = params as {
          sessionId?: unknown; query?: unknown; limit?: unknown;
        };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/obsidian/search: sessionId required');
        }
        const queryRaw = typeof p.query === 'string' ? p.query.trim() : '';
        if (queryRaw.length === 0) {
          return { matches: [], error: 'query-required' };
        }
        const limit = typeof p.limit === 'number' && p.limit > 0 && p.limit <= 200
          ? Math.floor(p.limit)
          : 50;
        const obsidian = resolveObsidianRoot();
        if (!obsidian.available) {
          return { matches: [], error: 'obsidian-vault-unavailable' };
        }
        // 공유 ripgrep-core(rg --json) — obsidian·vault 와 동일 프리미티브(복붙 3벌 수렴).
        const res = await rgJsonMatchesAsync(queryRaw, {
          roots: [obsidian.root], ignoreCase: true, lineNumber: true, perFileMaxCount: 3,
          typeAdd: ['md:*.md'], types: ['md'], relTo: obsidian.root, snippetMax: 240, limit,
        });
        if (!res.ok) return { matches: [], error: `rg-exit-${res.code}: ${res.stderr.slice(0, 200)}` };
        return { matches: res.matches.map((m) => ({ path: m.path, snippet: m.text, lineNumber: m.line })) };
      }
      if (method === 'elanous/obsidian/backlinks') {
        // PLAN-ipad-notes-obsidian-typora §5 Phase O3·1 (2026-05-17) —
        // vault reverse index. Given a target note basename (without
        // `.md`), returns every other `.md` file that wikilinks it
        // (plain, aliased, heading-anchored, or path-prefixed). Self-
        // references in the target file itself are filtered out so a
        // rename refactor surfaces only true dangling pointers.
        const p = params as { sessionId?: unknown; target?: unknown; limit?: unknown };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/obsidian/backlinks: sessionId required');
        }
        const target = typeof p.target === 'string' ? p.target.trim() : '';
        if (target.length === 0) {
          return { matches: [], error: 'target-required' };
        }
        const limit = typeof p.limit === 'number' && p.limit > 0 && p.limit <= 500
          ? Math.floor(p.limit)
          : 100;
        const obsidian = resolveObsidianRoot();
        if (!obsidian.available) {
          return { matches: [], error: 'obsidian-vault-unavailable' };
        }
        const { findBacklinks } = await import('./obsidian-backlinks.js');
        const result = await findBacklinks({ vaultRoot: obsidian.root, target, limit });
        return { ...result };
      }
      if (method === 'elanous/obsidian/templates') {
        // PLAN-ipad-notes-obsidian-typora §5 Phase O3·3 (2026-05-17) —
        // `<vault>/Templates/*.md` enumeration. Read-only: caller reads
        // the chosen template via `elanous/fs/read` then writes a new
        // note via `notes-save`. Empty `templates` array means no
        // Templates folder exists yet — iPad UI shows "Create a
        // Templates folder…" hint.
        const p = params as { sessionId?: unknown };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/obsidian/templates: sessionId required');
        }
        const obsidian = resolveObsidianRoot();
        if (!obsidian.available) {
          return { templates: [], error: 'obsidian-vault-unavailable' };
        }
        const { findTemplates } = await import('./obsidian-templates.js');
        const result = await findTemplates({ vaultRoot: obsidian.root });
        return { ...result };
      }
      if (method === 'elanous/obsidian/notes') {
        // PLAN-ipad-notes-obsidian-typora §5 Phase O2 — PR Q (2026-05-17) —
        // Recursive vault `.md` enumeration for the iPad CodeMirror
        // editor's `[[wikilink]]` autocomplete. Hidden + `.obsidian` +
        // `.git` + `node_modules` skipped. Sorted by basename. Optional
        // substring `query` against basename or relPath. Default 500 cap
        // (max 2000) — larger vaults rely on `query` to narrow.
        const p = params as {
          sessionId?: unknown; query?: unknown; limit?: unknown;
        };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/obsidian/notes: sessionId required');
        }
        const obsidian = resolveObsidianRoot();
        if (!obsidian.available) {
          return { notes: [], truncated: false, error: 'obsidian-vault-unavailable' };
        }
        const query = typeof p.query === 'string' ? p.query : undefined;
        const limit = typeof p.limit === 'number' ? p.limit : undefined;
        const { findNotes } = await import('./obsidian-notes.js');
        const result = await findNotes({ vaultRoot: obsidian.root, query, limit });
        return { ...result };
      }
      if (method === 'elanous/sync/status') {
        // PLAN-ipad-notes-obsidian-typora §9 Phase O.S (2026-05-17) —
        // obsidian-headless wrapper status snapshot. Pure poll — no
        // side effects. iPad Notes header pill calls this on view
        // appear + sync trigger completion.
        const p = params as { sessionId?: unknown };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/sync/status: sessionId required');
        }
        const { getSharedObsidianHeadless } = await import('../nexus/sync/obsidian-headless.js');
        const status = await getSharedObsidianHeadless().getStatus();
        return { ...status };
      }
      if (method === 'elanous/sync/trigger') {
        // PLAN-ipad-notes-obsidian-typora §9 Phase O.S (2026-05-17) —
        // one-shot push. Optional `vaultPath` overrides whatever the
        // wrapper was last configured with; absent → use the cached
        // path or the resolved obsidian vault root as a default.
        const p = params as { sessionId?: unknown; vaultPath?: unknown };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/sync/trigger: sessionId required');
        }
        const explicit = typeof p.vaultPath === 'string' && p.vaultPath.length > 0
          ? p.vaultPath
          : undefined;
        const { getSharedObsidianHeadless } = await import('../nexus/sync/obsidian-headless.js');
        const runner = getSharedObsidianHeadless();
        const fallback = explicit ?? (resolveObsidianRoot().available ? resolveObsidianRoot().root : undefined);
        const status = await runner.syncOnce(fallback);
        return { ...status };
      }
      if (method === 'elanous/sync/configure') {
        // PLAN-ipad-notes-obsidian-typora §9 Phase O.S (2026-05-17) —
        // persist a vault path on the wrapper so subsequent triggers
        // don't need to pass it. Currently in-process state only;
        // a future polish stores it under ~/.elanous/sync.json.
        const p = params as { sessionId?: unknown; vaultPath?: unknown };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/sync/configure: sessionId required');
        }
        const vaultPath = typeof p.vaultPath === 'string' ? p.vaultPath.trim() : '';
        if (vaultPath.length === 0) {
          return { ok: false, error: 'vaultPath-required' };
        }
        const { getSharedObsidianHeadless } = await import('../nexus/sync/obsidian-headless.js');
        getSharedObsidianHeadless().configure(vaultPath);
        return { ok: true, vaultPath };
      }
      if (method === 'elanous/obsidian/template-expand') {
        // PLAN-ipad-notes-obsidian-typora §5 Phase O4·7 (2026-05-17) —
        // Templates smart fill. Reads a vault template file, expands
        // Obsidian-style `{{date}}` / `{{date:FORMAT}}` / `{{time}}` /
        // `{{time:FORMAT}}` / `{{title}}` tokens, returns the populated
        // markdown. iPad Toolbar Today menu chains the result into
        // `notes-save` so a Daily note creation never needs the user
        // to type today's date manually.
        const p = params as {
          sessionId?: unknown; templatePath?: unknown; title?: unknown;
        };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/obsidian/template-expand: sessionId required');
        }
        if (typeof p.templatePath !== 'string' || p.templatePath.trim().length === 0) {
          throw new Error('elanous/obsidian/template-expand: templatePath required');
        }
        const obsidian = resolveObsidianRoot();
        if (!obsidian.available) {
          return { content: '', tokensExpanded: [], error: 'obsidian-vault-unavailable' };
        }
        const title = typeof p.title === 'string' && p.title.length > 0 ? p.title : undefined;
        const { expandTemplate } = await import('./obsidian-template-expand.js');
        const result = await expandTemplate({
          vaultRoot: obsidian.root,
          templatePath: p.templatePath,
          ...(title !== undefined ? { title } : {}),
        });
        return { ...result };
      }
      if (method === 'elanous/obsidian/cleanup-orphans') {
        // PLAN-ipad-notes-obsidian-typora R1·c (2026-05-17) —
        // orphan-note enumeration. Returns vault `.md` files that look
        // like abandoned auto-save drafts (old enough · empty body
        // post-frontmatter). Read-only — UI is responsible for the
        // destructive delete confirm gate.
        const p = params as {
          sessionId?: unknown; minAgeMs?: unknown;
          minBodyBytes?: unknown; limit?: unknown;
        };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/obsidian/cleanup-orphans: sessionId required');
        }
        const obsidian = resolveObsidianRoot();
        if (!obsidian.available) {
          return { orphans: [], scanned: 0, truncated: false, error: 'obsidian-vault-unavailable' };
        }
        const minAgeMs = typeof p.minAgeMs === 'number' ? p.minAgeMs : undefined;
        const minBodyBytes = typeof p.minBodyBytes === 'number' ? p.minBodyBytes : undefined;
        const limit = typeof p.limit === 'number' ? p.limit : undefined;
        const { findOrphanNotes } = await import('./obsidian-cleanup-orphans.js');
        const result = await findOrphanNotes({
          vaultRoot: obsidian.root,
          ...(minAgeMs !== undefined ? { minAgeMs } : {}),
          ...(minBodyBytes !== undefined ? { minBodyBytes } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        return { ...result };
      }
      if (method === 'elanous/obsidian/poll-changes') {
        // PLAN-ipad-notes-obsidian-typora §5 Phase O4·6 (2026-05-17) —
        // external-change indicator. Walks the vault `.md` files and
        // counts those with mtime > sinceMs. iPad Notes polls every
        // ~30s; when the daemon reports count > 0, the UI surfaces a
        // "vault changed externally · Reload" indicator on the sync
        // pill so the user knows their local cache is stale.
        const p = params as {
          sessionId?: unknown; sinceMs?: unknown;
          samplePathCap?: unknown; walkCap?: unknown;
        };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/obsidian/poll-changes: sessionId required');
        }
        const obsidian = resolveObsidianRoot();
        if (!obsidian.available) {
          return { count: 0, samplePaths: [], latestMtimeMs: 0, error: 'obsidian-vault-unavailable' };
        }
        const sinceMs = typeof p.sinceMs === 'number' ? p.sinceMs : 0;
        const samplePathCap = typeof p.samplePathCap === 'number' ? p.samplePathCap : undefined;
        const walkCap = typeof p.walkCap === 'number' ? p.walkCap : undefined;
        const { pollVaultChanges } = await import('./obsidian-poll-changes.js');
        const result = await pollVaultChanges({
          vaultRoot: obsidian.root,
          sinceMs,
          ...(samplePathCap !== undefined ? { samplePathCap } : {}),
          ...(walkCap !== undefined ? { walkCap } : {}),
        });
        return { ...result };
      }
      if (method === 'elanous/obsidian/graph') {
        // PLAN-ipad-notes-obsidian-typora §5 Phase O4·1 (2026-05-17) —
        // vault graph (nodes + edges) for the iPad Notes Graph view.
        // Returns every `.md` file as a node and every resolved
        // `[[wikilink]]` as a directed edge. Optional `focus` + `hops`
        // restrict the result to the BFS neighborhood around a focus
        // node (used by O4·3 local graph). Caller caps via `limit`
        // (default 500, max 2000) — vaults larger than that should
        // rely on `focus` to navigate.
        const p = params as {
          sessionId?: unknown; limit?: unknown;
          focus?: unknown; hops?: unknown;
        };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/obsidian/graph: sessionId required');
        }
        const obsidian = resolveObsidianRoot();
        if (!obsidian.available) {
          return { nodes: [], edges: [], truncated: false, error: 'obsidian-vault-unavailable' };
        }
        const limit = typeof p.limit === 'number' ? p.limit : undefined;
        const focus = typeof p.focus === 'string' && p.focus.trim().length > 0
          ? p.focus.trim() : undefined;
        const hops = typeof p.hops === 'number' ? p.hops : undefined;
        const { buildVaultGraph } = await import('./obsidian-graph.js');
        const result = await buildVaultGraph({
          vaultRoot: obsidian.root,
          ...(limit !== undefined ? { limit } : {}),
          ...(focus !== undefined ? { focus } : {}),
          ...(hops !== undefined ? { hops } : {}),
        });
        return { ...result };
      }
      if (method === 'elanous/obsidian/tags') {
        // PLAN-ipad-notes-obsidian-typora §5 Phase O3·2 (2026-05-17) —
        // vault-wide tag aggregate. Returns each unique inline `#tag`
        // with occurrence count + sample referencing paths. Inline tags
        // only this cut; frontmatter `tags:` array parsing lands with
        // O3·6 (frontmatter editor needs a real YAML parser anyway).
        const p = params as { sessionId?: unknown; limit?: unknown };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/obsidian/tags: sessionId required');
        }
        const limit = typeof p.limit === 'number' && p.limit > 0 && p.limit <= 1000
          ? Math.floor(p.limit)
          : 200;
        const obsidian = resolveObsidianRoot();
        if (!obsidian.available) {
          return { tags: [], error: 'obsidian-vault-unavailable' };
        }
        const { findTags } = await import('./obsidian-tags.js');
        const result = await findTags({ vaultRoot: obsidian.root, limit });
        return { ...result };
      }
      if (method === 'elanous/codex/plugins') {
        // PLAN-codex-app-server-hermes-parity §5 Phase H2·2 (2026-05-16) —
        // project the active codex client's `plugin/list` response into
        // the BackendPickerChip-ready shape. Cached at the fetcher layer
        // (codex-plugins.ts · 5 min TTL). Soft-fail when no codex client
        // is wired or the RPC throws — UI hides sub-chips, never errors.
        const p = params as { sessionId?: unknown };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/codex/plugins: sessionId required');
        }
        if (!opts.fetchCodexPlugins) {
          return { plugins: [] };
        }
        try {
          const plugins = await opts.fetchCodexPlugins(p.sessionId);
          return { plugins };
        } catch (e) {
          return { plugins: [], error: String(e instanceof Error ? e.message : e) };
        }
      }
      if (method === 'elanous/skills/list') {
        // Phase 2·B (RESEARCH-ios-companion-tui-parity §1.1·B · 2026-05-17) —
        // skills under `~/.elanous/skills/*` for the `$` picker on iOS/PWA chat
        // surfaces. TUI src/chat/index.ts 의 SkillCandidate 의 daemon-side
        // enumeration. 각 skill = directory name (parsed YAML metadata optional ·
        // 본 cut 은 name + description first-line only).
        const p = params as { sessionId?: unknown; query?: unknown };
        if (typeof p.sessionId !== 'string') {
          throw new Error('elanous/skills/list: sessionId required');
        }
        // ★ G9 P5b — 공유 런타임(dispatchElanousSkillsList) 재사용: router/executor 와 동일한 user-config
        //   skill dir(defaultSkillDirs·P5a)로 통일 + 중복 제거. 종전 하드코딩 ~/.elanous/skills 는 빈 디렉토리라
        //   iOS/PWA `$` 피커가 빈 목록을 보이던 버그(실 skill 은 ~/.claude/skills).
        const { dispatchElanousSkillsList } = await import('../tool-runtime/elanous-skills-list-runtime.js');
        const query = typeof p.query === 'string' ? p.query : '';
        const res = await dispatchElanousSkillsList({ query });
        return { skillsDir: res.skillsDir, skillsDirs: res.skillsDirs, entries: res.entries, ...(res.error ? { error: res.error } : {}) };
      }
      if (method === 'terminal/peers/count') {
        // WT-M-1 — number of ACP connections currently attached to this
        // session id. PWA renders the count badge "Nx" when > 1 so the
        // user knows another device is sharing the terminal.
        const p = params as { sessionId?: unknown };
        if (typeof p.sessionId !== 'string') {
          throw new Error('terminal/peers/count: sessionId required');
        }
        const set = sessionPeers.get(p.sessionId);
        const count = set ? set.size : 0;
        if (debug.enabled) {
          debug.log('webterm.acp', 'peers.count', { sessionId: p.sessionId, count });
        }
        return { sessionId: p.sessionId, count };
      }
      throw new Error(`unknown extension method: ${method}`);
    },
    };
  }, stream);

  // BACKLOG #2.5 — peer-registry cleanup. When the connection closes,
  // walk the session ids this connection registered against and remove
  // its `peer` from each session's broadcast set. Empty sets are
  // pruned so a future loadSession on the same id starts clean.
  void conn.closed.finally(() => {
    for (const sid of ownedSessionIds) {
      const set = sessionPeers.get(sid);
      if (!set) continue;
      set.delete(peer);
      const remaining = set.size;
      if (remaining === 0) sessionPeers.delete(sid);
      if (debug.enabled) {
        debug.log('acp.peer.unregister', sid, { remainingPeers: remaining });
      }
      // C5d — 마지막 peer 이탈 시 'acp' 구독자 브리지 정리(bindings 오염 방지·gated). fire-and-forget.
      if (remaining === 0) {
        void (async () => {
          try {
            const { getUserConfig } = await import('../user-config.js');
            if (getUserConfig().sessionFabric?.streaming?.acp !== true) return;
            const { unsubscribeSession, subscriberKey } = await import('../session/index.js');
            const { acpEndpointKey } = await import('../session/session-endpoint-key.js');
            unsubscribeSession(sid, subscriberKey('acp', acpEndpointKey({ sessionId: sid })));
          } catch { /* fail-soft */ }
        })();
      }
    }
    ownedSessionIds.clear();
  });

  return conn;
}

/** Construct an ndJsonStream from a transport connection's byte
 *  streams. Extracted so both the stdio and transport paths hit the
 *  same wrapper call. */
function streamFromTransportConnection(
  connection: AcpTransportConnection,
): ReturnType<typeof ndJsonStream> {
  return ndJsonStream(connection.writable, connection.readable);
}

/** Adapt Node's stdio into Web byte streams for the stdio ACP path. */
async function createStdioBytes(): Promise<{
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
}> {
  const { Readable, Writable } = await import('node:stream');
  const input = (Readable as unknown as { toWeb: (s: unknown) => ReadableStream<Uint8Array> })
    .toWeb(process.stdin);
  const output = (Writable as unknown as { toWeb: (s: unknown) => WritableStream<Uint8Array> })
    .toWeb(process.stdout);
  return { input, output };
}

/** Keep the SDK's input stream open after EOF until responses already received
 *  have been written. Closing it earlier makes the SDK abort its handlers. */
function drainStdioResponses(
  stream: ReturnType<typeof ndJsonStream>,
  timeoutMs: number,
): ReturnType<typeof ndJsonStream> {
  const pending = new Map<string, number>();
  let releaseDrain: (() => void) | undefined;
  let inputEnded = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const input = stream.readable.getReader();
  const output = stream.writable.getWriter();
  const readable = new ReadableStream<NonNullable<Awaited<ReturnType<typeof input.read>>['value']>>({
    async pull(controller) {
      const { done, value } = inputEnded
        ? { done: true as const, value: undefined }
        : await input.read();
      if (!done) {
        if (value && !Array.isArray(value) && 'method' in value && 'id' in value) {
          const key = JSON.stringify(value.id);
          pending.set(key, (pending.get(key) ?? 0) + 1);
        }
        controller.enqueue(value!);
        return;
      }
      if (!inputEnded) {
        inputEnded = true;
        if (pending.size > 0) {
          drainTimer = setTimeout(() => {
            drainTimer = undefined;
            releaseDrain?.();
          }, timeoutMs);
        }
      }
      while (pending.size > 0 && drainTimer) {
        await new Promise<void>((resolve) => { releaseDrain = resolve; });
        releaseDrain = undefined;
      }
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = undefined;
      controller.close();
    },
    async cancel(reason) {
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = undefined;
      await input.cancel(reason);
    },
  });
  const writable = new WritableStream<Parameters<typeof output.write>[0]>({
    async write(message) {
      await output.write(message);
      if (message && !Array.isArray(message) && !('method' in message) && 'id' in message) {
        const key = JSON.stringify(message.id);
        const count = pending.get(key);
        if (count !== undefined) {
          if (count === 1) pending.delete(key);
          else pending.set(key, count - 1);
          if (pending.size === 0) releaseDrain?.();
        }
      }
    },
    async close() { await output.close(); },
    async abort(reason) { await output.abort(reason); },
  });
  return { readable, writable };
}

/** Construct the server state + register method handlers. Returns a
 *  promise that resolves when the stdio stream closes (so the caller
 *  can `await runAcpServer()` as a long-running process).
 *
 *  U4b — when `opts.transportFactory` is provided, stdio is skipped
 *  and the factory's transport accepts connections; each inbound
 *  connection gets its own `AgentSideConnection` bound to the shared
 *  server state. The returned promise resolves when the transport
 *  closes (externally, e.g. SIGINT calls `.close()`). */
export async function runAcpServer(opts: AcpServerOptions = {}): Promise<void> {
  const sessions = new Map<string, AcpServerSession>();
  // iOS session-list track (2026-05-14) — expose an out-of-protocol
  // cancel hook so REST clients (DELETE /v1/sessions/:id) can flip
  // the same `aborted` flag the in-band `session/cancel`
  // notification flips. Caller (NEXUS boot) captures the function
  // into a holder + threads it through `MetaApiOpts.abortSession`.
  opts.onAbortHandle?.((sessionId) => {
    const s = sessions.get(sessionId);
    if (!s) return false;
    s.aborted = true;
    return true;
  });
  const sessionPeers = new Map<string, Set<SessionPeer>>();
  const dualRole = opts.dualRoleManager ?? globalDualRoleManager();
  const ctx: AcpServerContext = {
    sessions,
    sessionPeers,
    dualRole,
    nextSessionToken: mintAcpSessionToken,
    agentName: opts.agentName ?? 'elanous-agent',
    agentVersion: opts.agentVersion ?? readPkgVersion(),
    opts,
  };
  // ACP streaming Phase E — register module-level broadcaster so
  // out-of-ACP code paths (chat REST `/v1/prompt/stream` handler) can
  // fan-out `session/update` notifications during their turns. Mirrors
  // the connection-bound `broadcast()` helper at line ~573.
  activeAcpBroadcaster = async (sessionId, update) => {
    const peers = sessionPeers.get(sessionId);
    const peerCount = peers?.size ?? 0;
    if (!peers || peers.size === 0) {
      if (debug.enabled) {
        debug.log('acp.broadcast', 'no-peers', {
          sessionId,
          kind: extractUpdateKind(update),
          scope: 'module',
        });
      }
      return { delivered: 0 };
    }
    const tasks: Promise<unknown>[] = [];
    let delivered = 0;
    for (const p of peers) {
      delivered += 1;
      tasks.push(p.sessionUpdate({ sessionId, update }));
    }
    if (debug.enabled) {
      debug.log('acp.broadcast', 'fanout', {
        sessionId,
        kind: extractUpdateKind(update),
        peerCount,
        delivered,
        scope: 'module',
      });
    }
    await Promise.allSettled(tasks);
    return { delivered };
  };
  // PLAN-ios-rich-dev-feedback-hydrate M4 (2026-05-13) — all-sessions
  // fan-out for process-wide envelope kinds (hud.segment). Iterates
  // sessionPeers + delegates each session to activeAcpBroadcaster
  // (consistent transport · same agent_thought_chunk text-in-text shape).
  activeAcpAllSessionsFeedbackBroadcaster = async (envProto) => {
    let fannedTo = 0;
    let delivered = 0;
    for (const [sessionId, peers] of sessionPeers) {
      if (peers.size === 0) continue;
      fannedTo += 1;
      const env = { ...envProto, sessionId } as FeedbackEnvelope;
      const text = formatElanousFeedbackEnvelope({ method: 'emit', payload: env });
      for (const peer of peers) {
        try {
          await peer.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text },
            },
          });
          delivered += 1;
        } catch {
          /* swallow — best-effort fan-out */
        }
      }
    }
    return { delivered, fannedTo };
  };
  // ⭐P2 (capture substrate) — all-sessions terminalFrame fan-out. Mirrors
  // the feedback all-sessions broadcaster: iterate sessionPeers, gate each
  // peer on its negotiated `terminalFrame` cap, deliver the envelope-in-text.
  activeAcpAllSessionsTermFrameBroadcaster = async (payload) => {
    let fannedTo = 0;
    let delivered = 0;
    const text = formatElanousTermEnvelope({ method: 'terminalFrame', payload });
    for (const [sessionId, peers] of sessionPeers) {
      if (peers.size === 0) continue;
      let any = false;
      for (const peer of peers) {
        if (peer.getTermCaps().terminalFrame !== true) continue;
        any = true;
        try {
          await peer.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text },
            },
          });
          delivered += 1;
        } catch {
          /* swallow — best-effort fan-out */
        }
      }
      if (any) fannedTo += 1;
    }
    if (debug.enabled) {
      debug.log('acp.termframe', 'fanout', {
        terminalId: payload.terminalId,
        instance: payload.instance,
        frameBytes: payload.frame.length,
        fannedTo,
        delivered,
      });
    }
    return { delivered, fannedTo };
  };
  if (debug.enabled) {
    debug.log('acp.broadcaster.lifecycle', 'set', {
      mode: opts.transportFactory ? 'transport' : 'stdio',
    });
  }

  if (opts.transportFactory) {
    // Transport mode — per-connection AgentSideConnection, shared
    // server state. Live connections are tracked so a transport
    // close can await their drain.
    const liveConnections = new Set<AgentSideConnection>();
    const onConnection: AcpConnectionHandler = async (connection) => {
      const stream = streamFromTransportConnection(connection);
      const agentConn = wireAcpConnection(stream, ctx);
      liveConnections.add(agentConn);
      try {
        await agentConn.closed;
      } finally {
        liveConnections.delete(agentConn);
        try { await connection.close(); } catch { /* ignore */ }
      }
    };
    const transport = await opts.transportFactory(onConnection);
    try {
      await waitUntilSignalAborts(opts.shutdownSignal);
    } finally {
      try { await transport.close(); } catch { /* ignore */ }
      acpServerDisposeSessions(sessions, dualRole);
      activeAcpBroadcaster = null;
      activeAcpAskPusher = null;
      activeAcpAllSessionsFeedbackBroadcaster = null;
      activeAcpAllSessionsTermFrameBroadcaster = null;
      if (debug.enabled) {
        debug.log('acp.broadcaster.lifecycle', 'clear', { mode: 'transport' });
      }
    }
    return;
  }

  // Stdio path — EOF stops intake, but already received replies drain first.
  const bytes = opts.stdioInput && opts.stdioOutput
    ? { input: opts.stdioInput, output: opts.stdioOutput }
    : await createStdioBytes();
  const stream = drainStdioResponses(
    ndJsonStream(bytes.output, bytes.input),
    opts.stdioDrainTimeoutMs ?? 30_000,
  );
  const conn = wireAcpConnection(stream, ctx);
  try {
    await conn.closed;
    // The SDK closes its message stream on EOF but does not close the
    // underlying byte sink. Flush and end stdout only after the replies.
    const writer = bytes.output.getWriter();
    try { await writer.close(); } finally { writer.releaseLock(); }
  } finally {
    acpServerDisposeSessions(sessions, dualRole);
    activeAcpBroadcaster = null;
    activeAcpAskPusher = null;
    activeAcpAllSessionsTermFrameBroadcaster = null;
    if (debug.enabled) {
      debug.log('acp.broadcaster.lifecycle', 'clear', { mode: 'stdio' });
    }
  }
}

/** Extract plain-text content from a PromptRequest's ContentBlock[].
 *  Non-text blocks are represented by `[<kind>]` placeholders so the
 *  echo stub has something coherent to round-trip.  */
export function extractText(blocks: PromptRequest['prompt']): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if ((b as { type?: string }).type === 'text' && typeof (b as { text?: string }).text === 'string') {
      parts.push((b as { text: string }).text);
    } else {
      const kind = (b as { type?: string }).type ?? 'unknown';
      parts.push(`[${kind}]`);
    }
  }
  return parts.join('\n');
}

/** Resolve when the provided abort signal fires. When the signal is
 *  undefined, blocks forever — caller SIGINTs to exit. When already
 *  aborted, resolves immediately. Extracted so tests can hand in a
 *  synthetic controller without rewriting the serve-loop shape. */
async function waitUntilSignalAborts(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    await new Promise<void>(() => { /* run forever */ });
    return;
  }
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function readPkgVersion(): string {
  try {
    // Module constants work in both ESM (via import.meta) and test
    // environments without fs spelunking.
    return (process.env.npm_package_version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}
