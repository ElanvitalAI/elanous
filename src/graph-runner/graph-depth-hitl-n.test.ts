// GRAPH-RUNNER-SMALL-FIXES 1a — (a) unit depth 3→5 · (b) HITL choices 2→N.
// Expected values are independent literals (rule 11): never built from GRAPH_UNIT_MAX_DEPTH,
// GRAPH_HITL_MAX_OPTIONS or the renderers under test.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { handleGraphApprovals } from '../nexus/api/graph-approvals.js';
import { flattenGraphUnits } from '../self-implement/graph-unit-flatten.js';
import type { GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import { simCli } from '../ux-sim/in-process-cli.js';
import { applyDecidedApprovals, raiseApprovalCard } from './graph-approval-card.js';
import { formatApprovalMessage } from './graph-notify.js';
import { decideGraphApproval, runGraph, type GraphRunState } from './runner.js';

setDefaultTimeout(60_000);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
const eventsOf = (category: string, event: string, runId?: string) => debug.events(500)
  .filter(entry => entry.category === category && entry.event === event && (runId === undefined || (entry.data as Record<string, unknown>)?.runId === runId))
  .map(entry => entry.data as Record<string, unknown>);

// ── (a) depth ────────────────────────────────────────────────────────────────

/** parent → worker → level-2 … level-<levels>; the last unit is the leaf that runs one command. */
function unitChain(levels: number): { graph: string; root: string; unitDir: string } {
  const root = tempDir('graph-depth-');
  const unitDir = join(root, 'units');
  mkdirSync(unitDir);
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  writeFileSync(join(unitDir, 'recipes.yaml'), 'produce:\n  command: printf produced\n');
  const graph = join(root, 'graph.yaml');
  writeFileSync(graph, `graph_id: parent
version: 1
entry_node: invoke
terminal_nodes: [done, failed]
nodes:
  - { node_id: invoke, kind: subgraph, recipe: none, max_visits: 1, call: worker@1, budget: { inner_steps: 40 }, contract: { inputs: [request], tools: read-only, outputs: [answer] } }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: invoke, on: outcome, map: { done: done, failed: failed } }
`);
  const ids = ['worker', ...Array.from({ length: levels - 1 }, (_, index) => `level-${index + 2}`)];
  ids.forEach((id, index) => writeUnit(unitDir, id, ids[index + 1]));
  return { graph, root, unitDir };
}

function writeUnit(unitDir: string, id: string, next?: string): void {
  const produce = next === undefined
    ? "  - { node_id: produce, kind: agent, recipe: 'cmd:produce', max_visits: 1 }"
    : `  - { node_id: produce, kind: subgraph, recipe: none, max_visits: 1, call: ${next}@1, budget: { inner_steps: 40 }, contract: { inputs: [request], tools: read-only, outputs: [answer] } }`;
  writeFileSync(join(unitDir, `${id}.yaml`), `graph_id: ${id}
version: 1
entry_node: produce
terminal_nodes: [done, failed]
unit: { inputs: [request], outputs: [answer], exits: [done, failed] }
nodes:
${produce}
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: produce, on: outcome, map: { ${next === undefined ? 'ok: done, fail: failed' : 'done: done, failed: failed'} } }
`);
}

const answer = async () => ({ stdout: '{"answer":"world"}', stderr: '', exitCode: 0 });

test('A1 runGraph: five nested unit levels run to done with one leaf command', async () => {
  const { graph, root } = unitChain(5);
  let calls = 0;
  const run = await runGraph(graph, { input: { request: 'hello' }, quiet: true, deps: { root,
    runBash: async () => { calls++; return answer(); } } });
  expect(run.status).toBe('done');
  expect(run.path).toEqual(['invoke', 'done']);
  expect(calls).toBe(1);
  expect(existsSync(join(root, 'graph-runs', 'level-5'))).toBe(true);
});

test('A2 runGraph: a sixth level fails before any command with a depth-exceeded event', async () => {
  const { graph, root } = unitChain(6);
  let calls = 0;
  await expect(runGraph(graph, { input: { request: 'hello' }, quiet: true, deps: { root,
    runBash: async () => { calls++; return answer(); } } }))
    .rejects.toThrow('unit nesting exceeds depth 5: parent -> worker -> level-2 -> level-3 -> level-4 -> level-5 -> level-6');
  expect(calls).toBe(0);
  expect(existsSync(join(root, 'graph-runs'))).toBe(false);
  expect(eventsOf('graph.unit', 'depth-exceeded').filter(data => data.reader === 'runner' && data.graphId === 'level-6').at(-1))
    .toMatchObject({ depth: 6, limit: 5 }); // Source: #38414 case table A2/A5 (6th level refused, limit 5)
});

test('A3 resume: a run started at depth 5 refuses to resume once its leaf grows a sixth level', async () => {
  const { graph, root, unitDir } = unitChain(5);
  const first = await runGraph(graph, { input: { request: 'hello' }, quiet: true, deps: { root, runBash: answer } });
  expect(first.status).toBe('done');
  writeUnit(unitDir, 'level-5', 'level-6');
  writeUnit(unitDir, 'level-6');
  const before = eventsOf('graph.unit', 'depth-exceeded').length;
  await expect(runGraph(graph, { resumeRunId: first.runId, quiet: true, deps: { root, runBash: answer } }))
    .rejects.toThrow('unit nesting exceeds depth 5');
  expect(eventsOf('graph.unit', 'depth-exceeded').length).toBe(before + 1);
});

test('A4 CLI graph run: a sixth level exits 1 with the depth message', async () => {
  const { graph, root } = unitChain(6);
  const result = await simCli(['graph', 'run', graph, '--json'], { allowPaths: [['graph', 'run']], stateRoot: join(root, 'state') });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('unit nesting exceeds depth 5');
});

function staticChain(levels: number): { root: GraphTemplateSpec; resolve: (call: string) => { path: string; template: GraphTemplateSpec } } {
  const template = (id: string, next?: string): GraphTemplateSpec => ({
    graphId: id, version: 1, entryNode: 'work', terminalNodes: ['completed'],
    ...(id === 'root' ? {} : { unit: { inputs: [], outputs: [], exits: ['completed'] } }),
    nodes: [
      next === undefined ? { nodeId: 'work', kind: 'agent', recipe: 'work', maxVisits: 1 } // Source: #38414 A5 one visit per static node
        : { nodeId: 'work', kind: 'subgraph', recipe: 'none', maxVisits: 1, call: `${next}@1`, contract: { inputs: [], tools: 'read-only', outputs: [] } }, // Source: #38414 A5
      { nodeId: 'completed', kind: 'observe', recipe: 'none', maxVisits: 1 }, // Source: #38414 A5
    ],
    edges: [next === undefined ? { from: 'work', to: 'completed' } : { from: 'work', on: 'outcome', map: { completed: 'completed' } }],
  });
  const ids = Array.from({ length: levels }, (_, index) => `u${index + 1}`);
  const units = new Map(ids.map((id, index) => [id, template(id, ids[index + 1])]));
  return { root: template('root', 'u1'), resolve: (call) => ({ path: `/units/${call}.yaml`, template: units.get(call.split('@')[0]!)! }) };
}

test('A5 static flatten (PWA/anatomy reader): five levels flatten, a sixth fails with the same event', () => {
  const five = staticChain(5);
  expect(flattenGraphUnits(five.root, '/root.yaml', five.resolve).nodes.map(node => node.nodeId))
    .toContain('work__work__work__work__work__work');
  const six = staticChain(6);
  expect(() => flattenGraphUnits(six.root, '/root.yaml', six.resolve)).toThrow('unit nesting exceeds depth 5: root -> u1 -> u2 -> u3 -> u4 -> u5 -> u6');
  expect(eventsOf('graph.unit', 'depth-exceeded').filter(data => data.reader === 'static' && data.graphId === 'u6').at(-1))
    .toMatchObject({ depth: 6, limit: 5 }); // Source: #38414 case table A2/A5 (6th level refused, limit 5)
});

// ── (b) HITL N options ───────────────────────────────────────────────────────

const threeWay = `graph_id: hitl-n
version: 1
entry_node: ask
terminal_nodes: [done, failed]
nodes:
  - { node_id: ask, kind: hitl, recipe: none, max_visits: 1, hitl: { options: [{ key: split, exit: split }, { key: retry, exit: retry }, { key: abort, exit: abort, default: true }] }, input: { approval: 'Pick a path' } }
  - { node_id: split-path, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: retry-path, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: ask, on: outcome, map: { split: split-path, retry: retry-path, abort: failed } }
  - { from: split-path, to: done }
  - { from: retry-path, to: done }
`;
const twoWay = `graph_id: hitl-two
version: 1
entry_node: ask
terminal_nodes: [done, failed]
nodes:
  - { node_id: ask, kind: hitl, recipe: none, max_visits: 1, hitl: { options: [{ key: approve, exit: approved }, { key: reject, exit: rejected, default: true }] }, input: { approval: 'Approve?' } }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: ask, on: outcome, map: { approved: done, rejected: failed } }
`;

function hitlGraph(source: string): { path: string; root: string } {
  const dir = tempDir('graph-hitl-n-');
  const path = join(dir, 'graph.yaml');
  writeFileSync(path, source);
  writeFileSync(join(dir, 'recipes.yaml'), '{}\n');
  return { path, root: join(dir, 'state') };
}
const claimOf = (state: GraphRunState) => `${state.statePath}.1.decision.json`;

test('B1 three options: pause renders every option and pins the choices in pending', async () => {
  const { path, root } = hitlGraph(threeWay);
  const paused = await runGraph(path, { input: { n: 1 }, quiet: true, deps: { root } });
  expect(paused.status).toBe('awaiting-approval');
  expect(paused.pending?.message).toBe('Pick a path split → split, retry → retry, abort → abort (default)');
  expect(paused.pending?.choices).toEqual([{ key: 'split', exit: 'split' }, { key: 'retry', exit: 'retry' }, { key: 'abort', exit: 'abort', default: true }]);
});

test('B2 two options stay byte-identical: message, pending keys, claim keys and node output', async () => {
  const { path, root } = hitlGraph(twoWay);
  const paused = await runGraph(path, { input: { n: 1 }, quiet: true, deps: { root } });
  expect(paused.pending?.message).toBe('Approve? approve → approved, reject → rejected (default)');
  expect(Object.keys(paused.pending!).filter(key => key !== 'notifiedAt').sort()).toEqual(['inputSha256', 'message', 'nodeId', 'since']);
  decideGraphApproval(paused.graphId, paused.runId, 'approved', 'owner', root);
  expect(Object.keys(JSON.parse(readFileSync(claimOf(paused), 'utf8'))).sort()).toEqual(['decidedAt', 'decidedBy', 'decision', 'inputSha256', 'nodeId']);
  const done = await runGraph(path, { resumeRunId: paused.runId, quiet: true, deps: { root } });
  expect(done.path).toEqual(['ask', 'done']);
  const output = JSON.parse(String(done.nodes[0]!.output));
  expect(Object.keys(output)).toEqual(['outcome', 'choice', 'graphId', 'runId', 'nodeId', 'decidedBy', 'decidedAt']);
  expect(output).toMatchObject({ outcome: 'approved', choice: 'approve' });
});

test('B3 a non-default choice approves and routes to its own exit', async () => {
  const { path, root } = hitlGraph(threeWay);
  const paused = await runGraph(path, { input: { n: 1 }, quiet: true, deps: { root } });
  decideGraphApproval(paused.graphId, paused.runId, 'approved', 'owner', root, undefined, 'retry');
  expect(JSON.parse(readFileSync(claimOf(paused), 'utf8'))).toMatchObject({ decision: 'approved', choice: 'retry' });
  const done = await runGraph(path, { resumeRunId: paused.runId, quiet: true, deps: { root } });
  expect(done.path).toEqual(['ask', 'retry-path', 'done']);
  expect(done.nodes[0]).toMatchObject({ ok: true });
  expect(JSON.parse(String(done.nodes[0]!.output))).toMatchObject({ outcome: 'retry', choice: 'retry' });
});

test('B4 the default choice records a rejection and still routes to its declared exit', async () => {
  const { path, root } = hitlGraph(threeWay);
  const paused = await runGraph(path, { input: { n: 1 }, quiet: true, deps: { root } });
  decideGraphApproval(paused.graphId, paused.runId, 'rejected', 'owner', root, undefined, 'abort');
  const done = await runGraph(path, { resumeRunId: paused.runId, quiet: true, deps: { root } });
  expect(done.path).toEqual(['ask', 'failed']);
  expect(done.nodes[0]).toMatchObject({ ok: false, error: 'approval rejected by owner' });
  expect(JSON.parse(String(done.nodes[0]!.output))).toMatchObject({ outcome: 'abort', choice: 'abort' });
});

test.each([
  ['choice-required', undefined, 'approved', 'HITL node ask has 3 options; choose one with --choice <key>: split, retry, abort'],
  ['unknown-choice', 'nope', 'approved', "unknown HITL choice 'nope' at ask; choose one of: split, retry, abort"],
  ['decision-conflict', 'abort', 'approved', "HITL choice 'abort' records rejected, not approved"],
  ['decision-conflict', 'split', 'rejected', "HITL choice 'split' records approved, not rejected"],
] as const)('B5 refuse %s (choice %p, %s): event, no claim, run stays undecided', async (reason, choice, decision, message) => {
  const { path, root } = hitlGraph(threeWay);
  const paused = await runGraph(path, { input: { n: 1 }, quiet: true, deps: { root } });
  expect(() => decideGraphApproval(paused.graphId, paused.runId, decision, 'owner', root, undefined, choice)).toThrow(message);
  expect(eventsOf('graph.approval', 'choice-refused', paused.runId).at(-1)).toMatchObject({ reason, options: 3 });
  expect(existsSync(claimOf(paused))).toBe(false);
  const still = await runGraph(path, { resumeRunId: paused.runId, quiet: true, deps: { root } });
  expect(still.status).toBe('awaiting-approval');
});

test('B5b a choice combined with a named approval outcome is refused with an event', async () => {
  const { path, root } = hitlGraph(threeWay);
  const paused = await runGraph(path, { input: { n: 1 }, quiet: true, deps: { root } });
  expect(() => decideGraphApproval(paused.graphId, paused.runId, 'approved', 'OP', root,
    { nodeId: 'ask', visit: 1, outcome: 'waived-known-issue' }, 'split')).toThrow('a HITL choice cannot be combined with a named approval outcome');
  expect(eventsOf('graph.approval', 'choice-refused', paused.runId).at(-1)).toMatchObject({ reason: 'outcome-conflict', choice: 'split' });
  expect(existsSync(claimOf(paused))).toBe(false);
});

test('B6 a choice on a two-option node is refused with an event (yes/no stays approve/reject)', async () => {
  const { path, root } = hitlGraph(twoWay);
  const paused = await runGraph(path, { input: { n: 1 }, quiet: true, deps: { root } });
  expect(() => decideGraphApproval(paused.graphId, paused.runId, 'approved', 'owner', root, undefined, 'approve'))
    .toThrow('HITL choice applies only to nodes with 3+ declared options: ask');
  expect(eventsOf('graph.approval', 'choice-refused', paused.runId).at(-1)).toMatchObject({ reason: 'no-choices', options: 0 });
  expect(existsSync(claimOf(paused))).toBe(false);
});

test('B7 a tampered claim whose choice is not declared fails resume instead of routing', async () => {
  const { path, root } = hitlGraph(threeWay);
  const paused = await runGraph(path, { input: { n: 1 }, quiet: true, deps: { root } });
  writeFileSync(claimOf(paused), JSON.stringify({ nodeId: 'ask', decision: 'approved', choice: 'forged', decidedAt: new Date().toISOString(),
    inputSha256: paused.pending!.inputSha256 }));
  await expect(runGraph(path, { resumeRunId: paused.runId, quiet: true, deps: { root } })).rejects.toThrow('approval decision mismatch');
  writeFileSync(claimOf(paused), JSON.stringify({ nodeId: 'ask', decision: 'approved', decidedAt: new Date().toISOString(),
    inputSha256: paused.pending!.inputSha256 }));
  await expect(runGraph(path, { resumeRunId: paused.runId, quiet: true, deps: { root } })).rejects.toThrow('approval decision mismatch');
});

test.each([
  ['nine options parse and pause', 9, undefined],
  ['ten options are refused at parse', 10, 'HITL 선택지는 최대 9개까지 허용한다'],
] as const)('B8 bounds: %s', async (_label, count, error) => {
  const keys = Array.from({ length: count }, (_, index) => `k${index + 1}`);
  const source = `graph_id: hitl-bound\nversion: 1\nentry_node: ask\nterminal_nodes: [done, failed]\nnodes:\n` +
    `  - { node_id: ask, kind: hitl, recipe: none, max_visits: 1, hitl: { options: [${keys.map(key => `{ key: ${key}, exit: ${key} }`).join(', ')}] } }\n` +
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\n' +
    `edges:\n  - { from: ask, on: outcome, map: { ${keys.map(key => `${key}: done`).join(', ')} } }\n`;
  const { path, root } = hitlGraph(source);
  if (error) await expect(runGraph(path, { quiet: true, deps: { root } })).rejects.toThrow(error);
  else expect((await runGraph(path, { quiet: true, deps: { root } })).pending?.choices).toHaveLength(9);
});

test('B9 an empty option list is refused at parse', async () => {
  const { path, root } = hitlGraph(threeWay.replace(/hitl: \{ options: \[.*?\] \}/, 'hitl: { options: [] }'));
  await expect(runGraph(path, { quiet: true, deps: { root } })).rejects.toThrow('hitl 은 options 를 가진 맵이어야 한다');
});

test('B10 CLI graph approve --choice: valid key, unknown key, and --reject conflict', async () => {
  const { path, root } = hitlGraph(threeWay);
  const cli = (...args: string[]) => simCli(['graph', ...args], { allowPaths: [['graph', 'run'], ['graph', 'approve']], stateRoot: root });
  const paused = JSON.parse((await cli('run', path, '--json')).stdout) as GraphRunState;
  expect(paused.status).toBe('awaiting-approval');
  const conflict = await cli('approve', 'hitl-n', paused.runId, '--choice', 'retry', '--reject');
  expect(conflict.exitCode).toBe(1);
  expect(conflict.stderr).toContain('--choice cannot be combined with --reject');
  const unknown = await cli('approve', 'hitl-n', paused.runId, '--choice', 'nope');
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stderr).toContain("unknown HITL choice 'nope'");
  const missing = await cli('approve', 'hitl-n', paused.runId);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toContain('choose one with --choice <key>');
  const chosen = await cli('approve', 'hitl-n', paused.runId, '--choice', 'abort', '--by', 'owner');
  expect(chosen.exitCode).toBe(0);
  expect(chosen.stdout).toContain(`hitl-n ${paused.runId}: rejected (abort)`);
  const resumed = JSON.parse((await cli('run', path, '--resume', paused.runId, '--json')).stdout) as GraphRunState;
  expect(resumed.path).toEqual(['ask', 'failed']);
});

