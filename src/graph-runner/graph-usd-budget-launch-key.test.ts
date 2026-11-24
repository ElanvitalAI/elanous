// GRAPH-RUNNER-SMALL-FIXES 1b — (c) run-level USD budget · (d) K5 launch key.
// Expected values are independent literals (rule 11); dollar figures come from the fixture commands below.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { simCli } from '../ux-sim/in-process-cli.js';
import { manageGraphRun, runGraph, type GraphRunState } from './runner.js';
import { createHash } from 'node:crypto';

/** Independent of the product: the documented run id shape for a launch key (rule 11). */
// Source: #38479 D1–D11 fixtures visit each node once so replayed effects stay visible.
const fixtureMaxVisits = 1;
// Source: #38479 D7 unit fixture leaves room for the worker's producer and terminal.
const fixtureInnerSteps = 10;

const expectedLaunchRunId = (key: string) => `launch-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;  // Source: #38479 launch run id = "launch-" + first 32 hex of sha256(key)

setDefaultTimeout(60_000);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
const eventsOf = (category: string, event: string, runId?: string) => debug.events(500)
  .filter(entry => entry.category === category && entry.event === event && (runId === undefined || (entry.data as Record<string, unknown>)?.runId === runId))
  .map(entry => entry.data as Record<string, unknown>);

/** a → b → c → done; each command prints its own stdout so the fixture states the reported cost. */
function chain(stdout: Record<'a' | 'b' | 'c', string>): { path: string; root: string; runBash: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>; calls: string[] } {
  const dir = tempDir('graph-usd-');
  const path = join(dir, 'graph.yaml');
  writeFileSync(path, `graph_id: usd-chain
version: 1
entry_node: a
terminal_nodes: [done, failed]
nodes:
  - { node_id: a, kind: agent, recipe: 'cmd:a', max_visits: ${fixtureMaxVisits} }
  - { node_id: b, kind: agent, recipe: 'cmd:b', max_visits: ${fixtureMaxVisits} }
  - { node_id: c, kind: agent, recipe: 'cmd:c', max_visits: ${fixtureMaxVisits} }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${fixtureMaxVisits} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${fixtureMaxVisits} }
edges:
  - { from: a, to: b }
  - { from: b, to: c }
  - { from: c, to: done }
