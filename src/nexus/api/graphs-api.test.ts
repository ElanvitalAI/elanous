import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { routeRequest } from './http-server.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { GRAPH_VERSION_CAP, handleGraphVersionsGet, RESERVED_GRAPH_IDS, handleGraphsClone, handleGraphsCreate, handleGraphsGet, handleGraphsPut, handleGraphsRevert } from './graphs-api.js';
import { defaultGraphsDir } from '../../self-implement/graph-templates.js';

const headers = { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' };

function request(path: string, method = 'GET', authorized = true) {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  return routeRequest(new Request(`http://localhost${path}`, { method, headers: authorized ? headers : { 'sec-fetch-site': 'cross-site' } }), {
    state, registry: new TabRegistry(state), eventBus: bus, metaApi: { bearerToken: 'owner-secret', noAuth: false },
  }, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
}

test('GET /v1/graphs reads real YAML, retains labelled research branches and denies anonymous or write requests', async () => {
  const list = await request('/v1/graphs');
  expect(list?.status).toBe(200);
  const graphs = (await list!.json() as { graphs: Array<{ id: string; source: string; editable: boolean; nodeCount: number }> }).graphs;
  expect(graphs).toContainEqual({ id: 'research-loop', source: 'core', editable: false, nodeCount: 7 });

  const response = await request('/v1/graphs/research-loop');
  expect(response?.status).toBe(200);
  const detail = await response!.json() as {
    entry_node: string; terminal_nodes: string[];
    nodes: Array<{ node_id: string; kind: string; recipe: string; max_visits: number }>;
    edges: Array<{ from: string; on?: string; map?: Record<string, string> }>;
  };
  expect(detail.entry_node).toBe('investigate');
  expect(detail.terminal_nodes).toContain('merge');
  expect(detail.nodes).toContainEqual({ node_id: 'investigate', kind: 'agent', recipe: 'headless-goal-loop', max_visits: 7 });
  expect(detail.edges.find((edge) => edge.from === 'investigate')).toMatchObject({
    on: 'changed-files', map: { 'code-changed': 'gate', 'documents-only': 'judge', unknown: 'gate' },
  });
  expect((await request('/v1/graphs', 'GET', false))?.status).toBe(401);
  expect((await request('/v1/graphs/research-loop', 'GET', false))?.status).toBe(401);
  for (const method of ['POST', 'PUT', 'DELETE']) expect((await request('/v1/graphs/research-loop', method))?.status).toBe(405);
  expect((await request('/v1/graphs/not-present'))?.status).toBe(404);
  expect((await request('/v1/graphs/%2Fetc%2Fpasswd'))?.status).toBe(404);
});

test('missing YAML directory does not expose built-in fallback as core graph', async () => {
  const response = handleGraphsGet('/v1/graphs', '/nonexistent-core-graphs', { mineDir: '/nonexistent-mine-graphs' });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: 'graphs-unavailable' });
});

test('PUT of a core id is refused and a clone can be saved then listed as mine', async () => {
  const mineDir = mkdtempSync(join(tmpdir(), 'elanous-mine-graphs-'));
  const coreDir = defaultGraphsDir();
  const deps = { coreDir, mineDir };
  const coreYaml = await handleGraphsGet('/v1/graphs/research-loop/yaml', coreDir, deps);
  expect(coreYaml.status).toBe(200);
  const original = (await coreYaml.json() as { yaml: string }).yaml;
  expect(original).toBe(readFileSync(join(coreDir, 'research-loop.yaml'), 'utf8'));

  const refused = await handleGraphsPut('/v1/graphs/research-loop/yaml', new Request('http://localhost/v1/graphs/research-loop/yaml', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: original }),
  }), deps);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: 'core-read-only', id: 'research-loop' });
  expect(readFileSync(join(coreDir, 'research-loop.yaml'), 'utf8')).toBe(original);

  const cloned = await handleGraphsClone('/v1/graphs/research-loop/clone', new Request('http://localhost/v1/graphs/research-loop/clone', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newId: 'research-loop-mine' }),
  }), deps);
  expect(cloned.status).toBe(201);
  const copied = readFileSync(join(mineDir, 'research-loop-mine.yaml'), 'utf8');
  expect(copied.replace('graph_id: research-loop-mine', 'graph_id: research-loop')).toBe(original);

  const savedText = copied.replace('max_visits: 7', 'max_visits: 8');
  const saved = await handleGraphsPut('/v1/graphs/research-loop-mine/yaml', new Request('http://localhost/v1/graphs/research-loop-mine/yaml', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: savedText }),
  }), deps);
  expect(saved.status).toBe(200);
  const list = await handleGraphsGet('/v1/graphs', coreDir, deps);
  const graphs = (await list.json() as { graphs: Array<{ id: string; source: string; editable: boolean }> }).graphs;
  expect(graphs).toContainEqual(expect.objectContaining({ id: 'research-loop', source: 'core', editable: false }));
  expect(graphs).toContainEqual(expect.objectContaining({ id: 'research-loop-mine', source: 'mine', editable: true }));
  expect((await handleGraphsGet('/v1/graphs/research-loop-mine/yaml', coreDir, deps)).status).toBe(200);

  const broken = await handleGraphsPut('/v1/graphs/research-loop-mine/yaml', new Request('http://localhost/v1/graphs/research-loop-mine/yaml', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: 'graph_id: research-loop-mine\n' }),
  }), deps);
  expect(broken.status).toBe(422);
  expect(await broken.json()).toMatchObject({ error: 'invalid-graph' });
  expect((await handleGraphsPut('/v1/graphs/%2Fetc%2Fpasswd/yaml', new Request('http://localhost', { method: 'PUT', body: '{}' }), deps)).status).toBe(400);
});

