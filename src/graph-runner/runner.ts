import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getElanousConfigDir, getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { debug } from '../debug/log.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { listInstalledPlugins } from '../plugins/install/plugin-install.js';
import { credentialStatus, pluginEnv } from '../plugins/install/plugin-credentials.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { loadNodeCatalog } from '../self-implement/graph-catalog.js';
import { parseGraphTemplateYaml, type GraphEdgeSpec, type GraphNodeSpec } from '../self-implement/graph-yaml.js';
import { psProcessStartMs, START_TOLERANCE_MS } from '../harness/harness-stop.js';
import { executeBashNode } from '../workflow-runtime/nodes/bash.js';
import type { BashNode, NodeExecContext, WorkflowDeps } from '../workflow-runtime/types.js';

type BashRun = WorkflowDeps['runBash'];

export interface GraphRunState {
  graphId: string;
  runId: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  pidStartedAt?: string;
  status: 'running' | 'done' | 'failed' | 'budget-exceeded' | 'awaiting-approval';
  path: string[];
  nodes: Array<{ nodeId: string; ok: boolean; exit: number | null; executed: boolean; output?: unknown; error?: string; decidedBy?: string; decidedAt?: string }>;
  input?: unknown;
  pending?: { nodeId: string; message: string; since: string; notifiedAt?: string; decision?: 'approved' | 'rejected'; decidedBy?: string; decidedAt?: string };
  approvalSourceHash?: string;
  /** Hash of the graph and recipes used for this run; required to safely restart a failed path. */
  sourceHash?: string;
  graphSnapshot?: { graphSha: string; recipesSha: string };
  graphPath?: string;
  resume?: { from: string; at: string; previousStatus: GraphRunState['status']; graph?: 'snapshot' | 'current' };
  executed: number;
  dryRun: boolean;
  statePath: string;
}

export interface GraphRunOptions {
  input?: unknown;
  dryRun?: boolean;
  runId?: string;
  resumeRunId?: string;
  resumeGraphId?: string;
  fromNodeId?: string;
  useCurrentGraph?: boolean;
  deps?: { root?: string; runBash?: BashRun; log?: (event: string, data: Record<string, unknown>) => void; processStartMs?: (pid: number) => number | null };
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === '.' || value === '..') {
    throw new Error(`invalid graph run identifier: ${value}`);
  }
  return value;
}

type CommandRecipe = { command: string; timeout_ms?: number };
type Recipe = CommandRecipe | { approval: string };

/** 접두 없는 recipe 가 카탈로그 역할이고, 그래프 옆 recipes.yaml 에 같은 키의 `{ command }` 가 있을 때만 cmd 처럼 실행한다. */
function roleCommand(recipe: string, recipes: Record<string, Recipe>, catalogRoles: ReadonlySet<string>): CommandRecipe | undefined {
  if (!recipe || recipe === 'none' || recipe.includes(':') || !catalogRoles.has(recipe)) return undefined;
  const entry = recipes[recipe];
  return entry && 'command' in entry ? entry : undefined;
}

function resolveNodeRecipe(node: GraphNodeSpec, recipes: Record<string, Recipe>, catalogRoles: ReadonlySet<string>): { command?: CommandRecipe; approval?: { approval: string } } {
  if (node.recipe === 'none') return {};
  if (node.recipe.startsWith('cmd:')) {
    const id = node.recipe.slice(4);
    const entry = recipes[id];
    return entry && 'command' in entry ? { command: entry } : {};
  }
  if (node.recipe.startsWith('approval:')) {
    const id = node.recipe.slice(9);
    const entry = recipes[id];
    return entry && 'approval' in entry ? { approval: entry } : {};
  }
  const command = roleCommand(node.recipe, recipes, catalogRoles);
  return command ? { command } : {};
}

function approvalMessage(template: string, input: unknown): string {
  if (!template.includes('{{input.version}}')) return template;
  const version = input && typeof input === 'object' && 'version' in input ? (input as { version: unknown }).version : undefined;
  if (typeof version !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error('approval input.version must be a release version');
  }
  return template.replaceAll('{{input.version}}', version);
}