`);
  writeFileSync(join(dir, 'recipes.yaml'), 'a:\n  command: node-a\nb:\n  command: node-b\nc:\n  command: node-c\n');
  const calls: string[] = [];
  const runBash = async (command: string) => {
    const id = (['a', 'b', 'c'] as const).find(name => command.includes(`node-${name}`))!;
    calls.push(id);
    return { stdout: stdout[id], stderr: '', exitCode: 0 };
  };
  return { path, root: join(dir, 'state'), runBash, calls };
}
const costly = { a: '{"outcome":"ok","costUsd":0.6}', b: '{"outcome":"ok","costUsd":0.6}', c: '{"outcome":"ok","costUsd":0.6}' };
const silent = { a: '{"outcome":"ok"}', b: '{"outcome":"ok"}', c: '{"outcome":"ok"}' };

// ── (c) USD budget ───────────────────────────────────────────────────────────

test('C1 measured cost reaching the budget pauses before the next node with an event', async () => {
  const { path, root, runBash, calls } = chain(costly);
  const run = await runGraph(path, { budgetUsd: 1, quiet: true, deps: { root, runBash } }); // Source: #38422 case table (C-cells; fixture costs 0.6 per node)
  expect(run.status).toBe('paused');
  expect(run.reason).toBe('usd-budget-exceeded');
  expect(calls).toEqual(['a', 'b']);
  expect(run.path).toEqual(['a', 'b']);
  expect(run.usdBudget).toEqual({ budgetUsd: 1, measuredUsd: 1.2, measuredNodes: 2, unmeasuredNodes: [] }); // Source: #38422 case table (C-cells; fixture costs 0.6 per node)
  expect(eventsOf('graph.budget', 'usd-exceeded', run.runId).at(-1)).toMatchObject({ nextNodeId: 'c', budgetUsd: 1, measuredUsd: 1.2 }); // Source: #38422 case table (C-cells; fixture costs 0.6 per node)
  expect(JSON.parse(readFileSync(run.statePath, 'utf8'))).toMatchObject({ status: 'paused', reason: 'usd-budget-exceeded' });
});

test('C2 resume with the same budget stops again before the same node; nothing re-runs', async () => {
  const { path, root, runBash, calls } = chain(costly);
  const first = await runGraph(path, { budgetUsd: 1, quiet: true, deps: { root, runBash } }); // Source: #38422 case table (C-cells; fixture costs 0.6 per node)
  const again = await runGraph(path, { resumeRunId: first.runId, quiet: true, deps: { root, runBash } });
  expect(again.status).toBe('paused');
  expect(calls).toEqual(['a', 'b']);
  expect(eventsOf('graph.budget', 'usd-exceeded', first.runId)).toHaveLength(2);
});

test('C3 resume with a raised budget continues at the next node and finishes', async () => {
  const { path, root, runBash, calls } = chain(costly);
  const first = await runGraph(path, { budgetUsd: 1, quiet: true, deps: { root, runBash } }); // Source: #38422 case table (C-cells; fixture costs 0.6 per node)
  const done = await runGraph(path, { resumeRunId: first.runId, budgetUsd: 5, quiet: true, deps: { root, runBash } }); // Source: #38422 case table (C-cells; fixture costs 0.6 per node)
  expect(done.status).toBe('done');
  expect(calls).toEqual(['a', 'b', 'c']);
  expect(done.path).toEqual(['a', 'b', 'c', 'done']);
  expect(done.usdBudget).toMatchObject({ budgetUsd: 5, measuredNodes: 3 }); // Source: #38422 case table (C-cells; fixture costs 0.6 per node)
  expect(done.usdBudget!.measuredUsd).toBeCloseTo(1.8, 10);
  expect(eventsOf('graph.budget', 'usd-budget-changed', first.runId).at(-1)).toMatchObject({ from: 1, to: 5 });
});

test('C4 nodes that report no cost are listed as unmeasured, never counted as $0, and never stop the run', async () => {
  const { path, root, runBash } = chain(silent);
  const run = await runGraph(path, { budgetUsd: 0.01, quiet: true, deps: { root, runBash } }); // Source: #38422 case table (C-cells; fixture costs 0.6 per node)
  expect(run.status).toBe('done');
  expect(run.usdBudget).toEqual({ budgetUsd: 0.01, measuredUsd: 0, measuredNodes: 0, unmeasuredNodes: ['a', 'b', 'c'] }); // Source: #38422 case table (C-cells; fixture costs 0.6 per node)
  expect(eventsOf('graph.budget', 'usd-unmeasured', run.runId).map(data => [data.nodeId, data.reason]))
    .toEqual([['a', 'no-cost-reported'], ['b', 'no-cost-reported'], ['c', 'no-cost-reported']]);
});

test.each([
  ['negative', '{"outcome":"ok","costUsd":-1}'],
  ['string', '{"outcome":"ok","costUsd":"0.5"}'],
])('C5 an invalid %s costUsd is unmeasured with reason invalid-cost', async (_label, stdout) => {
  const { path, root, runBash } = chain({ ...silent, a: stdout });
  const run = await runGraph(path, { budgetUsd: 1, quiet: true, deps: { root, runBash } }); // Source: #38422 case table (C-cells; fixture costs 0.6 per node)
  expect(run.usdBudget?.unmeasuredNodes).toEqual(['a', 'b', 'c']);
  expect(eventsOf('graph.budget', 'usd-unmeasured', run.runId)[0]).toMatchObject({ nodeId: 'a', reason: 'invalid-cost' });
});

test('C6 a run without budgetUsd has no usdBudget field and no budget events', async () => {
  const { path, root, runBash } = chain(costly);
  const run = await runGraph(path, { quiet: true, deps: { root, runBash } });
  expect(run.status).toBe('done');
  expect('usdBudget' in JSON.parse(readFileSync(run.statePath, 'utf8'))).toBe(false);
  expect(debug.events(500).filter(entry => entry.category === 'graph.budget' && (entry.data as Record<string, unknown>)?.runId === run.runId)).toEqual([]);
});

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('C7 budgetUsd %p is refused with an event before any node', async (budgetUsd) => {
  const { path, root, runBash, calls } = chain(costly);
  await expect(runGraph(path, { budgetUsd, quiet: true, deps: { root, runBash } })).rejects.toThrow('budgetUsd must be a positive finite number');
  expect(calls).toEqual([]);
  expect(eventsOf('graph.budget', 'refused').at(-1)).toMatchObject({ reason: 'invalid-budget' });
});

test('C8 a budget cannot be added on resume to a run started without one', async () => {
  const { path, root, runBash, calls } = chain(costly);
  let crash = true;
  const interrupted = runGraph(path, { quiet: true, deps: { root, runBash,
    beforeNode: () => { if (crash) { crash = false; throw new Error('simulated crash'); } } } });
  await expect(interrupted).rejects.toThrow('simulated crash');
  const runId = readdirSync(join(root, 'graph-runs', 'usd-chain')).find(file => /^[^.][^]*\.json$/.test(file) && !file.includes('.json.'))!.slice(0, -5);
  await expect(runGraph(path, { resumeRunId: runId, budgetUsd: 1, quiet: true, deps: { root, runBash } })) // Source: #38422 case table (C-cells; fixture costs 0.6 per node)
    .rejects.toThrow('budgetUsd cannot be added on resume to a run started without one');
  expect(calls).toEqual([]);
  expect(eventsOf('graph.budget', 'refused').at(-1)).toMatchObject({ reason: 'added-on-resume' });
});

test('C9 a terminal node is not blocked by an exhausted budget', async () => {
  const { path, root, runBash } = chain({ ...costly, c: '{"outcome":"ok","costUsd":3}' });
  const run = await runGraph(path, { budgetUsd: 2.5, quiet: true, deps: { root, runBash } }); // Source: #38422 case table (C-cells; fixture costs 0.6 per node)
  expect(run.status).toBe('done');
  expect(run.path).toEqual(['a', 'b', 'c', 'done']);
});

test('C10 a dry run neither meters nor stops', async () => {
  const { path, root, runBash, calls } = chain(costly);
  const run = await runGraph(path, { dryRun: true, budgetUsd: 0.1, quiet: true, deps: { root, runBash } }); // Source: #38422 case table (C-cells; fixture costs 0.6 per node)
  expect(run.status).toBe('done');
  expect(calls).toEqual([]);
  expect(run.usdBudget).toEqual({ budgetUsd: 0.1, measuredUsd: 0, measuredNodes: 0, unmeasuredNodes: [] }); // Source: #38422 case table (C-cells; fixture costs 0.6 per node)
});

test('C11 CLI graph run --budget-usd pauses with exit 1 and the persisted reason', async () => {
  const dir = tempDir('graph-usd-cli-');
  const path = join(dir, 'graph.yaml');
  writeFileSync(path, `graph_id: usd-cli
