import type { HarnessGraphEventWire, HarnessRunTraversal, RunGraphDetail } from '@/nexus/client';

export type McpEdgeDirection = 'to-elanous' | 'to-aside' | 'mcp';

const MCP_TOOL_NODE = /(?:^|[-_:/.])(elanous_task_submit|skill_exec|aside_exec)(?:$|[-_:/.])/i;
const ASIDE_NODE = /(?:^|[-_:/.])aside(?:$|[-_:/.])/i;
const ELANOUS_NODE = /(?:^|[-_:/.])elanous(?:$|[-_:/.])/i;

/** Mark only graph edges whose recorded node ids identify one of the existing aside/Elanous MCP tools. */
export function mcpEdgeDirection(from: string, to: string): McpEdgeDirection | null {
  const fromAside = ASIDE_NODE.test(from);
  const fromElanous = ELANOUS_NODE.test(from);
  const toAside = ASIDE_NODE.test(to);
  const toElanous = ELANOUS_NODE.test(to);
  if (fromAside && toElanous) return 'to-elanous';
  if (fromElanous && toAside) return 'to-aside';
  if (MCP_TOOL_NODE.test(to)) {
    if (/aside_exec/i.test(to) && fromElanous) return 'to-aside';
    if (/(?:elanous_task_submit|skill_exec)/i.test(to) && fromAside) return 'to-elanous';
  }
  if (MCP_TOOL_NODE.test(from)) {
    if (/aside_exec/i.test(from) && toElanous) return 'to-elanous';
    if (/(?:elanous_task_submit|skill_exec)/i.test(from) && toAside) return 'to-aside';
  }
  return null;
}

export interface LiveRunStageMetrics {
  nodes: number | null;
  edges: number | null;
  visits: number;
  failures: number;
  repairs: number;
  mcpEdges: number | null;
  births: number;
}

export function liveRunStageMetrics(
  run: Pick<HarnessRunTraversal, 'steps' | 'graphEvents'>,
  graph: Pick<RunGraphDetail, 'nodes' | 'edges'> | null,
): LiveRunStageMetrics {
  const events = run.graphEvents ?? [];
  const mcpPairs = new Set<string>();
  const renderedPairs = new Set<string>();
  for (const edge of graph?.edges ?? []) {
    const mappedTargets = edge.map ? Object.values(edge.map) : edge.to ? [edge.to] : [];
    const mappedSet = new Set(mappedTargets);
    const targets = [...mappedTargets, ...(edge.fallback ?? []).filter((fallback) => !mappedSet.has(fallback.node)).map((fallback) => fallback.node)];
    for (const target of targets) {
      if (!target) continue;
      const pair = `${edge.from}\u0000${target}`;
      renderedPairs.add(pair);
      if (mcpEdgeDirection(edge.from, target)) mcpPairs.add(pair);
    }
  }
  return {
    nodes: graph ? new Set(graph.nodes.map((node) => node.node_id)).size : null,
    edges: graph ? renderedPairs.size : null,
    visits: run.steps.length,
    failures: run.steps.filter((step) => ['fail', 'failed', 'error', 'blocked', 'rejected', 'aborted', 'timeout'].includes(step.outcome?.toLowerCase() ?? '')).length,
    repairs: events.filter((event) => event.type === 'edge-rerouted').length,
    mcpEdges: graph ? mcpPairs.size : null,
    births: events.filter((event) => event.type === 'node-added').length,
  };
}

export function visibleRunAtCursor<T extends { sourceSeq?: number; at: string }, E extends { seq: number; ts: string }>(
  run: { steps: readonly T[]; graphEvents?: readonly E[] },
  cursor: number,
  live: boolean,
): { steps: T[]; graphEvents: E[] } {
  if (live) return { steps: [...run.steps], graphEvents: [...(run.graphEvents ?? [])] };
  const steps = cursor < 0 ? [] : run.steps.slice(0, cursor + 1);
  const current = steps.at(-1);
  if (!current) return { steps, graphEvents: run.steps.length === 0 ? [...(run.graphEvents ?? [])] : [] };
  if (cursor >= run.steps.length - 1) return { steps, graphEvents: [...(run.graphEvents ?? [])] };
  const seq = current.sourceSeq;
  const at = Date.parse(current.at);
  return {
    steps,
    graphEvents: (run.graphEvents ?? []).filter((event) => seq !== undefined
      ? event.seq <= seq
      : Date.parse(event.ts) <= at),
  };
}

