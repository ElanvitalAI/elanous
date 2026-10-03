// Messenger-agnostic ACP turn runner. Telegram and Discord both call
// this for their `/cc`-style commands. The only messenger-specific
// detail that remains at the call site is the streamer (because
// edit-in-place is a messenger UI concern) and the chat key shape
// (Telegram: number, Discord: string snowflake — both accepted by
// the session-store).
//
// MSS M1.1 Phase B3 — the tracked `sessionId` is narrowed to the
// `SessionUri` brand. The ACP SDK itself carries a plain-string
// `SessionId`, so the brand is added at the boundary where the runner
// minted (or looked up) the id. Phantom cast — no runtime cost.
//
// Stale-session resilience (2026-05-02) — three layers:
//   A. `isStaleSessionError` — pure detector unifying the three error
//      shapes seen in practice (codex-app-server "unknown session",
//      claude-code-acp JSON-RPC `data.details: "Session not found"`,
//      and `AcpLoadSessionUnsupportedError`). Re-used by acp-chat to
//      keep dashboard + messenger paths in lockstep.
//   L2. Capability-aware persistence — backends that don't advertise
//      `loadSession` are tracked in an in-process ephemeral cache
//      instead of the on-disk session store. Their session ids are
//      meaningless across restarts, so we don't persist them; that
//      eliminates the load → fail → drop → mint cycle on every boot.
//   L3. loadSession-first validation — when a persisted id is found,
//      we call `agent.loadSession(...)` once per process to confirm
//      the session is actually live. Stale ids surface as a typed
//      error before we burn a user's prompt on a dead session; we
//      drop the entry and mint a fresh one transparently.
//
// Together: bot restart no longer makes the user's first message
// fail; mid-session daemon hibernate is recovered without retry; and
// non-stale errors (auth, network, crash) still propagate.

import { globalAcpAgentManager } from './agent-manager.js';
import { canonicalizeBackendId } from './backend-registry.js';
import { globalAcpSessionStore, ACP_SESSION_EPOCH, type ChatKey } from './session-store.js';
import { buildAcpPrompt, type NormalizedAttachment } from './content-blocks.js';
import type { SessionUri } from '../mss/uri/brand.js';
import { unsafeBrandSessionUri } from '../mss/uri/brand.js';
import { debug } from '../debug/log.js';
import type { AgentStatusStore } from '../agent-status/store.js';
import type { AcpPermissionApprover, AcpQuestionApprover } from './client.js';
import {
  CODEX_APPROVAL_OPT_ONCE,
  CODEX_APPROVAL_OPT_REJECT,
  CODEX_APPROVAL_QUESTION_ID,
} from './codex-approval-adapter.js';
import type { ConfirmChannel } from '../hitl/confirm.js';
import type { QuestionChannel } from '../hitl/question.js';
import {
  createAcpPermissionApproverFromHitl,
  createAcpQuestionApproverFromHitl,
} from '../hitl/hitl-acp-adapter.js';
import {
  renderToolUpdate,
  type RelayToolUpdate,
} from '../channel/agent-event-relay.js';
import { spillFileName } from '../channel/file-sink.js';
import { getUserConfig } from '../user-config.js';

// ── Surface-scoped HITL for delegated ACP turns ───────────────────
//
// When a `/cc`-style mission is delegated to Claude Code / Codex and
// the subprocess asks for permission (or a clarifying question), the
// prompt must go back to the SURFACE that triggered the turn — the
// exact Telegram chat / Discord channel — not a global HITL bot. The
// messenger passes its own surface-scoped `ConfirmChannel`(s) on the
// turn; we register them keyed by the backend session id so the
// approver (installed once on the shared cached agent) resolves the
// right channel per permission request, even if two chats drive the
// same backend concurrently. Deregistered in `runAcpTurn`'s finally.
//
// No channels registered for a session ⇒ the approver denies (maps to
// ACP `cancelled`), matching the pre-existing default-deny posture for
// unattended turns — so nothing hangs when a surface opts out.
const turnHitlChannels = new Map<string, ConfirmChannel[]>();
const turnPermissionApprovers = new Map<string, AcpPermissionApprover>();
/** Parallel registry for multi-option question channels (same keying
 *  as `turnHitlChannels`). Present ⇒ the question approver fans out
 *  real N-option prompts; absent ⇒ it falls back to yes/no collapse
 *  over the confirm channels. */
const turnHitlQuestionChannels = new Map<string, QuestionChannel[]>();

/** Default per-request HITL wait before the confirm race times out and
 *  denies. Kept modest so an ignored prompt can't wedge the subprocess
 *  indefinitely (the YOLO regression that motivated this wiring). */
const HITL_TURN_TIMEOUT_MS = 120_000;

const surfacePermissionApprover: AcpPermissionApprover = async (req) => {
  const turnApprover = turnPermissionApprovers.get(req.sessionId);
  if (turnApprover) return turnApprover(req);
  // Autonomous by default: edit/command PERMISSIONS auto-approve. Asking the
  // human to approve every write defeats delegation (the interactive-editor
  // paradigm ACP inherited doesn't fit autonomous telegram delegation).
  // Opt into per-edit oversight via `acp.editApproval`. Structured QUESTIONS
  // (surfaceQuestionApprover) still surface regardless — that's genuine
  // consultation, not babysitting.
  const editApproval = getUserConfig().acp?.editApproval === true;
  const channels = turnHitlChannels.get(req.sessionId);
  if (!editApproval || !channels || channels.length === 0) return true;
  // Instrument the human-approval wait so a slow turn can be attributed
  // to HITL (human tapping) vs the prompt's own work.
  const t = Date.now();
  debug.log('acp.turn-runner.hitl.wait.start', req.sessionId, { kind: 'permission', title: (req as { title?: string }).title });
  const answer = await createAcpPermissionApproverFromHitl({
    channels,
    timeoutMs: HITL_TURN_TIMEOUT_MS,
  })(req);
  debug.log('acp.turn-runner.hitl.wait.end', req.sessionId, { kind: 'permission', elapsedMs: Date.now() - t, answer });
  return answer;
};

