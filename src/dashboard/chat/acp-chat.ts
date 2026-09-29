// Dashboard ACP chat bridge — T7-N.
//
// Wires the dashboard `/acp` slash straight into the real ACP client
// (src/acp/*). Streams agent_message_chunk + tool_call updates
// into the dashboard chat pane.
//
// Design:
//
//   • One `DashboardAcpChat` instance per dashboard lifetime.
//   • Per backend (claude / codex / gemini) one session, reused across
//     `/acp <backend> <msg>` calls so the conversation persists.
//   • `active.backendId` tracks the last-used backend; a bare `/acp
//     <msg>` targets it.
//   • Streaming fires user-supplied callbacks (pushChatLine,
//     redraw) so dashboard.ts keeps painting control.
//   • Cancel routes to `agent.cancel(sessionId)`; in-flight promise
//     resolves with stopReason='cancelled'.
//
// Tier 8: dashboard session ids are persisted through AcpSessionStore
// under a dashboard:<cwd> key. ACP subprocess restarts may still make
// an old id stale; drop the backend session if that happens.

import { globalAcpAgentManager } from '../../acp/agent-manager.js';
import { canonicalizeBackendId } from '../../acp/backend-registry.js';
import { buildAcpPrompt, type NormalizedAttachment } from '../../acp/content-blocks.js';
import { globalAcpSessionStore, type ChatKey } from '../../acp/session-store.js';
import { isStaleSessionError } from '../../acp/turn-runner.js';
import type { AcpPermissionApprover, AcpQuestionApprover } from '../../acp/client.js';
import {
  createStreamingBuffer,
  type StreamingBuffer,
  type StreamingBufferOpts,
  type StreamingBufferScheduler,
} from '../../acp/streaming-text-buffer.js';
import {
  createPlanModel,
  type PlanModel,
} from '../../acp/plan-model.js';
import {
  createToolCallTable,
  toolCallGlyph,
  toolCallLabel,
  type ToolCallTable,
} from '../../acp/tool-call-state.js';
import { getSessionCwd } from '../../session/working-dir.js';
import { getUserConfig } from '../../user-config.js';
import { debug } from '../../debug/log.js';
import type { SessionUpdate } from '@agentclientprotocol/sdk';

export type AcpBackendId = 'claude' | 'gemini' | 'codex-app-server';

/** User-facing display name for a backend id. The registry id
 *  `'codex-app-server'` is too internal for chat surfaces — sprint 5C
 *  (2026-04-28) adds this helper so chat lines render as `codex`
 *  while the underlying type stays stable. claude / gemini are short
 *  enough to render as-is. */
export function displayBackendName(id: AcpBackendId): string {
  if (id === 'codex-app-server') return 'codex';
  return id;
}

/** F2 — pull a human-readable message out of any error shape the ACP
 *  agent stack might surface. JSON-RPC errors (claude-code-acp /
 *  codex-acp / gemini --experimental-acp) are plain `{code, message,
 *  data?}` objects; calling `String(err)` on those yields
 *  `"[object Object]"` which used to land verbatim in the chat
 *  (`acp:claude error: [object Object]`). Real `Error` instances pass
 *  straight through; objects with a `.message` field get their
 *  message (prefixed with `[code]` when present); anything else is
 *  JSON-stringified so at least the structure is debuggable. */
function formatAcpError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown };
    if (typeof e.message === 'string' && e.message.length > 0) {
      return typeof e.code === 'number' ? `[${e.code}] ${e.message}` : e.message;
    }
    try { return JSON.stringify(err); } catch { /* fall through */ }
  }
  return String(err);
}

