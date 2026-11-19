import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runArgSupervisorTick, type ArgMutationState, type ArgSupervisorPorts } from './arg-supervisor.js';
import { listGraphRuns } from './runner.js';

const releaseDir = resolve(import.meta.dir, '../../graphs/release');
const loopId = 'loop:event-trigger-watch@1';
const loopSource = `apiVersion: elanous.dev/loop/v1
id: '${loopId}'
card: { title: Event Trigger Watch, supervises: [release-loop], role: primary, extensions: [elanous.dev/arg] }
authority: [reroute, add-node, repair, hitl]
policy:
  scope: run
  approval: { resultType: input_required }
knowledgePacks: [../release-edge-vocabulary.yaml, ../macrophage-subscriber.yaml]
templateMemory: { graph: ../release-loop.yaml }
graph: ./supervisor.yaml
`;
const targetSource = `graph_id: release-loop
version: 1
supervisors:
  - { ref: '${loopId}', role: primary, scope: run, authority: [reroute, add-node, repair, hitl], requires: [elanous.dev/arg] }
entry_node: gate
terminal_nodes: [done]
nodes:
  - { node_id: gate, kind: gate, recipe: none, max_visits: 2 }
  - { node_id: gate-triage, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: gate, on: outcome, map: { fail: gate-triage, ok: done } }
  - { from: gate-triage, on: outcome, map: { ok: done } }
`;
const supervisorSource = `graph_id: event-trigger-supervisor
version: 1
entry_node: observe
terminal_nodes: [done, failed, needs-human]
nodes:
  - { node_id: observe, kind: agent, recipe: 'cmd:observe', max_visits: 1 }
  - { node_id: propose, kind: agent, recipe: 'cmd:propose', max_visits: 1 }
  - { node_id: validate, kind: judge, recipe: 'cmd:validate', max_visits: 1 }
  - { node_id: apply, kind: agent, recipe: 'cmd:apply', max_visits: 1 }
  - { node_id: verify, kind: gate, recipe: 'cmd:verify', max_visits: 1 }
  - { node_id: rollback, kind: agent, recipe: 'cmd:rollback', max_visits: 1 }
  - { node_id: needs-human, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: observe, on: outcome, map: { ok: propose, fail: failed } }
  - { from: propose, on: outcome, map: { ok: validate, fail: failed } }
  - { from: validate, on: outcome, map: { ok: apply, input_required: needs-human, fail: failed } }
  - { from: apply, on: outcome, map: { ok: verify, input_required: needs-human, fail: failed } }
  - { from: verify, on: outcome, map: { ok: done, fail: rollback } }
  - { from: rollback, on: outcome, map: { ok: failed, fail: failed } }
`;
const recipesSource = `observe: { command: 'arg:observe' }
propose: { command: 'arg:propose' }
validate: { command: 'arg:validate' }
apply: { command: 'arg:apply' }
verify: { command: 'arg:verify' }
rollback: { command: 'arg:rollback' }
`;
// Source: initial graph revision fixture from graphs/release/rla/loop.yaml ARG contract.
const initialRevision = 1;
const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated supervisor' });
const ports: ArgSupervisorPorts = {
  observe: ok,
  propose: () => ({ ...ok(), effect: { kind: 'retry-edge', from: 'gate-triage', to: 'gate',
    triggerEvent: 'release.gate.failed', rationale: 'event trigger supervisor retry' } }),
  validate: ok,
  verify: ok,
};

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { root: string; loopPath: string; graphs: string } {
  const root = mkdtempSync(join(tmpdir(), 'arg-supervisor-event-trigger-'));
  roots.push(root);
  const loopDir = join(root, 'event-trigger-watch');
  const graphs = join(root, 'graphs');
  mkdirSync(loopDir, { recursive: true });
  mkdirSync(graphs, { recursive: true });
  writeFileSync(join(loopDir, 'loop.yaml'), loopSource);
  writeFileSync(join(loopDir, 'supervisor.yaml'), supervisorSource);
  writeFileSync(join(loopDir, 'recipes.yaml'), recipesSource);
  writeFileSync(join(root, 'release-loop.yaml'), targetSource);
  writeFileSync(join(root, 'release-edge-vocabulary.yaml'), readFileSync(join(releaseDir, 'release-edge-vocabulary.yaml'), 'utf8'));
  writeFileSync(join(root, 'macrophage-subscriber.yaml'), readFileSync(join(releaseDir, 'macrophage-subscriber.yaml'), 'utf8'));
  writeFileSync(join(graphs, 'recipes.yaml'), '{}\n');
  return { root, loopPath: join(loopDir, 'loop.yaml'), graphs };
}

