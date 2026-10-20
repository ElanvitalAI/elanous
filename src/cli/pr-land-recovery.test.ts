import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { runGraph } from '../graph-runner/runner.js';
import { planPrLandRecovery, planPrLandRecoveryForEntry } from './pr-land-recovery.js';

const pr = 29086;
const head = '5a23b9210015b2e1f3a62d9a1a38f421fc4aa18d';
const busy = '✗ heavy-remote: 원격 게이트 gate-host-busy — 로컬 게이트로 폴백하지 않는다.';

test('recover@1 chooses only a delayed, pinned retry for measured host busy', () => {
  expect(planPrLandRecovery({ refusal: busy, pr, head })).toMatchObject({
    outcome: 'rework', result: { action: 'wait-retry', pr, head, delayMs: 30000 },
    evidence: { label: 'gate-host-busy', route: 'next-move', source: 'graph' },
  });
});

test('review refusal chooses exact-head review while conflicts and unknown refusals stay human', () => {
  expect(planPrLandRecovery({ refusal: '✗ ancestor-auto: review-missing', pr, head }).result.action).toBe('request-review');
  expect(planPrLandRecovery({ refusal: '✗ ancestor-auto: ancestor-auto-not-ancestor: a is not an ancestor of b', pr, head }).result.action).toBe('needs-human');
  expect(planPrLandRecovery({ refusal: '✗ other: unexplained', pr, head }).outcome).toBe('needs-human');
});

test('missing pinned identity fails closed and cannot select a retry', () => {
  expect(planPrLandRecovery({ refusal: busy, pr, head: 'short' })).toMatchObject({ outcome: 'failed', result: { action: 'none' } });
  expect(planPrLandRecovery({ refusal: busy, pr: 0, head })).toMatchObject({ outcome: 'failed', result: { action: 'none' } });
});

test('a mixed refusal transcript never selects the convenient busy retry', () => {
  const plan = planPrLandRecovery({ refusal: `${busy}\n✗ review: must-fix remains`, pr, head });
  expect(plan).toMatchObject({ outcome: 'needs-human', result: { action: 'needs-human' } });
  expect(planPrLandRecovery({ refusal: `${busy}\nerror: review-missing`, pr, head }))
    .toMatchObject({ outcome: 'needs-human', result: { action: 'needs-human' } });
});

test('recover@1 declares the standard envelope and four exits', () => {
  const path = join(import.meta.dir, '../../graphs/units/recover.yaml');
  const parsed = parseGraphTemplateYaml(readFileSync(path, 'utf8'), path);
  expect(parsed.errors).toEqual([]);
  expect(parsed.template?.unit).toEqual({ inputs: ['ask', 'context', 'prior'], outputs: ['result', 'evidence'], exits: ['done', 'rework', 'needs-human', 'failed'], entries: ['plan', 'request-review', 'wait-retry', 'human-review'] });
});

test('a selected recover entry rejects a mismatched refusal before any recovery effect', () => {
  expect(planPrLandRecoveryForEntry({ refusal: busy, pr, head }, 'request-review')).toMatchObject({
    outcome: 'failed', result: { action: 'none' },
  });
  expect(planPrLandRecoveryForEntry({ refusal: '✗ ancestor-auto: review-missing', pr, head }, 'wait-retry')).toMatchObject({
    outcome: 'failed', result: { action: 'none' },
  });
  expect(planPrLandRecoveryForEntry({ refusal: busy, pr, head }, 'wait-retry')).toMatchObject({
    outcome: 'rework', result: { action: 'wait-retry', pr, head },
  });
  expect(planPrLandRecoveryForEntry({ refusal: '✗ ancestor-auto: review-missing', pr, head }, 'request-review')).toMatchObject({
    outcome: 'rework', result: { action: 'request-review', pr, head },
  });
  expect(planPrLandRecoveryForEntry({ refusal: '✗ ancestor-auto: ancestor-auto-not-ancestor: a is not an ancestor of b', pr, head }, 'human-review'))
    .toMatchObject({ outcome: 'needs-human', result: { action: 'needs-human', pr, head } });
  expect(planPrLandRecoveryForEntry({ refusal: busy, pr, head }, 'human-review'))
    .toMatchObject({ outcome: 'failed', result: { action: 'none' } });
  expect(planPrLandRecoveryForEntry({ refusal: busy, pr, head }, 'plan'))
    .toMatchObject({ outcome: 'rework', result: { action: 'wait-retry', pr, head } });
  expect(planPrLandRecoveryForEntry({ refusal: busy, pr, head }, ''))
    .toMatchObject({ outcome: 'failed', result: { action: 'none', reason: 'unknown recover entry: ' } });
});

