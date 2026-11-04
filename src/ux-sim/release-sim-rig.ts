import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getTestStateRoot } from '../nexus/paths.js';
import { resetEffectiveInstanceRoot } from '../instance/resolve.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { execFileSync } from 'node:child_process';
import { listGraphRuns, runGraph, type GraphRunState } from '../graph-runner/runner.js';
import { releaseResumeWaiver } from '../../scripts/release-loop/resume.js';
import { runKnownIssues } from '../../scripts/release-loop/known-issues-node.js';
import { graphGateResult, type GateResult } from '../../scripts/release-loop/gate-node.js';
import { runNpmPublish } from '../../scripts/release-loop/npm-publish-node.js';
import { runPublish } from '../../scripts/release-loop/publish-node.js';
import { resumeReleaseRun } from '../../scripts/release-loop/resume-release.js';
import { runAutoApprove } from '../../scripts/release-loop/auto-approve-node.js';
import { runVerify } from '../../scripts/release-loop/verify-node.js';
import { resolveScenarioFilePath } from './scenario.js';

const REPOSITORY_ROOT = join(import.meta.dir, '../..');
const RELEASE_GRAPH = join(REPOSITORY_ROOT, 'graphs/release/release-loop.yaml');
let cachedCutTip: string | undefined;
function cutTip(): string {
  // The sim command is registered for root help. Resolve Git only when a
  // release simulation runs so importing its registrar works from any cwd.
  cachedCutTip ??= execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim();
  return cachedCutTip;
}


