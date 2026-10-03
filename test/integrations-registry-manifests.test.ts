import { expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const load = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));

test('MCP registry manifest identifies the npm stdio server at the package version', () => {
  const pkg = load('package.json');
  const server = load('server.json');
  expect(pkg.mcpName).toBe('io.github.ElanvitalAI/elanous');
  expect(pkg.name).toBe('elanous');
  expect(server.$schema).toBe('https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json');
  expect(server.name).toBe(pkg.mcpName);
  expect(server.description).toMatch(/^[A-Z][^\n]{0,98}\.$/);
  expect(server.description.length).toBeLessThanOrEqual(100);
  expect(server.version).toBe(pkg.version);
  expect(server.repository).toEqual({ url: 'https://github.com/ElanvitalAI/elanous', source: 'github' });
  expect(server.packages).toHaveLength(1);
  expect(server.packages[0]).toEqual({
    registryType: 'npm', identifier: pkg.name, version: pkg.version,
    transport: { type: 'stdio' },
    packageArguments: [
      { type: 'positional', value: 'mcp' },
      { type: 'positional', value: 'serve' },
    ],
  });
});

test('Codex marketplace entry points to the existing Codex plugin', () => {
  const marketplace = load('.agents/plugins/marketplace.json');
  expect(marketplace.name).toBe('elanous');
  expect(marketplace.interface?.displayName).toBe('Elanous');
  expect(marketplace.plugins).toHaveLength(1);
  const plugin = marketplace.plugins[0];
  expect(plugin.name).toBe('elanous');
  expect(plugin.source).toBe('./integrations/elanous-agent');
  const source = resolve(root, plugin.source);
  expect(statSync(source).isDirectory()).toBe(true);
  expect(existsSync(resolve(source, '.codex-plugin/plugin.json'))).toBe(true);
  expect(plugin.policy).toEqual({ installation: 'AVAILABLE', authentication: 'ON_USE' });
  expect(['AVAILABLE', 'INSTALLED_BY_DEFAULT', 'NOT_AVAILABLE']).toContain(plugin.policy.installation);
  expect(plugin.category).toBe('productivity');
});
