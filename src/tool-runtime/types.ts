// ── ToolRuntime — the shared dispatch contract ──
//
// Phase S4 of the PTY promotion track (DESIGN-pty-llm-native-promotion.md
// §3B). Mirrors codex-rs's `ToolRuntime<Req, Out>` trait: one shape
// that every LLM-callable tool implements, exposing a single
// dispatchToolByName() entry point callable from skill-runner,
// dashboard chat loop, plugin host, and — eventually — MCP export.
//
// Scope is deliberately minimal in this phase:
//   • types + registry exist
//   • PtyShell* are the first migrated clients (proof)
//   • skill-runner and dashboard STILL own their direct-dispatch
//     maps for every other tool; migration is tool-by-tool in
//     follow-up commits
//
// The migration criterion is reuse: any tool whose dispatch logic
// differs between skill and dashboard scopes (e.g. approval gates,
// capability policy, audit logging) is a good candidate. Tools
// with identical skill/dashboard behavior can stay on the direct
// map until there's an actual reason to change.

import type { LLMToolSpec } from '../llm.js';
import type { FeedbackEnvelope } from '../feedback/envelope.js';

import type { ToolHost } from '../tool-surface.js';

export type ToolSurface = ToolHost;

type ToolRuntimeSurface = ToolSurface | 'dashboard';

export interface ToolRuntimeContext {
  /** Where this dispatch originated. Runtimes can branch on surface
   *  to attach approval prompts (e.g. dashboard) or skip them
   *  (e.g. skill, which delegates trust to the skill author). */
  surface: ToolRuntimeSurface;
  /** When true, the runtime should treat the invocation as
   *  untrusted and prompt the user before taking side effects.
   *  Runtime may ignore for read-only ops. */
  requireApproval?: boolean;
  /** DI for the HITL prompt. When omitted, runtimes that need
   *  approval fall back to the default requestConfirmation()
   *  channels wired at dashboard startup. */
  approver?: (req: { cmd: string; args?: string[]; cwd?: string }) => Promise<boolean>;
  /** L1 self-dev — fail-OPEN a required approval when no responder
   *  answers (headless / autonomous coding context: autopilot mission
   *  executor, drive-tui). Only coding-tool runtimes (PtyShell) honor
   *  this; the trade / financial path never sets it, so money approvals
   *  stay fail-CLOSED. Opt-in, default undefined (false). See
   *  `ConfirmOpts.failOpen` in `src/hitl/confirm.ts`. */
  failOpen?: boolean;
  /** MCP only — the connected client's `clientInfo.name` from `initialize`
   *  (e.g. `claude-code`, `codex-mcp-client`). Unset on other surfaces. */
  mcpClient?: string;
  /** Cancellation — forwarded to underlying dispatcher when
   *  supported (e.g. streaming fetch, long-running agent calls). */
  signal?: AbortSignal;
  /** Parent catalog and dispatcher inherited by an Agent runtime's child. */
  agentHostTools?: LLMToolSpec[];
  /** Host-selected working directory for an Agent spawned through MCP. */
  agentCwd?: string;
  agentDispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  buildChildToolCatalog?: (cwd: string) => {
    specs: LLMToolSpec[];
    dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    workingDirectory: string;
  };
  /** M5 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) —
   *  optional progress emitter. Runtimes that produce streaming
   *  side effects (bash stdout tail, search hit streaming, edit
   *  diff preview) push FeedbackEnvelopes here so PWA / TUI / iOS
   *  surfaces hydrate progressive cards. Always treat as opt-in:
   *  call sites must null-check, and a missing emitter is the
   *  normal case (skill / mcp surface routes typically omit it).
   *
   *  Wire chain: caller of the runtime (handlePromptStreamPost in
   *  meta-api.ts) constructs a `dualEmitFeedback` closure that
   *  fans the envelope to SSE `feedback` events (PWA) and any
   *  future ACP broadcast. Errors in the emitter are swallowed
   *  upstream — runtimes don't need defensive try/catch. */
  emitFeedback?: (env: FeedbackEnvelope) => void;
  /** M5 — parent tool-call id (Anthropic-style toolCallId) so the
   *  FeedbackEnvelope.parentToolCallId field can be populated for
   *  multi-block correlation in the chat surface. Optional; absent
   *  when the dispatch path doesn't have an LLM-issued id (e.g.
   *  direct skill invocation). */
  toolCallId?: string;
  /** M5 — chat session id used as the envelope.sessionId. Optional;
   *  absent when dispatch doesn't have a session context (e.g.
   *  CLI / startup script use). */
  sessionId?: string;
  /** Session that originated this execution when it was delegated through another runtime session. */
  originSessionId?: string;
}

/** Output shape the LLM layer expects back. Most tools produce
 *  `{ output: string }`; more elaborate shapes (e.g. plugin tools
 *  returning structured JSON) are fine — the LLM just gets the
 *  stringified form.
 *
 *  Image-bearing convention (Phase 1, 2026-05-05): if the result
 *  exposes BOTH `mediaType: 'image/<sub>'` AND `dataB64: string` at
 *  top-level (the WT-C-2 WebTerminalScreenshot shape), the LLM
 *  dispatch wrapper repackages it as an Anthropic-style
 *  `tool_result.content` array — `[{type:'image',...},{type:'text',
 *  text: <other-fields-as-JSON>}]` — so vision-capable models receive
 *  the bytes as actual image input. Other providers fall back to a
 *  text-only metadata note (image dropped). Tools that want to opt in
 *  just need to return those two fields at the top level; the
 *  remaining fields become the metadata text. */
export type ToolRunResult = { output: string } | Record<string, unknown>;

export interface ToolRuntime<Req = Record<string, unknown>, Out extends ToolRunResult = ToolRunResult> {
  /** Canonical id (must match nativeToolCatalog entry id). */
  id: string;
  /** Schema surfaced to the LLM. */
  spec: LLMToolSpec;
  /** Execute the tool. Argument validation is the runtime's
   *  responsibility — parse `req` before using it. */
  run(req: Req, ctx: ToolRuntimeContext): Promise<Out>;
  /** Optional surface declaration for runtimes that aren't in
   *  `nativeToolCatalog` (e.g. MCP proxy runtimes registered at NEXUS
   *  boot from the *active universe's* config `mcp.servers` — resolved
   *  through `effectiveInstanceRoot()`, ⛔ not a hardcoded
   *  `~/.elanous/config.json`). `listToolRuntimes`
   *  checks the catalog first; when there is no catalog entry it
   *  falls back to this field. Set by `createMcpProxyRuntime` to
   *  `['mcp']` so the local MCP server's `tools/list` relay surfaces
   *  every proxied tool to Claude Code / Cursor / Codex. Native
   *  runtimes leave it undefined and rely on the catalog. */
  surfaces?: ToolSurface[];
}