test('B11 decision card (TUI /decide · telegram card): one letter per option, answer applies the choice', async () => {
  const { path, root } = hitlGraph(threeWay);
  const paused = await runGraph(path, { input: { n: 1 }, quiet: true, deps: { root } });
  const ledger = new DecisionLedger({ stateDir: root });
  const card = raiseApprovalCard(paused, paused.pending!, { root, ledger })!;
  expect(card.options.map(option => [option.key, option.label, option.consequence])).toEqual([
    ['a', 'split', 'ask → split'], ['b', 'retry', 'ask → retry'], ['c', 'abort', 'ask → abort (거절로 기록)']]);
  ledger.decide(card.id, 'b', { kind: 'human' });
  expect(applyDecidedApprovals({ root, ledger })).toBe(1);
  expect(JSON.parse(readFileSync(claimOf(paused), 'utf8'))).toMatchObject({ decision: 'approved', choice: 'retry', decidedBy: 'owner:human' });
  expect((await runGraph(path, { resumeRunId: paused.runId, quiet: true, deps: { root } })).path).toEqual(['ask', 'retry-path', 'done']);
});

test('B11b a card letter beyond the declared options is skipped with a reason, never applied', async () => {
  const { path, root } = hitlGraph(threeWay);
  const paused = await runGraph(path, { input: { n: 1 }, quiet: true, deps: { root } });
  const entry = { id: 'D-out-of-range', choice: 'd', decidedBy: { kind: 'human' }, refs: [`graph-approval:hitl-n:${paused.runId}:ask:1`] };
  const ledger = { list: () => [entry], raise: () => { throw new Error('unused'); } } as unknown as Pick<DecisionLedger, 'list' | 'raise'>;
  expect(applyDecidedApprovals({ root, ledger })).toBe(0);
  expect(eventsOf('graph.approval-card', 'skipped', paused.runId).at(-1)).toMatchObject({ decisionId: 'D-out-of-range', reason: 'choice-out-of-range' });
  expect(existsSync(claimOf(paused))).toBe(false);
});

