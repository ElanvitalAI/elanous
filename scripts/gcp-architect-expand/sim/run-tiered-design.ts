/** Run the GCP graph through a fake provider and render all three shared architecture bundles. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration } from '../../../src/graph-runner/capabilities.js';
import { runArchitectureDeliverables } from '../../../src/graph-runner/architecture-deliverables.js';
import { decideGraphApproval, runGraph } from '../../../src/graph-runner/runner.js';
import { buildTieredDesigns, type TieredPlan } from '../../../src/ux-sim/gcp-architect-expand/tiered-design.js';

const repo = resolve(import.meta.dir, '../../..');
const plugin = join(repo, 'plugins/gcp-architect-expand');
const architecturePlugin = join(repo, 'plugins/architecture-deliverables');
const requirementPath = resolve(process.argv[2] ?? join(plugin, 'demo/fixtures/advanced-requirement.json'));
const outRoot = resolve(process.argv[3] ?? join(repo, '.elanous-test/gcp-advanced-tiered-design'));
const requirement = JSON.parse(readFileSync(requirementPath, 'utf8')) as unknown;
const proposal = buildTieredDesigns(requirement);
const checksum = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const contracts = ['cloud-resource.observe@1', 'cloud-resource.design@1', 'cloud-resource.architecture-deliverables@1'] as const;
let registry = emptyGraphCapabilityRegistry();
for (const id of contracts) registry = registerGraphCapabilityContract(registry, { id, input: { type: 'object' }, output: { type: 'object' } });
const called: string[] = [];
registry = registerGraphCapabilityProviderDeclaration(registry, {
  id: 'gcp-tiered-fake-world', provides: contracts, tier: 'free',
  invoke: async ({ nodeId, input, graphInput, outputs }) => {
    called.push(nodeId);
    const withInput = input as { action?: unknown; input?: unknown };
    if (nodeId === 'detect') return { ok: true, outcome: 'shortage', result: { source: 'synthetic-requirement' } };
    if (nodeId === 'design') {
      if (withInput.action !== 'propose-tiered' || (graphInput as { requirementPath?: unknown })?.requirementPath !== requirementPath)
        return { ok: false, outcome: 'failed', error: 'tiered design input mismatch' };
      return { ok: true, outcome: 'proposed', result: proposal };
    }
    if (nodeId === 'deliverables') {
      const previous = outputs.design as { result?: { plans?: unknown } } | undefined;
      const linkedPlans = previous?.result?.plans;
      if (withInput.action !== 'run-tiered-architecture-deliverables'
        || !Array.isArray(withInput.input) || JSON.stringify(withInput.input) !== JSON.stringify(proposal.plans)
        || !Array.isArray(linkedPlans) || JSON.stringify(linkedPlans) !== JSON.stringify(proposal.plans))
        return { ok: false, outcome: 'failed', error: 'tiered plans were not wired from design' };
      const artifacts = [];
      for (const plan of linkedPlans as TieredPlan[]) {
        const designPath = join(outRoot, 'inputs', `${plan.tier}.json`);
        const outDir = join(outRoot, 'artifacts', plan.tier);
        mkdirSync(join(outRoot, 'inputs'), { recursive: true });
        writeFileSync(designPath, `${JSON.stringify(plan.design, null, 2)}\n`);
        try {
          const result = await runArchitectureDeliverables({ pluginRoot: architecturePlugin, structuredDesignPath: designPath,
            outDir, resourceRoot: repo, stateRoot: join(outRoot, 'state', plan.tier) });
          const files = ['architecture.excalidraw', 'architecture.png', 'architecture.html', 'architecture.pdf', 'verification.json'];
          if (result.receipt.status !== 'verified' || files.some(name => !existsSync(join(outDir, name))))
            throw new Error(`${plan.tier} output verification incomplete`);
          artifacts.push({ tier: plan.tier, monthlySimUsd: plan.monthlySimUsd, costStatus: plan.costStatus,
            outDir, files: files.map(name => ({ name, sha256: checksum(join(outDir, name)) })),
            graphId: result.graphId, runId: result.runId, receipt: result.receipt });
        } catch (error) {
          return { ok: false, outcome: 'failed', error: `${plan.tier}: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      return { ok: true, outcome: 'done', result: { artifacts, realGcpCalls: 0 } }; // Source: provider invokes only the local shared renderer.
    }
    return { ok: false, outcome: 'failed', error: 'fake provider refuses spending nodes' };
  },
});
const state = await runGraph(join(plugin, 'tiered-graph.yaml'), { input: { requirementPath }, quiet: true,
  deps: { root: join(outRoot, 'graph-state'), capabilityProviders: registry } });
if (state.status !== 'awaiting-approval' || state.pending?.nodeId !== 'approve'
  || called.join(',') !== 'detect,design,deliverables') throw new Error(`tiered graph stopped unexpectedly: ${state.status}/${called.join(',')}`);
const outputText = state.nodes.find(node => node.nodeId === 'deliverables')?.output;
if (typeof outputText !== 'string') throw new Error('tiered graph deliverables output missing');
const output = JSON.parse(outputText) as { result?: { artifacts?: Array<{ tier: string }> } };
const artifacts = output.result?.artifacts ?? [];
const expectedTiers = ['small', 'medium', 'large'];
if (artifacts.length !== expectedTiers.length || artifacts.some((item, index) => item.tier !== expectedTiers[index]))
  throw new Error('tiered graph did not produce exactly three ordered bundles');
decideGraphApproval(state.graphId, state.runId, 'approved', 'sim-reviewer', join(outRoot, 'graph-state'));
const resumed = await runGraph(join(plugin, 'tiered-graph.yaml'), { resumeRunId: state.runId, resumeGraphId: state.graphId,
  quiet: true, deps: { root: join(outRoot, 'graph-state'), capabilityProviders: registry } });
if (resumed.status !== 'done' || called.join(',') !== 'detect,design,deliverables'
  || resumed.nodes.some(node => ['provision', 'schedule', 'idle-stop'].includes(node.nodeId)))
  throw new Error(`tiered approval resumed outside the design-only boundary: ${resumed.status}/${called.join(',')}`);
const receipt = { requirementPath, requirementSha256: checksum(requirementPath), requirementHash: proposal.requirementHash,
  graphId: state.graphId, runId: state.runId, status: state.status, pendingNode: state.pending.nodeId,
  executedNodes: called, approvedResumeStatus: resumed.status, approvedResumeNodes: resumed.nodes.map(node => node.nodeId),
  spendingNodesExecuted: false, realGcpCalls: 0,
  plans: proposal.plans.map((plan: TieredPlan) => ({ tier: plan.tier, id: plan.id, services: plan.services,
    monthlySimUsd: plan.monthlySimUsd, costStatus: plan.costStatus,
    costRows: plan.design.costs, costInputs: plan.design.simulation })), artifacts }; // Source: fake provider has no GCP connector.
mkdirSync(outRoot, { recursive: true });
writeFileSync(join(outRoot, 'tiered-design-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ status: receipt.status, tiers: expectedTiers, realGcpCalls: 0,
  receipt: join(outRoot, 'tiered-design-receipt.json') })); // Source: fake provider has no GCP connector.
