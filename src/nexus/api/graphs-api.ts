import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { defaultGraphsDir, loadGraphTemplatesFrom } from '../../self-implement/graph-templates.js';
import { loadGraphTemplates } from '../../self-implement/graph-yaml.js';
import { jsonResponse } from './json-response.js';

/** Declared graph ids only. A user string is never joined onto a filesystem path. */
const GRAPH_ID = /^[a-z0-9-]+$/;

export interface GraphCatalogEntry {
  id: string;
  source: 'core' | 'mine';
  editable: boolean;
  nodeCount: number;
}

export interface GraphsApiDeps {
  coreDir?: string;
  mineDir?: string;
}

function mineGraphsDir(): string {
  return join(elanousStateRoot(), 'graphs');
}

function resolveId(raw: string): string | null {
  let id: string;
  try { id = decodeURIComponent(raw); }
  catch { return null; }
  return GRAPH_ID.test(id) ? id : null;
}

function readDirYaml(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.yaml') || name.endsWith('.yml')).sort();
  } catch {
    return [];
  }
}

/** Index by the declared `graph_id`, never by the file name the caller supplied. */
function indexByDeclaredId(dir: string): Map<string, { file: string; text: string }> {
  const found = new Map<string, { file: string; text: string }>();
  for (const file of readDirYaml(dir)) {
    let text: string;
    try { text = readFileSync(join(dir, file), 'utf8'); }
    catch { continue; }
    let raw: unknown;
    try { raw = parseYaml(text); }
    catch { continue; }
    const id = raw !== null && typeof raw === 'object' && typeof (raw as { graph_id?: unknown }).graph_id === 'string'
      ? (raw as { graph_id: string }).graph_id
      : '';
    if (!GRAPH_ID.test(id) || found.has(id)) continue;
    found.set(id, { file, text });
  }
  return found;
}

function coreCatalog(dir: string): { ok: true; graphs: GraphCatalogEntry[] } | { ok: false; issues: unknown } {
  const loaded = loadGraphTemplatesFrom(dir);
  if (loaded.source !== 'yaml') return { ok: false, issues: loaded.issues };
  const specs = loadGraphTemplates(dir);
  if (specs.errors.length > 0) return { ok: false, issues: specs.errors };
  return {
    ok: true,
    graphs: Object.values(loaded.templates).map((template) => ({
      id: template.graphId, source: 'core', editable: false, nodeCount: template.nodes.length,
    })),
  };
}

function mineCatalog(dir: string): GraphCatalogEntry[] {
  const specs = loadGraphTemplates(dir);
  return Object.values(specs.templates)
    .filter((template) => GRAPH_ID.test(template.graphId))
    .map((template) => ({ id: template.graphId, source: 'mine' as const, editable: true, nodeCount: template.nodes.length }));
}

function detailOf(id: string, source: 'core' | 'mine', editable: boolean, dir: string): Response | null {
  const loaded = loadGraphTemplatesFrom(dir);
  const specs = loadGraphTemplates(dir);
  const template = Object.hasOwn(loaded.templates, id) ? loaded.templates[id] : undefined;
  const spec = Object.hasOwn(specs.templates, id) ? specs.templates[id] : undefined;
  if (!template || !spec || template.graphId !== id) return null;
  return jsonResponse({
    id: spec.graphId,
    source,
    editable,
    entry_node: template.entryNode,
    terminal_nodes: template.terminalNodes,
    nodes: template.nodes.map(({ nodeId, kind, recipe, maxVisits }) => ({ node_id: nodeId, kind, recipe, max_visits: maxVisits })),
    edges: spec.edges.map(({ from, to, on, map }) => ({
      from,
      ...(to === undefined ? {} : { to }),
      ...(on === undefined ? {} : { on }),
      ...(map === undefined ? {} : { map }),
    })),
  });
}

