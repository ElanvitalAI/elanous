import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraphManifestForFile, loadGraphPluginFromDir } from './graph-manifest-loader.js';
import { runGraph } from './runner.js';
import { compilePluginYaml } from '../plugins/core/plugin-yaml.js';

const graph = (id: string) => `graph_id: ${id}\nversion: 1\nentry_node: done\nterminal_nodes: [done]\nnodes:\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges: []\n`;
async function fixture(run: (dir: string, write: (body: Record<string, unknown>) => void) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'graph-manifest-'));
  const write = (extension: Record<string, unknown>) => writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
    name: 'example-graphs', version: '1.0.0', extensions: { 'ai.elanous': extension },
  }));
  try { await run(dir, write); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('generic graph plugin loader binds arbitrary graph IDs to their plugin declarations', () => fixture((dir, write) => {
  writeFileSync(join(dir, 'flow.yaml'), graph('custom-flow'));
  write({ graphs: ['./flow.yaml'], graphManifests: { 'custom-flow': { purpose: 'Run a custom flow', allow: { recipes: [] }, hitl: [] } } });
  const loaded = loadGraphPluginFromDir(dir);
  expect(loaded.plugin.id).toBe('example-graphs');
  expect(loaded.graphs['custom-flow']?.template.graphId).toBe('custom-flow');
  expect(loaded.graphs['custom-flow']?.manifest.purpose).toBe('Run a custom flow');
  expect(loaded.graphs['custom-flow']?.file).toBe(realpathSync(join(dir, 'flow.yaml')));
}));

test('loader fails closed on absent declarations, undeclared IDs, and paths escaping the plugin root', () => fixture((dir, write) => {
  writeFileSync(join(dir, 'flow.yaml'), graph('custom-flow'));
  write({ graphs: ['./flow.yaml'] });
  expect(() => loadGraphPluginFromDir(dir)).toThrow('graphManifests');
  write({ graphs: ['./flow.yaml'], graphManifests: { other: { purpose: 'Other', allow: { recipes: [] }, hitl: [] } } });
  expect(() => loadGraphPluginFromDir(dir)).toThrow('custom-flow');
  write({ graphs: ['../outside.yaml'], graphManifests: { 'custom-flow': { purpose: 'Flow', allow: { recipes: [] }, hitl: [] } } });
  expect(() => loadGraphPluginFromDir(dir)).toThrow("must not contain '..' segments");
}));

test('loader rejects symlink escapes and duplicate graph IDs', () => fixture((dir, write) => {
  symlinkSync('/etc/hosts', join(dir, 'outside.yaml'));
  write({ graphs: ['./outside.yaml'], graphManifests: { 'custom-flow': { purpose: 'Flow', allow: { recipes: [] }, hitl: [] } } });
  expect(() => loadGraphPluginFromDir(dir)).toThrow('escapes plugin root through symlink');
  writeFileSync(join(dir, 'first.yaml'), graph('custom-flow'));
  writeFileSync(join(dir, 'second.yaml'), graph('custom-flow'));
  write({ graphs: ['./first.yaml', './second.yaml'], graphManifests: { 'custom-flow': { purpose: 'Flow', allow: { recipes: [] }, hitl: [] } } });
  expect(() => loadGraphPluginFromDir(dir)).toThrow("duplicate graph_id 'custom-flow'");
}));

test('loader rejects a node recipe outside its manifest', () => fixture((dir, write) => {
  writeFileSync(join(dir, 'flow.yaml'), graph('custom-flow').replace('recipe: none', 'recipe: cmd:outside'));
  write({ graphs: ['./flow.yaml'], graphManifests: { 'custom-flow': { purpose: 'Flow', allow: { recipes: [] }, hitl: [] } } });
  expect(() => loadGraphPluginFromDir(dir)).toThrow('graph.manifest-denied: recipe cmd:outside');
}));

test('loader accepts a command recipe when its recipe ID is declared', () => fixture((dir, write) => {
  writeFileSync(join(dir, 'flow.yaml'), graph('custom-flow').replace('recipe: none', 'recipe: cmd:run'));
  write({ graphs: ['./flow.yaml'], graphManifests: { 'custom-flow': { purpose: 'Run a custom flow', allow: { recipes: ['run'] }, hitl: [] } } });
  expect(loadGraphPluginFromDir(dir).graphs['custom-flow']?.manifest.allow.recipes).toEqual(['run']);
}));

test('runner rejects an injected recipe before dispatch for a manifested graph', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-manifest-run-'));
  try {
    const path = join(dir, 'flow.yaml');
    writeFileSync(path, graph('custom-flow'));
    writeFileSync(join(dir, 'recipes.yaml'), '{}\n');
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'example-graphs', version: '1.0.0', extensions: {
      'ai.elanous': { graphs: ['./flow.yaml'], graphManifests: { 'custom-flow': {
        purpose: 'Flow', allow: { recipes: [] }, hitl: [],
      } } },
    } }));
    await expect(runGraph(path, { graphSource: graph('custom-flow').replace('recipe: none', 'recipe: cmd:outside'),
      deps: { root: join(dir, 'state') } })).rejects.toThrow('graph.manifest-denied: recipe cmd:outside');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loader validates declared skills, domain packs, policy defaults, and graph policy references', () => fixture((dir, write) => {
  writeFileSync(join(dir, 'flow.yaml'), graph('custom-flow').replace('entry_node: done', 'entry_node: done\npolicy: { attempts: "$policy.heal.maxAttempts" }'));
  const declaration = {
    purpose: 'Policy-bound flow',
    allow: { recipes: [], skills: ['release-operations'], domainPacks: ['release-ops'], maxSideEffects: 'write' },
    policy: { 'heal.maxAttempts': { type: 'int', default: 2, bounds: [1, 3] } },
    hitl: [], observe: { categories: ['graph', 'release-loop'] },
  };
  write({ graphs: ['./flow.yaml'], graphManifests: { 'custom-flow': declaration } });
  expect(loadGraphPluginFromDir(dir).graphs['custom-flow']?.manifest).toMatchObject(declaration);

  write({ graphs: ['./flow.yaml'], graphManifests: { 'custom-flow': {
    ...declaration,
    policy: { 'heal.maxAttempts': { type: 'int', default: 'many' } },
  } } });
  expect(() => loadGraphPluginFromDir(dir)).toThrow('default does not match int');

  write({ graphs: ['./flow.yaml'], graphManifests: { 'custom-flow': {
    ...declaration,
    allow: { ...declaration.allow, skills: [''] },
  } } });
  expect(() => loadGraphPluginFromDir(dir)).toThrow('allow.skills must be a string array');
}));

