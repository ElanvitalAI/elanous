// ── Agent tool (Claude Code-compatible Task spawn) ──
//
// Lets a skill's LLM delegate a focused unit of work to a sub-agent
// running in its own context window. Ports the spawn semantics of
// claude-code-fork's AgentTool: the parent calls Agent({ prompt,
// subagent_type? }), we resolve the named agent (or fall back to
// 'general-purpose'), spawn a fresh task on the global registry, and
// stream its final text back as the tool_result.
//
// Why this exists:
// - Multi-agent skills (e.g. stochastic-multi-agent-consensus) want
//   to fan out N expert personas, each doing independent research with
//   its own omni-crawl/omni-market calls. Without Agent the parent
//   chat LLM has no way to spawn workers, so it just loops re-reading
//   personas.json until TOOL_LOOP_MAX_TURNS_DEFAULT exhausts.
// - Sub-agent contexts are isolated — re-reads of large files (60KB
//   personas.json, factsheets, etc.) live in the child's history and
//   never bloat the parent. The parent only sees the child's final
//   message.
// - Each sub-agent gets its own maxTurns budget (default 20) so a
//   complex worker can do 5+ tool rounds without crowding the
//   parent's loop budget.
//
// Recursion: the sub-agent's tool list excludes Agent itself by
// default — one level of nesting is enough for the use cases we care
// about (skill orchestrator → expert workers → tools). Allowing
// arbitrary nesting risks exponential token spend; revisit if a
// concrete use case demands it.
//
// Debug instrumentation: every spawn / completion / error / tool
// call emits a debug.log event under category `agent.*` so /debug
// mirror users see live progress when sub-agents run inside a skill.

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { debug } from '../../debug/log.js';
import type { LLMToolSpec, LLMProvider } from '../../llm.js';
import {
  globalAgentRegistry, collectAgentText,
} from '../../agent/registry.js';
import '../../agent/task-notification.js';
import { enhanceAgentResultWithSeed } from '../../agent/seed.js';
import { resolveAgent } from '../../agent/loader.js';
import { resolveAgentLayered } from '../../agent/definition-registry.js';
import type { AgentDefinition } from '../../agent/types.js';
import { getSessionCwd } from '../../session/working-dir.js';
import {
  agentCacheKey, dedupeStub, logDedupHit, type SessionCache,
  DEDUP_CASCADE_HALT_THRESHOLD, CONSECUTIVE_DEDUP_BLOCK_THRESHOLD,
} from '../../session/cache.js';

/** Default maxTurns for sub-agents — much higher than the 6-turn
 *  chat default because a focused worker often needs 5–15 rounds of
 *  tool calls (read → search → analyze → format) to finish its task. */
export const AGENT_TOOL_DEFAULT_MAX_TURNS = 20;

/** Hard ceiling regardless of caller-supplied max_turns. Prevents a
 *  pathological skill prompt from spawning 200-turn workers. */
const AGENT_TOOL_TURNS_CEILING = 50;

/** Fallback agent when subagent_type is missing or unresolvable. The
 *  loader picks this up from src/agents/general-purpose.md — built
 *  inline below as a defensive default in case that file is removed. */
const FALLBACK_GENERAL_PURPOSE: AgentDefinition = {
  name: 'general-purpose',
  description: 'Default sub-agent — full tool access, focused execution',
  systemPrompt:
    'You are a sub-agent spawned by a parent task. Run the work in the prompt to ' +
    'completion using the tools you have, then return ONE final message containing ' +
    'the deliverable. Be terse — your output goes back into the parent\'s context.',
  tools: ['Bash', 'Read', 'Edit', 'Grep', 'WebFetch'],
};

export interface AgentToolArgs {
  description: string;
  prompt: string;
  subagent_type?: string;
  max_turns?: number;
  /** ROADMAP-agent-surface-deferred-tools-2026-05-13 Wave 5 E1 —
   *  per-spawn registry isolation (Gemini CLI pattern). When set,
   *  the sub-agent sees ONLY tools whose name is in `allow` and NOT
   *  in `deny`. Composes with the agent-definition's `tools` /
   *  `disallowedTools` lists — the LLM-supplied filter narrows the
   *  intersection further (cannot widen). Use for deep-research /
   *  omni-crawl style spawns where you want a read-only worker.
   *  Empty `allow` = pure text (no tools); omitted = no extra filter. */
  tool_filter?: {
    allow?: string[];
    deny?: string[];
  };
  // ── PFC-S1 P1 additions ─────────────────────────────────────────
  /** When true, dispatcher returns immediately with a taskId. The
   *  child keeps running; completion emits a task-notification
   *  (P2) which the parent sees in the next turn's user message. */
  run_in_background?: boolean;
  /** UI label for this spawn — shown on agent-roster so siblings
   *  sharing a definition are distinguishable. Takes precedence
   *  over `description` as task.label. */
  name?: string;
  /** Team context for this spawn. Stamped on task.teamName so
   *  SendMessage can resolve same-team delivery. When omitted and
   *  the parent is itself a team member, inherits via ambient
   *  context (wired in P4). */
  team_name?: string;
  /** "worktree" creates a new git worktree and pins the child there;
   *  if the session cwd is outside a git repo, it falls back to "cwd"
   *  and reports the applied strategy. "cwd" pins the child to the
   *  current session working directory without creating a worktree. */
  isolation?: 'worktree' | 'cwd';
  /** Permission mode hint injected into the child's system prompt.
   *  'plan' = plan-mode style (no writes), 'auto' = approve-all,
   *  'default' = normal. Prepended as a <system-reminder>. */
  mode?: 'plan' | 'auto' | 'default';
}

