import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginManifestFromDir } from './manifest.js';
import { compilePluginYaml } from './plugin-yaml.js';
import { installPlugin, listInstalledPlugins } from '../install/plugin-install.js';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-yaml-gen-'));
  mkdirSync(join(root, 'graph'));
  writeFileSync(join(root, 'plugin.yaml'), [
    'apiVersion: elanous.dev/plugin/v2',
    'id: absorb',
    'name: Absorb',
    'version: 1.0.0',
    'description: Declarative absorb graph bundle.',
    'graphs: [./graph/absorb-brief.yaml]',
    'capabilities: [store, extract, llm-judge]',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'graph/absorb-brief.yaml'), [
    'apiVersion: elanous.dev/graph/v2',
    'graph: { id: absorb-brief, version: 1.0.0, layer: flow, purpose: "Collect and brief member scraps" }',
    'allow: { recipes: [cmd:collect], skills: [absorb/*], mcp: [] }',
    'packs: [member-apps@1]',
    'policy:',
    '  hitl: [approve-suggestion]',
    '  suggestion.limit: { type: int, default: 3, bounds: [1, 10] }',
    'observe: { categories: [graph.run, absorb.brief] }',
    '',
  ].join('\n'));
  return root;
}

test('plugin.yaml compiles graph declarations into the committed plugin.json extension', () => {
  const root = fixture();
  try {
    const generated = compilePluginYaml(root);
    const manifest = JSON.parse(generated);
    expect(manifest.id).toBe('absorb');
    expect(manifest.extensions['ai.elanous'].graphs).toEqual(['./graph/absorb-brief.yaml']);
    expect(manifest.extensions['ai.elanous'].capabilities).toEqual(['store', 'extract', 'llm-judge']);
    expect(manifest.extensions['ai.elanous'].graphManifests['absorb-brief']).toEqual({
      purpose: 'Collect and brief member scraps',
      allow: { recipes: ['cmd:collect'], skills: ['absorb/*'], domainPacks: ['member-apps@1'] },
      policy: { 'suggestion.limit': { type: 'int', default: 3, bounds: [1, 10] } },
      hitl: ['approve-suggestion'],
      observe: { categories: ['graph.run', 'absorb.brief'] },
    });
    writeFileSync(join(root, 'plugin.json'), generated);
    const loaded = loadPluginManifestFromDir(root, { id: 'fallback-plugin' });
    expect(loaded.path).toBe(join(root, 'plugin.yaml'));
    expect(loaded.manifest.id).toBe('absorb');
    expect(loaded.manifest.contributes.graphs).toEqual(['./graph/absorb-brief.yaml']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('plugin loader rejects a generated plugin.json that differs from plugin.yaml', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'plugin.json'), compilePluginYaml(root).replace('"version": "1.0.0"', '"version": "1.0.1"'));
    expect(() => loadPluginManifestFromDir(root, { id: 'absorb' })).toThrow('plugin.json is stale');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('plugin.yaml graph assets cannot escape through parent paths or symlinks', () => {
  const root = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'plugin-yaml-outside-'));
  try {
    writeFileSync(join(outside, 'escape.yaml'), 'apiVersion: elanous.dev/graph/v2\n');
    symlinkSync(join(outside, 'escape.yaml'), join(root, 'graph/escape.yaml'));
    const yamlPath = join(root, 'plugin.yaml');
    const source = readFileSync(yamlPath, 'utf8').replace('./graph/absorb-brief.yaml', './graph/escape.yaml');
    writeFileSync(yamlPath, source);
    expect(() => compilePluginYaml(root)).toThrow('escapes plugin root');
    writeFileSync(yamlPath, source.replace('./graph/escape.yaml', '../escape.yaml'));
    expect(() => compilePluginYaml(root)).toThrow('unsafe graph asset');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('contributes.skills paths cannot escape by parent traversal or symlink', () => {
  const root = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'plugin-skill-outside-'));
  try {
    const source = readFileSync(join(root, 'plugin.yaml'), 'utf8');
    writeFileSync(join(root, 'plugin.yaml'), `${source}contributes:\n  skills:\n    - { id: outside, path: ../outside/SKILL.md }\n`);
    expect(() => compilePluginYaml(root)).toThrow('unsafe graph asset');
    writeFileSync(join(outside, 'SKILL.md'), 'outside');
    symlinkSync(join(outside, 'SKILL.md'), join(root, 'linked-skill.md'));
    writeFileSync(join(root, 'plugin.yaml'), `${source}contributes:\n  skills:\n    - { id: outside, path: linked-skill.md }\n`);
    expect(() => compilePluginYaml(root)).toThrow('escapes plugin root');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('shipped absorb v2 manifest compiles and installs with all declared graph tools', async () => {
  const source = join(import.meta.dir, '../../../plugins/absorb');
  const root = mkdtempSync(join(tmpdir(), 'plugin-absorb-install-'));
  try {
    const generated = compilePluginYaml(source);
    expect(readFileSync(join(source, 'plugin.json'), 'utf8')).toBe(generated);
    const loaded = loadPluginManifestFromDir(source, { id: 'absorb' }).manifest;
    expect(loaded.dependencies?.plugins).toEqual([{ id: 'elanous-app-deploy', version: '^0.3.9', optional: true }]);
    expect(loaded.contributes.aiTools?.map(tool => tool.name)).toEqual([
      'scrap_add', 'brief_today', 'suggest_list', 'suggest_accept',
    ]);
    const installed = await installPlugin(source, { root, yes: true });
    expect(installed.name).toBe('absorb');
    expect(listInstalledPlugins(root).map(item => item.name)).toEqual(['absorb']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bundled Absorb host-import exception still requires capability consent', async () => {
  const source = join(import.meta.dir, '../../../plugins/absorb');
  const root = mkdtempSync(join(tmpdir(), 'plugin-absorb-consent-'));
  try {
    await expect(installPlugin(source, { root })).rejects.toMatchObject({ reason: 'consent-denied' });
    await expect(installPlugin(source, { root, consent: async () => false })).rejects.toMatchObject({ reason: 'consent-denied' });
    expect(listInstalledPlugins(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
