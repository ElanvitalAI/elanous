import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { applyDecidedApprovals, raiseApprovalCard } from './graph-approval-card.js';
import { decideGraphApproval, runGraph, type GraphRunState } from './runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(graphId = 'release-loop', nodeId = 'approve-publish') {
  const root = mkdtempSync(join(tmpdir(), 'graph-card-'));
  roots.push(root);
  const runId = 'run-1';
  const statePath = join(root, 'graph-runs', graphId, `${runId}.json`);
  mkdirSync(join(root, 'graph-runs', graphId), { recursive: true });
  const state: GraphRunState = { graphId, runId, statePath, status: 'awaiting-approval', path: [nodeId], nodes: [],
    executed: 0, dryRun: false, pending: { nodeId, since: new Date().toISOString(), message: 'v0.2.10 공개 발행 — 되돌릴 수 없다. 승인하시겠습니까?' } };
  writeFileSync(statePath, JSON.stringify(state));
  const ledger = new DecisionLedger({ stateDir: root, resolveVersion: () => ({ released: '0.2.9', dev: '0.2.10', codename: null }) });
  const deps = { root, ledger };
  const claim = `${statePath}.1.decision.json`;
  return { root, state, statePath, claim, ledger, deps };
}

test('release approval raises one publish card with exact ref and human-only choices; repeat deduplicates', () => {
  const { state, ledger, deps } = fixture();
  const first = raiseApprovalCard(state, state.pending!, deps);
  expect(first?.title).toBe('v0.2.10 공개 발행 — 되돌릴 수 없다. 승인하시겠습니까?');
  expect(first?.category).toBe('publish');
  expect(first?.refs).toEqual(['graph-approval:release-loop:run-1:approve-publish:1']);
  expect(first?.options.map(option => [option.key, option.label])).toEqual([['a', '승인'], ['b', '거절']]);
  expect(first?.recommendation).toEqual({ skipped: true, reason: '사람 판단' });
  expect(raiseApprovalCard(state, state.pending!, deps)?.id).toBe(first?.id);
  expect(ledger.list({ status: 'all' })).toHaveLength(1);
});

test('non-release approvals use scope and include the run and node in title', () => {
  const { state, deps } = fixture('other', 'gate');
  const entry = raiseApprovalCard(state, state.pending!, deps);
  expect(entry?.category).toBe('scope');
  expect(entry?.title).toBe('other run-1 — gate 승인');
});

test.each([['a', 'approved'], ['b', 'rejected']] as const)('decided %s claims %s with the runner writer only once', (choice, outcome) => {
  const { state, ledger, deps, claim } = fixture();
  const card = raiseApprovalCard(state, state.pending!, deps)!;
  ledger.decide(card.id, choice, { kind: 'human' });
  expect(applyDecidedApprovals(deps)).toBe(1);
  const recorded = JSON.parse(readFileSync(claim, 'utf8'));
  expect(recorded).toMatchObject({ nodeId: 'approve-publish', decision: outcome, decidedBy: 'owner:human' });
  expect(applyDecidedApprovals(deps)).toBe(0);
  expect(readFileSync(claim, 'utf8')).toBe(JSON.stringify(recorded) + '\n');
});

test('CLI claim wins without overwriting it', () => {
  const { state, ledger, deps, claim, root } = fixture();
  const card = raiseApprovalCard(state, state.pending!, deps)!;
  ledger.decide(card.id, 'b', { kind: 'human' });
  decideGraphApproval(state.graphId, state.runId, 'approved', 'cli', root);
  const before = readFileSync(claim, 'utf8');
  expect(applyDecidedApprovals(deps)).toBe(0);
  expect(readFileSync(claim, 'utf8')).toBe(before);
});

test('moved run or a later visit never receives the stale card answer', () => {
  const { state, ledger, deps, claim, statePath } = fixture();
  const card = raiseApprovalCard(state, state.pending!, deps)!;
  ledger.decide(card.id, 'a', { kind: 'human' });
  state.pending = { nodeId: 'next', since: new Date().toISOString(), message: 'next?' };
  state.path.push('next');
  writeFileSync(statePath, JSON.stringify(state));
  expect(applyDecidedApprovals(deps)).toBe(0);
  expect(existsSync(claim)).toBe(false);
  state.pending = { nodeId: 'approve-publish', since: new Date().toISOString(), message: 'again?' };
  state.path.push('approve-publish');
  writeFileSync(statePath, JSON.stringify(state));
  expect(applyDecidedApprovals(deps)).toBe(0);
  expect(existsSync(`${statePath}.3.decision.json`)).toBe(false);
});