/** PCH-2b — answer codex's 3-way approval question with a yes/no permission
 *  approver. Returns null when the request is not that question. */
export async function answerCodexApprovalQuestion(
  req: Parameters<AcpQuestionApprover>[0],
  approver: AcpPermissionApprover,
): Promise<Awaited<ReturnType<AcpQuestionApprover>> | null> {
  const q = req.questions[0];
  if (req.questions.length !== 1 || q?.id !== CODEX_APPROVAL_QUESTION_ID) return null;
  const approved = await approver({
    backendId: req.backendId,
    sessionId: req.sessionId,
    title: q.question,
    options: [],
  });
  return { answers: { [q.id]: approved ? CODEX_APPROVAL_OPT_ONCE : CODEX_APPROVAL_OPT_REJECT } };
}

const surfaceQuestionApprover: AcpQuestionApprover = async (req) => {
  // PCH-2b — an ACP server turn answers codex's approval question through its
  // own client (yes/no), not the messenger HITL channels.
  const turnApprover = turnPermissionApprovers.get(req.sessionId);
  if (turnApprover) {
    const answered = await answerCodexApprovalQuestion(req, turnApprover);
    if (answered) return answered;
  }
  const channels = turnHitlChannels.get(req.sessionId);
  if (!channels || channels.length === 0) return { answers: {}, cancelled: true };
  // When the surface provided real multi-option QuestionChannels, fan
  // the structured question out as N inline-keyboard buttons; otherwise
  // the adapter collapses to a yes/no over the confirm channels.
  const questionChannels = turnHitlQuestionChannels.get(req.sessionId);
  const t = Date.now();
  debug.log('acp.turn-runner.hitl.wait.start', req.sessionId, { kind: 'question' });
  const res = await createAcpQuestionApproverFromHitl({
    channels,
    ...(questionChannels && questionChannels.length > 0 ? { questionChannels } : {}),
    timeoutMs: HITL_TURN_TIMEOUT_MS,
  })(req);
  debug.log('acp.turn-runner.hitl.wait.end', req.sessionId, { kind: 'question', elapsedMs: Date.now() - t, cancelled: res.cancelled === true });
  return res;
};

// ── Rich-dev-feedback opportunistic followup §6.2 #3 (2026-05-13) ──
//
// Module-level wire for ACP turn-runner → AgentStatusStore. NEXUS boot
// calls `setAcpAgentStatusStore(state.agentStatusStore)` once at
// startup so every subsequent `runAcpTurn(...)` automatically
// publishes `working` / `working` (lastEvent tag changes) / `done` /
// `err` transitions to the store. The store fan-outs to the
// `/v1/events` bus via `wireAgentStatusEvents`, and PWA chat picks
// them up via `subscribeAgentStatusEvents` → `<StatusChip>`.
//
// Single-observer by design (matches setWorkflowRunEventBus pattern).
// Tests inject a fresh store + null it on teardown.

let activeAgentStatusStore: AgentStatusStore | null = null;

export function setAcpAgentStatusStore(store: AgentStatusStore | null): void {
  activeAgentStatusStore = store;
}

export function getAcpAgentStatusStore(): AgentStatusStore | null {
  return activeAgentStatusStore;
}

/** Minimal streamer shape — both Telegram's TgMessageStreamer and
 *  Discord's DcMessageStreamer satisfy this structurally. */
export interface AcpStreamer {
  edit(partialText: string): void;
  /** P1.4 file spill — optional. Present on file-capable sinks (Telegram
   *  today); when a relayed tool body overflows the inline cap the runner
   *  spills the full body here. Absent ⇒ the chat keeps just the truncated
   *  inline (the `/cc` slash path before P1.4). Fire-and-forget. */
  sendFile?: import('../channel/file-sink.js').FileSink['sendFile'];
}

/** Default soft focus budget for slash `/cc`·/cdx·/gem when the user
 *  hasn't set `acp.slashMaxTurns`. Targeted commands run tight; natural-
 *  language delegation (elanous brain) is generous and never gets this. */
export const SLASH_FOCUS_TURNS_DEFAULT = 8;

/** Build the tight-budget directive prepended to a targeted slash
 *  prompt. Advisory (the sub-agent self-regulates) but empirically
 *  keeps claude/codex from wandering — no file re-read pathology, no
 *  broad exploration; do the named thing and finish. Pure — unit-tested. */
export function buildSlashFocusPreamble(focusTurns: number): string {
  return (
    `[집중 모드 · 슬래시 타겟 명령] 이 작업은 슬래시 명령으로 타겟 지정됐다. ` +
    `약 ${focusTurns}회의 도구 호출(읽기/실행/편집) 안에 끝내는 것을 목표로 하라 — ` +
    `광범위 탐색과 파일 재독을 피하고, 필요한 것만 최소로 확인한 뒤 목표를 바로 수행하고 간결히 답하라.\n\n` +
    `작업:\n`
  );
}