version: 1
entry_node: a
terminal_nodes: [done, failed]
nodes:
  - { node_id: a, kind: agent, recipe: 'cmd:a', max_visits: ${fixtureMaxVisits} }
  - { node_id: b, kind: agent, recipe: 'cmd:b', max_visits: ${fixtureMaxVisits} }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${fixtureMaxVisits} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${fixtureMaxVisits} }
edges:
  - { from: a, to: b }
  - { from: b, to: done }
`);
  writeFileSync(join(dir, 'recipes.yaml'), `a:\n  command: printf '{"outcome":"ok","costUsd":2}'\nb:\n  command: printf b >> ${join(dir, 'b-ran')}\n`);
  const result = await simCli(['graph', 'run', path, '--budget-usd', '1', '--json'], { allowPaths: [['graph', 'run']], stateRoot: join(dir, 'state') });
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'paused', reason: 'usd-budget-exceeded', usdBudget: { budgetUsd: 1, measuredUsd: 2 } }); // Source: #38422 case table (C-cells; fixture costs 0.6 per node)
  expect(existsSync(join(dir, 'b-ran'))).toBe(false);
});

// ── (d) K5 launch key ────────────────────────────────────────────────────────

test('D1 the same launch key twice resolves to the same run; the side effect runs once; the second is deduped', async () => {
  const { path, root, runBash, calls } = chain(silent);
  const first = await runGraph(path, { launchKey: 'k5:same', quiet: true, deps: { root, runBash } });
  const second = await runGraph(path, { launchKey: 'k5:same', quiet: true, deps: { root, runBash } });
  expect(first.status).toBe('done');
  expect(second.runId).toBe(first.runId);
  expect(calls).toEqual(['a', 'b', 'c']);
  expect(eventsOf('graph.launch', 'deduped', first.runId)).toHaveLength(1);
  expect(eventsOf('graph.launch', 'deduped', first.runId)[0]).toMatchObject({ graphId: 'usd-chain', status: 'done' });
});

test('D2 a different launch key produces a different run', async () => {
  const { path, root, runBash, calls } = chain(silent);
  const first = await runGraph(path, { launchKey: 'k5:one', quiet: true, deps: { root, runBash } });
  const other = await runGraph(path, { launchKey: 'k5:two', quiet: true, deps: { root, runBash } });
  expect(other.runId).not.toBe(first.runId);
  expect(calls).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
});

test('D3 a crash between launch and the first node record: relaunch yields the same run, and resume runs each effect once', async () => {
  const { path, root, runBash, calls } = chain(silent);
  let crash = true;
  await expect(runGraph(path, { launchKey: 'k5:crash', quiet: true, deps: { root, runBash,
    beforeNode: () => { if (crash) { crash = false; throw new Error('simulated launcher crash'); } } } })).rejects.toThrow('simulated launcher crash');
  const ledgers = readdirSync(join(root, 'graph-runs', 'usd-chain')).filter(file => /^[^.].*\.json$/.test(file) && !file.includes('.json.'));
  expect(ledgers).toHaveLength(1);
  const relaunched = await runGraph(path, { launchKey: 'k5:crash', quiet: true, deps: { root, runBash } });
  expect(`${relaunched.runId}.json`).toBe(ledgers[0]);
  expect(relaunched.status).toBe('running');
  expect(calls).toEqual([]);
  expect(eventsOf('graph.launch', 'deduped', relaunched.runId).at(-1)).toMatchObject({ status: 'running' });
  const resumed = await runGraph(path, { resumeRunId: relaunched.runId, quiet: true, deps: { root, runBash } });
  expect(resumed.status).toBe('done');
  expect(calls).toEqual(['a', 'b', 'c']);
});

test('D4 a launcher stopped after its claim but before the ledger: no ledger exists, and relaunch runs the same run id once', async () => {
  const { path, root, runBash, calls } = chain(silent);
  await expect(runGraph(path, { launchKey: 'k5:no-ledger', quiet: true, deps: { root, runBash,
    afterLaunchClaim: () => { throw new Error('stopped after claim'); } } })).rejects.toThrow('stopped after claim');
  const claimedRunId = eventsOf('graph.launch', 'claimed').at(-1)!.runId as string;
  expect(existsSync(join(root, 'graph-runs', 'usd-chain', `${claimedRunId}.json`))).toBe(false);
  expect(readdirSync(join(root, 'graph-runs', 'usd-chain', '.launch-claims'))).toEqual([]);
  expect(calls).toEqual([]);
  const relaunched = await runGraph(path, { launchKey: 'k5:no-ledger', quiet: true, deps: { root, runBash } });
  expect(relaunched.runId).toBe(claimedRunId);
  expect(relaunched.status).toBe('done');
  expect(calls).toEqual(['a', 'b', 'c']);
});

test('D9 concurrency: two overlapped launches with the same key run the side effects exactly once', async () => {
  const { path, root, runBash, calls } = chain(silent);
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const beforeLaunchClaim = async () => { arrived++; if (arrived === 2) release(); await barrier; }; // Source: #38422 review MF1 concurrency cell (two overlapped launches)
  const [one, two] = await Promise.all([
    runGraph(path, { launchKey: 'k5:race', quiet: true, deps: { root, runBash, beforeLaunchClaim } }),
    runGraph(path, { launchKey: 'k5:race', quiet: true, deps: { root, runBash, beforeLaunchClaim } }),
  ]);
  expect(arrived).toBe(2); // Source: #38422 review MF1 concurrency cell
  expect(two.runId).toBe(one.runId);
  expect(calls).toEqual(['a', 'b', 'c']);
  expect(eventsOf('graph.launch', 'deduped', one.runId).filter(data => data.race === true)).toHaveLength(1);
});

test('D10 stale claim: a claim left by a dead pid on this host is reclaimed and the run starts once', async () => {
  const { path, root, runBash, calls } = chain(silent);
  const runId = expectedLaunchRunId('k5:stale');
  const claim = join(root, 'graph-runs', 'usd-chain', '.launch-claims', `${runId}.claim`);
  mkdirSync(claim, { recursive: true });
  const deadPid = spawnSync('true').pid;
  writeFileSync(join(claim, 'owner.json'), JSON.stringify({ pid: deadPid, pidStartedAt: '2026-01-01T00:00:00.000Z', host: hostname(), claimedAt: '2026-01-01T00:00:00.000Z' }));
  const run = await runGraph(path, { launchKey: 'k5:stale', quiet: true, deps: { root, runBash } });
  expect(run.runId).toBe(runId);
  expect(run.status).toBe('done');
  expect(calls).toEqual(['a', 'b', 'c']);
  expect(eventsOf('graph.launch', 'claim-reclaimed', runId).at(-1)).toMatchObject({ reason: 'owner-dead', stalePid: deadPid });
  expect(existsSync(claim)).toBe(false);
});

test('D11 in-flight claim held by another host with no ledger: the loser fails honestly and runs nothing', async () => {
  const { path, root, runBash, calls } = chain(silent);
  const runId = expectedLaunchRunId('k5:foreign');
  const claim = join(root, 'graph-runs', 'usd-chain', '.launch-claims', `${runId}.claim`);
  mkdirSync(claim, { recursive: true });
  writeFileSync(join(claim, 'owner.json'), JSON.stringify({ pid: process.pid, pidStartedAt: '2026-01-01T00:00:00.000Z', host: 'another-host.invalid', claimedAt: '2026-01-01T00:00:00.000Z' }));
  await expect(runGraph(path, { launchKey: 'k5:foreign', quiet: true, deps: { root, runBash } }))
    .rejects.toThrow('launch key is being launched by another runner and has no ledger yet');
  expect(calls).toEqual([]);
  expect(eventsOf('graph.launch', 'refused', runId).at(-1)).toMatchObject({ reason: 'in-flight', ownerHost: 'another-host.invalid' });
  expect(existsSync(join(claim, 'owner.json'))).toBe(true);
});

test.each([
  ['with-resume', { resumeRunId: 'r1', launchKey: 'k' }, 'launch key cannot be combined with --resume'],
  ['with-dry-run', { dryRun: true, launchKey: 'k' }, 'launch key cannot be combined with --dry-run'],
  ['with-run-id', { runId: 'r1', launchKey: 'k' }, 'launch key cannot be combined with an explicit run id'],
  ['empty-key', { launchKey: '  ' }, 'launch key must not be empty'],
] as const)('D5 launch key refusal %s has an event and runs nothing', async (reason, extra, message) => {
  const { path, root, runBash, calls } = chain(silent);
  await expect(runGraph(path, { ...extra, quiet: true, deps: { root, runBash } })).rejects.toThrow(message);
  expect(calls).toEqual([]);
  expect(eventsOf('graph.launch', 'refused').at(-1)).toMatchObject({ reason });
});

test('D6 CLI graph run --launch-key twice: same run id, the command ran once', async () => {
  const dir = tempDir('graph-launch-cli-');
  const path = join(dir, 'graph.yaml');
  const marker = join(dir, 'effects');
  writeFileSync(path, `graph_id: launch-cli
