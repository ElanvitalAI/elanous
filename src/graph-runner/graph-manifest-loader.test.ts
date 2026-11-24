import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraphManifestForFile, loadGraphPluginFromDir } from './graph-manifest-loader.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';

/** Independent of the product: the documented host default catalog path (rule 11). */
// Source: #38482 manifest fixtures use a single visit for linear graph steps.
const fixtureSingleVisit = 1;
// Source: #38482 append fixture permits the subscribed node to wake once again.
const fixtureWakeVisits = 2;

const graphVocabularyCatalogPath = () => join(effectiveInstanceRoot(), 'graph', 'capability-vocabulary.json');
import { debug } from '../debug/log.js';
import { getUserConfig, runWithUserConfigSnapshot } from '../user-config.js';
import { runGraph } from './runner.js';
import { graphCapabilityVocabularyDigest, type GraphCapabilityContract, type GraphCapabilityVocabularyEntry } from './capabilities.js';
import { compilePluginYaml } from '../plugins/core/plugin-yaml.js';

const graph = (id: string) => `graph_id: ${id}\nversion: 1\nentry_node: done\nterminal_nodes: [done]\nnodes:\n  - { node_id: done, kind: gate, recipe: none, max_visits: ${fixtureSingleVisit} }\nedges: []\n`;
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
    `terminal_nodes: [done]\nnodes:\n  - { node_id: use, kind: capability, recipe: 'cap:store', max_visits: ${fixtureSingleVisit} }\n` +
    `  - { node_id: done, kind: gate, recipe: none, max_visits: ${fixtureSingleVisit} }\n` +
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

const vocabularyFlow = (requires: string) => `graph_id: vocab-flow\nversion: 1\nentry_node: read\nterminal_nodes: [done]\n` +
  `nodes:\n  - { node_id: read, kind: capability, recipe: none, requires: ${requires}, max_visits: ${fixtureSingleVisit} }\n` +
  `  - { node_id: done, kind: gate, recipe: none, max_visits: ${fixtureSingleVisit} }\n` +
  `edges:\n  - { from: read, on: outcome, map: { ok: done, failed: done } }\n`;
const catalogContract = (id: string): GraphCapabilityContract =>
  ({ id: id as GraphCapabilityContract['id'], input: { type: 'object' }, output: { type: 'object' } });
const catalogEntries = (): GraphCapabilityVocabularyEntry[] => [
  { id: 'search.web@1', status: 'approved', reviewer: 'jud-b', contract: catalogContract('search.web@1') },
  { id: 'answer.compose@1', status: 'proposed', contract: catalogContract('answer.compose@1') },
  { id: 'answer.compose@2', status: 'approved', reviewer: 'jud-b', contract: catalogContract('answer.compose@2') },
];
/** Review-owned catalog at the host default (<isolated state>/graph/capability-vocabulary.json); `dir` is unused by design. */
const writeCatalog = (_dir: string, entries: GraphCapabilityVocabularyEntry[], digest?: string, file = graphVocabularyCatalogPath()): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ entries, digest: digest ?? graphCapabilityVocabularyDigest(entries) }));
};
afterEach(() => { rmSync(graphVocabularyCatalogPath(), { force: true }); });
const vocabularyRefusals = () => debug.events(500).filter(entry => entry.category === 'graph.manifest' && entry.event === 'vocabulary-refused')
  .map(entry => entry.data as Record<string, unknown>);
const writeVocabularyPlugin = (dir: string, graphs: string[], digest: string,
  graphManifests: Record<string, unknown>): string => {
  const pluginDir = join(dir, 'plugin');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'vocab-graphs', version: '1.0.0',
    extensions: { 'ai.elanous': {
      graphs, capabilityVocabulary: { digest }, graphManifests,
    } } }));
  return pluginDir;
};