/** Per-chat in-flight turn registry. Keyed by canonical chat key
 *  (stringified so Telegram numbers and Discord snowflakes share the
 *  same namespace). `/cancel` from any messenger looks the entry up
 *  here and calls agent.cancel(sessionId). */
const inFlightTurns = new Map<string, { backendId: string; sessionId: SessionUri; cwd?: string }>();

/** Per-chat abort registry for the NL brain turn (and its blocking
 *  `delegate_code_agent` sub-turn). The SLASH path (`inFlightTurns` +
 *  `cancelAcpTurn`) already cancels a `/cc` turn, but a natural-language
 *  delegation blocks inside elanous's brain via `clientSessionSend` — a
 *  different path that `/cancel` couldn't reach, so the only recourse was
 *  killing processes. The messenger registers a per-turn AbortController
 *  here; `/cancel` aborts it; the delegate tool (which forwards
 *  `ctx.signal`) closes its ACP session, unblocking the send. */
const turnAborters = new Map<string, AbortController>();

/** Open a cancelable turn for a chat — returns a fresh AbortController
 *  registered so `cancelAcpTurn` can abort it. The caller passes
 *  `.signal` down to `runTurn` (→ delegate `ctx.signal`) and MUST call
 *  `endCancelableTurn` in a finally. */
export function beginCancelableTurn(chatId: ChatKey, threadId?: ChatKey): AbortController {
  const ac = new AbortController();
  turnAborters.set(chatKey(chatId, threadId), ac);
  return ac;
}

/** Deregister a cancelable turn. Idempotent; only clears the entry when
 *  it still points at THIS controller (avoids racing a re-entrant turn). */
export function endCancelableTurn(chatId: ChatKey, threadId: ChatKey | undefined, ac: AbortController): void {
  const key = chatKey(chatId, threadId);
  if (turnAborters.get(key) === ac) turnAborters.delete(key);
}

function chatKey(k: ChatKey, threadKey?: ChatKey): string {
  return threadKey !== undefined ? `${k}:${threadKey}` : String(k);
}

/** Composite key for ephemeral cache + validated set. Includes
 *  backend id so two backends used by the same chat don't collide. */
function sessionKey(chatId: ChatKey, backendId: string, threadId?: ChatKey): string {
  return threadId !== undefined
    ? `${chatId}:${threadId}\0${backendId}`
    : `${chatId}\0${backendId}`;
}

// ── L2 · ephemeral session cache (in-process only) ────────────────
//
// Backends that advertise `loadSession=false` (e.g. codex-acp
// 0.11.1 · gemini-cli 0.38.0) cannot resume across a bot restart.
// Persisting their session ids on disk just guarantees that the next
// boot reads a stale id and fails — so we keep them in memory only.
// Multi-turn within the same process still works (the cache survives
// for the bot's lifetime); a restart cleanly drops them and the next
// turn mints a fresh session.
const ephemeralCache = new Map<string, string>();

// ── L3 · validated-this-process set ───────────────────────────────
//
// Once we've confirmed a sessionId is live (either by `loadSession`
// success or by minting via `newSession`), we don't pay the
// validation RPC again for the lifetime of this process. This keeps
// the loadSession-first flow zero-overhead on the hot path.
const validatedSessions = new Set<string>();

/** Detect "the session id we have is stale / unusable" errors so the
 *  caller can drop the entry + mint a fresh session instead of
 *  surfacing a raw error to the end user. Three real-world shapes:
 *
 *    1. Native `Error.message` — `codex-app-server · unknown session <id>`
 *    2. JSON-RPC error envelope — `{ code: -32603, message: "Internal
 *       error", data: { details: "Session not found" } }` (claude-code-acp)
 *    3. `AcpLoadSessionUnsupportedError` — peer didn't advertise
 *       loadSession, so any stored id is unresumable
 *
 *  Detection is intentionally narrow: only `unknown session` /
 *  `session ... not found` / `loadSession` (case-insensitive,
 *  whitespace-tolerant). Vague "session" mentions like rate-limit
 *  errors must NOT match — otherwise a transient backend hiccup
 *  would trigger an infinite recovery loop.
 *
 *  Falls back to JSON.stringify on the whole payload for pathological
 *  shapes where the signal is buried in a non-standard field. The
 *  fallback is circular-safe (try/catch around stringify). */
const STALE_SIGNAL = /unknown session|session\s+not\s+found|loadSession/i;

export function isStaleSessionError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err === 'string') return STALE_SIGNAL.test(err);
  if (err instanceof Error) {
    if (STALE_SIGNAL.test(err.message)) return true;
    // Some libraries attach JSON-RPC `data` onto Error instances.
    const withData = err as Error & { data?: unknown };
    if (withData.data && typeof withData.data === 'object') {
      const details = (withData.data as { details?: unknown }).details;
      if (typeof details === 'string' && STALE_SIGNAL.test(details)) return true;
    }
    return false;
  }
  if (typeof err === 'object') {
    const obj = err as { message?: unknown; data?: unknown };
    if (typeof obj.message === 'string' && STALE_SIGNAL.test(obj.message)) return true;
    if (obj.data && typeof obj.data === 'object') {
      const details = (obj.data as { details?: unknown }).details;
      if (typeof details === 'string' && STALE_SIGNAL.test(details)) return true;
    }
    // Last-resort fallback for non-standard shapes — the signal might
    // live in a deeply nested field. JSON.stringify handles that, but
    // throws on circular refs; swallow + return false in that case so
    // we don't crash the recovery path.
    try {
      const dump = JSON.stringify(err);
      if (typeof dump === 'string' && STALE_SIGNAL.test(dump)) return true;
    } catch {
      /* circular — message+data checks above already missed, give up */
    }
    return false;
  }
  return false;
}