export interface AcpChatHandlers {
  /** Push a single chat line into the dashboard pane. Each chunk of
   *  streamed text arrives via onChunk; this is for status/control
   *  lines like "→ sending to claude" or error notices. */
  pushLine: (line: string) => void;
  /** Append streamed assistant text. Caller accumulates + redraws.
   *  Receives each chunk exactly as the ACP agent emits it. */
  appendChunk: (delta: string) => void;
  /** Called once per tool_call event with a rendered label like
   *  "→ tool: read_file(/tmp/foo)". Dashboard writes these into the
   *  log pane with a subdued style. */
  pushToolCall: (label: string) => void;
  /** H4 Phase 2 · agent_thought_chunk landing point. When the caller
   *  supplies this, the dispatcher routes reasoning / thinking output
   *  here with `isReasoning=true` for codex-native's `_meta.reasoning`
   *  channel (rendered distinctly · e.g. dim gray 💭 prefix) and
   *  `false` for plain thought chunks from other backends. Fallback is
   *  `pushLine` with a `💭 ` / `· ` prefix so existing callers keep
   *  working. */
  pushThought?: (text: string, isReasoning: boolean) => void;
  /** Stream ended — caller commits any buffered text and redraws. */
  onDone: (stopReason: string) => void;
  /** Soft error — spawn failure, mid-stream crash, cancel etc. */
  onError: (err: Error) => void;
  /** Redraw request. Invoked after every streamed chunk so the pane
   *  stays current without the caller polling. Optional. */
  redraw?: () => void;
}

interface AcpChatSession {
  backendId: AcpBackendId;
  sessionId: string;
  inFlight: boolean;
  /** H1 #1 streaming smoothing — owned per in-flight turn. Reset when
   *  the turn ends or the session is dropped so we never carry pending
   *  text across prompts. */
  streamBuffer: StreamingBuffer | null;
  /** H1 #2 plan model — lazy. Cleared on dropSession. Persists across
   *  turns within a session (plan state is session-scoped per ACP). */
  planModel: PlanModel | null;
  /** H1 #3 tool-call table — lazy per session. Cleared on dropSession.
   *  Cancel flips all non-terminal records to 'canceled'. */
  toolCallTable: ToolCallTable | null;
  /** Server-confirmed runtime model, scoped to this backend session only. */
  runtimeModel?: string;
}

export interface DashboardAcpChatOpts {
  /** cwd for new ACP subprocesses. Accepts either a static string or
   *  a function that resolves lazily (dashboard's workingDir may not
   *  be constructed yet at instantiation time). Defaults to the
   *  session working directory via getSessionCwd() (WD7). */
  cwd?: string | (() => string);
  /** Logger for subprocess stderr / protocol events. Route into the
   *  dashboard debug log (pushLog). */
  log?: (msg: string) => void;
  /** Dependency injection hook for tests — overrides the default
   *  `globalAcpAgentManager()` lookup. Production call sites omit
   *  this field. */
  agentManager?: {
    getAgent: (backendId: string, opts?: {
      cwd?: string;
      log?: (m: string) => void;
      permissionApprover?: AcpPermissionApprover;
      questionApprover?: AcpQuestionApprover;
    }) => Promise<{
      newSession: () => Promise<string>;
      prompt: (sessionId: string, blocks: unknown, onUpdate: (u: SessionUpdate) => void) => Promise<{ stopReason: string }>;
      cancel: (sessionId: string) => Promise<void>;
      getSessionModel?: (sessionId: string) => string | undefined;
    }>;
  };
  sessionStore?: {
    get: (chatId: ChatKey, backendId: string, threadId?: ChatKey) => string | null;
    set: (chatId: ChatKey, backendId: string, sessionId: string, threadId?: ChatKey) => void;
    delete: (chatId: ChatKey, backendId: string, threadId?: ChatKey) => boolean;
  };
  permissionApprover?: AcpPermissionApprover;
  /** AU5 — optional. Wired from dashboard with an adapter that
   *  converts the subprocess's AcpQuestionRequest into the elanous
   *  AskUserQuestionRequest + surfaces the modal. When omitted,
   *  ACP subprocesses that emit question-shaped permission calls
   *  fall back to the yes/no permission approver. */
  questionApprover?: AcpQuestionApprover;
  /** H1 #1 — override the streaming buffer's scheduler. Tests inject
   *  a fake that ticks deterministically; production leaves this
   *  undefined so the buffer uses an unref'd setInterval. */
  streamScheduler?: StreamingBufferScheduler;
  /** H1 #1 — disable the smoothing buffer entirely. Text chunks then
   *  route straight to appendChunk, matching pre-smoothing behavior.
   *  Kept as an escape hatch for low-bandwidth integrations. */
  disableStreamSmoothing?: boolean;
  /** R1 — test seam / local override for chat.rendering.streaming. */
  streamBufferConfig?: Pick<StreamingBufferOpts, 'mode' | 'catchUpThresholdLines' | 'catchUpAgeMs'>;
}

