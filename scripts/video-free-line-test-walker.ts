import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { GraphSpecLike, WalkerApi } from '../src/video-pipeline/walk-line.js';

interface TestGraph extends GraphSpecLike {
  entry_node: string;
  terminal_nodes: string[];
  nodes: ({ node_id: string; recipe?: string; max_visits?: number })[];
}

export const readGraphSpec: WalkerApi['readGraphSpec'] = (path) => {
  try { return { spec: parseYaml(readFileSync(path, 'utf8')) as TestGraph }; }
  catch (e) { return { error: (e as Error).message }; }
};

export const walkGraph: WalkerApi['walkGraph'] = async (graph, step, opts) => {
  const spec = graph as TestGraph;
  const visits = new Map<string, number>();
  const steps: { node: string; visit: number }[] = [];
  let next = spec.entry_node;
  while (steps.length < opts.maxSteps) {
    const node = spec.nodes.find((n) => n.node_id === next);
    if (!node) return { terminal: null, stopReason: 'no-node', steps };
    const visit = (visits.get(next) ?? 0) + 1;
    if (visit > (node.max_visits ?? 1)) return { terminal: null, stopReason: 'budget-exceeded', steps };
    visits.set(next, visit);
    steps.push({ node: next, visit });
    if (spec.terminal_nodes.includes(next)) return { terminal: next, stopReason: 'terminal', steps };
    const outcome = await step(node);
    if (outcome === null) { next = opts.unobservedNode; continue; }
    const edge = spec.edges.find((e) => e.from === next && (e.to !== undefined || e.map?.[outcome] !== undefined));
    if (!edge) return { terminal: null, stopReason: 'no-edge', steps };
    next = edge.to ?? edge.map![outcome]!;
  }
  return { terminal: null, stopReason: 'budget-exceeded', steps };
};
