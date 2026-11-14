import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePluginManifest, loadPluginManifestFromDir } from './manifest.js';
import { compilePluginYaml } from './plugin-yaml.js';
import { PluginHost } from './host.js';
import { dispatchToolSearch } from '../../skills/tools/tool-search.js';
import { takeHydratedTools } from '../../skills/tools/tool-search-spec.js';
import { toLLMToolSpec } from '../../llm/tool-spec.js';
import { createChildPluginRuntimeContract } from '../../cli/child-plugin-runtime.js';
import { appDeployPluginSpec } from '../../agent/app-deploy-plugin.js';

const roots: string[] = [];
const temporary = () => { const root = mkdtempSync(join(tmpdir(), 'capability-manifest-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const discovery = {
  description: 'Synthetic lookup capability.',
  whenToUse: 'Find synthetic opaque_lookup_criterion data.',
  inputs: { query: 'The declared lookup query.' }, outputs: { value: 'Lookup result.' },
  examples: ['Look up the synthetic fixture.'],
  requires: { memberConnection: true, confirmation: false, appKinds: ['static-export'] },
};

test('manifest discovery retains explicit requirements without changing legacy plugin parsing', () => {
  expect(parsePluginManifest({ id: 'fixture', ...discovery })).toMatchObject(discovery);
  const legacy = parsePluginManifest({ id: 'legacy', inputs: 'legacy-opaque-field',
    requires: { tools: ['bun'], knowledgePacks: ['existing-pack'] } });
  expect(legacy.whenToUse).toBeUndefined();
  expect(legacy.requires).toEqual({ tools: ['bun'], knowledgePacks: ['existing-pack'] });
  for (const change of [
    { whenToUse: {} }, { inputs: [] }, { inputs: {} }, { outputs: null }, { outputs: {} }, { examples: [] },
    { examples: ['one', 'two', 'three'] }, { requires: { memberConnection: 'yes' } },
    { requires: { appKinds: ['unknown-server'] } }, { requires: { unknownPrerequisite: true } },
  ]) expect(() => parsePluginManifest({ id: 'invalid', ...discovery, ...change })).toThrow();
});

test('YAML generation and the actual loader preserve metadata and reject a stale committed manifest', () => {
  const root = temporary();
  const yaml = [
    'apiVersion: elanous.dev/plugin/v2', 'id: fixture', 'name: Fixture', 'version: 1.0.0',
    'graphs: [./fixture.yaml]',
    ...Object.entries(discovery).map(([key, value]) => key + ': ' + JSON.stringify(value)),
  ].join('\n') + '\n';
  writeFileSync(join(root, 'fixture.yaml'), [
    'apiVersion: elanous.dev/graph/v2',
    'graph: { id: fixture, version: 1.0.0, layer: flow, purpose: Synthetic metadata fixture }',
    'allow: { recipes: [], skills: [], mcp: [] }',
  ].join('\n'));
  writeFileSync(join(root, 'plugin.yaml'), yaml);
  writeFileSync(join(root, 'plugin.json'), compilePluginYaml(root));
  expect(loadPluginManifestFromDir(root, { id: 'fixture' }).manifest).toMatchObject(discovery);
  for (const key of ['inputs', 'outputs'] as const) {
    writeFileSync(join(root, 'plugin.yaml'), yaml.replace(key + ': ' + JSON.stringify(discovery[key]), key + ': {}'));
    expect(() => compilePluginYaml(root)).toThrow('nonempty');
  }
  writeFileSync(join(root, 'plugin.yaml'), yaml.replace('opaque_lookup_criterion', 'changed_criterion'));
  expect(() => loadPluginManifestFromDir(root, { id: 'fixture' })).toThrow('stale');
});

test('actual plugin activation makes manifest usage searchable, hydrates its schema and dispatches the registered handler', async () => {
  const userDir = temporary();
  const plugin = join(userDir, 'cap-fixture');
  mkdirSync(plugin);
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({
    id: 'cap-fixture', name: 'cap-fixture', version: '1.0.0', main: './plugin.ts', ...discovery,
    contributes: { aiTools: [{
      name: 'FixtureLookup', description: 'Lookup.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      route: { triggers: ['lookup'], examples: ['lookup fixture'], sideEffects: 'read-only', risk: 'low',
        cost: 'cheap', requiresConfirm: false },
    }] },
  }));
  writeFileSync(join(plugin, 'plugin.ts'), [
    'export default { name:"cap-fixture",version:"1",description:"",initialState:()=>({}),panes:{},',
    'llmTools:[{name:"FixtureLookup",description:"Lookup.",parameters:{type:"object"},',
    'handler:async()=>({value:"synthetic-result"})}]};',
  ].join('\n'));
  const host = new PluginHost({ log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {} },
    null, { userDir });
  await host.discover();
  await host.activate('cap-fixture');
  try {
    const spec = toLLMToolSpec(host.activePluginLLMTools().find(tool => tool.name === 'FixtureLookup')!);
    const result = dispatchToolSearch({ query: 'opaque_lookup_criterion' }, { specs: [spec] });
    expect(result.matched).toEqual(['FixtureLookup']);
    expect(result.content).toContain('memberConnection');
    expect(result.content).toContain('static-export');
    const hydrated = takeHydratedTools(result);
    expect(hydrated.map(tool => tool.name)).toEqual(['FixtureLookup']);
    expect(await host.dispatchTool(hydrated[0]!.name, { query: 'fixture' }))
      .toEqual({ ok: true, result: { value: 'synthetic-result' } });
    const inactive = dispatchToolSearch({ query: 'opaque_lookup_criterion' },
      { specs: [spec], activePluginIds: new Set(['unrelated-plugin']) });
    expect(inactive.matched).toEqual([]);
  } finally { await host.deactivate(); }
});

