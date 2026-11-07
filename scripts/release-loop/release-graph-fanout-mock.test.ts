import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from '../../src/graph-runner/runner.js';

type Branch = { id: string; outcome: 'done' | 'failed'; artifact: string };
type BranchState = Branch & { runs: number };

/** Test-only state machine: it does not load or execute release YAML or the production graph runner. */
async function runMockFanout(
  plan: readonly Branch[],
  prior: ReadonlyMap<string, BranchState> = new Map(),
) {
  const started: string[] = [];
  const ended: string[] = [];
  const events: string[] = [];
  const selected = plan.filter((branch) => prior.get(branch.id)?.outcome !== 'done');
  const states = new Map(prior);
  let joinOpened = false;
  let joinOpenCount = 0;
  const openJoinWhenReady = () => {
    if (!joinOpened && plan.every((branch) => states.has(branch.id))) {
      joinOpened = true;
      joinOpenCount++;
    }
  };
  const current = await Promise.all(selected.map(async (branch) => {
    started.push(branch.id);
    events.push(`start:${branch.id}`);
    const delayMs = branch.id === 'docs-land' ? 15 : branch.id === 'notes-check' ? 10 : 5;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    ended.push(branch.id);
    events.push(`end:${branch.id}`);
    const state = { ...branch, runs: (prior.get(branch.id)?.runs ?? 0) + 1 } satisfies BranchState;
    states.set(branch.id, state);
    openJoinWhenReady();
    return state;
  }));
  openJoinWhenReady();
  const failuresById = new Map([...states.values()]
    .filter((branch) => branch.outcome === 'failed').map((branch) => [branch.id, branch]));
  return { started, ended, events, states, joinOpened, joinOpenCount, failuresById, ran: current.length };
}

test('RELEASE-GRAPH-FANOUT mock: join waits for independent branches and resume reruns only failed branch', async () => {
  const plan: Branch[] = [
    { id: 'docs-land', outcome: 'failed', artifact: 'docs-attempt-1' },
    { id: 'version-dev-bump', outcome: 'done', artifact: 'version-pr-1' },
    { id: 'notes-check', outcome: 'done', artifact: 'notes-proof-1' },
  ];

  const first = await runMockFanout(plan);
  expect(first.started).toEqual(['docs-land', 'version-dev-bump', 'notes-check']);
  expect(first.ended).toEqual(['version-dev-bump', 'notes-check', 'docs-land']);
  expect(first.events.slice(0, 3)).toEqual(['start:docs-land', 'start:version-dev-bump', 'start:notes-check']);
  expect(first.events.slice(3)).toEqual(['end:version-dev-bump', 'end:notes-check', 'end:docs-land']);
  expect(first.joinOpened).toBe(true);
  expect(first.joinOpenCount).toBe(1);
  expect([...first.failuresById.keys()]).toEqual(['docs-land']);
  expect(first.states.get('version-dev-bump')).toMatchObject({ runs: 1, artifact: 'version-pr-1' });

  const retryPlan = plan.map((branch) => branch.id === 'docs-land'
    ? { ...branch, outcome: 'done' as const, artifact: 'docs-attempt-2' } : branch);
  const resumed = await runMockFanout(retryPlan, first.states);
  expect(resumed.ran).toBe(1);
  expect(resumed.started).toEqual(['docs-land']);
  expect(resumed.joinOpened).toBe(true);
  expect(resumed.joinOpenCount).toBe(1);
  expect(resumed.failuresById.size).toBe(0);
  expect(resumed.states.get('docs-land')).toMatchObject({ runs: 2, artifact: 'docs-attempt-2' });
  expect(resumed.states.get('version-dev-bump')).toEqual(first.states.get('version-dev-bump'));
  expect(resumed.states.get('notes-check')).toEqual(first.states.get('notes-check'));
});

test('RELEASE-GRAPH-FANOUT mock: multiple failures remain separate and prevent publish', async () => {
  const plan: Branch[] = [
    { id: 'docs-land', outcome: 'failed', artifact: 'docs-error' },
    { id: 'version-dev-bump', outcome: 'failed', artifact: 'bump-error' },
    { id: 'notes-check', outcome: 'done', artifact: 'notes-proof' },
  ];
  const result = await runMockFanout(plan);
  expect(result.joinOpened).toBe(true);
  expect(result.joinOpenCount).toBe(1);
  expect([...result.failuresById.keys()]).toEqual(['version-dev-bump', 'docs-land']);
  expect(result.failuresById.get('docs-land')).toMatchObject({ artifact: 'docs-error', outcome: 'failed' });
  expect(result.failuresById.get('version-dev-bump')).toMatchObject({ artifact: 'bump-error', outcome: 'failed' });
  expect(result.states.get('notes-check')).toMatchObject({ outcome: 'done', artifact: 'notes-proof', runs: 1 });
  const publishAllowed = result.failuresById.size === 0;
  expect(publishAllowed).toBe(false);
});