export interface AgentToolResult {
  /** Final assistant text — what the parent sees as the tool_result.
   *  For background spawns this is a stub message; the real output
   *  arrives via task-notification (P2). */
  output: string;
  agent: string;
  /** Debug correlation id stamped on every `agent.spawn.*` / `agent.done.*`
   *  / `agent.error.*` record for this dispatch. Returning it makes the
   *  observation axis usable from the CALL SITE: a caller can pair its own
   *  dispatch against the log stream without guessing. Prior to this the id
   *  existed only inside the log payloads, so anyone counting the axis had
   *  to fall back on `dispatch − finish`, which is structurally wrong for
   *  background spawns (see `background-finish` below).
   *
   *  ⚠️ Declared OPTIONAL although `dispatchAgent` sets it on every return
   *  path (all three were audited). The reason is a gate constraint, not a
   *  design one: `scripts/ci-typecheck-changed.ts` escalates any new
   *  *required* field on an exported type to a whole-repository typecheck,
   *  and that scope currently carries 74 pre-existing non-exempt errors
   *  (measured 2026-08-23 against `tsconfig.gate.json`; none of them in this
   *  file). Marking it required would therefore fold someone else's type
   *  debt into this change. Consumers may treat it as always present when
   *  the promise resolves. */
  cid?: string;
  durationMs: number;
  /** Wall-clock turn count we authorised (not the number actually consumed —
   *  the runner doesn't currently expose that, so we report the budget). */
  maxTurns: number;
  taskId: string;
  /** PFC-S1 P1: true when run_in_background was passed. Parent can
   *  use this to route follow-up prompts ("check on task X"). */
  background?: boolean;
  /** Child working directory when an isolation strategy set one. */
  cwd?: string;
  /** Isolation actually applied to the child. A worktree request from a
   *  non-git session falls back to the session cwd and reports `cwd`. */
  isolation?: 'worktree' | 'cwd';
}

export function buildAgentTool(): LLMToolSpec {
  return {
    name: 'Agent',
    description:
      'Delegate a focused unit of work to a sub-agent that runs in its own ' +
      'context window. Use this when:\n' +
      '  • The work would consume a lot of tool output you do not need to keep in your own history (e.g. large file reads, long bash output).\n' +
      '  • You want to fan out N independent workers in parallel — call Agent N times in the same turn; each runs independently.\n' +
      '  • A SKILL.md instructs you to "spawn N expert agents" / "use the Agent tool" — that is exactly this tool.\n' +
      '\n' +
      'The sub-agent gets its own tools (Bash/Read/Edit/Grep/WebFetch by default) and its own ' +
      'turn budget (default 20). It returns ONE final message which becomes your tool_result. ' +
      'Pass everything the worker needs (data, persona, framing) inside `prompt` — the worker ' +
      'starts with no memory of your conversation.',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Short label for the spawned task (3–8 words). Shown in logs / debug mirror.',
        },
        prompt: {
          type: 'string',
          description: 'The full task / instructions for the sub-agent. Be specific and self-contained — the worker has no access to your prior conversation.',
        },
        subagent_type: {
          type: 'string',
          description: 'Optional. Name of a pre-registered agent definition (loaded from src/agents/*.md or ~/.claude/agents/*.md). When omitted, falls back to "general-purpose".',
        },
        max_turns: {
          type: 'number',
          description: `Optional tool-loop budget for the sub-agent. Default ${AGENT_TOOL_DEFAULT_MAX_TURNS}; capped at ${AGENT_TOOL_TURNS_CEILING}. Raise for complex multi-phase work, lower for quick lookups.`,
        },
        run_in_background: {
          type: 'boolean',
          description: 'When true, returns the spawn handle immediately instead of waiting for completion. The child keeps running; its final message arrives in your next turn as a <task-notification> user message. Use for long-running explorations (multi-minute research, 10+ tool calls) so you can keep working in parallel.',
        },
        name: {
          type: 'string',
          description: 'Optional UI label for this spawn (shown in agent-roster / logs). Useful when fanning out N workers with the same subagent_type — give each a distinct name so the roster can tell them apart.',
        },
        team_name: {
          type: 'string',
          description: 'Optional team context. Spawns sharing a team_name can reach each other via SendMessage. Omit for standalone spawns.',
        },
        isolation: {
          type: 'string',
          enum: ['worktree', 'cwd'],
          description: 'Optional isolation strategy. "worktree" creates a fresh git worktree + branch and pins the child there; outside a git repo it falls back to "cwd" and reports that applied value. "cwd" explicitly runs in the session working directory.',
        },
        mode: {
          type: 'string',
          enum: ['plan', 'auto', 'default'],
          description: 'Permission-mode hint for the child. "plan" discourages writes, "auto" approves-all, "default" normal. Prepended to the child system prompt as a reminder; the host permission gate still applies.',
        },
        tool_filter: {
          type: 'object',
          description: 'Optional per-spawn tool registry isolation (Gemini pattern). Omit this field to inherit the parent\'s full available tool registry. Use it only to narrow a child to a focused subset (for example, read-only deep research or a single-purpose worker): it composes with the agent definition\'s allowlist and cannot widen access. Over-narrowing can leave the child unable to complete its task; retain every tool the delegated work needs.',
          properties: {
            allow: {
              type: 'array',
              items: { type: 'string' },
              description: 'Whitelist of tool names the sub-agent may call. Empty array = pure text (no tools). Omitted = no allow constraint.',
            },
            deny: {
              type: 'array',
              items: { type: 'string' },
              description: 'Blacklist of tool names hidden from the sub-agent even if allow includes them.',
            },
          },
          additionalProperties: false,
        },
      },
      required: ['description', 'prompt'],
    },
  };
}