function recipesFor(path: string, recipeSource: string): Record<string, Recipe> {
  const file = join(dirname(path), 'recipes.yaml');
  const parsed: unknown = parseYaml(recipeSource);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`invalid recipes: ${file}`);
  const recipes: Record<string, Recipe> = Object.create(null);
  for (const [id, raw] of Object.entries(parsed)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid recipe: ${id}`);
    const item = raw as Record<string, unknown>;
    if (Object.hasOwn(item, 'approval')) {
      if (typeof item.approval !== 'string' || !item.approval.trim() || Object.keys(item).length !== 1) throw new Error(`invalid recipe: ${id}`);
      recipes[id] = { approval: item.approval };
    } else {
      if (typeof item.command !== 'string' || !item.command.trim() ||
        (item.timeout_ms !== undefined && (!Number.isSafeInteger(item.timeout_ms) || (item.timeout_ms as number) <= 0))) {
        throw new Error(`invalid recipe: ${id}`);
      }
      recipes[id] = { command: item.command, ...(item.timeout_ms === undefined ? {} : { timeout_ms: item.timeout_ms as number }) };
    }
  }
  return recipes;
}

const realRunBash: BashRun = (body, opts) => new Promise((resolve, reject) => {
  execFile('/bin/bash', ['-c', body], { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, signal: opts.signal, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && typeof (error as NodeJS.ErrnoException).code !== 'number') {
      reject(error);
      return;
    }
    resolve({ stdout, stderr, exitCode: error ? (error as unknown as { code: number }).code : 0 });
  });
});

function graphRunPath(graphId: string, runId: string, root: string): string {
  return join(root, 'graph-runs', safeSegment(graphId), `${safeSegment(runId)}.json`);
}

function approvalDecisionPath(state: GraphRunState): string {
  return `${state.statePath}.${state.path.length}.decision.json`;
}

function applyRecordedDecision(state: GraphRunState): GraphRunState {
  if (!state.pending) return state;
  let recorded: { nodeId: string; decision: 'approved' | 'rejected'; decidedBy?: string; decidedAt: string };
  try { recorded = JSON.parse(readFileSync(approvalDecisionPath(state), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return state;
    throw error;
  }
  if (recorded.nodeId !== state.pending.nodeId || !['approved', 'rejected'].includes(recorded.decision) ||
    typeof recorded.decidedAt !== 'string' || (recorded.decidedBy !== undefined && typeof recorded.decidedBy !== 'string') ||
    (state.pending.decision && state.pending.decision !== recorded.decision)) {
    throw new Error(`approval decision mismatch: ${state.graphId}/${state.runId}`);
  }
  state.pending = { ...state.pending, ...recorded };
  return state;
}

function readGraphRun(graphId: string, runId: string, root: string): GraphRunState {
  const file = graphRunPath(graphId, runId, root);
  const state = JSON.parse(readFileSync(file, 'utf8')) as GraphRunState;
  if (state.graphId !== graphId || state.runId !== runId) throw new Error(`run identity mismatch: ${graphId}/${runId}`);
  return applyRecordedDecision({ ...state, statePath: file });
}

function persistGraphRun(state: GraphRunState): void {
  mkdirSync(dirname(state.statePath), { recursive: true });
  const temporary = `${state.statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n');
  renameSync(temporary, state.statePath);
}

export interface ExpectedGraphApprovalVisit { nodeId: string; visit: number }

export function decideGraphApproval(graphId: string, runId: string, decision: 'approved' | 'rejected', by?: string, root = effectiveInstanceRoot(), expected?: ExpectedGraphApprovalVisit): GraphRunState {
  const state = readGraphRun(graphId, runId, root);
  if (state.status !== 'awaiting-approval' || !state.pending || state.pending.decision ||
      (expected && (state.dryRun || state.pending.nodeId !== expected.nodeId || state.path.at(-1) !== expected.nodeId ||
        !Number.isSafeInteger(expected.visit) || expected.visit < 1 ||
        state.path.filter(node => node === expected.nodeId).length !== expected.visit))) {
    throw new Error(`run is not awaiting an undecided approval: ${graphId}/${runId}`);
  }
  if (by !== undefined && !by.trim()) throw new Error('approver name must not be empty');
  const recorded = { nodeId: state.pending.nodeId, decision, ...(by === undefined ? {} : { decidedBy: by }), decidedAt: new Date().toISOString() };
  // A card can claim only the visit it names; never derive a later visit's claim path from a fresh read.
  const decisionPath = approvalDecisionPath(state);
  const temporary = `${decisionPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(recorded) + '\n', { flag: 'wx' });
  try {
    // Hard-link creation is atomic across processes: only the first approver can claim this visit.
    linkSync(temporary, decisionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`run is not awaiting an undecided approval: ${graphId}/${runId}`);
    }
    throw error;
  } finally {
    unlinkSync(temporary);
  }
  return applyRecordedDecision(state);
}

/** 노드 stdout 의 «마지막 비어 있지 않은 줄»이 JSON 객체면 그것을 구조 산출로 본다(아니면 없음). */
export function lastJsonObject(stdout: unknown): Record<string, unknown> | undefined {
  if (typeof stdout !== 'string') return undefined;
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (!last || !last.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(last);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** 이름 붙은 결과: 산출의 `outcome` 이 그 간선 map 의 키면 그 목적지 — 아니면 종전 ok/fail(exit) → fallback. */
function nextNode(edges: readonly GraphEdgeSpec[], nodeId: string, exitOutcome: 'ok' | 'fail', namedOutcome?: string): string | undefined {
  const edge = edges.find((e) => e.from === nodeId);
  if (!edge) return undefined;
  if (edge.to !== undefined) return edge.to;
  if (edge.on !== 'outcome') throw new Error(`unsupported edge condition: ${edge.on}`);
  if (namedOutcome !== undefined && edge.map && Object.hasOwn(edge.map, namedOutcome)) return edge.map[namedOutcome];
  return edge.map?.[exitOutcome] ?? edge.fallback?.[0]?.node;
}

export async function runGraph(path: string, options: GraphRunOptions = {}): Promise<GraphRunState> {
  if (options.resumeRunId && options.runId) throw new Error('runId and resumeRunId cannot be combined');
  if (options.fromNodeId && !options.resumeRunId) throw new Error('--from requires --resume');
  if (options.useCurrentGraph && !options.resumeRunId) throw new Error('--use-current-graph requires --resume');
  const root = options.deps?.root ?? effectiveInstanceRoot();
  const matchingRuns = options.resumeRunId && !options.resumeGraphId
    ? listGraphRuns(root).runs.filter((run) => run.runId === options.resumeRunId && run.graphPath === resolve(path)) : [];
  if (matchingRuns.length > 1) throw new Error(`ambiguous run id: ${options.resumeRunId}`);
  const currentSource = options.resumeRunId && (options.resumeGraphId || matchingRuns.length) && !options.useCurrentGraph
    ? undefined : readFileSync(path, 'utf8');
  const currentHeader: unknown = options.resumeRunId && !options.resumeGraphId && !matchingRuns.length ? parseYaml(currentSource!) : undefined;
  const resumeGraphId = options.resumeGraphId ?? matchingRuns[0]?.graphId ?? (currentHeader && typeof currentHeader === 'object' && !Array.isArray(currentHeader)
    ? (currentHeader as Record<string, unknown>).graph_id : undefined);
  const saved = options.resumeRunId && typeof resumeGraphId === 'string'
    ? readGraphRun(safeSegment(resumeGraphId), safeSegment(options.resumeRunId), root) : undefined;
  if (saved?.graphSnapshot && (!saved.graphPath || resolve(path) !== resolve(saved.graphPath))) {
    throw new Error('--file cannot change the graph path of a snapshot run (이 런은 시작 때 그래프 사본이 있다 — --file 대신 --use-current-graph)');
  }
  const snapshotDir = saved ? `${saved.statePath}.graph` : undefined;
  const graphMode: 'snapshot' | 'current' = snapshotDir && saved?.graphSnapshot && !options.useCurrentGraph ? 'snapshot' : 'current';
  const source = graphMode === 'snapshot' ? readFileSync(join(snapshotDir!, 'graph.yaml'), 'utf8') : currentSource ?? readFileSync(path, 'utf8');
  // The shared YAML parser requires a recipe string. A command-less node in
  // this runner is represented internally as `none`, without changing that parser.
  const raw: unknown = parseYaml(source);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid graph: ${path}`);
  const document = raw as Record<string, unknown>;
  if (Array.isArray(document.nodes)) {
    document.nodes = document.nodes.map((node: unknown) => node && typeof node === 'object' && !Array.isArray(node) && !('recipe' in node)
      ? { ...node, recipe: 'none' } : node);
  }
  const parsed = parseGraphTemplateYaml(stringifyYaml(document), path);
  if (!parsed.template || parsed.errors.length) throw new Error(parsed.errors.map((e) => `${e.path}: ${e.message}`).join('\n'));
  const graph = parsed.template;
  const pluginRoot = elanousStateRoot();
  const graphFile = graphMode === 'snapshot' && !existsSync(path) ? resolve(path) : realpathSync(path);
  const installed = listInstalledPlugins(pluginRoot);
  const owner = installed.find(item => {
    const graphsDir = join(item.path, 'graphs');
    return existsSync(graphsDir) && graphFile.startsWith(`${realpathSync(graphsDir)}${sep}`);
  });
  const credentials = owner ? pluginEnv(owner.name, pluginRoot) : {};
  const declaredEnv = [...new Set(installed.map(item => item.name))]
    .flatMap(name => credentialStatus(name, pluginRoot).fields.map(field => field.env));
  const credentialFields = owner ? credentialStatus(owner.name, pluginRoot).fields.filter(field => field.set).map(field => field.name) : [];
  for (const terminal of graph.terminalNodes) {
    if (terminal !== 'done' && terminal !== 'failed') {
      throw new Error(`unsupported terminal node: ${terminal} (expected done or failed)`);
    }
  }
  const recipeSource = readFileSync(graphMode === 'snapshot' ? join(snapshotDir!, 'recipes.yaml') : join(dirname(path), 'recipes.yaml'), 'utf8');
  if (graphMode === 'snapshot' && saved?.graphSnapshot &&
    (createHash('sha256').update(source).digest('hex') !== saved.graphSnapshot.graphSha ||
      createHash('sha256').update(recipeSource).digest('hex') !== saved.graphSnapshot.recipesSha)) {
    throw new Error('graph snapshot changed since run started');
  }
  const recipes = recipesFor(path, recipeSource);
  const catalogRoles = new Set(loadNodeCatalog().roles.keys());
  // Bind a human decision to the exact graph and recipe contents, not just its id or approval prompt.
  const approvalSourceHash = createHash('sha256').update(source).update('\0').update(recipeSource).digest('hex');
  // Resolve all commands before executing any node; an unknown recipe must never produce a partial publication.
  for (const node of graph.nodes) {
    if (node.recipe === 'none') continue;
    const resolved = resolveNodeRecipe(node, recipes, catalogRoles);
    if (!resolved.command && !resolved.approval) throw new Error(`unknown command recipe for ${node.nodeId}: ${node.recipe}`);
  }
  const graphId = safeSegment(graph.graphId);
  if (saved && graphId !== saved.graphId) {
    if (options.fromNodeId && graphMode === 'current') throw new Error('graph or recipes changed since failed run');
    throw new Error(`run identity mismatch: ${saved.graphId}/${saved.runId}`);
  }
  const runId = safeSegment(options.resumeRunId ?? options.runId ?? randomUUID());
  const statePath = graphRunPath(graphId, runId, root);
  // A resume owns the run from the first state read through its last write and command.
  // Fail closed on a concurrent (or interrupted) owner rather than replaying a command.
  const resumeLock = `${statePath}.resume.lock`;
  if (options.resumeRunId) {
    mkdirSync(dirname(statePath), { recursive: true });
    try { mkdirSync(resumeLock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`run is already being resumed: ${graphId}/${runId}`);
      throw error;
    }
  }
  try {
  const startMs = (options.deps?.processStartMs ?? psProcessStartMs)(process.pid);
  const runnerOwner = { pid: process.pid, pidStartedAt: new Date(startMs ?? Date.now() - process.uptime() * 1_000).toISOString() };
  const state: GraphRunState = options.resumeRunId
    ? readGraphRun(graphId, runId, root)
    : { graphId, runId, startedAt: new Date().toISOString(), ...runnerOwner, status: 'running', path: [], nodes: [], sourceHash: approvalSourceHash,
      graphSnapshot: { graphSha: createHash('sha256').update(source).digest('hex'), recipesSha: createHash('sha256').update(recipeSource).digest('hex') },
      graphPath: resolve(path), ...(options.input === undefined ? {} : { input: options.input }), executed: 0, dryRun: options.dryRun === true, statePath };
  if (options.resumeRunId && graphMode === 'snapshot' && state.sourceHash && state.sourceHash !== approvalSourceHash) {
    throw new Error('graph snapshot changed since run started');
  }
  if (options.resumeRunId && options.dryRun !== undefined && options.dryRun !== state.dryRun) throw new Error('cannot change dryRun when resuming');
  if (options.fromNodeId) {
    if (state.status !== 'failed' || state.pending || state.dryRun) throw new Error('--from requires a failed, non-dry run without pending approval');
    if (graphMode === 'current' && (!state.sourceHash || state.sourceHash !== approvalSourceHash)) throw new Error('graph or recipes changed since failed run');
    const from = state.path.indexOf(options.fromNodeId);
    if (from < 0 || state.path.lastIndexOf(options.fromNodeId) !== from || graph.terminalNodes.includes(options.fromNodeId)) throw new Error(`--from node is not unique on the saved executable path: ${options.fromNodeId}`);
    if (state.path.length !== state.nodes.length || state.nodes.some((record, i) => record.nodeId !== state.path[i]) ||
      state.executed !== state.nodes.filter((record) => record.executed).length) {
      throw new Error('saved run path and node records do not match');
    }
    for (let i = 0; i < state.path.length; i++) {
      const recorded = state.nodes[i]!;
      const spec = graph.nodes.find((node) => node.nodeId === recorded.nodeId);
      if (!spec) throw new Error(`saved path has undeclared node: ${recorded.nodeId}`);
      if (i > 0) {
        const prior = state.nodes[i - 1]!;
        const reported = lastJsonObject(prior.output)?.outcome;
        const next = nextNode(graph.edges, prior.nodeId, prior.ok ? 'ok' : 'fail', typeof reported === 'string' ? reported : undefined);
        if (next !== recorded.nodeId) throw new Error('saved run path does not follow graph edges');
      } else if (recorded.nodeId !== graph.entryNode) throw new Error('saved run path does not start at entry node');
      if (i < from && !recorded.ok) throw new Error('cannot preserve a failed predecessor when resuming');
      const approved = resolveNodeRecipe(spec, recipes, catalogRoles).approval;
      if (approved && i >= from) throw new Error('cannot restart across an approval decision');
      if (approved && i < from) {
        // A JSON state alone is not evidence of approval: require the immutable decision claim for this visit.
        const decisionFile = `${statePath}.${i + 1}.decision.json`;
        let decision: { nodeId?: string; decision?: string; decidedAt?: string };
        try { decision = JSON.parse(readFileSync(decisionFile, 'utf8')); }
        catch { throw new Error(`missing approval decision for ${recorded.nodeId}`); }
        if (decision.nodeId !== recorded.nodeId || decision.decision !== 'approved' || decision.decidedAt !== recorded.decidedAt || !recorded.ok) {
          throw new Error(`invalid approval decision for ${recorded.nodeId}`);
        }
      }
    }
    if (resolveNodeRecipe(graph.nodes.find((node) => node.nodeId === options.fromNodeId)!, recipes, catalogRoles).approval) {
      throw new Error('--from cannot restart an approval node');
    }
    state.path = state.path.slice(0, from);
    state.nodes = state.nodes.slice(0, from);
    state.executed = state.nodes.filter((node) => node.executed).length;
    state.status = 'running';
    Object.assign(state, runnerOwner);
    state.resume = { from: options.fromNodeId, at: new Date().toISOString(), previousStatus: 'failed', graph: graphMode };
    // Persist the restart boundary before executing it, so previous outputs remain durable.
    persistGraphRun(state);
  }
  if (options.resumeRunId && state.status === 'running' && state.pending) {
    throw new Error(`run is not awaiting approval: ${graphId}/${runId}`);
  }
  if (options.resumeRunId && state.status === 'awaiting-approval' && !state.pending) {
    throw new Error(`run is not awaiting approval: ${graphId}/${runId}`);
  }
  if (options.resumeRunId && state.status !== 'awaiting-approval' && state.status !== 'running') {
    throw new Error(`run is not awaiting approval: ${graphId}/${runId}`);
  }
  if (options.resumeRunId && (state.graphId !== graphId || state.runId !== runId)) {
    throw new Error(`run is not awaiting approval: ${graphId}/${runId}`);
  }
  if (options.resumeRunId && state.status === 'awaiting-approval' && state.approvalSourceHash !== approvalSourceHash) {
    throw new Error(`approval source changed since run was paused: ${graphId}/${runId}`);
  }
  if (options.resumeRunId && !options.fromNodeId) {
    const previousStatus = state.status;
    Object.assign(state, runnerOwner);
    state.resume = { from: state.pending?.nodeId ?? state.path.at(-1) ?? graph.entryNode, at: new Date().toISOString(), previousStatus, graph: graphMode };
    persistGraphRun(state);
  }
  if (options.resumeRunId) debug.log('graph.runs', 'resume', { graphId, runId, from: state.resume?.from, graph: graphMode });
  const persist = () => {
    if (state.status === 'done' || state.status === 'failed' || state.status === 'budget-exceeded') state.finishedAt ??= new Date().toISOString();
    persistGraphRun(state);
  };
  const log = options.deps?.log ?? ((event: string, data: Record<string, unknown>) => debug.log('graph.runner', event, data));
  const visits = new Map<string, number>();
  for (const nodeId of state.path) visits.set(nodeId, (visits.get(nodeId) ?? 0) + 1);
  let current: string | undefined = options.fromNodeId ?? state.pending?.nodeId ?? state.path.at(-1) ?? graph.entryNode;
  if (!options.resumeRunId) {
    mkdirSync(dirname(statePath), { recursive: true });
    if (readdirSync(dirname(statePath)).some((file) => file.startsWith(`${runId}.json.`) && file.endsWith('.decision.json'))) {
      throw new Error(`run id already exists: ${graphId}/${runId}`);
    }
    try { writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`run id already exists: ${graphId}/${runId}`);
      throw error;
    }
    mkdirSync(`${statePath}.graph`);
    writeFileSync(join(`${statePath}.graph`, 'graph.yaml'), source, { flag: 'wx' });
    writeFileSync(join(`${statePath}.graph`, 'recipes.yaml'), recipeSource, { flag: 'wx' });
  }
  while (current !== undefined) {
    const node = graph.nodes.find((n) => n.nodeId === current);
    if (!node) throw new Error(`undeclared node: ${current}`);
    const resumingPending = state.pending?.nodeId === current;
    const completed = [...state.nodes].reverse().find((recorded) => recorded.nodeId === current && recorded.executed);
    const resumingCompleted = options.resumeRunId !== undefined && !options.fromNodeId && !!completed && state.path.at(-1) === current && !resumingPending;
    if (!resumingPending && !resumingCompleted && (visits.get(current) ?? 0) >= node.maxVisits) {
      state.status = 'budget-exceeded';
      log('budget-exceeded', { graphId, runId, nodeId: current });
      persist();
      break;
    }
    if (!resumingPending && !resumingCompleted) {
      visits.set(current, (visits.get(current) ?? 0) + 1);
      state.path.push(current);
    }
    const resolved = resolveNodeRecipe(node, recipes, catalogRoles);
    const command = resolved.command;
    const approval = resolved.approval ? { approval: approvalMessage(resolved.approval.approval, state.input) } : undefined;
    if (resumingPending && (!approval || approval.approval !== state.pending?.message)) {
      throw new Error(`pending approval no longer matches graph: ${current}`);
    }
    // Graphs may opt into previewing the approval boundary in dry runs.
    if (approval && (!state.dryRun || document.dry_run_await_approval === true) && !state.pending?.decision) {
      if (!state.pending) {
        state.pending = { nodeId: current, message: approval.approval, since: new Date().toISOString() };
        state.approvalSourceHash = approvalSourceHash;
      }
      state.status = 'awaiting-approval';
      if (!state.dryRun && !state.pending.notifiedAt) {
        try {
          log('approval-pending', { graphId, runId, nodeId: current, message: state.pending.message, since: state.pending.since });
          state.pending = { ...state.pending, notifiedAt: new Date().toISOString() };
        } catch (error) {
          persist();
          throw error;
        }
      }
      persist();
      break;
    }
    state.status = 'running';
    const startedAt = performance.now();
    console.error(`[graph] ${current} start (0.00s)`);
    debug.log('graph.run', 'node', { graphId, runId, nodeId: current, phase: 'start', dryRun: state.dryRun });
    log('node-start', { graphId, runId, nodeId: current, visit: visits.get(current), dryRun: state.dryRun });
    persist();
    let ok = approval && !state.dryRun ? state.pending?.decision === 'approved' : true;
    let exit: number | null = null;
    let error: string | undefined;
    let output: unknown;
    if (command && !state.dryRun && !resumingCompleted) {
      const outputs: Record<string, unknown> = Object.create(null);
      // 구조 산출(마지막 JSON 줄)이 있으면 그것을, 없으면 원문을 준다 — 다음 노드가 판단을 «값»으로 받는다.
      for (const previous of state.nodes) outputs[previous.nodeId] = lastJsonObject(previous.output) ?? previous.output ?? null;
      const contextPath = join(`${statePath}.contexts`, `${state.path.length}.json`);
      mkdirSync(dirname(contextPath), { recursive: true });
      writeFileSync(contextPath, JSON.stringify({ graphId, runId, nodeId: current, input: state.input ?? null, outputs }, null, 2) + '\n');
      let code: number | null = null;
      const redactCredentials = (text: string) => Object.values(credentials).filter(value => value.length > 0)
        .reduce((safe, value) => safe.replaceAll(value, '[REDACTED]'), text);
      const runBash: BashRun = async (body, opts) => {
        const result = await (options.deps?.runBash ?? realRunBash)(body, opts);
        code = result.exitCode;
        return { ...result, stdout: redactCredentials(result.stdout), stderr: redactCredentials(result.stderr) };
      };
      if (owner) debug.log('plugin.credentials', 'injected', { plugin: owner.name, fields: credentialFields, count: credentialFields.length });
      const env = { ...process.env };
      for (const key of declaredEnv) delete env[key];
      Object.assign(env, credentials);
      // 러너가 명시로 받은 우주(`--config-dir`)를 `cmd:` 자식에 못 박는다 — 자식이 코드 위치(소스 트리)로 시험 우주를 새로 고르던 구멍
      //   (09-30 🅢 스튜어드: 작업 트리 `graph run … --config-dir ~/.elanous` 의 자식 triage 가 «apiKey missing» · 0.2.5 컷 릴리스 루프도 같은 발사 줄).
      if (getElanousConfigDirOverride()) {
        env.ELANOUS_CONFIG_DIR = getElanousConfigDir();
        env.ELANOUS_STATE_DIR = effectiveInstanceRoot();
        debug.log('graph-runner', 'child-universe-pinned', { graphId, runId, node: current, configDir: env.ELANOUS_CONFIG_DIR, stateDir: env.ELANOUS_STATE_DIR });
      }
      env.ELANOUS_GRAPH_CONTEXT = contextPath;
      env.ELANOUS_GRAPH_DIR = dirname(resolve(path));
      const ctx = { arguments: '', artifactsDir: dirname(statePath), outputs: {}, resolvedProvider: undefined, resolvedModel: undefined, toolPolicy: {}, env } as NodeExecContext;
      const result = await executeBashNode({ id: current, type: 'bash', bash: command.command, ...(command.timeout_ms ? { idle_timeout: command.timeout_ms } : {}) } as BashNode, ctx, { runBash } as WorkflowDeps);
      output = result.output;
      ok = result.ok;
      exit = code;
      error = result.error ? redactCredentials(result.error) : undefined;
      state.executed++;
    }
    if (resumingCompleted && completed) {
      ok = completed.ok;
      exit = completed.exit;
      output = completed.output;
      error = completed.error;
    } else {
      // 승인 노드도 결과를 «값»으로 남긴다 — 뒤 노드가 문맥(outputs)에서 승인 여부를 확인할 수 있게(발행 노드가 승인 없이 돌지 않도록).
      if (approval && !state.dryRun && !command) {
        output = JSON.stringify({ outcome: ok ? 'approved' : 'rejected', ...(state.pending?.decidedBy === undefined ? {} : { decidedBy: state.pending.decidedBy }), decidedAt: state.pending?.decidedAt ?? null });
      }
      state.nodes.push({ nodeId: current, ok, exit, executed: !!command && !state.dryRun, ...((command || approval) && !state.dryRun && output !== undefined ? { output } : {}), ...(error ? { error } : {}),
        ...(approval && state.pending ? { ...(state.pending.decidedBy === undefined ? {} : { decidedBy: state.pending.decidedBy }), decidedAt: state.pending.decidedAt } : {}) });
    }
    if (approval) {
      delete state.pending;
      delete state.approvalSourceHash;
    }
    const reported = command && !state.dryRun ? lastJsonObject(resumingCompleted ? completed?.output : output)?.outcome : undefined;
    const namedOutcome = typeof reported === 'string' ? reported : undefined;
    const seconds = Number(((performance.now() - startedAt) / 1000).toFixed(2));
    console.error(`[graph] ${current} ${ok ? 'ok' : 'fail'} (${seconds.toFixed(2)}s)`);
    debug.log('graph.run', 'node', { graphId, runId, nodeId: current, phase: ok ? 'ok' : 'fail', seconds, exit });
    log('node-end', { graphId, runId, nodeId: current, ok, exit, ...(namedOutcome === undefined ? {} : { outcome: namedOutcome }), dryRun: state.dryRun });
    persist();
    if (graph.terminalNodes.includes(current)) {
      state.status = current === 'failed' || !ok ? 'failed' : 'done';
      persist();
      break;
    }
    current = nextNode(graph.edges, current, state.dryRun ? 'ok' : ok ? 'ok' : 'fail', state.dryRun ? undefined : namedOutcome);
    if (current === undefined) {
      state.status = 'failed';
      persist();
    }
  }
  return state;
  } finally {
    if (options.resumeRunId) rmdirSync(resumeLock);
  }
}

