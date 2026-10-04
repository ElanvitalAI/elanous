import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getElanousConfigDir, getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { debug } from '../debug/log.js';
import { publishInsideEvent } from '../nexus/api/inside-events.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { listInstalledPlugins } from '../plugins/install/plugin-install.js';
import { credentialStatus, pluginEnv } from '../plugins/install/plugin-credentials.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { loadNodeCatalog } from '../self-implement/graph-catalog.js';
import { growthApprovalRef, proposeGrowth, type GraphGrowth, type GrowthProposer, type GrowthRecipeEffect, type GrowthDecisionDeps, type GrowthCommand } from './graph-grow.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import { createLLMGrowthProposer } from './graph-grow-llm.js';
import { parseGraphTemplateYaml, type GraphEdgeSpec, type GraphNodeSpec, type GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import { createGraphVariant, type GraphVariantPlan } from '../self-implement/graph-variant.js';
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
  activeNode?: { nodeId: string; pid: number; pidStartedAt: string };
  stoppedAt?: string;
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
  variant?: { overlayId: string; goal: string; plan: GraphVariantPlan };
  growth?: GraphGrowth[];
  growthRejections?: Array<{ from: string; outcome: string; reason: string }>;
  growthPark?: { from: string; outcome: string; reason: string; decisionId: string; decisionRef: string; growth: GraphGrowth; command?: GrowthCommand; approval?: string };
  resume?: { from: string; at: string; previousStatus: GraphRunState['status']; graph?: 'snapshot' | 'current' };
  executed: number;
  dryRun: boolean;
  statePath: string;
}

export interface GraphRunOptions {
  input?: unknown;
  dryRun?: boolean;
  variant?: { goal: string; plan: GraphVariantPlan };
  runId?: string;
  resumeRunId?: string;
  resumeGraphId?: string;
  fromNodeId?: string;
  useCurrentGraph?: boolean;
  deps?: { root?: string; runBash?: BashRun; log?: (event: string, data: Record<string, unknown>) => void; processStartMs?: (pid: number) => number | null; growthProposer?: GrowthProposer; growthLLM?: (prompt: string) => Promise<string>; classifyGrowthRecipe?: (node: GraphNodeSpec, resolved: { command?: string; approval?: string }) => GrowthRecipeEffect; growthDecision?: GrowthDecisionDeps & { list?: (filters: { status: 'all' }) => DecisionEntry[] } };
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === '.' || value === '..') {
    throw new Error(`invalid graph run identifier: ${value}`);
  }
  return value;
}

type CommandRecipe = { command: string; dry_run_command?: string; timeout_ms?: number };
type Recipe = CommandRecipe | ({ approval: string } & Partial<CommandRecipe>);

/** 접두 없는 recipe 가 카탈로그 역할이고, 그래프 옆 recipes.yaml 에 같은 키의 `{ command }` 가 있을 때만 cmd 처럼 실행한다. */
function roleCommand(recipe: string, recipes: Record<string, Recipe>, catalogRoles: ReadonlySet<string>): CommandRecipe | undefined {
  if (!recipe || recipe === 'none' || recipe.includes(':') || !catalogRoles.has(recipe)) return undefined;
  const entry = recipes[recipe];
  // An entry that carries an approval only runs through `approval:` — never as a bare command.
  return entry && !('approval' in entry) && typeof entry.command === 'string' ? { command: entry.command,
    ...(entry.dry_run_command ? { dry_run_command: entry.dry_run_command } : {}),
    ...(entry.timeout_ms ? { timeout_ms: entry.timeout_ms } : {}) } : undefined;
}