export class DashboardAcpChat {
  private readonly getCwd: () => string;
  private readonly log: (msg: string) => void;
  private readonly agentManager: NonNullable<DashboardAcpChatOpts['agentManager']>;
  private readonly sessionStore: NonNullable<DashboardAcpChatOpts['sessionStore']>;
  private readonly permissionApprover?: AcpPermissionApprover;
  private readonly questionApprover?: AcpQuestionApprover;
  private readonly streamScheduler?: StreamingBufferScheduler;
  private readonly smoothingEnabled: boolean;
  private readonly streamBufferConfig?: NonNullable<DashboardAcpChatOpts['streamBufferConfig']>;
  /** One session per backend — reused across /acp calls so user gets
   *  a conversation rather than one-shots. */
  private readonly sessionsByBackend = new Map<AcpBackendId, AcpChatSession>();
  /** The last backend the user talked to. A bare `/acp <msg>`
   *  targets it. Null until the first /acp <backend> call lands. */
  private lastBackend: AcpBackendId | null = null;
  /** Sticky multi-turn target. When set, dashboard text submits route
   *  straight to this backend (no `/acp …` prefix needed) until the
   *  user runs `/acp exit`. Drop semantics handled by the caller via
   *  `clearSticky({drop:true})`. */
  private stickyBackend: AcpBackendId | null = null;

  constructor(opts: DashboardAcpChatOpts = {}) {
    if (typeof opts.cwd === 'function') this.getCwd = opts.cwd;
    else if (typeof opts.cwd === 'string') {
      const c = opts.cwd;
      this.getCwd = () => c;
    } else {
      // WD7 — default cwd follows the session working directory.
      this.getCwd = () => getSessionCwd();
    }
    this.log = opts.log ?? ((_m) => { /* default: drop */ });
    this.agentManager = opts.agentManager ?? {
      getAgent: (backendId, o) => globalAcpAgentManager().getAgent(backendId, o) as any,
    };
    this.sessionStore = opts.sessionStore ?? globalAcpSessionStore();
    this.permissionApprover = opts.permissionApprover;
    this.questionApprover = opts.questionApprover;
    this.streamScheduler = opts.streamScheduler;
    this.smoothingEnabled = opts.disableStreamSmoothing !== true;
    this.streamBufferConfig = opts.streamBufferConfig;
  }

  /** Last backend the user targeted, or null if none yet. */
  getLastBackend(): AcpBackendId | null {
    return this.lastBackend;
  }

  /** Runtime model confirmed for the active ACP backend session only. */
  activeRuntimeModel(): string | undefined {
    const backendId = this.lastBackend;
    return backendId ? this.sessionsByBackend.get(backendId)?.runtimeModel : undefined;
  }

  /** Sticky backend (multi-turn passthrough). Null when not in sticky
   *  mode. Dashboard's text-submit hook reads this to decide whether
   *  the next plain (non-slash) input should bypass the LLM and go
   *  straight to ACP. */
  getSticky(): AcpBackendId | null {
    return this.stickyBackend;
  }

  /** Enter sticky mode for `backend`. Idempotent — re-calling with
   *  the same backend is a no-op; switching backends silently swaps
   *  the pointer (caller surfaces the banner). Does NOT auto-create
   *  the session — that happens lazily on the next send(). */
  setSticky(backend: AcpBackendId): void {
    this.stickyBackend = backend;
  }

  /** Leave sticky mode. `drop: true` also evicts the backend's
   *  session (calls dropSession). `drop: false` keeps the session
   *  warm so the user can re-enter via `/acp <backend> --multi`
   *  and continue the same conversation. */
  clearSticky(opts: { drop: boolean }): void {
    const target = this.stickyBackend;
    this.stickyBackend = null;
    if (opts.drop && target) this.dropSession(target);
  }

  /** True if this backend has an active session (in-flight or idle). */
  hasSession(backendId: AcpBackendId): boolean {
    return this.sessionsByBackend.has(backendId);
  }

