import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getTestStateRoot } from '../nexus/paths.js';
import { listGraphRuns, runGraph, type GraphRunState } from '../graph-runner/runner.js';
import { resolveScenarioFilePath } from './scenario.js';

const REPOSITORY_ROOT = join(import.meta.dir, '../..');
const RELEASE_GRAPH = join(REPOSITORY_ROOT, 'graphs/release/release-loop.yaml');
const CUT_TIP = 'a'.repeat(40);

export interface ReleaseSimRigCase {
  id: string;
  mode?: 'baseline' | 'cut-tip-moved-after-resume';
  fault?: { node: string; outcome: 'fail' | 'error' | 'timeout'; evidence?: Record<string, unknown> };
  expect: { status: 'done' | 'failed' | 'resume-refused'; mustVisit: string[]; mustNotVisit: string[] };
}

export interface ReleaseSimRigScenario {
  version: 1;
  kind: 'release-graph';
  id: string;
  isolation: 'test';
  input: { version: string; previousVersion: string };
  cases: ReleaseSimRigCase[];
}

export interface ReleaseSimRigCaseResult {
  id: string;
  pass: boolean;
  status: string;
  path: string[];
  dispatchedNodes: string[];
  unexpectedEdges: Array<{ from: string; to: string; outcome: string; expectedTo?: string }>;
  checks: { status: boolean; mustVisit: boolean; mustNotVisit: boolean; ledgerEvents: boolean };
  injectedEvidence: Record<string, unknown>;
  ledgerEvents: Array<Record<string, unknown>>;
  statePath: string;
  refusal?: string;
}

function unexpectedEdges(path: string[], state: GraphRunState, edges: Map<string, Record<string, unknown>>): ReleaseSimRigCaseResult['unexpectedEdges'] {
  const nodes = new Map(state.nodes.map((node) => [node.nodeId, node]));
  const issues: ReleaseSimRigCaseResult['unexpectedEdges'] = [];
  for (let index = 0; index + 1 < path.length; index++) {
    const from = path[index]!;
    const to = path[index + 1]!;
    const edge = edges.get(from);
    const output = nodes.get(from)?.output;
    let parsed: Record<string, unknown> = {};
    if (typeof output === 'string') {
      try { parsed = record(JSON.parse(output.trim().split('\n').at(-1) ?? ''), `${from} output`); } catch { /* use runner fallback below */ }
    } else if (output && typeof output === 'object' && !Array.isArray(output)) parsed = output as Record<string, unknown>;
    const named = typeof parsed.outcome === 'string' ? parsed.outcome : nodes.get(from)?.ok ? 'ok' : 'fail';
    const map = edge?.map && typeof edge.map === 'object' ? edge.map as Record<string, unknown> : {};
    const expectedTo = typeof map[named] === 'string' ? map[named] as string : typeof map[named === 'ok' ? 'ok' : 'fail'] === 'string'
      ? map[named === 'ok' ? 'ok' : 'fail'] as string : undefined;
    if (expectedTo !== to) issues.push({ from, to, outcome: named, ...(expectedTo ? { expectedTo } : {}) });
  }
  return issues;
}

function recordObservedEdges(path: string[], events: Array<Record<string, unknown>>): void {
  for (let index = 0; index + 1 < path.length; index++) {
    events.push({ event: 'edge-observed', from: path[index], to: path[index + 1], source: 'release-run-path' });
  }
}

export interface ReleaseSimRigResult {
  id: string;
  pass: boolean;
  universe: string;
  cases: ReleaseSimRigCaseResult[];
  table: Array<{ scenario: string; path: string; status: string; unexpectedEdges: string }>;
  artifactPath: string;
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${where} has unsupported key(s): ${extra.join(', ')}`);
}

function stringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${where} must be an array of non-empty strings`);
  }
  return value as string[];
}