test('RELEASE-GRAPH-FANOUT event injection: release YAML joins docs-land and version bump; resume runs only failed branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-graph-fanout-runner-'));
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const calls = new Map<string, number>();
  const lifecycle: Array<{ event: string; graphId: string; runId: string; nodeId: string }> = [];
  let failDocsLand = true;
  let activeBranches = 0;
  let maxActiveBranches = 0;
  const runBash = async (_command: string, options: { env?: NodeJS.ProcessEnv }) => {
    const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
    if (!contextPath) throw new Error('mock runner did not receive graph context');
    const context = JSON.parse(await Bun.file(contextPath).text()) as { nodeId: string };
    calls.set(context.nodeId, (calls.get(context.nodeId) ?? 0) + 1);
    if (context.nodeId === 'docs-land' || context.nodeId === 'version-dev-bump') {
      activeBranches++;
      maxActiveBranches = Math.max(maxActiveBranches, activeBranches);
      // Leave enough delay for the child graph runner's synchronous setup on a busy host; this tests
      // overlapping node execution, not which branch happened to finish during startup overhead.
      await Bun.sleep(context.nodeId === 'docs-land' ? 1_000 : 800);
      activeBranches--;
      const ok = context.nodeId !== 'docs-land' || !failDocsLand;
      return { stdout: JSON.stringify({ outcome: ok ? 'ok' : 'fail', artifact: `${context.nodeId}-${calls.get(context.nodeId)}` }), stderr: '', exitCode: ok ? 0 : 1 };
    }
    const extra = context.nodeId === 'version-release' ? { version: '0.2.44', commit: 'a'.repeat(40), branch: 'release/0.2.44' } : {};
    return { stdout: JSON.stringify({ outcome: 'ok', ...extra }), stderr: '', exitCode: 0 };
  };
  try {
    const first = await runGraph(graph, { input: { version: '0.2.44', branchCut: true }, deps: { root, runBash,
      log: (event, data) => {
        if (event === 'node-start' || event === 'node-end') {
          lifecycle.push({ event, graphId: String(data.graphId), runId: String(data.runId), nodeId: String(data.nodeId) });
        }
      } } });
    expect(first.status).toBe('failed');
    expect(maxActiveBranches).toBe(2);
    const fanout = first.fanOuts?.['traffic-npm-published:ok'];
    expect(fanout).toBeDefined();
    const branchRunIds = new Set(Object.values(fanout!.branches).map((branch) => branch.runId));
    const activeNodes = new Map<string, string>();
    const lifecyclePairingErrors: string[] = [];
    let maxConcurrentNodes = 0;
    let maxConcurrentNodeIds: string[] = [];
    for (const event of lifecycle) {
      if (event.graphId !== first.graphId || !branchRunIds.has(event.runId)) continue;
      const key = `${event.runId}:${event.nodeId}`;
      if (event.event === 'node-start') {
        if (activeNodes.has(key)) lifecyclePairingErrors.push(`duplicate start: ${key}`);
        activeNodes.set(key, event.nodeId);
        if (activeNodes.size > maxConcurrentNodes) {
          maxConcurrentNodes = activeNodes.size;
          maxConcurrentNodeIds = [...new Set(activeNodes.values())].sort();
        }
      } else {
        if (!activeNodes.has(key)) lifecyclePairingErrors.push(`end without start: ${key}`);
        activeNodes.delete(key);
      }
    }
    expect(lifecyclePairingErrors).toEqual([]);
    expect([...activeNodes.keys()]).toEqual([]);
    const concurrencyMeasurement = { graphId: first.graphId, runId: first.runId, concurrentNodes: maxConcurrentNodes,
      concurrentNodeIds: maxConcurrentNodeIds, branchRunIds: [...branchRunIds].sort() };
    console.info(`[release-concurrency-measurement] ${JSON.stringify(concurrencyMeasurement)}`);
    expect(branchRunIds.size).toBe(2);
    const startedBranchRunIds = new Set(lifecycle
      .filter((event) => event.event === 'node-start' && branchRunIds.has(event.runId)).map((event) => event.runId));
    expect([...startedBranchRunIds].sort()).toEqual([...branchRunIds].sort());
    expect(concurrencyMeasurement.concurrentNodes).toBe(2);
    expect(concurrencyMeasurement.concurrentNodeIds).toEqual(['docs-land', 'version-dev-bump']);
    expect(fanout?.branches).toMatchObject({
      'docs-land': { status: 'failed', output: expect.any(String), artifactSha256: expect.any(String) },
      'version-dev-bump': { status: 'done', output: expect.any(String), artifactSha256: expect.any(String) },
    });
    expect(calls.get('publish')).toBe(1); // This command is intercepted by runBash; no publish process runs.
    const completedBump = { ...first.fanOuts!['traffic-npm-published:ok']!.branches['version-dev-bump']! };

    failDocsLand = false;
    const cutTip = 'a'.repeat(40);
    const sourceGit = (args: string[]) => args[0] === 'rev-parse' ? cutTip : '';
    const resumed = await runGraph(graph, { resumeRunId: first.runId, fromNodeId: 'traffic-npm-published', deps: { root, runBash },
      releaseCommandSource: { root: join(import.meta.dir, '../..'), cutTip, git: sourceGit } });
    expect(resumed.status).toBe('done');
    expect(calls.get('docs-land')).toBe(2);
    expect(calls.get('version-dev-bump')).toBe(1);
    expect(resumed.fanOuts?.['traffic-npm-published:ok']?.branches['version-dev-bump']).toEqual(completedBump);
    expect(resumed.nodes.find((node) => node.nodeId === 'release-post-publish-join')).toMatchObject({ ok: true });
    const retriedRunId = resumed.fanOuts?.['traffic-npm-published:ok']?.branches['docs-land']?.runId;
    expect(retriedRunId).toBeDefined();
    const retried = JSON.parse(await Bun.file(join(root, 'graph-runs', 'release-loop', `${retriedRunId}.json`)).text()) as { status: string };
    expect(retried.status).toBe('done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
