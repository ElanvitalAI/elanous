import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { decideGraphApproval, hasApprovedGraphNodeInput, runGraph } from './runner.js';
import { loadGraphPluginFromDir } from './graph-manifest-loader.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { applyDecidedApprovals, raiseApprovalCard } from './graph-approval-card.js';
import { graphTick } from './graph-tick.js';

const graph = `graph_id: hitl-seam\nversion: 1\nentry_node: approve-budget\nterminal_nodes: [done, failed]\n` +
  `nodes:\n  - { node_id: approve-budget, kind: hitl, recipe: 'hitl:budget', max_visits: 1, input: { approval: 'Approve budget {{input.request}}?' } }\n` +
  `  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n` +
  `  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\n` +
  `edges:\n  - { from: approve-budget, on: outcome, map: { approved: done, rejected: failed } }\n`;

function fixture(graphId = 'hitl-seam'): { dir: string; path: string; root: string } {
  const dir = mkdtempSync(join(tmpdir(), 'graph-hitl-seam-'));
  const path = join(dir, 'graph.yaml');
  writeFileSync(path, graph.replace('graph_id: hitl-seam', `graph_id: ${graphId}`));
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'hitl-seam', version: '1.0.0',
    extensions: { 'ai.elanous': { graphs: ['./graph.yaml'], graphManifests: { [graphId]: {
      purpose: 'Approve a bounded request', allow: { recipes: [] }, hitl: ['approve-budget'],
    } } } } }));
  return { dir, path, root: join(dir, 'state') };
}