test('B12 telegram text: N options list one --choice command each; yes/no text is unchanged', () => {
  const event = { graphId: 'g', runId: 'r', nodeId: 'ask', message: 'Pick' };
  expect(formatApprovalMessage(event, [{ key: 'split', exit: 'split' }, { key: 'two words', exit: 'x' }])).toBe(
    "Graph g / run r — approval required at ask\nPick\nsplit → split: elanous graph approve g r --choice split\ntwo words → x: elanous graph approve g r --choice 'two words'");
  expect(formatApprovalMessage(event)).toBe(
    'Graph g / run r — approval required at ask\nPick\nApprove: elanous graph approve g r\nReject: elanous graph approve g r --reject');
});

test('B13 PWA API: list carries allowlisted choices; POST needs a declared choice', async () => {
  const { path, root } = hitlGraph(threeWay);
  const paused = await runGraph(path, { input: { n: 1 }, quiet: true, deps: { root } });
  const deps = { root, authorize: () => true, authReason: () => 'bearer-match' };
  const listed = await (await handleGraphApprovals(new Request('http://localhost/v1/graph-approvals'), deps)).json() as { items: Array<Record<string, unknown>> };
  expect(listed.items[0]!.choices).toEqual([{ key: 'split', exit: 'split' }, { key: 'retry', exit: 'retry' }, { key: 'abort', exit: 'abort', default: true }]);
  const post = (body: unknown) => handleGraphApprovals(new Request(`http://localhost/v1/graph-approvals/hitl-n/${paused.runId}`,
    { method: 'POST', body: JSON.stringify(body) }), deps);
  const missing = await post({ decision: 'approved' });
  expect(missing.status).toBe(409);
  expect(await missing.json()).toMatchObject({ error: 'invalid-choice' });
  expect(eventsOf('approvals.graph', 'refused').filter(data => data.runId === paused.runId).at(-1))
    .toMatchObject({ reason: 'invalid-choice', nodeId: 'ask', decision: 'approved' });
  expect((await post({ decision: 'approved', choice: 7 })).status).toBe(400);
  expect(eventsOf('approvals.graph', 'refused').filter(data => data.runId === paused.runId).at(-1)).toMatchObject({ reason: 'bad-choice', choiceType: 'number' });
  const chosen = await post({ decision: 'approved', choice: 'split' });
  expect(chosen.status).toBe(200);
  expect((await runGraph(path, { resumeRunId: paused.runId, quiet: true, deps: { root } })).path).toEqual(['ask', 'split-path', 'done']);
});