test('GRAPH-VOCAB-DYNAMIC: unreviewed capability names are rejected at load against the pinned edition', () => fixture((dir) => {
  const entries = catalogEntries();
  writeCatalog(dir, entries);
  const flow = (requires: string) => {
    mkdirSync(join(dir, 'plugin'), { recursive: true });
    writeFileSync(join(dir, 'plugin', 'flow.yaml'), vocabularyFlow(requires));
  };
  const declare = () => writeVocabularyPlugin(dir, ['./flow.yaml'], graphCapabilityVocabularyDigest(entries),
    { 'vocab-flow': { purpose: 'Reviewed vocabulary flow', allow: { recipes: [] }, hitl: [] } });

  flow('search.web@1');
  declare();
  const manifest = loadGraphPluginFromDir(join(dir, 'plugin')).graphs['vocab-flow']?.manifest;
  expect(manifest?.capabilityVocabulary?.digest).toBe(graphCapabilityVocabularyDigest(entries));
  expect(manifest?.allow.capabilities).toEqual([]);
  // 미심사(proposed) 이름 노드 거부
  flow('answer.compose@1');
  expect(() => loadGraphPluginFromDir(join(dir, 'plugin'))).toThrow('graph.manifest-denied: capability answer.compose@1 is proposed, not approved');
  // 프로토타입 키 이름도 어휘 밖이다(점검표 1)
  flow('constructor.web@1');
  expect(() => loadGraphPluginFromDir(join(dir, 'plugin'))).toThrow('graph.manifest-denied: capability constructor.web@1 is outside the pinned capability vocabulary');
  // 어휘 밖 이름 거부
  flow('crawl.site@1');
  expect(() => loadGraphPluginFromDir(join(dir, 'plugin'))).toThrow('graph.manifest-denied: capability crawl.site@1 is outside the pinned capability vocabulary');
  // 판 고정: 승인은 정확히 그 판의 버전에만 성립한다
  flow('search.web@2');
  expect(() => loadGraphPluginFromDir(join(dir, 'plugin'))).toThrow('graph.manifest-denied: capability search.web@2 is outside the pinned capability vocabulary');
  flow('answer.compose@2');
  expect(loadGraphPluginFromDir(join(dir, 'plugin')).graphs['vocab-flow']?.manifest.capabilityVocabulary?.digest)
    .toBe(graphCapabilityVocabularyDigest(entries));
}));

test('GRAPH-VOCAB-DYNAMIC: a plugin cannot self-approve — entries are review-owned and the edition is separate', () => fixture((dir) => {
  const entries = catalogEntries();
  const digest = graphCapabilityVocabularyDigest(entries);
  const pluginDir = join(dir, 'plugin');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'flow.yaml'), vocabularyFlow('answer.compose@1'));
  const writePlugin = (vocabulary: Record<string, unknown>) => writeFileSync(join(pluginDir, 'plugin.json'),
    JSON.stringify({ name: 'vocab-graphs', version: '1.0.0', extensions: { 'ai.elanous': {
      graphs: ['./flow.yaml'], capabilityVocabulary: vocabulary,
      graphManifests: { 'vocab-flow': { purpose: 'Flow', allow: { recipes: [] }, hitl: [] } },
    } } }));

  // 플러그인 선언에 항목을 실으면 거부: 심사 결과는 플러그인 저작물이 아니다.
  writePlugin({ digest, entries: [{ id: 'answer.compose@1', status: 'approved', reviewer: 'attacker', contract: catalogContract('answer.compose@1') }] });
  expect(() => loadGraphPluginFromDir(pluginDir)).toThrow('entries are review-owned');

  // 플러그인 디렉터리 안의 카탈로그(자체 승인판)는 결코 참조되지 않는다.
  const attackerEntries: GraphCapabilityVocabularyEntry[] = [
    { id: 'answer.compose@1', status: 'approved', reviewer: 'attacker', contract: catalogContract('answer.compose@1') },
  ];
  writeFileSync(join(pluginDir, 'capability-vocabulary.json'),
    JSON.stringify({ entries: attackerEntries, digest: graphCapabilityVocabularyDigest(attackerEntries) }));
  writePlugin({ digest: graphCapabilityVocabularyDigest(attackerEntries) });
  expect(() => loadGraphPluginFromDir(pluginDir)).toThrow('graph.manifest-denied: the host capability vocabulary catalog is missing');

  // 정본 카탈로그와 다른 판을 고정하면 판 불일치로 거부된다.
  writeCatalog(dir, entries);
  const flipped = digest.endsWith('0') ? `${digest.slice(0, 63)}1` : `${digest.slice(0, 63)}0`;
  writePlugin({ digest: flipped });
  expect(() => loadGraphPluginFromDir(pluginDir)).toThrow('plugin pins capability vocabulary edition');

  // 카탈로그 항목을 digest 없이 바꾸면(제안을 승인으로) 판 위조로 거부된다.
  const tampered: GraphCapabilityVocabularyEntry[] = [
    entries[0]!,
    { ...entries[1]!, status: 'approved', reviewer: 'attacker' },
    entries[2]!,
  ];
  writeCatalog(dir, tampered, digest);
  writePlugin({ digest });
  expect(() => loadGraphPluginFromDir(pluginDir)).toThrow('capability vocabulary edition digest does not match its entries');
}));

