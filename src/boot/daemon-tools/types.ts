// MVP M1.5 A.2 — daemon tool surface types.
//
// Common shapes for the read-only tool catalog the daemon exposes
// when `ELANOUS_TOOLS=readonly` (or `--tools readonly`) is set. The
// surface is a small, security-reviewed subset — Read · Grep ·
// WebSearch — gated behind `path-guard.ts` for fs access.

import type { LLMToolSpec } from '../../llm.js';
import type { FeedbackEnvelope } from '../../feedback/envelope.js';
import type { IngestionEntry } from '../../agent-substrate/execution/ingestion-policy.js';
import type { SurfaceKind } from '../../agent/surface-ux/types.js';
import type { RequestOrigin } from '../../policy/claude-subscription-guard.js';

/** Activation level requested by the operator.
 *
 *  - `none`     → empty surface; LLM has zero tools (text-only chat
 *                 backend).
 *  - `readonly` → Read · Grep · WebSearch · Plan · MarkStepDone
 *                 (fs read, sandboxed; no shell, no writes).
 *  - `chat`     → readonly + Edit + Bash. **Default for `elanous nexus
 *                 run`** (2026-05-13 · chat-only friction-free). The
 *                 baseline surface for PWA / iOS / TUI chat clients —
 *                 LLM can read files, edit files, and execute shell
 *                 commands against the daemon's tool-cwd without any
 *                 PTY / web-terminal dependency.
 *  - `webterm`  → chat + WebTerminalList · WebTerminalSnapshot ·
 *                 WebTerminalInput · WebTerminalScreenshot ·
 *                 LiveCameraFrame. Explicit opt-in for genuinely
 *                 interactive workflows (REPL, vim, long-running
 *                 watchers, TUI apps). WebTerminalInput sends raw
 *                 bytes to a PTY — heavier risk surface than `chat`. */
export type DaemonToolSurfaceKind = 'none' | 'readonly' | 'chat' | 'webterm';

/** Result of `toolSurface(kind)`. The daemon's `runTurn` consumes
 *  `specs` (sent to the LLM as available tools) and `dispatch` (the
 *  per-call handler). `dispatch` returns the raw output the model
 *  consumes — typically a string or a small structured object. */
export interface DaemonToolSurface {
  kind: DaemonToolSurfaceKind;
  specs: LLMToolSpec[];
  dispatch(name: string, args: Record<string, unknown>, ctx: DaemonToolDispatchCtx): Promise<unknown>;
}

export interface DaemonToolDispatchCtx {
  /** Working directory for fs-bound tools (Read · Grep). Fixed at
   *  daemon boot from `--tool-cwd` / `ELANOUS_TOOL_CWD` / process.cwd(). */
  cwd: string;
  /** Lazy production-write destination. Read-only tools keep `cwd`; write
   * tools request this only immediately before dispatch. */
  resolveWriteCwd?: () => string;
  /** Caller-supplied abort signal. Tool implementations forward to
   *  any spawned child / network call. */
  signal: AbortSignal;
  /** Image-pipeline followup #1 (2026-05-05) — current ACP sessionId
   *  for this turn. Threaded through from `daemon-prompt-turn` /
   *  `daemon-runtime` (via `CoreTurnDispatchTool` ctx) so session-keyed
   *  tools (WebTerminalList · Snapshot · Input · Screenshot) can
   *  auto-inject the right scope when the LLM omits `sessionId` from
   *  the args. Optional for backward compat with tests / surfaces that
   *  build the ctx by hand without a session in scope. */
  sessionId?: string;
  /** Trusted server-side classification of the current turn, never supplied as a tool argument. */
  requestOrigin?: RequestOrigin;
  /** Owner principal verified at the server request boundary, not from input source metadata. */
  verifiedOwner?: { id: string };
  /** Ingestion entry class. Omit for conservative external-verbatim fallback. */
  entry?: IngestionEntry;
  /** M5 PR 2 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) —
   *  carrier-agnostic Feedback Envelope emitter. Tools that produce
   *  progressive output (Grep hit stream, large file read chunks)
   *  push envelopes here so PWA chat renders <SearchHitList> /
   *  <ToolProgressCard> while the dispatch is still running.
   *
   *  Always treat as opt-in: caller (`handlePromptStreamPost` via
   *  `runDaemonPromptTurn`) wraps it in `dualEmitFeedback` so emit
   *  errors swallow upstream — tools don't need defensive try/catch.
   *  Absent on legacy callers (skill runner, CLI-only dispatch). */
  emitFeedback?: (env: FeedbackEnvelope) => void;
  /** M5 PR 2 — Anthropic-style tool_use id for the LLM's call.
   *  Surfaced as `envelope.parentToolCallId` so PWA can correlate a
   *  search-hit / progress card with the matching tool_use pill. */
  toolCallId?: string;
  /** Surface-scoped HITL confirm channels for the TRIGGERING chat.
   *  `delegate_code_agent` uses them to route the delegated sub-agent's
   *  permission / question prompts back to the chat that asked (e.g.
   *  the Telegram user who said "Claude로 구현해줘"). Absent ⇒ the
   *  delegate falls back to auto-approve (unattended self-improving
   *  flow, matching prior behavior). */
  /** 원본 유저 메시지 텍스트(#24) — LLM 이 tool arg(objective)에서 "auto_drive on" 을 떼도 dev-harness
   *  detached 위임 판정이 원문에서 의도를 잡게. monad-agent-turn 이 opts.userText 로 실어준다. */
  userText?: string;
  /** Triggering chat surface for SurfaceUx rendering and observability. */
  surface?: SurfaceKind;
  surfaceHitlChannels?: import('../../hitl/confirm.js').ConfirmChannel[];
  /** Paired multi-option question channels for the triggering chat.
   *  `delegate_code_agent` fans a sub-agent's structured question out
   *  as N option buttons there (falls back to yes/no over
   *  `surfaceHitlChannels` when absent). */
  surfaceQuestionChannels?: import('../../hitl/question.js').QuestionChannel[];
  /** P1.4 · surface file spill for the triggering chat.
   *  `delegate_code_agent` spills a sub-agent's overflowing tool bodies
   *  (big diffs/stdout) here as file attachments, so the full content
   *  reaches the chat instead of being clipped at the aggregate cap.
   *  Absent ⇒ overflow is only truncated inline (prior behavior). */
  surfaceFileSink?: import('../../channel/file-sink.js').FileSink;
}

/** Tool-specific safety failure surfaced to the LLM as a structured
 *  error. Distinct from generic `Error` so the bridge can render a
 *  consistent "tool refused" message. */
export class ToolSafetyError extends Error {
  constructor(
    public readonly kind: 'path-traversal' | 'sensitive' | 'binary' | 'too-large' | 'timeout' | 'unavailable',
    message: string,
  ) {
    super(`tool refused: ${kind} — ${message}`);
    this.name = 'ToolSafetyError';
  }
}
