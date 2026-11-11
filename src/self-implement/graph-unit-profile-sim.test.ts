import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraphUnitResolver, flattenGraphTemplate } from './graph-unit-resolver.js';
import { parseGraphTemplateYaml } from './graph-yaml.js';
import { runGraph, validateUnitCalls } from '../graph-runner/runner.js';

// Source: graph template versions in the C1 unit contract fixtures are 1.
const UNIT_VERSION = 1;
// Source: each fixture node is visited once in the C1 simulator fixtures.
const UNIT_VISITS = 1;
// Source: the C1 unit contract simulator grants eight child steps.
const UNIT_BUDGET = 8;

function unitSource(entry: string): string {
  return `graph_id: worker\nversion: ${UNIT_VERSION}\nunit: { inputs: [ask], outputs: [result, evidence], exits: [done] }\nentry_node: ${entry}\nterminal_nodes: [done]\nnodes:\n  - { node_id: ${entry}, kind: gate, recipe: none, max_visits: ${UNIT_VISITS} }\n  - { node_id: done, kind: gate, recipe: none, max_visits: ${UNIT_VISITS} }\nedges:\n  - { from: ${entry}, to: done }\n`;
}

test('SIM-GRAPH-COMPOSE-C4: a dedicated <id>.unit.yaml definition takes precedence over the standalone graph', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-compose-c4-unit-'));
  const units = join(root, 'units');
  mkdirSync(units);
  const callerPath = join(root, 'caller.yaml');
  try {
    writeFileSync(join(units, 'worker.yaml'), unitSource('standalone-entry'));
    writeFileSync(join(units, 'worker.unit.yaml'), unitSource('component-entry'));

    const resolved = createGraphUnitResolver()('worker@1', callerPath);

    expect(resolved.template.entryNode).toBe('component-entry');
    expect(resolved.path).toBe(join(units, 'worker.unit.yaml'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SIM-GRAPH-COMPOSE-C4: profiles.unit is selected by static flatten and child execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-compose-c4-profile-'));
  const units = join(root, 'units');
  mkdirSync(units);
  const callerPath = join(root, 'caller.yaml');
  try {
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(join(units, 'recipes.yaml'), '{}\n');
    writeFileSync(join(units, 'worker.yaml'), `${unitSource('standalone-entry')}profiles:\n  unit:\n    entry_node: profile-entry\n    nodes:\n      - { node_id: profile-entry, kind: agent, recipe: 'handler:component', max_visits: ${UNIT_VISITS} }\n      - { node_id: done, kind: gate, recipe: none, max_visits: ${UNIT_VISITS} }\n    edges:\n      - { from: profile-entry, to: done }\n`);
    writeFileSync(callerPath, `graph_id: parent\nversion: ${UNIT_VERSION}\nentry_node: invoke\nterminal_nodes: [done]\nnodes:\n  - node_id: invoke\n    kind: subgraph\n    recipe: none\n    max_visits: ${UNIT_VISITS}\n    call: worker@${UNIT_VERSION}\n    budget: { inner_steps: ${UNIT_BUDGET} }\n    contract: { inputs: [ask], tools: none, outputs: [result, evidence] }\n  - { node_id: done, kind: gate, recipe: none, max_visits: ${UNIT_VISITS} }\nedges:\n  - { from: invoke, on: outcome, map: { done: done } }\n`);
    const resolved = createGraphUnitResolver()('worker@1', callerPath);
    expect(resolved.template.entryNode).toBe('profile-entry');
    expect(resolved.path).toBe(join(units, 'worker.yaml'));
    expect(resolved.definition).toBe('component');
    const parsed = parseGraphTemplateYaml(await Bun.file(callerPath).text(), callerPath);
    expect(parsed.errors).toEqual([]);
    const flattened = flattenGraphTemplate(parsed.template!, callerPath);
    expect(flattened.nodes.some((node) => node.nodeId === 'invoke__profile-entry')).toBe(true);
    const state = await runGraph(callerPath, { input: { ask: 'profile' }, deps: { root,
      inProcessHandlers: { component: async () => ({ ok: true, outcome: 'done', result: 'profile-result', evidence: { selected: 'profile' } }) },
    } });
    expect(state.status).toBe('done');
    expect(state.unitCalls?.[0]?.hash).toBe(resolved.hash);
    const childRunId = state.unitCalls?.[0]?.childRunId;
    const child = JSON.parse(readFileSync(join(root, 'graph-runs', 'worker', `${childRunId}.json`), 'utf8')) as typeof state;
    expect(child.graphSnapshot?.graphSha).toBe(resolved.hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SIM-GRAPH-COMPOSE-C4: a component definition takes precedence over the standalone unit plus its shape request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-compose-c4-shape-priority-'));
  const units = join(root, 'units');
  mkdirSync(units);
  const callerPath = join(root, 'caller.yaml');
  const standalone = unitSource('draft').replace(
    'unit: { inputs: [ask], outputs: [result, evidence], exits: [done] }',
    'unit:\n  inputs: [ask]\n  outputs: [result, evidence]\n  exits: [done]\n  shape_points: { skip: [review] }',
  ).replace(
    `  - { node_id: done, kind: gate, recipe: none, max_visits: ${UNIT_VISITS} }\nedges:\n  - { from: draft, to: done }`,
    `  - { node_id: review, kind: gate, recipe: none, max_visits: ${UNIT_VISITS} }\n  - { node_id: done, kind: gate, recipe: none, max_visits: ${UNIT_VISITS} }\nedges:\n  - { from: draft, to: review }\n  - { from: review, to: done }`,
  );
  const component = `graph_id: worker\nversion: ${UNIT_VERSION}\nunit: { inputs: [ask], outputs: [result, evidence], exits: [done] }\nentry_node: component-entry\nterminal_nodes: [done]\nnodes:\n  - { node_id: component-entry, kind: agent, recipe: 'handler:component', max_visits: ${UNIT_VISITS} }\n  - { node_id: done, kind: gate, recipe: none, max_visits: ${UNIT_VISITS} }\nedges:\n  - { from: component-entry, to: done }\n`;
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  writeFileSync(join(units, 'recipes.yaml'), '{}\n');
  writeFileSync(join(units, 'worker.yaml'), standalone);
  writeFileSync(join(units, 'worker.unit.yaml'), component);
  writeFileSync(callerPath, `graph_id: parent\nversion: ${UNIT_VERSION}\nentry_node: invoke\nterminal_nodes: [done]\nnodes:\n  - node_id: invoke\n    kind: subgraph\n    recipe: none\n    max_visits: ${UNIT_VISITS}\n    call:\n      unit: worker@${UNIT_VERSION}\n      shape: { skip: [review] }\n    budget: { inner_steps: ${UNIT_BUDGET} }\n    contract: { inputs: [ask], tools: none, outputs: [result, evidence] }\n  - { node_id: done, kind: gate, recipe: none, max_visits: ${UNIT_VISITS} }\nedges:\n  - { from: invoke, on: outcome, map: { done: done } }\n`);
  try {
    const parsed = parseGraphTemplateYaml(await Bun.file(callerPath).text(), callerPath);
    expect(parsed.errors).toEqual([]);
    const resolved = validateUnitCalls(parsed.template!, callerPath).get('invoke');
    expect(resolved?.template.entryNode).toBe('component-entry');
    expect(resolved?.shapeHash).toBeUndefined();

    const state = await runGraph(callerPath, { input: { ask: 'shape' }, deps: { root,
      inProcessHandlers: { component: async () => ({ ok: true, outcome: 'done', result: 'component-result', evidence: { selected: 'component' } }) },
    } });
    expect(state.status).toBe('done');
    expect(state.unitCalls?.[0]?.hash).toBe(resolved?.hash);
    const childRunId = state.unitCalls?.[0]?.childRunId;
    const child = JSON.parse(readFileSync(join(root, 'graph-runs', 'worker', `${childRunId}.json`), 'utf8')) as typeof state;
    expect(child.graphSnapshot?.graphSha).toBe(resolved?.hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SIM-GRAPH-COMPOSE-C4: cached standalone, profile, and dedicated definitions are reloaded before child calls', async () => {
  for (const definition of ['standalone', 'profile', 'dedicated'] as const) {
    const root = mkdtempSync(join(tmpdir(), `graph-compose-c4-stale-${definition}-`));
    const units = join(root, 'units');
    mkdirSync(units);
    const callerPath = join(root, 'caller.yaml');
    const unitPath = join(units, definition === 'dedicated' ? 'worker.unit.yaml' : 'worker.yaml');
    const profileSource = (entry: string) => `${unitSource('standalone-entry')}profiles:\n  unit:\n    entry_node: ${entry}\n    nodes:\n      - { node_id: ${entry}, kind: gate, recipe: none, max_visits: ${UNIT_VISITS} }\n      - { node_id: done, kind: gate, recipe: none, max_visits: ${UNIT_VISITS} }\n    edges:\n      - { from: ${entry}, to: done }\n`;
    const original = definition === 'profile' ? profileSource('profile-entry') : unitSource(`${definition}-entry`);
    const changed = definition === 'profile' ? profileSource('changed-entry') : unitSource('changed-entry');
    try {
      writeFileSync(join(root, 'recipes.yaml'), '{}\n');
      writeFileSync(join(units, 'recipes.yaml'), '{}\n');
      if (definition === 'dedicated') writeFileSync(join(units, 'worker.yaml'), unitSource('standalone-entry'));
      writeFileSync(unitPath, original);
      writeFileSync(callerPath, `graph_id: parent\nversion: ${UNIT_VERSION}\nentry_node: mutate\nterminal_nodes: [failed, done]\nnodes:\n  - { node_id: mutate, kind: agent, recipe: 'handler:mutate', max_visits: ${UNIT_VISITS} }\n  - node_id: invoke\n    kind: subgraph\n    recipe: none\n    max_visits: ${UNIT_VISITS}\n    call: worker@${UNIT_VERSION}\n    budget: { inner_steps: ${UNIT_BUDGET} }\n    contract: { inputs: [ask], tools: none, outputs: [result, evidence] }\n  - { node_id: done, kind: gate, recipe: none, max_visits: ${UNIT_VISITS} }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: ${UNIT_VISITS} }\nedges:\n  - { from: mutate, on: outcome, map: { done: invoke, fail: failed } }\n  - { from: invoke, on: outcome, map: { done: done } }\n`);
      const state = await runGraph(callerPath, { input: { ask: 'change-after-resolution' }, deps: { root,
        inProcessHandlers: { mutate: async () => { writeFileSync(unitPath, changed); return { ok: true, outcome: 'done' }; } },
      } });
      expect(state.status, definition).toBe('failed');
      expect(state.unitCalls?.length ?? 0, definition).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
