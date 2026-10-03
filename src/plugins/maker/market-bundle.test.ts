import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIndexKeyPair, validateMarketplaceIndex, verifyIndex } from '../../market/signed-index.js';
import { bundleInstalledWizardPlugin } from './market-bundle.js';
import { makePlugin } from './plugin-maker.js';
import { listInstalledPlugins } from '../install/plugin-install.js';

const roots: string[] = [];
const priorState = process.env.ELANOUS_STATE_DIR;
const priorRedactions = process.env.ELANOUS_EXPORT_REDACTIONS;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wizard-market-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  const redactions = join(root, 'private.tsv');
  writeFileSync(redactions, '# empty local redaction table\n');
  process.env.ELANOUS_EXPORT_REDACTIONS = redactions;
  const plugin = join(root, 'plugin');
  mkdirSync(plugin);
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'demo-plugin', version: '0.1.0', description: 'Demo',
    extensions: { 'ai.elanous': { capabilities: ['fs:workdir'], connectors: [{ id: 'weather', fields: [{ name: 'API_KEY', secret: true }] }] } } }));
  writeFileSync(join(plugin, 'README.md'), '# Demo plugin\n');
  return { root, plugin, output: join(root, 'review-bundle') };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (priorState === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = priorState;
  if (priorRedactions === undefined) delete process.env.ELANOUS_EXPORT_REDACTIONS;
  else process.env.ELANOUS_EXPORT_REDACTIONS = priorRedactions;
});

test('fake installed plugin produces official market index and artifact path without publishing', () => {
  const { root, plugin, output } = fixture();
  const published = spyOn(globalThis, 'fetch');
  try {
    const result = bundleInstalledWizardPlugin(plugin, output, join(root, 'no-config.json'));
    expect(result).toEqual({ path: output, artifact: join(output, 'demo-plugin-0.1.0.tgz'), signature: 'signing-required' });
    expect(readdirSync(output).sort()).toEqual(['demo-plugin-0.1.0.tgz', 'marketplace.json']);
    const index = JSON.parse(readFileSync(join(output, 'marketplace.json'), 'utf8'));
    expect(validateMarketplaceIndex(index)).toBeNull();
    expect(index.plugins[0]['ai.elanous'].connectors[0].userConfig).toEqual([{ key: 'API_KEY', label: 'API_KEY', secret: true }]);
    expect(index.plugins[0].artifact.sha256).toBe(createHash('sha256').update(readFileSync(result.artifact)).digest('hex'));
    const tar = Bun.spawnSync(['tar', '-tzf', result.artifact]);
    expect(tar.exitCode).toBe(0);
    expect(tar.stdout.toString().split('\n')).toContain('plugin.json');
    expect(published).toHaveBeenCalledTimes(0);
  } finally { published.mockRestore(); }
});

test('configured key signs the exact official index bytes; no key material is bundled', () => {
  const { root, plugin, output } = fixture();
  const key = generateIndexKeyPair();
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ market: { signing: { keyId: key.keyId, privateKey: key.privateKeyPem } } }));
  const result = bundleInstalledWizardPlugin(plugin, output, config);
  expect(result.signature).toBe('signed');
  const checked = verifyIndex({ marketplaceBytes: readFileSync(join(output, 'marketplace.json')),
    signatureText: readFileSync(join(output, 'index.sig'), 'utf8'), trustedKeys: [key] });
  expect(checked.ok).toBe(true);
  expect(readFileSync(join(output, 'marketplace.json'), 'utf8')).not.toContain(key.privateKeyPem);
});

test('public-export leak markers refuse a private-looking string before creating any bundle', () => {
  const { plugin, output, root } = fixture();
  writeFileSync(join(plugin, 'README.md'), 'private source/' + 'pilot/ note\n');
  expect(() => bundleInstalledWizardPlugin(plugin, output, join(root, 'no-config.json'))).toThrow('pilot-tree');
  expect(existsSync(output)).toBe(false);
});

test('malformed manifest and missing referenced asset are refused without output', () => {
  const { plugin, output, root } = fixture();
  writeFileSync(join(plugin, 'plugin.json'), '{bad json');
  expect(() => bundleInstalledWizardPlugin(plugin, output, join(root, 'no-config.json'))).toThrow();
  expect(existsSync(output)).toBe(false);
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'demo-plugin', version: '0.1.0', main: './missing.ts' }));
  expect(() => bundleInstalledWizardPlugin(plugin, output, join(root, 'no-config.json'))).toThrow('market manifest asset missing');
  expect(existsSync(output)).toBe(false);
});

test('missing private redaction table fails closed', () => {
  const { plugin, output, root } = fixture();
  process.env.ELANOUS_EXPORT_REDACTIONS = join(root, 'missing.tsv');
  expect(() => bundleInstalledWizardPlugin(plugin, output)).toThrow('redaction list unavailable');
  expect(existsSync(output)).toBe(false);
});

test('wizard bundles only after successful installation, without any publish dependency', async () => {
  const { root, output } = fixture();
  const result = await makePlugin({ request: 'test plugin', name: 'test-plugin', parentDir: join(root, 'local'), marketBundleDir: output,
    deps: { codex: async dir => {
      const graph = join(dir, 'graphs', 'test-plugin.yaml');
      writeFileSync(graph, readFileSync(graph, 'utf8')
        .replace('  - { node_id: done,', "  - { node_id: second, kind: agent, recipe: 'cmd:second', max_visits: 1 }\n  - { node_id: done,")
        .replace('map: { ok: done, fail: failed } }', 'map: { ok: second, fail: failed } }\n  - { from: second, on: outcome, map: { ok: done, fail: failed } }'));
      writeFileSync(join(dir, 'graphs', 'recipes.yaml'), 'main:\n  command: \'bun "$ELANOUS_GRAPH_DIR/run-step.ts" main\'\nsecond:\n  command: \'bun "$ELANOUS_GRAPH_DIR/run-step.ts" second\'\n');
      writeFileSync(join(dir, 'graphs', 'run-step.ts'), "console.log(JSON.stringify({ outcome: 'ok' }));\n");
    } },
  });
  expect(result.status).toBe('installed');
  expect(result.marketBundle?.path).toBe(output);
  expect(validateMarketplaceIndex(JSON.parse(readFileSync(join(output, 'marketplace.json'), 'utf8')))).toBeNull();
  expect(listInstalledPlugins(root).map(plugin => plugin.name)).toContain('test-plugin');
});
