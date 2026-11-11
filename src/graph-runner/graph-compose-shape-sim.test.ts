import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { runGraph, validateUnitCalls } from './runner.js';

const SHAPE_GRAPH_VERSION = 1;
const SHAPE_NODE_VISITS = 1;
const SHAPE_UNIT_BUDGET = 16;

function world(shape = `skip: [review]\nrecipe: { draft: 'handler:shaped' }\nfanout_max: 2`): { root: string; caller: string; unit: string } {
  const root = mkdtempSync(join(tmpdir(), 'graph-compose-shape-sim-'));
  const units = join(root, 'units');
  mkdirSync(units);
  const caller = join(root, 'parent.yaml');
  const unit = join(units, 'worker.yaml');
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  writeFileSync(join(units, 'recipes.yaml'), '{}\n');
  writeFileSync(caller, `graph_id: shape-parent
version: ${SHAPE_GRAPH_VERSION}
entry_node: invoke
terminal_nodes: [done, failed]
nodes:
  - node_id: invoke
    kind: subgraph
    recipe: none
    max_visits: ${SHAPE_NODE_VISITS}
    call:
      unit: worker@${SHAPE_GRAPH_VERSION}
      shape:
${shape.split('\n').map(line => `        ${line}`).join('\n')}
    budget: { inner_steps: ${SHAPE_UNIT_BUDGET} }
    contract: { inputs: [ask], tools: none, outputs: [result, evidence] }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${SHAPE_NODE_VISITS} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${SHAPE_NODE_VISITS} }
edges:
  - { from: invoke, on: outcome, map: { done: done, failed: failed } }
`);
  writeFileSync(unit, `graph_id: worker
version: ${SHAPE_GRAPH_VERSION}
max_parallel_nodes: 4
unit:
  inputs: [ask]
  outputs: [result, evidence]
  exits: [done, failed]
  shape_points:
    skip: [review]
    recipe: [draft, review]
    fanout_max: { min: 1, max: 2 }
entry_node: draft
terminal_nodes: [done, failed]
nodes:
  - { node_id: draft, kind: agent, recipe: 'handler:base', max_visits: ${SHAPE_NODE_VISITS} }
  - { node_id: review, kind: agent, recipe: 'handler:review', max_visits: ${SHAPE_NODE_VISITS} }
  - { node_id: parallelize, kind: agent, recipe: 'handler:fanout', max_visits: ${SHAPE_NODE_VISITS} }
  - { node_id: branch-a, kind: agent, recipe: 'handler:branch', max_visits: ${SHAPE_NODE_VISITS} }
  - { node_id: branch-b, kind: agent, recipe: 'handler:branch', max_visits: ${SHAPE_NODE_VISITS} }
  - { node_id: branch-c, kind: agent, recipe: 'handler:branch', max_visits: ${SHAPE_NODE_VISITS} }
  - { node_id: join, kind: agent, recipe: 'handler:join', max_visits: ${SHAPE_NODE_VISITS} }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${SHAPE_NODE_VISITS} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${SHAPE_NODE_VISITS} }
edges:
  - { from: draft, on: outcome, map: { done: review, failed: failed } }
  - { from: review, to: parallelize }
  - { from: parallelize, on: outcome, branches: { done: [branch-a, branch-b, branch-c] }, join: join }
  - { from: join, on: outcome, map: { ok: done, fail: failed } }
`);
  return { root, caller, unit };
}

function successfulNode(outcome = 'done', result: unknown = 'shaped-result') {
  return async () => ({ ok: true, outcome, result, evidence: { simulated: true } });
}

