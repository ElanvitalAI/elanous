import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { RELEASE_NODE_COMMANDS } from '../graph-runner/runner.js';

type ReleaseNode = { node_id: string; recipe: string };
type ReleaseGraph = { nodes: ReleaseNode[]; terminal_nodes: string[] };
type Recipe = { command?: string; approval?: string };
type Bindings = Readonly<Record<string, { recipe: string; command?: string }>>;

function bindingDefects(graph: ReleaseGraph, recipes: Record<string, Recipe>, bindings: Bindings): string[] {
  const defects: string[] = [];
  for (const node of graph.nodes) {
    const binding = bindings[node.node_id];
    if (!binding) {
      defects.push(`${node.node_id}: missing RELEASE_NODE_COMMANDS binding`);
      continue;
    }
    if (binding.recipe !== node.recipe) defects.push(`${node.node_id}: recipe ${binding.recipe} != graph ${node.recipe}`);
    const commandRole = node.recipe.startsWith('cmd:') ? node.recipe.slice('cmd:'.length) : undefined;
    const approvalRole = node.recipe.startsWith('approval:') ? node.recipe.slice('approval:'.length) : undefined;
    if (commandRole) {
      const recipeCommand = recipes[commandRole]?.command;
      if (!recipeCommand) defects.push(`${node.node_id}: graph command recipe ${commandRole} has no command`);
      else if (binding.command !== recipeCommand) defects.push(`${node.node_id}: bound command does not match recipe ${commandRole}`);
    } else if (approvalRole) {
      if (!recipes[approvalRole]?.approval) defects.push(`${node.node_id}: graph approval recipe ${approvalRole} has no approval`);
      if (binding.command !== undefined) defects.push(`${node.node_id}: approval binding unexpectedly has a command`);
    } else if (node.recipe === 'none' && binding.command !== undefined) {
      defects.push(`${node.node_id}: none binding unexpectedly has a command`);
    } else if (node.recipe !== 'none') {
      defects.push(`${node.node_id}: unsupported graph recipe ${node.recipe}`);
    }
    const terminal = graph.terminal_nodes.includes(node.node_id);
    if (terminal !== (node.node_id === 'done' || node.node_id === 'failed')) {
      defects.push(`${node.node_id}: terminal declaration differs from runner contract`);
    }
  }
  return defects;
}

test('RELEASE-NODE-COMMANDS-BINDING sim: every release graph node matches a runner and recipe command binding', () => {
  const root = join(import.meta.dir, '../..');
  const graph = parseYaml(readFileSync(join(root, 'graphs/release/release-loop.yaml'), 'utf8')) as ReleaseGraph;
  const recipes = parseYaml(readFileSync(join(root, 'graphs/release/recipes.yaml'), 'utf8')) as Record<string, Recipe>;

  expect(bindingDefects(graph, recipes, RELEASE_NODE_COMMANDS)).toEqual([]);
  expect(RELEASE_NODE_COMMANDS['emergency-switch']).toEqual({
    recipe: 'cmd:emergency-switch', command: 'bun scripts/release-loop/emergency-publish-switch-sim.ts',
  });

  // Mutation proof: both an omitted binding and a newly declared graph node are rejected.
  const missingEmergency = { ...RELEASE_NODE_COMMANDS };
  delete (missingEmergency as Record<string, { recipe: string; command?: string }>)['emergency-switch'];
  expect(bindingDefects(graph, recipes, missingEmergency)).toContain('emergency-switch: missing RELEASE_NODE_COMMANDS binding');
  const addedNode = { ...graph, nodes: [...graph.nodes, { node_id: 'new-release-node', recipe: 'cmd:new-release-node' }] };
  expect(bindingDefects(addedNode, recipes, RELEASE_NODE_COMMANDS)).toContain('new-release-node: missing RELEASE_NODE_COMMANDS binding');
});
