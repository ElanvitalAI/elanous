import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { jsonResponse } from '../nexus/api/json-response.js';
import { listInstalledPlugins } from '../plugins/install/plugin-install.js';
import { graphContractValueMatches, type GraphContractSchema } from './capabilities.js';
import { loadGraphPluginFromDir } from './graph-manifest-loader.js';
import { graphTick } from './graph-tick.js';
import { runGraph } from './runner.js';

const GRAPH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const validGraphId = (value: unknown): value is string =>
  typeof value === 'string' && GRAPH_ID.test(value) && !['.', '..'].includes(value);

/** Only installed graph plugins can acquire a daemon or API entry. */
export function installedGraphFiles(root = elanousStateRoot()): string[] {
  const files: string[] = [];
  for (const plugin of listInstalledPlugins(root)) {
    const manifest = join(plugin.path, 'plugin.json');
    if (!existsSync(manifest)) continue;
    try {
      const raw = JSON.parse(readFileSync(manifest, 'utf8')) as { extensions?: { 'ai.elanous'?: { graphManifests?: unknown } } };
      if (!raw.extensions?.['ai.elanous']?.graphManifests) continue;
      files.push(...Object.values(loadGraphPluginFromDir(plugin.path).graphs).map(graph => graph.file));
    } catch (error) {
      debug.log('graph.entry', 'plugin-invalid', { plugin: plugin.name, error: String(error) }, { level: 'warn' });
    }
  }
  return [...new Set(files)].sort();
}

function validSchema(value: unknown, depth = 0): value is GraphContractSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 8) return false;
  const schema = value as Record<string, unknown>;
  if (Object.keys(schema).some(key => !['type', 'required', 'properties', 'items', 'enum'].includes(key)) ||
    typeof schema.type !== 'string' || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type)) return false;
  if (schema.required !== undefined && (schema.type !== 'object' || !Array.isArray(schema.required) ||
    !schema.required.every(key => typeof key === 'string' && key.length > 0))) return false;
  if (schema.properties !== undefined && (schema.type !== 'object' || !schema.properties ||
    typeof schema.properties !== 'object' || Array.isArray(schema.properties) ||
    !Object.values(schema.properties).every(child => validSchema(child, depth + 1)))) return false;
  if (schema.items !== undefined && (schema.type !== 'array' || !validSchema(schema.items, depth + 1))) return false;
  return schema.enum === undefined || (Array.isArray(schema.enum) && schema.enum.length > 0);
}

/** API routes use a fixed path derived from graph_id; YAML may only declare auth and input shape. */
export function graphApiTrigger(document: unknown): { graphId: string; inputSchema: GraphContractSchema } | undefined {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('invalid graph YAML');
  const graph = document as Record<string, unknown>;
  const triggers = graph.triggers;
  if (triggers === undefined) return undefined;
  if (!triggers || typeof triggers !== 'object' || Array.isArray(triggers)) throw new Error('graph triggers must be an object');
  const api = (triggers as Record<string, unknown>).api;
  if (api === undefined) return undefined;
  if (!validGraphId(graph.graph_id))
    throw new Error('graph API trigger requires a valid graph_id');
  if (!api || typeof api !== 'object' || Array.isArray(api)) throw new Error('graph triggers.api must be an object');
  const declaration = api as Record<string, unknown>;
  if (Object.keys(declaration).sort().join(',') !== 'auth,input_schema' || declaration.auth !== 'operator' ||
    !validSchema(declaration.input_schema) || declaration.input_schema.type !== 'object')
    throw new Error('graph triggers.api requires auth: operator and an object input_schema');
  return { graphId: graph.graph_id, inputSchema: declaration.input_schema };
}

export interface PluginGraphApiDeps {
  graphFiles?: readonly string[];
  stateRoot?: string;
  run?: typeof runGraph;
}

/** Called only after the NEXUS operator credential gate. */
export async function handlePluginGraphApiRun(request: Request, rawId: string, deps: PluginGraphApiDeps = {}): Promise<Response> {
  let graphId: string;
  try { graphId = decodeURIComponent(rawId); } catch { return jsonResponse({ error: 'bad_request' }, 400); }
  if (!validGraphId(graphId)) return jsonResponse({ error: 'bad_request' }, 400);
  const matches: Array<{ file: string; document: unknown }> = [];
  for (const file of deps.graphFiles ?? installedGraphFiles()) {
    let document: unknown;
    try { document = parseYaml(readFileSync(file, 'utf8')) as unknown; }
    catch (error) {
      debug.log('graph.entry', 'graph-unreadable', { file, error: String(error) }, { level: 'warn' });
      continue;
    }
    if (document && typeof document === 'object' && !Array.isArray(document) &&
      (document as Record<string, unknown>).graph_id === graphId) matches.push({ file, document });
  }
  if (matches.length === 0) return jsonResponse({ error: 'not-found' }, 404);
  if (matches.length !== 1) return jsonResponse({ error: 'ambiguous-graph-id' }, 409);
  let declaration: ReturnType<typeof graphApiTrigger>;
  try { declaration = graphApiTrigger(matches[0]!.document); }
  catch (error) { return jsonResponse({ error: 'invalid-graph-trigger', reason: String(error) }, 503); }
  if (!declaration) return jsonResponse({ error: 'not-found' }, 404);
  const rawBody = await request.text();
  if (rawBody.length > 1_000_000) return jsonResponse({ error: 'body-too-large' }, 413);
  let input: unknown;
  try { input = JSON.parse(rawBody); } catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  if (!graphContractValueMatches(declaration.inputSchema, input)) return jsonResponse({ error: 'input-schema-mismatch' }, 422);
  const runId = randomUUID();
  void (deps.run ?? runGraph)(matches[0]!.file, { runId, input, deps: { root: deps.stateRoot ?? effectiveInstanceRoot() } })
    .catch(error => debug.log('graph.entry', 'api-run-failed', { graphId, runId, error: String(error) }, { level: 'warn' }));
  return jsonResponse({ graphId, runId }, 202);
}

/** The existing webhook router authenticates and checks route collisions before this callback. */
export async function handlePluginGraphWebhook(file: string,
  request: { method: string; path: string; body: string }, tick: typeof graphTick = graphTick,
): Promise<{ ok: boolean; runId?: string; error?: string }> {
  try {
    let body: unknown = request.body;
    try { body = JSON.parse(request.body); } catch { /* raw payload is still an input value */ }
    const result = await tick(file, { startIfIdle: true,
      input: { webhook: { method: request.method, path: request.path, body } } });
    return result.action === 'started' && result.runId ? { ok: true, runId: result.runId }
      : { ok: false, error: result.status === 'refused' ? result.reason : `no run (${result.action})` };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
