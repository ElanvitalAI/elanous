import { expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { nextNode } from './runner.js';
import { bindReleaseInstance, deriveReleaseTemplate, dispatchReleaseInstance, type ReleaseInstanceDispatchRequest,
  type ReleaseTemplateManifest, type ReleaseTemplateOverlay } from './graph-instance.js';

const base: ReleaseTemplateManifest = {
  id: 'release-template', version: '1.0.0',
  allow: { recipes: ['cmd:cut', 'cmd:publish', 'cmd:verify'] },
  policy: {
    executor: { type: 'enum', default: 'local', bounds: ['local', 'remote-hosts', 'pod-pool'] },
    shards: { type: 'int', default: 1, bounds: [1, 32] },
    'pod.pool': { type: 'ref', default: 'none' },
    'fanout.hosts': { type: 'ref', default: 'none' },
    'gate.accept.list': { type: 'accept-item[]', default: [], scope: 'instance' },
  },
  extensionPoints: { 'after-publish': { after: 'publish', before: 'verify', failure: 'failed' } },
};
const graphSource = `graph_id: release-template
version: 1
entry_node: cut
terminal_nodes: [done, failed]
nodes:
  - { node_id: cut, kind: git, recipe: 'cmd:cut', max_visits: 1 }
  - { node_id: publish, kind: git, recipe: 'cmd:publish', max_visits: 1 }
  - { node_id: verify, kind: gate, recipe: 'cmd:verify', max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: cut, on: outcome, map: { ok: publish, fail: failed, error: failed } }
  - { from: publish, on: outcome, map: { ok: verify, fail: failed, error: failed } }
  - { from: verify, on: outcome, map: { ok: done, fail: failed, error: failed } }
`;
const parsedFixtureGraph = parseGraphTemplateYaml(graphSource, 'fixture');
if (!parsedFixtureGraph.template || parsedFixtureGraph.errors.length) throw new Error('invalid graph fixture');
const graph = parsedFixtureGraph.template;
const recipesSource = `cut:\n  command: 'bun ./release-step.ts cut'\npublish:\n  command: 'bun ./release-step.ts publish'\nverify:\n  command: 'bun ./release-step.ts verify'\nnpm-publish:\n  command: 'bun ./release-step.ts npm-publish'\n`;
const overlay: ReleaseTemplateOverlay = {
  id: 'elanous-release', base: { id: 'release-template', version: '1.0.0' },
  policyDefaults: { executor: 'pod-pool', 'pod.pool': 'gate' },
  recipes: ['cmd:npm-publish'],
  // Source: #35883; one publish visit matches graphs/templates/release/release.yaml.
  additions: [{ slot: 'after-publish', nodes: [{ nodeId: 'npm-publish', kind: 'git', recipe: 'cmd:npm-publish', maxVisits: 1,
    contract: { inputs: ['version'], tools: 'proc:bun', outputs: ['published'] } }] }],
};

function derive(overrides: Partial<Parameters<typeof deriveReleaseTemplate>[0]> = {}) {
  return deriveReleaseTemplate({ manifest: base, graph, graphSource, recipesSource, overlay, ...overrides });
}

test('GRAPH-TEMPLATE-INSTANCE simulation: derive adds only at a declared slot and pins both sources', () => {
  const derived = derive();
  expect(derived.graph.edges).toContainEqual({ from: 'publish', on: 'outcome', map: { ok: 'npm-publish', fail: 'failed', error: 'failed' } });
  expect(derived.graph.edges).toContainEqual({ from: 'npm-publish', on: 'outcome', map: { ok: 'verify', fail: 'failed', error: 'failed' } });
  expect(nextNode(derived.graph.edges, 'publish', 'fail')).toBe('failed');
  expect(nextNode(derived.graph.edges, 'npm-publish', 'fail')).toBe('failed');
  expect(nextNode(derived.graph.edges, 'npm-publish', 'ok')).toBe('verify');
  expect(derived.policyDefaults).toMatchObject({ executor: 'pod-pool', shards: 1 });
  expect(derived.pin).toMatchObject({ id: 'release-template', version: '1.0.0', manifestSha: expect.any(String), graphSha: expect.any(String),
    recipesSha: expect.any(String), overlaySha: expect.any(String) });
  const instance = bindReleaseInstance(derived, { version: '0.3.9', runId: 'run-release-039', pin: derived.pin,
    overrides: { 'gate.accept.list': { value: [{ id: 'regression-1', rule: 'present-on-main', evidenceId: 'e-1', expiresAt: '0.3.10' }],
      by: 'RLA', why: 'main evidence', evidenceId: 'e-1', expiresAt: '0.3.10' } } });
  expect(instance.policy['gate.accept.list']).toHaveLength(1);
  expect(derived.policyDefaults['gate.accept.list']).toEqual([]);
  expect(derived.pin).not.toHaveProperty('releaseVersion');
});

test('GRAPH-TEMPLATE-INSTANCE simulation: undeclared policy, destructive patch, stale pin and expired acceptance fail closed', () => {
  expect(() => derive({ overlay: { ...overlay, policyDefaults: { 'unknown.key': true } } })).toThrow('undeclared policy');
  expect(() => derive({ overlay: { ...overlay, patch: [{ op: 'remove', path: '/nodes/0' }] } })).toThrow('add-only');
  expect(() => derive({ overlay: { ...overlay, recipes: [] } })).toThrow('recipe not declared');
  expect(() => derive({ graphSource: graphSource.replace('entry_node: cut', 'entry_node: publish') })).toThrow('graph source mismatch');
  expect(() => derive({ recipesSource: recipesSource.replace(/npm-publish:[\s\S]*$/, '') }))
    .toThrow('recipe source missing executable definition: cmd:npm-publish');
  expect(() => derive({ manifest: { ...base, allow: { recipes: ['cmd:publish', 'cmd:verify'] } },
    overlay: { ...overlay, recipes: ['cmd:npm-publish', 'cmd:cut'] } })).toThrow('recipe source missing executable definition: cmd:cut');
  expect(() => derive({ recipesSource: recipesSource.replace("command: 'bun ./release-step.ts npm-publish'", "command: '   '") }))
    .toThrow('recipe source missing executable definition: cmd:npm-publish');
  expect(() => derive({ graphSource: graphSource.replace("recipe: 'cmd:cut'", "recipe: 'approval:release'"),
    graph: parseGraphTemplateYaml(graphSource.replace("recipe: 'cmd:cut'", "recipe: 'approval:release'"), 'fixture').template!,
    manifest: { ...base, allow: { recipes: ['approval:release', 'cmd:publish', 'cmd:verify'] } },
    recipesSource: `${recipesSource}release:\n  approval: '   '\n` }))
    .toThrow('recipe source missing executable definition: approval:release');
  const derived = derive();
  const changedManifest = derive({ manifest: { ...base, policy: { ...base.policy, shards: { ...base.policy.shards!, default: 2 } } } });
  expect(changedManifest.pin.manifestSha).not.toBe(derived.pin.manifestSha);
  expect(() => bindReleaseInstance(changedManifest, { version: '0.3.9', runId: 'run-test-instance', pin: derived.pin })).toThrow('pin mismatch');
  expect(() => bindReleaseInstance(derived, { version: '0.3.9', runId: 'run-test-instance', pin: { ...derived.pin, overlaySha: 'stale' } })).toThrow('pin mismatch');
  expect(() => bindReleaseInstance(derived, { version: '0.3.9', runId: 'run-test-instance', pin: derived.pin,
    overrides: { 'gate.accept.list': { value: [{ id: 'regression-1', rule: 'present-on-main', evidenceId: 'e-1', expiresAt: '0.3.8' }],
      by: 'RLA', why: 'old', evidenceId: 'e-1', expiresAt: '0.3.8' } } })).toThrow('expired');
});

test('GRAPH-TEMPLATE-INSTANCE assets: generic plugin owns a valid graph and elanous derives through its declared slot', () => {
  const root = join(import.meta.dir, '../../');
  const manifest = JSON.parse(readFileSync(join(root, 'graphs/templates/release/plugin.json'), 'utf8'));
  const extension = manifest.extensions['ai.elanous'];
  const graphSource = readFileSync(join(root, 'graphs/templates/release/release.yaml'), 'utf8');
  const recipesSource = readFileSync(join(root, 'graphs/templates/release/recipes.yaml'), 'utf8');
  const parsed = parseGraphTemplateYaml(graphSource, 'release.yaml');
  expect(parsed.errors).toEqual([]);
  const recipes = parseYaml(recipesSource) as Record<string, { command?: string; approval?: string }>;
  for (const recipe of [...parsed.template!.nodes.map((node) => node.recipe), 'cmd:npm-publish']) {
    if (recipe === 'none') continue;
    const [kind, name] = recipe.split(':');
    expect(recipes[name!]?.[kind === 'cmd' ? 'command' : 'approval']).toBeTruthy();
  }
  expect(extension.graphManifests['release-template'].policy.executor.default).toBe('local');
  const actualOverlay = JSON.parse(readFileSync(join(root, 'graphs/release/derive.json'), 'utf8'));
  const result = deriveReleaseTemplate({ manifest: extension.graphManifests['release-template'], graph: parsed.template!, graphSource, recipesSource,
    overlay: actualOverlay });
  expect(result.graph.nodes.some((node) => node.nodeId === 'npm-publish')).toBe(true);
  expect(JSON.stringify(manifest)).not.toContain('0.3.9');
});


test('GRAPH-TEMPLATE-INSTANCE simulation: 0.3.8 Elanous and a user app bind different execution routes and isolated ledgers', async () => {
  const internal = derive();
  const general = derive({ overlay: { id: 'general', base: { id: base.id, version: base.version } } });
  const elanous = bindReleaseInstance(internal, { version: '0.3.8', runId: 'run-elanous-038', pin: internal.pin,
    inputs: { cutSha: 'a'.repeat(40) }, overrides: { executor: { value: 'remote-hosts', by: 'RLA', why: 'guardian capacity', evidenceId: 'guardian-1', expiresAt: '0.3.10' },
      'fanout.hosts': { value: 'host-a', by: 'RLA', why: 'gate host', evidenceId: 'guardian-1' },
      shards: { value: 8, by: 'RLA', why: 'run capacity', evidenceId: 'guardian-1' } } });
  const user = bindReleaseInstance(general, { version: '1.2.3', runId: 'run-user-app', pin: general.pin,
    inputs: { cutSha: 'b'.repeat(40) } });
  expect(elanous.route).toEqual({ executor: 'remote-hosts', destination: 'host-a', shards: 8 });
  expect(user.route).toEqual({ executor: 'local', destination: 'local', shards: 1 });
  expect(elanous.pin.overlaySha).not.toBe(user.pin.overlaySha);
  const calls: Array<{ executor: string; destination: string; shards: number; runId: string }> = [];
  const root = mkdtempSync(join(tmpdir(), 'graph-instances-'));
  try {
    const executors = {
      local: async ({ instance, destination, shards }: ReleaseInstanceDispatchRequest) => {
        calls.push({ executor: 'local', destination, shards, runId: instance.runId });
        return 'local-complete';
      },
      'remote-hosts': async ({ instance, destination, shards }: ReleaseInstanceDispatchRequest) => {
        calls.push({ executor: 'remote-hosts', destination, shards, runId: instance.runId });
        return 'remote-complete';
      },
      'pod-pool': async ({ instance, destination, shards }: ReleaseInstanceDispatchRequest) => {
        calls.push({ executor: 'pod-pool', destination, shards, runId: instance.runId });
        return 'pod-complete';
      },
    };
    const elanousRun = await dispatchReleaseInstance({ derived: internal, instance: elanous, root, executors });
    const userRun = await dispatchReleaseInstance({ derived: general, instance: user, root, executors });
    const elanousPath = elanousRun.ledgerPath;
    const userPath = userRun.ledgerPath;
    expect(elanousPath).not.toBe(userPath);
    expect(elanousRun.result).toBe('remote-complete');
    expect(userRun.result).toBe('local-complete');
    expect(calls).toEqual([
      { executor: 'remote-hosts', destination: 'host-a', shards: 8, runId: 'run-elanous-038' },
      { executor: 'local', destination: 'local', shards: 1, runId: 'run-user-app' },
    ]);
    expect(readFileSync(elanousPath, 'utf8')).toContain('graph.policy-override');
    expect(JSON.parse(readFileSync(elanousPath, 'utf8').split('\n')[0]!).policy.shards).toBe(8);
    expect(readFileSync(userPath, 'utf8')).not.toContain('guardian-1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
