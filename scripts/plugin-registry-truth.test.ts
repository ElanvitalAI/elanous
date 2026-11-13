import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDefaultPluginGroup } from '../src/plugins/install/plugin-install.js';
import { compilePluginYaml } from '../src/plugins/core/plugin-yaml.js';
import { auditPluginRegistry } from './plugin-registry-truth.js';

const roots: string[] = [];
setDefaultTimeout(60_000);
function fixture(): { root: string; plugin: string } {
  const root = mkdtempSync(join(tmpdir(), 'plugin-registry-truth-'));
  roots.push(root);
  const plugin = join(root, 'plugins', 'local', 'sample-plugin', '1.0.0');
  mkdirSync(join(plugin, 'skills', 'read-mail'), { recursive: true });
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({
    id: 'sample-plugin', version: '1.0.0', skills: './skills/',
    contributes: { skills: [{ name: 'read-mail' }] },
  }));
  writeFileSync(join(plugin, 'skills', 'read-mail', 'SKILL.md'), '---\nname: read-mail\ndescription: Read mail\n---\n');
  writeFileSync(join(root, 'plugins', 'installed.json'), JSON.stringify([{ market: 'local', name: 'sample-plugin', version: '1.0.0' }]));
  return { root, plugin };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('registered installed skill matches the actual packaged SKILL.md', () => {
  const { root } = fixture();
  const report = auditPluginRegistry(root);
  expect(report.status).toBe('pass');
  expect(report.plugins[0]).toMatchObject({ key: 'local/sample-plugin/1.0.0', codeEntry: 'undeclared',
    declared: ['skill:read-mail'], problems: [] });
  expect(report.plugins[0]?.providedFiles).toContain('skill-file:skills/read-mail/SKILL.md');
});

test('registry refuses to call a missing skill or code entry provided', () => {
  const { root, plugin } = fixture();
  rmSync(join(plugin, 'skills', 'read-mail', 'SKILL.md'));
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({
    id: 'sample-plugin', version: '1.0.0', main: './plugin.ts', skills: './skills/',
    contributes: { skills: [{ name: 'read-mail' }], aiTools: [{ name: 'declared-only', description: 'Only declared', handler: 'native:noop' }] },
  }));
  const report = auditPluginRegistry(root);
  expect(report.status).toBe('fail');
  expect(report.plugins[0]?.codeEntry).toBe('absent');
  expect(report.plugins[0]?.problems).toContain('code-entry: missing file ./plugin.ts');
  expect(report.plugins[0]?.problems).toContain('skill:read-mail: missing file skills/read-mail/SKILL.md');
  expect(report.plugins[0]?.declared).toContain('aiTools:1');
});

test('YAML skill directory declaration reports a missing packaged directory', () => {
  const { root, plugin } = fixture();
  writeFileSync(join(plugin, 'plugin.yaml'), [
    'apiVersion: elanous.dev/plugin/v2',
    'id: sample-plugin',
    'name: Sample Plugin',
    'version: 1.0.0',
    'graphs: [./graphs/run.yaml]',
    'skills: ./custom-skills',
    '',
  ].join('\n'));
  const report = auditPluginRegistry(root);
  expect(report.status).toBe('fail');
  expect(report.plugins[0]?.declared).toContain('skill-root:./custom-skills');
  expect(report.plugins[0]?.problems).toContain('skill-root: missing directory ./custom-skills');
  expect(report.plugins[0]?.problems.some(problem => problem.startsWith('manifest unreadable:'))).toBe(true);
});

test('JSON custom skill root is scanned instead of the default skills folder', () => {
  const { root, plugin } = fixture();
  rmSync(join(plugin, 'skills'), { recursive: true, force: true });
  mkdirSync(join(plugin, 'custom-skills', 'read-mail'), { recursive: true });
  writeFileSync(join(plugin, 'custom-skills', 'read-mail', 'SKILL.md'), '# Read mail\n');
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({
    id: 'sample-plugin', version: '1.0.0', skills: './custom-skills',
    contributes: { skills: [{ name: 'read-mail' }] },
  }));
  const report = auditPluginRegistry(root);
  expect(report.status).toBe('pass');
  expect(report.plugins[0]?.providedFiles).toContain('skill-file:custom-skills/read-mail/SKILL.md');
  expect(report.plugins[0]?.problems).toEqual([]);
});