function put(id: string, yaml: string, deps: { coreDir: string; mineDir: string }) {
  return handleGraphsPut(`/v1/graphs/${id}/yaml`, new Request(`http://localhost/v1/graphs/${id}/yaml`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml }),
  }), deps);
}

function revert(id: string, version: unknown, deps: { coreDir: string; mineDir: string }) {
  return handleGraphsRevert(`/v1/graphs/${id}/revert`, new Request(`http://localhost/v1/graphs/${id}/revert`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version }),
  }), deps);
}

async function versions(id: string, deps: { coreDir: string; mineDir: string }) {
  const response = handleGraphVersionsGet(`/v1/graphs/${id}/versions`, deps);
  return { status: response.status, body: await response.json() as { versions: Array<{ version: string; savedAt: string; bytes: number }> } };
}

async function cloneMine(newId: string) {
  const deps = { coreDir: defaultGraphsDir(), mineDir: mkdtempSync(join(tmpdir(), 'elanous-mine-graphs-')) };
  const cloned = await handleGraphsClone('/v1/graphs/research-loop/clone', new Request('http://localhost/v1/graphs/research-loop/clone', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newId }),
  }), deps);
  expect(cloned.status).toBe(201);
  return { deps, file: join(deps.mineDir, `${newId}.yaml`) };
}

