import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runGraph } from '../../src/graph-runner/runner.js';
import { resolveGraphUnit } from '../../src/self-implement/graph-unit-resolver.js';

type ReleaseGraph = {
  entry_node: string;
  terminal_nodes: string[];
  nodes: Array<Record<string, unknown> & { node_id: string }>;
  edges: Array<Record<string, unknown> & { from: string; on?: string; map?: Record<string, string> }>;
};

const releaseGraphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
const releaseRecipesPath = join(import.meta.dir, '../../graphs/release/recipes.yaml');

test('RELEASE-GRAPH-PODREUSE-SUBGRAPH-CALL: shipped prep unit immediately returns the pending legacy verdict', async () => {
  const unit = resolveGraphUnit('pod-reuse-prep@1', releaseGraphPath);
  expect(unit.template.unit).toMatchObject({ inputs: ['cutSha', 'candidatePath'],
    outputs: ['verdict', 'reason', 'receiptPath'], exits: ['reuse', 'legacy', 'skip', 'failed', 'error'] });
  const root = mkdtempSync(join(tmpdir(), 'release-pod-reuse-pending-'));
  try {
    const result = await runGraph(unit.path, { input: { cutSha: 'cut-sha', candidatePath: 'candidate' }, deps: { root } });
    expect(result.status).toBe('done');
    expect(result.path).toEqual(['pending', 'legacy']);
    expect(result.nodes[0]?.output).toContain('"verdict":"legacy"');
    expect(result.nodes[0]?.output).toContain('"reason":"prep-body-pending"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RELEASE-GRAPH-PODREUSE-SUBGRAPH-CALL: reuse, legacy, mismatch, timeout, failure and error reach the legacy gate', async () => {
  const cutSha = 'a'.repeat(40); // Source: a full commit SHA is the simulated release cut input.
  const source = readFileSync(releaseGraphPath, 'utf8');
  const production = parseYaml(source) as ReleaseGraph;
  const call = production.nodes.find((node) => node.node_id === 'pod-reuse-prep');
  expect(call).toMatchObject({ kind: 'subgraph', call: 'pod-reuse-prep@1',
    contract: { inputs: ['cutSha', 'candidatePath'], outputs: ['verdict', 'reason', 'receiptPath'] } });
  expect(production.edges.find((edge) => edge.from === 'pre-gate-join')?.map?.ok).toBe('cloud-approval-check');
  expect(production.edges.find((edge) => edge.from === 'cloud-approval-check')?.map?.ok).toBe('cloud-join');
  expect(production.edges.find((edge) => edge.from === 'cloud-join')?.map?.ok).toBe('pod-reuse-prep');
  expect(production.edges.find((edge) => edge.from === 'pod-reuse-prep')?.map)
    .toEqual({ reuse: 'gate', legacy: 'gate', skip: 'gate', failed: 'gate', error: 'gate' });

  const cases = [
    { candidatePath: 'fixture:reuse', exit: 'reuse', verdict: 'reuse', reason: 'warm match' },
    { candidatePath: 'fixture:legacy', exit: 'legacy', verdict: 'legacy', reason: 'no reusable worker' },
    { candidatePath: 'fixture:mismatch', exit: 'legacy', verdict: 'legacy', reason: 'identity mismatch' },
    { candidatePath: 'fixture:timeout', exit: 'legacy', verdict: 'legacy', reason: 'prep timeout' },
    { candidatePath: 'fixture:failure', exit: 'failed', verdict: 'legacy', reason: 'prep failed' },
    { candidatePath: 'fixture:error', exit: 'error', verdict: 'legacy', reason: 'prep error' },
  ] as const;

  const universe = mkdtempSync(join(tmpdir(), 'release-pod-reuse-subgraph-'));
  const graphDir = join(universe, 'graphs', 'release');
  const unitsDir = join(graphDir, 'units');
  mkdirSync(unitsDir, { recursive: true });
  const graphPath = join(graphDir, 'release-loop.yaml');
  writeFileSync(graphPath, stringifyYaml(production));
  writeFileSync(join(graphDir, 'recipes.yaml'), readFileSync(releaseRecipesPath, 'utf8'));
  writeFileSync(join(unitsDir, 'pod-reuse-prep.yaml'), `graph_id: pod-reuse-prep
version: 1
unit:
  inputs: [cutSha, candidatePath]
  outputs: [verdict, reason, receiptPath]
  exits: [reuse, legacy, skip, failed, error]
entry_node: observe
terminal_nodes: [reuse, legacy, skip, failed, error]
nodes:
  - { node_id: observe, kind: agent, recipe: 'cmd:observe', max_visits: 1 }
  - { node_id: decide, kind: agent, recipe: 'cmd:decide', max_visits: 1 }
  - { node_id: reuse, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: legacy, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: skip, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: error, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: observe, on: outcome, map: { ok: decide, skip: skip } }
  - { from: decide, on: outcome, map: { reuse: reuse, legacy: legacy, fail: failed, error: error } }
`);
  writeFileSync(join(unitsDir, 'recipes.yaml'), `observe:\n  command: 'fake pod reuse observe'\ndecide:\n  command: 'fake pod reuse decide'\n`);

  try {
    for (const item of cases) {
      const root = join(universe, item.candidatePath.replaceAll(':', '-'));
      let gateCalls = 0;
      const runBash = async (_command: string, options: { env?: NodeJS.ProcessEnv }) => {
        const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
        if (!contextPath) throw new Error('release graph simulation is missing its node context');
        const context = JSON.parse(await Bun.file(contextPath).text()) as {
          graphId: string; nodeId: string; executionId?: string; input?: { cutSha?: string; candidatePath?: string };
          outputs?: Record<string, { outcome?: string; verdict?: string; reason?: string; receiptPath?: string }>;
        };
        if (context.graphId === 'pod-reuse-prep' && context.nodeId === 'observe') {
          expect(context.input).toMatchObject({ cutSha, candidatePath: item.candidatePath });
          return { stdout: JSON.stringify({ outcome: 'ok', verdict: item.verdict, reason: item.reason,
            receiptPath: '/test/pod-reuse-receipt.json' }), stderr: '', exitCode: 0 };
        }
        if (context.graphId === 'pod-reuse-prep' && context.nodeId === 'decide') {
          return { stdout: JSON.stringify({ outcome: item.exit === 'failed' ? 'fail' : item.exit }), stderr: '',
            exitCode: item.exit === 'failed' ? 1 : 0 };
        }
        if (context.graphId === 'release-loop' && context.nodeId === 'gate') {
          gateCalls++;
          expect(context.outputs?.['pod-reuse-prep']).toMatchObject({ verdict: item.verdict, reason: item.reason,
            receiptPath: '/test/pod-reuse-receipt.json' });
        }
        if (context.graphId === 'release-loop' && context.nodeId === 'cutoff')
          return { stdout: JSON.stringify({ outcome: 'ok', version: '0.3.9', commit: cutSha, cutoff: { sha: cutSha } }), stderr: '', exitCode: 0 };
        const outcome = context.nodeId === 'gate-cutover-switch' ? 'legacy' : 'ok';
        return { stdout: JSON.stringify({ outcome, version: '0.3.9', commit: cutSha,
          ...(context.nodeId === 'gate' ? { executionId: context.executionId } : {}) }), stderr: '', exitCode: 0 };
      };
      const result = await runGraph(graphPath, { input: { version: '0.3.9', cutSha, candidatePath: item.candidatePath },
        deps: { root, runBash } });
      expect(result.status, JSON.stringify(result.nodes)).toBe('done');
      expect(result.path, item.candidatePath).toContain('pod-reuse-prep');
      expect(result.path, item.candidatePath).toContain('gate');
      expect(gateCalls, item.candidatePath).toBe(1);
    }
  } finally {
    rmSync(universe, { recursive: true, force: true });
  }
}, 30_000); // Source: remote run exercises six complete release-graph scenarios under the measured CI host budget.

test('RELEASE-POD-PREP-INPUT-WIRE: actual release graph maps cutoff SHA and skips absent candidate to gate', async () => {
  const cutSha = 'c'.repeat(40); // Source: a full commit SHA is the simulated release cut input.
  const root = mkdtempSync(join(tmpdir(), 'release-pod-prep-input-wire-'));
  try {
    let gateCalls = 0;
    const result = await runGraph(releaseGraphPath, {
      input: { version: '0.3.9' },
      deps: { root, runBash: async (_command, options) => {
        const contextFile = options.env?.ELANOUS_GRAPH_CONTEXT;
        if (!contextFile) throw new Error('release graph simulation is missing its node context');
        const context = JSON.parse(await Bun.file(contextFile).text()) as {
          graphId: string; nodeId: string; executionId?: string;
          outputs?: Record<string, { outcome?: string; verdict?: string; reason?: string; receiptPath?: string }>;
        };
        if (context.graphId === 'release-loop' && context.nodeId === 'cutoff')
          return { stdout: JSON.stringify({ outcome: 'ok', version: '0.3.9', commit: cutSha,
            baseline: { sha: 'b'.repeat(40) }, cutoff: { sha: cutSha } }), stderr: '', exitCode: 0 };
        if (context.graphId === 'release-loop' && context.nodeId === 'gate') {
          gateCalls++;
          expect(context.outputs?.['pod-reuse-prep']).toMatchObject({
            outcome: 'skip', verdict: 'skip', reason: 'candidate-path-unavailable', receiptPath: '',
          });
        }
        const outcome = context.nodeId === 'gate-cutover-switch' ? 'legacy' : 'ok';
        return { stdout: JSON.stringify({ outcome, version: '0.3.9', commit: cutSha,
          ...(context.nodeId === 'gate' ? { executionId: context.executionId } : {}) }), stderr: '', exitCode: 0 };
      } },
    });
    expect(result.status, JSON.stringify(result.nodes)).toBe('done');
    expect(result.path).toContain('pod-reuse-prep');
    expect(result.path).toContain('gate');
    expect(gateCalls).toBe(1);
    expect(String(result.nodes.find((node) => node.nodeId === 'pod-reuse-prep')?.output))
      .toContain('"outcome":"skip"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