test('GRAPH-VOCAB-DYNAMIC: the runner rejects an injected unreviewed requires through the same manifest gate', () => fixture(async (dir) => {
  const entries = catalogEntries();
  writeCatalog(dir, entries);
  const pluginDir = join(dir, 'plugin');
  mkdirSync(pluginDir, { recursive: true });
  const path = join(pluginDir, 'flow.yaml');
  writeFileSync(path, vocabularyFlow('search.web@1'));
  writeFileSync(join(pluginDir, 'recipes.yaml'), '{}\n');
  writeVocabularyPlugin(dir, ['./flow.yaml'], graphCapabilityVocabularyDigest(entries),
    { 'vocab-flow': { purpose: 'Reviewed vocabulary flow', allow: { recipes: [] }, hitl: [] } });

  const state = await runGraph(path, { dryRun: true, quiet: true, deps: { root: join(dir, 'state') } });
  expect(state.status).toBe('done');
  await expect(runGraph(path, { graphSource: vocabularyFlow('answer.compose@1'),
    deps: { root: join(dir, 'state-injected') } }))
    .rejects.toThrow('graph.manifest-denied: capability answer.compose@1 is proposed, not approved');
  await expect(runGraph(path, { graphSource: vocabularyFlow('crawl.site@1'),
    deps: { root: join(dir, 'state-outside') } }))
    .rejects.toThrow('graph.manifest-denied: capability crawl.site@1 is outside the pinned capability vocabulary');
}));

