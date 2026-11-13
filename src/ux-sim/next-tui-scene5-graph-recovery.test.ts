import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { decideGraphApproval, runGraph } from '../graph-runner/runner.js';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration, type GraphContractId } from '../graph-runner/capabilities.js';

type Attempt = { provider: string; graphId: string; runId: string; nodeId: string; outcome: string };
const graphPath = resolve(import.meta.dir, '../../plugins/gcp-architect-expand/graph.yaml');
const declaration = parse(readFileSync(graphPath, 'utf8')) as {
  graph: { id: string }; nodes: Array<{ id: string; requires?: GraphContractId }>;
};

async function scenario(recovery: boolean, choice: 'y' | 'N') {
  const kept = process.env.ELANOUS_SCENE5_NEXT_OUT?.trim();
  if (kept) mkdirSync(kept, { recursive: true });
  const root = mkdtempSync(join(kept ?? tmpdir(), `scene5-graph-recovery-${choice}-`));
  const attempts: Attempt[] = [];
  let registry = emptyGraphCapabilityRegistry();
  const contracts = declaration.nodes.flatMap(node => node.requires ? [node.requires] : []);
  for (const id of contracts) registry = registerGraphCapabilityContract(registry, {
    id, input: { type: 'object' }, output: { type: 'object' },
  });
  registry = registerGraphCapabilityProviderDeclaration(registry, {
    id: 'scene5-injected-failure', tier: 'free', provides: ['cloud-resource.observe@1'],
    invoke: ({ graphId, runId, nodeId }) => {
      attempts.push({ provider: 'injected-failure', graphId, runId, nodeId, outcome: 'failed' });
      return { ok: false, outcome: 'failed', error: 'injected observation provider failure' };
    },
  });
  registry = registerGraphCapabilityProviderDeclaration(registry, {
    id: 'scene5-isolated-recovery', tier: 'byok',
    provides: recovery ? contracts : contracts.filter(id => id !== 'cloud-resource.observe@1'),
    invoke: ({ requires, graphId, runId, nodeId }) => {
      const outcome = requires === 'cloud-resource.observe@1' ? 'shortage'
        : requires === 'cloud-resource.design@1' ? 'proposed'
        : requires === 'cloud-resource.idle-stop@1' ? 'stopped' : 'done';
      attempts.push({ provider: 'isolated-recovery', graphId, runId, nodeId, outcome });
      return { ok: true, outcome, result: { simulated: true, realGcpCalls: 0,
        // The declared deliverables input binds $design.result.architectureSpec.
        ...(requires === 'cloud-resource.design@1'
          ? { architectureSpec: { service: 'scene5-recovery', realGcpCalls: 0 } } : {}) } };
    },
  });
  try {
    const deps = { root, capabilityProviders: registry, log: () => {} };
    const pending = await runGraph(graphPath, { quiet: true, routeGraphEvents: false, deps });
    const beforeDecision = [...attempts];
    if (recovery) {
      expect(pending.status).toBe('awaiting-approval');
      expect(pending.pending?.nodeId).toBe('approve');
      expect(beforeDecision.map(attempt => [attempt.nodeId, attempt.outcome])).toEqual([
        ['detect', 'failed'], ['detect', 'shortage'], ['design', 'proposed'], ['deliverables', 'done'],
      ]);
      expect(new Set(beforeDecision.map(attempt => attempt.runId))).toEqual(new Set([pending.runId]));
      decideGraphApproval(pending.graphId, pending.runId, choice === 'y' ? 'approved' : 'rejected', 'scene5-test-member', root);
      const final = await runGraph(graphPath, { quiet: true, routeGraphEvents: false,
        resumeGraphId: pending.graphId, resumeRunId: pending.runId, deps });
      expect(final.status).toBe(choice === 'y' ? 'done' : 'failed');
      expect(final.runId).toBe(pending.runId);
      expect(attempts.slice(beforeDecision.length).map(attempt => attempt.nodeId))
        .toEqual(choice === 'y' ? ['provision', 'schedule', 'idle-stop'] : []);
      if (kept) writeFileSync(join(root, 'receipt.json'), JSON.stringify({
        grade: 'actual declared graph and capability dispatcher; isolated fake providers; no TUI interaction',
        failureKind: 'provider-attempt failure recovered inside one graph node; not a persisted failed-node restart',
        graphPath, beforeDecision, attempts, pending, final, realGcpCalls: 0,
      }, null, 2) + '\n');
    } else {
      expect(pending.status).toBe('failed');
      expect(pending.pending).toBeUndefined();
      expect(attempts.map(attempt => [attempt.nodeId, attempt.outcome])).toEqual([['detect', 'failed']]);
      if (kept) writeFileSync(join(root, 'receipt.json'), JSON.stringify({
        grade: 'recovery-disabled negative control', graphPath, attempts, final: pending, realGcpCalls: 0,
      }, null, 2) + '\n');
    }
  } finally {
    if (!kept) rmSync(root, { recursive: true, force: true });
  }
}

test.each(['y', 'N'] as const)('Scene 5 automatically recovers a provider failure before the real %s HITL decision', async choice => {
  await scenario(true, choice);
});

test('Scene 5 cannot reach approval when the recovery provider is unavailable', async () => {
  await scenario(false, 'N');
});
