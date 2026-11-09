import { createHash } from 'node:crypto';
import { runMacrophageHeal, type MacrophageScrap } from '../release-loop/macrophage-heal.js';
import { planMacrophageIncident, type MacrophageIncidentSignal } from '../release-loop/macrophage-incident-recovery.js';
import { planMacrophageRepairLadder, type MacrophageRepairLadderInput } from '../release-loop/macrophage-repair-ladder.js';
import type { GraphSubgraphAppendProposal } from '../graph-runner/graph-subscriptions.js';
import type { GraphEdgeSpec, GraphNodeSpec } from '../self-implement/graph-yaml.js';

/** In-memory release canvas. Recipes are recorded, never run by this simulator. */
export interface ArgMacroCanvasManifest {
  readonly graphId: string;
  readonly edgeRef: string;
  readonly appendAfter: readonly string[];
  readonly appendRecipes: readonly string[];
  readonly allowRecipes: readonly string[];
  readonly maxDepth: number;
  readonly allowance: number;
  readonly hitlNode: string;
  readonly rejoinNode: string;
}

export interface ArgMacroCanvasIncident {
  readonly scrap: MacrophageScrap;
  readonly signal: MacrophageIncidentSignal;
  readonly ladder: Omit<MacrophageRepairLadderInput, 'runId' | 'signature'>;
  readonly afterNodeId: string;
  readonly recipe: string;
  readonly depth?: number;
  /** A fake recipe verdict; the simulator never invokes a process or writes a repository file. */
  readonly recipeOutcome: 'passed' | 'failed';
}

export interface ArgMacroCanvasLedgerRow {
  readonly graphId: string;
  readonly runId: string;
  readonly incidentId: string;
  readonly eventId: string;
  readonly edgeRef: string;
  readonly event: 'macrophage.classified' | 'graph.edge-added' | 'graph.recipe-simulated' | 'graph.rejoin' | 'graph.escalate' | 'graph.manifest-denied' | 'graph.policy-denied' | 'graph.policy-noop';
  readonly detail: string;
}

export interface ArgMacroCanvasResult {
  readonly graphId: string;
  readonly runId: string;
  readonly ledger: readonly ArgMacroCanvasLedgerRow[];
  readonly appended: readonly { incidentId: string; afterNodeId: string; proposal: GraphSubgraphAppendProposal }[];
  readonly graph: { readonly nodes: readonly GraphNodeSpec[]; readonly edges: readonly GraphEdgeSpec[] };
  /** Simulator prediction from injected recipeOutcome; inspect runGraph's state for executed outcomes. */
  readonly simulatedTerminal: Readonly<Record<string, 'healed' | 'hitl'>>;
}

function eventId(runId: string, incidentId: string): string {
  return createHash('sha256').update(`${runId}\0${incidentId}`).digest('hex').slice(0, 12);
}

