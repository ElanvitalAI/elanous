import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideGraphApproval, runGraph } from '../graph-runner/runner.js';

export interface GraphResumeAnyEntryScenario {
  readonly id: 'hitl-receipt' | 'budget-exceeded' | 'repeated-approval' | 'healed-edge' | 'arg-instance';
  readonly status: string;
  readonly path: readonly string[];
  readonly invariant: boolean;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export async function simulateGraphResumeAnyEntry(): Promise<readonly GraphResumeAnyEntryScenario[]> {
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'resume-any-entry-world-'));
  const previousStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = sandboxRoot;
  const makeWorld = (id: string, graph: string, recipes: string) => {
    const root = join(sandboxRoot, id);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'recipes.yaml'), recipes);
    const graphPath = join(root, 'graph.yaml');
    writeFileSync(graphPath, graph);
    return { root, graphPath };
  };
  const node = (id: string, recipe = `cmd:${id}`, maxVisits = 1) => `  - { node_id: ${id}, kind: agent, recipe: '${recipe}', max_visits: ${maxVisits} }`;
  const terminals = '  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }';
  const results: GraphResumeAnyEntryScenario[] = [];

  try {
    // A completed node's durable receipt stays byte-for-byte stable while approval waits and resumes.
    {
      const world = makeWorld('hitl', `graph_id: resume-hitl\nversion: 1\nentry_node: source\nterminal_nodes: [done, failed]\nnodes:\n${node('source')}\n  - { node_id: approval, kind: judge, recipe: 'approval:publish', max_visits: 1 }\n${terminals}\nedges:\n  - { from: source, to: approval }\n  - { from: approval, on: outcome, map: { ok: done, fail: failed } }\n`,
        'source:\n  command: source\npublish:\n  approval: Publish?\n');
      const deps = { root: world.root, runBash: async () => ({ stdout: '{"outcome":"ok","receipt":"source-receipt-1"}', stderr: '', exitCode: 0 }) };
      const paused = await runGraph(world.graphPath, { runId: 'hitl-one', deps });
      const receipt = JSON.stringify(paused.nodes[0]?.output);
      decideGraphApproval(paused.graphId, paused.runId, 'approved', 'sim-operator', world.root);
      const resumed = await runGraph(world.graphPath, { resumeRunId: paused.runId, deps });
      results.push({ id: 'hitl-receipt', status: resumed.status, path: resumed.path,
        invariant: paused.status === 'awaiting-approval' && resumed.status === 'done' &&
          JSON.stringify(resumed.nodes[0]?.output) === receipt && resumed.nodes[0]?.executionId === paused.nodes[0]?.executionId,
        evidence: { receipt, preserved: JSON.stringify(resumed.nodes[0]?.output), resumeFrom: resumed.resume?.from } });
    }

    // Inject a persisted budget stop, then exercise the production explicit budget-resume guard and counter reset.
    {
      const world = makeWorld('budget', `graph_id: release-loop\nversion: 1\nentry_node: cutoff\nterminal_nodes: [done, failed]\nnodes:\n${node('cutoff')}\n${terminals}\nedges:\n  - { from: cutoff, on: outcome, map: { ok: done, fail: failed, error: failed } }\n`,
        'cutoff:\n  command: bun scripts/release-loop/node-verdict.ts cutoff\n');
      let attempts = 0;
      const deps = { root: world.root, runBash: async () => ({ stdout: '', stderr: '', exitCode: ++attempts === 1 ? 1 : 0 }) };
      const stopped = await runGraph(world.graphPath, { runId: 'budget-one', deps });
      const saved = JSON.parse(readFileSync(stopped.statePath, 'utf8')) as Record<string, unknown>;
      saved.status = 'budget-exceeded';
      writeFileSync(stopped.statePath, JSON.stringify(saved));
      const resumed = await runGraph(world.graphPath, { resumeRunId: stopped.runId, fromNodeId: 'cutoff',
        releaseBudgetExceededResume: { reason: 'simulated budget recovery' }, deps });
      results.push({ id: 'budget-exceeded', status: resumed.status, path: resumed.path,
        invariant: resumed.status === 'done' && resumed.resume?.previousStatus === 'budget-exceeded' &&
          resumed.resume.budgetReset?.reason === 'simulated budget recovery',
        evidence: { previousStatus: resumed.resume?.previousStatus, budgetReset: resumed.resume?.budgetReset } });
    }

    // Approval is crossed only after its recorded decision; exact visit identity selects the second gate visit.
    {
      const world = makeWorld('repeated', `graph_id: resume-repeated\nversion: 1\nentry_node: gate\nterminal_nodes: [done, failed]\nnodes:\n${node('gate', 'cmd:gate', 2)}\n${node('triage')}\n  - { node_id: approval, kind: judge, recipe: 'approval:publish', max_visits: 1 }\n${terminals}\nedges:\n  - from: gate\n    on: outcome\n    map: { again: triage, ok: done, fail: failed }\n  - { from: triage, to: approval }\n  - { from: approval, to: gate }\n`,
        'gate:\n  command: gate\ntriage:\n  command: triage\npublish:\n  approval: Approve repair?\n');
      let gateCalls = 0;
      const deps = { root: world.root, runBash: async (command: string) => ({
        stdout: command === 'gate' ? JSON.stringify({ outcome: ++gateCalls === 1 ? 'again' : 'fail' }) : '{"outcome":"ok"}',
        stderr: '', exitCode: 0,
      }) };
      const waiting = await runGraph(world.graphPath, { runId: 'repeat-one', deps });
      decideGraphApproval(waiting.graphId, waiting.runId, 'approved', 'sim-operator', world.root);
      const failed = await runGraph(world.graphPath, { resumeRunId: waiting.runId, deps });
      const secondGateVisit = failed.nodes.filter(record => record.nodeId === 'gate')[1]!.executionId!;
      const resumed = await runGraph(world.graphPath, { resumeRunId: failed.runId, fromVisitId: secondGateVisit,
        deps: { ...deps, runBash: async () => ({ stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 }) } });
      results.push({ id: 'repeated-approval', status: resumed.status, path: resumed.path,
        invariant: waiting.status === 'awaiting-approval' && failed.status === 'failed' && resumed.status === 'done' &&
          resumed.resume?.visitId === secondGateVisit && resumed.nodes.some(record => record.nodeId === 'approval' && record.ok),
        evidence: { secondGateVisit, resume: resumed.resume, approvalRecorded: resumed.nodes.some(record => record.nodeId === 'approval' && record.ok) } });
    }

    // A simulated self-heal grows the real runner graph before failure; resuming the exact downstream visit retains that edge.
    {
      const world = makeWorld('heal', `graph_id: resume-heal\nversion: 1\ngrow: on\nentry_node: first\nterminal_nodes: [done, failed]\nnodes:\n${node('first')}\n${node('second')}\n${terminals}\nedges:\n  - { from: first, on: outcome, map: { ok: second, fail: failed } }\n  - { from: second, on: outcome, map: { ok: done, fail: failed } }\n`,
        'first:\n  command: first\nsecond:\n  command: second\narg-repair:\n  command: repair\n');
      let calls = 0;
      const deps = { root: world.root, growthScope: 'task-agent' as const,
        growthProposer: () => ({ node: { nodeId: 'arg-repair', kind: 'agent', recipe: 'cmd:arg-repair', maxVisits: 1,
          contract: { inputs: [], tools: 'read-only' as const, outputs: [] } }, returnTo: 'second', reason: 'healing adds repair edge' }),
        classifyGrowthRecipe: () => 'read-only' as const,
        runBash: async (command: string) => ({ stdout: command === 'first' ? '{"outcome":"new"}' : '', stderr: '',
          exitCode: command === 'second' && ++calls === 1 ? 1 : 0 }) };
      const failed = await runGraph(world.graphPath, { runId: 'heal-one', deps });
      const repairVisit = failed.nodes.find(record => record.nodeId === 'arg-repair')?.executionId;
      const resumed = await runGraph(world.graphPath, { resumeRunId: failed.runId, fromVisitId: repairVisit,
        deps: { ...deps, growthProposer: () => { throw new Error('healing must not be proposed again'); },
          runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } });
      results.push({ id: 'healed-edge', status: resumed.status, path: resumed.path,
        invariant: failed.status === 'failed' && !!repairVisit && resumed.status === 'done' && resumed.growth?.length === 1 &&
          resumed.resume?.visitId === repairVisit && resumed.resume.from === 'arg-repair' &&
          resumed.nodes.some(record => record.nodeId === 'arg-repair' && record.executionId !== repairVisit),
        evidence: { repairVisit, growth: resumed.growth, resume: resumed.resume } });
    }

    // Two persisted ARG instances share a graph template but not state; a visit resume touches only its named instance.
    {
      const world = makeWorld('instances', `graph_id: arg-instance\nversion: 1\nentry_node: work\nterminal_nodes: [done, failed]\nnodes:\n${node('work', 'cmd:work', 2)}\n${terminals}\nedges:\n  - { from: work, on: outcome, map: { again: work, ok: done, fail: failed } }\n`,
        'work:\n  command: work\n');
      const makeDeps = (fail: boolean) => { let n = 0; return { root: world.root,
        runBash: async () => ({ stdout: JSON.stringify({ outcome: ++n === 1 ? 'again' : fail ? 'fail' : 'ok' }), stderr: '', exitCode: 0 }) }; };
      const [first, second] = await Promise.all([
        runGraph(world.graphPath, { runId: 'arg-A', deps: makeDeps(true) }),
        runGraph(world.graphPath, { runId: 'arg-B', deps: makeDeps(true) }),
      ]);
      const firstVisit = first.nodes[0]!.executionId!;
      const resumed = await runGraph(world.graphPath, { resumeRunId: first.runId, fromVisitId: firstVisit,
        deps: { ...makeDeps(false), runBash: async () => ({ stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 }) } });
      const untouched = JSON.parse(readFileSync(second.statePath, 'utf8')) as { status: string; path: string[] };
      results.push({ id: 'arg-instance', status: resumed.status, path: resumed.path,
        invariant: first.status === 'failed' && second.status === 'failed' && resumed.status === 'done' &&
          untouched.status === 'failed' && untouched.path.join(',') === second.path.join(','),
        evidence: { resumedRunId: resumed.runId, untouchedRunId: second.runId, untouchedStatus: untouched.status,
          selectedVisit: firstVisit, resume: resumed.resume } });
    }
    return results;
  } finally {
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateDir;
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
}
