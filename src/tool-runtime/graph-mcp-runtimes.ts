// External graph control uses the same wizard, editor run API, and runner as the local UI.
// The MCP HTTP boundary filters mutating tools by token scope before dispatch.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMToolSpec } from '../llm.js';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { generateGraphFromPrompt } from '../graph-wizard/generate.js';
import { handleGraphsCreate } from '../nexus/api/graphs-api.js';
import { handleGraphRunGet, handleGraphRunStart } from '../graph-runner/graph-run-api.js';
import { proposeGrowth } from '../graph-runner/graph-grow.js';
import { runGraph, type GraphRunState } from '../graph-runner/runner.js';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';

const GRAPH_ID = /^[a-z0-9-]+$/;
const RUN_ID = /^ed-[a-z0-9]+-[a-f0-9]{6}$/;
type Args = Record<string, unknown>;
type Result = { output: string; [key: string]: unknown };
export interface GraphMcpDeps {
  root?: string;
  mineDir?: string;
  recipesFile?: string;
  generate?: typeof generateGraphFromPrompt;
  growth?: typeof proposeGrowth;
  run?: typeof runGraph;
}
let testDeps: GraphMcpDeps = {};
export function setGraphMcpDepsForTest(deps: GraphMcpDeps | undefined): void { testDeps = deps ?? {}; }
const rootOf = () => testDeps.root ?? effectiveInstanceRoot();

function value(args: Args, key: string): string | null {
  const item = args[key];
  return typeof item === 'string' && item.trim() ? item.trim() : null;
}

function error(tool: string, reason: string): Result {
  return { output: `${tool}: ${reason}`, error: reason };
}

function observe(tool: string, action: string, ctx: ToolRuntimeContext, fields: Record<string, unknown>): void {
  debug.log('mcp.graph', action, { tool, caller: ctx.mcpClient ?? 'unknown', ...fields });
}

function spec(name: string, description: string, properties: Record<string, unknown>, required: string[]): LLMToolSpec {
  return { name, description, parameters: { type: 'object', properties, required } };
}

const composeSpec = spec('graph_compose', 'Preview a validated graph from one research goal. Does not save or run it.',
  { goal: { type: 'string' } }, ['goal']);
const startSpec = spec('graph_run_start', 'Start an existing saved graph, or save and start a graph_compose result. Requires a write-scoped MCP token.',
  { graphId: { type: 'string' }, compose: { type: 'object', description: 'graph_compose result: id, yaml, optional validated steps.' },
    reason: { type: 'string' } }, ['reason']);
const statusSpec = spec('graph_run_status', 'Read bounded node states, outputs, and source IDs for a graph run.',
  { graphId: { type: 'string' }, runId: { type: 'string' } }, ['graphId', 'runId']);
const nodeSpec = spec('graph_node_op', 'Operate on a saved run: retry from a failed node, or add a validated growth node as a new linked run. Requires a write-scoped MCP token.',
  { graphId: { type: 'string' }, runId: { type: 'string' }, op: { type: 'string', enum: ['retry', 'add-node'] },
    nodeId: { type: 'string' }, outcome: { type: 'string' }, reason: { type: 'string' } },
  ['graphId', 'runId', 'op', 'nodeId', 'reason']);

function storedRun(graphId: string, runId: string, root: string): GraphRunState | null {
  if (!GRAPH_ID.test(graphId) || !RUN_ID.test(runId)) return null;
  try {
    const state = JSON.parse(readFileSync(join(root, 'graph-runs', graphId, `${runId}.json`), 'utf8')) as GraphRunState;
    return state.graphId === graphId && state.runId === runId ? state : null;
  } catch { return null; }
}

async function compose(args: Args, ctx: ToolRuntimeContext): Promise<Result> {
  const goal = value(args, 'goal');
  if (!goal) return error('graph_compose', 'goal is required');
  try {
    const result = await (testDeps.generate ?? generateGraphFromPrompt)({ prompt: goal, kind: 'harness' });
    observe('graph_compose', result.ok ? 'composed' : 'rejected', ctx, { graphId: result.id, reason: result.summary });
    return { output: result.summary, ...result, compose: result.ok
      ? { id: result.id, yaml: result.yaml, ...(result.steps ? { steps: result.steps } : {}) } : null };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    observe('graph_compose', 'failed', ctx, { reason });
    return error('graph_compose', reason);
  }
}

