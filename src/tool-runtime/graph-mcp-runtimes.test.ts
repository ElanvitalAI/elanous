import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GRAPH_MCP_RUNTIMES, setGraphMcpDepsForTest } from './graph-mcp-runtimes.js';
import { isToolAllowedForScope } from '../nexus/api/mcp-public-allowlist.js';
import { proposeGrowth } from '../graph-runner/graph-grow.js';
import type { GraphRunState } from '../graph-runner/runner.js';

const dirs: string[] = [];
afterEach(() => {
  setGraphMcpDepsForTest(undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runtime(id: string) {
  const found = GRAPH_MCP_RUNTIMES.find(rt => rt.id === id);
  if (!found) throw new Error(id);
  return found;
}

test('the four graph MCP tools are listed and a public token can only call read tools', () => {
  expect(GRAPH_MCP_RUNTIMES.map(rt => rt.id)).toEqual([
    'graph_compose', 'graph_run_start', 'graph_run_status', 'graph_node_op',
  ]);
  expect(isToolAllowedForScope('graph_compose', 'mcp-public')).toBe(true);
  expect(isToolAllowedForScope('graph_run_status', 'mcp-public')).toBe(true);
  expect(isToolAllowedForScope('graph_run_start', 'mcp-public')).toBe(false);
  expect(isToolAllowedForScope('graph_node_op', 'mcp-public')).toBe(false);
});

test('graph_compose previews through the existing wizard without writing a run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-mcp-compose-'));
  dirs.push(root);
  setGraphMcpDepsForTest({ root, generate: async () => ({
    ok: true, id: 'research-proof', yaml: 'graph_id: research-proof\n', issues: [],
    attempts: 1, summary: 'validated preview', steps: {}, base: 'research-loop',
  }) });
  const result = await runtime('graph_compose').run({ goal: '이 주장 검증해' }, { surface: 'mcp', mcpClient: 'aside' });
  expect(result).toMatchObject({ ok: true, compose: { id: 'research-proof' } });
  expect(existsSync(join(root, 'graph-runs'))).toBe(false);
});

test('graph_run_status reads persisted node output and source IDs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-mcp-status-'));
  dirs.push(root);
  const graphId = 'research-proof';
  const runId = 'ed-test-abcdef';
  const dir = join(root, 'graph-runs', graphId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
    graphId, runId, status: 'done', path: ['source', 'done'],
    nodes: [{ nodeId: 'source', ok: true, exit: 0, executed: true,
      output: { answer: 'supported', sourceIds: ['ref-1'] } }],
  }));
  setGraphMcpDepsForTest({ root });
  const result = await runtime('graph_run_status').run({ graphId, runId }, { surface: 'mcp', mcpClient: 'aside' });
  expect(result).toMatchObject({ status: 'done', nodes: [{ nodeId: 'source', ok: true, exit: 0, executed: true,
    sourceIds: ['ref-1'] }] });
});

test('graph_run_status returns the existing run API error for a missing run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-mcp-status-missing-'));
  dirs.push(root);
  setGraphMcpDepsForTest({ root });
  const result = await runtime('graph_run_status').run({ graphId: 'research-proof', runId: 'ed-test-abcdef' },
    { surface: 'mcp', mcpClient: 'aside' });
  expect(result).toMatchObject({ output: 'graph_run_status: not-found', error: 'not-found' });
  expect(result.status).toBeUndefined();
});

test('graph_run_status marks bounded output and keeps its JSON valid', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-mcp-status-large-'));
  dirs.push(root);
  const graphId = 'research-proof';
  const runId = 'ed-test-abcdef';
  const dir = join(root, 'graph-runs', graphId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
    graphId, runId, status: 'done', path: ['source'],
    nodes: [{ nodeId: 'source', ok: true, exit: 0, executed: true, output: { answer: '한'.repeat(100_000) } }],
  }));
  setGraphMcpDepsForTest({ root });
  const result = await runtime('graph_run_status').run({ graphId, runId }, { surface: 'mcp' });
  expect(result.output.length).toBeLessThanOrEqual(24_000);
  expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(24_000);
  const parsed = JSON.parse(result.output) as { truncated: boolean; nodes: Array<{ output: string }> };
  expect(parsed.truncated).toBe(true);
  expect(parsed.nodes[0]?.output.length).toBeLessThanOrEqual(800);
});

test('graph_run_status caps a long saved path and preserves failed node status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-mcp-status-path-'));
  dirs.push(root);
  const graphId = 'research-proof';
  const runId = 'ed-test-abcdef';
  const dir = join(root, 'graph-runs', graphId);
  mkdirSync(dir, { recursive: true });
  const path = Array.from({ length: 500 }, (_, i) => `node-${i}-` + 'x'.repeat(200));
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
    graphId, runId, status: 'failed', path,
    nodes: [{ nodeId: 'failed-node', ok: false, exit: 1, executed: true, output: { error: 'no route' } }],
  }));
  setGraphMcpDepsForTest({ root });
  const result = await runtime('graph_run_status').run({ graphId, runId }, { surface: 'mcp' });
  expect(result.output.length).toBeLessThanOrEqual(24_000);
  expect(JSON.parse(result.output)).toMatchObject({ status: 'failed', truncated: true,
    nodes: [expect.objectContaining({ nodeId: 'failed-node', ok: false })] });
});