// ── review #38414 MF1: a 3+ option HITL node with an approval recipe that also runs a command ─────────────

const withCommand = `graph_id: hitl-cmd
version: 1
entry_node: ask
terminal_nodes: [done, failed]
nodes:
  - { node_id: ask, kind: hitl, recipe: 'approval:ship', max_visits: 1, hitl: { options: [{ key: canary, exit: canary }, { key: full, exit: full }, { key: abort, exit: abort, default: true }] } }
  - { node_id: canary-path, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: full-path, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: ask, on: outcome, map: { canary: canary-path, full: full-path, abort: failed } }
  - { from: canary-path, to: done }
  - { from: full-path, to: done }
`;
function commandGraph(exitCode = 0): { path: string; root: string; calls: string[]; runBash: () => Promise<{ stdout: string; stderr: string; exitCode: number }> } { // Source: #38414 review MF1 case table C1-C3 (exit 0 ok, 1 command failure)
  const dir = tempDir('graph-hitl-cmd-');
  const path = join(dir, 'graph.yaml');
  writeFileSync(path, withCommand);
  writeFileSync(join(dir, 'recipes.yaml'), "ship:\n  approval: 'Ship it?'\n  command: ship-now\n");
  const calls: string[] = [];
  return { path, root: join(dir, 'state'), calls, runBash: async () => { calls.push('ship-now');
    return { stdout: '{"outcome":"shipped","url":"https://example.invalid/r1"}', stderr: '', exitCode }; } };
}