test('declarations alone bind a generic HITL node and durable approval to the pinned input', async () => {
  const { dir, path, root } = fixture();
  try {
    expect(loadGraphPluginFromDir(dir).graphs['hitl-seam']?.manifest.hitl).toEqual(['approve-budget']);
    const input = { request: { budgetKrw: 1234 } }; // Source: #36491
    const sha = createHash('sha256').update(JSON.stringify(input.request)).digest('hex');
    const first = await runGraph(path, { runId: 'approved', input, deps: { root }, quiet: true });
    expect(first.status).toBe('awaiting-approval');
    expect(first.pending?.nodeId).toBe('approve-budget');
    expect(first.pending?.message).toContain('{"budgetKrw":1234}');
    const check = { graphId: first.graphId, runId: first.runId, nodeId: 'approve-budget', inputPath: 'request',
      inputSha256: sha, maxAgeMs: 60_000, root }; // Source: #36491
    expect(hasApprovedGraphNodeInput(check)).toBe(false);
    decideGraphApproval(first.graphId, first.runId, 'approved', 'OP', root);
    const resumed = await runGraph(path, { resumeRunId: first.runId, deps: { root }, quiet: true });
    expect(resumed.status).toBe('done');
    expect(resumed.path).toEqual(['approve-budget', 'done']);
    expect(hasApprovedGraphNodeInput(check)).toBe(true);
    const changed = JSON.parse(readFileSync(resumed.statePath, 'utf8')) as { input: { request: { budgetKrw: number } } };
    changed.input.request.budgetKrw = 9999; // Source: #36491
    writeFileSync(resumed.statePath, JSON.stringify(changed));
    expect(hasApprovedGraphNodeInput({ ...check,
      inputSha256: createHash('sha256').update(JSON.stringify(changed.input.request)).digest('hex') })).toBe(false);
    expect(hasApprovedGraphNodeInput({ ...check, inputSha256: '0'.repeat(64) })).toBe(false);
    const at = Date.parse(resumed.nodes[0]!.decidedAt!);
    expect(hasApprovedGraphNodeInput({ ...check, now: at + 60_001 })).toBe(false);
    const claim = JSON.parse(readFileSync(`${resumed.statePath}.1.decision.json`, 'utf8')) as { decision: string };
    expect(claim.decision).toBe('approved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two-choice HITL uses the declared prompt and generic version interpolation', async () => {
  const { dir, path, root } = fixture();
  try {
    const source = readFileSync(path, 'utf8').replace("'Approve budget {{input.request}}?'", "'Approve {{input.version}} for {{input.request}}?'")
      .replace('max_visits: 1, input:', 'max_visits: 1, hitl: { options: [{ key: approve, exit: approved }, { key: reject, exit: rejected, default: true }] }, input:');
    writeFileSync(path, source);
    const state = await runGraph(path, { input: { version: 'v1', request: { budgetKrw: 1234 } }, deps: { root }, quiet: true }); // Source: #36491
    expect(state.status).toBe('awaiting-approval');
    expect(state.pending?.message).toContain('Approve v1 for {"budgetKrw":1234}?');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('approval rejects input changed after the card was shown', async () => {
  const { dir, path, root } = fixture();
  try {
    writeFileSync(path, readFileSync(path, 'utf8').replace('Approve budget {{input.request}}?', 'Approve budget?'));
    const pending = await runGraph(path, { input: { request: { budgetKrw: 1234 } }, deps: { root }, quiet: true }); // Source: #36491
    const changed = JSON.parse(readFileSync(pending.statePath, 'utf8'));
    changed.input.request.budgetKrw = 9999; // Source: #36491
    writeFileSync(pending.statePath, JSON.stringify(changed));
    expect(() => decideGraphApproval(pending.graphId, pending.runId, 'approved', 'OP', root))
      .toThrow('approval input changed since card was shown');
    await expect(runGraph(path, { resumeRunId: pending.runId, deps: { root }, quiet: true }))
      .rejects.toThrow('approval input changed since card was shown');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each([false, true])('legacy unpinned card is retired before a fresh approval (claim: %p)', async (existingClaim) => {
  const { dir, path, root } = fixture();
  try {
    const first = await runGraph(path, { input: { request: { budgetKrw: 1234 } }, deps: { root }, quiet: true }); // Source: #36491
    const saved = JSON.parse(readFileSync(first.statePath, 'utf8'));
    delete saved.pending.inputSha256;
    writeFileSync(first.statePath, JSON.stringify(saved));
    const ledger = new DecisionLedger({ stateDir: root });
    const oldCard = raiseApprovalCard(saved, saved.pending, { root, ledger })!;
    ledger.decide(oldCard.id, 'a', { kind: 'human' });
    const oldClaim = `${first.statePath}.1.decision.json`;
    if (existingClaim) writeFileSync(oldClaim, JSON.stringify({ nodeId: 'approve-budget', decision: 'approved',
      decidedAt: new Date().toISOString(), inputSha256: createHash('sha256').update(JSON.stringify(saved.input)).digest('hex') }));
    const refreshed = await runGraph(path, { resumeRunId: first.runId, deps: { root }, quiet: true });
    expect(refreshed.status).toBe('awaiting-approval');
    expect(refreshed.pending?.inputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(refreshed.pending?.approvalNonce).toBeTruthy();
    expect(existsSync(oldClaim)).toBe(false);
    expect(readdirSync(`${root}/graph-runs/hitl-seam`).some(file => file.includes('.decision.json.legacy-'))).toBe(existingClaim);
    expect(applyDecidedApprovals({ root, ledger })).toBe(0);
    const newCard = raiseApprovalCard(refreshed, refreshed.pending!, { root, ledger })!;
    expect(newCard.id).not.toBe(oldCard.id);
    ledger.decide(newCard.id, 'a', { kind: 'human' });
    expect(applyDecidedApprovals({ root, ledger })).toBe(1);
    const done = await runGraph(path, { resumeRunId: first.runId, deps: { root }, quiet: true });
    expect(done.status).toBe('done');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('daemon tick reissues a legacy unpinned card instead of waiting forever', async () => {
  const { dir, path, root } = fixture();
  try {
    const first = await runGraph(path, { input: { request: { budgetKrw: 1234 } }, deps: { root }, quiet: true }); // Source: #36491
    const saved = JSON.parse(readFileSync(first.statePath, 'utf8'));
    delete saved.pending.inputSha256;
    writeFileSync(first.statePath, JSON.stringify(saved));
    const result = await graphTick(path, { deps: { root } });
    expect(result).toMatchObject({ action: 'resumed', runId: first.runId, status: 'awaiting-approval' });
    const refreshed = JSON.parse(readFileSync(first.statePath, 'utf8'));
    expect(refreshed.pending.inputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(refreshed.pending.approvalNonce).toBeTruthy();
    expect(await graphTick(path, { deps: { root } })).toMatchObject({ action: 'waiting', runId: first.runId });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1 HITL and capability graph needs no command recipe sidecar', async () => {
  const { dir, path, root } = fixture();
  try {
    writeFileSync(path, readFileSync(path, 'utf8')
      .replace('entry_node: approve-budget', 'entry_node: inspect')
      .replace('  - { node_id: approve-budget,', "  - { node_id: inspect, kind: capability, recipe: 'cap:store', max_visits: 1 }\n  - { node_id: approve-budget,")
      .replace('edges:\n', 'edges:\n  - { from: inspect, on: outcome, map: { ok: approve-budget, fail: failed } }\n'));
    const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
    manifest.extensions['ai.elanous'].capabilities = ['store'];
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
    const state = await runGraph(path, { input: { request: { budgetKrw: 1234 } }, dryRun: true, // Source: #36491
      deps: { root }, quiet: true });
    expect(state.path).toContain('inspect');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('declared command consumer verifies the durable approval before dispatch', async () => {
  const { dir, path, root } = fixture();
  try {
    writeFileSync(path, readFileSync(path, 'utf8')
      .replace('  - { node_id: done,', "  - { node_id: consume, kind: gate, recipe: 'cmd:consume', max_visits: 1, input: { approvedInput: { nodeId: approve-budget, inputPath: request, maxAgeMs: 60000 } } }\n  - { node_id: done,") // Source: #36491
      .replace('approved: done, rejected: failed', 'approved: consume, rejected: failed')
      .replace('edges:\n', 'edges:\n  - { from: consume, on: outcome, map: { ok: done, fail: failed } }\n'));
    writeFileSync(join(dir, 'recipes.yaml'), 'consume:\n  command: "printf consumed"\n');
    const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
    manifest.extensions['ai.elanous'].graphManifests['hitl-seam'].allow.recipes = ['cmd:consume'];
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
    let dispatches = 0;
    const deps = { root, runBash: async () => { dispatches++; return { exitCode: 0, stdout: 'consumed', stderr: '' }; } };
    const pending = await runGraph(path, { input: { request: { budgetKrw: 1234 } }, deps, quiet: true }); // Source: #36491
    expect(dispatches).toBe(0);
    decideGraphApproval(pending.graphId, pending.runId, 'approved', 'OP', root);
    const resumed = await runGraph(path, { resumeRunId: pending.runId, deps, quiet: true });
    expect(resumed.status).toBe('done');
    expect(dispatches).toBe(1);
    const state = JSON.parse(readFileSync(resumed.statePath, 'utf8'));
    state.input.request.budgetKrw = 9999; // Source: #36491
    writeFileSync(resumed.statePath, JSON.stringify(state));
    expect(hasApprovedGraphNodeInput({ graphId: pending.graphId, runId: pending.runId, nodeId: 'approve-budget',
      inputPath: 'request', inputSha256: createHash('sha256').update(JSON.stringify(state.input.request)).digest('hex'),
      maxAgeMs: 60000, root })).toBe(false); // Source: #36491
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a forged run JSON without the durable decision claim cannot authorize input', async () => {
  const { dir, path, root } = fixture();
  try {
    const input = { request: { budgetKrw: 1234 } }; // Source: #36491
    const first = await runGraph(path, { runId: 'forged', input, deps: { root }, quiet: true });
    const state = JSON.parse(readFileSync(first.statePath, 'utf8')) as Record<string, unknown>;
    const at = new Date().toISOString();
    state.nodes = [{ nodeId: 'approve-budget', ok: true, decidedAt: at,
      output: JSON.stringify({ outcome: 'approved', graphId: first.graphId, runId: first.runId, nodeId: 'approve-budget', decidedAt: at }) }];
    writeFileSync(first.statePath, JSON.stringify(state));
    expect(hasApprovedGraphNodeInput({ graphId: first.graphId, runId: first.runId, nodeId: 'approve-budget',
      inputPath: 'request', inputSha256: createHash('sha256').update(JSON.stringify(input.request)).digest('hex'),
      maxAgeMs: 60_000, root })).toBe(false); // Source: #36491
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('release command guard accepts one manifest-declared hitl:* binding without a static node entry', async () => {
  const { dir, path, root } = fixture('release-loop');
  try {
    const first = await runGraph(path, { runId: 'release-generic-hitl',
      input: { version: '9.9.9', previousVersion: '9.9.8', request: { budgetKrw: 1234 } }, deps: { root }, quiet: true }); // Source: #36491
    expect(first.status).toBe('awaiting-approval');
    expect(first.pending?.nodeId).toBe('approve-budget');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a rejected decision never authorizes a plugin input', async () => {
  const { dir, path, root } = fixture();
  try {
    const input = { request: { budgetKrw: 1234 } }; // Source: #36491
    const first = await runGraph(path, { runId: 'rejected', input, deps: { root }, quiet: true });
    decideGraphApproval(first.graphId, first.runId, 'rejected', 'OP', root);
    const resumed = await runGraph(path, { resumeRunId: first.runId, deps: { root }, quiet: true });
    expect(resumed.status).toBe('failed');
    expect(resumed.path).toEqual(['approve-budget', 'failed']);
    expect(hasApprovedGraphNodeInput({ graphId: first.graphId, runId: first.runId, nodeId: 'approve-budget',
      inputPath: 'request', inputSha256: createHash('sha256').update(JSON.stringify(input.request)).digest('hex'),
      maxAgeMs: 60_000, root })).toBe(false); // Source: #36491
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