test('loader rejects graph policy references and edge keys outside the declared vocabulary', () => fixture((dir, write) => {
  writeFileSync(join(dir, 'flow.yaml'), graph('custom-flow').replace('edges: []',
    'policy: { attempts: "$policy.heal.unknown" }\nedges:\n  - { from: done, to: done, magic_edge: true }'));
  write({ graphs: ['./flow.yaml'], graphManifests: { 'custom-flow': {
    purpose: 'Flow', allow: { recipes: [], skills: [], domainPacks: [] }, policy: {}, hitl: [],
    observe: { categories: ['graph'] },
  } } });
  expect(() => loadGraphPluginFromDir(dir)).toThrow('unsupported edge vocabulary: magic_edge');
  writeFileSync(join(dir, 'flow.yaml'), graph('custom-flow').replace('edges: []',
    'policy: { attempts: "$policy.heal.unknown" }\nedges: []'));
  expect(() => loadGraphPluginFromDir(dir)).toThrow('references undeclared policy key: heal.unknown');
}));

test('production release manifest loads under the generic declaration checks', () => {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const loaded = loadGraphPluginFromDir(join(root, 'graphs', 'release'));
  expect(Object.keys(loaded.graphs)).toEqual(['release-loop']);
  expect(loaded.graphs['release-loop']?.manifest.observe?.categories).toContain('release-loop.*');
  const general = loadGraphPluginFromDir(join(root, 'graphs', 'templates', 'release'));
  expect(Object.keys(general.graphs)).toEqual(['release-template']);
});