export interface DispatchAgentOpts {
  /** Tools the host makes available — typically the same tool list the
   *  parent skill is using, MINUS the Agent tool itself (no recursion).
   *  When omitted, the sub-agent runs with no tools (text-only). */
  hostTools?: LLMToolSpec[];
  /** Host-selected cwd when there is no parent session (e.g. MCP). */
  cwd?: string;
  /** Dispatcher the parent uses for tool calls. The sub-agent reuses
   *  this so all I/O hits the same Bash/Read/etc. implementations. */
  dispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Trusted host factory for a child-specific catalog. The model never
   *  controls this value; the isolation owner supplies the child cwd. */
  buildChildToolCatalog?: (cwd: string) => {
    specs: LLMToolSpec[];
    dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    workingDirectory: string;
  };
  /** Provider override (test stubs). When omitted, runner picks via
   *  agent definition's `model` field or parent default. */
  provider?: LLMProvider;
  /** Abort signal — sub-agent cancels when the parent skill aborts. */
  signal?: AbortSignal;
  /** Resolver for agent definitions. Defaults to the global cache via
   *  resolveAgent(). Tests inject a stub. */
  resolveAgentDef?: (name: string) => AgentDefinition | undefined;
  /** Session-scoped dedup cache. When a parent loops by re-spawning
   *  the same (description + subagent_type + prompt) we short-circuit
   *  the second attempt with a stub message, freeing turn budget and
   *  preventing the same sub-agent result from re-bloating history. */
  sessionCache?: SessionCache;
  /** P5.1: parent's correlation ID — when this dispatch happens
   *  inside another agent's tool loop, the caller forwards its own
   *  CID so the registry can stamp it on the spawned task. Agent
   *  roster then renders nested agents as a tree. Optional; omitted
   *  at the top-level spawn site (skill-runner → first tool call). */
  parentCorrelationId?: string;
  /** Optional callback for each child tool invocation the sub-agent
   *  issues. Used by the log-pane renderer (Phase F1b) to nest
   *  `  ⎿ Bash(cmd)` / `  ⎿ Read(path)` lines under the parent's
   *  `⏺ Agent(desc)` header. Fires ONCE per child tool_call event
   *  (not on tool_result), so the parent display sees live progress
   *  as the sub-agent works. Ignored when omitted — the streaming
   *  pipeline is unchanged. */
  onChildToolCall?: (event: {
    name: string;
    args: Record<string, unknown>;
    callIdx: number;
  }) => void;
  /** Fires once when the sub-agent finishes — used by the Phase F1c
   *  Done-line renderer to emit `  ⎿ Done (N tool uses · X tokens · Ys)`.
   *  The summary fields are strictly observable from inside dispatchAgent
   *  (tool counter + wall-clock + output/prompt char budgets). Callers
   *  that want real provider-reported tokens wire those in later. */
  onDone?: (summary: {
    toolCount: number;
    durationMs: number;
    outputChars: number;
    promptChars: number;
  }) => void;
}

