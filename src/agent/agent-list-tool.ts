import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── AgentList LLM tool (PFC PX-1 Phase 6) ──
//
// Read-only introspection of the 4-layer agent-definition registry.
// Used by the chat LLM to decide which `subagent_type` to pass to the
// Agent tool (src/skill-tool-agent.ts), and by humans running the tool
// manually from /plugin aiTools.
//
// Parallel-safe. No side effects. No network. Touches only the
// filesystem (read) via loadAgentsLayered — so a stale cache is never
// a risk: every call rescans.
//
// NOTE: does NOT spawn agents. Spawning is the Agent tool's job.
// Separation keeps the "observe registry" and "invoke an agent"
// concerns orthogonal — useful when the LLM wants to reason about the
// agent catalog before committing to a spawn.


import { debug } from '../debug/log.js';
import { loadAgentsLayered } from './definition-registry.js';
import type { LayeredLoadReport, LoadLayeredOptions } from './definition-registry.js';
import type { AgentDefinition } from './types.js';

export function buildAgentListTool(): LLMToolSpec {
  return {
    name: 'AgentList',
    description:
      'Return the current agent-definition registry — every subagent_type available to the Agent tool, with source layer (builtin / plugin-builtin / user / project), model, permission mode, tool allowlist, and description. Read-only. Use before calling Agent({subagent_type:...}) to pick the right agent for the task.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  };
}

export interface AgentListEntry extends Record<string, unknown> {
  name: string;
  description: string;
  role?: string;
  goal?: string;
  model: string;
  permissionMode?: string;
  effort?: string | number;
  toolsCount: number | null;
  disallowedCount: number | null;
  source: string;
  sourcePath?: string;
  omitInheritedContext: boolean;
  maxTurns?: number;
  isolation?: string;
}

export interface AgentListResult extends Record<string, unknown> {
  /** One-line summary for the LLM's ambient render ("8 agents: 5 plugin-builtin, 3 builtin"). */
  output: string;
  count: number;
  agents: AgentListEntry[];
  /** LayeredLoadReport pass-through for observability. */
  overrides: Array<{ id: string; winnerSource: string; loserSource: string }>;
  warnings: string[];
  errors: string[];
}

export interface DispatchAgentListDeps {
  /** Test seam — production dispatch always reloads the layered registry. */
  load?: () => { agents: Map<string, AgentDefinition>; report: LayeredLoadReport };
  /** Test seam for exercising the real layered loader with isolated fixture directories. */
  loadOptions?: LoadLayeredOptions;
}

export async function dispatchAgentList(
  _raw: Record<string, unknown> = {},
  deps: DispatchAgentListDeps = {},
): Promise<AgentListResult> {
  const { agents, report } = deps.load?.() ?? loadAgentsLayered(deps.loadOptions ?? {});
  const entries: AgentListEntry[] = [];
  for (const def of agents.values()) {
    entries.push({
      name: def.name,
      description: def.description ?? '',
      ...(def.role ? { role: def.role } : {}),
      ...(def.goal ? { goal: def.goal } : {}),
      model: def.model ?? 'inherit',
      ...(def.permissionMode ? { permissionMode: def.permissionMode } : {}),
      ...(def.effort !== undefined ? { effort: def.effort } : {}),
      toolsCount: def.tools?.length ?? null,
      disallowedCount: def.disallowedTools?.length ?? null,
      source: def.source ?? 'builtin',
      ...(def.sourcePath ? { sourcePath: def.sourcePath } : {}),
      omitInheritedContext: def.omitInheritedContext ?? false,
      ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
      ...(def.isolation ? { isolation: def.isolation } : {}),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const bySource = new Map<string, number>();
  for (const e of entries) {
    bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
  }
  const sourceSummary = [...bySource.entries()].map(([s, n]) => `${n} ${s}`).join(', ');
  const output = `${entries.length} agents: ${sourceSummary}` + (report.overrides.length ? ` · ${report.overrides.length} overrides` : '');
  const result: AgentListResult = {
    output,
    count: entries.length,
    agents: entries,
    overrides: report.overrides.map(o => ({
      id: o.id,
      winnerSource: o.winnerSource,
      loserSource: o.loserSource,
    })),
    warnings: [...report.warnings],
    errors: [...report.errors],
  };
  debug.log('agent.list', 'dispatch', {
    selection: 'layered-registry',
    count: result.count,
    ...(result.count === 0 ? {
      zeroResultReason: report.registered === 0
        ? 'no_registered_agents'
        : 'all_registered_agents_filtered',
    } : {}),
    overrides: result.overrides.length,
    warnings: result.warnings.length,
    errors: result.errors.length,
  });
  return result;
}