function resolveNodeRecipe(node: GraphNodeSpec, recipes: Record<string, Recipe>, catalogRoles: ReadonlySet<string>): { command?: CommandRecipe; approval?: { approval: string } } {
  if (node.recipe === 'none') return {};
  if (node.recipe.startsWith('cmd:')) {
    const id = node.recipe.slice(4);
    const entry = recipes[id];
    return entry && !('approval' in entry) && typeof entry.command === 'string' ? { command: { command: entry.command,
      ...(entry.dry_run_command ? { dry_run_command: entry.dry_run_command } : {}),
      ...(entry.timeout_ms ? { timeout_ms: entry.timeout_ms } : {}) } } : {};
  }
  if (node.recipe.startsWith('approval:')) {
    const id = node.recipe.slice(9);
    const entry = recipes[id];
    return entry && 'approval' in entry ? { approval: entry,
      ...('command' in entry && typeof entry.command === 'string' ? { command: { command: entry.command,
        ...(entry.dry_run_command ? { dry_run_command: entry.dry_run_command } : {}),
        ...(entry.timeout_ms ? { timeout_ms: entry.timeout_ms } : {}) } } : {}) } : {};
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
      if (typeof item.approval !== 'string' || !item.approval.trim() ||
        (item.command !== undefined && (typeof item.command !== 'string' || !item.command.trim())) ||
        (item.timeout_ms !== undefined && (!Number.isSafeInteger(item.timeout_ms) || (item.timeout_ms as number) <= 0)) ||
        (item.dry_run_command !== undefined && (typeof item.dry_run_command !== 'string' || !item.dry_run_command.trim())) ||
        (item.command === undefined && (item.timeout_ms !== undefined || item.dry_run_command !== undefined)) ||
        Object.keys(item).some(key => !['approval', 'command', 'dry_run_command', 'timeout_ms'].includes(key))) throw new Error(`invalid recipe: ${id}`);
      recipes[id] = { approval: item.approval,
        ...(item.command === undefined ? {} : { command: item.command as string }),
        ...(item.dry_run_command === undefined ? {} : { dry_run_command: item.dry_run_command as string }),
        ...(item.timeout_ms === undefined ? {} : { timeout_ms: item.timeout_ms as number }) };
    } else {
      if (typeof item.command !== 'string' || !item.command.trim() ||
        (item.timeout_ms !== undefined && (!Number.isSafeInteger(item.timeout_ms) || (item.timeout_ms as number) <= 0)) ||
        (item.dry_run_command !== undefined && (typeof item.dry_run_command !== 'string' || !item.dry_run_command.trim()))) {
        throw new Error(`invalid recipe: ${id}`);
      }
      recipes[id] = { command: item.command,
        ...(item.dry_run_command === undefined ? {} : { dry_run_command: item.dry_run_command as string }),
        ...(item.timeout_ms === undefined ? {} : { timeout_ms: item.timeout_ms as number }) };
    }
  }
  return recipes;
}

function realRunBash(onSpawn: (pid: number) => boolean): BashRun {
  return (body, opts) => new Promise((resolve, reject) => {
    let unverified: ReturnType<typeof setTimeout> | undefined;
    const child = execFile('/bin/bash', ['-c', body], { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, signal: opts.signal, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (unverified) clearTimeout(unverified);
      if (error && typeof (error as NodeJS.ErrnoException).code !== 'number') {
        reject(error);
        return;
      }
      resolve({ stdout, stderr, exitCode: error ? (error as unknown as { code: number }).code : 0 });
    });
    if (child.pid) {
      try {
        if (!onSpawn(child.pid)) {
          // A process can exit before ps observes it. A completed child is safe to report;
          // an unverified child still running must not be left without a tracked PID.
          unverified = setTimeout(() => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            child.kill('SIGTERM');
            reject(new Error(`cannot verify node process start: ${child.pid}`));
          }, 500);
        }
      } catch (error) { child.kill('SIGTERM'); reject(error); }
    }
  });
}

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