export async function dispatchAgent(
  args: Record<string, unknown>,
  opts: DispatchAgentOpts = {},
): Promise<AgentToolResult> {
  const description = typeof args.description === 'string' ? args.description.trim() : '';
  const prompt      = typeof args.prompt === 'string' ? args.prompt : '';
  const requestedType = typeof args.subagent_type === 'string' && args.subagent_type.trim()
    ? args.subagent_type.trim()
    : 'general-purpose';
  // Parent LLMs cannot pick the sub-agent's model. We removed the
  // `model` arg from the tool schema because gpt-5.4 parents were
  // down-shifting sub-agents to gpt-5.4-mini (the docstring's
  // example value acted as a bias), which cratered sub-agent output
  // quality. The sub-agent's model is determined by:
  //   1. agent definition's frontmatter `model` field (if set)
  //   2. otherwise parent's configured provider (inherited)
  // TODO(session 16+): add an explicit runtime policy for forcing
  // *stronger* models on spawn (e.g. upgrade mini → full, or lock
  // sub-agents to the parent's resolved model so a mis-configured
  // agent frontmatter can't weaken them).
  const requestedMaxTurns = typeof args.max_turns === 'number' && Number.isFinite(args.max_turns)
    ? Math.max(1, Math.min(AGENT_TOOL_TURNS_CEILING, Math.floor(args.max_turns)))
    : AGENT_TOOL_DEFAULT_MAX_TURNS;

  // PFC-S1 P1: new optional fields.
  const runInBackground = args.run_in_background === true;
  const spawnName = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
  const teamName = typeof args.team_name === 'string' && args.team_name.trim() ? args.team_name.trim() : undefined;
  const isolation = args.isolation === 'worktree' || args.isolation === 'cwd'
    ? args.isolation
    : undefined;
  const mode = args.mode === 'plan' || args.mode === 'auto' || args.mode === 'default' ? args.mode : undefined;

  if (!description) throw new Error('Agent: description is required');
  if (!prompt)      throw new Error('Agent: prompt is required');

  // Minted up-front rather than at the `dispatch` log site so that EVERY
  // exit path — including the dedup short-circuit below, which never reaches
  // that site — can report a correlation id. A caller that gets `cid` back
  // can pair its dispatch against the log stream; a caller that gets the
  // dedup stub still learns which id to look for.
  const debugCorrelationId = randomUUID().slice(0, 8);

  // Session-scoped dedup — if the parent already spawned an Agent
  // with this exact (description + type + prompt) combination, don't
  // burn another turn on the same work. Return a stub that points
  // the parent back to its existing history. Parents stuck in a
  // "keep re-spawning Data Collector" loop escape via this gate.
  if (opts.sessionCache) {
    const key = agentCacheKey(requestedType, requestedType, prompt);
    // Key strategy: description is noisy (parents sometimes vary the
    // label between calls); we hash the FUNCTIONAL signature only
    // — subagent_type + prompt. Same prompt to same agent = same
    // expected work, regardless of how the call was labelled.
    const hit = opts.sessionCache.check(key);
    if (hit) {
      const label = `Agent[${requestedType}] "${description.slice(0, 60)}"`;
      logDedupHit('agent.dedup', label, hit, {
        requestedType,
        description: description.slice(0, 80),
        consecutive: opts.sessionCache.consecutiveHits,
      });

      // Runtime-level block: same treatment as Read. When the parent
      // re-spawns the IDENTICAL Agent call N times in a row without
      // any other tool use in between, throw so the resulting
      // tool_result carries is_error=true. Soft stubs have been
      // observed to produce 6+ retries in the wild; an error break
      // the reflex loop more reliably.
      if (opts.sessionCache.consecutiveHits >= CONSECUTIVE_DEDUP_BLOCK_THRESHOLD) {
        debug.log('agent.dedup', 'consecutive-block', {
          requestedType,
          description: description.slice(0, 80),
          consecutive: opts.sessionCache.consecutiveHits,
          threshold: CONSECUTIVE_DEDUP_BLOCK_THRESHOLD,
        });
        throw new Error(
          `RUNTIME BLOCKED — Agent[${requestedType}] "${description.slice(0, 60)}" ` +
          `has been spawned ${opts.sessionCache.consecutiveHits} times in a row with ` +
          `no intervening progress. The previous sub-agent's final message is in ` +
          `your conversation history above — use that. Spawn an Agent with a ` +
          `DIFFERENT persona (different subagent_type or a substantively different ` +
          `prompt) next turn, OR write your final text answer now. Do NOT repeat ` +
          `this exact spawn.`,
        );
      }

      // Cascade detection kept for forensics only — the HALT message
      // it used to inject was ignored by parent LLMs in practice
      // (session 16 log/debug-20260415144418.log: cascade-halt fired
      // 6× while the parent kept re-spawning regardless) and added
      // ~500 chars of history noise per hit. We now emit the debug
      // event past threshold for traceability but return the normal
      // "spawn a different persona" stub — same message every hit.
      if (opts.sessionCache.totalHits >= DEDUP_CASCADE_HALT_THRESHOLD) {
        debug.log('agent.dedup', 'cascade-threshold', {
          totalHits: opts.sessionCache.totalHits,
          threshold: DEDUP_CASCADE_HALT_THRESHOLD,
          requestedType,
          description: description.slice(0, 80),
        });
      }

      const note =
        `The previous sub-agent's final message is in your conversation above ` +
        `as a tool_result. Use that. If you need additional perspective, spawn ` +
        `an Agent with a DIFFERENT persona (different subagent_type or a ` +
        `substantively different prompt). Do not repeat the same request.`;
      const stub = dedupeStub(label, hit.hits, hit.firstSeenAt, note);
      return {
        output: stub,
        agent: requestedType,
        cid: debugCorrelationId,
        durationMs: 0,
        maxTurns: requestedMaxTurns,
        taskId: 'dedup',
      };
    }
    opts.sessionCache.noteSeen(key, `Agent[${requestedType}] ${description.slice(0, 60)}`);
  }

  // Resolve the agent definition. Try the 4-layer resolver first;
  // on miss fall back to general-purpose. PFC-S1 P1 migrates the
  // default from 2-layer (`resolveAgent`) to 4-layer
  // (`resolveAgentLayered`) so project + plugin-builtin definitions
  // are picked up. Tests + legacy callers keep 2-layer shape by
  // passing their own `resolveAgentDef`.
  const resolver = opts.resolveAgentDef ?? resolveAgentLayered;
  let definition = resolver(requestedType);
  if (!definition && requestedType !== 'general-purpose') {
    definition = resolver('general-purpose');
  }
  if (!definition) {
    // Last resort: also try the 2-layer cache (legacy path) so
    // deployments that only shipped the old loader still work.
    definition = resolveAgent(requestedType) ?? resolveAgent('general-purpose');
  }
  if (!definition) {
    definition = FALLBACK_GENERAL_PURPOSE;
  }

  // PFC-S1 P1: apply `mode` as a prepended system-reminder so the
  // child sees the intended permission posture even when the host
  // gate can't enforce it (plan-mode discipline is advisory for
  // sub-agents — writes still hit the real permission check).
  if (mode) {
    const reminder =
      `<system-reminder>\nYou are running in '${mode}' mode. ` +
      (mode === 'plan'
        ? 'Do not write, edit, or run destructive shell commands — produce a plan only.'
        : mode === 'auto'
          ? 'Approvals are pre-granted for this task; still avoid destructive defaults.'
          : 'Standard permission posture.') +
      `\n</system-reminder>`;
    definition = {
      ...definition,
      systemPrompt: `${reminder}\n\n${definition.systemPrompt}`,
    };
  }

  // PX-3 P5: SubagentSpawn hook — lets plugins override the
  // definition (e.g. force Opus for critic), or abort the spawn
  // outright (e.g. budget exhausted). Zero cost when no handlers.
  {
    const { globalHookDispatcher } = await import('../../plugin-hooks/dispatcher.js');
    if (globalHookDispatcher.list('SubagentSpawn').length > 0) {
      const outcome = await globalHookDispatcher.dispatch('SubagentSpawn', {
        parentTaskId: undefined,
        subagentType: requestedType,
        prompt,
        definition,
      });
      if (outcome.abort) {
        throw new Error(`SubagentSpawn denied by hook: ${outcome.abort.reason}`);
      }
      if (outcome.output.overrideDefinition) {
        definition = { ...definition, ...outcome.output.overrideDefinition };
      }
    }
  }

  // PFC-S1 P1: isolation='worktree' → call EnterWorktree runtime.
  // Imported lazily so unit tests that never touch isolation don't
  // drag the git-fs stack into their module graph.
  let childCwd: string | undefined;
  let appliedIsolation: AgentToolResult['isolation'];
  if (isolation === 'cwd') {
    childCwd = opts.cwd ?? getSessionCwd();
    appliedIsolation = 'cwd';
    debug.log('agent.spawn', 'cwd', { agent: definition.name, cwd: childCwd });
  } else if (isolation === 'worktree') {
    const { enterWorktreeRuntime } = await import('../../tool-runtime/git-worktree-runtimes.js');
    const wtName = `${spawnName ?? definition.name}-${debugCorrelationId}`.replace(/[^a-zA-Z0-9._/-]/g, '-');
    try {
      const wt = await enterWorktreeRuntime.run({ name: wtName }, { surface: 'skill' as any });
      childCwd = wt.path;
      appliedIsolation = 'worktree';
      debug.log('agent.spawn', 'worktree', {
        cid: debugCorrelationId,
        agent: definition.name,
        worktreePath: wt.path,
        branch: wt.branch,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('is not inside a git repo')) throw error;
      childCwd = opts.cwd ?? getSessionCwd();
      appliedIsolation = 'cwd';
      debug.log('agent.spawn', 'worktree-fallback-cwd', {
        agent: definition.name,
        cwd: childCwd,
        requestedIsolation: 'worktree',
        reason: message,
      }, { level: 'warn' });
    }
  } else {
    childCwd = opts.cwd ?? getSessionCwd();
    debug.log('agent.spawn', 'inherited-cwd', { agent: definition.name, cwd: childCwd });
  }

  let childDispatchTool = opts.dispatchTool;
  let childTools = opts.hostTools ?? [];
  if (childCwd && opts.buildChildToolCatalog) {
    let catalog: ReturnType<NonNullable<DispatchAgentOpts['buildChildToolCatalog']>>;
    try {
      catalog = opts.buildChildToolCatalog(childCwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug.log('agent.spawn', 'tool-cwd-mismatch', {
        cid: debugCorrelationId,
        agent: definition.name,
        assignedCwd: childCwd,
        reason: 'catalog-factory-failed',
        error: message,
      }, { level: 'warn' });
      throw error;
    }
    childTools = catalog.specs;
    childDispatchTool = catalog.dispatch;
    const canonicalDirectory = (cwd: string): string => {
      try {
        return realpathSync(cwd);
      } catch {
        return resolve(cwd);
      }
    };
    if (canonicalDirectory(catalog.workingDirectory) !== canonicalDirectory(childCwd)) {
      debug.log('agent.spawn', 'tool-cwd-mismatch', {
        cid: debugCorrelationId,
        agent: definition.name,
        assignedCwd: childCwd,
        toolCwd: catalog.workingDirectory,
        reason: 'catalog-working-directory-mismatch',
      }, { level: 'warn' });
    }
  } else if (appliedIsolation === 'worktree') {
    debug.log('agent.spawn', 'tool-cwd-mismatch', {
      cid: debugCorrelationId,
      agent: definition.name,
      assignedCwd: childCwd,
      reason: 'catalog-unavailable-parent-tools-inherited',
    }, { level: 'warn' });
  }

  // Strip the Agent tool itself from the sub-agent's available tools.
  // One level of nesting only — see file header rationale.
  childTools = childTools
    .filter(t => t.name !== 'Agent');
  // Wave 5 E1 — apply per-spawn tool_filter. Narrows the intersection
  // further (cannot widen the host's allowlist). When `allow` is
  // explicit-empty `[]`, the worker runs text-only.
  const toolFilter = (args.tool_filter && typeof args.tool_filter === 'object' && !Array.isArray(args.tool_filter))
    ? args.tool_filter as { allow?: unknown; deny?: unknown }
    : undefined;
  if (toolFilter) {
    const availableToolCount = childTools.length;
    const allowList = Array.isArray(toolFilter.allow)
      ? new Set((toolFilter.allow as unknown[]).filter((n): n is string => typeof n === 'string'))
      : null;
    const denyList = Array.isArray(toolFilter.deny)
      ? new Set((toolFilter.deny as unknown[]).filter((n): n is string => typeof n === 'string'))
      : null;
    childTools = childTools.filter((t) => {
      if (denyList && denyList.has(t.name)) return false;
      if (allowList && !allowList.has(t.name)) return false;
      return true;
    });
    debug.log('agent.spawn', 'tool-filter', {
      allowSize: allowList?.size,
      denySize: denyList?.size,
      available: availableToolCount,
      remaining: childTools.length,
      removed: availableToolCount - childTools.length,
    });
  }

  const hasNoTools = childTools.length === 0;
  const childPrompt = hasNoTools
    ? `${prompt}\n\nNo tools are available; if a request requires reading files or executing commands, report that as unavailable rather than guessing.`
    : prompt;

  debug.log('agent.spawn', 'dispatch', {
    cid: debugCorrelationId,
    requestedType,
    resolvedAgent: definition.name,
    description: description.slice(0, 80),
    promptChars: childPrompt.length,
    model: definition.model || '(inherit)',
    maxTurns: requestedMaxTurns,
    tools: childTools.map(t => t.name),
    noTools: hasNoTools,
  });

  const startedAt = Date.now();
  const handle = globalAgentRegistry.spawn({
    definition,
    prompt: childPrompt,
    label: spawnName ?? description,   // PFC-S1 P1: explicit `name`
                          // wins, else fall back to the task label
                          // (kept for existing callers).
    tools: childTools,
    dispatchTool: childDispatchTool,
    provider: opts.provider,
    maxTurns: requestedMaxTurns,
    // P5.1: stamp the correlation ID on the registry task so the
    // display surface + debug pane can link back to debug.log
    // payloads for this exact spawn. parentCorrelationId comes from
    // the caller (skill-runner) when this agent was dispatched by
    // another agent's tool loop — lets the roster render a tree.
    correlationId: debugCorrelationId,
    ...(opts.parentCorrelationId ? { parentCorrelationId: opts.parentCorrelationId } : {}),
    // PFC-S1 P1: team / cwd / background are carried on the task so
    // roster + task-notification (P2) + SendMessage (P4) can read
    // them without re-threading through AgentToolArgs.
    ...(teamName ? { teamName } : {}),
    ...(childCwd ? { cwd: childCwd } : {}),
    ...(runInBackground ? { background: true } : {}),
  });

  // Forward parent abort to the spawned task. The registry owns the
  // child's controller; we just chain ours into it.
  if (opts.signal) {
    if (opts.signal.aborted) globalAgentRegistry.abort(handle.task.id);
    else opts.signal.addEventListener(
      'abort',
      () => globalAgentRegistry.abort(handle.task.id),
      { once: true },
    );
  }

  // PFC-S1 P1: background spawn — kick the event stream off-thread
  // and return a stub result immediately. The drain still advances
  // the task state (running → done/error/aborted); completion is
  // surfaced to the parent via task-notification (P2). We drain into
  // a no-op here; P2 will wrap this with registry.onTaskDone.
  if (runInBackground) {
    debug.log('agent.spawn', 'background', {
      cid: debugCorrelationId,
      agent: definition.name,
      taskId: handle.task.id,
      ...(childCwd ? { cwd: childCwd } : {}),
      ...(appliedIsolation ? { isolation: appliedIsolation } : {}),
      ...(teamName ? { teamName } : {}),
    });
    void (async () => {
      try {
        // Drain silently — events keep the task state moving. P2
        // listens via registry.onTaskDone to emit task-notification.
        for await (const _ev of handle.events) {
          void _ev;
        }
        // ⭐ A0 (#7333) — the drain used to succeed with NO log at all, so a
        // backgrounded spawn NEVER produced an `agent.done` record. Terminal
        // state did exist, but only on a DIFFERENT category
        // (`agent.task-routing/auto-foreground-on-completion`), so anyone
        // counting this axis as `dispatch − finish` scored every background
        // spawn as "unaccounted". Measured 2026-08-23: dispatch 15 = finish 10
        // + background 4 + 1 genuinely unpaired — i.e. 4 of the 5 apparent
        // gaps were this hole. Emitting the terminal event on the SAME axis
        // makes the obvious ruler the correct one.
        debug.log('agent.done', 'background-finish', {
          cid: debugCorrelationId,
          agent: definition.name,
          taskId: handle.task.id,
          taskState: handle.task.state,
          durationMs: Date.now() - startedAt,
        });
      } catch (err: any) {
        debug.log('agent.error', 'background-drain', {
          cid: debugCorrelationId,
          agent: definition.name,
          message: err?.message || String(err),
        }, { level: 'error' });
      }
    })();
    return {
      output: `(running in background — taskId=${handle.task.id})`,
      agent: definition.name,
      cid: debugCorrelationId,
      durationMs: 0,
      maxTurns: requestedMaxTurns,
      taskId: handle.task.id,
      background: true,
      ...(childCwd ? { cwd: childCwd } : {}),
      ...(appliedIsolation ? { isolation: appliedIsolation } : {}),
    };
  }

  // Per-tool-call mirror so /debug tail shows the worker's activity
  // inline. Done by intercepting the event stream — collectAgentText
  // is too coarse for this, so we drain manually.
  let output = '';
  let toolCalls = 0;
  // P5.2: remember tool_call start times keyed by tool-call id so
  // tool_result events can compute durationMs. Small map cleared on
  // per-call resolution; bounded by concurrency inside one agent.
  const pendingToolStarts = new Map<string, { idx: number; startedAt: number; tool: string; args: Record<string, unknown> }>();
  try {
    for await (const ev of handle.events) {
      if (ev.type === 'text') {
        output += ev.delta;
      } else if (ev.type === 'tool_call') {
        toolCalls++;
        debug.log('agent.tool', 'call', {
          cid: debugCorrelationId,
          agent: definition.name,
          tool: ev.name,
          callIdx: toolCalls,
        });
        // Forward to the parent's log-pane renderer so the sub-agent's
        // tool activity appears nested under the `⏺ Agent(...)` header.
        // The callback is callback-tolerant: any exception in the
        // renderer must not kill the sub-agent run.
        if (opts.onChildToolCall) {
          try {
            opts.onChildToolCall({ name: ev.name, args: ev.args, callIdx: toolCalls });
          } catch (err: any) {
            debug.log('agent.tool', 'onChildToolCall.error', {
              cid: debugCorrelationId,
              message: err?.message || String(err),
            }, { level: 'error' });
          }
        }
        // P5.2: detail-level tool-call event for the timeline pane.
        // Gated on isDetailEnabled so trail/normal pay zero cost.
        if (debug.isDetailEnabled()) {
          const startedAt = Date.now();
          pendingToolStarts.set(ev.id, { idx: toolCalls, startedAt, tool: ev.name, args: ev.args });
          globalAgentRegistry.emitToolCall({
            agentId: handle.task.id,
            correlationId: debugCorrelationId,
            callIdx: toolCalls,
            tool: ev.name,
            args: ev.args,
            phase: 'start',
            ts: startedAt,
          });
        }
      } else if (ev.type === 'tool_result') {
        // P5.2: pair with the 'start' to compute durationMs. Only
        // fires when detail level saw the start, so trail/normal
        // remain zero-cost. Also captures a size-bounded stringified
        // result so the timeline can show a preview without carrying
        // MB of tool output per event.
        if (debug.isDetailEnabled()) {
          const start = pendingToolStarts.get(ev.id);
          if (start) {
            pendingToolStarts.delete(ev.id);
            const now = Date.now();
            let resultStr: string;
            try {
              resultStr = typeof ev.result === 'string'
                ? ev.result
                : JSON.stringify(ev.result);
            } catch {
              resultStr = String(ev.result);
            }
            if (resultStr.length > 1024) resultStr = resultStr.slice(0, 1024) + `…(+${resultStr.length - 1024}c)`;
            globalAgentRegistry.emitToolCall({
              agentId: handle.task.id,
              correlationId: debugCorrelationId,
              callIdx: start.idx,
              tool: start.tool,
              args: start.args,
              phase: 'result',
              result: resultStr,
              durationMs: now - start.startedAt,
              ts: now,
            });
          }
        }
      } else if (ev.type === 'done') {
        output = ev.text;
        break;
      } else if (ev.type === 'error') {
        debug.log('agent.error', 'failed', {
          cid: debugCorrelationId,
          agent: definition.name,
          message: ev.message,
          durationMs: Date.now() - startedAt,
        }, { level: 'error' });
        throw new Error(`Agent[${definition.name}]: ${ev.message}`);
      } else if (ev.type === 'status' && ev.stage === 'aborted') {
        debug.log('agent.error', 'aborted', {
          cid: debugCorrelationId,
          agent: definition.name,
          durationMs: Date.now() - startedAt,
        }, { level: 'error' });
        throw new Error(`Agent[${definition.name}]: aborted`);
      }
    }
  } catch (err: any) {
    if (!handle.task.error) {
      handle.task.error = err?.message || String(err);
    }
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  debug.log('agent.done', 'finish', {
    cid: debugCorrelationId,
    agent: definition.name,
    durationMs,
    outputChars: output.length,
    toolCalls,
    taskState: handle.task.state,
  });

  // Phase F1c: notify the caller so it can emit the Done summary
  // line (`  ⎿ Done (N tool uses · X tokens · Ys)`) in the log pane.
  // Fires after the final output is settled so outputChars reflects
  // the real deliverable. onDone is best-effort — renderer errors
  // are swallowed like onChildToolCall so the caller's await resolves.
  if (opts.onDone) {
    try {
      opts.onDone({
        toolCount: toolCalls,
        durationMs,
        outputChars: output.length,
        promptChars: prompt.length,
      });
    } catch (err: any) {
      debug.log('agent.done', 'onDone.error', {
        cid: debugCorrelationId,
        message: err?.message || String(err),
      }, { level: 'error' });
    }
  }

  // PLAN §4.5 (Arc 2.1) — append a `<subagent-signal>` block to the
  // tool_result text when the child's final message contains
  // recognisable file/test/error signals. The parent LLM then sees
  // the digest in canonical positions and doesn't have to re-scan
  // the child's prose to identify the next inspect target. Pass-
  // through when the heuristic extracts nothing.
  const enrichedOutput = enhanceAgentResultWithSeed(output);

  return {
    output: enrichedOutput,
    agent: definition.name,
    cid: debugCorrelationId,
    durationMs,
    maxTurns: requestedMaxTurns,
    taskId: handle.task.id,
    ...(childCwd ? { cwd: childCwd } : {}),
    ...(appliedIsolation ? { isolation: appliedIsolation } : {}),
  };
}