test('built-in app deployment and generated Absorb manifest publish truthful bounded discovery descriptions', () => {
  const spec = appDeployPluginSpec();
  expect(spec.description).toContain('static-export');
  expect(spec.description).toContain('memberConnection');
  const root = join(import.meta.dir, '../../..');
  const absorb = loadPluginManifestFromDir(join(root, 'plugins/absorb'), { id: 'absorb' }).manifest;
  expect(absorb.whenToUse).toBeTruthy();
  expect(absorb.requires?.memberConnection).toBe(true);
  expect(absorb.examples).toEqual(expect.arrayContaining([expect.any(String)]));
});

test('discovery budget includes serialized requirements, not just usage descriptions', () => {
  // Source: capability-discovery.ts MAX_METADATA_CHARS; each entry remains below MAX_TEXT_CHARS.
  const oversizedRequirements = { tools: ['a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(1000), 'd'.repeat(1000)] };
  expect(() => parsePluginManifest({ id: 'budget', ...discovery, requires: oversizedRequirements })).toThrow('budget');
});
test('legacy prerequisite fields retain historical tolerant parsing without discovery opt-in', () => {
  const legacy = parsePluginManifest({ id: 'legacy', requires: {
    memberConnection: 'legacy-opaque', appKinds: 'legacy-opaque', tools: ['bun'],
  } });
  expect(legacy.requires).toEqual({ tools: ['bun'] });
});
test('opt-in requires are mandatory and malformed known prerequisite types never silently disappear', () => {
  expect(() => parsePluginManifest({ id: 'missing', ...discovery, requires: undefined })).toThrow('explicit');
  for (const requires of [{ tools: 'bun' }, { optionalTools: [false] }, { optionalPython: null },
    { knowledgePacks: [42] }, { elanous: {} }]) {
    expect(() => parsePluginManifest({ id: 'malformed', ...discovery, requires })).toThrow();
  }
});

test('actual Next child route catalog retains discovery metadata for JSON and YAML plugin tools', () => {
  const bridge = createChildPluginRuntimeContract();
  const specs = bridge.hostTools.map(toLLMToolSpec);
  for (const name of ['app_deploy', 'scrap_add', 'gcp_architect_expand']) {
    const spec = specs.find(tool => tool.name === name);
    expect(spec?.description).toContain('whenToUse');
    expect(spec?.description).toContain(name === 'gcp_architect_expand' ? 'confirmation' : 'memberConnection');
    const result = dispatchToolSearch({ query: 'select:' + name }, { specs });
    expect(takeHydratedTools(result).map(tool => tool.name)).toEqual([name]);
  }
  const app = dispatchToolSearch({ query: 'AppManifest' }, { specs });
  expect(app.matched).toContain('app_deploy');
});
