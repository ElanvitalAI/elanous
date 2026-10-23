// ── Agent runtime types ──
//
// Phase B: types only. No side effects — just the shapes shared between
// the registry (src/agent/registry.ts), runner (src/agent/runner.ts),
// and future agent definitions (Phase C).
//
// Keep this file provider-agnostic: it depends on src/llm.ts for the
// ContentBlock / LLMMessage shape, nothing else.

import type { LLMMessage, LLMToolSpec, LLMProvider } from '../llm.js';
import type { AgentUri } from '../mss/uri/brand.js';

/** Declarative description of an agent — what model to run, what
 *  system prompt to wear, what tools it may call. Typically loaded
 *  from `~/.claude/agents/<name>.md` (Phase C) or constructed in
 *  code for tests / built-ins.
 *
 *  PFC PX-1 extension (2026-04-18): CrewAI 3-tuple (role/goal/backstory),
 *  permission/effort/isolation/omitInheritedContext fields, disallowedTools,
 *  and `source`/`sourcePath` for layer tracking. All new fields are
 *  optional — existing callers (general-purpose, aggregator,
 *  data-collector, consensus-trader) keep working unchanged. */
export interface AgentDefinition {
  /** Stable identifier (matches the filename for disk-loaded agents). */
  name: string;
  /** Optional model override. When unset the runner picks via
   *  getProvider() against the parent's default. */
  model?: string;
  /** System prompt body. The runner may optionally prepend a parent-
   *  supplied prefix (see AgentSpawnOpts.systemPromptPrefix). */
  systemPrompt: string;
  /** Tool allowlist. `undefined` = inherit all host tools; empty array
   *  = disallow every tool (pure text agent); non-empty = only these
   *  names resolve. Phase B honours this at spawn time. */
  tools?: string[];
  /** PFC PX-1: tool denylist. Applied AFTER tools allowlist. */
  disallowedTools?: string[];
  /** Skill SKILL.md names to preload into system prompt (Phase C). Not
   *  consumed in Phase B — kept on the type so future phases don't
   *  reshape this interface. */
  skills?: string[];
  /** Optional hint for humans / debug panes. Doesn't affect behaviour. */
  description?: string;

  // ── PFC PX-1 CrewAI 3-tuple (optional, prepended by composeSystemPrompt) ──
  role?: string;
  goal?: string;
  backstory?: string;

  // ── PFC PX-1 operational hints (consumed by future PFC S1 Agent tool) ──
  permissionMode?: 'read-only' | 'default' | 'plan' | 'auto';
  effort?: 'trivial' | 'low' | 'medium' | 'high' | 'expert' | number;
  maxTurns?: number;
  isolation?: 'worktree' | 'cwd';
  /** Omits parent-provided context and the project preamble, while retaining this agent's instructions. */
  omitInheritedContext?: boolean;
  background?: boolean;
  color?: string;

  // ── PFC PX-1 layer tracking (set by loader, read by definition-registry) ──
  /** Which layer this def came from. 'builtin' = src/agents/ (shipped),
   *  'plugin-builtin' = plugins/<name>/agents/, 'user' = ~/.claude/agents/ or
   *  ~/.elanous/agents/, 'project' = <cwd>/.elanous/agents/. Kept on the type
   *  so panes / layered-registry can show provenance. */
  source?: 'builtin' | 'plugin-builtin' | 'user' | 'project';
  /** Absolute path the def was parsed from — debug/trace only. */
  sourcePath?: string;
}

/** Runtime state of one spawned agent. Registry owns the authoritative
 *  copy; callers may hold references but should not mutate fields
 *  other than by going through registry methods. */