function releaseGraphShape(): { nodeIds: Set<string>; edges: Map<string, Record<string, unknown>> } {
  const graph = record(parseYaml(readFileSync(RELEASE_GRAPH, 'utf8')), 'release graph');
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('release graph nodes or edges missing');
  const nodeIds = new Set(graph.nodes.map((value) => record(value, 'release graph node').node_id)
    .filter((id): id is string => typeof id === 'string'));
  const edges = new Map<string, Record<string, unknown>>();
  for (const raw of graph.edges) {
    const edge = record(raw, 'release edge');
    if (typeof edge.from !== 'string' || edge.on !== 'outcome' || !edge.map || typeof edge.map !== 'object') {
      throw new Error('release simulation requires outcome edges with explicit maps');
    }
    if (edges.has(edge.from)) throw new Error(`release graph has multiple outcome edges from ${edge.from}`);
    edges.set(edge.from, edge);
  }
  return { nodeIds, edges };
}

export function parseReleaseSimRigScenario(source: string): ReleaseSimRigScenario {
  const root = record(parseYaml(source), 'release simulation scenario');
  exactKeys(root, ['version', 'kind', 'id', 'isolation', 'input', 'cases'], 'release simulation scenario');
  if (root.version !== 1 || root.kind !== 'release-graph' || root.isolation !== 'test') {
    throw new Error('release simulation scenario requires version: 1, kind: release-graph, isolation: test');
  }
  if (typeof root.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(root.id)) throw new Error('scenario.id must be lowercase letters, digits, and hyphens');
  const input = record(root.input, 'scenario.input');
  exactKeys(input, ['version', 'previousVersion'], 'scenario.input');
  if (typeof input.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(input.version)
    || typeof input.previousVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(input.previousVersion)) {
    throw new Error('scenario.input requires release version and previousVersion');
  }
  const rawCases = root.cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0 || rawCases.length > 32) throw new Error('scenario.cases must contain 1–32 cases');
  const { nodeIds } = releaseGraphShape();
  const ids = new Set<string>();
  const cases = rawCases.map((raw, index): ReleaseSimRigCase => {
    const row = record(raw, `scenario.cases[${index}]`);
    exactKeys(row, ['id', 'mode', 'fault', 'expect'], `scenario.cases[${index}]`);
    if (typeof row.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.id) || ids.has(row.id)) throw new Error(`scenario.cases[${index}].id must be unique lowercase text`);
    ids.add(row.id);
    let mode: ReleaseSimRigCase['mode'];
    if (row.mode !== undefined) {
      if (row.mode !== 'baseline' && row.mode !== 'cut-tip-moved-after-resume') throw new Error(`scenario.cases[${index}].mode is unregistered`);
      mode = row.mode;
    }
    let fault: ReleaseSimRigCase['fault'];
    if (row.fault !== undefined) {
      const parsed = record(row.fault, `scenario.cases[${index}].fault`);
      exactKeys(parsed, ['node', 'outcome', 'evidence'], `scenario.cases[${index}].fault`);
      if (typeof parsed.node !== 'string' || !nodeIds.has(parsed.node)) throw new Error(`scenario.cases[${index}].fault.node is not in the release graph`);
      if (parsed.outcome !== 'fail' && parsed.outcome !== 'error' && parsed.outcome !== 'timeout') throw new Error(`scenario.cases[${index}].fault.outcome is unregistered`);
      fault = { node: parsed.node, outcome: parsed.outcome, ...(parsed.evidence === undefined ? {} : { evidence: record(parsed.evidence, `scenario.cases[${index}].fault.evidence`) }) };
    }
    if ((mode === undefined) === (fault === undefined)) throw new Error(`scenario.cases[${index}] requires exactly one of mode or fault`);
    const expected = record(row.expect, `scenario.cases[${index}].expect`);
    exactKeys(expected, ['status', 'mustVisit', 'mustNotVisit'], `scenario.cases[${index}].expect`);
    if (expected.status !== 'done' && expected.status !== 'failed' && expected.status !== 'resume-refused') throw new Error(`scenario.cases[${index}].expect.status is invalid`);
    const mustVisit = stringList(expected.mustVisit, `scenario.cases[${index}].expect.mustVisit`);
    const mustNotVisit = stringList(expected.mustNotVisit, `scenario.cases[${index}].expect.mustNotVisit`);
    for (const id of [...mustVisit, ...mustNotVisit]) if (!nodeIds.has(id)) throw new Error(`scenario.cases[${index}] names unknown release node ${id}`);
    if (mustVisit.some((id) => mustNotVisit.includes(id))) throw new Error(`scenario.cases[${index}] visits and excludes the same node`);
    return { id: row.id, ...(mode ? { mode } : {}), ...(fault ? { fault } : {}), expect: { status: expected.status, mustVisit, mustNotVisit } };
  });
  return { version: 1, kind: 'release-graph', id: root.id, isolation: 'test',
    input: { version: input.version, previousVersion: input.previousVersion }, cases };
}