test('C1 approval+command × chosen non-default: pause, answer, resume runs the command once and routes to the chosen exit', async () => {
  const { path, root, calls, runBash } = commandGraph();
  const paused = await runGraph(path, { input: { n: 1 }, quiet: true, deps: { root, runBash } });
  expect(paused.status).toBe('awaiting-approval');
  expect(paused.pending?.message).toBe('Ship it? canary → canary, full → full, abort → abort (default)');
  expect(calls).toEqual([]);
  decideGraphApproval(paused.graphId, paused.runId, 'approved', 'owner', root, undefined, 'full');
  const done = await runGraph(path, { resumeRunId: paused.runId, quiet: true, deps: { root, runBash } });
  expect(done.status).toBe('done');
  expect(done.path).toEqual(['ask', 'full-path', 'done']);
  expect(calls).toEqual(['ship-now']);
  expect(JSON.parse(String(done.nodes[0]!.output))).toMatchObject({ outcome: 'full', choice: 'full', commandOutcome: 'shipped', url: 'https://example.invalid/r1' });
});

test('C2 approval+command × default choice: the command never runs and the run routes to the default exit', async () => {
  const { path, root, calls, runBash } = commandGraph();
  const paused = await runGraph(path, { input: { n: 1 }, quiet: true, deps: { root, runBash } });
  decideGraphApproval(paused.graphId, paused.runId, 'rejected', 'owner', root, undefined, 'abort');
  const done = await runGraph(path, { resumeRunId: paused.runId, quiet: true, deps: { root, runBash } });
  expect(done.path).toEqual(['ask', 'failed']);
  expect(calls).toEqual([]);
  expect(JSON.parse(String(done.nodes[0]!.output))).toMatchObject({ outcome: 'abort', choice: 'abort', error: 'approval rejected by owner' });
});