export interface RunAcpTurnOpts {
  backendId: string;
  promptText: string;
  chatId: ChatKey;
  threadId?: ChatKey;
  streamer?: AcpStreamer;
  /** Multimedia attachments normalized by the messenger layer. Each
   *  entry becomes one or more ACP ContentBlocks prepended to the
   *  text prompt. Empty / omitted = text-only turn (v1 behavior). */
  attachments?: NormalizedAttachment[];
  /** Optional working directory for the ACP subprocess/session. */
  cwd?: string;
  /** Session-scoped Codex app-server configuration arguments. */
  codexArgs?: readonly string[];
  /** ACP server turn's permission request, routed through its client rather than the messenger HITL channel. */
  permissionApprover?: AcpPermissionApprover;
  /** Soft focus budget (tool-turns) for a TARGETED slash invocation
   *  (`/cc`·/cdx·/gem). When set, a tight-budget directive is prepended
   *  to the prompt so the sub-agent stays focused (minimize re-reads /
   *  exploration). Advisory — not hard-enforced. Omit for natural-
   *  language turns (elanous brain stays generous). */
  focusTurns?: number;
  /** Surface-scoped HITL channels for this turn. When the delegated
   *  agent requests permission or asks a question, the prompt is
   *  raced over these channels — so it lands back in the chat that
   *  triggered the mission. Omit / empty ⇒ the turn runs unattended
   *  (permission requests are denied, matching prior behavior). The
   *  messenger builds these (e.g. Telegram inline-keyboard channel);
   *  the runner stays channel-agnostic. */
  hitlConfirmChannels?: ConfirmChannel[];
  /** Surface-scoped multi-option question channels for this turn.
   *  Paired with `hitlConfirmChannels` — when present, a delegated
   *  agent's structured questions render as N option buttons instead
   *  of collapsing to yes/no. */
  hitlQuestionChannels?: QuestionChannel[];
  /** L4 — fired once per turn when L3 had to drop a stale persisted
   *  session and mint a fresh one. Messengers can use this to
   *  surface a "_session restarted · prior context lost_" notice
   *  via the streamer or a separate status line, so users
   *  understand why follow-up questions might lack prior context.
   *  Default = silent (preserves existing API). */
  onRecovery?: (info: AcpRecoveryInfo) => void;
}

/** Payload for the L4 recovery callback. `previousSessionId` is the
 *  stale id we dropped; `reason` discriminates between "the live
 *  validation rejected the id" vs "the backend doesn't advertise
 *  loadSession at all" so callers can word the user-facing message
 *  appropriately if they care to. */
export interface AcpRecoveryInfo {
  reason: 'stale-validation' | 'unsupported-load-session';
  previousSessionId: string;
  backendId: string;
}

export interface RunAcpTurnResult {
  text: string;
  /** One of ACP's StopReason values: 'end_turn' | 'cancelled' |
   *  'max_tokens' | 'refusal' | 'max_turn_requests' | ... */
  stopReason: string;
  /** Backend-reported model for this turn's session, when known (codex).
   *  Undefined when the backend doesn't surface it (claude-code-acp). */
  model?: string;
}

/** Minimal capability-and-session shape we need from the agent.
 *  AcpAgent and the codex-app-server duck-typed equivalent both
 *  satisfy this — typed loosely so tests can pass a stub without
 *  importing the full client surface. */
interface AcpAgentLike {
  getCapabilities(): { loadSession?: boolean } | null;
  newSession(): Promise<string>;
  /** The backend-reported model for a session, when the backend surfaces it
   *  (codex reports it via thread/start; claude-code-acp doesn't expose one).
   *  Undefined when unknown — callers show backend-only rather than guess. */
  getSessionModel?(sessionId: string): string | undefined;
  loadSession?(req: { sessionId: string; cwd?: string }): Promise<unknown>;
  prompt(
    sessionId: string,
    blocks: ReturnType<typeof buildAcpPrompt>,
    onUpdate: (update: { sessionUpdate: string; content?: { type: string; text?: string }; title?: string; kind?: string }) => void,
  ): Promise<{ stopReason: string }>;
}

function isPersistableAgent(agent: AcpAgentLike): boolean {
  return agent.getCapabilities()?.loadSession === true;
}

/** Look up a persisted-or-cached sessionId for this chat+backend.
 *  Persistable backends → on-disk store. Ephemeral (no loadSession)
 *  → in-memory cache only. Returns null when no record exists. */
function lookupSession(
  agent: AcpAgentLike,
  chatId: ChatKey,
  backendId: string,
  threadId?: ChatKey,
): string | null {
  if (isPersistableAgent(agent)) {
    return globalAcpSessionStore().getRecord(chatId, backendId, threadId)?.sessionId ?? null;
  }
  return ephemeralCache.get(sessionKey(chatId, backendId, threadId)) ?? null;
}