async function start(args: Args, ctx: ToolRuntimeContext): Promise<Result> {
  const reason = value(args, 'reason');
  const supplied = args.compose;
  const candidate = supplied && typeof supplied === 'object' && !Array.isArray(supplied)
    ? supplied as Record<string, unknown> : null;
  const graphId = candidate ? value(candidate, 'id') : value(args, 'graphId');
  if (!reason || !graphId || !GRAPH_ID.test(graphId)) return error('graph_run_start', 'valid graphId and reason are required');
  if (candidate) {
    if (typeof candidate.yaml !== 'string') return error('graph_run_start', 'compose.yaml is required');
    const created = await handleGraphsCreate(new Request('http://localhost/v1/graphs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: graphId, yaml: candidate.yaml, ...(candidate.steps ? { steps: candidate.steps } : {}) }),
    }), { ...(testDeps.mineDir ? { mineDir: testDeps.mineDir } : {}) });
    if (!created.ok) {
      const detail = await created.text();
      observe('graph_run_start', 'refused', ctx, { graphId, reason, status: created.status });
      return error('graph_run_start', `save refused (${created.status}): ${detail.slice(0, 300)}`);
    }
  }
  const response = handleGraphRunStart(graphId, {
    ...(testDeps.mineDir ? { mineDir: testDeps.mineDir } : {}),
    root: rootOf(),
    ...(testDeps.recipesFile ? { recipesFile: testDeps.recipesFile } : {}),
  });
  const body = await response.json() as Record<string, unknown>;
  observe('graph_run_start', response.ok ? 'started' : 'refused', ctx,
    { graphId, runId: body.runId ?? null, reason, status: response.status });
  return { output: response.ok ? `Started ${graphId} run ${body.runId}` : `Start refused: ${JSON.stringify(body)}`,
    ...body, status: response.status };
}

async function status(args: Args, ctx: ToolRuntimeContext): Promise<Result> {
  const graphId = value(args, 'graphId');
  const runId = value(args, 'runId');
  if (!graphId || !runId || !GRAPH_ID.test(graphId) || !RUN_ID.test(runId)) return error('graph_run_status', 'invalid graphId or runId');
  const response = handleGraphRunGet(graphId, runId, { root: rootOf() });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const reason = typeof body.reason === 'string' ? body.reason
      : typeof body.error === 'string' ? body.error : `request failed (${response.status})`;
    observe('graph_run_status', 'refused', ctx, { graphId, runId, status: response.status, error: reason });
    return error('graph_run_status', reason);
  }
  const state = storedRun(graphId, runId, rootOf());
  let truncated = false;
  const clip = (text: string, max: number) => {
    if (text.length > max) truncated = true;
    return text.slice(0, max);
  };
  const allNodes = state?.nodes.map(node => {
    const record = node.output && typeof node.output === 'object' && !Array.isArray(node.output)
      ? node.output as Record<string, unknown> : null;
    const sourceIds = [record?.sourceIds, record?.refs, record?.citations]
      .flatMap(item => Array.isArray(item) ? item.filter((id): id is string => typeof id === 'string') : [])
      .slice(0, 30);
    const encodedOutput = node.output === undefined ? undefined : JSON.stringify(node.output);
    if (sourceIds.length > 10) truncated = true;
    return { nodeId: clip(node.nodeId, 160), ok: node.ok, exit: node.exit, executed: node.executed,
      ...(node.error ? { error: clip(node.error, 300) } : {}),
      sourceIds: sourceIds.slice(0, 10).map(id => clip(id, 120)),
      ...(encodedOutput === undefined ? {} : { output: clip(encodedOutput, 800) }) };
  }) ?? [];
  const rawPath = Array.isArray(body.path) ? body.path : [];
  const errorText = typeof body.error === 'string' ? body.error : undefined;
  let nodes = [...allNodes].sort((a, b) => Number(b.ok === false) - Number(a.ok === false)).slice(0, 30);
  let path = rawPath.slice(0, 100).map(nodeId => clip(String(nodeId), 160));
  if (allNodes.length > nodes.length || rawPath.length > path.length) truncated = true;
  const statusValue = clip(String(body.status ?? 'unknown'), 40);
  const graphIdValue = clip(graphId, 120);
  const runIdValue = clip(runId, 120);
  const startedAt = typeof body.startedAt === 'string' ? clip(body.startedAt, 100) : undefined;
  const finishedAt = typeof body.finishedAt === 'string' ? clip(body.finishedAt, 100) : undefined;
  const boundedError = errorText ? clip(errorText, 1000) : undefined;
  const serialize = () => JSON.stringify({
    graphId: graphIdValue, runId: runIdValue, status: statusValue,
    ...(startedAt ? { startedAt } : {}), ...(finishedAt ? { finishedAt } : {}),
    ...(boundedError ? { error: boundedError } : {}), path, nodes, truncated,
  });
  let encoded = serialize();
  while (Buffer.byteLength(encoded, 'utf8') > 24000 && nodes.length > 0) {
    nodes = nodes.slice(0, -1);
    truncated = true;
    encoded = serialize();
  }
  while (Buffer.byteLength(encoded, 'utf8') > 24000 && path.length > 0) {
    path = path.slice(0, -1);
    truncated = true;
    encoded = serialize();
  }
  if (Buffer.byteLength(encoded, 'utf8') > 24000) {
    truncated = true;
    path = [];
    nodes = [];
    encoded = serialize();
  }
  observe('graph_run_status', 'read', ctx, { graphId, runId, status: body.status ?? response.status });
  return { output: encoded, ...JSON.parse(encoded) as Record<string, unknown> };
}

