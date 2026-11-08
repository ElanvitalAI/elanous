import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── PX-3 P1: 5 turn-level hook event types ──
//
// Each hook event has a strict In / Out pair. Plugins register handlers
// keyed by event; the dispatcher collects them per priority and chains
// outputs. See types.ts for HookHandler + HookCtx, dispatcher.ts for
// the invoke semantics.
//
// Scope (DD-PX3-1): 5 events cover the LLM-turn lifecycle we actually
// need today (Turn / Message / ToolCall / SubagentSpawn / StateRestore).
// UserPromptSubmit / SessionEnd / etc. are deferred.

import type { LLMMessage } from '../llm.js';
import type { AgentDefinition } from '../agent/types.js';

export type HookEvent =
  | 'Turn'
  | 'Message'
  | 'ToolCall'
  | 'SubagentSpawn'
  | 'StateRestore';

// ── Turn ────────────────────────────────────────────────────────────
//
// Fires just before the LLM stream call for one turn. Gives hooks a
// chance to inject system-prompt content (Andon banners, budget
// warnings) or prepend extra user messages before the model sees the
// turn. `abort` cancels the turn entirely.

export interface TurnHookInput {
  turnNumber: number;
  messages: readonly LLMMessage[];
  systemPrompt: string;
  tools: readonly { name: string; description?: string }[];
}

export interface TurnHookOutput {
  /** Appended to the system prompt with a blank-line separator. */
  systemPromptInject?: string;
  /** Inserted ahead of the user's message (after system, before user). */
  messagesPrepend?: LLMMessage[];
  /** When set, the turn is cancelled; reason is surfaced to the user. */
  abort?: { reason: string };
}

// ── Message ─────────────────────────────────────────────────────────
//
// Fires after the assistant produces a message (including any
// tool_calls bound to it). Hooks can append follow-up user messages
// (e.g. Kaizen suggestion prompts) or request a routing redirect.

export interface MessageHookInput {
  turnNumber: number;
  role: 'assistant';
  content: string;
  toolCalls?: { name: string; args: unknown }[];
}

export interface MessageHookOutput {
  followupMessages?: LLMMessage[];
  redirectTo?: { kind: 'agent' | 'skill' | 'workflow'; id: string };
}

// ── ToolCall ────────────────────────────────────────────────────────
//
// Fires immediately before a tool is invoked. Gives hooks a chance to
// swap the input (normalization, rate-limiting) or block the call
// (Poka-Yoke, budget exhaustion, permission overlay). The dispatcher's
// matcher lets hooks filter by toolName so a budget guard doesn't
// pay the cost on every non-cost-incurring tool.

export interface ToolCallHookInput {
  turnNumber: number;
  toolName: string;
  input: unknown;
}

export interface ToolCallHookOutput {
  /** When set, replaces the tool's input. */
  modifyInput?: unknown;
  /** Deny the call with a structured reason (becomes tool_result error). */
  deny?: { reason: string };
  /** Explicit allow (default true). Informational — chain continues
   *  regardless; used by admission-log consumers to see which hook said
   *  yes. */
  allow?: boolean;
}

// ── SubagentSpawn ───────────────────────────────────────────────────
//
// Fires when the Agent tool is about to spawn a sub-agent. Gives
// hooks a chance to override the definition (model upgrade, tool
// denylist tightening) or block the spawn (FMEA top-RPN items, budget
// exhaustion).

export interface SubagentSpawnHookInput {
  parentTaskId?: string;
  subagentType: string;
  prompt: string;
  definition: AgentDefinition;
}

export interface SubagentSpawnHookOutput {
  /** Shallow-merged onto the definition before registry.spawn. */
  overrideDefinition?: Partial<AgentDefinition>;
  abort?: { reason: string };
}

// ── StateRestore ────────────────────────────────────────────────────
//
// Fires once per plugin after session re-activation, delivering the
// plugin's persisted state blob. Hooks that maintain cross-session
// derived state (indices, caches) rehydrate here. Output is void —
// no chain-level aggregation is needed for a fire-and-forget restore.

export interface StateRestoreHookInput {
  sessionId: string;
  pluginId: string;
  restoredState: unknown;
}

export type StateRestoreHookOutput = void;

// ── Map: HookEvent → In/Out pair ────────────────────────────────────
//
// Used by the dispatcher's generic dispatch<event>() so callers get
// type inference on output shape without casts.

export interface HookEventMap {
  Turn: { input: TurnHookInput; output: TurnHookOutput };
  Message: { input: MessageHookInput; output: MessageHookOutput };
  ToolCall: { input: ToolCallHookInput; output: ToolCallHookOutput };
  SubagentSpawn: { input: SubagentSpawnHookInput; output: SubagentSpawnHookOutput };
  StateRestore: { input: StateRestoreHookInput; output: StateRestoreHookOutput };
}

export const ALL_HOOK_EVENTS: readonly HookEvent[] = Object.freeze([
  'Turn', 'Message', 'ToolCall', 'SubagentSpawn', 'StateRestore',
]);

/** Type guard — used by manifest parsers + shell-hook adapters that
 *  consume untyped `event` strings from JSON. */
export function isHookEvent(s: unknown): s is HookEvent {
  return typeof s === 'string' && (ALL_HOOK_EVENTS as readonly string[]).includes(s);
}