test('GRAPH-VOCAB-DYNAMIC: the appendGraph port rejects an unreviewed capability node mid-run', () => fixture(async (dir) => {
  const entries = catalogEntries();
  writeCatalog(dir, entries);
  const pluginDir = join(dir, 'plugin');
  mkdirSync(pluginDir, { recursive: true });
  const graphFile = join(pluginDir, 'append.yaml');
  writeFileSync(graphFile, `graph_id: vocab-append\nversion: 1\nentry_node: first\nterminal_nodes: [done, failed]\n` +
    `nodes:\n` +
    `  - { node_id: first, kind: agent, recipe: handler:emit-append, max_visits: ${fixtureSingleVisit}, emits: [vocab.test.append-wake] }\n` +
    `  - { node_id: second, kind: agent, recipe: 'cmd:second', max_visits: ${fixtureWakeVisits}, subscribes: [{ event: vocab.test.append-wake, match: { nodeId: first }, action: wake }] }\n` +
    `  - { node_id: done, kind: gate, recipe: none, max_visits: ${fixtureSingleVisit} }\n` +
    `  - { node_id: failed, kind: gate, recipe: none, max_visits: ${fixtureSingleVisit} }\n` +
    `edges:\n` +
    `  - { from: first, on: outcome, map: { ok: second, failed: failed, error: failed } }\n` +
    `  - { from: second, on: outcome, map: { ok: done, failed: failed, error: failed } }\n`);
  writeFileSync(join(pluginDir, 'recipes.yaml'), 'second:\n  command: "printf second"\n');
  writeVocabularyPlugin(dir, ['./append.yaml'], graphCapabilityVocabularyDigest(entries), {
    'vocab-append': { purpose: 'Reviewed append flow', allow: { recipes: ['second', 'handler:emit-append'] }, hitl: [] },
  });

  const appendResults: Array<{ disposition: string; nodeId?: string; reason?: string }> = [];
  const state = await runGraph(graphFile, { quiet: true, deps: {
    root: join(dir, 'state'),
    inProcessHandlers: { 'emit-append': async (context) => {
      await context.emitEvent?.('vocab.test.append-wake', {});
      return { ok: true, outcome: 'ok' };
    } },
    runBash: async () => ({ exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' }),
    dispatchGraphSubscription: async (dispatch) => {
      if (!dispatch.appendGraph) throw new Error('append graph port was not provided');
      appendResults.push(await dispatch.appendGraph({
        // 근거: #37609 — append 수리 노드는 단일 방문(maxVisits 1)으로 제안한다.
        nodes: [{ nodeId: 'search', kind: 'capability', recipe: 'none', requires: 'answer.compose@1', maxVisits: 1 }],
        edges: [{ from: 'search', on: 'outcome', map: { ok: 'second', fail: 'failed', error: 'failed' } }],
        entryNodeId: 'search', returnTo: 'second', failureTo: 'failed',
        reason: 'append an unreviewed capability node',
      }));
    },
  } });
  expect(state.status).toBe('done');
  expect(appendResults).toEqual([{
    disposition: 'rejected',
    nodeId: 'search',
    reason: 'graph.manifest-denied: capability answer.compose@1 is proposed, not approved',
  }]);
}));

test('GRAPH-VOCAB-DYNAMIC (#37609 MF1): a self-approved catalog in a plugin-controlled parent directory is never read', () => fixture((dir) => {
  const attackerEntries: GraphCapabilityVocabularyEntry[] = [
    { id: 'answer.compose@1', status: 'approved', reviewer: 'attacker', contract: catalogContract('answer.compose@1') },
  ];
  const attackerDigest = graphCapabilityVocabularyDigest(attackerEntries);
  writeFileSync(join(dir, 'capability-vocabulary.json'), JSON.stringify({ entries: attackerEntries, digest: attackerDigest }));
  mkdirSync(join(dir, 'plugin'), { recursive: true });
  writeFileSync(join(dir, 'plugin', 'flow.yaml'), vocabularyFlow('answer.compose@1'));
  writeVocabularyPlugin(dir, ['./flow.yaml'], attackerDigest,
    { 'vocab-flow': { purpose: 'Flow', allow: { recipes: [] }, hitl: [] } });
  // No host catalog: refused, the parent-directory catalog is not discovered.
  expect(existsSync(graphVocabularyCatalogPath())).toBe(false);
  expect(() => loadGraphPluginFromDir(join(dir, 'plugin'))).toThrow('graph.manifest-denied: the host capability vocabulary catalog is missing');
  expect(vocabularyRefusals().at(-1)).toMatchObject({ reason: 'catalog-missing' });
  // A real host catalog of another edition: still refused, the attacker digest never matches the host edition.
  writeCatalog(dir, catalogEntries());
  expect(() => loadGraphPluginFromDir(join(dir, 'plugin'))).toThrow('graph.manifest-denied: plugin pins capability vocabulary edition');
  expect(vocabularyRefusals().at(-1)).toMatchObject({ reason: 'edition-mismatch' });
}));

test('GRAPH-VOCAB-DYNAMIC (#37609 MF1): the host-configured graph.vocabularyCatalog is the catalog that is read and accepted', () => fixture((dir) => {
  const entries = catalogEntries();
  const hostDir = mkdtempSync(join(tmpdir(), 'graph-vocab-host-'));
  try {
    const hostCatalog = join(hostDir, 'reviewed-vocabulary.json');
    writeCatalog(dir, entries, undefined, hostCatalog);
    mkdirSync(join(dir, 'plugin'), { recursive: true });
    writeFileSync(join(dir, 'plugin', 'flow.yaml'), vocabularyFlow('search.web@1'));
    writeVocabularyPlugin(dir, ['./flow.yaml'], graphCapabilityVocabularyDigest(entries),
      { 'vocab-flow': { purpose: 'Flow', allow: { recipes: [] }, hitl: [] } });
    expect(() => loadGraphPluginFromDir(join(dir, 'plugin'))).toThrow('graph.manifest-denied: the host capability vocabulary catalog is missing');
    const loaded = runWithUserConfigSnapshot({ ...getUserConfig(), graph: { vocabularyCatalog: hostCatalog } },
      () => loadGraphPluginFromDir(join(dir, 'plugin')));
    expect(loaded.graphs['vocab-flow']?.manifest.capabilityVocabulary?.digest).toBe(graphCapabilityVocabularyDigest(entries));
    expect(Object.isFrozen(loaded.graphs['vocab-flow']?.manifest.capabilityVocabulary?.entries[0]?.contract)).toBe(true);
    // The config parser keeps only an absolute path.
    const config = join(hostDir, 'config.json');
    writeFileSync(config, JSON.stringify({ graph: { vocabularyCatalog: hostCatalog } }));
    expect(getUserConfig(config).graph).toEqual({ vocabularyCatalog: hostCatalog });
    writeFileSync(config, JSON.stringify({ graph: { vocabularyCatalog: 'relative/catalog.json' } }));
    expect(getUserConfig(config).graph).toBeUndefined();
  } finally { rmSync(hostDir, { recursive: true, force: true }); }
}));

test('GRAPH-VOCAB-DYNAMIC (#37609 MF1): a host catalog that resolves inside the plugin, or is unreadable, is refused with an event', () => fixture((dir) => {
  const entries = catalogEntries();
  mkdirSync(join(dir, 'plugin'), { recursive: true });
  writeFileSync(join(dir, 'plugin', 'flow.yaml'), vocabularyFlow('search.web@1'));
  writeVocabularyPlugin(dir, ['./flow.yaml'], graphCapabilityVocabularyDigest(entries),
    { 'vocab-flow': { purpose: 'Flow', allow: { recipes: [] }, hitl: [] } });
  const inside = join(dir, 'plugin', 'capability-vocabulary.json');
  writeCatalog(dir, entries, undefined, inside);
  expect(() => runWithUserConfigSnapshot({ ...getUserConfig(), graph: { vocabularyCatalog: inside } },
    () => loadGraphPluginFromDir(join(dir, 'plugin')))).toThrow('must not live inside a plugin');
  expect(vocabularyRefusals().at(-1)).toMatchObject({ reason: 'catalog-inside-plugin' });
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{not json');
  expect(() => runWithUserConfigSnapshot({ ...getUserConfig(), graph: { vocabularyCatalog: broken } },
    () => loadGraphPluginFromDir(join(dir, 'plugin')))).toThrow('the host capability vocabulary catalog is unreadable');
  expect(vocabularyRefusals().at(-1)).toMatchObject({ reason: 'catalog-unreadable' });
}));