function compareEventToStep(event: { seq: number; ts: string }, step: { sourceSeq?: number; at: string }): number | null {
  if (step.sourceSeq !== undefined && Number.isFinite(event.seq)) return Math.sign(event.seq - step.sourceSeq);
  const eventAt = Date.parse(event.ts);
  const stepAt = Date.parse(step.at);
  if (!Number.isFinite(eventAt) || !Number.isFinite(stepAt) || eventAt === stepAt) return null;
  return Math.sign(eventAt - stepAt);
}

/** Count graph events whose order cannot be established from shared sequence ids or distinct timestamps. */
export function unorderableGraphEventCount(
  run: Pick<HarnessRunTraversal, 'steps' | 'graphEvents'>,
  cursor: number,
  live: boolean,
): number {
  const events = run.graphEvents ?? [];
  const consideredSteps = live ? run.steps : cursor < 0 ? [] : run.steps.slice(0, cursor + 1);
  return events.filter((event) => {
    if (!Number.isFinite(event.seq) || run.steps.length === 0) return true;
    return consideredSteps.some((step) => compareEventToStep(event, step) === null);
  }).length;
}

export function nodeBirthsBetweenSteps<T extends { sourceSeq?: number; at: string }>(
  events: readonly HarnessGraphEventWire[], previous: T | undefined, current: T | undefined, finalCursor: boolean,
): string[] {
  return events.flatMap((event) => {
    if (event.type !== 'node-added') return [];
    const previousOrder = previous ? compareEventToStep(event, previous) : null;
    const currentOrder = current ? compareEventToStep(event, current) : null;
    const afterPrevious = !previous || (previousOrder !== null && previousOrder > 0);
    const beforeCurrent = finalCursor || Boolean(current && currentOrder !== null && currentOrder <= 0);
    return afterPrevious && beforeCurrent ? [event.node] : [];
  });
}

export interface StageNodeResource { host?: string; pod?: string; models?: string[]; plugins?: string[] }
const RESOURCE_LABELS: Array<[keyof StageNodeResource, string]> = [
  ['host', '호스트'], ['pod', 'Pod'], ['models', '모델'], ['plugins', '플러그인'],
];

/** Show resources from the latest visit only; a later visit never inherits missing fields from an earlier one. */
export function stageNodeResourceBadges(
  steps: readonly { node: string; resources?: StageNodeResource }[],
  resolve: (node: string) => string = (node) => node,
  fallbackSubstrate: string | null = null,
  visibleNodes: readonly string[] = [],
): Map<string, string[]> {
  const values = new Map<string, Partial<StageNodeResource>>();
  for (const node of visibleNodes) values.set(resolve(node), {});
  for (const step of steps) {
    const id = resolve(step.node);
    const current: Partial<StageNodeResource> = {};
    const host = step.resources?.host;
    const pod = step.resources?.pod;
    if (typeof host === 'string' && host.trim()) current.host = host.trim();
    if (typeof pod === 'string' && pod.trim()) current.pod = pod.trim();
    for (const key of ['models', 'plugins'] as const) {
      const observed = step.resources?.[key]?.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
      if (observed?.length) current[key] = observed;
    }
    values.set(id, current);
  }
  return new Map([...values].map(([node, resources]) => {
    const badges = RESOURCE_LABELS.flatMap(([key, label]) => {
      const value = resources[key];
      if (value) return [`${label} ${Array.isArray(value) ? value.join(', ') : value}`];
      if (key === 'host' || key === 'models') return [`${label} 미계측`];
      return [];
    });
    if (!resources.pod && !resources.plugins?.length && fallbackSubstrate) badges.push(`실행 ${fallbackSubstrate}`);
    return [node, badges];
  }));
}

export function failureRepairEvidence(run: Pick<HarnessRunTraversal, 'steps' | 'graphEvents'>): {
  failure: HarnessRunTraversal['steps'][number];
  repair: Extract<HarnessGraphEventWire, { type: 'edge-rerouted' }>;
} | null {
  const failures = run.steps.filter((step) => ['fail', 'failed', 'error', 'blocked', 'rejected', 'aborted', 'timeout'].includes(step.outcome?.toLowerCase() ?? ''));
  const repairs = (run.graphEvents ?? []).filter((event): event is Extract<HarnessGraphEventWire, { type: 'edge-rerouted' }> => event.type === 'edge-rerouted');
  const evidence = repairs.flatMap((repair) => {
    const failure = failures.filter((step) => step.node === repair.from
      && (compareEventToStep(repair, step) ?? -1) > 0
      && (!repair.outcome || repair.outcome === '$default' || repair.outcome.toLowerCase() === step.outcome?.toLowerCase()))
      .at(-1);
    return failure ? [{ failure, repair }] : [];
  }).sort((left, right) => right.repair.seq - left.repair.seq)[0];
  return evidence ?? null;
}