export interface ReleaseSimRigCase {
  id: string;
  mode?: 'baseline' | 'cut-tip-moved-after-resume' | 'gate-waive-introduced-regression' | 'owner-waive-missing-schema' | 'owner-waive-0246-fixture';
  fault?: { node: string; outcome: 'fail' | 'error' | 'timeout'; evidence?: Record<string, unknown> };
  nodeOutcomes?: Record<string, { outcome: 'ok' | 'fail' | 'error'; delayMs?: number }>;
  expect: { status: 'done' | 'failed' | 'resume-refused'; mustVisit: string[]; mustNotVisit: string[]; overlap?: [string, string]; refusalIncludes?: string };
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
  checks: { status: boolean; mustVisit: boolean; mustNotVisit: boolean; overlap: boolean; ledgerEvents: boolean };
  fanOuts?: GraphRunState['fanOuts'];
  nodeTimings?: Record<string, { startedAtMs: number; endedAtMs: number }>;
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
    if (edge?.branches && edge.join === to) continue; // The runner records a fan-out's barrier as the parent-path successor.
    const output = nodes.get(from)?.output;
    let parsed: Record<string, unknown> = {};
    if (typeof output === 'string') {
      try { parsed = record(JSON.parse(output.trim().split('\n').at(-1) ?? ''), `${from} output`); } catch { /* use runner fallback below */ }
    } else if (output && typeof output === 'object' && !Array.isArray(output)) parsed = output as Record<string, unknown>;
    const named = typeof parsed.outcome === 'string' ? parsed.outcome : nodes.get(from)?.ok ? 'ok' : 'fail';
    const map = edge?.map && typeof edge.map === 'object' ? edge.map as Record<string, unknown> : {};
    const mappedOutcome = named === 'pass(owner-waived)' ? 'ok' : named;
    const expectedTo = typeof map[mappedOutcome] === 'string' ? map[mappedOutcome] as string : typeof map[mappedOutcome === 'ok' ? 'ok' : 'fail'] === 'string'
      ? map[mappedOutcome === 'ok' ? 'ok' : 'fail'] as string : undefined;
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
    const mapped = !!edge.map && typeof edge.map === 'object';
    const branched = !!edge.branches && typeof edge.branches === 'object' && typeof edge.join === 'string';
    if (typeof edge.from !== 'string' || edge.on !== 'outcome' || (!mapped && !branched)) {
      throw new Error('release simulation requires outcome edges with explicit maps or fan-out joins');
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
    exactKeys(row, ['id', 'mode', 'fault', 'nodeOutcomes', 'expect'], `scenario.cases[${index}]`);
    if (typeof row.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.id) || ids.has(row.id)) throw new Error(`scenario.cases[${index}].id must be unique lowercase text`);
    ids.add(row.id);
    let mode: ReleaseSimRigCase['mode'];
    if (row.mode !== undefined) {
      if (row.mode !== 'baseline' && row.mode !== 'cut-tip-moved-after-resume' && row.mode !== 'gate-waive-introduced-regression' && row.mode !== 'owner-waive-missing-schema' && row.mode !== 'owner-waive-0246-fixture') throw new Error(`scenario.cases[${index}].mode is unregistered`);
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
    const nodeOutcomes: ReleaseSimRigCase['nodeOutcomes'] = {};
    if (row.nodeOutcomes !== undefined) {
      const rawOutcomes = record(row.nodeOutcomes, `scenario.cases[${index}].nodeOutcomes`);
      for (const [node, value] of Object.entries(rawOutcomes)) {
        if (!nodeIds.has(node)) throw new Error(`scenario.cases[${index}].nodeOutcomes names unknown release node ${node}`);
        const injection = record(value, `scenario.cases[${index}].nodeOutcomes.${node}`);
        exactKeys(injection, ['outcome', 'delayMs'], `scenario.cases[${index}].nodeOutcomes.${node}`);
        if (injection.outcome !== 'ok' && injection.outcome !== 'fail' && injection.outcome !== 'error') throw new Error(`scenario.cases[${index}].nodeOutcomes.${node}.outcome is invalid`);
        if (injection.delayMs !== undefined && (!Number.isSafeInteger(injection.delayMs) || (injection.delayMs as number) < 0 || (injection.delayMs as number) > 60_000)) throw new Error(`scenario.cases[${index}].nodeOutcomes.${node}.delayMs must be 0–60000`);
        nodeOutcomes[node] = { outcome: injection.outcome, ...(injection.delayMs === undefined ? {} : { delayMs: injection.delayMs as number }) };
      }
    }
    const expected = record(row.expect, `scenario.cases[${index}].expect`);
    exactKeys(expected, ['status', 'mustVisit', 'mustNotVisit', 'overlap', 'refusalIncludes'], `scenario.cases[${index}].expect`);
    if (expected.status !== 'done' && expected.status !== 'failed' && expected.status !== 'resume-refused') throw new Error(`scenario.cases[${index}].expect.status is invalid`);
    const mustVisit = stringList(expected.mustVisit, `scenario.cases[${index}].expect.mustVisit`);
    const mustNotVisit = stringList(expected.mustNotVisit, `scenario.cases[${index}].expect.mustNotVisit`);
    const refusalIncludes = expected.refusalIncludes;
    if (refusalIncludes !== undefined && (typeof refusalIncludes !== 'string' || !refusalIncludes.trim())) throw new Error(`scenario.cases[${index}].expect.refusalIncludes must be nonempty text`);
    let overlap: [string, string] | undefined;
    if (expected.overlap !== undefined) {
      const pair = stringList(expected.overlap, `scenario.cases[${index}].expect.overlap`);
      if (pair.length !== 2 || pair[0] === pair[1] || pair.some((id) => !nodeIds.has(id))) throw new Error(`scenario.cases[${index}].expect.overlap must name two different release nodes`);
      overlap = [pair[0]!, pair[1]!];
    }
    for (const id of [...mustVisit, ...mustNotVisit]) if (!nodeIds.has(id)) throw new Error(`scenario.cases[${index}] names unknown release node ${id}`);
    if (mustVisit.some((id) => mustNotVisit.includes(id))) throw new Error(`scenario.cases[${index}] visits and excludes the same node`);
    return { id: row.id, ...(mode ? { mode } : {}), ...(fault ? { fault } : {}), ...(Object.keys(nodeOutcomes).length ? { nodeOutcomes } : {}),
      expect: { status: expected.status, mustVisit, mustNotVisit, ...(overlap ? { overlap } : {}), ...(typeof refusalIncludes === 'string' ? { refusalIncludes } : {}) } };
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
  const commit = nodeId === 'version-release' ? { commit: cutTip(), tag: `v${version}` } : {};
  const payload = { outcome, verdict: outcome === 'ok' ? 'pass' : 'fail', summary: triggeredFault ? `simulated ${triggeredFault.outcome}` : `simulated ${nodeId} success`, ...commit,
    simulation: { injected: triggeredFault !== undefined, node: nodeId, evidence } };
  return { exitCode: !triggeredFault ? 0 : triggeredFault.outcome === 'fail' ? 1 : triggeredFault.outcome === 'timeout' ? 124 : 2,
    stdout: `${JSON.stringify(payload)}\n`, stderr: triggeredFault ? `SIMULATED_${triggeredFault.outcome.toUpperCase()}` : '', evidence };
}

async function runGateWaiveCase(scenario: ReleaseSimRigScenario, item: ReleaseSimRigCase, root: string,
  edges: Map<string, Record<string, unknown>>): Promise<ReleaseSimRigCaseResult> {
  const runId = `release-sim-${scenario.id}-${item.id}`;
  if (item.mode === 'owner-waive-0246-fixture') {
    root = join(root, runId);
    mkdirSync(root, { recursive: true });
  }
  const ownerWaived = item.mode === 'owner-waive-missing-schema' || item.mode === 'owner-waive-0246-fixture';
  const fixtureOwnerWaiver = item.mode === 'owner-waive-0246-fixture';
  const input = fixtureOwnerWaiver ? { ...scenario.input, version: '0.2.46', previousVersion: '0.2.45', branchCut: true }
    : ownerWaived ? { ...scenario.input, version: '0.2.45', previousVersion: '0.2.44' } : scenario.input;
  const gateFixture = fixtureOwnerWaiver
    ? JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'scripts/release-loop/fixtures/gate-verdict-0.2.46.json'), 'utf8')) as Record<string, unknown>
    : undefined;
  const fixtureIntroducedIds = Array.isArray(gateFixture?.introduced) ? gateFixture.introduced as string[] : [];
  const introducedId = 'src/example.test.ts > reports the known regression';
  const acceptedRegressions = [{ id: introducedId, note: 'The example capability may fail during use.' }];
  const reason = 'Known gate failures remain in this release. Users may encounter these issues during normal use.';
  const dispatchedNodes: string[] = [];
  const firstAttemptDispatchedNodes: string[] = [];
  let resumedPhase = false;
  let npmPublishEvidence: Record<string, unknown> | undefined;
  let verifyEvidence: Record<string, unknown> | undefined;
  const ledgerEvents: Array<Record<string, unknown>> = [];
  const nodeTimings: NonNullable<ReleaseSimRigCaseResult['nodeTimings']> = {};
  let knownIssuesAccepted: unknown;
  const runBash = async (command: string, options: { env?: NodeJS.ProcessEnv }) => {
    const { nodeId } = parseContext(options.env ?? process.env);
    if (!command.trim()) throw new Error(`empty command at simulated node ${nodeId}`);
    dispatchedNodes.push(nodeId);
    if (!resumedPhase) firstAttemptDispatchedNodes.push(nodeId);
    const startedAtMs = performance.now();
    if (nodeId === 'gate') {
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      if (gateFixture) {
        const persisted = gateFixture as unknown as { outcome: 'regression'; introduced: string[]; preexisting: string[]; knownEnv: string[] };
        const normalized = graphGateResult({ ...persisted, preexisting: persisted.preexisting.length, knownEnv: persisted.knownEnv.length,
          fixed: null, knownEnvCleared: [], durationMs: 0, stalledEnv: [], stalledShards: [], unmeasuredRecheckFiles: [],
          unmeasuredErrors: [], abortedShards: 0, rcNonzeroNoFailures: [] } as unknown as GateResult, true);
        return { exitCode: 1, stdout: `${JSON.stringify(normalized)}\n`, stderr: '' };
      }
      return { exitCode: 1, stdout: `${JSON.stringify(item.mode === 'owner-waive-missing-schema' ? { outcome: 'fail', introduced: 1, introducedIds: [] } : { outcome: 'fail', verdict: 'fail', introduced: [introducedId],
        preexisting: 0, knownEnv: 0, durationMs: 1, stalledEnv: [], stalledShards: [], unmeasuredRecheckFiles: [], unmeasuredErrors: [], rcNonzeroNoFailures: [], abortedShards: 0 })}
`, stderr: '' };
    }
    if (nodeId === 'version-release' && fixtureOwnerWaiver) {
      const value = { outcome: 'ok', version: input.version, commit: cutTip(), branch: `release/${input.version}` };
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
    }
    if (nodeId === 'prepare' && fixtureOwnerWaiver) {
      const out = join(root, 'release', input.version, 'prepared');
      mkdirSync(join(out, 'dist'), { recursive: true });
      for (let index = 0; index < 5; index += 1) writeFileSync(join(out, 'dist', `fixture-${index}.tgz`), 'fixture');
      const value = { outcome: 'ok', commit: cutTip(), out };
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
    }
    if (nodeId === 'docs' && fixtureOwnerWaiver) {
      const worktree = join(root, 'owner-waive-docs');
      const notes = join(worktree, 'release/public/docs/releases', `${input.version}.md`);
      mkdirSync(join(worktree, 'release/public/docs/releases'), { recursive: true });
      writeFileSync(notes, `# ${input.version}\n\n`);
      const value = { outcome: 'ok', branch: `release-docs/${input.version}`, worktree, notes: 'fixture release notes', artifactOwner: { runId, attempt: 1 } };
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
    }
    const location = options.env?.ELANOUS_GRAPH_CONTEXT;
    const context = location ? record(JSON.parse(readFileSync(location, 'utf8')), 'release graph context') : {};
    if (nodeId === 'known-issues') knownIssuesAccepted = record(context.input, 'known-issues input').acceptedRegressions;
    if (nodeId === 'docs' && ownerWaived) {
      const worktree = join(root, 'owner-waive-docs');
      const notes = join(worktree, 'release/public/docs/releases', `${input.version}.md`);
      mkdirSync(join(worktree, 'release/public/docs/releases'), { recursive: true });
      writeFileSync(notes, '# Release\n');
      const result = { outcome: 'ok', branch: `release-docs/${input.version}`, worktree };
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      return { exitCode: 0, stdout: JSON.stringify(result) + '\n', stderr: '' };
    }
    if (nodeId === 'known-issues' && ownerWaived) {
      const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextPath) throw new Error('known-issues context missing in owner waiver rig');
      const previous = process.env.ELANOUS_GRAPH_CONTEXT;
      const previousStateDir = process.env.ELANOUS_STATE_DIR;
      const previousConfigDir = getElanousConfigDirOverride();
      process.env.ELANOUS_GRAPH_CONTEXT = contextPath;
      process.env.ELANOUS_STATE_DIR = root;
      setElanousConfigDir(root);
      resetEffectiveInstanceRoot();
      try {
        const graphContext = record(JSON.parse(readFileSync(contextPath, 'utf8')), 'known-issues context');
        const output = runKnownIssues(graphContext as never, (program, args, cwd) => program === 'git' ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: `unexpected ${program} ${args.join(' ')}` });
        knownIssuesAccepted = record(graphContext.input, 'known-issues input').acceptedRegressions;
        nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
        return { exitCode: 0, stdout: JSON.stringify(output) + '\n', stderr: '' };
      } finally { if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous; if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousStateDir; if (previousConfigDir === undefined) resetElanousConfigDir(); else setElanousConfigDir(previousConfigDir); resetEffectiveInstanceRoot(); }
    }
    if (nodeId === 'auto-approve' && fixtureOwnerWaiver) {
      const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextPath) throw new Error('auto-approve context missing in owner waiver rig');
      const previous = process.env.ELANOUS_GRAPH_CONTEXT;
      const previousStateDir = process.env.ELANOUS_STATE_DIR;
      const previousConfigDir = getElanousConfigDirOverride();
      process.env.ELANOUS_GRAPH_CONTEXT = contextPath;
      process.env.ELANOUS_STATE_DIR = root;
      setElanousConfigDir(root);
      resetEffectiveInstanceRoot();
      try {
        const value = runAutoApprove(record(JSON.parse(readFileSync(contextPath, 'utf8')), 'auto-approve context') as never,
          { instanceRoot: root, repo: REPOSITORY_ROOT, bunVersion: readFileSync(join(REPOSITORY_ROOT, '.bun-version'), 'utf8').trim() });
        nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
        return { exitCode: value.outcome === 'ok' ? 0 : 1, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
      } finally {
        if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous;
        if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousStateDir;
        if (previousConfigDir === undefined) resetElanousConfigDir(); else setElanousConfigDir(previousConfigDir);
        resetEffectiveInstanceRoot();
      }
    }
    if (nodeId === 'tui' && fixtureOwnerWaiver) {
      const value = { outcome: 'ok', verdict: 'pass', regress: { pass: 7, fail: 0,
        results: Array.from({ length: 7 }, (_, index) => ({ id: `R${index + 1}`, title: `fixture R${index + 1}`, ok: true, reason: 'fixture pass' })) } };
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
    }
    if (nodeId === 'npm-publish' && fixtureOwnerWaiver) {
      const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextPath) throw new Error('npm-publish context missing in owner waiver rig');
      const graphContext = record(JSON.parse(readFileSync(contextPath, 'utf8')), 'npm-publish context');
      const tokenFile = join(root, 'npm-token');
      writeFileSync(tokenFile, 'fixture-token\n', { mode: 0o600 });
      const registryReads = new Map<string, number>();
      const published: string[] = [];
      const result = await runNpmPublish({ ...graphContext, input: { ...record(graphContext.input, 'npm-publish input'), npmWaitMinutes: 0, npmTokenFile: tokenFile } } as never, {
        stateDir: root, productionRoot: root, sleep: async () => {},
        exec: (command, args) => {
          if (command === 'tar') return { status: 0, stdout: JSON.stringify({ name: 'elanous', version: '0.2.46' }), stderr: '' };
          if (command === 'npm' && args[0] === 'publish') { published.push(args.join(' ')); return { status: 0, stdout: 'published', stderr: '' }; }
          return { status: 2, stdout: '', stderr: `unexpected ${command} ${args.join(' ')}` };
        },
        registry: async (url) => {
          const count = (registryReads.get(url) ?? 0) + 1;
          registryReads.set(url, count);
          if (url.endsWith('/0.2.46')) return count === 1 ? { status: 404, body: null } : { status: 200, body: { name: 'elanous', version: '0.2.46' } };
          return { status: 200, body: { 'dist-tags': { latest: count === 1 ? '0.2.45' : '0.2.46' } } };
        },
      });
      npmPublishEvidence = { ...(npmPublishEvidence ?? {}), result, publishedCommands: published, registryReads: Object.fromEntries(registryReads) };
      nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
      return { exitCode: result.outcome === 'ok' ? 0 : 1, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
    }
    if (nodeId === 'publish' && fixtureOwnerWaiver) {
      const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextPath) throw new Error('publish context missing in owner waiver rig');
      const previous = process.env.ELANOUS_GRAPH_CONTEXT;
      const previousStateDir = process.env.ELANOUS_STATE_DIR;
      const previousConfigDir = getElanousConfigDirOverride();
      process.env.ELANOUS_GRAPH_CONTEXT = contextPath;
      process.env.ELANOUS_STATE_DIR = root;
      setElanousConfigDir(root);
      resetEffectiveInstanceRoot();
      const externalCalls: string[] = [];
      try {
        const result = runPublish((program, args) => {
          externalCalls.push(`${program} ${args.join(' ')}`);
          if (program === 'git' && args[0] === 'show' && args[1]?.endsWith(`release/public/docs/releases/${input.version}.md`))
            return { status: 0, stdout: `# ${input.version}\n\nKnown Issues\n`, stderr: '' };
          if (program === 'git' && args[0] === 'show' && args[1]?.endsWith('website/pages.json'))
            return { status: 0, stdout: JSON.stringify({ pages: [] }), stderr: '' };
          if (program === 'bun' && args[0] === 'bin/elanous.mjs' && args[1] === 'release' && args[2] === 'publish')
            return { status: 0, stdout: JSON.stringify({ ok: true, published: true, tag: `v${input.version}`, publicRepo: 'elanous/elanous', assets: [] }), stderr: '' };
          return { status: 2, stdout: '', stderr: `unexpected publish boundary ${program} ${args.join(' ')}` };
        }, undefined, { now: () => Date.now(), sleep: () => {} }, root);
        npmPublishEvidence = { ...(npmPublishEvidence ?? {}), publishNodeResult: result, publishNodeExternalCalls: externalCalls };
        nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
        return { exitCode: result.outcome === 'ok' ? 0 : 1, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
      } finally {
        if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous;
        if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousStateDir;
        if (previousConfigDir === undefined) resetElanousConfigDir(); else setElanousConfigDir(previousConfigDir);
        resetEffectiveInstanceRoot();
      }
    }
    if (nodeId === 'verify' && fixtureOwnerWaiver) {
      const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextPath) throw new Error('verify context missing in owner waiver rig');
      const previous = process.env.ELANOUS_GRAPH_CONTEXT;
      process.env.ELANOUS_GRAPH_CONTEXT = contextPath;
      try {
        const result = runVerify(() => ({ status: 0, stdout: JSON.stringify({ ok: true, notesPage: 'ok', npmLatest: '0.2.46' }), stderr: '' }));
        verifyEvidence = { result, command: 'release verify --version 0.2.46', npmLatest: '0.2.46' };
        nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
        return { exitCode: result.outcome === 'ok' ? 0 : 1, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
      } finally { if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous; }
    }
    const result = resultForNode(nodeId, undefined, input.version);
    nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
  const capture = (event: string, data: Record<string, unknown>) => ledgerEvents.push({ event, ...data });
  const first = await runGraph(RELEASE_GRAPH, { runId, input, pinChildUniverse: true, quiet: true,
    deps: { root, runBash, log: capture } });
  const waiver = releaseResumeWaiver(first, { from: 'gate', ...(ownerWaived ? { ownerWaive: 'gate' } : { waive: 'gate' }), reason, acceptedRegressions: ownerWaived ? [] : acceptedRegressions, approvedBy: 'OP' });
  if (!waiver) throw new Error('measured gate waiver was not produced');
  resumedPhase = true;
  dispatchedNodes.length = 0;
  const git = (args: string[]) => {
    if (args[0] === 'ls-remote' && args.at(-1) === `refs/heads/release/${input.version}`) return `${cutTip()}\trefs/heads/release/${input.version}`;
    if (args[0] === 'ls-remote' || args[0] === 'show-ref' || args[0] === 'worktree') return '';
    if (args[0] === 'fetch') return '';
    if (args[0] === 'rev-parse') return cutTip();
    if (args[0] === 'ls-files') return '';
    if (args[0] === '-c' && args.includes('status.showUntrackedFiles=all')) return '';
    if (args[0] === 'merge-base') return '';
    throw new Error(`unexpected simulated release git ${args.join(' ')}`);
  };
  const trafficFile = join(root, 'traffic.json');
  writeFileSync(trafficFile, '{}\n');
  const resumed = fixtureOwnerWaiver
    ? (await resumeReleaseRun({ runId, from: 'gate', ownerWaive: 'gate', reason, acceptedRegressions: [], approvedBy: 'OP',
      partial: false, commandRoot: REPOSITORY_ROOT }, {
      root, repo: REPOSITORY_ROOT, graphPath: RELEASE_GRAPH, runBash, trafficFile, ledgerRoot: root,
      git, isAncestor: () => true,
    })).state
    : await runGraph(RELEASE_GRAPH, { resumeRunId: runId, fromNodeId: 'gate', input,
      releaseWaiver: { ...waiver, requestedRegressions: ownerWaived ? [] : acceptedRegressions }, pinChildUniverse: true, quiet: true,
      deps: { root, runBash, log: capture } });
  const path = resumed.path;
  const visited = new Set([...path, ...Object.values(resumed.fanOuts ?? {}).flatMap((fanout) => Object.keys(fanout.branches))]);
  recordObservedEdges(path, ledgerEvents);
  const edgeIssues = unexpectedEdges(path, resumed, edges);
  const gate = resumed.nodes.find((node) => node.nodeId === 'gate');
  const issueRows = Array.isArray(knownIssuesAccepted) ? knownIssuesAccepted as Array<{ id?: unknown; note?: unknown }> : [];
  const knownIssueOk = (ownerWaived ? !issueRows.some((issue) => issue.id === introducedId) : issueRows.some((issue) => issue.id === introducedId))
    && issueRows.some((issue) => issue.id === 'waive:gate' && issue.note === reason);
  const ownerNotes = ownerWaived ? readFileSync(join(root, 'owner-waive-docs', 'release/public/docs/releases', `${input.version}.md`), 'utf8') : '';
  const ownerRunLedger = ownerWaived ? JSON.parse(readFileSync(resumed.statePath, 'utf8')) as GraphRunState : undefined;
  const ownerLedger = ownerRunLedger?.nodes.find((node) => node.nodeId === 'gate')?.waiver;
  const ownerLedgerHasApproval = ownerRunLedger?.path.includes('gate') === true && ownerRunLedger.runId === resumed.runId;
  const knownIssuesOutput = resumed.nodes.find((node) => node.nodeId === 'known-issues')?.output;
  const knownIssuesResult = typeof knownIssuesOutput === 'string' ? JSON.parse(knownIssuesOutput) as Record<string, unknown> : {};
  const auditLine = ownerNotes.match(/<!-- (\{[^\n]*\}) -->/)?.[1];
  const audit = auditLine ? JSON.parse(auditLine) as Record<string, unknown> : undefined;
  const expectedOwnerIds = fixtureOwnerWaiver ? fixtureIntroducedIds : [];
  const ownerRecordOk = !ownerWaived || (ownerLedgerHasApproval && ownerLedger?.ownerWaived === true && ownerLedger.approvedBy === 'OP'
    && ownerLedger.reason === reason && JSON.stringify(ownerLedger.introducedIds ?? []) === JSON.stringify(expectedOwnerIds)
    && audit?.type === 'release-owner-waiver' && audit.approvedBy === 'OP' && audit.reason === reason
    && JSON.stringify(audit.introducedIds ?? []) === JSON.stringify(expectedOwnerIds)
    && Array.isArray(knownIssuesResult.bullets) && knownIssuesResult.bullets.includes(reason));
  const statusOk = resumed.status === item.expect.status && resumed.path.includes('publish');
  const visitOk = item.expect.mustVisit.every((id) => visited.has(id));
  const notVisitOk = item.expect.mustNotVisit.every((id) => !visited.has(id));
  const ledgerOk = ledgerEvents.some((row) => row.event === 'node-start') && ledgerEvents.some((row) => row.event === 'node-end')
    && ledgerEvents.filter((row) => row.event === 'edge-observed').length === Math.max(0, path.length - 1);
  const waiverOk = gate?.ok === true && gate.executed === false && gate.waiver?.reason === reason
    && gate.waiver.approvedBy === 'OP' && (ownerWaived ? gate.waiver.ownerWaived === true && JSON.stringify(JSON.parse(String(gate.output)).outcome) === JSON.stringify('pass(owner-waived)') : JSON.stringify(gate.waiver.introducedIds) === JSON.stringify([introducedId]));
  const releaseTailOk = !fixtureOwnerWaiver || (dispatchedNodes.includes('publish') && dispatchedNodes.includes('npm-publish') && dispatchedNodes.includes('verify')
    && (npmPublishEvidence?.publishNodeResult as { outcome?: string } | undefined)?.outcome === 'ok'
    && Array.isArray(npmPublishEvidence?.publishNodeExternalCalls)
    && npmPublishEvidence?.result !== undefined && (npmPublishEvidence.result as { outcome?: string; npm?: string }).outcome === 'ok'
    && (npmPublishEvidence.result as { npm?: string }).npm === 'published'
    && Array.isArray(npmPublishEvidence.publishedCommands) && npmPublishEvidence.publishedCommands.length === 1
    && verifyEvidence?.result !== undefined && (verifyEvidence.result as { outcome?: string }).outcome === 'ok');
  const pass = statusOk && visitOk && notVisitOk && knownIssueOk && waiverOk && ownerRecordOk && releaseTailOk && ledgerOk && edgeIssues.length === 0;
  const result: ReleaseSimRigCaseResult = { id: item.id, pass, status: resumed.status, path, dispatchedNodes, unexpectedEdges: edgeIssues,
    checks: { status: statusOk, mustVisit: visitOk && knownIssueOk && waiverOk && ownerRecordOk, mustNotVisit: notVisitOk, overlap: true, ledgerEvents: ledgerOk },
    injectedEvidence: { introducedId, introducedIds: fixtureIntroducedIds, acceptedRegressions, reason, waived: waiverOk, knownIssuesAccepted, initialStatus: first.status, initialPath: first.path, initialDispatchedNodes: firstAttemptDispatchedNodes, publishReached: path.includes('publish'), npmPublishEvidence, verifyEvidence, ownerNotes, ownerRecordOk, releaseTailOk, ownerLedgerPath: ownerWaived ? resumed.statePath : undefined },
    fanOuts: resumed.fanOuts, nodeTimings, ledgerEvents, statePath: resumed.statePath };
  return result;
}