  /** True if any session has a turn in flight right now. Used to
   *  gate /acp cancel + to render a spinner in the HUD. */
  isBusy(): boolean {
    for (const s of this.sessionsByBackend.values()) {
      if (s.inFlight) return true;
    }
    return false;
  }

  /** Send a prompt to the named backend. Idempotently spawns the
   *  subprocess + mints the session on first use. Streams via the
   *  supplied handlers. Resolves when the turn completes (or is
   *  cancelled / errors). `attachments` are normalized into ACP
   *  ContentBlocks (image / resource_link) and prepended to the user
   *  message — empty by default for backwards compatibility with the
   *  text-only slash dispatch path. */
  async send(
    backendId: AcpBackendId,
    promptText: string,
    handlers: AcpChatHandlers,
    attachments: NormalizedAttachment[] = [],
  ): Promise<void> {
    this.lastBackend = backendId;
    let sess = this.sessionsByBackend.get(backendId);
    try {
      const agent = await this.agentManager.getAgent(backendId, {
        cwd: this.getCwd(),
        log: this.log,
        permissionApprover: this.permissionApprover,
        questionApprover: this.questionApprover,
      });
      if (!sess) {
        const storeKey = this.storeKey();
        const persisted = this.sessionStore.get(storeKey, backendId);
        let sid = persisted;
        if (!sid) {
          if (debug.enabled) {
            handlers.pushLine(`  → creating ${displayBackendName(backendId)} ACP session…`);
          }
          sid = await agent.newSession();
          this.sessionStore.set(storeKey, backendId, sid);
        } else if (debug.enabled) {
          handlers.pushLine(`  → resuming ${displayBackendName(backendId)} ACP session…`);
        }
        sess = {
          backendId,
          sessionId: sid,
          inFlight: false,
          streamBuffer: null,
          planModel: null,
          toolCallTable: null,
        };
        sess.runtimeModel = agent.getSessionModel?.(sid);
        this.sessionsByBackend.set(backendId, sess);
      }
      if (sess.inFlight) {
        throw new Error(`${displayBackendName(backendId)} already has a turn in flight — /acp cancel first`);
      }
      sess.inFlight = true;
      if (debug.enabled) {
        handlers.pushLine(`  → sending to ${displayBackendName(backendId)}…`);
      }
      handlers.redraw?.();

      const activeSess = sess;
      const doPrompt = () =>
        agent.prompt(
          activeSess.sessionId,
          buildAcpPrompt(promptText, attachments),
          (update: SessionUpdate) => {
            this.dispatchUpdate(update, handlers, activeSess);
          },
        );
      let result;
      try {
        result = await doPrompt();
      } catch (err) {
        // Persisted sessionId may be stale — e.g. the backend stores
        // sessions in-process only (CodexAppServerAgent synths a
        // elanous-side id) and restarts leave the id in the on-disk
        // session-store pointing at nothing. Recover once: drop the
        // persisted id, mint a fresh session, retry the same prompt.
        // Predicate is shared with the messenger path (turn-runner.ts)
        // so both UIs stay in lockstep on what counts as recoverable.
        if (!isStaleSessionError(err)) throw err;
        handlers.pushLine(`  → persisted ${displayBackendName(backendId)} session stale · creating fresh…`);
        const storeKey = this.storeKey();
        this.sessionStore.delete(storeKey, backendId);
        this.sessionsByBackend.delete(backendId);
        const freshSid = await agent.newSession();
        this.sessionStore.set(storeKey, backendId, freshSid);
        activeSess.sessionId = freshSid;
        this.sessionsByBackend.set(backendId, activeSess);
        result = await doPrompt();
      }
      this.closeStreamBuffer(sess, 'flush');
      sess.inFlight = false;
      handlers.onDone(result.stopReason);
    } catch (err) {
      if (sess) {
        this.closeStreamBuffer(sess, 'flush');
        sess.inFlight = false;
      }
      handlers.onError(err instanceof Error ? err : new Error(formatAcpError(err)));
    }
  }