test('recover@1 runner selects rework without invoking a landing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recover-unit-'));
  try {
    const path = join(import.meta.dir, '../../graphs/units/recover.yaml');
    const run = await runGraph(path, { input: { ask: 'recover landing refusal', context: { refusal: busy, pr, head }, prior: null }, deps: { root } });
    expect(run.status).toBe('done');
    expect(run.path).toEqual(['plan', 'rework']);
    expect(JSON.parse(String(run.nodes[0]?.output))).toMatchObject({ result: { action: 'wait-retry', pr, head }, evidence: { label: 'gate-host-busy' } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a parent graph calls recover@1 and receives its selected action', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recover-parent-'));
  try {
    const graph = join(root, 'parent.yaml');
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(graph, `graph_id: recover-parent
version: 1
entry_node: recover
terminal_nodes: [done, failed]
nodes:
  - node_id: recover
    kind: subgraph
    recipe: none
    max_visits: 1
    call: recover@1
    call_entry: wait-retry
    budget: { inner_steps: 3 }
    contract: { inputs: [ask, context, prior], tools: read-only, outputs: [result, evidence] }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: recover, on: outcome, map: { done: done, rework: done, needs-human: done, failed: failed } }
`);
    const run = await runGraph(graph, { input: { ask: 'recover landing refusal', context: { refusal: busy, pr, head }, prior: null }, deps: { root } });
    expect(run.status).toBe('done');
    expect(run.unitCalls?.[0]).toMatchObject({ unit: 'recover', entry: 'wait-retry', exit: 'rework' });
    expect(JSON.parse(String(run.nodes[0]?.output))).toMatchObject({ outcome: 'rework', result: { action: 'wait-retry', pr, head } });
    writeFileSync(graph, readFileSync(graph, 'utf8').replace('call_entry: wait-retry', 'call_entry: request-review'));
    const mismatch = await runGraph(graph, { input: { ask: 'recover landing refusal', context: { refusal: busy, pr, head }, prior: null }, deps: { root } });
    expect(mismatch.status).toBe('failed');
    expect(mismatch.unitCalls?.[0]).toMatchObject({ unit: 'recover', entry: 'request-review', exit: 'failed' });
    expect(JSON.parse(String(mismatch.nodes[0]?.output))).toMatchObject({ outcome: 'failed', result: { action: 'none' } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a parent graph with no call_entry uses the default recover plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recover-default-'));
  try {
    const graph = join(root, 'parent.yaml');
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(graph, `graph_id: recover-default-parent
version: 1
entry_node: recover
terminal_nodes: [done, failed]
nodes:
  - node_id: recover
    kind: subgraph
    recipe: none
    max_visits: 1
    call: recover@1
    budget: { inner_steps: 3 }
    contract: { inputs: [ask, context, prior], tools: read-only, outputs: [result, evidence] }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: recover, on: outcome, map: { done: done, rework: done, needs-human: done, failed: failed } }
`);
    const run = await runGraph(graph, { input: { ask: 'recover landing refusal', context: { refusal: busy, pr, head }, prior: null }, deps: { root } });
    expect(run.status).toBe('done');
    expect(run.unitCalls?.[0]).toMatchObject({ unit: 'recover', entry: 'plan', exit: 'rework' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