test('C3 approval+command × chosen option whose command fails: routed as a failure with an event, not as the choice', async () => {
  const { path, root, calls, runBash } = commandGraph(1); // Source: #38414 review MF1 C3 failing command
  const paused = await runGraph(path, { input: { n: 1 }, quiet: true, deps: { root, runBash } });
  decideGraphApproval(paused.graphId, paused.runId, 'approved', 'owner', root, undefined, 'canary');
  const failed = await runGraph(path, { resumeRunId: paused.runId, quiet: true, deps: { root, runBash } });
  expect(failed.status).toBe('failed');
  expect(failed.path).toEqual(['ask']);
  expect(calls).toEqual(['ship-now']);
  expect(eventsOf('graph.approval', 'choice-command-failed').filter(data => data.runId === paused.runId).at(-1)).toMatchObject({ choice: 'canary' });
});

test('C4 dry run: a 3+ option node with a command behaves like the 2-option dry run (no pause, no command)', async () => {
  const three = commandGraph();
  const two = commandGraph();
  writeFileSync(two.path, withCommand.replace('{ key: full, exit: full }, ', '').replace(', full: full-path', ''));
  const dryThree = await runGraph(three.path, { dryRun: true, quiet: true, deps: { root: three.root, runBash: three.runBash } });
  const dryTwo = await runGraph(two.path, { dryRun: true, quiet: true, deps: { root: two.root, runBash: two.runBash } });
  expect(dryThree.status).toBe(dryTwo.status);
  expect(dryThree.path).toEqual(dryTwo.path);
  expect(three.calls).toEqual([]);
});