async function runCase(scenario: ReleaseSimRigScenario, item: ReleaseSimRigCase, root: string,
  edges: Map<string, Record<string, unknown>>): Promise<ReleaseSimRigCaseResult> {
  const runId = `release-sim-${scenario.id}-${item.id}`;
  const ledgerEvents: Array<Record<string, unknown>> = [];
  const dispatchedNodes: string[] = [];
  const nodeTimings: NonNullable<ReleaseSimRigCaseResult['nodeTimings']> = {};
  const runBash = async (command: string, options: { env?: NodeJS.ProcessEnv }) => {
    const { nodeId } = parseContext(options.env ?? process.env);
    if (!command.trim()) throw new Error(`empty command at simulated node ${nodeId}`);
    dispatchedNodes.push(nodeId);
    const startedAtMs = performance.now();
    const injection = item.nodeOutcomes?.[nodeId];
    const result = injection ? resultForNode(nodeId, injection.outcome === 'ok' ? undefined : {
      node: nodeId, outcome: injection.outcome, evidence: {},
    }, scenario.input.version) : resultForNode(nodeId, item.fault, scenario.input.version);
    if (injection?.delayMs) await new Promise((resolve) => setTimeout(resolve, injection.delayMs));
    nodeTimings[nodeId] = { startedAtMs, endedAtMs: performance.now() };
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
  const capture = (event: string, data: Record<string, unknown>) => ledgerEvents.push({ event, ...data });

  if (item.mode === 'gate-waive-introduced-regression' || item.mode === 'owner-waive-missing-schema' || item.mode === 'owner-waive-0246-fixture') return runGateWaiveCase(scenario, item, root, edges);

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
    const visited = new Set([...path, ...Object.values(interrupted?.fanOuts ?? {}).flatMap((fanout) => Object.keys(fanout.branches))]);
    recordObservedEdges(path, ledgerEvents);
    const edgeIssues = interrupted ? unexpectedEdges(path, interrupted, edges) : [];
    const statusOk = item.expect.status === 'resume-refused' && refusal.includes(item.expect.refusalIncludes ?? 'release command source differs from the saved cut tip');
    const visitOk = item.expect.mustVisit.every((id) => visited.has(id));
    const notVisitOk = item.expect.mustNotVisit.every((id) => !visited.has(id));
    const overlapPair = item.expect.overlap;
    const overlapOk = !overlapPair || (!!nodeTimings[overlapPair[0]] && !!nodeTimings[overlapPair[1]] &&
      nodeTimings[overlapPair[0]]!.startedAtMs < nodeTimings[overlapPair[1]]!.endedAtMs &&
      nodeTimings[overlapPair[1]]!.startedAtMs < nodeTimings[overlapPair[0]]!.endedAtMs);
    const ledgerOk = ledgerEvents.some((row) => row.event === 'node-end')
      && ledgerEvents.filter((row) => row.event === 'edge-observed').length === Math.max(0, path.length - 1);
    return { id: item.id, pass: statusOk && visitOk && notVisitOk && overlapOk && ledgerOk && edgeIssues.length === 0, status: statusOk ? 'resume-refused' : interrupted?.status ?? 'missing',
      path, dispatchedNodes, unexpectedEdges: edgeIssues, checks: { status: statusOk, mustVisit: visitOk, mustNotVisit: notVisitOk, overlap: overlapOk, ledgerEvents: ledgerOk }, injectedEvidence: {}, ledgerEvents,
      statePath: stateFile, ...(refusal ? { refusal } : {}) };
  }

  // Initial runs have no releaseCommandSource (the runner only accepts it on resume); all node shell work is intercepted here.
  const state = await runGraph(RELEASE_GRAPH, { runId, input: scenario.input, pinChildUniverse: true, quiet: true,
    deps: { root, runBash, log: capture } });
  const path = state.path;
  const visited = new Set([...path, ...Object.values(state.fanOuts ?? {}).flatMap((fanout) => Object.keys(fanout.branches))]);
  recordObservedEdges(path, ledgerEvents);
  const edgeIssues = unexpectedEdges(path, state, edges);
  const statusOk = state.status === item.expect.status;
  const visitOk = item.expect.mustVisit.every((id) => visited.has(id));
  const notVisitOk = item.expect.mustNotVisit.every((id) => !visited.has(id));
  const overlapPair = item.expect.overlap;
  const overlapOk = !overlapPair || (!!nodeTimings[overlapPair[0]] && !!nodeTimings[overlapPair[1]] &&
    nodeTimings[overlapPair[0]]!.startedAtMs < nodeTimings[overlapPair[1]]!.endedAtMs &&
    nodeTimings[overlapPair[1]]!.startedAtMs < nodeTimings[overlapPair[0]]!.endedAtMs);
  const ledgerOk = ledgerEvents.some((row) => row.event === 'node-start') && ledgerEvents.some((row) => row.event === 'node-end')
    && ledgerEvents.filter((row) => row.event === 'edge-observed').length === Math.max(0, path.length - 1);
  const injectedEvidence = item.fault ? item.fault.evidence ?? {} : {};
  return { id: item.id, pass: statusOk && visitOk && notVisitOk && overlapOk && ledgerOk && edgeIssues.length === 0, status: state.status, path, dispatchedNodes, unexpectedEdges: edgeIssues,
    checks: { status: statusOk, mustVisit: visitOk, mustNotVisit: notVisitOk, overlap: overlapOk, ledgerEvents: ledgerOk }, injectedEvidence,
    fanOuts: state.fanOuts, nodeTimings, ledgerEvents, statePath: state.statePath };
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