test('compiled plugin.yaml owns an executable graph.yaml v2 and rejects a stale generated manifest', async () => fixture(async (dir) => {
  const source = `apiVersion: elanous.dev/graph/v2\n` +
    `graph: { id: graph-plugin-format, version: 1.0.0, layer: flow, purpose: Run a declared graph }\n` +
    `entry: work\nnodes:\n  - { id: work, type: gate }\nedges:\n  - { from: work, to: done }\nterminal: [done]\n`;
  writeFileSync(join(dir, 'graph.yaml'), source);
  writeFileSync(join(dir, 'plugin.yaml'), `apiVersion: elanous.dev/plugin/v2\nid: graph-plugin-format\n` +
    `name: Graph Plugin Format\nversion: 1.0.0\ngraphs: [./graph.yaml]\n`);
  writeFileSync(join(dir, 'plugin.json'), compilePluginYaml(dir));
  const loaded = loadGraphPluginFromDir(dir);
  expect(loaded.graphs['graph-plugin-format']?.template.graphId).toBe('graph-plugin-format');
  const state = await runGraph(join(dir, 'graph.yaml'), { dryRun: true, quiet: true, deps: { root: join(dir, 'state') } });
  expect(state.status).toBe('done');
  await expect(runGraph(join(dir, 'graph.yaml'), { graphSource: source.replace('id: graph-plugin-format', 'id: injected-flow'),
    deps: { root: join(dir, 'state') } })).rejects.toThrow('graph.manifest-denied');
  writeFileSync(join(dir, 'plugin.json'), compilePluginYaml(dir).replace('"version": "1.0.0"', '"version": "1.0.1"'));
  expect(() => loadGraphPluginFromDir(dir)).toThrow('plugin.json is stale');
}));

test('v2 capability nodes require the plugin manifest to declare their capability', () => fixture(async (dir) => {
  const source = `apiVersion: elanous.dev/graph/v2\n` +
    `graph: { id: capability-flow, version: 1.0.0, layer: flow, purpose: Read declared data }\n` +
    `entry: read\nnodes:\n  - { id: read, type: store, requires: store.read@1 }\n` +
    `edges:\n  - { from: read, to: done }\nterminal: [done]\n`;
  writeFileSync(join(dir, 'graph.yaml'), source);
  const plugin = (capabilities: string) => `apiVersion: elanous.dev/plugin/v2\nid: capability-flow\n` +
    `name: Capability Flow\nversion: 1.0.0\ngraphs: [./graph.yaml]\ncapabilities: ${capabilities}\n`;
  writeFileSync(join(dir, 'plugin.yaml'), plugin('[store]'));
  writeFileSync(join(dir, 'plugin.json'), compilePluginYaml(dir));
  expect(loadGraphPluginFromDir(dir).graphs['capability-flow']?.manifest.allow.capabilities).toEqual(['store']);
  const state = await runGraph(join(dir, 'graph.yaml'), { dryRun: true, quiet: true, deps: { root: join(dir, 'state') } });
  expect(state.status).toBe('done');
  writeFileSync(join(dir, 'plugin.yaml'), plugin('[]'));
  writeFileSync(join(dir, 'plugin.json'), compilePluginYaml(dir));
  expect(() => loadGraphPluginFromDir(dir)).toThrow('graph.manifest-denied: capability store.read@1');
  await expect(runGraph(join(dir, 'graph.yaml'), { dryRun: true, quiet: true, deps: { root: join(dir, 'state') } }))
    .rejects.toThrow('graph.manifest-denied: capability store.read@1');
}));