version: 1
entry_node: effect
terminal_nodes: [done, failed]
nodes:
  - { node_id: effect, kind: agent, recipe: 'cmd:effect', max_visits: ${fixtureMaxVisits} }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${fixtureMaxVisits} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${fixtureMaxVisits} }
edges:
  - { from: effect, to: done }
`);
  writeFileSync(join(dir, 'recipes.yaml'), `effect:\n  command: printf x >> ${marker}\n`);
  const cli = () => simCli(['graph', 'run', path, '--launch-key', 'k5:cli', '--json'], { allowPaths: [['graph', 'run']], stateRoot: join(dir, 'state') });
  const first = JSON.parse((await cli()).stdout) as GraphRunState;
  const second = JSON.parse((await cli()).stdout) as GraphRunState;
  expect(second.runId).toBe(first.runId);
  expect(readFileSync(marker, 'utf8')).toBe('x');
});

function unitParent(): { graph: string; root: string; leafCalls: string[]; runBash: () => Promise<{ stdout: string; stderr: string; exitCode: number }> } {
  const root = tempDir('graph-launch-unit-');
  mkdirSync(join(root, 'units'));
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  writeFileSync(join(root, 'units', 'recipes.yaml'), 'produce:\n  command: produce\n');
  const graph = join(root, 'graph.yaml');
  writeFileSync(graph, `graph_id: parent