async function nodeOp(args: Args, ctx: ToolRuntimeContext): Promise<Result> {
  const graphId = value(args, 'graphId');
  const runId = value(args, 'runId');
  const op = value(args, 'op');
  const nodeId = value(args, 'nodeId');
  const reason = value(args, 'reason');
  if (!graphId || !runId || !GRAPH_ID.test(graphId) || !RUN_ID.test(runId) || !nodeId || !reason
    || !['retry', 'add-node'].includes(op ?? '')) return error('graph_node_op', 'invalid graphId, runId, op, nodeId, or reason');
  if (op === 'add-node' && !value(args, 'outcome'))
    return error('graph_node_op', 'add-node requires the observed node outcome');
  const root = rootOf();
  const state = storedRun(graphId, runId, root);
  if (!state || state.status !== 'failed' || !state.path.includes(nodeId))
    return error('graph_node_op', 'a failed run and node on its saved path are required');
  const graphFile = join(root, 'graph-run-work', graphId, runId, 'graph.yaml');
  if (op === 'retry') {
    try {
      // Runner enforces the saved source hash, approval boundary, and failed-path limit.
      const next = await (testDeps.run ?? runGraph)(graphFile, { resumeRunId: runId, fromNodeId: nodeId, deps: { root } });
      observe('graph_node_op', op, ctx, { graphId, runId, nodeId, reason, status: next.status });
      return { output: `${op}: ${next.status}`, graphId, runId, status: next.status, path: next.path };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      observe('graph_node_op', 'refused', ctx, { graphId, runId, nodeId, op, reason, error: message });
      return error('graph_node_op', message);
    }
  }
  try {
    const parsed = parseGraphTemplateYaml(readFileSync(graphFile, 'utf8'), graphFile);
    if (!parsed.template || parsed.errors.length) return error('graph_node_op', 'saved graph is invalid');
    const nodeOutput = [...state.nodes].reverse().find(node => node.nodeId === nodeId)?.output;
    const outcome = value(args, 'outcome')!;
    const growth = await (testDeps.growth ?? proposeGrowth)({ graph: parsed.template, nodeId, outcome, runId, output: nodeOutput },
      undefined, () => 'unknown', { root });
    if (!growth.ok) {
      observe('graph_node_op', 'refused', ctx, { graphId, runId, nodeId, op, reason, detail: growth.reason });
      return error('graph_node_op', growth.reason);
    }
    const returnTo = growth.growth.edges.find(edge => edge.from === growth.growth.node.nodeId)?.to;
    if (!returnTo) return error('graph_node_op', 'growth has no return node');
    const next = await (testDeps.run ?? runGraph)(graphFile, { variant: { goal: `mcp_${runId}`,
      plan: { growth: { node: growth.growth.node, from: nodeId, outcome,
        returnTo } } }, input: { source: 'mcp', parentRunId: runId, reason }, deps: { root } });
    observe('graph_node_op', 'add-node', ctx, { graphId, runId: next.runId, parentRunId: runId, nodeId, reason, status: next.status });
    return { output: `add-node: ${next.status}`, graphId, runId: next.runId, parentRunId: runId, status: next.status };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    observe('graph_node_op', 'refused', ctx, { graphId, runId, nodeId, op, reason, error: message });
    return error('graph_node_op', message);
  }
}

export const GRAPH_MCP_RUNTIMES: ToolRuntime<Args, Result>[] = [
  { id: 'graph_compose', spec: composeSpec, surfaces: ['mcp'], run: compose },
  { id: 'graph_run_start', spec: startSpec, surfaces: ['mcp'], run: start },
  { id: 'graph_run_status', spec: statusSpec, surfaces: ['mcp'], run: status },
  { id: 'graph_node_op', spec: nodeSpec, surfaces: ['mcp'], run: nodeOp },
];