export interface AgentTask {
  id: string;
  definition: AgentDefinition;
  /** Caller-supplied short label for this specific spawn — distinct
   *  from `definition.description` which is the boilerplate stamp
   *  shared by all tasks that reuse the same AgentDefinition.
   *  dispatchAgent populates this from the Agent tool's `description`
   *  argument so the dashboard agent-roster can show the *task*'s
   *  purpose ("Data collector Samsung facts") rather than the
   *  definition's generic blurb ("Default sub-agent for delegated
   *  work — full tool access"). */
  label?: string;
  /** 'pending' before runAgent starts, 'running' while the generator
   *  yields events, 'done' when runAgent returns, 'error' on throw,
   *  'aborted' when the caller cancelled via AbortController. */
  state: AgentState;
  /** Prompt the agent was spawned with (often just the user query). */
  prompt: string;
  /** Full message history as the runner built it — starts with a
   *  system message + user prompt and grows with tool rounds. */
  messages: LLMMessage[];
  /** Tool calls the child has made so far, counted live as each call starts.
   *  `messages` only grows when a tool loop completes (and never on abort/error),
   *  so a roster that counted messages alone showed «0 tools» for a working child. */
  toolCallCount?: number;
  /** Final assistant text once the run completes. */
  result?: string;
  /** Error message when state === 'error'. */
  error?: string;
  /** Wall-clock timestamps for basic observability. */
  startedAt?: number;
  finishedAt?: number;
  /** AbortController — the registry owns it; callers abort via
   *  registry.abort(id) rather than touching this directly. */
  controller: AbortController;
  /** P5.1: stable short ID (e.g. 8-hex-chars) a caller can stamp on
   *  debug events + display events + log rows belonging to this
   *  agent. Lets the debug / agent-detail panes cross-reference
   *  "which events came from this spawn?". skill-tool-agent
   *  generates it once per spawn and passes it through
   *  AgentSpawnOpts.correlationId. Undefined = not set by the
   *  caller (tests, early code paths). */
  correlationId?: string;
  /** P5.1: when this agent was spawned BY ANOTHER agent (nested),
   *  carries the parent's correlation ID so agent-roster can draw
   *  the tree. AgentSpawnOpts already has parentTaskId but that's
   *  the registry-local UUID; correlationId is the shorter tracer
   *  ID that matches debug.log payloads. */
  parentCorrelationId?: string;
  /** ROADMAP-agent-surface-deferred-tools-2026-05-13 Wave 3 W3.4 —
   *  the parent task's registry id (the UUID `AgentRegistry.spawn`
   *  returns). Carries the spawn-time parent so `abortCascade` can
   *  walk the descendant tree. Distinct from `parentCorrelationId`
   *  which is the debug-tracer shortcode — that one is for renderers,
   *  not foreign-key lookups. Populated by `registry.spawn` when the
   *  caller passes `AgentSpawnOpts.parentTaskId`. */
  parentTaskId?: string;
  /** ROADMAP-agent-surface-deferred-tools-2026-05-13 Wave 5 E3 —
   *  HOP_CAP depth. Top-level spawns (no `parentTaskId`) get depth 0;
   *  each nested spawn adds 1. `registry.spawn` rejects when the
   *  derived depth would exceed `AGENT_HOP_CAP` so a pathological
   *  agent can't recursively spawn itself into oblivion. Optional on
   *  the type (legacy test fixtures + ad-hoc `register()` calls may
   *  omit it) but always populated by `registry.spawn` / `register`
   *  — readers should treat absence as 0. */
  depth?: number;
  /** PFC-S1 P1: team this task belongs to. Populated by the Agent
   *  tool's `team_name` arg (or the ambient team context). Used by
   *  SendMessage (PFC-S1 P4) to resolve same-team delivery and by
   *  future roster panes to group sibling tasks. */
  teamName?: string;
  /** PFC-S1 P1: working directory the child runs in. When
   *  `isolation === 'worktree'` this is the worktree path, otherwise
   *  it falls back to the parent's session cwd. Kept on the task so
   *  roster panes can show which worktree each task is editing. */
  cwd?: string;
  /** PFC-S1 P1: true when this task was spawned with
   *  `run_in_background`. The dispatcher returns immediately and
   *  the runner drains events in the background; completion emits
   *  a task-notification (PFC-S1 P2). */
  background?: boolean;
  /** MSS M1.2: branded URI form of this spawn's identity. The
   *  registry mints one alongside the UUID-keyed `id`. Downstream
   *  MSS bridges (M3 signal sender · M4 memory participant) reference
   *  this rather than the raw UUID so cross-track payloads stay typed. */
  agentUri?: AgentUri;
}

export type AgentState = 'pending' | 'running' | 'done' | 'error' | 'aborted';

/** Streaming events a consumer sees while a task runs. Mirrors
 *  LLMStreamEvent at the text/tool_call level, plus status transitions
 *  and a terminal `done`/`error` frame so subscribers can unsubscribe
 *  cleanly without polling task.state. */
export type AgentEvent =
  | { type: 'status'; stage: AgentStage }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; result: unknown }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

export type AgentStage = 'queued' | 'thinking' | 'tool' | 'aborted' | 'done' | 'error';

/** Options accepted by registry.spawn(). Everything optional so tests
 *  can pass just `{ definition, prompt }` and rely on defaults. */
export interface AgentSpawnOpts {
  definition: AgentDefinition;
  /** User message / query the agent should answer. */
  prompt: string;
  /** Short task label — used by UI panes (e.g. agent-roster in
   *  wd-scratch) to distinguish spawns that share a definition.
   *  Stored verbatim on AgentTask.label. Optional; when omitted,
   *  consumers fall back to `definition.description` / `definition.name`. */
  label?: string;
  /** Tools the host makes available. The runner filters these to
   *  definition.tools before calling the provider; dispatch goes
   *  through the supplied `dispatchTool` handler. */
  tools?: LLMToolSpec[];
  dispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** When set, prepended (with a blank line) to definition.systemPrompt
   *  so multiple agents sharing a parent context hit the same cache
   *  prefix. Typical use: the dashboard/plugin's pre-rendered system
   *  text. Pass the exact same bytes across sibling spawns. */
  systemPromptPrefix?: string;
  /** Provider override (for tests — stub LLM without env vars). */
  provider?: LLMProvider;
  /** Max tool-loop turns override (defaults to streamLLMWithTools's 6). */
  maxTurns?: number;
  /** Link to a parent task (set by registry.spawn when called from
   *  another agent's dispatch handler — enables Phase F log threading). */
  parentTaskId?: string;
  /** P5.1: stable correlation ID the caller has already generated
   *  for debug.log payloads. When present, registry stamps it on
   *  the AgentTask so subscribers (debug pane, agent surface) can
   *  cross-reference. */
  correlationId?: string;
  /** P5.1: when this is a nested spawn, the parent agent's
   *  correlation ID. Surface uses it to render the roster as a
   *  tree. */
  parentCorrelationId?: string;
  /** PFC-S1 P1: team context for this spawn — stored on the task so
   *  SendMessage can resolve same-team delivery from ambient state. */
  teamName?: string;
  /** PFC-S1 P1: explicit cwd for the child. Runner forwards this to
   *  the dispatchTool handler so every tool the child invokes lands
   *  in the right path. When omitted, child inherits parent cwd. */
  cwd?: string;
  /** PFC-S1 P1: when true, the dispatcher returns the handle
   *  immediately and drains events off-thread. Completion emits a
   *  task-notification (see src/agent/task-notification.ts, P2). */
  background?: boolean;
  /** MSS M1.2: when the caller has already minted an AgentUri (e.g. a
   *  parent spawn pre-allocating ids for tracing), pass it here.
   *  Otherwise registry.spawn mints one. */
  agentUri?: AgentUri;
}
