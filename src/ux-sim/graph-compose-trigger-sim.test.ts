import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { appendRunLedgerEntry, loadRunLedger } from '../self-implement/run-ledger.js';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { runGraph } from '../graph-runner/runner.js';
import { loadMockScenarioCatalog } from './mock-scenario-catalog.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const SIM_NODE_VISITS = 1;
// Source: graph declaration and trigger target both use integer graph version tags.
const SIM_GRAPH_VERSION = 1;

const targetYaml = `graph_id: compose-target
version: ${SIM_GRAPH_VERSION}
inputs:
  required: [topic]
  properties: { topic: { type: string } }
entry_node: accept
terminal_nodes: [done]
nodes:
  - { node_id: accept, kind: agent, recipe: handler:observe-trigger-input, max_visits: ${SIM_NODE_VISITS} }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${SIM_NODE_VISITS} }
edges:
  - { from: accept, on: outcome, map: { done: done } }
`;

const parentYaml = `graph_id: compose-parent
version: ${SIM_GRAPH_VERSION}
entry_node: launch
terminal_nodes: [done, failed]
nodes:
  - { node_id: launch, kind: agent, recipe: handler:trigger-target, max_visits: ${SIM_NODE_VISITS} }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${SIM_NODE_VISITS} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${SIM_NODE_VISITS} }
edges:
  - { from: launch, on: outcome, map: { done: done, failed: failed } }
`;

type TriggerReceipt = { accepted: true; childRunId: string; completion: Promise<Awaited<ReturnType<typeof runGraph>>> }
  | { accepted: false; issues: string[] };

type GraphRunCompletion = Promise<Awaited<ReturnType<typeof runGraph>>>;

function validateTargetInputs(declaration: unknown, supplied: unknown): string[] {
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)
    || !supplied || typeof supplied !== 'object' || Array.isArray(supplied)) return ['inputs must be an object'];
  const contract = declaration as { required?: unknown; properties?: unknown };
  const input = supplied as Record<string, unknown>;
  const properties = contract.properties && typeof contract.properties === 'object' && !Array.isArray(contract.properties)
    ? contract.properties as Record<string, { type?: unknown }> : {};
  const required = Array.isArray(contract.required) ? contract.required.filter((key): key is string => typeof key === 'string') : [];
  const issues = required.filter((key) => !Object.hasOwn(input, key)).map((key) => `missing required input: ${key}`);
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!property) issues.push(`unknown input: ${key}`);
    else if (property.type === 'string' && typeof value !== 'string') issues.push(`input must be a string: ${key}`);
  }
  return issues;
}

function setupWorld(options: { holdChild?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'graph-compose-trigger-sim-'));
  roots.push(root);
  const graphs = join(root, 'graphs');
  mkdirSync(graphs);
  const parentPath = join(graphs, 'parent.yaml');
  const targetPath = join(graphs, 'target.yaml');
  writeFileSync(parentPath, parentYaml);
  writeFileSync(targetPath, targetYaml);
  writeFileSync(join(graphs, 'recipes.yaml'), '{}\n');
  const parsedTarget = parseGraphTemplateYaml(targetYaml, targetPath);
  expect(parsedTarget.errors).toEqual([]);
  const targetDeclaration = (parseYaml(targetYaml) as { inputs?: unknown }).inputs;
  const ledgerDir = join(root, 'run-ledger');
  let started = 0;
  const receivedInputs: unknown[] = [];
  let completion: GraphRunCompletion | undefined;
  let childFinished = false;
  let childStartedSeen = false;
  let markChildStarted!: () => void;
  let rejectChildStarted!: (error: Error) => void;
  const childStarted = new Promise<void>((resolve, reject) => { markChildStarted = resolve; rejectChildStarted = reject; });
  let releaseChild: (() => void) | undefined;
  const childGate = options.holdChild ? new Promise<void>((resolve) => { releaseChild = resolve; }) : undefined;

  async function trigger(input: { parentRunId: string; childRunId: string; inputs: unknown; awaitChild: boolean }): Promise<TriggerReceipt> {
    const issues = validateTargetInputs(targetDeclaration, input.inputs);
    if (issues.length) return { accepted: false, issues };
    started += 1;
    appendRunLedgerEntry({ runId: input.parentRunId, event: 'graph-trigger-dispatched', data: {
      childRunId: input.childRunId, graphId: parsedTarget.template!.graphId,
    } }, ledgerDir);
    appendRunLedgerEntry({ runId: input.childRunId, event: 'graph-trigger-started', data: {
      graphId: parsedTarget.template!.graphId, parentRunId: input.parentRunId,
    } }, ledgerDir);
    completion = runGraph(targetPath, { runId: input.childRunId, input: input.inputs, deps: { root,
      inProcessHandlers: { 'observe-trigger-input': async ({ input: childInput }) => {
        receivedInputs.push(childInput);
        childStartedSeen = true;
        markChildStarted();
        await childGate;
        return { ok: true, outcome: 'done', result: { accepted: true }, evidence: { childInput } };
      } },
    } });
    completion = completion.then((state) => { childFinished = true; return state; });
    if (!input.awaitChild) return { accepted: true, childRunId: input.childRunId, completion };
    await completion;
    return { accepted: true, childRunId: input.childRunId, completion };
  }

  async function waitForChildStarted(): Promise<void> {
    const childRun = completion;
    if (!childRun) throw new Error('trigger did not create a child run');
    await Promise.race([childStarted, childRun.then(() => {
      if (!childStartedSeen) throw new Error('child run completed before its handler started');
    })]);
  }

  return { root, parentPath, targetPath, ledgerDir, trigger, get started() { return started; }, receivedInputs,
    get completion() { return completion; }, get childFinished() { return childFinished; }, childStarted,
    rejectChildStarted, waitForChildStarted, get childStartedSeen() { return childStartedSeen; }, releaseChild: () => releaseChild?.() };
}