test('SIM-GRAPH-COMPOSE-C3: only declared shape points alter a called unit and the shaped copy is ledgered', async () => {
  const sim = world();
  const seen: string[] = [];
  let activeBranches = 0;
  let peakBranches = 0;
  let startedBranches = 0;
  const unitShapeEventHashes: string[] = [];
  let announceFirst!: () => void;
  let releaseBranches!: () => void;
  const firstBranchStarted = new Promise<void>((resolve) => { announceFirst = resolve; });
  const branchGate = new Promise<void>((resolve) => { releaseBranches = resolve; });
  try {
    const parsed = parseGraphTemplateYaml(await Bun.file(sim.caller).text(), sim.caller);
    expect(parsed.errors).toEqual([]);
    const resolved = validateUnitCalls(parsed.template!, sim.caller).get('invoke');
    expect(resolved?.template.nodes.find(node => node.nodeId === 'review')).toBeUndefined();
    expect(resolved?.template.nodes.find(node => node.nodeId === 'draft')?.recipe).toBe('handler:shaped');
    expect(resolved?.template.maxParallelNodes).toBe(2);

    const branch = async () => {
      seen.push('branch');
      startedBranches++;
      activeBranches++;
      peakBranches = Math.max(peakBranches, activeBranches);
      if (startedBranches === 1) announceFirst();
      await branchGate;
      activeBranches--;
      return { ok: true, outcome: 'ok' };
    };
    const run = runGraph(sim.caller, { input: { ask: 'shape the unit' }, deps: { root: sim.root,
      log: (event, data) => {
        if (event === 'graph.unit' && data.phase === 'enter' && typeof data.shapeHash === 'string') unitShapeEventHashes.push(data.shapeHash);
      },
      inProcessHandlers: {
      base: successfulNode(), shaped: async () => { seen.push('shaped'); return { ok: true, outcome: 'done', result: 'shaped-result', evidence: { simulated: true } }; },
      review: async () => { seen.push('review'); return { ok: true, outcome: 'done' }; },
      fanout: successfulNode(), branch, join: async () => ({ ok: true, outcome: 'ok' }),
    } } });
    try {
      await firstBranchStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(startedBranches).toBe(2);
      expect(peakBranches).toBe(2);
    } finally {
      releaseBranches();
    }
    const state = await run;
    expect(state.status).toBe('done');
    expect(seen).toContain('shaped');
    expect(seen).not.toContain('review');
    expect(state.unitCalls?.[0]?.shapeHash).toMatch(/^[a-f0-9]{64}$/);
    const saved = JSON.parse(readFileSync(state.statePath, 'utf8')) as typeof state;
    expect(saved.unitCalls?.[0]?.shapeHash).toBe(state.unitCalls?.[0]?.shapeHash);
    const childRunId = state.unitCalls?.[0]?.childRunId;
    const child = JSON.parse(readFileSync(join(sim.root, 'graph-runs', 'worker', `${childRunId}.json`), 'utf8')) as typeof state;
    expect(state.unitCalls?.[0]?.shapeHash).toBe(child.graphSnapshot?.graphSha);
    expect(state.unitCalls?.[0]?.shapeHash).not.toBe(createHash('sha256').update(readFileSync(sim.unit)).digest('hex'));
    const shapeHash = state.unitCalls?.[0]?.shapeHash;
    if (!shapeHash) throw new Error('unit call ledger omitted shapeHash');
    expect(unitShapeEventHashes).toContain(shapeHash);
  } finally { rmSync(sim.root, { recursive: true, force: true }); }
});

test('SIM-GRAPH-COMPOSE-C3: undeclared shape points and out-of-range fanout are rejected before execution', async () => {
  for (const shape of [`skip: [unknown]`, `recipe: { unknown: 'handler:replacement' }`, `fanout_max: 3`]) {
    const sim = world(shape);
    try {
      const parsed = parseGraphTemplateYaml(await Bun.file(sim.caller).text(), sim.caller);
      expect(parsed.errors).toEqual([]);
      expect(() => validateUnitCalls(parsed.template!, sim.caller)).toThrow(/shape|fanout/i);
    } finally { rmSync(sim.root, { recursive: true, force: true }); }
  }
});