/** A synchronous, per-ledger critical section shared by runner writes and stop/destroy. */
function withRunWriteLock<T>(file: string, work: () => T): T {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.write.lock`;
  const staged = `${lock}.${randomUUID()}.staged`;
  mkdirSync(staged);
  const until = Date.now() + 5_000;
  let acquired = false;
  try {
    writeFileSync(join(staged, 'owner.json'), JSON.stringify({ pid: process.pid, started: Date.now() - process.uptime() * 1_000 }), { flag: 'wx' });
    while (!acquired) {
      try {
        // Unlike mkdir(lock) followed by a write, publication exposes an already complete owner.
        symlinkSync(staged, lock, 'dir');
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let owner: { pid: number; started: number } | undefined;
        try { owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')); } catch { /* legacy unowned directory */ }
        const ownerStart = owner && Number.isSafeInteger(owner.pid) && Number.isFinite(owner.started) ? psProcessStartMs(owner.pid) : undefined;
        let stale = ownerStart !== undefined && (ownerStart === null || Math.abs(ownerStart - owner!.started) > START_TOLERANCE_MS);
        if (!owner && !lstatSync(lock).isSymbolicLink()) {
          // Legacy mkdir-before-owner crash: do not evict a writer still publishing its owner.
          stale = Date.now() - statSync(lock).mtimeMs >= 5_000;
        }
        if (stale) {
          try {
            if (lstatSync(lock).isSymbolicLink()) {
              const target = readlinkSync(lock);
              if (!target.startsWith(`${lock}.`) || !target.endsWith('.staged')) throw new Error('invalid graph run write lock');
              unlinkSync(lock);
              rmSync(target, { recursive: true, force: true });
            } else {
              if (owner) unlinkSync(join(lock, 'owner.json'));
              rmdirSync(lock);
            }
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
          }
          continue;
        }
        if (Date.now() >= until) throw new Error(`graph run write lock is held: ${file}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return work();
  } finally {
    if (acquired && existsSync(lock) && lstatSync(lock).isSymbolicLink() && readlinkSync(lock) === staged) unlinkSync(lock);
    rmSync(staged, { recursive: true, force: true });
  }
}

function persistOwnedRun(state: GraphRunState, expected: Pick<GraphRunState, 'pid' | 'pidStartedAt' | 'stoppedAt'>, allowRestart = false): void {
  withRunWriteLock(state.statePath, () => {
    let disk: GraphRunState;
    try { disk = JSON.parse(readFileSync(state.statePath, 'utf8')) as GraphRunState; }
    catch (cause) { throw new Error(`run was removed or unreadable: ${state.graphId}/${state.runId}`, { cause }); }
    if (disk.graphId !== state.graphId || disk.runId !== state.runId || disk.pid !== expected.pid ||
        disk.pidStartedAt !== expected.pidStartedAt || disk.stoppedAt !== expected.stoppedAt ||
        (disk.stoppedAt !== undefined && !allowRestart)) {
      throw new Error(`run was stopped or ownership changed: ${state.graphId}/${state.runId}`);
    }
    persistGraphRun(state);
  });
}

export interface ExpectedGraphApprovalVisit { nodeId: string; visit: number }