/** Persist a freshly-minted (or re-validated) sessionId. */
function rememberSession(
  agent: AcpAgentLike,
  chatId: ChatKey,
  backendId: string,
  sessionId: string,
  threadId?: ChatKey,
): void {
  if (isPersistableAgent(agent)) {
    globalAcpSessionStore().set(chatId, backendId, sessionId, threadId);
  } else {
    ephemeralCache.set(sessionKey(chatId, backendId, threadId), sessionId);
  }
}

/** Drop a sessionId we believed was good but turned out stale. */
function forgetSession(
  agent: AcpAgentLike,
  chatId: ChatKey,
  backendId: string,
  threadId?: ChatKey,
): void {
  if (isPersistableAgent(agent)) {
    globalAcpSessionStore().delete(chatId, backendId, threadId);
  } else {
    ephemeralCache.delete(sessionKey(chatId, backendId, threadId));
  }
  validatedSessions.delete(sessionKey(chatId, backendId, threadId));
}

/** Recycle a persisted session after this many turns. Bounds the
 *  loadSession replay cost. 2026-07-11 — SMART lifecycle: the old crude
 *  24-turn cap severed coding continuity at an ARBITRARY, topic-blind
 *  boundary (대표 지적). Continuity is now kept across a topic; a session
 *  ends only on meaningful signals — IDLE (below), topic reset (`/new`·
 *  /cc_clear`, see clearChatAcpSessions), or a stale epoch (restart). This
 *  cap survives only as a pathological BACKSTOP (unbounded-growth guard);
 *  fresh-session context is refilled by the carry-in digest, so a recycle
 *  never loses the conversation. */
export const ACP_SESSION_TURN_CAP = 200;
/** SMART idle termination — a coding session untouched this long is treated
 *  as a natural boundary (topic likely moved on): recycled to a fresh mint
 *  (context refilled by carry-in) instead of resuming a cold, possibly-bloated
 *  transcript. Replaces the arbitrary turn cap as the primary lifecycle
 *  signal. */
export const ACP_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
/** Abandon a loadSession replay that overruns this. Defense-in-depth for
 *  a surprise-bloated session that the epoch/turn-cap guards didn't catch
 *  (e.g. a huge session minted THIS process before the cap kicked in) —
 *  better a fresh start than a wedged turn. */
const ACP_RESUME_TIMEOUT_MS = 12_000;
/** Backends whose loadSession replays the WHOLE transcript on resume
 *  (claude-code-acp — 60s+ for a big session). For these a cross-restart
 *  resume of a LARGE session is so expensive we recycle EAGERLY on a
 *  stale epoch (never even attempt the replay). Backends with a cheap
 *  re-attach resume (codex's single `thread/resume` RPC, which also
 *  self-heals restarts via its own ensureSessionResumed) keep their
 *  session across restarts — the turn cap (②) + resume time-box (③)
 *  still bound them, without discarding cheap continuity or churning
 *  orphan backend sessions on every restart. */
const EAGER_RECYCLE_BACKENDS = new Set(['claude']);
/** S5 (2026-07-12) — 재시작 생존: even for EAGER_RECYCLE_BACKENDS, a
 *  session at or below this turn count gets a time-boxed loadSession
 *  attempt across a restart instead of an unconditional recycle — a
 *  small transcript replays in seconds, so "데몬 재시작 = /cc 코딩
 *  세션 초기화"였던 v1 한계가 통상 세션에서는 사라진다. Legacy records
 *  with UNKNOWN size (absent turnCount) still recycle eagerly (risky
 *  replay), and the ③ time-box catches any surprise bloat. */
export const ACP_CROSS_RESTART_RESUME_MAX_TURNS = 40;

/** Reject with `acp-resume-timeout` if `p` doesn't settle in `ms`. The
 *  underlying loadSession keeps running in the subprocess, but we stop
 *  waiting and recycle — the next turn mints a clean session. */
export function withResumeTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('acp-resume-timeout')), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Resolve a sessionId for this chat+backend, validating against the
 *  agent if the id was persisted in a prior process. Returns the id
 *  to use for `agent.prompt(...)` — guaranteed to be live as far as
 *  loadSession or newSession can tell.
 *
 *  Paths:
 *    1. Stored id + already validated this process → use as-is
 *       (zero RPC overhead on the hot path)
 *    2. Stored id but STALE (prior-process epoch) or OVER THE TURN CAP →
 *       recycle (forget + mint fresh) WITHOUT paying a loadSession replay
 *    3. Stored id + not yet validated → time-boxed agent.loadSession; on
 *       stale/timeout → drop + mint; on success → mark validated
 *    4. No stored id → mint via agent.newSession + persist
 */