test('CGE-SAVE: invalid save → 422 with the validator issues and nothing written (no version either)', async () => {
  const { deps, file } = await cloneMine('cge-invalid');
  const before = readFileSync(file, 'utf8');
  // Parses as YAML and keeps graph_id, so only the shared validator can reject it.
  const invalid = before.replace(/^entry_node:.*$/m, 'entry_node: 42');
  expect(invalid).not.toBe(before);
  const response = await put('cge-invalid', invalid, deps);
  expect(response.status).toBe(422);
  const body = await response.json() as { error: string; errors: Array<{ path: string; message: string }> };
  expect(body.error).toBe('invalid-graph');
  expect(body.errors.some((issue) => issue.path.includes('entry_node'))).toBe(true);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(existsSync(join(deps.mineDir, '.versions'))).toBe(false);

  const wrongId = await put('cge-invalid', before.replace('graph_id: cge-invalid', 'graph_id: someone-else'), deps);
  expect(wrongId.status).toBe(400);
  expect(await wrongId.json()).toMatchObject({ error: 'graph-id-mismatch' });
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test('CGE-SAVE: two saves are listed as versions, revert restores bytes and is itself a version', async () => {
  const { deps, file } = await cloneMine('cge-history');
  const original = readFileSync(file, 'utf8');
  const first = original.replace('max_visits: 7', 'max_visits: 8');
  const second = original.replace('max_visits: 7', 'max_visits: 9');

  const saved1 = await put('cge-history', first, deps);
  expect(saved1.status).toBe(200);
  const s1 = await saved1.json() as { version: string; previous: string };
  const saved2 = await put('cge-history', second, deps);
  const s2 = await saved2.json() as { version: string; previous: string };
  expect(s2.previous).toBe(s1.version);
  expect(readFileSync(file, 'utf8')).toBe(second);

  const listed = await versions('cge-history', deps);
  expect(listed.status).toBe(200);
  // baseline (clone bytes, recorded on first save) + save 1 + save 2
  expect(listed.body.versions.map((entry) => entry.version)).toEqual([s1.previous, s1.version, s2.version]);
  expect(listed.body.versions[1]!.bytes).toBe(Buffer.byteLength(first));
  expect(Number.isNaN(Date.parse(listed.body.versions[1]!.savedAt))).toBe(false);

  const reverted = await revert('cge-history', s1.previous, deps);
  expect(reverted.status).toBe(200);
  const r = await reverted.json() as { version: string; previous: string; restoredFrom: string };
  expect(r).toMatchObject({ previous: s2.version, restoredFrom: s1.previous });
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect((await versions('cge-history', deps)).body.versions.at(-1)!.version).toBe(r.version);

  expect((await revert('cge-history', 'no-such-version', deps)).status).toBe(400);
  expect((await revert('cge-history', '2000-01-01T00-00-00-000Z', deps)).status).toBe(404);
  expect((await revert('cge-history', '../../x', deps)).status).toBe(400);
  // a stray .yml in the history dir is not listed (revert only reads .yaml)
  writeFileSync(join(deps.mineDir, '.versions', 'cge-history', '2001-01-01T00-00-00-000Z.yml'), original);
  expect((await versions('cge-history', deps)).body.versions.some((entry) => entry.version.startsWith('2001-'))).toBe(false);
  expect((await revert('cge-history', '2001-01-01T00-00-00-000Z', deps)).status).toBe(404);
  // no temp files left next to the graph
  expect(readdirSync(deps.mineDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  expect((await revert('cge-history', '---', deps)).status).toBe(400);
  const nullBody = await handleGraphsRevert('/v1/graphs/cge-history/revert', new Request('http://localhost/v1/graphs/cge-history/revert', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null',
  }), deps);
  expect(nullBody.status).toBe(400);
  const nullPut = await handleGraphsPut('/v1/graphs/cge-history/yaml', new Request('http://localhost/v1/graphs/cge-history/yaml', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: 'null',
  }), deps);
  expect(nullPut.status).toBe(400);
});

test('CGE-SAVE: history is capped and core graphs have no history and cannot be reverted', async () => {
  const { deps } = await cloneMine('cge-cap');
  const base = readFileSync(join(deps.mineDir, 'cge-cap.yaml'), 'utf8');
  for (let n = 0; n < GRAPH_VERSION_CAP + 3; n += 1) {
    expect((await put('cge-cap', base.replace('max_visits: 7', `max_visits: ${10 + n}`), deps)).status).toBe(200);
  }
  expect((await versions('cge-cap', deps)).body.versions).toHaveLength(GRAPH_VERSION_CAP);

  const coreFile = join(deps.coreDir, 'research-loop.yaml');
  const coreBefore = readFileSync(coreFile, 'utf8');
  expect(handleGraphVersionsGet('/v1/graphs/research-loop/versions', deps).status).toBe(403);
  const refused = await revert('research-loop', '2000-01-01T00-00-00-000Z', deps);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: 'core-read-only' });
  expect(readFileSync(coreFile, 'utf8')).toBe(coreBefore);
  expect(existsSync(join(deps.coreDir, '.versions'))).toBe(false);
});

test('CGE-SAVE: versions and revert routes require auth', async () => {
  expect((await request('/v1/graphs/research-loop/versions', 'GET', false))?.status).toBe(401);
  expect((await request('/v1/graphs/research-loop/revert', 'POST', false))?.status).toBe(401);
});