/** Rewrite only the declared graph_id scalar. Every other byte, including comments, stays. */
export function rewriteGraphId(text: string, newId: string): string | null {
  const match = /^([ \t]*graph_id:[ \t]*)([^\n#]*?)([ \t]*(?:#.*)?)$/m.exec(text);
  if (!match || match.index === undefined) return null;
  const current = match[2]!.trim().replace(/^['"]|['"]$/g, '');
  if (!GRAPH_ID.test(current)) return null;
  return `${text.slice(0, match.index)}${match[1]}${newId}${match[3]}${text.slice(match.index + match[0].length)}`;
}

function validateInTemp(text: string, expectedId: string): { ok: true } | { ok: false; errors: unknown } {
  const scratch = mkdtempSync(join(tmpdir(), 'elanous-graph-'));
  try {
    writeFileSync(join(scratch, `${expectedId}.yaml`), text);
    const loaded = loadGraphTemplates(scratch);
    if (loaded.errors.length > 0 || !Object.hasOwn(loaded.templates, expectedId)) {
      return { ok: false, errors: loaded.errors.length > 0 ? loaded.errors : [{ path: expectedId, message: 'graph_id 가 요청 id 와 다르다' }] };
    }
    return { ok: true };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Core graphs are read from the same YAML loader as the harness, never rewritten by this API. */
export function handleGraphsGet(pathname: string, dir = defaultGraphsDir(), deps: GraphsApiDeps = {}): Response {
  const coreDir = deps.coreDir ?? dir;
  const mineDir = deps.mineDir ?? mineGraphsDir();
  const core = coreCatalog(coreDir);
  if (!core.ok && pathname === '/v1/graphs') return jsonResponse({ error: 'graphs-unavailable', issues: core.issues }, 503);

  if (pathname === '/v1/graphs') {
    const mine = mineCatalog(mineDir);
    const coreIds = new Set((core.ok ? core.graphs : []).map((graph) => graph.id));
    return jsonResponse({ graphs: [...(core.ok ? core.graphs : []), ...mine.filter((graph) => !coreIds.has(graph.id))] });
  }

  const yamlMatch = /^\/v1\/graphs\/([^/]+)\/yaml$/.exec(pathname);
  if (yamlMatch) {
    const id = resolveId(yamlMatch[1]!);
    if (!id) return jsonResponse({ error: 'bad_request', reason: 'invalid graph id' }, 400);
    const mineHit = indexByDeclaredId(mineDir).get(id);
    const coreHit = core.ok ? indexByDeclaredId(coreDir).get(id) : undefined;
    const hit = mineHit ?? coreHit;
    if (!hit) return jsonResponse({ error: 'not-found', id }, 404);
    return jsonResponse({ id, source: mineHit ? 'mine' : 'core', editable: Boolean(mineHit), yaml: hit.text });
  }

  const match = /^\/v1\/graphs\/([^/]+)$/.exec(pathname);
  if (!match) return jsonResponse({ error: 'not-found' }, 404);
  const id = resolveId(match[1]!);
  if (!id) return jsonResponse({ error: 'not-found' }, 404);
  if (core.ok && Object.hasOwn(loadGraphTemplatesFrom(coreDir).templates, id)) {
    return detailOf(id, 'core', false, coreDir) ?? jsonResponse({ error: 'not-found', id }, 404);
  }
  if (indexByDeclaredId(mineDir).has(id)) {
    return detailOf(id, 'mine', true, mineDir) ?? jsonResponse({ error: 'not-found', id }, 404);
  }
  return jsonResponse({ error: 'not-found', id }, 404);
}

/** PUT writes only under the state-root graphs directory. Core YAML is never opened for write. */
export async function handleGraphsPut(pathname: string, req: Request, deps: GraphsApiDeps = {}): Promise<Response> {
  const match = /^\/v1\/graphs\/([^/]+)\/yaml$/.exec(pathname);
  if (!match) return jsonResponse({ error: 'not-found' }, 404);
  const id = resolveId(match[1]!);
  if (!id) return jsonResponse({ error: 'bad_request', reason: 'invalid graph id' }, 400);
  const coreDir = deps.coreDir ?? defaultGraphsDir();
  const mineDir = deps.mineDir ?? mineGraphsDir();
  const core = coreCatalog(coreDir);
  const coreOwns = core.ok && indexByDeclaredId(coreDir).has(id);
  const mineOwns = indexByDeclaredId(mineDir).has(id);
  if (coreOwns && !mineOwns) return jsonResponse({ error: 'core-read-only', id }, 403);
  if (!mineOwns) return jsonResponse({ error: 'not-found', id }, 404);
  let body: { yaml?: unknown };
  try { body = await req.json() as { yaml?: unknown }; }
  catch { return jsonResponse({ error: 'bad_request', reason: 'json body required' }, 400); }
  if (typeof body.yaml !== 'string') return jsonResponse({ error: 'bad_request', reason: 'yaml string required' }, 400);
  const checked = validateInTemp(body.yaml, id);
  if (!checked.ok) return jsonResponse({ error: 'invalid-graph', errors: checked.errors }, 400);
  const existing = indexByDeclaredId(mineDir).get(id)!;
  writeFileSync(join(mineDir, existing.file), body.yaml);
  return jsonResponse({ id, source: 'mine', editable: true, saved: true });
}

/** Copy core bytes into «my graphs», changing only the declared graph_id. */
export async function handleGraphsClone(pathname: string, req: Request, deps: GraphsApiDeps = {}): Promise<Response> {
  const match = /^\/v1\/graphs\/([^/]+)\/clone$/.exec(pathname);
  if (!match) return jsonResponse({ error: 'not-found' }, 404);
  const id = resolveId(match[1]!);
  if (!id) return jsonResponse({ error: 'bad_request', reason: 'invalid graph id' }, 400);
  let body: { newId?: unknown };
  try { body = await req.json() as { newId?: unknown }; }
  catch { return jsonResponse({ error: 'bad_request', reason: 'json body required' }, 400); }
  if (typeof body.newId !== 'string' || !GRAPH_ID.test(body.newId) || body.newId === id) {
    return jsonResponse({ error: 'bad_request', reason: 'newId must match [a-z0-9-]' }, 400);
  }
  const coreDir = deps.coreDir ?? defaultGraphsDir();
  const mineDir = deps.mineDir ?? mineGraphsDir();
  const source = indexByDeclaredId(coreDir).get(id) ?? indexByDeclaredId(mineDir).get(id);
  if (!source) return jsonResponse({ error: 'not-found', id }, 404);
  if (indexByDeclaredId(mineDir).has(body.newId) || indexByDeclaredId(coreDir).has(body.newId)) {
    return jsonResponse({ error: 'conflict', id: body.newId }, 409);
  }
  const rewritten = rewriteGraphId(source.text, body.newId);
  if (rewritten === null) return jsonResponse({ error: 'bad_request', reason: 'source graph_id is not rewritable' }, 400);
  const checked = validateInTemp(rewritten, body.newId);
  if (!checked.ok) return jsonResponse({ error: 'invalid-graph', errors: checked.errors }, 400);
  mkdirSync(mineDir, { recursive: true });
  writeFileSync(join(mineDir, `${body.newId}.yaml`), rewritten);
  return jsonResponse({ id: body.newId, source: 'mine', editable: true, clonedFrom: id }, 201);
}

export async function handleGraphsMutation(pathname: string, req: Request, deps: GraphsApiDeps = {}): Promise<Response | null> {
  if (req.method === 'PUT' && /^\/v1\/graphs\/[^/]+\/yaml$/.test(pathname)) return handleGraphsPut(pathname, req, deps);
  if (req.method === 'POST' && /^\/v1\/graphs\/[^/]+\/clone$/.test(pathname)) return handleGraphsClone(pathname, req, deps);
  return null;
}
