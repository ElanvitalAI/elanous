import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { loadNodeCatalog } from '../self-implement/graph-catalog.js';
import { parseGraphTemplateYaml, type GraphEdgeSpec, type GraphNodeSpec } from '../self-implement/graph-yaml.js';
import { executeBashNode } from '../workflow-runtime/nodes/bash.js';
import type { BashNode, NodeExecContext, WorkflowDeps } from '../workflow-runtime/types.js';

type BashRun = WorkflowDeps['runBash'];

export interface GraphRunState {
  graphId: string;
  runId: string;
  status: 'running' | 'done' | 'failed' | 'budget-exceeded' | 'awaiting-approval';
  path: string[];
  nodes: Array<{ nodeId: string; ok: boolean; exit: number | null; executed: boolean; output?: unknown; error?: string; decidedBy?: string; decidedAt?: string }>;
  input?: unknown;
  pending?: { nodeId: string; message: string; since: string; notifiedAt?: string; decision?: 'approved' | 'rejected'; decidedBy?: string; decidedAt?: string };
  approvalSourceHash?: string;
  executed: number;
  dryRun: boolean;
  statePath: string;
}

export interface GraphRunOptions {
  input?: unknown;
  dryRun?: boolean;
  runId?: string;
  resumeRunId?: string;
  deps?: { root?: string; runBash?: BashRun; log?: (event: string, data: Record<string, unknown>) => void };
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

export function decideGraphApproval(graphId: string, runId: string, decision: 'approved' | 'rejected', by?: string, root = effectiveInstanceRoot()): GraphRunState {
  const state = readGraphRun(graphId, runId, root);
  if (state.status !== 'awaiting-approval' || !state.pending || state.pending.decision) {
    throw new Error(`run is not awaiting an undecided approval: ${graphId}/${runId}`);
  }
  if (by !== undefined && !by.trim()) throw new Error('approver name must not be empty');
  const recorded = { nodeId: state.pending.nodeId, decision, ...(by === undefined ? {} : { decidedBy: by }), decidedAt: new Date().toISOString() };
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
  const source = readFileSync(path, 'utf8');
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
  for (const terminal of graph.terminalNodes) {
    if (terminal !== 'done' && terminal !== 'failed') {
      throw new Error(`unsupported terminal node: ${terminal} (expected done or failed)`);
    }
  }
  const recipeSource = readFileSync(join(dirname(path), 'recipes.yaml'), 'utf8');
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
  if (options.resumeRunId && options.runId) throw new Error('runId and resumeRunId cannot be combined');
  const runId = safeSegment(options.resumeRunId ?? options.runId ?? randomUUID());
  const statePath = graphRunPath(graphId, runId, options.deps?.root ?? effectiveInstanceRoot());
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
  const state: GraphRunState = options.resumeRunId
    ? readGraphRun(graphId, runId, options.deps?.root ?? effectiveInstanceRoot())
    : { graphId, runId, status: 'running', path: [], nodes: [], ...(options.input === undefined ? {} : { input: options.input }), executed: 0, dryRun: options.dryRun === true, statePath };
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
  if (options.resumeRunId && options.dryRun !== undefined && options.dryRun !== state.dryRun) throw new Error('cannot change dryRun when resuming');
  if (options.resumeRunId && state.status === 'awaiting-approval' && state.approvalSourceHash !== approvalSourceHash) {
    throw new Error(`approval source changed since run was paused: ${graphId}/${runId}`);
  }
  const persist = () => persistGraphRun(state);
  const log = options.deps?.log ?? ((event: string, data: Record<string, unknown>) => debug.log('graph.runner', event, data));
  const visits = new Map<string, number>();
  for (const nodeId of state.path) visits.set(nodeId, (visits.get(nodeId) ?? 0) + 1);
  let current: string | undefined = state.pending?.nodeId ?? state.path.at(-1) ?? graph.entryNode;
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
  }
  while (current !== undefined) {
    const node = graph.nodes.find((n) => n.nodeId === current);
    if (!node) throw new Error(`undeclared node: ${current}`);
    const resumingPending = state.pending?.nodeId === current;
    const completed = [...state.nodes].reverse().find((recorded) => recorded.nodeId === current && recorded.executed);
    const resumingCompleted = options.resumeRunId !== undefined && !!completed && state.path.at(-1) === current && !resumingPending;
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
    const approval = resolved.approval;
    if (resumingPending && (!approval || approval.approval !== state.pending?.message)) {
      throw new Error(`pending approval no longer matches graph: ${current}`);
    }
    if (approval && !state.dryRun && !state.pending?.decision) {
      if (!state.pending) {
        state.pending = { nodeId: current, message: approval.approval, since: new Date().toISOString() };
        state.approvalSourceHash = approvalSourceHash;
      }
      state.status = 'awaiting-approval';
      if (!state.pending.notifiedAt) {
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
      const runBash: BashRun = async (body, opts) => {
        const result = await (options.deps?.runBash ?? realRunBash)(body, opts);
        code = result.exitCode;
        return result;
      };
      const ctx = { arguments: '', artifactsDir: dirname(statePath), outputs: {}, resolvedProvider: undefined, resolvedModel: undefined, toolPolicy: {}, env: { ...process.env, ELANOUS_GRAPH_CONTEXT: contextPath } } as NodeExecContext;
      const result = await executeBashNode({ id: current, type: 'bash', bash: command.command, ...(command.timeout_ms ? { idle_timeout: command.timeout_ms } : {}) } as BashNode, ctx, { runBash } as WorkflowDeps);
      output = result.output;
      ok = result.ok;
      exit = code;
      error = result.error;
      state.executed++;
    }
    if (resumingCompleted && completed) {
      ok = completed.ok;
      exit = completed.exit;
      output = completed.output;
      error = completed.error;
    } else {
      state.nodes.push({ nodeId: current, ok, exit, executed: !!command && !state.dryRun, ...(command && !state.dryRun ? { output } : {}), ...(error ? { error } : {}),
        ...(approval && state.pending ? { ...(state.pending.decidedBy === undefined ? {} : { decidedBy: state.pending.decidedBy }), decidedAt: state.pending.decidedAt } : {}) });
    }
    if (approval) {
      delete state.pending;
      delete state.approvalSourceHash;
    }
    const reported = command && !state.dryRun ? lastJsonObject(resumingCompleted ? completed?.output : output)?.outcome : undefined;
    const namedOutcome = typeof reported === 'string' ? reported : undefined;
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
