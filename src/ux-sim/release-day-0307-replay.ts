import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadReleaseGraphManifest, assertReleaseRecipeAllowed } from '../graph-runner/release-graph-manifest.js';
import { runReleaseSimRigScenario, type ReleaseSimRigResult } from './release-sim-rig.js';

const REPO_ROOT = join(import.meta.dir, '../..');
const SCENARIO_PATH = join(REPO_ROOT, 'scenarios/ux-sim/release-day-0307-replay.yaml');
const MANIFEST_PATH = join(REPO_ROOT, 'graphs/release/plugin.json');
const GRAPH_PATH = join(REPO_ROOT, 'graphs/release/release-loop.yaml');
const RECIPES_PATH = join(REPO_ROOT, 'graphs/release/recipes.yaml');
const EXPECTED_IDS = Array.from({ length: 15 }, (_, index) => `A${index + 1}`);

export interface ReleaseDay0307ReplayEvent {
  readonly id: string;
  readonly type: string;
  readonly action: string;
  readonly binding: string;
  readonly mechanism: 'recipe' | 'domain-pack' | 'edge' | 'hitl';
  readonly rationale: string;
  readonly runId?: string;
  readonly recipe?: string;
  readonly introduced?: string[];
  readonly pickShas?: string[];
  readonly changedFiles?: string[];
  readonly receiptCosts?: { readonly partialMs: number; readonly fullMs: number; readonly source: 'simulation-same-ledger' };
  readonly [key: string]: unknown;
}

export interface ReleaseDay0307ReplayResult {
  readonly pass: boolean;
  readonly runId: string;
  readonly events: readonly ReleaseDay0307ReplayEvent[];
  readonly eventTrace: readonly { readonly event: 'release.day.0307.intervention'; readonly observer: 'RLA'; readonly runId: string;
    readonly sequence: number; readonly id: string; readonly action: string; readonly rationale: string; readonly mechanism: string }[];
  readonly graphRun: ReleaseSimRigResult;
  readonly graphPath: readonly string[];
  readonly hitlPath: readonly string[];
  readonly contractFailures: readonly string[];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/** Replay the publication-day event ledger against the checked-in release graph and its real runner. */
export async function runReleaseDay0307Replay(): Promise<ReleaseDay0307ReplayResult> {
  const scenario = asRecord(parseYaml(readFileSync(SCENARIO_PATH, 'utf8')), 'release-day scenario');
  const events = scenario.events as ReleaseDay0307ReplayEvent[];
  if (!Array.isArray(events)) throw new Error('release-day scenario requires events');
  const manifest = loadReleaseGraphManifest(MANIFEST_PATH);
  const graph = asRecord(parseYaml(readFileSync(GRAPH_PATH, 'utf8')), 'release graph');
  const recipes = asRecord(parseYaml(readFileSync(RECIPES_PATH, 'utf8')), 'release recipes');
  const graphNodes = (graph.nodes as Array<Record<string, unknown>>).map((node) => String(node.node_id));
  const graphEdges = graph.edges as Array<Record<string, unknown>>;
  const runId = String(scenario.runId);
  const contractFailures: string[] = [];
  if (scenario.scenario !== 'release-day-0307-replay' || scenario.version !== '0.3.7') contractFailures.push('scenario identity/version mismatch');
  if (events.length !== EXPECTED_IDS.length || events.some((event, index) => event.id !== EXPECTED_IDS[index])) {
    contractFailures.push('the incident sequence must contain A1-A15 exactly once and in order');
  }
  for (const event of events) {
    if (!event.type || !event.action || !event.rationale || !event.binding) contractFailures.push(`${event.id} lacks typed action, binding, or rationale`);
    if (event.runId !== undefined && event.runId !== runId) contractFailures.push(`${event.id} changes the release runId`);
    if (event.mechanism === 'recipe') {
      if (!event.recipe || !Object.hasOwn(recipes, event.recipe)) contractFailures.push(`${event.id} references an undeclared recipe`);
      else {
        try { assertReleaseRecipeAllowed(manifest, event.recipe); }
        catch { contractFailures.push(`${event.id} recipe is outside the release manifest`); }
      }
    } else if (event.mechanism === 'domain-pack' && !manifest.domainPackRules.includes(event.binding)) {
      contractFailures.push(`${event.id} references an undeclared domain-pack rule`);
    } else if (event.mechanism === 'edge' && !manifest.edgeVocabulary.includes(event.binding)) {
      contractFailures.push(`${event.id} references an undeclared graph edge kind`);
    } else if (event.mechanism === 'hitl' && (!manifest.hitlNodes.includes(event.binding) || event.binding !== 'approve-publish')) {
      contractFailures.push(`${event.id} is not the declared publication approval boundary`);
    }
  }
  const gateNode = (graph.nodes as Array<Record<string, unknown>>).find((node) => node.node_id === 'gate');
  const gateNeeds = Array.isArray(gateNode?.needs) ? gateNode.needs : [];
  if (gateNeeds.includes('export-check')) contractFailures.push('gate must remain independent of export-check');
  const gateToReceiptAudit = graphEdges.some((edge) => edge.from === 'gate' && asRecord(edge.map, 'gate edge map').ok === 'receipt-audit');
  if (!gateToReceiptAudit) contractFailures.push('the real graph must route a successful gate into receipt audit');
  const independentExportCheck = events.find((event) => event.id === 'A7');
  if (!independentExportCheck || independentExportCheck.from !== 'gate' || independentExportCheck.to !== 'receipt-audit') {
    contractFailures.push('A7 must bind the real gate-to-receipt-audit edge independently of export-check');
  }

  const graphScenario = `version: 1\nkind: release-graph\nid: release-day-0307-replay\nisolation: test\ninput:\n  version: '0.3.7'\n  previousVersion: '0.3.6'\ncases:\n  - id: replay\n    mode: baseline\n    nodeOutcomes:\n      auto-approve: { outcome: fail }\n    expect:\n      status: awaiting-approval\n      mustVisit: [version-release, traffic-cut-start, cutoff, gate, auto-approve, approve-publish]\n      mustNotVisit: [approve-continue, npm-publish, done]\n`;
  const graphRun = await runReleaseSimRigScenario(graphScenario);
  const graphCase = graphRun.cases.find((item) => item.id === 'replay');
  const graphPath = graphCase?.path ?? [];
  const hitlPath = graphPath.filter((nodeId) => manifest.hitlNodes.includes(nodeId));
  const eventTrace = events.map((event, index) => ({ event: 'release.day.0307.intervention' as const, observer: 'RLA' as const,
    runId, sequence: index + 1, id: event.id, action: event.action, rationale: event.rationale, mechanism: event.mechanism }));
  if (graphNodes.length === 0 || !graphCase || graphCase.status !== 'awaiting-approval' || !graphCase.dispatchedNodes.includes('export-check')) {
    contractFailures.push('the actual release-loop runner did not reach the pre-publish graph and export branch');
  }
  if (hitlPath.length !== 1 || hitlPath[0] !== 'approve-publish') contractFailures.push('the replay must stop at approve-publish as its only HITL visit');
  return { pass: graphRun.pass && contractFailures.length === 0, runId, events, eventTrace, graphRun, graphPath, hitlPath, contractFailures };
}
