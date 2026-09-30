import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runGraph } from '../../../src/graph-runner/runner.js';

const directory = import.meta.dir;
const graph = parseYaml(readFileSync(join(directory, 'report-enterprise.yaml'), 'utf8')) as {
  graph_id: string; entry_node: string; terminal_nodes: string[];
  nodes: { node_id: string; kind: string; recipe?: string; max_visits: number }[];
  edges: { from: string; on: string; map: Record<string, string> }[];
};
const recipes = parseYaml(readFileSync(join(directory, 'recipes.yaml'), 'utf8')) as Record<string, { command: string; timeout_ms: number }>;

const steps = ['intake', 'needs', 'task', 'ncs-match', 'ai-fit', 'competency', 'roadmap', 'spec', 'routing', 'judge'];

test('enterprise graph executes all ten steps in order and retries the report stages once', () => {
  expect(graph.graph_id).toBe('job-coach-report-enterprise');
  expect(graph.entry_node).toBe('intake');
  expect(graph.terminal_nodes).toEqual(['done', 'failed']);
  expect(graph.nodes.map(node => node.node_id)).toEqual([...steps, 'done', 'failed']);
  for (const [index, name] of steps.entries()) {
    const node = graph.nodes[index]!;
    const recipeName = name === 'judge' ? 'judge-enterprise' : name;
    expect(node).toEqual({ node_id: name, kind: name === 'judge' ? 'judge' : 'agent', recipe: `cmd:${recipeName}`, max_visits: index < 4 ? 1 : 2 });
    expect(recipes[recipeName]).toEqual({ command: `bun "$ELANOUS_GRAPH_DIR/run-step.ts" ${recipeName}`, timeout_ms: 30000 });
    expect(graph.edges[index]).toEqual({ from: name, on: 'outcome', map: {
      ok: steps[index + 1] ?? 'done', ...(name === 'judge' ? { retry: 'ai-fit' } : {}), fail: 'failed',
    } });
  }
  expect(graph.nodes.slice(-2)).toEqual([
    { node_id: 'done', kind: 'gate', max_visits: 1 },
    { node_id: 'failed', kind: 'gate', max_visits: 1 },
  ]);
  expect(graph.edges).toHaveLength(steps.length);
});

test('enterprise graph dry-run reaches done through every declared node without executing recipes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'job-coach-enterprise-dry-'));
  try {
    const state = await runGraph(join(directory, 'report-enterprise.yaml'), {
      dryRun: true, deps: { root },
    });
    expect(state.status).toBe('done');
    expect(state.path).toEqual([...steps, 'done']);
    expect(state.executed).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('personal graph and original recipes retain their contract', () => {
  const personal = parseYaml(readFileSync(join(directory, 'report.yaml'), 'utf8')) as typeof graph;
  expect(personal.graph_id).toBe('job-coach-report');
  expect(personal.entry_node).toBe('profile');
  expect(personal.nodes.map(node => node.node_id)).toEqual(['profile', 'ncs-match', 'research', 'gap', 'report', 'judge', 'done', 'failed']);
  expect(personal.edges.map(edge => `${edge.from}:${edge.map.ok}:${edge.map.retry ?? '-'}:${edge.map.fail}`)).toEqual([
    'profile:ncs-match:-:failed', 'ncs-match:research:-:failed',
    'research:gap:-:failed', 'gap:report:-:failed',
    'report:judge:-:failed', 'judge:done:research:failed',
  ]);
  for (const name of ['profile', 'ncs-match', 'research', 'gap', 'report', 'judge']) {
    expect(recipes[name]).toEqual({ command: `bun "$ELANOUS_GRAPH_DIR/run-step.ts" ${name}`, timeout_ms: name === 'research' ? 120000 : 30000 });
  }
});
