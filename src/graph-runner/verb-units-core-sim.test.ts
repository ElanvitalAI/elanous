import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph, validateUnitCalls } from './runner.js';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';

const verbs = ['decide', 'make', 'watch'] as const;
const unitEnvelope = {
  inputs: ['ask', 'context', 'prior'],
  outputs: ['result', 'evidence'],
  exits: ['done', 'rework', 'needs-human', 'failed'],
} as const;
// Source: graph template and call versions use integer version tags.
const SIM_GRAPH_VERSION = 1;
// Source: every node in the simulation fixture is visited once.
const SIM_NODE_VISITS = 1;
// Source: the child executes one producer and one selected terminal node.
const SIM_UNIT_STEP_BUDGET = 2;

function callerGraph(verb: string): string {
  return [
    `graph_id: verb-${verb}-envelope-sim`,
    'version: 1',
    'entry_node: invoke',
    'terminal_nodes: [done]',
    'nodes:',
    `  - node_id: invoke`,
    '    kind: subgraph',
    '    recipe: none',
    '    max_visits: 1',
    `    call: verb-${verb}@1`,
    '    budget: { inner_steps: 8 }',
    `    contract: { inputs: [ask, context, prior], tools: none, outputs: [result, evidence] }`,
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
    'edges:',
    '  - from: invoke',
    '    on: outcome',
    '    map: { done: done, rework: done, needs-human: done, failed: done }',
  ].join('\n');
}

test('SIM-VERB-UNITS-CORE-3: three v2 core verb calls resolve through the existing unit runner contract', () => {
  const callerPath = join(process.cwd(), 'graphs/work/verb-units-core-sim.yaml');
  for (const verb of verbs) {
    const parsed = parseGraphTemplateYaml(callerGraph(verb), callerPath);
    expect(parsed.errors, `${verb} caller graph`).toEqual([]);
    expect(parsed.template).toBeDefined();
    const resolved = validateUnitCalls(parsed.template!, callerPath);
    expect(resolved.get('invoke')?.template.unit).toEqual(unitEnvelope);
    expect(resolved.get('invoke')?.template.graphId).toBe(`verb-${verb}`);
  }
});

test('SIM-VERB-UNITS-CORE-3: reject a caller whose unit inputs or exit map drift from the declared envelope', () => {
  const callerPath = join(process.cwd(), 'graphs/work/verb-units-core-sim.yaml');
  const badInputs = parseGraphTemplateYaml(callerGraph('decide').replace(
    'contract: { inputs: [ask, context, prior], tools: none, outputs: [result, evidence] }',
    'contract: { inputs: [ask], tools: none, outputs: [result, evidence] }',
  ), callerPath);
  expect(badInputs.errors).toEqual([]);
  expect(() => validateUnitCalls(badInputs.template!, callerPath)).toThrow('unit contract mismatch');

  const badExits = parseGraphTemplateYaml(callerGraph('watch').replace(
    'map: { done: done, rework: done, needs-human: done, failed: done }',
    'map: { done: done, needs-human: done, failed: done }',
  ), callerPath);
  expect(badExits.errors).toEqual([]);
  expect(() => validateUnitCalls(badExits.template!, callerPath)).toThrow('unit contract mismatch');
});

