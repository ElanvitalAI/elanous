import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { debug } from '../../debug/log.js';
import { defaultGraphsDir, loadGraphTemplatesFrom } from '../../self-implement/graph-templates.js';
import { loadGraphTemplates } from '../../self-implement/graph-yaml.js';
import { validateGraphYaml } from './graph-kinds.js';
import { parseWizardSteps, readWizardSteps, withWizardSteps } from '../../graph-wizard/saved-steps.js';
import type { WizardNodeStep } from '../../graph-wizard/steps.js';
import { jsonResponse } from './json-response.js';
import { clearPeerEdit, peerEditRefusalBody, peerEditRunGate, readPeerEdit, writePeerEdit } from './graph-peer-edit.js';

/** Declared graph ids only. A user string is never joined onto a filesystem path. */
const GRAPH_ID = /^[a-z0-9-]+$/;

/**
 * Sidecar names a graph directory loads specially. `recipes.yaml` next to a graph is what
 * the graph runner executes (`cmd:` recipes), so an HTTP write to `<mine>/recipes.yaml`
 * would be a remote command path. These ids are never created, saved or reverted, and
 * these files are never indexed as graphs.
 */
export const RESERVED_GRAPH_IDS: ReadonlySet<string> = new Set(['recipes', 'overlay', 'overlays']);

function reserved(id: string): Response | null {
  if (!RESERVED_GRAPH_IDS.has(id)) return null;
  debug.log('nexus.graphs', 'rejected-reserved', { id });
  return jsonResponse({ error: 'reserved-id', id }, 400);
}

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

export type GraphPermission = 'view' | 'edit';
type GraphGrant = { recipient: string; permission: GraphPermission };
const TOKEN_PATTERN = /^eg_[A-Za-z0-9_-]{32,}$/;

function accessFile(dir: string, id: string): string {
  return join(dir, '.access', `${id}.json`);
}
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
function accessGrants(dir: string, id: string): GraphGrant[] {
  let text: string;
  try { text = readFileSync(accessFile(dir, id), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every((entry): entry is GraphGrant => entry !== null && typeof entry === 'object'
    && typeof entry.recipient === 'string' && /^[a-f0-9]{64}$/.test(entry.recipient)
    && (entry.permission === 'view' || entry.permission === 'edit'))) throw new Error('invalid graph access store');
  return parsed;
}

/** Only a hash is persisted; no owner bearer or raw recipient credential goes into a graph/YAML. */
export function handleGraphAccess(pathname: string, req: Request, deps: GraphsApiDeps = {}): Response {
  const match = /^\/v1\/graphs\/([^/]+)\/access$/.exec(pathname);
  const id = match ? resolveId(match[1]!) : null;
  if (!id) return jsonResponse({ error: 'bad_request' }, 400);
  const owned = mineOwnership(id, deps);
  if (owned instanceof Response) return owned;
  if (req.method !== 'GET') return jsonResponse({ error: 'method-not-allowed' }, 405);
  try { return jsonResponse({ grants: accessGrants(owned.mineDir, id) }); }
  catch (error) { return saveFailed(id, error); }
}

export async function handleGraphAccessPut(pathname: string, req: Request, deps: GraphsApiDeps = {}): Promise<Response> {
  const match = /^\/v1\/graphs\/([^/]+)\/access$/.exec(pathname);
  const id = match ? resolveId(match[1]!) : null;
  if (!id) return jsonResponse({ error: 'bad_request' }, 400);
  const owned = mineOwnership(id, deps);
  if (owned instanceof Response) return owned;
  // Detail GET resolves a core id first; do not grant a token for a shadowed mine id.
  if (indexByDeclaredId(deps.coreDir ?? defaultGraphsDir()).has(id)) return jsonResponse({ error: 'core-id-conflict', id }, 409);
  let body: { recipient?: unknown; permission?: unknown };
  try { body = await req.json() as typeof body; }
  catch { return jsonResponse({ error: 'bad_request' }, 400); }
  if (!body || typeof body.recipient !== 'string' || !TOKEN_PATTERN.test(body.recipient)
    || (body.permission !== 'view' && body.permission !== 'edit')) {
    return jsonResponse({ error: 'bad_request', reason: 'recipient access token and view/edit permission required' }, 400);
  }
  const recipient = tokenHash(body.recipient);
  const dir = join(owned.mineDir, '.access');
  try {
    const grants = accessGrants(owned.mineDir, id).filter((grant) => grant.recipient !== recipient);
    grants.push({ recipient, permission: body.permission });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = accessFile(owned.mineDir, id);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(grants), { mode: 0o600 });
      renameSync(temp, target);
    } finally { rmSync(temp, { force: true }); }
  } catch (error) { return saveFailed(id, error); }
  return jsonResponse({ recipient, permission: body.permission });
}