export function decideGraphApproval(graphId: string, runId: string, decision: 'approved' | 'rejected', by?: string, root = effectiveInstanceRoot(), expected?: ExpectedGraphApprovalVisit): GraphRunState {
  const state = readGraphRun(graphId, runId, root);
  if (state.status !== 'awaiting-approval' || !state.pending || state.growthPark || state.pending.decision ||
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

/** Reconstruct the run-local edges from the ledger without rewriting the YAML snapshot. */
function withGrowth(graph: GraphTemplateSpec, growth: readonly GraphGrowth[]): GraphTemplateSpec {
  return growth.reduce<GraphTemplateSpec>((current, item) => {
    const edge = current.edges.find((candidate) => candidate.from === item.undo.removeOutcome.from);
    if (!edge || !edge.map || !item.node || item.undo.removeNode !== item.node.nodeId ||
        current.nodes.some((node) => node.nodeId === item.node.nodeId) ||
        Object.hasOwn(edge.map, item.undo.removeOutcome.outcome) ||
        !item.edges.some((added) => added.from === edge.from && added.map?.[item.undo.removeOutcome.outcome] === item.node.nodeId)) {
      throw new Error('invalid saved graph growth');
    }
    return { ...current, nodes: [...current.nodes, item.node], edges: current.edges.map((candidate) => candidate === edge
      ? { ...edge, map: { ...edge.map, [item.undo.removeOutcome.outcome]: item.node.nodeId } } : candidate)
      .concat(item.undo.removeEdge ? [item.undo.removeEdge] : []) };
  }, graph);
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
  if (options.variant && options.resumeRunId) throw new Error('variant cannot be combined with --resume');
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
  let graph = parsed.template;
  const variant = options.variant ? createGraphVariant({ template: graph, ...options.variant }) : undefined;
  if (variant && !variant.ok) throw new Error(`graph variant rejected: ${JSON.stringify(variant.rejections)}`);
  if (variant?.ok) graph = variant.template;
  const variantSource = variant?.ok ? stringifyYaml({ ...document,
    nodes: graph.nodes.map((node, index) => ({
      ...((document.nodes as Record<string, unknown>[])[index] ?? {}), node_id: node.nodeId, kind: node.kind,
      recipe: node.recipe, max_visits: node.maxVisits,
      ...(node.contract ? { contract: node.contract } : {}),
    })),
    edges: graph.edges.map((edge, index) => ({
      ...((document.edges as Record<string, unknown>[])[index] ?? {}), from: edge.from,
      ...(edge.to === undefined ? { on: edge.on, map: edge.map } : { to: edge.to }),
      ...(edge.fallback ? { fallback: edge.fallback } : {}),
    })),
  }) : source;
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
  const approvalSourceHash = createHash('sha256').update(variantSource).update('\0').update(recipeSource).digest('hex');
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
      graphSnapshot: { graphSha: createHash('sha256').update(variantSource).digest('hex'), recipesSha: createHash('sha256').update(recipeSource).digest('hex') },
      graphPath: resolve(path), ...(variant?.ok ? { variant: { overlayId: variant.overlay.overlayId, ...options.variant! } } : {}),
      ...(options.input === undefined ? {} : { input: options.input }), executed: 0, dryRun: options.dryRun === true, statePath };
  if (options.resumeRunId && graphMode === 'snapshot' && state.sourceHash && state.sourceHash !== approvalSourceHash) {
    throw new Error('graph snapshot changed since run started');
  }
  if (options.resumeRunId && options.dryRun !== undefined && options.dryRun !== state.dryRun) throw new Error('cannot change dryRun when resuming');
  if (options.resumeRunId && state.growth?.length && graphMode === 'current' && state.sourceHash !== approvalSourceHash) {
    throw new Error('graph or recipes changed since grown run');
  }
  if (state.growth?.length) graph = withGrowth(graph, state.growth);
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
    delete state.stoppedAt;
    Object.assign(state, runnerOwner);
    state.resume = { from: options.fromNodeId, at: new Date().toISOString(), previousStatus: 'failed', graph: graphMode };
    // Persist the restart boundary before executing it, so previous outputs remain durable.
    persistOwnedRun(state, saved!, true);
  }
  let resumedGrowth = false;
  if (options.resumeRunId && state.growthPark) {
    if (state.graphId !== graphId || state.runId !== runId || (graphMode === 'current' && state.sourceHash !== approvalSourceHash)) {
      throw new Error(`growth source changed since run was paused: ${graphId}/${runId}`);
    }
    const parked = state.growthPark;
    const decision = (options.deps?.growthDecision?.list?.({ status: 'all' }) ??
      new DecisionLedger({ stateDir: root }).list({ status: 'all' }))
      .find(entry => entry.id === parked.decisionId && entry.refs?.includes(parked.decisionRef));
    if (!decision || decision.status !== 'decided' || decision.decidedBy?.kind !== 'human' ||
        (decision.choice !== 'a' && decision.choice !== 'b')) {
      throw new Error(`growth is parked for human confirmation: ${graphId}/${runId}`);
    }
    if (typeof parked.decisionRef !== 'string' ||
        growthApprovalRef({ graphId, runId, from: parked.from, outcome: parked.outcome },
          parked.growth, parked.command, parked.approval) !== parked.decisionRef) {
      throw new Error(`growth approval target changed since card was raised: ${graphId}/${runId}`);
    }
    if (state.status !== 'awaiting-approval' || state.dryRun || state.path.at(-1) !== parked.from ||
        state.path.length !== state.nodes.length || state.nodes.at(-1)?.nodeId !== parked.from ||
        state.pending?.nodeId !== parked.from || state.growthRejections?.at(-1)?.from !== parked.from ||
        state.growthRejections.at(-1)?.outcome !== parked.outcome ||
        parked.growth.undo.removeOutcome.from !== parked.from || parked.growth.undo.removeOutcome.outcome !== parked.outcome) {
      throw new Error(`invalid parked growth: ${graphId}/${runId}`);
    }
    if (decision.choice === 'a') {
      const currentCommand = resolveNodeRecipe(parked.growth.node, recipes, catalogRoles).command;
      const currentApproval = resolveNodeRecipe(parked.growth.node, recipes, catalogRoles).approval?.approval;
      // The approved target is the (approval, command) pair as raised — a command appearing, vanishing or changing all fail.
      if (parked.growth.node.recipe !== 'none' &&
          (currentApproval !== parked.approval ||
            JSON.stringify(currentCommand ?? null) !== JSON.stringify(parked.command ?? null) ||
            (parked.approval === undefined && !parked.command))) {
        throw new Error(`growth command changed since approval: ${graphId}/${runId}`);
      }
      graph = withGrowth(graph, [parked.growth]);
      state.growth ??= [];
      state.growth.push(parked.growth);
      state.growthRejections!.pop();
    }
    resumedGrowth = true;
    delete state.pending;
    delete state.growthPark;
    state.status = 'running';
    persistOwnedRun(state, saved!);
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
    persistOwnedRun(state, saved!);
  }
  if (options.resumeRunId) debug.log('graph.runs', 'resume', { graphId, runId, from: state.resume?.from, graph: graphMode });
  const persist = () => {
    if (state.status === 'done' || state.status === 'failed' || state.status === 'budget-exceeded') state.finishedAt ??= new Date().toISOString();
    persistOwnedRun(state, runnerOwner);
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
    writeFileSync(join(`${statePath}.graph`, 'graph.yaml'), variantSource, { flag: 'wx' });
    writeFileSync(join(`${statePath}.graph`, 'recipes.yaml'), recipeSource, { flag: 'wx' });
  }
  while (current !== undefined) {
    const node = graph.nodes.find((n) => n.nodeId === current);
    if (!node) throw new Error(`undeclared node: ${current}`);
    const resumingPending = state.pending?.nodeId === current;
    const completed = state.nodes.at(-1);
    const resumingCompleted = options.resumeRunId !== undefined && !options.fromNodeId && completed?.nodeId === current &&
      state.path.at(-1) === current && !resumingPending;
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
    publishInsideEvent({ kind: 'node', graphId, runId, nodeId: current, phase: 'start' });
    log('node-start', { graphId, runId, nodeId: current, visit: visits.get(current), dryRun: state.dryRun });
    persist();
    let ok = approval && !state.dryRun ? state.pending?.decision === 'approved' : true;
    let exit: number | null = null;
    let error: string | undefined;
    let output: unknown;
    if (command && (!approval || state.dryRun || ok) && (!state.dryRun || command.dry_run_command) && !resumingCompleted) {
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
        const execute = options.deps?.runBash ?? realRunBash((pid) => {
          // Publish the child before its start time is known, so a concurrent stop refuses instead of failing
          // the ledger while an untracked node keeps working (REL8b review round 3).
          state.activeNode = { nodeId: current!, pid, pidStartedAt: UNVERIFIED_NODE_START };
          persist();
          const started = (options.deps?.processStartMs ?? psProcessStartMs)(pid);
          if (started === null) return false;
          state.activeNode = { nodeId: current!, pid, pidStartedAt: new Date(started).toISOString() };
          persist();
          return true;
        });
        try {
          const result = await execute(body, opts);
          code = result.exitCode;
          return { ...result, stdout: redactCredentials(result.stdout), stderr: redactCredentials(result.stderr) };
        } finally {
          if (state.activeNode?.nodeId === current) {
            delete state.activeNode;
            persist();
          }
        }
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
      env.ELANOUS_GRAPH_DRY_RUN = state.dryRun ? '1' : '0';
      env.ELANOUS_GRAPH_DIR = dirname(resolve(path));
      const ctx = { arguments: '', artifactsDir: dirname(statePath), outputs: {}, resolvedProvider: undefined, resolvedModel: undefined, toolPolicy: {}, env } as NodeExecContext;
      const result = await executeBashNode({ id: current, type: 'bash', bash: state.dryRun ? command.dry_run_command! : command.command, ...(command.timeout_ms ? { idle_timeout: command.timeout_ms } : {}) } as BashNode, ctx, { runBash } as WorkflowDeps);
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
      state.nodes.push({ nodeId: current, ok, exit, executed: !!command && (!state.dryRun || !!command.dry_run_command), ...((command || approval) && (!state.dryRun || !!command?.dry_run_command) && output !== undefined ? { output } : {}), ...(error ? { error } : {}),
        ...(approval && state.pending ? { ...(state.pending.decidedBy === undefined ? {} : { decidedBy: state.pending.decidedBy }), decidedAt: state.pending.decidedAt } : {}) });
    }
    if (approval) {
      delete state.pending;
      delete state.approvalSourceHash;
    }
    const reported = command && (!state.dryRun || command.dry_run_command) ? lastJsonObject(resumingCompleted ? completed?.output : output)?.outcome : undefined;
    const namedOutcome = typeof reported === 'string' ? reported : undefined;
    const seconds = Number(((performance.now() - startedAt) / 1000).toFixed(2));
    console.error(`[graph] ${current} ${ok ? 'ok' : 'fail'} (${seconds.toFixed(2)}s)`);
    debug.log('graph.run', 'node', { graphId, runId, nodeId: current, phase: ok ? 'ok' : 'fail', seconds, exit });
    publishInsideEvent({ kind: 'node', graphId, runId, nodeId: current, phase: ok ? 'ok' : 'fail', seconds });
    publishInsideEvent({ kind: 'verdict', graphId, runId, nodeId: current, verdict: ok ? 'ok' : 'fail', ...(namedOutcome === undefined ? {} : { outcome: namedOutcome }) });
    log('node-end', { graphId, runId, nodeId: current, ok, exit, ...(namedOutcome === undefined ? {} : { outcome: namedOutcome }), dryRun: state.dryRun });
    persist();
    if (graph.terminalNodes.includes(current)) {
      state.status = current === 'failed' || !ok ? 'failed' : 'done';
      persist();
      break;
    }
    const fromNodeId = current;
    const edge = graph.edges.find((candidate) => candidate.from === current);
    if (!resumedGrowth && document.grow === 'on' && !state.dryRun && namedOutcome !== undefined &&
        edge?.on === 'outcome' && edge.map && !Object.hasOwn(edge.map, namedOutcome) &&
        !state.growth?.some((item) => item.undo.removeOutcome.from === current && item.undo.removeOutcome.outcome === namedOutcome) &&
        !state.growthRejections?.some((item) => item.from === current && item.outcome === namedOutcome)) {
      const result = (state.growth?.length ?? 0) >= 3 ? { ok: false as const, reason: 'growth limit 3 reached' }
        : await proposeGrowth({ graph, nodeId: current, outcome: namedOutcome, runId, output: state.nodes.at(-1)?.output },
          options.deps?.growthProposer ?? createLLMGrowthProposer(options.deps?.growthLLM), (candidate) => {
            const resolved = resolveNodeRecipe(candidate, recipes, catalogRoles);
            if (!resolved.command && !resolved.approval && candidate.recipe !== 'none') return 'unknown';
            return { effect: resolved.approval ? 'unknown' : options.deps?.classifyGrowthRecipe?.(candidate, { command: resolved.command?.command }) ?? 'unknown',
              command: resolved.command, approval: resolved.approval?.approval };
          }, { ...options.deps?.growthDecision, root });
      if (result.ok) {
        graph = result.graph;
        state.growth ??= [];
        state.growth.push(result.growth);
        persist();
        log('edge-added', { graphId, runId, from: current, outcome: namedOutcome, to: result.growth.node.nodeId });
        debug.log('graph.run', 'edge-added', { graphId, runId, from: current, outcome: namedOutcome, to: result.growth.node.nodeId });
        publishInsideEvent({ kind: 'edge-added', graphId, runId, from: current, outcome: namedOutcome, to: result.growth.node.nodeId });
      } else {
        state.growthRejections ??= [];
        state.growthRejections.push({ from: current, outcome: namedOutcome, reason: result.reason });
        if (result.park && result.growth && result.decisionId && result.decisionRef) {
          state.status = 'awaiting-approval';
          state.pending = { nodeId: current, message: result.reason, since: new Date().toISOString() };
          state.growthPark = { from: current, outcome: namedOutcome, reason: result.reason,
            growth: result.growth, decisionId: result.decisionId, decisionRef: result.decisionRef,
            ...(result.command ? { command: result.command } : {}), ...(result.approval ? { approval: result.approval } : {}) };
          persist();
          break;
        }
      }
      persist();
    }
    current = nextNode(graph.edges, current, state.dryRun && !command?.dry_run_command ? 'ok' : ok ? 'ok' : 'fail', namedOutcome);
    resumedGrowth = false;
    if (current !== undefined) publishInsideEvent({ kind: 'edge', graphId, runId, from: fromNodeId, to: current });
    if (current === undefined) {
      state.status = 'failed';
      persist();
    }
  }
  return state;
  } finally {
    if (options.resumeRunId && existsSync(resumeLock)) rmdirSync(resumeLock);
  }
}

