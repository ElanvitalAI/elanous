/** Isolated Scene 5 capability provider. It never loads credentials or calls GCP. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration, type GraphCapabilityRegistry,
  type GraphContractId } from '../../graph-runner/capabilities.js';
import { activeResourceLeases, beginResourceLease, endResourceLease,
  readResourceLedger } from '../../resource-ledger/resource-ledger.js';

type Attachment = { kind: 'diagram' | 'diagram-source' | 'pdf' | 'html'; title: string;
  url: string; mime: string; sha256: string; producedBy: string };
type Proposal = { id: string; inputSha256: string; region: string; architecture: string;
  shortageAxes: string[]; signalSource: string; estimate: { formula: string; skuSource: string; price: 'unpriced' };
  savings: string[]; security: { grade: string; controls: string[] }; idleTtlMs: number; realGcpCalls: 0 };
type FakeProject = { id: string; state: 'created' | 'running' | 'stopped'; provider: 'fake-gcp' };
type CostEvent = { event: string; amount: 'unpriced'; at: string; proposalId: string };
type FakeRunState = { graphId: string; runId: string; proposalId: string; estimate: Proposal['estimate'];
  events: CostEvent[]; project?: FakeProject; scheduledAt?: number; leaseId?: string;
  realGcpCalls: 0; resourceLedgerPath: string };

export interface GcpScene5FakeWorld {
  proposal: Proposal;
  pressure: unknown;
  outDir: string;
  stateRoot: string;
  approvalNodeId?: string;
  deliverables: () => Promise<{ attachments: Attachment[]; receipt: { status?: string; immutableDirectory?: string } }>;
  onInvoke?: (nodeId: string) => void;
}

const contracts = [
  'cloud-resource.observe@1', 'cloud-resource.design@1', 'cloud-resource.architecture-deliverables@1',
  'cloud-resource.provision@1', 'cloud-resource.schedule@1', 'cloud-resource.idle-stop@1',
] as const satisfies readonly GraphContractId[];

/** Reuse this registry in an absorb-build test universe after its graph declares the GCP nodes. */
export function registerGcpScene5FakeProvider(world: GcpScene5FakeWorld,
  base: GraphCapabilityRegistry = emptyGraphCapabilityRegistry()): GraphCapabilityRegistry {
  if (!isAbsolute(world.outDir) || !isAbsolute(world.stateRoot))
    throw new Error('Scene 5 output and graph state directories must be absolute');
  const proposal = world.proposal;
  if (!proposal.id || !proposal.inputSha256 || !proposal.region || !proposal.architecture
    || !proposal.shortageAxes?.length || !Number.isFinite(proposal.idleTtlMs) || proposal.idleTtlMs <= 0
    || proposal.estimate?.price !== 'unpriced'
    || !proposal.estimate.formula || !proposal.estimate.skuSource || proposal.realGcpCalls !== 0)
    throw new Error('invalid fake GCP proposal');
  let registry = base;
  for (const id of contracts) {
    if (!registry.contracts[id]) registry = registerGraphCapabilityContract(registry, { id, input: { type: 'object' }, output: { type: 'object' } });
  }
  const runDir = (graphId: string, runId: string) => {
    if (!/^[a-z][a-z0-9-]*$/u.test(graphId) || !/^[a-f0-9-]{36}$/u.test(runId))
      throw new Error('invalid fake GCP graph/run identity');
    return join(world.outDir, 'fake-gcp-runs', graphId, runId);
  };
  const costPath = (graphId: string, runId: string) => join(runDir(graphId, runId), 'cost-ledger.json');
  const readRun = (graphId: string, runId: string): FakeRunState => {
    const path = costPath(graphId, runId);
    if (!existsSync(path)) return { graphId, runId, proposalId: proposal.id, estimate: proposal.estimate,
      events: [], realGcpCalls: 0, resourceLedgerPath: join(runDir(graphId, runId), 'resource-events.jsonl') };
    const state = JSON.parse(readFileSync(path, 'utf8')) as FakeRunState;
    if (state.graphId !== graphId || state.runId !== runId || state.proposalId !== proposal.id
      || state.realGcpCalls !== 0 || !Array.isArray(state.events)
      || state.resourceLedgerPath !== join(runDir(graphId, runId), 'resource-events.jsonl'))
      throw new Error('fake GCP run ledger identity mismatch');
    return state;
  };
  const persist = (state: FakeRunState) => {
    const path = costPath(state.graphId, state.runId);
    mkdirSync(runDir(state.graphId, state.runId), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2) + '\n');
    renameSync(`${path}.tmp`, path);
  };
  const addEvent = (state: FakeRunState, name: string, at = Date.now()) => {
    if (!state.events.some(item => item.event === name))
      state.events.push({ event: name, amount: 'unpriced', at: new Date(at).toISOString(), proposalId: proposal.id });
    persist(state);
  };
  const inputMatchesProposal = (value: unknown): boolean => {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const path = input.ticketDesignPath;
    if (typeof path !== 'string' || !isAbsolute(path)) return false;
    try { return createHash('sha256').update(readFileSync(path)).digest('hex') === proposal.inputSha256; }
    catch { return false; }
  };
  const attachmentFile = (item: Attachment, immutableDirectory?: string): string | null => {
    const expected = { 'diagram-source': 'architecture.excalidraw', diagram: 'architecture.png',
      pdf: 'architecture.pdf', html: 'architecture.html' }[item.kind];
    if (isAbsolute(item.url)) return basename(item.url) === expected
      && (!immutableDirectory || item.url.includes(`/${immutableDirectory}/`)) ? item.url : null;
    let url: URL;
    try { url = new URL(item.url); } catch { return null; }
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const name = basename(url.pathname);
    if (name !== expected) return null;
    if (immutableDirectory) {
      if (!/^\.architecture-bundles\/\.architecture-stage-[\w-]+$/u.test(immutableDirectory)
        || !url.pathname.endsWith(`/${immutableDirectory}/${name}`)) return null;
      return join(world.outDir, immutableDirectory, name);
    }
    return join(world.outDir, name);
  };
  const approvedInGraphLedger = (graphId: string, runId: string): boolean => {
    const path = join(world.stateRoot, 'graph-runs', graphId, `${runId}.json`);
    let state: { graphId?: string; runId?: string; nodes?: Array<{ nodeId?: string; ok?: boolean; output?: string }> };
    try { state = JSON.parse(readFileSync(path, 'utf8')); } catch { return false; }
    if (state.graphId !== graphId || state.runId !== runId || !Array.isArray(state.nodes)) return false;
    return state.nodes.some(node => {
      if (node.nodeId !== (world.approvalNodeId ?? 'approve') || node.ok !== true || typeof node.output !== 'string') return false;
      try {
        const output = JSON.parse(node.output);
        return output.outcome === 'approved' && output.choice === 'y'
          && output.graphId === graphId && output.runId === runId && output.nodeId === node.nodeId;
      } catch { return false; }
    });
  };
  return registerGraphCapabilityProviderDeclaration(registry, {
    id: 'gcp-scene5-fake-world', provides: contracts, tier: 'free', invoke: async ({ requires, graphId, runId, nodeId, input, graphInput }) => {
      world.onInvoke?.(nodeId);
      switch (requires) {
        case 'cloud-resource.observe@1':
          return { ok: true, outcome: 'shortage', result: { signal: world.pressure,
            shortageAxes: proposal.shortageAxes, source: proposal.signalSource } };
        case 'cloud-resource.design@1':
          if (!inputMatchesProposal(graphInput ?? input))
            return { ok: false, outcome: 'failed', error: 'Scene 4 design input SHA does not match GCP proposal' };
          return { ok: true, outcome: 'proposed', result: { proposalId: proposal.id,
            architectureSpec: proposal, estimate: proposal.estimate, savings: proposal.savings,
            security: proposal.security } };
        case 'cloud-resource.architecture-deliverables@1': {
          const output = await world.deliverables();
          const required = ['diagram', 'diagram-source', 'pdf', 'html'];
          if (output.receipt.status !== 'verified'
            || required.some(kind => !output.attachments.some(item => item.kind === kind))
            || output.attachments.some(item => !attachmentFile(item, output.receipt.immutableDirectory)
              || item.producedBy !== (item.kind === 'pdf' || item.kind === 'html' ? 'pdf' : 'diagram')
              || createHash('sha256').update(readFileSync(attachmentFile(item, output.receipt.immutableDirectory)!)).digest('hex') !== item.sha256))
            return { ok: false, outcome: 'failed', error: 'unverified architecture attachment' };
          return { ok: true, outcome: 'done', result: output };
        }
        case 'cloud-resource.provision@1':
          if (!approvedInGraphLedger(graphId, runId)) return { ok: false, outcome: 'failed', error: 'user approval required' };
          if (!inputMatchesProposal(graphInput ?? input))
            return { ok: false, outcome: 'failed', error: 'Scene 4 design input changed after approval' };
          {
          const state = readRun(graphId, runId);
          if (state.project) return { ok: true, outcome: 'done', result: { project: state.project } };
          mkdirSync(runDir(graphId, runId), { recursive: true });
          const leaseFp = `fp_${createHash('sha256').update(`${proposal.id}:${graphId}:${runId}`).digest('hex').slice(0, 12)}`;
          if (!activeResourceLeases(readResourceLedger(state.resourceLedgerPath)).some(item => item.id === leaseFp))
            beginResourceLease({ fp: leaseFp,
            host: `fakegcp.${proposal.region}`, lane: 'unknown',
            resources: { cpu: 2, memoryBytes: 2 * 1024 ** 3 }, mission: { cell: proposal.id },
            ttlMs: proposal.idleTtlMs, now: new Date() }, state.resourceLedgerPath);
          state.leaseId = leaseFp;
          state.project = { id: `fake-${proposal.id}-${runId}`, state: 'created', provider: 'fake-gcp' };
          addEvent(state, 'project-created');
          return { ok: true, outcome: 'done', result: { project: state.project } };
          }
        case 'cloud-resource.schedule@1':
          {
          const state = readRun(graphId, runId);
          if (!state.project) return { ok: false, outcome: 'failed', error: 'fake project missing' };
          if (state.project.state === 'created') {
            state.scheduledAt = Date.now(); state.project.state = 'running'; addEvent(state, 'work-scheduled', state.scheduledAt);
          }
          if (!state.events.some(item => item.event === 'work-scheduled'))
            return { ok: false, outcome: 'failed', error: 'fake work schedule missing' };
          return { ok: true, outcome: 'done', result: { project: state.project } };
          }
        case 'cloud-resource.idle-stop@1':
          {
          const state = readRun(graphId, runId);
          if (!state.project || state.scheduledAt === undefined || !state.leaseId
            || !['running', 'stopped'].includes(state.project.state))
            return { ok: false, outcome: 'failed', error: 'fake project not running' };
          // Virtual clock: the fake job is idle for the declared TTL; no real wait or cloud call.
          if (activeResourceLeases(readResourceLedger(state.resourceLedgerPath)).some(item => item.id === state.leaseId))
            endResourceLease(state.leaseId, 'fake idle TTL', 'gcp-scene5-fake-world',
              new Date(state.scheduledAt + proposal.idleTtlMs), state.resourceLedgerPath);
          state.project.state = 'stopped'; addEvent(state, 'idle-stopped', state.scheduledAt + proposal.idleTtlMs);
          return { ok: true, outcome: 'stopped', result: { project: state.project, costLedger: state.events,
            activeLeases: activeResourceLeases(readResourceLedger(state.resourceLedgerPath)).length } };
          }
        default:
          return { ok: false, outcome: 'failed', error: 'undeclared fake GCP action' };
      }
    },
  });
}