test('SIM-GRAPH-COMPOSE-C1: a parent calls one unit and maps every declared exit without losing its envelope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-compose-unit-contract-'));
  const units = join(root, 'units');
  mkdirSync(units);
  const parentPath = join(root, 'parent.yaml');
  const exits = ['done', 'rework', 'needs-human', 'failed'] as const;
  const parentTargets = { done: 'finished', rework: 'retry', 'needs-human': 'human-review', failed: 'stopped' } as const;
  const observedUnitInputs: unknown[] = [];
  let currentExit: typeof exits[number] = exits[0];
  try {
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(join(units, 'recipes.yaml'), "produce:\n  command: 'true'\n");
    writeFileSync(parentPath, `graph_id: parent
version: ${SIM_GRAPH_VERSION}
entry_node: invoke
terminal_nodes: [done, failed]
nodes:
  - { node_id: invoke, kind: subgraph, recipe: none, max_visits: ${SIM_NODE_VISITS}, call: worker@${SIM_GRAPH_VERSION}, budget: { inner_steps: ${SIM_UNIT_STEP_BUDGET} }, contract: { inputs: [ask], tools: none, outputs: [result, evidence] } }
  - { node_id: finished, kind: gate, recipe: none, max_visits: ${SIM_NODE_VISITS} }
  - { node_id: retry, kind: gate, recipe: none, max_visits: ${SIM_NODE_VISITS} }
  - { node_id: human-review, kind: gate, recipe: none, max_visits: ${SIM_NODE_VISITS} }
  - { node_id: stopped, kind: gate, recipe: none, max_visits: ${SIM_NODE_VISITS} }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${SIM_NODE_VISITS} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${SIM_NODE_VISITS} }
edges:
  - { from: invoke, on: outcome, map: { done: finished, rework: retry, needs-human: human-review, failed: stopped } }
  - { from: finished, to: done }
  - { from: retry, to: done }
  - { from: human-review, to: done }
  - { from: stopped, to: failed }
`);
    writeFileSync(join(units, 'worker.yaml'), `graph_id: worker
version: ${SIM_GRAPH_VERSION}
unit: { inputs: [ask], outputs: [result, evidence], exits: [done, rework, needs-human, failed] }
entry_node: produce
terminal_nodes: [done, rework, needs-human, failed]
nodes:
  - { node_id: produce, kind: agent, recipe: 'handler:capture-unit-input', max_visits: ${SIM_NODE_VISITS} }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${SIM_NODE_VISITS} }
  - { node_id: rework, kind: gate, recipe: none, max_visits: ${SIM_NODE_VISITS} }
  - { node_id: needs-human, kind: gate, recipe: none, max_visits: ${SIM_NODE_VISITS} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${SIM_NODE_VISITS} }
edges:
  - { from: produce, on: outcome, map: { done: done, rework: rework, needs-human: needs-human, failed: failed } }
`);

    const runInvalidParent = (source: string) => {
      writeFileSync(parentPath, source);
      return runGraph(parentPath, {
        input: { ask: 'compose a unit' },
        deps: { root },
      });
    };
    const parentSource = readFileSync(parentPath, 'utf8');
    const unitSource = readFileSync(join(units, 'worker.yaml'), 'utf8');
    await expect(runInvalidParent(parentSource.replace('outputs: [result, evidence]', 'outputs: [result]'))).rejects.toThrow('unit contract mismatch');
    await expect(runInvalidParent(parentSource.replace('rework: retry, ', ''))).rejects.toThrow('unit contract mismatch');
    await expect(runInvalidParent(parentSource.replace('failed: stopped }', 'failed: stopped, extra: stopped }'))).rejects.toThrow('unit contract mismatch');
    writeFileSync(join(units, 'worker.yaml'), unitSource.replace(/unit: \{[^\n]+\}\n/, ''));
    await expect(runInvalidParent(parentSource)).rejects.toThrow('unit not found');
    writeFileSync(join(units, 'worker.yaml'), unitSource);
    writeFileSync(parentPath, parentSource);

    for (const exit of exits) {
      currentExit = exit;
      const run = await runGraph(parentPath, {
        input: { ask: 'compose a unit' },
        deps: { root, inProcessHandlers: { 'capture-unit-input': async ({ input }) => {
          observedUnitInputs.push(input);
          return { ok: true, outcome: currentExit, result: `result:${currentExit}`, evidence: { exit: currentExit } };
        } } },
      });
      expect(run.path).toEqual(['invoke', parentTargets[exit], exit === 'failed' ? 'failed' : 'done']);
      expect(run.unitCalls?.[0]?.exit).toBe(exit);
      expect(JSON.parse(String(run.nodes[0]?.output))).toEqual({ outcome: exit, result: `result:${exit}`, evidence: { exit } });
      expect(observedUnitInputs.at(-1)).toEqual({ ask: 'compose a unit' });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