export type GraphRunAlive = boolean | 'unknown';

/** activeNode.pidStartedAt while the node child is spawned but its start time is not read yet — stop must not pass it. */
const UNVERIFIED_NODE_START = 'unverified';
/** A failed run's empty resume lock younger than this may belong to a resume that has not persisted «running» yet. */
const RESUME_LOCK_GRACE_MS = 60_000;

function runArtifacts(state: GraphRunState): string[] {
  const file = state.statePath;
  const claims = readdirSync(dirname(file))
    .filter(name => name.startsWith(`${state.runId}.json.`) && /^\d+\.decision\.json$/.test(name.slice(`${state.runId}.json.`.length)))
    .map(name => join(dirname(file), name));
  for (const claim of claims) {
    if (lstatSync(claim).isSymbolicLink()) throw new Error('graph run artifact is a symlink');
    let value: unknown;
    try { value = JSON.parse(readFileSync(claim, 'utf8')); }
    catch { throw new Error(`invalid graph run decision claim: ${claim}`); }
    const visit = Number(claim.slice(`${file}.`.length, -'.decision.json'.length));
    if (!isDecisionClaim(value) || !Number.isSafeInteger(visit) || visit < 1 ||
        (value as { nodeId: string }).nodeId !== state.path[visit - 1]) {
      throw new Error(`invalid graph run decision claim: ${claim}`);
    }
  }
  return [file, `${file}.graph`, `${file}.contexts`, ...claims];
}

