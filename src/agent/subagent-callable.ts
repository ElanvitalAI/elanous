// ── Surface-Agnostic TOX × Agent registry bridge ──
//
// Phase 2 of RESEARCH-tox-surface-agnostic-boot-2026-05-13. Builds a
// `SubagentCallable` (the contract TOX's subagent surface adapter
// expects) backed by the process-wide `globalAgentRegistry`. NEXUS
// boot wires this so any TOX task with `surface.kind === 'subagent'`
// auto-spawns through the same registry that the `Agent` LLM tool
// uses — one source of truth for live AgentTasks across PWA, iPhone,
// dashboard, MCP, future surfaces.
//
// Lifecycle:
//   - `address` returned synchronously = AgentTask.id (UUID), which
//     pairs with `AgentOutput(taskId, …)` / `AgentStop(taskId)` /
//     `agent-status-bridge` from Wave 1.
//   - `done` resolves when the runner finishes. We drain the event
//     stream to accumulate the final assistant text + measure
//     wall-clock, then return the contract-shaped `{ status, output,
//     durationMs, modelId }`.
//   - External `signal` cancellation chains into the task's own
//     AbortController. Aborts surface as `status: 'cancelled'` to the
//     adapter (TOX folds that into execution state 'cancelled').
//
// Caller convention: pass `definitionName` through `resolveAgentLayered`
// before reaching us if you need fallback behaviour. Here we trust the
// caller — definition lookup is the adapter's job (it has access to
// the 4-layer agent loader). If `definitionName` doesn't resolve, we
// fail loud with status='failed' + an error message in `output`.

import { resolveAgentLayered } from './definition-registry.js';
import { resolveAgent } from './loader.js';
import { globalAgentRegistry } from './registry.js';
import type { AgentRegistry } from './registry.js';
import type { LLMProvider, LLMToolSpec } from '../llm.js';
import type { SubagentCallable } from '../task-orchestrator/surfaces/subagent.js';

export interface CreateSubagentCallableOpts {
  /** Defaults to `globalAgentRegistry`. Tests inject a fresh
   *  AgentRegistry to avoid bleed between cases. */
  registry?: AgentRegistry;
  /** Defaults to `resolveAgentLayered` (4-layer disk loader). Tests
   *  inject a synchronous lookup table so they don't touch the
   *  filesystem. */
  resolveDefinition?: (name: string) => ReturnType<typeof resolveAgentLayered>;
  /** Same catalog and dispatcher supplied to the host's interactive agent tools. */
  hostTools?: LLMToolSpec[];
  dispatchTool?: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  provider?: LLMProvider;
  cwd?: string;
}

/** Surface-agnostic factory — returns a `SubagentCallable` ready to
 *  pass to `wireTox({ surfaces: { subagent: ... } })`. */
