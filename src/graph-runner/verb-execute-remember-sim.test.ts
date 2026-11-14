import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph, validateUnitCalls } from './runner.js';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';

type Verb = 'execute' | 'remember';
const verbs: readonly Verb[] = ['execute', 'remember'];
// Source: graph templates and calls use integer version tags.
const VERSION = 1;
// Source: one producer plus one terminal node in each unit.
const INNER_STEPS = 2;

function parentSource(verb: Verb, outputs = verb === 'execute' ? '[result, evidence, undo]' : '[result, evidence]'): string {
  return `graph_id: ta-${verb}-caller
version: ${VERSION}
entry_node: invoke
terminal_nodes: [done, failed]
nodes:
  - node_id: invoke
    kind: subgraph
    recipe: none
    max_visits: 1
    call: verb-${verb}@${VERSION}
    budget: { inner_steps: ${INNER_STEPS} }
    contract: { inputs: [ask, context, prior], tools: none, outputs: ${outputs} }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: observe, recipe: none, max_visits: 1 }
edges:
  - from: invoke
    on: outcome
    map: { done: done, rework: failed, needs-human: failed, failed: failed }
`;
}

function world(verb: Verb): { root: string; parent: string } {
  const root = mkdtempSync(join(tmpdir(), `ta-${verb}-unit-sim-`));
  mkdirSync(join(root, 'units'));
  copyFileSync(join(process.cwd(), 'graphs/units/verbs', `${verb}.yaml`), join(root, 'units', `verb-${verb}.yaml`));
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  writeFileSync(join(root, 'units', 'recipes.yaml'), '{}\n');
  const parent = join(root, 'parent.yaml');
  writeFileSync(parent, parentSource(verb));
  return { root, parent };
}

test('execute and remember units pass the node-to-TA envelope through the production graph runner', async () => {
  for (const verb of verbs) {
    const { root, parent } = world(verb);
    try {
      const parsed = parseGraphTemplateYaml(readFileSync(parent, 'utf8'), parent);
      expect(parsed.errors).toEqual([]);
      const resolved = validateUnitCalls(parsed.template!, parent);
      expect(resolved.get('invoke')?.template.graphId).toBe(`verb-${verb}`);
      expect(resolved.get('invoke')?.template.unit).toEqual({
        inputs: ['ask', 'context', 'prior'],
        outputs: verb === 'execute' ? ['result', 'evidence', 'undo'] : ['result', 'evidence'],
        exits: ['done', 'rework', 'needs-human', 'failed'],
      });
      const unit = resolved.get('invoke')!.template;
      expect(unit.nodes.find(node => node.nodeId === verb)?.maxVisits).toBe(1);
      expect(unit.edges.some(edge => Object.values(edge.map ?? {}).includes(verb))).toBe(false);

      let calls = 0;
      const input = { ask: `fake-${verb}`, context: { target: 'synthetic' }, prior: { verified: true } };
      const result = { outcome: 'done', result: `fake-${verb}-result`, evidence: { world: 'fake' },
        ...(verb === 'execute' ? { undo: 'none' } : {}) };
      const state = await runGraph(parent, { input, deps: {
        root,
        runBash: async () => { throw new Error('TA fake escaped to shell'); },
        inProcessHandlers: { [`ta-${verb}`]: async ({ input: received }) => {
          calls++;
          expect(received).toEqual(input);
          return { ok: true, ...result };
        } },
      } });
      expect(calls).toBe(1);
      expect(state.status).toBe('done');
      expect(state.unitCalls?.[0]?.exit).toBe('done');
      expect(JSON.parse(String(state.nodes[0]?.output))).toEqual(result);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('a missing TA handler and a mismatched caller envelope refuse before an effect', async () => {
  const { root, parent } = world('execute');
  try {
    const bad = parseGraphTemplateYaml(parentSource('execute', '[result, evidence]'), parent);
    expect(bad.errors).toEqual([]);
    expect(() => validateUnitCalls(bad.template!, parent)).toThrow('unit contract mismatch');
    const state = await runGraph(parent, { input: { ask: 'synthetic', context: {}, prior: {} }, deps: { root, inProcessHandlers: {},
      runBash: async () => { throw new Error('missing TA handler escaped to shell'); } } });
    expect(state.status).toBe('failed');
    expect(state.nodes[0]?.error).toContain('unknown in-process handler');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('execute cannot report done when its compensation plan is missing', async () => {
  const { root, parent } = world('execute');
  try {
    const state = await runGraph(parent, { input: { ask: 'synthetic', context: {}, prior: {} }, deps: {
      root,
      runBash: async () => { throw new Error('TA fake escaped to shell'); },
      inProcessHandlers: { 'ta-execute': async () => ({ ok: true, outcome: 'done',
        result: 'synthetic result', evidence: { world: 'fake' } }) },
    } });
    expect(state.status).toBe('failed');
    expect(state.nodes[0]?.error).toContain('unit output missing: invoke.');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('both units route every declared exit through the caller without repeating a TA effect', async () => {
  for (const verb of verbs) for (const outcome of ['rework', 'needs-human', 'failed'] as const) {
    const { root, parent } = world(verb);
    try {
      let calls = 0;
      const state = await runGraph(parent, { input: { ask: 'synthetic', context: {}, prior: {} }, deps: {
        root,
        runBash: async () => { throw new Error('TA fake escaped to shell'); },
        inProcessHandlers: { [`ta-${verb}`]: async () => {
          calls++;
          return { ok: true, outcome, result: `synthetic-${outcome}`, evidence: { world: 'fake' },
            ...(verb === 'execute' ? { undo: 'synthetic-compensation-plan' } : {}) };
        } },
      } });
      expect(calls).toBe(1);
      expect(state.unitCalls?.[0]?.exit).toBe(outcome);
      expect(state.status).not.toBe('done');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('execute effect cannot be repeated by a caller rework edge', async () => {
  const { root, parent } = world('execute');
  try {
    writeFileSync(parent, parentSource('execute').replace('rework: failed', 'rework: invoke'));
    let calls = 0;
    const state = await runGraph(parent, { input: { ask: 'synthetic', context: {}, prior: {} }, deps: {
      root,
      runBash: async () => { throw new Error('TA fake escaped to shell'); },
      inProcessHandlers: { 'ta-execute': async () => {
        calls++;
        return { ok: true, outcome: 'rework', result: 'retry requested', evidence: { world: 'fake' }, undo: 'plan' };
      } },
    } });
    expect(calls).toBe(1);
    expect(state.status).not.toBe('done');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