test('graph_run_status bounds long graph and run identifiers in its JSON response', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-mcp-status-id-'));
  dirs.push(root);
  const graphId = `g${'a'.repeat(220)}`;
  const runId = `ed-${'a'.repeat(220)}-abcdef`;
  const dir = join(root, 'graph-runs', graphId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ graphId, runId, status: 'done', path: [], nodes: [] }));
  setGraphMcpDepsForTest({ root });
  const result = await runtime('graph_run_status').run({ graphId, runId }, { surface: 'mcp' });
  const parsed = JSON.parse(result.output) as { graphId: string; runId: string; truncated: boolean };
  expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(24_000);
  expect(parsed.graphId.length).toBe(120);
  expect(parsed.runId.length).toBe(120);
  expect(parsed.truncated).toBe(true);
});

test('graph_run_start calls the existing editor runner and returns a real run identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-mcp-start-'));
  dirs.push(root);
  const mineDir = join(root, 'mine');
  mkdirSync(mineDir);
  writeFileSync(join(mineDir, 'demo-safe.yaml'), `graph_id: demo-safe
version: 1
entry_node: done
terminal_nodes: [done]
nodes:
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
edges: []
`);
  const recipesFile = join(root, 'recipes.yaml');
  writeFileSync(recipesFile, '{}\n');
  setGraphMcpDepsForTest({ root, mineDir, recipesFile });
  const started = await runtime('graph_run_start').run({ graphId: 'demo-safe', reason: 'verify a claim' },
    { surface: 'mcp', mcpClient: 'aside' });
  expect(started.status).toBe(202);
  expect(started.runId).toMatch(/^ed-/);
  const runId = String(started.runId);
  let status: Record<string, unknown> = {};
  for (let i = 0; i < 100; i++) {
    status = await runtime('graph_run_status').run({ graphId: 'demo-safe', runId }, { surface: 'mcp' });
    if (status.status === 'done' || status.status === 'failed') break;
    await Bun.sleep(20);
  }
  expect(status.status).toBe('done');
});

test('graph_run_start accepts a compose result only through the graph save validator', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-mcp-save-'));
  dirs.push(root);
  const mineDir = join(root, 'mine');
  const recipesFile = join(root, 'recipes.yaml');
  writeFileSync(recipesFile, '{}\n');
  setGraphMcpDepsForTest({ root, mineDir, recipesFile });
  const rejected = await runtime('graph_run_start').run({ reason: 'test invalid YAML',
    compose: { id: 'demo-safe', yaml: 'graph_id: different\n' } }, { surface: 'mcp' });
  expect(rejected.error).toContain('save refused');
  expect(existsSync(join(mineDir, 'demo-safe.yaml'))).toBe(false);
  const started = await runtime('graph_run_start').run({ reason: 'verify claim',
    compose: { id: 'demo-safe', yaml: `graph_id: demo-safe
version: 1
entry_node: done
terminal_nodes: [done]
nodes:
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
edges: []
` } }, { surface: 'mcp', mcpClient: 'aside' });
  expect(started.status).toBe(202);
  expect(existsSync(join(mineDir, 'demo-safe.yaml'))).toBe(true);
});

test('graph_run_start and graph_node_op refuse missing write context without changing run state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-mcp-write-'));
  dirs.push(root);
  setGraphMcpDepsForTest({ root });
  expect(await runtime('graph_run_start').run({ graphId: 'research-proof' }, { surface: 'mcp' }))
    .toMatchObject({ error: 'valid graphId and reason are required' });
  expect(await runtime('graph_node_op').run({ graphId: 'research-proof', runId: 'ed-test-abcdef',
    op: 'retry', nodeId: 'source', reason: 'recheck' }, { surface: 'mcp' }))
    .toMatchObject({ error: 'a failed run and node on its saved path are required' });
  expect(await runtime('graph_node_op').run({ graphId: 'research-proof', runId: 'ed-test-abcdef',
    op: 'add-node', nodeId: 'source', reason: 'research gap' }, { surface: 'mcp' }))
    .toMatchObject({ error: 'add-node requires the observed node outcome' });
  expect(await runtime('graph_node_op').run({ graphId: 'research-proof', runId: 'ed-test-abcdef',
    op: 'narrow', nodeId: 'source', reason: 'unsupported until runner semantics are defined' }, { surface: 'mcp' }))
    .toMatchObject({ error: 'invalid graphId, runId, op, nodeId, or reason' });
});