test('SIM-GRAPH-COMPOSE-TRIGGER: a fake target validates inputs and stores parent-child run lineage', async () => {
  const world = setupWorld({ holdChild: true });
  const refusedMissing = await world.trigger({ parentRunId: 'parent-missing', childRunId: 'child-missing', inputs: {}, awaitChild: false });
  const refusedType = await world.trigger({ parentRunId: 'parent-type', childRunId: 'child-type', inputs: { topic: 42 }, awaitChild: false });
  expect(refusedMissing).toMatchObject({ accepted: false, issues: ['missing required input: topic'] });
  expect(refusedType).toMatchObject({ accepted: false, issues: ['input must be a string: topic'] });
  expect(world.started).toBe(0);
  expect(loadRunLedger('child-missing', world.ledgerDir)).toBeNull();

  try {
    const parent = await runGraph(world.parentPath, { runId: 'parent-fire', input: { topic: 'graph composition' }, deps: { root: world.root,
      inProcessHandlers: { 'trigger-target': async ({ runId, input }) => {
        const topic = (input as { topic: string }).topic;
        const receipt = await world.trigger({ parentRunId: runId, childRunId: 'child-fire', inputs: { topic }, awaitChild: false });
        return { ok: true, outcome: receipt.accepted ? 'done' : 'failed', result: receipt.accepted ? { childRunId: receipt.childRunId } : receipt.issues };
      } },
    } });
    expect(parent.status).toBe('done');
    await world.waitForChildStarted();
    expect(world.started).toBe(1);
    expect(world.childFinished).toBe(false);
    expect(world.receivedInputs).toEqual([{ topic: 'graph composition' }]);
    expect(loadRunLedger('child-fire', world.ledgerDir)).toMatchObject([{ event: 'graph-trigger-started', data: {
      graphId: 'compose-target', parentRunId: 'parent-fire',
    } }]);
    expect(loadRunLedger('parent-fire', world.ledgerDir)).toMatchObject([{ event: 'graph-trigger-dispatched', data: {
      childRunId: 'child-fire', graphId: 'compose-target',
    } }]);
  } finally {
    world.releaseChild();
    await world.completion;
  }
});

test('SIM-GRAPH-COMPOSE-TRIGGER: await mode returns a completed separate target run', async () => {
  const world = setupWorld({ holdChild: true });
  let parentFinished = false;
  const parentCompletion = runGraph(world.parentPath, { runId: 'parent-await', input: { topic: 'awaited topic' }, deps: { root: world.root,
    inProcessHandlers: { 'trigger-target': async ({ runId, input }) => {
      const topic = (input as { topic: string }).topic;
      const receipt = await world.trigger({ parentRunId: runId, childRunId: 'child-await', inputs: { topic }, awaitChild: true });
      return { ok: true, outcome: receipt.accepted ? 'done' : 'failed', result: receipt.accepted ? { childRunId: receipt.childRunId } : receipt.issues };
    } },
  } }).then((state) => { parentFinished = true; return state; }).catch((error: unknown) => {
    if (!world.childStartedSeen) world.rejectChildStarted(error instanceof Error ? error : new Error(String(error)));
    throw error;
  });
  let parent: Awaited<ReturnType<typeof runGraph>>;
  try {
    await world.childStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(parentFinished).toBe(false);
  } finally {
    world.releaseChild();
    parent = await parentCompletion;
  }
  expect(parent.status).toBe('done');
  expect(parentFinished).toBe(true);
  expect(world.childFinished).toBe(true);
  expect(world.receivedInputs).toEqual([{ topic: 'awaited topic' }]);
  expect(loadRunLedger('child-await', world.ledgerDir)).toMatchObject([{ data: { parentRunId: 'parent-await' } }]);
});

test('SIM-GRAPH-COMPOSE-TRIGGER: Nexus mock catalog registers the focused trigger simulator', () => {
  const device = loadMockScenarioCatalog().devices.find((row) => row.id === 'graph-compose-trigger-sim');
  expect(device?.implementation).toEqual(['src/graph-runner/runner.ts', 'src/self-implement/graph-yaml.ts', 'src/self-implement/run-ledger.ts']);
  expect(device?.tests).toContain('src/ux-sim/graph-compose-trigger-sim.test.ts');
  expect(device?.entryCommands).toContain('bun test src/ux-sim/graph-compose-trigger-sim.test.ts');
});