test('cap recipes cannot use the ordinary recipe allowlist to bypass capability admission', () => fixture((dir, write) => {
  writeFileSync(join(dir, 'flow.yaml'), `graph_id: cap-allowlist-bypass\nversion: 1\nentry_node: use\n` +
    `terminal_nodes: [done]\nnodes:\n  - { node_id: use, kind: capability, recipe: 'cap:store', max_visits: 1 }\n` +
    `  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n` +
    `edges:\n  - { from: use, on: outcome, map: { ok: done, fail: done, error: done } }\n`);
  const declaration = { purpose: 'Reject undeclared capability', allow: { recipes: ['cap:store'] }, hitl: [] };
  write({ graphs: ['./flow.yaml'], capabilities: [], graphManifests: { 'cap-allowlist-bypass': declaration } });
  expect(() => loadGraphPluginFromDir(dir)).toThrow('graph.manifest-denied: capability store');
  write({ graphs: ['./flow.yaml'], capabilities: ['store'], graphManifests: { 'cap-allowlist-bypass': declaration } });
  expect(loadGraphPluginFromDir(dir).graphs['cap-allowlist-bypass']?.manifest.allow.capabilities).toEqual(['store']);
}));

test('manifest discovery climbs nested plugin paths and keeps null declarations in transition mode', () => fixture(async (dir) => {
  const nested = join(dir, 'graphs', 'units', 'verbs');
  mkdirSync(nested, { recursive: true });
  const file = join(nested, 'flow.yaml');
  writeFileSync(file, graph('custom-flow'));
  writeFileSync(join(nested, 'recipes.yaml'), '{}\n');
  const manifest = { name: 'nested-graphs', version: '1.0.0', extensions: { 'ai.elanous': {
    graphs: ['./graphs/units/verbs/flow.yaml'], graphManifests: {
      'custom-flow': { purpose: 'Nested flow', allow: { recipes: [], skills: [], domainPacks: [] }, hitl: [] },
    },
  } } };
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
  expect(loadGraphManifestForFile(file, 'custom-flow')?.graphId).toBe('custom-flow');
  expect((await runGraph(file, { deps: { root: join(dir, 'nested-state') } })).status).toBe('done');

  for (const extensions of [null, { 'ai.elanous': null }, { 'ai.elanous': { graphManifests: null } }]) {
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'legacy', version: '1.0.0', extensions }));
    expect(loadGraphManifestForFile(file, 'custom-flow')).toBeUndefined();
  }
}));

test('runner checks the executable graph source against the declared HITL boundary', async () => fixture(async (dir, write) => {
  const file = join(dir, 'flow.yaml');
  const source = graph('custom-flow');
  writeFileSync(file, source);
  writeFileSync(join(dir, 'recipes.yaml'), '{}\n');
  write({ graphs: ['./flow.yaml'], graphManifests: { 'custom-flow': {
    purpose: 'Flow', allow: { recipes: [], skills: [], domainPacks: [] }, hitl: [],
  } } });
  await expect(runGraph(file, { graphSource: source.replace('kind: gate', 'kind: hitl'), deps: { root: join(dir, 'state') } }))
    .rejects.toThrow('hitl differs from executable graph hitl nodes');
}));

test('nested legacy plugin declarations do not inherit a parent plugin graph manifest', async () => fixture(async (dir) => {
  const child = join(dir, 'nested-plugin');
  mkdirSync(child);
  const childGraph = join(child, 'flow.yaml');
  writeFileSync(childGraph, graph('child-flow'));
  writeFileSync(join(child, 'recipes.yaml'), '{}\n');
  writeFileSync(join(dir, 'parent.yaml'), graph('parent-flow'));
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'parent', version: '1.0.0', extensions: {
    'ai.elanous': { graphs: ['./parent.yaml'], graphManifests: {
      'parent-flow': { purpose: 'Parent', allow: { recipes: [], skills: [], domainPacks: [] }, hitl: [] },
    } },
  } }));

  for (const [index, extensions] of [null, { 'ai.elanous': null }, { 'ai.elanous': { graphManifests: null } }].entries()) {
    writeFileSync(join(child, 'plugin.json'), JSON.stringify({ name: 'legacy-child', version: '1.0.0', extensions }));
    expect((await runGraph(childGraph, { deps: { root: join(child, `state-${index}`) } })).status).toBe('done');
  }
}));