test('CGE-SAVE: POST /v1/graphs creates a new «mine» graph with version v1; exists 409, core 403, id mismatch 400', async () => {
  const deps = { coreDir: defaultGraphsDir(), mineDir: join(mkdtempSync(join(tmpdir(), 'elanous-mine-graphs-')), 'not-yet') };
  const coreText = readFileSync(join(deps.coreDir, 'research-loop.yaml'), 'utf8');
  const fresh = coreText.replace(/^graph_id:.*$/m, 'graph_id: cge-new');
  const create = (id: unknown, yaml: unknown) => handleGraphsCreate(new Request('http://localhost/v1/graphs', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, yaml }),
  }), deps);

  const created = await create('cge-new', fresh);
  expect(created.status).toBe(201);
  const body = await created.json() as { id: string; source: string; editable: boolean; saved: boolean; version: string };
  expect(body).toMatchObject({ id: 'cge-new', source: 'mine', editable: true, saved: true, previous: null });
  expect(readFileSync(join(deps.mineDir, 'cge-new.yaml'), 'utf8')).toBe(fresh);
  expect((await versions('cge-new', deps)).body.versions.map((entry) => entry.version)).toEqual([body.version]);
  const list = await handleGraphsGet('/v1/graphs', deps.coreDir, deps);
  expect((await list.json() as { graphs: unknown[] }).graphs).toContainEqual(expect.objectContaining({ id: 'cge-new', source: 'mine', editable: true }));

  // then a normal save works and chains to v1
  const saved = await put('cge-new', fresh.replace('max_visits: 7', 'max_visits: 8'), deps);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ previous: body.version });

  expect((await create('cge-new', fresh)).status).toBe(409);
  const core = await create('research-loop', coreText);
  expect(core.status).toBe(403);
  expect(await core.json()).toMatchObject({ error: 'core-read-only' });
  expect(readFileSync(join(deps.coreDir, 'research-loop.yaml'), 'utf8')).toBe(coreText);
  const mismatch = await create('cge-other', fresh);
  expect(mismatch.status).toBe(400);
  expect(existsSync(join(deps.mineDir, 'cge-other.yaml'))).toBe(false);
  expect((await create('../etc', fresh)).status).toBe(400);
  expect((await create('cge-bad', 'graph_id: cge-bad\n')).status).toBe(422);
  expect(existsSync(join(deps.mineDir, 'cge-bad.yaml'))).toBe(false);
});

test('CGE-SAVE: POST /v1/graphs route requires auth', async () => {
  expect((await request('/v1/graphs', 'POST', false))?.status).toBe(401);
  // authorized POST reaches the create handler (no body → 400 before any write), not 405
  expect((await request('/v1/graphs', 'POST'))?.status).toBe(400);
});

test('CGE-SAVE security: reserved sidecar ids (recipes …) are refused on create, PUT, revert, versions and clone', async () => {
  expect(RESERVED_GRAPH_IDS.has('recipes')).toBe(true);
  const deps = { coreDir: defaultGraphsDir(), mineDir: mkdtempSync(join(tmpdir(), 'elanous-mine-graphs-')) };
  const recipeText = "graph_id: recipes\nmain:\n  command: 'touch /tmp/pwned'\n";
  // A hand-placed recipes.yaml declaring a graph id must not be treated as that graph either.
  writeFileSync(join(deps.mineDir, 'recipes.yaml'), recipeText);
  const created = await handleGraphsCreate(new Request('http://localhost/v1/graphs', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'recipes', yaml: recipeText }),
  }), deps);
  expect(created.status).toBe(400);
  expect(await created.json()).toMatchObject({ error: 'reserved-id' });
  const saved = await put('recipes', recipeText, deps);
  expect(saved.status).toBe(400);
  expect(await saved.json()).toMatchObject({ error: 'reserved-id' });
  expect((await revert('recipes', '2000-01-01T00-00-00-000Z', deps)).status).toBe(400);
  expect(handleGraphVersionsGet('/v1/graphs/recipes/versions', deps).status).toBe(400);
  const cloned = await handleGraphsClone('/v1/graphs/research-loop/clone', new Request('http://localhost/v1/graphs/research-loop/clone', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newId: 'recipes' }),
  }), deps);
  expect(cloned.status).toBe(400);
  expect(readFileSync(join(deps.mineDir, 'recipes.yaml'), 'utf8')).toBe(recipeText);
  expect(existsSync(join(deps.mineDir, '.versions'))).toBe(false);
});

test('CGE-SAVE: files under .versions never appear as graphs', async () => {
  const { deps } = await cloneMine('cge-hidden');
  const text = readFileSync(join(deps.mineDir, 'cge-hidden.yaml'), 'utf8');
  expect((await put('cge-hidden', text.replace('max_visits: 7', 'max_visits: 8'), deps)).status).toBe(200);
  // a version file that declares a different id is still not a graph
  const dir = join(deps.mineDir, '.versions', 'cge-hidden');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2000-01-01T00-00-00-000Z.yaml'), text.replace('graph_id: cge-hidden', 'graph_id: ghost-version'));
  const list = await handleGraphsGet('/v1/graphs', deps.coreDir, deps);
  const ids = (await list.json() as { graphs: Array<{ id: string }> }).graphs.map((graph) => graph.id);
  expect(ids).toContain('cge-hidden');
  expect(ids).not.toContain('ghost-version');
  expect((await handleGraphsGet('/v1/graphs/ghost-version/yaml', deps.coreDir, deps)).status).toBe(404);
});