version: 1
entry_node: invoke
terminal_nodes: [done, failed]
nodes:
  - { node_id: invoke, kind: subgraph, recipe: none, max_visits: ${fixtureMaxVisits}, call: worker@1, budget: { inner_steps: ${fixtureInnerSteps} }, contract: { inputs: [request], tools: read-only, outputs: [answer] } }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${fixtureMaxVisits} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${fixtureMaxVisits} }
edges:
  - { from: invoke, on: outcome, map: { done: done, failed: failed } }
`);
  writeFileSync(join(root, 'units', 'worker.yaml'), `graph_id: worker
version: 1
entry_node: produce
terminal_nodes: [done, failed]
unit: { inputs: [request], outputs: [answer], exits: [done, failed] }
nodes:
  - { node_id: produce, kind: agent, recipe: 'cmd:produce', max_visits: ${fixtureMaxVisits} }
  - { node_id: done, kind: gate, recipe: none, max_visits: ${fixtureMaxVisits} }
  - { node_id: failed, kind: gate, recipe: none, max_visits: ${fixtureMaxVisits} }
edges:
  - { from: produce, on: outcome, map: { ok: done, fail: failed } }
`);
  const leafCalls: string[] = [];
  return { graph, root, leafCalls, runBash: async () => { leafCalls.push('produce'); return { stdout: '{"answer":"world"}', stderr: '', exitCode: 0 }; } };
}

test('D7 unit child: an interrupted visit restarted with --from re-attaches the same child instead of relaunching', async () => {
  const { graph, root, leafCalls, runBash } = unitParent();
  const parent = await runGraph(graph, { input: { request: 'hello' }, quiet: true, deps: { root, runBash } });
  expect(parent.status).toBe('done');
  const record = parent.nodes[0]!;
  expect(record.launchKey).toMatch(/^k5:[a-f0-9]{64}$/);
  const childRunId = parent.unitCalls![0]!.childRunId;
  // The runner died after the child finished but before the parent recorded the node.
  const deadPid = spawnSync('true').pid;
  const saved = JSON.parse(readFileSync(parent.statePath, 'utf8')) as GraphRunState;
  const { finishedAt: _finishedAt, ...rest } = saved;
  writeFileSync(parent.statePath, JSON.stringify({ ...rest, status: 'running', pid: deadPid, path: ['invoke'], nodes: [], executed: 0, unitCalls: [],
    currentNode: { nodeId: 'invoke', executionId: record.executionId, startedAt: record.startedAt, launchKey: record.launchKey } }));
  const stopped = manageGraphRun('parent', parent.runId, 'stop', root, () => null);
  expect(stopped.nodes[0]).toMatchObject({ nodeId: 'invoke', launchKey: record.launchKey });
  const resumed = await runGraph(graph, { resumeRunId: parent.runId, fromNodeId: 'invoke', quiet: true, deps: { root, runBash } });
  expect(resumed.status).toBe('done');
  expect(resumed.unitCalls![0]!.childRunId).toBe(childRunId);
  expect(leafCalls).toEqual(['produce']);
  expect(eventsOf('graph.launch', 'reattach-interrupted', parent.runId)).toHaveLength(1);
  expect(eventsOf('graph.launch', 'deduped', childRunId).at(-1)).toMatchObject({ parentRunId: parent.runId, nodeId: 'invoke', status: 'done' });
});

test('D7b unit child: a genuinely failed visit retried with --from gets a fresh key and a new child', async () => {
  const { graph, root, leafCalls } = unitParent();
  let fail = true;
  const runBash = async () => { leafCalls.push('produce'); const exitCode = fail ? 1 : 0; fail = false;
    return { stdout: '{"answer":"world"}', stderr: '', exitCode }; };
  const failed = await runGraph(graph, { input: { request: 'hello' }, quiet: true, deps: { root, runBash } });
  expect(failed.status).toBe('failed');
  const firstChild = failed.unitCalls![0]!.childRunId;
  const retried = await runGraph(graph, { resumeRunId: failed.runId, fromNodeId: 'invoke', quiet: true, deps: { root, runBash } });
  expect(retried.status).toBe('done');
  expect(retried.unitCalls![0]!.childRunId).not.toBe(firstChild);
  expect(leafCalls).toEqual(['produce', 'produce']);
});

test('D8 unit child: a new parent run gets a new child run (fresh key per attempt)', async () => {
  const { graph, root, leafCalls, runBash } = unitParent();
  const first = await runGraph(graph, { input: { request: 'hello' }, quiet: true, deps: { root, runBash } });
  const second = await runGraph(graph, { input: { request: 'hello' }, quiet: true, deps: { root, runBash } });
  expect(second.unitCalls![0]!.childRunId).not.toBe(first.unitCalls![0]!.childRunId);
  expect(leafCalls).toEqual(['produce', 'produce']);
});

// ── review #38479 MF1: reclaiming a stale claim is serialized and token-checked ─────────────────────────────

function staleClaim(root: string, key: string, owner: Record<string, unknown> | string): string {
  const claim = join(root, 'graph-runs', 'usd-chain', '.launch-claims', `${expectedLaunchRunId(key)}.claim`);
  mkdirSync(claim, { recursive: true });
  writeFileSync(join(claim, 'owner.json'), typeof owner === 'string' ? owner : JSON.stringify(owner));
  return claim;
}
const deadOwner = (token: string) => ({ pid: spawnSync('true').pid, pidStartedAt: '2026-01-01T00:00:00.000Z', host: hostname(),
  claimedAt: '2026-01-01T00:00:00.000Z', token });

test('R1 two reclaimers race on one stale claim: exactly one run executes, the other backs off and refuses', async () => {
  const { path, root, runBash, calls } = chain(silent);
  staleClaim(root, 'k5:reclaim-race', deadOwner('gen-dead'));
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const launches: Promise<GraphRunState>[] = [];
  let settledOne!: Promise<void>;
  const deps = { root, runBash,
    beforeLaunchReclaim: async () => { arrived++; if (arrived === 2) release(); await barrier; }, // Source: #38479 review MF1 (two reclaimers)
    afterLaunchClaim: async () => { await settledOne; } };
  launches.push(runGraph(path, { launchKey: 'k5:reclaim-race', quiet: true, deps }));
  launches.push(runGraph(path, { launchKey: 'k5:reclaim-race', quiet: true, deps }));
  settledOne = Promise.race(launches.map(launch => launch.then(() => undefined, () => undefined)));
  const results = await Promise.allSettled(launches);
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  expect(String(rejected.reason)).toContain('launch key is being launched by another runner and has no ledger yet');
  const runId = expectedLaunchRunId('k5:reclaim-race');
  expect((results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<GraphRunState>).value.runId).toBe(runId);
  expect(calls).toEqual(['a', 'b', 'c']);
  expect(eventsOf('graph.launch', 'claim-reclaimed', runId)).toHaveLength(1);
  expect(eventsOf('graph.launch', 'reclaim-backed-off', runId).at(-1)).toMatchObject({ reason: 'claim-changed' });
});

test('R2 a reclaimer that judged generation gen-1 stale does not move the claim once gen-2 is on disk', async () => {
  const { path, root, runBash, calls } = chain(silent);
  const claim = staleClaim(root, 'k5:generation', deadOwner('gen-1'));
  const newer = { pid: process.pid, pidStartedAt: '2026-01-01T00:00:00.000Z', host: 'another-host.invalid', claimedAt: '2026-01-02T00:00:00.000Z', token: 'gen-2' };
  await expect(runGraph(path, { launchKey: 'k5:generation', quiet: true, deps: { root, runBash,
    beforeLaunchReclaim: () => { writeFileSync(join(claim, 'owner.json'), JSON.stringify(newer)); } } }))
    .rejects.toThrow('launch key is being launched by another runner and has no ledger yet');
  expect(calls).toEqual([]);
  expect(JSON.parse(readFileSync(join(claim, 'owner.json'), 'utf8')).token).toBe('gen-2');
  const runId = expectedLaunchRunId('k5:generation');
  expect(eventsOf('graph.launch', 'reclaim-backed-off', runId).at(-1)).toMatchObject({ reason: 'claim-changed' });
  expect(eventsOf('graph.launch', 'claim-reclaimed', runId)).toEqual([]);
});

test('R3 a reclaim lock left by a dead reclaimer is broken, and the stale claim is then reclaimed once', async () => {
  const { path, root, runBash, calls } = chain(silent);
  const claim = staleClaim(root, 'k5:dead-lock', deadOwner('gen-dead'));
  mkdirSync(`${claim}.reclaim`);
  writeFileSync(join(`${claim}.reclaim`, 'owner.json'), JSON.stringify(deadOwner('dead-reclaimer')));
  const run = await runGraph(path, { launchKey: 'k5:dead-lock', quiet: true, deps: { root, runBash } });
  const runId = expectedLaunchRunId('k5:dead-lock');
  expect(run.runId).toBe(runId);
  expect(calls).toEqual(['a', 'b', 'c']);
  expect(eventsOf('graph.launch', 'reclaim-lock-reclaimed', runId)).toHaveLength(1);
  expect(eventsOf('graph.launch', 'claim-reclaimed', runId)).toHaveLength(1);
  expect(existsSync(`${claim}.reclaim`)).toBe(false);
  expect(existsSync(claim)).toBe(false);
});

test('R4 an unreadable owner file is treated as stale with its own reason, and the run starts once', async () => {
  const { path, root, runBash, calls } = chain(silent);
  staleClaim(root, 'k5:unreadable', '{not json');
  const run = await runGraph(path, { launchKey: 'k5:unreadable', quiet: true, deps: { root, runBash } });
  expect(run.status).toBe('done');
  expect(calls).toEqual(['a', 'b', 'c']);
  expect(eventsOf('graph.launch', 'claim-reclaimed', expectedLaunchRunId('k5:unreadable')).at(-1)).toMatchObject({ reason: 'owner-unreadable' });
});