function writeListener(graphs: string, id: string, on: string): void {
  writeFileSync(join(graphs, `${id}.yaml`), `graph_id: ${id}\nversion: 1\ntriggers:\n  event: { from: '${loopId}', on: ${on} }\nentry_node: done\nterminal_nodes: [done]\nnodes:\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges: []\n`);
}

const tick = (f: ReturnType<typeof fixture>, tickPorts: ArgSupervisorPorts = ports) => runArgSupervisorTick({ loopPath: f.loopPath, root: f.root,
  targetGraphId: 'release-loop', targetRunId: 'release-run', gateEventId: 'gate-failed-1',
  graphRevision: initialRevision, operation: 'reroute', eventTriggerRoot: f.root,
  mutableState: { graphRevision: initialRevision, adaptiveGraphEdges: [], adaptiveGraphVocabulary: [] } satisfies ArgMutationState,
  ports: tickPorts });

test('failed and rolled-back ticks never trigger a supervisor.complete listener', async () => {
  for (const failure of ['observe', 'verify'] as const) {
    const f = fixture();
    writeListener(f.graphs, 'listener', 'supervisor.complete');
    const result = await tick(f, { ...ports, [failure]: () => ({ outcome: 'fail', evidence: 'test failure' }) });
    expect(result.graphRun.path.at(-1)).toBe('failed');
    expect(result.graphRun.path.includes('rollback')).toBe(failure === 'verify');
    expect(listGraphRuns(f.root).runs.filter(run => run.graphId === 'listener')).toEqual([]);
  }
});

test('a completed supervisor tick starts the graph declaring {from: supervisor, on: supervisor.complete} once', async () => {
  const f = fixture();
  writeListener(f.graphs, 'listener', 'supervisor.complete');
  writeListener(f.graphs, 'needs-human-listener', 'supervisor.input_required');

  const result = await tick(f);

  expect(result.resultType).toBe('complete');
  const listenerRuns = listGraphRuns(f.root).runs.filter(run => run.graphId === 'listener');
  expect(listenerRuns.map(run => run.status)).toEqual(['done']);
  expect(listenerRuns[0]?.input).toMatchObject({ supervisorEvent: { supervisorId: loopId, type: 'supervisor.complete',
    targetGraphId: 'release-loop', targetRunId: 'release-run', eventId: 'gate-failed-1' } });
  expect(listGraphRuns(f.root).runs.some(run => run.graphId === 'needs-human-listener')).toBe(false);
});

test('concurrent ticks dispatch one completion and never execute the denied tick', async () => {
  const f = fixture();
  writeListener(f.graphs, 'listener', 'supervisor.complete');
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let observations = 0;
  const first = tick(f, { ...ports, observe: async () => {
    observations++; start(); await blocked; return ok();
  } });
  await started;
  const second = tick(f, { ...ports, observe: () => { observations++; return ok(); } })
    .then(() => null, (error: Error) => error.message);
  release();
  const [result, denied] = await Promise.all([first, second]);
  expect(result.graphRun.path.at(-1)).toBe('done');
  expect(denied).toBe('RLA incident claim denied: incident already completed');
  expect(observations).toBe(1);
  expect(listGraphRuns(f.root).runs.filter(run => run.graphId === 'listener').map(run => run.status)).toEqual(['done']);
});

test('a broken listener declaration is logged and leaves the supervisor result unchanged', async () => {
  const f = fixture();
  writeFileSync(join(f.graphs, 'broken.yaml'), `graph_id: broken\ntriggers:\n  event: { from: '${loopId}', on: 42 }\n`);

  const result = await tick(f);

  expect(result.resultType).toBe('complete');
  expect(result.graphRun.path.at(-1)).toBe('done');
  expect(listGraphRuns(f.root).runs.some(run => run.graphId === 'broken')).toBe(false);
});