test('valid YAML custom skill path verifies its packaged SKILL.md', () => {
  const { root, plugin } = fixture();
  rmSync(join(plugin, 'skills'), { recursive: true, force: true });
  mkdirSync(join(plugin, 'custom-skills', 'read-mail'), { recursive: true });
  mkdirSync(join(plugin, 'graphs'), { recursive: true });
  writeFileSync(join(plugin, 'custom-skills', 'read-mail', 'SKILL.md'), '# Read mail\n');
  writeFileSync(join(plugin, 'graphs', 'run.yaml'), 'apiVersion: elanous.dev/graph/v2\ngraph: { id: sample-run, purpose: Check custom skill }\n');
  writeFileSync(join(plugin, 'plugin.yaml'), [
    'apiVersion: elanous.dev/plugin/v2',
    'id: sample-plugin',
    'name: Sample Plugin',
    'version: 1.0.0',
    'graphs: [./graphs/run.yaml]',
    'skills:',
    '  - { id: read-mail, path: ./custom-skills/read-mail/SKILL.md }',
    '',
  ].join('\n'));
  writeFileSync(join(plugin, 'plugin.json'), compilePluginYaml(plugin));
  const report = auditPluginRegistry(root);
  expect(report.status).toBe('pass');
  expect(report.plugins[0]?.providedFiles).toContain('skill:read-mail');
  expect(report.plugins[0]?.problems).toEqual([]);
});

test('orphan and duplicate ledger entries are visible instead of silently filtered', () => {
  const { root } = fixture();
  writeFileSync(join(root, 'plugins', 'installed.json'), JSON.stringify([
    { market: 'local', name: 'ghost', version: '1.0.0' },
    { market: 'local', name: 'ghost', version: '1.0.0' },
  ]));
  const report = auditPluginRegistry(root);
  expect(report.status).toBe('fail');
  expect(report.plugins[0]?.problems).toContain('installed package missing');
  expect(report.plugins[1]?.problems).toContain('duplicate ledger row');
});

test('empty installed registry is unmeasured', () => {
  const { root } = fixture();
  writeFileSync(join(root, 'plugins', 'installed.json'), '[]');
  expect(auditPluginRegistry(root).status).toBe('unmeasured');
});

test('a code file alone does not certify a declared runtime tool as exposed', () => {
  const { root, plugin } = fixture();
  writeFileSync(join(plugin, 'plugin.ts'), 'export default { name: "sample-plugin", initialState: () => ({}) };');
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({
    id: 'sample-plugin', version: '1.0.0', main: './plugin.ts', skills: './skills/',
    contributes: { skills: [{ name: 'read-mail' }], aiTools: [{ name: 'declared-only', description: 'Only declared', handler: 'native:noop' }] },
  }));
  const report = auditPluginRegistry(root);
  expect(report.status).toBe('unmeasured');
  expect(report.plugins[0]).toMatchObject({ codeEntry: 'present', runtimeClaims: ['aiTools'], problems: [] });
});

test('an installed manifest with no provided asset is not green', () => {
  const { root, plugin } = fixture();
  rmSync(join(plugin, 'skills'), { recursive: true, force: true });
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ id: 'sample-plugin', version: '1.0.0' }));
  const report = auditPluginRegistry(root);
  expect(report.status).toBe('fail');
  expect(report.plugins[0]?.problems).toContain('package provides no verified file or code entry');
});

test('isolated installation of the shipped default group has a ledger and real skill files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-registry-shipped-'));
  roots.push(root);
  await installDefaultPluginGroup({ root });
  const report = auditPluginRegistry(root);
  expect(report.status).toBe('pass');
  expect(report.plugins).toHaveLength(6);
  expect(report.plugins.every(plugin => plugin.providedFiles.includes('skill-root') || plugin.providedFiles.some(file => file.startsWith('skill:')))).toBe(true);
  expect(report.plugins.every(plugin => plugin.codeEntry === 'undeclared')).toBe(true);
});