// ── review #38414 MF2: runs that paused before this change ──────────────────────────────────────────

test.each([['approved', ['ask', 'done'], 'approved', 'approve'], ['rejected', ['ask', 'failed'], 'rejected', 'reject']] as const)(
  'L1 an old 2-option pending run (pre-PR ledger shape) resumes byte-identically after %s', async (decision, path, outcome, choice) => {
  const { path: graph, root } = hitlGraph(twoWay);
  const paused = await runGraph(graph, { input: { n: 1 }, quiet: true, deps: { root } });
  const saved = JSON.parse(readFileSync(paused.statePath, 'utf8'));
  expect('choices' in saved.pending).toBe(false);
  decideGraphApproval(paused.graphId, paused.runId, decision, 'owner', root);
  expect(Object.keys(JSON.parse(readFileSync(claimOf(paused), 'utf8'))).sort()).toEqual(['decidedAt', 'decidedBy', 'decision', 'inputSha256', 'nodeId']);
  const resumed = await runGraph(graph, { resumeRunId: paused.runId, quiet: true, deps: { root } });
  expect(resumed.path).toEqual([...path]);
  const output = JSON.parse(String(resumed.nodes[0]!.output));
  expect(Object.keys(output)).toEqual(['outcome', 'choice', 'graphId', 'runId', 'nodeId', 'decidedBy', 'decidedAt', ...(decision === 'rejected' ? ['error'] : [])]);
  expect(output).toMatchObject({ outcome, choice });
});