  /** Cancel the currently in-flight turn on the last-used backend
   *  (or a specific backend if supplied). Returns true if anything
   *  was cancelled. */
  async cancel(backendId?: AcpBackendId): Promise<boolean> {
    const target = backendId ?? this.lastBackend;
    if (!target) return false;
    const sess = this.sessionsByBackend.get(target);
    if (!sess || !sess.inFlight) return false;
    try {
      const agent = await this.agentManager.getAgent(target);
      await agent.cancel(sess.sessionId);
      // Drop anything the agent streamed up to the cancel point —
      // partial text is already in the chat pane from prior reveals,
      // but in-flight pending should not leak after the user said stop.
      this.closeStreamBuffer(sess, 'dispose');
      // H1 #3 — tool calls in flight transition to 'canceled'.
      if (sess.toolCallTable) sess.toolCallTable.markCanceledAll();
      return true;
    } catch {
      return false;
    }
  }

  /** Drop the session for a backend (keeps the subprocess alive for
   *  other backends / sessions). Next /acp <backend> call mints a
   *  new session. */
  dropSession(backendId: AcpBackendId): void {
    const existing = this.sessionsByBackend.get(backendId);
    if (existing) {
      this.closeStreamBuffer(existing, 'dispose');
      if (existing.planModel) existing.planModel.clear();
      if (existing.toolCallTable) existing.toolCallTable.clear();
      existing.planModel = null;
      existing.toolCallTable = null;
    }
    this.sessionsByBackend.delete(backendId);
    this.sessionStore.delete(this.storeKey(), backendId);
    if (this.lastBackend === backendId) this.lastBackend = null;
    if (this.stickyBackend === backendId) this.stickyBackend = null;
  }

  /** Enumerate live sessions — dashboard status panel uses this. */
  list(): AcpChatSession[] {
    return Array.from(this.sessionsByBackend.values()).map(s => ({ ...s }));
  }

  private storeKey(): string {
    return `dashboard:${this.getCwd()}`;
  }