/** Manage only an identity-checked ledger in this instance, never a caller-supplied path. */
export function manageGraphRun(graphId: string, runId: string, action: 'stop' | 'destroy',
  root = effectiveInstanceRoot(), processStartMs: (pid: number) => number | null = psProcessStartMs,
  signal: (pid: number) => void = (pid) => process.kill(pid, 'SIGTERM')): GraphRunState {
  const file = graphRunPath(safeSegment(graphId), safeSegment(runId), root);
  return withRunWriteLock(file, () => {
  if (lstatSync(join(root, 'graph-runs')).isSymbolicLink() || lstatSync(dirname(file)).isSymbolicLink() || lstatSync(file).isSymbolicLink()) throw new Error('graph run path is a symlink');
  const state = readGraphRun(graphId, runId, root);
  if (state.statePath !== file || !Array.isArray(state.path) || !Array.isArray(state.nodes) ||
      !Number.isSafeInteger(state.executed) || state.executed < 0 || (state.status === 'running' && state.pending)) {
    throw new Error(`invalid run state: ${graphId}/${runId}`);
  }
  for (const path of runArtifacts(state)) {
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('graph run artifact is a symlink'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const live = graphRunAlive(state, processStartMs);
  if (action === 'stop' && state.status !== 'running') throw new Error(`run is not running: ${graphId}/${runId}`);
  const lock = `${file}.resume.lock`;
  if (existsSync(lock) && (!lstatSync(lock).isDirectory() || readdirSync(lock).length > 0)) throw new Error('invalid resume lock');
  if (existsSync(lock) && state.status !== 'running') {
    // A resume persists «running» right after taking the lock; an older empty lock on a finished run is a crash leftover.
    const ageMs = Date.now() - statSync(lock).mtimeMs;
    if (ageMs < RESUME_LOCK_GRACE_MS) throw new Error(`run is being resumed: ${graphId}/${runId}`);
    rmdirSync(lock);
    debug.log('graph.runs', 'stale-resume-lock-cleared', { graphId, runId, ageMs: Math.round(ageMs), status: state.status });
  }
  if (state.status === 'running') {
    if (live === 'unknown') throw new Error(`cannot verify run owner: ${graphId}/${runId}`);
    if (live && state.pid === process.pid) throw new Error('cannot stop the current graph runner');
    const node = state.activeNode;
    if (node && (node.nodeId !== state.path.at(-1) || state.path.length !== state.nodes.length + 1)) throw new Error('active node does not match saved path');
    if (state.path.length !== state.nodes.length && state.path.length !== state.nodes.length + 1) {
      throw new Error('saved run path and node records do not match');
    }
    if (state.path.some((nodeId, i) => state.nodes[i] && state.nodes[i]?.nodeId !== nodeId) ||
        state.executed !== state.nodes.filter(record => record.executed).length) throw new Error('saved run path and node records do not match');
    if (node?.pidStartedAt === UNVERIFIED_NODE_START) {
      // While the runner lives it will either verify this child or kill it; retry stop after that.
      if (live) throw new Error(`node process start is not verified yet — retry stop: ${graphId}/${runId}`);
      // Runner gone (e.g. reboot): the pid may be reused, so never signal an identity we could not verify.
      debug.log('graph.runs', 'unverified-node-not-signaled', { graphId, runId, nodeId: node.nodeId, pid: node.pid });
    } else if (node) {
      const nodeAlive = graphRunAlive({ ...state, pid: node.pid, pidStartedAt: node.pidStartedAt }, processStartMs);
      if (nodeAlive === 'unknown') throw new Error('cannot verify node process owner');
      if (nodeAlive && node.pid === process.pid) throw new Error('cannot stop the current process');
      if (nodeAlive && node.pid !== state.pid) {
        try { signal(node.pid); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    if (state.path.length === state.nodes.length + 1) {
      state.nodes.push({ nodeId: state.path.at(-1)!, ok: false, exit: null, executed: false, error: 'stopped before node completed' });
    }
    state.status = 'failed';
    state.finishedAt = new Date().toISOString();
    state.stoppedAt = state.finishedAt;
    delete state.activeNode;
    persistGraphRun(state);
    try {
      if (live) signal(state.pid!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    } finally {
      // The failed ledger is durable even if its runner vanished between verification and signaling.
      if (existsSync(lock)) rmdirSync(lock);
    }
  } else if (existsSync(lock)) rmdirSync(lock);
  if (action === 'destroy') {
    for (const path of runArtifacts(state)) rmSync(path, { recursive: true, force: true });
  }
  debug.log('graph.runs', action, { graphId, runId, previousAlive: live, status: state.status });
  return state;
  });
}

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
