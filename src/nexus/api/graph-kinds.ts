import { parse as parseYaml } from 'yaml';
import { debug } from '../../debug/log.js';
import { listNodeKinds, type GraphKind } from '../../graph-kinds/registry.js';
import { parseGraphTemplateYaml } from '../../self-implement/graph-yaml.js';
import { parseWorkflowYaml } from '../../workflow-runtime/parser.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { jsonResponse } from './json-response.js';

function isGraph(value: unknown): value is GraphKind {
  return value === 'harness' || value === 'workflow';
}

export function handleGraphKindsGet(req: Request, opts: MetaApiOpts): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  const graph = url.searchParams.get('graph');
  if (graph !== null && !isGraph(graph)) return jsonResponse({ error: 'bad_request', reason: 'graph must be harness or workflow' }, 400);
  return jsonResponse({ kinds: listNodeKinds(graph ?? undefined).map(({ graph, kind, plugin, description, schema, core }) => ({ graph, kind, plugin, description, schema, core })) });
}

const harnessShape = {
  graph_id: true, version: true, entry_node: true, terminal_nodes: true,
  docs_only_gate_skip: true, state: true,
  loop: { title: true, description: true, trigger: { cron: true, events: true } },
  run_contract: { substrate: true, profile: true, effects: true },
  nodes: [{ node_id: true, kind: true, recipe: true, max_visits: true, progress: true, phases: true, terminal_stages: true, fan_out: true,
    contract: { inputs: true, tools: true, outputs: true } }],
  edges: [{ from: true, to: true, on: true, map: '*' as const, observed: true,
    fallback: [{ node: true, requires: true, observed: true }] }],
};

// The workflow validator keeps each node's input object intact, while it
// normalizes the top-level fields and picks only the supported _meta fields.
const workflowShape = {
  name: true, description: true, provider: true, model: true, interactive: true,
  nodes: ['*' as const], _meta: { missionId: true, intakeId: true, sourceTaskKey: true },
};

function ignoredPaths(input: unknown, shape: unknown, path = ''): string[] {
  if (shape === '*' || shape === true) return [];
  if (Array.isArray(input)) {
    if (!Array.isArray(shape)) return [];
    return input.flatMap((value, index) => ignoredPaths(value, shape[0], `${path}[${index}]`));
  }
  if (!input || typeof input !== 'object' || Array.isArray(shape) || !shape || typeof shape !== 'object') return [];
  const allowed = shape as Record<string, unknown>;
  return Object.entries(input as Record<string, unknown>).flatMap(([key, value]) => {
    const child = path ? `${path}.${key}` : key;
    return Object.hasOwn(allowed, key) ? ignoredPaths(value, allowed[key], child) : [child];
  });
}

export async function handleGraphsValidatePost(req: Request, opts: MetaApiOpts): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  let body: unknown;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'bad_request', reason: 'JSON body required' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !isGraph((body as Record<string, unknown>).graph) || typeof (body as Record<string, unknown>).yaml !== 'string') {
    return jsonResponse({ error: 'bad_request', reason: 'graph (harness|workflow) and yaml (string) required' }, 400);
  }
  const { graph, yaml } = body as { graph: GraphKind; yaml: string };
  const result = graph === 'harness' ? parseGraphTemplateYaml(yaml) : parseWorkflowYaml(yaml);
  const errors = graph === 'harness' ? (result as ReturnType<typeof parseGraphTemplateYaml>).errors : (result as ReturnType<typeof parseWorkflowYaml>).issues;
  let input: unknown;
  try { input = parseYaml(yaml); } catch { /* The parser already reports the YAML error. */ }
  const ignoredKeys = ignoredPaths(input, graph === 'harness' ? harnessShape : workflowShape);
  const ok = errors.length === 0;
  debug.log('graph.kinds', 'validate', { graph, ok, errors, ignored: ignoredKeys });
  return jsonResponse({ ok, errors, ignoredKeys }, ok ? 200 : 422);
}
