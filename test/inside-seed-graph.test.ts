import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runGraph } from '../src/graph-runner/runner.js';

const graphPath = resolve(import.meta.dir, '../graphs/demo/inside-seed.yaml');
const recipesPath = resolve(import.meta.dir, '../graphs/demo/recipes.yaml');
const walk = ['plan', 'build', 'review', 'build', 'review', 'publish', 'done'];

test('inside-seed reworks the first review, publishes after the second, and isolates review state per run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'inside-seed-'));
  try {
    for (const runId of ['first', 'second']) {
      const state = await runGraph(graphPath, { runId, deps: { root } });
      expect(state.status).toBe('done');
      expect(state.path).toEqual(walk);
      expect(state.executed).toBe(6);
      expect(state.nodes.filter((node) => node.nodeId === 'review').map((node) => JSON.parse(node.output as string).outcome)).toEqual(['rework', 'ok']);
      expect(existsSync(join(`${state.statePath}.contexts`, 'review-seen'))).toBe(true);
      expect(readFileSync(state.statePath, 'utf8')).toContain('"status": "done"');
    }
    expect(existsSync(resolve(import.meta.dir, '../graphs/demo/review-seen'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('inside-seed declares only inert demo commands and a bounded review loop', () => {
  const graph = parseYaml(readFileSync(graphPath, 'utf8')) as {
    entry_node: string;
    terminal_nodes: string[];
    nodes: Array<{ node_id: string; max_visits: number; recipe?: string }>;
    edges: Array<{ from: string; on: string; map: Record<string, string> }>;
  };
  const recipes = parseYaml(readFileSync(recipesPath, 'utf8')) as Record<string, { command: string }>;
  expect(graph.entry_node).toBe('plan');
  expect(graph.terminal_nodes).toEqual(['done']);
  expect(graph.nodes.map(({ node_id }) => node_id)).toEqual(['plan', 'build', 'review', 'publish', 'done']);
  expect(graph.nodes.map(({ max_visits }) => max_visits)).toEqual([1, 2, 2, 1, 1]);
  expect(graph.edges.map(({ from, on, map }) => [from, on, map])).toEqual([
    ['plan', 'outcome', { ok: 'build' }],
    ['build', 'outcome', { ok: 'review' }],
    ['review', 'outcome', { rework: 'build', ok: 'publish' }],
    ['publish', 'outcome', { ok: 'done' }],
  ]);
  expect(Object.keys(recipes)).toEqual(['plan', 'build', 'review', 'publish']);
  expect(graph.nodes.filter(({ recipe }) => recipe).map(({ recipe }) => recipe)).toEqual(Object.keys(recipes).map((key) => `cmd:${key}`));
  expect(recipes.plan?.command).toStartWith('sleep ');
  expect(recipes.build?.command).toStartWith('sleep ');
  expect(recipes.publish?.command).toStartWith('sleep ');
  expect(recipes.review?.command).toContain('${ELANOUS_GRAPH_CONTEXT%/*}/review-seen');
});