async function resolveSessionId(
  agent: AcpAgentLike,
  opts: RunAcpTurnOpts,
  recoveryBackendId = opts.backendId,
): Promise<string> {
  const cacheKey = sessionKey(opts.chatId, opts.backendId, opts.threadId);
  let sessionId = lookupSession(agent, opts.chatId, opts.backendId, opts.threadId);

  if (sessionId && !validatedSessions.has(cacheKey)) {
    if (isPersistableAgent(agent) && typeof agent.loadSession === 'function') {
      // ①② Freshness + bloat guard — decided BEFORE paying any replay.
      //   ① A session minted by a PRIOR process (epoch mismatch, or absent
      //      epoch on pre-bounding records) would loadSession-replay its
      //      whole transcript on resume → recycle to a fresh mint instead.
      //   ② A session past the turn cap is recycled to keep replay cheap
      //      and the backend's context bounded.
      const rec = globalAcpSessionStore().getRecord(opts.chatId, opts.backendId, opts.threadId);
      // S5 — cross-restart survival: an epoch mismatch alone no longer
      // recycles a SMALL known-size session (replay is seconds; the ③
      // time-box bounds the worst case). Unknown-size legacy records and
      // large sessions keep the eager-recycle fast path.
      const knownSmall = rec?.turnCount !== undefined
        && rec.turnCount <= ACP_CROSS_RESTART_RESUME_MAX_TURNS;
      const staleEpoch = EAGER_RECYCLE_BACKENDS.has(opts.backendId)
        && (rec?.mintedEpoch ?? undefined) !== ACP_SESSION_EPOCH
        && !knownSmall;
      // SMART idle boundary — untouched > TTL ⇒ topic likely moved on.
      const idleMs = rec?.updatedAt ? (Date.now() - Date.parse(rec.updatedAt)) : 0;
      const idleStale = idleMs > ACP_SESSION_IDLE_TTL_MS;
      // Pathological backstop only (continuity is otherwise kept).
      // ⛔⭐ `>=` 다 — 「cap 에 «닿으면»」 갈아치운다. 2026-08-27 에 한 무인 착지가 이것을 `>` 로 바꾸고
      //   시험을 「cap 이면 이어붙는다」로 다시 썼는데, ⑴ 그 변경은 그 착지가 고치려던 아홉에 «필요 없었고»
      //   (되돌려도 나머지 13 이 통과한다) ⑵ 근거로 든 것은 «다른 상수»였다(RESUME_MAX_TURNS=40 ↔ TURN_CAP=200).
      const overCap = (rec?.turnCount ?? 0) >= ACP_SESSION_TURN_CAP;
      if (staleEpoch || idleStale || overCap) {
        debug.log('acp.turn-runner.session.recycle', sessionId, {
          backendId: opts.backendId, chatId: String(opts.chatId),
          reason: staleEpoch ? 'stale-epoch' : idleStale ? 'idle-ttl' : 'turn-cap-backstop',
          turnCount: rec?.turnCount ?? 0, idleMs,
        });
        forgetSession(agent, opts.chatId, opts.backendId, opts.threadId);
        sessionId = null;
      }
    }
  }

  if (sessionId && !validatedSessions.has(cacheKey)) {
    if (isPersistableAgent(agent) && typeof agent.loadSession === 'function') {
      try {
        // ③ Time-box the resume — a surprise-bloated session can't wedge
        //    the turn for a minute; on overrun we recycle instead.
        await withResumeTimeout(agent.loadSession({ sessionId, cwd: opts.cwd }), ACP_RESUME_TIMEOUT_MS);
        validatedSessions.add(cacheKey);
        if (debug.enabled) {
          debug.log('acp.turn-runner.loadSession.ok', sessionId, {
            backendId: opts.backendId, chatId: String(opts.chatId),
          });
        }
      } catch (err) {
        const timedOut = err instanceof Error && err.message === 'acp-resume-timeout';
        // Rethrow only genuine failures — a stale session or a resume
        // timeout both mean "drop it + mint fresh", not an error.
        if (!timedOut && !isStaleSessionError(err)) throw err;
        if (timedOut) {
          debug.log('acp.turn-runner.loadSession.timeout', sessionId, {
            backendId: opts.backendId, chatId: String(opts.chatId), ms: ACP_RESUME_TIMEOUT_MS,
          }, { level: 'warn' });
        } else {
          if (debug.enabled) {
            debug.log('acp.turn-runner.loadSession.stale', sessionId, {
              backendId: opts.backendId, chatId: String(opts.chatId),
              err: err instanceof Error ? err.message : String(err),
            });
          }
          // L4 — notify the caller that we're about to drop a stale
          // persisted session so it can surface a recovery notice.
          // We discriminate AcpLoadSessionUnsupportedError from generic
          // stale-shaped errors so callers can word the message
          // appropriately. The class import would be a circular dep;
          // detect by name + message instead.
          const errName = err instanceof Error ? err.name : '';
          const errMsg = err instanceof Error ? err.message : String(err);
          const reason: AcpRecoveryInfo['reason'] =
            errName === 'AcpLoadSessionUnsupportedError'
              || /loadSession/i.test(errMsg)
              ? 'unsupported-load-session'
              : 'stale-validation';
          try {
            opts.onRecovery?.({
              reason,
              previousSessionId: sessionId,
              backendId: recoveryBackendId,
            });
          } catch { /* listener errors must not wedge recovery */ }
        }
        forgetSession(agent, opts.chatId, opts.backendId, opts.threadId);
        sessionId = null;
      }
    } else {
      // Ephemeral backend: in-memory cache only, can't be cross-process
      // stale by construction. Mark validated so we don't re-enter
      // this branch on follow-up turns.
      validatedSessions.add(cacheKey);
    }
  }

  if (!sessionId) {
    sessionId = await agent.newSession();
    rememberSession(agent, opts.chatId, opts.backendId, sessionId, opts.threadId);
    validatedSessions.add(cacheKey);
    if (debug.enabled) {
      debug.log('acp.turn-runner.newSession', sessionId, {
        backendId: opts.backendId, chatId: String(opts.chatId),
        persistable: isPersistableAgent(agent),
      });
    }
  }
  return sessionId;
}