/** The peer token works only on this graph and the requested read/edit operation. */
export function graphAccessForRequest(pathname: string, method: string, token: string | null, deps: GraphsApiDeps = {}): boolean {
  const match = /^\/v1\/graphs\/([^/]+)(?:\/(yaml))?$/.exec(pathname);
  const id = match ? resolveId(match[1]!) : null;
  if (!id || !token || !TOKEN_PATTERN.test(token)) return false;
  if (method !== 'GET' && !(method === 'PUT' && match?.[2] === 'yaml')) return false;
  try {
    if (!indexByDeclaredId(deps.mineDir ?? mineGraphsDir()).has(id)) return false;
    if (indexByDeclaredId(deps.coreDir ?? defaultGraphsDir()).has(id)) return false;
    const wanted = tokenHash(token);
    return accessGrants(deps.mineDir ?? mineGraphsDir(), id).some((grant) => {
      const stored = Buffer.from(grant.recipient, 'hex');
      return timingSafeEqual(stored, Buffer.from(wanted, 'hex')) && (method === 'GET' || grant.permission === 'edit');
    });
  } catch (error) {
    debug.log('nexus.graphs', 'access-read-failed', { id, reason: String(error) }, { level: 'warn' });
    return false;
  }
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
    if (RESERVED_GRAPH_IDS.has(file.replace(/\.ya?ml$/, ''))) continue;
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
    // GRAPH-GROUPS — a node's `group:` tag (when the loader carries it) rides along so the PWA can box/fold units.
    nodes: template.nodes.map((node) => {
      const { nodeId, kind, recipe, maxVisits } = node;
      const group = (node as { group?: unknown }).group;
      return { node_id: nodeId, kind, recipe, max_visits: maxVisits, ...(typeof group === 'string' && group.trim() ? { group: group.trim() } : {}) };
    }),
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

/** Same validator as POST /v1/graphs/validate. Invalid → 422; declared graph_id ≠ id → 400. Null = ok. */
function rejectGraphYaml(text: string, id: string, version?: string): Response | null {
  const checked = validateGraphYaml('harness', text);
  if (!checked.ok) {
    debug.log('nexus.graphs', 'rejected-invalid', { id, ...(version ? { version } : {}), issues: checked.errors });
    return jsonResponse({ error: 'invalid-graph', errors: checked.errors, ignoredKeys: checked.ignoredKeys }, 422);
  }
  if (checked.graphId !== id) {
    const errors = [{ path: `${id}/graph_id`, message: 'graph_id 가 요청 id 와 다르다' }];
    debug.log('nexus.graphs', 'rejected-invalid', { id, issues: errors });
    return jsonResponse({ error: 'graph-id-mismatch', errors }, 400);
  }
  return null;
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
    const steps = mineHit ? readWizardSteps(mineDir, id, hit.text) : null;
    return jsonResponse({ id, source: mineHit ? 'mine' : 'core', editable: Boolean(mineHit), yaml: hit.text, ...(steps ? { steps } : {}) });
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
/** Who authorized a save: the owner, or a peer token holding an «edit» grant (raw token; only a hash prefix is kept). */
export type GraphSaveActor = { peerToken: string } | null;

export async function handleGraphsPut(pathname: string, req: Request, deps: GraphsApiDeps = {}, actor: GraphSaveActor = null): Promise<Response> {
  const match = /^\/v1\/graphs\/([^/]+)\/yaml$/.exec(pathname);
  if (!match) return jsonResponse({ error: 'not-found' }, 404);
  const id = resolveId(match[1]!);
  if (!id) return jsonResponse({ error: 'bad_request', reason: 'invalid graph id' }, 400);
  const reservedId = reserved(id);
  if (reservedId) return reservedId;
  const coreDir = deps.coreDir ?? defaultGraphsDir();
  const mineDir = deps.mineDir ?? mineGraphsDir();
  const core = coreCatalog(coreDir);
  const coreOwns = core.ok && indexByDeclaredId(coreDir).has(id);
  const mineOwns = indexByDeclaredId(mineDir).has(id);
  if (coreOwns && !mineOwns) return jsonResponse({ error: 'core-read-only', id }, 403);
  if (!mineOwns) return jsonResponse({ error: 'not-found', id }, 404);
  let body: { yaml?: unknown; steps?: unknown };
  try { body = await req.json() as { yaml?: unknown; steps?: unknown }; }
  catch { return jsonResponse({ error: 'bad_request', reason: 'json body required' }, 400); }
  if (typeof body?.yaml !== 'string') return jsonResponse({ error: 'bad_request', reason: 'yaml string required' }, 400);
  const rejected = rejectGraphYaml(body.yaml, id);
  if (rejected) return rejected;
  const steps = stepsOf(body.steps, body.yaml);
  if (steps instanceof Response) return steps;
  const existing = indexByDeclaredId(mineDir).get(id)!;
  // Writes go only to <mine>/<id>.yaml; a hand-placed file under another name is not edited over HTTP.
  if (existing.file !== `${id}.yaml`) return jsonResponse({ error: 'file-name-mismatch', id, file: existing.file }, 409);
  let written: { version: string; previous: string };
  const editedBy = actor ? `peer:${tokenHash(actor.peerToken).slice(0, 8)}` : null;
  try {
    written = withWizardSteps(mineDir, id, steps, () => {
      // Peer save: the marker goes down «before» the bytes, so a crash in between still refuses the run.
      if (editedBy) writePeerEdit(mineDir, id, { editedBy, version: 'pending', at: new Date().toISOString() });
      const result = writeWithVersion(mineDir, id, existing, body.yaml as string);
      if (editedBy) writePeerEdit(mineDir, id, { editedBy, version: result.version, at: new Date().toISOString() });
      else clearPeerEdit(mineDir, id);
      return result;
    });
  }
  catch (error) { return saveFailed(id, error); }
  const { version, previous } = written;
  debug.log('nexus.graphs', 'saved', { id, version, previous, steps: steps ? Object.keys(steps).length : 0, ...(editedBy ? { editedBy } : {}) });
  return jsonResponse({ id, source: 'mine', editable: true, saved: true, version, previous, ...(editedBy ? { editedBy } : {}) });
}

const VERSION_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d{4})?$/;
export const GRAPH_VERSION_CAP = 20;

function versionsDir(mineDir: string, id: string): string {
  return join(mineDir, '.versions', id);
}

/** Version ids are ISO timestamps (`:`/`.` → `-`), so name order is save order. */
export function listGraphVersions(mineDir: string, id: string): Array<{ version: string; savedAt: string; bytes: number }> {
  const dir = versionsDir(mineDir, id);
  // Only `.yaml` is ever written, read and reverted — a stray `.yml` is not a version.
  return readDirYaml(dir)
    .filter((file) => file.endsWith('.yaml'))
    .map((file) => file.replace(/\.yaml$/, ''))
    .filter((version) => VERSION_ID.test(version))
    .sort()
    .map((version) => {
      const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(version);
      let bytes = 0;
      try { bytes = statSync(join(dir, `${version}.yaml`)).size; } catch { /* listed above; raced away */ }
      return { version, savedAt: iso ? `${iso[1]}T${iso[2]}:${iso[3]}:${iso[4]}.${iso[5]}Z` : version, bytes };
    });
}

function recordVersion(mineDir: string, id: string, text: string): string {
  const dir = versionsDir(mineDir, id);
  mkdirSync(dir, { recursive: true });
  const base = new Date().toISOString().replace(/[:.]/g, '-');
  let version = base;
  for (let n = 1; existsSync(join(dir, `${version}.yaml`)); n += 1) version = `${base}-${String(n).padStart(4, '0')}`;
  writeFileSync(join(dir, `${version}.yaml`), text);
  const all = listGraphVersions(mineDir, id);
  for (const old of all.slice(0, Math.max(0, all.length - GRAPH_VERSION_CAP))) {
    rmSync(join(dir, `${old.version}.yaml`), { force: true });
  }
  return version;
}

/**
 * Every saved state is a version. A graph with no history yet (e.g. a fresh clone)
 * first records its current bytes, so `previous` always points at restorable bytes.
 */
function writeWithVersion(mineDir: string, id: string, existing: { file: string; text: string }, text: string): { version: string; previous: string } {
  const history = listGraphVersions(mineDir, id);
  const previous = history.at(-1)?.version ?? recordVersion(mineDir, id, existing.text);
  // Version first, then an atomic replace of the current file: a crash in between leaves
  // the old current bytes intact (they are `previous`), never bytes that no version holds.
  const version = recordVersion(mineDir, id, text);
  const target = join(mineDir, `${id}.yaml`);
  const temp = join(mineDir, `.${id}.yaml.${process.pid}.tmp`);
  writeFileSync(temp, text);
  renameSync(temp, target);
  return { version, previous };
}

function mineOwnership(id: string, deps: GraphsApiDeps): { mineDir: string; existing: { file: string; text: string } } | Response {
  const reservedId = reserved(id);
  if (reservedId) return reservedId;
  const coreDir = deps.coreDir ?? defaultGraphsDir();
  const mineDir = deps.mineDir ?? mineGraphsDir();
  const existing = indexByDeclaredId(mineDir).get(id);
  if (!existing) {
    const core = coreCatalog(coreDir);
    if (core.ok && indexByDeclaredId(coreDir).has(id)) return jsonResponse({ error: 'core-read-only', id }, 403);
    return jsonResponse({ error: 'not-found', id }, 404);
  }
  return { mineDir, existing };
}

/** GET /v1/graphs/<id>/versions — only «mine» graphs have history. */
export function handleGraphVersionsGet(pathname: string, deps: GraphsApiDeps = {}): Response {
  const match = /^\/v1\/graphs\/([^/]+)\/versions$/.exec(pathname);
  if (!match) return jsonResponse({ error: 'not-found' }, 404);
  const id = resolveId(match[1]!);
  if (!id) return jsonResponse({ error: 'bad_request', reason: 'invalid graph id' }, 400);
  const owned = mineOwnership(id, deps);
  if (owned instanceof Response) return owned;
  return jsonResponse({ id, versions: listGraphVersions(owned.mineDir, id) });
}

/** POST /v1/graphs/<id>/revert {version} — restores that version; the restore is itself a new version. */
export async function handleGraphsRevert(pathname: string, req: Request, deps: GraphsApiDeps = {}): Promise<Response> {
  const match = /^\/v1\/graphs\/([^/]+)\/revert$/.exec(pathname);
  if (!match) return jsonResponse({ error: 'not-found' }, 404);
  const id = resolveId(match[1]!);
  if (!id) return jsonResponse({ error: 'bad_request', reason: 'invalid graph id' }, 400);
  const owned = mineOwnership(id, deps);
  if (owned instanceof Response) return owned;
  if (owned.existing.file !== `${id}.yaml`) return jsonResponse({ error: 'file-name-mismatch', id, file: owned.existing.file }, 409);
  let body: { version?: unknown };
  try { body = await req.json() as { version?: unknown }; }
  catch { return jsonResponse({ error: 'bad_request', reason: 'json body required' }, 400); }
  if (typeof body?.version !== 'string' || !VERSION_ID.test(body.version)) {
    return jsonResponse({ error: 'bad_request', reason: 'version string required' }, 400);
  }
  const target = body.version;
  // Only a listed version id is ever joined onto a path.
  if (!listGraphVersions(owned.mineDir, id).some((entry) => entry.version === target)) {
    return jsonResponse({ error: 'version-not-found', id, version: target }, 404);
  }
  const text = readFileSync(join(versionsDir(owned.mineDir, id), `${target}.yaml`), 'utf8');
  const rejected = rejectGraphYaml(text, id, target);
  if (rejected) return rejected;
  const { version, previous } = writeWithVersion(owned.mineDir, id, owned.existing, text);
  debug.log('nexus.graphs', 'reverted', { id, version, previous, restoredFrom: target });
  return jsonResponse({ id, source: 'mine', editable: true, reverted: true, version, previous, restoredFrom: target });
}

/** GRAPH-WIZARD-SAVE-RECIPES — optional `steps` on save (the wizard's node → library step map). Absent = keep
 *  whatever sidecar the graph has; present = validated against the step library and stored as a sidecar. The
 *  run builds commands from it server-side (src/graph-wizard/saved-steps.ts) — no client command text is kept. */
function stepsOf(raw: unknown, yaml: string): Record<string, WizardNodeStep> | null | Response {
  // Only an absent field means «keep what is there»; an explicit null or any other non-object is a bad request.
  if (raw === undefined) return null;
  const parsed = parseWizardSteps(raw, yaml);
  if (!parsed.ok) return jsonResponse({ error: 'bad_request', reason: parsed.reason }, 400);
  return parsed.steps;
}

function saveFailed(id: string, error: unknown): Response {
  const reason = error instanceof Error ? error.message.slice(0, 200) : String(error);
  debug.log('nexus.graphs', 'save-failed', { id, reason }, { level: 'warn' });
  return jsonResponse({ error: 'save-failed', id, reason }, 500);
}

/** POST /v1/graphs {id, yaml} — a brand-new «mine» graph (blank canvas → save). Records version v1. */
export async function handleGraphsCreate(req: Request, deps: GraphsApiDeps = {}): Promise<Response> {
  let body: { id?: unknown; yaml?: unknown; steps?: unknown };
  try { body = await req.json() as { id?: unknown; yaml?: unknown; steps?: unknown }; }
  catch { return jsonResponse({ error: 'bad_request', reason: 'json body required' }, 400); }
  const id = typeof body?.id === 'string' ? resolveId(body.id) : null;
  if (!id) return jsonResponse({ error: 'bad_request', reason: 'id must match [a-z0-9-]' }, 400);
  const reservedId = reserved(id);
  if (reservedId) return reservedId;
  if (typeof body.yaml !== 'string') return jsonResponse({ error: 'bad_request', reason: 'yaml string required' }, 400);
  const coreDir = deps.coreDir ?? defaultGraphsDir();
  const mineDir = deps.mineDir ?? mineGraphsDir();
  if (indexByDeclaredId(coreDir).has(id)) return jsonResponse({ error: 'core-read-only', id }, 403);
  if (indexByDeclaredId(mineDir).has(id) || existsSync(join(mineDir, `${id}.yaml`))) return jsonResponse({ error: 'exists', id }, 409);
  const rejected = rejectGraphYaml(body.yaml, id);
  if (rejected) return rejected;
  const steps = stepsOf(body.steps, body.yaml);
  if (steps instanceof Response) return steps;
  let version: string;
  try {
    version = withWizardSteps(mineDir, id, steps, () => {
      mkdirSync(mineDir, { recursive: true });
      writeFileSync(join(mineDir, `${id}.yaml`), body.yaml as string, { flag: 'wx' });
      try { return recordVersion(mineDir, id, body.yaml as string); }
      catch (error) { rmSync(join(mineDir, `${id}.yaml`), { force: true }); throw error; }
    });
  } catch (error) { return saveFailed(id, error); }
  debug.log('nexus.graphs', 'saved', { id, version, created: true, steps: steps ? Object.keys(steps).length : 0 });
  return jsonResponse({ id, source: 'mine', editable: true, saved: true, version, previous: null }, 201);
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
  const reservedId = reserved(body.newId);
  if (reservedId) return reservedId;
  const coreDir = deps.coreDir ?? defaultGraphsDir();
  const mineDir = deps.mineDir ?? mineGraphsDir();
  const fromCore = indexByDeclaredId(coreDir).get(id);
  const source = fromCore ?? indexByDeclaredId(mineDir).get(id);
  if (!source) return jsonResponse({ error: 'not-found', id }, 404);
  // A clone would carry a peer's unapproved change into a graph with no marker — approve first.
  if (!fromCore) {
    const gate = peerEditRunGate(mineDir, id);
    if (!gate.ok) return jsonResponse(peerEditRefusalBody(id, gate), 409);
  }
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

/** POST /v1/graphs/<id>/approve {version} — owner only (the route never accepts a peer token). Approves the
 *  exact peer version the run refusal named; a newer peer save is a new version and needs a new approval. */
export async function handleGraphsApprove(pathname: string, req: Request, deps: GraphsApiDeps = {}): Promise<Response> {
  const match = /^\/v1\/graphs\/([^/]+)\/approve$/.exec(pathname);
  if (!match) return jsonResponse({ error: 'not-found' }, 404);
  const id = resolveId(match[1]!);
  if (!id) return jsonResponse({ error: 'bad_request', reason: 'invalid graph id' }, 400);
  const owned = mineOwnership(id, deps);
  if (owned instanceof Response) return owned;
  let body: { version?: unknown };
  try { body = await req.json() as { version?: unknown }; }
  catch { return jsonResponse({ error: 'bad_request', reason: 'json body required' }, 400); }
  if (typeof body?.version !== 'string' || !body.version) return jsonResponse({ error: 'bad_request', reason: 'version string required' }, 400);
  let record;
  try { record = readPeerEdit(owned.mineDir, id); }
  catch (error) { return saveFailed(id, error); }
  if (!record) return jsonResponse({ id, approved: true, version: body.version, pending: false });
  if (record.version !== body.version) {
    return jsonResponse({ error: 'version-mismatch', id, version: record.version, reason: '승인하려는 판이 최신 상대 변경과 다르다 — 다시 확인하라' }, 409);
  }
  const approved = { version: record.version, at: new Date().toISOString() };
  try { writePeerEdit(owned.mineDir, id, { ...record, approved }); }
  catch (error) { return saveFailed(id, error); }
  debug.log('nexus.graphs', 'peer-edit-approved', { id, version: record.version, editedBy: record.editedBy });
  return jsonResponse({ id, approved: true, version: record.version, editedBy: record.editedBy });
}

export async function handleGraphsMutation(pathname: string, req: Request, deps: GraphsApiDeps = {}, actor: GraphSaveActor = null): Promise<Response | null> {
  // Only PUT …/yaml is open to a peer token; every other mutation is the owner's alone.
  if (actor && !(req.method === 'PUT' && /^\/v1\/graphs\/[^/]+\/yaml$/.test(pathname))) return jsonResponse({ error: 'unauthorized' }, 401);
  if (req.method === 'POST' && pathname === '/v1/graphs') return handleGraphsCreate(req, deps);
  if (req.method === 'PUT' && /^\/v1\/graphs\/[^/]+\/yaml$/.test(pathname)) return handleGraphsPut(pathname, req, deps, actor);
  if (req.method === 'POST' && /^\/v1\/graphs\/[^/]+\/approve$/.test(pathname)) return handleGraphsApprove(pathname, req, deps);
  if (req.method === 'POST' && /^\/v1\/graphs\/[^/]+\/clone$/.test(pathname)) return handleGraphsClone(pathname, req, deps);
  if (req.method === 'POST' && /^\/v1\/graphs\/[^/]+\/revert$/.test(pathname)) return handleGraphsRevert(pathname, req, deps);
  return null;
}
