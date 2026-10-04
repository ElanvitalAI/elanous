import { debug } from '../debug/log.js';

export type GraphKind = 'harness' | 'workflow';

/** Declarative body a workflow plugin kind reuses. */
export type NodeKindRun =
  | { bash: string }
  | { http: { method: string; url: string; body?: string } }
  | { skill: { name: string; prompt?: string } }
  | { mcp: { server: string; tool: string; args?: Record<string, unknown> } };

export interface NodeKindEntry {
  graph: GraphKind;
  kind: string;
  plugin?: string;
  description: string;
  schema?: Record<string, unknown>;
  core: boolean;
  /** Workflow kinds only. Absent on core kinds and on harness kinds. */
  run?: NodeKindRun;
}

export const HARNESS_CORE_KINDS = ['agent', 'gate', 'git', 'judge', 'observe', 'hitl', 'subgraph'] as const;

// Workflow validation, the palette, and executor variant labels read the same keys.
export const WORKFLOW_CORE_KINDS = ['prompt', 'bash', 'skill', 'cft', 'approval', 'if', 'switch', 'iteration', 'classify', 'extract', 'set', 'filter', 'template', 'http', 'showroom', 'task', 'scheduleTrigger', 'webhookTrigger', 'discordTrigger', 'telegramTrigger', 'manualTrigger', 'chatTrigger', 'subworkflow', 'knowledge'] as const;

const descriptions: Record<GraphKind, readonly string[]> = {
  harness: ['Run an agent', 'Check an execution gate', 'Perform git operations', 'Judge an outcome', 'Observe a result', 'Request human input', 'Run a child graph'],
  workflow: ['Run an LLM prompt', 'Run a shell command', 'Invoke a skill', 'Invoke a CFT method', 'Request approval', 'Branch on a condition', 'Select a case', 'Iterate items', 'Classify input', 'Extract structured data', 'Assign variables', 'Filter items', 'Render a template', 'Make an HTTP request', 'Run a showroom', 'Create a task', 'Start on a schedule', 'Start on a webhook', 'Start on Discord', 'Start on Telegram', 'Start manually', 'Start on chat', 'Call another workflow', 'Search the vault for context'],
};

const kinds = new Map<GraphKind, Map<string, NodeKindEntry>>();
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function registerNodeKind(entry: NodeKindEntry): { ok: true } | { ok: false; reason: 'core-kind' | 'bad-name' | 'duplicate' } {
  if (entry.graph !== 'harness' && entry.graph !== 'workflow') return { ok: false, reason: 'bad-name' };
  const graphKinds = kinds.get(entry.graph) ?? new Map<string, NodeKindEntry>();
  const existing = graphKinds.get(entry.kind);
  if (existing?.core || (!entry.core && (entry.graph === 'harness' ? HARNESS_CORE_KINDS : WORKFLOW_CORE_KINDS).some((kind) => kind === entry.kind))) return { ok: false, reason: 'core-kind' };
  if (!entry.core && (!entry.plugin || !NAME.test(entry.plugin) || !NAME.test(entry.kind.split(':')[1] ?? '') || entry.kind !== `${entry.plugin}:${entry.kind.split(':')[1]}`)) {
    return { ok: false, reason: 'bad-name' };
  }
  if (entry.core && (entry.plugin !== undefined || entry.run !== undefined || !(entry.graph === 'harness' ? HARNESS_CORE_KINDS : WORKFLOW_CORE_KINDS).some((kind) => kind === entry.kind))) return { ok: false, reason: 'bad-name' };
  if (entry.run !== undefined && (entry.graph !== 'workflow' || !isNodeKindRun(entry.run))) return { ok: false, reason: 'bad-name' };
  if (existing) return { ok: false, reason: 'duplicate' };
  graphKinds.set(entry.kind, { ...entry });
  kinds.set(entry.graph, graphKinds);
  debug.log('graph.kinds', 'register', { graph: entry.graph, kind: entry.kind, plugin: entry.plugin });
  return { ok: true };
}

/** Internal ownership handle; unlike the public snapshot, this is the registered object itself. */
export function getNodeKindRegistration(graph: GraphKind, kind: string): NodeKindEntry | undefined {
  return kinds.get(graph)?.get(kind);
}

/** Remove a plugin registration only when it is still the same registered object; core kinds are immutable. */
export function unregisterPluginNodeKind(graph: GraphKind, kind: string, plugin: string, registered: NodeKindEntry): boolean {
  const graphKinds = kinds.get(graph);
  const entry = graphKinds?.get(kind);
  if (!entry || entry.core || entry.plugin !== plugin || entry !== registered) return false;
  graphKinds!.delete(kind);
  debug.log('graph.kinds', 'unregister', { graph, kind, plugin });
  return true;
}

export function registerCoreKinds(): void {
  for (const graph of ['harness', 'workflow'] as const) {
    const names = graph === 'harness' ? HARNESS_CORE_KINDS : WORKFLOW_CORE_KINDS;
    names.forEach((kind, index) => {
      if (!kinds.get(graph)?.has(kind)) registerNodeKind({ graph, kind, description: descriptions[graph][index]!, core: true });
    });
  }
}

export function listNodeKinds(graph?: GraphKind): NodeKindEntry[] {
  registerCoreKinds();
  return (graph ? [graph] : ['harness', 'workflow'] as const).flatMap((g) => [...(kinds.get(g)?.values() ?? [])].map((entry) => ({ ...entry })));
}

export function hasNodeKind(graph: GraphKind, kind: string): boolean {
  registerCoreKinds();
  return kinds.get(graph)?.has(kind) ?? false;
}

/** The registered entry, or undefined. Core kinds are ensured first. */
export function getNodeKind(graph: GraphKind, kind: string): NodeKindEntry | undefined {
  registerCoreKinds();
  const entry = kinds.get(graph)?.get(kind);
  return entry ? { ...entry } : undefined;
}

function isNodeKindRun(run: NodeKindRun): boolean {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return false;
  if ('bash' in run) return typeof run.bash === 'string' && run.bash.trim().length > 0 && !('http' in run) && !('skill' in run) && !('mcp' in run);
  if ('http' in run) {
    return !('skill' in run) && !('mcp' in run)
      && typeof run.http === 'object' && run.http !== null
      && typeof run.http.method === 'string' && run.http.method.trim().length > 0
      && typeof run.http.url === 'string' && run.http.url.trim().length > 0
      && (run.http.body === undefined || typeof run.http.body === 'string');
  }
  if ('skill' in run) return !('mcp' in run)
    && typeof run.skill === 'object' && run.skill !== null
    && typeof run.skill.name === 'string' && run.skill.name.trim().length > 0
    && (run.skill.prompt === undefined || typeof run.skill.prompt === 'string');
  if ('mcp' in run) {
    const spec = run.mcp;
    return typeof spec === 'object' && spec !== null && !Array.isArray(spec)
      && typeof spec.server === 'string' && /^[a-z0-9_-]+$/.test(spec.server)
      && typeof spec.tool === 'string' && /^[a-z0-9_-]+$/.test(spec.tool)
      && (spec.args === undefined || (typeof spec.args === 'object' && spec.args !== null && !Array.isArray(spec.args)));
  }
  return false;
}

registerCoreKinds();