test('graph_node_op validates add-node through graph-grow and links the new run to the failed parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-mcp-grow-'));
  dirs.push(root);
  const graphId = 'demo-safe';
  const runId = 'ed-test-abcdef';
  const graphDir = join(root, 'graph-run-work', graphId, runId);
  const stateDir = join(root, 'graph-runs', graphId);
  mkdirSync(graphDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(graphDir, 'graph.yaml'), `graph_id: demo-safe
version: 1
entry_node: judge
terminal_nodes: [done, failed]
nodes:
  - { node_id: judge, kind: judge, recipe: none, max_visits: 2 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: judge, on: outcome, map: { ok: done, fail: failed } }
`);
  writeFileSync(join(stateDir, `${runId}.json`), JSON.stringify({
    graphId, runId, status: 'failed', path: ['judge', 'failed'],
    nodes: [{ nodeId: 'judge', ok: false, exit: 1, executed: true, output: { gaps: ['missing source'] } }],
  }));
  let seen: Record<string, unknown> | undefined;
  setGraphMcpDepsForTest({
    root,
    growth: ((input, _proposer, classify, deps) => proposeGrowth(input,
      () => ({ node: { nodeId: 'research', kind: 'agent', recipe: 'none', maxVisits: 1,
        contract: { inputs: [], tools: 'read-only', outputs: [] } }, returnTo: 'judge', reason: 'check source' }),
      classify, deps)) as typeof proposeGrowth,
    run: (async (_file, options) => {
      seen = options as Record<string, unknown>;
      return { graphId, runId: 'ed-child-fedcba', status: 'done', path: ['judge', 'research', 'done'], nodes: [], executed: true } as unknown as GraphRunState;
    }) as typeof import('../graph-runner/runner.js').runGraph,
  });
  const result = await runtime('graph_node_op').run({ graphId, runId, op: 'add-node', nodeId: 'judge',
    outcome: 'needs-research', reason: 'source absent' }, { surface: 'mcp', mcpClient: 'aside' });
  expect(result).toMatchObject({ status: 'done', parentRunId: runId, runId: 'ed-child-fedcba' });
  expect(seen?.variant).toMatchObject({ plan: { growth: { from: 'judge', outcome: 'needs-research', returnTo: 'judge',
    node: { nodeId: 'research' } } } });
  const retried = await runtime('graph_node_op').run({ graphId, runId, op: 'retry', nodeId: 'judge',
    reason: 'new source available' }, { surface: 'mcp', mcpClient: 'aside' });
  expect(retried).toMatchObject({ status: 'done', runId });
  expect(seen).toMatchObject({ resumeRunId: runId, fromNodeId: 'judge' });
});

test('graph_node_op converts missing saved graph errors into structured add-node refusals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-mcp-grow-missing-'));
  dirs.push(root);
  const graphId = 'demo-safe';
  const runId = 'ed-test-abcdef';
  const stateDir = join(root, 'graph-runs', graphId);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `${runId}.json`), JSON.stringify({ graphId, runId, status: 'failed', path: ['judge'],
    nodes: [{ nodeId: 'judge', ok: false, exit: 1, executed: true, output: { gaps: ['missing source'] } }] }));
  setGraphMcpDepsForTest({ root });
  const result = await runtime('graph_node_op').run({ graphId, runId, op: 'add-node', nodeId: 'judge',
    outcome: 'needs-research', reason: 'source absent' }, { surface: 'mcp', mcpClient: 'aside' });
  expect(result.error).toContain('ENOENT');
  expect(result.output).toStartWith('graph_node_op: ');
});

test('graph_node_op converts graph-grow exceptions into structured add-node refusals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-mcp-grow-throws-'));
  dirs.push(root);
  const graphId = 'demo-safe';
  const runId = 'ed-test-abcdef';
  const graphDir = join(root, 'graph-run-work', graphId, runId);
  const stateDir = join(root, 'graph-runs', graphId);
  mkdirSync(graphDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(graphDir, 'graph.yaml'), `graph_id: demo-safe
version: 1
entry_node: judge
terminal_nodes: [done, failed]
nodes:
  - { node_id: judge, kind: judge, recipe: none, max_visits: 2 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: judge, on: outcome, map: { ok: done, fail: failed } }
`);
  writeFileSync(join(stateDir, `${runId}.json`), JSON.stringify({ graphId, runId, status: 'failed', path: ['judge'],
    nodes: [{ nodeId: 'judge', ok: false, exit: 1, executed: true, output: { gaps: ['missing source'] } }] }));
  setGraphMcpDepsForTest({ root, growth: (async () => { throw new Error('growth unavailable'); }) as typeof proposeGrowth });
  const result = await runtime('graph_node_op').run({ graphId, runId, op: 'add-node', nodeId: 'judge',
    outcome: 'needs-research', reason: 'source absent' }, { surface: 'mcp', mcpClient: 'aside' });
  expect(result).toMatchObject({ output: 'graph_node_op: growth unavailable', error: 'growth unavailable' });
});