/** Drives the production macrophage and R0–R4 policy contracts through one declared append canvas. */
export function runArgMacroCanvasSim(input: {
  readonly runId: string;
  readonly manifest: ArgMacroCanvasManifest;
  readonly incidents: readonly ArgMacroCanvasIncident[];
  readonly now?: Date;
}): ArgMacroCanvasResult {
  const { runId, manifest } = input;
  if (!runId.trim() || !manifest.graphId.trim() || !manifest.edgeRef.trim()
    || !manifest.hitlNode.trim() || !manifest.rejoinNode.trim()) throw new Error('canvas identity and exits are required');
  if (!Number.isSafeInteger(manifest.maxDepth) || manifest.maxDepth < 1 ||
    !Number.isSafeInteger(manifest.allowance) || manifest.allowance < 0) throw new Error('invalid adaptive allowance');
  const sourceNodes = new Set<string>();
  for (const incident of input.incidents) {
    if (sourceNodes.has(incident.afterNodeId)) {
      throw new Error(`ARG canvas incidents sharing ${incident.afterNodeId} require separate graph runs`);
    }
    sourceNodes.add(incident.afterNodeId);
  }
  const seen = new Set<string>();
  const ledger: ArgMacroCanvasLedgerRow[] = [];
  const appended: ArgMacroCanvasResult['appended'][number][] = [];
  const nodes: GraphNodeSpec[] = [];
  const edges: GraphEdgeSpec[] = [];
  const simulatedTerminal: Record<string, 'healed' | 'hitl'> = {};
  const record = (incidentId: string, event: ArgMacroCanvasLedgerRow['event'], detail: string): void => {
    ledger.push({ graphId: manifest.graphId, runId, incidentId, eventId: eventId(runId, incidentId),
      edgeRef: manifest.edgeRef, event, detail });
  };
  for (const item of input.incidents) {
    const id = item.signal.id;
    if (!id.trim() || seen.has(id) || item.scrap.id !== id) throw new Error(`duplicate or mismatched canvas incident: ${id}`);
    seen.add(id);
    const macrophage = runMacrophageHeal({ phase: 'idle', mode: 'simulation', now: input.now ?? new Date(0),
      consecutiveFailureLimit: 3, inventory: [item.scrap] });
    const action = macrophage.events.find((event) => event.id === id)?.action;
    if (!action) throw new Error(`macrophage did not classify ${id}`);
    const policy = planMacrophageIncident(item.signal);
    const ladder = planMacrophageRepairLadder({ ...item.ladder, runId, signature: item.signal.signature });
    record(id, 'macrophage.classified', `${action}:${policy.label}:${ladder.step}`);
    const ladderCanRun = ladder.action === 'repair-plan' || ladder.action === 'remeasure-same-slice';
    const policyCanRun = policy.label === 'fix'
      || (policy.label === 'noise' && policy.step === 'R0-remeasure' && ladder.action === 'remeasure-same-slice');
    if (action === 'retain' || !policyCanRun || !ladderCanRun) {
      if (policy.label === 'noise' && policy.step === 'none' && ladder.action === 'no-op') {
        edges.push({ from: item.afterNodeId, to: manifest.rejoinNode });
        record(id, 'graph.policy-noop', `${policy.label}:${policy.step}:${ladder.action}`);
        record(id, 'graph.edge-added', `${item.afterNodeId}->${manifest.rejoinNode}`);
        record(id, 'graph.rejoin', manifest.rejoinNode);
        simulatedTerminal[id] = 'healed';
      } else {
        edges.push({ from: item.afterNodeId, to: manifest.hitlNode });
        record(id, 'graph.policy-denied', `${policy.label}:${policy.step}:${ladder.step}:${ladder.action}:${action}`);
        record(id, 'graph.edge-added', `${item.afterNodeId}->${manifest.hitlNode}`);
        record(id, 'graph.escalate', manifest.hitlNode);
        simulatedTerminal[id] = 'hitl';
      }
      continue;
    }
    const depth = item.depth ?? 1;
    const allowed = manifest.appendAfter.includes(item.afterNodeId)
      && manifest.appendRecipes.includes(item.recipe) && manifest.allowRecipes.includes(item.recipe)
      && action !== 'retain' && Number.isSafeInteger(depth) && depth > 0 && depth <= manifest.maxDepth
      && appended.length < manifest.allowance;
    if (!allowed) {
      edges.push({ from: item.afterNodeId, to: manifest.hitlNode });
      record(id, 'graph.manifest-denied', `${item.afterNodeId}:${item.recipe}`);
      record(id, 'graph.edge-added', `${item.afterNodeId}->${manifest.hitlNode}`);
      record(id, 'graph.escalate', manifest.hitlNode);
      simulatedTerminal[id] = 'hitl';
      continue;
    }
    const nodeId = `arg-macro-${eventId(runId, id)}`;
    const heals = item.recipeOutcome === 'passed';
    const proposal: GraphSubgraphAppendProposal = {
      nodes: [{ nodeId, kind: 'agent', recipe: item.recipe, maxVisits: 1 }],
      edges: [{ from: nodeId, on: 'outcome', map: { ok: manifest.rejoinNode, fail: manifest.hitlNode, error: manifest.hitlNode } }],
      entryNodeId: nodeId, returnTo: manifest.rejoinNode, failureTo: manifest.hitlNode,
      reason: `${id}:${policy.label}:${ladder.step}`,
    };
    appended.push({ incidentId: id, afterNodeId: item.afterNodeId, proposal });
    nodes.push(...proposal.nodes);
    edges.push({ from: item.afterNodeId, to: proposal.entryNodeId }, ...proposal.edges);
    record(id, 'graph.edge-added', nodeId);
    record(id, 'graph.recipe-simulated', item.recipeOutcome);
    record(id, heals ? 'graph.rejoin' : 'graph.escalate', heals ? manifest.rejoinNode : manifest.hitlNode);
    simulatedTerminal[id] = heals ? 'healed' : 'hitl';
  }
  return { graphId: manifest.graphId, runId, ledger, appended, graph: { nodes, edges }, simulatedTerminal };
}