test('a CLI claim and resume between card check and writer never claims the next visit', () => {
  const { state, ledger, root, claim, statePath } = fixture();
  const card = raiseApprovalCard(state, state.pending!, { root, ledger })!;
  ledger.decide(card.id, 'b', { kind: 'human' });
  const decided = ledger.list({ status: 'decided' })[0]!;
  let raced = false;
  Object.defineProperty(decided.decidedBy!, 'kind', { get() {
    if (!raced) {
      raced = true;
      decideGraphApproval(state.graphId, state.runId, 'approved', 'cli', root);
      state.path.push('next', state.pending!.nodeId);
      state.pending = { nodeId: 'approve-publish', since: new Date().toISOString(), message: 'second visit' };
      writeFileSync(statePath, JSON.stringify(state));
    }
    return 'human';
  } });
  const racingLedger = { list: () => [decided], raise: ledger.raise.bind(ledger) } as unknown as DecisionLedger;
  expect(applyDecidedApprovals({ root, ledger: racingLedger })).toBe(0);
  expect(JSON.parse(readFileSync(claim, 'utf8'))).toMatchObject({ decision: 'approved', decidedBy: 'cli' });
  expect(existsSync(`${statePath}.3.decision.json`)).toBe(false);
});

test('card approval resumes through the actual graph approval node toward publish', async () => {
  const { root, ledger, deps } = fixture();
  const dir = join(root, 'graphs');
  mkdirSync(dir);
  const graph = join(dir, 'release-loop.yaml');
  writeFileSync(graph, `graph_id: release-loop\nversion: 1\nentry_node: approve-publish\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: approve-publish, kind: hitl, recipe: 'approval:publish', max_visits: 1 }\n  - { node_id: publish, kind: git, recipe: 'cmd:command', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - { from: approve-publish, on: outcome, map: { ok: publish, fail: failed } }\n  - { from: publish, on: outcome, map: { ok: done, fail: failed } }\n`);
  writeFileSync(join(dir, 'recipes.yaml'), `publish: { approval: 'Publish?' }\ncommand: { command: 'echo published' }\n`);
  const run = await runGraph(graph, { runId: 'actual', deps: { root, processStartMs: () => null } });
  expect(run.status).toBe('awaiting-approval');
  const card = raiseApprovalCard(run, run.pending!, deps)!;
  ledger.decide(card.id, 'a', { kind: 'human' });
  expect(applyDecidedApprovals(deps)).toBe(1);
  const resumed = await runGraph(graph, { resumeRunId: 'actual', deps: { root, processStartMs: () => null, runBash: async () => ({ stdout: 'published', stderr: '', exitCode: 0 }) } });
  expect(resumed.path).toEqual(['approve-publish', 'publish', 'done']);
  expect(resumed.nodes[0]?.decidedBy).toBe('owner:human');
  expect(resumed.status).toBe('done');
});

test('a delegated auto decision never approves or rejects a graph approval', () => {
  const { state, ledger, deps, claim } = fixture();
  const card = raiseApprovalCard(state, state.pending!, deps)!;
  ledger.decide(card.id, 'a', { kind: 'auto', agent: 'tc', delegation: 'D-test' });
  expect(applyDecidedApprovals(deps)).toBe(0);
  expect(existsSync(claim)).toBe(false);
});

test('one unreadable run does not block a later card', () => {
  const { state, ledger, deps, claim, root, statePath } = fixture();
  const brokenDir = join(root, 'graph-runs', 'broken');
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, 'run-x.json'), '{not json');
  ledger.raise({ title: 'broken', category: 'scope', scqa: { s: 's', c: 'c' },
    options: [{ key: 'a', label: '승인', consequence: 'x' }, { key: 'b', label: '거절', consequence: 'y' }],
    recommendation: { skipped: true, reason: '사람 판단' }, raisedBy: { agent: 'graph-runner' }, refs: ['graph-approval:broken:run-x:gate:1'] });
  const broken = ledger.list({ status: 'open' }).find(entry => entry.title === 'broken')!;
  ledger.decide(broken.id, 'a', { kind: 'human' });
  const card = raiseApprovalCard(state, state.pending!, deps)!;
  ledger.decide(card.id, 'a', { kind: 'human' });
  expect(applyDecidedApprovals(deps)).toBe(1);
  expect(JSON.parse(readFileSync(claim, 'utf8'))).toMatchObject({ decision: 'approved' });
  expect(statePath).toBeTruthy();
});
