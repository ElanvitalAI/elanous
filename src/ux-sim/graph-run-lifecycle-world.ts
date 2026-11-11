import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkGraphRun, manageGraphRun, runGraph } from '../graph-runner/runner.js';

export interface GraphRunLifecycleScenario {
  readonly id: 'pause-after-owner-death' | 'cancel-after-owner-death' | 'fork-after-owner-death';
  readonly status: string;
  readonly events: readonly string[];
  readonly invariant: boolean;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export async function simulateGraphRunLifecycleWorld(): Promise<readonly GraphRunLifecycleScenario[]> {
  const root = mkdtempSync(join(tmpdir(), 'graph-run-lifecycle-world-'));
  const previousStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  const graphRoot = join(root, 'world');
  mkdirSync(graphRoot, { recursive: true });
  const graphPath = join(graphRoot, 'graph.yaml');
  // Source: src/graph-runner/runner.test.ts graph fixture schema.
  writeFileSync(graphPath, `graph_id: lifecycle-world\nversion: 1\nentry_node: warm\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: warm, kind: agent, recipe: 'cmd:warm', max_visits: 1 }\n  - { node_id: work, kind: agent, recipe: 'cmd:work', max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: 'cmd:done', max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: 'cmd:failed', max_visits: 1 }\nedges:\n  - { from: warm, on: outcome, map: { ok: work, fail: failed } }\n  - { from: work, on: outcome, map: { ok: done, fail: failed } }\n`);
  writeFileSync(join(graphRoot, 'recipes.yaml'), 'warm:\n  command: warm\nwork:\n  command: work\ndone:\n  command: done\nfailed:\n  command: failed\n');
  const scenarios: GraphRunLifecycleScenario[] = [];
  const makeBlockedRun = async (runId: string, commit: string) => {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let warmCalls = 0;
    const ongoing = runGraph(graphPath, { runId, input: { commit }, deps: { root,
      processStartMs: () => null,
      runBash: async (command) => {
        if (command === 'warm') warmCalls += 1;
        if (command === 'work') { entered(); await blocked; }
        return { stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 };
      } } });
    await started;
    return { ongoing, release, warmCalls: () => warmCalls };
  };

  try {
    {
      const run = await makeBlockedRun('pause-run', 'a'.repeat(40));
      const paused = manageGraphRun('lifecycle-world', 'pause-run', 'pause', root, () => null);
      run.release();
      let ownerExitObserved = false;
      try { await run.ongoing; } catch { ownerExitObserved = true; }
      const resumed = await runGraph(graphPath, { resumeRunId: 'pause-run', fromNodeId: 'work', deps: { root,
        runBash: async () => ({ stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 }) } });
      const saved = JSON.parse(readFileSync(paused.statePath, 'utf8')) as { status: string; resume?: { previousStatus: string } };
      scenarios.push({ id: 'pause-after-owner-death', status: resumed.status,
        events: ['run-start', 'node-start(warm)', 'node-end(warm,ok)', 'node-start(work)', 'pause-requested', 'owner-exited', 'run-resumed', 'node-end(work,ok)', 'run-completed'],
        invariant: paused.status === 'paused' && ownerExitObserved && resumed.status === 'done' && run.warmCalls() === 1 &&
          saved.status === 'done' && resumed.resume?.previousStatus === 'paused',
        evidence: { pausedStatus: paused.status, finalStatus: resumed.status, warmCalls: run.warmCalls(), resume: resumed.resume } });
    }
    {
      const run = await makeBlockedRun('cancel-run', 'b'.repeat(40));
      const cancelled = manageGraphRun('lifecycle-world', 'cancel-run', 'cancel', root, () => null);
      run.release();
      let ownerExitObserved = false;
      try { await run.ongoing; } catch { ownerExitObserved = true; }
      let resumeRefused = false;
      try { await runGraph(graphPath, { resumeRunId: 'cancel-run', fromNodeId: 'work', deps: { root } }); }
      catch (error) { resumeRefused = String(error).includes('cancel'); }
      scenarios.push({ id: 'cancel-after-owner-death', status: cancelled.status,
        events: ['run-start', 'node-start(warm)', 'node-end(warm,ok)', 'node-start(work)', 'cancel-requested', 'owner-exited', 'run-cancelled'],
        invariant: cancelled.status === 'cancelled' && ownerExitObserved && resumeRefused && run.warmCalls() === 1,
        evidence: { status: cancelled.status, resumeRefused, warmCalls: run.warmCalls() } });
    }
    {
      const sourceCommit = 'c'.repeat(40);
      const targetCommit = 'd'.repeat(40);
      const run = await makeBlockedRun('fork-source', sourceCommit);
      const interrupted = manageGraphRun('lifecycle-world', 'fork-source', 'pause', root, () => null);
      run.release();
      try { await run.ongoing; } catch { /* simulated process loss leaves the durable paused receipt */ }
      const forked = forkGraphRun('lifecycle-world', 'fork-source', 'fork-target', targetCommit, {
        root, isAncestor: (ancestor, descendant) => ancestor === sourceCommit && descendant === targetCommit,
      });
      const resumed = await runGraph(graphPath, { resumeRunId: forked.runId, fromNodeId: 'work', deps: { root,
        runBash: async () => ({ stdout: '{"outcome":"ok"}', stderr: '', exitCode: 0 }) } });
      const source = JSON.parse(readFileSync(interrupted.statePath, 'utf8')) as { status: string; input?: { commit?: string } };
      const target = JSON.parse(readFileSync(forked.statePath, 'utf8')) as { status: string; input?: { commit?: string; forkedFrom?: string } };
      scenarios.push({ id: 'fork-after-owner-death', status: resumed.status,
        events: ['run-start(source)', 'node-start(work)', 'pause-requested', 'owner-exited', 'run-forked(source,target,descendant-commit)', 'run-resumed(target)', 'run-completed(target)'],
        invariant: source.status === 'paused' && source.input?.commit === sourceCommit && target.status === 'done' &&
          target.input?.commit === targetCommit && target.input?.forkedFrom === 'fork-source' && resumed.status === 'done' && run.warmCalls() === 1,
        evidence: { sourceStatus: source.status, sourceCommit: source.input?.commit, forkedRunId: forked.runId,
          targetCommit: target.input?.commit, finalStatus: resumed.status, warmCalls: run.warmCalls() } });
    }
    return scenarios;
  } finally {
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateDir;
    rmSync(root, { recursive: true, force: true });
  }
}