/** Execute an ACP turn end-to-end: resolve the subprocess, look up
 *  (or mint) the session, stream updates into the messenger's
 *  placeholder via `streamer.edit`, and return the accumulated
 *  final text plus stop reason. Throws on agent crash — the caller
 *  decides how to surface the error to the user.
 *
 *  Side effects:
 *    - Persists the sessionId (or caches in-memory for ephemeral
 *      backends) so follow-up turns same chat continue the
 *      conversation.
 *    - Registers in the inFlightTurns map for `/cancel` to reach.
 *    - On stale-session error: drops the agent handle + clears the
 *      session-store entry + mints a fresh session and retries the
 *      same prompt once. Mid-session daemon hibernate / cross-process
 *      restart no longer surface to the user.
 *    - On non-stale error: drops the agent + session entry and
 *      rethrows so the caller can surface a real failure. */
export async function runAcpTurn(opts: RunAcpTurnOpts): Promise<RunAcpTurnResult> {
  const requestedBackendId = opts.backendId;
  // Canonicalize a friendly backend alias (codex/cx/cas → codex-app-server)
  // BEFORE anything keys off it — the ACP session store, per-backend status,
  // and getAgent must all agree, so `/cdx` and an NL codex delegate share
  // one agent + one session instead of splitting on the alias.
  opts = { ...opts, backendId: canonicalizeBackendId(opts.backendId) };
  // Install the surface-scoped HITL approvers on the (possibly shared,
  // cached) agent. They dispatch per-request via the `turnHitlChannels`
  // registry, so re-installing them on every turn is idempotent and
  // never leaks one chat's channel to another.
  // Step-by-step timing so a slow ACP turn can be decomposed into
  // subprocess-prep (getAgent), session resolution (loadSession/newSession),
  // and prompt execution (which folds in HITL wait + tool relay). Enable
  // with debug.level=diag; read the elapsedMs on each `.end` event.
  const turnStartedAt = Date.now();
  debug.log('acp.turn-runner.getAgent.start', opts.backendId, { cwd: opts.cwd });
  const tGetAgent = Date.now();
  const agent = (await globalAcpAgentManager().getAgent(opts.backendId, {
    cwd: opts.cwd,
    codexArgs: opts.codexArgs,
    permissionApprover: surfacePermissionApprover,
    questionApprover: surfaceQuestionApprover,
  })) as unknown as AcpAgentLike;
  debug.log('acp.turn-runner.getAgent.end', opts.backendId, { elapsedMs: Date.now() - tGetAgent });

  debug.log('acp.turn-runner.resolveSession.start', opts.backendId);
  const tResolve = Date.now();
  const sessionId = await resolveSessionId(agent, opts, requestedBackendId);
  debug.log('acp.turn-runner.resolveSession.end', sessionId, { elapsedMs: Date.now() - tResolve });

  // Register this turn's surface channels so the approver can reach the
  // triggering chat for the duration of the turn. Keyed by backend
  // session id (== the `req.sessionId` seen in requestPermission).
  const hasHitl = !!opts.hitlConfirmChannels && opts.hitlConfirmChannels.length > 0;
  if (hasHitl) turnHitlChannels.set(sessionId, opts.hitlConfirmChannels!);
  if (opts.permissionApprover) turnPermissionApprovers.set(sessionId, opts.permissionApprover);
  const hasHitlQuestions = !!opts.hitlQuestionChannels && opts.hitlQuestionChannels.length > 0;
  if (hasHitlQuestions) turnHitlQuestionChannels.set(sessionId, opts.hitlQuestionChannels!);

  const key = chatKey(opts.chatId, opts.threadId);
  inFlightTurns.set(key, { backendId: opts.backendId, sessionId: unsafeBrandSessionUri(sessionId), cwd: opts.cwd });
  let accumulated = '';
  // Count relayed tool events so the timing log shows how much work the
  // prompt did (e.g. "prompt 87s · 15 tool relays" → agent-bound, not HITL).
  let toolRelayCount = 0;
  // Phase 1 · Channel Terminal Relay — single 'normal' policy (mutating
  // tools show command + output; read-only tools a 1-line header). No
  // user knob — verbosity was de-optioned as premature configurability.
  const relayVerbosity = 'normal' as const;
  // Status fan-out — opt-in via the module-level setter
  // (`setAcpAgentStatusStore`). Off in tests that don't wire it.
  const statusStore = activeAgentStatusStore;
  const setStatus = (
    status: 'working' | 'done' | 'err',
    lastEvent: string,
  ): void => {
    if (!statusStore) return;
    try {
      statusStore.set(opts.backendId, status, lastEvent);
    } catch {
      /* swallow — status fan-out is supplemental */
    }
  };
  // Targeted slash invocation → prepend a tight focus directive so the
  // sub-agent stays bounded (NL delegation omits focusTurns → generous).
  const effectivePromptText = opts.focusTurns
    ? buildSlashFocusPreamble(opts.focusTurns) + opts.promptText
    : opts.promptText;
  setStatus('working', 'turn-start');
  debug.log('acp.turn-runner.prompt.start', sessionId, { backendId: opts.backendId, focusTurns: opts.focusTurns ?? null });
  const tPrompt = Date.now();
  try {
    const result = await agent.prompt(
      sessionId,
      buildAcpPrompt(effectivePromptText, opts.attachments ?? []),
      (update) => {
        if (update.sessionUpdate === 'agent_message_chunk') {
          const c = update.content;
          if (c && c.type === 'text' && typeof c.text === 'string') {
            accumulated += c.text;
            opts.streamer?.edit(accumulated);
          }
        } else if (update.sessionUpdate === 'tool_call') {
          // Phase 1 relay: render the tool header + command (was: a bare
          // `→ tool: X` marker) so the user sees WHAT is being run.
          const rendered = renderToolUpdate(update as unknown as RelayToolUpdate, {
            verbosity: relayVerbosity,
          });
          if (rendered) {
            accumulated += rendered.text;
            opts.streamer?.edit(accumulated);
          }
          toolRelayCount++;
          setStatus('working', `tool-call:${update.title ?? update.kind ?? 'unknown'}`);
        } else if (update.sessionUpdate === 'tool_call_update') {
          // Phase 1 relay: stream the tool's stdout/stderr/diff into the
          // chat. Output over the inline cap is rendered truncated with a
          // "(truncated N chars)" note; P1.4 now spills the FULL body as a
          // file attachment on file-capable sinks (Telegram sendDocument).
          const rendered = renderToolUpdate(update as unknown as RelayToolUpdate, {
            verbosity: relayVerbosity,
          });
          if (rendered) {
            accumulated += rendered.text;
            opts.streamer?.edit(accumulated);
            if (rendered.overflow && opts.streamer?.sendFile) {
              opts.streamer.sendFile(rendered.overflow.body, {
                ext: rendered.overflow.ext,
                caption: `${rendered.overflow.title} · ${rendered.overflow.body.length} chars`,
                name: spillFileName(rendered.overflow.title, rendered.overflow.ext),
              });
            }
          }
          // ACP tool_call_update.status is the ACP enum
          // ('in_progress' | 'completed' | 'failed' | ...). 'failed'
          // surfaces as agent error; 'completed' returns the agent to
          // generic 'working' (next tool / text chunk continues).
          const u = update as unknown as { status?: string; title?: string };
          if (u.status === 'failed') {
            setStatus('err', `tool-error:${u.title ?? 'unknown'}`);
          } else if (u.status === 'completed') {
            setStatus('working', `tool-result:${u.title ?? 'unknown'}`);
          }
        }
      },
    );
    debug.log('acp.turn-runner.prompt.end', sessionId, {
      elapsedMs: Date.now() - tPrompt, stopReason: result.stopReason, toolRelayCount,
    });
    setStatus('done', `turn-end:${result.stopReason}`);
    debug.log('acp.turn-runner.turn.end', sessionId, {
      totalMs: Date.now() - turnStartedAt, stopReason: result.stopReason, toolRelayCount,
    });
    // Count the turn so the session gets recycled once it passes the cap
    // (bounds replay cost + backend context). Persisted backends only;
    // ephemeral sessions have no store record (bumpTurn is a no-op).
    if (isPersistableAgent(agent)) {
      try { globalAcpSessionStore().bumpTurn(opts.chatId, opts.backendId, opts.threadId); }
      catch { /* telemetry — must never fail the turn */ }
    }
    return { text: accumulated, stopReason: result.stopReason, model: agent.getSessionModel?.(sessionId) };
  } catch (err) {
    debug.log('acp.turn-runner.prompt.end', sessionId, {
      elapsedMs: Date.now() - tPrompt, error: err instanceof Error ? err.message.slice(0, 80) : 'unknown', toolRelayCount,
    });
    setStatus('err', `turn-failed:${err instanceof Error ? err.message.slice(0, 40) : 'unknown'}`);
    // Stale-session or subprocess crash recovery — drop everything
    // so the next turn starts fresh. The L3 loadSession validation
    // catches MOST stale ids before they reach prompt(), but a
    // session can still go stale mid-turn (codex hibernate, daemon
    // restart, etc.) so we keep the safety net.
    globalAcpAgentManager().drop(opts.backendId, opts.cwd);
    forgetSession(agent, opts.chatId, opts.backendId, opts.threadId);
    throw err;
  } finally {
    inFlightTurns.delete(key);
    if (hasHitl) turnHitlChannels.delete(sessionId);
    if (opts.permissionApprover) turnPermissionApprovers.delete(sessionId);
    if (hasHitlQuestions) turnHitlQuestionChannels.delete(sessionId);
  }
}