test('L2 an old 3+ option pending run without pinned choices refuses a plain answer, pins on resume, then routes the choice', async () => {
  const { path, root } = hitlGraph(threeWay);
  const paused = await runGraph(path, { input: { n: 1 }, quiet: true, deps: { root } });
  const saved = JSON.parse(readFileSync(paused.statePath, 'utf8'));
  delete saved.pending.choices;
  writeFileSync(paused.statePath, JSON.stringify(saved));
  expect(() => decideGraphApproval(paused.graphId, paused.runId, 'approved', 'owner', root))
    .toThrow('HITL node ask paused before its choices were pinned; resume the run once to pin them, then answer with --choice');
  expect(eventsOf('graph.approval', 'choice-refused', paused.runId).at(-1)).toMatchObject({ reason: 'choices-unpinned' });
  expect(existsSync(claimOf(paused))).toBe(false);
  const repinned = await runGraph(path, { resumeRunId: paused.runId, quiet: true, deps: { root } });
  expect(repinned.status).toBe('awaiting-approval');
  expect(repinned.pending?.choices).toEqual([{ key: 'split', exit: 'split' }, { key: 'retry', exit: 'retry' }, { key: 'abort', exit: 'abort', default: true }]);
  expect(eventsOf('graph.approval', 'choices-pinned-on-resume', paused.runId)).toHaveLength(1);
  decideGraphApproval(paused.graphId, paused.runId, 'approved', 'owner', root, undefined, 'split');
  expect((await runGraph(path, { resumeRunId: paused.runId, quiet: true, deps: { root } })).path).toEqual(['ask', 'split-path', 'done']);
});