function parseContext(env: NodeJS.ProcessEnv): { nodeId: string } {
  const location = env.ELANOUS_GRAPH_CONTEXT;
  if (!location) throw new Error('ELANOUS_GRAPH_CONTEXT missing in release simulation');
  const context = record(JSON.parse(readFileSync(location, 'utf8')), 'release graph context');
  if (typeof context.nodeId !== 'string') throw new Error('release graph context nodeId missing');
  return { nodeId: context.nodeId };
}

function resultForNode(nodeId: string, fault: ReleaseSimRigCase['fault'], version: string): { exitCode: number; stdout: string; stderr: string; evidence: Record<string, unknown> } {
  const triggeredFault = fault?.node === nodeId ? fault : undefined;
  const outcome = triggeredFault ? triggeredFault.outcome === 'timeout' ? 'error' : triggeredFault.outcome : 'ok';
  const evidence = triggeredFault?.evidence ?? {};
  const commit = nodeId === 'version-release' ? { commit: CUT_TIP, tag: `v${version}` } : {};
  const payload = { outcome, verdict: outcome === 'ok' ? 'pass' : 'fail', summary: triggeredFault ? `simulated ${triggeredFault.outcome}` : `simulated ${nodeId} success`, ...commit,
    simulation: { injected: triggeredFault !== undefined, node: nodeId, evidence } };
  return { exitCode: !triggeredFault ? 0 : triggeredFault.outcome === 'fail' ? 1 : triggeredFault.outcome === 'timeout' ? 124 : 2,
    stdout: `${JSON.stringify(payload)}\n`, stderr: triggeredFault ? `SIMULATED_${triggeredFault.outcome.toUpperCase()}` : '', evidence };
}