/** Cancel the in-flight turn for a chat. Returns true if a turn was
 *  found and cancel was sent; false if nothing running. */
export async function cancelAcpTurn(chatId: ChatKey, threadId?: ChatKey): Promise<boolean> {
  const key = chatKey(chatId, threadId);
  // NL brain turn / in-flight delegation — abort the registered controller
  // so the delegate tool closes its ACP session (unblocks clientSessionSend).
  const aborter = turnAborters.get(key);
  if (aborter && !aborter.signal.aborted) aborter.abort();
  // SLASH `/cc` turn — cancel the ACP agent's in-flight prompt directly.
  const turn = inFlightTurns.get(key);
  if (turn) {
    const agent = await globalAcpAgentManager().getAgent(turn.backendId, { cwd: turn.cwd });
    await agent.cancel(turn.sessionId);
  }
  return !!aborter || !!turn;
}

export function inFlightAcpBackend(chatId: ChatKey, threadId?: ChatKey): string | null {
  return inFlightTurns.get(chatKey(chatId, threadId))?.backendId ?? null;
}

/** Tests only — reset the in-process caches so each test starts
 *  fresh. Production code never calls this. */
export function _resetTurnRunnerCachesForTests(): void {
  ephemeralCache.clear();
  validatedSessions.clear();
  inFlightTurns.clear();
}