export type GraphRunAlive = boolean | 'unknown';

export function graphRunAlive(state: GraphRunState, processStartMs: (pid: number) => number | null = psProcessStartMs): GraphRunAlive {
  if (state.pid === undefined) return 'unknown';
  if (!Number.isSafeInteger(state.pid) || state.pid <= 0 || typeof state.pidStartedAt !== 'string') return false;
  const recorded = Date.parse(state.pidStartedAt);
  if (!Number.isFinite(recorded)) return false;
  try {
    const actual = processStartMs(state.pid);
    return actual !== null && Number.isFinite(actual) && Math.abs(actual - recorded) <= START_TOLERANCE_MS;
  } catch { return false; }
}

function isDecisionClaim(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  return typeof value.nodeId === 'string' && (value.decision === 'approved' || value.decision === 'rejected')
    && typeof value.decidedAt === 'string' && (value.decidedBy === undefined || typeof value.decidedBy === 'string')
    && !('graphId' in value) && !('runId' in value);
}

export function listGraphRuns(root = effectiveInstanceRoot()): { runs: GraphRunState[]; unreadable: number } {
  const base = join(root, 'graph-runs');
  let graphs: string[];
  try { graphs = readdirSync(base); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [], unreadable: 0 };
    throw error;
  }
  const runs: GraphRunState[] = [];
  let unreadable = 0;
  for (const graphId of graphs) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(graphId) || graphId === '.' || graphId === '..') continue;
    const dir = join(base, graphId);
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch { unreadable++; continue; }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const runId = file.slice(0, -5);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === '.' || runId === '..') continue;
      // Decision claims are named <runId>.json.<visit>.decision.json; a run
      // may itself end in .decision, so check the ledger identity before skipping.
      const decisionParent = file.match(/^(.*\.json)\.\d+\.decision\.json$/)?.[1];
      try {
        const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        // Skip only a VALID decision claim (decideGraphApproval writes { nodeId, decision, decidedBy?, decidedAt });
        // anything else under a claim-like name is judged as a ledger and counts as unreadable when broken.
        if (decisionParent && isDecisionClaim(raw)) continue;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
          (raw as Partial<GraphRunState>).graphId !== graphId || (raw as Partial<GraphRunState>).runId !== runId) {
          unreadable++;
          continue;
        }
        const state = readGraphRun(graphId, runId, root);
        if (typeof state.startedAt !== 'string' || !Number.isFinite(Date.parse(state.startedAt)) ||
          !Array.isArray(state.path) || !state.path.every((node) => typeof node === 'string') ||
          !Array.isArray(state.nodes) || !state.nodes.every((node) => node && typeof node.nodeId === 'string' && typeof node.ok === 'boolean')) {
          throw new Error('invalid run state');
        }
        runs.push(state);
      } catch { unreadable++; }
    }
  }
  runs.sort((a, b) => Date.parse(b.startedAt!) - Date.parse(a.startedAt!) || a.graphId.localeCompare(b.graphId) || a.runId.localeCompare(b.runId));
  return { runs, unreadable };
}

export function latestGraphRun(graphId: string, root = effectiveInstanceRoot()): GraphRunState | null {
  const dir = join(root, 'graph-runs', safeSegment(graphId));
  let files: string[];
  try { files = readdirSync(dir).filter((file) => file.endsWith('.json') && !file.endsWith('.decision.json')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const latest = files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)[0];
  return latest ? readGraphRun(graphId, latest.slice(0, -5), root) : null;
}