  private dispatchUpdate(update: SessionUpdate, handlers: AcpChatHandlers, sess: AcpChatSession): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const c = update.content;
        if (c.type === 'text') {
          this.routeText(sess, c.text, handlers);
        }
        return;
      }
      case 'tool_call': {
        // Tool call renders a non-text line — flush buffered assistant
        // text first so the tool marker doesn't appear mid-sentence.
        this.closeStreamBuffer(sess, 'flush');
        const table = this.ensureToolCallTable(sess);
        const rec = table.createFromWire(update);
        const glyph = toolCallGlyph(rec.state);
        const kindSuffix = rec.kind ? ` (${rec.kind})` : '';
        handlers.pushToolCall(`${glyph} → ${rec.title}${kindSuffix}`);
        handlers.redraw?.();
        return;
      }
      case 'tool_call_update': {
        // H1 #3 — incremental progress. Snapshot the prior state BEFORE
        // applyUpdate mutates the record in place (table.get returns
        // the same ref applyUpdate patches) so we can detect true
        // transitions instead of always seeing the post-update state
        // on both sides.
        const table = sess.toolCallTable;
        if (!table) return;
        const prev = table.get(update.toolCallId);
        const prevState = prev ? prev.state : null;
        const rec = table.applyUpdate(update);
        if (!rec) return;
        if (prevState !== null && prevState !== rec.state) {
          // Mirror `tool_call`'s flush: when the agent emits a state
          // transition (e.g. Completed) the next assistant chunk must
          // start on a fresh chat line. Without this, codex-app-server's
          // delta-streaming agent_message_chunks land mid-line on the
          // tool record (e.g. "· CompletedI found the top-level…").
          // codex-native isn't affected because it emits agent_message
          // only on item.completed (whole text per chunk).
          this.closeStreamBuffer(sess, 'flush');
          const glyph = toolCallGlyph(rec.state);
          const label = toolCallLabel(rec.state);
          const errSuffix = rec.error ? ` — ${rec.error}` : '';
          handlers.pushToolCall(`  ${glyph} ${rec.title} · ${label}${errSuffix}`);
          handlers.redraw?.();
        }
        return;
      }
      case 'plan': {
        // H1 #2 — render a collapsed summary line. Flush pending text
        // first so ordering matches the agent's narrative.
        this.closeStreamBuffer(sess, 'flush');
        const model = this.ensurePlanModel(sess);
        model.applyWire(update);
        handlers.pushLine(`  ${model.renderSummary()}`);
        handlers.redraw?.();
        return;
      }
      case 'agent_thought_chunk': {
        // H4 Phase 2 · reasoning / thought channel. Flush pending
        // assistant text so the thought line doesn't appear mid-
        // sentence. `_meta.reasoning === true` means this came from a
        // backend's reasoning item (Codex native right now · Claude
        // extended-thinking landing later) — rendered with a distinct
        // prefix so users can tell reasoning apart from the final
        // answer. Plain thought chunks (no meta) get a neutral dot
        // prefix.
        const c = (update as any).content;
        if (!c || c.type !== 'text' || typeof c.text !== 'string') return;
        const text = c.text as string;
        if (text.length === 0) return;
        this.closeStreamBuffer(sess, 'flush');
        const meta = (update as any)._meta as { reasoning?: unknown } | undefined;
        const isReasoning = meta?.reasoning === true;
        if (handlers.pushThought) {
          handlers.pushThought(text, isReasoning);
        } else {
          const prefix = isReasoning ? '  💭 ' : '  · ';
          handlers.pushLine(`${prefix}${text}`);
        }
        handlers.redraw?.();
        return;
      }
      default:
        // Unknown update kinds ignored for forward compat.
        return;
    }
  }

  private ensurePlanModel(sess: AcpChatSession): PlanModel {
    if (!sess.planModel) sess.planModel = createPlanModel();
    return sess.planModel;
  }

  private ensureToolCallTable(sess: AcpChatSession): ToolCallTable {
    if (!sess.toolCallTable) sess.toolCallTable = createToolCallTable();
    return sess.toolCallTable;
  }

  /** H1 #1 — route text either through the smoothing buffer or
   *  straight to the consumer depending on the smoothing flag. */
  private routeText(sess: AcpChatSession, text: string, handlers: AcpChatHandlers): void {
    if (!this.smoothingEnabled) {
      handlers.appendChunk(text);
      handlers.redraw?.();
      return;
    }
    if (!sess.streamBuffer) {
      const streamingCfg = this.streamBufferConfig ?? getUserConfig().chat.rendering.streaming;
      sess.streamBuffer = createStreamingBuffer({
        mode: streamingCfg.mode,
        catchUpThresholdLines: streamingCfg.catchUpThresholdLines,
        catchUpAgeMs: streamingCfg.catchUpAgeMs,
        onReveal: (t) => {
          handlers.appendChunk(t);
          handlers.redraw?.();
        },
        scheduler: this.streamScheduler,
      });
    }
    sess.streamBuffer.append(text);
  }

  /** H1 #1 — drain (flush) or drop (dispose) the per-session buffer
   *  and null the slot. Safe to call when no buffer exists. */
  private closeStreamBuffer(sess: AcpChatSession, mode: 'flush' | 'dispose'): void {
    const buf = sess.streamBuffer;
    if (!buf) return;
    if (mode === 'flush') buf.flush();
    else buf.dispose();
    sess.streamBuffer = null;
  }
}

/** Parse the backend argument from a slash subcommand. Accepts
 *  aliases:
 *    'cc' → claude
 *    'cx' / 'codex' / 'cas' / 'codex-app-server' → codex-app-server
 *    'gm' → gemini
 *
 *  Sprint 5B (2026-04-28) removed the legacy 'cxn' / 'codex-native'
 *  and 'codex-acp-zed' / 'codex-zed' escape aliases. They now return
 *  null (unknown backend), so callers fall back to the default.
 *
 *  Returns null when no valid backend token is present (caller picks
 *  the default). */
export function parseAcpBackend(token: string | undefined): AcpBackendId | null {
  if (!token) return null;
  const id = canonicalizeBackendId(token);
  return id === 'claude' || id === 'gemini' || id === 'codex-app-server'
    ? id
    : null;
}