export function createGlobalSubagentCallable(
  opts: CreateSubagentCallableOpts = {},
): SubagentCallable {
  const registry = opts.registry ?? globalAgentRegistry;
  // The 4-layer map loads the builtin layer only when a builtin dir is passed, so the
  // builtins (`general-purpose` …) were missing here while chat's Agent tool had them
  // (2026-09-27 dogfood: every TOX `run` task failed «'general-purpose' not found»).
  // Fall back to the builtin loader — the same order `dispatchAgent` uses.
  const resolveDefinition = opts.resolveDefinition ?? ((name: string) => resolveAgentLayered(name) ?? resolveAgent(name));

  return async ({ definitionName, prompt, model, signal }) => {
    const startedAt = Date.now();
    const definition = resolveDefinition(definitionName);
    if (!definition) {
      // Synthesise a done promise that immediately reports failure so
      // the adapter's contract is still honoured (it always awaits
      // `done`). `address` is a stable but non-real id so debug
      // tooling has something to print.
      const address = `subagent:unknown:${definitionName}`;
      return {
        address,
        done: Promise.resolve({
          status: 'failed' as const,
          output: `subagent definition '${definitionName}' not found in the 4-layer registry`,
          durationMs: Date.now() - startedAt,
        }),
      };
    }

    // Optional `model` override — fold into the definition copy so we
    // don't mutate the cached version (definition-registry hands back
    // a shared reference).
    const effectiveDefinition = model
      ? { ...definition, model }
      : definition;

    const allowed = new Set(effectiveDefinition.tools ?? []);
    const denied = new Set(effectiveDefinition.disallowedTools ?? []);
    const tools = (opts.hostTools ?? []).filter(tool =>
      tool.name !== 'Agent' && allowed.has(tool.name) && !denied.has(tool.name));
    const permittedNames = new Set(tools.map(tool => tool.name));
    if (allowed.size > 0 && (tools.length === 0 || !opts.dispatchTool)) {
      return {
        address: `subagent:no-tools:${definitionName}`,
        done: Promise.resolve({
          status: 'failed' as const,
          output: `no-tools: definition '${definitionName}' requires [${[...allowed].join(', ')}]; host tool count=${opts.hostTools === undefined ? 'unknown' : opts.hostTools.length}; usable=${tools.length}; dispatchTool=${Boolean(opts.dispatchTool)}`,
          durationMs: Date.now() - startedAt,
        }),
      };
    }

    let childSignal: AbortSignal | undefined;
    const handle = registry.spawn({
      definition: effectiveDefinition,
      prompt,
      tools,
      dispatchTool: opts.dispatchTool
        ? async (name, args) => {
          if (!permittedNames.has(name)) throw new Error(`subagent tool '${name}' is not allowed`);
          return opts.dispatchTool!(name, args, childSignal);
        }
        : undefined,
      provider: opts.provider,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    childSignal = handle.task.controller?.signal;

    // External cancellation: chain caller signal into the registry's
    // own AbortController. Idempotent — registry.abort is a no-op on
    // already-terminal tasks. Both directions: caller aborts ⇒ task
    // aborts; task aborts internally ⇒ caller's signal stays clean
    // (no reverse fan).
    if (signal) {
      if (signal.aborted) registry.abort(handle.task.id);
      else signal.addEventListener('abort', () => registry.abort(handle.task.id), { once: true });
    }

    const address = handle.task.id;
    const done = drainToResult(handle.events, () => ({
      durationMs: Date.now() - startedAt,
      modelId: effectiveDefinition.model,
    }));

    return { address, done };
  };
}

/** Drain the AgentEvent stream and produce the SubagentCallable
 *  contract shape. We accumulate text deltas as a fallback for
 *  callers/tests; `done` events carry the runner's canonical final
 *  text and win when present. */
async function drainToResult(
  events: AsyncGenerator<
    | { type: 'text'; delta: string }
    | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
    | { type: 'tool_result'; id: string; name: string; result: unknown }
    | { type: 'done'; text: string }
    | { type: 'error'; message: string }
    | { type: 'status'; stage: string },
    void,
    unknown
  >,
  closing: () => { durationMs: number; modelId?: string },
): Promise<{
  status: 'completed' | 'failed' | 'cancelled';
  output: string;
  durationMs: number;
  modelId?: string;
}> {
  let accumulated = '';
  let final: string | null = null;
  let errorMsg: string | null = null;
  let aborted = false;
  try {
    for await (const ev of events) {
      switch (ev.type) {
        case 'text':
          accumulated += ev.delta;
          break;
        case 'done':
          final = ev.text;
          break;
        case 'error':
          errorMsg = ev.message;
          break;
        case 'status':
          if (ev.stage === 'aborted') aborted = true;
          break;
        default:
          // tool_call / tool_result — not folded into output
          break;
      }
    }
  } catch (err) {
    errorMsg = errorMsg ?? (err instanceof Error ? err.message : String(err));
  }

  const close = closing();
  const baseModel = close.modelId ? { modelId: close.modelId } : {};
  if (aborted) {
    return { status: 'cancelled', output: accumulated, durationMs: close.durationMs, ...baseModel };
  }
  if (errorMsg !== null) {
    return { status: 'failed', output: errorMsg, durationMs: close.durationMs, ...baseModel };
  }
  return {
    status: 'completed',
    output: final ?? accumulated,
    durationMs: close.durationMs,
    ...baseModel,
  };
}