async function runCase(scenario: ReleaseSimRigScenario, item: ReleaseSimRigCase, root: string,
  edges: Map<string, Record<string, unknown>>): Promise<ReleaseSimRigCaseResult> {
  const runId = `release-sim-${scenario.id}-${item.id}`;
  const ledgerEvents: Array<Record<string, unknown>> = [];
  const dispatchedNodes: string[] = [];
  const runBash = async (command: string, options: { env?: NodeJS.ProcessEnv }) => {
    const { nodeId } = parseContext(options.env ?? {});
    if (!command.trim()) throw new Error(`empty command at simulated node ${nodeId}`);
    dispatchedNodes.push(nodeId);
    const result = resultForNode(nodeId, item.fault, scenario.input.version);
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
  const capture = (event: string, data: Record<string, unknown>) => ledgerEvents.push({ event, ...data });

  if (item.mode === 'cut-tip-moved-after-resume') {
    let beforeNode = 0;
    const simulatedStop = new Error('simulated runner stop after cut');
    try {
      await runGraph(RELEASE_GRAPH, { runId, input: scenario.input, pinChildUniverse: true, quiet: true,
        deps: { root, runBash, log: capture, beforeNode: () => { if (++beforeNode === 2) throw simulatedStop; } } });
    } catch (error) {
      if (error !== simulatedStop) throw error;
    }
    let refusal = '';
    try {
      await runGraph(RELEASE_GRAPH, { resumeRunId: runId, pinChildUniverse: true, quiet: true,
        releaseCommandSource: { root: REPOSITORY_ROOT, cutTip: 'b'.repeat(40), git: () => { throw new Error('git must not be consulted after the saved tip differs'); } },
        deps: { root, runBash, log: capture } });
    } catch (error) { refusal = error instanceof Error ? error.message : String(error); }
    const interrupted = listGraphRuns(root).runs.find((run) => run.runId === runId);
    const stateFile = interrupted?.statePath ?? '';
    const path = interrupted?.path ?? [];
    recordObservedEdges(path, ledgerEvents);
    const edgeIssues = interrupted ? unexpectedEdges(path, interrupted, edges) : [];
    const statusOk = item.expect.status === 'resume-refused' && refusal.includes('release command source differs from the saved cut tip');
    const visitOk = item.expect.mustVisit.every((id) => path.includes(id));
    const notVisitOk = item.expect.mustNotVisit.every((id) => !path.includes(id));
    const ledgerOk = ledgerEvents.some((row) => row.event === 'node-end')
      && ledgerEvents.filter((row) => row.event === 'edge-observed').length === Math.max(0, path.length - 1);
    return { id: item.id, pass: statusOk && visitOk && notVisitOk && ledgerOk && edgeIssues.length === 0, status: statusOk ? 'resume-refused' : interrupted?.status ?? 'missing',
      path, dispatchedNodes, unexpectedEdges: edgeIssues, checks: { status: statusOk, mustVisit: visitOk, mustNotVisit: notVisitOk, ledgerEvents: ledgerOk }, injectedEvidence: {}, ledgerEvents,
      statePath: stateFile, ...(refusal ? { refusal } : {}) };
  }

  // Initial runs have no releaseCommandSource (the runner only accepts it on resume); all node shell work is intercepted here.
  const state = await runGraph(RELEASE_GRAPH, { runId, input: scenario.input, pinChildUniverse: true, quiet: true,
    deps: { root, runBash, log: capture } });
  const path = state.path;
  recordObservedEdges(path, ledgerEvents);
  const edgeIssues = unexpectedEdges(path, state, edges);
  const statusOk = state.status === item.expect.status;
  const visitOk = item.expect.mustVisit.every((id) => path.includes(id));
  const notVisitOk = item.expect.mustNotVisit.every((id) => !path.includes(id));
  const ledgerOk = ledgerEvents.some((row) => row.event === 'node-start') && ledgerEvents.some((row) => row.event === 'node-end')
    && ledgerEvents.filter((row) => row.event === 'edge-observed').length === Math.max(0, path.length - 1);
  const injectedEvidence = item.fault ? item.fault.evidence ?? {} : {};
  return { id: item.id, pass: statusOk && visitOk && notVisitOk && ledgerOk && edgeIssues.length === 0, status: state.status, path, dispatchedNodes, unexpectedEdges: edgeIssues,
    checks: { status: statusOk, mustVisit: visitOk, mustNotVisit: notVisitOk, ledgerEvents: ledgerOk }, injectedEvidence,
    ledgerEvents, statePath: state.statePath };
}

export async function runReleaseSimRigScenario(source: string): Promise<ReleaseSimRigResult> {
  const scenario = parseReleaseSimRigScenario(source);
  const root = getTestStateRoot();
  if (!root) throw new Error('release simulation rig requires --test isolated mode');
  const { edges } = releaseGraphShape();
  const cases = [];
  for (const item of scenario.cases) cases.push(await runCase(scenario, item, root, edges));
  const result: ReleaseSimRigResult = { id: scenario.id, pass: cases.every((item) => item.pass), universe: root, cases,
    table: cases.map((item) => ({ scenario: item.id, path: item.path.join(' → '), status: item.status,
      unexpectedEdges: item.unexpectedEdges.length ? JSON.stringify(item.unexpectedEdges) : 'none' })),
    artifactPath: join(root, 'ux-sim', 'evidence', `${scenario.id}.json`) };
  mkdirSync(join(root, 'ux-sim', 'evidence'), { recursive: true });
  writeFileSync(result.artifactPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result;
}

export async function runReleaseSimRigIfFile(filePath: string): Promise<ReleaseSimRigResult | null> {
  const source = readFileSync(resolveScenarioFilePath(filePath), 'utf8');
  if (record(parseYaml(source), 'scenario').kind !== 'release-graph') return null;
  if (!getTestStateRoot()) throw new Error('release simulation rig requires --test isolated mode');
  return runReleaseSimRigScenario(source);
}