/** T7-Q — testable /acp slash handler extracted from dashboard.ts.
 *  Returns one of:
 *    { kind: 'message', lines }      — caller appends lines to chat
 *    { kind: 'help',    lines }      — same, but sink is the help panel
 *    { kind: 'send', backend, msg }  — caller runs chat.send()
 *    { kind: 'noop' }                — nothing to do
 *  The caller owns the actual chat pane mutation + draw — this keeps
 *  the handler pure and test-friendly. */
export type AcpSlashOutcome =
  | { kind: 'help'; lines: string[] }
  | { kind: 'message'; lines: string[] }
  | { kind: 'send'; backend: AcpBackendId; message: string }
  | { kind: 'cancel' }
  | { kind: 'status' }
  | { kind: 'drop'; backend: AcpBackendId }
  /** Sticky multi-turn entry. Caller calls chat.setSticky(backend) +
   *  pushes a banner; if `firstMessage` is set, immediately sends it
   *  as the opening turn. */
  | { kind: 'enter-sticky'; backend: AcpBackendId; firstMessage?: string }
  /** Sticky exit. Caller calls chat.clearSticky({drop}). drop=true
   *  also evicts the backend session (one-shot --drop flag). */
  | { kind: 'exit-sticky'; drop: boolean }
  | { kind: 'noop' };

export function parseAcpSlash(sub: string, args: string[], chat: DashboardAcpChat): AcpSlashOutcome {
  if (!sub || sub === 'help') {
    const last = chat.getLastBackend();
    const sticky = chat.getSticky();
    const lines: string[] = [
      'ACP chat (T7):',
      '  /acp claude [msg]      talk to claude-code-acp',
      '  /acp codex  [msg]      talk to codex app-server (canonical · RPC v2)',
      '  /acp gemini [msg]      talk to gemini (--experimental-acp)',
      '  /acp cas    [msg]      alias for /acp codex',
      '  /acp <msg>             talk to last-used backend',
      '  /acp <backend> --multi [first msg]  enter sticky multi-turn (subsequent input → backend)',
      '  /acp --multi           sticky on last-used (or claude default)',
      '  /acp exit [--drop]     leave sticky (--drop also evicts session)',
      '  /acp cancel            cancel in-flight turn',
      '  /acp status            list sessions',
      '  /acp drop <backend>    reset a session',
    ];
    if (last) lines.push(`  last backend: ${last}`);
    if (sticky) lines.push(`  sticky: ${sticky}`);
    return { kind: 'help', lines };
  }
  if (sub === 'cancel') return { kind: 'cancel' };
  if (sub === 'status') return { kind: 'status' };
  if (sub === 'exit') {
    const drop = args.includes('--drop');
    return { kind: 'exit-sticky', drop };
  }
  if (sub === 'drop') {
    const target = parseAcpBackend(args[0]);
    if (!target) {
      return { kind: 'message', lines: ['  /acp drop: specify backend (claude|codex|gemini)'] };
    }
    return { kind: 'drop', backend: target };
  }

  // `/acp --multi`               → sticky on last-used (or claude default)
  // `/acp <backend> --multi`     → sticky on <backend>
  // `/acp <backend> --multi msg` → sticky + immediate first turn
  if (sub === '--multi') {
    const backend = chat.getLastBackend() ?? 'claude';
    const firstMessage = args.join(' ').trim() || undefined;
    return { kind: 'enter-sticky', backend, ...(firstMessage ? { firstMessage } : {}) };
  }

  const maybeBackend = parseAcpBackend(sub);
  const backend: AcpBackendId = maybeBackend ?? chat.getLastBackend() ?? 'claude';
  const msgTokens = maybeBackend ? args : [sub, ...args];
  const multiIdx = msgTokens.indexOf('--multi');
  if (multiIdx !== -1) {
    const tail = [...msgTokens.slice(0, multiIdx), ...msgTokens.slice(multiIdx + 1)];
    const firstMessage = tail.join(' ').trim() || undefined;
    return { kind: 'enter-sticky', backend, ...(firstMessage ? { firstMessage } : {}) };
  }

  const msg = msgTokens.join(' ').trim();
  if (!msg) {
    return { kind: 'message', lines: [`  /acp: session open for ${backend}. Type /acp ${backend} <msg> to send.`] };
  }
  return { kind: 'send', backend, message: msg };
}
